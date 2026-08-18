import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORPUS } from '../src/kernel/ui/reader/wordSnap/corpus.ts'
import { assertTransportable, buildSnippet, evaluateSnippet } from './word-snap-parity.mjs'

/**
 * `Intl.Segmenter` is backed by ICU, and Node and WebKit do not agree.
 * Measured in this repository: `isWordLike` is `true` for `3.14`, `1,000` and
 * `42` under Node's ICU and `false` for all three under the WKWebView the app
 * ships on. Our implementation never reads that flag, so this particular
 * divergence is already neutralised — but it proves the class is real, and a
 * macOS upgrade can shift WebKit's segmentation again.
 *
 * These cases are the part of the parity harness that can be gated. They prove
 * the generator produces WORKING code from the corpus at run time. The live
 * WebKit run belongs to the `live` lane — `node scripts/word-snap-live.mjs`,
 * manual-only — and **nothing here claims to have done it**. That separation is
 * the whole design: the guard against a silently empty live run has to live in
 * the lane that always runs, not in the lane being guarded.
 */

const SCRIPT = fileURLToPath(new URL('./word-snap-parity.mjs', import.meta.url))

/** The script, as a user would run it. `status` rather than a throw, because
 *  every exit-code case below is a case where a non-zero exit is the point. */
function run(args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: input ?? '',
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'word-snap-parity-'))
  const path = join(dir, name)
  writeFileSync(path, contents, 'utf8')
  return path
}

/** A Latin row with a distinctive id, used to prove the generator reads its
 *  argument. `probe word`: `word` spans 6..10, so an edge at 7 expands to 6 and
 *  one at 8 expands to 10. */
const PROBE = {
  id: 'derivation-probe',
  tags: ['latin'],
  strs: ['probe word'],
  start: { index: 0, offset: 7 },
  end: { index: 0, offset: 8 },
  expected: { start: { index: 0, offset: 6 }, end: { index: 0, offset: 10 } },
  why: 'a row that exists only in this test, so a generator with its own copy of the corpus cannot see it',
}

describe('word-snap-parity — the generated snippet', () => {
  /*
   * Real evaluation of the real generated source in a real JS context, with no
   * module resolver present. Not a string comparison against an expected
   * snippet: that would be a snapshot of the generator's formatting, and it
   * would pass while the snippet was syntactically broken. Evaluating it is
   * also what proves the snippet is self-contained, which is the one property
   * `webview_execute_js` actually requires.
   */
  it('reproduces the suite’s results when evaluated in Node', () => {
    const report = evaluateSnippet(buildSnippet(CORPUS))

    expect(report.total).toBe(CORPUS.length)
    expect(report.rows).toHaveLength(CORPUS.length)
    expect(report.rows.filter((row) => !row.pass).map((row) => row.id)).toEqual([])
    expect(report.errors).toBe(0)
    expect(report.failures).toBe(0)
    expect(report.ok).toBe(true)
  })

  /*
   * The case that makes "the parity check is not theatre" checkable. The plan
   * says the generator must read the fixture module and never a retyped copy;
   * feeding it a corpus with one extra row is the only assertion that can tell
   * the difference. A generator closing over its own table passes every other
   * case in this file and fails this one.
   */
  it('is derived from the rows it is given, not from a copy of its own', () => {
    const base = evaluateSnippet(buildSnippet(CORPUS))
    const grown = evaluateSnippet(buildSnippet([...CORPUS, PROBE]))

    expect(grown.rows).toHaveLength(CORPUS.length + 1)
    expect(grown.rows.map((row) => row.id)).toContain(PROBE.id)
    expect(base.rows.map((row) => row.id)).not.toContain(PROBE.id)
    expect(grown.rows.find((row) => row.id === PROBE.id).pass).toBe(true)
    expect(grown.ok).toBe(true)
  })

  /*
   * A divergence between two engines is useless without the segmentation that
   * caused it — that is the entire diagnostic value of a parity run. Without
   * this case the harness could ship reporting `pass: false` and nothing else.
   * The `failures === 1` assertion also proves the runner is not hardcoded to
   * report everything as passing.
   */
  it('fails a divergent row loudly, carrying both results and the engine’s segmentation', () => {
    const source = CORPUS.find((row) => row.id === 'expand-both-edges')
    const wrong = {
      ...source,
      id: 'wrong',
      expected: { start: { index: 0, offset: 5 }, end: source.expected.end },
    }

    const report = evaluateSnippet(buildSnippet([...CORPUS, wrong]))
    const row = report.rows.find((entry) => entry.id === 'wrong')

    expect(report.failures).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/1 of \d+ rows/)
    expect(row.pass).toBe(false)
    expect(row.expected).toEqual({ start: { index: 0, offset: 5 }, end: { index: 0, offset: 15 } })
    expect(row.actual).toEqual({ start: { index: 0, offset: 4 }, end: { index: 0, offset: 15 } })
    expect(row.segments).toEqual([
      { text: 'the', index: 0, wordLike: true },
      { text: ' ', index: 3, wordLike: false },
      { text: 'quick', index: 4, wordLike: true },
      { text: ' ', index: 9, wordLike: false },
      { text: 'brown', index: 10, wordLike: true },
      { text: ' ', index: 15, wordLike: false },
      { text: 'fox', index: 16, wordLike: true },
    ])
  })

  /*
   * `ok = failures === 0` scores an empty corpus a perfect pass — the same
   * class of silent success as a coverage report measuring zero lines. Fail
   * closed instead.
   */
  it('reports failure for a zero-row corpus rather than a clean sweep', () => {
    const report = evaluateSnippet(buildSnippet([]))

    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/empty|zero rows/i)
    expect(report.total).toBe(0)
    expect(report.failures).toBe(0)
    expect(report.rows).toEqual([])
  })

  /* The bridge serialises whatever the snippet returns, so a report holding
   * anything JSON cannot carry is a report that arrives mangled. */
  it('returns a report that survives JSON transport unchanged', () => {
    const report = evaluateSnippet(buildSnippet(CORPUS))

    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  /*
   * The corpus carries a soft hyphen, a word joiner, a zero-width joiner and
   * two astral characters, so the emitted data must be escaped down to ASCII.
   * The two characters that cannot be escaped away are the ones this checks:
   * they can only arrive from a COMMENT in the inlined source, and there they
   * would end the comment early and fail at parse inside the webview.
   */
  it('emits a snippet with no character that could break at parse in transit', () => {
    const snippet = buildSnippet(CORPUS)

    // The rows themselves are pure ASCII: everything up to the closing bracket
    // of the data literal.
    const data = snippet.slice(0, snippet.indexOf('\n];\n') + 4)
    expect(data).not.toBe('')
    expect(data.match(/[^\x20-\x7E\n]/g)).toBeNull()
    expect(() => assertTransportable(snippet)).not.toThrow()
  })

  it('refuses a snippet carrying a line terminator or an unpaired surrogate', () => {
    const u2028 = String.fromCharCode(0x2028)
    const highSurrogate = String.fromCharCode(0xd800)

    expect(() => assertTransportable('// a plain comment\nrun()')).not.toThrow()
    expect(() => assertTransportable(`// a comment${u2028}stillCode()`)).toThrow(/U\+2028/)
    expect(() => assertTransportable(`/* ${highSurrogate} */`)).toThrow(/U\+D800/)
    // A well-formed astral pair is fine — it is only the lone half that is not.
    expect(() => assertTransportable('/* \u{20000} */')).not.toThrow()
  })
})

describe('word-snap-parity — the script', () => {
  it('emits a snippet on stdout that evaluates to a clean report', () => {
    const { code, out } = run([])

    expect(code).toBe(0)
    const report = evaluateSnippet(out)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(CORPUS.length)
  })

  it('checks the corpus in this engine and exits zero', () => {
    const { code, out } = run(['--check'])
    const report = JSON.parse(out)

    expect(code).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(CORPUS.length)
  })

  /*
   * The bridge-unreachable case. A parity run that produced no report is not a
   * pass — it is a run that did not happen, and the two look identical in a
   * summary unless the exit code separates them.
   */
  it('exits non-zero when there is no report to compare — the bridge was unreachable', () => {
    const missing = join(tmpdir(), 'word-snap-parity-there-is-no-such-file.json')
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

  it('exits non-zero on a divergence, printing both engines’ results', () => {
    const local = JSON.parse(run(['--check']).out)
    const tampered = structuredClone(local)
    const target = tampered.rows.find((row) => row.id === 'expand-both-edges')
    target.actual = { start: { index: 0, offset: 5 }, end: { index: 0, offset: 15 } }

    const path = tempFile('diverged.json', JSON.stringify(tampered))
    const { code, err } = run(['--compare', path])

    expect(code).not.toBe(0)
    expect(err).toContain('expand-both-edges')
    expect(err).toMatch(/"offset": ?5/)
    expect(err).toMatch(/"offset": ?4/)
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
