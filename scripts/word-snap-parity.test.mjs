import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CORPUS } from '../src/kernel/ui/reader/wordSnap/corpus.ts'
import {
  assertTransportable,
  buildSnippet,
  compareReports,
  evaluateSnippet,
  loadCorpus,
  main,
} from './word-snap-parity.mjs'

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
 *
 * ⚠️ **THE SCRIPT IS CALLED, NOT SPAWNED — EXCEPT TO PROVE THE ENTRY POINT.**
 * Every case below used to run the CLI as a child process, which measured none
 * of it: 201 of the script's 266 mutants were uncovered behind a green file,
 * `compareReports` among them. `main` takes its streams, its stdin and its
 * corpus as arguments now, the way `sentence-parity.mjs`'s does.
 */

const SCRIPT = fileURLToPath(new URL('./word-snap-parity.mjs', import.meta.url))

/** One directory for the whole file, made before its first case and removed
 *  after its last. NOT at module scope: collecting a file runs its body and no
 *  hook — `vitest list` does exactly that, and `pnpm test:ledger` runs it, and
 *  so does a run whose name filter leaves no case here — so a directory made
 *  there was left behind each time. */
let scratch
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'word-snap-parity-'))
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
 *  from a throw with nothing in it. */
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
  '  node scripts/word-snap-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/word-snap-parity.mjs --check         run the snippet in this engine',
  '  node scripts/word-snap-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/word-snap-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

const ENGINE = 'no navigator — not a browser engine'
/** What a webview report calls its engine in these cases. Anything that names
 *  a browser will do; Node's own name is refused — see `compareReports`. */
const WEBKIT = 'WebKit under test'
const NO_REPORT =
  '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n'

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

/** The corpus's first row, `the quick brown fox` snapped from 5..12 to 4..15. */
const FOX = CORPUS.find((row) => row.id === 'expand-both-edges')
/** Its segmentation, as a divergence message prints one. */
const FOX_SEGMENTS = '[["the",0],[" ",3],["quick",4],[" ",9],["brown",10],[" ",15],["fox",16]]'

/** This engine's report for `rows`, relabelled as a webview's. */
const asWebview = (rows) => ({ ...evaluateSnippet(buildSnippet(rows)), engine: WEBKIT })

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
    const wrong = {
      ...FOX,
      id: 'wrong',
      expected: { start: { index: 0, offset: 5 }, end: FOX.expected.end },
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
   * ⚠️ A REPORT FROM OLDER CODE PASSED AGAINST NEWER CODE — in this harness
   * after `sentence-parity.mjs` had been fixed for it. The report names the code
   * it ran by digest, and the digest has to be of THAT code, all of it and
   * nothing else, or a change to the driver would slip past exactly as a change
   * to `snapWordRange.ts` used to.
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
    expect(code).toContain('function snapWordRange(')
    /* The rows are not the code — `inputsOf` answers for those. */
    expect(buildSnippet([PROBE, { ...PROBE, id: 'another' }])).toContain(`${marker}${named}';\n`)
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
    expect(assertTransportable(snippet)).toBe(snippet)
  })

  /*
   * Each refusal in its own words, and the characters on either side of the
   * surrogate range let through — so a range that lost an end, or a check that
   * lost one of its two terminators, fails a different line.
   */
  it('refuses a snippet carrying a line terminator or an unpaired surrogate', () => {
    const said = (named) =>
      `word-snap-parity: the snippet carries ${named} — a JS line terminator or an unpaired ` +
      'surrogate. It would fail at parse inside the webview, or arrive mangled. Escape it, or ' +
      'take it out of the comment it came from.'
    const refusalOf = (snippet) => {
      const cause = thrownBy(() => assertTransportable(snippet))
      expect(cause).toBeInstanceOf(Error)
      return cause.message
    }
    const lineSeparator = String.fromCharCode(0x2028)
    const paragraphSeparator = String.fromCharCode(0x2029)

    for (const clean of [
      '// a plain comment\nrun()',
      `/* ${String.fromCharCode(0xd7ff)} ${String.fromCharCode(0xe000)} */`,
      // A well-formed astral pair is fine — it is only the lone half that is not.
      `/* ${String.fromCodePoint(0x20000)} */`,
    ]) {
      expect(assertTransportable(clean)).toBe(clean)
    }
    expect(refusalOf(`// a comment${lineSeparator}stillCode()`)).toBe(said('U+2028'))
    expect(refusalOf(`// a comment${paragraphSeparator}stillCode()`)).toBe(said('U+2029'))
    expect(refusalOf(`/* ${String.fromCharCode(0xd800)} */`)).toBe(said('U+D800'))
    expect(refusalOf(`/* ${String.fromCharCode(0xdfff)} */`)).toBe(said('U+DFFF'))
    /* Each character named once, in the order it first appears. */
    expect(refusalOf(`${paragraphSeparator}${lineSeparator}${paragraphSeparator}`)).toBe(said('U+2029, U+2028'))
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
      expect(refusal.message).toBe('word-snap-parity: buildSnippet needs an array of corpus rows')
    }
  })

  /*
   * The inlined implementation was written as ES modules, which are always
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

  it('reads the corpus from disk, and refuses a module that does not export one', async () => {
    expect(await loadCorpus()).toEqual(CORPUS)

    const impostor = pathToFileURL(tempFile('impostor.mjs', 'export const CORPUS = { rows: [] }\n'))
    const cause = await loadCorpus(impostor).then(
      () => null,
      (thrown) => thrown,
    )

    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toBe(`word-snap-parity: ${impostor.href} did not export a CORPUS array`)
  })
})

/** An edge at `offset` into the row's one string, and a range between two. */
const at = (offset) => ({ index: 0, offset })
const span = (start, end) => ({ start: at(start), end: at(end) })

/**
 * A report row as the driver writes one, small enough that every message the
 * comparison can print is spelled out in full below. `one two`, snapped from
 * 1..2 to `one` at 0..3. Its inputs serialise as
 * `["a",["one two"],{"index":0,"offset":1},{"index":0,"offset":2},{"end":{"index":0,"offset":3},"start":{"index":0,"offset":0}}]`
 * and its boundaries as `[["one",0],[" ",3],["two",4]]`.
 */
function row(id, overrides = {}) {
  return {
    id,
    tags: ['latin'],
    strs: ['one two'],
    start: at(1),
    end: at(2),
    expected: span(0, 3),
    actual: span(0, 3),
    text: 'one',
    pass: true,
    error: null,
    segments: [
      { text: 'one', index: 0, wordLike: true },
      { text: ' ', index: 3, wordLike: false },
      { text: 'two', index: 4, wordLike: true },
    ],
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
    reason: null,
    rows,
    ...overrides,
  }
}

const INPUTS_OF_A =
  '["a",["one two"],{"index":0,"offset":1},{"index":0,"offset":2},{"end":{"index":0,"offset":3},"start":{"index":0,"offset":0}}]'

/** How a refusal of a report's row shapes opens, and how one of its claims does
 *  — spelled out, not imported: the words are the behaviour under test. */
const SHAPE = "the report's rows are missing fields this harness writes, or carry them as the wrong type: "
const CLAIMS = "the report's own claims contradict its rows: "

describe('word-snap-parity — comparing a webview report', () => {
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
   * ⚠️ NODE'S OWN REPORT, FED BACK, PASSED FOR WEBKIT'S — here after the
   * sentence harness had been fixed for it. What `--check` prints is a
   * perfectly good report of the wrong engine, and so is one from Node outside
   * a vm, whose `navigator` says `Node.js/`.
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
   * ⚠️ THE TOTALS WERE BELIEVED OVER THE ROWS. `total: 999` beside 51 rows, and
   * a row that threw and did not pass under `failures: 0, errors: 0`, compared
   * successfully and exited 0 — reproduced 2026-09-14, after the audit that
   * fixed the same thing in `sentence-parity.mjs`. The first case has two
   * totals wrong at once; then each alone, so a check that read only one of
   * them fails a different expectation.
   */
  it('refuses a report whose own totals contradict its rows', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (live) => compareReports(local, live)
    const threw = row('b', { actual: null, text: null, pass: false, error: 'it threw' })
    /* A row that did not pass because its answer is not the corpus's, so its
       own `pass` agrees with it and only the total is wrong. */
    const failing = row('b', { pass: false, actual: span(4, 7), text: 'two' })

    expect(refusedFor(reportOf([row('a'), threw], { total: 3, errors: 1 }))).toEqual({
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
  })

  /*
   * ⚠️ **A ROW COULD PASS AND CARRY AN ERROR AT THE SAME TIME.** The driver
   * writes `pass` as `error === null && the snap agrees`, so the two can only
   * disagree in a report it did not write — but every total then adds up (one
   * error, no failures, the right count). A row that threw did not pass,
   * whatever it says of itself.
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
   * ⚠️ **AND A ROW COULD PASS WITH THE WRONG SNAP, OR WITH NONE, OR FAIL WITH
   * THE RIGHT ONE — WITH EVERY TOTAL AGREEING.** `pass` is the driver's own
   * reading of the row's other fields, and `'none'` expects no snap at all.
   */
  it('refuses a report whose rows claim a pass their own fields contradict', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (b, totals = {}) => compareReports(local, reportOf([row('a'), b], totals)).problems
    const PASS = `${CLAIMS}rows whose pass contradicts their error or their answer: ["b"]`

    expect(refusedFor(row('b', { actual: span(4, 7), text: 'two' }))).toEqual([PASS])
    expect(refusedFor(row('b', { actual: { start: at(0), end: at(7) } }))).toEqual([PASS])
    expect(refusedFor(row('b', { actual: null, text: null }))).toEqual([PASS])
    expect(refusedFor(row('b', { expected: 'none' }))).toEqual([PASS])
    expect(refusedFor(row('b', { pass: false }), { failures: 1 })).toEqual([PASS])
  })

  /*
   * ⚠️ **A ROW MISSING A FIELD THE DRIVER ALWAYS WRITES COMPARED SUCCESSFULLY.**
   * With `error` taken out of every row a real report still agreed — and a row
   * without `segments` was read as `[]`, which two real rows genuinely are. Every
   * field the driver writes is held to its type before any of them is believed.
   * A row is named by its id, or by where it stands when it has none.
   */
  it('refuses a report whose rows lack a field the driver writes or carry one as the wrong type, naming the field and the rows', () => {
    const local = reportOf([row('a'), row('b')])
    const refusedFor = (b) => compareReports(local, reportOf([row('a'), b]))
    const without = (field) => {
      const one = row('b')
      delete one[field]
      return one
    }
    const FIELDS = ['id', 'tags', 'strs', 'start', 'end', 'expected', 'actual', 'text', 'pass', 'error', 'segments']
    const refusal = (field) => ({ problems: [`${SHAPE}${field} in ${field === 'id' ? '[1]' : '["b"]'}`], notes: [] })
    const word = { text: 'one', index: 0, wordLike: true }

    for (const field of FIELDS) expect(refusedFor(without(field)), `without ${field}`).toEqual(refusal(field))
    for (const [field, value] of [
      ['id', 7],
      ['tags', 'latin'],
      ['tags', ['latin', 3]],
      ['strs', 'one two'],
      ['strs', ['one two', 3]],
      ['start', null],
      ['start', { index: 0 }],
      ['start', { offset: 1 }],
      ['start', { index: '0', offset: 1 }],
      ['end', 2],
      ['end', { index: 0, offset: '2' }],
      ['expected', null],
      ['expected', 'None'],
      ['expected', { start: at(0) }],
      ['expected', { end: at(3) }],
      ['actual', 'none'],
      ['actual', { start: null, end: at(3) }],
      ['text', 3],
      ['pass', 1],
      ['error', 3],
      ['segments', 'one two'],
      ['segments', [null]],
      ['segments', [{ index: 0, wordLike: true }]],
      ['segments', [{ text: 'one', wordLike: true }]],
      ['segments', [{ text: 'one', index: 0 }]],
      ['segments', [{ text: 'one', index: '0', wordLike: true }]],
      ['segments', [word, 5]],
    ]) {
      expect(refusedFor(row('b', { [field]: value })), `${field} as ${JSON.stringify(value)}`).toEqual(refusal(field))
    }
    expect(refusedFor(null)).toEqual({
      problems: [`${SHAPE}${FIELDS.map((field) => `${field} in [1]`).join(', ')}`],
      notes: [],
    })
  })

  /* The other half: every shape the driver CAN write — a row that threw and so
     has no snap, a row expecting none, one that threw expecting none, a row of
     no strings and no segments — is read, not refused. */
  it('accepts every shape the driver writes a row in', () => {
    const local = reportOf(
      [
        row('a', { tags: [] }),
        row('threw', { actual: null, text: null, pass: false, error: 'boom' }),
        row('none', { expected: 'none', actual: null, text: null }),
        row('none-threw', { expected: 'none', actual: null, text: null, pass: false, error: 'boom' }),
        row('empty', { strs: [], segments: [], expected: 'none', actual: null, text: null }),
      ],
      { ok: false, failures: 2, errors: 2, reason: '2 of 5 rows diverged from the corpus' },
    )

    expect(compareReports(local, structuredClone(local))).toEqual({
      problems: ['the webview reported 2 of its own failures against the corpus'],
      notes: [],
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
   * The staleness comparing ids could not see: a report from an older corpus
   * whose row kept its id while an edge or its expectation moved underneath
   * it. It agrees on every id, and it can agree on the snap by luck — so it is
   * reported once, as a different row, and not also as a different snap.
   */
  it('reports a row that kept its id but changed underneath, and nothing else about it', () => {
    const local = reportOf([row('a')])
    const moved = row('a', { start: at(0) })
    /* Its expectation moved with its snap, so the row's own `pass` agrees with
       it: one that contradicted itself would be refused before rows are read. */
    const reexpected = row('a', { expected: span(4, 7), actual: span(4, 7), text: 'two' })

    expect(compareReports(local, reportOf([moved]))).toEqual({
      problems: [
        'a: the report was produced from a DIFFERENT version of this row\n' +
          `    node    ${INPUTS_OF_A}\n` +
          '    webview ["a",["one two"],{"index":0,"offset":0},{"index":0,"offset":2},{"end":{"index":0,"offset":3},"start":{"index":0,"offset":0}}]',
      ],
      notes: [],
    })
    expect(compareReports(local, reportOf([reexpected]))).toEqual({
      problems: [
        'a: the report was produced from a DIFFERENT version of this row\n' +
          `    node    ${INPUTS_OF_A}\n` +
          '    webview ["a",["one two"],{"index":0,"offset":1},{"index":0,"offset":2},{"end":{"index":0,"offset":7},"start":{"index":0,"offset":4}}]',
      ],
      notes: [],
    })
  })

  /* ⚠️ FIELD ORDER WAS COMPARED AS BEHAVIOUR: the same snap, written with its
     fields the other way round, diverged — as a snap and as an input. Measured
     2026-09-14 against a real report: 41 divergences, all of them this. */
  it('compares snaps by what they say, not by the order their fields were written in', () => {
    const backwards = { end: { offset: 3, index: 0 }, start: { offset: 0, index: 0 } }
    const reordered = row('a', { actual: backwards, expected: structuredClone(backwards), start: { offset: 1, index: 0 } })

    expect(compareReports(reportOf([row('a')]), reportOf([reordered]))).toEqual({ problems: [], notes: [] })
  })

  it('prints both snaps and both segmentations for a row snapped differently', () => {
    /* The corpus expects the webview's snap, so that row passes as written and
       this engine's does not; a webview row whose `pass` contradicted its own
       snap would be refused before any snap is compared. */
    const local = reportOf([row('a', { expected: span(4, 7), pass: false })], { failures: 1 })
    const live = reportOf([
      row('a', {
        expected: span(4, 7),
        actual: span(4, 7),
        text: 'two',
        segments: [{ text: 'one two', index: 0, wordLike: false }],
      }),
    ])

    expect(compareReports(local, live)).toEqual({
      problems: [
        'a: snapped differently\n' +
          '    node    {"end":{"index":0,"offset":3},"start":{"index":0,"offset":0}}\n' +
          '    webview {"end":{"index":0,"offset":7},"start":{"index":0,"offset":4}}\n' +
          '    node    segments [["one",0],[" ",3],["two",4]]\n' +
          '    webview segments [["one two",0]]',
      ],
      notes: [],
    })
  })

  /*
   * The subtler half, and the reason segments are recorded for every row
   * rather than only failing ones: two engines can agree on the snap today
   * while their boundaries have already moved underneath it. The same NUMBER
   * of segments, deliberately — only where one falls, or what it holds, moved.
   */
  it('reports segmentation that moved even though the snap agreed', () => {
    const segmentsOf = (space) => [
      { text: 'one', index: 0, wordLike: true },
      space,
      { text: 'two', index: 4, wordLike: true },
    ]
    const moved = row('a', { segments: segmentsOf({ text: ' ', index: 4, wordLike: false }) })
    const retexted = row('a', { segments: segmentsOf({ text: '  ', index: 3, wordLike: false }) })

    expect(compareReports(reportOf([row('a')]), reportOf([moved]))).toEqual({
      problems: [
        'a: segmented differently while snapping the same\n' +
          '    node    [["one",0],[" ",3],["two",4]]\n' +
          '    webview [["one",0],[" ",4],["two",4]]',
      ],
      notes: [],
    })
    expect(compareReports(reportOf([row('a')]), reportOf([retexted]))).toEqual({
      problems: [
        'a: segmented differently while snapping the same\n' +
          '    node    [["one",0],[" ",3],["two",4]]\n' +
          '    webview [["one",0],["  ",3],["two",4]]',
      ],
      notes: [],
    })
  })

  /*
   * The divergence already measured and deliberately never read: `isWordLike`
   * differs between the two engines on numbers. A NOTE, never a problem — a
   * harness red on a healthy app is a harness somebody switches off.
   */
  it('notes an isWordLike flag that differs, and finds no problem in it', () => {
    const flagged = row('b', {
      segments: [
        { text: 'one', index: 0, wordLike: false },
        { text: ' ', index: 3, wordLike: false },
        { text: 'two', index: 4, wordLike: true },
      ],
    })

    expect(compareReports(reportOf([row('a'), row('b')]), reportOf([row('a'), flagged]))).toEqual({
      problems: [],
      notes: ['b: isWordLike differs — node [true,false,true], webview [false,false,true]'],
    })
  })

  /* Its own failures are the finding; that it also said ok:false adds nothing. */
  it('reports the webview’s own failures once, and not its ok:false as well', () => {
    /* A row both engines snap the same wrong way, so the webview's own count is
       the only thing left to say. */
    const failing = row('a', { pass: false, actual: span(4, 7), text: 'two' })
    const live = reportOf([failing], { ok: false, failures: 1, reason: '1 of 1 rows diverged from the corpus' })

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
      problems: ['the webview reported ok:false — this engine has no Intl.Segmenter, so nothing was segmented'],
      notes: [],
    })
  })
})

describe('word-snap-parity — the script', () => {
  it('prints its usage for --help and -h without reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('--help read the corpus'))

    for (const flag of ['--help', '-h']) {
      expect(await cli([flag], { corpus })).toEqual({ code: 0, out: '', err: `${USAGE}\n` })
    }
  })

  /* ⚠️ **`--help --compare report.json` PRINTED THE USAGE AND EXITED 0** — the
     one exit code a caller reads as "the thing I asked for happened". */
  it('refuses an argument --help does not take rather than printing usage over it', async () => {
    const corpus = () => Promise.reject(new Error('--help read the corpus'))

    for (const flag of ['--help', '-h']) {
      expect(await cli([flag, '--compare', 'report.json'], { corpus })).toEqual({
        code: 1,
        out: '',
        err: `word-snap-parity: ${flag} takes no arguments, and was also given ["--compare","report.json"]\n${USAGE}\n`,
      })
    }
  })

  it('emits a snippet on stdout that evaluates to a clean report', async () => {
    const said = `word-snap-parity: ${CORPUS.length} rows. Paste stdout into webview_execute_js, then feed the report back with --compare -\n`

    for (const args of [[], ['--emit']]) {
      const { code, out, err } = await cli(args)

      expect(out).toBe(buildSnippet(CORPUS))
      expect(err).toBe(said)
      expect(code).toBe(0)
    }
    const report = evaluateSnippet((await cli([])).out)
    expect(report.ok).toBe(true)
    expect(report.total).toBe(CORPUS.length)
  })

  it('checks the corpus in this engine and exits zero', async () => {
    const expected = evaluateSnippet(buildSnippet(CORPUS))
    expect(expected.ok).toBe(true)

    const { code, out, err } = await cli(['--check'])

    expect(out).toBe(JSON.stringify(expected, null, 2) + '\n')
    expect(err).toBe(`word-snap-parity: ${CORPUS.length} rows pass in this engine\n`)
    expect(code).toBe(0)
  })

  it('exits non-zero from --check on a corpus this engine does not reproduce', async () => {
    const wrong = { ...FOX, id: 'wrong', expected: span(5, 15) }

    const { code, out, err } = await cli(['--check'], { corpus: async () => [wrong] })

    expect(JSON.parse(out).ok).toBe(false)
    expect(err).toBe('word-snap-parity: 1 of 1 rows diverged from the corpus\n')
    expect(code).toBe(1)
  })

  it('exits non-zero on an empty corpus instead of emitting a snippet of nothing', async () => {
    expect(await cli(['--emit'], { corpus: async () => [] })).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-parity: the corpus is empty — nothing to check\n',
    })
  })

  it('exits non-zero on an option it does not know, with its usage, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('an unknown option read the corpus'))

    expect(await cli(['--bogus'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: unknown option --bogus\n${USAGE}\n`,
    })
  })

  /* ⚠️ `--check --compare missing.json` RAN THE CHECK AND EXITED 0, never
     having looked for the report it was asked to compare — reproduced
     2026-09-14, a fix `sentence-parity.mjs` already carried. */
  it('refuses an argument its mode does not take, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('a stray argument read the corpus'))

    expect(await cli(['--check', '--compare', 'missing.json'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: --check takes no arguments, and was also given ["--compare","missing.json"]\n${USAGE}\n`,
    })
    expect(await cli(['--emit', 'extra'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: --emit takes no arguments, and was also given ["extra"]\n${USAGE}\n`,
    })
    expect(await cli(['--compare', 'a.json', 'b.json'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: --compare takes one argument, and was also given ["b.json"]\n${USAGE}\n`,
    })
  })

  it('exits non-zero when --compare is given nothing to compare, before reading the corpus', async () => {
    const corpus = () => Promise.reject(new Error('--compare with no file read the corpus'))

    expect(await cli(['--compare'], { corpus })).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-parity: --compare needs a report file, or - for stdin\n',
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

    expect(said).toContain(`word-snap-parity: no report to compare (${missing}): ENOENT`)
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
      err: `word-snap-parity: no report to compare (${blank}): the report is empty\n${NO_REPORT}`,
    })
    expect(await cli(['--compare', '-'], { stdin: ' \n' })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: no report to compare (-): the report is empty\n${NO_REPORT}`,
    })
  })

  it('exits non-zero on a report holding zero rows', async () => {
    const path = tempFile('empty.json', JSON.stringify({ ok: true, total: 0, rows: [] }))

    expect(await cli(['--compare', path])).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-parity: 1 divergence\n  the report holds zero rows — an empty run is a failure, not a clean sweep\n',
    })
  })

  it('accepts an agreeing report on stdin and exits zero', async () => {
    const report = asWebview(CORPUS)
    const json = JSON.stringify(report)
    const said = `word-snap-parity: ${CORPUS.length} rows agree between this engine and ${WEBKIT}\n`

    expect(await cli(['--compare', '-'], { stdin: json })).toEqual({ code: 0, out: '', err: said })
    expect(await cli(['--compare', tempFile('agreeing.json', json)])).toEqual({ code: 0, out: '', err: said })
  })

  /* The known divergence, end to end: noted by row, counted in the verdict, and
     the run still exits 0. */
  it('counts the isWordLike differences it notes, and still exits zero', async () => {
    const live = asWebview(CORPUS)
    live.rows.find((one) => one.id === FOX.id).segments[0].wordLike = false

    expect(await cli(['--compare', '-'], { stdin: JSON.stringify(live) })).toEqual({
      code: 0,
      out: '',
      err:
        '  note: expand-both-edges: isWordLike differs — node [true,false,true,false,true,false,true], ' +
        'webview [false,false,true,false,true,false,true]\n' +
        `word-snap-parity: ${CORPUS.length} rows agree between this engine and ${WEBKIT} (1 isWordLike flag differences, not read by us)\n`,
    })
  })

  /* The mix-up the browser refusal exists for, end to end: `--check`'s own
     output handed straight back to `--compare`. It exited 0. */
  it('exits non-zero when handed this engine’s own report', async () => {
    const own = (await cli(['--check'])).out

    expect(await cli(['--compare', '-'], { stdin: own })).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 1 divergence\n' +
        `  the report came from ${ENGINE}, not a browser — an engine compared with itself says nothing about WebKit\n`,
    })
  })

  /* ⚠️ **FABRICATED CONTENTS COMPARED SUCCESSFULLY, END TO END.** Reproduced
     2026-09-14 against the real corpus: a webview report with `error` taken out
     of every row, and one claiming 999 rows with a row that threw and still
     counted no failure, each exited 0 as rows that agree between two engines. */
  it('exits non-zero on a real report with its rows’ errors taken out, or its totals invented', async () => {
    const stripped = asWebview(CORPUS)
    for (const one of stripped.rows) delete one.error
    const invented = asWebview(CORPUS)
    Object.assign(invented.rows[0], { pass: false, error: 'it threw' })
    invented.total = 999

    expect(await cli(['--compare', '-'], { stdin: JSON.stringify(stripped) })).toEqual({
      code: 1,
      out: '',
      err: `word-snap-parity: 1 divergence\n  ${SHAPE}error in ${JSON.stringify(CORPUS.map((one) => one.id))}\n`,
    })
    expect(await cli(['--compare', '-'], { stdin: JSON.stringify(invented) })).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 1 divergence\n' +
        `  ${CLAIMS}total 999 for ${CORPUS.length} rows, failures 0 but 1 not passing, errors 0 but 1 carrying an error\n`,
    })
  })

  /* The corpus here expects what the webview returned, so the webview's row
     passes as written and this engine's does not: one divergence, and only one. */
  it('exits non-zero on a divergence, printing both engines’ results', async () => {
    const misread = { ...FOX, expected: span(5, 15) }
    const live = asWebview([misread])
    Object.assign(live.rows[0], { actual: misread.expected, text: 'uick brown', pass: true })
    Object.assign(live, { ok: true, failures: 0, reason: null })

    expect(
      await cli(['--compare', tempFile('diverged.json', JSON.stringify(live))], {
        corpus: async () => [misread],
      }),
    ).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 1 divergence\n' +
        '  expand-both-edges: snapped differently\n' +
        '    node    {"end":{"index":0,"offset":15},"start":{"index":0,"offset":4}}\n' +
        '    webview {"end":{"index":0,"offset":15},"start":{"index":0,"offset":5}}\n' +
        `    node    segments ${FOX_SEGMENTS}\n` +
        `    webview segments ${FOX_SEGMENTS}\n`,
    })
  })

  it('counts and prints every divergence when there is more than one', async () => {
    const live = asWebview([FOX])
    Object.assign(live.rows[0], { actual: span(5, 15), text: 'uick brown', pass: false })
    Object.assign(live, { ok: false, failures: 1, reason: '1 of 1 rows diverged from the corpus' })

    expect(
      await cli(['--compare', tempFile('diverged-twice.json', JSON.stringify(live))], {
        corpus: async () => [FOX],
      }),
    ).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 2 divergences\n' +
        '  expand-both-edges: snapped differently\n' +
        '    node    {"end":{"index":0,"offset":15},"start":{"index":0,"offset":4}}\n' +
        '    webview {"end":{"index":0,"offset":15},"start":{"index":0,"offset":5}}\n' +
        `    node    segments ${FOX_SEGMENTS}\n` +
        `    webview segments ${FOX_SEGMENTS}\n` +
        '  the webview reported 1 of its own failures against the corpus\n',
    })
  })

  /*
   * The staleness comparing IDs could not see, and the reason this check exists
   * in both harnesses rather than one: a report from an older corpus whose row
   * kept its id while its strings moved underneath it. It agrees on every id,
   * and it can agree on the snapped answer by luck.
   */
  it('exits non-zero when a row kept its id but changed underneath', async () => {
    const live = asWebview(CORPUS)
    live.rows.find((one) => one.id === FOX.id).strs = ['the quick brown cat']

    expect(await cli(['--compare', tempFile('restated.json', JSON.stringify(live))])).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 1 divergence\n' +
        '  expand-both-edges: the report was produced from a DIFFERENT version of this row\n' +
        '    node    ["expand-both-edges",["the quick brown fox"],{"index":0,"offset":5},{"index":0,"offset":12},{"end":{"index":0,"offset":15},"start":{"index":0,"offset":4}}]\n' +
        '    webview ["expand-both-edges",["the quick brown cat"],{"index":0,"offset":5},{"index":0,"offset":12},{"end":{"index":0,"offset":15},"start":{"index":0,"offset":4}}]\n',
    })
  })

  it('exits non-zero when the report was produced from a different corpus', async () => {
    const live = asWebview(CORPUS)
    const short = { ...live, rows: live.rows.slice(1), total: live.total - 1 }

    expect(await cli(['--compare', tempFile('short.json', JSON.stringify(short))])).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-parity: 1 divergence\n' +
        `  the report was produced from a different corpus: ${CORPUS.length - 1} rows against ${CORPUS.length} here, missing ["expand-both-edges"]\n`,
    })
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
      err: `word-snap-parity: ${failure.stack}\n`,
    })
    expect(await cli(['--check'], { corpus: () => Promise.reject(undefined) })).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-parity: undefined\n',
    })
  })
})

describe('word-snap-parity — the process entry', () => {
  /*
   * The only cases left that spawn, because what they show is the one thing no
   * call can: that node, starting this file, runs `main` over the real stdin
   * and exits with its answer — zero for one and non-zero for the other, so an
   * entry that exited the same way whatever `main` said fails one of them.
   * These measure nothing for coverage; everything the script decides is
   * measured above.
   */
  it('exits zero on an agreeing report read from the real stdin', () => {
    const report = asWebview(CORPUS)

    const { code, err } = spawn(['--compare', '-'], JSON.stringify(report))

    expect(err).toContain(`word-snap-parity: ${report.total} rows agree between this engine and ${WEBKIT}\n`)
    expect(code).toBe(0)
  })

  it('exits non-zero when main says so', () => {
    const { code, err } = spawn(['--bogus'])

    expect(err).toContain('word-snap-parity: unknown option --bogus\n')
    expect(code).toBe(1)
  })
})
