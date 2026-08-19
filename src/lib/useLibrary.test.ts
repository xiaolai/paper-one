import { describe, expect, it } from 'vitest'
import { asRow } from './useLibrary'

/**
 * The one pure decision in `useLibrary` with a launch riding on it.
 *
 * `hasContent` is derived by the scan and is not a field of `BookRecord`, so
 * every row rebuilt from a record has lost it unless `asRow` is handed it
 * back. `loadShelf` refuses to trust an index in which any row lacks the flag
 * — so a single flagless row, which every `add` used to produce, turned the
 * cache off for the next launch and made opening a fresh library pay a full
 * folder-by-folder scan every single time.
 */
describe('asRow', () => {
  const record = { title: 'Moby-Dick', author: 'Melville' }

  it('carries the flag it is handed', () => {
    expect(asRow(record, 'book_a', true).hasContent).toBe(true)
    expect(asRow(record, 'book_a', false).hasContent).toBe(false)
  })

  /* Carries knowledge, does not invent any: a row that was never measured
   * stays unmeasured, rather than guessing a value the folder might contradict. */
  it('adds nothing when the flag was never derived', () => {
    expect(asRow(record, 'book_a', undefined)).not.toHaveProperty('hasContent')
  })

  it('stamps the id over whatever the record claims', () => {
    expect(asRow({ ...record, bookId: 'stale' }, 'book_a', true).bookId).toBe('book_a')
  })

  /* The flag is the ROW's, never the record's: were it spread in from a record
   * it would be one write away from landing inside `book.json`, which is the
   * stored-flag disagreement `bookIndex` exists to rule out. */
  it('takes the flag only from its own argument', () => {
    const smuggled = { ...record, hasContent: true } as typeof record
    expect(asRow(smuggled, 'book_a', false).hasContent).toBe(false)
  })
})
