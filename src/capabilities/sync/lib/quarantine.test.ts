import { describe, expect, it } from 'vitest'
import { EMPTY_QUARANTINE, QUARANTINE_CAP, quarantineFor, release, setAside } from './quarantine'

/**
 * WI-20.25 — the pull side's quarantine: the books whose marks answer would
 * not validate, kept per shelf, re-fetched every session, and BOUNDED so a
 * faulty or hostile peer cannot grow it or the per-session work without limit.
 */
describe('the marks quarantine', () => {
  it('holds a book once, newest last, and releases it by name', () => {
    let held = quarantineFor(EMPTY_QUARANTINE, 'shelf-1')
    held = setAside(held, 'book:a')
    held = setAside(held, 'book:b')
    held = setAside(held, 'book:a')
    expect(held.books).toEqual(['book:b', 'book:a'])
    expect(held.dropped).toBe(0)
    held = release(held, 'book:b')
    expect(held.books).toEqual(['book:a'])
    // Releasing a book that was never held changes nothing.
    expect(release(held, 'book:zz')).toBe(held)
  })

  it('is bounded: ten thousand distinct books leave sixty-four, the oldest dropped and counted', () => {
    let held = quarantineFor(EMPTY_QUARANTINE, 'shelf-1')
    for (let i = 0; i < 10_000; i += 1) held = setAside(held, `book:${i}`)
    expect(held.books.length).toBe(QUARANTINE_CAP)
    expect(held.dropped).toBe(10_000 - QUARANTINE_CAP)
    // The newest survive; the oldest went.
    expect(held.books[0]).toBe(`book:${10_000 - QUARANTINE_CAP}`)
    expect(held.books.at(-1)).toBe('book:9999')
  })

  it('belongs to one shelf: a list held for another peer is not this peer’s list', () => {
    const theirs = setAside(quarantineFor(EMPTY_QUARANTINE, 'shelf-1'), 'book:a')
    const mine = quarantineFor(theirs, 'shelf-2')
    expect(mine).toEqual({ peerId: 'shelf-2', books: [], dropped: 0 })
    // The same peer keeps what it held.
    expect(quarantineFor(theirs, 'shelf-1')).toBe(theirs)
  })
})
