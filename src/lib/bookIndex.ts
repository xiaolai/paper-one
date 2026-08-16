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
import { BOOKS_DIR, folderOf, parseRecord, recordPath, type BookRecord } from './bookFolder'

export const INDEX_FILE = 'index.json'

/** A book as the shelf needs it: its record, plus the id naming its folder. */
export interface IndexedBook extends BookRecord {
  readonly bookId: string
  /**
   * Whether the book's bytes are actually there.
   *
   * DERIVED on scan, never stored — a stored flag is one more thing that can
   * disagree with the folder, which is the failure this whole phase exists to
   * remove. It is what lets the shelf say "this one will not open", which phase
   * 4 deleted on the premise that a book which is its own folder always opens.
   * That premise is false for a record whose content was never written.
   */
  readonly hasContent?: boolean
}

/** Does this folder hold a content file? One `exists` per known extension. */
async function hasContentFile(fs: IndexFs, folder: string): Promise<boolean> {
  for (const ext of ['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz', 'bin']) {
    if (await fs.exists(`${BOOKS_DIR}/${folder}/content.${ext}`)) return true
  }
  return false
}

export interface IndexFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
}

interface StoredIndex {
  readonly version: 1
  readonly books: readonly IndexedBook[]
  /**
   * The folder names this index was built from.
   *
   * A COUNT was not enough, and the gap is not exotic: a book added and another
   * removed between two launches leaves the count identical, so a stale index
   * describing neither was trusted. Comparing the SET catches that, and it costs
   * the directory listing that was already being read to count.
   *
   * It still does not catch a `book.json` edited without the index being
   * rewritten, which happens only on a crash between the two — and that is why
   * `updateBook` applies changes to the record ON DISK rather than to whatever
   * the index handed the caller. A stale index can then be out of date; it
   * cannot cause a stale write.
   */
  readonly folders?: readonly string[]
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
    if (!record) continue
    /* `hasContent` CARRIED THROUGH. It is derived by the scan and is not part of
     * a record, so rebuilding a cached entry through `parseRecord` dropped it —
     * and `canOpen` reads `!== false`, so every dead row came back enabled on
     * the next cache-backed launch. The fix that disabled them worked exactly
     * once, on the launch that scanned. */
    const flag = (one as { hasContent?: unknown }).hasContent
    books.push({
      ...record,
      bookId: id,
      ...(typeof flag === 'boolean' ? { hasContent: flag } : {}),
    })
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
      if (!record) continue
      /* THE RECORD'S OWN ID, not the directory name. `safeId` is not reversible
       * — `book:abc` is stored in `book_abc` — so taking the id from the folder
       * renamed every book on any rescan, and marks are keyed by it. The folder
       * name is the fallback for records written before the id was stored, which
       * is the same wrong answer as before and no worse. */
      const bookId = record.bookId || entry.name
      /* WHETHER THERE ARE BYTES, derived here rather than stored. A record with
       * no content is a folder that is not a book yet — a half-written import,
       * or a migrated row whose copy never existed — and the shelf has to be
       * able to say so. `scanBooks` already skips a folder with no record for
       * exactly this reasoning; this is the same rule applied to the other half. */
      const hasContent = await hasContentFile(fs, entry.name)
      books.push({ ...record, bookId, hasContent })
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
    const folders = await folderNames(fs)
    const known = new Set(cached.books.map((one) => folderOf(one.bookId).slice(BOOKS_DIR.length + 1)))
    const agrees = folders.length === known.size && folders.every((name) => known.has(name))
    if (agrees) return { books: [...cached.books], rescanned: false }
  }
  const books = await scanBooks(fs)
  await writeIndex(fs, books).catch(() => {})
  return { books, rescanned: true }
}

async function readIndex(
  fs: IndexFs,
): Promise<{ books: readonly IndexedBook[]; folders?: readonly string[] } | null> {
  try {
    const raw = new TextDecoder().decode(await fs.readFile(INDEX_FILE))
    const books = parseIndex(raw)
    return books ? { books } : null
  } catch {
    return null
  }
}

async function folderNames(fs: IndexFs): Promise<string[]> {
  try {
    return (await fs.readDir(BOOKS_DIR)).filter((one) => one.isDirectory).map((one) => one.name)
  } catch {
    return []
  }
}

/** Write the cache. Atomic, like every other write here. */
export async function writeIndex(fs: IndexFs, books: readonly IndexedBook[]): Promise<void> {
  const writing = `${INDEX_FILE}.writing`
  const payload: StoredIndex = {
    version: 1,
    books,
    folders: books.map((one) => folderOf(one.bookId).slice(BOOKS_DIR.length + 1)),
  }
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


/**
 * Every book's marks, for the one view that needs them all.
 *
 * `pane/Notes.tsx` shows the open book's marks first and every other book's
 * after, deliberately — and marks living in book folders means answering that
 * costs one read per book. So it is paid ONLY when the Notes pane is mounted,
 * which is the moment somebody asked for cross-book notes, rather than at boot
 * where nobody did.
 *
 * A book whose marks will not read contributes none rather than failing the
 * scan: one damaged book should cost that book's notes, not the pane.
 *
 * This is the shape a SQLite index would eventually replace — and replacing it
 * would change nothing above, because the folders stay the truth either way.
 */
export async function scanAllMarks(fs: IndexFs): Promise<unknown[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await fs.readDir(BOOKS_DIR)
  } catch {
    return []
  }
  const all: unknown[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    try {
      const bytes = await fs.readFile(`${BOOKS_DIR}/${entry.name}/marks.json`)
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (Array.isArray(parsed)) all.push(...parsed)
    } catch {
      continue
    }
  }
  return all
}
