/**
 * Cross-engine parity harness for word-boundary snapping.
 *
 * `Intl.Segmenter` is backed by ICU, and **Node and WebKit do not agree**.
 * Measured in this repository: the segment record's `isWordLike` flag is `true`
 * for `3.14`, `1,000` and `42` under Node's ICU and `false` for all three under
 * the WKWebView the app ships on. `src/reader/wordSnap/classify.ts`
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

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { inlineModules } from './lib/inline-ts.mjs'

/** The snapping implementation, in dependency order: a module may only use
 *  names the modules before it export. */
const MODULES = ['classify.ts', 'snapWordRange.ts']

const WORD_SNAP = new URL('../src/reader/wordSnap/', import.meta.url)

/** The whole snapping implementation as one self-contained fragment, read from
 *  disk on every call. `inline-ts.mjs` carries the rationale — including why
 *  each module keeps its own scope, and why an import it does not understand
 *  throws here rather than inside a webview. */
function snapperSource() {
  return inlineModules(WORD_SNAP, MODULES)
}

/**
 * JSON, escaped down to printable ASCII.
 *
 * The corpus carries a soft hyphen, a word joiner, a zero-width joiner, lone
 * astral characters and a line feed. Emitting those raw into a JS string
 * literal is asking for one of them to be eaten by a transport, a terminal or a
 * copy-paste, and the failure would look like a segmentation divergence rather
 * than like the mangling it is. Escaped, the snippet is pure ASCII and says the
 * same thing everywhere.
 *
 * Applied to each row's COMPACT JSON, never to a pretty-printed document. In
 * pretty-printed output the newlines between fields are structure, not data,
 * and escaping those emits a U+000A escape where the parser needs an actual
 * line break — a snippet that fails at parse. Measured, not hypothetical: it is
 * exactly what the first draft of this function did.
 */
function asAsciiJson(rows) {
  const escape = (text) =>
    text.replace(/[^\x20-\x7E]/g, (character) => {
      return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    })
  if (rows.length === 0) return '[]'
  return '[\n  ' + rows.map((row) => escape(JSON.stringify(row))).join(',\n  ') + ',\n]'
}

/** The report builder, as source. Runs with `ROWS` and `snapWordRange` already
 *  in scope. Written without template literals so it survives being embedded in
 *  one. */
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
  const named = [...offenders]
    .map((code) => 'U+' + code.toString(16).toUpperCase().padStart(4, '0'))
    .join(', ')
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
  return assertTransportable(
    '(function () {\n' +
      "'use strict';\n" +
      'const ROWS = ' +
      asAsciiJson(rows) +
      ';\n' +
      snapperSource() +
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
 * The corpus, imported from `corpus.ts` with nothing but Node's own type
 * stripping — no vite, no bundler, no build step. `corpus.ts` has no value
 * imports, which is what makes that possible, and `corpus.test.ts` enforces it.
 */
export async function loadCorpus() {
  const module = await import(new URL('corpus.ts', WORD_SNAP).href)
  const rows = module.CORPUS
  if (!Array.isArray(rows)) {
    throw new Error('word-snap-parity: corpus.ts did not export a CORPUS array')
  }
  return rows
}

const compact = (value) => JSON.stringify(value)
const boundaries = (segments) => compact(segments.map((s) => [s.text, s.index]))
const flags = (segments) => compact(segments.map((s) => s.wordLike))

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
 * Exported because `word-snap-live.mjs` drives the same comparison over the
 * bridge. A second implementation there would be a second calibration of these
 * three outcomes, and the two would diverge the first time one was tuned.
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
    if (compact(here.actual) !== compact(there.actual)) {
      problems.push(
        `${here.id}: snapped differently\n` +
          `    node    ${compact(here.actual)}\n` +
          `    webview ${compact(there.actual)}\n` +
          `    node    segments ${boundaries(here.segments)}\n` +
          `    webview segments ${boundaries(there.segments ?? [])}`,
      )
      continue
    }
    if (boundaries(here.segments) !== boundaries(there.segments ?? [])) {
      problems.push(
        `${here.id}: segmented differently while snapping the same\n` +
          `    node    ${boundaries(here.segments)}\n` +
          `    webview ${boundaries(there.segments ?? [])}`,
      )
      continue
    }
    if (flags(here.segments) !== flags(there.segments ?? [])) {
      notes.push(
        `${here.id}: isWordLike differs — node ${flags(here.segments)}, ` +
          `webview ${flags(there.segments ?? [])}`,
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

function readReport(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  if (raw.trim() === '') throw new Error('the report is empty')
  return JSON.parse(raw)
}

const USAGE = [
  'usage:',
  '  node scripts/word-snap-parity.mjs                 emit the snippet for webview_execute_js',
  '  node scripts/word-snap-parity.mjs --check         run the snippet in this engine',
  '  node scripts/word-snap-parity.mjs --compare FILE  diff a webview report against this engine',
  '  node scripts/word-snap-parity.mjs --compare -     … reading the report from stdin',
].join('\n')

async function main(argv) {
  const mode = argv[0] ?? '--emit'
  if (mode === '--help' || mode === '-h') {
    process.stderr.write(USAGE + '\n')
    return 0
  }

  const rows = await loadCorpus()
  if (rows.length === 0) {
    process.stderr.write('word-snap-parity: the corpus is empty — nothing to check\n')
    return 1
  }

  if (mode === '--emit') {
    process.stdout.write(buildSnippet(rows))
    process.stderr.write(
      `word-snap-parity: ${rows.length} rows. Paste stdout into webview_execute_js, then feed ` +
        'the report back with --compare -\n',
    )
    return 0
  }

  if (mode === '--check') {
    const report = evaluateSnippet(buildSnippet(rows))
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write(
      report.ok
        ? `word-snap-parity: ${report.total} rows pass in this engine\n`
        : `word-snap-parity: ${String(report.reason)}\n`,
    )
    return report.ok ? 0 : 1
  }

  if (mode === '--compare') {
    const path = argv[1]
    if (path === undefined) {
      process.stderr.write('word-snap-parity: --compare needs a report file, or - for stdin\n')
      return 1
    }
    let live
    try {
      live = readReport(path)
    } catch (cause) {
      /* The bridge-unreachable case. No report is not a pass: it is a run that
       * did not happen, and only the exit code can tell the two apart. */
      process.stderr.write(
        `word-snap-parity: no report to compare (${path}): ${cause.message}\n` +
          '  the webview run produced nothing — the bridge was unreachable, or the snippet threw\n',
      )
      return 1
    }

    const local = evaluateSnippet(buildSnippet(rows))
    const { problems, notes } = compareReports(local, live)

    for (const note of notes) process.stderr.write(`  note: ${note}\n`)
    if (problems.length === 0) {
      process.stderr.write(
        `word-snap-parity: ${local.total} rows agree between this engine and ${String(live.engine)}` +
          (notes.length > 0 ? ` (${notes.length} isWordLike flag differences, not read by us)\n` : '\n'),
      )
      return 0
    }
    const plural = problems.length === 1 ? 'divergence' : 'divergences'
    process.stderr.write(`word-snap-parity: ${problems.length} ${plural}\n`)
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    return 1
  }

  process.stderr.write(`word-snap-parity: unknown option ${mode}\n${USAGE}\n`)
  return 1
}

const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (cause) => {
      process.stderr.write(`word-snap-parity: ${cause?.stack ?? String(cause)}\n`)
      process.exitCode = 1
    },
  )
}
