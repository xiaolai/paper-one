import { describe, expect, it } from 'vitest'
import {
  SENTENCE_CORPUS,
  type SentenceAnswer,
  type SentenceCorpusRow,
  type SentenceTag,
} from './sentenceCorpus'
import { sentenceOf } from './sentenceOf'

/**
 * The sentence corpus held to what its rows say, by running them — and by
 * nothing that reads the corpus as text, which is why this file exists.
 *
 * ⚠️ **`sentenceCorpus.test.ts` ASSERTS MOST OF THIS TOO, AND A MUTATION SWEEP
 * COUNTS NONE OF IT.** That file also reads `sentenceCorpus.ts` as text, to
 * prove it is plain data, and a test that reads a subject's text is left out of
 * that subject's run (`sourceReaders` in `scripts/check-mutants.mjs`). The one
 * covering test left, `scripts/sentence-parity.test.mjs`, holds a row's ANSWER
 * to the implementation and nothing else about the row. Swept 2026-09-15: 151
 * mutants survived — every tag and every `why` — and by hand that suite also
 * passed with a row's id, its expected `sentence`, or a declining row's run
 * emptied.
 *
 * A row is read here exactly as the parity driver reads it (`DRIVER` in
 * `scripts/sentence-parity.mjs`): the same call, the same answer shape, the same
 * rule for a covered row. A reading that differed would be measuring a
 * different corpus.
 */

/** What `sentenceOf` returns for a row, in the corpus's own shape. */
function answerOf(row: SentenceCorpusRow): SentenceAnswer {
  const result = sentenceOf(row.raw, row.termStart, row.termEnd, {
    locale: row.locale,
    maxSentenceChars: row.maxSentenceChars,
    before: row.before,
    after: row.after,
    requireComplete: row.requireComplete,
  })
  return result.ok ? { sentence: result.sentence, term: result.term } : 'none'
}

/** Whether what the row records is what a person would say — a decline
 *  included, where the honest answer is that there is no sentence to name. */
function covered(row: SentenceCorpusRow): boolean {
  return row.actual === 'none' ? row.sentence === 'none' : row.actual.sentence === row.sentence
}

/**
 * Every category a row may claim. A `Record` over `SentenceTag`, so the
 * compiler holds it to the type both ways — a category the type gains is a
 * missing key here and one it loses is an extra — rather than this being a
 * second list free to drift from the first.
 */
const DECLARED: Readonly<Record<SentenceTag, true>> = {
  abbreviation: true,
  cap: true,
  cjk: true,
  edge: true,
  empty: true,
  invisible: true,
  japanese: true,
  latin: true,
  locale: true,
  numeric: true,
  quotation: true,
  span: true,
  whitespace: true,
}

describe('the sentence corpus, run — every row returns the answer it records', () => {
  /* One case per row, so a divergence names its row and the rest still run.
   * A row the implementation gets wrong is held to the WRONG answer it
   * records: that answer is the shortfall, written down. */
  it.each([...SENTENCE_CORPUS])('$id', (row) => {
    expect(answerOf(row)).toEqual(row.actual)
  })
})

describe('the sentence corpus, run — what it says is not right yet', () => {
  /*
   * Both directions, because each alone lets the record go stale: one way a
   * shortfall nobody explained, the other a row fixed and still calling itself
   * a shortfall. It is also what notices an expected `sentence` edited on its
   * own — the row's coverage moves and its `why` does not.
   */
  it('opens the why of exactly the rows it gets wrong with UNCOVERED', () => {
    const wrong = SENTENCE_CORPUS.filter((row) => !covered(row)).map((row) => row.id)
    const saidWrong = SENTENCE_CORPUS.filter((row) => row.why.startsWith('UNCOVERED')).map((row) => row.id)

    expect(saidWrong).toEqual(wrong)
  })

  /* Non-vacuity for the case above and the rows before it: an empty corpus
   * agrees on both lists, and `it.each([])` passes reporting zero tests. */
  it('holds rows it gets right and rows it gets wrong', () => {
    expect(SENTENCE_CORPUS.filter((row) => covered(row)).length).toBeGreaterThan(0)
    expect(SENTENCE_CORPUS.filter((row) => !covered(row)).length).toBeGreaterThan(0)
  })
})

describe('the sentence corpus — what a row carries besides its answer', () => {
  /*
   * No answer reads a tag or a `why`, so no run above can notice one emptied.
   * They are still what the row is FOR: the tags travel with it into every
   * parity report, and the `why` is "the thing that breaks if it is deleted" —
   * the text that report's note sends a reader to.
   */
  it('says what every row covers, in categories the schema declares', () => {
    const unsaid = SENTENCE_CORPUS.filter(
      (row) => row.tags.length === 0 || row.tags.some((tag) => !Object.hasOwn(DECLARED, tag)),
    ).map((row) => ({ id: row.id, tags: row.tags }))

    expect(unsaid).toEqual([])
  })

  it('says why every row is in the corpus', () => {
    expect(SENTENCE_CORPUS.filter((row) => row.why.trim() === '').map((row) => row.id)).toEqual([])
  })

  /* A blank id is a row a report cannot name; a blank locale is the host's,
   * which the header forbids; and a blank sentence on a row already wrong
   * stays wrong, so the UNCOVERED case above cannot see it. */
  it('names every row once, and gives each a locale and a sentence', () => {
    const ids = SENTENCE_CORPUS.map((row) => row.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(
      SENTENCE_CORPUS.filter((row) => row.id === '' || row.locale === '' || row.sentence === '').map(
        (row) => ({ id: row.id, locale: row.locale, sentence: row.sentence }),
      ),
    ).toEqual([])
  })

  /*
   * A decline records `'none'` and not WHY it declined, so a decline row whose
   * run or far side is emptied still declines, for another reason, and every
   * run above agrees with it. Measured 2026-09-15: eleven runs and three far
   * sides emptied by hand passed each case above this one. What such a row can
   * be held to is its inputs being real — a term that lies inside the run, and
   * a far side named as text that holds some, which is all `sentenceAt` sends:
   * a blank one there becomes `null` or nothing.
   */
  it('gives every row a term inside its run, and any far side it names as text some text', () => {
    const outside = SENTENCE_CORPUS.filter(
      (row) => row.termStart < 0 || row.termEnd < row.termStart || row.termEnd > row.raw.length,
    ).map((row) => row.id)
    const blankSide = SENTENCE_CORPUS.filter((row) =>
      [row.before, row.after].some((side) => typeof side === 'string' && side.trim() === ''),
    ).map((row) => row.id)

    expect({ outside, blankSide }).toEqual({ outside: [], blankSide: [] })
  })
})
