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
  forgetBook,
  inScope,
  tagBook,
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
    expect(inScope(entry({ subjects: ['Ethics'] }), { label: 'Ethics', tag: 'Ethics' })).toBe(true)
    expect(inScope(entry({ subjects: ['Poetry'] }), { label: 'Ethics', tag: 'Ethics' })).toBe(false)
  })

  it('restricts to a series', () => {
    const scope = { label: 'Discworld', series: 'Discworld' }
    expect(inScope(entry({ series: 'Discworld' }), scope)).toBe(true)
    expect(inScope(entry({ series: 'Dune' }), scope)).toBe(false)
  })
})

describe('shelfView', () => {
  const shelf = [
    entry({ bookId: 'a', title: 'Ethics', subjects: ['Philosophy'], lastOpened: 3 }),
    entry({ bookId: 'b', title: 'Poems', subjects: ['Poetry'], lastOpened: 2 }),
    entry({ bookId: 'c', title: 'Ethics II', subjects: ['Philosophy'], lastOpened: 1 }),
  ]

  it('applies the scope before the query, so a search stays inside it', () => {
    const view = shelfView(shelf, { scope: { label: 'Poetry', tag: 'Poetry' }, query: 'ethics' })
    expect(view).toEqual([])
  })

  it('orders what survived, not the whole library', () => {
    const view = shelfView(shelf, { scope: { label: 'Philosophy', tag: 'Philosophy' }, order: 'title' })
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
    expect(tagCounts(shelf, { label: 'Ethics', tag: 'Ethics' })).toEqual([
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
