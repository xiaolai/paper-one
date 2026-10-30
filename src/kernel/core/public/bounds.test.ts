import { describe, expect, it } from 'vitest'
import {
  ANCHOR_PER_TASK,
  DEFAULT_PUBLIC_BOUNDS,
  MAX_HELD_BYTES_PER_BOOK,
  MAX_BOOKS_WITH_PUBLIC,
  MAX_HELD_PER_BOOK,
  VERIFY_PER_TASK,
  admitsAnotherBook,
  hasRoom,
  keepWithin,
  sizeOf,
  sliceFor,
  type Weighed,
} from './bounds'

const weighed = (at: number, size = 100): Weighed => ({ at, received: `${at}`.padEnd(size, 'x') })

describe('sliceFor', () => {
  it('takes a whole batch when it fits and says there is no more', () => {
    expect(sliceFor(10, 32)).toEqual({ take: 10, more: false })
    expect(sliceFor(0, 32)).toEqual({ take: 0, more: false })
  })

  it('takes a task’s worth and says there is more', () => {
    expect(sliceFor(100, 32)).toEqual({ take: 32, more: true })
    expect(sliceFor(32, 32)).toEqual({ take: 32, more: false })
    expect(sliceFor(33, 32)).toEqual({ take: 32, more: true })
  })

  it('refuses a count or a batch size that is not one', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => sliceFor(bad, 32)).toThrow(/not a count/u)
      expect(() => sliceFor(10, bad)).toThrow(/not a batch size/u)
    }
    /* A batch of zero never terminates. */
    expect(() => sliceFor(10, 0)).toThrow(/not a batch size/u)
  })

  it('has a batch size for each of the two loops WI-26.7 names', () => {
    /* ⚠️ **SIGNATURE VERIFICATION IS NEW MAIN-THREAD WORK, AND THE RE-ANCHOR
       PASS YIELDS BETWEEN SECTIONS BUT NOT INSIDE ONE.** Both are loops a
       flood chooses the length of. */
    expect(VERIFY_PER_TASK).toBeGreaterThan(0)
    expect(ANCHOR_PER_TASK).toBeGreaterThan(0)
  })
})

describe('keepWithin — retained storage, not traffic', () => {
  it('keeps everything under the bounds', () => {
    const held = [weighed(3), weighed(1), weighed(2)]
    expect(keepWithin(held)).toHaveLength(3)
  })

  it('keeps the oldest when the count is exceeded', () => {
    /* ⚠️ **NOT "FAIR", AND THE CHOICE IS BETWEEN TWO UNFAIR RULES.** Keeping
       the NEWEST means a flood evicts everything the reader has been reading,
       continuously — the attacker's goal handed to them. */
    const held = Array.from({ length: MAX_HELD_PER_BOOK + 5 }, (_, i) => weighed(i))
    const kept = keepWithin(held)
    expect(kept).toHaveLength(MAX_HELD_PER_BOOK)
    expect(kept[0]?.at).toBe(0)
    expect(kept.some((one) => one.at === MAX_HELD_PER_BOOK + 4)).toBe(false)
  })

  it('keeps within the byte bound as well as the count', () => {
    const big = Math.floor(MAX_HELD_BYTES_PER_BOOK / 3)
    const held = [weighed(1, big), weighed(2, big), weighed(3, big), weighed(4, big)]
    const kept = keepWithin(held)
    expect(kept.length).toBeLessThan(4)
    expect(kept.reduce((total, one) => total + sizeOf(one.received), 0)).toBeLessThanOrEqual(MAX_HELD_BYTES_PER_BOOK)
  })

  it('keeps scanning past one annotation too big to fit', () => {
    /* ⚠️ **THE FIRST THAT DID NOT FIT ENDED THE SCAN.** One near-limit
       envelope early in the order threw away every older-but-smaller
       annotation after it — each of which would have fitted on its own. The
       COUNT bound is still a `break`, and correctly: nothing later fits under
       a count that is already full. */
    const held = [
      { at: 1, received: 'x'.repeat(100) },
      { at: 2, received: 'y'.repeat(MAX_HELD_BYTES_PER_BOOK) },
      { at: 3, received: 'z'.repeat(100) },
    ]
    expect(keepWithin(held).map((one) => one.at)).toEqual([1, 3])
  })

  it('breaks ties the same way on every device, whatever its locale', () => {
    /* ⚠️ **`localeCompare` MADE RETENTION A PROPERTY OF THE MACHINE.** Two
       readers holding the same envelopes evicted different ones, and strings a
       collation calls equivalent but that are not equal compared `0` — so
       those two stayed in whatever order an attacker delivered them. */
    const held = [
      { at: 1, received: 'a\u0301' },
      { at: 1, received: '\u00e1' },
      { at: 1, received: 'B' },
    ]
    const one = keepWithin(held, { ...DEFAULT_PUBLIC_BOUNDS, heldPerBook: 2 })
    const other = keepWithin([...held].reverse(), { ...DEFAULT_PUBLIC_BOUNDS, heldPerBook: 2 })
    expect(one).toEqual(other)
    /* Code-unit order, which no locale moves: 'B' (0x42) before both. */
    expect(one[0]?.received).toBe('B')
  })
})

describe('a JSONL record costs its separator', () => {
  it('counts the newline the file will carry, so both bounds measure the file', () => {
    /* ⚠️ **THE STORE WRITES `lines.join('\n')` PLUS A TRAILING NEWLINE.** A
       book at exactly `heldBytesPerBook` by the envelope-only measure was
       `heldPerBook` bytes larger on disk. */
    expect(sizeOf('abc')).toBe(4)
    expect(sizeOf('')).toBe(1)
    /* UTF-8, not UTF-16 code units — a Chinese character is one unit and
       three bytes. */
    expect(sizeOf('中')).toBe(4)
  })

  it('measures both sides of the room question the same way', () => {
    /* ⚠️ **THE SEPARATOR ON ONE SIDE ONLY IS A SECOND MEASURE**, which is the
       drift this file exists to prevent: a book the trimmer called full still
       had room, so an annotation was admitted and then immediately trimmed. */
    const room = MAX_HELD_BYTES_PER_BOOK - sizeOf('x'.repeat(10))
    const held = [{ at: 1, received: 'x'.repeat(10) }]
    expect(hasRoom(held, room)).toBe(true)
    expect(hasRoom(held, room + 1)).toBe(false)
  })

  it('is deterministic when two annotations claim the same time', () => {
    /* A stranger chooses `at`, so a thousand can claim one millisecond. Two
       devices must still keep the same set. */
    const held = [weighed(1), { at: 1, received: 'aaa' }, { at: 1, received: 'bbb' }]
    expect(keepWithin(held, { ...DEFAULT_PUBLIC_BOUNDS, heldPerBook: 2 })).toEqual(
      keepWithin([...held].reverse(), { ...DEFAULT_PUBLIC_BOUNDS, heldPerBook: 2 }),
    )
  })
})

describe('hasRoom', () => {
  it('is true below both bounds and false at either', () => {
    expect(hasRoom([], 100)).toBe(true)
    expect(hasRoom(Array.from({ length: MAX_HELD_PER_BOOK }, (_, i) => weighed(i)), 1)).toBe(false)
    expect(hasRoom([{ at: 1, received: 'x'.repeat(MAX_HELD_BYTES_PER_BOOK) }], 1)).toBe(false)
  })

  it('admits exactly the last byte that fits', () => {
    const held = [{ at: 1, received: 'x'.repeat(MAX_HELD_BYTES_PER_BOOK - 10) }]
    /* The held line costs its newline too, so nine bytes is what is left. */
    expect(hasRoom(held, 9)).toBe(true)
    expect(hasRoom(held, 10)).toBe(false)
  })
})

describe('admitsAnotherBook', () => {
  it('is true below the bound and false at it', () => {
    /* ⚠️ **THE CONSTANT WAS DECLARED AND NEVER READ**, so the claimed
       device-wide storage bound did not exist — found by audit. */
    expect(admitsAnotherBook(0)).toBe(true)
    expect(admitsAnotherBook(MAX_BOOKS_WITH_PUBLIC - 1)).toBe(true)
    expect(admitsAnotherBook(MAX_BOOKS_WITH_PUBLIC)).toBe(false)
    expect(admitsAnotherBook(MAX_BOOKS_WITH_PUBLIC + 1)).toBe(false)
  })

  it('honours a caller’s own bound', () => {
    expect(admitsAnotherBook(2, { ...DEFAULT_PUBLIC_BOUNDS, booksWithPublic: 2 })).toBe(false)
  })
})

describe('a bound that is asked with a non-count', () => {
  it('throws rather than refusing quietly', () => {
    /* ⚠️ **THIS IS HOW A MISSING BARREL EXPORT SURVIVED ITS OWN PROBE.**
       `admitsAnotherBook(undefined)` was `undefined < 2000` — `false`, a
       refusal, so nothing unsafe happened and a test asserting the refusal
       passed while measuring nothing. A detector that finds nothing looks
       exactly like a clean result. */
    for (const bad of [undefined, null, -1, 1.5, Number.NaN, '3']) {
      expect(() => admitsAnotherBook(bad as never), String(bad)).toThrow(/not a count/u)
    }
  })

  it('refuses a BOUNDS RECORD that is not one, which used to disable the check', () => {
    /* ⚠️ **A `NaN` LIMIT FAILS IN THE UNSAFE DIRECTION AND SAYS NOTHING.**
       `bytes + size > NaN` is `false` and `kept.length >= NaN` is `false`, so
       the trimmer ran, reported success and kept everything. Every scalar
       count in this file was already refused when it was not a count; the
       record they are compared against was the one thing nobody checked. */
    const held = Array.from({ length: MAX_HELD_PER_BOOK + 5 }, (_, i) => weighed(i))
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => keepWithin(held, { ...DEFAULT_PUBLIC_BOUNDS, heldPerBook: bad }), String(bad)).toThrow(
        /heldPerBook is not a bound/u,
      )
      expect(() => hasRoom([], 1, { ...DEFAULT_PUBLIC_BOUNDS, heldBytesPerBook: bad }), String(bad)).toThrow(
        /heldBytesPerBook is not a bound/u,
      )
      expect(() => admitsAnotherBook(1, { ...DEFAULT_PUBLIC_BOUNDS, booksWithPublic: bad }), String(bad)).toThrow(
        /booksWithPublic is not a bound/u,
      )
    }
  })
})
