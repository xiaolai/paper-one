import { coverFrom } from '../lib/coverArt'
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
interface ParsedBook {
  readonly meta: BookMeta
  readonly cover: Blob | null
}

export async function parseBook(file: File): Promise<ParsedBook> {
  return isPdf(file) ? parsePdf(file) : parseFoliateBook(file)
}

/**
 * Everything that is not a PDF: EPUB, MOBI, AZW3, FB2, FBZ, CBZ.
 *
 * Named for the parser rather than for EPUB, because it was called `parseEpub`
 * and reviewed as though EPUB were the only thing reaching it — which is how
 * the FB2 cover trap above sat here unnoticed.
 */
async function parseFoliateBook(file: File): Promise<ParsedBook> {
  const { makeBook } = await import('foliate-js/view.js')
  const book = await makeBook(file)
  try {
    return { meta: readMeta(book), cover: await coverFrom(book) }
  } finally {
    /* THIS BRANCH NEEDS IT TOO, which the first version of this file missed by
     * giving the `finally` only to the PDF. `epub.js`, `fb2.js` and
     * `comic-book.js` all define `destroy()` — FB2 creates an object URL PER
     * SECTION — and none of it was ever released, so a pass over two thousand
     * books leaked every one of them. It went unseen because the `Book` type
     * did not declare the method that the fork has always had. */
    book.destroy?.()
  }
}

async function parsePdf(file: File): Promise<ParsedBook> {
  const { makePdf } = await import('./makePdf')
  const book = await makePdf(file)
  try {
    return { meta: readMeta(book), cover: await coverFrom(book) }
  } finally {
    /* ALWAYS, and AWAITED. A `PdfBook` owns a pdf.js document, its worker and a
     * set of object URLs; two thousand left open is two thousand workers, and
     * the pass would take the app down long before the end of a real library.
     * Fire-and-forget was not enough: `parseBook` resolved before the worker
     * was actually released, so the next book's parse overlapped the previous
     * one's teardown and the one-at-a-time guarantee was one-at-a-time only in
     * the part that is cheap. */
    await book.destroy()
  }
}
