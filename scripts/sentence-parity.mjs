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

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { inlineModules } from './lib/inline-ts.mjs'
import { assertTransportable } from './word-snap-parity.mjs'

/** The extraction policy, in dependency order. `sentenceOf.ts` imports nothing
 *  at all, which is what keeps this list one entry long. */
const MODULES = ['sentenceOf.ts']

const WORD_SNAP = new URL('../src/kernel/ui/reader/wordSnap/', import.meta.url)

function extractorSource() {
  return inlineModules(WORD_SNAP, MODULES)
}

/**
 * JSON, escaped down to printable ASCII.
 *
 * The corpus carries a soft hyphen, a no-break space, a line feed, Han and
 * kana. Emitting those raw into a JS string literal is asking for one of them
 * to be eaten by a transport, a terminal or a copy-paste — and the failure
 * would look like a segmentation divergence rather than like the mangling it
 * is. Escaped, the snippet is pure ASCII and says the same thing everywhere.
 *
 * Applied to each row's COMPACT JSON, never to a pretty-printed document: in
 * pretty-printed output the newlines between fields are structure rather than
 * data, and escaping those emits a U+000A escape where the parser needs an
 * actual line break.
 */
function asAsciiJson(rows) {
  const escape = (text) =>
    text.replace(/[^\x20-\x7E]/g, (character) => {
      return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    })
  if (rows.length === 0) return '[]'
  return '[\n  ' + rows.map((row) => escape(JSON.stringify(row))).join(',\n  ') + ',\n]'
}

/**
 * The report builder, as source. Runs with `ROWS` and `sentenceOf` already in
 * scope. Written without template literals so it survives being embedded in
 * one.
 *
 * It records the engine's RAW sentence segmentation for every row, not only
 * the failing ones. A divergence is useless without it, and two engines that
 * segment differently while happening to agree on the answer are exactly the
 * drift this exists to catch early.
 */
const DRIVER = `
const report = {
  ok: false,
  engine:
    typeof navigator === 'object' && navigator !== null && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : 'no navigator — not a browser engine',
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

  const segments = [];
  try {
    const iterator = new Intl.Segmenter(row.locale, { granularity: 'sentence' }).segment(row.raw);
    for (const part of iterator) segments.push([part.segment, part.index]);
  } catch (thrown) {
    segments.length = 0;
  }

  let actual = null;
  let error = null;
  try {
    const result = sentenceOf(row.raw, row.termStart, row.termEnd, {
      locale: row.locale,
      maxSentenceChars: row.maxSentenceChars,
    });
    actual = result.ok ? { sentence: result.sentence, term: result.term } : 'none';
  } catch (thrown) {
    error = String((thrown && thrown.message) || thrown);
  }

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
    sentence: row.sentence,
    expected: row.actual,
    actual: actual,
    covered: covered,
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
  return assertTransportable(
    '(function () {\n' +
      "'use strict';\n" +
      'const ROWS = ' +
      asAsciiJson(rows) +
      ';\n' +
      extractorSource() +
      DRIVER +
      '})()\n',
  )
}

/**
 * Evaluate a snippet here, in a context with no module resolver.
 *
 * The JSON round-trip is not cosmetic: it brings the report out of the vm's
 * realm and, more usefully, proves the report is something the MCP bridge can
 * actually serialise. A report the bridge mangles is a report that arrives
 * looking like a divergence.
 */
export function evaluateSnippet(snippet) {
  return JSON.parse(JSON.stringify(runInNewContext(snippet, undefined, { timeout: 30000 })))
}

/**
 * The corpus, imported with nothing but Node's own type stripping — no vite, no
 * bundler, no build step. `sentenceCorpus.ts` has no imports at all, which is
 * what makes that possible, and `sentenceCorpus.test.ts` enforces it.
 */
export async function loadCorpus() {
  const module = await import(new URL('sentenceCorpus.ts', WORD_SNAP).href)
  const rows = module.SENTENCE_CORPUS
  if (!Array.isArray(rows)) {
    throw new Error('sentence-parity: sentenceCorpus.ts did not export a SENTENCE_CORPUS array')
  }
  return rows
}

const compact = (value) => JSON.stringify(value)
const boundaries = (segments) => compact((segments ?? []).map((pair) => pair[1]))

/**
 * Everything about a row that is INPUT rather than result.
 *
 * Comparing ids alone was not enough, and the gap is exactly the one a stale
 * report walks through: a report produced from an older corpus whose row kept
 * its id while its text, offsets, locale, cap or expectation changed underneath
 * it agrees on every id and can agree on the answers by luck. What it cannot do
 * is agree on this.
 *
 * The expectation is included deliberately. A row whose `actual` was updated in
 * the tree and not in the webview run is precisely a run that no longer says
 * anything about the code on disk.
 */
const inputsOf = (row) =>
  compact([
    row.id,
    row.raw,
    row.termStart,
    row.termEnd,
    row.locale,
    row.maxSentenceChars,
    row.sentence,
    row.expected,
  ])

/**
 * A webview report against this engine's, row for row.
 *
 * Two fatal outcomes, and no ignorable third — which is the one way this
 * differs from the word-snap harness. There, `isWordLike` is a known
 * divergence the implementation deliberately never reads, so failing on it
 * would make the check red on a healthy app. Nothing here is read and ignored:
 * every sentence boundary this engine finds is a boundary the answer depends
 * on.
 *
 * - **A different answer is fatal.** That is a real behaviour difference, and
 *   it means one of the two engines is handing a different sentence to the
 *   model.
 * - **Different segment boundaries are fatal.** The answer may still agree by
 *   luck today; the boundaries are the thing that moved.
 *
 * The uncovered COUNT is a note rather than a problem: it is the corpus saying
 * what it already says under Node, and a webview that reproduces it exactly is
 * agreeing rather than failing.
 */
export function compareReports(local, live) {
  const problems = []
  const notes = []

  if (live === null || typeof live !== 'object' || !Array.isArray(live.rows)) {
    problems.push('the report has no rows array — it is not a report this harness produced')
    return { problems, notes }
  }
  if (live.rows.length === 0) {
    problems.push('the report holds zero rows — an empty run is a failure, not a clean sweep')
    return { problems, notes }
  }

  const localIds = local.rows.map((row) => row.id)
  const liveIds = live.rows.map((row) => row.id)
  if (compact(localIds) !== compact(liveIds)) {
    const missing = localIds.filter((id) => !liveIds.includes(id))
    const extra = liveIds.filter((id) => !localIds.includes(id))
    problems.push(
      'the report was produced from a different corpus: ' +
        `${liveIds.length} rows against ${localIds.length} here` +
        (missing.length > 0 ? `, missing ${compact(missing)}` : '') +
        (extra.length > 0 ? `, unexpected ${compact(extra)}` : ''),
    )
    return { problems, notes }
  }

  for (let i = 0; i < localIds.length; i += 1) {
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
          `    node    boundaries ${boundaries(here.segments)}\n` +
          `    webview boundaries ${boundaries(there.segments)}`,
      )
      continue
    }
    if (boundaries(here.segments) !== boundaries(there.segments)) {
      problems.push(
        `${here.id}: segmented differently while extracting the same\n` +
          `    node    ${boundaries(here.segments)}\n` +
          `    webview ${boundaries(there.segments)}`,
      )
    }
  }

  if (live.failures > 0) {
    problems.push(`the webview reported ${live.failures} of its own failures against the corpus`)
  }
  if (live.ok !== true && problems.length === 0) {
    problems.push(`the webview reported ok:false — ${String(live.reason)}`)
  }
  if (typeof live.uncovered === 'number' && live.uncovered > 0) {
    notes.push(
      `${live.uncovered} of ${live.total} rows are cases the implementation does not get right; ` +
        'see each row’s `why` in sentenceCorpus.ts',
    )
  }
  return { problems, notes }
}

function readReport(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  if (raw.trim() === '') throw new Error('the report is empty')
  return JSON.parse(raw)
}

const USAGE = [
  'usage:',
  '  node scripts/sentence-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/sentence-parity.mjs --check         run the snippet in this engine',
  '  node scripts/sentence-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/sentence-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

async function main(argv) {
  const mode = argv[0] ?? '--emit'
  if (mode === '--help' || mode === '-h') {
    process.stderr.write(USAGE + '\n')
    return 0
  }

  const rows = await loadCorpus()
  if (rows.length === 0) {
    process.stderr.write('sentence-parity: the corpus is empty — nothing to check\n')
    return 1
  }

  if (mode === '--emit') {
    process.stdout.write(buildSnippet(rows))
    process.stderr.write(
      `sentence-parity: ${rows.length} rows. Paste stdout into webview_execute_js, then feed ` +
        'the report back with --compare -\n',
    )
    return 0
  }

  if (mode === '--check') {
    const report = evaluateSnippet(buildSnippet(rows))
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write(
      report.ok
        ? `sentence-parity: ${report.total} rows pass in this engine, ${report.uncovered} uncovered\n`
        : `sentence-parity: ${String(report.reason)}\n`,
    )
    return report.ok ? 0 : 1
  }

  if (mode === '--compare') {
    const path = argv[1]
    if (path === undefined) {
      process.stderr.write('sentence-parity: --compare needs a report file, or - for stdin\n')
      return 1
    }
    let live
    try {
      live = readReport(path)
    } catch (cause) {
      /* The bridge-unreachable case. No report is not a pass: it is a run that
       * did not happen, and only the exit code can tell the two apart. */
      process.stderr.write(
        `sentence-parity: no report to compare (${path}): ${cause.message}\n` +
          '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n',
      )
      return 1
    }

    const local = evaluateSnippet(buildSnippet(rows))
    const { problems, notes } = compareReports(local, live)

    for (const note of notes) process.stderr.write(`  note: ${note}\n`)
    if (problems.length === 0) {
      process.stderr.write(
        `sentence-parity: ${local.total} rows agree between this engine and ${String(live.engine)}\n`,
      )
      return 0
    }
    const plural = problems.length === 1 ? 'divergence' : 'divergences'
    process.stderr.write(`sentence-parity: ${problems.length} ${plural}\n`)
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    return 1
  }

  process.stderr.write(`sentence-parity: unknown option ${mode}\n${USAGE}\n`)
  return 1
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (cause) => {
      process.stderr.write(`sentence-parity: ${cause?.stack ?? String(cause)}\n`)
      process.exitCode = 1
    },
  )
}
