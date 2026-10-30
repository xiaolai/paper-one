import { describe, expect, it } from 'vitest'
import { legacyBookIdFor, rekeyBook } from './idMigration'
import { bookIdFor } from './marks'

describe('legacyBookIdFor', () => {
  it('reproduces the scheme the stored rows were written under', async () => {
    // Both shapes the old implementation produced.
    expect(await legacyBookIdFor('/sample.epub')).toBe('url:/sample.epub')
    expect(await legacyBookIdFor(new File(['abcd'], 'x.epub'))).toMatch(/^file:[0-9a-f]{32}$/)
  })

  /* The whole reason a migration is needed. If these ever agreed there would be
   * nothing to move — and if this test starts failing because the two happen to
   * match, the migration has silently become a no-op. */
  it('does not agree with the current scheme', async () => {
    const file = new File(['abcd'], 'x.epub')
    expect(await legacyBookIdFor(file)).not.toBe(await bookIdFor(file))
    expect(await legacyBookIdFor('/sample.epub')).not.toMatch(/^book:/)
  })

  /* It is a COPY of the old code, not a call into the new one. If someone
   * "tidies" it by delegating to `bookIdFor`, this fails. */
  it('is pinned to the old algorithm rather than following the new one', async () => {
    const same = new File(['abcd'], 'x.epub')
    const legacy = await legacyBookIdFor(same)
    expect(legacy.startsWith('file:')).toBe(true)
    expect(legacy.startsWith('book:')).toBe(false)
  })
})

describe('rekeyBook', () => {
  const rows = [
    { id: '1', bookId: 'file:old' },
    { id: '2', bookId: 'file:old' },
    { id: '3', bookId: 'file:other' },
  ]

  it('moves every row belonging to the book, and no others', () => {
    const moved = rekeyBook(rows, 'file:old', 'book:new')
    expect(moved.map((r) => r.bookId)).toEqual(['book:new', 'book:new', 'file:other'])
    expect(moved.map((r) => r.id)).toEqual(['1', '2', '3'])
  })

  /* Returned by identity, because this runs on EVERY open and all but the first
   * find nothing. A fresh array each time would re-render and re-persist the
   * whole store for a migration that already happened. */
  it('returns the same list when there is nothing to move', () => {
    expect(rekeyBook(rows, 'file:absent', 'book:new')).toBe(rows)
    expect(rekeyBook(rows, 'book:new', 'book:new')).toBe(rows)
    expect(rekeyBook([], 'file:old', 'book:new')).toEqual([])
  })

  it('does not mutate what it was given', () => {
    const before = rows.map((r) => ({ ...r }))
    rekeyBook(rows, 'file:old', 'book:new')
    expect(rows).toEqual(before)
  })
})
