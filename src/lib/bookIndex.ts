/**
 * A cache of every book's record, so the shelf is one read rather than N.
 *
 * THE WORD THAT MATTERS IS DERIVED, and it is the difference between this and
 * the flat store it replaces:
 *
 *   - It is rebuilt by scanning `books/*∕book.json`, and rebuilding is safe.
 *   - If it disagrees with a folder, THE FOLDER WINS.
 *   - It is never the only copy of anything.
 *   - Losing it is a rescan, not data loss.
 *
 * Phase 3's store was the opposite: it WAS the truth and the files beside it
 * were side effects, which is the arrangement that produced an orphaned copy, an
 * invisible book, a stale cover and a three-step removal.
 *
 * That is also why every write goes to `book.json` FIRST and here second. A
 * crash between the two costs a stale index until the next scan; the reverse
 * would cost the reader's work.
 */

import type { VaultFs } from './bookVault'
import { BOOKS_DIR, parseRecord, recordPath, type BookRecord } from './bookFolder'

export const INDEX_FILE = 'index.json'

/** A book as the shelf needs it: its record, plus the id naming its folder. */
export interface IndexedBook extends BookRecord {
  readonly bookId: string
}

export interface IndexFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
}

interface StoredIndex {
  readonly version: 1
  readonly books: readonly IndexedBook[]
}

/**
 * Read the cache, or null when it is missing, corrupt or a version we do not
 * know.
 *
 * All three are the same thing to the caller — rescan — which is why they are
 * not distinguished. A cache that cannot be read has no claim on anything.
 */
export function parseIndex(raw: string | null): readonly IndexedBook[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const shape = parsed as Partial<StoredIndex>
  if (!shape || shape.version !== 1 || !Array.isArray(shape.books)) return null
  const books: IndexedBook[] = []
  for (const one of shape.books) {
    const id = (one as { bookId?: unknown })?.bookId
    if (typeof id !== 'string' || !id) continue
    // Validated through the SAME parser the folder uses, so the cache cannot
    // hold a shape the record could not.
    const record = parseRecord(JSON.stringify(one))
    if (record) books.push({ ...record, bookId: id })
  }
  return books
}

/**
 * Rebuild by reading every book's record.
 *
 * A folder whose `book.json` is missing or unreadable is SKIPPED rather than
 * failing the scan: one damaged book should cost that book, not the library. It
 * also means a half-written import — a folder with content but no record yet —
 * is simply not on the shelf until it is finished, which is the correct
 * behaviour rather than a special case.
 */
export async function scanBooks(fs: IndexFs): Promise<IndexedBook[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await fs.readDir(BOOKS_DIR)
  } catch {
    // No library yet. An empty shelf, not an error.
    return []
  }
  const books: IndexedBook[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    try {
      const bytes = await fs.readFile(`${BOOKS_DIR}/${entry.name}/book.json`)
      const record = parseRecord(new TextDecoder().decode(bytes))
      if (record) books.push({ ...record, bookId: entry.name })
    } catch {
      continue
    }
  }
  return books
}

/**
 * Load the shelf: the cache when it is usable, a scan when it is not.
 *
 * `trust` decides whether a present cache is believed. It exists because the
 * cache can be STALE rather than wrong — a crash between writing a record and
 * writing the index leaves it one book behind — and the cheap check is whether
 * the folder count matches. A mismatch rescans.
 *
 * That check is deliberately weak: it catches a book added or removed outside
 * the app, which is the case worth catching, and it does not try to detect an
 * edited record. A reader who edits `book.json` by hand can delete the index.
 */
export async function loadShelf(fs: IndexFs): Promise<{ books: IndexedBook[]; rescanned: boolean }> {
  const cached = await readIndex(fs)
  if (cached) {
    const folders = await countFolders(fs)
    if (folders === cached.length) return { books: [...cached], rescanned: false }
  }
  const books = await scanBooks(fs)
  await writeIndex(fs, books).catch(() => {})
  return { books, rescanned: true }
}

async function readIndex(fs: IndexFs): Promise<readonly IndexedBook[] | null> {
  try {
    return parseIndex(new TextDecoder().decode(await fs.readFile(INDEX_FILE)))
  } catch {
    return null
  }
}

async function countFolders(fs: IndexFs): Promise<number> {
  try {
    return (await fs.readDir(BOOKS_DIR)).filter((one) => one.isDirectory).length
  } catch {
    return 0
  }
}

/** Write the cache. Atomic, like every other write here. */
export async function writeIndex(fs: IndexFs, books: readonly IndexedBook[]): Promise<void> {
  const writing = `${INDEX_FILE}.writing`
  const payload: StoredIndex = { version: 1, books }
  try {
    await fs.writeFile(writing, new TextEncoder().encode(JSON.stringify(payload)))
    await fs.rename(writing, INDEX_FILE)
  } catch (cause) {
    await fs.remove(writing).catch(() => {})
    throw cause
  }
}

/** Where a book's record lives — re-exported so callers need one import. */
export { recordPath }
