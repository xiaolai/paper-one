import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserPositions, readingPositions, type PositionStore } from './positions'

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

  it('forgetting a book it does not have writes nothing', () => {
    const { store, held } = fakeStore()
    readingPositions(store).forget('never-there')
    expect(held(), 'nothing to forget is nothing to write').toBeNull()
  })

  /* THE KEY IS STORED STATE, not a name. Positions an earlier build wrote sit
     under it, and a build that looked anywhere else would open every book at
     page one. */
  it('reads and writes under the key earlier builds wrote to', () => {
    const keys: string[] = []
    const store: PositionStore = {
      getItem: (key) => (key === 'paper.reading-positions' ? JSON.stringify({ one: { cfi: 'cfi-one', at: 1 } }) : null),
      setItem: (key) => void keys.push(key),
    }
    const positions = readingPositions(store, () => 2)
    expect(positions.get('one')).toBe('cfi-one')
    positions.set('two', 'cfi-two')
    expect(keys).toEqual(['paper.reading-positions'])
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
    it('answers nothing when the store cannot be read, and writes nothing over it', () => {
      const { store, held } = fakeStore('{}', 'read')
      const positions = readingPositions(store)
      expect(positions.get('one')).toBeNull()
      expect(() => positions.set('one', 'cfi')).not.toThrow()
      /* A READ THAT FAILED IS NOT AN EMPTY STORE. `set` is a read-modify-write,
         so writing here would put one position over every position this module
         could not read a moment ago. */
      expect(held()).toBe('{}')
    })

    it('does not throw when the store is full', () => {
      const { store } = fakeStore(null, 'write')
      const positions = readingPositions(store)
      expect(() => positions.set('one', 'cfi')).not.toThrow()
      expect(positions.get('one')).toBeNull()
    })

    /* NOT CLEARED. A store this cannot parse may belong to something else;
       overwriting it would be this module deciding that.

       ⚠️ **AND EVERY WRITE USED TO DECIDE IT ANYWAY.** The read answered an
       empty map, and `set`, `touch` and `forget` are each a read-modify-write
       — so the next page turn put one position over a store this module had
       just refused to touch, and the comment above it described the opposite.
       Found by the 2026-09-13 audit. */
    it.each(['not json at all', '[]', '42', '"a string"', 'null'])(
      'reads a store holding %s as no positions, and never writes over it',
      (raw) => {
        const { store, held } = fakeStore(raw)
        const positions = readingPositions(store)
        expect(positions.get('one')).toBeNull()
        expect(positions.held('one')).toBeNull()

        positions.set('one', 'a-real-cfi')
        positions.touch('one')
        positions.forget('one')

        expect(held()).toBe(raw)
      },
    )

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

    /* ONE BAD ROW LOSES ONE ROW. A `null` row read as an object throws, and a
       throw is the whole store's refusal — so it would take every good position
       with it. A cfi that is not a string is no position either, and `held`
       must say so as plainly as `get`, which turns `undefined` into null. */
    it('refuses a null row, or a cfi that is not a string, and keeps the rows beside them', () => {
      const { store } = fakeStore(
        JSON.stringify({ good: { cfi: 'a-cfi', at: 1 }, nothing: null, noCfi: { at: 2 }, numberCfi: { cfi: 7, at: 3 } }),
      )
      const positions = readingPositions(store)
      expect(positions.get('good')).toBe('a-cfi')
      expect(positions.held('nothing')).toBeNull()
      expect(positions.held('noCfi')).toBeNull()
      expect(positions.held('numberCfi')).toBeNull()
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

  /* AT THE CAP IS NOT OVER IT. Nothing is dropped and nothing is sorted:
     sorting is the eviction path's cost, not every page turn's, so the store
     is written in the order its books were first remembered. */
  it('fills to exactly the cap without dropping or reordering anything', () => {
    /* 499 seeded oldest-first, so the 500th — the newest — is the one a sort
       would move to the front. Seeded rather than written one at a time: 500
       writes of a growing store cost seconds and test nothing more. */
    const seed: Record<string, { cfi: string; at: number }> = {}
    for (let i = 0; i < 499; i += 1) seed[`book-${i}`] = { cfi: `cfi-${i}`, at: i + 1 }
    const { store, held } = fakeStore(JSON.stringify(seed))
    readingPositions(store, () => 10_000).set('book-499', 'cfi-499')
    const kept = Object.keys(JSON.parse(held() ?? '{}') as Record<string, unknown>)
    expect(kept).toHaveLength(500)
    expect(kept[0]).toBe('book-0')
    expect(kept.at(-1)).toBe('book-499')
  })

  /* A ROW WRITTEN BEFORE `readAt` EXISTED is ordered by its write stamp — `at`
     stands in. Read as recency 0 instead, every old row ties, and the tie
     evicts by place in the store rather than by age. */
  it('evicts a row that predates readAt by when it was written', () => {
    const seed: Record<string, { cfi: string; at: number }> = {}
    for (let i = 0; i < 500; i += 1) seed[`book-${i}`] = { cfi: `cfi-${i}`, at: i + 1 }
    const positions = readingPositions(fakeStore(JSON.stringify(seed)).store, () => 10_000)
    positions.set('new', 'cfi-new')
    expect(positions.get('book-0'), 'the oldest write is the one to go').toBeNull()
    expect(positions.get('book-499')).toBe('cfi-499')
    expect(positions.get('new')).toBe('cfi-new')
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

  it('stamps with the wall clock when no clock is handed in', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const positions = readingPositions(fakeStore().store)
    positions.set('one', 'epubcfi(/6/4)')
    expect(positions.held('one')).toEqual({ cfi: 'epubcfi(/6/4)', at: 1_700_000_000_000 })
    vi.restoreAllMocks()
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
     * forever — in eviction and against the shelf alike.
     *
     * ⚠️ WRITTEN AS TEXT, because `JSON.stringify` writes `Infinity` as `null`.
     * This seed was built with it, so the store held `"at":null` and the test
     * never met the value its title names; a stamp that let `Infinity` through
     * passed it. */
    const seed = '{"book:a":{"cfi":"epubcfi(/6/2!/4/2)","at":1e400}}'
    const positions = readingPositions(fakeStore(seed).store)
    expect(positions.held('book:a')).toEqual({ cfi: 'epubcfi(/6/2!/4/2)', at: 0 })
  })
})

describe('browserPositions', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps positions in the browser’s own storage', () => {
    const { store, held } = fakeStore()
    vi.stubGlobal('window', { localStorage: store })
    browserPositions().set('one', 'cfi-one')
    expect(held()).toContain('"cfi-one"')
  })

  /* `localStorage` IS A GETTER THAT THROWS when a reader blocks site data, so
     reaching for it is as risky as using it. A lost position, never a lost book. */
  it('remembers nothing, and throws nothing, when reaching storage throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): PositionStore {
        throw new Error('site data is blocked')
      },
    })
    const positions = browserPositions()
    expect(() => positions.set('one', 'cfi-one')).not.toThrow()
    expect(positions.get('one')).toBeNull()
    expect(positions.held('one')).toBeNull()
  })
})
