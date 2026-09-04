import { describe, expect, it, vi } from 'vitest'
import { fakeFs } from './fakeFs.testkit'
import { MAX_COVER_BYTES, createCoverFactsPass, measureCover, publishableCover } from './coverFacts'
import type { BookRecord } from './bookFolder'

const port = (size = 12) => ({ hashFile: vi.fn((_folder: string, _name: string) => Promise.resolve({ blake3: 'ab'.repeat(32), size })) })

describe('measuring a jacket — WI-23.C5', () => {
  it('hashes cover.jpg by the folder’s segment, falls back to the legacy name, and answers null with no jacket', async () => {
    const hashes = port()
    expect(await measureCover(fakeFs({ 'books/book_a/cover.jpg': 'j' }), hashes, 'book:a')).toEqual({ name: 'cover.jpg', size: 12, hash: 'ab'.repeat(32) })
    expect(hashes.hashFile).toHaveBeenCalledWith('book_a', 'cover.jpg')
    expect(await measureCover(fakeFs({ 'books/book_a/cover.webp': 'j' }), hashes, 'book:a')).toMatchObject({ name: 'cover.webp' })
    expect(await measureCover(fakeFs(), hashes, 'book:a')).toBeNull()
  })

  it('is publishable only when measured and within the bound', () => {
    expect(publishableCover({})).toBeUndefined()
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: MAX_COVER_BYTES, hash: 'ab'.repeat(32) } })).toBe('ab'.repeat(32))
    expect(publishableCover({ coverFacts: { name: 'cover.jpg', size: MAX_COVER_BYTES + 1, hash: 'ab'.repeat(32) } })).toBeUndefined()
  })
})

describe('the pass over the library', () => {
  function world(files: Record<string, string>, rows: readonly { bookId: string; coverFacts?: BookRecord['coverFacts'] }[], hashes: ReturnType<typeof port> | null = port()) {
    const held: { bookId: string; coverFacts?: NonNullable<BookRecord['coverFacts']> }[] = rows.map((row) => (row.coverFacts ? { bookId: row.bookId, coverFacts: row.coverFacts } : { bookId: row.bookId }))
    const update = vi.fn(async (bookId: string, change: (record: BookRecord) => BookRecord) => {
      const at = held.findIndex((row) => row.bookId === bookId)
      held[at] = change(held[at] as unknown as BookRecord) as unknown as (typeof held)[number]
    })
    const pass = createCoverFactsPass({ fs: fakeFs(files), library: { getSnapshot: () => held, update }, hashes: () => hashes, batch: 2 })
    return { pass, held, update, hashes }
  }

  it('stamps a batch of unmeasured jackets, leaves the measured alone, and converges to nothing', async () => {
    const w = world(
      { 'books/book_a/cover.jpg': 'a', 'books/book_b/cover.jpg': 'b', 'books/book_c/cover.webp': 'c', 'books/book_d/cover.jpg': 'd' },
      [{ bookId: 'book:a' }, { bookId: 'book:b' }, { bookId: 'book:c' }, { bookId: 'book:d', coverFacts: { name: 'cover.jpg', size: 1, hash: 'ff'.repeat(32) } }],
    )
    expect(await w.pass.runOnce()).toBe(2)
    expect(await w.pass.runOnce()).toBe(1)
    expect(await w.pass.runOnce()).toBe(0)
    expect(w.held.map((row) => row.coverFacts?.name)).toEqual(['cover.jpg', 'cover.jpg', 'cover.webp', 'cover.jpg'])
    /* The measured one was never re-hashed. */
    expect(w.hashes!.hashFile).toHaveBeenCalledTimes(3)
  })

  it('does not look twice at a book with no jacket, nor at one the port refused', async () => {
    const hashes = port()
    hashes.hashFile.mockRejectedValueOnce(new Error('unreadable'))
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }, { bookId: 'book:none' }], hashes)
    expect(await w.pass.runOnce()).toBe(0)
    expect(await w.pass.runOnce()).toBe(0)
    expect(hashes.hashFile).toHaveBeenCalledTimes(1)
    expect(w.update).not.toHaveBeenCalled()
  })

  it('does nothing without a port, and keeps a stamp another writer made first', async () => {
    const w = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }], null)
    expect(await w.pass.runOnce()).toBe(0)
    const raced = world({ 'books/book_a/cover.jpg': 'a' }, [{ bookId: 'book:a' }])
    /* The record already holds facts by the time the update lands: the pass yields to them. */
    raced.update.mockImplementationOnce(async (_bookId, change) => {
      const already = { bookId: 'book:a', coverFacts: { name: 'cover.jpg' as const, size: 5, hash: 'cd'.repeat(32) } } as unknown as BookRecord
      expect(change(already)).toBe(already)
    })
    expect(await raced.pass.runOnce()).toBe(1)
  })
})

describe('the pass, held to the letter', () => {
  it('serves a jacket of exactly one mebibyte and no more', () => {
    expect(MAX_COVER_BYTES).toBe(1_048_576)
  })

  it('does not look at the disk without a port, and does not look twice at a book found without a jacket', async () => {
    const exists = vi.fn(() => Promise.resolve(false))
    const rows = [{ bookId: 'book:none' }]
    const idle = createCoverFactsPass({ fs: { exists }, library: { getSnapshot: () => rows, update: vi.fn() }, hashes: () => null })
    expect(await idle.runOnce()).toBe(0)
    expect(exists).not.toHaveBeenCalled()
    const pass = createCoverFactsPass({ fs: { exists }, library: { getSnapshot: () => rows, update: vi.fn() }, hashes: () => port() })
    expect(await pass.runOnce()).toBe(0)
    const looked = exists.mock.calls.length
    expect(looked).toBeGreaterThan(0)
    expect(await pass.runOnce()).toBe(0)
    expect(exists).toHaveBeenCalledTimes(looked)
  })
})
