import { describe, expect, it } from 'vitest'
import { FASTEST_REST_MS, SLOWEST_REST_MS, restPerStep } from './autoAdvance'
import { WORDS_PER_MINUTE } from './readingTime'

/**
 * The pace a hands-free reading advances at.
 *
 * The numbers here are the real book the mechanism was measured against:
 * section 21 of *Hands-On Machine Learning* is 171 651 spine bytes of a
 * 1 229 000-byte spine and reports **159 steps** in scrolled flow.
 */

/** That real section, as the derivation sees it. */
const section21 = {
  bookWords: 175_000,
  sectionBytes: 171_651,
  spineBytes: 1_229_000,
  steps: 159,
}

describe('restPerStep', () => {
  it('derives a pace a person would actually read at', () => {
    const rest = restPerStep(section21)
    expect(rest).not.toBeNull()
    /* 175 000 words x 14 % of the spine / 159 steps is about 154 words a step,
       which at 250 a minute is about 37 seconds of reading. */
    expect(rest! / 1000).toBeGreaterThan(20)
    expect(rest! / 1000).toBeLessThan(60)
  })

  it('rests longer on a denser section and shorter on a sparser one', () => {
    const dense = restPerStep({ ...section21, steps: 80 })!
    const sparse = restPerStep({ ...section21, steps: 300 })!
    expect(dense).toBeGreaterThan(sparse)
  })

  it('scales with the book, because the share is by bytes', () => {
    const half = restPerStep({ ...section21, sectionBytes: section21.sectionBytes / 2 })!
    const whole = restPerStep(section21)!
    /* Three places, not five: the answer is rounded to whole milliseconds on
       purpose — a timer cannot use a fraction — so the ratio carries up to a
       millisecond of rounding on a rest of tens of seconds. */
    expect(whole / half).toBeCloseTo(2, 3)
  })

  it('agrees with the pace the time-left estimate uses', () => {
    /* One constant, two features. If these ever disagree, a reader is told one
       pace and shown another. */
    const rest = restPerStep({ bookWords: WORDS_PER_MINUTE * 10, sectionBytes: 100, spineBytes: 100, steps: 10 })
    /* Ten steps over ten minutes of words: one minute a step. */
    expect(rest).toBe(60_000)
  })

  it('refuses a book whose length is unknown', () => {
    /* Every PDF, and any book with a partial spine — see `wordsInSpine`. A
       control that advances at an invented pace is worse than one that declines,
       because the reader cannot tell a chosen rate from a broken one. */
    expect(restPerStep({ ...section21, bookWords: null })).toBeNull()
  })

  it('refuses a section or spine it cannot measure', () => {
    for (const over of [
      { sectionBytes: 0 },
      { sectionBytes: -1 },
      { sectionBytes: Number.NaN },
      { spineBytes: 0 },
      { spineBytes: Number.NaN },
    ]) {
      expect(restPerStep({ ...section21, ...over })).toBeNull()
    }
  })

  it('refuses a step count that is not a count', () => {
    /* `renderer.pages` read before layout settles answers 0, and a section
       cannot have fewer than one step. */
    for (const steps of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(restPerStep({ ...section21, steps })).toBeNull()
    }
  })

  it('takes a single-step section, which is the commonest short chapter', () => {
    expect(restPerStep({ ...section21, steps: 1, sectionBytes: 3_000 })).not.toBeNull()
  })

  it('refuses a rest faster than anyone reads a viewport', () => {
    /* ⚠️ A derivation below the floor means an input is wrong — a section that
       is mostly markup, or a `pages` count taken too early. Clamping would turn
       that into a plausible-looking rate nothing chose. */
    const tooFast = restPerStep({ bookWords: 10, sectionBytes: 100, spineBytes: 100, steps: 100 })
    expect(tooFast).toBeNull()
  })

  it('refuses a rest slower than anyone would call movement', () => {
    const tooSlow = restPerStep({ bookWords: 10_000_000, sectionBytes: 100, spineBytes: 100, steps: 1 })
    expect(tooSlow).toBeNull()
  })

  it('takes both ends of the band exactly, so the bound is the bound', () => {
    /* A band a test only brackets loosely is a band any mutant can move. */
    const atFloor = (FASTEST_REST_MS / 60_000) * WORDS_PER_MINUTE
    expect(restPerStep({ bookWords: atFloor, sectionBytes: 100, spineBytes: 100, steps: 1 })).toBe(FASTEST_REST_MS)
    const atCeiling = (SLOWEST_REST_MS / 60_000) * WORDS_PER_MINUTE
    expect(restPerStep({ bookWords: atCeiling, sectionBytes: 100, spineBytes: 100, steps: 1 })).toBe(SLOWEST_REST_MS)
  })

  it('answers whole milliseconds, because a timer cannot use a fraction', () => {
    const rest = restPerStep({ bookWords: 1_001, sectionBytes: 997, spineBytes: 1_009, steps: 7 })
    expect(rest).not.toBeNull()
    expect(Number.isInteger(rest!)).toBe(true)
  })
})
