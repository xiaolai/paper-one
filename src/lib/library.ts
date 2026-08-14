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
 * A book opened twice is one row that moves to the top, not two rows. The new
 * entry wins on every field: a File-sourced open after a URL one legitimately
 * clears the URL, because that is now how the reader has it.
 */
export function recordOpen(
  entries: readonly LibraryEntry[],
  entry: LibraryEntry,
): LibraryEntry[] {
  return [entry, ...entries.filter((existing) => existing.bookId !== entry.bookId)]
}

export function forgetBook(
  entries: readonly LibraryEntry[],
  bookId: string,
): LibraryEntry[] {
  return entries.filter((entry) => entry.bookId !== bookId)
}

function isEntry(value: unknown): value is LibraryEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e['bookId'] === 'string' &&
    typeof e['title'] === 'string' &&
    typeof e['author'] === 'string' &&
    (typeof e['url'] === 'string' || e['url'] === null) &&
    typeof e['lastOpened'] === 'number'
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
