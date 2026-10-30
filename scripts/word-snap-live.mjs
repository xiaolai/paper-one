/**
 * WI-12's live lane: the word-snapping feature, checked against the WKWebView
 * it actually ships on.
 *
 * Everything from WI-5 to WI-11 is verified in the `unit` lane against
 * hand-built fakes of `Selection`, `Range`, `Document` and the PDF text layer.
 * Those fakes are models of WebKit, and nothing had checked the models. This
 * runner is the pairing partner policy-core rule 6 requires: it connects to the
 * Tauri MCP bridge (127.0.0.1:31415, see `AGENTS.md`), and in the real engine it
 *
 * - runs the WI-4 corpus and diffs it against this engine's, row for row;
 * - proves `setBaseAndExtent` detaches a captured `Range` — the single
 *   behaviour every WI-6 assertion rests on;
 * - proves a backward selection keeps its direction through a snap;
 * - reproduces the block-boundary `toString()` merge AND shows WI-9's
 *   derivation suppressing it, in the same run, so "the fix works" cannot be
 *   confused with "the defect was never there";
 * - segments a soft hyphen and a word joiner, the two invisible characters the
 *   sentinel choice was decided on.
 *
 * ## What this CANNOT do, and no harness can
 *
 * **The bridge cannot produce trusted pointer input.** `webview_interact`
 * dispatches synthetic events with `isTrusted: false`: WebKit does not create a
 * native selection from them and does not fire `selectionchange`. So this
 * runner verifies the ADAPTER against the live DOM — it calls `applySnap` and
 * `rangeText` and inspects the resulting `Selection` — and it verifies WebKit's
 * own semantics. It does not reach a single gesture. Mouse drag, double-click,
 * triple-click, shift+click, long-press, selection-handle drag, force touch and
 * pen have no lane at any level; the manual selection checklist is the
 * only thing that covers them, on real hardware, by hand.
 *
 * THAT CHECKLIST IS NOT IN THIS REPOSITORY. It was `dev-docs/`-local and was
 * purged from the history when the repository was published, so nothing here
 * can check that it exists, is complete, or was ever run. Treat every mention
 * of it below as naming a document kept outside version control.
 *
 * Nothing this file prints may be read as evidence about a gesture.
 *
 * ## Failing closed
 *
 * A run that connects and evaluates nothing looks exactly like a clean sweep in
 * a summary. So the exit code is the contract, and it is non-zero for: an
 * unreachable bridge, an empty corpus, a report with no rows, a check count
 * that does not match the checks defined here, any corpus divergence, and any
 * failed check. Green is not evidence that anything happened — the counters
 * are, and they are asserted rather than printed.
 *
 *   node scripts/word-snap-live.mjs                run everything against the bridge
 *   node scripts/word-snap-live.mjs --list         list the checks; needs no bridge
 *   node scripts/word-snap-live.mjs --emit-dom     print the DOM-check snippet
 *   node scripts/word-snap-live.mjs --port 31415   bridge port
 *   node scripts/word-snap-live.mjs --corpus FILE  corpus rows from a JSON file
 *   node scripts/word-snap-live.mjs --json         print both reports as JSON
 */

import { readFileSync } from 'node:fs'
import { isProcessEntry } from './lib/entry.mjs'
import { inlineModules } from './lib/inline-ts.mjs'
/* The bridge client lives in `lib/bridge.mjs` — this file held the only
   copy until `circle-scenario.sh` needed the same round trip, and two
   implementations of one wire protocol is how they stop matching. */
import { connect, execute, DEFAULT_PORT } from './lib/bridge.mjs'
import {
  assertTransportable,
  buildSnippet,
  compareReports,
  evaluateSnippet,
  loadCorpus,
} from './word-snap-parity.mjs'

/** The selection adapter, in dependency order: a module may only use names the
 *  modules before it export. Read from disk on every run — see
 *  `lib/inline-ts.mjs` for why a transcription would be worse than nothing. */
const MODULES = [
  'classify.ts',
  'snapWordRange.ts',
  'flatten.ts',
  'rangeText.ts',
  'applySnap.ts',
]

const WORD_SNAP = new URL('../src/kernel/ui/reader/wordSnap/', import.meta.url)

/**
 * The programmatic checks, and what each one is FOR.
 *
 * Exported so the unit lane can assert the snippet declares exactly these —
 * the counters only prove a run happened if the two lists agree.
 */
export const CHECKS = [
  {
    id: 'range-detach',
    title: 'setBaseAndExtent detaches a captured Range',
    why:
      'The single WebKit behaviour every WI-6 assertion rests on. If this ever disagrees ' +
      'with selectionFake.testkit.ts, every Level 4 assertion in applySnap.test.ts becomes ' +
      'suspect at once — which makes this the highest-value check in the lane.',
  },
  {
    id: 'backward-direction',
    title: 'a backward selection keeps its direction through a snap',
    why:
      'Verifies the ADAPTER against a real backward Selection. It does NOT cover a backward ' +
      'DRAG, which needs trusted pointer input and stays on the manual checklist.',
  },
  {
    id: 'block-merge',
    title: 'toString() welds two blocks together, and rangeText does not',
    why:
      'The defect and the fix asserted in one run, so a green result cannot mean the defect ' +
      'was simply never there in this engine.',
  },
  {
    id: 'br-merge',
    title: 'toString() welds across a <br>, and rangeText does not',
    why: 'The same defect through the other sentinel source. Both must reproduce, and both must be fixed.',
  },
  {
    id: 'soft-hyphen',
    title: 'a soft hyphen does not break a word',
    why:
      'UAX #29 WB4 ignores U+00AD, and WebKit double-click agrees. This is where that ' +
      'decision gets re-checked on evidence rather than on memory when ICU moves with the OS.',
  },
  {
    id: 'word-joiner',
    title: 'a word joiner does not break a word',
    why: 'Why U+2060 is not a usable sentinel: it does not split a word, so it cannot mark a boundary.',
  },
]

/**
 * The fixture, the checks, and the report — as source.
 *
 * Runs with `CHECK_IDS`, `applySnap` and `rangeText` already in scope. Written
 * without template literals and without any of `await `, `async `, `.then(`
 * or the Promise constructor, for two separate reasons:
 *
 * - it is embedded in a template literal here, and
 * - the bridge falls back from WKWebView's native `evaluateJavaScript` to an
 *   eval-plus-IPC round trip the instant it sees one of those tokens ANYWHERE
 *   in the script, comments included. The fallback has a five-second timeout
 *   and needs `__TAURI__` in the page, so a stray token in a doc comment turns
 *   a working check into an intermittent one for reasons nothing reports.
 *
 * ## Why a fresh iframe rather than the app's own document
 *
 * Three reasons, all of them about the answer being trustworthy: a pristine
 * `<html>` for `walkRoot` to reach, a fixture that does not depend on which
 * book happens to be open, and the reader's own selection left untouched. The
 * frame is rendered but off-screen, never `display: none` — the flattener
 * excludes hidden subtrees by design, so a hidden fixture would flatten to
 * nothing and every check would pass against an empty window.
 */
const DOM_DRIVER = `
var LF = String.fromCharCode(10);
var SOFT_HYPHEN = String.fromCharCode(0x00ad);
var WORD_JOINER = String.fromCharCode(0x2060);

var FIXTURE =
  '<p id="pa">all done</p>' +
  '<p id="pb">Start here</p>' +
  '<p id="pbr">one<br>two</p>' +
  '<p id="pfox">the quick brown fox</p>';

var report = {
  ok: false,
  engine:
    typeof navigator === 'object' && navigator !== null && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : 'no navigator — not a browser engine',
  expected: CHECK_IDS.length,
  ran: 0,
  failures: 0,
  reason: null,
  checks: [],
};

/* Fail closed, and say which precondition was missing. A run that reports
 * 'ok' having evaluated nothing is the defect this whole file exists to make
 * impossible. */
if (typeof document === 'undefined' || document === null || !document.body) {
  report.reason =
    'this engine has no document — the DOM checks need a live WebKit document, ' +
    'and a run without one is a run that did not happen';
  return report;
}
if (typeof Intl !== 'object' || typeof Intl.Segmenter !== 'function') {
  report.reason = 'this engine has no Intl.Segmenter, so nothing was segmented';
  return report;
}

var frame = document.createElement('iframe');
frame.setAttribute('title', 'word-snap live checks');
frame.setAttribute('aria-hidden', 'true');
frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:640px;height:480px;border:0;';
document.body.appendChild(frame);

var doc = frame.contentDocument;
var win = frame.contentWindow;
if (!doc || !win || !doc.body) {
  frame.remove();
  report.reason = 'the fixture iframe never produced a document to run against';
  return report;
}
/* ⚠️ **THE CLEANUP BEGINS HERE, AND IT USED TO BEGIN AFTER THE FIXTURE.**
 * (No backticks in this comment: it lives inside a template literal.)
 * Everything below — the markup assignment, the selection, the checks table —
 * ran outside the cleanup, so a throw from any of it left an off-screen
 * iframe attached with a selection inside it. The next run inherits both, and
 * a selection nobody set is the one thing these checks cannot survive.
 * Reproduced by making the markup assignment throw. */
try {
  doc.body.innerHTML = FIXTURE;

  var sel = win.getSelection();
  var textOf = function (id) {
    var el = doc.getElementById(id);
    return el ? el.firstChild : null;
  };
  var segmentsOf = function (text) {
    var out = [];
    var parts = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text);
    for (var part of parts) out.push({ text: part.segment, index: part.index, wordLike: !!part.isWordLike });
    return out;
  };
  var quote = function (value) { return JSON.stringify(value); };

  /*
   * The two shapes of check this file makes, each written once.
   *
   * Both pairs below repeated their whole body — the selection, the two
   * readings, the comparison and the formatting — differing only in which nodes
   * they select and what they expect. Two copies of a formatting line is two
   * places a detail string can stop matching what it reports.
   */
  var mergesAcross = function (nodes, raw, derived) {
    return function () {
      var ends = nodes();
      sel.removeAllRanges();
      sel.setBaseAndExtent(ends[0], ends[1], ends[2], ends[3]);
      var range = sel.getRangeAt(0);
      var was = range.toString();
      var is = rangeText(range);
      return {
        pass: was === raw && is === derived,
        detail: 'toString()=' + quote(was) + ' rangeText()=' + quote(is),
      };
    };
  };

  var oneWord = function (word) {
    return function () {
      var parts = segmentsOf(word);
      return {
        pass: parts.length === 1 && parts[0].text === word && parts[0].index === 0,
        detail: 'segments=' + quote(parts.map(function (p) { return [p.text, p.index, p.wordLike]; })),
      };
    };
  };

  var CHECKS = {
    'range-detach': function () {
      var a = textOf('pa');
      var b = textOf('pb');
      sel.removeAllRanges();
      sel.setBaseAndExtent(a, 0, a, 8);

      var captured = sel.getRangeAt(0);
      var identicalBefore = captured === sel.getRangeAt(0);
      var textBefore = captured.toString();

      sel.setBaseAndExtent(b, 0, b, 5);
      var identicalAfter = captured === sel.getRangeAt(0);
      var textAfter = captured.toString();
      var liveText = sel.getRangeAt(0).toString();

      return {
        pass:
          identicalBefore === true &&
          identicalAfter === false &&
          textBefore === 'all done' &&
          textAfter === 'all done' &&
          liveText === 'Start',
        detail:
          'identical to getRangeAt(0) before=' + identicalBefore + ' after=' + identicalAfter +
          ', captured text before=' + quote(textBefore) + ' after=' + quote(textAfter) +
          ', live now=' + quote(liveText),
      };
    },

    'backward-direction': function () {
      var fox = textOf('pfox');
      /* Programmatic, and that is the whole limit of this check: anchor after
       * focus is what a backward DRAG produces, but no harness can drag. */
      sel.removeAllRanges();
      sel.setBaseAndExtent(fox, 13, fox, 5);
      var before = sel.toString();

      var result = applySnap(sel);

      /* ⚠️ **THIS EXPECTED NINE CHARACTERS OF AN EIGHT-CHARACTER SELECTION**
       * until 2026-09-14, so the check could not pass on any engine — and being
       * manual-gated, nobody had run it to find out. In "the quick brown fox"
       * offsets 5 to 13 are "uick bro"; "uick brow" is 5 to 14. Everything else
       * here answered exactly as written, the backward anchor and focus
       * included, the first time it ran in WebKit.
       * (No backticks in this comment: it is inside the injected snippet's own
       * template literal, and one closes it.) */
      return {
        pass:
          before === 'uick bro' &&
          result.snapped === true &&
          sel.toString() === 'quick brown' &&
          sel.anchorNode === fox &&
          sel.focusNode === fox &&
          sel.anchorOffset === 15 &&
          sel.focusOffset === 4,
        detail:
          'before=' + quote(before) + ' after=' + quote(sel.toString()) +
          ', snapped=' + result.snapped +
          ', anchor=' + sel.anchorOffset + ' focus=' + sel.focusOffset +
          ' (backward means anchor > focus)',
      };
    },

    'block-merge': mergesAcross(function () { return [textOf('pa'), 0, textOf('pb'), 10]; }, 'all doneStart here', 'all done' + LF + 'Start here'),

    'br-merge': mergesAcross(function () {
      var line = doc.getElementById('pbr');
      return [line.firstChild, 0, line.lastChild, 3];
    }, 'onetwo', 'one' + LF + 'two'),

    /* Asserted on BOUNDARIES, not on isWordLike. The flag is the divergence
     * this repository already measured and deliberately never reads; failing
     * on it would make this lane red on a healthy app. */
    'soft-hyphen': oneWord('hyphen' + SOFT_HYPHEN + 'ation'),

    'word-joiner': oneWord('done' + WORD_JOINER + 'Start'),
  };

  for (var i = 0; i < CHECK_IDS.length; i += 1) {
    var id = CHECK_IDS[i];
    var outcome;
    if (typeof CHECKS[id] !== 'function') {
      outcome = { pass: false, detail: 'this snippet defines no check with that id' };
    } else {
      try {
        outcome = CHECKS[id]();
      } catch (thrown) {
        outcome = { pass: false, detail: 'threw: ' + String((thrown && thrown.message) || thrown) };
      }
    }
    report.ran += 1;
    if (!outcome.pass) report.failures += 1;
    report.checks.push({ id: id, pass: !!outcome.pass, detail: String(outcome.detail) });
  }
} finally {
  /* The selection is cleared and the frame goes, whatever happened. Leaving an
   * off-screen iframe behind would leave a selection in it, and the next run
   * would inherit both. */
  try { sel.removeAllRanges(); } catch (ignored) { void ignored; }
  frame.remove();
}

report.ok = report.failures === 0 && report.ran === report.expected;
report.reason = report.ok
  ? null
  : report.failures + ' of ' + report.ran + ' checks failed';
return report;
`

/** The DOM checks as a self-contained snippet: the app's own adapter, read
 *  from disk, plus the driver above. */
export function buildDomSnippet() {
  /* The `;` travels inside the statement it ends, as it does in
   * `word-snap-parity.mjs`. As a literal of its own, deleting it changed
   * nothing any run could see: the inlined source opens on a comment line, so
   * automatic semicolon insertion put it back. */
  return assertTransportable(
    '(function () {\n' +
      "'use strict';\n" +
      `var CHECK_IDS = ${JSON.stringify(CHECKS.map((check) => check.id))};\n` +
      inlineModules(WORD_SNAP, MODULES) +
      DOM_DRIVER +
      '})()\n',
  )
}

/* ------------------------------------------------------------------------ */
/* The run                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Everything that must be true for the exit code to be zero, checked against
 * the reports' own counters rather than against the absence of complaints.
 *
 * A run that connects, evaluates nothing and answers `{}` satisfies every
 * "no problems found" test there is. These are the assertions that do not.
 *
 * Exported because what the runner CONCLUDES from a report is pure, and a bug
 * here would turn a hollow run green — so the unit lane holds it to every
 * shape a page could answer, one call per shape. `main` reaches it too, over a
 * fake socket, but a whole run per shape is the slow way to ask.
 */
export function assertRan(parity, dom, expectedRows) {
  const problems = []

  if (parity === null || typeof parity !== 'object' || !Array.isArray(parity.rows)) {
    problems.push('the corpus report is not a report this harness produced')
  } else if (parity.rows.length === 0) {
    problems.push('the corpus report holds zero rows — an empty run is a failure, not a clean sweep')
  } else if (parity.rows.length !== expectedRows) {
    problems.push(
      'the corpus report holds ' + parity.rows.length + ' rows against ' + expectedRows + ' sent',
    )
  }

  if (dom === null || typeof dom !== 'object' || !Array.isArray(dom.checks)) {
    problems.push('the DOM report is not a report this harness produced')
    return problems
  }
  if (dom.ran !== CHECKS.length || dom.expected !== CHECKS.length) {
    problems.push(
      'the DOM report ran ' + dom.ran + ' of a declared ' + dom.expected + ' checks, against ' +
        CHECKS.length + ' defined here' + (dom.reason ? ' — ' + String(dom.reason) : ''),
    )
  }
  /* ⚠️ **THE COUNTERS WERE TRUSTED AND THE ENTRIES WERE NOT RECONCILED WITH
     THEM.** `dom.ran` and `dom.expected` are numbers the page reports about
     itself, so a report with `checks: []` and the right counters passed
     everything below; so did six entries all carrying ONE id; so did
     `ok: false, failures: 2`, because nothing read either field. Every one of
     those is a run that proved nothing and said it was clean — which is the
     exact failure this whole file exists to prevent, in the file that exists
     to prevent it.

     The ENTRIES are the evidence. The counters are a claim about them. */
  const seen = new Set()
  for (const check of dom.checks) {
    if (check === null || typeof check !== 'object' || typeof check.id !== 'string') {
      problems.push('the DOM report holds an entry that is not a check')
      continue
    }
    if (seen.has(check.id)) problems.push(check.id + ': reported more than once')
    seen.add(check.id)
    if (check.pass !== true) problems.push(check.id + ': ' + String(check.detail))
  }
  for (const declared of CHECKS) {
    if (!seen.has(declared.id)) problems.push(declared.id + ': declared here and absent from the report')
  }
  if (dom.checks.length !== dom.ran) {
    problems.push('the DOM report claims ' + dom.ran + ' checks ran and carries ' + dom.checks.length)
  }
  /* An explicit failure status is believed even when every entry passed: the
     page knows something the entries do not carry.

     ⚠️ **A FAILURE COUNT THAT WAS NOT A NUMBER WAS NOT READ AT ALL** until
     2026-09-15. A `typeof … === 'number'` guard stood in front of the
     comparison, and the only values it ever turned away were ones that compare
     as a positive count — so `failures: "2"` over entries that all passed was
     a clean report. Absent and `null` compare as no failures without it. */
  if (dom.ok === false || dom.failures > 0) {
    problems.push('the DOM report declares itself failed (ok: ' + String(dom.ok) + ', failures: ' + String(dom.failures) + ')')
  }
  if (typeof dom.engine !== 'string' || dom.engine === '' || /no navigator/.test(dom.engine)) {
    problems.push('the DOM report carries no engine string — it did not run in a browser engine')
  }

  return problems
}

function readCorpusFile(path) {
  // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — so both parse the same rows and no test can tell them apart
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) {
    throw new Error('the corpus file must hold an array of rows, not ' + typeof rows)
  }
  return rows
}

const USAGE = [
  'usage:',
  '  node scripts/word-snap-live.mjs                 run every check against the bridge',
  '  node scripts/word-snap-live.mjs --list          list the checks; needs no bridge',
  '  node scripts/word-snap-live.mjs --emit-dom      print the DOM-check snippet',
  '  node scripts/word-snap-live.mjs --port N        bridge port (default ' + DEFAULT_PORT + ')',
  '  node scripts/word-snap-live.mjs --corpus FILE   corpus rows from a JSON file',
  '  node scripts/word-snap-live.mjs --json          print both reports as JSON',
  '',
  'The app must be running (pnpm tauri dev, a DEBUG build — the bridge is not in release).',
  'No gesture is reachable from here: see the manual selection checklist,',
  'which is kept outside this repository.',
].join('\n')

/** Every option this runner reads: the ones that stand alone, and the ones that take a value. */
const SWITCHES = ['--help', '-h', '--list', '--emit-dom', '--json']
const VALUED = ['--corpus', '--port']

/**
 * The whole command line, read before anything runs, so a mistyped invocation
 * cannot quietly produce a report about something nobody asked for. Answers
 * each option given, with its value; a standalone option's is `undefined`.
 *
 * ⚠️ **A TRAILING FLAG IS A MISTAKE, NOT A DEFAULT.** `--port` with nothing
 * after it returned `null`, which every caller read as "not given" — so a
 * mistyped invocation connected to the default port and ran, reporting on
 * something the operator did not ask for. An option named without a value is
 * refused by name.
 *
 * ⚠️ **AND AN UNKNOWN FLAG WAS IGNORED ENTIRELY**, so `--prot 9223` ran the
 * whole suite against the default port and said nothing. A runner that
 * silently does something other than what it was asked is worse than one that
 * refuses.
 *
 * ⚠️ **AND THE REFUSAL THAT FIXED IT HAD HOLES OF ITS OWN** until 2026-09-15. Its
 * list of known flags never named `--json`, so every run the usage offers JSON
 * for was refused as a typo. It looked only at `--` flags, so a bare `9223`
 * was ignored exactly as `--prot 9223` had been. And it ran after `--help`,
 * `--list` and `--emit-dom` had already returned, and read only the first of a
 * repeated option. Every argument is accounted for here, once.
 */
function argumentsOf(argv) {
  const given = new Map()
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (given.has(arg)) throw new Error(arg + ' was given more than once')
    if (SWITCHES.includes(arg)) {
      given.set(arg, undefined)
    } else if (VALUED.includes(arg)) {
      const value = argv[at + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(arg + ' needs a value')
      given.set(arg, value)
      at += 1
    } else {
      throw new Error('unknown option: ' + arg + ' (known: ' + [...SWITCHES, ...VALUED].join(', ') + ')')
    }
  }
  return given
}

/**
 * The script, with everything it reaches handed in — the same seam as
 * `word-snap-parity.mjs`'s `main`.
 *
 * The defaults are the process: its two streams, the corpus on disk and the
 * bridge's own `connect`. A test hands in writers that capture, rows of its
 * own and a `dial` that answers with a fake socket, so nothing is dialled.
 * ⚠️ **THIS SCRIPT WAS TESTED ONLY BY SPAWNING IT**, which exercises a CLI
 * faithfully and measures none of it: 169 of its mutants had no test reach
 * them — every option, every exit and the whole bridge path.
 *
 * Nothing leaves as a rejection. A crash is a run that did not happen, so it
 * exits non-zero with its stack like every other failure here.
 */
export async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr, corpus = loadCorpus, dial = connect } = {},
) {
  try {
    return await run(argv, { stdout, stderr, corpus, dial })
  } catch (cause) {
    stderr.write('word-snap-live: ' + (cause?.stack ?? String(cause)) + '\n')
    return 1
  }
}

async function run(argv, io) {
  let args
  try {
    args = argumentsOf(argv)
  } catch (cause) {
    io.stderr.write(String(cause.message) + '\n' + USAGE + '\n')
    return 2
  }

  if (args.has('--help') || args.has('-h')) {
    io.stderr.write(USAGE + '\n')
    return 0
  }

  if (args.has('--list')) {
    for (const check of CHECKS) {
      io.stdout.write(check.id + '  —  ' + check.title + '\n    ' + check.why + '\n\n')
    }
    io.stdout.write(
      CHECKS.length + ' programmatic checks, plus the ' +
        'WI-4 corpus, run against the live WKWebView.\n' +
        'No gesture is among them, and none can be: see the manual selection\n' +
        'checklist, kept outside this repository.\n',
    )
    return 0
  }

  if (args.has('--emit-dom')) {
    io.stdout.write(buildDomSnippet())
    return 0
  }

  const corpusPath = args.get('--corpus')
  let rows
  try {
    rows = corpusPath === undefined ? await io.corpus() : readCorpusFile(corpusPath)
  } catch (cause) {
    io.stderr.write('word-snap-live: the corpus could not be read: ' + cause.message + '\n')
    return 1
  }
  /* Before the bridge is dialled, so the reason names the corpus rather than
   * the connection. Zero rows is a failure: under `ok = failures === 0` an
   * empty corpus scores a perfect pass. */
  if (rows.length === 0) {
    io.stderr.write(
      'word-snap-live: the corpus is empty — zero rows to check is a failure, not a clean sweep\n',
    )
    return 1
  }

  const portRaw = args.get('--port')
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    io.stderr.write('word-snap-live: --port needs a port number, got ' + String(portRaw) + '\n')
    return 1
  }

  const paritySnippet = buildSnippet(rows)
  const domSnippet = buildDomSnippet()

  let socket
  try {
    socket = await io.dial(port)
  } catch (cause) {
    /* The bridge-unreachable case, and the reason this runner has an exit code
     * at all. No report is not a pass: it is a run that did not happen, and in
     * a summary the two look identical. */
    io.stderr.write(
      'word-snap-live: the MCP bridge at 127.0.0.1:' + port + ' is unreachable — ' +
        cause.message + '\n' +
        '  nothing was checked. Start the app with `pnpm tauri dev` (a debug build; the\n' +
        '  bridge is compiled out of release) and run this again.\n',
    )
    return 1
  }

  let parityLive
  let domLive
  try {
    parityLive = await execute(socket, paritySnippet, 'the corpus run')
    domLive = await execute(socket, domSnippet, 'the DOM checks')
  } catch (cause) {
    io.stderr.write('word-snap-live: ' + cause.message + '\n  nothing can be concluded from this run.\n')
    socket.close()
    return 1
  }
  socket.close()

  const parityLocal = evaluateSnippet(paritySnippet)
  const { problems, notes } = compareReports(parityLocal, parityLive)
  const ranProblems = assertRan(parityLive, domLive, rows.length)

  if (args.has('--json')) {
    io.stdout.write(JSON.stringify({ corpus: parityLive, dom: domLive }, null, 2) + '\n')
  }

  for (const note of notes) io.stderr.write('  note: ' + note + '\n')
  for (const check of domLive?.checks ?? []) {
    io.stderr.write('  ' + (check.pass ? 'ok  ' : 'FAIL') + '  ' + check.id + ': ' + check.detail + '\n')
  }

  const all = [...problems, ...ranProblems]
  if (all.length === 0) {
    io.stderr.write(
      'word-snap-live: ' + parityLive.rows.length + ' corpus rows agree with this engine and ' +
        domLive.ran + ' checks pass in ' + domLive.engine + '\n' +
        '  NOT covered, by anything, at any level: every gesture. See the\n' +
        '  manual selection checklist, kept outside this repository.\n',
    )
    return 0
  }

  io.stderr.write('word-snap-live: ' + all.length + (all.length === 1 ? ' problem\n' : ' problems\n'))
  for (const problem of all) io.stderr.write('  ' + problem + '\n')
  return 1
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `main`, which is measured in-process
if (isProcessEntry(import.meta)) process.exitCode = await main(process.argv.slice(2))
