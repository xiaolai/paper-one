import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?raw'
import type { PDFDataRangeTransport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TocItem } from 'foliate-js/view.js'
import { isRanged, titleFromSource, type BookSource, type RangedSource } from '../../core/formats'
import { COVER_WIDTH } from '../../core/coverArt'
import { createReflowGuard } from './wordSnap/invalidate'

/**
 * A PDF, presented to foliate as a book.
 *
 * This is the whole architecture, and it is worth stating plainly because the
 * obvious alternative is worse. A PDF could be given its own reader — load
 * pdf.js, paint canvases into a scroller, handle scrolling and selection — and
 * that reader would then be a second-class citizen forever: no marks, because
 * marks are anchored by CFI; no reading ruler, because the ruler is injected
 * into the book's document; no reading aloud, because speech walks text nodes.
 * Every feature would need building twice and would drift.
 *
 * Instead each PAGE becomes a small HTML document — a canvas with pdf.js's
 * transparent text layer over it — and the whole file becomes a `Book`: the
 * same shape `epub.js` and `mobi.js` produce, which `View.open` accepts and
 * foliate's fixed-layout renderer paginates. Because every page is then a real
 * document containing real text nodes, search, the Overlayer, the ruler and
 * TTS all work through exactly the code that already serves EPUBs.
 *
 * The shape is taken from foliate-js's own `pdf.js`, which is in its repository
 * but NOT in the published npm package — it expects a vendored pdf.js under
 * `vendor/pdfjs/`, which is why it is excluded. So the adapter is reimplemented
 * here against `pdfjs-dist` from npm rather than vendored, and Paper does not
 * carry a fork of foliate-js to get it. (Readest, which does fork, forked for
 * deep renderer changes rather than for this.)
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

/* Staged into `vendor/pdfjs/` by `scripts/sync-pdfjs-assets.mjs`. pdf.js fetches
 * these by name at run time and degrades QUIETLY without them: CJK pages come
 * out blank, and a PDF that assumes Helvetica rather than embedding it gets
 * substituted metrics. */
const ASSET_BASE = '/pdfjs/'

/** What `View.open` needs. Structural — foliate types this loosely. */
export interface PdfBook {
  readonly rendition: { layout: string }
  readonly metadata: Record<string, unknown>
  readonly toc: readonly TocItem[]
  readonly sections: readonly {
    id: number
    load: () => Promise<{ src: string; onZoom: (arg: { doc: Document; scale: number }) => void }>
    /** Text-only document for search — see `pageDocument`. */
    createDocument: () => Promise<Document>
    size: number
  }[]
  isExternal: (uri: string) => boolean
  resolveHref: (href: string) => Promise<{ index: number }>
  splitTOCHref: (href: string) => Promise<[number | null, null]>
  getTOCFragment: (doc: Document) => Element
  /** Page one, rendered. Null when it will not render — see the implementation. */
  getCover: () => Promise<Blob | null>
  /**
   * Release the object URLs, the document and its worker.
   *
   * RETURNS THE PROMISE rather than firing and forgetting, so a caller that
   * needs the worker actually gone can wait for it. The enrichment pass does:
   * it parses one book at a time, and discarding this promise meant `parseBook`
   * resolved while the worker was still shutting down — so the next book's
   * parse overlapped the previous one's teardown and "one at a time" held only
   * for the cheap part. Callers that do not care may ignore it.
   */
  destroy: () => Promise<void>
}

/**
 * Containers already carrying the selection fix.
 *
 * The text layer's container OUTLIVES the text layer: a repaint clears its
 * children and builds new spans inside the same element. Binding on every paint
 * therefore stacked one more pair of listeners per zoom step, all of them alive,
 * all doing the same work on every pointer event for the rest of the session.
 */
const selectionBound = new WeakSet<Element>()

function bindSelectionFix(container: Element, doc: Document): void {
  if (selectionBound.has(container)) return
  selectionBound.add(container)
  container.addEventListener('pointerdown', () => container.classList.add('selecting'))
  /* Released on the DOCUMENT, not on the container. A drag that ends outside
   * the text layer — in the page margin, which is where a selection to the end
   * of the page naturally finishes — never delivers `pointerup` to the
   * container at all, and the class stays on: from then on every click selects
   * to the end of the layer. `pointercancel` covers the same for a gesture the
   * system takes over. */
  const release = () => container.classList.remove('selecting')
  doc.addEventListener('pointerup', release)
  doc.addEventListener('pointercancel', release)
  /* And when the page loses focus mid-drag — a drag that ends in another
   * window, or one the system interrupts, delivers no pointer event here at
   * all, and the class would stay on for the rest of the session. */
  doc.defaultView?.addEventListener('blur', release)
}

/**
 * The render in flight for a page document, so a new paint can CANCEL it.
 *
 * Abandoning it is not enough, and the difference is a blank page rather than a
 * stale one. pdf.js serialises rendering per `PDFPageProxy`: a second
 * `render()` while the first is outstanding waits for it, and an abandoned
 * first render is still outstanding — nobody is going to await it, so it hands
 * nothing on and the page never paints at all. Observed exactly that way: the
 * transform and `--scale-factor` set, no canvas, no text layer, no error.
 */
const inFlight = new WeakMap<Document, { cancel: () => void }>()

/**
 * Paint one page into the document foliate has put on screen.
 *
 * Called on first display and again on every zoom, because the canvas is a
 * bitmap: scaling it with CSS blurs it, so it is repainted at the new scale
 * instead. `--scale-factor` is pdf.js's own contract with its text-layer CSS —
 * the spans are positioned in units of it, and without it every one of them
 * lands at the top-left corner.
 */
async function paint(page: PDFPageProxy, doc: Document, zoom: number): Promise<boolean> {
  /* The render generation, and the announcement that this page is being rebuilt
   * under whatever is anchored into it — see `createReflowGuard`, which holds
   * both and explains why they are one thing. Taking it here rather than after
   * the render is deliberate: `replaceChildren()` below detaches every node a
   * selection points at, and the reader's pending word snap has to hear about
   * that BEFORE it happens, not after. */
  const reflow = createReflowGuard(doc)
  const generation = reflow.bump()
  const superseded = () => !reflow.isValid(generation)

  // Stop the previous paint before starting this one — see `inFlight`.
  inFlight.get(doc)?.cancel()

  const scale = zoom * devicePixelRatio
  doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
  doc.documentElement.style.transformOrigin = 'top left'
  doc.documentElement.style.setProperty('--scale-factor', String(scale))
  const viewport = page.getViewport({ scale })

  /* Created in the HOST document, not the page's. pdf.js loads a PDF's fonts
   * into the document that owns the PDFDocumentProxy, and a canvas belonging to
   * another document cannot see them — the page paints with substituted glyphs.
   * It is adopted into the frame afterwards. */
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const task = page.render({ canvas, viewport })

  /* What a LATER paint must cancel to stop this one — see `inFlight`.
   *
   * A paint has two cancellable stages, and this used to name only the first:
   * `inFlight` was cleared as soon as the canvas settled, so for the whole text
   * stage the map held nothing and a new paint's `inFlight.get(doc)?.cancel()`
   * found nothing to cancel. The superseded text layer went on appending spans
   * into the same `.textLayer` the new paint had just emptied, and the page
   * ended up carrying two renders' worth of text, positioned at two scales.
   * Ownership therefore passes from the canvas task to the text layer with no
   * gap between them, and only the single `finally` below gives it up. */
  let active: { cancel: () => void } = task
  inFlight.set(doc, task)
  try {
    try {
      await task.promise
    } catch (cause) {
      // A cancelled render rejects; anything else is worth knowing about, and
      // an unhandled rejection here reaches the window as an uncaught error.
      if (!superseded()) console.error('Paper: PDF page render failed', cause)
      return false
    }
    if (superseded()) return false
    doc.querySelector('#canvas')?.replaceChildren(doc.adoptNode(canvas))

    const container = doc.querySelector('.textLayer')
    if (!container) return false
    container.replaceChildren()
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: container as HTMLElement,
      viewport,
    })
    if (inFlight.get(doc) === active) {
      active = textLayer
      inFlight.set(doc, textLayer)
    }
    /* Cancelled and caught, like the canvas render above. A superseded text
     * layer left running keeps positioning spans into a document that is being
     * repainted underneath it, and its rejection had nowhere to go — it left
     * the function as an unhandled rejection at the window. */
    try {
      await textLayer.render()
    } catch (cause) {
      if (!superseded()) console.error('Paper: PDF text layer failed', cause)
      return false
    }
    if (superseded()) {
      textLayer.cancel()
      return false
    }

    /* pdf.js's selection fix: without `.selecting`, a drag that leaves the last
     * span selects to the end of the layer rather than to the pointer. */
    const end = doc.createElement('div')
    end.className = 'endOfContent'
    container.append(end)
    bindSelectionFix(container, doc)
    return true
  } finally {
    if (inFlight.get(doc) === active) inFlight.delete(doc)
  }
}

/**
 * A page's text as a standalone Document, for search.
 *
 * foliate's search walks `section.createDocument()` and SILENTLY SKIPS any
 * section that does not have one — `if (!createDocument) continue` — so
 * without this a PDF is searchable-looking and finds nothing, with no error to
 * say why. It is separate from the rendered page because search wants text in
 * reading order and nothing else: no canvas, no positioning, no fonts.
 *
 * The stream is drained with an explicit reader rather than through
 * `getTextContent()`, which async-iterates a ReadableStream internally —
 * something WebKit does not implement. It throws
 * "undefined is not a function (near '...value of readableStream...')" on
 * every page, which looks exactly like a book with no text in it. Paper ships
 * on WebKit everywhere except Windows, so this is the load-bearing path.
 */
async function pageDocument(page: PDFPageProxy): Promise<Document> {
  const doc = document.implementation.createHTMLDocument()
  /* The spans go under a `.textLayer` container, exactly as the painted page
   * puts them. A search hit's CFI addresses child indexes from the root, so a
   * document whose spans hang directly off `body` produces anchors one level
   * shallower than the page they are meant to point into. */
  const layer = doc.createElement('div')
  layer.className = 'textLayer'
  doc.body.append(layer)
  const reader = page.streamTextContent().getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const item of value?.items ?? []) {
      if (!('str' in item)) continue
      /* Mirrors pdf.js's own TextLayer: one span per item, and a <br> where
       * the item reports an end of line. It matters twice over. A search hit's
       * CFI addresses child indexes in THIS document, so inserting or omitting
       * a node shifts every anchor after it — jumping to a late hit lands in
       * the wrong place. And a bare space where the page has a line break
       * joins the last word of one line to the first of the next, so a phrase
       * spanning a line break cannot be found at all. */
      /* Appended only when the item has text, because that is what pdf.js's
       * own TextLayer does — it builds a span for every item but appends it
       * behind `hasText`, i.e. `item.str !== ''`. Appending unconditionally
       * put a node in this document that the painted page does not have, and
       * every CFI child index after it was off by one: a search hit past an
       * empty item resolved into the wrong text, or failed to resolve. */
      if (item.str !== '') {
        const span = doc.createElement('span')
        span.textContent = item.str
        layer.append(span)
      }
      if ('hasEOL' in item && item.hasEOL) layer.append(doc.createElement('br'))
    }
  }
  return doc
}

/** The blank page document, into which `paint` draws. */
function pageSource(width: number, height: number): string {
  /* No `lang`. It was hardcoded to English, which is an assertion rather than a
   * default: a Chinese or Japanese PDF was announced as English to the platform,
   * and language-dependent behaviour — selection granularity, hyphenation,
   * screen-reader pronunciation — followed the wrong language. Omitting it
   * leaves the language undetermined, which is the truth here, and lets a
   * future caller supply one from the PDF's own metadata. */
  const html = `<!DOCTYPE html>
<html>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
<style>
html, body { margin: 0; padding: 0; }
:root {
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
}
${viewerCss}
</style>
<div id="canvas"></div>
<div class="textLayer"></div>
`
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }))
}

function tocItem(item: { title: string; dest: unknown; items?: unknown[] }): TocItem {
  const subitems = item.items?.length
    ? item.items.map((child) => tocItem(child as Parameters<typeof tocItem>[0]))
    : null
  /* A destinationless heading gets `href: null`, which is foliate's own signal
   * for a grouping row that is not a link — `TocItem.href` is declared nullable
   * for exactly this. `JSON.stringify(null)` returns the STRING "null", so an
   * unlinked heading used to arrive looking perfectly navigable and then failed
   * when the reader clicked it, with `goTo("null")` resolving nothing. */
  const href = item.dest == null ? null : JSON.stringify(item.dest)
  return { label: item.title, href, subitems }
}

export interface PdfHooks {
  /**
   * A page has finished painting, text layer and all.
   *
   * The overlay for a section is created when its frame LOADS, which for a PDF
   * is before `paint` has put any text in it — so a mark's CFI resolves against
   * an empty document and silently draws nothing. This is the caller's cue to
   * re-attach the marks now that there is text to anchor them to.
   */
  onPagePainted?: () => void
}

/**
 * A PDF whose bytes are somewhere else (phase 18, WI-18.8).
 *
 * The browser client holds no book. `range` is a `PDFDataRangeTransport` over
 * `content.read`, so pdf.js asks the shelf for the byte ranges of the page it
 * is rendering and nothing more — the difference between opening a 300 MB
 * scanned book and downloading one.
 *
 * `name` is what the book was called, because pdf.js answers a title from the
 * document's own metadata and most scanned books have none.
 */
export interface RangedPdf extends RangedSource {
  readonly range: PDFDataRangeTransport
}

/**
 * The transport out of a ranged source, checked.
 *
 * `formats.ts` types `range` as `object` so that half a megabyte of pdf.js
 * stays out of every module that asks what a file is; this is the one place
 * that has already paid for the import, so this is where the type is made
 * real. It is CHECKED rather than asserted because `getDocument` silently
 * ignores a `range` that fails its own `instanceof` and then throws "Invalid
 * parameter object" — true, and about the wrong thing.
 */
function transportOf(source: RangedSource): PDFDataRangeTransport {
  if (source.range instanceof pdfjs.PDFDataRangeTransport) return source.range
  throw new Error(
    `Paper: ${source.name} carries a range that is not a PDFDataRangeTransport. ` +
      'Two copies of pdf.js in the module graph will do this.',
  )
}

export async function makePdf(file: BookSource, hooks: PdfHooks = {}): Promise<PdfBook> {
  const task = pdfjs.getDocument({
    ...(isRanged(file)
      ? {
          /* `length` COMES OFF THE TRANSPORT — `getDocument` reads
           * `src.range.length` and never looks at a `length` beside it, so
           * passing one here would be a field nothing reads.
           *
           * BOTH SWITCHES MATTER. Left at their defaults pdf.js fetches every
           * remaining byte in the background as soon as the first page is up,
           * which is the whole file over the wire and the exact cost this
           * transport exists to avoid. The book still works — which is why
           * this is easy to leave wrong and never notice. */
          range: transportOf(file),
          disableAutoFetch: true,
          disableStream: true,
        }
      : typeof file === 'string'
        ? { url: file }
        : { data: await file.arrayBuffer() }),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    /* Required for scanned books, which are JBIG2 or JPEG 2000 images with a
     * text layer over them. Without these every page fails to decode and the
     * book renders blank — pdf.js reports it as a warning, not an error. */
    wasmUrl: `${ASSET_BASE}wasm/`,
    iccUrl: `${ASSET_BASE}iccs/`,
  })
  const pdf: PDFDocumentProxy = await task.promise

  const { info } = (await pdf.getMetadata().catch(() => ({ info: {} }))) as {
    info?: { Title?: string; Author?: string }
  }
  const outline = (await pdf.getOutline().catch(() => null)) as
    | { title: string; dest: unknown; items?: unknown[] }[]
    | null

  /** A destination — a name or an explicit array — resolved to a page index. */
  const destIndex = async (href: string): Promise<number | null> => {
    try {
      const parsed: unknown = JSON.parse(href)
      const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
      if (!Array.isArray(dest) || dest.length === 0) return null
      return await pdf.getPageIndex(dest[0] as never)
    } catch {
      // Broken destinations are common in the wild; the entry simply does not
      // navigate rather than taking the table of contents down with it.
      return null
    }
  }

  const sources = new Map<number, string>()

  return {
    rendition: { layout: 'pre-paginated' },
    metadata: {
      title: info?.Title?.trim() || titleFromSource(file),
      author: info?.Author?.trim() || '',
      /* THE ONE THING THAT MAKES A PDF DIFFERENT FROM A BOOK, as far as the
       * rest of the app is concerned: it has pages. Reflowable text does not —
       * its "page" is a property of the window it happens to be shown in — so
       * this is what lets a citation say "p. 12" for a PDF and a chapter for an
       * EPUB without either of them having to ask what format they are.
       *
       * One section per page (see `sections` below), so the page a passage is
       * on is its section index plus one. Printed page LABELS — the roman
       * numerals a book gives its front matter — are not honoured: pdf.js
       * exposes them through `getPageLabels()`, but metadata is stored in
       * `library.json` and rewritten on every position save, and an array of
       * two thousand strings does not belong in a file written that often. */
      pageCount: pdf.numPages,
    },
    toc: outline?.map(tocItem) ?? [],
    sections: Array.from({ length: pdf.numPages }, (_, i) => ({
      id: i,
      load: async () => {
        const page = await pdf.getPage(i + 1)
        const { width, height } = page.getViewport({ scale: 1 })
        /* The blob URL is cached per page: foliate re-loads a section every
         * time it comes back into view, and minting a new object URL each time
         * leaks one per visit for the lifetime of the window. */
        let src = sources.get(i)
        if (!src) {
          src = pageSource(width, height)
          sources.set(i, src)
        }
        return {
          src,
          onZoom: ({ doc, scale }) => {
            /* Only a paint that finished AND is still current re-attaches the
             * marks. `paint` catches cancellation and failure and resolves
             * either way, so `.then(hook)` fired for a superseded page too —
             * re-resolving anchors against a text layer that had just been
             * replaced. The terminal catch is for the hook itself: this
             * promise is not awaited anywhere, so a throw in `redrawMarks`
             * reached the window as an unhandled rejection. */
            void paint(page, doc, scale)
              .then((painted) => {
                if (painted) hooks.onPagePainted?.()
              })
              .catch((cause: unknown) => {
                console.error('Paper: painting a PDF page failed', cause)
              })
          },
        }
      },
      createDocument: async () => pageDocument(await pdf.getPage(i + 1)),
      // foliate uses this to weight progress. Pages are equal enough.
      size: 1000,
    })),
    isExternal: (uri) => /^\w+:/i.test(uri),
    /* A destination that cannot be resolved REFUSES, rather than resolving to
     * page 0. Falling back sent the reader to the cover — from wherever they
     * were, with no way back but the history — and did it for exactly the
     * broken links this file already documents as common in the wild. The
     * rejection is caught by the caller in `session.ts`, where it does nothing
     * visible, which is what a dead link should do. */
    resolveHref: async (href) => {
      const index = await destIndex(href)
      if (index === null) throw new Error(`Paper: unresolvable PDF destination ${href}`)
      return { index }
    },
    splitTOCHref: async (href) => [await destIndex(href), null],
    getTOCFragment: (doc) => doc.documentElement,
    /* Page one, as the book's jacket.
     *
     * A PDF carries no embedded cover to pull out the way an EPUB does — but it
     * has a first page, which is the thing a reader recognises on a shelf, and
     * foliate's own PDF backend renders exactly that. Paper replaced that
     * backend wholesale to reach `pdfjs-dist` (see the header) and this method
     * did not come across, so every PDF filed no jacket at all.
     *
     * NOTHING SAID SO, which is the part worth keeping in mind. `session.ts`
     * reaches for this with an optional call — `view.book?.getCover?.()` — so a
     * backend that simply lacks the method is indistinguishable from a book
     * that has no picture. The shelf drew the derived tint, the tint is a
     * legitimate answer for a jacketless book, and so a missing feature wore
     * the costume of a working fallback. The comment on `BookCover` even
     * explained the gap as inherent to the format.
     *
     * Rendered STRAIGHT to `COVER_WIDTH` rather than at full size and shrunk
     * afterwards. `downscaleCover` would do the shrinking either way, but a
     * publisher's page at scale 1 is a couple of thousand pixels wide, and
     * decoding that to throw three quarters of it away is work with nothing to
     * show for it.
     *
     * Null rather than a throw when the page will not render. A book whose
     * jacket failed is a book with no jacket — the shelf already draws the tint
     * for that — and taking the open down over a thumbnail would be the wrong
     * trade by a wide margin. */
    getCover: async () => {
      try {
        const page = await pdf.getPage(1)
        const unscaled = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: COVER_WIDTH / unscaled.width })
        /* Created in the HOST document, for the reason `paint` gives at length:
         * pdf.js loads a PDF's fonts into the document that owns the proxy, and
         * a canvas belonging to another document paints with substituted
         * glyphs. Nothing adopts this one — it never reaches the screen. */
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvas, viewport }).promise
        return await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve)
        })
      } catch (cause) {
        console.error('Paper: could not render the PDF cover', cause)
        return null
      }
    },
    destroy: () => {
      for (const src of sources.values()) URL.revokeObjectURL(src)
      sources.clear()
      // Reported rather than discarded: this is what releases the worker, and a
      // failure here is a leak that grows one book at a time with nothing on
      // screen to suggest it. Handed back so a caller can await the release;
      // still resolving on failure, because a teardown that cannot finish must
      // not become an unhandled rejection at the window.
      return task.destroy().catch((cause: unknown) => {
        console.error('Paper: could not destroy the PDF loading task', cause)
      })
    },
  }
}


