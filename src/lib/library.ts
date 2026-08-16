/**
 * The library — books this reader has actually opened.
 *
 * Small on purpose. This is not task #6's library screen; it is the minimum
 * that makes the book switcher tell the truth, which is the alternative to
 * listing the same four fixture books the Notes panel used to.
 *
 * The honest limit is worth stating, because it shapes the type: a book picked
 * or dropped as a File cannot be reopened later. A File is a handle to bytes
 * the page was granted access to for that session — there is no path to keep,
 * and re-deriving one would need Tauri's own file APIs and a permission the app
 * does not ask for. So an entry records a URL when it has one and null when it
 * does not, and the switcher shows the latter as present-but-not-reopenable
 * rather than pretending a click will work.
 */

export interface LibraryEntry {
  /** Matches `bookIdFor` — the same identity marks are keyed by. */
  readonly bookId: string
  readonly title: string
  readonly author: string
  /** Reopenable only when the book came from a URL. Null for a picked file. */
  readonly url: string | null
  readonly lastOpened: number
  /**
   * Where the reader left off — a CFI into this book, or null for one never
   * read past its first page.
   *
   * It lives here rather than in a store of its own because this row is already
   * the one thing that knows a book by the identity marks use, is already
   * persisted, already validated, and already goes away when the book does. A
   * second store keyed the same way would be a second answer to the same
   * question, with orphans whenever the two disagreed.
   *
   * Untrusted on the way back in. It is handed to foliate's resolver, and a
   * string that no longer names anything in the book — a re-exported EPUB, a
   * different edition under a colliding id — must fail to opening at the start
   * rather than to a reader that will not display.
   */
  readonly position: string | null
  /**
   * The WORK's identifier, as the book declares it, or null.
   *
   * Recorded here and used by nothing yet — deliberately. It is the key that
   * anything shared between two READERS has to be keyed on, because `bookId`
   * says "this exact file" and two people almost never hold the same bytes. It
   * is captured now because it cannot be recovered from storage later: getting
   * it back means re-opening every book on the shelf.
   */
  readonly workId: string | null
  /**
   * Where this book is on THIS machine, or null.
   *
   * The field that makes a shelf a shelf: a picked `File` is bytes granted for
   * one session, so before this every file-opened book was a row that said,
   * honestly, that it would not open again — and the reading position saved for
   * it had nowhere to be spent.
   *
   * DEVICE-LOCAL, and the one field here that is. It is a fact about this
   * machine rather than about the book, and later phases replicate these rows
   * between devices: a macOS path replicated onto a phone is meaningless at
   * best. Anything that syncs must strip it.
   */
  readonly path: string | null
  /**
   * What the book declared about itself, beyond title and author.
   *
   * EVERY FIELD IS OPTIONAL, and that is load-bearing rather than lazy: rows
   * written before this existed carry none of them and must keep working
   * untouched. `parseLibrary` leaves an absent field absent rather than dropping
   * the row, the same way it already treats `position` and `path`.
   *
   * All of it is bounded on the way in — see `readMeta`'s caps. A book is a file
   * a stranger wrote, and this store is read whole, parsed whole and rewritten
   * whole on every position save.
   *
   * foliate has been parsing all of it on every open since before Paper had a
   * shelf; the fields were discarded between the parse and the row. Recovering
   * them is what makes series, tags, real sorting and filtering possible at all.
   */
  readonly sortAs?: string
  readonly series?: string
  readonly seriesIndex?: number | null
  readonly subjects?: readonly string[]
  readonly publisher?: string
  readonly published?: string
  readonly languages?: readonly string[]
  readonly description?: string
}

export const LIBRARY_STORAGE_KEY = 'paper.library.v1'

/** Newest first — a switcher is a recency list, not an alphabetical one. */
export function byRecency(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) => b.lastOpened - a.lastOpened)
}

/** How a shelf can be arranged. Recency is what the switcher always used. */
export type LibraryOrder = 'recent' | 'title' | 'author'

/**
 * The shelf in a chosen order.
 *
 * Compared with `localeCompare` rather than `<`, because `<` orders by code
 * point: every accented title sorts after every unaccented one, so a shelf with
 * `Émile` on it puts that book after `Zola` in a list a reader is scanning
 * alphabetically. `numeric` so `Volume 2` precedes `Volume 10`.
 *
 * Ties fall back to recency, which is total here — two books with the same
 * title would otherwise swap places between renders.
 */
export function inOrder(
  entries: readonly LibraryEntry[],
  order: LibraryOrder,
): LibraryEntry[] {
  if (order === 'recent') return byRecency(entries)
  const key = order === 'title' ? sortTitle : displayAuthor
  return [...entries].sort(
    (a, b) =>
      key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' }) ||
      b.lastOpened - a.lastOpened,
  )
}

/**
 * Record an open, replacing any earlier entry for the same book.
 *
 * A book opened twice is one row that moves to the top, not two rows.
 *
 * The new entry wins on every field, but be precise about what that can mean:
 * it CANNOT be a file-sourced open clearing an earlier URL, which is what this
 * comment used to claim. `bookIdFor` prefixes the two kinds — `url:` for a URL
 * and `file:` for a content hash — so a file and a URL never share an id and
 * never meet here. The same book opened both ways is two rows, which is a
 * known limitation of identifying a URL by its address rather than by reading
 * it, not a case this function handles.
 */
export function recordOpen(
  entries: readonly LibraryEntry[],
  entry: LibraryEntry,
): LibraryEntry[] {
  /* One field the new entry does NOT win: the position, when it does not have
   * one. An open is recorded as soon as the metadata arrives — before the
   * reader has been anywhere — so the entry that arrives here carries a null
   * position on every single open. Taking it would erase, on opening a book,
   * the one field whose entire job is to survive that. */
  const previous = entries.find((existing) => existing.bookId === entry.bookId)
  /* Two fields a newer entry does not win when it does not have them. The
   * position, because an open is recorded before the reader has been anywhere;
   * and the path, because the same book can be opened again by a route that
   * does not carry one — a drop, or a URL — and forgetting where it lives would
   * turn a reopenable row back into a dead one. */
  const kept = {
    ...entry,
    position: entry.position ?? previous?.position ?? null,
    path: entry.path ?? previous?.path ?? null,
  }
  return [kept, ...entries.filter((existing) => existing.bookId !== entry.bookId)]
}

/**
 * Record where the reader left off in a book already on the shelf.
 *
 * Separate from `recordOpen` because it means something different: an open
 * rewrites the row and moves it to the top, and reading on inside a book is
 * neither. Nothing here touches the recency order — a book does not become the
 * most recent because a page turned in it.
 *
 * Returns the SAME array when nothing changes. This is called on a page turn,
 * and a fresh array every time would re-render the shelf and the switcher for a
 * change that did not happen.
 *
 * A position for a book with no row is dropped rather than creating one: the
 * row is written when the metadata arrives, and a row invented here would have
 * no title, no author and no url — nothing any surface can draw.
 */
export function rememberPosition(
  entries: readonly LibraryEntry[],
  bookId: string,
  position: string,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  if (at === -1) return entries
  const entry = entries[at]
  if (!entry || entry.position === position) return entries
  const next = [...entries]
  next[at] = { ...entry, position }
  return next
}

/* `forgetBook` was here, with a test and no caller. Nothing in the app can
 * remove a book from the shelf — there is no control for it — so this was a
 * capability that existed only in the test suite. */

/**
 * A stored row, or not.
 *
 * Stricter than "the fields have the right types", because this is the trust
 * boundary and the shapes that get through it are the ones the UI has to cope
 * with forever after. Two specifically:
 *
 *   - An EMPTY url is not a url. It passed as a string, so the switcher and the
 *     shelf both drew the row as reopenable — and then their own truthiness
 *     check on click did nothing, giving the reader an enabled control that
 *     silently fails. Empty means null here, which both surfaces already
 *     render honestly.
 *   - A non-finite `lastOpened` sorts unpredictably against every other row,
 *     so one bad entry scrambles a recency list that has nothing wrong with it.
 */
type StoredRow = Omit<LibraryEntry, 'position' | 'workId' | 'path'> & {
  readonly position?: unknown
  readonly workId?: unknown
  readonly path?: unknown
}

function isEntry(value: unknown): value is StoredRow {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const url = e['url']
  return (
    typeof e['bookId'] === 'string' &&
    e['bookId'] !== '' &&
    typeof e['title'] === 'string' &&
    typeof e['author'] === 'string' &&
    (url === null || (typeof url === 'string' && url !== '')) &&
    typeof e['lastOpened'] === 'number' &&
    Number.isFinite(e['lastOpened']) &&
    e['lastOpened'] >= 0
  )
}

/**
 * A stored position, or null.
 *
 * Deliberately gentler than the rule above it, which DROPS a row whose url is
 * the wrong shape. Rows written before positions existed are already in
 * readers' storage and have no such field, and a shelf that empties itself on
 * upgrade would be a far worse defect than the one this field fixes. Missing,
 * empty and wrong-typed all mean the same thing — we do not know where they
 * were — and that is what null already says.
 */
function readPosition(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Same rule, same reason: absent means "we do not know", which is null. */
function readWorkId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** And again for the path. An empty path is not a path. */
function readPath(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * How a row presents itself — shared by the shelf and the switcher.
 *
 * Both used to derive these independently: the same fallbacks, the same
 * reopenable test, the same explanatory suffix, written twice. They had not
 * drifted yet, but the switcher's SEARCH had already gone its own way — it
 * filtered on the raw fields, so a row displaying "Untitled" could not be found
 * by typing "Untitled", because the string it showed existed only in the JSX.
 */
export function displayTitle(entry: LibraryEntry): string {
  return entry.title || 'Untitled'
}

export function displayAuthor(entry: LibraryEntry): string {
  return entry.author || 'Unknown author'
}

/**
 * The title to ALPHABETISE by, which is not the title to show.
 *
 * `dc:title`'s `file-as` — or Calibre's `title_sort` — exists precisely because
 * sorting on the displayed title is wrong in every language with articles: `The
 * Hobbit` belongs under H, and a shelf that files it under T is not sorted, it
 * is ordered by a string beginning with a word nobody thinks of as part of the
 * name.
 *
 * foliate has been parsing this all along. Paper sorted on `title` because the
 * field was discarded before it reached the row, not because anyone chose to.
 *
 * Falls back to the displayed title, so a book declaring no `file-as` sorts
 * exactly as it did before — this changes the order only where the book itself
 * asked for a different one.
 */
export function sortTitle(entry: LibraryEntry): string {
  return entry.sortAs || displayTitle(entry)
}

/** Whether clicking the row can actually open the book — see the header. */
export function isReopenable(entry: LibraryEntry): boolean {
  return Boolean(entry.url) || Boolean(entry.path)
}

/** §11: say what happened and what to do, in one line. */
export const NOT_REOPENABLE = 'Opened from a file — add it again to reopen'

/**
 * The suffix a row appends to its subtitle to explain its state.
 *
 * Both surfaces showed one and each phrased it separately — the shelf said
 * "add the file again to reopen" and the switcher said the same words with a
 * different lead-in, which is two strings to keep in step for one sentence the
 * reader sees in two places.
 */
export function rowSuffix(entry: LibraryEntry, isCurrent = false): string {
  if (isCurrent) return ' · open'
  return isReopenable(entry) ? '' : ' · add the file again to reopen'
}

/** Whether a row matches a query, matching on what the reader can SEE. */
export function matchesQuery(entry: LibraryEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    displayTitle(entry).toLowerCase().includes(q) ||
    displayAuthor(entry).toLowerCase().includes(q)
  )
}

/** Same trust-boundary rule as marks: drop a bad row, keep the rest. */
export function parseLibrary(raw: string | null): LibraryEntry[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(isEntry)
    .map((row) => ({
      ...row,
      position: readPosition(row.position),
      workId: readWorkId(row.workId),
      path: readPath(row.path),
    }))
}
