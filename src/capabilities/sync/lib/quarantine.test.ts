import { describe, expect, it } from 'vitest'
import { EMPTY_QUARANTINE, QUARANTINE_CAP, SYNC_QUARANTINE_SETTING, quarantineFor, release, setAside } from './quarantine'

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

  it('reads a persisted list with one entry per book, newest kept, and counts what the cap drops', () => {
    /* Two audit findings on the parser, one case: a duplicated id on disk
     * meant two re-fetches and a repaired count of two for one book; and a
     * list past the cap was trimmed silently, against the file's own
     * "dropped and counted" rule. */
    const parse = SYNC_QUARANTINE_SETTING.parse
    expect(parse({ peerId: 'p', books: ['a', 'b', 'a'], dropped: 0 })).toEqual({ peerId: 'p', books: ['b', 'a'], dropped: 0 })
    const many = Array.from({ length: QUARANTINE_CAP + 3 }, (_, i) => `book:${i}`)
    const held = parse({ peerId: 'p', books: many, dropped: 2 })
    expect(held?.books.length).toBe(QUARANTINE_CAP)
    expect(held?.books[0]).toBe('book:3')
    expect(held?.dropped).toBe(5)
    // A count past the safe range is refused, not carried into arithmetic.
    expect(parse({ peerId: 'p', books: [], dropped: Number.MAX_SAFE_INTEGER + 2 })).toBeUndefined()
  })

  it('belongs to one shelf: a list held for another peer is not this peer’s list', () => {
    const theirs = setAside(quarantineFor(EMPTY_QUARANTINE, 'shelf-1'), 'book:a')
    const mine = quarantineFor(theirs, 'shelf-2')
    expect(mine).toEqual({ peerId: 'shelf-2', books: [], dropped: 0 })
    // The same peer keeps what it held.
    expect(quarantineFor(theirs, 'shelf-1')).toBe(theirs)
  })
})
