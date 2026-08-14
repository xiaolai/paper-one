import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import viewerCss from 'pdfjs-dist/web/pdf_viewer.css?raw'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TocItem } from 'foliate-js/view.js'

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

/* Staged into `public/pdfjs/` by `scripts/sync-pdfjs-assets.mjs`. pdf.js fetches
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
  destroy: () => void
}

/**
 * Paint one page into the document foliate has put on screen.
 *
 * Called on first display and again on every zoom, because the canvas is a
 * bitmap: scaling it with CSS blurs it, so it is repainted at the new scale
 * instead. `--scale-factor` is pdf.js's own contract with its text-layer CSS —
 * the spans are positioned in units of it, and without it every one of them
 * lands at the top-left corner.
 */
async function paint(page: PDFPageProxy, doc: Document, zoom: number): Promise<void> {
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
  await page.render({ canvas, viewport }).promise
  doc.querySelector('#canvas')?.replaceChildren(doc.adoptNode(canvas))

  const container = doc.querySelector('.textLayer')
  if (container) {
    container.replaceChildren()
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: container as HTMLElement,
      viewport,
    })
    await textLayer.render()

    /* pdf.js's selection fix: without `.selecting`, a drag that leaves the last
     * span selects to the end of the layer rather than to the pointer. */
    const end = doc.createElement('div')
    end.className = 'endOfContent'
    container.append(end)
    container.addEventListener('pointerdown', () => container.classList.add('selecting'))
    container.addEventListener('pointerup', () => container.classList.remove('selecting'))
  }

  /* pdf.js appends measuring canvases to the HOST document while rendering a
   * text layer and does not remove them. Unhidden they stack up over the
   * reader, one per page painted. */
  for (const stray of document.querySelectorAll('.hiddenCanvasElement')) {
    Object.assign((stray as HTMLElement).style, {
      position: 'absolute',
      width: '0',
      height: '0',
      display: 'none',
    })
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
  const reader = page.streamTextContent().getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const item of value?.items ?? []) {
      if (!('str' in item) || !item.str) continue
      const span = doc.createElement('span')
      span.textContent = item.str
      doc.body.append(span, doc.createTextNode(' '))
    }
  }
  return doc
}

/** The blank page document, into which `paint` draws. */
function pageSource(width: number, height: number): string {
  const html = `<!DOCTYPE html>
<html lang="en">
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
  return { label: item.title, href: JSON.stringify(item.dest), subitems }
}

export async function makePdf(file: File | string): Promise<PdfBook> {
  const task = pdfjs.getDocument({
    ...(typeof file === 'string' ? { url: file } : { data: await file.arrayBuffer() }),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
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
      title: info?.Title?.trim() || fileName(file),
      author: info?.Author?.trim() || '',
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
        return { src, onZoom: ({ doc, scale }) => void paint(page, doc, scale) }
      },
      createDocument: async () => pageDocument(await pdf.getPage(i + 1)),
      // foliate uses this to weight progress. Pages are equal enough.
      size: 1000,
    })),
    isExternal: (uri) => /^\w+:/i.test(uri),
    resolveHref: async (href) => ({ index: (await destIndex(href)) ?? 0 }),
    splitTOCHref: async (href) => [await destIndex(href), null],
    getTOCFragment: (doc) => doc.documentElement,
    destroy: () => {
      for (const src of sources.values()) URL.revokeObjectURL(src)
      sources.clear()
      void task.destroy()
    },
  }
}

function fileName(file: File | string): string {
  const name = typeof file === 'string' ? (file.split('/').pop() ?? file) : file.name
  return name.replace(/\.pdf$/i, '')
}
