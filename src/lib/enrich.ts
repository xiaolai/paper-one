import type { IndexedBook } from './bookIndex'
import type { BookRecord } from './bookFolder'
import { recordFromMeta } from './bookFolder'

/**
 * Give a book that was never opened its own title, author and jacket.
 *
 * WHY THERE IS A SECOND PARSE PATH AT ALL. An import writes a placeholder: a
 * row whose title is the filename, because parsing three hundred books to learn
 * three hundred titles would make importing a folder as slow as reading one.
 * The comment that says so is right about the import and was wrong as a
 * permanent state — it left enrichment as a side effect of READING, and nothing
 * ever enriches a book you do not read. A library of two thousand imported
 * books stayed two thousand filenames and derived tints, and the shelf that was
 * built to show jackets showed almost none.
 *
 * So: the same parse the reader triggers by opening a book, run in the
 * background over the books nobody has opened. Not during the import — that
 * decision stands — but afterwards, and again on every launch, until there is
 * nothing left to do.
 *
 * THIS MODULE IS THE PART WITH NO MOVING PIECES: which books still need it, and
 * what one book's parse produces. It takes its parser and its filesystem as
 * arguments, so the whole of it is testable without pdf.js, without foliate and
 * without a DOM. The scheduling — one at a time, paused while a book is open,
 * resumed on the next launch — is `useEnrichment`, and it is a different kind
 * of problem.
 */

/** What a parse produced for one book, ready to be written. */
export interface Enriched {
  readonly bookId: string
  /** The record to fold in — always carries `parsedAt`. */
  readonly record: BookRecord
  /** The jacket, or null when the book has none or would not give one up. */
  readonly cover: Blob | null
  /** False when the parser could not read the file at all. */
  readonly parsed: boolean
}

/** The pieces `enrichOne` needs, injected so this module can be tested. */
export interface EnrichDeps {
  /**
   * Read a book's bytes back as a `File` the parser will accept.
   *
   * A `File` rather than bytes because the parser routes on the NAME's
   * extension — the vault stores by hash, and handing it `a3f9…` would make
   * every book an unknown format.
   */
  readonly readBook: (book: IndexedBook) => Promise<File>
  /**
   * Parse a file into the book's own account of itself and its jacket.
   *
   * The reader's own parser, handed in rather than imported, because importing
   * it here would pull pdf.js and foliate into every test that touches this
   * file — and because the enrichment pass must be able to say it uses the
   * SAME parser the reader does, which is a claim about the caller.
   */
  readonly parse: (file: File) => Promise<{
    readonly meta: Parameters<typeof recordFromMeta>[0]
    readonly cover: Blob | null
  }>
  /** Wall-clock, injected so a test does not have to freeze it. */
  readonly now: () => number
}

/**
 * Does this book still need parsing?
 *
 * `parsedAt` absent is the whole condition — see the field, which records that
 * the parser RAN rather than that it succeeded, so a book the parser cannot
 * read is not retried on every launch.
 *
 * `hasContent === false` is excluded because there is nothing to parse: the row
 * exists but the bytes do not, and the shelf already says so. It is checked as
 * an explicit `false` rather than falsy, since the flag is derived on scan and
 * absent on a record that predates it — and treating absent as "no content"
 * would make the pass skip every older book on the shelf.
 */
export function needsEnrichment(book: IndexedBook): boolean {
  return book.parsedAt === undefined && book.hasContent !== false
}

/**
 * The books still to do, in the order to do them.
 *
 * MOST RECENTLY ADDED FIRST. A reader who has just imported a folder is looking
 * at the shelf they imported it onto, and the books they are looking at are the
 * ones that should fill in first. Oldest-first would spend the first minutes on
 * books already scrolled past. Books with no `addedAt` sort last: they are from
 * a library old enough to predate the field, so they have been sitting there
 * unparsed for a long time already and one more pass changes nothing for them.
 */
export function pendingFor(books: readonly IndexedBook[]): readonly IndexedBook[] {
  return books
    .filter(needsEnrichment)
    .slice()
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
}

/**
 * Why the pass is not parsing anything right now.
 *
 * Named rather than boolean, because "idle" has three very different causes and
 * only one of them means the work is finished. A pass that has stood down for
 * the reader and a pass with nothing left to do look identical from outside,
 * and the difference is the whole question when somebody asks why their covers
 * stopped appearing.
 */
export type IdleReason =
  /** Outside Tauri: there is no library on disk to enrich. */
  | 'no-filesystem'
  /** The reader is in a book, and the main thread is theirs. */
  | 'reading'
  /** Every book on the shelf has been parsed. */
  | 'complete'

export type PassStep =
  | { readonly kind: 'idle'; readonly why: IdleReason }
  | { readonly kind: 'parse'; readonly book: IndexedBook }

/**
 * What the pass should do at this instant.
 *
 * PURE, and extracted for the same reason `nextPlacement` was pulled out of
 * `usePlacement`: the decisions worth testing are the ones about WHEN to act,
 * and they were trapped inside an effect that needs a DOM, a filesystem and a
 * parser to reach. This needs none of the three, so the rule that the pass
 * stands down while the reader is in a book is a test rather than a promise.
 *
 * The order of the checks is the order of the reasons: no library at all beats
 * standing aside for the reader, which beats having nothing to do. Reading is
 * checked BEFORE the work list is built, so a reader in a book never pays even
 * for the filter.
 */
export function nextStep(state: {
  readonly books: readonly IndexedBook[]
  readonly hasFilesystem: boolean
  readonly reading: boolean
}): PassStep {
  if (!state.hasFilesystem) return { kind: 'idle', why: 'no-filesystem' }
  if (state.reading) return { kind: 'idle', why: 'reading' }
  const next = pendingFor(state.books)[0]
  return next ? { kind: 'parse', book: next } : { kind: 'idle', why: 'complete' }
}

/**
 * Parse one book and produce what to write.
 *
 * NEVER THROWS. A shelf is full of files Paper did not write — a truncated
 * download, a DRM'd EPUB, something renamed `.epub` that is not one — and a
 * pass that stops at the first of them enriches nothing after it. A failure is
 * a result: `parsed: false`, and a record that carries only `parsedAt`, so the
 * book keeps the filename it had and the pass does not come back to it.
 *
 * The record deliberately does NOT carry `openedAt`, `ext`, `origin` or
 * `bookId`: a parse knows about the book, not about this copy of it, and
 * `mergeParsed` keeps those from what is already there. That division is the
 * subject of the partition test in `bookFolder.test.ts`, and getting it wrong
 * here would have stripped the extension off every enriched PDF and left a
 * shelf of books that open nothing.
 */
export async function enrichOne(deps: EnrichDeps, book: IndexedBook): Promise<Enriched> {
  const parsedAt = deps.now()
  try {
    const file = await deps.readBook(book)
    const { meta, cover } = await deps.parse(file)
    return {
      bookId: book.bookId,
      record: { ...recordFromMeta(meta), parsedAt },
      cover,
      parsed: true,
    }
  } catch (cause) {
    /* Logged, not surfaced. There is no reader watching this and nothing they
     * could do about it; the book keeps its filename, which is what the shelf
     * showed a moment ago and is a perfectly usable row. */
    console.warn(`Paper: could not parse ${book.bookId} in the background`, cause)
    return {
      bookId: book.bookId,
      /* `title` and `author` are `BookRecord`'s required fields, so a failure
       * still has to supply them — and it supplies WHAT THE ROW ALREADY HAS,
       * not empty strings. `mergeParsed` treats a parse as the book's own
       * account of itself, so writing `title: ''` here would erase the filename
       * the import put there and leave the reader an untitled row. */
      record: { title: book.title, author: book.author, parsedAt },
      cover: null,
      parsed: false,
    }
  }
}
