/**
 * A book is a folder.
 *
 * ```
 * $APPDATA/books/<bookId>/
 *   content.<ext>   the bytes
 *   book.json       everything the shelf needs
 *   cover.webp      omitted when the book has no jacket
 *   marks.json      the reader's own writing
 * ```
 *
 * WHY, given phase 3 already worked. Because phase 3 spread one book across
 * three places that could disagree — a row in a flat store, bytes under
 * `books/`, a jacket under `covers/` — and its audit charged four bugs to
 * exactly that split: a copy written with no row referring to it, a book in the
 * vault whose row was gone and which stayed invisible because every later import
 * called it a duplicate, a cover left behind after removal, and a removal that
 * touched three places any of which could fail alone.
 *
 * None of those are expressible here. Not less likely — absent, because there is
 * nothing left for an index to disagree with. Removal is one rename. A duplicate
 * import has nowhere to go, because the folder name IS the content hash. And a
 * book is one directory to back up, replicate to a phone, or hand to somebody.
 *
 * The cost is that a shelf of 2,000 books cannot read 2,000 files to draw
 * itself, which is what `bookIndex` is for — and it is a CACHE. The folders are
 * the truth.
 */

import type { VaultFs } from './bookVault'
import { extensionFor } from './bookVault'

export const BOOKS_DIR = 'books'
export const TRASH_DIR = 'trash'

/** What `book.json` holds. Every field optional except the two a shelf needs. */
export interface BookRecord {
  /**
   * The book's canonical id, stored rather than inferred.
   *
   * A folder is named `safeId(bookId)`, which replaces every character outside
   * `[a-zA-Z0-9]` — so `book:abc` becomes `book_abc` and the mapping is NOT
   * reversible. Reading the id back off the directory name therefore renamed
   * every book on any rescan, and marks are keyed by it.
   *
   * Optional only because records written before this existed do not have it;
   * `scanBooks` falls back to the folder name for those, which is the same
   * wrong answer it always gave and no worse.
   */
  readonly bookId?: string
  readonly title: string
  readonly author: string
  readonly sortAs?: string
  readonly series?: string
  readonly seriesIndex?: number | null
  readonly publisher?: string
  readonly published?: string
  readonly languages?: readonly string[]
  /** The publisher's own subjects. Replaced whenever the book is re-parsed. */
  readonly subjects?: readonly string[]
  /** The reader's tags. NEVER replaced by a parse — see `writeBook`. */
  readonly tags?: readonly string[]
  readonly position?: string | null
  readonly progress?: number
  readonly finished?: boolean
  readonly addedAt?: number
  readonly openedAt?: number
  /**
   * Where this book was imported from, for provenance only.
   *
   * DEVICE-LOCAL, and the one field here that is. A macOS path replicated onto
   * a phone is meaningless, so anything that syncs a book must strip it.
   */
  readonly origin?: string | null
  /** The content file's extension, so the reader can be handed a real name. */
  readonly ext?: string
}

/**
 * A `bookId` reduced to a safe single path segment.
 *
 * `bookIdFor` produces `book:` followed by hex, so in practice this changes
 * nothing. It is here because "in practice" is not a guarantee: an id also comes
 * back off a stored record, and a path segment built from one must not be able
 * to contain a slash whatever it says.
 *
 * Not exported — the two builders below are the only callers, and a path helper
 * that anything can reach is a path helper somebody will use to build a path
 * this file did not sanction.
 */
function safeId(bookId: string): string {
  return bookId.replace(/[^a-zA-Z0-9]/g, '_')
}

export const folderOf = (bookId: string): string => `${BOOKS_DIR}/${safeId(bookId)}`
export const trashOf = (bookId: string): string => `${TRASH_DIR}/${safeId(bookId)}`
export const recordPath = (bookId: string): string => `${folderOf(bookId)}/book.json`
export const coverPathIn = (bookId: string): string => `${folderOf(bookId)}/cover.webp`
export const marksPathIn = (bookId: string): string => `${folderOf(bookId)}/marks.json`
export const contentPathIn = (bookId: string, name: string): string =>
  `${folderOf(bookId)}/content.${extensionFor(name)}`

const MAX_FIELD = 500
const MAX_LONG = 4000
/**
 * The bound for a reading position, which is DROPPED past it rather than cut.
 *
 * A CFI is a path through a document and truncating one does not produce a
 * shorter position, it produces a broken string that parses as nothing. Worse,
 * the truncated value survived the next merge and was written back over the
 * complete one, so a position long enough to trip this was destroyed by being
 * read. Generous enough that no real CFI reaches it, and a bound rather than
 * none because this parses a file a reader can edit.
 */
const MAX_POSITION = 64_000
const MAX_LIST = 64

const text = (v: unknown, limit = MAX_FIELD): string | undefined =>
  typeof v === 'string' && v ? v.slice(0, limit) : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const list = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const clean = v
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .slice(0, MAX_LIST)
    .map((one) => one.slice(0, MAX_FIELD))
  return clean.length ? clean : undefined
}

/**
 * Read a `book.json` back, dropping anything malformed.
 *
 * The same trust boundary the flat store had, and for the same reason: this is a
 * file on disk that anything could have written. A `subjects` that is a number
 * rather than an array of strings crashes the shelf the moment it renders.
 *
 * Built from KNOWN FIELDS rather than spread, so an unknown key never reaches
 * memory — the correction phase 3's audit forced, kept.
 */
export function parseRecord(raw: string | null): BookRecord | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  // A book with no title at all is still a book — the filename stands in — so
  // this is the one field that falls back rather than failing the record.
  const title = text(r['title']) ?? ''
  return {
    ...(text(r['bookId']) ? { bookId: text(r['bookId'])! } : {}),
    title,
    author: text(r['author']) ?? '',
    ...(text(r['sortAs']) ? { sortAs: text(r['sortAs'])! } : {}),
    ...(text(r['series']) ? { series: text(r['series'])! } : {}),
    ...(num(r['seriesIndex']) === undefined ? {} : { seriesIndex: num(r['seriesIndex'])! }),
    ...(text(r['publisher']) ? { publisher: text(r['publisher'])! } : {}),
    ...(text(r['published']) ? { published: text(r['published'])! } : {}),
    ...(list(r['languages']) ? { languages: list(r['languages'])! } : {}),
    ...(list(r['subjects']) ? { subjects: list(r['subjects'])! } : {}),
    ...(list(r['tags']) ? { tags: list(r['tags'])! } : {}),
    /* NOT `text`, which SLICES. See `MAX_POSITION`: a shortened CFI is not a
     * rougher position, it is a broken one, and it used to overwrite the good
     * value on the next merge. Over the bound the field is dropped, so the book
     * opens at the beginning — recoverable — instead of at a corrupted anchor. */
    ...(typeof r['position'] === 'string' &&
    r['position'] !== '' &&
    r['position'].length <= MAX_POSITION
      ? { position: r['position'] }
      : {}),
    // Clamped, not merely checked finite: a hand-edited `progress: 4` would draw
    // a bar four times the width of its track.
    ...(num(r['progress']) === undefined
      ? {}
      : { progress: Math.min(1, Math.max(0, num(r['progress'])!)) }),
    ...(typeof r['finished'] === 'boolean' ? { finished: r['finished'] } : {}),
    ...(num(r['addedAt']) === undefined ? {} : { addedAt: num(r['addedAt'])! }),
    ...(num(r['openedAt']) === undefined ? {} : { openedAt: num(r['openedAt'])! }),
    ...(text(r['origin'], MAX_LONG) ? { origin: text(r['origin'], MAX_LONG)! } : {}),
    ...(text(r['ext'], 8) ? { ext: text(r['ext'], 8)! } : {}),
  }
}

export async function readBook(fs: VaultFs, bookId: string): Promise<BookRecord | null> {
  try {
    const bytes = await fs.readFile(recordPath(bookId))
    return parseRecord(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/**
 * Write a book's record, whole and atomically.
 *
 * Temp neighbour then rename, the property `ownBook` already has: an interrupted
 * write must not leave a truncated `book.json`, because that file IS the book as
 * far as the shelf is concerned, and a half-written one would lose the reader's
 * tags and position with no error anywhere.
 *
 * ONE BOOK'S FILE, which is the other half of the point. The flat store
 * serialised the entire shelf on every position save; a page turn now writes a
 * few hundred bytes.
 */
export async function writeBook(
  fs: VaultFs,
  bookId: string,
  record: BookRecord,
): Promise<void> {
  const path = recordPath(bookId)
  const writing = `${path}.writing`
  await fs.mkdir(folderOf(bookId))
  try {
    // Stamped on every write, so the record always knows its own id even if the
    // caller passed one that was not in it.
    const stamped: BookRecord = { ...record, bookId }
    await fs.writeFile(writing, new TextEncoder().encode(JSON.stringify(stamped, null, 2)))
    await fs.rename(writing, path)
  } catch (cause) {
    await fs.remove(writing).catch(() => {})
    throw cause
  }
}

/**
 * Change part of a book's record, reading and writing under one call.
 *
 * The replacement for seven near-duplicate mutators. `rememberPosition`,
 * `rememberVault`, `rememberCover`, `markFinished`, `tagBook`, `untagBook` and
 * `applyLookup` were seven ways to write one field to one book, each with its
 * own identity check and its own persistence path.
 *
 * Returns false when the book is not there, which is not an error: a write
 * racing a removal should do nothing rather than recreate the folder.
 */
export async function updateBook(
  fs: VaultFs,
  bookId: string,
  change: (record: BookRecord) => BookRecord,
): Promise<boolean> {
  /* THE CHANGE IS APPLIED TO WHAT IS ON DISK, which is the point of taking a
   * function rather than a value. A caller holding an in-memory copy may be
   * behind — the index it came from can be one write stale after a crash — and
   * writing that copy back would undo whatever landed in between. */
  /* WHETHER A REMOVED COPY WAS ALREADY WAITING, read before anything is
   * written. It is the discriminator for the check below: a trash entry that
   * appears while this call is running is a removal that happened in between. */
  const trashedBefore = await fs.exists(trashOf(bookId))
  const current = await readBook(fs, bookId)
  if (!current) {
    /* PRESENT BUT UNREADABLE IS NOT ABSENT. `readBook` answers both with null,
     * and returning false here reported "the book is gone, nothing to do" — so
     * the tag the reader had just typed was dropped with no error anywhere and
     * nothing to replay it. Gone is false; broken throws, and the caller says
     * it could not save. */
    if (await fs.exists(recordPath(bookId))) {
      throw new Error(`book.json for ${bookId} is there but could not be read`)
    }
    return false
  }
  const next = change(current)
  if (next === current) return true
  await writeBook(fs, bookId, next)
  /* CHECKED AFTER THE WRITE, because a removal can rename the folder between
   * the read above and the write — and `writeBook` calls `mkdir`, so it happily
   * recreates the folder containing nothing but this record. That is a book
   * resurrected as an empty shell, which is worse than the write being lost.
   *
   * TESTING `exists(folder)` HERE PROVED NOTHING: `writeBook` had just created
   * it, so the answer was always yes and the guard could not fire. The removal
   * is what leaves a trace — the folder it renamed away — so that is what is
   * looked for, and only when it was not already there. */
  if (!trashedBefore && (await fs.exists(trashOf(bookId)))) {
    // Undone rather than left: the shell this call created is removed, and the
    // removal keeps the book it moved.
    await fs.removeDir(folderOf(bookId)).catch(() => {})
    return false
  }
  return true
}

/**
 * Fold what a parse learned into what the reader owns.
 *
 * The book is the authority on its own metadata; the reader is the authority on
 * their tags, their place in it, and whether they are done. Phase 3 got this
 * wrong in `recordOpen` and erased a reader's tags on every reopen, so the rule
 * is stated as a function rather than left to a spread.
 */
/**
 * Reconcile TWO records that are both the reader's, for one book.
 *
 * Not the same problem as `mergeParsed`, which folds what a book says about
 * itself into what the reader owns and has a clear winner for every field. Here
 * both sides are the reader's own work — a record stranded in the trash by a
 * restore that could not finish, and the live one that has been in use since —
 * so taking either side whole loses the other's.
 *
 * Tags UNION, because a tag is an addition and neither list is more correct.
 * Position and progress come from the LIVE record when it has them, because
 * reading moves forwards and the live one is where the reading happened.
 * `finished` is true if either says so; `addedAt` is the earlier, since that is
 * when the book actually arrived.
 */
export function mergeStranded(stranded: BookRecord, live: BookRecord): BookRecord {
  const tags = [...(stranded.tags ?? [])]
  const seen = new Set(tags.map((tag) => tag.trim().normalize('NFC').toLowerCase()))
  for (const tag of live.tags ?? []) {
    const key = tag.trim().normalize('NFC').toLowerCase()
    if (key && !seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  const addedAt =
    stranded.addedAt === undefined
      ? live.addedAt
      : live.addedAt === undefined
        ? stranded.addedAt
        : Math.min(stranded.addedAt, live.addedAt)
  return {
    ...live,
    ...(tags.length ? { tags } : {}),
    ...(live.position ?? stranded.position ? { position: live.position ?? stranded.position! } : {}),
    ...((live.progress ?? stranded.progress) === undefined
      ? {}
      : { progress: live.progress ?? stranded.progress! }),
    ...(stranded.finished || live.finished ? { finished: true } : {}),
    ...(addedAt === undefined ? {} : { addedAt }),
  }
}

export function mergeParsed(previous: BookRecord | null, parsed: BookRecord): BookRecord {
  if (!previous) return parsed
  return {
    ...parsed,
    ...(previous.tags ? { tags: previous.tags } : {}),
    ...(previous.position ? { position: previous.position } : {}),
    ...(previous.progress === undefined ? {} : { progress: previous.progress }),
    ...(previous.finished === undefined ? {} : { finished: previous.finished }),
    ...(previous.addedAt === undefined ? {} : { addedAt: previous.addedAt }),
  }
}


/**
 * The reader's marks in a book, read from that book's folder.
 *
 * Decision 1: they are what the reader WROTE about this book, so they belong
 * with it. It also makes a book genuinely self-contained — one directory to back
 * up, replicate to a phone, or hand to somebody — and it means removing a book
 * takes its annotations with it in one rename, rather than leaving them in a
 * shared file keyed by an id nothing refers to any more.
 *
 * Returns an empty list for a book with none, and THROWS for one whose file is
 * there and will not read. The two are different answers and were the same for
 * a while, which is how a momentary read failure came to look like a book with
 * no marks — and the next highlight wrote over everything the reader had.
 */
export async function readMarks(fs: VaultFs, bookId: string): Promise<unknown[]> {
  /* ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER, and collapsing them into
   * `[]` was the most destructive line in this file. A book with no marks yet
   * and a book whose marks file could not be read look identical to the caller
   * — so a momentary read failure loaded an empty list, and the next highlight
   * wrote a snapshot of exactly that one mark over everything the reader had.
   *
   * Absent is an empty list, which is the truth. Anything else THROWS, and the
   * store surfaces it as "not saving" rather than quietly starting again. */
  if (!(await fs.exists(marksPathIn(bookId)))) return []
  const bytes = await fs.readFile(marksPathIn(bookId))
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  /* A file holding something that is not a list is not a marks file. Treated as
   * empty it would be overwritten on the next edit; thrown, it is left alone. */
  if (!Array.isArray(parsed)) throw new Error(`marks.json for ${bookId} is not a list`)
  return parsed
}

/** Write a book's marks, whole and atomically — see `writeBook`. */
export async function writeMarks(
  fs: VaultFs,
  bookId: string,
  marks: readonly unknown[],
): Promise<void> {
  const path = marksPathIn(bookId)
  const writing = `${path}.writing`
  await fs.mkdir(folderOf(bookId))
  try {
    await fs.writeFile(writing, new TextEncoder().encode(JSON.stringify(marks)))
    await fs.rename(writing, path)
  } catch (cause) {
    await fs.remove(writing).catch(() => {})
    throw cause
  }
}
