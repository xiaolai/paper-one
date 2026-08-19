import type { IndexedBook } from './bookIndex'
import { TAG_MAX, fold, normalizeTag, tagKey } from './library'

/**
 * The reader's filing, as a file they can keep.
 *
 * Tags live in per-book `book.json` files and nowhere else, which means an
 * evening spent filing three hundred books exists in three hundred places, with
 * no way to back it up, carry it to another machine, or repair it in bulk. That
 * is the one part of a library that is purely the reader's work — everything
 * else can be re-derived from the files themselves.
 *
 * WHAT IS EXPORTED IS ONLY WHAT THE READER MADE. Publisher subjects are not
 * here: they come out of the book on every parse, so writing them into an
 * archive would be backing up a copy of something that regenerates itself, and
 * importing them would forge provenance — a subject the reader never adopted
 * would arrive as their own tag.
 *
 * PURE. Reading and writing the file belongs to the caller; everything about
 * what the document contains and how a book in it is matched to a book on the
 * shelf is decided here, where it can be tested without a filesystem.
 */

/** The document. Versioned so a later shape can be told from this one. */
export interface TagArchive {
  readonly version: 1
  readonly books: readonly ArchivedBook[]
}

/**
 * One book's filing.
 *
 * THREE WAYS TO NAME THE SAME BOOK, because the archive has two jobs and they
 * want different keys. Restoring into the same library wants `bookId`, which is
 * derived from the file's own bytes and is exact. Carrying the filing to
 * another machine — a different download of the same work — wants the title and
 * author, because the bytes there are not the same bytes. Both are written so
 * one file serves both, and `planImport` prefers the exact one.
 */
export interface ArchivedBook {
  readonly bookId: string
  readonly title: string
  readonly author: string
  readonly tags: readonly string[]
}

/** The tags to put on one book, as `planImport` works them out. */
export interface TagImport {
  readonly bookId: string
  readonly tags: readonly string[]
}

/** What an import would do, before it does it — for saying so in a sentence. */
export interface ImportPlan {
  readonly additions: readonly TagImport[]
  /** Books in the archive that match nothing on this shelf. */
  readonly unmatched: number
  /** How many books would gain at least one tag. */
  readonly booksTouched: number
  /** How many distinct tags would be added, across all books. */
  readonly tagsAdded: number
}

/** How a book is looked up by name when its id is not on this shelf. */
const nameKey = (title: string, author: string): string => `${fold(title)}\u0000${fold(author)}`

/**
 * Everything the reader has filed, as a document.
 *
 * Books with no tags of their own are left out entirely rather than written as
 * empty rows: an archive is a record of work done, and a thousand empty entries
 * make it harder to read and no more complete.
 */
export function exportTags(books: readonly IndexedBook[]): TagArchive {
  const rows: ArchivedBook[] = []
  for (const book of books) {
    const tags = book.tags ?? []
    if (tags.length === 0) continue
    rows.push({ bookId: book.bookId, title: book.title, author: book.author, tags: [...tags] })
  }
  return { version: 1, books: rows }
}

/** A bounded list of strings from a file nobody can vouch for. */
function tagList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const one of value) {
    if (typeof one !== 'string') continue
    const tag = normalizeTag(one)
    const key = tagKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, TAG_MAX * 8) : ''

/**
 * Read an archive, keeping what survives and dropping what does not.
 *
 * Null only when the document is not an archive at all — unparseable, or the
 * wrong shape. A file that IS an archive with three broken rows imports the
 * rest: this is a recovery path, and refusing the whole file over one bad row
 * is the behaviour that makes a backup worthless at the moment it is needed.
 */
export function parseArchive(raw: string): TagArchive | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (doc['version'] !== 1 || !Array.isArray(doc['books'])) return null
  const books: ArchivedBook[] = []
  for (const one of doc['books']) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const tags = tagList(row['tags'])
    if (tags.length === 0) continue
    const bookId = str(row['bookId'])
    const title = str(row['title'])
    // Unnameable by either route is not a row, it is noise.
    if (!bookId && !title) continue
    books.push({ bookId, title, author: str(row['author']), tags })
  }
  return { version: 1, books }
}

/**
 * What importing this archive would add, without adding it.
 *
 * ADDITIVE, ALWAYS. An import never takes a tag off: the file on disk is one
 * reader's filing at one moment, and treating it as the whole truth would make
 * restoring a month-old backup silently delete a month of work. Merging is the
 * only behaviour that cannot lose anything, and the reader can still remove
 * what they do not want afterwards — with an undo.
 *
 * MATCHED BY ID FIRST, then by title and author folded. The id is exact and
 * means "this same file"; the name is how filing follows a work to a different
 * download of it. A name that matches more than one book on the shelf is
 * skipped rather than guessed at — two editions of one title are exactly where
 * a wrong guess would put someone's filing on the wrong book.
 */
export function planImport(archive: TagArchive, books: readonly IndexedBook[]): ImportPlan {
  const byId = new Map<string, IndexedBook>()
  const byName = new Map<string, IndexedBook | null>()
  for (const book of books) {
    byId.set(book.bookId, book)
    const key = nameKey(book.title, book.author)
    // Null marks a name that more than one book answers to — see above.
    byName.set(key, byName.has(key) ? null : book)
  }

  const additions: TagImport[] = []
  let unmatched = 0
  let tagsAdded = 0
  for (const row of archive.books) {
    const match =
      (row.bookId ? byId.get(row.bookId) : undefined) ??
      (row.title ? byName.get(nameKey(row.title, row.author)) ?? undefined : undefined)
    if (!match) {
      unmatched += 1
      continue
    }
    /* Only what the book does not already carry, judged by KEY — an archive
       written before a rename holds the old spelling, and adding it back beside
       the new one would undo the rename one book at a time. */
    const own = new Set((match.tags ?? []).map(tagKey))
    const fresh = row.tags.filter((tag) => !own.has(tagKey(tag)))
    if (fresh.length === 0) continue
    additions.push({ bookId: match.bookId, tags: fresh })
    tagsAdded += fresh.length
  }
  return { additions, unmatched, booksTouched: additions.length, tagsAdded }
}

/** The file name an export is offered under. Dated, because a reader will keep
 *  more than one and the useful question about a backup is when it was taken. */
export function archiveName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `paper-tags-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}
