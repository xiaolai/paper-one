import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import {
  allTags,
  CANNOT_OPEN,
  byRecency,
  canOpen,
  inOrder,
  inScope,
  matchesQuery,
  shelfFor,
  shelfView,
  sortTitle,
  statusOf,
  tagCounts,
  tagKey,
} from './library'

/**
 * The shelf, as presentation.
 *
 * Everything about WRITING a book moved to `bookFolder` and `useLibrary` when a
 * book became a folder. What is left here takes books and returns books, so
 * every case is about ordering, matching or tag identity.
 */

/**
 * A book as the shelf sees it.
 *
 * `openedAt` rather than `lastOpened`, and no `url`, `path`, `vault` or `cover`:
 * a book is a folder, so where it lives is the folder's name and there is
 * nothing left to disagree about.
 */
function entry(over: Partial<IndexedBook> = {}): IndexedBook {
  return {
    bookId: 'book_moby',
    title: 'Moby-Dick',
    author: 'Herman Melville',
    openedAt: 1000,
    ...over,
  }
}

describe('byRecency', () => {
  it('puts the most recently opened first', () => {
    const shelf = [entry({ bookId: 'a', openedAt: 1 }), entry({ bookId: 'b', openedAt: 2 })]
    expect(byRecency(shelf).map((b) => b.bookId)).toEqual(['b', 'a'])
  })

  /* A book added and never opened still has a place, or importing a folder
   * would put every new book at the bottom in an arbitrary order. */
  it('falls back to when the book was added', () => {
    // `exactOptionalPropertyTypes` is on, so an absent field is absent rather
    // than explicitly undefined — which is also how it arrives off disk.
    const never = { bookId: 'b', title: 'New', author: 'A', addedAt: 5 }
    const shelf = [entry({ bookId: 'a', openedAt: 1 }), never]
    expect(byRecency(shelf)[0]?.bookId).toBe('b')
  })
})

describe('sortTitle', () => {
  it('files a book under its declared sort title', () => {
    expect(sortTitle(entry({ title: 'The Hobbit', sortAs: 'Hobbit, The' }))).toBe('Hobbit, The')
  })

  /* Paired so the two keys DISAGREE: by displayed title Ivanhoe comes first
   * (I before T), by sort title it comes second (I after H). An earlier version
   * of this case used Grendel, which sorts first either way — so it passed
   * happily with the field ignored. */
  it('files The Hobbit under H, so it precedes Ivanhoe', () => {
    const shelf = [
      entry({ bookId: 'a', title: 'Ivanhoe' }),
      entry({ bookId: 'b', title: 'The Hobbit', sortAs: 'Hobbit, The' }),
    ]
    expect(inOrder(shelf, 'title').map((b) => b.title)).toEqual(['The Hobbit', 'Ivanhoe'])
  })

  it('falls back to the displayed title', () => {
    expect(sortTitle(entry({ title: 'Moby-Dick' }))).toBe('Moby-Dick')
  })

  it('falls back again for a book with no title at all', () => {
    expect(sortTitle(entry({ title: '' }))).toBe('Untitled')
  })
})

describe('inOrder', () => {
  /* `localeCompare` rather than `<`: code-point order puts every accented title
   * after every unaccented one, so `Émile` landed after `Zola`. */
  it('sorts accented titles where a reader expects them', () => {
    const shelf = [entry({ bookId: 'a', title: 'Zola' }), entry({ bookId: 'b', title: 'Émile' })]
    expect(inOrder(shelf, 'title').map((b) => b.title)).toEqual(['Émile', 'Zola'])
  })

  it('sorts numerically, so Volume 2 precedes Volume 10', () => {
    const shelf = [
      entry({ bookId: 'a', title: 'Volume 10' }),
      entry({ bookId: 'b', title: 'Volume 2' }),
    ]
    expect(inOrder(shelf, 'title').map((b) => b.title)).toEqual(['Volume 2', 'Volume 10'])
  })
})

describe('tagKey', () => {
  it('folds case', () => {
    expect(tagKey('Philosophy')).toBe(tagKey('philosophy'))
  })

  it('folds surrounding space', () => {
    expect(tagKey('  Sea  ')).toBe(tagKey('Sea'))
  })

  /**
   * The duplicate nothing on screen can explain.
   *
   * `Café` typed on macOS is decomposed — `e` plus a combining acute — and the
   * same word pasted from elsewhere is composed. They render identically and
   * compare unequal.
   */
  it('folds Unicode composition', () => {
    const composed = 'Café'
    const decomposed = 'Café'
    expect(composed).not.toBe(decomposed)
    expect(tagKey(composed)).toBe(tagKey(decomposed))
  })

  /* NFC before lowercasing, not after: lowercasing can change which
   * decompositions apply, so normalising second leaves the two forms folding to
   * different keys. */
  it('folds composition and case together', () => {
    expect(tagKey('CAFÉ')).toBe(tagKey('café'))
  })
})

describe('allTags', () => {
  it('lists the reader tags before the publisher subjects', () => {
    const row = entry({ tags: ['Mine'], subjects: ['Theirs'] })
    expect(allTags(row)).toEqual(['Mine', 'Theirs'])
  })

  /* A publisher's `philosophy` beside a reader's `Philosophy` would otherwise
   * appear as two subjects on one book. */
  it('drops a declared subject that folds onto a reader tag', () => {
    const row = entry({ subjects: ['philosophy'], tags: ['Philosophy'] })
    expect(allTags(row)).toEqual(['Philosophy'])
  })

  it('is the declared subjects when the reader has added none', () => {
    expect(allTags(entry({ subjects: ['Sea'] }))).toEqual(['Sea'])
  })
})

describe('matchesQuery', () => {
  it('matches what the row displays', () => {
    expect(matchesQuery(entry({ title: 'Moby-Dick' }), 'moby')).toBe(true)
    expect(matchesQuery(entry({ author: 'Herman Melville' }), 'melville')).toBe(true)
  })

  /* Searching for a series when the shelf is visibly grouped by one and finding
   * nothing reads as the search being broken. */
  it('matches the fields the shelf groups by', () => {
    expect(matchesQuery(entry({ series: 'Discworld' }), 'discworld')).toBe(true)
    expect(matchesQuery(entry({ publisher: 'Penguin' }), 'penguin')).toBe(true)
    expect(matchesQuery(entry({ subjects: ['Philosophy'] }), 'philos')).toBe(true)
  })

  it('matches everything on an empty query', () => {
    expect(matchesQuery(entry(), '   ')).toBe(true)
  })

  it('does not match an unrelated term', () => {
    expect(matchesQuery(entry({ title: 'Moby-Dick' }), 'zebra')).toBe(false)
  })

  it('survives a book carrying none of the optional fields', () => {
    expect(matchesQuery(entry(), 'discworld')).toBe(false)
  })
})

describe('inScope', () => {
  it('lets everything through with no scope', () => {
    expect(inScope(entry(), null)).toBe(true)
    expect(inScope(entry(), { tags: [] })).toBe(true)
  })

  /* EVERY tag, not any: a second tag narrows. Meaning "or" would grow the shelf
   * as the reader typed more, which is the opposite of what typing more means
   * anywhere else. */
  it('requires every tag', () => {
    const both = { tags: ['Sea', 'Classics'] }
    expect(inScope(entry({ tags: ['Sea', 'Classics'] }), both)).toBe(true)
    expect(inScope(entry({ tags: ['Sea'] }), both)).toBe(false)
  })

  it('matches whatever case the book stored', () => {
    expect(inScope(entry({ tags: ['philosophy'] }), { tags: ['Philosophy'] })).toBe(true)
  })

  it('matches a publisher subject as readily as a reader tag', () => {
    expect(inScope(entry({ subjects: ['Sea'] }), { tags: ['sea'] })).toBe(true)
  })
})

describe('shelfView', () => {
  const shelf = [
    entry({ bookId: 'a', title: 'Ethics', tags: ['Philosophy'], openedAt: 3 }),
    entry({ bookId: 'b', title: 'Poems', tags: ['Poetry'], openedAt: 2 }),
    entry({ bookId: 'c', title: 'Ethics II', tags: ['Philosophy'], openedAt: 1 }),
  ]

  it('applies the scope before the query, so a search stays inside it', () => {
    expect(shelfView(shelf, { scope: { tags: ['Poetry'] }, query: 'ethics' })).toEqual([])
  })

  it('orders what survived, not the whole library', () => {
    const view = shelfView(shelf, { scope: { tags: ['Philosophy'] }, order: 'title' })
    expect(view.map((b) => b.title)).toEqual(['Ethics', 'Ethics II'])
  })

  it('is the whole shelf with no scope and no query', () => {
    expect(shelfView(shelf)).toHaveLength(3)
  })
})

describe('shelfFor', () => {
  const shelf = [
    entry({ bookId: 'a', title: 'Ethics', tags: ['Philosophy'] }),
    entry({ bookId: 'b', title: 'Poems', tags: ['Poetry'] }),
  ]

  /* One string carries both the restriction and the text, which is why there is
   * no scope state beside the field that could disagree with it. */
  it('reads the scope and the text out of one query', () => {
    const view = shelfFor(shelf, 'tag:Philosophy ethics')
    expect(view.tags).toEqual(['Philosophy'])
    expect(view.books.map((b) => b.title)).toEqual(['Ethics'])
  })

  it('is the whole shelf for an empty query', () => {
    expect(shelfFor(shelf, '').books).toHaveLength(2)
  })

  it('folds the tag in the query against the tag on the book', () => {
    expect(shelfFor(shelf, 'tag:philosophy').books).toHaveLength(1)
  })
})

describe('tagCounts', () => {
  it('counts each tag, most used first', () => {
    const shelf = [
      entry({ bookId: 'a', subjects: ['Philosophy', 'Ethics'] }),
      entry({ bookId: 'b', subjects: ['Philosophy'] }),
      entry({ bookId: 'c' }),
    ]
    expect(tagCounts(shelf)).toEqual([
      { tag: 'Philosophy', count: 2 },
      { tag: 'Ethics', count: 1 },
    ])
  })

  it('counts folded variants as one tag, shown once', () => {
    const shelf = [
      entry({ bookId: 'a', tags: ['Philosophy'] }),
      entry({ bookId: 'b', tags: ['philosophy'] }),
      entry({ bookId: 'c', subjects: ['PHILOSOPHY'] }),
    ]
    expect(tagCounts(shelf)).toEqual([{ tag: 'Philosophy', count: 3 }])
  })

  /* One book carrying the tag under both provenances must not count twice. */
  it('counts a book once even when both lists carry the tag', () => {
    expect(tagCounts([entry({ tags: ['Sea'], subjects: ['sea'] })])).toEqual([
      { tag: 'Sea', count: 1 },
    ])
  })

  it('counts within the scope it is given', () => {
    const shelf = [
      entry({ bookId: 'a', tags: ['Philosophy', 'Ethics'] }),
      entry({ bookId: 'b', tags: ['Poetry'] }),
    ]
    expect(tagCounts(shelf, { tags: ['Ethics'] })).toEqual([
      { tag: 'Ethics', count: 1 },
      { tag: 'Philosophy', count: 1 },
    ])
  })

  /* Two tags with the same count would otherwise swap places on a redraw. */
  it('breaks a tie by name, so the order is stable', () => {
    expect(tagCounts([entry({ tags: ['Zebra', 'Apple'] })]).map((t) => t.tag)).toEqual([
      'Apple',
      'Zebra',
    ])
  })
})

describe('statusOf', () => {
  it('is unread with no recorded position', () => {
    expect(statusOf(entry())).toBe('unread')
  })

  it('is reading once there is a position', () => {
    expect(statusOf(entry({ position: 'epubcfi(/6/4)' }))).toBe('reading')
  })

  it('is finished when the reader says so, whatever the fraction', () => {
    expect(statusOf(entry({ position: 'x', progress: 0.94, finished: true }))).toBe('finished')
  })

  /* A book at 100% is NOT finished on that basis alone — the reader may simply
   * have jumped to the index. */
  it('is not finished merely because the fraction reached the end', () => {
    expect(statusOf(entry({ position: 'x', progress: 1 }))).toBe('reading')
  })
})


/**
 * The concept WI-4.7 deleted on a false premise.
 *
 * "A book that is its own folder is always openable" is true for a book Paper
 * wrote, and false for a record whose content was never there — which is exactly
 * what migrating a phase-3 library produced. Derived now rather than stored, so
 * unlike the field it replaces it cannot disagree with the disk.
 */
describe('canOpen', () => {
  it('opens a book whose bytes are there', () => {
    expect(canOpen(entry({ hasContent: true }))).toBe(true)
  })

  it('does not open a record with no bytes and no original', () => {
    expect(canOpen(entry({ hasContent: false }))).toBe(false)
  })

  /* `origin` is the reader's own file and IS a way back — a fallback rather
   * than a first choice, since it depends on their file still being there. */
  it('opens one with no bytes but a path back to the file', () => {
    expect(canOpen(entry({ hasContent: false, origin: '/books/moby.epub' }))).toBe(true)
  })

  /* A record from before `hasContent` was derived says nothing about content,
   * and assuming the worst would empty an existing shelf. */
  it('assumes a record that says nothing is fine', () => {
    expect(canOpen(entry())).toBe(true)
  })

  it('has something to say on the row', () => {
    expect(CANNOT_OPEN).toContain('add the file again')
  })
})

describe('allTags folds the publisher subjects against each other', () => {
  /* The earlier version folded declared subjects against the READER's tags and
   * not against each other — and returned them untouched when the reader had
   * added none. A book whose publisher listed both spellings drew two chips. */
  it('folds two case-variant subjects into one', () => {
    expect(allTags(entry({ subjects: ['Fiction', 'fiction'] }))).toEqual(['Fiction'])
  })

  it('folds across both lists at once', () => {
    const row = entry({ tags: ['Sea'], subjects: ['sea', 'Classics', 'CLASSICS'] })
    expect(allTags(row)).toEqual(['Sea', 'Classics'])
  })
})
