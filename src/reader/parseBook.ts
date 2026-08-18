import { isPdf } from '../lib/formats'
import { readMeta } from './session'
import type { BookMeta } from '../lib/useBook'

/**
 * Read a book's own account of itself, WITHOUT rendering it.
 *
 * The reader gets metadata and a jacket as a side effect of opening a book: a
 * `View` is built, a document is laid out, and the parse falls out on the way.
 * The enrichment pass needs the parse and none of the rest — two thousand books
 * are not going to be laid out one at a time — so this is the same parsers,
 * reached directly.
 *
 * SAME PARSERS, and that is the point rather than an implementation detail.
 * `readMeta` is the reader's own, so a book filled in by the pass carries
 * exactly the fields it would have carried had the reader opened it; and the
 * PDF branch is the same `makePdf` the reader opens PDFs with, so its jacket is
 * the same page one at the same width. A second extractor here would be a
 * second answer to "what is this book called", and the two would drift with
 * nothing comparing them.
 *
 * Both parsers are loaded LAZILY, and for the reason the reader loads pdf.js
 * lazily: it is half a megabyte, and a launch that touches no PDF must not pay
 * for it. A shelf of EPUBs never loads it at all.
 */
export interface ParsedBook {
  readonly meta: BookMeta
  readonly cover: Blob | null
}

export async function parseBook(file: File): Promise<ParsedBook> {
  return isPdf(file) ? parsePdf(file) : parseEpub(file)
}

async function parseEpub(file: File): Promise<ParsedBook> {
  const { makeBook } = await import('foliate-js/view.js')
  const book = await makeBook(file)
  const meta = readMeta(book)
  /* A jacket is not worth failing a parse over — a malformed manifest is a book
   * without a picture, which is the same thing the reader's own open decides
   * when it pulls a cover out beside the first paint. */
  const cover = await book.getCover?.().catch(() => null)
  return { meta, cover: cover ?? null }
}

async function parsePdf(file: File): Promise<ParsedBook> {
  const { makePdf } = await import('./makePdf')
  const book = await makePdf(file)
  try {
    const meta = readMeta(book)
    const cover = await book.getCover().catch(() => null)
    return { meta, cover: cover ?? null }
  } finally {
    /* ALWAYS, and this is the line the pass depends on. A `PdfBook` owns a
     * pdf.js document, its worker and a set of object URLs; two thousand of
     * them left open is two thousand workers, and the pass would take the app
     * down long before it reached the end of a real library. The reader gets
     * this for free from session disposal — there is no session here, so it is
     * spelled out. */
    book.destroy()
  }
}
