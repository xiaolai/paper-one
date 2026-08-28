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

  /**
   * RE-OPENING AT THE SAME PLACE IS ALSO READING IT.
   *
   * The test above changes the cfi, so it exercises "moved recently" and not
   * "read recently" — and `set` used to return early when the cfi matched,
   * without touching `at`. A reader who opens a favourite, reads a page and
   * comes back to the same line reports the same cfi every time, so the book
   * they had open kept the timestamp of the last time they turned a page in it,
   * aged past the cap, and was evicted out from under them.
   *
   * Same cfi, deliberately. That is the whole difference from the case above.
   */
  it('re-opening a book at the SAME place saves it from eviction too', () => {
    const { store } = fakeStore()
    let clock = 0
    const positions = readingPositions(store, () => ++clock)

    positions.set('favourite', 'cfi-same')
    for (let i = 0; i < 400; i += 1) positions.set(`book-${i}`, `cfi-${i}`)
    /* `touch`, not `set` — the reader opened it and has not moved yet, which is
       exactly the case `set` cannot see. */
    positions.touch('favourite')
    for (let i = 400; i < 600; i += 1) positions.set(`book-${i}`, `cfi-${i}`)

    expect(positions.get('favourite')).toBe('cfi-same')
  })

  it('touching a book it has never seen writes nothing', () => {
    /* Opening a book for the first time is `set`'s job: there is no position to
       refresh, and inventing one would put a row with no cfi in the store. */
    const setItem = vi.fn()
    let held: string | null = null
    const store: PositionStore = {
      getItem: () => held,
      setItem: (_k, v) => {
        held = v
        setItem(v)
      },
    }
    readingPositions(store).touch('never-opened')
    expect(setItem).not.toHaveBeenCalled()
  })

  /**
   * A BOOK ID IS A KEY FROM STORAGE, AND STORAGE IS NOT TRUSTED INPUT.
   *
   * `JSON.parse` makes `__proto__` a real own property — it does not invoke the
   * setter. Assigning it onto a plain `{}` a moment later DOES: the map's
   * prototype is replaced and the key becomes non-own. `Object.entries` in
   * `write` then cannot see it, so the row is silently dropped the next time
   * anything else is written, while `get` keeps answering from the prototype
   * until then. A position that reads back correctly and vanishes on the next
   * unrelated write is the worst shape this could take.
   *
   * The round trip is the assertion, not the reading: reading alone passes
   * either way, which is what makes this worth writing down.
   */
  describe('a book id that collides with an object\'s own machinery', () => {
    for (const hostile of ['__proto__', 'constructor', 'toString']) {
      it(`keeps a position stored under "${hostile}" across a later write`, () => {
        const { store } = fakeStore(
          `{"${hostile}":{"cfi":"cfi-hostile","at":1},"real":{"cfi":"cfi-real","at":2}}`,
        )
        const positions = readingPositions(store, () => 3)

        expect(positions.get(hostile)).toBe('cfi-hostile')
        /* An unrelated write is what re-serialises the map. */
        positions.set('another', 'cfi-another')
        expect(positions.get(hostile), `${hostile} must survive a re-serialisation`).toBe('cfi-hostile')
        expect(positions.get('real')).toBe('cfi-real')
      })
    }

    it('answers null for inherited names nothing ever stored', () => {
      const { store } = fakeStore()
      const positions = readingPositions(store)
      for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        expect(positions.get(name), `${name} is not a stored position`).toBeNull()
      }
    })
  })
})

describe('held', () => {
  it('answers the position with the clock it was written at, and null for a book it does not have', () => {
    const { store } = fakeStore()
    const positions = readingPositions(store, () => 1_700_000_000_000)
    positions.set('one', 'epubcfi(/6/4)')
    expect(positions.held('one')).toEqual({ cfi: 'epubcfi(/6/4)', at: 1_700_000_000_000 })
    expect(positions.held('two')).toBeNull()
  })

  it('reads a row that recorded no clock as written at 0, so any shelf stamp beats it', () => {
    const { store } = fakeStore(JSON.stringify({ one: { cfi: 'epubcfi(/6/4)' } }))
    expect(readingPositions(store).held('one')).toEqual({ cfi: 'epubcfi(/6/4)', at: 0 })
  })
})

describe('recency and the position stamp are two different questions', () => {
  it('touch refreshes the eviction order and never the stamp the shelf is compared against', () => {
    /* The live interleaving this pins: the desktop reads on at 12:30; the
     * phone is opened OFFLINE at 13:00 with no page turned; reopened online,
     * a touched `at` made the stale phone position "newer" than the shelf's
     * and dragged the record back. Newest WRITE wins, not newest glance. */
    let clock = 1_000
    const positions = readingPositions(fakeStore().store, () => clock)
    positions.set('book:a', 'epubcfi(/6/2!/4/2)')
    clock = 5_000
    positions.touch('book:a')
    expect(positions.held('book:a')).toEqual({ cfi: 'epubcfi(/6/2!/4/2)', at: 1_000 })
  })

  it('a stored timestamp that is not a real moment is read as never recorded', () => {
    /* `1e400` parses as `Infinity`, which would beat every genuine stamp
     * forever — in eviction and against the shelf alike. */
    const seed = JSON.stringify({ 'book:a': { cfi: 'epubcfi(/6/2!/4/2)', at: 1e400 } })
    const positions = readingPositions(fakeStore(seed).store)
    expect(positions.held('book:a')).toEqual({ cfi: 'epubcfi(/6/2!/4/2)', at: 0 })
  })
})
