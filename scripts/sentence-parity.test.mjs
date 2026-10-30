import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SENTENCE_CORPUS } from '../src/kernel/ui/reader/wordSnap/sentenceCorpus.ts'
/* The evaluator is shared with the word-snap harness and is tested there, in
   `lib/parity.test.mjs`; these cases use it to RUN what this harness emits. */
import { evaluateSnippet } from './lib/parity.mjs'
import { buildSnippet, compareReports, loadCorpus, main } from './sentence-parity.mjs'

/**
 * The part of the sentence parity harness that CAN be gated.
 *
 * These cases prove the generator produces working code from the corpus at run
 * time. **The live WebKit run belongs to a manual lane and nothing here claims
 * to have done it** — that separation is the whole design: the guard against a
 * silently empty live run has to live in the lane that always runs, not in the
 * lane being guarded.
 *
 * ⚠️ **THE SCRIPT IS CALLED, NOT SPAWNED — EXCEPT TO PROVE THE ENTRY POINT.**
 * Its cases used to run the CLI as a child process, which exercises it
 * faithfully and measures none of it: a child runs outside the test runner, so
 * coverage and mutation testing both saw `main`, `compareReports` and the report
 * reader as code no test reached — 209 mutants uncovered behind seventeen green
 * tests. `main` takes its streams, its stdin and its corpus as arguments now,
 * and two spawn cases remain for the one thing only a process can show.
 */

const SCRIPT = fileURLToPath(new URL('./sentence-parity.mjs', import.meta.url))

/** One directory for the whole file, made before its first case and removed
 *  after its last. Left behind, it leaks a copy of the corpus into the temp dir
 *  on every run of the suite.
 *
 *  NOT at module scope: collecting a file runs its body and no hook — `vitest
 *  list` does exactly that, and `pnpm test:ledger` runs it, and so does a run
 *  whose name filter leaves no case here — so a directory made there was left
 *  behind each time. */
let scratch
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sentence-parity-'))
})
let written = 0
function tempFile(name, contents) {
  written += 1
  const path = join(scratch, `${written}-${name}`)
  writeFileSync(path, contents, 'utf8')
  return path
}

afterAll(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
})

/**
 * The script, called the way its entry point calls it, with everything it says
 * captured. `stdin` is an open FILE, read by the same call the process uses on
 * descriptor 0 — and it is empty unless a case fills it, so a case that names a
 * report file fails loudly if the script reads stdin instead.
 */
async function cli(args, { stdin = '', corpus } = {}) {
  const descriptor = openSync(tempFile('stdin.json', stdin), 'r')
  const out = []
  const err = []
  try {
    const code = await main(args, {
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      stdin: descriptor,
      corpus,
    })
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    closeSync(descriptor)
  }
}

/** The script as a user runs it. `status` rather than a throw, because both
 *  cases that still spawn are about the exit code. */
function spawn(args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: input ?? '',
  })
  return { code: result.status, err: result.stderr ?? '' }
}

/** What a throw leaves behind, or `null` when nothing was thrown — asserted as a
 *  value, because a matcher on the message alone cannot tell a real `Error`
 *  from a rejection with nothing in it. */
function thrownBy(act) {
  try {
    act()
    return null
  } catch (cause) {
    return cause
  }
}

/** Spelled out, not imported: the words are the behaviour under test. */
const USAGE = [
  'usage:',
  '  node scripts/sentence-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/sentence-parity.mjs --check         run the snippet in this engine',
  '  node scripts/sentence-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/sentence-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

const ENGINE = 'no navigator — not a browser engine'
/** What a webview report calls its engine in these cases. Anything that names
 *  a browser will do; Node's own name is refused — see `compareReports`. */
const WEBKIT = 'WebKit under test'
const NO_REPORT =
  '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n'

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
  why: 'a row that exists only in this test. The second sentence is CAPITALISED deliberately — UAX #29 SB8 does not end a sentence after a full stop when the next word is lowercase, so `probe here.` would have been swallowed and the probe would have proved the wrong thing',
}

/** This engine's report for `rows`, relabelled as a webview's. */
const asWebview = (rows) => ({ ...evaluateSnippet(buildSnippet(rows)), engine: WEBKIT })

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
  it('fails a divergent row loudly, carrying both answers and the segmentation behind them', () => {
    const wrong = { ...PROBE, id: 'wrong', actual: { sentence: 'Alpha one.', term: 'Probe' } }

    const report = evaluateSnippet(buildSnippet([...SENTENCE_CORPUS, wrong]))
    const row = report.rows.find((entry) => entry.id === 'wrong')

    expect(report.failures).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.reason).toMatch(/1 of \d+ rows/)
    expect(row.pass).toBe(false)
    expect(row.expected).toEqual({ sentence: 'Alpha one.', term: 'Probe' })
    expect(row.actual).toEqual({ sentence: 'Probe here.', term: 'Probe' })
    expect(row.segmented).toEqual([['Alpha one. Probe here. Beta two.', [0, 11, 23]]])
  })

  /*
   * ⚠️ THE TRACE WAS `row.raw`, SEGMENTED BY THE DRIVER — and the extractor
   * never segments that text here. It squeezes the doubled space first, and at
   * the run's start it asks about the text joined to what lies before it. Both
   * of those are what the engine was handed, and the raw run is neither.
   */
  it('records each segmentation the extractor asked for, and not one of its own', () => {
    const traced = {
      id: 'traced',
      tags: ['latin'],
      raw: 'Probe  here. Beta two.',
      termStart: 0,
      termEnd: 5,
      locale: 'en',
      maxSentenceChars: 1000,
      before: 'Earlier.',
      sentence: 'Probe here.',
      actual: { sentence: 'Probe here.', term: 'Probe' },
      why: 'a doubled space the extractor squeezes, and a far side it joins on at the start of the run',
    }

    const row = evaluateSnippet(buildSnippet([traced])).rows[0]

    expect(row.pass).toBe(true)
    expect(row.segmented).toEqual([
      ['Probe here. Beta two.', [0, 12]],
      ['Earlier. Probe here. Beta two.', [0, 9, 21]],
    ])
  })

  /*
   * A row can ask for the fallback walk, which answers without the completeness
   * gate. The term here opens the run and nothing is known before it, so the
   * gated walk refuses and only the ungated one returns the sentence — which is
   * what tells a driver that passes the flag from one that drops it. Absent
   * stays absent in the report, because absent is the gate ON.
   */
  it('walks a row without the completeness gate when the row says so, and records which walk it was', () => {
    const ungated = {
      ...PROBE,
      id: 'ungated',
      raw: 'Probe here. Beta two.',
      termStart: 0,
      termEnd: 5,
      requireComplete: false,
      why: 'the term opens the run and nothing is known before it, so only the ungated walk answers',
    }
    const gated = { ...ungated, id: 'gated', requireComplete: undefined }

    const report = evaluateSnippet(buildSnippet([ungated, gated]))

    expect(report.rows.map((entry) => [entry.id, entry.requireComplete, entry.actual])).toEqual([
      ['ungated', false, { sentence: 'Probe here.', term: 'Probe' }],
      ['gated', undefined, 'none'],
    ])
    expect(report.rows.find((entry) => entry.id === 'gated')).not.toHaveProperty('requireComplete')
  })

  /*
   * Nothing between the engine and the row catches any more. A locale the
   * engine refuses throws inside the extractor, and that throw is the row's
   * error — in the engine's own words, not replaced by an empty trace.
   */
  it('fails a row whose locale the engine refuses, carrying the engine’s own words', () => {
    const refused = { ...PROBE, id: 'refused-locale', locale: 'en_US' }

    const report = evaluateSnippet(buildSnippet([PROBE, refused]))
    const row = report.rows.find((entry) => entry.id === 'refused-locale')

    expect(row.error).toBe(thrownBy(() => new Intl.Segmenter('en_US')).message)
    expect(row.pass).toBe(false)
    expect(row.segmented).toEqual([])
    expect(report.errors).toBe(1)
    expect(report.failures).toBe(1)
  })

  /*
   * ⚠️ A REPORT FROM OLDER CODE PASSED AGAINST NEWER CODE. The report names the
   * code it ran by digest — and the digest has to be of THAT code, all of it
   * and nothing else, or a change to the driver or the trace would slip past
   * exactly as a change to the extractor used to.
   */
  it('names the code it ran, and that code alone', () => {
    const marker = "const IMPLEMENTATION = '"
    const snippet = buildSnippet([PROBE])
    const opens = snippet.indexOf(marker) + marker.length
    const closes = snippet.indexOf("';\n", opens)
    const named = snippet.slice(opens, closes)
    const code = snippet.slice(closes + "';\n".length, snippet.length - '})()\n'.length)

    expect(evaluateSnippet(snippet).implementation).toBe(named)
    expect(named).toBe(createHash('sha256').update(code).digest('hex'))
    expect(code).toContain('function sentenceOf(')
    /* The rows are not the code — `inputsOf` answers for those. */
    expect(buildSnippet([PROBE, { ...PROBE, id: 'another' }])).toContain(`${marker}${named}';\n`)
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

  /*
   * An empty string and an array-like both have a `length`, and the first
   * would otherwise build a perfectly good snippet of zero rows — so the
   * refusal is asserted by its own words, not by any TypeError at all.
   */
  it('refuses rows that are not an array, even ones with a length', () => {
    for (const rows of [undefined, '', { length: 0 }, { 0: PROBE, length: 1 }]) {
      const refusal = thrownBy(() => buildSnippet(rows))

      expect(refusal).toBeInstanceOf(TypeError)
      expect(refusal.message).toBe('sentence-parity: buildSnippet needs an array of corpus rows')
    }
  })

  /*
   * The inlined implementation was written as an ES module, which is always
   * strict, and the snippet runs it as a plain script, which is not unless it
   * says so. From outside a closed function strictness shows through one door
   * the language keeps shut on purpose: a sloppy function's `caller` never
   * reveals a strict one. So the probe is a sloppy getter on `navigator`, which
   * the driver reads first.
   */
  it('runs the inlined implementation in strict mode, as the module it was written as', () => {
    const callersSeenBy = (snippet) => {
      const context = createContext({})
      runInContext(
        'var callers = [];\n' +
          "Object.defineProperty(globalThis, 'navigator', { get: function probe() { callers.push(probe.caller); return undefined; } });\n",
        context,
      )
      runInContext(snippet, context)
      return [...context.callers]
    }

    const snippet = buildSnippet([PROBE])
    const strict = callersSeenBy(snippet)
    expect(strict.length).toBeGreaterThan(0)
    expect(strict.filter((caller) => caller !== null)).toEqual([])

    /* The known positive: the same snippet without its directive, and the same
     * probe sees exactly who called it. */
    const sloppy = callersSeenBy(snippet.replace("'use strict';\n", ''))
    expect(sloppy.length).toBeGreaterThan(0)
    expect(sloppy.every((caller) => typeof caller === 'function')).toBe(true)
  })

  /* The evaluator's own cases — the realm crossing, the missing resolver and
     the timeout — moved to `lib/parity.test.mjs` with the evaluator, which both
     harnesses now share. Testing it here as well would be one behaviour under
     two names, and the copies are what that extraction was for. */

  it('reads the corpus from disk, and refuses a module that does not export one', async () => {
    expect(await loadCorpus()).toEqual(SENTENCE_CORPUS)

    const impostor = pathToFileURL(
      tempFile('impostor.mjs', 'export const SENTENCE_CORPUS = { rows: [] }\n'),
    )
    const cause = await loadCorpus(impostor).then(
      () => null,
      (thrown) => thrown,
    )

    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toBe(
      `sentence-parity: ${impostor.href} did not export a SENTENCE_CORPUS array`,
    )
  })
})

/**
 * A report row as the driver writes one, small enough that every message the
 * comparison can print is spelled out in full below. Its inputs serialise as
 * `["a","One. Two.",5,8,"en",1000,null,"Three.",{"gated":true},"Two.",{"sentence":"Two.","term":"Two"}]`,
 * and its one segmentation as `[["One. Two.",[0,5]]]`.
 */
function row(id, overrides = {}) {
  return {
    id,
    tags: [],
    locale: 'en',
    raw: 'One. Two.',
    termStart: 5,
    termEnd: 8,
    maxSentenceChars: 1000,
    before: null,
    after: 'Three.',
    sentence: 'Two.',
    expected: { sentence: 'Two.', term: 'Two' },
    actual: { sentence: 'Two.', term: 'Two' },
    covered: true,
    pass: true,
    error: null,
    segmented: [['One. Two.', [0, 5]]],
    ...overrides,
  }
}

function reportOf(rows, overrides = {}) {
  return {
    ok: true,
    engine: 'a test engine',
    total: rows.length,
    failures: 0,
    errors: 0,
    uncovered: 0,
    reason: null,
    rows,
    ...overrides,
  }
}

const INPUTS = (side, gate = { gated: true }) =>
  JSON.stringify(['a', 'One. Two.', 5, 8, 'en', 1000, side, 'Three.', gate, 'Two.', { sentence: 'Two.', term: 'Two' }])

/** How a refusal of a report's row shapes opens, and how one of its claims does
 *  — spelled out, not imported: the words are the behaviour under test. */
const SHAPE = "the report's rows are missing fields this harness writes, or carry them as the wrong type: "
const CLAIMS = "the report's own claims contradict its rows: "

describe('sentence-parity — comparing a webview report', () => {
  it('finds nothing to say about a report that matches row for row', () => {
    const local = reportOf([row('a'), row('b')])

    expect(compareReports(local, structuredClone(local))).toEqual({ problems: [], notes: [] })
  })

  it('refuses anything that is not a report with a rows array', () => {
    const local = reportOf([row('a')])

    for (const live of [null, undefined, 'rows', { ok: true }, { rows: 'a, b' }]) {
      expect(compareReports(local, live)).toEqual({
        problems: ['the report has no rows array — it is not a report this harness produced'],
        notes: [],
      })
    }
  })

  it('refuses a report holding zero rows', () => {
    expect(compareReports(reportOf([row('a')]), reportOf([]))).toEqual({
      problems: ['the report holds zero rows — an empty run is a failure, not a clean sweep'],
      notes: [],
    })
  })

  /*
   * ⚠️ NODE'S OWN REPORT, FED BACK, PASSED FOR WEBKIT'S. What `--check` prints
   * is a perfectly good report of the wrong engine, and so is one from Node
   * outside a vm, whose `navigator` says `Node.js/`.
   */
  it('refuses a report that did not come from a browser', () => {
    const local = reportOf([row('a')])

    for (const engine of [ENGINE, 'Node.js/24', undefined, 7]) {
      expect(compareReports(local, reportOf([row('a')], { engine }))).toEqual({
        problems: [
          `the report came from ${String(engine)}, not a browser — an engine compared with itself says nothing about WebKit`,
        ],
        notes: [],
      })
    }
    expect(compareReports(local, reportOf([row('a')], { engine: 'Mozilla/5.0 AppleWebKit Node.js/24' }))).toEqual({
      problems: [],
      notes: [],
    })
  })

  /* ⚠️ A REPORT FROM OLDER CODE PASSED AGAINST NEWER CODE, wherever the change
     had not moved an answer yet. */
  it('refuses a report produced by different code, however well its rows agree', () => {
    const local = reportOf([row('a')], { implementation: 'aaa' })
    const said = (other) =>
      `the report was produced by different code: ${other} against aaa here — emit the snippet again and rerun it in the webview`

    expect(compareReports(local, reportOf([row('a')], { implementation: 'bbb' }))).toEqual({
      problems: [said('bbb')],
      notes: [],
    })
    expect(compareReports(local, reportOf([row('a')]))).toEqual({ problems: [said('undefined')], notes: [] })
  })

  /*
   * ⚠️ THE TOTALS WERE BELIEVED OVER THE ROWS. The first case is the report the
   * audit built: every flag says clean — `ok`, no failures — while a row did
   * not pass and threw, and the total is wrong. Then each total alone, so a
   * check that read only one of them fails a different expectation.
   *
   * ⚠️ **AND `uncovered` WAS NOT ONE OF THEM.** `uncovered: 999` beside a
   * 37-row corpus compared successfully — finding #20, reproduced 2026-09-14 —
   * and the note then printed whatever number the report had chosen.
   */
  it('refuses a report whose own totals contradict its rows', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (live) => compareReports(local, live)
    /* A row that did not pass because its answer is not the corpus's, so its
       own `pass` agrees with it and only the total is wrong. */
    const failing = row('b', { pass: false, actual: { sentence: 'One.', term: 'Two' } })
    const short = row('b', { sentence: 'One. Two.', covered: false })

    expect(refusedFor(reportOf([row('a'), row('b', { pass: false, error: 'it threw' })], { total: 3, errors: 1 }))).toEqual({
      problems: [`${CLAIMS}total 3 for 2 rows, failures 0 but 1 not passing`],
      notes: [],
    })
    expect(refusedFor(reportOf([row('a'), row('b')], { total: 1 })).problems).toEqual([`${CLAIMS}total 1 for 2 rows`])
    expect(refusedFor(reportOf([row('a'), failing], { failures: 0 })).problems).toEqual([
      `${CLAIMS}failures 0 but 1 not passing`,
    ])
    expect(refusedFor(reportOf([row('a'), row('b')], { errors: 2 })).problems).toEqual([
      `${CLAIMS}errors 2 but 0 carrying an error`,
    ])
    expect(refusedFor(reportOf([row('a'), row('b')], { uncovered: 999 })).problems).toEqual([
      `${CLAIMS}uncovered 999 but 0 not covered`,
    ])
    expect(refusedFor(reportOf([row('a'), short], { uncovered: 0 })).problems).toEqual([
      `${CLAIMS}uncovered 0 but 1 not covered`,
    ])
  })

  /*
   * ⚠️ **A ROW COULD PASS AND CARRY AN ERROR AT THE SAME TIME.** The driver
   * writes `pass` as `error === null && the answer agrees`, so the two can only
   * disagree in a report it did not write — but every total then adds up (one
   * error, no failures, the right count) and the reading went straight past it
   * to compare the rows. A row that threw did not pass, whatever it says of
   * itself.
   */
  it('refuses a report whose row passes while carrying an error', () => {
    const local = reportOf([row('a'), row('b')])
    const live = reportOf([row('a'), row('b', { error: 'it threw' })], { errors: 1 })

    expect(compareReports(local, live)).toEqual({
      problems: [`${CLAIMS}rows whose pass contradicts their error or their answer: ["b"]`],
      notes: [],
    })
  })

  /*
   * ⚠️ **AND A ROW COULD PASS WITH THE WRONG ANSWER, FAIL WITH THE RIGHT ONE, OR
   * CALL ITSELF COVERED WHEN ITS OWN SENTENCE SAYS OTHERWISE — WITH EVERY TOTAL
   * AGREEING.** The driver writes both flags from the row's other fields:
   * `pass` from its error and whether its answer is the expected one, `covered`
   * from whether its hand-written sentence is the expected one. Those fields are
   * held to the corpus row by row, so a flag that disagrees with them is a claim
   * nothing in the report supports — and a total counted from such flags agrees
   * with them, which is how the totals above let it through.
   */
  it('refuses a report whose rows claim a pass or a coverage their own fields contradict', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (b, totals = {}) => compareReports(local, reportOf([row('a'), b], totals)).problems
    const PASS = `${CLAIMS}rows whose pass contradicts their error or their answer: ["b"]`
    const COVERED = `${CLAIMS}rows whose covered contradicts their sentence: ["b"]`

    expect(refusedFor(row('b', { actual: { sentence: 'One.', term: 'Two' } }))).toEqual([PASS])
    expect(refusedFor(row('b', { actual: { sentence: 'Two.', term: 'One' } }))).toEqual([PASS])
    expect(refusedFor(row('b', { actual: 'none' }))).toEqual([PASS])
    expect(refusedFor(row('b', { pass: false }), { failures: 1 })).toEqual([PASS])
    expect(refusedFor(row('b', { covered: false }), { uncovered: 1 })).toEqual([COVERED])
    expect(refusedFor(row('b', { sentence: 'One.', expected: 'none', actual: 'none' }))).toEqual([COVERED])
    expect(refusedFor(row('b', { sentence: 'none', expected: 'none', actual: 'none', covered: false }), { uncovered: 1 })).toEqual([
      COVERED,
    ])
  })

  /*
   * ⚠️ **A ROW MISSING A FIELD THE DRIVER ALWAYS WRITES COMPARED SUCCESSFULLY.**
   * Finding #20, reproduced 2026-09-14: with `error` taken out of every row, a
   * report still agreed, because an absent error read as no error. Every field
   * the driver writes is held to its type now, before any of them is believed —
   * a required one missing, any one mistyped, a row that is not an object at
   * all. A row is named by its id, or by where it stands when it has none.
   */
  it('refuses a report whose rows lack a field the driver writes or carry one as the wrong type, naming the field and the rows', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (b) => compareReports(local, reportOf([row('a'), b]))
    const without = (field) => {
      const one = row('b')
      delete one[field]
      return one
    }
    const REQUIRED = ['id', 'tags', 'locale', 'raw', 'termStart', 'termEnd', 'maxSentenceChars', 'sentence', 'expected', 'actual', 'covered', 'pass', 'error', 'segmented']
    const refusal = (field) => ({ problems: [`${SHAPE}${field} in ${field === 'id' ? '[1]' : '["b"]'}`], notes: [] })

    for (const field of REQUIRED) expect(refusedFor(without(field)), `without ${field}`).toEqual(refusal(field))
    for (const [field, value] of [
      ['id', 7],
      ['tags', 'latin'],
      ['tags', ['latin', 3]],
      ['locale', null],
      ['raw', 5],
      ['termStart', '5'],
      ['termEnd', null],
      ['maxSentenceChars', '1000'],
      ['sentence', null],
      ['expected', null],
      ['expected', 'None'],
      ['expected', { sentence: 'Two.' }],
      ['expected', { term: 'Two' }],
      ['actual', 3],
      ['actual', { sentence: 'Two.', term: 2 }],
      ['covered', 'true'],
      ['pass', 1],
      ['error', 3],
      ['segmented', 'One. Two.'],
      ['segmented', [['One. Two.', [0, 5], []]]],
      ['segmented', [{ 0: 'One. Two.', 1: [0, 5], length: 2 }]],
      ['segmented', [[5, [0, 5]]]],
      ['segmented', [['One. Two.', 5]]],
      ['segmented', [['One. Two.', ['0']]]],
      /* One boundary a number and one not: refused as a whole, not for having one. */
      ['segmented', [['One. Two.', [0, '5']]]],
      ['before', 3],
      ['after', false],
      ['requireComplete', 'no'],
    ]) {
      expect(refusedFor(row('b', { [field]: value })), `${field} as ${JSON.stringify(value)}`).toEqual(refusal(field))
    }
    expect(refusedFor(null)).toEqual({
      problems: [`${SHAPE}${REQUIRED.map((field) => `${field} in [1]`).join(', ')}`],
      notes: [],
    })
  })

  /* The other half: every shape the driver CAN write — a row that threw and so
     has no answer, an answer of `none`, a row the corpus knows it gets wrong,
     far sides and a gate left out — is read, not refused. */
  it('accepts every shape the driver writes a row in', () => {
    const open = row('open')
    delete open.before
    delete open.after
    const local = reportOf(
      [
        row('a'),
        row('threw', { actual: null, pass: false, error: 'Incorrect locale information provided', segmented: [] }),
        row('none', { sentence: 'none', expected: 'none', actual: 'none', requireComplete: false }),
        row('short', { sentence: 'One.', expected: 'none', actual: 'none', covered: false }),
        open,
      ],
      { ok: false, failures: 1, errors: 1, uncovered: 1, reason: '1 of 5 rows diverged from the corpus' },
    )

    expect(compareReports(local, structuredClone(local))).toEqual({
      problems: ['the webview reported 1 of its own failures against the corpus'],
      notes: ['1 of 5 rows are cases the implementation does not get right; see each row’s `why` in sentenceCorpus.ts'],
    })
  })

  /*
   * Each clause is printed only when it has something in it, so every case
   * below leaves out a different one — a clause that printed an empty list, or
   * never printed at all, fails a different case.
   */
  it('names the rows a report from a different corpus lacks and adds', () => {
    const local = reportOf([row('a'), row('b'), row('c')])
    const against = (...ids) => compareReports(local, reportOf(ids.map((id) => row(id))))
    const corpus = 'the report was produced from a different corpus: '

    expect(against('b', 'c', 'd')).toEqual({
      problems: [`${corpus}3 rows against 3 here, missing ["a"], unexpected ["d"]`],
      notes: [],
    })
    expect(against('a', 'b')).toEqual({
      problems: [`${corpus}2 rows against 3 here, missing ["c"]`],
      notes: [],
    })
    expect(against('a', 'b', 'c', 'd')).toEqual({
      problems: [`${corpus}4 rows against 3 here, unexpected ["d"]`],
      notes: [],
    })
    /* The same rows in another order are still another corpus: rows are
     * compared by position. */
    expect(against('b', 'a', 'c')).toEqual({
      problems: [`${corpus}3 rows against 3 here`],
      notes: [],
    })
  })

  /*
   * The subtler staleness, and the one comparing IDs could not see: a report
   * from an older corpus whose row kept its id while its text moved underneath
   * it. It agrees on every id, and it can agree on the answers by luck — so it
   * is reported once, as a different row, and not also as a different answer.
   */
  it('reports a row that kept its id but changed underneath, and nothing else about it', () => {
    /* Its expectation moved with its text, so the row's own flags agree with
       it: one that contradicted itself would be refused before rows are read. */
    const moved = { sentence: 'One.', term: 'Two' }
    const live = reportOf([row('a', { raw: 'One. Two!', sentence: 'One.', expected: moved, actual: moved })])

    expect(compareReports(reportOf([row('a')]), live)).toEqual({
      problems: [
        'a: the report was produced from a DIFFERENT version of this row\n' +
          `    node    ${INPUTS(null)}\n` +
          `    webview ${JSON.stringify(['a', 'One. Two!', 5, 8, 'en', 1000, null, 'Three.', { gated: true }, 'One.', moved])}`,
      ],
      notes: [],
    })
  })

  /*
   * THE COMPLETENESS GATE IS AN INPUT TOO, and absent is not `false`: absent is
   * the gate ON, `sentenceOf`'s default, and `false` is the fallback walk that
   * answers without it. A report from before a row's gate changed agrees on
   * every other input and can agree on the answer by luck.
   */
  it('reports a row whose completeness gate changed underneath it', () => {
    const ungated = row('a', { requireComplete: false })

    expect(compareReports(reportOf([row('a')]), reportOf([ungated]))).toEqual({
      problems: [
        'a: the report was produced from a DIFFERENT version of this row\n' +
          `    node    ${INPUTS(null)}\n` +
          `    webview ${INPUTS(null, false)}`,
      ],
      notes: [],
    })
    expect(compareReports(reportOf([ungated]), reportOf([structuredClone(ungated)]))).toEqual({
      problems: [],
      notes: [],
    })
  })

  /*
   * AND THE FAR SIDES ARE INPUTS TOO, where absent and `null` are different
   * ones — "nothing is known across this edge" and "nothing lies across it".
   * An array serialises both as `null`, so the message has to spell the absent
   * one out, and a row absent on both sides is not a difference at all.
   */
  it('tells a far side that is absent from one that is null', () => {
    const lost = row('a')
    delete lost.before

    expect(compareReports(reportOf([row('a')]), reportOf([lost]))).toEqual({
      problems: [
        'a: the report was produced from a DIFFERENT version of this row\n' +
          `    node    ${INPUTS(null)}\n` +
          `    webview ${INPUTS({ unknown: true })}`,
      ],
      notes: [],
    })
    expect(compareReports(reportOf([lost]), reportOf([structuredClone(lost)]))).toEqual({
      problems: [],
      notes: [],
    })
  })

  /* ⚠️ FIELD ORDER WAS COMPARED AS BEHAVIOUR: the same answer, written with its
     fields the other way round, diverged — as an answer and as an input. */
  it('compares answers by what they say, not by the order their fields were written in', () => {
    const reordered = row('a', {
      actual: { term: 'Two', sentence: 'Two.' },
      expected: { term: 'Two', sentence: 'Two.' },
    })

    expect(compareReports(reportOf([row('a')]), reportOf([reordered]))).toEqual({ problems: [], notes: [] })
  })

  it('prints both answers and both segmentations for a row extracted differently', () => {
    /* The corpus expects the webview's answer, so that row passes as written
       and this engine's does not; a webview row whose `pass` contradicted its
       own answer would be refused before any answer is compared. */
    const expected = { sentence: 'One.', term: 'Two' }
    const local = reportOf([row('a', { sentence: 'One.', expected, pass: false })], { failures: 1 })
    const live = reportOf([row('a', { sentence: 'One.', expected, actual: expected, segmented: [['One. Two.', [0]]] })])

    expect(compareReports(local, live)).toEqual({
      problems: [
        'a: extracted differently\n' +
          '    node    {"sentence":"Two.","term":"Two"}\n' +
          '    webview {"sentence":"One.","term":"Two"}\n' +
          '    node    segmented [["One. Two.",[0,5]]]\n' +
          '    webview segmented [["One. Two.",[0]]]',
      ],
      notes: [],
    })
  })

  /*
   * The subtler half, and the reason segmentations are recorded for every row
   * rather than only failing ones: two engines can agree on the answer today
   * while their segmentation has already moved underneath it. The same NUMBER
   * of boundaries, deliberately — only where one falls has moved. And the text
   * the engine was handed is part of it: the same boundaries over a different
   * text are a different segmentation.
   */
  it('reports a segmentation that moved even though the answer agreed', () => {
    const moved = reportOf([row('a', { segmented: [['One. Two.', [0, 4]]] })])
    const retexted = reportOf([row('a', { segmented: [['One.  Two.', [0, 5]]] })])

    expect(compareReports(reportOf([row('a')]), moved)).toEqual({
      problems: [
        'a: segmented differently while extracting the same\n' +
          '    node    [["One. Two.",[0,5]]]\n' +
          '    webview [["One. Two.",[0,4]]]',
      ],
      notes: [],
    })
    expect(compareReports(reportOf([row('a')]), retexted)).toEqual({
      problems: [
        'a: segmented differently while extracting the same\n' +
          '    node    [["One. Two.",[0,5]]]\n' +
          '    webview [["One.  Two.",[0,5]]]',
      ],
      notes: [],
    })
  })

  /*
   * ⚠️ **A ROW WITH NO SEGMENTATIONS WAS READ AS ONE THAT SEGMENTED NOTHING** —
   * and two rows of the real corpus do segment nothing
   * (`term-of-whitespace-only`, `run-of-whitespace-only`), so against either of
   * them a report that had dropped the field agreed. The driver writes
   * `segmented` for every row, `[]` included, precisely so a reader can tell
   * which rows measured the engine; one without it was not written by it.
   */
  it('refuses a row with no segmentations rather than reading it as one that segmented nothing', () => {
    const quiet = row('a', { segmented: [] })
    const bare = row('a', { segmented: [] })
    delete bare.segmented

    expect(compareReports(reportOf([quiet]), reportOf([bare]))).toEqual({
      problems: [`${SHAPE}segmented in ["a"]`],
      notes: [],
    })
  })

  /* Its own failures are the finding; that it also said ok:false adds nothing. */
  it('reports the webview’s own failures once, and not its ok:false as well', () => {
    /* A row both engines answer the same wrong way, so the webview's own count
       is the only thing left to say. */
    const failing = row('a', { pass: false, actual: { sentence: 'One.', term: 'Two' } })
    const live = reportOf([failing], {
      ok: false,
      failures: 1,
      reason: '1 of 1 rows diverged from the corpus',
    })

    expect(compareReports(reportOf([failing]), live)).toEqual({
      problems: ['the webview reported 1 of its own failures against the corpus'],
      notes: [],
    })
  })

  it('reports an ok:false that nothing else explains, with its reason', () => {
    const live = reportOf([row('a')], {
      ok: false,
      reason: 'this engine has no Intl.Segmenter, so nothing was segmented',
    })

    expect(compareReports(reportOf([row('a')]), live)).toEqual({
      problems: [
        'the webview reported ok:false — this engine has no Intl.Segmenter, so nothing was segmented',
      ],
      notes: [],
    })
  })

  /*
   * The uncovered count is the corpus saying what it already says under Node,
   * so it is a note and never a problem — and only a real, positive count is
   * one.
   */
  /* A count its own rows do not bear out — `'1'`, or 999 — is refused before
     it can become a note; see the totals above. */
  it('notes the known shortfalls a report counts, and only a positive count of them', () => {
    const short = reportOf([row('a'), row('b', { sentence: 'One. Two.', covered: false })], { uncovered: 1 })
    const none = reportOf([row('a'), row('b')])

    expect(compareReports(short, structuredClone(short))).toEqual({
      problems: [],
      notes: [
        '1 of 2 rows are cases the implementation does not get right; see each row’s `why` in sentenceCorpus.ts',
      ],
    })
    expect(compareReports(none, structuredClone(none))).toEqual({ problems: [], notes: [] })
  })
})

describe('sentence-parity — the script', () => {
  it('prints its usage for --help and -h without reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('--help read the corpus'))

    for (const flag of ['--help', '-h']) {
      expect(await cli([flag], { corpus })).toEqual({ code: 0, out: '', err: `${USAGE}\n` })
    }
  })

  /* ⚠️ **`--help` WAS THE ONE MODE THAT SWALLOWED WHATEVER FOLLOWED IT**, so
     `--help --compare report.json` printed the usage and exited 0 — the same
     shape as `--check --compare missing.json` below, and the one exit code a
     caller reads as "the thing I asked for happened". */
  it('refuses an argument --help does not take rather than printing usage over it', async () => {
    const corpus = () => Promise.reject(new Error('--help read the corpus'))

    for (const flag of ['--help', '-h']) {
      expect(await cli([flag, '--compare', 'report.json'], { corpus })).toEqual({
        code: 1,
        out: '',
        err: `sentence-parity: ${flag} takes no arguments, and was also given ["--compare","report.json"]\n${USAGE}\n`,
      })
    }
  })

  it('emits the snippet on stdout by default, and says how many rows it holds', async () => {
    const said = `sentence-parity: ${SENTENCE_CORPUS.length} rows. Paste stdout into webview_execute_js, then feed the report back with --compare -\n`

    for (const args of [[], ['--emit']]) {
      const { code, out, err } = await cli(args)

      expect(out).toBe(buildSnippet(SENTENCE_CORPUS))
      expect(err).toBe(said)
      expect(code).toBe(0)
    }
    const report = evaluateSnippet((await cli([])).out)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(SENTENCE_CORPUS.length)
  })

  it('checks the corpus in this engine and exits zero', async () => {
    const expected = evaluateSnippet(buildSnippet(SENTENCE_CORPUS))
    expect(expected.ok).toBe(true)

    const { code, out, err } = await cli(['--check'])

    expect(out).toBe(JSON.stringify(expected, null, 2) + '\n')
    expect(err).toBe(
      `sentence-parity: ${SENTENCE_CORPUS.length} rows pass in this engine, ${expected.uncovered} uncovered\n`,
    )
    expect(code).toBe(0)
  })

  it('exits non-zero from --check on a corpus this engine does not reproduce', async () => {
    const wrong = { ...PROBE, id: 'wrong', actual: { sentence: 'Alpha one.', term: 'Probe' } }

    const { code, out, err } = await cli(['--check'], { corpus: async () => [wrong] })

    expect(JSON.parse(out).ok).toBe(false)
    expect(err).toBe('sentence-parity: 1 of 1 rows diverged from the corpus\n')
    expect(code).toBe(1)
  })

  it('exits non-zero on an empty corpus instead of emitting a snippet of nothing', async () => {
    expect(await cli(['--emit'], { corpus: async () => [] })).toEqual({
      code: 1,
      out: '',
      err: 'sentence-parity: the corpus is empty — nothing to check\n',
    })
  })

  it('exits non-zero on an option it does not know, with its usage, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('an unknown option read the corpus'))

    expect(await cli(['--bogus'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: unknown option --bogus\n${USAGE}\n`,
    })
  })

  /* ⚠️ `--check --compare missing.json` RAN THE CHECK AND EXITED 0, never
     having looked for the report it was asked to compare. */
  it('refuses an argument its mode does not take, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('a stray argument read the corpus'))

    expect(await cli(['--check', '--compare', 'missing.json'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: --check takes no arguments, and was also given ["--compare","missing.json"]\n${USAGE}\n`,
    })
    expect(await cli(['--emit', 'extra'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: --emit takes no arguments, and was also given ["extra"]\n${USAGE}\n`,
    })
    expect(await cli(['--compare', 'a.json', 'b.json'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: --compare takes one argument, and was also given ["b.json"]\n${USAGE}\n`,
    })
  })

  /* Before the corpus, like every other refusal here: a run that cannot do what
     it was asked has nothing to gain by first reading 36 rows off disk, and the
     corpus is exactly what a mistyped command line should not depend on. */
  it('exits non-zero when --compare is given nothing to compare, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('--compare with no file read the corpus'))

    expect(await cli(['--compare'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: 'sentence-parity: --compare needs a report file, or - for stdin\n',
    })
  })

  /*
   * The bridge-unreachable case. A parity run that produced no report is not a
   * pass — it is a run that did not happen, and the two look identical in a
   * summary unless the exit code separates them.
   */
  it('exits non-zero when there is no report to compare — the bridge was unreachable', async () => {
    const missing = join(scratch, 'there-is-no-such-report.json')

    const { code, out, err } = await cli(['--compare', missing])
    const [said, ...rest] = err.split('\n')

    expect(said).toContain(`sentence-parity: no report to compare (${missing}): ENOENT`)
    expect(rest.join('\n')).toBe(NO_REPORT)
    expect(out).toBe('')
    expect(code).toBe(1)
  })

  /* Whitespace is as empty as nothing, from a file and from stdin alike. */
  it('exits non-zero on a report that is blank, naming it as empty', async () => {
    const blank = tempFile('blank.json', ' \n\t\n')

    expect(await cli(['--compare', blank])).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: no report to compare (${blank}): the report is empty\n${NO_REPORT}`,
    })
    expect(await cli(['--compare', '-'], { stdin: ' \n' })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: no report to compare (-): the report is empty\n${NO_REPORT}`,
    })
  })

  it('accepts an agreeing report from a file or from stdin, naming the engine it came from', async () => {
    const report = asWebview(SENTENCE_CORPUS)
    expect(report.uncovered).toBeGreaterThan(0)
    const json = JSON.stringify(report)
    const said =
      `  note: ${report.uncovered} of ${report.total} rows are cases the implementation does not get right; see each row’s \`why\` in sentenceCorpus.ts\n` +
      `sentence-parity: ${report.total} rows agree between this engine and ${WEBKIT}\n`

    expect(await cli(['--compare', tempFile('agreeing.json', json)])).toEqual({
      code: 0,
      out: '',
      err: said,
    })
    expect(await cli(['--compare', '-'], { stdin: json })).toEqual({ code: 0, out: '', err: said })
  })

  /* The mix-up this refusal exists for, end to end: `--check`'s own output
     handed straight back to `--compare`. */
  it('exits non-zero when handed this engine’s own report', async () => {
    const own = (await cli(['--check'])).out

    expect(await cli(['--compare', '-'], { stdin: own })).toEqual({
      code: 1,
      out: '',
      err:
        'sentence-parity: 1 divergence\n' +
        `  the report came from ${ENGINE}, not a browser — an engine compared with itself says nothing about WebKit\n`,
    })
  })

  /* ⚠️ **FABRICATED CONTENTS COMPARED SUCCESSFULLY, END TO END.** Finding #20,
     reproduced 2026-09-14 against the real corpus: a webview report with `error`
     taken out of every row, and one claiming `uncovered: 999`, each exited 0 as
     rows that agree between the two engines. */
  it('exits non-zero on a real report with its rows’ errors taken out, or its uncovered count invented', async () => {
    const stripped = asWebview(SENTENCE_CORPUS)
    for (const one of stripped.rows) delete one.error
    const invented = { ...asWebview(SENTENCE_CORPUS), uncovered: 999 }
    const uncovered = invented.rows.filter((one) => !one.covered).length

    expect(await cli(['--compare', '-'], { stdin: JSON.stringify(stripped) })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: 1 divergence\n  ${SHAPE}error in ${JSON.stringify(SENTENCE_CORPUS.map((one) => one.id))}\n`,
    })
    expect(await cli(['--compare', '-'], { stdin: JSON.stringify(invented) })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: 1 divergence\n  ${CLAIMS}uncovered 999 but ${uncovered} not covered\n`,
    })
  })

  /* The corpus here expects what the webview returned, so the webview's row
     passes as written and this engine's does not: one divergence, and only one.
     A webview row claiming a pass its own answer contradicts is refused before
     any answer is compared — see `compareReports`. */
  it('exits non-zero on a divergent answer, printing both engines’ results', async () => {
    const misread = { ...PROBE, sentence: 'Beta two.', actual: { sentence: 'Beta two.', term: 'Probe' } }
    const live = asWebview([misread])
    Object.assign(live.rows[0], { actual: misread.actual, pass: true })
    Object.assign(live, { ok: true, failures: 0, reason: null })

    expect(
      await cli(['--compare', tempFile('diverged.json', JSON.stringify(live))], {
        corpus: async () => [misread],
      }),
    ).toEqual({
      code: 1,
      out: '',
      err:
        'sentence-parity: 1 divergence\n' +
        '  derivation-probe: extracted differently\n' +
        '    node    {"sentence":"Probe here.","term":"Probe"}\n' +
        '    webview {"sentence":"Beta two.","term":"Probe"}\n' +
        '    node    segmented [["Alpha one. Probe here. Beta two.",[0,11,23]]]\n' +
        '    webview segmented [["Alpha one. Probe here. Beta two.",[0,11,23]]]\n',
    })
  })

  it('counts and prints every divergence when there is more than one', async () => {
    const live = asWebview([PROBE])
    live.rows[0].actual = { sentence: 'Beta two.', term: 'Probe' }
    live.rows[0].pass = false
    live.failures = 1
    live.ok = false

    expect(
      await cli(['--compare', tempFile('diverged-twice.json', JSON.stringify(live))], {
        corpus: async () => [PROBE],
      }),
    ).toEqual({
      code: 1,
      out: '',
      err:
        'sentence-parity: 2 divergences\n' +
        '  derivation-probe: extracted differently\n' +
        '    node    {"sentence":"Probe here.","term":"Probe"}\n' +
        '    webview {"sentence":"Beta two.","term":"Probe"}\n' +
        '    node    segmented [["Alpha one. Probe here. Beta two.",[0,11,23]]]\n' +
        '    webview segmented [["Alpha one. Probe here. Beta two.",[0,11,23]]]\n' +
        '  the webview reported 1 of its own failures against the corpus\n',
    })
  })

  /*
   * Against the REAL corpus, because the half that matters is the driver's: it
   * must write `before: null` into the report for the comparison to have
   * anything to tell an absent far side from.
   */
  it('exits non-zero when a real row’s far side went from nothing to unknown', async () => {
    const live = asWebview(SENTENCE_CORPUS)
    const target = live.rows.find((entry) => entry.id === 'document-start')
    expect(target.before).toBeNull()
    delete target.before

    const { code, err } = await cli(['--compare', tempFile('far-side.json', JSON.stringify(live))])

    expect(err).toContain('sentence-parity: 1 divergence\n')
    expect(err).toContain(
      '  document-start: the report was produced from a DIFFERENT version of this row\n',
    )
    expect(code).toBe(1)
  })

  /*
   * A crash is a run that did not happen, and it must not escape as a
   * rejection that a caller could mistake for anything else: non-zero, with
   * the stack — or, for a throw that has none, whatever was thrown.
   */
  it('exits non-zero on a crash, printing its stack', async () => {
    const failure = new Error('the corpus could not be imported')

    expect(await cli(['--check'], { corpus: () => Promise.reject(failure) })).toEqual({
      code: 1,
      out: '',
      err: `sentence-parity: ${failure.stack}\n`,
    })
    expect(await cli(['--check'], { corpus: () => Promise.reject(undefined) })).toEqual({
      code: 1,
      out: '',
      err: 'sentence-parity: undefined\n',
    })
  })
})

describe('sentence-parity — the process entry', () => {
  /*
   * The only cases left that spawn, because what they show is the one thing no
   * call can: that node, starting this file, runs `main` over the real stdin
   * and exits with its answer — zero for one and non-zero for the other, so an
   * entry that exited the same way whatever `main` said fails one of them.
   * These measure nothing for coverage; everything the script decides is
   * measured above.
   */
  it('exits zero on an agreeing report read from the real stdin', () => {
    const report = asWebview(SENTENCE_CORPUS)

    const { code, err } = spawn(['--compare', '-'], JSON.stringify(report))

    expect(err).toContain(`sentence-parity: ${report.total} rows agree between this engine and ${WEBKIT}\n`)
    expect(code).toBe(0)
  })

  it('exits non-zero when main says so', () => {
    const { code, err } = spawn(['--bogus'])

    expect(err).toContain('sentence-parity: unknown option --bogus\n')
    expect(code).toBe(1)
  })
})
