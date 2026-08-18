/**
 * The shelf: ordering, searching and tag identity.
 *
 * PRESENTATION ONLY. Every function here takes books and returns books, or takes
 * a tag and returns its identity. Nothing reads or writes anything — a book is a
 * folder, `bookFolder` owns its file, and `useLibrary` owns the verbs.
 *
 * This file was 838 lines and 31 exports. Most of that was the cost of a flat
 * store: nine mutators for one entity, and a parser with six field validators.
 *
 * ONE DELETION WAS WRONG AND IS BACK. `isReopenable` went on the reasoning that
 * a book which is its own folder is always openable — true for a book Paper
 * wrote, false for a record whose content was never there, which is exactly what
 * migrating a phase-3 library produces. It returns as `canOpen`, DERIVED from
 * the scan rather than stored, so unlike the field it replaces it cannot
 * disagree with the disk.
 */

import type { IndexedBook } from './bookIndex'
import { parseQuery } from './searchQuery'
import { tagKey } from './tags'

/* `tagKey`, `TAG_MAX` and `normalizeTag` live in `tags.ts` now — see the note
 * there — and are re-exported here so nothing that reached them through this
 * module has to move. */
export { TAG_MAX, normalizeTag, tagKey } from './tags'

/** How a shelf can be arranged. Presentation, not a domain verb. */
export type LibraryOrder = 'recent' | 'title' | 'author' | 'progress'

/** Newest first. A switcher is a recency list, not an alphabetical one. */
export function byRecency(books: readonly IndexedBook[]): IndexedBook[] {
  return [...books].sort((a, b) => (b.openedAt ?? b.addedAt ?? 0) - (a.openedAt ?? a.addedAt ?? 0))
}

export function displayTitle(book: IndexedBook): string {
  return book.title || 'Untitled'
}

export function displayAuthor(book: IndexedBook): string {
  return book.author || 'Unknown author'
}

/**
 * The title to ALPHABETISE by, which is not the title to show.
 *
 * `dc:title`'s `file-as` — or Calibre's `title_sort` — exists because sorting on
 * the displayed title is wrong in every language with articles: `The Hobbit`
 * belongs under H. foliate parses it; Paper discarded it until phase 3.
 *
 * Falls back to the displayed title, so a book declaring no `file-as` sorts
 * exactly as it did — this changes the order only where the book asked it to.
 */
export function sortTitle(book: IndexedBook): string {
  return book.sortAs || displayTitle(book)
}

/**
 * The shelf in a chosen order.
 *
 * `localeCompare` rather than `<`, which orders by code point and puts every
 * accented title after every unaccented one — `Émile` after `Zola` in a list
 * somebody is scanning alphabetically. `numeric` so `Volume 2` precedes
 * `Volume 10`. Ties fall back to recency, which is total, or two books with the
 * same title swap places between renders.
 */
export function inOrder(books: readonly IndexedBook[], order: LibraryOrder): IndexedBook[] {
  if (order === 'recent') return byRecency(books)
  /* HOW FAR IN, most-read first — the order that answers "what am I in the
   * middle of", which on a shelf of two thousand mostly-unopened books is the
   * question a reader has. Finished counts as one, so a book that is done sorts
   * with the fullest rather than falling in with the untouched: `finished` is
   * set by hand and does not move `progress`, so the two disagree constantly
   * and only one of them is what the reader meant.
   *
   * Recency breaks the tie, which matters here more than in the other orders:
   * an unread shelf is thousands of books all at exactly zero. */
  if (order === 'progress') {
    const far = (book: IndexedBook) => (book.finished ? 1 : (book.progress ?? 0))
    return [...books].sort(
      (a, b) =>
        far(b) - far(a) ||
        (b.openedAt ?? b.addedAt ?? 0) - (a.openedAt ?? a.addedAt ?? 0) ||
        a.bookId.localeCompare(b.bookId),
    )
  }
  const key = order === 'title' ? sortTitle : displayAuthor
  return [...books].sort(
    (a, b) =>
      key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' }) ||
      (b.openedAt ?? 0) - (a.openedAt ?? 0) ||
      /* THE ID LAST, so the order is genuinely total. Recency was called the
       * tie-break that made it so, and it is not one: two books with the same
       * title and no `openedAt` — which every freshly imported folder produces —
       * compared equal, so their order came from whatever order the input
       * happened to be in and could change between renders. */
      a.bookId.localeCompare(b.bookId),
  )
}


/**
 * Every tag on a book, whoever put it there.
 *
 * The publisher's `subjects` and the reader's own `tags`, deduplicated by key.
 * They are stored apart because they have different lifetimes — subjects are
 * replaced by a re-parse and a reader's tag must survive one — but nothing
 * downstream cares which is which.
 */
export function allTags(book: IndexedBook): readonly string[] {
  /* ONE PASS OVER BOTH LISTS, folding as it goes. The earlier version folded the
   * declared subjects against the reader's tags and not against EACH OTHER — and
   * returned them untouched when the reader had added none. A book whose
   * publisher listed `Fiction` and `fiction` therefore drew two chips, which is
   * the exact duplicate the fold exists to prevent, in the one place it was not
   * applied. */
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of [...(book.tags ?? []), ...(book.subjects ?? [])]) {
    const key = tagKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** Whether a book matches free text, on the fields the shelf shows or groups by. */
export function matchesQuery(book: IndexedBook, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    displayTitle(book).toLowerCase().includes(q) ||
    displayAuthor(book).toLowerCase().includes(q) ||
    (book.series?.toLowerCase().includes(q) ?? false) ||
    (book.publisher?.toLowerCase().includes(q) ?? false) ||
    allTags(book).some((tag) => tag.toLowerCase().includes(q))
  )
}

/**
 * A restriction on which books are in play: every tag, not any; and at most
 * one reading status, since a book has only one.
 *
 * Two axes, because a shelf is organised two ways at once — by what a book is
 * ABOUT (tags) and by where the reader IS with it (status) — and the Library
 * panel offers both. They compose: `is:reading tag:Sea` is the nautical books
 * in flight.
 */
export interface Scope {
  readonly tags: readonly string[]
  readonly status?: ReadingStatus | null
}

export function inScope(book: IndexedBook, scope: Scope | null): boolean {
  if (!scope) return true
  if (scope.status && statusOf(book) !== scope.status) return false
  if (scope.tags.length === 0) return true
  /* EVERY tag: adding a second one narrows. `tag:Sea tag:Classics` meaning
   * "nautical or classical" would grow the shelf as the reader typed more,
   * which is the opposite of what typing more means anywhere else. */
  const has = new Set(allTags(book).map(tagKey))
  return scope.tags.every((tag) => has.has(tagKey(tag)))
}

/**
 * Scope, then text, then order — and the sequence is the part that is silent
 * when wrong. Scope first keeps a search inside its tags; ordering last means
 * "first alphabetically" is first among what is SHOWN.
 */
export function shelfView(
  books: readonly IndexedBook[],
  { scope = null, query = '', order = 'recent' }: {
    scope?: Scope | null
    query?: string
    order?: LibraryOrder
  } = {},
): IndexedBook[] {
  return inOrder(
    books.filter((book) => inScope(book, scope) && matchesQuery(book, query)),
    order,
  )
}

/**
 * The shelf for one typed query — scope and text come from the same string.
 *
 * The whole point of the `tag:` syntax: there is no scope state beside the field
 * that could disagree with it. What the reader sees IS what is applied.
 */
export function shelfFor(
  books: readonly IndexedBook[],
  raw: string,
  order: LibraryOrder = 'recent',
): { books: IndexedBook[]; tags: readonly string[]; status: ReadingStatus | null } {
  const { tags, status, text } = parseQuery(raw, tagKey)
  return { books: shelfView(books, { scope: { tags, status }, query: text, order }), tags, status }
}

/**
 * How many books stand at each reading status — the numbers the Library
 * panel puts beside its rows.
 *
 * Counted over the WHOLE shelf, not the scoped one, deliberately. The count is
 * a fact about the collection — three in flight, two never opened — and it
 * should read the same whichever row is currently on; a count that shrank to
 * match the current filter would tell the reader only what they can already
 * see. `tagCounts` is scoped for the opposite reason: a tag's number under a
 * status filter answers "how many of THESE are tagged so", which is the
 * question a reader narrowing further is asking.
 */
export function statusCounts(
  books: readonly IndexedBook[],
): Record<ReadingStatus, number> & { readonly all: number } {
  const counts = { all: books.length, unread: 0, reading: 0, finished: 0 }
  for (const book of books) counts[statusOf(book)] += 1
  return counts
}

/**
 * Every tag on the shelf with how many books carry it, most used first.
 *
 * Counted by KEY and shown by SPELLING — the first encountered on a stable walk,
 * so the label does not change between redraws. Ties break by name, or two
 * equally used tags swap places on every render. Derived by scanning; there is
 * no tag store.
 */
export function tagCounts(
  books: readonly IndexedBook[],
  scope: Scope | null = null,
): { tag: string; count: number; mine: boolean }[] {
  /* `mine`: whether ANY book carries this as the reader's own tag, as opposed
   * to only as a publisher's subject. It is what decides whether the Library
   * panel offers to rename or remove the tag — a subject is a fact about the
   * book, comes back on re-parse, and is not the reader's to edit; a tag that
   * is both (the reader wrote `Fiction` on a book whose publisher says
   * `fiction`) IS editable, because the reader's copy is real. */
  const counts = new Map<string, { tag: string; count: number; mine: boolean }>()
  for (const book of books) {
    if (!inScope(book, scope)) continue
    const own = new Set((book.tags ?? []).map(tagKey))
    /* No per-book deduplication here: `allTags` already folds a reader's `Sea`
     * and a publisher's `sea` into one before returning, so a second `seen` set
     * was a branch that could not be taken. It was written when `allTags`
     * returned the two lists unfolded. */
    for (const tag of allTags(book)) {
      const key = tagKey(tag)
      const already = counts.get(key)
      if (already) {
        already.count += 1
        if (own.has(key)) already.mine = true
      } else counts.set(key, { tag, count: 1, mine: own.has(key) })
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/**
 * Whether clicking this row can actually open the book.
 *
 * THIS CONCEPT WAS DELETED IN WI-4.7 AND SHOULD NOT HAVE BEEN. The reasoning
 * was that a book which is its own folder is always openable — true for a book
 * Paper wrote, and false for a record whose content was never there. A phase-3
 * library migrated into folders produced exactly that: rows for books whose
 * bytes were never stored, on a shelf with nothing able to say so.
 *
 * It is DERIVED now rather than a stored field, which is the difference from the
 * `isReopenable` that existed before: `hasContent` comes off the scan, and
 * `origin` is the reader's own file, so nothing here can disagree with the disk.
 */
export function canOpen(book: IndexedBook): boolean {
  return book.hasContent !== false || Boolean(book.origin)
}

/** §11: say what happened and what to do, in one line. */
export const CANNOT_OPEN = 'Paper has no copy of this one — add the file again'

export type ReadingStatus = 'unread' | 'reading' | 'finished'

/**
 * Where a book stands, in one word.
 *
 * Derived, except the part that cannot be: `finished` is a judgement and nothing
 * about a position can infer it. A book read to 94% with the endnotes skipped is
 * finished; one at 100% because the reader jumped to the index is not.
 */
export function statusOf(book: IndexedBook): ReadingStatus {
  if (book.finished) return 'finished'
  return book.position ? 'reading' : 'unread'
}
