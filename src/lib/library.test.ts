import { describe, expect, it } from 'vitest'
import type { IndexedBook } from './bookIndex'
import {
  allTags,
  CANNOT_OPEN,
  byRecency,
  canOpen,
  inOrder,
  inScope,
  inTagOrder,
  matchesQuery,
  selectionTags,
  shelfFor,
  shelfView,
  sortTitle,
  splitTags,
  statusOf,
  tagCounts,
  tagKey,
  tagSuggestions,
  untaggedCount,
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
  /* `toLowerCase` is not case folding: ß reaches ss only through its
   * uppercase form, so `Straße` and `STRASSE` were two tags. And capital ẞ
   * has to be lowered FIRST or it never takes that road at all. */
  it('folds case the Unicode way, not the ASCII way', () => {
    expect(tagKey('Straße')).toBe(tagKey('STRASSE'))
    expect(tagKey('STRAẞE')).toBe(tagKey('STRASSE'))
    expect(tagKey('ẞ')).toBe(tagKey('ss'))
  })

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

  /* The query goes through the same fold tag identity uses: a decomposed
   * `café` typed on macOS must find the composed one in a title. */
  it('matches across Unicode composition', () => {
    const composed = entry({ title: 'Café Society' })
    expect(matchesQuery(composed, 'café')).toBe(true)
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

  /* `-tag:` — none of these, whoever said it. */
  describe('excluded', () => {
    it('keeps a book carrying an excluded tag out', () => {
      expect(inScope(entry({ tags: ['Abandoned'] }), { tags: [], excluded: ['abandoned'] })).toBe(false)
    })
    it('lets a book without it through', () => {
      expect(inScope(entry({ tags: ['Sea'] }), { tags: [], excluded: ['Abandoned'] })).toBe(true)
    })
    it('excludes on a publisher subject as readily as a reader tag', () => {
      expect(inScope(entry({ subjects: ['Poetry'] }), { tags: [], excluded: ['poetry'] })).toBe(false)
    })
    it('composes with a required tag', () => {
      const scope = { tags: ['Sea'], excluded: ['Abandoned'] }
      expect(inScope(entry({ tags: ['Sea'] }), scope)).toBe(true)
      expect(inScope(entry({ tags: ['Sea', 'Abandoned'] }), scope)).toBe(false)
      expect(inScope(entry({ tags: ['Classics'] }), scope)).toBe(false)
    })
  })

  /* `is:untagged` — none of the READER's tags. A publisher's subjects do not
   * make a book filed. */
  describe('untagged', () => {
    it('lets through a book the reader has not tagged', () => {
      expect(inScope(entry(), { tags: [], untagged: true })).toBe(true)
      expect(inScope(entry({ tags: [] }), { tags: [], untagged: true })).toBe(true)
    })
    it('keeps out a book with any tag of the reader\'s', () => {
      expect(inScope(entry({ tags: ['Sea'] }), { tags: [], untagged: true })).toBe(false)
    })
    it('does not count a publisher subject as filing', () => {
      expect(inScope(entry({ subjects: ['Fiction', 'Sea'] }), { tags: [], untagged: true })).toBe(true)
    })
    it('composes with a status', () => {
      const scope = { tags: [], untagged: true, status: 'reading' as const }
      expect(inScope(entry({ position: 'x' }), scope)).toBe(true)
      expect(inScope(entry(), scope)).toBe(false)
    })
  })
})

describe('untaggedCount', () => {
  const shelf = [
    entry({ bookId: 'a', tags: ['Sea'] }),
    entry({ bookId: 'b', subjects: ['Fiction'] }),
    entry({ bookId: 'c' }),
    entry({ bookId: 'd', tags: ['Sea'], position: 'x' }),
    entry({ bookId: 'e', position: 'x' }),
  ]
  it('counts books with none of the reader\'s tags', () => {
    expect(untaggedCount(shelf)).toBe(3)
  })
  it('counts within the scope it is given', () => {
    expect(untaggedCount(shelf, { tags: [], status: 'reading' })).toBe(1)
  })

  /* A whitespace tag has no identity: it draws no chip anywhere, so the book
   * carrying only it must still read as untagged — or it can never be found. */
  it('ignores a tag that folds to nothing', () => {
    expect(untaggedCount([entry({ tags: ['  '] })])).toBe(1)
    expect(inScope(entry({ tags: ['  '] }), { tags: [], untagged: true })).toBe(true)
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
      { tag: 'Philosophy', count: 2, mine: false },
      { tag: 'Ethics', count: 1, mine: false },
    ])
  })

  it('counts folded variants as one tag, shown once', () => {
    const shelf = [
      entry({ bookId: 'a', tags: ['Philosophy'] }),
      entry({ bookId: 'b', tags: ['philosophy'] }),
      entry({ bookId: 'c', subjects: ['PHILOSOPHY'] }),
    ]
    expect(tagCounts(shelf)).toEqual([{ tag: 'Philosophy', count: 3, mine: true }])
  })

  /* One book carrying the tag under both provenances must not count twice. */
  it('counts a book once even when both lists carry the tag', () => {
    expect(tagCounts([entry({ tags: ['Sea'], subjects: ['sea'] })])).toEqual([
      { tag: 'Sea', count: 1, mine: true },
    ])
  })

  /* `mine` is what decides whether the Library panel offers to rename or
   * remove a tag. A publisher's subject is a fact about the book and comes
   * back on re-parse — not the reader's to edit. A tag that is BOTH is
   * editable, because the reader's copy is real; the publisher's stays. */
  describe('mine — whether the reader can change it', () => {
    it('is false for a tag that is only a publisher subject', () => {
      const [t] = tagCounts([entry({ subjects: ['Fiction'] })])
      expect(t?.mine).toBe(false)
    })
    it('is true for a tag the reader wrote', () => {
      const [t] = tagCounts([entry({ tags: ['Fiction'] })])
      expect(t?.mine).toBe(true)
    })
    it('is true across the shelf if ANY book carries it as the reader\'s own', () => {
      const shelf = [entry({ bookId: 'a', subjects: ['Fiction'] }), entry({ bookId: 'b', tags: ['fiction'] })]
      const [t] = tagCounts(shelf)
      expect(t).toMatchObject({ count: 2, mine: true })
    })
    it('is true for a tag that is both the reader\'s and the publisher\'s on one book', () => {
      const [t] = tagCounts([entry({ tags: ['Sea'], subjects: ['sea'] })])
      expect(t?.mine).toBe(true)
    })
  })

  it('counts within the scope it is given', () => {
    const shelf = [
      entry({ bookId: 'a', tags: ['Philosophy', 'Ethics'] }),
      entry({ bookId: 'b', tags: ['Poetry'] }),
    ]
    expect(tagCounts(shelf, { tags: ['Ethics'] })).toEqual([
      { tag: 'Ethics', count: 1, mine: true },
      { tag: 'Philosophy', count: 1, mine: true },
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

/* The editor's field: what one Enter means. */
describe('splitTags', () => {
  it('is one tag for one word', () => {
    expect(splitTags('Sea')).toEqual(['Sea'])
  })
  it('splits on commas and trims each piece', () => {
    expect(splitTags(' Sea , Classics ,To reread')).toEqual(['Sea', 'Classics', 'To reread'])
  })
  it('drops empties, so a trailing comma asks for nothing extra', () => {
    expect(splitTags('Sea,')).toEqual(['Sea'])
    expect(splitTags(', ,')).toEqual([])
  })
  it('folds pieces that are one tag', () => {
    expect(splitTags('Sea, sea, SEA')).toEqual(['Sea'])
  })
  it('cuts each piece the way the store will', () => {
    const long = 'x'.repeat(80)
    expect(splitTags(long)[0]).toHaveLength(60)
  })

  /* The cut counts CODE POINTS: sixty emoji are sixty characters, and the
   * sixtieth must not be half a surrogate pair. */
  it('does not cut through a surrogate pair', () => {
    const emoji = '📚'.repeat(70)
    const cut = splitTags(emoji)[0]!
    expect([...cut]).toHaveLength(60)
    expect(cut.at(-1)).not.toMatch(/[\uD800-\uDBFF]$/)
  })
})

describe('tagSuggestions', () => {
  const all = [
    { tag: 'Sea', count: 12, mine: true },
    { tag: 'Seafaring', count: 2, mine: false },
    { tag: 'Philosophy', count: 9, mine: true },
    { tag: 'Deep sea', count: 3, mine: true },
    { tag: 'Fiction', count: 40, mine: false },
  ]
  const none = new Set<string>()

  it('offers the most used tags when nothing is typed', () => {
    const { rows } = tagSuggestions(all, '', none)
    expect(rows.map((r) => r.tag)).toEqual(['Sea', 'Philosophy', 'Deep sea', 'Fiction', 'Seafaring'])
  })

  /* Starts-with before contains; the reader's own before a subject; then count. */
  it('ranks a tag starting with the text above one containing it', () => {
    const { rows } = tagSuggestions(all, 'sea', none)
    expect(rows.map((r) => r.tag)).toEqual(['Sea', 'Seafaring', 'Deep sea'])
  })

  /* A finished name is a pick, not a prefix: Enter goes to row 0, so the
   * exact match must sit there even when a longer tag is better used. */
  it('puts the exact match first whatever the counts say', () => {
    const rows = tagSuggestions(
      [
        { tag: 'Seafaring', count: 40, mine: true },
        { tag: 'Sea', count: 1, mine: false },
      ],
      'sea',
      none,
    ).rows
    expect(rows[0]?.tag).toBe('Sea')
  })

  it('matches by key, so case and accents do not hide a tag', () => {
    const rows = tagSuggestions([{ tag: 'Café', count: 1, mine: true }], 'café', none).rows
    expect(rows.map((r) => r.tag)).toEqual(['Café'])
  })

  it('leaves out what the book already carries', () => {
    const { rows } = tagSuggestions(all, 'sea', new Set(['sea']))
    expect(rows.map((r) => r.tag)).toEqual(['Seafaring', 'Deep sea'])
  })

  it('says whether what was typed already exists', () => {
    expect(tagSuggestions(all, 'sea', none).exact).toBe(true)
    expect(tagSuggestions(all, 'Sea ', none).exact).toBe(true)
    expect(tagSuggestions(all, 'Seas', none).exact).toBe(false)
  })

  /* Already on the book is not "exists to be picked" — the field should offer
   * neither to add it nor to create it. */
  it('does not count a tag already on the book as exact', () => {
    expect(tagSuggestions(all, 'sea', new Set(['sea'])).exact).toBe(false)
  })

  it('caps the list', () => {
    expect(tagSuggestions(all, '', none, 2).rows).toHaveLength(2)
  })
})

describe('selectionTags', () => {
  it('unions the reader\'s tags with how many books carry each', () => {
    const rows = selectionTags([
      entry({ bookId: 'a', tags: ['Sea', 'Classics'] }),
      entry({ bookId: 'b', tags: ['sea'] }),
      entry({ bookId: 'c', subjects: ['Sea'] }),
    ])
    expect(rows).toEqual([
      { tag: 'Sea', count: 2 },
      { tag: 'Classics', count: 1 },
    ])
  })
  it('leaves publisher subjects out — they are not the reader\'s to edit', () => {
    expect(selectionTags([entry({ subjects: ['Fiction'] })])).toEqual([])
  })
})

describe('inTagOrder', () => {
  const rows = [
    { tag: 'Sea', count: 12, mine: true },
    { tag: 'émile', count: 3, mine: true },
    { tag: 'Classics', count: 3, mine: true },
  ]
  it('leaves the count order as it came', () => {
    expect(inTagOrder(rows, 'count').map((r) => r.tag)).toEqual(['Sea', 'émile', 'Classics'])
  })
  it('sorts by name the way a reader files, accents included', () => {
    expect(inTagOrder(rows, 'name').map((r) => r.tag)).toEqual(['Classics', 'émile', 'Sea'])
  })
})
