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
 * Upstream: https://github.com/johnfactotum/foliate-js
 */
declare module 'foliate-js/view.js' {
  export interface TocItem {
    readonly label: string
    readonly href: string
    readonly subitems?: readonly TocItem[] | null
  }

  export interface BookMetadata {
    readonly title?: string | Record<string, string>
    readonly author?: string | readonly unknown[]
    readonly language?: string | readonly string[]
  }

  export interface Book {
    readonly metadata?: BookMetadata
    readonly toc?: readonly TocItem[]
    readonly sections: readonly unknown[]
    getCover?: () => Promise<Blob | null>
  }

  /** `relocate` detail — the progress fields are spread in at the top level. */
  export interface RelocateDetail {
    readonly fraction: number
    readonly location?: { readonly current: number; readonly total: number }
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

  /** `draw-annotation` detail — call `draw` with an Overlayer draw function. */
  export interface DrawAnnotationDetail {
    readonly draw: (fn: unknown, options?: Record<string, unknown>) => void
    readonly annotation: unknown
    readonly doc: Document
    readonly range: Range
  }

  /**
   * The renderer owns the book's iframes. `flow` is set as an ATTRIBUTE —
   * there is no JS property for it — and `setStyles` is optional because the
   * fixed-layout renderer does not implement it.
   */
  export interface Renderer extends HTMLElement {
    setStyles?: (css: string) => void
    next(): Promise<void>
    prev(): Promise<void>
  }

  export interface InitOptions {
    /** A CFI or href to restore; null starts from the beginning. */
    lastLocation?: string | null
    /** Skip front matter and open at the start of the text proper. */
    showTextStart?: boolean
  }

  export class View extends HTMLElement {
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
    addAnnotation(annotation: unknown, remove?: boolean): void
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

declare module 'foliate-js/overlayer.js' {
  /**
   * An SVG living inside the BOOK document, sized to the viewport and drawn
   * from `range.getClientRects()`. Anything anchored to text belongs here,
   * because it shares the text's coordinate space for free. Host-side chrome
   * (the selection popup, the margin marks) does not, and needs the rect
   * translation in `src/reader/coordinates.ts`.
   */
  export class Overlayer {
    readonly element: SVGSVGElement
    add(
      key: string,
      range: Range | (() => Range),
      draw: unknown,
      options?: Record<string, unknown>,
    ): void
    remove(key: string): void
    redraw(): void
    hitTest(event: { x: number; y: number }): [string, Range] | []

    static highlight: unknown
    static underline: unknown
    static strikethrough: unknown
    static squiggly: unknown
    static outline: unknown
  }
}

/* No top-level import or export in this file, deliberately: adding one turns
 * it into a module, at which point the `declare module` blocks above become
 * augmentations of modules that have no types of their own, and every one of
 * them silently stops applying. */
interface HTMLElementTagNameMap {
  'foliate-view': import('foliate-js/view.js').View
}
