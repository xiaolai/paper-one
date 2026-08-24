import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { SENTENCE_CORPUS } from '../src/kernel/ui/reader/wordSnap/sentenceCorpus.ts'
import { buildSnippet, evaluateSnippet } from './sentence-parity.mjs'

/**
 * The part of the sentence parity harness that CAN be gated.
 *
 * These cases prove the generator produces working code from the corpus at run
 * time. **The live WebKit run belongs to a manual lane and nothing here claims
 * to have done it** — that separation is the whole design: the guard against a
 * silently empty live run has to live in the lane that always runs, not in the
 * lane being guarded.
 */

const SCRIPT = fileURLToPath(new URL('./sentence-parity.mjs', import.meta.url))

/** The script, as a user would run it. `status` rather than a throw, because
 *  every exit-code case below is a case where a non-zero exit is the point. */
function run(args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: input ?? '',
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** Tracked and removed. Left behind, one directory per call leaks a copy of the
 *  corpus into the temp dir on every run of the suite. */
const scratch = []
function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'sentence-parity-'))
  scratch.push(dir)
  const path = join(dir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A row that exists only in this test, so a generator carrying its own copy of
 *  the corpus cannot see it. `Probe` spans 11..16 of the run below. */
const PROBE = {
  id: 'derivation-probe',
  tags: ['latin'],
  raw: 'Alpha one. Probe here. Beta two.',
  termStart: 11,
  termEnd: 16,
  locale: 'en',
  maxSentenceChars: 1000,
  sentence: 'Probe here.',
  actual: { sentence: 'Probe here.', term: 'Probe' },
  why: 'a row that exists only in this test. The second sentence is CAPITALISED deliberately — UAX #29 SB11 does not end a sentence before a lowercase word, so `probe here.` would have been swallowed and the probe would have proved the wrong thing',
}

describe('sentence-parity — the generated snippet', () => {
  /*
   * Real evaluation of the real generated source in a real JS context with no
   * module resolver present. Not a string comparison against an expected
   * snippet — that would be a snapshot of the generator's formatting and would
   * pass while the snippet was syntactically broken. Evaluating it is also what
   * proves the snippet is self-contained, which is the one property
   * `webview_execute_js` actually requires.
   */
  it('reproduces the suite’s results when evaluated in Node', () => {
    const report = evaluateSnippet(buildSnippet(SENTENCE_CORPUS))

    expect(report.total).toBe(SENTENCE_CORPUS.length)
    expect(report.rows).toHaveLength(SENTENCE_CORPUS.length)
    expect(report.rows.filter((row) => !row.pass).map((row) => row.id)).toEqual([])
    expect(report.errors).toBe(0)
    expect(report.failures).toBe(0)
    expect(report.ok).toBe(true)
  })

  /*
   * The case that makes "the parity check is not theatre" checkable. Feeding
   * the generator a corpus with one extra row is the only assertion that can
   * tell a generator reading the fixture from one closing over its own table —
   * the latter passes every other case in this file and fails this one.
   */
  it('is derived from the rows it is given, not from a copy of its own', () => {
    const base = evaluateSnippet(buildSnippet(SENTENCE_CORPUS))
    const grown = evaluateSnippet(buildSnippet([...SENTENCE_CORPUS, PROBE]))

    expect(grown.rows).toHaveLength(SENTENCE_CORPUS.length + 1)
    expect(grown.rows.map((row) => row.id)).toContain(PROBE.id)
    expect(base.rows.map((row) => row.id)).not.toContain(PROBE.id)
    expect(grown.rows.find((row) => row.id === PROBE.id).pass).toBe(true)
    expect(grown.ok).toBe(true)
  })

  /*
   * A divergence is useless without the segmentation that caused it — that is
   * the entire diagnostic value of a parity run. The `failures === 1`
   * assertion also proves the runner is not hardcoded to report everything as
   * passing.
   */
  it('fails a divergent row loudly, carrying both answers and the engine’s boundaries', () => {
    const wrong = { ...PROBE, id: 'wrong', actual: { sentence: 'Alpha one.', term: 'Probe' } }

    const report = evaluateSnippet(buildSnippet([...SENTENCE_CORPUS, wrong]))
    const row = report.rows.find((entry) => entry.id === 'wrong')

    expect(report.failures).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/1 of \d+ rows/)
    expect(row.pass).toBe(false)
    expect(row.expected).toEqual({ sentence: 'Alpha one.', term: 'Probe' })
    expect(row.actual).toEqual({ sentence: 'Probe here.', term: 'Probe' })
    expect(row.segments).toEqual([
      ['Alpha one. ', 0],
      ['Probe here. ', 11],
      ['Beta two.', 23],
    ])
  })

  /*
   * The corpus is the record of what the implementation does NOT get right,
   * and a report that dropped that count would look like a clean sweep of a
   * suite that had quietly stopped measuring anything.
   */
  it('reports how many rows are known shortfalls, separately from failures', () => {
    const report = evaluateSnippet(buildSnippet(SENTENCE_CORPUS))

    expect(report.uncovered).toBeGreaterThan(0)
    expect(report.uncovered).toBeLessThan(report.total)
    expect(report.rows.filter((row) => !row.covered)).toHaveLength(report.uncovered)
    /* A shortfall is not a failure: the row still returns what the corpus says
     * it returns. Conflating the two would make the harness red on a healthy
     * app, which is how a check gets switched off. */
    expect(report.failures).toBe(0)
  })

  /*
   * `ok = failures === 0` scores an empty corpus a perfect pass — the same
   * class of silent success as a coverage report measuring zero lines.
   */
  it('reports failure for a zero-row corpus rather than a clean sweep', () => {
    const report = evaluateSnippet(buildSnippet([]))

    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/empty|zero rows/i)
    expect(report.total).toBe(0)
    expect(report.failures).toBe(0)
    expect(report.rows).toEqual([])
  })

  it('returns a report that survives JSON transport unchanged', () => {
    const report = evaluateSnippet(buildSnippet(SENTENCE_CORPUS))

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  /*
   * The corpus carries a soft hyphen, a no-break space, a line feed, Han and
   * kana. Every one of them is a character a transport, a terminal or a
   * copy-paste can eat — and the failure would look like a segmentation
   * divergence rather than like the mangling it is.
   */
  it('emits the rows as pure ASCII, so nothing in them can be eaten in transit', () => {
    const snippet = buildSnippet(SENTENCE_CORPUS)

    const data = snippet.slice(0, snippet.indexOf('\n];\n') + 4)
    expect(data).not.toBe('')
    expect(data.match(/[^\x20-\x7E\n]/g)).toBeNull()
    /* Non-vacuity: the rows really do carry those characters, so an ASCII-only
     * data block means they were escaped rather than that there was nothing to
     * escape. */
    expect(SENTENCE_CORPUS.some((row) => /[^\x20-\x7E]/.test(row.raw))).toBe(true)
  })
})

describe('sentence-parity — the script', () => {
  it('emits a snippet on stdout that evaluates to a clean report', () => {
    const { code, out } = run([])

    expect(code).toBe(0)
    const report = evaluateSnippet(out)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(SENTENCE_CORPUS.length)
  })

  it('checks the corpus in this engine and exits zero', () => {
    const { code, out } = run(['--check'])
    const report = JSON.parse(out)

    expect(code).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(SENTENCE_CORPUS.length)
  })

  /*
   * The bridge-unreachable case. A parity run that produced no report is not a
   * pass — it is a run that did not happen, and the two look identical in a
   * summary unless the exit code separates them.
   */
  it('exits non-zero when there is no report to compare — the bridge was unreachable', () => {
    const missing = join(tmpdir(), 'sentence-parity-there-is-no-such-file.json')
    const { code, err } = run(['--compare', missing])

    expect(code).not.toBe(0)
    expect(err).toMatch(/report/i)
  })

  it('exits non-zero on a report holding zero rows', () => {
    const path = tempFile('empty.json', JSON.stringify({ ok: true, total: 0, rows: [] }))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/empty|zero rows/i)
  })

  it('exits non-zero on a divergent answer, printing both engines’ results', () => {
    const local = JSON.parse(run(['--check']).out)
    const tampered = structuredClone(local)
    const target = tampered.rows.find((row) => row.id === 'abbreviation-title')
    target.actual = { sentence: 'Smith today.', term: 'Smith' }

    const path = tempFile('diverged.json', JSON.stringify(tampered))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toContain('abbreviation-title')
    expect(err).toContain('He met Mr. Smith today.')
    expect(err).toContain('Smith today.')
  })

  /*
   * The subtler half, and the reason boundaries are recorded for every row
   * rather than only failing ones: two engines can agree on the answer today
   * while their segmentation has already moved underneath it.
   */
  it('exits non-zero when the boundaries moved even though the answer agreed', () => {
    const local = JSON.parse(run(['--check']).out)
    const tampered = structuredClone(local)
    const target = tampered.rows.find((row) => row.id === 'abbreviation-title')
    target.segments = [['Alpha one. He met Mr. Smith today. Beta two.', 0]]

    const path = tempFile('boundaries.json', JSON.stringify(tampered))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/segmented differently/)
  })

  /*
   * The subtler staleness, and the one comparing IDs could not see: a report
   * from an older corpus whose row kept its id while its text moved underneath
   * it. It agrees on every id, and it can agree on the answers by luck.
   */
  it('exits non-zero when a row kept its id but changed underneath', () => {
    const local = JSON.parse(run(['--check']).out)
    const tampered = structuredClone(local)
    const target = tampered.rows.find((row) => row.id === 'abbreviation-title')
    target.raw = 'Alpha one. He met Mrs. Smith today. Beta two.'

    const path = tempFile('restated.json', JSON.stringify(tampered))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/DIFFERENT version of this row/)
    expect(err).toContain('abbreviation-title')
  })

  it('exits non-zero when the report was produced from a different corpus', () => {
    const local = JSON.parse(run(['--check']).out)
    const short = { ...local, rows: local.rows.slice(1), total: local.total - 1 }
    const path = tempFile('short.json', JSON.stringify(short))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/corpus/i)
  })

  it('accepts an agreeing report on stdin and exits zero', () => {
    const { code: checkCode, out } = run(['--check'])
    const { code, err } = run(['--compare', '-'], out)

    expect(checkCode).toBe(0)
    expect(code).toBe(0)
    expect(err).toMatch(/agree/i)
  })
})
