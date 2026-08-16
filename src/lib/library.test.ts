import { describe, expect, it } from 'vitest'
import {
  byRecency,
  inOrder,
  shelfView,
  sortTitle,
  tagCounts,
  isReopenable,
  parseLibrary,
  allTags,
  applyLookup,
  forgetBook,
  markFinished,
  statusOf,
  inScope,
  tagBook,
  tagKey,
  untagBook,
  matchesQuery,
  recordOpen,
  rememberVault,
  rememberPosition,
  type LibraryEntry,
} from './library'

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    bookId: 'url:/moby.epub',
    title: 'Moby-Dick',
    author: 'Herman Melville',
    url: '/moby.epub',
    lastOpened: 1000,
    position: null,
    workId: null,
    path: null,
    ...over,
  }
}

describe('recordOpen', () => {
  it('moves a book already in the list to the top rather than duplicating it', () => {
    const before = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    const after = recordOpen(before, entry({ bookId: 'b', lastOpened: 2000 }))
    expect(after.map((e) => e.bookId)).toEqual(['b', 'a'])
    expect(after).toHaveLength(2)
  })

  it('takes every field from the newer entry, not just the timestamp', () => {
    /* The metadata a book was recorded with can improve — a title read from
     * the file replacing one guessed from its name — and the later open is
     * the one that is true now.
     *
     * This deliberately does NOT test a file-sourced open clearing a URL, which
     * is what it used to assert: `bookIdFor` prefixes the two kinds, so a file
     * and a URL never share an id and never meet in this function. The test
     * passed and demonstrated nothing, because it constructed by hand a pair of
     * entries production cannot produce. */
    const before = [entry({ bookId: 'a', title: 'moby', author: '' })]
    const after = recordOpen(
      before,
      entry({ bookId: 'a', title: 'Moby-Dick', author: 'Herman Melville' }),
    )
    expect(after).toHaveLength(1)
    expect(after[0]?.title).toBe('Moby-Dick')
    expect(after[0]?.author).toBe('Herman Melville')
  })

  /* The exception to "every field from the newer entry", and the reason it is
   * an exception: an open is recorded the moment the metadata arrives, before
   * the reader has been anywhere, so the entry it carries has no position. Left
   * to the rule above, opening a book would erase where you were in it — the
   * one field whose whole purpose is to survive an open. */
  it('carries the saved position through an open that does not name one', () => {
    const before = [entry({ bookId: 'a', position: 'epubcfi(/6/14!/4/2/6)' })]
    const after = recordOpen(before, entry({ bookId: 'a', lastOpened: 2000 }))
    expect(after[0]?.position).toBe('epubcfi(/6/14!/4/2/6)')
    expect(after[0]?.lastOpened).toBe(2000)
  })

  it('lets an entry that does name a position replace the saved one', () => {
    const before = [entry({ bookId: 'a', position: 'old' })]
    expect(recordOpen(before, entry({ bookId: 'a', position: 'new' }))[0]?.position).toBe('new')
  })
})

describe('a row that can be reopened', () => {
  it('counts a path as reopenable, not only a url', () => {
    expect(isReopenable(entry({ url: null, path: '/books/moby.epub' }))).toBe(true)
    expect(isReopenable(entry({ url: '/moby.epub', path: null }))).toBe(true)
    expect(isReopenable(entry({ url: null, path: null }))).toBe(false)
  })

  /* The same carry-through rule the position has, for the same reason: a book
   * can be opened again by a route that does not know where it lives — dropped
   * in, or from a URL — and losing the path would turn a row that opens back
   * into one that does not. */
  it('keeps a known path through an open that does not carry one', () => {
    const before = [entry({ bookId: 'a', path: '/books/moby.epub' })]
    const after = recordOpen(before, entry({ bookId: 'a', path: null, lastOpened: 2000 }))
    expect(after[0]?.path).toBe('/books/moby.epub')
    expect(after[0]?.lastOpened).toBe(2000)
  })

  it('lets a newer path replace an older one', () => {
    const before = [entry({ bookId: 'a', path: '/old/moby.epub' })]
    expect(recordOpen(before, entry({ bookId: 'a', path: '/new/moby.epub' }))[0]?.path).toBe(
      '/new/moby.epub',
    )
  })

  it('reads a row saved before paths existed, as a book with no path', () => {
    const old = { bookId: 'a', title: 'T', author: 'A', url: null, lastOpened: 5 }
    // url null and no path: honest about not being reopenable rather than dropped.
    const parsed = parseLibrary(JSON.stringify([{ ...old, url: '/a.epub' }]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.path).toBeNull()
  })
})

describe('rememberPosition', () => {
  it('stores where the reader left off, touching nothing else', () => {
    const before = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    const after = rememberPosition(before, 'a', 'epubcfi(/6/4!/4/2)')
    expect(after[0]?.position).toBe('epubcfi(/6/4!/4/2)')
    expect({ ...after[0], position: null }).toEqual(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('leaves the recency order alone — reading a book is not opening it', () => {
    const before = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    expect(rememberPosition(before, 'b', 'x').map((e) => e.bookId)).toEqual(['a', 'b'])
  })

  /* Returned by identity, not by value. This runs on a page turn, and a new
   * array every time re-renders the shelf and the switcher for a change that
   * did not happen. */
  it('returns the same list when there is nothing to change', () => {
    const before = [entry({ bookId: 'a', position: 'same' })]
    expect(rememberPosition(before, 'a', 'same')).toBe(before)
    expect(rememberPosition(before, 'absent', 'x')).toBe(before)
  })

  it('drops a position for a book not on the shelf rather than inventing a row', () => {
    // A row without a title or a url is not something any surface can draw.
    expect(rememberPosition([], 'ghost', 'x')).toEqual([])
  })
})

describe('inOrder', () => {
  const shelf = [
    entry({ bookId: 'c', title: 'Émile', author: 'Rousseau', lastOpened: 1 }),
    entry({ bookId: 'a', title: 'Volume 10', author: 'Zola', lastOpened: 3 }),
    entry({ bookId: 'b', title: 'Volume 2', author: 'Adams', lastOpened: 2 }),
  ]

  it('keeps recency as the switcher has always had it', () => {
    expect(inOrder(shelf, 'recent').map((e) => e.bookId)).toEqual(['a', 'b', 'c'])
  })

  /* `<` orders by code point, so every accented title sorts after every
   * unaccented one — a shelf with Émile on it puts that book after Zola in a
   * list the reader is scanning alphabetically. */
  it('sorts titles the way a reader reads them, accents included', () => {
    expect(inOrder(shelf, 'title').map((e) => e.title)).toEqual([
      'Émile',
      'Volume 2',
      'Volume 10',
    ])
  })

  it('sorts by author', () => {
    expect(inOrder(shelf, 'author').map((e) => e.author)).toEqual([
      'Adams',
      'Rousseau',
      'Zola',
    ])
  })

  /* Without a tie-break two books with one title swap places between renders,
   * because `Array.sort` is only stable with respect to the input order and the
   * input is itself re-derived. */
  it('breaks ties by recency rather than arbitrarily', () => {
    const same = [
      entry({ bookId: 'old', title: 'Same', lastOpened: 1 }),
      entry({ bookId: 'new', title: 'Same', lastOpened: 9 }),
    ]
    expect(inOrder(same, 'title').map((e) => e.bookId)).toEqual(['new', 'old'])
    expect(inOrder([...same].reverse(), 'title').map((e) => e.bookId)).toEqual(['new', 'old'])
  })

  it('does not mutate the shelf it was given', () => {
    const before = shelf.map((e) => e.bookId)
    inOrder(shelf, 'title')
    expect(shelf.map((e) => e.bookId)).toEqual(before)
  })
})

describe('byRecency', () => {
  it('puts the most recently opened first', () => {
    const sorted = byRecency([
      entry({ bookId: 'old', lastOpened: 1 }),
      entry({ bookId: 'new', lastOpened: 9 }),
    ])
    expect(sorted.map((e) => e.bookId)).toEqual(['new', 'old'])
  })

  it('does not mutate its input', () => {
    const input = [entry({ bookId: 'a', lastOpened: 1 }), entry({ bookId: 'b', lastOpened: 9 })]
    byRecency(input)
    expect(input.map((e) => e.bookId)).toEqual(['a', 'b'])
  })
})

describe('parseLibrary', () => {
  it('reads back what was written, including a null url', () => {
    const books = [entry(), entry({ bookId: 'file:x', url: null })]
    expect(parseLibrary(JSON.stringify(books))).toEqual(books)
  })

  it('returns nothing for absent, malformed or non-array payloads', () => {
    expect(parseLibrary(null)).toEqual([])
    expect(parseLibrary('not json')).toEqual([])
    expect(parseLibrary('{"books":[]}')).toEqual([])
  })

  it('drops rows that fail validation and keeps the rest', () => {
    const payload = JSON.stringify([entry({ bookId: 'good' }), { bookId: 'bad' }, 7])
    const parsed = parseLibrary(payload)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.bookId).toBe('good')
  })

  it('rejects a url that is neither a string nor null', () => {
    expect(parseLibrary(JSON.stringify([{ ...entry(), url: 42 }]))).toEqual([])
  })

  /* Rows written before positions existed are already in readers' storage, and
   * a shelf that empties itself on upgrade is a worse bug than the one the
   * position field fixes. Absent, empty and wrong-typed all mean "we do not
   * know where they were", which is exactly what null means. */
  it('reads a row saved before positions existed, as a book with no position', () => {
    const old = { bookId: 'a', title: 'T', author: 'A', url: '/a.epub', lastOpened: 5 }
    const parsed = parseLibrary(JSON.stringify([old]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.position).toBeNull()
  })

  it('normalises an unusable position to null rather than dropping the book', () => {
    for (const position of [42, '', {}, false]) {
      const parsed = parseLibrary(JSON.stringify([{ ...entry(), position }]))
      expect(parsed, `position: ${JSON.stringify(position)}`).toHaveLength(1)
      expect(parsed[0]?.position).toBeNull()
    }
  })

  it('reads back a stored position unchanged', () => {
    const cfi = 'epubcfi(/6/14!/4/2/6,/1:0,/1:12)'
    expect(parseLibrary(JSON.stringify([entry({ position: cfi })]))[0]?.position).toBe(cfi)
  })
})


/**
 * The title a shelf alphabetises by is not the title it shows.
 *
 * `file-as` exists because sorting on the displayed title is wrong in every
 * language with articles. foliate has been parsing it all along; Paper sorted on
 * `title` because the field was discarded before it reached the row.
 */
describe('sortTitle', () => {
  it('files a book under its declared sort title', () => {
    expect(sortTitle(entry({ title: 'The Hobbit', sortAs: 'Hobbit, The' }))).toBe('Hobbit, The')
  })

  /* Stated as an ordering, and paired so the two keys DISAGREE.
   *
   * The first version of this case used Grendel, which sorts before The Hobbit
   * whichever key is used — so it passed just as happily with the field ignored.
   * Ivanhoe is the pair that separates them: by the displayed title it comes
   * first (I before T), by the sort title it comes second (I after H). */
  it('files The Hobbit under H, so it precedes Ivanhoe', () => {
    const shelf = [
      entry({ bookId: 'a', title: 'Ivanhoe' }),
      entry({ bookId: 'b', title: 'The Hobbit', sortAs: 'Hobbit, The' }),
    ]
    expect(inOrder(shelf, 'title').map((e) => e.title)).toEqual(['The Hobbit', 'Ivanhoe'])
  })

  /* A book declaring no `file-as` must sort exactly as it did before this
   * existed. The field changes the order only where the book asked it to. */
  it('falls back to the displayed title', () => {
    expect(sortTitle(entry({ title: 'Moby-Dick' }))).toBe('Moby-Dick')
  })

  it('falls back again for a book with no title at all', () => {
    expect(sortTitle(entry({ title: '' }))).toBe('Untitled')
  })
})

/**
 * A row written before any of these fields existed.
 *
 * The compatibility case, and the reason every new field is optional: the store
 * on a reader's disk right now has none of them, and a shelf that dropped those
 * rows would lose the library to gain a feature.
 */
describe('rows written before the metadata fields existed', () => {
  const legacy = JSON.stringify([
    {
      bookId: 'url:/old.epub',
      title: 'Old',
      author: 'A',
      url: '/old.epub',
      lastOpened: 1,
      position: null,
    },
  ])

  it('survives parsing, rather than being dropped', () => {
    expect(parseLibrary(legacy)).toHaveLength(1)
  })

  it('sorts by its displayed title, having no sort title', () => {
    const [row] = parseLibrary(legacy)
    expect(row && sortTitle(row)).toBe('Old')
  })

  it('carries the new fields when a book does declare them', () => {
    const rich = JSON.stringify([
      {
        bookId: 'url:/new.epub',
        title: 'New',
        author: 'B',
        url: '/new.epub',
        lastOpened: 2,
        position: null,
        series: 'Discworld',
        seriesIndex: 5,
        subjects: ['Fantasy'],
      },
    ])
    expect(parseLibrary(rich)[0]).toMatchObject({
      series: 'Discworld',
      seriesIndex: 5,
      subjects: ['Fantasy'],
    })
  })
})


/**
 * Paper's own copy, recorded once it lands.
 *
 * Kept separate from `recordOpen` because it happens moments after one,
 * asynchronously — a copy landing must not move the row the reader is looking
 * at, the same reason `rememberPosition` is separate.
 */
describe('rememberVault', () => {
  it('attaches the copy to the right row', () => {
    const shelf = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    const after = rememberVault(shelf, 'b', 'books/b.epub')
    expect(after[1]?.vault).toBe('books/b.epub')
    expect(after[0]?.vault).toBeUndefined()
  })

  it('does not reorder the shelf', () => {
    const shelf = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    expect(rememberVault(shelf, 'b', 'books/b.epub').map((e) => e.bookId)).toEqual(['a', 'b'])
  })

  /* Returned by identity so the caller can skip a write without comparing rows
   * itself — this fires on every open and most find the copy already recorded. */
  it('returns its input unchanged when the copy is already recorded', () => {
    const shelf = [entry({ bookId: 'a', vault: 'books/a.epub' })]
    expect(rememberVault(shelf, 'a', 'books/a.epub')).toBe(shelf)
  })

  it('returns its input for a book not on the shelf', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(rememberVault(shelf, 'missing', 'books/x.epub')).toBe(shelf)
  })

  /* A row shelved before the vault existed has no `vault` and must survive
   * parsing untouched — it gets one on its next open, not by a sweep. */
  it('leaves a pre-vault row parseable', () => {
    const legacy = JSON.stringify([
      { bookId: 'a', title: 'T', author: 'A', url: null, path: '/books/t.epub', lastOpened: 1, position: null },
    ])
    const [row] = parseLibrary(legacy)
    expect(row?.vault).toBeUndefined()
    expect(row?.path).toBe('/books/t.epub')
  })
})


/**
 * Taking a book off the shelf.
 *
 * `forgetBook` existed once with a test and no caller, and was deleted for being
 * a capability that lived only in the suite. It is back with the control that
 * makes it real — and with a promise it can now keep, because there are two
 * files and only one of them is Paper's.
 */
describe('forgetBook', () => {
  it('removes the row', () => {
    const shelf = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    expect(forgetBook(shelf, 'a').map((e) => e.bookId)).toEqual(['b'])
  })

  it('leaves the rest in their order', () => {
    const shelf = [entry({ bookId: 'a' }), entry({ bookId: 'b' }), entry({ bookId: 'c' })]
    expect(forgetBook(shelf, 'b').map((e) => e.bookId)).toEqual(['a', 'c'])
  })

  /* By identity, so a caller can skip the write — the same contract
   * `rememberPosition` and `rememberVault` keep. */
  it('returns its input unchanged for a book that is not there', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(forgetBook(shelf, 'missing')).toBe(shelf)
  })

  it('empties a shelf of one', () => {
    expect(forgetBook([entry({ bookId: 'a' })], 'a')).toEqual([])
  })
})


/**
 * Searching, scoping, and the order the two are applied in.
 *
 * The order is the part that is silent when wrong: scope before query means a
 * search inside a collection stays inside it, and ordering last means "first
 * alphabetically" is first among what is SHOWN rather than first in the library.
 */
describe('matchesQuery', () => {
  it('matches what the row displays', () => {
    expect(matchesQuery(entry({ title: 'Moby-Dick' }), 'moby')).toBe(true)
    expect(matchesQuery(entry({ author: 'Herman Melville' }), 'melville')).toBe(true)
  })

  /* Searching for a series or a publisher and finding nothing, when the shelf
   * is visibly grouped by exactly that, reads as the search being broken. */
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

  /* A row written before the metadata fields existed has none of them, and must
   * not throw its way out of a search. */
  it('survives a row with none of the new fields', () => {
    expect(matchesQuery(entry(), 'discworld')).toBe(false)
  })
})

describe('inScope', () => {
  it('lets everything through with no scope', () => {
    expect(inScope(entry(), null)).toBe(true)
  })

  it('restricts to a tag', () => {
    expect(inScope(entry({ subjects: ['Ethics'] }), { tags: ['Ethics'] })).toBe(true)
    expect(inScope(entry({ subjects: ['Poetry'] }), { tags: ['Ethics'] })).toBe(false)
  })

  /* A series is a book PROPERTY, not a tag — phase 4's vocabulary. Scoping by
   * one is scoping by the tag a reader gave it, which is the only kind of scope
   * that exists now. */
  it('requires EVERY tag, so a second tag narrows', () => {
    const both = { tags: ['Sea', 'Classics'] }
    expect(inScope(entry({ tags: ['Sea', 'Classics'] }), both)).toBe(true)
    expect(inScope(entry({ tags: ['Sea'] }), both)).toBe(false)
  })

  it('lets everything through for an empty tag list', () => {
    expect(inScope(entry(), { tags: [] })).toBe(true)
  })
})

describe('shelfView', () => {
  const shelf = [
    entry({ bookId: 'a', title: 'Ethics', subjects: ['Philosophy'], lastOpened: 3 }),
    entry({ bookId: 'b', title: 'Poems', subjects: ['Poetry'], lastOpened: 2 }),
    entry({ bookId: 'c', title: 'Ethics II', subjects: ['Philosophy'], lastOpened: 1 }),
  ]

  it('applies the scope before the query, so a search stays inside it', () => {
    const view = shelfView(shelf, { scope: { tags: ['Poetry'] }, query: 'ethics' })
    expect(view).toEqual([])
  })

  it('orders what survived, not the whole library', () => {
    const view = shelfView(shelf, { scope: { tags: ['Philosophy'] }, order: 'title' })
    expect(view.map((e) => e.title)).toEqual(['Ethics', 'Ethics II'])
  })

  it('is the whole shelf with no scope and no query', () => {
    expect(shelfView(shelf)).toHaveLength(3)
  })
})

describe('tagCounts', () => {
  const shelf = [
    entry({ bookId: 'a', subjects: ['Philosophy', 'Ethics'] }),
    entry({ bookId: 'b', subjects: ['Philosophy'] }),
    entry({ bookId: 'c' }),
  ]

  it('counts each tag, most used first', () => {
    expect(tagCounts(shelf)).toEqual([
      { tag: 'Philosophy', count: 2 },
      { tag: 'Ethics', count: 1 },
    ])
  })

  /* Counted WITHIN the scope, so the numbers describe what the reader can
   * actually reach rather than what exists somewhere else. */
  it('counts within the scope it is given', () => {
    expect(tagCounts(shelf, { tags: ['Ethics'] })).toEqual([
      { tag: 'Ethics', count: 1 },
      { tag: 'Philosophy', count: 1 },
    ])
  })

  /* Two tags with the same count would otherwise swap places on a redraw. */
  it('breaks a tie by name, so the order is stable', () => {
    const tied = [entry({ bookId: 'a', subjects: ['Zebra', 'Apple'] })]
    expect(tagCounts(tied).map((t) => t.tag)).toEqual(['Apple', 'Zebra'])
  })
})


/**
 * The reader's own tags, kept apart from the publisher's.
 *
 * Two fields rather than one merged list, and the separation is load-bearing:
 * `subjects` are replaced wholesale every time the book is re-opened, so a
 * reader's tag folded in there would be erased by re-reading the book it was
 * attached to.
 */
describe('reader tags', () => {
  it('adds a tag without touching the declared subjects', () => {
    const shelf = [entry({ bookId: 'a', subjects: ['Philosophy'] })]
    const [row] = tagBook(shelf, 'a', 'To reread')
    expect(row?.tags).toEqual(['To reread'])
    expect(row?.subjects).toEqual(['Philosophy'])
  })

  /* The case the split exists for: re-opening a book replaces `subjects`, and
   * the reader's tag has to be there afterwards. */
  it('survives the declared subjects being replaced', () => {
    const tagged = tagBook([entry({ bookId: 'a', subjects: ['Old'] })], 'a', 'Mine')
    const reparsed = tagged.map((row) => ({ ...row, subjects: ['New'] }))
    expect(allTags(reparsed[0]!)).toEqual(['Mine', 'New'])
  })

  it('refuses a tag the book already carries under either provenance', () => {
    const shelf = [entry({ bookId: 'a', subjects: ['Philosophy'] })]
    expect(tagBook(shelf, 'a', 'Philosophy')).toBe(shelf)
    const own = tagBook(shelf, 'a', 'Mine')
    expect(tagBook(own, 'a', 'Mine')).toBe(own)
  })

  it('trims and caps, and refuses an empty tag', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(tagBook(shelf, 'a', '   ')).toBe(shelf)
    expect(tagBook(shelf, 'a', '  spaced  ')[0]?.tags).toEqual(['spaced'])
    expect(tagBook(shelf, 'a', 'x'.repeat(200))[0]?.tags?.[0]).toHaveLength(60)
  })

  /* A publisher's subject is a fact about the book, not a choice — and it comes
   * back on the next open anyway, so removing it would be theatre. */
  it('cannot remove a declared subject', () => {
    const shelf = [entry({ bookId: 'a', subjects: ['Philosophy'] })]
    expect(untagBook(shelf, 'a', 'Philosophy')).toBe(shelf)
  })

  it('removes one of the reader own tags', () => {
    const tagged = tagBook([entry({ bookId: 'a' })], 'a', 'Mine')
    expect(untagBook(tagged, 'a', 'Mine')[0]?.tags).toEqual([])
  })

  it('deduplicates across both lists, reader first', () => {
    const row = entry({ bookId: 'a', subjects: ['Shared', 'Theirs'], tags: ['Shared', 'Mine'] })
    expect(allTags(row)).toEqual(['Shared', 'Mine', 'Theirs'])
  })
})


/**
 * Where a book stands.
 *
 * Derived, except the one part that cannot be: finishing is a judgement and a
 * fraction is a measurement. A book read to 94% with the endnotes skipped is
 * finished; one at 100% because the reader jumped to the index is not.
 */
describe('statusOf', () => {
  it('is unread with no recorded position', () => {
    expect(statusOf(entry({ position: null }))).toBe('unread')
  })

  it('is reading once there is a position', () => {
    expect(statusOf(entry({ position: 'epubcfi(/6/4)' }))).toBe('reading')
  })

  it('is finished when the reader says so, whatever the fraction', () => {
    expect(statusOf(entry({ position: 'epubcfi(/6/4)', progress: 0.94, finished: true }))).toBe(
      'finished',
    )
  })

  /* And a book sitting at 100% is NOT finished on that basis alone — the reader
   * may simply have jumped to the index. */
  it('is not finished merely because the fraction reached the end', () => {
    expect(statusOf(entry({ position: 'x', progress: 1 }))).toBe('reading')
  })
})

describe('markFinished', () => {
  it('marks and unmarks', () => {
    const shelf = [entry({ bookId: 'a' })]
    const done = markFinished(shelf, 'a', true)
    expect(done[0]?.finished).toBe(true)
    expect(markFinished(done, 'a', false)[0]?.finished).toBe(false)
  })

  it('returns its input when nothing changes', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(markFinished(shelf, 'a', false)).toBe(shelf)
    expect(markFinished(shelf, 'missing', true)).toBe(shelf)
  })
})

describe('rememberPosition with a fraction', () => {
  it('records the fraction beside the position', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(rememberPosition(shelf, 'a', 'cfi', 0.42)[0]?.progress).toBe(0.42)
  })

  /* A fraction outside 0–1 says the renderer is confused, not that the reader
   * is 400% through a book. */
  it('clamps a nonsensical fraction', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(rememberPosition(shelf, 'a', 'cfi', 4)[0]?.progress).toBe(1)
    expect(rememberPosition(shelf, 'a', 'cfi', -1)[0]?.progress).toBe(0)
    expect(rememberPosition(shelf, 'a', 'cfi', NaN)[0]?.progress).toBeUndefined()
  })

  it('keeps the previous fraction when none is given', () => {
    const shelf = [entry({ bookId: 'a', progress: 0.3 })]
    expect(rememberPosition(shelf, 'a', 'other')[0]?.progress).toBe(0.3)
  })

  /* Identity when neither the position nor the fraction moved, so the caller
   * can still skip the write — this runs while the reader is reading. */
  it('returns its input when nothing moved', () => {
    const shelf = [entry({ bookId: 'a', position: 'cfi', progress: 0.5 })]
    expect(rememberPosition(shelf, 'a', 'cfi', 0.5)).toBe(shelf)
  })
})


/**
 * What a REOPEN may overwrite, and what it must not.
 *
 * The audit's worst finding, and the sharpest kind: reader tags exist as a
 * separate field precisely so a re-parse cannot erase them, and reopening the
 * book erased them anyway — one function away from the separation that was
 * supposed to protect them.
 */
describe('recordOpen keeps what the book cannot know about', () => {
  const fresh = (over: Partial<LibraryEntry> = {}) =>
    entry({ bookId: 'a', title: 'T', author: 'A', lastOpened: 2, ...over })

  const lived = [
    entry({
      bookId: 'a',
      lastOpened: 1,
      position: 'epubcfi(/6/4)',
      progress: 0.4,
      finished: true,
      tags: ['To reread'],
      vault: 'books/a.epub',
      cover: 'covers/a.jpg',
    }),
  ]

  it('keeps the reader own tags', () => {
    expect(recordOpen(lived, fresh())[0]?.tags).toEqual(['To reread'])
  })

  it('keeps the finished flag and the progress', () => {
    const [row] = recordOpen(lived, fresh())
    expect(row?.finished).toBe(true)
    expect(row?.progress).toBe(0.4)
  })

  it('keeps the vault path and the cover', () => {
    const [row] = recordOpen(lived, fresh())
    expect(row?.vault).toBe('books/a.epub')
    expect(row?.cover).toBe('covers/a.jpg')
  })

  /* The book IS the authority on its own metadata, so a re-parse must still
   * win there — otherwise a corrected OPF could never take effect. */
  it('still lets the book replace what the book declares', () => {
    const [row] = recordOpen(lived, fresh({ title: 'Corrected', subjects: ['New'] }))
    expect(row?.title).toBe('Corrected')
    expect(row?.subjects).toEqual(['New'])
  })
})

describe('applyLookup', () => {
  /* A lookup is a slow call against a row captured when the reader clicked. By
   * the time it answers the book may be gone — and `recordOpen` would have
   * recreated it. */
  it('does nothing for a book that has been removed', () => {
    const shelf = [entry({ bookId: 'a' })]
    expect(applyLookup(shelf, 'gone', { title: 'X' })).toBe(shelf)
  })

  it('does not reorder the shelf', () => {
    const shelf = [entry({ bookId: 'a' }), entry({ bookId: 'b' })]
    expect(applyLookup(shelf, 'b', { author: 'Found' }).map((e) => e.bookId)).toEqual(['a', 'b'])
  })

  it('fills only the fields it was given', () => {
    const shelf = [entry({ bookId: 'a', title: 'Keep', position: 'cfi' })]
    const [row] = applyLookup(shelf, 'a', { author: 'Melville' })
    expect(row?.title).toBe('Keep')
    expect(row?.author).toBe('Melville')
    expect(row?.position).toBe('cfi')
  })
})

/**
 * The store is a file on disk, so every field in it is untrusted.
 *
 * The row validator only ever checked the fields that existed when it was
 * written, so everything added since arrived unexamined — and a `subjects` that
 * is not an array of strings crashes the shelf the moment it renders.
 */
describe('parseLibrary validates the fields added since it was written', () => {
  const row = (over: Record<string, unknown>) =>
    JSON.stringify([
      { bookId: 'a', title: 'T', author: 'A', url: null, lastOpened: 1, position: null, ...over },
    ])

  it('drops a subjects list that is not a list of strings', () => {
    const [parsed] = parseLibrary(row({ subjects: 42 }))
    expect(parsed?.subjects).toBeUndefined()
  })

  it('drops the non-strings out of a mixed list', () => {
    const [parsed] = parseLibrary(row({ tags: ['ok', 7, null, 'fine'] }))
    expect(parsed?.tags).toEqual(['ok', 'fine'])
  })

  it('drops a non-finite number', () => {
    expect(parseLibrary(row({ progress: 'lots' }))[0]?.progress).toBeUndefined()
  })

  it('drops a non-boolean finished flag', () => {
    expect(parseLibrary(row({ finished: 'yes' }))[0]?.finished).toBeUndefined()
  })

  /* The crash this prevents: `matchesQuery` and `tagCounts` both call string
   * methods on whatever is in these lists. */
  it('leaves the shelf able to search a hostile row', () => {
    const [parsed] = parseLibrary(row({ subjects: [1, 2], series: 99 }))
    expect(() => matchesQuery(parsed!, 'anything')).not.toThrow()
    expect(() => tagCounts([parsed!])).not.toThrow()
  })
})

describe('isReopenable', () => {
  /* A DROPPED file has no path and no url, so it was marked never-reopenable at
   * the moment it was added — and stayed greyed out even after its vault copy
   * landed a second later. */
  it('counts Paper own copy', () => {
    expect(isReopenable(entry({ url: null, path: null, vault: 'books/a.epub' }))).toBe(true)
  })

  it('still counts a url or a path', () => {
    expect(isReopenable(entry({ url: '/a.epub', path: null }))).toBe(true)
    expect(isReopenable(entry({ url: null, path: '/books/a.epub' }))).toBe(true)
  })

  it('is false with none of the three', () => {
    expect(isReopenable(entry({ url: null, path: null }))).toBe(false)
  })
})


/**
 * `progress` off disk, which is a different trust boundary from `progress` on
 * the way in.
 *
 * `rememberPosition` clamps what it writes; this file can be edited, and a row
 * claiming `progress: 4` would draw a bar four times the width of its track.
 */
describe('parseLibrary clamps progress rather than only checking it', () => {
  const withProgress = (progress: unknown) =>
    JSON.stringify([
      {
        bookId: 'a',
        title: 'T',
        author: 'A',
        url: null,
        lastOpened: 1,
        position: null,
        progress,
      },
    ])

  it('holds an over-range value to the track', () => {
    expect(parseLibrary(withProgress(4))[0]?.progress).toBe(1)
    expect(parseLibrary(withProgress(-2))[0]?.progress).toBe(0)
  })

  it('keeps a sane value untouched', () => {
    expect(parseLibrary(withProgress(0.42))[0]?.progress).toBe(0.42)
  })

  it('drops one that is not a number at all', () => {
    expect(parseLibrary(withProgress('lots'))[0]?.progress).toBeUndefined()
  })
})


/**
 * A tag's identity, as opposed to its spelling.
 *
 * `Philosophy` and `philosophy` are one tag. They were two — with two counts and
 * two chips — which is a shelf telling a reader they have two subjects when they
 * have one, and nothing on screen able to explain it.
 */
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
    const composed = 'Caf\u00e9'
    const decomposed = 'Cafe\u0301'
    expect(composed).not.toBe(decomposed)
    expect(tagKey(composed)).toBe(tagKey(decomposed))
  })

  /* NFC before lowercasing, not after: lowercasing can change which
   * decompositions apply, so normalising second leaves the two forms of a
   * word folding to different keys. */
  it('folds composition and case together', () => {
    expect(tagKey('CAF\u00c9')).toBe(tagKey('cafe\u0301'))
  })
})

describe('tags fold rather than duplicate', () => {
  it('refuses a tag that differs only in case', () => {
    const shelf = tagBook([entry({ bookId: 'a' })], 'a', 'Philosophy')
    expect(tagBook(shelf, 'a', 'philosophy')).toBe(shelf)
    expect(tagBook(shelf, 'a', 'PHILOSOPHY')).toBe(shelf)
  })

  it('keeps the spelling the reader first used', () => {
    const shelf = tagBook([entry({ bookId: 'a' })], 'a', 'Philosophy')
    expect(shelf[0]?.tags).toEqual(['Philosophy'])
  })

  it('removes a tag whatever case it is clicked in', () => {
    const shelf = tagBook([entry({ bookId: 'a' })], 'a', 'Philosophy')
    expect(untagBook(shelf, 'a', 'philosophy')[0]?.tags).toEqual([])
  })

  /* A publisher's `philosophy` beside a reader's `Philosophy` would otherwise
   * appear as two subjects on one book. */
  it('does not show a declared subject that folds onto a reader tag', () => {
    const row = entry({ bookId: 'a', subjects: ['philosophy'], tags: ['Philosophy'] })
    expect(allTags(row)).toEqual(['Philosophy'])
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
    const shelf = [entry({ bookId: 'a', tags: ['Sea'], subjects: ['sea'] })]
    expect(tagCounts(shelf)).toEqual([{ tag: 'Sea', count: 1 }])
  })

  it('scopes by key, so a chip matches whatever case a book used', () => {
    const row = entry({ bookId: 'a', tags: ['philosophy'] })
    expect(inScope(row, { tags: ['Philosophy'] })).toBe(true)
  })
})
