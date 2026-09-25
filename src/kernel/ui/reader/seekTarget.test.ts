import { describe, expect, it } from 'vitest'
import { seekTarget } from './seekTarget'

/** The common book: no page list. 140 of 150 sampled books are this. */
const reflowable = { pages: 0 }
/** The 7 %: a book carrying its print edition's own pagination. */
const paginated = { pages: 320 }

describe('seekTarget', () => {
  it('reads a percentage', () => {
    expect(seekTarget('60%', reflowable)).toEqual({ kind: 'fraction', fraction: 0.6 })
  })

  it('reads a bare number as a percentage, which is the decision', () => {
    /* `60` is ambiguous between 60 % and page 60. Reading it as a page would
       refuse in the 93 % of books with no page list, turning the commonest
       input into the commonest failure. */
    expect(seekTarget('60', reflowable)).toEqual({ kind: 'fraction', fraction: 0.6 })
  })

  it('tolerates the spacing and the decimal a person actually types', () => {
    expect(seekTarget('  60 % ', reflowable)).toEqual({ kind: 'fraction', fraction: 0.6 })
    expect(seekTarget('12.5%', reflowable)).toEqual({ kind: 'fraction', fraction: 0.125 })
  })

  it('takes both ends of the range', () => {
    expect(seekTarget('0%', reflowable)).toEqual({ kind: 'fraction', fraction: 0 })
    expect(seekTarget('100%', reflowable)).toEqual({ kind: 'fraction', fraction: 1 })
  })

  it('refuses a percentage outside the range, in its own words', () => {
    const refusal = seekTarget('101%', reflowable)
    expect(refusal.kind).toBe('refuse')
    expect(refusal.kind === 'refuse' && refusal.why).toMatch(/runs from 0 to 100/u)
  })

  it('reads a page, in the spellings a person uses', () => {
    for (const typed of ['p. 213', 'p.213', 'p 213', 'pg 213', 'page 213', 'PAGE 213']) {
      expect(seekTarget(typed, paginated)).toEqual({ kind: 'page', page: 213 })
    }
  })

  it('refuses a page in a book that declares none, and says what to try instead', () => {
    /* ⚠️ NOT APPROXIMATED FROM THE FRACTION. A page number invented from how
       far through the file a reader is, is a citation nobody else can follow —
       the argument `citation.ts` already makes in its own words. */
    const refusal = seekTarget('p. 213', reflowable)
    expect(refusal.kind).toBe('refuse')
    expect(refusal.kind === 'refuse' && refusal.why).toMatch(/no page numbers of its own/u)
  })

  it('refuses a page past the end, naming the last one', () => {
    const refusal = seekTarget('p. 900', paginated)
    expect(refusal.kind).toBe('refuse')
    expect(refusal.kind === 'refuse' && refusal.why).toMatch(/goes up to page 320/u)
  })

  it('refuses page zero, which is not a page', () => {
    expect(seekTarget('p. 0', paginated).kind).toBe('refuse')
  })

  it('takes the first and last page exactly', () => {
    expect(seekTarget('p. 1', paginated)).toEqual({ kind: 'page', page: 1 })
    expect(seekTarget('p. 320', paginated)).toEqual({ kind: 'page', page: 320 })
  })

  it('refuses an empty box with an instruction rather than a complaint', () => {
    const refusal = seekTarget('   ', reflowable)
    expect(refusal.kind).toBe('refuse')
    expect(refusal.kind === 'refuse' && refusal.why).toMatch(/Type a place/u)
  })

  it('refuses words, quoting back what was typed', () => {
    const refusal = seekTarget('the whale', reflowable)
    expect(refusal.kind).toBe('refuse')
    expect(refusal.kind === 'refuse' && refusal.why).toMatch(/the whale/u)
  })

  it('refuses a negative, which the bare-number reading must not swallow', () => {
    expect(seekTarget('-5', reflowable).kind).toBe('refuse')
    expect(seekTarget('-5%', reflowable).kind).toBe('refuse')
  })

  it('refuses a number so long it cannot be a place', () => {
    expect(seekTarget('1234567', reflowable).kind).toBe('refuse')
  })
})
