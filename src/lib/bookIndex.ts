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

import { CONTENT_EXTENSIONS, type VaultFs } from './bookVault'
import { BOOKS_DIR, atomicWrite, folderOf, parseRecord, type BookRecord } from './bookFolder'

export const INDEX_FILE = 'index.json'

/** A book as the shelf needs it: its record, plus the id naming its folder. */
export interface IndexedBook extends BookRecord {
  readonly bookId: string
  /**
   * Whether the book's bytes are actually there.
   *
   * DERIVED from the folder, never written into `book.json` — a flag stored in
   * the record is one more thing that can disagree with the folder, which is
   * the failure this whole phase exists to remove. It IS carried by this cache
   * (the index would otherwise cost one listing per book per launch to
   * rebuild), and that is safe under the rule at the top of this file: the
   * cache is derived, and the folder wins. It is what lets the shelf say "this
   * one will not open", which phase 4 deleted on the premise that a book which
   * is its own folder always opens. That premise is false for a record whose
   * content was never written.
   */
  readonly hasContent?: boolean
}

/**
 * Every name a stored content file may have — derived from `bookVault`, which
 * is the module that decides what a stored book may be called. An earlier copy
 * of the list lived here, so adding a format to one and not the other made
 * every book of that format look contentless.
 */
const CONTENT_NAMES: readonly string[] = CONTENT_EXTENSIONS.map((ext) => `content.${ext}`)

/** Does this listing contain a content file? Shared by the scan and the probe. */
function listsContent(names: ReadonlySet<string>): boolean {
  return CONTENT_NAMES.some((name) => names.has(name))
}

/**
 * Does this book's folder hold a content file? ONE listing, not one probe per
 * format.
 *
 * Every filesystem call here is an IPC round-trip into the Tauri process, so
 * the unit of cost is the CALL, not the bytes. Probing `exists` per extension
 * cost up to eight round-trips to learn what one `readDir` says outright —
 * and the scan asks this question once per book on the shelf.
 *
 * NULL when the folder could not be LISTED — which is a different answer from
 * "listed, and no bytes", and collapsing the two was a real defect: a
 * transient failure to look became a measured `false`, was written into a
 * trusted cache, and disabled a book whose bytes were sitting right there.
 * A caller holding null knows nothing new and must carry what it already had.
 */
export async function hasContentFile(fs: IndexFs, bookId: string): Promise<boolean | null> {
  try {
    const entries = await fs.readDir(folderOf(bookId))
    return listsContent(new Set(entries.map((one) => one.name)))
  } catch {
    return null
  }
}

export interface IndexFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
}

interface StoredIndex {
  readonly version: 1
  readonly books: readonly IndexedBook[]
  /**
   * Every directory under `books/` when this index was built — not just the
   * ones that produced a book.
   *
   * The check below asks whether the library has CHANGED since the scan, and
   * comparing the directory listing against the cached books answers a
   * different question: a folder the scan deliberately skipped, because it has
   * no `book.json` yet, is a directory with no book. An abandoned import or a
   * half-finished one therefore disagreed forever — every launch rescanned,
   * wrote an index that still did not mention it, and disagreed again. The
   * cache stopped working entirely, quietly, for one stray folder.
   *
   * Not circular: this is what the DIRECTORY looked like, and the directory is
   * what it is being compared with. It says nothing about whether those folders
   * were readable, which is the scan's business and is checked separately.
   */
  readonly folders?: readonly string[]
}

/**
 * Read the cache, or null when it is missing, corrupt or a version we do not
 * know.
 *
 * All three are the same thing to the caller — rescan — which is why they are
 * not distinguished. A cache that cannot be read has no claim on anything.
 *
 * ONE BAD ROW COSTS THE WHOLE CACHE, deliberately — the opposite of the rule
 * the scan follows, because the failure modes are opposite. The scan's "one
 * damaged book costs that book" is right for folders: the book stays on disk
 * and every later scan sees it. Here, DROPPING a row while keeping the rest
 * produced a cache that still agreed with the directory listing — the dropped
 * book's folder was in `folders` and on disk alike — so `loadShelf` trusted a
 * cache that silently omitted a book, and the shelf hid it on every launch
 * with nothing left to notice. Refusing the whole cache turns the same
 * corruption into one rescan, which rewrites it clean.
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
    if (typeof id !== 'string' || !id) return null
    // Validated through the SAME parser the folder uses, so the cache cannot
    // hold a shape the record could not.
    const record = parseRecord(JSON.stringify(one))
    if (!record) return null
    /* THE VALIDATED ID, not the raw one. `parseRecord` bounds every field it
     * keeps, and taking `bookId` off the untrusted object afterwards put the
     * unbounded original back — for a value that names a directory. */
    if (record.bookId && record.bookId !== id) return null
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
 * How many folders a scan reads at once.
 *
 * The scan's cost is IPC round-trips, and one at a time means paying every
 * round-trip's latency in full, in a row, before the first window can draw —
 * `main.tsx` awaits this before React mounts. A handful in flight overlaps the
 * waiting without contending for anything real: the work per folder is two
 * small reads, not computation.
 */
const SCAN_WIDTH = 16

/**
 * Run `work` over every item, at most `width` in flight.
 *
 * Results keep the ITEMS' order, not completion order — the walk is concurrent,
 * what it produces is not allowed to be. `null` is "nothing came of this item",
 * so a worker can decline without a slot going missing.
 */
async function pooledMap<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R | null>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array<R | null>(items.length).fill(null)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const at = cursor
      cursor += 1
      if (at >= items.length) return
      results[at] = await work(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return results
}

/**
 * The books directory, listed under the ONE rule every walker here shares:
 * absent is an empty listing, and any other failure throws.
 *
 * NO LIBRARY YET is an empty shelf. ANY OTHER FAILURE IS NOT. Both used to be
 * `return []`, and `loadShelf` writes that answer straight back to
 * `index.json` — so one unreadable directory, from a permission prompt or a
 * volume not yet mounted, showed an empty library AND replaced the cache that
 * described the real one. The shelf then agreed with itself, and the books
 * were gone as far as anything could tell.
 *
 * This rule was copied out three times — the shelf scan, the trust check, the
 * marks scan — with the same commentary, which is three places for it to
 * drift. Now it is one.
 *
 * KNOWN LIMIT, accepted deliberately: absent is decided by asking `exists`,
 * because the alternative is inspecting an error whose shape is the plugin's
 * business — Tauri's fs errors carry no stable code to branch on. `exists`
 * itself answers false on a metadata failure, so a directory that is present
 * but unstat-able is treated as absent. That trade costs a rescan-and-empty
 * shelf in a failure mode no cheap check can tell apart; the folders remain
 * the truth, and the next healthy launch finds them.
 */
async function listBooksDir(fs: IndexFs): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return await fs.readDir(BOOKS_DIR)
  } catch (cause) {
    if (await fs.exists(BOOKS_DIR)) throw cause
    return []
  }
}

/**
 * One folder's fate under the scan, named — so the aggregation below is
 * arithmetic over answers rather than side effects threaded through a loop.
 *
 *   - `book`: a readable record, as a shelf row.
 *   - `stray`: a folder with no record yet — a half-written import. Not on the
 *     shelf, but SEEN: it belongs in the index's folder snapshot, or its mere
 *     presence would distrust the cache on every launch.
 *   - `gone`: the folder vanished between the root listing and this task —
 *     the serial walk answered by walking past, and the pooled walk must too.
 *     NOT seen: recording a folder this scan could not actually look at would
 *     let a misclassified metadata failure write an emptier shelf into a cache
 *     whose folder snapshot still matches the directory — a lie the trust
 *     check would then believe on every launch. Left out, the next launch's
 *     listing disagrees and rescans until the folder reads or truly goes.
 *   - `unreadable`: a record IS there and would not read. These are what the
 *     all-unreadable throw counts.
 */
type FolderScan =
  | { readonly kind: 'book'; readonly book: IndexedBook }
  | { readonly kind: 'stray' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }

async function scanFolder(fs: IndexFs, name: string): Promise<FolderScan> {
  try {
    const listing = await fs.readDir(`${BOOKS_DIR}/${name}`)
    const names = new Set(listing.map((one) => one.name))
    if (!names.has('book.json')) return { kind: 'stray' }
    const bytes = await fs.readFile(`${BOOKS_DIR}/${name}/book.json`)
    const record = parseRecord(new TextDecoder().decode(bytes))
    /* A record that is THERE and parses to nothing is unreadable too — which
     * is what a truncated or corrupt `book.json` actually looks like, since
     * reading the bytes succeeds and only the parse fails. Counting only the
     * throw missed the commonest shape of the thing being counted. */
    if (!record) return { kind: 'unreadable' }
    /* THE RECORD'S OWN ID — but only when it names the folder it is sitting
     * in. `safeId` is not reversible, so `book:abc` lives in `book_abc` and
     * taking the id from the directory renamed every book on any rescan.
     *
     * The check matters because a folder can be renamed while its record is
     * not: carrying a book onto a new id moves the directory atomically and
     * stamps the record afterwards, and the second step can fail on its own.
     * A record claiming an id that resolves somewhere else is describing a
     * folder that is not there, so the directory wins and the next write
     * stamps it straight. The folder name is also the fallback for a record
     * written before the id was stored at all. */
    const claimed = record.bookId
    const bookId = claimed && folderOf(claimed) === `${BOOKS_DIR}/${name}` ? claimed : name
    /* WHETHER THERE ARE BYTES, derived here rather than stored. A record with
     * no content is a folder that is not a book yet — a half-written import,
     * or a migrated row whose copy never existed — and the shelf has to be
     * able to say so. */
    return { kind: 'book', book: { ...record, bookId, hasContent: listsContent(names) } }
  } catch {
    /* GONE IS NOT UNREADABLE. A folder can be removed between the root listing
     * and this task — the serial walk's `exists` probe skipped it quietly, and
     * counting it as a failed record here could fire the all-unreadable throw
     * over a library that is merely being edited. Gone only when `exists`
     * RESOLVED false: an `exists` that itself fails proves nothing, and
     * assuming gone on it would let a catastrophic IO failure read as a clean
     * empty scan. `exists` answering false on a metadata error is the known
     * limit documented on `listBooksDir`; `gone`'s exclusion from the folder
     * snapshot is what keeps that misclassification from being TRUSTED. */
    const gone = await fs.exists(`${BOOKS_DIR}/${name}`).then((there) => !there, () => false)
    return gone ? { kind: 'gone' } : { kind: 'unreadable' }
  }
}

/**
 * Rebuild by reading every book's record.
 *
 * A folder whose `book.json` is missing or unreadable is SKIPPED rather than
 * failing the scan: one damaged book should cost that book, not the library. It
 * also means a half-written import — a folder with content but no record yet —
 * is simply not on the shelf until it is finished, which is the correct
 * behaviour rather than a special case.
 *
 * TWO ROUND-TRIPS PER BOOK, a few folders at a time — see `SCAN_WIDTH`. This
 * walk used to be strictly serial and probed each folder up to ten times —
 * `exists` for the record, a read, then `exists` once per known format for the
 * bytes — which put thousands of back-to-back IPC waits between launching the
 * app and the first paint of a library big enough to matter. One listing per
 * folder answers both questions the probes asked.
 *
 * Returns the folder names it walked beside the books, because the caller
 * writing an index needs BOTH from the same snapshot — a second listing taken
 * after the scan can disagree with the scan, and an index written from two
 * snapshots is trusted as if it were one.
 */
async function scanShelf(fs: IndexFs): Promise<{ books: IndexedBook[]; folders: string[] }> {
  const entries = await listBooksDir(fs)
  const walked = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
  const outcomes = await pooledMap(walked, SCAN_WIDTH, (name) => scanFolder(fs, name))
  const books = outcomes.flatMap((one) => (one?.kind === 'book' ? [one.book] : []))
  /* ONLY WHAT THE SCAN COULD LOOK AT. A `gone` folder is left out of the
   * snapshot — see `FolderScan` — so a folder this scan failed to see keeps
   * the cache distrusted rather than agreeing its books away. */
  const folders = walked.filter((_name, at) => outcomes[at]?.kind !== 'gone')
  /* Folders whose record IS THERE and would not read — as distinct from one
   * that simply has no record yet, which is a half-written import and is
   * correctly skipped. */
  const unreadable = outcomes.filter((one) => one?.kind === 'unreadable').length
  /* EVERY RECORD UNREADABLE IS NOT AN EMPTY LIBRARY. One damaged book costs
   * that book — the rule `scanFolder` is written around, and the right one.
   * But a whole library that will not read is the state where the shelf says
   * "Your library is empty" over books that are all still on disk, which is the
   * one thing this app must never say wrongly. If ANY book loaded, the failure
   * is per-book and the shelf is honest; if none did and records were there to
   * read, the caller is told rather than shown an empty shelf. */
  if (books.length === 0 && unreadable > 0) {
    throw new Error(`the library could not be read: ${unreadable} records failed`)
  }
  return { books, folders }
}

export async function scanBooks(fs: IndexFs): Promise<IndexedBook[]> {
  return (await scanShelf(fs)).books
}

/**
 * Load the shelf: the cache when it is usable, a scan when it is not.
 *
 * A present cache is believed only when it still describes the directory. The
 * cache can be STALE rather than wrong — a crash between writing a record and
 * writing the index leaves it one book behind — and the cheap check is whether
 * the folder listing matches what the index saw. A mismatch rescans.
 *
 * That check is deliberately weak: it catches a book added or removed outside
 * the app, which is the case worth catching, and it does not try to detect an
 * edited record — or bytes appearing or vanishing inside an unchanged folder
 * set, which would cost one listing per book per launch to notice and is
 * exactly the cost this cache exists to remove. A reader who edits a book
 * folder by hand can delete the index.
 */
export async function loadShelf(fs: IndexFs): Promise<{ books: IndexedBook[]; rescanned: boolean }> {
  const cached = await readIndex(fs)
  if (cached) {
    const folders = (await listBooksDir(fs))
      .filter((one) => one.isDirectory)
      .map((one) => one.name)
    /* WHAT THE DIRECTORY HELD AT SCAN TIME, when the index records it — see
     * `StoredIndex.folders`. Falling back to the cached books is what an index
     * written before that field existed can offer, and it is the old, weaker
     * answer: correct for a library where every folder is a book, and wrong
     * forever for one that has a stray folder in it. */
    const before = cached.folders ?? cached.books.map((one) => folderNameOf(one.bookId))
    const known = new Set(before)
    const agrees = folders.length === known.size && folders.every((name) => known.has(name))
    /* AND EVERY ENTRY KNOWS WHETHER IT HAS BYTES. `hasContent` is derived by the
     * scan, so an index written before it was recorded has none — and `canOpen`
     * reads an absent flag as openable, which puts a row for a book Paper cannot
     * open back on the shelf looking fine. Distrusting such a cache costs one
     * rescan, once, and the index it writes has the flag. */
    const complete = cached.books.every((one) => typeof one.hasContent === 'boolean')
    if (agrees && complete) return { books: [...cached.books], rescanned: false }
  }
  /* ONE SNAPSHOT for both halves of the write: the scan returns the listing it
   * actually walked. A second listing taken here used to race the scan — a
   * folder appearing between the two produced an index whose `folders` and
   * whose books disagreed about the same instant, and the next launch trusted
   * the disagreement. */
  const { books, folders } = await scanShelf(fs)
  await writeIndex(fs, books, folders).catch(() => {})
  return { books, rescanned: true }
}

async function readIndex(
  fs: IndexFs,
): Promise<{ books: readonly IndexedBook[]; folders?: readonly string[] } | null> {
  try {
    const raw = new TextDecoder().decode(await fs.readFile(INDEX_FILE))
    const books = parseIndex(raw)
    if (!books) return null
    const shape = JSON.parse(raw) as Partial<StoredIndex>
    const folders = Array.isArray(shape.folders)
      ? shape.folders.filter((one): one is string => typeof one === 'string')
      : undefined
    return { books, ...(folders ? { folders } : {}) }
  } catch {
    return null
  }
}

/** A book's folder as the bare name `StoredIndex.folders` lists — no `books/`. */
function folderNameOf(bookId: string): string {
  return folderOf(bookId).slice(BOOKS_DIR.length + 1)
}

/** Write the cache. Atomic, like every other write here. */
/**
 * Throw the cached shelf away, so the next launch rebuilds it from the folders.
 *
 * `loadShelf` trusts `index.json` whenever the directory listing still agrees
 * with it — which is the whole point of the cache, and is only sound while the
 * index is not behind the records it summarises. `book.json` is explicitly
 * allowed to be newer (see `readBook`), so a run where a write failed after the
 * record landed but before the index was rewritten leaves a cache that AGREES
 * about folders and is wrong about contents, and nothing later would notice: a
 * tag added just before the failure would come back missing on the next launch
 * and stay missing.
 *
 * Deleting it costs one rescan and cannot be wrong. Failing to delete it costs
 * a reader their work, silently, with the shelf looking perfectly healthy.
 *
 * Best effort by design. This runs on the failure path, where the disk is
 * already refusing writes — an invalidation that threw would replace a bad
 * cache with an unhandled rejection.
 */
export async function invalidateIndex(fs: IndexFs): Promise<void> {
  await fs.remove(INDEX_FILE).catch(() => {})
}

export async function writeIndex(
  fs: IndexFs,
  books: readonly IndexedBook[],
  folders?: readonly string[],
): Promise<void> {
  /* The DIRECTORY listing this describes — see `StoredIndex.folders`. A write
   * that follows an ordinary mutation has not walked the directory: it knows
   * the books it is saving and nothing about stray folders, and asserting the
   * library is exactly its own books is what made one abandoned folder rescan
   * forever.
   *
   * So the STRAYS ARE CARRIED FORWARD from the index being replaced, and the
   * book folders are rebuilt from the books being written. "Leaves the field
   * alone" was this comment's old promise and the code broke it — the whole
   * file is rewritten, so omitting the field DELETED it, and one tag written
   * in a library with one stray folder put every launch after back on the
   * full-scan path this cache exists to prevent. An index that never recorded
   * folders offers nothing to carry, and the field stays absent as before. */
  let kept = folders
  if (!kept) {
    const previous = await readIndex(fs).catch(() => null)
    if (previous?.folders) {
      const owned = new Set(previous.books.map((one) => folderNameOf(one.bookId)))
      const strays = previous.folders.filter((name) => !owned.has(name))
      kept = [...new Set([...strays, ...books.map((one) => folderNameOf(one.bookId))])]
    }
  }
  const payload: StoredIndex = { version: 1, books, ...(kept ? { folders: kept } : {}) }
  await atomicWrite(fs, INDEX_FILE, new TextEncoder().encode(JSON.stringify(payload)))
}


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
  /* ABSENT AND UNREADABLE, distinguished — `listBooksDir` is that rule, held
   * in common with the shelf scan and the trust check. Resolving with `[]` for
   * both used to mean this function could not fail, so the caller's `.catch`
   * was unreachable: a read failure arrived as a successful scan of nothing,
   * which marked the cross-book list as loaded and emptied the Notes pane. */
  const entries = await listBooksDir(fs)
  /* The same pooled walk the shelf scan uses, for the same reason: one read
   * per book, serial, is a wall of back-to-back IPC waits in front of the one
   * pane that asked. Order is the ITEMS' order either way — see `pooledMap` —
   * so the pane draws the same list a serial walk produced. */
  const marks = await pooledMap(
    entries.filter((entry) => entry.isDirectory),
    SCAN_WIDTH,
    async (entry) => {
      try {
        const bytes = await fs.readFile(`${BOOKS_DIR}/${entry.name}/marks.json`)
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
        return Array.isArray(parsed) ? parsed : null
      } catch {
        return null
      }
    },
  )
  return marks.flatMap((one) => one ?? [])
}
