import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { TocItem } from 'foliate-js/view.js'
import type { BookMeta } from '../lib/useBook'

/**
 * PDF, which is a second reader rather than a second file format.
 *
 * foliate-js has no PDF loader — it rejects one as an unsupported type — so
 * nothing above this line is reusable. An EPUB is HTML in an iframe, which is
 * what lets marks be anchored by CFI, the ruler band be injected into the
 * book's own body, and speech be collected by walking text nodes. A PDF is a
 * sequence of pages painted onto canvases, and has none of those affordances.
 *
 * So this file loads and describes a PDF, and `PdfView` paints it. What is NOT
 * supported is stated in the reader rather than left to be discovered: marks,
 * the reading ruler and reading aloud are EPUB-only for now, because each needs
 * an anchor into a document that a canvas does not have.
 *
 * Text selection and copying DO work: pdf.js can lay a transparent text layer
 * over each page, which is also what makes the pages searchable.
 */

/* The worker is a separate module that Vite must emit as its own asset — hence
 * the `?url` import. Without this pdf.js falls back to running the parser on
 * the main thread, where a large document blocks every frame. */
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

export type PdfDocument = PDFDocumentProxy

/**
 * An open PDF, and the one call that closes it.
 *
 * `destroy` belongs to the LOADING TASK, not to the document — a document
 * abandoned without it leaves its worker and transport alive for the lifetime
 * of the window. Returning the pair together is what stops a caller holding
 * the document and having nothing to shut it down with.
 */
export interface OpenPdf {
  readonly doc: PdfDocument
  readonly destroy: () => void
}

export async function loadPdf(source: File | string): Promise<OpenPdf> {
  const task =
    typeof source === 'string'
      ? pdfjs.getDocument({ url: source })
      : pdfjs.getDocument({ data: await source.arrayBuffer() })
  const doc = await task.promise
  return { doc, destroy: () => void task.destroy() }
}

/**
 * The document's outline, flattened into the same shape the Contents panel
 * already renders for an EPUB.
 *
 * `href` carries a page NUMBER as a string rather than a destination object,
 * because that is what survives being passed through `goTo` as a plain string —
 * the panel and the book store both treat a target as opaque text. Resolving a
 * PDF destination to a page needs the document, which is why it happens here.
 */
export async function readOutline(doc: PdfDocument): Promise<TocItem[]> {
  const outline = await doc.getOutline()
  if (!outline) return []

  const toPage = async (dest: unknown): Promise<number | null> => {
    try {
      const resolved =
        typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[] | null)
      if (!Array.isArray(resolved) || resolved.length === 0) return null
      const index = await doc.getPageIndex(resolved[0] as never)
      return index + 1
    } catch {
      // A broken destination is common in the wild and must not take the whole
      // outline down with it — the entry simply becomes unnavigable.
      return null
    }
  }

  interface RawItem {
    title: string
    dest: unknown
    items?: RawItem[]
  }

  const convert = async (items: RawItem[]): Promise<TocItem[]> => {
    const out: TocItem[] = []
    for (const item of items) {
      const page = await toPage(item.dest)
      const subitems = item.items?.length ? await convert(item.items) : null
      out.push({
        label: item.title,
        href: page === null ? '' : String(page),
        subitems,
      })
    }
    return out
  }

  return convert(outline as unknown as RawItem[])
}

export async function readPdfMeta(doc: PdfDocument, fallback: string): Promise<BookMeta> {
  try {
    const { info } = (await doc.getMetadata()) as {
      info?: { Title?: string; Author?: string }
    }
    return {
      title: info?.Title?.trim() || fallback,
      author: info?.Author?.trim() || '',
    }
  } catch {
    return { title: fallback, author: '' }
  }
}

/**
 * One page's text.
 *
 * NOT `page.getTextContent()`, which is the obvious call and does not work
 * here: it async-iterates a ReadableStream internally, and WebKit does not
 * implement async iteration on streams. It throws
 * "undefined is not a function (near '...value of readableStream...')" on
 * every page, which — swallowed — looks exactly like a book with no text in it.
 *
 * Draining the stream with an explicit reader is the same thing pdf.js's own
 * TextLayer does, which is why the selectable text layer worked on these pages
 * while search found nothing on any of them. Paper ships on WebKit everywhere
 * except Windows, so this is the load-bearing path, not a fallback.
 */
async function pageText(doc: PdfDocument, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber)
  const reader = page.streamTextContent().getReader()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const item of value?.items ?? []) {
      if ('str' in item) text += `${item.str} `
    }
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Every page's text, for search.
 *
 * pdf.js ships a find controller, but it is bound to its own viewer's DOM and
 * page-management. Reading the text directly is a fraction of the surface for
 * the one thing the side pane needs, and it yields per page so a long document
 * streams results instead of blocking until the last page is parsed.
 */
export async function* searchPdf(
  doc: PdfDocument,
  query: string,
  signal: AbortSignal,
): AsyncGenerator<{ page: number; pre: string; match: string; post: string }> {
  const needle = query.trim().toLowerCase()
  if (!needle) return

  for (let page = 1; page <= doc.numPages; page += 1) {
    if (signal.aborted) return
    let text: string
    try {
      text = await pageText(doc, page)
    } catch (cause) {
      // A page whose text cannot be read is skipped rather than ending the
      // search — but it says so. Swallowing this made a search that failed on
      // every page indistinguishable from one that found nothing.
      console.error(`Paper: could not read text on page ${page}`, cause)
      continue
    }

    const haystack = text.toLowerCase()
    let at = haystack.indexOf(needle)
    while (at >= 0) {
      if (signal.aborted) return
      yield {
        page,
        pre: text.slice(Math.max(0, at - 40), at),
        match: text.slice(at, at + needle.length),
        post: text.slice(at + needle.length, at + needle.length + 40),
      }
      at = haystack.indexOf(needle, at + needle.length)
    }
  }
}
