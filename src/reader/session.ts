import type {
  CreateOverlayDetail,
  DrawAnnotationDetail,
  LoadDetail,
  RelocateDetail,
  TocItem,
  View,
} from 'foliate-js/view.js'
import type { MarkKind } from '../lib/marks'
import type { BookMeta, ReaderPosition } from '../lib/useBook'
import { deferSnap } from './wordSnap/deferredSnap'
import { watchGestureProvenance } from './wordSnap/gestureProvenance'
import { createReflowGuard } from './wordSnap/invalidate'
import { wheelPager, type PageIntent } from './wheelPaging'
import { markContext } from './wordSnap/markContext'
import { rangeText } from './wordSnap/rangeText'

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

/**
 * Is the pointer over a box the BOOK's own author made scrollable?
 *
 * A code listing or a wide table in an `overflow: auto` div is ordinary book
 * markup, and its content has to stay reachable — so an event over one belongs
 * to it, not to page turning.
 *
 * Deliberately stops at `body`. The document scroller above it is the
 * renderer's, and handing events back to that is what the flow question below
 * decides; answering it here as well would consume nothing and page nothing.
 *
 * `overflow: auto` and `scroll` only — `hidden` is scrollable via script but
 * not by a wheel, and treating it as scrollable would swallow gestures over any
 * clipped box, which is a very common thing for a book to contain.
 */
function scrollableUnder(event: WheelEvent): boolean {
  const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX)
  const delta = vertical ? event.deltaY : event.deltaX
  if (delta === 0) return false

  let node = event.target as Element | null
  for (; node && node.nodeName !== 'BODY' && node.nodeName !== 'HTML'; node = node.parentElement) {
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node)
    if (!style) continue
    const overflow = vertical ? style.overflowY : style.overflowX
    if (overflow !== 'auto' && overflow !== 'scroll') continue

    const size = vertical ? node.clientHeight : node.clientWidth
    const content = vertical ? node.scrollHeight : node.scrollWidth
    const position = vertical ? node.scrollTop : node.scrollLeft
    const remaining = content - size
    if (remaining <= 1) continue
    /* Only while it can still MOVE the way the gesture asks. A box scrolled to
     * its end must hand the gesture on, or the reader is stuck at the foot of a
     * code listing with a page that will not turn. */
    if (delta > 0 ? position < remaining - 1 : position > 1) return true
  }
  return false
}

/**
 * How long after scrolling backwards a page may still arrive and open at its foot.
 *
 * A page load that a gesture caused follows it within a frame or two; anything
 * slower than this came from somewhere else. Generous rather than tight because
 * failing the check is a real cost — the reader lands at the head of the page
 * and has to scroll down through it — while passing it late costs one surprising
 * scroll position.
 */
const ENTER_AT_FOOT_MS = 1500

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
  /**
   * The text on either side of the selection — see `markContext`.
   *
   * Read HERE, from the live range, because this is the only place it exists.
   * By the time a mark is stored the range is gone, and recovering the context
   * from a stored mark means re-opening the book and resolving its CFI.
   */
  readonly prefix: string
  readonly suffix: string
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
  /**
   * A wheel gesture asked for another page — see `wheelPaging`.
   *
   * A semantic event rather than the wheel events it came from. The keymap is
   * forwarded raw because keystrokes are occasional and the host owns the map;
   * wheel events arrive tens per second, and re-dispatching each one to be
   * accumulated somewhere else would be waste. The gesture is recognised where
   * the events land, and what it MEANS is still the host's to decide.
   */
  onPageIntent: (intent: PageIntent) => void
  /**
   * The book is fixed-layout, so it cannot REFLOW — but it can still scroll.
   *
   * The second half of that used to say it could not, and this work is what made
   * it false: the same Flow setting reaches `foliate-fxl` as `zoom`, where
   * `fit-width` overflows a page and the renderer scrolls it. What a fixed
   * layout cannot do is re-break text, which is what the reading ruler and the
   * measure depend on.
   *
   * Published because the app offers controls that only mean something for a
   * reflowable book, and a control wired to nothing is worse than an absent one.
   * Read from the view rather than guessed from the file extension: a PDF is
   * always fixed-layout, and an EPUB declaring `pre-paginated` is too.
   */
  onFixedLayout: (fixed: boolean) => void
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
  /**
   * The page to the left, and to the right — in VISUAL terms.
   *
   * Distinct from `next`/`prev` and not a synonym for them: in a right-to-left
   * book the next page is the one on the LEFT. foliate resolves that through
   * the book's own `dir`, so a gesture that knows only which way the reader
   * pushed can hand the question over rather than answering it twice.
   */
  goLeft: () => void
  goRight: () => void
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
  /**
   * Where this book was last left, if anywhere.
   *
   * A getter, and read at the LAST possible moment — after the book has been
   * parsed — because the saved position is keyed by the book's content-derived
   * id, which resolves asynchronously alongside the open. Reading it when the
   * session is constructed would be reading it before it can be known.
   *
   * Returning null means the start of the book, which is also what a position
   * the book no longer contains falls back to. See `#display`.
   */
  lastLocation?: () => string | null
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

/**
 * Whether a range still describes something in the document.
 *
 * BOTH ends, because a range with one live boundary and one dead one is not a
 * half-success — it is a selection nobody can see, and `applySnap` refuses to
 * write one for the same reason. `isConnected` is transitive: a text node whose
 * grandparent was replaced still points at its own parent and is still
 * disconnected, which is exactly the shape `replaceChildren()` leaves behind.
 */
function connectedRange(range: Range): boolean {
  return range.startContainer.isConnected && range.endContainer.isConnected
}

export class ReaderSession {
  #disposed = false
  #view: View | null = null
  /** One per session — a gesture can span a spine boundary. See `#watchWheel`. */
  readonly #pager = wheelPager()
  /**
   * The next page to load was reached by scrolling BACKWARDS, so open its foot.
   *
   * Only ever set for a fit-width fixed-layout book, where one page is one
   * section and scrolling is the reading motion. Without it, scrolling up at the
   * head of a page loads the previous one at ITS head — so the reader is at the
   * top again, scrolls up again, and skips backwards through the book without
   * seeing any of it. Reading forwards has no equivalent problem, because the
   * head of the next page is where it should start.
   *
   * A TIME rather than a boolean, because arming it is not proof that anything
   * will load. `prev()` at the very first page navigates nowhere, and a
   * fixed-layout renderer can move within a spread without emitting `load` — so
   * a plain flag could stay armed indefinitely and then send some unrelated
   * later page, reached by a tap in the contents, to its foot. Bounding it keeps
   * the worst case inside the moment the gesture happened.
   */
  #enterAtFootAt: number | null = null
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

  /**
   * The document whose selection is currently on screen, or null.
   *
   * Session-level because a fixed-layout spread has TWO live documents, each
   * running its own `#watchSelection`. This used to be a `published` boolean
   * inside each closure, so both could believe they owned the popup: selecting
   * in the left page then the right left the left one still flagged, and the
   * next repaint or collapse over there took down the right page's newer
   * selection. Ownership is single by construction now — publishing transfers
   * it, and only the holder may clear.
   */
  #selectionOwner: Document | null = null
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
    await this.#display(view, deps)
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
      const { doc, index } = (event as CustomEvent<LoadDetail>).detail
      // A section re-loaded is the same document with fresh content, so its
      // previous listeners are dropped before new ones go on — otherwise every
      // return to a section doubles them.
      this.#resetWatchers(doc)
      this.#openAtFootIfArrivedBackwards()
      this.#watchSelection(doc, view, index)
      this.#watchKeys(doc)
      this.#watchWheel(doc)
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
      const { index } = (event as CustomEvent<CreateOverlayDetail>).detail
      this.#sections.add(index)
      this.#drawSection(view, index)
    })

    view.addEventListener('draw-annotation', (event) => {
      if (this.#disposed) return
      /* The shared declaration, not a copy. These shapes were written out
       * inline here and declared again in `vite-env.d.ts`, and the two had
       * already drifted — this one made `annotation.value` optional where the
       * declaration requires it, which is the difference between a guard that
       * is load-bearing and one that is noise. */
      const detail = (event as CustomEvent<DrawAnnotationDetail>).detail
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
      const detail = (event as CustomEvent<RelocateDetail>).detail
      this.#cb.onRelocate({
        fraction: detail.fraction,
        chapterLabel: detail.tocItem?.label ?? '',
        chapterHref: detail.tocItem?.href ?? '',
        // Carried through rather than dropped, which is what this handler used
        // to do with it. It is what `lastLocation` below is given back.
        cfi: detail.cfi ?? null,
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
      goLeft: () => void view.goLeft()?.catch?.(reportNavigation('goLeft')),
      goRight: () => void view.goRight()?.catch?.(reportNavigation('goRight')),
    })

    this.#cb.onFixedLayout(view.isFixedLayout)

    // Settings go on BEFORE the first paint, so the reader never flashes
    // foliate's defaults on the way to the configured layout.
    deps.applySettings(view)
  }

  /**
   * Show where the reader left off, or the first section.
   *
   * `open` parses the book and attaches a renderer but navigates NOWHERE.
   * Without this the view stays empty with a populated table of contents and no
   * iframe, reporting no error to explain it.
   *
   * A saved position is UNTRUSTED input, even though this app wrote it: books
   * are identified by hashing their ends, so a re-exported or re-encoded
   * edition can inherit a position from a file whose spine it no longer
   * matches. Losing the book over a stale bookmark is the worse of the two
   * failures, so a failed restore is retried from the start and only a failure
   * with no position to blame is reported to the reader.
   *
   * Be precise about what that retry is FOR, because foliate covers most of it
   * already: `resolveNavigation` catches its own errors and returns nothing, so
   * a CFI that cannot be resolved at all falls through to `showTextStart`
   * inside `init` and never reaches this catch. What does reach it is a
   * position that resolves to a section and then fails to RENDER — and that is
   * the case where retrying is the difference between a book and an error.
   */
  async #display(view: View, deps: SessionDeps): Promise<void> {
    const saved = deps.lastLocation?.() ?? null

    /* Wrapped rather than thrown, so a book that fails BOTH attempts reports
     * the second failure and not a stale first one. A bare `catch` variable
     * cannot say "nothing failed" — a thrown `undefined` is indistinguishable
     * from no throw at all. */
    const show = async (at: string | null): Promise<{ cause: unknown } | null> => {
      try {
        await view.init({ lastLocation: at, showTextStart: true })
        return null
      } catch (cause) {
        return { cause }
      }
    }

    let failed = await show(saved)

    if (failed && saved !== null && !this.#disposed) {
      /* Loud, but not at the reader: they asked to read a book and they get
       * one. Silence here would make a position that never restores look
       * exactly like a book nobody had opened before. */
      console.warn('Paper: the saved position could not be restored', failed.cause)
      failed = await show(null)
    }

    if (!this.#settle(view)) return
    if (failed) this.#cb.onError(message(failed.cause, 'This book could not be displayed.'))
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
   * Split across three triggers on purpose. `selectionchange` fires
   * continuously while a drag is in progress, so publishing a snapshot from it
   * would make the popup chase the pointer; it is used only to CLEAR, which is
   * what makes a click-to-dismiss feel immediate and is why that path is never
   * deferred. The snapshot itself is published when the gesture ends — and the
   * two gestures end differently:
   *
   * - **pointerup** hands the selection to the deferred snap, and the snapshot
   *   is published when that settles. A drag is what word snapping is for, and
   *   the deferral is WI-8's: writing a wider selection while foliate's
   *   paginator still has its pointer flag up turns the page
   *   (`paginator.js:586`). It publishes whether or not the snap wrote
   *   anything: provenance decides whether the selection is WIDENED, never
   *   whether it is reported, and a pointer gesture that published nothing
   *   would leave the reader with no toolbar to mark or copy from. Only a
   *   CANCELLED snap publishes nothing — a section torn down or a PDF page
   *   repainted, where there is no longer a gesture to report.
   * - **keyup** publishes immediately and unsnapped. Shift+arrow is
   *   character-granular, and taking that away is the one thing the keyboard
   *   selection has over the mouse's.
   */
  #watchSelection(doc: Document, view: View, index: number): void {
    const selectionOf = (): Range | null => {
      const selection = doc.defaultView?.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
      return selection.getRangeAt(0)
    }

    /** Whether THIS document's snapshot is the one on screen, so a repaint
     *  knows whether it has a popup to take down. Asked of `#selectionOwner`
     *  rather than kept per document — see that field — and not asked of the
     *  host, because publishing `null` on every repaint would churn the popup
     *  state continuously through a pinch. */
    const owns = () => this.#selectionOwner === doc

    /**
     * Publish one range — always one the caller has just read, never one
     * captured before a mutation.
     *
     * That is the whole reason this takes an argument. `setBaseAndExtent`
     * DETACHES a previously issued `Range` (measured in WebKit): the captured
     * one keeps returning the old text while the live selection returns the
     * snapped text, so a `publish` that read its range once and used it either
     * side of the snap would store a cfi and a text describing a selection the
     * reader never made. `applySnap` returns the range it read AFTER the write
     * for exactly this call.
     *
     * The text is not `range.toString()` either — see `rangeText`, which spells
     * block boundaries and drops the invisible characters that must not reach
     * stored mark text.
     */
    const publish = (range: Range | null) => {
      if (this.#disposed) return
      /* A range whose ends have LEFT the document describes a page that no
       * longer exists. On a PDF that is what a zoom does — `makePdf`'s `paint`
       * calls `replaceChildren()` on the text layer — and WI-8's deferral means
       * a snap can settle just after it, holding a range over nodes nobody can
       * see. Publishing it would put the popup over a re-laid-out page pointing
       * at nothing, which is worse than publishing nothing. */
      const live = range && connectedRange(range) ? range : null
      const text = live ? rangeText(live) : ''
      if (!live || !text) {
        /* Ownership goes with the popup: once null is published there is
         * nothing on screen for anyone to own. The guard against one page of a
         * spread taking down the other page's newer selection belongs at the
         * REPAINT site, which asks `owns()` before calling here at all — not in
         * this function, which must keep emitting null for every caller that
         * reaches it or a collapsed selection stops dismissing the popup. */
        this.#selectionOwner = null
        this.#cb.onSelection(null)
        return
      }
      this.#selectionOwner = doc
      const context = markContext(live)
      this.#cb.onSelection({
        cfi: view.getCFI(index, live),
        sectionIndex: index,
        text,
        prefix: context.prefix,
        suffix: context.suffix,
        range: live,
      })
    }

    const publishLive = () => publish(selectionOf())

    const clearIfCollapsed = () => {
      if (this.#disposed) return
      // Through `publish`, so the "is a popup up?" flag comes down with it. A
      // clear that went straight to the callback would leave the flag saying
      // `true`, and the next repaint would clear an already-cleared popup.
      if (!selectionOf()) publish(null)
    }

    /**
     * Where the selection came from, kept per document alongside the
     * publishers.
     *
     * The snap reads it when it runs — never when it is scheduled — so a
     * selection replaced between the gesture and the macrotask is not snapped,
     * and a shift+arrow selection followed by a context-click is not either.
     * Both are bound here rather than beside the snap so that every listener in
     * this section lives and dies through the one teardown path — see
     * `#onTeardown`, which is also where the pending snap is cancelled.
     *
     * Its `pointerup` listener is a second one on this document, and on a PDF
     * page `bindSelectionFix` adds a third (`makePdf.ts:82`). None of the three
     * may depend on running first, and none does: this one only lowers a flag,
     * and scheduling a macrotask cannot be observed by either of the others.
     */
    const provenance = watchGestureProvenance(doc)
    const snap = deferSnap(doc, {
      isPointerProduced: provenance.isPointerProduced,
      onSettled: (application) => publish(application.range),
    })

    /**
     * A PDF page repainting underneath all of this.
     *
     * `makePdf`'s `paint` takes a render generation at the top of every zoom or
     * re-render and finishes by calling `replaceChildren()` on the `.textLayer`
     * — so both the pending snap and the published snapshot are about to be
     * describing nodes that have left the document. Neither is recoverable, and
     * a selection that is silently re-anchored to whatever now sits at those
     * offsets is the outcome this exists to prevent: the snap is dropped, and
     * the popup comes down.
     *
     * Not a `MutationObserver`: the generation already exists, is already what
     * `paint` consults, and — unlike an observer — is reachable from the only
     * test lane this repository has. The notification fires when the repaint
     * STARTS, which is a moment before the nodes go, so this may not decide
     * anything by asking whether they are still attached; at that moment they
     * always are.
     *
     * An EPUB section never repaints this way, so its guard is never bumped and
     * none of this ever runs for one.
     */
    const offReflow = createReflowGuard(doc).onReflow(() => {
      snap.cancel()
      if (owns()) publish(null)
    })

    doc.addEventListener('pointerup', snap.schedule)
    doc.addEventListener('keyup', publishLive)
    doc.addEventListener('selectionchange', clearIfCollapsed)

    this.#onTeardown(doc, () => {
      provenance.unbind()
      /* Not a DOM listener, so the listener-count assertions cannot see it: a
       * section returned to twice would otherwise leave two watchers reacting
       * to one repaint, each retaining this session and its document. */
      offReflow()
      /* Before the listeners come off, and covering both the section going away
       * and the whole session being disposed: `dispose()` runs every teardown
       * list it holds. A timer left armed here fires into a document nobody is
       * reading and writes to its selection — the publish would be caught by
       * the disposal latch, but the mutation would already have happened. */
      snap.cancel()
      doc.removeEventListener('pointerup', snap.schedule)
      doc.removeEventListener('keyup', publishLive)
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
   * Does the platform have a real scroll to perform with this event?
   *
   * Asked of the renderer, not of the app: what a gesture MEANS is the host's
   * question and is answered in `Reader`, but whether the event has a default
   * worth suppressing is a fact about the renderer. It has to be settled here,
   * because `preventDefault` counts only synchronously inside the listener.
   *
   * THE TWO RENDERERS ANSWER IT DIFFERENTLY, and asking only `flow` was the
   * regression that killed swiping on PDFs. A fixed-layout book is drawn by
   * `foliate-fxl`, whose `observedAttributes` is `['zoom']` — `flow` sits on it
   * unread, so reading it back meant a reader who had ever chosen scrolled mode
   * got a PDF that ignored every gesture, in a renderer that could not scroll
   * either way.
   *
   *   paginator, `flow="scrolled"`  — its scrollport is inside a CLOSED shadow
   *     root, so the host cannot even see it. Hands the event straight back.
   *
   *   fxl, `zoom="fit-width"`       — the scrollport IS the renderer element
   *     (`:host { overflow: auto }`), so its position is readable from here and
   *     the answer can be exact: hand the event back while the page has further
   *     to go, and take it at the edge so the gesture turns the page instead.
   *     That edge check is what makes a PDF read continuously — reaching the
   *     bottom of one page carries on to the next, rather than stranding the
   *     reader on page one with a dead trackpad.
   */
  /**
   * Land on the foot of a page the reader reached by scrolling up into it.
   *
   * Deferred by a frame, and that is the whole difficulty. The `load` event
   * fires when the page's document is ready, which is BEFORE `foliate-fxl` has
   * scaled the frame — so `scrollHeight` at this instant is the pre-layout
   * value and scrolling to it lands somewhere arbitrarily short. A frame later
   * the layout is settled.
   *
   * A SUSPENDED FRAME RESUMES, which is the part that has to be defended
   * against and which an earlier comment here got wrong. An occluded window
   * stops servicing `requestAnimationFrame` — this project has been caught by
   * that before — but it does not cancel the callback: it runs when the window
   * comes back, which may be minutes and several pages later. So the deadline is
   * re-checked INSIDE the frame rather than only before scheduling it, and the
   * renderer is the one captured when the page loaded rather than whichever is
   * current when the frame finally arrives. Without both, coming back to an
   * occluded reader scrolled whatever page happened to be open.
   */
  #openAtFootIfArrivedBackwards(): void {
    const armed = this.#enterAtFootAt
    this.#enterAtFootAt = null
    if (armed === null || performance.now() - armed > ENTER_AT_FOOT_MS) return
    /* Captured here, at the load this belongs to. Reading it inside the callback
     * would resolve a renderer that may by then belong to a different book. */
    const renderer = this.#view?.renderer
    if (!renderer) return
    const toFoot = () => {
      if (this.#disposed) return
      if (performance.now() - armed > ENTER_AT_FOOT_MS) return
      if (this.#view?.renderer !== renderer || !this.#scrollsByPage()) return
      /* Assigning past the end is how the DOM is asked for "the bottom" — it
       * clamps to the maximum, so this needs no arithmetic and cannot overshoot
       * if the layout settled at a different height than expected. */
      renderer.scrollTop = renderer.scrollHeight
    }
    /* Read off `globalThis` rather than called bare, because a bare call throws
     * where the function does not exist — which would take down section loading
     * entirely, for a scroll-position nicety. The immediate path is a real
     * fallback rather than a test affordance: it lands correctly whenever the
     * layout is already settled, and simply lands short when it is not. */
    const raf = globalThis.requestAnimationFrame
    if (typeof raf === 'function') raf(toFoot)
    else toFoot()
  }

  /**
   * A fixed-layout book scaled to the width — one page per section, scrolled.
   *
   * The shape a PDF takes in scroll mode. Named rather than inlined because two
   * separate decisions turn on it: whether a wheel event is the platform's, and
   * whether arriving at a new page backwards should open its foot.
   */
  #scrollsByPage(): boolean {
    const view = this.#view
    return view?.isFixedLayout === true && view.renderer?.getAttribute('zoom') === 'fit-width'
  }

  #platformScrolls(event: WheelEvent): boolean {
    const view = this.#view
    const renderer = view?.renderer
    if (!view || !renderer) return false

    /* THE AUTHOR'S OWN SCROLLING BOXES COME FIRST, before anything about flow.
     *
     * A book is HTML, and a book designer may put a long code listing or a wide
     * table in an `overflow: auto` box. In paged flow the whole event was being
     * consumed, so a wheel over that box turned the page instead of scrolling
     * it, and its content below the fold was simply unreachable. Nothing about
     * the reader's flow setting makes that right.
     *
     * Walked from the event's target rather than asked of the renderer, because
     * this is a question about what is UNDER THE POINTER. It stops at the body:
     * beyond that is the document scroller, which in paged flow is the
     * paginator's business and is exactly what the suppression exists for. */
    if (scrollableUnder(event)) return true

    if (!view.isFixedLayout) return renderer.getAttribute('flow') === 'scrolled'
    if (!this.#scrollsByPage()) return false

    /* Only a dominantly VERTICAL gesture is a scroll. A horizontal swipe means
     * the page left or right whatever the reader has scrolled to, and letting
     * it fall in here would silently do nothing whenever the page happened to
     * be scrolled away from an edge. */
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return false

    /* The one-pixel slack absorbs fractional layout: a scrollport sized by a
     * scaled canvas lands on `scrollHeight` a hair over `clientHeight` with
     * nothing actually to scroll, and an exact comparison would then hand back
     * every event and wedge the book on that page. */
    const remaining = renderer.scrollHeight - renderer.clientHeight
    if (remaining <= 1) return false
    return event.deltaY > 0 ? renderer.scrollTop < remaining - 1 : renderer.scrollTop > 1
  }

  /**
   * Turn a trackpad swipe into one page.
   *
   * The detector is per SESSION, not per document: a gesture that begins on one
   * spine item and finishes after the next has loaded is one gesture, and a
   * fresh detector per document would lose its accumulated travel halfway
   * through. Nothing resets it explicitly — it is discarded WITH the session,
   * and a session is never reused for a second book.
   *
   * NOT passive, and the earlier comment here had it exactly backwards. It said
   * there was no default to suppress because paged flow has nothing to scroll.
   * There is: a wheel event that reaches a scroll container with nowhere to go
   * chains outwards until something bounces, and on macOS that is the viewport
   * — so every swipe dragged the whole application sideways and sprang back.
   * Reported as the window "shaking".
   *
   * So in PAGED flow the gesture is consumed. `global.css` also terminates the
   * chain at the document, which covers everything that never reaches here;
   * this covers the case properly, by saying the event was handled.
   *
   * In SCROLLED flow it is not touched. The book genuinely scrolls there, and
   * consuming the event would stop it dead.
   */
  #watchWheel(doc: Document): void {
    const onWheel = (event: WheelEvent) => {
      if (this.#disposed) return
      /* Only real input. A book is attacker-controlled HTML in a same-origin
       * frame, and `dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }))`
       * would otherwise let its script drive the host's navigation and clear
       * the reader's selection at will. Phase 0's policy stops book script
       * running at all; this is the second lock on the same door, and it is the
       * same property the gesture checklist relies on to say the MCP bridge
       * cannot fake a gesture. */
      if (!event.isTrusted) return

      /* A PINCH, which arrives as a wheel event with `ctrlKey` set, and which
       * has to be let go BEFORE the suppression below rather than after.
       *
       * `wheelPager` already declines to page on one, so the gesture was
       * harmless — but declining happens after `preventDefault`, and by then the
       * platform's zoom and the paginator's own pinch handling have both been
       * cancelled. A reader pinching a PDF page got nothing at all, which looks
       * exactly like a missing feature rather than a suppressed one. */
      if (event.ctrlKey) return

      if (this.#platformScrolls(event)) return
      event.preventDefault()
      /* The HOST's clock, not `event.timeStamp`.
       *
       * A DOM event's timestamp is relative to its own global's time origin,
       * and every spine item is a separate iframe with a separate origin. The
       * pager is per-session on purpose — a gesture can span a section boundary
       * — so mixing the two scales compares numbers that are not on the same
       * axis. Turning a page at a boundary loads a new document, the momentum
       * tail lands in THAT document, and its timestamps start near zero while
       * the previous document's were large: the gap goes hugely negative, never
       * exceeds the quiet period, and the gesture never ends. */
      const intent = this.#pager.feed(event, performance.now())
      if (!intent) return
      /* Only a backwards VERTICAL intent, and only where scrolling is how the
       * book is read. A sideways swipe is a page turn, and a page turn lands at
       * the top like every other one. */
      this.#enterAtFootAt =
      intent === 'prev' && this.#scrollsByPage() ? performance.now() : null
      this.#cb.onPageIntent(intent)
    }
    doc.addEventListener('wheel', onWheel, { passive: false })
    this.#onTeardown(doc, () => doc.removeEventListener('wheel', onWheel))
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
   *
   * That `pagehide` listener is itself torn down, and it is the FIRST entry in
   * the list so that every path which releases a document releases it too. It
   * used to be the one listener nothing removed: a section reload runs
   * `#resetWatchers`, which drops the map entry, and the next `#onTeardown`
   * then registered a second `pagehide` on the same window — one more per
   * return to a section, each retaining this session and its document, while
   * every other listener in the file was scrupulously balanced.
   */
  #onTeardown(doc: Document, off: () => void): void {
    const existing = this.#unwatch.get(doc)
    if (existing) {
      this.#unwatch.set(doc, [...existing, off])
      return
    }
    const view = doc.defaultView
    const onPageHide = () => {
      for (const fn of this.#unwatch.get(doc) ?? []) fn()
      this.#unwatch.delete(doc)
    }
    this.#unwatch.set(doc, [() => view?.removeEventListener('pagehide', onPageHide), off])
    view?.addEventListener('pagehide', onPageHide, { once: true })
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

    /* `FontFaceSet.ready` does not reject — a document torn down mid-load
     * simply never settles it. But `.then(redraw)` is a NEW promise, and it
     * rejects if `redraw` throws, which this used to leave unhandled at the
     * window. Reported, not swallowed: the point of the original "no catch"
     * note was that a failure in `redrawMarks` must not disappear, and a catch
     * that logs keeps that while giving the rejection somewhere to go. */
    void fonts.ready
      .then(redraw)
      .catch((cause: unknown) => console.error('Paper: redraw after fonts loaded failed', cause))
  }

  /** Drop the listeners a document had, before re-registering them. */
  #resetWatchers(doc: Document): void {
    for (const off of this.#unwatch.get(doc) ?? []) off()
    this.#unwatch.delete(doc)
  }

  /**
   * Idempotent, and safe at any point in startup.
   *
   * Every step is isolated, and the resource-releasing half runs in a `finally`.
   * `#disposed` latches on entry, so a single throwing host callback or teardown
   * function used to abort the rest of this method permanently: the next call
   * returned at the guard, and the listeners, the prepared book, the view and
   * the host were never released. The one thing teardown must not do is stop
   * halfway, so nothing here is allowed to propagate.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    try {
      quietly('onDocument', () => this.#cb.onDocument(null))
      quietly('onNavigator', () => this.#cb.onNavigator(null))
      quietly('onSelection', () => this.#cb.onSelection(null))
      for (const offs of this.#unwatch.values())
        for (const off of offs) quietly('teardown', off)
    } finally {
      this.#unwatch.clear()
      this.#sections.clear()
      this.#painters = null
      const prepared = this.#prepared
      this.#prepared = null
      if (prepared) destroyQuietly(prepared)
      const built = this.#view
      this.#view = null
      if (built) closeQuietly(built)
      quietly('host cleanup', () => this.#host.replaceChildren())
    }
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
 * Run one step of teardown without letting it stop the rest.
 *
 * `dispose()` latches `#disposed` on entry, so a step that throws used to make
 * teardown unfinishable rather than merely incomplete — the next call returned
 * at the guard and the remaining listeners, the book, the view and the host
 * were never released. Reported rather than swallowed: a host callback that
 * throws during teardown is a real defect, and the leak it used to cause was
 * invisible precisely because nothing said anything.
 */
function quietly(what: string, step: () => void): void {
  try {
    step()
  } catch (cause) {
    console.error(`Paper: ${what} threw during teardown`, cause)
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
 * What was closed on a view, so it is never closed twice for the same state —
 * and IS closed again when startup built something new underneath.
 *
 * Both `dispose()` and the post-await `#settle()` can legitimately reach the
 * same view: dispose closes what it holds, then the in-flight startup resolves
 * and hands the very same view back. The old `try/catch` hid the second close
 * rather than preventing it — and a swallowed double-close is precisely the
 * kind of thing that looks fine until foliate starts throwing on it.
 *
 * Keying on the view ALONE was too coarse, and leaked. `dispose()` can close a
 * view while its `open()`/`init()` is still in flight; that startup then builds
 * a renderer AFTER the close, and the `#settle()` call that would have released
 * it was suppressed as a duplicate. The renderer and its iframes survived the
 * session. So the record is the renderer that was closed, and a later call with
 * a DIFFERENT renderer — including one where there was none before — is real
 * work rather than a repeat.
 */
const CLOSED = new WeakMap<object, unknown>()

/** `renderer` is a getter that throws before `open()` has built one. */
function rendererOf(view: View): unknown {
  try {
    return view.renderer ?? null
  } catch {
    return null
  }
}

function closeQuietly(view: View): void {
  const renderer = rendererOf(view)
  if (CLOSED.has(view) && CLOSED.get(view) === renderer) return
  CLOSED.set(view, renderer)
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
  /* Checked BEFORE the iterator exists. `view.search()` clears foliate's own
   * results and starts walking the book, so entering it on an already-aborted
   * signal threw away the results still on screen and began work whose every
   * outcome is discarded. The caller aborts on each keystroke, so this is the
   * common path, not the rare one. */
  if (signal.aborted) return

  const results = view.search({ query })
  /* Closed on the way out, however we leave. A `for await` that returns early
   * does call `results.return()`, but an abort arriving while we are parked on
   * the next result is not observed until that result arrives — so the search
   * runs on after cancellation. Racing the iterator against the abort lets the
   * cancellation win immediately, and `finally` closes the generator foliate
   * gave us rather than leaving it walking the book. */
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })

  try {
    for (;;) {
      const step = await Promise.race([results.next(), aborted])
      if (step === 'aborted' || step.done) return
      const result = step.value
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
  } finally {
    await results.return?.(undefined)
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
  const belongsTo = (md['belongsTo'] ?? {}) as Record<string, unknown>
  const series = firstOf(belongsTo['series'])
  return {
    title: cap(text(md['title'])),
    author: cap(text(md['author'])),
    // Loosely typed like the rest: foliate resolves the OPF's unique-identifier
    // and hands back a string, but a malformed package can put anything here.
    identifier: cap(typeof md['identifier'] === 'string' ? md['identifier'] : ''),
    sortAs: cap(text(md['sortAs'])),
    series: cap(text(series?.['name'] ?? series)),
    /* A position, not an index into anything: EPUB allows `1.5` for a novella
     * between two books, so this is a float and NaN must not survive as one. */
    seriesIndex: finiteOrNull(series?.['position']),
    subjects: list(md['subject'], text),
    publisher: cap(text(md['publisher'])),
    /* Kept as the STRING the book declared, not parsed into a date. EPUB dates
     * are only loosely specified — `2011`, `2011-03`, and a full timestamp are
     * all legal — and `new Date('2011')` silently invents a January 1st in
     * whatever timezone the reader happens to be in. Sorting can compare these
     * lexically, which is correct for ISO-shaped values and no worse than a
     * fabricated day for the rest. */
    published: cap(text(md['published'])),
    languages: list(md['language'], text),
    description: cap(text(md['description']), MAX_LONG),
    subtitle: cap(text(md['subtitle'])),
  }
}

/**
 * Caps on metadata, because a book is a file a stranger wrote.
 *
 * Every field below travels straight from an untrusted OPF into a store that is
 * read whole, parsed whole and rewritten whole on every position save. Without
 * a bound, a book declaring a megabyte-long description or forty thousand
 * subjects would bloat that store permanently — and it would still be there
 * after the book was removed from the shelf, because the row outlives the open.
 *
 * The numbers are chosen to be past anything real rather than to be tight. A
 * genuine title is not 500 characters and a genuine book is not in 32
 * languages; the point is only that there IS a ceiling.
 */
const MAX_FIELD = 500
const MAX_LONG = 4000
const MAX_LIST = 32

function cap(value: string, limit = MAX_FIELD): string {
  return value.length > limit ? value.slice(0, limit) : value
}

/** foliate hands back an object, an array of them, or nothing. */
function firstOf(value: unknown): Record<string, unknown> | null {
  const one = Array.isArray(value) ? value[0] : value
  return one && typeof one === 'object' ? (one as Record<string, unknown>) : null
}

function finiteOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? parseFloat(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** A bounded list of non-empty strings, deduplicated, order preserved. */
function list(value: unknown, text: (v: unknown) => string): readonly string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value]
  const out: string[] = []
  for (const item of raw) {
    const one = cap(text(item))
    // Deduplicated because an OPF may repeat a subject per language, and a tag
    // shown twice on a row looks like a bug in the reader rather than the book.
    if (one && !out.includes(one)) out.push(one)
    if (out.length >= MAX_LIST) break
  }
  return out
}
