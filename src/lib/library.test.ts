import { describe, expect, it } from 'vitest'
import { byRecency, parseLibrary, recordOpen, type LibraryEntry } from './library'

function entry(over: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    bookId: 'url:/moby.epub',
    title: 'Moby-Dick',
    author: 'Herman Melville',
    url: '/moby.epub',
    lastOpened: 1000,
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
})
