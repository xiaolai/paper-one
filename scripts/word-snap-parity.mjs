/**
 * Cross-engine parity harness for word-boundary snapping.
 *
 * `Intl.Segmenter` is backed by ICU, and **Node and WebKit do not agree**.
 * Measured in this repository: the segment record's `isWordLike` flag is `true`
 * for `3.14`, `1,000` and `42` under Node's ICU and `false` for all three under
 * the WKWebView the app ships on. `src/kernel/ui/reader/wordSnap/classify.ts`
 * deliberately never reads that flag, so this divergence is already
 * neutralised — but it proves the class is real, and a macOS upgrade can shift
 * WebKit's segmentation again. A Node-only green is not evidence about the
 * runtime.
 *
 * So this script emits a **self-contained** snippet — the corpus and the whole
 * snapping implementation, inlined, with no imports — to be pasted into
 * `webview_execute_js` against the running app (bridge port 31415, see
 * `AGENTS.md`). Its report can then be fed back in with `--compare`, and any
 * divergence fails loudly with both engines' answers printed.
 *
 *   node scripts/word-snap-parity.mjs                  emit the snippet
 *   node scripts/word-snap-parity.mjs --check          run it in THIS engine
 *   node scripts/word-snap-parity.mjs --compare FILE   diff a webview report
 *   node scripts/word-snap-parity.mjs --compare -      … from stdin
 *
 * **Everything is read at run time — nothing here is a transcription.** The
 * rows come from `corpus.ts` and the algorithm from `classify.ts` and
 * `snapWordRange.ts`, all three loaded from disk on every invocation. A
 * generator holding its own copy of either would report a green parity run
 * against code the app does not contain, which is worse than no harness at
 * all. `buildSnippet` therefore takes its rows as an ARGUMENT, which is what
 * makes the property checkable: `word-snap-parity.test.mjs` hands it a corpus
 * with one extra row and the emitted snippet must grow by one row.
 *
 * Every failure exits non-zero. A parity run that produced no report is a run
 * that did not happen, and in a summary that looks exactly like a clean sweep
 * unless the exit code says otherwise.
 */

import { createHash } from 'node:crypto'
import { isProcessEntry } from './lib/entry.mjs'
import { inlineModules } from './lib/inline-ts.mjs'
import { asAsciiJson, evaluateSnippet, readReport } from './lib/parity.mjs'

/* `word-snap-live.mjs` drives this harness's snippet over the bridge and takes
   the evaluator from here, where it used to live. Re-exported rather than moved
   out from under it: one evaluator, named where its callers already look. */
export { evaluateSnippet }

/** The snapping implementation, in dependency order: a module may only use
 *  names the modules before it export. */
const MODULES = ['classify.ts', 'snapWordRange.ts']

const WORD_SNAP = new URL('../src/kernel/ui/reader/wordSnap/', import.meta.url)

/** The whole snapping implementation as one self-contained fragment, read from
 *  disk on every call. `inline-ts.mjs` carries the rationale — including why
 *  each module keeps its own scope, and why an import it does not understand
 *  throws here rather than inside a webview. */
function snapperSource() {
  return inlineModules(WORD_SNAP, MODULES)
}

/** What a report calls its engine when the snippet found no `navigator` — which
 *  is to say when it ran in Node's vm, and not in a browser at all. */
const NO_BROWSER = 'no navigator — not a browser engine'

/** The report builder, as source. Runs with `ROWS`, `IMPLEMENTATION` and
 *  `snapWordRange` already in scope. Written without template literals so it
 *  survives being embedded in one. */
const DRIVER = `
const report = {
  ok: false,
  implementation: IMPLEMENTATION,
  engine:
    typeof navigator === 'object' && navigator !== null && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : ${JSON.stringify(NO_BROWSER)},
  total: ROWS.length,
  failures: 0,
  errors: 0,
  reason: null,
  rows: [],
};

if (typeof Intl !== 'object' || typeof Intl.Segmenter !== 'function') {
  report.reason = 'this engine has no Intl.Segmenter, so nothing was segmented';
  return report;
}

/* Fail closed. Under 'ok = failures === 0' an empty corpus scores a perfect
 * pass, which is the same class of silent success as a coverage report
 * measuring zero lines. */
if (ROWS.length === 0) {
  report.reason = 'the corpus is empty — zero rows to check is a failure, not a clean sweep';
  return report;
}

const flatOf = function (strs, edge) {
  let flat = edge.offset;
  for (let i = 0; i < edge.index; i += 1) flat += (strs[i] || '').length;
  return flat;
};
const sameEdge = function (a, b) {
  return !!a && !!b && a.index === b.index && a.offset === b.offset;
};
const sameSnap = function (a, b) {
  if (a === null || b === null) return a === b;
  return sameEdge(a.start, b.start) && sameEdge(a.end, b.end);
};

for (let i = 0; i < ROWS.length; i += 1) {
  const row = ROWS[i];
  const flat = row.strs.join('');

  /* The engine's raw segmentation, recorded for EVERY row and not only the
   * failing ones. A divergence is useless without it, and two engines that
   * segment differently while happening to snap the same are exactly the drift
   * this harness exists to catch early. */
  const segments = [];
  for (const part of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(flat)) {
    segments.push({ text: part.segment, index: part.index, wordLike: !!part.isWordLike });
  }

  let actual = null;
  let error = null;
  try {
    actual = snapWordRange(row.strs, row.start, row.end, {});
  } catch (thrown) {
    error = String((thrown && thrown.message) || thrown);
  }

  const expected = row.expected === 'none' ? null : row.expected;
  const pass = error === null && sameSnap(actual, expected);
  if (error !== null) report.errors += 1;
  if (!pass) report.failures += 1;

  report.rows.push({
    id: row.id,
    tags: row.tags,
    strs: row.strs,
    start: row.start,
    end: row.end,
    expected: row.expected,
    actual: actual,
    text:
      actual === null
        ? null
        : flat.slice(flatOf(row.strs, actual.start), flatOf(row.strs, actual.end)),
    pass: pass,
    error: error,
    segments: segments,
  });
}

report.ok = report.failures === 0;
report.reason = report.ok
  ? null
  : report.failures + ' of ' + report.total + ' rows diverged from the corpus';
return report;
`

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

/**
 * Refuse a snippet that would break at parse rather than at a row.
 *
 * Two characters can reach here from a comment in the inlined source, where
 * escaping is not an option because a comment is not a string:
 *
 * - **U+2028 and U+2029 are JS line terminators.** One inside a `//` comment
 *   ends the comment early and the rest of the line becomes code. The failure
 *   is a `SyntaxError` from a webview, with a position that points at
 *   something innocent.
 * - **A lone surrogate** is not valid UTF-8 and does not survive a JSON
 *   transport intact, so the snippet that arrives is not the snippet that was
 *   sent.
 *
 * Neither is present today. This is here so that neither can ARRIVE quietly:
 * the check costs a pass over a 36 kB string and turns an inscrutable
 * cross-process failure into a message naming the character.
 */
export function assertTransportable(snippet) {
  const offenders = new Set()
  for (const character of snippet) {
    const code = character.charCodeAt(0)
    if (character === LINE_SEPARATOR || character === PARAGRAPH_SEPARATOR) offenders.add(code)
    // Iteration is by code point, so a well-formed pair arrives as one
    // two-unit string. A one-unit string in the surrogate range is therefore
    // unpaired, which is the case worth refusing.
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) offenders.add(code)
  }
  if (offenders.size === 0) return snippet
  /* No padding: every character refused above is at U+2028 or higher, so its
     hex is four digits already. It was padded to four, which no run could see. */
  const named = [...offenders].map((code) => 'U+' + code.toString(16).toUpperCase()).join(', ')
  throw new Error(
    `word-snap-parity: the snippet carries ${named} — a JS line terminator or an unpaired ` +
      'surrogate. It would fail at parse inside the webview, or arrive mangled. Escape it, or ' +
      'take it out of the comment it came from.',
  )
}

/**
 * A self-contained snippet that runs `rows` through the real implementation and
 * returns a report.
 *
 * The rows are a parameter, never an import inside this function. That is what
 * makes "derived from the fixture at run time" a structural fact rather than a
 * claim: a generator closing over its own table cannot produce a different
 * snippet for a different corpus, and the test feeds it one.
 */
export function buildSnippet(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('word-snap-parity: buildSnippet needs an array of corpus rows')
  }
  const implementation = snapperSource() + DRIVER
  /* The `;` travels inside the statement it ends. As a literal of its own,
   * deleting it changed nothing any run could see: the inlined source opens on
   * a comment line, so automatic semicolon insertion put it back. */
  return assertTransportable(
    '(function () {\n' +
      "'use strict';\n" +
      `const ROWS = ${asAsciiJson(rows)};\n` +
      `const IMPLEMENTATION = '${digestOf(implementation)}';\n` +
      implementation +
      '})()\n',
  )
}

/**
 * The identity of the code a report came from: everything the snippet runs
 * except its rows, which `inputsOf` already holds.
 *
 * ⚠️ **A REPORT FROM OLDER CODE PASSED AGAINST NEWER CODE**, here after
 * `sentence-parity.mjs` had been fixed for it. Every row was pinned to the
 * corpus and nothing pinned the report to the implementation, so a webview run
 * from before a change to `snapWordRange.ts` — or to this driver — compared
 * after it agreed wherever the change happened not to move Node's answers.
 */
function digestOf(implementation) {
  return createHash('sha256').update(implementation).digest('hex')
}

/**
 * The corpus, imported from `corpus.ts` with nothing but Node's own type
 * stripping — no vite, no bundler, no build step. `corpus.ts` has no value
 * imports, which is what makes that possible, and `corpus.test.ts` enforces it.
 *
 * `from` is there for the refusal: the real module always exports the array,
 * so only a module that does not can show the refusal fires.
 */
export async function loadCorpus(from = new URL('corpus.ts', WORD_SNAP)) {
  const module = await import(from.href)
  const rows = module.CORPUS
  if (!Array.isArray(rows)) {
    throw new Error(`word-snap-parity: ${from.href} did not export a CORPUS array`)
  }
  return rows
}

/**
 * JSON with every object's keys in one order.
 *
 * ⚠️ **THE ORDER OF AN OBJECT'S FIELDS WAS COMPARED AS THOUGH IT WERE
 * BEHAVIOUR.** A snap written `{ end, start }` diverged from the same snap
 * written `{ start, end }` — 41 divergences from one real report, measured
 * 2026-09-14 — an order a transport rebuilding the object decides, and neither
 * engine. `sentence-parity.mjs` had already been fixed for it.
 */
const compact = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, inner[key]]),
        )
      : inner,
  )
const boundaries = (segments) => compact(segments.map((s) => [s.text, s.index]))
const flags = (segments) => compact(segments.map((s) => s.wordLike))

/**
 * Everything about a row that is INPUT rather than result.
 *
 * ⚠️ **Comparing ids was not enough, and this harness was the second place to
 * learn it.** `sentence-parity.mjs` was audited and fixed first; this one was
 * left on the grounds that it is separately tested — which was the wrong
 * reason, because its tests did not carry the new guarantee across. Two
 * harnesses that disagree about what "the same corpus" means is one defect in
 * two files.
 *
 * The gap it closes: a webview report produced from an OLDER corpus, whose rows
 * kept their ids while their `strs`, edges or expectation moved underneath
 * them, agrees on every id and can agree on the snapped answers by luck. What
 * it cannot do is agree on this.
 */
const inputsOf = (row) => compact([row.id, row.strs, row.start, row.end, row.expected])

/**
 * Whether a report's engine is a browser.
 *
 * ⚠️ **NODE'S OWN REPORT, FED BACK, PASSED FOR WEBKIT'S** — reproduced here on
 * 2026-09-14, after the same fix had landed in `sentence-parity.mjs`. `--check`
 * prints a report and `--compare` accepted it: one engine agreeing with itself,
 * printed as "rows agree between this engine and no navigator — not a browser
 * engine", exit 0. Node outside a vm has a `navigator` of its own, and its user
 * agent says `Node.js/`.
 */
const fromABrowser = (engine) =>
  typeof engine === 'string' && engine !== NO_BROWSER && !/^Node\.js\//u.test(engine)

/**
 * What the driver writes in every row, as a test of each field's value. Every
 * field is written for every row; `actual`, `text` and `error` are `null` when
 * there is nothing to say.
 *
 * ⚠️ **A ROW MISSING A FIELD THE DRIVER ALWAYS WRITES COMPARED SUCCESSFULLY.**
 * Reproduced 2026-09-14: with `error` taken out of every row a real report
 * still agreed, and a row without `segments` was read as `[]` — which two real
 * rows genuinely are. The shape is held first, so nothing past it can mistake
 * an absent field for a value.
 */
const TEXT = (value) => typeof value === 'string'
const NUMBER = (value) => typeof value === 'number'
const FLAG = (value) => typeof value === 'boolean'
const TEXTS = (value) => Array.isArray(value) && value.every(TEXT)
const EDGE = (value) => NUMBER(value?.index) && NUMBER(value.offset)
const SNAP = (value) => EDGE(value?.start) && EDGE(value.end)
const SEGMENT = (value) => TEXT(value?.text) && NUMBER(value.index) && FLAG(value.wordLike)
const ROW_SHAPE = {
  id: TEXT,
  tags: TEXTS,
  strs: TEXTS,
  start: EDGE,
  end: EDGE,
  expected: (value) => value === 'none' || SNAP(value),
  actual: (value) => value === null || SNAP(value),
  text: (value) => value === null || TEXT(value),
  pass: FLAG,
  error: (value) => value === null || TEXT(value),
  segments: (value) => Array.isArray(value) && value.every(SEGMENT),
}

/** Each field some row lacks or mistypes, with those rows — by id, or by where
 *  a row stands when it has no id to be named by. */
function misshapen(rows) {
  const found = []
  for (const [field, valid] of Object.entries(ROW_SHAPE)) {
    const wrong = rows.flatMap((row, at) => (valid(row?.[field]) ? [] : [TEXT(row?.id) ? row.id : at]))
    if (wrong.length > 0) found.push(`${field} in ${compact(wrong)}`)
  }
  return found
}

/**
 * Where a report's own claims disagree with its rows — its totals, and the
 * flag each row carries about itself.
 *
 * ⚠️ **THE TOTALS WERE BELIEVED OVER THE ROWS**, in this harness after the
 * sentence harness had been fixed for it. `total: 999` beside 51 rows, and a row
 * that threw and did not pass under `failures: 0, errors: 0`, compared
 * successfully and exited 0 — reproduced 2026-09-14. The driver writes every
 * count from its rows, and each row's `pass` as `error === null` and the snap
 * being the expected one, so a report in which they disagree was not written
 * by it — or did not arrive intact.
 */
function contradictions(live) {
  const count = (holds) => live.rows.filter(holds).length
  const notPassing = count((row) => !row.pass)
  const erring = count((row) => row.error !== null)
  const passWrong = live.rows
    .filter((row) => row.pass !== (row.error === null && compact(row.actual) === compact(row.expected === 'none' ? null : row.expected)))
    .map((row) => row.id)
  const found = []
  if (live.total !== live.rows.length) found.push(`total ${String(live.total)} for ${live.rows.length} rows`)
  if (live.failures !== notPassing) found.push(`failures ${String(live.failures)} but ${notPassing} not passing`)
  if (live.errors !== erring) found.push(`errors ${String(live.errors)} but ${erring} carrying an error`)
  if (passWrong.length > 0) found.push(`rows whose pass contradicts their error or their answer: ${compact(passWrong)}`)
  return found
}

/**
 * Why a report cannot be compared row for row at all, or `null` when it can.
 * Each reason makes a row-by-row reading meaningless rather than merely
 * different, so each is the ONLY thing said about the report.
 */
function refusalOf(local, live) {
  if (live === null || typeof live !== 'object' || !Array.isArray(live.rows)) {
    return 'the report has no rows array — it is not a report this harness produced'
  }
  if (live.rows.length === 0) {
    return 'the report holds zero rows — an empty run is a failure, not a clean sweep'
  }
  if (!fromABrowser(live.engine)) {
    return `the report came from ${String(live.engine)}, not a browser — an engine compared with itself says nothing about WebKit`
  }
  if (live.implementation !== local.implementation) {
    return (
      `the report was produced by different code: ${String(live.implementation)} against ` +
      `${String(local.implementation)} here — emit the snippet again and rerun it in the webview`
    )
  }
  const shape = misshapen(live.rows)
  if (shape.length > 0) {
    return `the report's rows are missing fields this harness writes, or carry them as the wrong type: ${shape.join(', ')}`
  }
  const wrong = contradictions(live)
  if (wrong.length > 0) {
    return `the report's own claims contradict its rows: ${wrong.join(', ')}`
  }

  const localIds = local.rows.map((row) => row.id)
  const liveIds = live.rows.map((row) => row.id)
  if (compact(localIds) !== compact(liveIds)) {
    const missing = localIds.filter((id) => !liveIds.includes(id))
    const extra = liveIds.filter((id) => !localIds.includes(id))
    return (
      'the report was produced from a different corpus: ' +
      `${liveIds.length} rows against ${localIds.length} here` +
      (missing.length > 0 ? `, missing ${compact(missing)}` : '') +
      (extra.length > 0 ? `, unexpected ${compact(extra)}` : '')
    )
  }
  return null
}

/**
 * A webview report against this engine's, row for row.
 *
 * Three outcomes, and the difference between them is the whole calibration of
 * this harness:
 *
 * - **A different snap is fatal.** That is a real behaviour difference.
 * - **Different segment boundaries are fatal.** The snap may still agree by
 *   luck today; the boundaries are the thing that moved.
 * - **A different `isWordLike` flag is a NOTE, not a failure.** It is the
 *   divergence we already know about and deliberately do not read — `3.14`,
 *   `1,000` and `42` are flagged word-like by Node and not by WebKit. Failing
 *   on it would make this harness red on a healthy app, which is how a check
 *   gets switched off.
 *
 * Before any of them, a report that cannot be read row for row is refused as a
 * whole — see `refusalOf` — and past that point every field is taken as written.
 *
 * Exported because `word-snap-live.mjs` drives the same comparison over the
 * bridge. A second implementation there would be a second calibration of these
 * three outcomes, and the two would diverge the first time one was tuned.
 */
export function compareReports(local, live) {
  const refusal = refusalOf(local, live)
  if (refusal !== null) return { problems: [refusal], notes: [] }

  const problems = []
  const notes = []
  for (let i = 0; i < local.rows.length; i += 1) {
    const here = local.rows[i]
    const there = live.rows[i]
    if (inputsOf(here) !== inputsOf(there)) {
      problems.push(
        `${here.id}: the report was produced from a DIFFERENT version of this row\n` +
          `    node    ${inputsOf(here)}\n` +
          `    webview ${inputsOf(there)}`,
      )
      continue
    }
    if (compact(here.actual) !== compact(there.actual)) {
      problems.push(
        `${here.id}: snapped differently\n` +
          `    node    ${compact(here.actual)}\n` +
          `    webview ${compact(there.actual)}\n` +
          `    node    segments ${boundaries(here.segments)}\n` +
          `    webview segments ${boundaries(there.segments)}`,
      )
      continue
    }
    if (boundaries(here.segments) !== boundaries(there.segments)) {
      problems.push(
        `${here.id}: segmented differently while snapping the same\n` +
          `    node    ${boundaries(here.segments)}\n` +
          `    webview ${boundaries(there.segments)}`,
      )
      continue
    }
    if (flags(here.segments) !== flags(there.segments)) {
      notes.push(
        `${here.id}: isWordLike differs — node ${flags(here.segments)}, ` +
          `webview ${flags(there.segments)}`,
      )
    }
  }

  if (live.failures > 0) {
    problems.push(`the webview reported ${live.failures} of its own failures against the corpus`)
  }
  if (live.ok !== true && problems.length === 0) {
    problems.push(`the webview reported ok:false — ${String(live.reason)}`)
  }
  return { problems, notes }
}

const USAGE = [
  'usage:',
  '  node scripts/word-snap-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/word-snap-parity.mjs --check         run the snippet in this engine',
  '  node scripts/word-snap-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/word-snap-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

/**
 * The script, with everything it reads and writes handed in — the same seam
 * as `sentence-parity.mjs`'s `main`.
 *
 * The defaults are the process: its two streams, file descriptor 0 and the
 * corpus on disk. A test hands in writers that capture, an open file as
 * `stdin` and, for the branches the real corpus cannot reach, rows of its own.
 * ⚠️ **THIS SCRIPT WAS TESTED ONLY BY SPAWNING IT**, which exercises a CLI
 * faithfully and measures none of it: 201 of its 266 mutants were uncovered
 * behind a green test file, `compareReports` among them.
 *
 * Nothing leaves as a rejection. A crash is a run that did not happen, so it
 * exits non-zero with its stack like every other failure here.
 */
export async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr, stdin = 0, corpus = loadCorpus } = {},
) {
  try {
    return await run(argv, { stdout, stderr, stdin, corpus })
  } catch (cause) {
    stderr.write(`word-snap-parity: ${cause?.stack ?? String(cause)}\n`)
    return 1
  }
}

/**
 * How many arguments each mode takes, counting its own name.
 *
 * ⚠️ **AN ARGUMENT AFTER THE MODE WAS IGNORED**, `--help`'s included — the fix
 * `sentence-parity.mjs` already carried, reproduced here 2026-09-14.
 * `--check --compare missing.json` ran the check, never looked for the report,
 * and exited 0; `--help --compare report.json` printed the usage and exited 0.
 * Each a comparison that did not happen, reading exactly like one that passed.
 */
const ARITY = { '--emit': 1, '--check': 1, '--compare': 2, '--help': 1, '-h': 1 }

async function run(argv, io) {
  const mode = argv[0] ?? '--emit'
  if (!Object.hasOwn(ARITY, mode)) {
    io.stderr.write(`word-snap-parity: unknown option ${mode}\n${USAGE}\n`)
    return 1
  }
  if (argv.length > ARITY[mode]) {
    io.stderr.write(
      `word-snap-parity: ${mode} takes ${ARITY[mode] === 2 ? 'one argument' : 'no arguments'}, ` +
        `and was also given ${compact(argv.slice(ARITY[mode]))}\n${USAGE}\n`,
    )
    return 1
  }
  if (mode === '--help' || mode === '-h') {
    io.stderr.write(USAGE + '\n')
    return 0
  }
  /* Before the corpus, like every other refusal here: a command line that is
     already wrong should not depend on the corpus being readable. */
  if (mode === '--compare' && argv[1] === undefined) {
    io.stderr.write('word-snap-parity: --compare needs a report file, or - for stdin\n')
    return 1
  }

  const rows = await io.corpus()
  if (rows.length === 0) {
    io.stderr.write('word-snap-parity: the corpus is empty — nothing to check\n')
    return 1
  }

  if (mode === '--emit') {
    io.stdout.write(buildSnippet(rows))
    io.stderr.write(
      `word-snap-parity: ${rows.length} rows. Paste stdout into webview_execute_js, then feed ` +
        'the report back with --compare -\n',
    )
    return 0
  }

  if (mode === '--check') {
    const report = evaluateSnippet(buildSnippet(rows))
    io.stdout.write(JSON.stringify(report, null, 2) + '\n')
    io.stderr.write(
      report.ok
        ? `word-snap-parity: ${report.total} rows pass in this engine\n`
        : `word-snap-parity: ${String(report.reason)}\n`,
    )
    return report.ok ? 0 : 1
  }

  /* `--compare`, the only mode left, and it has a value: both were settled
     above, before the corpus was read. */
  const path = argv[1]
  let live
  try {
    live = readReport(path, io.stdin)
  } catch (cause) {
    /* The bridge-unreachable case. No report is not a pass: it is a run that
     * did not happen, and only the exit code can tell the two apart. */
    io.stderr.write(
      `word-snap-parity: no report to compare (${path}): ${cause.message}\n` +
        '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n',
    )
    return 1
  }

  const local = evaluateSnippet(buildSnippet(rows))
  const { problems, notes } = compareReports(local, live)

  for (const note of notes) io.stderr.write(`  note: ${note}\n`)
  if (problems.length === 0) {
    io.stderr.write(
      `word-snap-parity: ${local.total} rows agree between this engine and ${String(live.engine)}` +
        (notes.length > 0 ? ` (${notes.length} isWordLike flag differences, not read by us)\n` : '\n'),
    )
    return 0
  }
  const plural = problems.length === 1 ? 'divergence' : 'divergences'
  io.stderr.write(`word-snap-parity: ${problems.length} ${plural}\n`)
  for (const problem of problems) io.stderr.write(`  ${problem}\n`)
  return 1
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `main`, which is measured in-process
if (isProcessEntry(import.meta)) process.exitCode = await main(process.argv.slice(2))
