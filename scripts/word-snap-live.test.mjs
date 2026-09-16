import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script, createContext, runInContext } from 'node:vm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CORPUS } from '../src/kernel/ui/reader/wordSnap/corpus.ts'
import { buildSnippet, compareReports, evaluateSnippet } from './word-snap-parity.mjs'
import { CHECKS, assertRan, buildDomSnippet, main } from './word-snap-live.mjs'

/**
 * The guards on WI-12's live lane — and they live HERE, in the lane that
 * always runs, on purpose.
 *
 * EXCEPT THAT ONE SUITE BELOW DOES NOT ALWAYS RUN, and the sentence above was
 * read as though it did. `describe.skipIf(noConfig)` gates the first suite on
 * `.claude/tdd-guardian/config.json`, which `.gitignore` excludes — so those
 * three cases collect on a developer's machine and are skipped on every clean
 * checkout. Written into `tests/ledger.json` by a `--write` run on a machine
 * that had the file, they then read as GONE to CI, to a fresh clone, and to
 * `verify:without`'s temp copy. That is what turned `main` red on 2026-08-21,
 * eight steps into `pnpm verify`, with no code change behind it.
 *
 * **The ledger is now written as a CLEAN CHECKOUT sees it**, so those three
 * are absent from it. A machine that has the config collects three more than
 * the ledger records, and additions are free and silent by design — so it is
 * green in both places, and a genuine deletion is still caught in both.
 *
 * The rule that generalises, and it is not only about this file: **anything
 * conditional on an untracked path must not reach the ledger.** If these
 * guards should genuinely always run, the fix is to stop gating them on a file
 * the repository does not contain — not to re-record them.
 *
 * The live lane needs a running app, a WebKit bridge and a human. A guard
 * against a silently empty live run is worthless if it only runs in the lane
 * being guarded: that is the same class of defect as `actool` and
 * `screencapture` exiting 0 having written nothing, which this repository has
 * been bitten by twice (`AGENTS.md`).
 *
 * So the cases below check two things the unit lane genuinely can check:
 *
 * 1. **the lane is configured as specified** — `gateOn: ["manual"]`,
 *    `coverage: "none"`, and a probe that runs without the app;
 * 2. **the runner fails closed** — an unreachable bridge and a zero-row corpus
 *    both exit non-zero, and the snippet reports failure rather than success in
 *    an engine with no DOM.
 *
 * ⚠️ **THE SCRIPT IS CALLED, NOT SPAWNED — EXCEPT TO PROVE THE ENTRY POINT.**
 * Every case about the command line used to run it as a child process, which
 * measured none of it: 169 of the script's mutants had no test reach them —
 * every option, every exit, the whole bridge path — and the `--json` its usage
 * offers had been refused as an unknown option all along. `main` takes its
 * streams, its corpus and the bridge's `connect` as arguments now, the way
 * `word-snap-parity.mjs`'s does, and a fake socket answers in place of the
 * bridge. Nothing here dials one.
 *
 * **Nothing here verifies a gesture, and nothing here claims a live run
 * happened.** The Tauri MCP bridge dispatches `isTrusted: false` events, which
 * produce no native selection and no `selectionchange`; no harness at any level
 * reaches a drag, a double-click, a long-press or a pen.
 *
 * **The manual gesture record is no longer in this repository.** It was
 * The manual selection checklist, and seven cases here asserted it
 * named every unautomatable gesture, pinned its environment with no
 * placeholders, and declared an honest run status. It was removed from the
 * history deliberately; those seven assertions went with it, and this file no
 * longer has any way to tell whether the manual lane is documented at all.
 * That cover is gone rather than relocated — if it is wanted back, the
 * checklist has to return to a tracked path first.
 */

const ROOT = new URL('../', import.meta.url)
const SCRIPT = fileURLToPath(new URL('./word-snap-live.mjs', import.meta.url))
const CONFIG = fileURLToPath(new URL('.claude/tdd-guardian/config.json', ROOT))

/** The script, as a user would run it. `status`, not a throw: every exit-code
 *  case below is one where a non-zero exit is the point. */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** A directory of the case's own, removed when the case finishes — however it
 *  finishes, a failed assertion or a skip included. Every call used to leave
 *  one behind in the system temp directory, on every run. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'word-snap-live-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tempFile(name, contents) {
  const path = join(tempDir(), name)
  writeFileSync(path, contents, 'utf8')
  return path
}

/** A port nothing is listening on, found by binding one and letting it go.
 *  Racy in principle, immediate in practice — and a port that DID answer would
 *  fail the assertion loudly rather than pass it. */
function closedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Spelled out, not imported: the words are the behaviour under test. */
const USAGE = [
  'usage:',
  '  node scripts/word-snap-live.mjs                 run every check against the bridge',
  '  node scripts/word-snap-live.mjs --list          list the checks; needs no bridge',
  '  node scripts/word-snap-live.mjs --emit-dom      print the DOM-check snippet',
  '  node scripts/word-snap-live.mjs --port N        bridge port (default 31415)',
  '  node scripts/word-snap-live.mjs --corpus FILE   corpus rows from a JSON file',
  '  node scripts/word-snap-live.mjs --json          print both reports as JSON',
  '',
  'The app must be running (pnpm tauri dev, a DEBUG build — the bridge is not in release).',
  'No gesture is reachable from here: see the manual selection checklist,',
  'which is kept outside this repository.',
].join('\n')

/** What `--list` prints — the lane's probe, and the only place a check says what it is FOR. */
const LISTING =
  'range-detach  —  setBaseAndExtent detaches a captured Range\n' +
  '    The single WebKit behaviour every WI-6 assertion rests on. If this ever disagrees with ' +
  'selectionFake.testkit.ts, every Level 4 assertion in applySnap.test.ts becomes suspect at once — ' +
  'which makes this the highest-value check in the lane.\n\n' +
  'backward-direction  —  a backward selection keeps its direction through a snap\n' +
  '    Verifies the ADAPTER against a real backward Selection. It does NOT cover a backward DRAG, ' +
  'which needs trusted pointer input and stays on the manual checklist.\n\n' +
  'block-merge  —  toString() welds two blocks together, and rangeText does not\n' +
  '    The defect and the fix asserted in one run, so a green result cannot mean the defect was ' +
  'simply never there in this engine.\n\n' +
  'br-merge  —  toString() welds across a <br>, and rangeText does not\n' +
  '    The same defect through the other sentinel source. Both must reproduce, and both must be fixed.\n\n' +
  'soft-hyphen  —  a soft hyphen does not break a word\n' +
  '    UAX #29 WB4 ignores U+00AD, and WebKit double-click agrees. This is where that decision gets ' +
  're-checked on evidence rather than on memory when ICU moves with the OS.\n\n' +
  'word-joiner  —  a word joiner does not break a word\n' +
  '    Why U+2060 is not a usable sentinel: it does not split a word, so it cannot mark a boundary.\n\n' +
  '6 programmatic checks, plus the WI-4 corpus, run against the live WKWebView.\n' +
  'No gesture is among them, and none can be: see the manual selection\n' +
  'checklist, kept outside this repository.\n'

const UNREACHABLE_ADVICE =
  '  nothing was checked. Start the app with `pnpm tauri dev` (a debug build; the\n' +
  '  bridge is compiled out of release) and run this again.\n'

const GESTURES_NOT_COVERED =
  '  NOT covered, by anything, at any level: every gesture. See the\n' +
  '  manual selection checklist, kept outside this repository.\n'

/** What a webview report calls its engine. Anything naming a browser will do;
 *  Node's own name is refused by both comparisons. */
const WEBKIT = 'WebKit under test'

/** Two corpus rows: enough to be a corpus, few enough to evaluate quickly. */
const ROWS = CORPUS.slice(0, 2)

/** A DOM report as a page that ran every check and passed them all writes it. */
const PASSING_DOM = {
  ok: true,
  engine: WEBKIT,
  expected: CHECKS.length,
  ran: CHECKS.length,
  failures: 0,
  reason: null,
  checks: CHECKS.map((check) => ({ id: check.id, pass: true, detail: 'as expected' })),
}

/** The bridge's reply to one `execute_js`, as `lib/bridge.mjs` reads it. */
const answering = (data) => () => ({ success: true, data })

/** The corpus snippet, run in this engine and relabelled as a webview's. */
const corpusInWebview = (script) => ({ success: true, data: { ...evaluateSnippet(script), engine: WEBKIT } })

/** A jsdom window running `snippet`, answering what it returns. jsdom is not
 *  WebKit: a pass here says nothing about WebKit, only about the assembly. */
async function inJsdom(snippet) {
  const { JSDOM } = await import('jsdom')
  return new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window.eval(snippet)
}

/**
 * A stand-in for the bridge's WebSocket, with nothing behind it.
 *
 * Each `execute_js` it is sent is answered by the next of `replies`, given the
 * script, and the answer travels as JSON text the way the plugin's does — so
 * the real `execute` in `lib/bridge.mjs` runs against it unchanged, id
 * matching included. It records what it was sent and how often it was closed.
 */
function fakeBridge(...replies) {
  const socket = new EventTarget()
  socket.readyState = 1
  socket.scripts = []
  socket.closes = 0
  socket.close = () => {
    socket.closes += 1
  }
  socket.send = (text) => {
    const { id, args } = JSON.parse(text)
    socket.scripts.push(args.script)
    const reply = replies[socket.scripts.length - 1](args.script)
    setImmediate(async () => {
      const settled = { id, ...reply, data: await reply.data }
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(settled) }))
    })
  }
  return socket
}

/**
 * The script, called the way its entry point calls it, with everything it says
 * captured. `dial` answers with `socket`, or rejects with `refuse` — and records
 * every port it was asked for, so a case that must not reach the bridge can
 * say it did not. `corpusReads` counts calls to the default corpus.
 */
async function cli(args, { rows = ROWS, corpus, socket, refuse, stdout } = {}) {
  const out = []
  const err = []
  const dialled = []
  let corpusReads = 0
  const code = await main(args, {
    stdout: stdout ?? { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    corpus:
      corpus ??
      (async () => {
        corpusReads += 1
        return rows
      }),
    dial: async (port) => {
      dialled.push(port)
      if (refuse !== undefined) throw refuse
      return socket
    },
  })
  return { code, out: out.join(''), err: err.join(''), dialled, corpusReads }
}

/**
 * The workspace's tdd-guardian config, when this checkout has one.
 *
 * `.gitignore` puts the whole of `.claude/` outside version control — this
 * repository runs cc-suite in PRIVATE mode — so a fresh clone genuinely has no
 * config to assert against, and a test that read it unconditionally would be
 * red for everyone but the machine that ran `/tdd-guardian:init`.
 *
 * Absent, the three lane cases below are **skipped and say so in their names**,
 * never quietly passed.
 */
const config = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : null
const noConfig = config === null

describe.skipIf(noConfig)('the live lane (skipped when this checkout has no .claude/tdd-guardian/config.json)', () => {
  /*
   * `gateOn: ["manual"]` is the whole point: the lane needs `pnpm tauri dev`
   * running and a human at the machine. On `taskCompleted` it would stall every
   * task on a bridge that is usually not there; on `commit` it would block
   * every commit made without the app up.
   */
  it('exists, is manual-only, and carries a probe that runs without the app', () => {
    const live = config.lanes.find((lane) => lane.name === 'live')

    expect(live).toBeDefined()
    expect(live.gateOn).toEqual(['manual'])
    expect(live.coverage).toBe('none')
    expect(live.command.trim()).not.toBe('')
    expect(live.probeCommand.trim()).not.toBe('')
  })

  /*
   * `coverage: "include"` on a lane with no instrumentation is the e2e
   * anti-pattern lane-policy names: the report is missing or empty, and an
   * empty report scores 100%, so adding this lane would RAISE the merged total
   * while measuring nothing.
   */
  it('does not claim to contribute coverage', () => {
    for (const lane of config.lanes) {
      if (lane.coverage === 'include') {
        expect(lane.coverageSummaryPath ?? '').not.toBe('')
      }
    }
    expect(config.lanes.find((lane) => lane.name === 'live').coverage).toBe('none')
  })

  /* The fast inner loop must stay where it was. A live lane that quietly took
   * over `taskCompleted` would be a far bigger change than adding a lane. */
  it('leaves the unit lane gating taskCompleted and commit', () => {
    const unit = config.lanes.find((lane) => lane.name === 'unit')

    expect(unit).toBeDefined()
    expect(unit.gateOn).toEqual(['taskCompleted', 'commit'])
  })

})

describe('assertRan — the reports it used to accept', () => {
  /* ⚠️ **EACH OF THESE PASSED, AND EACH IS A RUN THAT PROVED NOTHING.** The
     counters `ran` and `expected` are numbers the PAGE reports about itself,
     and nothing reconciled them with the entries — so an empty report with the
     right numbers was clean, six entries under one id were clean, and a report
     that declared itself failed was clean. In the file whose entire job is to
     refuse a hollow run. */
  const good = () => ({
    engine: 'WebKit',
    ran: CHECKS.length,
    expected: CHECKS.length,
    ok: true,
    failures: 0,
    checks: CHECKS.map((one) => ({ id: one.id, pass: true, detail: '' })),
  })
  const parity = (rows) => ({ rows: Array.from({ length: rows }, (_, i) => ({ id: i, same: true })) })

  it('accepts a report that is complete and consistent', () => {
    expect(assertRan(parity(3), good(), 3)).toEqual([])
  })

  it('refuses an EMPTY check list wearing the right counters', () => {
    expect(assertRan(parity(3), { ...good(), checks: [] }, 3).join(' ')).toMatch(/carries 0|absent from the report/u)
  })

  it('refuses the same check reported more than once', () => {
    const one = CHECKS[0]
    const dom = { ...good(), checks: CHECKS.map(() => ({ id: one.id, pass: true, detail: '' })) }
    expect(assertRan(parity(3), dom, 3).join(' ')).toMatch(/reported more than once/u)
  })

  it('refuses a report that declares itself failed even when every entry passed', () => {
    expect(assertRan(parity(3), { ...good(), ok: false, failures: 2 }, 3).join(' ')).toMatch(/declares itself failed/u)
  })

  it('refuses an entry that is not a check at all', () => {
    expect(assertRan(parity(3), { ...good(), checks: [null, ...good().checks.slice(1)] }, 3).join(' ')).toMatch(/not a check/u)
  })
})

describe('word-snap-live — failing closed', () => {
  /* The lane's probe. It must work with no bridge, no app and no book —
   * otherwise the probe reports the lane broken on every machine where the app
   * is not up, which is most of them. Outside the config-dependent block on
   * purpose: this one runs everywhere. */
  it('probes green with no bridge, naming every check it would run', () => {
    const { code, out } = run(['--list'])

    expect(code).toBe(0)
    for (const check of CHECKS) expect(out).toContain(check.id)
    expect(CHECKS.length).toBeGreaterThan(0)
  })

  /*
   * **The green-with-nothing-run guard.** A runner that caught the connection
   * error and reported "0 checks, 0 failures" would look identical to a clean
   * sweep in any summary. The exit code is the only thing that separates them,
   * and the port belongs in the message because "could not connect" without one
   * sends the reader to the wrong machine.
   */
  it('exits non-zero when the bridge is unreachable, naming the bridge and the port', async () => {
    const port = await closedPort()
    const { code, err } = run(['--port', String(port)])

    expect(code).not.toBe(0)
    expect(err).toMatch(/bridge/i)
    expect(err).toContain(String(port))
  })

  /*
   * The zero-row case. `ok = failures === 0` scores an empty corpus a perfect
   * pass — the same silent success as a coverage report measuring zero lines.
   * Checked BEFORE the bridge is dialled, so the reason names the corpus rather
   * than the connection.
   */
  it('exits non-zero on an empty corpus, before it ever dials the bridge', () => {
    const path = tempFile('empty-corpus.json', '[]')
    const { code, err } = run(['--corpus', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/corpus/i)
    expect(err).toMatch(/empty|zero rows/i)
    expect(err).not.toMatch(/bridge/i)
  })

  it('exits non-zero on a corpus file that is not an array of rows', () => {
    const path = tempFile('not-rows.json', '{"rows": []}')
    const { code, err } = run(['--corpus', path])

    expect(code).not.toBe(0)
    expect(err).toMatch(/corpus/i)
  })
})

describe('word-snap-live — what it concludes from a report', () => {
  /**
   * The round trip needs a running app, so it cannot be gated. What the runner
   * DECIDES from a report is pure, and it is where a hollow run would be turned
   * green — so it is tested here, in the lane that always runs.
   */
  const goodParity = { engine: 'WebKit', rows: [{ id: 'a' }, { id: 'b' }] }
  const goodDom = {
    engine: 'Mozilla/5.0 … Version/26.6 Safari/605.1.15',
    expected: CHECKS.length,
    ran: CHECKS.length,
    failures: 0,
    reason: null,
    checks: CHECKS.map((check) => ({ id: check.id, pass: true, detail: 'ok' })),
  }

  /* Runs first, and it is what stops every case below from being vacuous: a
   * function that returned a problem for everything would pass all of them. */
  it('accepts a complete, passing pair', () => {
    expect(assertRan(goodParity, goodDom, 2)).toEqual([])
  })

  it('rejects a corpus report with no rows', () => {
    const problems = assertRan({ ...goodParity, rows: [] }, goodDom, 2)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/zero rows/i)
  })

  it('rejects a corpus report built from a different number of rows', () => {
    expect(assertRan(goodParity, goodDom, 3).join(' ')).toMatch(/2 rows against 3 sent/)
  })

  it('rejects a bridge answer that is not a report at all', () => {
    expect(assertRan(null, null, 2).length).toBeGreaterThan(0)
    expect(assertRan(goodParity, undefined, 2).join(' ')).toMatch(/not a report/i)
    expect(assertRan(goodParity, {}, 2).join(' ')).toMatch(/not a report/i)
  })

  /* The green-with-nothing-run shape, in its most plausible disguise: a report
   * with no failures because it ran nothing. */
  it('rejects a DOM report that ran nothing, however clean it looks', () => {
    const hollow = { ...goodDom, ran: 0, failures: 0, checks: [], reason: 'no document' }

    expect(assertRan(goodParity, hollow, 2).join(' ')).toMatch(/ran 0 of/)
  })

  it('rejects a DOM report that declares fewer checks than are defined here', () => {
    const short = { ...goodDom, expected: CHECKS.length - 1, ran: CHECKS.length - 1 }

    expect(assertRan(goodParity, short, 2).join(' ')).toContain(String(CHECKS.length))
  })

  it('names the check that failed, and its detail', () => {
    const failed = {
      ...goodDom,
      failures: 1,
      checks: goodDom.checks.map((check, i) =>
        i === 0 ? { ...check, pass: false, detail: 'identical after=true' } : check,
      ),
    }

    const problems = assertRan(goodParity, failed, 2)
    expect(problems.join(' ')).toContain(CHECKS[0].id)
    expect(problems.join(' ')).toContain('identical after=true')
  })

  /* The engine string is the one field that proves the snippet ran in a browser
   * rather than being answered by something in the middle. */
  it('rejects a report that did not come from a browser engine', () => {
    const noEngine = { ...goodDom, engine: 'no navigator — not a browser engine' }

    expect(assertRan(goodParity, noEngine, 2).join(' ')).toMatch(/engine/i)
    expect(assertRan(goodParity, { ...goodDom, engine: '' }, 2).join(' ')).toMatch(/engine/i)
    expect(assertRan(goodParity, { ...goodDom, engine: undefined }, 2)).toEqual([
      'the DOM report carries no engine string — it did not run in a browser engine',
    ])
  })

  /* Every case below asserts the WHOLE list. A matcher on one clause passes a
   * function that adds a second, wrong complaint beside the right one, and a
   * complaint missing its numbers is a complaint nobody can act on. */
  const n = CHECKS.length

  it('says only that a corpus answer is not a report, whatever shape it is not one in', () => {
    for (const parity of [null, undefined, 'rows', { rows: 'many' }]) {
      expect(assertRan(parity, goodDom, 2)).toEqual(['the corpus report is not a report this harness produced'])
    }
  })

  it('names both row counts when the corpus report holds a different number', () => {
    expect(assertRan(goodParity, goodDom, 3)).toEqual(['the corpus report holds 2 rows against 3 sent'])
  })

  it('refuses a DOM report whose declared count alone is wrong, naming all three numbers and its reason', () => {
    expect(assertRan(goodParity, { ...goodDom, expected: n - 1 }, 2)).toEqual([
      `the DOM report ran ${n} of a declared ${n - 1} checks, against ${n} defined here`,
    ])
    expect(assertRan(goodParity, { ...goodDom, expected: n - 1, reason: 'the frame went away' }, 2)).toEqual([
      `the DOM report ran ${n} of a declared ${n - 1} checks, against ${n} defined here — the frame went away`,
    ])
  })

  it('refuses an entry that is not a check, whichever way it fails to be one', () => {
    const rest = goodDom.checks.slice(1)
    for (const entry of [undefined, CHECKS[0].id, { pass: true, detail: 'ok' }]) {
      expect(assertRan(goodParity, { ...goodDom, checks: [entry, ...rest] }, 2)).toEqual([
        'the DOM report holds an entry that is not a check',
        `${CHECKS[0].id}: declared here and absent from the report`,
      ])
    }
  })

  it('reports a failed check as its id and its own detail, and nothing else', () => {
    const failed = {
      ...goodDom,
      checks: goodDom.checks.map((check, i) => (i === 0 ? { ...check, pass: false, detail: 'identical after=true' } : check)),
    }

    expect(assertRan(goodParity, failed, 2)).toEqual([`${CHECKS[0].id}: identical after=true`])
  })

  /* The counts all agree here, so the declared check that is missing is the
   * only thing that can say so. */
  it('refuses a report carrying a check nobody declared in place of one that was', () => {
    const stray = { id: 'stray', pass: true, detail: 'ok' }
    const swapped = { ...goodDom, checks: [...goodDom.checks.slice(0, -1), stray] }

    expect(assertRan(goodParity, swapped, 2)).toEqual([`${CHECKS.at(-1).id}: declared here and absent from the report`])
  })

  it('refuses a report whose entries outnumber the checks it says ran', () => {
    const padded = { ...goodDom, checks: [...goodDom.checks, { id: 'stray', pass: true, detail: 'ok' }] }

    expect(assertRan(goodParity, padded, 2)).toEqual([`the DOM report claims ${n} checks ran and carries ${n + 1}`])
  })

  it('believes a failure status on either field alone', () => {
    expect(assertRan(goodParity, { ...goodDom, ok: false }, 2)).toEqual([
      'the DOM report declares itself failed (ok: false, failures: 0)',
    ])
    expect(assertRan(goodParity, { ...goodDom, ok: true, failures: 2 }, 2)).toEqual([
      'the DOM report declares itself failed (ok: true, failures: 2)',
    ])
  })

  /* ⚠️ **A FAILURE COUNT THAT WAS NOT A NUMBER WAS NOT READ AT ALL** until
     2026-09-15: a type guard stood in front of the comparison, and the only
     values it ever turned away were ones that compare as a positive count — so
     a report saying `failures: "2"` over entries that all passed was clean. */
  it('believes a failure count that arrives as text', () => {
    expect(assertRan(goodParity, { ...goodDom, ok: true, failures: '2' }, 2)).toEqual([
      'the DOM report declares itself failed (ok: true, failures: 2)',
    ])
  })
})

describe('word-snap-live — the DOM-check snippet', () => {
  /*
   * The snippet is assembled from the app's own TypeScript at run time, so the
   * thing that breaks is the assembly, not the algorithm. Compiling it here
   * turns "a SyntaxError from a webview, at a position pointing at something
   * innocent" into a failure in the lane that always runs.
   */
  it('compiles as JavaScript', () => {
    expect(() => new Script(buildDomSnippet())).not.toThrow()
  })

  /*
   * The report's own counters are what make "it actually ran" checkable, and
   * they have to agree with the runner's expectations or the agreement is
   * vacuous. `expected` is set before any DOM is touched precisely so this
   * assertion survives the no-DOM path below.
   */
  it('declares exactly the checks the runner expects', () => {
    const report = evaluateSnippet(buildDomSnippet())

    expect(report.expected).toBe(CHECKS.length)
  })

  /*
   * Evaluated in Node, where there is no `document`. A snippet that returned
   * `ok: true` here would return `ok: true` from a webview that had been torn
   * down, from a window with no document, and from a bridge that answered
   * without running anything.
   */
  it('fails closed in an engine with no DOM rather than reporting a clean sweep', () => {
    const report = evaluateSnippet(buildDomSnippet())

    expect(report.ok).toBe(false)
    expect(report.ran).toBe(0)
    expect(report.reason).toMatch(/document|DOM/i)
    expect(report.checks).toEqual([])
  })

  /*
   * ⚠️ **A CHECK THAT NO ENGINE COULD PASS STOOD IN THIS FILE UNNOTICED.** The
   * backward-direction check expected nine characters of an eight-character
   * selection until 2026-09-14, and being manual-gated, nothing ran it. jsdom
   * is not WebKit, so a pass here says nothing about WebKit — but a check that
   * fails in EVERY DOM, and an adapter that did not arrive in the snippet, or
   * an id the snippet has no check for, all fail here, in the lane that always
   * runs. Every one of the six passes in jsdom.
   */
  it('passes every check it declares when a DOM runs it', async () => {
    const report = await inJsdom(buildDomSnippet())

    expect(report).toMatchObject({ ok: true, expected: CHECKS.length, ran: CHECKS.length, failures: 0, reason: null })
    /* Compared whole, so a failure prints each check's own detail beside it. */
    expect(report.checks).toEqual(CHECKS.map(({ id }) => expect.objectContaining({ id, pass: true })))
  })

  /*
   * The adapter was written as modules, which are strict, and the snippet
   * keeps it that way. Strictness is only visible from inside — a sloppy
   * function's `caller` never reveals a strict one — so the probe is a sloppy
   * getter on `navigator`, which the driver reads before anything else. The
   * same probe `word-snap-parity.test.mjs` holds its snippet to.
   */
  it('runs the inlined adapter in strict mode, as the modules it was written as', () => {
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

    const snippet = buildDomSnippet()
    const strict = callersSeenBy(snippet)
    expect(strict.length).toBeGreaterThan(0)
    expect(strict.filter((caller) => caller !== null)).toEqual([])

    /* The known positive: the same snippet without its directive, and the same
     * probe sees exactly who called it. */
    const sloppy = callersSeenBy(snippet.replace("'use strict';\n", ''))
    expect(sloppy.length).toBeGreaterThan(0)
    expect(sloppy.every((caller) => typeof caller === 'function')).toBe(true)
  })

  it('removes its fixture frame, however the run ends', async () => {
    /* ⚠️ **EVERY OTHER TEST OF THE SNIPPET RUNS WITHOUT A DOM**, where it stops
       at the first guard — which is the point of those, and leaves everything
       past the guard unexecuted, the fixture iframe included. So the one thing
       the snippet promises about its own housekeeping, that it never leaves an
       off-screen frame behind, had nothing asserting it.

       A jsdom window rather than the `jsdom` test environment: this file is
       assembled from the app's source through `import.meta.url`, which under
       that environment is not a file URL and cannot be read from. jsdom is not
       WebKit, so whether the checks pass in it is not what this measures — the
       case above does that. What this measures is what the snippet LEAVES. */
    const { JSDOM } = await import('jsdom')
    const snippet = buildDomSnippet()

    const clean = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
    clean.window.eval(snippet)
    expect(clean.window.document.querySelectorAll('iframe')).toHaveLength(0)

    /* ⚠️ **AND WHEN THE FIXTURE ITSELF FAILS, WHICH IS THE CASE IT LEAKED.**
       The cleanup used to begin after the fixture was built, so a throw from
       the markup assignment, the selection or the checks table left the iframe
       attached — with a selection inside it, which the next run inherits.
       Injected by giving the frame's document a body whose `innerHTML`
       refuses, the first thing the snippet does with it. */
    const broken = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
    const real = broken.window.document.createElement.bind(broken.window.document)
    broken.window.document.createElement = (tag) => {
      const made = real(tag)
      if (tag !== 'iframe') return made
      Object.defineProperty(made, 'contentDocument', {
        configurable: true,
        get: () => ({
          body: {
            set innerHTML(_value) {
              throw new Error('the fixture would not build')
            },
          },
        }),
      })
      return made
    }
    expect(() => broken.window.eval(snippet)).toThrow(/the fixture would not build/u)
    expect(broken.window.document.querySelectorAll('iframe')).toHaveLength(0)
  })

  /*
   * The snippet crosses a process boundary as JSON and is then parsed by
   * WebKit. A JS line terminator inside a comment ends that comment early and
   * turns the rest of the line into code; an unpaired surrogate does not
   * survive UTF-8 at all. Both arrive from the inlined source, where escaping
   * is not an option because a comment is not a string.
   */
  it('carries nothing that would break at parse in transit', () => {
    const snippet = buildDomSnippet()
    const lineSeparator = String.fromCharCode(0x2028)
    const paragraphSeparator = String.fromCharCode(0x2029)
    const offenders = []

    // Iteration is by code point, so a well-formed astral pair arrives as one
    // two-unit string; a one-unit string in the surrogate range is unpaired.
    for (const character of snippet) {
      const code = character.charCodeAt(0)
      const lone = character.length === 1 && code >= 0xd800 && code <= 0xdfff
      if (lone || character === lineSeparator || character === paragraphSeparator) {
        offenders.push('U+' + code.toString(16).toUpperCase().padStart(4, '0'))
      }
    }

    expect(offenders).toEqual([])
  })

  /*
   * WKWebView's native `evaluateJavaScript` is the path that returns a result
   * synchronously; the bridge falls back to an eval-plus-IPC round trip the
   * moment it sees any of these tokens anywhere in the script, including in a
   * comment. That fallback has a five-second timeout and needs `__TAURI__` in
   * the page, so a stray "async " in a doc comment turns a working check into
   * an intermittent one for reasons nothing reports.
   */
  it('avoids the tokens that push the bridge off its native evaluation path', () => {
    const snippet = buildDomSnippet()

    for (const token of ['await ', 'async ', '(async', '.then(', 'Promise.', 'new Promise(']) {
      expect(snippet).not.toContain(token)
    }
  })

  /* The corpus and the DOM checks are two halves of one run; a live report that
   * carried the checks but not the rows would be half a verification. */
  it('is a different snippet from the corpus parity one, and both are non-empty', () => {
    expect(buildDomSnippet().length).toBeGreaterThan(0)
    expect(CORPUS.length).toBeGreaterThan(0)
  })
})

describe('word-snap-live — the command line', () => {
  it('prints its usage for --help and -h, reading no corpus and dialling nothing', async () => {
    for (const flag of ['--help', '-h']) {
      expect(await cli([flag])).toEqual({ code: 0, out: '', err: `${USAGE}\n`, dialled: [], corpusReads: 0 })
    }
  })

  it('lists every check with what it is for, reading no corpus and dialling nothing', async () => {
    expect(await cli(['--list'])).toEqual({ code: 0, out: LISTING, err: '', dialled: [], corpusReads: 0 })
  })

  it('prints the DOM-check snippet for --emit-dom, and nothing else', async () => {
    expect(await cli(['--emit-dom'])).toEqual({ code: 0, out: buildDomSnippet(), err: '', dialled: [], corpusReads: 0 })
  })

  /* ⚠️ **ONLY `--` FLAGS WERE CHECKED, AND ONLY AFTER THREE MODES HAD RUN.** A
     bare `9223` was ignored exactly as `--prot 9223` once was, and so was
     anything after `--list`. The whole command line is read first now. */
  it('refuses an argument it does not know, with its usage, before anything runs', async () => {
    const known = '(known: --help, -h, --list, --emit-dom, --json, --corpus, --port)'
    for (const [args, unknown] of [
      [['--prot', '9223'], '--prot'],
      [['9223'], '9223'],
      [['--list', '--bogus'], '--bogus'],
    ]) {
      expect(await cli(args)).toEqual({
        code: 2,
        out: '',
        err: `unknown option: ${unknown} ${known}\n${USAGE}\n`,
        dialled: [],
        corpusReads: 0,
      })
    }
  })

  /* ⚠️ **`--json` WAS NEVER ON THE LIST OF KNOWN OPTIONS**, though the usage
     offers it: every run asked for JSON was refused as a typo. */
  it('knows every option its usage offers', async () => {
    const socket = fakeBridge(corpusInWebview, answering(PASSING_DOM))
    const { code, err } = await cli(['--json', '--port', '31415'], { socket })

    expect(err).not.toContain('unknown option')
    expect(code).toBe(0)
  })

  it('refuses an option named without its value', async () => {
    for (const [args, flag] of [
      [['--port'], '--port'],
      [['--corpus', '--json'], '--corpus'],
    ]) {
      expect(await cli(args)).toEqual({ code: 2, out: '', err: `${flag} needs a value\n${USAGE}\n`, dialled: [], corpusReads: 0 })
    }
  })

  it('refuses an option given twice rather than reading one of them', async () => {
    expect(await cli(['--port', '4242', '--port', '31415'])).toEqual({
      code: 2,
      out: '',
      err: `--port was given more than once\n${USAGE}\n`,
      dialled: [],
      corpusReads: 0,
    })
  })
})

describe('word-snap-live — the corpus it sends', () => {
  it('exits non-zero on an empty corpus, before it dials the bridge', async () => {
    expect(await cli([], { rows: [] })).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-live: the corpus is empty — zero rows to check is a failure, not a clean sweep\n',
      dialled: [],
      corpusReads: 1,
    })
  })

  it('exits non-zero when the corpus cannot be read, saying why, before it dials', async () => {
    const refused = await cli([], { corpus: () => Promise.reject(new Error('corpus.ts did not export a CORPUS array')) })
    expect(refused).toMatchObject({ code: 1, out: '', dialled: [] })
    expect(refused.err).toBe('word-snap-live: the corpus could not be read: corpus.ts did not export a CORPUS array\n')

    const notRows = await cli(['--corpus', tempFile('not-rows.json', '{"rows": []}')])
    expect(notRows).toEqual({
      code: 1,
      out: '',
      err: 'word-snap-live: the corpus could not be read: the corpus file must hold an array of rows, not object\n',
      dialled: [],
      corpusReads: 0,
    })

    const missing = join(tempDir(), 'absent.json')
    const absent = await cli(['--corpus', missing])
    expect(absent).toMatchObject({ code: 1, out: '', dialled: [], corpusReads: 0 })
    expect(absent.err).toMatch(/^word-snap-live: the corpus could not be read: ENOENT: .*absent\.json'\n$/u)
  })

  it('sends the rows from --corpus FILE rather than the corpus module', async () => {
    const rows = [CORPUS[2]]
    const socket = fakeBridge(corpusInWebview, answering(PASSING_DOM))

    const result = await cli(['--corpus', tempFile('one-row.json', JSON.stringify(rows))], { socket })

    expect(result).toMatchObject({ code: 0, corpusReads: 0 })
    expect(result.err).toContain('word-snap-live: 1 corpus rows agree with this engine')
    expect(socket.scripts[0]).toBe(buildSnippet(rows))
  })
})

describe('word-snap-live — the bridge', () => {
  it('dials the pinned port unless --port names another, and says so when nothing answers', async () => {
    const refuse = new Error('the bridge refused or dropped the connection')

    expect(await cli([], { refuse })).toEqual({
      code: 1,
      out: '',
      err:
        'word-snap-live: the MCP bridge at 127.0.0.1:31415 is unreachable — the bridge refused or dropped the connection\n' +
        UNREACHABLE_ADVICE,
      dialled: [31415],
      corpusReads: 1,
    })
    for (const port of ['1', '4242', '65535']) {
      const result = await cli(['--port', port], { refuse })
      expect(result.dialled).toEqual([Number(port)])
      expect(result.err).toBe(
        `word-snap-live: the MCP bridge at 127.0.0.1:${port} is unreachable — the bridge refused or dropped the connection\n` +
          UNREACHABLE_ADVICE,
      )
    }
  })

  it('refuses a --port that is not a port number, before it dials', async () => {
    for (const port of ['abc', '0', '-1', '1.5', '65536', '']) {
      expect(await cli(['--port', port])).toEqual({
        code: 1,
        out: '',
        err: `word-snap-live: --port needs a port number, got ${port}\n`,
        dialled: [],
        corpusReads: 1,
      })
    }
  })

  it('runs the corpus and then the DOM checks, closes the connection, and exits zero when both agree', async () => {
    const socket = fakeBridge(corpusInWebview, answering(PASSING_DOM))

    expect(await cli([], { socket })).toEqual({
      code: 0,
      out: '',
      err:
        CHECKS.map(({ id }) => `  ok    ${id}: as expected\n`).join('') +
        `word-snap-live: 2 corpus rows agree with this engine and ${CHECKS.length} checks pass in ${WEBKIT}\n` +
        GESTURES_NOT_COVERED,
      dialled: [31415],
      corpusReads: 1,
    })
    expect(socket.scripts).toEqual([buildSnippet(ROWS), buildDomSnippet()])
    expect(socket.closes).toBe(1)
  })

  it('passes end to end when a DOM answers the checks the snippet carries', async () => {
    const socket = fakeBridge(corpusInWebview, (script) => ({ success: true, data: inJsdom(script) }))

    const { code, err } = await cli([], { socket })

    for (const { id } of CHECKS) expect(err).toContain(`  ok    ${id}: `)
    expect(err).toContain(`word-snap-live: 2 corpus rows agree with this engine and ${CHECKS.length} checks pass in `)
    expect(code).toBe(0)
  })

  it('prints both reports as JSON for --json', async () => {
    const socket = fakeBridge(corpusInWebview, answering(PASSING_DOM))
    const corpus = JSON.parse(JSON.stringify(corpusInWebview(buildSnippet(ROWS)).data))

    const result = await cli(['--json'], { socket })

    expect(result.out).toBe(JSON.stringify({ corpus, dom: PASSING_DOM }, null, 2) + '\n')
    expect(result.code).toBe(0)
  })

  it('prints each note the comparison makes, and still exits zero', async () => {
    const flipped = (script) => {
      const report = evaluateSnippet(script)
      const [first, ...rest] = report.rows
      const segments = first.segments.map((segment, i) => (i === 0 ? { ...segment, wordLike: !segment.wordLike } : segment))
      return { success: true, data: { ...report, engine: WEBKIT, rows: [{ ...first, segments }, ...rest] } }
    }
    const { notes } = compareReports(evaluateSnippet(buildSnippet(ROWS)), flipped(buildSnippet(ROWS)).data)
    expect(notes).toHaveLength(1)

    const result = await cli([], { socket: fakeBridge(flipped, answering(PASSING_DOM)) })

    expect(result.err).toBe(
      `  note: ${notes[0]}\n` +
        CHECKS.map(({ id }) => `  ok    ${id}: as expected\n`).join('') +
        `word-snap-live: 2 corpus rows agree with this engine and ${CHECKS.length} checks pass in ${WEBKIT}\n` +
        GESTURES_NOT_COVERED,
    )
    expect(result.code).toBe(0)
  })

  it('exits non-zero on one failed check, printing it and counting one problem', async () => {
    const failing = {
      ...PASSING_DOM,
      checks: PASSING_DOM.checks.map((check, i) => (i === 0 ? { ...check, pass: false, detail: 'identical after=true' } : check)),
    }

    const result = await cli([], { socket: fakeBridge(corpusInWebview, answering(failing)) })

    expect(result.err).toBe(
      `  FAIL  ${CHECKS[0].id}: identical after=true\n` +
        CHECKS.slice(1).map(({ id }) => `  ok    ${id}: as expected\n`).join('') +
        'word-snap-live: 1 problem\n' +
        `  ${CHECKS[0].id}: identical after=true\n`,
    )
    expect(result.code).toBe(1)
  })

  it('counts and prints every problem, the comparison’s before the report’s', async () => {
    const short = () => ({ success: true, data: { ...evaluateSnippet(buildSnippet(ROWS.slice(0, 1))), engine: WEBKIT } })
    const { problems } = compareReports(evaluateSnippet(buildSnippet(ROWS)), short().data)
    expect(problems).toHaveLength(1)

    const result = await cli([], { socket: fakeBridge(short, answering({ ...PASSING_DOM, ok: false })) })

    expect(result.err).toBe(
      CHECKS.map(({ id }) => `  ok    ${id}: as expected\n`).join('') +
        'word-snap-live: 3 problems\n' +
        `  ${problems[0]}\n` +
        '  the corpus report holds 1 rows against 2 sent\n' +
        '  the DOM report declares itself failed (ok: false, failures: 0)\n',
    )
    expect(result.code).toBe(1)
  })

  it('refuses an answer that is not a DOM report, and prints no check for it', async () => {
    const result = await cli([], { socket: fakeBridge(corpusInWebview, answering(null)) })

    expect(result.err).toBe('word-snap-live: 1 problem\n  the DOM report is not a report this harness produced\n')
    expect(result.code).toBe(1)
  })

  it('exits non-zero when the webview refuses either script, closing the connection', async () => {
    const refusing = () => ({ success: false, error: 'the page went away' })

    const first = fakeBridge(refusing)
    expect(await cli([], { socket: first })).toMatchObject({
      code: 1,
      out: '',
      err: 'word-snap-live: the corpus run: the page went away\n  nothing can be concluded from this run.\n',
    })
    expect(first.scripts).toHaveLength(1)
    expect(first.closes).toBe(1)

    const second = fakeBridge(corpusInWebview, refusing)
    expect(await cli([], { socket: second })).toMatchObject({
      code: 1,
      out: '',
      err: 'word-snap-live: the DOM checks: the page went away\n  nothing can be concluded from this run.\n',
    })
    expect(second.closes).toBe(1)
  })

  /*
   * A crash is a run that did not happen, and it must not escape as a
   * rejection that a caller could mistake for anything else: non-zero, with
   * the stack — or, for a throw that has none, whatever was thrown.
   */
  it('exits non-zero on a crash, printing its stack', async () => {
    const failure = new Error('stdout is gone')
    const throwing = (value) => ({
      write: () => {
        throw value
      },
    })

    expect(await cli(['--list'], { stdout: throwing(failure) })).toMatchObject({
      code: 1,
      err: `word-snap-live: ${failure.stack}\n`,
    })
    expect(await cli(['--list'], { stdout: throwing(undefined) })).toMatchObject({
      code: 1,
      err: 'word-snap-live: undefined\n',
    })

    const notRows = await cli([], { corpus: async () => ({ length: 1 }) })
    expect(notRows).toMatchObject({ code: 1, dialled: [] })
    expect(notRows.err).toMatch(/^word-snap-live: TypeError: word-snap-parity: buildSnippet needs an array of corpus rows\n {4}at /u)
  })
})
