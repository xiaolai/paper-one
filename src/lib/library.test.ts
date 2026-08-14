import { describe, expect, it } from 'vitest'
import { byRecency, forgetBook, parseLibrary, recordOpen, type LibraryEntry } from './library'

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

  it('lets a later open clear a URL that is no longer how the book is held', () => {
    // Read from a URL once and picked as a file since: it is not reopenable
    // now, and saying otherwise would give the switcher a row that fails.
    const before = [entry({ bookId: 'a', url: '/moby.epub' })]
    const after = recordOpen(before, entry({ bookId: 'a', url: null }))
    expect(after[0]?.url).toBeNull()
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

describe('forgetBook', () => {
  it('removes one book and leaves the rest', () => {
    const after = forgetBook([entry({ bookId: 'a' }), entry({ bookId: 'b' })], 'a')
    expect(after.map((e) => e.bookId)).toEqual(['b'])
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
