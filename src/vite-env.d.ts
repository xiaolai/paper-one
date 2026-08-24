/// <reference types="vite/client" />

/**
 * foliate-js ships as unbundled ESM with no type declarations. These describe
 * the surface Paper actually uses, checked against the upstream `view.js`
 * rather than its README — the two disagree in one place that matters:
 *
 *   The README documents the annotation hook as `create-overlayer`. That is
 *   the INTERNAL event, dispatched by the renderer to the view. The event an
 *   app listens for is `create-overlay`. Listening for the documented name
 *   silently never fires, and annotations simply never draw.
 *
 * These describe OUR FORK, `github:xiaolai/foliate-js`, pinned to a SHA — not
 * anything on npm. The registry's `foliate-js` was published by an unrelated
 * account and had quietly rewritten `Overlayer.add`; declarations checked
 * against it described that rewrite rather than the library. `MarkPainter` is
 * where that surfaced, and the note on it is worth reading before trusting any
 * other shape in this file.
 *
 * Upstream: https://github.com/johnfactotum/foliate-js
 * Fork:     https://github.com/xiaolai/foliate-js (branch `paper`)
 */
/**
 * The CFI parser, imported by the marks store to ORDER anchors.
 *
 * Pure string work, no DOM — which is what lets `core/marks.ts` use it and still
 * be unit-tested without a browser environment. Declared narrowly: only the
 * comparison is used, and widening this invites the rest of the reader engine
 * into a module that is deliberately engine-agnostic.
 */
declare module 'foliate-js/epubcfi.js' {
  /**
   * Document order over two CFIs. Negative, zero or positive, like any
   * comparator. Throws on input it cannot parse.
   */
  export function compare(a: string, b: string): number

  /**
   * One end of a CFI as a CFI of its own — the start, or the end with `toEnd`.
   *
   * A range CFI carries both its ends in one string, and comparing two RANGES
   * needs them separately: `core/markMatch.ts` asks whether a mark and a
   * selection cover any of the same text, which is a question about four
   * points. Given a CFI that is already a single point, both ends are itself.
   *
   * Two failure modes, both measured against the fork rather than assumed, and
   * both load-bearing where this is used.
   *
   * A string that addresses nothing — `''`, `'not a cfi'`, `'epubcfi(garbage)'`
   * — collapses to the literal `'epubcfi()'` for either `toEnd` instead of
   * throwing. That is why `markMatch.ts` screens on that sentinel rather than
   * on foliate's `isCFI`, whose regex `/^epubcfi\((.*)\)$/` accepts all three.
   *
   * A range missing one of its ends (`'epubcfi(/6/4!/4/2,/1:5)'`) throws only
   * when the MISSING end is asked for: `collapse(cfi)` returns
   * `'epubcfi(/6/4!/4/2/1:5)'`, and `collapse(cfi, true)` throws `TypeError`.
   * So the `try` around the pair is still load-bearing, but the start alone
   * never trips it — a caller that only collapses starts gets a plausible CFI
   * back from input that is not a valid range.
   */
  export function collapse(cfi: string, toEnd?: boolean): string
}

declare module 'foliate-js/view.js' {
  export interface TocItem {
    readonly label: string
    /**
     * Null for a heading that is not a link.
     *
     * foliate emits this deliberately: an EPUB nav can carry a `<span>` as a
     * grouping heading — "Part One" over its chapters — with no destination of
     * its own. Typed as a plain string it was passed to `goTo` as though it
     * were one, which navigates nowhere and looks like a broken row.
     */
    readonly href: string | null
    readonly subitems?: readonly TocItem[] | null
  }

  export interface BookMetadata {
    readonly title?: string | Record<string, string>
    readonly author?: string | readonly unknown[]
    readonly language?: string | readonly string[]
    /** `dc:identifier`, resolved by foliate through the OPF's unique-identifier. */
    readonly identifier?: string
  }

  export interface Book {
    readonly metadata?: BookMetadata
    readonly toc?: readonly TocItem[]
    readonly sections: readonly unknown[]
    /**
     * The jacket, when the backend has one.
     *
     * DELIBERATELY NOT `Promise<Blob | null>`: foliate's FB2 backend assigns
     * `book.getCover = () => null` for a book with no cover art — a SYNCHRONOUS
     * null, not a resolved promise. Typed as always-thenable, every caller
     * wrote `.catch()` straight onto the result and threw a TypeError on
     * exactly those books. The type says what the fork does.
     */
    getCover?: () => Promise<Blob | null> | Blob | null
    /**
     * Release whatever the parse acquired — object URLs, a zip loader, a worker.
     *
     * Optional because not every backend defines it, and undeclared until now,
     * which is why nothing called it: `epub.js`, `fb2.js` and `comic-book.js`
     * all have one, and FB2 makes an object URL per section.
     */
    destroy?: () => void
  }

  /** `relocate` detail — the progress fields are spread in at the top level. */
  export interface RelocateDetail {
    readonly fraction: number
    readonly location?: { readonly current: number; readonly total: number }
    /**
     * Which spine item the reader is in, and how many there are.
     *
     * UNDECLARED HERE FOR AS LONG AS ANYTHING NEEDED IT, which is the whole
     * reason this entry exists. foliate has emitted `section.current` on every
     * relocation all along — it is the renderer's own index, the same number
     * `load` carries — and because this file did not mention it, the session
     * inferred the current section instead: from the relocation's range where
     * there was one, and otherwise from whichever section had most recently
     * rendered. The inference is wrong for a fixed-layout SPREAD, which loads
     * its left page and then its right and can afterwards display either
     * without loading again; a bookmark made on one side was filed under the
     * other, and the toggle that made it could not find it.
     *
     * Measured against the running app on 2026-08-20 rather than read out of
     * upstream's source: `{current: 19, total: 40}` alongside
     * `epubcfi(/6/40!…)`, whose spine step is the twentieth child — index 19.
     * The two agree, which is what makes this the value to trust.
     *
     * Optional because a renderer is not obliged to send it, and the session
     * keeps its fallbacks for one that does not.
     */
    readonly section?: { readonly current: number; readonly total: number }
    readonly tocItem?: TocItem | null
    readonly pageItem?: { readonly label: string } | null
    readonly cfi?: string
    readonly range?: Range
  }

  /** `load` detail — fires once per spine item, carrying its document. */
  export interface LoadDetail {
    readonly doc: Document
    readonly index: number
  }

  /** `create-overlay` detail. */
  /** `search` yields progress markers, per-section groups, individual hits,
   *  and finally the string 'done'. */
  export interface SearchExcerpt {
    readonly pre: string
    readonly match: string
    readonly post: string
  }

  export interface SearchHitRaw {
    readonly cfi: string
    readonly excerpt: SearchExcerpt
  }

  export type SearchYield =
    | { readonly progress: number }
    | { readonly label: string; readonly subitems: readonly SearchHitRaw[] }
    | SearchHitRaw
    | 'done'

  export interface SearchOptions {
    readonly query: string
    readonly index?: number
    readonly matchCase?: boolean
    readonly matchDiacritics?: boolean
    readonly matchWholeWords?: boolean
  }

  export interface CreateOverlayDetail {
    readonly index: number
  }

  /**
   * `link` detail — a link inside the book that resolves WITHIN the book.
   *
   * The event is CANCELABLE and that is the whole of its usefulness.
   * `#handleLinks` attaches one click listener per section document, calls
   * `preventDefault()` on the DOM event itself, resolves the href through the
   * section, then emits this — and only navigates if nothing cancelled it:
   *
   *     Promise.resolve(this.#emit('link', { a, href }, true))
   *         .then(x => x ? this.goTo(href) : null)
   *
   * So a listener that calls `preventDefault()` takes the link over, and one
   * that does not lets foliate navigate exactly as it always has. Paper needs
   * both: a footnote is taken over and shown in place, and anything else is
   * left to navigate — after the jump stack has recorded where the reader was.
   *
   * `href` is ALREADY RESOLVED against the section; `a` is the element clicked,
   * which is what the footnote heuristics read (`epub:type`, `role`, and
   * whether it is set as a superscript).
   */
  export interface LinkDetail {
    readonly a: HTMLAnchorElement
    readonly href: string
  }

  /**
   * `external-link` detail — a link whose scheme leaves the book.
   *
   * NOT ONLY THE WEB. The EPUB backend's test is
   * `uri => /^(?!blob)\w+:/i.test(uri)` — any scheme but `blob:` — so
   * `javascript:` and `data:` arrive here too, and the unhandled branch hands
   * whatever the book's author wrote to `globalThis.open`.
   *
   * `href_` is the RAW attribute, unresolved, because an external target is not
   * relative to anything in the package. The trailing underscore is foliate's
   * own name for it and is kept so the two can be compared.
   */
  export interface ExternalLinkDetail {
    readonly a: HTMLAnchorElement
    readonly href_: string
  }

  /**
   * What foliate resolves and draws.
   *
   * `value` is required and must be a string, because `addAnnotation` calls
   * `value.startsWith(SEARCH_PREFIX)` on it before anything else — so an
   * annotation without one throws at the first line rather than failing to
   * draw. Typed as `unknown` this was invisible: any object compiled, and the
   * error only appeared at runtime. Anything else on the object is carried
   * through untouched and handed back in `draw-annotation`, which is how
   * Paper's own `kind` survives the round trip.
   */
  export interface Annotation {
    readonly value: string
    readonly [carried: string]: unknown
  }

  /** `draw-annotation` detail — call `draw` with an Overlayer draw function. */
  export interface DrawAnnotationDetail {
    readonly draw: (fn: unknown, options?: Record<string, unknown>) => void
    readonly annotation: Annotation
    readonly doc: Document
    readonly range: Range
  }

  /**
   * The two style elements the paginator gives every document, in the order it
   * puts them in: one PREPENDED to `head` and one APPENDED to it.
   *
   * `paginator.js` creates both in `afterLoad` and `setStyles` writes the tuple
   * into them; a bare string writes only the appended one. That is the whole
   * mechanism behind Paper's `before` and `after` tiers — see `bookSheets`.
   */
  export type Styles = string | readonly [before: string, after: string]

  /**
   * The renderer owns the book's iframes. `flow` is set as an ATTRIBUTE —
   * there is no JS property for it — and `setStyles` is optional because the
   * fixed-layout renderer does not implement it.
   *
   * IT TAKES A TUPLE, and the declaration said it took a string. foliate has
   * accepted `[before, after]` at `paginator.js:1332` all along; typed as
   * `(css: string)` the second tier was unreachable from TypeScript, and the
   * type was the only thing forbidding it.
   */
  export interface Renderer extends HTMLElement {
    setStyles?: (css: Styles) => void
    next(): Promise<void>
    prev(): Promise<void>
    /**
     * The sections currently rendered, with their live documents.
     *
     * THE ONLY WAY IN. Both renderers call `attachShadow({ mode: 'closed' })`,
     * so an embedder cannot reach the iframe from the DOM side at all — this
     * is the whole public surface for reading what is on screen. `session.ts`
     * has used it since the beginning; it was simply never declared, so every
     * caller reached it through a cast.
     */
    getContents(): { index: number; doc: Document; overlayer?: unknown }[]
  }

  export interface InitOptions {
    /** A CFI or href to restore; null starts from the beginning. */
    lastLocation?: string | null
    /** Skip front matter and open at the start of the text proper. */
    showTextStart?: boolean
  }

  export class View extends HTMLElement {
    /**
     * True when the book declares `pre-paginated`, which every PDF does.
     *
     * The RENDERER is chosen from this — `foliate-fxl` rather than
     * `foliate-paginator` — and the two express the same ideas under different
     * attributes. Whether the book scrolls is `flow="scrolled"` on the
     * paginator and `zoom="fit-width"` on fxl, whose `observedAttributes` is
     * `['zoom']`; each ignores the other's, so both are always set and this
     * says which one to believe.
     */
    readonly isFixedLayout: boolean
    /** Accepts a File/Blob, a URL string, or an object implementing Book. */
    open(book: File | Blob | string | Book): Promise<void>

    /**
     * Displays the first section. `open` only parses the book and attaches a
     * renderer — it performs NO navigation, so without this call the view
     * stays empty, with a populated TOC and no iframe, and never reports an
     * error to say why.
     */
    init(options: InitOptions): Promise<void>
    close(): void
    goTo(target: string | number): Promise<void>
    goToFraction(fraction: number): Promise<void>
    prev(distance?: number): Promise<void>
    next(distance?: number): Promise<void>
    goLeft(): Promise<void>
    goRight(): Promise<void>
    /**
     * Resolves `annotation.value` (a CFI) and draws it, or erases it when
     * `remove` is true. Async upstream; nothing here awaits it, because the
     * only outcome is a drawing side effect.
     */
    addAnnotation(annotation: Annotation, remove?: boolean): Promise<void>
    /**
     * The CFI for a range within a spine item, or the section's own base CFI
     * when `range` is omitted. This is how a live selection becomes a durable
     * anchor — an offset into the rendered layout would not survive a reflow.
     */
    getCFI(index: number, range?: Range): string
    /** Clears the selection in every rendered document. */
    deselect(): void
    /** Async generator over the whole book. CFIs are navigable via `goTo`. */
    search(options: SearchOptions): AsyncGenerator<SearchYield, void, unknown>
    readonly renderer: Renderer
    readonly book: Book
  }

  export const makeBook: (file: File | Blob | string) => Promise<Book>

  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
}

/**
 * Upstream's footnote detection, which is the hard half of a note popover and
 * is already installed.
 *
 * `bookCss.ts` styles exactly ONE of the three reference types this
 * recognises. The rest — the other `epub:type` values, the ARIA roles, and the
 * superscript heuristic that catches the majority of real books, which declare
 * nothing at all — is written here and would otherwise be written again.
 *
 * MIT, and it ships in the fork Paper pins. Nothing on npm called `foliate-js`
 * is the author's; see `dev-docs/foliate-fork.md`.
 */
declare module 'foliate-js/footnotes.js' {
  import type { Book, View } from 'foliate-js/view.js'

  /**
   * What the reference pointed at, as `getReferencedType` classifies it, or
   * null when the target declares nothing. Used for the popover's label.
   */
  export type FootnoteType =
    | 'biblioentry'
    | 'definition'
    | 'endnote'
    | 'footnote'
    | 'note'
    | null

  /**
   * `render` — the note has been extracted into `view`, which the embedder
   * mounts. `hidden` is true for an `aside` the book meant to keep out of the
   * flow, which is the ordinary EPUB 3 footnote.
   */
  export interface FootnoteRenderDetail {
    /** A real `foliate-view` — `document.createElement('foliate-view')`. Typed
     *  as one because the embedder needs `renderer.getContents()` to measure
     *  the note; the paginator's shadow root is closed, so there is no way in
     *  from the DOM side. */
    readonly view: View
    readonly href: string
    readonly type: FootnoteType
    readonly hidden: boolean
    readonly target: Element | null
  }

  export class FootnoteHandler extends EventTarget {
    /**
     * Whether to trust the superscript heuristic as well as the declared
     * types. On by default upstream, and left on: most books in the wild
     * declare nothing, and the heuristic is what makes those work.
     */
    detectFootnotes: boolean
    /**
     * Take a `link` event, or decline it.
     *
     * CALLS `preventDefault()` SYNCHRONOUSLY when it takes one, which is what
     * stops foliate navigating — `#emit` reads the return of `dispatchEvent`
     * in the same turn. Returns a promise when it took the link and
     * `undefined` when it did not, which is how the caller tells the two
     * apart without waiting.
     */
    handle(book: Book, event: Event): Promise<void> | undefined
  }
}

declare module 'foliate-js/overlayer.js' {
  /**
   * A rect as a painter consumes it — the shape, not a DOMRect.
   *
   * ALL SIX edges, because the painters disagree about which they read:
   * `highlight` destructures `left/top/width/height`, while `underline`,
   * `strikethrough` and `squiggly` read `right` and `bottom`. Typed with only
   * the first four, a hand-built rect was type-correct and produced `NaN`
   * coordinates in any line painter it reached. Anything constructing one must
   * fill them all; `DOMRect` already does.
   */
  export interface PaintRect {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
    readonly width: number
    readonly height: number
  }

  /**
   * One options shape for all five painters, which is a KNOWN simplification.
   *
   * Upstream they are not alike: `underline` and `strikethrough` take a stroke
   * `width`, `squiggly` takes more, `outline` takes `radius` — and none of them
   * take the `doc` and `at` that Paper adds for the highlight. Modelled
   * honestly, this would be a generic with per-painter options.
   *
   * It is deliberately not. Paper calls exactly two of the five, and neither
   * uses the options this omits, so the generic would exist to describe calls
   * nobody makes. The cost of the shortcut is that a future call to `squiggly`
   * type-checks while silently dropping its parameters — worth knowing before
   * reaching for one, which is why this is written down rather than fixed.
   */
  /**
   * The rects a painter is handed are a `DOMRectList`, NOT an array.
   *
   * `Overlayer.add` passes `range.getClientRects()` straight through, and it
   * has done since foliate's first commit. This was declared as an array for
   * as long as Paper depended on the unofficial npm build of foliate-js, whose
   * publisher had rewritten `add` to map the rects into plain objects and
   * concatenate them into a real array. That rewrite is not upstream, so the
   * declaration described a stranger's fork rather than the library.
   *
   * Typed as `Iterable`, a painter can no longer reach for `filter`, `map` or
   * `length` without converting first — which is the whole guarantee, since
   * the version that could compiled cleanly and threw at the first highlight.
   */
  export type MarkPainter = (
    rects: Iterable<PaintRect>,
    options?: {
      color?: string
      doc?: Document | null
      /** The element the marked text is in — see `balanceRects`. */
      at?: Element | null
      writingMode?: string
    },
  ) => SVGElement

  /**
   * An SVG sized to the book's viewport and drawn from
   * `range.getClientRects()`, so it shares the text's coordinate space for
   * free. Anything anchored to text belongs here; host-side chrome (the
   * selection popup, the margin marks) does not, and needs the rect
   * translation in `ui/reader/coordinates.ts`.
   *
   * It lives in the view's shadow tree in the HOST document, BESIDE the
   * iframe — not inside the book, which this comment used to claim. The
   * difference is load-bearing twice over: CSS injected into the book cannot
   * style it, so its custom properties have to be declared on the host root
   * (see `styles/global.css`), and because it is painted OVER the text rather
   * than behind it, its blend mode decides whether a mark obscures the words.
   */
  export class Overlayer {
    readonly element: SVGSVGElement
    /**
     * Store an annotation and paint it.
     *
     * Worth knowing, because Paper depends on it: `add` computes
     * `range.getClientRects()`, hands those to `draw`, and STORES THE ORIGINALS
     * — so `hitTest` answers against the rects foliate measured, not against
     * whatever the painter drew. A painter that moves or merges its rects makes
     * the clickable area diverge from the visible one. See `markGeometry.ts`.
     */
    add(
      key: string,
      range: Range | (() => Range),
      draw: MarkPainter,
      options?: Parameters<MarkPainter>[1],
    ): void
    remove(key: string): void
    redraw(): void
    hitTest(event: { x: number; y: number }): [string, Range] | []

    /**
     * The painters. Each turns rects into an SVG group; `add` calls the one it
     * is given as `draw(rects, options)`, passing `options` through untouched —
     * which is how Paper smuggles the book document to `highlight` so the band
     * can be measured against the font it will sit on.
     */
    static highlight: MarkPainter
    static underline: MarkPainter
    static strikethrough: MarkPainter
    static squiggly: MarkPainter
    static outline: MarkPainter
  }
}

/* No top-level import or export in this file, deliberately: adding one turns
 * it into a module, at which point the `declare module` blocks above become
 * augmentations of modules that have no types of their own, and every one of
 * them silently stops applying. */
interface HTMLElementTagNameMap {
  'foliate-view': import('foliate-js/view.js').View
}
