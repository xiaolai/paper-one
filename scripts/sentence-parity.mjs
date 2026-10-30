/**
 * Cross-engine parity harness for sentence extraction.
 *
 * The same argument as `word-snap-parity.mjs`, one granularity up.
 * `Intl.Segmenter` is backed by ICU, and **Node and WebKit do not agree** —
 * measured in this repository for word granularity, and a macOS upgrade can
 * move sentence breaking the same way without anything here changing. Sentence
 * boundaries are also *more* locale-dependent than word boundaries, so the
 * surface for divergence is larger rather than smaller.
 *
 * A separate script from the word-snap harness, not a mode of it, for the
 * reason `sentenceCorpus.ts` is a separate schema: the row shapes have nothing
 * in common, and one driver serving both would be a `if (kind === …)` down its
 * whole length. What IS shared is shared — `inlineModules` and
 * `assertTransportable` are imported rather than reimplemented.
 *
 *   node scripts/sentence-parity.mjs                  emit the snippet
 *   node scripts/sentence-parity.mjs --check          run it in THIS engine
 *   node scripts/sentence-parity.mjs --compare FILE   diff a webview report
 *   node scripts/sentence-parity.mjs --compare -      … from stdin
 *
 * **Everything is read at run time — nothing here is a transcription.** The
 * rows come from `sentenceCorpus.ts` and the algorithm from `sentenceOf.ts`,
 * both loaded from disk on every invocation. A generator holding its own copy
 * of either would report a green parity run against code the app does not
 * contain, which is worse than no harness at all. `buildSnippet` therefore
 * takes its rows as an ARGUMENT, which is what makes the property checkable:
 * `sentence-parity.test.mjs` hands it a corpus with one extra row and the
 * emitted snippet must grow by one row.
 *
 * **THE LANE IS MANUAL-ONLY.** `node scripts/verify.mjs --list` contains no
 * parity step, so a green `pnpm verify` says nothing whatsoever about WebKit.
 * Whoever needs that evidence runs this against the app over the bridge (port
 * 31415, see `AGENTS.md`) and records the result. Every failure exits non-zero,
 * because a parity run that produced no report is a run that did not happen —
 * and in a summary that looks exactly like a clean sweep unless the exit code
 * says otherwise.
 */

import { createHash } from 'node:crypto'
import { isProcessEntry } from './lib/entry.mjs'
import { inlineModules } from './lib/inline-ts.mjs'
import { asAsciiJson, evaluateSnippet, readReport } from './lib/parity.mjs'
import { assertTransportable } from './word-snap-parity.mjs'

/** The extraction policy, in dependency order. `sentenceOf.ts` imports nothing
 *  at all, which is what keeps this list one entry long. */
const MODULES = ['sentenceOf.ts']

const WORD_SNAP = new URL('../src/kernel/ui/reader/wordSnap/', import.meta.url)

function extractorSource() {
  return inlineModules(WORD_SNAP, MODULES)
}

/** What a report calls its engine when the snippet found no `navigator` — which
 *  is to say when it ran in Node's vm, and not in a browser at all. */
const NO_BROWSER = 'no navigator — not a browser engine'

/**
 * Every sentence segmentation the extractor performs, recorded as it happens.
 * Placed before the inlined implementation, so the `Intl` it declares is the
 * one that implementation sees.
 *
 * ⚠️ **THE TRACE USED TO BE `row.raw`, SEGMENTED BY THE DRIVER ITSELF — OFTEN
 * NOT A TEXT THE EXTRACTOR SEGMENTS AT ALL.** `sentenceOf` squeezes whitespace
 * and drops soft hyphens before it segments, and at a run's edge it segments
 * the text JOINED to what lies across that edge. Measured 2026-09-13 over the
 * corpus: in 16 of its 36 rows the recorded trace was not what the extractor
 * handed the engine, 10 rows asked the engine more than once, and 6 never
 * asked it about `row.raw` at all. So a boundary could move in the very text an
 * answer depends on while the trace stood still — and the driver's own
 * segmentation swallowed any throw, recording it as no segments.
 *
 * Recorded through a LOCAL `Intl` whose `Segmenter` wraps the engine's, so the
 * page's own global is never touched. Each call keeps the text it was handed
 * and the boundaries the engine returned. Nothing here catches: a throw reaches
 * the driver as that row's error.
 *
 * Written without template literals, like `DRIVER`.
 */
const TRACE = `
const SEGMENTED = [];
const Intl = (function (engine) {
  if (typeof engine !== 'object' || engine === null || typeof engine.Segmenter !== 'function') return engine;
  const Recorded = class {
    constructor(locale, options) {
      this.engine = new engine.Segmenter(locale, options);
    }
    segment(text) {
      const segments = this.engine.segment(text);
      const boundaries = [];
      for (const part of segments) boundaries.push(part.index);
      SEGMENTED.push([text, boundaries]);
      return segments;
    }
    resolvedOptions() {
      return this.engine.resolvedOptions();
    }
  };
  return Object.assign(Object.create(engine), { Segmenter: Recorded });
})(globalThis.Intl);
`

/**
 * The report builder, as source. Runs with `ROWS`, `IMPLEMENTATION`,
 * `SEGMENTED` and `sentenceOf` already in scope. Written without template
 * literals so it survives being embedded in one.
 *
 * It records, for every row and not only the failing ones, each segmentation
 * the extractor asked the engine for — see `TRACE`. A divergence is useless
 * without it, and two engines that segment differently while happening to
 * agree on the answer are exactly the drift this exists to catch early.
 *
 * ⚠️ **A ROW THAT NEVER ASKS THE ENGINE PASSES, AND THAT IS THE RIGHT ANSWER.**
 * An audit raised the empty-input row with the invalid locale `en_US` as an
 * `ok: true` that ought to have been a failure. MEASURED 2026-09-13 against
 * this driver: that row comes back `segmented: []`, `error: null`, and exactly
 * what the identical row with a VALID locale comes back as — `sentenceOf`
 * refuses an empty run before it builds a `Segmenter`, so the locale is never
 * read and no ICU is involved. Two engines cannot disagree about a path neither
 * of them reaches.
 *
 * The same locale with TEXT in the row does throw — `Incorrect locale
 * information provided` — and is recorded as that row's `error` and counted as
 * its failure, which is the half that was missing. And two rows of the real
 * corpus ask nothing of the engine today (`term-of-whitespace-only`,
 * `run-of-whitespace-only`), so an empty `segmented` is a fact about the row
 * rather than a fault: it is written out for every row precisely so a reader
 * can tell which rows measured the engine and which did not.
 */
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
  uncovered: 0,
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

const sameAnswer = function (a, b) {
  if (a === 'none' || b === 'none') return a === b;
  return !!a && !!b && a.sentence === b.sentence && a.term === b.term;
};

for (let i = 0; i < ROWS.length; i += 1) {
  const row = ROWS[i];

  SEGMENTED.length = 0;
  let actual = null;
  let error = null;
  try {
    const result = sentenceOf(row.raw, row.termStart, row.termEnd, {
      locale: row.locale,
      maxSentenceChars: row.maxSentenceChars,
      before: row.before,
      after: row.after,
      requireComplete: row.requireComplete,
    });
    actual = result.ok ? { sentence: result.sentence, term: result.term } : 'none';
  } catch (thrown) {
    error = String((thrown && thrown.message) || thrown);
  }
  const segmented = SEGMENTED.slice();

  const pass = error === null && sameAnswer(actual, row.actual);
  if (error !== null) report.errors += 1;
  if (!pass) report.failures += 1;
  /* Recorded, not failed on: a row whose hand-written sentence differs from
   * what we return is a known shortfall the corpus is there to make legible. */
  const covered = row.actual === 'none' ? row.sentence === 'none' : row.actual.sentence === row.sentence;
  if (!covered) report.uncovered += 1;

  report.rows.push({
    id: row.id,
    tags: row.tags,
    locale: row.locale,
    raw: row.raw,
    termStart: row.termStart,
    termEnd: row.termEnd,
    maxSentenceChars: row.maxSentenceChars,
    before: row.before,
    after: row.after,
    requireComplete: row.requireComplete,
    sentence: row.sentence,
    expected: row.actual,
    actual: actual,
    covered: covered,
    pass: pass,
    error: error,
    segmented: segmented,
  });
}

report.ok = report.failures === 0;
report.reason = report.ok
  ? null
  : report.failures + ' of ' + report.total + ' rows diverged from the corpus';
return report;
`

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
    throw new TypeError('sentence-parity: buildSnippet needs an array of corpus rows')
  }
  const implementation = TRACE + extractorSource() + DRIVER
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
 * ⚠️ **A REPORT FROM OLDER CODE PASSED AGAINST NEWER CODE.** Every row was
 * pinned to the corpus and nothing pinned the report to the implementation, so
 * a webview run from before a change to `sentenceOf.ts` — or to this driver —
 * compared after it agreed wherever the change happened not to move Node's
 * answers, and reported WebKit parity for code WebKit had never run.
 */
function digestOf(implementation) {
  return createHash('sha256').update(implementation).digest('hex')
}

/**
 * The corpus, imported with nothing but Node's own type stripping — no vite, no
 * bundler, no build step. `sentenceCorpus.ts` has no imports at all, which is
 * what makes that possible, and `sentenceCorpus.test.ts` enforces it.
 *
 * `from` is there for the refusal: the real module always exports the array,
 * so only a module that does not can show the refusal fires.
 */
export async function loadCorpus(from = new URL('sentenceCorpus.ts', WORD_SNAP)) {
  const module = await import(from.href)
  const rows = module.SENTENCE_CORPUS
  if (!Array.isArray(rows)) {
    throw new Error(`sentence-parity: ${from.href} did not export a SENTENCE_CORPUS array`)
  }
  return rows
}

/**
 * JSON with every object's keys in one order.
 *
 * ⚠️ **THE ORDER OF AN OBJECT'S FIELDS WAS COMPARED AS THOUGH IT WERE
 * BEHAVIOUR.** An answer written `{ term, sentence }` diverged from the same
 * answer written `{ sentence, term }`, and so did an expectation in `inputsOf`
 * — an order that a transport rebuilding the object decides, and neither engine.
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
/** A row's segmentations — each text the extractor handed the engine, with the
 *  boundaries it got back. See `TRACE`. Every row has them, `[]` included:
 *  `misshapen` refuses one that does not. */
const traceOf = (row) => compact(row.segmented)

/**
 * Everything about a row that is INPUT rather than result.
 *
 * Comparing ids alone was not enough, and the gap is exactly the one a stale
 * report walks through: a report produced from an older corpus whose row kept
 * its id while its text, offsets, locale, cap, far sides, completeness gate or
 * expectation changed underneath it agrees on every id and can agree on the
 * answers by luck. What it cannot do is agree on this.
 *
 * The expectation is included deliberately. A row whose `actual` was updated in
 * the tree and not in the webview run is precisely a run that no longer says
 * anything about the code on disk.
 *
 * ⚠️ **AN ABSENT FAR SIDE AND A `null` ONE ARE DIFFERENT INPUTS** — "nothing is
 * known across this edge" and "nothing lies across it" (`sentenceCorpus.ts`),
 * which answer differently — and an array serialises both as `null`. So absence
 * is spelled out rather than left to `JSON.stringify` to erase.
 *
 * ⚠️ **AND SO ARE AN ABSENT `requireComplete` AND A `false` ONE.** Absent is
 * the completeness gate ON, which is `sentenceOf`'s default, and `false` is the
 * fallback walk that answers without it — so a row that moved from one to the
 * other can change its answer with every other input standing still. Absence
 * is spelled out the same way.
 */
const sideOf = (value) => (value === undefined ? { unknown: true } : value)
const gateOf = (value) => (value === undefined ? { gated: true } : value)
const inputsOf = (row) =>
  compact([
    row.id,
    row.raw,
    row.termStart,
    row.termEnd,
    row.locale,
    row.maxSentenceChars,
    sideOf(row.before),
    sideOf(row.after),
    gateOf(row.requireComplete),
    row.sentence,
    row.expected,
  ])

/**
 * Whether a report's engine is a browser.
 *
 * ⚠️ **NODE'S OWN REPORT, FED BACK, PASSED FOR WEBKIT'S.** `--check` prints a
 * report and `--compare` accepted it: one engine agreeing with itself, printed
 * as "rows agree between this engine and no navigator — not a browser engine"
 * and exited 0. A mixed-up file satisfied the one comparison this harness
 * exists to make. Node outside a vm has a `navigator` of its own, and its user
 * agent says `Node.js/`.
 */
const fromABrowser = (engine) =>
  typeof engine === 'string' && engine !== NO_BROWSER && !/^Node\.js\//u.test(engine)

/**
 * What the driver writes in every row, as a test of each field's value.
 * `before`, `after` and `requireComplete` may be absent — `inputsOf` says what
 * absence means for each — and every other field is written for every row.
 *
 * ⚠️ **A ROW MISSING A FIELD THE DRIVER ALWAYS WRITES COMPARED SUCCESSFULLY.**
 * Finding #20, reproduced 2026-09-14: with `error` taken out of every row a
 * report still agreed, because an absent error read as no error — and a row
 * without `segmented` read as one that segmented nothing, which two real rows
 * genuinely do. Nothing past this point can tell an absent field from a value,
 * so the shape is held first, and everything after it takes each field as
 * written.
 */
const TEXT = (value) => typeof value === 'string'
const NUMBER = (value) => typeof value === 'number'
const FLAG = (value) => typeof value === 'boolean'
const ANSWER = (value) => value === 'none' || (TEXT(value?.sentence) && TEXT(value.term))
const FAR_SIDE = (value) => value === undefined || value === null || TEXT(value)
const ROW_SHAPE = {
  id: TEXT,
  tags: (value) => Array.isArray(value) && value.every(TEXT),
  locale: TEXT,
  raw: TEXT,
  termStart: NUMBER,
  termEnd: NUMBER,
  maxSentenceChars: NUMBER,
  sentence: TEXT,
  expected: ANSWER,
  actual: (value) => value === null || ANSWER(value),
  covered: FLAG,
  pass: FLAG,
  error: (value) => value === null || TEXT(value),
  segmented: (value) =>
    Array.isArray(value) &&
    value.every(
      (one) => Array.isArray(one) && one.length === 2 && TEXT(one[0]) && Array.isArray(one[1]) && one[1].every(NUMBER),
    ),
  before: FAR_SIDE,
  after: FAR_SIDE,
  requireComplete: (value) => value === undefined || FLAG(value),
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
 * Where a report's own claims disagree with its rows — its totals, and the two
 * flags each row carries about itself.
 *
 * ⚠️ **THE TOTALS WERE BELIEVED OVER THE ROWS.** `ok: true, failures: 0`
 * passed a report holding a row that had not passed and carried an error, with
 * an `errors` count saying so and a `total` that was wrong. The driver writes
 * every count from its rows, so a report in which they disagree was not
 * written by it — or did not arrive intact.
 *
 * ⚠️ **AND A ROW COULD PASS WHILE CARRYING AN ERROR, WITH EVERY TOTAL AGREEING
 * ON IT.** One error, no failures, the right count — all three tallies add up,
 * and the row still says it both threw and passed.
 *
 * ⚠️ **AND `uncovered` WAS NO TOTAL AT ALL, AND A ROW'S FLAGS WERE TAKEN AT
 * THEIR WORD.** `uncovered: 999` beside 37 rows compared successfully — finding
 * #20, 2026-09-14 — and so would a row passing with the wrong answer, or calling
 * itself covered against its own sentence, with every total agreeing with the
 * flags it was counted from. The driver writes `pass` as `error === null` and
 * the answer being the expected one, and `covered` as the hand-written
 * sentence being the expected one; those fields are held to the corpus row by
 * row, so each flag is held to them here, and each total to the flags.
 */
function contradictions(live) {
  const count = (holds) => live.rows.filter(holds).length
  const idsWhere = (holds) => live.rows.filter(holds).map((row) => row.id)
  const notPassing = count((row) => !row.pass)
  const erring = count((row) => row.error !== null)
  const notCovered = count((row) => !row.covered)
  const passWrong = idsWhere((row) => row.pass !== (row.error === null && compact(row.actual) === compact(row.expected)))
  const coveredWrong = idsWhere(
    (row) => row.covered !== (row.sentence === (row.expected === 'none' ? 'none' : row.expected.sentence)),
  )
  const found = []
  if (live.total !== live.rows.length) found.push(`total ${String(live.total)} for ${live.rows.length} rows`)
  if (live.failures !== notPassing) found.push(`failures ${String(live.failures)} but ${notPassing} not passing`)
  if (live.errors !== erring) found.push(`errors ${String(live.errors)} but ${erring} carrying an error`)
  if (live.uncovered !== notCovered) found.push(`uncovered ${String(live.uncovered)} but ${notCovered} not covered`)
  if (passWrong.length > 0) found.push(`rows whose pass contradicts their error or their answer: ${compact(passWrong)}`)
  if (coveredWrong.length > 0) found.push(`rows whose covered contradicts their sentence: ${compact(coveredWrong)}`)
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
 * Two fatal outcomes, and no ignorable third — which is the one way this
 * differs from the word-snap harness. There, `isWordLike` is a known
 * divergence the implementation deliberately never reads, so failing on it
 * would make the check red on a healthy app. Nothing here is read and ignored:
 * every segmentation recorded is one the extractor asked for, so every
 * boundary in it is a boundary the answer depends on.
 *
 * - **A different answer is fatal.** That is a real behaviour difference, and
 *   it means one of the two engines is handing a different sentence to the
 *   model.
 * - **A different segmentation is fatal** — a different text handed to the
 *   engine, or different boundaries back. The answer may still agree by luck
 *   today; the segmentation is the thing that moved.
 *
 * The uncovered COUNT is a note rather than a problem: it is the corpus saying
 * what it already says under Node, and a webview that reproduces it exactly is
 * agreeing rather than failing.
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
        `${here.id}: extracted differently\n` +
          `    node    ${compact(here.actual)}\n` +
          `    webview ${compact(there.actual)}\n` +
          `    node    segmented ${traceOf(here)}\n` +
          `    webview segmented ${traceOf(there)}`,
      )
      continue
    }
    if (traceOf(here) !== traceOf(there)) {
      problems.push(
        `${here.id}: segmented differently while extracting the same\n` +
          `    node    ${traceOf(here)}\n` +
          `    webview ${traceOf(there)}`,
      )
    }
  }

  if (live.failures > 0) {
    problems.push(`the webview reported ${live.failures} of its own failures against the corpus`)
  }
  if (live.ok !== true && problems.length === 0) {
    problems.push(`the webview reported ok:false — ${String(live.reason)}`)
  }
  /* A number, and the rows' own — `contradictions` refused any other. */
  if (live.uncovered > 0) {
    notes.push(
      `${live.uncovered} of ${live.total} rows are cases the implementation does not get right; ` +
        'see each row’s `why` in sentenceCorpus.ts',
    )
  }
  return { problems, notes }
}

const USAGE = [
  'usage:',
  '  node scripts/sentence-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/sentence-parity.mjs --check         run the snippet in this engine',
  '  node scripts/sentence-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/sentence-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

/**
 * The script, with everything it reads and writes handed in.
 *
 * The defaults are the process: its two streams, file descriptor 0 and the
 * corpus on disk. A test hands in writers that capture, an open file as
 * `stdin` and, for the branches the real corpus cannot reach, rows of its own —
 * then reads back the exit code and every word. A child process could do all of
 * that except be measured: it runs outside the test runner, so a CLI exercised
 * only by spawning it reads as untested to coverage and to mutation testing
 * alike.
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
    stderr.write(`sentence-parity: ${cause?.stack ?? String(cause)}\n`)
    return 1
  }
}

/**
 * How many arguments each mode takes, counting its own name.
 *
 * ⚠️ **`--help` WAS NOT IN HERE, AND IT WAS THE ONE MODE THAT IGNORED WHAT
 * FOLLOWED IT.** It answered before the arity check, so
 * `--help --compare report.json` printed the usage and exited 0 — the same
 * silent nothing as the `--check --compare missing.json` the check below exists
 * for, wearing the exit code that says the run happened.
 */
const ARITY = { '--emit': 1, '--check': 1, '--compare': 2, '--help': 1, '-h': 1 }

async function run(argv, io) {
  const mode = argv[0] ?? '--emit'
  if (!Object.hasOwn(ARITY, mode)) {
    io.stderr.write(`sentence-parity: unknown option ${mode}\n${USAGE}\n`)
    return 1
  }
  /* ⚠️ **AN ARGUMENT AFTER THE MODE WAS IGNORED.** `--check --compare
   * missing.json` ran the check, never looked for the report, and exited 0 — a
   * comparison that did not happen, reading exactly like one that passed. */
  if (argv.length > ARITY[mode]) {
    io.stderr.write(
      `sentence-parity: ${mode} takes ${ARITY[mode] === 2 ? 'one argument' : 'no arguments'}, ` +
        `and was also given ${compact(argv.slice(ARITY[mode]))}\n${USAGE}\n`,
    )
    return 1
  }
  if (mode === '--help' || mode === '-h') {
    io.stderr.write(USAGE + '\n')
    return 0
  }
  /* ⚠️ **AND A MISSING VALUE WAS FOUND ONLY AFTER THE CORPUS HAD LOADED**, so
   * `--compare` with nothing after it read 36 rows off disk to refuse a command
   * line that was already wrong. Every other refusal here happens first; a
   * mistyped one should not depend on the corpus being readable. */
  if (mode === '--compare' && argv[1] === undefined) {
    io.stderr.write('sentence-parity: --compare needs a report file, or - for stdin\n')
    return 1
  }

  const rows = await io.corpus()
  if (rows.length === 0) {
    io.stderr.write('sentence-parity: the corpus is empty — nothing to check\n')
    return 1
  }

  if (mode === '--emit') {
    io.stdout.write(buildSnippet(rows))
    io.stderr.write(
      `sentence-parity: ${rows.length} rows. Paste stdout into webview_execute_js, then feed ` +
        'the report back with --compare -\n',
    )
    return 0
  }

  if (mode === '--check') {
    const report = evaluateSnippet(buildSnippet(rows))
    io.stdout.write(JSON.stringify(report, null, 2) + '\n')
    io.stderr.write(
      report.ok
        ? `sentence-parity: ${report.total} rows pass in this engine, ${report.uncovered} uncovered\n`
        : `sentence-parity: ${String(report.reason)}\n`,
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
      `sentence-parity: no report to compare (${path}): ${cause.message}\n` +
        '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n',
    )
    return 1
  }

  const local = evaluateSnippet(buildSnippet(rows))
  const { problems, notes } = compareReports(local, live)

  for (const note of notes) io.stderr.write(`  note: ${note}\n`)
  if (problems.length === 0) {
    io.stderr.write(
      `sentence-parity: ${local.total} rows agree between this engine and ${String(live.engine)}\n`,
    )
    return 0
  }
  const plural = problems.length === 1 ? 'divergence' : 'divergences'
  io.stderr.write(`sentence-parity: ${problems.length} ${plural}\n`)
  for (const problem of problems) io.stderr.write(`  ${problem}\n`)
  return 1
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `main`, which is measured in-process
if (isProcessEntry(import.meta)) process.exitCode = await main(process.argv.slice(2))
