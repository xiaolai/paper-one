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
  /**
   * A book was dropped ON the book — see `#watchDrops`.
   *
   * The host cannot see this one: the reader is full of iframes once a book is
   * open, and a drop lands in whichever document is under the pointer.
   */
  onFileDropped: (file: File) => void
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
  /**
   * §11's ← and →.
   *
   * Not optional chrome: a fixed-layout book — every PDF — does not scroll,
   * so these are the ONLY way through it. A scrolled EPUB hid that for a long
   * time, because scrolling worked and nobody missed the binding.
   */
  next: () => void
  prev: () => void
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

/**
 * `Node.ELEMENT_NODE`, spelled as its value.
 *
 * This module's tests run in plain node with no DOM — see `session.test.ts` —
 * so the `Node` global is not there to read the constant off. The suite caught
 * it immediately, which is the argument for keeping those tests DOM-free.
 */
const ELEMENT_NODE = 1

/**
 * A prepared book that owns resources of its own.
 *
 * `View.close()` closes the RENDERER; it knows nothing about a book object the
 * app synthesised, so a PDF's object URLs and its pdf.js loading task — worker
 * and transport included — survived every close and accumulated one set per
 * book opened. The session owns what it prepared, so it destroys it too.
 */
interface Destroyable {
  destroy: () => void
}

function destroyable(value: unknown): value is Destroyable {
  return typeof (value as Destroyable | null)?.destroy === 'function'
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
  /**
   * Per-document listener teardown, keyed by the document itself.
   *
   * A Map rather than an array, because an array only grows: foliate loads a
   * new document for every section the reader passes through, so a long book
   * accumulated one closure per section — each retaining its document, and for
   * a PDF the page canvas with it — until the book was closed. Keying by
   * document means re-loading one replaces its entry, and a WeakRef is
   * unnecessary because the entry is dropped explicitly.
   */
  readonly #unwatch = new Map<Document, (() => void)[]>()
  /** Which spine item each live document is, so a per-document redraw can find
   *  the one section it needs to touch. */
  readonly #indexOf = new WeakMap<Document, number>()
  /** A book this session synthesised, which `View.close()` will not release. */
  #prepared: Destroyable | null = null
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

  /**
   * Bring a book up, from nothing on screen to a first page.
   *
   * Five steps, each its own method below. They were one 136-line function, and
   * the length was not the problem — the RESPONSIBILITIES were: acquiring
   * resources, mounting DOM, binding events, opening the book and publishing an
   * API each fail differently and each has its own rollback, and reading which
   * `return` left which of them half-done meant holding all five in your head
   * at once. The disposal latch is checked between every pair, because each
   * step contains an await the caller can unmount across.
   */
  async start(source: File | string, deps: SessionDeps): Promise<void> {
    const view = await this.#acquire(deps)
    if (!view) return

    this.#mount(view)
    this.#bind(view)

    if (!(await this.#openBook(view, source, deps))) return

    this.#publish(view, deps)
    await this.#display(view)
  }

  /**
   * The view and the painters, or null if either failed.
   *
   * `allSettled`, not `all`: `all` rejects the moment either side fails while
   * the other keeps going, so a painters failure would strand a perfectly good
   * view with nothing holding a reference to close it — the same leak this
   * class exists to prevent, reintroduced one layer up.
   */
  async #acquire(deps: SessionDeps): Promise<View | null> {
    const [built, painted] = await Promise.allSettled([
      deps.createView(),
      deps.loadPainters(),
    ])

    if (built.status === 'rejected') {
      if (!this.#disposed) {
        this.#cb.onError(message(built.reason, 'The reader failed to start.'))
      }
      return null
    }
    const view = built.value
    if (!this.#settle(view)) return null

    if (painted.status === 'rejected') {
      // The view is settled, so dispose() will close it — the same contract as
      // a failed open, where the book stays closable.
      this.#cb.onError(message(painted.reason, 'The reader failed to start.'))
      return null
    }
    this.#painters = painted.value
    return view
  }

  /** Put the view in the host, filling it. */
  #mount(view: View): void {
    view.style.position = 'absolute'
    view.style.inset = '0'
    this.#host.replaceChildren(view)
  }

  /**
   * Subscribe to everything the view emits.
   *
   * Every listener consults the latch before touching shared state. A closing
   * view still emits these, and without the guard a dying book overwrites the
   * document and position of the one that replaced it.
   */
  #bind(view: View): void {
    view.addEventListener('load', (event) => {
      if (this.#disposed) return
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail
      // A section re-loaded is the same document with fresh content, so its
      // previous listeners are dropped before new ones go on — otherwise every
      // return to a section doubles them.
      this.#resetWatchers(doc)
      this.#watchSelection(doc, view, index)
      this.#watchKeys(doc)
      this.#watchDrops(doc)
      /* The overlay for this section dies with its document, so the section
       * leaves the live set at the same moment. Without this the set only ever
       * grew: a redraw after a theme change then re-resolved a CFI into every
       * section the reader had ever passed through, against overlays that no
       * longer exist — work that rises with the length of the reading session
       * and accomplishes nothing after the first few. */
      this.#indexOf.set(doc, index)
      this.#onTeardown(doc, () => this.#sections.delete(index))

      this.#redrawWhenFontsLand(doc)

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
        /** foliate emits this; it is the document the rects were measured in. */
        doc?: Document
      }>).detail
      const painters = this.#painters
      if (!painters) return
      if (detail.annotation?.value && detail.range) {
        this.#cb.onMarkDrawn(detail.annotation.value, detail.range)
      }
      const palette = this.#cb.getPalette()
      /* The book document travels with the draw options so the highlight
       * painter can read the font the rects were measured in — see
       * `balanceRects`. Taken from the range rather than added to the event
       * type, because the range is already in hand and cannot disagree. */
      /* From the EVENT, not rebuilt from the range. `startContainer` can be a
       * Document when a range spans a whole node, and `ownerDocument` on a
       * Document is null — so the reconstruction lost exactly the case it was
       * meant to cover. */
      const doc = detail.doc ?? detail.range?.startContainer?.ownerDocument ?? null
      /* The element the marked words are in, so the band is measured against
       * the font they are actually drawn in rather than the book's default —
       * a mark in a heading or a code span is not body text. */
      const container = detail.range?.startContainer ?? null
      const at =
        container && container.nodeType === ELEMENT_NODE
          ? (container as Element)
          : (container?.parentElement ?? null)
      // §01: your own mark is a gold fill, the companion's is an amber
      // underline. The kind rides along on the annotation so the painter does
      // not have to look the mark up again.
      if (detail.annotation?.kind === 'companion') {
        detail.draw(painters.underline, { color: palette.companion })
      } else if (palette.highlightAsRule) {
        detail.draw(painters.underline, { color: palette.highlight })
      } else {
        detail.draw(painters.highlight, { color: palette.highlight, doc, at })
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
  }

  /** Parse the source and open it. False means stop — failed or disposed. */
  async #openBook(view: View, source: File | string, deps: SessionDeps): Promise<boolean> {
    try {
      const target = deps.prepare ? await deps.prepare(source) : source
      // Held so disposal can release it — see `Destroyable`.
      if (target !== source && destroyable(target)) {
        /* Unless disposal already happened while the PDF was being parsed, in
         * which case nothing will ever read this field again and the book has
         * to be released here. It is the expensive case, too: parsing is the
         * slow step, so the race is likeliest exactly when the object being
         * dropped owns a worker and a set of object URLs. */
        if (this.#disposed) destroyQuietly(target)
        else this.#prepared = target
      }
      // `prepare` can be slow — a PDF is parsed here — so the latch is
      // consulted before the view is touched with the result.
      if (!this.#settle(view)) return false
      await view.open(target as File | string)
    } catch (cause) {
      if (!this.#settle(view)) return false
      this.#cb.onError(message(cause, 'This file could not be opened.'))
      return false
    }
    return this.#settle(view)
  }

  /** Hand the book's contents and its navigation to the host. */
  #publish(view: View, deps: SessionDeps): void {
    this.#cb.onToc(view.book.toc ?? [])
    this.#cb.onMeta(readMeta(view.book))
    this.#cb.onNavigator({
      /* Every navigation reports its own failure. These are async and were
       * discarded, so a target that will not resolve — a dead link in a table
       * of contents, a PDF destination pointing at a page that is not there —
       * surfaced as an unhandled rejection at the window rather than as a line
       * saying which link it was. Nothing is shown to the reader: a link that
       * goes nowhere should do nothing, not raise a dialog. */
      goTo: (target) => void view.goTo(target).catch(reportNavigation('goTo', target)),
      search: (query, signal) => runSearch(view, query, signal),
      // Reported, unlike the speculative offers made when an overlay is
      // created: this one is a direct response to the reader marking something,
      // so a failure is a mark that silently did not appear.
      drawMark: (anchor) => attachMark(view, anchor, { report: true }),
      eraseMark: (anchor) => attachMark(view, anchor, { remove: true, report: true }),
      deselect: () => view.deselect(),
      next: () => void view.next()?.catch?.(reportNavigation('next')),
      prev: () => void view.prev()?.catch?.(reportNavigation('prev')),
    })

    // Settings go on BEFORE the first paint, so the reader never flashes
    // foliate's defaults on the way to the configured layout.
    deps.applySettings(view)
  }

  /**
   * Show the first section.
   *
   * `open` parses the book and attaches a renderer but navigates NOWHERE.
   * Without this the view stays empty with a populated table of contents and no
   * iframe, reporting no error to explain it.
   */
  async #display(view: View): Promise<void> {
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
      attachMark(view, anchor)
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

    this.#onTeardown(doc, () => {
      doc.removeEventListener('pointerup', publish)
      doc.removeEventListener('keyup', publish)
      doc.removeEventListener('selectionchange', clearIfCollapsed)
    })
  }

  /**
   * Forward the book's keystrokes to the host.
   *
   * The book is an iframe with its own document, and clicking a page to read it
   * puts focus inside that document — where every subsequent keystroke stays.
   * A listener on the host window never sees them, so the ENTIRE keyboard map
   * stopped working the moment the reader touched the thing they were reading:
   * not just ← and →, but ⌘K, ⌘\, ⌘1…5 and Esc.
   *
   * It shows up worst on a fixed-layout book, where the arrows are the only way
   * to turn a page and scrolling cannot cover for them — a PDF simply stayed on
   * page one.
   *
   * Re-dispatching rather than handling here keeps one keymap in the app. The
   * session has no business knowing what any key means; it only makes sure the
   * event reaches the place that does.
   */
  #watchKeys(doc: Document): void {
    const onKey = (event: KeyboardEvent) => {
      if (this.#disposed) return

      /* Typing inside the book stays inside the book.
       *
       * The host's keymap guards on `event.target` being a field — and the
       * forwarded event's target is the WINDOW, so that guard cannot see a
       * field inside the iframe. An EPUB with a form in it, or any content the
       * book itself makes editable, would have every arrow key turn the page
       * out from under the cursor. The check has to happen here, where the real
       * target is still available. */
      const target = event.target as HTMLElement | null
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return
      }

      const forwarded = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(forwarded)

      /* Carry the cancellation back across the boundary.
       *
       * `preventDefault` on the copy does nothing to the original, so a key the
       * host handled ALSO kept its default inside the book: PageDown turned the
       * page and scrolled the document it had just left, and Space did both at
       * once. The two documents have to agree about whether the key was
       * consumed, and this is the only place that knows. */
      if (forwarded.defaultPrevented) event.preventDefault()
    }
    doc.addEventListener('keydown', onKey)
    this.#onTeardown(doc, () => doc.removeEventListener('keydown', onKey))
  }

  /**
   * Intercept a book dropped onto the book.
   *
   * Without this the webview NAVIGATES to the dropped file and the whole
   * application is replaced by WebKit's PDF viewer — an <embed> at a file://
   * URL, no titlebar, no pane, no reader, no error, no way back. The host
   * already prevents that at the window, but a drop over an iframe is
   * delivered to THAT document and never reaches the window at all. So the
   * first drop onto an empty reader worked and the second, onto the open book,
   * did not.
   *
   * `dragover` is the load-bearing prevention: without it there is no drop
   * event and the navigation happens regardless of what the drop handler says.
   *
   * The file is handed over directly rather than re-dispatched. A DragEvent
   * cannot carry its dataTransfer across a synthetic re-dispatch, and the
   * documents are same-origin, so passing the File itself is both simpler and
   * the only thing that actually works.
   */
  #watchDrops(doc: Document): void {
    const allow = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent) => {
      // Unconditional: a dropped URL navigates away just as a file does.
      event.preventDefault()
      if (this.#disposed) return
      const file = event.dataTransfer?.files?.item(0)
      if (file) this.#cb.onFileDropped(file)
    }

    doc.addEventListener('dragenter', allow)
    doc.addEventListener('dragover', allow)
    doc.addEventListener('drop', onDrop)
    this.#onTeardown(doc, () => {
      doc.removeEventListener('dragenter', allow)
      doc.removeEventListener('dragover', allow)
      doc.removeEventListener('drop', onDrop)
    })
  }

  /**
   * Register teardown for one document, replacing any it already had.
   *
   * foliate re-loads a section every time the reader returns to it, and each
   * load re-runs the watchers. Without replacing, the same document
   * accumulates duplicate listeners — every keystroke forwarded twice, every
   * page turn advancing two spreads — and every superseded closure keeps its
   * document alive.
   *
   * `pagehide` releases the entry as the document goes away, so a book read
   * end to end does not carry every section it passed through.
   */
  #onTeardown(doc: Document, off: () => void): void {
    const existing = this.#unwatch.get(doc)
    if (existing) {
      this.#unwatch.set(doc, [...existing, off])
      return
    }
    this.#unwatch.set(doc, [off])
    doc.defaultView?.addEventListener(
      'pagehide',
      () => {
        for (const fn of this.#unwatch.get(doc) ?? []) fn()
        this.#unwatch.delete(doc)
      },
      { once: true },
    )
  }

  /**
   * Redraw this document's marks once its webfont has actually arrived.
   *
   * A mark's band is positioned against the font's metrics — see
   * `balanceRects` — and a section renders before the face loads, so the first
   * paint measures the fallback. Without a redraw the band keeps the
   * fallback's geometry for as long as the section is on screen.
   *
   * BOTH signals, because neither alone is enough. `fonts.ready` can already
   * be fulfilled at the moment this runs: it is read inside foliate's `load`
   * callback, before the iframe has rendered anything, so the set may be idle
   * and the promise resolves immediately — before the face the render is about
   * to request has even been asked for. `loadingdone` fires when a later cycle
   * finishes, which is the one that matters. Redrawing twice is harmless;
   * `addAnnotation` replaces rather than stacks.
   */
  #redrawWhenFontsLand(doc: Document): void {
    const fonts = doc.fonts
    if (!fonts) return

    const redraw = () => {
      /* This document's own section, not every live one. The liveness check
       * alone was not enough: a font settling in any still-mounted section
       * redrew all of them, which for a book with marks in three rendered
       * sections is three times the CFI resolution for one font event. */
      if (this.#disposed || !this.#unwatch.has(doc)) return
      const view = this.#view
      const index = this.#indexOf.get(doc)
      if (!view || index === undefined || !this.#sections.has(index)) return
      this.#drawSection(view, index)
    }

    fonts.addEventListener('loadingdone', redraw)
    this.#onTeardown(doc, () => fonts.removeEventListener('loadingdone', redraw))

    /* No catch. `FontFaceSet.ready` does not reject — a document torn down
     * mid-load simply never settles it — so a catch here could only ever
     * swallow a failure thrown by `redrawMarks` itself, which is the opposite
     * of what a teardown guard is for. */
    void fonts.ready.then(redraw)
  }

  /** Drop the listeners a document had, before re-registering them. */
  #resetWatchers(doc: Document): void {
    for (const off of this.#unwatch.get(doc) ?? []) off()
    this.#unwatch.delete(doc)
  }

  /** Idempotent, and safe at any point in startup. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cb.onDocument(null)
    this.#cb.onNavigator(null)
    this.#cb.onSelection(null)
    for (const offs of this.#unwatch.values()) for (const off of offs) off()
    this.#unwatch.clear()
    this.#sections.clear()
    this.#painters = null
    const prepared = this.#prepared
    this.#prepared = null
    if (prepared) destroyQuietly(prepared)
    const built = this.#view
    this.#view = null
    if (built) closeQuietly(built)
    this.#host.replaceChildren()
  }
}

/**
 * Release a prepared book, reporting a failure rather than hiding it.
 *
 * Best effort because a half-open document must not stop the rest of teardown —
 * but loud, because what is being released here is a worker and a set of object
 * URLs, and a silent failure to release them is a leak that grows one book at a
 * time with nothing on screen to suggest it.
 */
function reportNavigation(what: string, target?: string): (cause: unknown) => void {
  return (cause) => {
    console.warn(`Paper: ${what}${target ? ` ${target}` : ''} failed`, cause)
  }
}

function destroyQuietly(prepared: Destroyable): void {
  try {
    prepared.destroy()
  } catch (cause) {
    console.error('Paper: failed to destroy the prepared book', cause)
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
 * Attach or erase one mark, tolerating an anchor that does not resolve.
 *
 * Unlike the silent catches this file has had to remove, this failure is
 * expected and specific: a CFI addresses a position in a document, and a PDF
 * page has no text in it until it has been painted. Marks are offered when the
 * section's overlay is created — before that paint — and offered again once it
 * lands, which is when they take. Reporting the first attempt would log a line
 * per mark per page on every book that has any.
 *
 * Which is why `report` exists rather than the catch being unconditional. That
 * reasoning covers the speculative offer and NOTHING else: when the reader
 * marks a passage, or removes one, a failure means the mark they just made did
 * not appear, there is no retry coming, and swallowing it leaves them looking
 * at a page that quietly disagrees with the notes panel.
 */
interface AttachOptions {
  readonly remove?: boolean
  readonly report?: boolean
}

function attachMark(view: View, anchor: MarkAnchor, options: AttachOptions = {}): void {
  const { remove = false, report = false } = options
  const fail = (cause: unknown) => {
    if (report) console.error(`Paper: could not ${remove ? 'erase' : 'draw'} a mark`, cause)
  }
  try {
    const pending = view.addAnnotation(annotationFor(anchor), remove)
    void pending?.catch?.(fail)
  } catch (cause) {
    // Threw synchronously — same case, same reasoning.
    fail(cause)
  }
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
