import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SENTENCE_CORPUS, type SentenceTag } from './sentenceCorpus'
import { sentenceOf } from './sentenceOf'
import { scan } from './sourceScan.testkit'

/**
 * The sentence corpus under Node's ICU. `scripts/sentence-parity.mjs` runs the
 * same rows inside the running app's WebKit, and the comparison is where the
 * engines are actually held to each other — **this lane cannot do that**, and a
 * green run here is not evidence about the runtime.
 */

/**
 * The row count, pinned by hand.
 *
 * Not derived. `it.each([])` passes silently and reports zero tests, which in a
 * summary looks exactly like a healthy run — so a corpus emptied by a bad
 * merge, a stray `.filter`, or a `.slice` that crept into the export would be
 * invisible. This number is the only thing that can tell "every row passed"
 * from "there were no rows".
 */
const PINNED_ROWS = 26

/**
 * How many rows the implementation does NOT get right, pinned the same way.
 *
 * This is the number the corpus exists to make legible. Every row's `sentence`
 * is the full linguistic sentence written by hand, so a row where `actual`
 * differs is a real shortfall — ICU's, or a deliberate fail-closed decline, or
 * the price of an entry on the merge list. Pinning the count means coverage can
 * be improved on purpose and cannot quietly fall: a new uncovered row fails
 * here until someone writes the number down and says why.
 */
const PINNED_UNCOVERED = 10

/**
 * The categories the corpus must cover, stated HERE rather than in
 * `sentenceCorpus.ts`. If the requirement lived beside the data, deleting the
 * last CJK row and its tag from the required list would be one edit and the
 * suite would stay green.
 */
const REQUIRED_TAGS: readonly SentenceTag[] = [
  'abbreviation',
  'cap',
  'cjk',
  'edge',
  'empty',
  'invisible',
  'japanese',
  'latin',
  'locale',
  'numeric',
  'quotation',
  'span',
  'whitespace',
]

/**
 * Everything wrong with one row, named.
 *
 * Deliberately typed `unknown`: the point is to check at run time what the
 * compiler has already been told, so a row arriving from a merge conflict or a
 * hand edit cannot be waved through by its declared type. Comparing a typed
 * field against `undefined` would not even compile.
 */
function faults(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null) return ['is not an object']
  const row = value as Record<string, unknown>
  const out: string[] = []
  if (typeof row['id'] !== 'string' || row['id'] === '') out.push('id')
  if (!Array.isArray(row['tags']) || row['tags'].length === 0) out.push('tags')
  if (typeof row['raw'] !== 'string') out.push('raw')
  if (!Number.isInteger(row['termStart'])) out.push('termStart')
  if (!Number.isInteger(row['termEnd'])) out.push('termEnd')
  if (typeof row['locale'] !== 'string' || row['locale'] === '') out.push('locale')
  if (!Number.isInteger(row['maxSentenceChars'])) out.push('maxSentenceChars')
  if (typeof row['sentence'] !== 'string' || row['sentence'] === '') out.push('sentence')
  if (!('actual' in row) || row['actual'] === undefined) out.push('actual is missing')
  else if (row['actual'] !== 'none' && !isAnswer(row['actual'])) out.push('actual is malformed')
  if (typeof row['why'] !== 'string' || row['why'].trim() === '') out.push('why')
  return out
}

function isAnswer(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  return typeof answer['sentence'] === 'string' && typeof answer['term'] === 'string'
}

/** What `sentenceOf` returns, in the corpus's own shape. */
function answerFor(row: (typeof SENTENCE_CORPUS)[number]): unknown {
  const result = sentenceOf(row.raw, row.termStart, row.termEnd, {
    locale: row.locale,
    maxSentenceChars: row.maxSentenceChars,
  })
  return result.ok ? { sentence: result.sentence, term: result.term } : 'none'
}

/* A row is covered when what we return is what a person would say — INCLUDING
 * a row whose honest answer is that there is no sentence to name. Treating
 * every decline as a shortfall would have counted the two empty-term rows,
 * where declining is the right answer rather than a gap. */
const uncovered = SENTENCE_CORPUS.filter((row) =>
  row.actual === 'none' ? row.sentence !== 'none' : row.actual.sentence !== row.sentence,
)

describe('the sentence corpus — every row under Node ICU', () => {
  /* `it.each` rather than a loop inside one `it`, so a single divergence names
   * its row and the rest still run. */
  it.each([...SENTENCE_CORPUS])('$id', (row) => {
    expect(answerFor(row)).toEqual(row.actual)
  })
})

describe('the sentence corpus — what it says about coverage', () => {
  /*
   * The assertion the two-field schema exists for. A corpus of transcripts
   * would report perfect coverage of ICU's own behaviour and tell nobody that
   * `He said, "Stop!" he said.` comes back as half a sentence.
   */
  it('names exactly the rows the implementation does not get right', () => {
    expect(uncovered.map((row) => row.id)).toEqual([
      'abbreviation-closing-quote',
      'abbreviation-street-overshoot',
      'japanese-closing-quote',
      'lowercase-sentence-start',
      'sentence-final-initial',
      'run-start-edge',
      'run-end-edge',
      'longer-than-a-sentence',
      'latin-abbreviation-in-han-under-zh',
      'unknown-language',
    ])
    expect(uncovered).toHaveLength(PINNED_UNCOVERED)
  })

  /* Non-vacuity for the pair: a corpus where every row was uncovered, or none
   * was, would satisfy a bare count. */
  it('holds rows the implementation does get right', () => {
    expect(SENTENCE_CORPUS.length - uncovered.length).toBeGreaterThan(uncovered.length)
  })

  it('says why every uncovered row is uncovered', () => {
    expect(uncovered.filter((row) => !/UNCOVERED/.test(row.why)).map((row) => row.id)).toEqual([])
  })
})

describe('the sentence corpus — the guards that make a green run mean something', () => {
  it('is non-empty and holds exactly the pinned number of rows', () => {
    expect(SENTENCE_CORPUS.length).toBeGreaterThan(0)
    expect(SENTENCE_CORPUS).toHaveLength(PINNED_ROWS)
  })

  /* A copy-pasted row shadows its original in a report while the total still
   * matches, so the count alone cannot see it. */
  it('gives every row a unique id', () => {
    expect(new Set(SENTENCE_CORPUS.map((row) => row.id)).size).toBe(SENTENCE_CORPUS.length)
  })

  /*
   * The count cannot see COMPOSITION: twenty Latin rows would satisfy it. The
   * CJK and Japanese rows are the ones the two engines are likeliest to
   * disagree about, and they are also the ones easiest to argue away as
   * "the same case again".
   */
  it('represents every required category', () => {
    const present = new Set<string>(SENTENCE_CORPUS.flatMap((row) => [...row.tags]))

    expect(REQUIRED_TAGS.filter((tag) => !present.has(tag))).toEqual([])
  })

  it('leaves no row unfinished', () => {
    const bad = SENTENCE_CORPUS.map((row) => ({ id: row.id, faults: faults(row) })).filter(
      (entry) => entry.faults.length > 0,
    )

    expect(bad).toEqual([])
  })

  /* Non-vacuity for the validator: it must actually reject something, or the
   * assertion above passes on a check that has stopped checking. */
  it('rejects a row with no answer, so the guard above is not vacuous', () => {
    const unfinished = {
      id: 'unfinished',
      tags: ['latin'],
      raw: 'Alpha one. Beta two. Gamma three.',
      termStart: 11,
      termEnd: 15,
      locale: 'en',
      maxSentenceChars: 1000,
      sentence: 'Beta two.',
      why: 'nobody filled this in',
    }

    expect(faults(unfinished)).toContain('actual is missing')
    expect(faults({ ...unfinished, actual: null })).toContain('actual is malformed')
    expect(faults({ ...unfinished, actual: { sentence: 'Beta two.' } })).toContain(
      'actual is malformed',
    )
    expect(faults({ ...unfinished, actual: 'none', locale: '' })).toContain('locale')
    expect(faults({ ...unfinished, actual: 'none', why: '  ' })).toContain('why')
    expect(faults({ ...unfinished, actual: 'none' })).toEqual([])
  })

  /*
   * Every row's offsets must pick a term that is really there. An off-by-one
   * in a hand-written offset would otherwise show up as a segmentation
   * divergence between two engines that both segmented correctly.
   */
  it('gives every row a term inside its own run', () => {
    const bad = SENTENCE_CORPUS.filter(
      (row) =>
        row.termStart < 0 ||
        row.termEnd < row.termStart ||
        row.termEnd > row.raw.length,
    ).map((row) => row.id)

    expect(bad).toEqual([])
  })
})

const SOURCE_PATH = fileURLToPath(new URL('./sentenceCorpus.ts', import.meta.url))

describe('sentenceCorpus.ts is plain data', () => {
  /*
   * `scripts/sentence-parity.mjs` imports this module with nothing but Node's
   * own type stripping, and Node's ESM resolver does not add extensions. One
   * value import would resolve fine under vitest and fail only when someone
   * runs the parity script — the moment it is least welcome. Unlike
   * `corpus.ts` this file imports nothing at all, type or otherwise: its
   * schema is declared in it.
   */
  it('imports nothing, so plain Node can load it with no build step', () => {
    const { withoutComments } = scan(readFileSync(SOURCE_PATH, 'utf8'))

    expect([...withoutComments.matchAll(/^[ \t]*import\b[^\n]*/gm)].map((m) => m[0])).toEqual([])
    /* Non-vacuity for the scanner: it does find the export, so an empty list
     * above means there are no imports rather than that it stopped looking. */
    expect(withoutComments).toMatch(/^export const SENTENCE_CORPUS/m)
  })

  it('holds no executable expression — the rows are literals', () => {
    const { codeOnly } = scan(readFileSync(SOURCE_PATH, 'utf8'))

    expect(codeOnly).not.toMatch(/\bfunction\b/)
    expect(codeOnly).not.toMatch(/=>/)
    expect(codeOnly).not.toMatch(/\bnew\b/)
  })
})
