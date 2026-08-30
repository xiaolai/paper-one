import { describe, expect, it } from 'vitest'
import { sentenceOf } from './sentenceOf'

/**
 * The two guards an audit found missing, and the option that made one of them
 * matter.
 *
 * `sentenceCorpus.test.ts` covers the SEGMENTATION against a corpus of real
 * sentences. These are the edges around it: what the abbreviation merge may not
 * cross, and what happens when a caller's offsets are wrong.
 */

/** `raw` with the term marked by `|term|`, so the offsets cannot drift. */
function around(marked: string) {
  const start = marked.indexOf('|')
  const end = marked.indexOf('|', start + 1) - 1
  return { raw: marked.replace(/\|/g, ''), start, end }
}

describe('what the abbreviation merge may not cross', () => {
  /* ⚠️ **U+2028 IS PRESERVED ON PURPOSE AND THE MERGE ATE IT.** `squeeze`
     collapses everything CSS collapses and deliberately keeps U+2028/U+2029,
     because CSS does not collapse them and the reader sees a line break there.
     `TITLE`/`INITIAL` ended in `\s*`, which matches those — so ICU's correct
     split at the separator was merged straight back. */
  it('does not merge across a line separator', () => {
    const { raw, start, end } = around('He lived on Main St.\u2028Beta |two| words here.')
    const found = sentenceOf(raw, start, end, { locale: 'en', requireComplete: false })

    expect(found.ok).toBe(true)
    if (found.ok) {
      expect(found.sentence).not.toContain('Main St.')
      expect(found.sentence).toContain('Beta two')
    }
  })

  /* NON-VACUITY: an ordinary space after the title still merges, which is the
     whole reason the merge pass exists. */
  it('still merges a title across an ordinary space', () => {
    const { raw, start, end } = around('He met Mr. |Smith| at noon. Then left.')
    const found = sentenceOf(raw, start, end, { locale: 'en', requireComplete: false })

    expect(found.ok).toBe(true)
    if (found.ok) expect(found.sentence).toBe('He met Mr. Smith at noon.')
  })
})

describe('what an out-of-range term does', () => {
  /* ⚠️ **`squeeze` CLAMPS, SO A WRONG OFFSET USED TO BE ANSWERED.** Under §C1
     the damage mostly ended as a `run-end` gap and was invisible; with
     `requireComplete: false` there is no gate, so a `termEnd` past the run
     returned a confident sentence spanning everything to its end. */
  it('refuses a term that runs past the text', () => {
    const raw = 'One sentence. Two sentence. Three.'
    expect(sentenceOf(raw, 4, raw.length + 10, { requireComplete: false })).toEqual({
      ok: false,
      gap: 'no-term',
    })
  })

  it('refuses a negative, inverted, or empty term', () => {
    const raw = 'One sentence. Two sentence. Three.'
    for (const [start, end] of [
      [-1, 5],
      [10, 4],
      [5, 5],
      [1.5, 6],
    ]) {
      expect(sentenceOf(raw, start as number, end as number, { requireComplete: false })).toEqual({
        ok: false,
        gap: 'no-term',
      })
    }
  })

  /* NON-VACUITY: an in-range term is still answered. */
  it('answers an in-range term', () => {
    const { raw, start, end } = around('One sentence. Two |sentence| here. Three.')
    expect(sentenceOf(raw, start, end, { requireComplete: false }).ok).toBe(true)
  })
})
