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
}

export const LIBRARY_STORAGE_KEY = 'paper.library.v1'

/** Newest first — a switcher is a recency list, not an alphabetical one. */
export function byRecency(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) => b.lastOpened - a.lastOpened)
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
  return [entry, ...entries.filter((existing) => existing.bookId !== entry.bookId)]
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
function isEntry(value: unknown): value is LibraryEntry {
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

/** Whether clicking the row can actually open the book — see the header. */
export function isReopenable(entry: LibraryEntry): boolean {
  return entry.url !== null && entry.url !== ''
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
  return parsed.filter(isEntry)
}
