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

/** A `bookId` reduced to a safe single path segment — see `bookVault`. */
export function safeId(bookId: string): string {
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
    ...(text(r['position'], MAX_LONG) ? { position: text(r['position'], MAX_LONG)! } : {}),
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
    await fs.writeFile(writing, new TextEncoder().encode(JSON.stringify(record, null, 2)))
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
  const current = await readBook(fs, bookId)
  if (!current) return false
  const next = change(current)
  if (next === current) return true
  await writeBook(fs, bookId, next)
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
 * Returns an empty list for a book with none AND for a file that will not parse.
 * The second is the same trust boundary the record has: this is a file on disk,
 * and one damaged book's marks should cost that book's marks rather than
 * throwing on the way to drawing a page.
 */
export async function readMarks(fs: VaultFs, bookId: string): Promise<unknown[]> {
  try {
    const bytes = await fs.readFile(marksPathIn(bookId))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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
