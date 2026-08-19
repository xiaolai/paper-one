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
}

/* There is no `parsed: boolean` here. Nothing outside the tests read it — the
 * driver acts identically either way, because a failure is already expressed in
 * what the record says: it repeats what the row had and moves only `parsedAt`.
 * A flag kept for a reporting feature nobody has asked for is the same
 * speculative mechanism `inPalette` was, and it goes for the same reason. */

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
  // `filter` already returns a fresh array; the `slice` that used to be here
  // copied it a second time before sorting.
  return books.filter(needsEnrichment).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
}

/**
 * HOW MANY books still need parsing — without ordering them.
 *
 * Separate from `pendingFor` because the progress line wants a number and
 * nothing else, and it wants it on every render. Taking `pendingFor(...).length`
 * sorted two thousand books to read one integer off the result, on every render
 * of the whole app, for the entire length of a pass that itself causes renders.
 */
export function pendingCount(books: readonly IndexedBook[]): number {
  let count = 0
  for (const book of books) if (needsEnrichment(book)) count += 1
  return count
}

/**
 * A shelf row as the record it came from — the shelf's own extra fields dropped.
 *
 * `IndexedBook` is a `BookRecord` plus `bookId` and the derived `hasContent`.
 * Neither belongs in a record being written back: `hasContent` is derived on
 * scan and storing it is the exact disagreement `bookIndex` exists to avoid.
 */
function recordOf(book: IndexedBook): BookRecord {
  const { hasContent: _hasContent, ...record } = book
  return record
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
  /**
   * Books are still arriving, and the main thread belongs to getting them in.
   *
   * The import copies on the main thread and now shelves as it copies, so the
   * rows this pass feeds on appear WHILE the import is running. Without this
   * the pass would start parsing at book twenty-four and spend a second per
   * book competing with the copy loop for the same thread — an import that
   * took half a minute would take an hour, with the counter the reader is
   * watching crawling for the whole of it.
   *
   * Nothing is lost by waiting: `parsedAt` on disk is the work list, so the
   * pass picks up every book the import brought in the moment it finishes.
   */
  | 'importing'
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
 * standing aside for the reader, which beats standing aside for the import,
 * which beats having nothing to do. Every stand-down is checked BEFORE the
 * work list is built, so neither a reader in a book nor a running import pays
 * even for the filter — and the filter is over the whole shelf, which during
 * an import is a list growing by twenty-four books at a time.
 */
export function nextStep(state: {
  readonly books: readonly IndexedBook[]
  readonly hasFilesystem: boolean
  readonly reading: boolean
  /** True while books are still being copied in — see `IdleReason`. */
  readonly importing?: boolean
}): PassStep {
  if (!state.hasFilesystem) return { kind: 'idle', why: 'no-filesystem' }
  if (state.reading) return { kind: 'idle', why: 'reading' }
  if (state.importing === true) return { kind: 'idle', why: 'importing' }
  const next = pendingFor(state.books)[0]
  return next ? { kind: 'parse', book: next } : { kind: 'idle', why: 'complete' }
}

/**
 * Parse one book and produce what to write.
 *
 * NEVER THROWS. A shelf is full of files Paper did not write — a truncated
 * download, a DRM'd EPUB, something renamed `.epub` that is not one — and a
 * pass that stops at the first of them enriches nothing after it. A failure is
 * a result: the row's own account of itself repeated back unchanged, with only
 * `parsedAt` moved — so the book keeps everything it had and the pass does not
 * come back to it.
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
    }
  } catch (cause) {
    /* Logged, not surfaced. There is no reader watching this and nothing they
     * could do about it; the book keeps its filename, which is what the shelf
     * showed a moment ago and is a perfectly usable row. */
    console.warn(`Paper: could not parse ${book.bookId} in the background`, cause)
    return {
      bookId: book.bookId,
      /* A FAILURE REPEATS WHAT THE ROW ALREADY SAYS, field for field, and that
       * is not defensive padding — it is the only safe thing to write.
       *
       * `mergeParsed` treats a record from a parse as the book's OWN ACCOUNT OF
       * ITSELF, and an account that omits a field is the book saying it has
       * none. A failure that wrote just `{title, author, parsedAt}` would
       * therefore be read as "this book has no subjects, no publisher, no
       * series, no languages" and would DELETE all of them. That is not
       * hypothetical: a book the reader has read has all of those, and a
       * re-parse of it that hit a transient failure would strip the record bare
       * while marking it complete.
       *
       * So a failure claims nothing new. It carries the record forward
       * unchanged and moves only `parsedAt`, which is the one field a failed
       * attempt has actually learned something about. */
      record: { ...recordOf(book), parsedAt },
      cover: null,
    }
  }
}
