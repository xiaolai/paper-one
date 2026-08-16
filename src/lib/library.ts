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
  /**
   * Where PAPER'S OWN copy of this book lives, relative to the app data
   * directory — or absent for a row shelved before the vault existed.
   *
   * Distinct from `path`, which points at the reader's file wherever they keep
   * it. This one is inside `$APPDATA`, which is in scope permanently, so
   * reopening from it does not depend on a dialog grant having been restored
   * across a relaunch — the thing phase 2 could never verify.
   *
   * Recorded only AFTER the copy lands. A row claiming a copy that is not there
   * would send `openStored` down a path that fails before it falls back, and a
   * shelf that overstates what it holds is the failure this project keeps
   * choosing not to ship.
   */
  readonly vault?: string | null
  /**
   * The book's own jacket, filed under `$APPDATA/covers/` — or absent.
   *
   * Absent means "no artwork", which is most PDFs and a fair number of EPUBs,
   * and the shelf falls back to the derived tint it drew for everything before
   * covers existed. A FILENAME rather than the image, because this row is
   * rewritten on every position save and a base64 jacket would be paid for on
   * every page turn.
   */
  readonly cover?: string | null
  /**
   * The READER's own tags, distinct from `subjects`.
   *
   * Two fields rather than one merged list, and the separation is load-bearing:
   * `subjects` come out of the book and are replaced wholesale every time it is
   * re-opened, so a reader's tag folded in there would be silently erased by
   * re-reading the book it was attached to. These are only ever written by a
   * person and never by a parse.
   *
   * They are searched and counted TOGETHER — see `allTags` — because the
   * distinction is about provenance and lifetime, not about what a reader is
   * looking for.
   */
  readonly tags?: readonly string[]
  /**
   * How far through, 0–1, recorded when the position was.
   *
   * Stored rather than computed, and that is the whole reason it exists as a
   * field: `position` is a CFI, and turning a CFI into a percentage means
   * resolving it against the book, which means OPENING the book. A shelf cannot
   * open forty books to draw forty progress bars. foliate publishes this on
   * every relocate, so it costs one number on a write that was happening anyway.
   */
  readonly progress?: number
  /**
   * The reader says they are done, whatever the fraction says.
   *
   * Separate from `progress` because finishing is a judgement and a fraction is
   * a measurement: a book read to 94% with the endnotes skipped is finished, and
   * one sitting at 100% because the reader jumped to the index is not.
   */
  readonly finished?: boolean
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
  progress?: number,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  if (at === -1) return entries
  const entry = entries[at]
  const next7 = clampProgress(progress) ?? entry?.progress
  if (!entry || (entry.position === position && entry.progress === next7)) return entries
  const next = [...entries]
  next[at] = { ...entry, position, ...(next7 === undefined ? {} : { progress: next7 }) }
  return next
}

/** 0–1, or undefined. A fraction outside that says the renderer is confused. */
function clampProgress(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** Mark a book read, or unread. The reader's judgement, not a measurement. */
export function markFinished(
  entries: readonly LibraryEntry[],
  bookId: string,
  finished: boolean,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  const entry = at === -1 ? null : entries[at]
  if (!entry || (entry.finished ?? false) === finished) return entries
  const next = [...entries]
  next[at] = { ...entry, finished }
  return next
}

export type ReadingStatus = 'unread' | 'reading' | 'finished'

/**
 * Where a book stands, in one word.
 *
 * Derived rather than stored, except for the one part that cannot be: `finished`
 * is a judgement the reader makes and nothing about a position can infer it. The
 * rest falls out — a book with no recorded position has not been started, and a
 * book with one has.
 */
export function statusOf(entry: LibraryEntry): ReadingStatus {
  if (entry.finished) return 'finished'
  return entry.position ? 'reading' : 'unread'
}

/**
 * Record that Paper now holds its own copy of a book.
 *
 * Separate from `recordOpen` for the reason `rememberPosition` is: an open
 * rewrites the row and moves it to the top, and a copy landing is neither. It
 * happens moments after the open, asynchronously, and must not disturb the
 * order the reader is looking at.
 *
 * Returns its input BY IDENTITY when nothing moves, so a caller can skip a
 * write without comparing rows itself.
 */
export function rememberCover(
  entries: readonly LibraryEntry[],
  bookId: string,
  cover: string,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  if (at === -1) return entries
  const entry = entries[at]
  if (!entry || entry.cover === cover) return entries
  const next = [...entries]
  next[at] = { ...entry, cover }
  return next
}

export function rememberVault(
  entries: readonly LibraryEntry[],
  bookId: string,
  vault: string,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  if (at === -1) return entries
  const entry = entries[at]
  if (!entry || entry.vault === vault) return entries
  const next = [...entries]
  next[at] = { ...entry, vault }
  return next
}

/**
 * Take a book off the shelf.
 *
 * `forgetBook` was here once, with a test and no caller, and was deleted for
 * being a capability that existed only in the test suite. It comes back with the
 * control that makes it real — and with a promise it can now actually keep.
 *
 * WHAT IT DOES NOT DO IS DELETE THE READER'S FILE. Before the vault there were
 * not two files to distinguish, so "remove" was ambiguous in a way no wording
 * could fix: the only file was the reader's own, sitting wherever they keep
 * their books, and an app that did not put it there has no business deleting it.
 * Now Paper has its own copy, that copy is what goes, and the original is
 * untouched. The caller disposes of the copy — see `disownBook`.
 *
 * MARKS AND POSITION DELIBERATELY SURVIVE. They are keyed by `bookId`, which is
 * derived from the bytes, so adding the same book again finds its highlights
 * waiting. That is what content-derived identity was built for and this is the
 * first place a reader can see it pay off. It also means removing a book is not
 * a destructive act, which is what makes it safe to offer without a trash.
 */
export function forgetBook(
  entries: readonly LibraryEntry[],
  bookId: string,
): readonly LibraryEntry[] {
  const next = entries.filter((entry) => entry.bookId !== bookId)
  // By identity when nothing matched, so a caller can skip the write.
  return next.length === entries.length ? entries : next
}

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
  /* Matched on what the row DISPLAYS first, so what a reader sees is what they
   * can search for. The rest are fields the shelf shows or groups by, added
   * once WI-3.1 stopped discarding them — searching for a series or a publisher
   * and finding nothing, when the shelf is visibly grouped by exactly that, is
   * the kind of gap that reads as the search being broken. */
  return (
    displayTitle(entry).toLowerCase().includes(q) ||
    displayAuthor(entry).toLowerCase().includes(q) ||
    (entry.series?.toLowerCase().includes(q) ?? false) ||
    (entry.publisher?.toLowerCase().includes(q) ?? false) ||
    allTags(entry).some((tag) => tag.toLowerCase().includes(q))
  )
}

/**
 * A restriction on which books are in play at all — see Decision 2.
 *
 * A COLLECTION IS A SCOPE, not a saved query, and this is the shape of that:
 * one predicate applied before anything else, so the shelf, the search, the
 * counts and the sort all operate inside the same restricted set rather than
 * each deciding separately. Calibre's manual draws exactly this distinction —
 * a search restricts the list, a virtual library restricts the list AND what
 * you can then filter by.
 *
 * `null` is the whole library. It exists ahead of the collections that will
 * produce these, deliberately: a matcher retrofitted for scope later is a
 * rewrite of every caller, and every caller is already being written now.
 */
export interface Scope {
  readonly label: string
  /** Which books are inside. A tag the book carries, or a series it is in. */
  readonly tag?: string
  readonly series?: string
}

export function inScope(entry: LibraryEntry, scope: Scope | null): boolean {
  if (!scope) return true
  if (scope.series) return entry.series === scope.series
  if (scope.tag) return allTags(entry).includes(scope.tag)
  return true
}

/**
 * Every tag on a book, whoever put it there.
 *
 * The publisher's `subjects` and the reader's own `tags`, deduplicated. They are
 * stored apart because they have different lifetimes — subjects are replaced by
 * a re-parse and a reader's tag must survive one — but nothing downstream cares
 * which is which, so everything downstream sees one list.
 */
export function allTags(entry: LibraryEntry): readonly string[] {
  const own = entry.tags ?? []
  const declared = entry.subjects ?? []
  if (own.length === 0) return declared
  return [...own, ...declared.filter((tag) => !own.includes(tag))]
}

/**
 * Add a reader's tag to a book.
 *
 * Normalised on the way in — trimmed, capped, and refused when it duplicates a
 * tag the book already carries under any provenance. Returned by identity when
 * nothing changes, like every other writer here.
 */
export function tagBook(
  entries: readonly LibraryEntry[],
  bookId: string,
  raw: string,
): readonly LibraryEntry[] {
  const tag = raw.trim().slice(0, 60)
  if (!tag) return entries
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  const entry = at === -1 ? null : entries[at]
  if (!entry || allTags(entry).includes(tag)) return entries
  const next = [...entries]
  next[at] = { ...entry, tags: [...(entry.tags ?? []), tag] }
  return next
}

/** Take a reader's tag off a book. A publisher's subject cannot be removed. */
export function untagBook(
  entries: readonly LibraryEntry[],
  bookId: string,
  tag: string,
): readonly LibraryEntry[] {
  const at = entries.findIndex((entry) => entry.bookId === bookId)
  const entry = at === -1 ? null : entries[at]
  if (!entry || !(entry.tags ?? []).includes(tag)) return entries
  const next = [...entries]
  next[at] = { ...entry, tags: (entry.tags ?? []).filter((one) => one !== tag) }
  return next
}

/**
 * The shelf a reader is actually looking at: scoped, matched, then ordered.
 *
 * One function because the ORDER of those three matters and getting it wrong is
 * silent. Scope before query means a search inside a collection stays inside it;
 * ordering last means the sort sees only what survived, so "first alphabetically"
 * means first among what is shown rather than first in the library.
 */
export function shelfView(
  entries: readonly LibraryEntry[],
  { scope = null, query = '', order = 'recent' }: {
    scope?: Scope | null
    query?: string
    order?: LibraryOrder
  } = {},
): LibraryEntry[] {
  return inOrder(
    entries.filter((entry) => inScope(entry, scope) && matchesQuery(entry, query)),
    order,
  )
}

/**
 * Every tag on the shelf with how many books carry it, most-used first.
 *
 * Derived rather than stored, and counted WITHIN the scope it is given, so the
 * numbers describe what the reader can actually reach. The chips this replaces
 * were `['All', '2,418']` — a prototype constant that would have been shown to
 * a reader with four books.
 */
export function tagCounts(
  entries: readonly LibraryEntry[],
  scope: Scope | null = null,
): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!inScope(entry, scope)) continue
    for (const tag of allTags(entry)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    // Count first, then name, so the order is stable rather than depending on
    // insertion — two tags with the same count would otherwise swap on a redraw.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
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
