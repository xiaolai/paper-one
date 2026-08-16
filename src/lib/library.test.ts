import { describe, expect, it } from 'vitest'
import {
  byRecency,
  parseLibrary,
  recordOpen,
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
