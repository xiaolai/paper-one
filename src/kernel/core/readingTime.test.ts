import { describe, expect, it } from 'vitest'
import { CHARS_PER_XHTML_BYTE, minutesLeft, spineBytes, timeLeft, wordsInSpine } from './readingTime'

/**
 * The estimate, against the real shelf's numbers.
 *
 * ⚠️ **WHAT THIS REPLACES WAS RIGHT AT THE MEDIAN AND WRONG FOR A THIRD OF THE
 * LIBRARY.** 250 words a minute over an assumed 90,000 words: the real median is
 * 95,715, so the old constant was an excellent median — and 33 % of books are
 * more than 2x from it, 17 % more than 3x, with the longest told "about 6 hours"
 * for eleven hours of reading. The cases below are keyed to those measurements
 * rather than to round numbers, so a change that reintroduces an assumption has
 * to argue with the corpus.
 */

/** Bytes of spine XHTML that come to roughly N words at the measured factor. */
const spineFor = (words: number) => (words * 5) / CHARS_PER_XHTML_BYTE

describe('wordsInSpine', () => {
  it('reads a length from the spine', () => {
    const words = wordsInSpine(spineFor(95_715), false)
    expect(words).not.toBeNull()
    expect(words!).toBeCloseTo(95_715, 0)
  })

  it('refuses a fixed-layout book, whose sizes are not file sizes', () => {
    /* ⚠️ **EVERY PDF.** `makePdf` sets a flat `size: 1000` per page — "foliate
       uses this to weight progress. Pages are equal enough." Multiplied by a
       chars-per-byte factor that is a confident number about nothing: a
       400-page PDF would claim 57,000 words whatever it contains. */
    expect(wordsInSpine(400 * 1000, true)).toBeNull()
  })

  it('refuses a spine it cannot measure rather than answering zero', () => {
    /* Zero words would answer "Nearly done" for a book nobody has read. */
    for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wordsInSpine(bytes, false)).toBeNull()
    }
  })

  it('scales with the spine, because that is the whole claim', () => {
    const one = wordsInSpine(spineFor(50_000), false)!
    const two = wordsInSpine(spineFor(100_000), false)!
    expect(two / one).toBeCloseTo(2, 5)
  })
})

describe('minutesLeft', () => {
  it('counts down as the reader advances', () => {
    const words = 95_715
    expect(minutesLeft(0.5, words)).toBe(Math.round(95_715 / 2 / 250))
    expect(minutesLeft(0.9, words)).toBeLessThan(minutesLeft(0.5, words)!)
  })

  it('says nothing before the reader has moved', () => {
    /* The footer's existing rule, kept: at 0 % the arithmetic answers with the
       whole book and reads as a fact about this reader. */
    expect(minutesLeft(0, 95_715)).toBeNull()
  })

  it('says nothing when the length is unknown', () => {
    expect(minutesLeft(0.5, null)).toBeNull()
  })

  it('answers 0 at the very end rather than a negative', () => {
    expect(minutesLeft(1, 95_715)).toBe(0)
  })

  it('clamps a malformed fraction instead of answering NaN minutes', () => {
    expect(minutesLeft(Number.NaN, 95_715)).toBeNull()
    expect(minutesLeft(-1, 95_715)).toBeNull()
    expect(minutesLeft(2, 95_715)).toBe(0)
  })

  it('is right about the book the old constant was most wrong about', () => {
    /* The longest book measured: 988,448 words. At the shelf's own pace that is
       about 66 hours, and the assumed 90,000 told the reader six. */
    const hours = minutesLeft(0, 988_448) // null — no estimate at the start
    expect(hours).toBeNull()
    const started = minutesLeft(0.001, 988_448)!
    expect(started / 60).toBeGreaterThan(60)
    /* What the old assumption would have said, for contrast. */
    expect(Math.round((90_000 * 0.999) / 250 / 60)).toBe(6)
  })

  it('is right about the shortest, which the old constant overstated 75-fold', () => {
    /* 1,207 words is about five minutes; the assumption said six hours. */
    const left = minutesLeft(0.01, 1_207)!
    expect(left).toBeLessThan(6)
  })
})

describe('timeLeft', () => {
  it('says nothing at all where there is nothing honest to say', () => {
    expect(timeLeft(0, 95_715)).toBeNull()
    expect(timeLeft(0.5, null)).toBeNull()
  })

  it('reads in minutes below an hour and hours above it', () => {
    expect(timeLeft(0.5, 250 * 30 * 2)).toBe('~30 min left')
    expect(timeLeft(0.5, 250 * 120 * 2)).toBe('~2 h left')
  })

  it('crosses to hours exactly at sixty minutes, not near it', () => {
    /* A bound a test only brackets loosely is a bound any mutant can move. */
    expect(timeLeft(0.5, 250 * 59 * 2)).toBe('~59 min left')
    expect(timeLeft(0.5, 250 * 60 * 2)).toBe('~1 h left')
  })

  it('says Nearly done rather than counting the last minute down', () => {
    expect(timeLeft(0.999, 95_715)).toBe('Nearly done')
  })

  it('crosses to Nearly done at THIRTY seconds, because the minutes are rounded first', () => {
    /* ⚠️ **NOT AT SIXTY, WHICH IS WHAT THIS CASE FIRST ASSERTED.**
       `minutesLeft` rounds and `timeLeft` then compares against 1, so 0.8 of a
       minute is already "1" by the time the comparison happens. The boundary is
       where the rounding lands, and it is worth pinning because reading the two
       functions separately suggests the wrong one. */
    expect(timeLeft(0.5, 250 * 0.8 * 2)).toBe('~1 min left')
    expect(timeLeft(0.5, 250 * 0.4 * 2)).toBe('Nearly done')
  })
})

describe('spineBytes', () => {
  it('sums a spine', () => {
    expect(spineBytes([{ size: 2167 }, { size: 975 }, { size: 832 }])).toBe(3974)
  })

  it('refuses a PARTIAL count rather than answering short', () => {
    /* ⚠️ An estimate that is quietly too small is worse than none, because it
       reads as a measurement. One missing size refuses the whole book. */
    expect(spineBytes([{ size: 2167 }, {}, { size: 832 }])).toBeNull()
    expect(spineBytes([{ size: 2167 }, { size: 0 }])).toBeNull()
    expect(spineBytes([{ size: 2167 }, { size: -5 }])).toBeNull()
    expect(spineBytes([{ size: 2167 }, { size: Number.NaN }])).toBeNull()
    expect(spineBytes([{ size: 2167 }, { size: '900' }])).toBeNull()
  })

  it('refuses a book with no sections at all', () => {
    expect(spineBytes([])).toBeNull()
  })

  it('refuses anything that is not a spine, rather than throwing at open', () => {
    /* ⚠️ **THE FIRST VERSION TOOK `readonly unknown[]` AND THREW.** A backend
       that publishes no `sections` gave `undefined`, `.length` threw, and this
       runs inside the session at OPEN — so the whole reader went down for a book
       that should simply have had no estimate. 167 cases went red at once. */
    for (const not of [undefined, null, 'sections', 7, {}, { length: 3 }]) {
      expect(spineBytes(not)).toBeNull()
    }
  })

  it('carries a hole through to the estimate as silence', () => {
    expect(wordsInSpine(spineBytes(undefined), false)).toBeNull()
    expect(timeLeft(0.5, wordsInSpine(spineBytes(undefined), false))).toBeNull()
  })
})
