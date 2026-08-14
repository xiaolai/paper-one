import type { TocItem, View } from 'foliate-js/view.js'
import type { MarkKind } from '../lib/marks'
import type { BookMeta, ReaderPosition } from '../lib/useBook'

/**
 * The reader's lifecycle, as a plain object.
 *
 * Startup is a chain of awaits — import the module, create the element, open
 * the book, configure the renderer, display the first section — and React can
 * unmount at any point in that chain. A bare `disposed` flag checked at each
 * step is easy to get subtly wrong and impossible to test, which is exactly
 * what the audit found: teardown could clear the view reference while an open
 * was still in flight, so the view that arrived afterwards had nothing left to
 * close it and kept its iframes, observers and listeners forever.
 *
 * Here disposal is a single latch. `dispose()` is idempotent and can be called
 * before, during, or after startup; `settle()` hands every completed step back
 * to the latch, so whichever side finishes last performs the close. None of it
 * touches React, so all of it can be asserted directly.
 */

/** One hit, flattened from foliate's mixed yield shapes. */
export interface SearchHit {
  readonly cfi: string
  readonly label: string
  readonly pre: string
  readonly match: string
  readonly post: string
}

/**
 * Enough of a mark to draw it.
 *
 * Deliberately not the stored `Mark`: the session has no business knowing what
 * a mark's note says or when it was made, and keeping the anchor narrow is what
 * lets the drawing be reasoned about without the store in view.
 */
export interface MarkAnchor {
  readonly cfi: string
  readonly sectionIndex: number
  readonly kind: MarkKind
}

/** A live selection in the book, with its anchor already resolved. */
export interface SelectionSnapshot {
  readonly cfi: string
  readonly sectionIndex: number
  readonly text: string
  /** In the BOOK document's coordinate space — translate before use. */
  readonly range: Range
}

/**
 * Concrete colours for the two mark provenances.
 *
 * Resolved by the caller at draw time rather than read from a custom property,
 * because the Overlayer sets `fill` as a presentation ATTRIBUTE, and `var()` is
 * not valid in one. Marks would silently draw black.
 */
export interface MarkPalette {
  readonly highlight: string
  readonly companion: string
  /**
   * Night draws your own mark as a rule rather than a fill — §05: "Highlights
   * stay legible by fill in light themes and by rule in Night, where a pale
   * fill would glare." A boolean rather than a painter reference so the palette
   * stays plain data and the session keeps sole ownership of the painters.
   */
  readonly highlightAsRule: boolean
}

/** The Overlayer's draw functions, passed in so foliate stays lazily loaded. */
export interface MarkPainters {
  readonly highlight: unknown
  readonly underline: unknown
}

export interface SessionCallbacks {
  onToc: (toc: readonly TocItem[]) => void
  onRelocate: (position: ReaderPosition) => void
  onDocument: (doc: Document | null) => void
  onMeta: (meta: BookMeta) => void
  onError: (message: string) => void
  onNavigator: (navigator: SessionNavigator | null) => void
  /**
   * The marks to draw, read afresh each time a section's overlay is built.
   *
   * A getter rather than a value because sections are created and destroyed as
   * the reader scrolls, long after the session started: a snapshot taken at
   * startup would draw the marks the book had when it opened and nothing made
   * since.
   */
  getMarks: () => readonly MarkAnchor[]
  /** Read at draw time, so marks follow a theme change. */
  getPalette: () => MarkPalette
  /**
   * A mark was resolved and drawn, reported with the live Range it landed on.
   *
   * This is the only place that Range is available: turning a CFI back into a
   * Range needs foliate's resolver, which is not public, and the margin marks
   * need one in order to sit beside the line they belong to. The Range stays
   * live — it tracks DOM mutations — so re-measuring it after a reflow gives
   * the new position without resolving anything again.
   */
  onMarkDrawn: (cfi: string, range: Range) => void
  /** The selection in the book changed. Null when it collapsed. */
  onSelection: (selection: SelectionSnapshot | null) => void
  /** A drawn mark was clicked, identified by its CFI. */
  onMarkActivated: (cfi: string) => void
}

export interface SessionNavigator {
  goTo: (target: string) => void
  /** Streams hits as they are found; stops when `signal` aborts. */
  search: (query: string, signal: AbortSignal) => AsyncGenerator<SearchHit>
  /** Draw a mark immediately, without waiting for the section to re-render. */
  drawMark: (anchor: MarkAnchor) => void
  eraseMark: (anchor: MarkAnchor) => void
  /** Clear the book's selection — after acting on it, per §07. */
  deselect: () => void
}

export interface SessionDeps {
  /** Injected so tests can supply a fake instead of a real custom element. */
  createView: () => Promise<View>
  /** Loaded alongside the view so the painters exist before the first paint. */
  loadPainters: () => Promise<MarkPainters>
  /**
   * Turn the source into something `View.open` accepts.
   *
   * foliate opens a File or URL by sniffing its type, but it has no PDF loader
   * — so a PDF is converted into a Book first, one HTML page per PDF page. See
   * `makePdf`. Everything else passes through unchanged.
   *
   * It happens HERE rather than at the call site so that a conversion failure
   * is reported through the same path as a failed open, and so that a session
   * disposed mid-conversion still stops before touching a view.
   */
  prepare?: (source: File | string) => Promise<unknown>
  applySettings: (view: View) => void
}

export class ReaderSession {
  #disposed = false
  #view: View | null = null
  #painters: MarkPainters | null = null
  /**
   * Sections that currently have an overlay.
   *
   * Marks can only be drawn into a section that has one, so this is what
   * `redrawMarks` iterates after a theme change — re-offering marks for a
   * section that has been scrolled away would resolve CFIs for nothing.
   */
  readonly #sections = new Set<number>()
  /** Selection listeners, one set per loaded spine document. */
  #unwatch: (() => void)[] = []
  readonly #host: HTMLElement
  readonly #cb: SessionCallbacks

  constructor(host: HTMLElement, callbacks: SessionCallbacks) {
    this.#host = host
    this.#cb = callbacks
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /** The live view, or null before startup completes / after disposal. */
  get view(): View | null {
    return this.#view
  }

  /**
   * Hand a freshly-created view to the latch.
   *
   * Returns false when the session was disposed while the caller was awaiting,
   * having already closed the view it was given. Callers must stop on false —
   * that is the whole contract.
   */
  #settle(view: View): boolean {
    if (this.#disposed) {
      closeQuietly(view)
      return false
    }
    this.#view = view
    return true
  }

  async start(source: File | string, deps: SessionDeps): Promise<void> {
    /* allSettled, not all: `all` rejects the moment either side fails while the
     * other keeps going, so a painters failure would strand a perfectly good
     * view with nothing holding a reference to close it — the same leak this
     * class exists to prevent, reintroduced one layer up. */
    const [built, painted] = await Promise.allSettled([
      deps.createView(),
      deps.loadPainters(),
    ])

    if (built.status === 'rejected') {
      if (!this.#disposed) {
        this.#cb.onError(message(built.reason, 'The reader failed to start.'))
      }
      return
    }
    const view = built.value
    if (!this.#settle(view)) return

    if (painted.status === 'rejected') {
      // The view is settled, so dispose() will close it — the same contract as
      // a failed open, where the book stays closable.
      this.#cb.onError(message(painted.reason, 'The reader failed to start.'))
      return
    }
    this.#painters = painted.value

    view.style.position = 'absolute'
    view.style.inset = '0'
    this.#host.replaceChildren(view)

    /* Both listeners consult the latch before touching shared state. A closing
     * view still emits these, and without the guard a dying book overwrites the
     * document and position of the one that replaced it. */
    view.addEventListener('load', (event) => {
      if (this.#disposed) return
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail
      this.#watchSelection(doc, view, index)
      this.#cb.onDocument(doc)
    })

    /* foliate builds one overlay per spine item, and rebuilds it every time the
     * section is re-rendered. This is the only moment a mark can be attached,
     * which is why the store is read through a getter rather than captured. */
    view.addEventListener('create-overlay', (event) => {
      if (this.#disposed) return
      const { index } = (event as CustomEvent<{ index: number }>).detail
      this.#sections.add(index)
      this.#drawSection(view, index)
    })

    view.addEventListener('draw-annotation', (event) => {
      if (this.#disposed) return
      const detail = (event as CustomEvent<{
        draw: (fn: unknown, options?: Record<string, unknown>) => void
        annotation: { value?: string; kind?: MarkKind }
        range: Range
      }>).detail
      const painters = this.#painters
      if (!painters) return
      if (detail.annotation?.value && detail.range) {
        this.#cb.onMarkDrawn(detail.annotation.value, detail.range)
      }
      const palette = this.#cb.getPalette()
      // §01: your own mark is a gold fill, the companion's is an amber
      // underline. The kind rides along on the annotation so the painter does
      // not have to look the mark up again.
      if (detail.annotation?.kind === 'companion') {
        detail.draw(painters.underline, { color: palette.companion })
      } else if (palette.highlightAsRule) {
        detail.draw(painters.underline, { color: palette.highlight })
      } else {
        detail.draw(painters.highlight, { color: palette.highlight })
      }
    })

    view.addEventListener('show-annotation', (event) => {
      if (this.#disposed) return
      const { value } = (event as CustomEvent<{ value: string }>).detail
      this.#cb.onMarkActivated(value)
    })
    view.addEventListener('relocate', (event) => {
      if (this.#disposed) return
      const detail = (event as CustomEvent<{
        fraction: number
        tocItem?: { label?: string; href?: string } | null
      }>).detail
      this.#cb.onRelocate({
        fraction: detail.fraction,
        chapterLabel: detail.tocItem?.label ?? '',
        chapterHref: detail.tocItem?.href ?? '',
      })
    })

    try {
      const target = deps.prepare ? await deps.prepare(source) : source
      // `prepare` can be slow — a PDF is parsed here — so the latch is
      // consulted before the view is touched with the result.
      if (!this.#settle(view)) return
      await view.open(target as File | string)
    } catch (cause) {
      if (!this.#settle(view)) return
      this.#cb.onError(message(cause, 'This file could not be opened.'))
      return
    }
    if (!this.#settle(view)) return

    this.#cb.onToc(view.book.toc ?? [])
    this.#cb.onMeta(readMeta(view.book))
    this.#cb.onNavigator({
      goTo: (target) => void view.goTo(target),
      search: (query, signal) => runSearch(view, query, signal),
      drawMark: (anchor) => void view.addAnnotation(annotationFor(anchor)),
      eraseMark: (anchor) => void view.addAnnotation(annotationFor(anchor), true),
      deselect: () => view.deselect(),
    })

    // Settings go on BEFORE the first paint, so the reader never flashes
    // foliate's defaults on the way to the configured layout.
    deps.applySettings(view)

    // `open` parses the book and attaches a renderer but navigates nowhere.
    // Without this the view stays empty with a populated table of contents and
    // no iframe, reporting no error to explain it.
    try {
      await view.init({ lastLocation: null, showTextStart: true })
    } catch (cause) {
      if (!this.#settle(view)) return
      this.#cb.onError(message(cause, 'This book could not be displayed.'))
      return
    }
    this.#settle(view)
  }

  /**
   * Re-attach every mark in every live section.
   *
   * The Overlayer's own `redraw()` reuses the options each mark was added with,
   * so it re-paints the old colour after a theme change. Re-adding is what
   * actually re-reads the palette — `add()` drops an existing key first, so
   * this updates in place rather than stacking a second copy.
   */
  redrawMarks(): void {
    const view = this.#view
    if (!view || this.#disposed) return
    for (const index of this.#sections) this.#drawSection(view, index)
  }

  /** Offer every mark belonging to one section to that section's overlay. */
  #drawSection(view: View, index: number): void {
    for (const anchor of this.#cb.getMarks()) {
      if (anchor.sectionIndex !== index) continue
      void view.addAnnotation(annotationFor(anchor))
    }
  }

  /**
   * Report the book's selection to the host.
   *
   * Split across two triggers on purpose. `selectionchange` fires continuously
   * while a drag is in progress, so publishing a snapshot from it would make
   * the popup chase the pointer; it is used only to CLEAR, which is what makes
   * a click-to-dismiss feel immediate. The snapshot itself is published when
   * the gesture ends — pointerup for the mouse, keyup for shift-arrow.
   */
  #watchSelection(doc: Document, view: View, index: number): void {
    const selectionOf = (): Range | null => {
      const selection = doc.defaultView?.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      return selection.getRangeAt(0)
    }

    const publish = () => {
      if (this.#disposed) return
      const range = selectionOf()
      const text = range?.toString().trim() ?? ''
      if (!range || !text) {
        this.#cb.onSelection(null)
        return
      }
      this.#cb.onSelection({ cfi: view.getCFI(index, range), sectionIndex: index, text, range })
    }

    const clearIfCollapsed = () => {
      if (this.#disposed) return
      if (!selectionOf()) this.#cb.onSelection(null)
    }

    doc.addEventListener('pointerup', publish)
    doc.addEventListener('keyup', publish)
    doc.addEventListener('selectionchange', clearIfCollapsed)

    this.#unwatch.push(() => {
      doc.removeEventListener('pointerup', publish)
      doc.removeEventListener('keyup', publish)
      doc.removeEventListener('selectionchange', clearIfCollapsed)
    })
  }

  /** Idempotent, and safe at any point in startup. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cb.onDocument(null)
    this.#cb.onNavigator(null)
    this.#cb.onSelection(null)
    for (const off of this.#unwatch) off()
    this.#unwatch = []
    this.#sections.clear()
    this.#painters = null
    const built = this.#view
    this.#view = null
    if (built) closeQuietly(built)
    this.#host.replaceChildren()
  }
}

/**
 * The object handed to foliate. `value` is the anchor it resolves; `kind` is
 * ours, carried through untouched and read back in `draw-annotation`.
 */
function annotationFor(anchor: MarkAnchor): { value: string; kind: MarkKind } {
  return { value: anchor.cfi, kind: anchor.kind }
}

/**
 * Closed views, so a view is never closed twice.
 *
 * Both `dispose()` and the post-await `#settle()` can legitimately reach the
 * same view: dispose closes what it holds, then the in-flight startup resolves
 * and hands the very same view back. The old `try/catch` hid the second close
 * rather than preventing it — and a swallowed double-close is precisely the
 * kind of thing that looks fine until foliate starts throwing on it.
 */
const CLOSED = new WeakSet<object>()

function closeQuietly(view: View): void {
  if (CLOSED.has(view)) return
  CLOSED.add(view)
  try {
    view.close()
  } catch {
    // close() throws when open() never got far enough to build a renderer.
  }
  view.remove?.()
}

/**
 * Flatten foliate's search stream into plain hits.
 *
 * It yields four different shapes — a progress number, a per-section group, a
 * bare hit, and finally the string 'done' — so the shape has to be narrowed
 * before anything downstream can render it. Section labels arrive on the group
 * and are carried onto the hits inside it, which is what lets a result say
 * which chapter it came from.
 */
async function* runSearch(
  view: View,
  query: string,
  signal: AbortSignal,
): AsyncGenerator<SearchHit> {
  let label = ''
  for await (const result of view.search({ query })) {
    if (signal.aborted) return
    if (result === 'done') return
    if (typeof result !== 'object' || result === null) continue
    if ('progress' in result) continue
    if ('subitems' in result) {
      label = result.label ?? ''
      for (const hit of result.subitems) {
        if (signal.aborted) return
        yield toHit(hit, label)
      }
      continue
    }
    if ('cfi' in result) yield toHit(result, label)
  }
}

function toHit(
  raw: { cfi: string; excerpt: { pre: string; match: string; post: string } },
  label: string,
): SearchHit {
  return {
    cfi: raw.cfi,
    label,
    pre: raw.excerpt?.pre ?? '',
    match: raw.excerpt?.match ?? '',
    post: raw.excerpt?.post ?? '',
  }
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

/** foliate's metadata is loosely typed: title may be a language map, author a
 *  string, an object, or an array of either. */
export function readMeta(book: { metadata?: unknown }): BookMeta {
  const md = (book.metadata ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ')
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>
      const name = rec['name']
      if (typeof name === 'string') return name
      const first = Object.values(rec)[0]
      if (typeof first === 'string') return first
    }
    return ''
  }
  return { title: text(md['title']), author: text(md['author']) }
}
