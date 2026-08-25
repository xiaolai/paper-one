import { describe, expect, it, vi } from 'vitest'
import { readingPositions, type PositionStore } from './positions'

/**
 * Where a reader stopped.
 *
 * Everything asserted here is a way for this to lose a position quietly, which
 * is the only way it can fail: a lost position is a book that reopens at page
 * one, and a reader who does not know why. The module's contract is that a
 * failure loses a POSITION and never a book, so most of these are about
 * refusing to throw.
 */

/** A store a test drives, with an optional way to make it fail. */
function fakeStore(seed: string | null = null, fail: 'read' | 'write' | null = null) {
  let held = seed
  const store: PositionStore = {
    getItem: () => {
      if (fail === 'read') throw new Error('storage is blocked')
      return held
    },
    setItem: (_key, value) => {
      if (fail === 'write') throw new Error('quota exceeded')
      held = value
    },
  }
  return { store, held: () => held }
}

describe('readingPositions', () => {
  it('remembers where a book was left and gives it back', () => {
    const { store } = fakeStore()
    const positions = readingPositions(store)
    expect(positions.get('one')).toBeNull()
    positions.set('one', 'epubcfi(/6/4!/4/2/10)')
    expect(positions.get('one')).toBe('epubcfi(/6/4!/4/2/10)')
  })

  it('keeps books apart', () => {
    const { store } = fakeStore()
    const positions = readingPositions(store)
    positions.set('one', 'cfi-one')
    positions.set('two', 'cfi-two')
    expect(positions.get('one')).toBe('cfi-one')
    expect(positions.get('two')).toBe('cfi-two')
  })

  /* A NULL CFI IS NOT A POSITION. The fixed-layout renderer reports one for
     some documents, and storing it would replace a good position with nothing —
     so the previous one has to stand. */
  it('does not let a null or empty cfi erase a good position', () => {
    const { store } = fakeStore()
    const positions = readingPositions(store)
    positions.set('one', 'a-real-cfi')
    positions.set('one', null)
    positions.set('one', '')
    expect(positions.get('one')).toBe('a-real-cfi')
  })

  it('forgets a book, and forgetting one it does not have is not an error', () => {
    const { store } = fakeStore()
    const positions = readingPositions(store)
    positions.set('one', 'cfi-one')
    positions.forget('one')
    expect(positions.get('one')).toBeNull()
    expect(() => positions.forget('never-there')).not.toThrow()
  })

  /* NOT A WRITE PER PAGE TURN of the same page. `onRelocate` fires on every
     turn and on resize; rewriting the same value still costs a JSON round trip
     and a synchronous storage write, on the frame a reader is turning a page. */
  it('does not write when the position has not moved', () => {
    const setItem = vi.fn()
    let held: string | null = null
    const store: PositionStore = {
      getItem: () => held,
      setItem: (_k, v) => {
        held = v
        setItem(v)
      },
    }
    const positions = readingPositions(store)
    positions.set('one', 'same')
    positions.set('one', 'same')
    positions.set('one', 'same')
    expect(setItem).toHaveBeenCalledOnce()
  })

  describe('failing soft', () => {
    /* A LOST POSITION IS NOT A LOST BOOK. Storage throws on a full quota, in
       private browsing, and whenever a reader has blocked site data. */
    it('answers nothing when the store cannot be read', () => {
      const { store } = fakeStore('{}', 'read')
      const positions = readingPositions(store)
      expect(positions.get('one')).toBeNull()
      expect(() => positions.set('one', 'cfi')).not.toThrow()
    })

    it('does not throw when the store is full', () => {
      const { store } = fakeStore(null, 'write')
      const positions = readingPositions(store)
      expect(() => positions.set('one', 'cfi')).not.toThrow()
      expect(positions.get('one')).toBeNull()
    })

    it('reads a corrupt store as empty rather than repairing it', () => {
      /* NOT CLEARED. A store this cannot parse may belong to something else;
         overwriting it would be this module deciding that. */
      const { store, held } = fakeStore('not json at all')
      const positions = readingPositions(store)
      expect(positions.get('one')).toBeNull()
      expect(held()).toBe('not json at all')
    })

    it('ignores rows that are not positions', () => {
      const { store } = fakeStore(
        JSON.stringify({
          good: { cfi: 'a-cfi', at: 1 },
          noCfi: { at: 2 },
          emptyCfi: { cfi: '', at: 3 },
          notAnObject: 'nonsense',
        }),
      )
      const positions = readingPositions(store)
      expect(positions.get('good')).toBe('a-cfi')
      /* A ROW WITHOUT A CFI WOULD SEND A READER TO THE START while claiming to
         restore them, which is worse than saying nothing. */
      expect(positions.get('noCfi')).toBeNull()
      expect(positions.get('emptyCfi')).toBeNull()
      expect(positions.get('notAnObject')).toBeNull()
    })

    it('survives a store holding an array or a bare value', () => {
      for (const raw of ['[]', '42', '"a string"', 'null']) {
        const { store } = fakeStore(raw)
        expect(readingPositions(store).get('one')).toBeNull()
      }
    })
  })

  /**
   * THE CAP, AND WHICH BOOK LOSES ITS PLACE.
   *
   * An unbounded store has no worst case, and a quota error is silent and
   * permanent once reached. Least-recently-read is the honest order to drop in:
   * a book nobody has opened in five hundred books' time is one whose position
   * nobody is about to want.
   */
  it('keeps the most recently read and drops the oldest', () => {
    const { store } = fakeStore()
    let clock = 0
    const positions = readingPositions(store, () => ++clock)

    for (let i = 0; i < 520; i += 1) positions.set(`book-${i}`, `cfi-${i}`)

    /* The oldest are gone and the newest are not. */
    expect(positions.get('book-0')).toBeNull()
    expect(positions.get('book-19')).toBeNull()
    expect(positions.get('book-519')).toBe('cfi-519')
    expect(positions.get('book-20')).toBe('cfi-20')
  })

  /* RE-READING A BOOK MOVES IT BACK TO THE FRONT of the eviction order, or the
     cap would drop the book a reader is actually reading. */
  it('re-reading an old book saves it from eviction', () => {
    const { store } = fakeStore()
    let clock = 0
    const positions = readingPositions(store, () => ++clock)

    positions.set('favourite', 'cfi-old')
    for (let i = 0; i < 400; i += 1) positions.set(`book-${i}`, `cfi-${i}`)
    positions.set('favourite', 'cfi-new')
    for (let i = 400; i < 600; i += 1) positions.set(`book-${i}`, `cfi-${i}`)

    expect(positions.get('favourite')).toBe('cfi-new')
  })
})
