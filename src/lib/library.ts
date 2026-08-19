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
import { parseQuery, type StatusTerm } from './searchQuery'

/** How a shelf can be arranged. Presentation, not a domain verb. */
export type LibraryOrder = 'recent' | 'title' | 'author' | 'progress'

/** When a book last mattered: opened, or failing that, added. The ONE recency
 *  reading — `inOrder`'s tie-breaks read it too, or two orders disagree about
 *  which of two books is more recent. */
const lastTouched = (book: IndexedBook): number => book.openedAt ?? book.addedAt ?? 0

/** Newest first. A switcher is a recency list, not an alphabetical one.
 *  The id last, so the order is total — a folder import stamps a whole shelf
 *  with one minute, and equal timestamps otherwise keep their input order,
 *  which can change between scans. */
export function byRecency(books: readonly IndexedBook[]): IndexedBook[] {
  return [...books].sort(
    (a, b) => lastTouched(b) - lastTouched(a) || a.bookId.localeCompare(b.bookId),
  )
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
        lastTouched(b) - lastTouched(a) ||
        a.bookId.localeCompare(b.bookId),
    )
  }
  const key = order === 'title' ? sortTitle : displayAuthor
  return [...books].sort(
    (a, b) =>
      key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' }) ||
      /* `lastTouched`, the same recency every other order reads — this read
       * `openedAt` alone, so two same-titled books never opened tied here on
       * their ids while `byRecency` ordered them by when they were added. */
      lastTouched(b) - lastTouched(a) ||
      /* THE ID LAST, so the order is genuinely total. Recency was called the
       * tie-break that made it so, and it is not one: two books with the same
       * title and no `openedAt` — which every freshly imported folder produces —
       * compared equal, so their order came from whatever order the input
       * happened to be in and could change between renders. */
      a.bookId.localeCompare(b.bookId),
  )
}

/**
 * Fold a string to the form two spellings of one word share.
 *
 *   NFC             — `Café` typed on macOS is decomposed (e + combining acute)
 *                     and the same word pasted from elsewhere is composed. They
 *                     render identically and compare unequal, which is the worst
 *                     kind of duplicate because nothing on screen can explain it.
 *   lower, UPPER, lower — case-folding, not lowercasing. `toLowerCase` alone
 *                     left `Straße` and `STRASSE` distinct, because ß only
 *                     reaches `ss` through its uppercase form. The first lower
 *                     is what brings capital ẞ along: upper-first left ẞ→ß
 *                     while SS→ss, two keys for one word — lowered first, all
 *                     three spellings meet at `ss`. The round trip is the
 *                     closest JavaScript comes to Unicode case folding without
 *                     a library; its one known deviation is Turkish dotless ı,
 *                     which merges with i — accepted, since a locale-correct
 *                     fold needs a locale nothing here has.
 *   NFC again       — case mapping can denormalise (`İ` lowers to `i` + a
 *                     combining dot), so the fold renormalises what it made.
 *
 * NFC BEFORE the case fold: case mapping can change which decompositions apply,
 * so normalising only afterwards leaves the two forms of `Café` folding apart.
 *
 * Shared by `tagKey` and `matchesQuery`, so a search matches by the same rule
 * tags deduplicate by — it lowercased without normalising, and a decomposed
 * `café` typed into the field missed the composed one in every title.
 */
const fold = (text: string): string =>
  text.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')

/**
 * The identity of a tag, as opposed to its spelling.
 *
 * `Philosophy` and `philosophy` are ONE tag: trim — a trailing space is not a
 * different subject — then `fold`.
 *
 * The DISPLAY spelling is never this — it is whatever the reader first typed,
 * kept on the book. This is only ever the key.
 */
export function tagKey(tag: string): string {
  return fold(tag.trim())
}

/** The longest a reader's tag may be. Kept here so the field and the store
 *  enforce one number rather than two that could disagree. */
export const TAG_MAX = 60

/**
 * A tag as it will be STORED: trimmed and cut to `TAG_MAX`. Empty when nothing
 * is left.
 *
 * ONE FUNCTION, called by everyone who writes a tag AND by everyone who then
 * refers to it. The store trimmed and truncated on the way in while the panel
 * put the reader's raw text into the query — so a 70-character rename left the
 * shelf scoped to a tag that had never been written, and the view emptied
 * with nothing to say why. Whoever writes the tag and whoever names it must
 * agree, and they agree by calling this.
 */
export function normalizeTag(raw: string): string {
  /* Normalised BEFORE the cut and cut BY CODE POINT, not by UTF-16 unit.
   * `slice` counts units, so a tag whose sixtieth character was an emoji or
   * any astral-plane letter was cut through the middle of its surrogate pair,
   * storing a lone surrogate no font can draw — and cutting a decomposed
   * string could drop a combining mark off the last letter, so two spellings
   * that fold to one key stored as two different truncations. */
  return [...raw.trim().normalize('NFC')].slice(0, TAG_MAX).join('')
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

/** Whether a book matches free text, on the fields the shelf shows or groups
 *  by. Both sides go through `fold`, so the match works by the same rule tag
 *  identity does — see the note there. */
export function matchesQuery(book: IndexedBook, query: string): boolean {
  const q = fold(query.trim())
  if (!q) return true
  return (
    fold(displayTitle(book)).includes(q) ||
    fold(displayAuthor(book)).includes(q) ||
    (book.series ? fold(book.series).includes(q) : false) ||
    (book.publisher ? fold(book.publisher).includes(q) : false) ||
    allTags(book).some((tag) => fold(tag).includes(q))
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
  /** Tags a book must NOT carry — `-tag:Name`. Either provenance counts. */
  readonly excluded?: readonly string[]
  readonly status?: ReadingStatus | null
  /**
   * Only books with none of the reader's OWN tags. Publisher subjects do not
   * count: a book shelved by its publisher under three subjects and by the
   * reader under none is a book the reader has not filed, and finding those
   * is what the flag is for.
   */
  readonly untagged?: boolean
}

/**
 * Whether the reader has filed this book at all — any own tag with a real
 * identity. BY KEY, not by array length: a record hand-edited or migrated to
 * hold a blank or whitespace tag draws no chip anywhere (`allTags` drops empty
 * keys), and a book whose only "tag" is invisible everywhere else must not be
 * invisible to Untagged too, or it can never be found to be fixed.
 */
const hasOwnTags = (book: IndexedBook): boolean =>
  (book.tags ?? []).some((one) => tagKey(one) !== '')

export function inScope(book: IndexedBook, scope: Scope | null): boolean {
  if (!scope) return true
  if (scope.status && statusOf(book) !== scope.status) return false
  if (scope.untagged && hasOwnTags(book)) return false
  const excluded = scope.excluded ?? []
  if (scope.tags.length === 0 && excluded.length === 0) return true
  /* EVERY tag: adding a second one narrows. `tag:Sea tag:Classics` meaning
   * "nautical or classical" would grow the shelf as the reader typed more,
   * which is the opposite of what typing more means anywhere else. */
  const has = new Set(allTags(book).map(tagKey))
  if (!scope.tags.every((tag) => has.has(tagKey(tag)))) return false
  /* And NONE of the excluded — a publisher's subject excludes as readily as
   * the reader's own tag requires, because `-tag:Poetry` means "not the
   * poetry" whoever said it was. */
  return !excluded.some((tag) => has.has(tagKey(tag)))
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
): {
  books: IndexedBook[]
  tags: readonly string[]
  excluded: readonly string[]
  status: ReadingStatus | null
  untagged: boolean
} {
  const { tags, excluded, status, untagged, text } = parseQuery(raw, tagKey)
  return {
    books: shelfView(books, { scope: { tags, excluded, status, untagged }, query: text, order }),
    tags,
    excluded,
    status,
    untagged,
  }
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

/** One row of `tagCounts` — named, because several surfaces pass them around. */
export type TagCount = ReturnType<typeof tagCounts>[number]

/**
 * How many books in scope carry NONE of the reader's own tags — the number
 * beside the panel's Untagged row. Publisher subjects do not count, for the
 * reason `Scope.untagged` gives.
 */
export function untaggedCount(books: readonly IndexedBook[], scope: Scope | null = null): number {
  let n = 0
  for (const book of books) {
    if (inScope(book, scope) && !hasOwnTags(book)) n += 1
  }
  return n
}

/** The two orders the panel offers. Most used first, or by name. */
export type TagOrder = 'count' | 'name'

/**
 * `tagCounts` comes most-used-first; this is the other order, and the one a
 * reader scanning for a NAME wants. `localeCompare` with `sensitivity: 'base'`
 * so `Émile` files under E and `sea` beside `Sea` — the same rule `inOrder`
 * uses for titles, for the same reason.
 */
export function inTagOrder(rows: readonly TagCount[], order: TagOrder): TagCount[] {
  if (order === 'count') return [...rows]
  return [...rows].sort(
    (a, b) =>
      a.tag.localeCompare(b.tag, undefined, { numeric: true, sensitivity: 'base' }) ||
      b.count - a.count,
  )
}

/**
 * Break what was typed into the tags it names.
 *
 * A COMMA SEPARATES, so `Sea, Classics` is two tags in one Enter — the way
 * Calibre's field and every tag field a reader has met reads it. Each piece is
 * normalised by the one function the store uses, empties are dropped, and two
 * pieces that fold together are one tag: `Sea, sea` is not a request for two.
 * Order is kept, so what the reader typed first is what lands first.
 */
export function splitTags(typed: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of typed.split(',')) {
    const tag = normalizeTag(piece)
    if (!tag) continue
    const key = tagKey(tag)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * What the editor's field offers as the reader types.
 *
 * Over every tag on the shelf, minus the ones already on the book, filtered by
 * KEY so `phil` finds `Philosophy` and `café` finds `Café`. Ranked the
 * way a reader's eye ranks them: a tag that STARTS with what was typed before
 * one that merely contains it; the reader's own tags before a publisher's
 * subjects, since their own vocabulary is what they are most likely reaching
 * for; then most used first, then by name, so the order is total and the list
 * does not reshuffle between keystrokes.
 *
 * `exact` says whether what was typed IS one of the offered tags, by key —
 * the field uses it to decide whether "Create" is worth offering. Typing `Sea`
 * when `Sea` exists is a pick, not a creation.
 *
 * Empty input offers the top of the shelf unfiltered — the most used tags,
 * which is what a reader who has just opened the field is most likely to want
 * — rather than nothing, which would make the field look like it knew nothing.
 */
export function tagSuggestions(
  all: readonly TagCount[],
  typed: string,
  already: ReadonlySet<string>,
  limit = 8,
): { rows: TagCount[]; exact: boolean } {
  const q = tagKey(typed)
  const candidates = all.filter((row) => !already.has(tagKey(row.tag)))
  const exact = candidates.some((row) => tagKey(row.tag) === q)
  /* THE EXACT MATCH FIRST, before everything. Ranked only by prefix, typing
   * the whole of `Sea` could still put a better-used `Seafaring` at the top —
   * and the editor points Enter at row 0, so finishing a tag's name and
   * pressing Enter added a tag the reader did not type. A finished name is a
   * pick, not a prefix. */
  const rank = (row: TagCount) =>
    q && tagKey(row.tag) === q ? 0 : q && tagKey(row.tag).startsWith(q) ? 1 : 2
  const rows = candidates
    .filter((row) => !q || tagKey(row.tag).includes(q))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.mine) - Number(a.mine) ||
        b.count - a.count ||
        a.tag.localeCompare(b.tag),
    )
    .slice(0, limit)
  return { rows, exact }
}

/**
 * The reader's own tags across a SELECTION, each with how many of the selected
 * books carry it — the chips of the editor in bulk mode. A tag on every book
 * reads as solid; one on some reads as partial and says its number, so the
 * reader knows what a click will do before doing it. Only the reader's own
 * tags: this is an editor, and subjects are not the reader's to edit.
 */
export function selectionTags(
  books: readonly IndexedBook[],
): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>()
  for (const book of books) {
    const seen = new Set<string>()
    for (const tag of book.tags ?? []) {
      const key = tagKey(tag)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const already = counts.get(key)
      if (already) already.count += 1
      else counts.set(key, { tag, count: 1 })
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

/* AN ALIAS, not a restatement. The literal list lives in `searchQuery`, where
 * the `is:` regex needs it; written out here as well, the two unions were one
 * `abandoned` away from disagreeing silently. The import direction is forced —
 * this file already imports the parser, and the parser must not import back. */
export type ReadingStatus = StatusTerm

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
