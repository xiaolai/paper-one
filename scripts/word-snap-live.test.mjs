import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CORPUS } from '../src/reader/wordSnap/corpus.ts'
import { evaluateSnippet } from './word-snap-parity.mjs'
import { CHECKS, assertRan, buildDomSnippet } from './word-snap-live.mjs'

/**
 * The guards on WI-12's live lane — and they live HERE, in the lane that
 * always runs, on purpose.
 *
 * The live lane needs a running app, a WebKit bridge and a human. A guard
 * against a silently empty live run is worthless if it only runs in the lane
 * being guarded: that is the same class of defect as `actool` and
 * `screencapture` exiting 0 having written nothing, which this repository has
 * been bitten by twice (`AGENTS.md`).
 *
 * So the cases below check three things the unit lane genuinely can check:
 *
 * 1. **the lane is configured as specified** — `gateOn: ["manual"]`,
 *    `coverage: "none"`, and a probe that runs without the app;
 * 2. **the runner fails closed** — an unreachable bridge and a zero-row corpus
 *    both exit non-zero, and the snippet reports failure rather than success in
 *    an engine with no DOM;
 * 3. **the manual checklist is complete** — every unautomatable gesture named,
 *    with the environment it is pinned to recorded.
 *
 * **Nothing here verifies a gesture, and nothing here claims a live run
 * happened.** The Tauri MCP bridge dispatches `isTrusted: false` events, which
 * produce no native selection and no `selectionchange`; no harness at any level
 * reaches a drag, a double-click, a long-press or a pen. A green run of this
 * file means the checklist EXISTS and is complete, never that it was performed
 * — which is exactly why the checklist carries its own status line.
 */

const ROOT = new URL('../', import.meta.url)
const SCRIPT = fileURLToPath(new URL('./word-snap-live.mjs', import.meta.url))
const CONFIG = fileURLToPath(new URL('.claude/tdd-guardian/config.json', ROOT))
const CHECKLIST = fileURLToPath(new URL('dev-docs/manual-selection-checklist.md', ROOT))

/** The script, as a user would run it. `status`, not a throw: every exit-code
 *  case below is one where a non-zero exit is the point. */
function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'word-snap-live-'))
  const path = join(dir, name)
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

/**
 * The workspace's tdd-guardian config, when this checkout has one.
 *
 * `.gitignore` puts the whole of `.claude/` outside version control — this
 * repository runs cc-suite in PRIVATE mode — so a fresh clone genuinely has no
 * config to assert against, and a test that read it unconditionally would be
 * red for everyone but the machine that ran `/tdd-guardian:init`.
 *
 * Absent, the four lane cases below are **skipped and say so in their names**,
 * never quietly passed. The checklist is a different matter and is tracked
 * deliberately (see the `.gitignore` entry): it is the only cover for every
 * gesture in this feature, so it may not be machine-local.
 */
const config = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : null
const noConfig = config === null
const checklist = readFileSync(CHECKLIST, 'utf8')

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

describe('the manual gesture checklist', () => {
  /**
   * Every gesture the plan names, as the phrase the checklist must carry.
   *
   * This is the list that turns "a checklist exists" into something a gate can
   * see. It cannot verify the gestures were performed — nothing can — but it
   * can verify the document is complete, which is the difference between an
   * honest manual lane and a decorative one.
   */
  const REQUIRED = [
    /mouse drag[^\n]*left[- ]to[- ]right/i,
    /mouse drag[^\n]*right[- ]to[- ]left/i,
    /double[- ]click/i,
    /triple[- ]click/i,
    /shift\s*\+\s*click/i,
    /shift\s*\+\s*arrow/i,
    /outside the iframe/i,
    /outside the window/i,
    /long[- ]press/i,
    /selection handle/i,
    /force[- ]touch/i,
    /\bpen\b/i,
    /paginated EPUB/i,
    /page turn/i,
    /re-mark/i,
    /orphan/i,
  ]

  it('names every gesture no harness can reach', () => {
    const missing = REQUIRED.filter((pattern) => !pattern.test(checklist)).map(String)

    expect(missing).toEqual([])
  })

  /* shift+arrow is the one keyboard case, and its expected result is the
   * opposite of every other row's. A checklist that listed it without saying so
   * would read as "snapping works here too". */
  it('says shift+arrow must stay unsnapped', () => {
    expect(checklist).toMatch(/shift\s*\+\s*arrow[\s\S]{0,400}?unsnapped/i)
  })

  /* The paginator race. The assertion is the ABSENCE of an event, which is why
   * it cannot be automated and why it has to be spelled out. */
  it('says the paginated EPUB case must not turn the page', () => {
    expect(checklist).toMatch(/paginated EPUB[\s\S]{0,400}?no page turn/i)
  })

  /*
   * WI-10's declared debt. Reverting `useMarking.selected` to byte-equality,
   * deleting its `eraseMark` line, or reverting `useMarks`' `upsertOverlapping`
   * to the byte-exact `upsertMark`, each survives every test in this repository
   * — nothing imports either hook, and the unit lane has no DOM and no React
   * renderer. It is the largest unverified surface in the feature, and the only
   * place it can be checked is here.
   *
   * `upsertOverlapping` is named because the checklist ONCE MISSED IT: it
   * listed the two `useMarking` survivors and not the `useMarks` one, while
   * claiming to be the complete cover. A section that is a cover by declaration
   * and not by content is worse than no section, so the third name is asserted
   * here rather than left to whoever reads it next.
   */
  it('covers the mark-overlap surface no test in this repo reaches', () => {
    expect(checklist).toMatch(/useMarking/)
    expect(checklist).toMatch(/eraseMark/)
    expect(checklist).toMatch(/upsertOverlapping/)
    expect(checklist).toMatch(/duplicate/i)
  })

  /*
   * Not "there is a heading called Environment" — the values themselves, and
   * they must not be placeholders. A checklist recording `macOS TBD` records
   * nothing, and the version is the entire point: ICU moves with the OS, so a
   * run against an unrecorded WebKit cannot be compared with the next one.
   */
  it('records the OS, WebKit and app versions it is pinned to, with no placeholders', () => {
    const fields = {
      macOS: /^\|\s*macOS\s*\|\s*([^|]+?)\s*\|/m,
      WebKit: /^\|\s*WebKit\s*\|\s*([^|]+?)\s*\|/m,
      Safari: /^\|\s*Safari\s*\|\s*([^|]+?)\s*\|/m,
      Date: /^\|\s*Date\s*\|\s*([^|]+?)\s*\|/m,
    }

    for (const [name, pattern] of Object.entries(fields)) {
      const match = checklist.match(pattern)
      expect(match, `${name} row missing from the environment table`).not.toBeNull()
      expect(match[1], `${name} is a placeholder`).not.toMatch(/TODO|TBD|\bxx\b|^-+$|^\?+$/i)
      expect(match[1].length).toBeGreaterThan(2)
    }
  })

  /*
   * The status is DECLARED, not inferred. Without it a complete-looking
   * checklist reads as a performed one, and a green `pnpm test` reads as
   * evidence about gestures it has never touched. Three values, one of which is
   * honest about having run nothing.
   */
  it('declares its run status as one of the allowed values', () => {
    const match = checklist.match(/^\|\s*Status\s*\|\s*([^|]+?)\s*\|/m)

    expect(match).not.toBeNull()
    /* PARTIAL was added when the first rows were actually run: a checklist
     * with some rows performed and some not is the normal state during a
     * feature, and forcing it to claim NOT RUN or PASS would make it lie in
     * one direction or the other. Still a bare enum with no prose, because
     * the whole point of the assertion is that the status cannot be padded
     * into something that reads as done. */
    expect(['NOT RUN', 'PARTIAL', 'PASS', 'FAIL']).toContain(match[1])
  })

  /*
   * The claim the plan's last acceptance criterion forbids. `webview_interact`
   * dispatches `isTrusted: false`, so the checklist must say WHY these are
   * manual, not merely that they are — otherwise the next reader tries to
   * automate them and concludes the app is broken.
   */
  it('says why no harness reaches these, not merely that none does', () => {
    expect(checklist).toMatch(/isTrusted/)
    expect(checklist).toMatch(/webview_interact/)
    expect(checklist).toMatch(/selectionchange/)
  })
})
