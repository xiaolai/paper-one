import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PINNED,
  PLATFORM_PREFIX,
  blockersOf,
  checkBrowserSafe,
  main,
  sourcesUnder,
} from './check-browser-safe.mjs'

/**
 * `check-browser-safe`: what reaches the platform, and what only talks about it.
 *
 * THE KNOWN-POSITIVE TEST IS THE POINT OF THIS FILE. A detector that finds
 * nothing looks exactly like a clean result, and this one has already produced
 * a confident all-clear on `vaultFsTauri.ts` — the Tauri binding itself —
 * because its regex forbade newlines and the binding's import is wrapped over
 * eight lines. Every other case here guards one of the two ways it was wrong:
 * counting prose, or missing a real import.
 *
 * How ONE module is read — comments, strings, type-only clauses — is tested
 * with the reader itself, in `lib/specifiers.test.mjs`, where it moved on
 * 2026-09-14. What stays here is what this gate does with the answer.
 */

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A tree holding `files` (path → content). */
function fixture(files) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'browser-safe-'))
  roots.push(root)
  for (const [p, body] of Object.entries(files)) {
    const full = join(root, p)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const blockedFiles = (root, entry) => [...blockersOf(root, entry).blockers.keys()].sort()

/**
 * The command, run in THIS process with both streams captured, and read the way
 * a spawned one is: `status`, `stdout`, `stderr`.
 *
 * ⚠️ **EVERY CASE OF THE COMMAND SPAWNED THE SCRIPT, AND SO MEASURED NOTHING A
 * MUTATION SWEEP COULD SEE.** A spawned child never runs the mutant under test:
 * 139 of this gate's 290 mutants — the whole command, `--survey` and the walk of
 * a directory — had no coverage while every case here passed. One case still
 * spawns, and asks only what a process adds. 2026-09-14.
 */
function cli(...argv) {
  const said = { stdout: '', stderr: '' }
  const status = main(argv, {
    stdout: { write: (text) => void (said.stdout += text) },
    stderr: { write: (text) => void (said.stderr += text) },
  })
  return { status, ...said }
}

/** The advice under a failing count, whole — it is all a reader of a red gate is told. */
const ADVICE =
  '\nA module reaches @tauri-apps through the closure above, so it cannot be\n' +
  'bundled for a browser. Usually the cause is a pure value sharing a module\n' +
  'with a platform binding — split the binding into its own file, the way\n' +
  '`vaultFsTauri.ts` was split from `bookVault.ts`.\n'

/**
 * ⚠️ **These walk the WHOLE of `src/` and are therefore slow by nature** —
 * `checkBrowserSafe` resolves and reads every module reachable from each pinned
 * entry. Measured 2026-09-01: 0.44 s alone, 9.2 s under `--coverage`, 25 s
 * inside a full `pnpm test:coverage` where the main thread is contended.
 *
 * The 60 s bound that makes that survivable is set for the whole `scripts`
 * PROJECT in `vitest.config.ts`, not here — a second gate test hit the same
 * 15 s ceiling for the same reason within hours, and two instances are a class.
 * That note carries the measurements and the reasoning.
 *
 * The cheap fix is not available: the walk cache is already shared across all
 * ten pinned modules in one `checkBrowserSafe` call (see `newWalkCache`), and
 * `pinnedReports()` memoises so the tree is walked once for the whole block.
 */
describe('the real tree — the cases this gate was built from', () => {
  /**
   * ⚠️ **WALKED ONCE, ASSERTED TWICE — AND IT USED TO BE WALKED TWICE.**
   *
   * `checkBrowserSafe` over `PINNED` reads and parses the transitive import
   * graph of ten entry modules, which is most of `src/`. Two cases below ask
   * different questions of the same answer, and each used to recompute it.
   *
   * Measured under `pnpm vitest run --coverage --project scripts`: 16 669 ms
   * and 11 113 ms, against a 15 000 ms `testTimeout` — so the first one FAILED,
   * intermittently, only ever under coverage and never in isolation (2.0 s for
   * the whole file). `scripts/**` is in `COVERAGE_INCLUDE`, so the walk runs
   * v8-instrumented; the cost is real, and doing it twice doubled it.
   *
   * The input is a pure function of the working tree, which does not change
   * during a run, so one walk is not a shortcut — the second call could only
   * ever return the same thing.
   *
   * ⚠️ **LAZY, NOT A `const` IN THE DESCRIBE BODY.** A describe body runs at
   * COLLECTION, where no `testTimeout` applies — so hoisting it there would
   * have swapped a bounded failure ("timed out in 15000ms", with the test
   * named) for an unbounded one (collection hangs, nothing named). Paying it
   * inside the first test that asks keeps the liveness bound exactly where it
   * can still report.
   *
   * The walk itself is now much cheaper than the measurements above: the same
   * audit fixed `checkBrowserSafe` to parse each file once per CALL rather than
   * once per ENTRY, which is where the real cost was.
   */
  let walked = null
  const pinnedReports = () => (walked ??= checkBrowserSafe(process.cwd(), [...PINNED]))

  /**
   * THE KNOWN POSITIVE, against the repository itself.
   *
   * `vaultFsTauri.ts` IS the Tauri binding for the vault filesystem. If this
   * ever passes, the detector is broken rather than the tree being clean —
   * which is precisely the failure that shipped once already.
   */
  it('reports the Tauri binding as blocked', () => {
    const [report] = checkBrowserSafe(process.cwd(), ['src/kernel/core/vaultFsTauri.ts'])
    expect(report.blockers.map((b) => b.file)).toContain('src/kernel/core/vaultFsTauri.ts')
    expect(report.blockers[0].packages.join()).toMatch(/@tauri-apps/)
  })

  /**
   * THE KNOWN NEGATIVE, and the reason it is not obvious.
   *
   * `bookVault.ts`'s docstring names `@tauri-apps` three times to explain that
   * it does NOT import it — the module's Tauri half was deliberately moved out.
   * A scan that greps the file reports it, and reported it.
   */
  it('does not report a module that only names the platform in prose', () => {
    expect(blockedFiles(process.cwd(), 'src/kernel/core/bookVault.ts')).toEqual([])
  })

  it('keeps every pinned module browser-safe', () => {
    for (const report of pinnedReports()) {
      expect({ module: report.module, missing: report.missing, blockers: report.blockers }).toEqual({
        module: report.module,
        missing: false,
        blockers: [],
      })
    }
  })

  it('pins modules that exist', () => {
    for (const report of pinnedReports()) {
      expect(report.missing).toBe(false)
      expect(report.modules).toBeGreaterThan(0)
    }
  })

  /* THE TWO DOORS. A browser client reaches the kernel through exactly these
     entries (AGENTS.md, "What a browser can reach"), and a `PINNED` that lost
     either would pass both cases above, over a shorter list. */
  it('pins both entries a browser client reaches the kernel through', () => {
    expect(PINNED).toEqual(expect.arrayContaining(['src/kernel/index.ts', 'src/kernel/ui/browser.ts']))
  })
})

describe('the walk', () => {
  it('reports nothing for a module with no platform import', () => {
    const root = fixture({ 'a.ts': "export const x = 1", 'b.ts': "import { x } from './a'" })
    expect(blockedFiles(root, 'b.ts')).toEqual([])
  })

  /* THE WHOLE POINT: the blocker is usually not the module you asked about.
     One value import nothing on the path ever calls is what took the reader
     subtree down, and naming the FILE is what makes the fix obvious. */
  it('names the blocking file, not the entry', () => {
    const root = fixture({
      'leaf.ts': "import { readFile } from '@tauri-apps/plugin-fs'\nexport const fs = readFile",
      'mid.ts': "export { fs } from './leaf'",
      'top.ts': "import { fs } from './mid'\nexport const a = fs",
    })
    expect(blockedFiles(root, 'top.ts')).toEqual(['leaf.ts'])
  })

  it('reports every package a blocker imports', () => {
    const root = fixture({
      'leaf.ts': "import { a } from '@tauri-apps/plugin-fs'\nimport { b } from '@tauri-apps/plugin-dialog'",
    })
    const [report] = checkBrowserSafe(root, ['leaf.ts'])
    expect(report.blockers[0].packages).toEqual(['@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs'])
  })

  it('follows a dynamic import', () => {
    const root = fixture({
      'leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'top.ts': "export const go = async () => (await import('./leaf')).x",
    })
    expect(blockedFiles(root, 'top.ts')).toEqual(['leaf.ts'])
  })

  /* ⚠️ THE READER THIS WALK USED WAS WRONG IN BOTH DIRECTIONS AT ONCE, and
     here the two point opposite ways. A dynamic import written as a TEMPLATE
     loads its module exactly as the quoted form does and was not an edge, so a
     module that reaches the platform through one read as browser-safe — the
     direction a pin cannot survive. And `import type x = require('…')`, which
     is erased whole, WAS an edge, so a module shipping nothing of the platform
     read as blocked. Measured 2026-09-13 against the reader itself, which was
     this gate's own until it moved to `lib/specifiers.mjs`. */
  it('follows a dynamic import written as a template', () => {
    const root = fixture({
      'leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'top.ts': 'export const go = async () => (await import(`./leaf`)).x',
    })
    expect(blockedFiles(root, 'top.ts')).toEqual(['leaf.ts'])
  })

  it('is not blocked by a type-only import-equals, which runs nothing', () => {
    const root = fixture({
      'top.ts': "import type fs = require('@tauri-apps/plugin-fs')\nexport type Reader = typeof fs.readFile",
    })
    expect(blockedFiles(root, 'top.ts')).toEqual([])
  })

  it('resolves a directory index', () => {
    const root = fixture({
      'pkg/index.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'top.ts': "import { x } from './pkg'\nexport const y = x",
    })
    /* SPELLED WITH A FORWARD SLASH, not built with `join`. A module path is
       reported the way this repository writes one, and `join` gives
       `pkg\\index.ts` on Windows — so this asserted the HOST's separator and
       agreed with the bug its sibling case exists for. Same shape as the
       `defaultDataDir` expectation: a test and a defect matching each other
       everywhere except on the platform where neither had run. */
    expect(blockedFiles(root, 'top.ts')).toEqual(['pkg/index.ts'])
  })

  /* ⚠️ ONE MODULE UNDER TWO NAMES WAS WALKED, AND COUNTED, TWICE ON WINDOWS. A
     directory's index was appended to `path.resolve`'s answer with a `/`, so
     `./pkg` found `…\pkg/index.ts` while `./pkg/index` found `…\pkg\index.ts`.
     Only the Windows leg can fail this — on macOS and Linux the two spellings
     were always one string — and that is where it was found (2026-09-15). */
  it('counts a directory index once, whichever way an import spells it', () => {
    const root = fixture({
      'pkg/index.ts': 'export const x = 1',
      'top.ts': "import { x } from './pkg'\nimport './pkg/index'\nexport const y = x",
    })
    expect(blockersOf(root, 'top.ts').modules).toBe(2)
  })

  /* A CYCLE MUST NOT HANG. Kernel modules import each other freely and a walk
     that revisits is a walk that never finishes. */
  it('terminates on an import cycle', () => {
    const root = fixture({ 'a.ts': "import './b'", 'b.ts': "import './a'" })
    expect(blockersOf(root, 'a.ts').modules).toBe(2)
  })

  it('counts every module it reached, so an empty walk is visible', () => {
    const root = fixture({ 'a.ts': "export const x = 1", 'b.ts': "import './a'" })
    expect(blockersOf(root, 'b.ts').modules).toBe(2)
  })

  /**
   * A MISSING MODULE IS A FINDING, NOT A PASS.
   *
   * A pin naming a file that has been renamed would otherwise report clean
   * forever, guarding nothing — the same shape as a scan that finds no files
   * and calls it success.
   */
  it('reports a module that does not exist rather than passing it', () => {
    const [report] = checkBrowserSafe(fixture({ 'a.ts': '' }), ['nope.ts'])
    expect(report.missing).toBe(true)
    expect(report.blockers).toEqual([])
  })

  it('ignores a bare package that is not the platform', () => {
    const root = fixture({ 'a.ts': "import React from 'react'\nimport { z } from 'zod'" })
    expect(blockedFiles(root, 'a.ts')).toEqual([])
  })

  it('matches any @tauri-apps subpath', () => {
    const root = fixture({ 'a.ts': `import { w } from '${PLATFORM_PREFIX}/api/window'` })
    expect(blockedFiles(root, 'a.ts')).toEqual(['a.ts'])
  })

  /* `.tsx` IS TRIED TWICE — as the module and as a directory's index — and
     every case above resolves a `.ts`, so a candidate list missing either
     spelling passed while every component behind one went unfollowed. */
  it('resolves a .tsx module and a .tsx directory index', () => {
    const root = fixture({
      'leaf.tsx': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'pkg/index.tsx': "import { b } from '@tauri-apps/plugin-fs'\nexport const y = b",
      'top.ts': "import { x } from './leaf'\nimport { y } from './pkg'\nexport const z = [x, y]",
    })
    expect(blockedFiles(root, 'top.ts')).toEqual(['leaf.tsx', 'pkg/index.tsx'])
  })

  /* Only a name ENDING in `.ts` or `.tsx` is a module. `.tsv` holds `.ts`, and
     a match anywhere in the name would read a data file as a source. */
  it('takes nothing that is not TypeScript for a module, whatever its name contains', () => {
    const root = fixture({ 'table.tsv': 'a\tb\n', 'top.ts': "import table from './table.tsv'\nexport const t = table" })
    expect(blockersOf(root, 'top.ts').modules).toBe(1)
  })

  /* WHAT `--survey` WALKS, in path order rather than the order a directory
     lists: `src/z.ts` sorts before `src/z/a.ts`, where a walk that visits the
     `z` directory first puts it after. */
  it('lists every TypeScript source under a directory, tests excluded, in path order', () => {
    const root = fixture({
      'src/z/a.ts': '',
      'src/z.ts': '',
      'src/b.tsx': '',
      'src/a.ts': '',
      'src/a.test.ts': '',
      'src/b.test.tsx': '',
      'src/notes.md': '',
      'src/table.tsv': '',
      'elsewhere.ts': '',
    })
    expect(sourcesUnder(root, 'src')).toEqual(['src/a.ts', 'src/b.tsx', 'src/z.ts', 'src/z/a.ts'])
  })
})

/**
 * THE COMMAND'S EXIT CODE, which is the only thing a gate is read by.
 *
 * `--survey` returned 0 before the root was ever validated, so
 * `--root /nowhere --survey src/kernel` printed "0 browser-safe, 0 blocked"
 * and succeeded. That is an authoritative all-clear about a tree that does not
 * exist — the third time this detector has produced a confident wrong answer,
 * and the same shape as the first two: nothing found is indistinguishable from
 * nowhere looked.
 */
describe('the CLI', () => {
  /* EXACT TEXT, NOT A FRAGMENT OF IT. These two refusals both contain "not a
     directory", so a check that asked for the phrase passed whichever of them
     was printed — and with the root check gone, a missing root falls through to
     the second. */
  it('refuses a survey of a root that does not exist', () => {
    const nowhere = join(tmpdir(), 'paper-no-such-root')
    const result = cli('--root', nowhere, '--survey', 'src/kernel')
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`check-browser-safe: ${nowhere} is not a directory\n`)
    expect(result.stdout).toBe('')
  })

  it('refuses a survey of a directory that does not exist under a real root', () => {
    const root = fixture({ 'a.ts': '' })
    const result = cli('--root', root, '--survey', 'src/nowhere')
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`check-browser-safe: src/nowhere is not a directory under ${root}\n`)
    expect(result.stdout).toBe('')
  })

  it('refuses a survey that found no sources at all', () => {
    /* A directory that exists and holds nothing this gate can read. "0 blocked"
       over an empty scan is the answer that started all of this. */
    const root = fixture({ 'src/kernel/README.md': 'not a module' })
    const result = cli('--root', root, '--survey', 'src/kernel')
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(
      'check-browser-safe: src/kernel holds no .ts/.tsx sources — a survey of nothing is not a clean survey\n',
    )
    expect(result.stdout).toBe('')
  })

  it('surveys a real tree and exits 0', () => {
    const root = fixture({ 'src/kernel/a.ts': "export const a = 1" })
    expect(cli('--root', root, '--survey', 'src/kernel')).toEqual({
      status: 0,
      stdout: 'src/kernel: 1 browser-safe, 0 blocked\n',
      stderr: '',
    })
  })

  it('surveys src/kernel when no directory is named', () => {
    const root = fixture({ 'src/kernel/a.ts': 'export const a = 1' })
    expect(cli('--root', root, '--survey')).toEqual({
      status: 0,
      stdout: 'src/kernel: 1 browser-safe, 0 blocked\n',
      stderr: '',
    })
  })

  /* ⚠️ **A SURVEY ANSWERED BEFORE IT HAD READ THE REST OF ITS ARGUMENTS.** It
     ran inside the argument loop, so a `--root` named after it was never read —
     this checkout was surveyed instead — and a module named beside it was
     neither checked nor mentioned. 2026-09-14. */
  it('reads every argument before it surveys, so a root named after --survey is the tree surveyed', () => {
    const root = fixture({ 'surveyed/a.ts': 'export const a = 1' })
    expect(cli('--survey', 'surveyed', '--root', root)).toEqual({
      status: 0,
      stdout: 'surveyed: 1 browser-safe, 0 blocked\n',
      stderr: '',
    })
  })

  it('refuses a module named beside a survey rather than leaving it unchecked', () => {
    const root = fixture({ 'src/kernel/a.ts': 'export const a = 1', 'a.ts': '', 'b.ts': '' })
    expect(cli('--root', root, 'a.ts', '--survey', 'src/kernel', 'b.ts')).toEqual({
      status: 2,
      stdout: '',
      stderr: 'check-browser-safe: --survey checks a directory, not modules — a.ts, b.ts would go unchecked\n',
    })
  })

  /* THE GROUPING IS WHAT A SURVEY IS FOR: a cause many modules share is the
     split worth making first, so it leads. `lib/a.ts` is the first blocked
     module in path order and heads the smallest group, so an unsorted list
     leads with it; `both.ts` imports `./z` before `./a`, so an unsorted cause
     reads the other way round. */
  it('groups a survey by the files that block it, the largest group first', () => {
    const root = fixture({
      'lib/a.ts': "import { d } from '@tauri-apps/plugin-dialog'\nexport const a = d",
      'lib/both.ts': "import { z } from './z'\nimport { a } from './a'\nexport const both = [z, a]",
      'lib/clean.ts': 'export const c = 1',
      'lib/m.ts': "import { z } from './z'\nexport const m = z",
      'lib/n.ts': "import { z } from './z'\nexport const n = z",
      'lib/z.ts': "import { f } from '@tauri-apps/plugin-fs'\nexport const z = f",
    })
    expect(cli('--root', root, '--survey', 'lib')).toEqual({
      status: 0,
      stdout:
        'lib: 1 browser-safe, 5 blocked\n' +
        '\n  lib/z.ts\n    lib/m.ts\n    lib/n.ts\n    lib/z.ts\n' +
        '\n  lib/a.ts\n    lib/a.ts\n' +
        '\n  lib/a.ts + lib/z.ts\n    lib/both.ts\n',
      stderr: '',
    })
  })

  it('refuses --root with nothing after it, printing the usage', () => {
    expect(cli('--root')).toEqual({
      status: 2,
      stdout: '',
      stderr: 'usage: node scripts/check-browser-safe.mjs [--root <dir>] [--survey [<dir>] | <module>...]\n',
    })
  })

  it('refuses a root that does not exist before checking any module', () => {
    const nowhere = join(tmpdir(), 'paper-no-such-root')
    expect(cli('--root', nowhere, 'a.ts')).toEqual({
      status: 2,
      stdout: '',
      stderr: `check-browser-safe: ${nowhere} is not a directory\n`,
    })
  })

  it('passes a module with nothing of the platform in reach, and exits 0', () => {
    const root = fixture({ 'a.ts': 'export const x = 1', 'b.ts': "import { x } from './a'\nexport const y = x" })
    expect(cli('--root', root, 'b.ts')).toEqual({
      status: 0,
      stdout: 'check-browser-safe: 1 module(s) checked, 0 blocked\n',
      stderr: '',
    })
  })

  /* EVERY LINE OF A FAILING RUN, whole: the blocked module with the file and
     the packages that block it, a missing one by name, the count, and the
     advice. The clean module between them prints nothing. */
  it('reports each blocked and each missing module, and exits 1', () => {
    const root = fixture({
      'leaf.ts':
        "import { a } from '@tauri-apps/plugin-fs'\nimport { b } from '@tauri-apps/plugin-dialog'\nexport const x = [a, b]",
      'mid.ts': "export { x } from './leaf'",
      'top.ts': "import { x } from './mid'\nexport const y = x",
      'clean.ts': 'export const c = 1',
    })
    expect(cli('--root', root, 'top.ts', 'clean.ts', 'gone.ts')).toEqual({
      status: 1,
      stdout:
        'top.ts  (3 modules)\n' +
        '    leaf.ts  →  @tauri-apps/plugin-dialog, @tauri-apps/plugin-fs\n' +
        'gone.ts  — MISSING (renamed or deleted?)\n' +
        'check-browser-safe: 3 module(s) checked, 2 blocked\n' +
        ADVICE,
      stderr: '',
    })
  })

  /* WITH NO MODULE NAMED IT CHECKS `PINNED` — which is what `pnpm
     browser:check` runs. Over a tree holding none of them every pin is
     missing, and a pin that is not there has to FAIL, or the list guards
     nothing. */
  it('checks the pinned modules when none is named, and fails a pin that is not there', () => {
    const root = fixture({ 'README.md': 'no modules here' })
    expect(cli('--root', root)).toEqual({
      status: 1,
      stdout:
        PINNED.map((module) => `${module}  — MISSING (renamed or deleted?)\n`).join('') +
        `check-browser-safe: ${PINNED.length} pinned module(s) checked, ${PINNED.length} blocked\n` +
        ADVICE,
      stderr: '',
    })
  })

  /* NO `--root` MEANS THIS CHECKOUT, found from where the script lives. The
     module is pinned, so it is browser-safe for as long as this gate is green. */
  it('checks this checkout when no root is named', () => {
    expect(cli('src/kernel/ui/inTauri.ts')).toEqual({
      status: 0,
      stdout: 'check-browser-safe: 1 module(s) checked, 0 blocked\n',
      stderr: '',
    })
  })

  /* THE ONE CASE THAT STILL SPAWNS, and it asks only what a process adds: that
     node hands the command the arguments after the script, and exits with the
     code the command returned. */
  it('runs as a process with the arguments after the script, exiting with the command code', () => {
    const script = fileURLToPath(new URL('./check-browser-safe.mjs', import.meta.url))
    const root = fixture({ 'leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a" })
    const result = spawnSync(process.execPath, [script, '--root', root, 'leaf.ts'], { encoding: 'utf8' })
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout:
        'leaf.ts  (1 modules)\n' +
        '    leaf.ts  →  @tauri-apps/api/core\n' +
        'check-browser-safe: 1 module(s) checked, 1 blocked\n' +
        ADVICE,
      stderr: '',
    })
  })
})

/** What a throw leaves behind, or `null` when nothing was thrown. */
function thrownBy(act) {
  try {
    act()
    return null
  } catch (cause) {
    return cause
  }
}

/**
 * ⚠️ **A PATH THIS GATE COULD NOT READ WAS A CLEAN RESULT.** Every read in the
 * walk sat in a `catch` that answered "nothing here". Measured 2026-09-14:
 * `node scripts/check-browser-safe.mjs src` read a DIRECTORY as a module,
 * failed, and printed "1 module(s) checked, 0 blocked" with exit 0. A survey
 * skipped a directory it could not list, a candidate it could not stat was a
 * module that did not exist, and a `tsconfig.base.json` that did not parse was
 * a tree with no aliases. Each is the failure this file's header names twice —
 * nothing found, indistinguishable from nowhere looked.
 */
/**
 * ⚠️ **A LOAD NO IMPORT GRAPH CAN FOLLOW USED TO REPORT THE MODULE CLEAN.**
 *
 * `runtimeSpecifiers` names `import(p)`, `require(p)` and `createRequire()` with
 * NOTHING — there is no single module to name — so a module whose only reach to
 * the platform ran through one of them walked to a leaf with no edges and was
 * CERTIFIED browser-safe. The gate could not look, and said there was nothing
 * there. Found by the 2026-09-19 audit; the cases below are the known positive
 * it was tested against, because a detector that finds nothing looks exactly
 * like a clean result — the lesson this gate's own header already records.
 */
describe('a load this gate cannot follow', () => {
  const unprovableIn = (root, entry) => [...blockersOf(root, entry).unprovable.values()].flat()

  it('refuses a module whose only reach to the platform is a computed import', () => {
    const root = fixture({
      'tsconfig.base.json': '{"compilerOptions":{"paths":{}}}',
      'src/sneaky.ts': "const where = '@tauri-apps/api/core'\nexport const go = async () => (await import(where)).invoke('x')\n",
    })
    /* NO BLOCKER — that is the point. Nothing static reaches the platform, so
       the old gate had nothing to report and exited 0 on this file. */
    expect(blockedFiles(root, 'src/sneaky.ts')).toEqual([])
    expect(unprovableIn(root, 'src/sneaky.ts')).toEqual(['a computed import()'])
  })

  it.each([
    ['a computed require', "const p = './x'\nexport const v = require(p)\n", 'a computed require()'],
    ['a relative require', "export const v = require('./x')\n", "require('./x')"],
    ['createRequire', "import { createRequire } from 'node:module'\nexport const r = createRequire(import.meta.url)\n", 'createRequire()'],
  ])('refuses %s', (_what, body, named) => {
    const root = fixture({ 'tsconfig.base.json': '{"compilerOptions":{"paths":{}}}', 'src/a.ts': body })
    expect(unprovableIn(root, 'src/a.ts')).toContain(named)
  })

  /* NON-VACUITY, and it is the half that matters: a check that refused
     everything would pass every case above and make the gate useless. */
  it('still clears a module that loads nothing it cannot see', () => {
    const root = fixture({
      'tsconfig.base.json': '{"compilerOptions":{"paths":{}}}',
      'src/clean.ts': "import { two } from './two'\nexport const v = two\n",
      'src/two.ts': 'export const two = 2\n',
    })
    expect(unprovableIn(root, 'src/clean.ts')).toEqual([])
    expect(blockedFiles(root, 'src/clean.ts')).toEqual([])
  })

  /* AND IT IS A FAILURE, not a note. The command's exit code is the whole
     contract — a finding nobody exits non-zero for is a finding nobody reads. */
  it('exits non-zero and names the load', () => {
    const root = fixture({
      'tsconfig.base.json': '{"compilerOptions":{"paths":{}}}',
      'src/sneaky.ts': "const where = '@tauri-apps/api/core'\nexport const go = async () => (await import(where)).invoke('x')\n",
    })
    const ran = cli('--root', root, 'src/sneaky.ts')
    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('not followable')
    expect(ran.stdout).toContain('a computed import()')
  })
})

describe('a path this gate cannot read', () => {
  const UNCHECKED = '— nothing past it was checked, and a path this gate could not check is not a clean one'

  /** `act`, with `dir` closed to this user and opened again whatever happens —
   *  `afterAll` cannot remove a tree it cannot list.
   *
   *  ⚠️ **ON WINDOWS THE CASE IS SKIPPED, SAYING WHY, BECAUSE THERE IS NOTHING
   *  TO SEAL.** A directory there has no mode bits: `chmod` leaves it readable,
   *  so no directory this user cannot list can be made, and the precondition
   *  below failed on every Windows run (2026-09-15). Through the test's own
   *  `context`, at run time — not `it.skipIf`, which `vitest list` leaves out,
   *  so `pnpm test:ledger` would read each of these as deleted there (see
   *  `src/hosts/node/fs.test.ts`). The root check stays: it is what guards a
   *  Linux runner. */
  const sealed = (context, dir, act) => {
    if (process.platform === 'win32') return context.skip('a Windows directory has no mode bits, so chmod leaves it open to this user')
    chmodSync(dir, 0o000)
    try {
      /* Root reads straight through a closed directory, and every case that
         uses this would then pass having sealed nothing. */
      expect(thrownBy(() => readdirSync(dir))?.code, 'this case needs a user file permissions apply to').toBe('EACCES')
      return act()
    } finally {
      chmodSync(dir, 0o700)
    }
  }

  /* A DIRECTORY where a module resolves: it exists, so the walk takes it for
     the module, and reading it fails on every platform with no permission
     involved. */
  it('refuses a module it cannot read, naming it, rather than passing everything past it', () => {
    const root = fixture({
      'leaf.ts/placeholder.txt': '',
      'top.ts': "import { x } from './leaf'\nexport const y = x",
    })
    for (const entry of ['top.ts', 'leaf.ts']) {
      const cause = thrownBy(() => checkBrowserSafe(root, [entry]))
      expect(cause, entry).toBeInstanceOf(Error)
      expect(cause.message).toBe(`cannot read leaf.ts (EISDIR) ${UNCHECKED}`)
    }
  })

  it('refuses a module it cannot look for, rather than taking it for one that is not there', (context) => {
    const root = fixture({
      'closed/leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'top.ts': "import { x } from './closed/leaf'\nexport const y = x",
    })
    sealed(context, join(root, 'closed'), () => {
      const cause = thrownBy(() => checkBrowserSafe(root, ['top.ts']))
      expect(cause).toBeInstanceOf(Error)
      expect(cause.message).toBe(`cannot look for closed/leaf.ts (EACCES) ${UNCHECKED}`)
    })
  })

  /* ⚠️ **AND A ROOT IT COULD NOT STAT WAS "NOT A DIRECTORY"** — the diagnosis
     `existsAt` had stopped giving, left standing one function away: a root
     behind a directory this user may not search was refused for being absent,
     which sends the reader looking for a tree that is there. 2026-09-14. */
  it('refuses a root it cannot look at in the words of the failure, not as one that is absent', (context) => {
    const root = fixture({ 'closed/tree/a.ts': 'export const a = 1' })
    const inside = join(root, 'closed/tree')
    sealed(context, join(root, 'closed'), () => {
      expect(cli('--root', inside, 'a.ts')).toEqual({
        status: 2,
        stdout: '',
        stderr: `check-browser-safe: EACCES: permission denied, stat '${inside}'\n`,
      })
    })
  })

  /* A MODULE ASKED ABOUT BY NAME went through `existsSync`, which answers
     `false` for a path it cannot stat — so an entry behind a closed directory
     was reported MISSING, "renamed or deleted?", when it was neither. */
  it('refuses a module it is asked about but cannot look for, rather than calling it missing', (context) => {
    const root = fixture({ 'closed/leaf.ts': 'export const x = 1' })
    sealed(context, join(root, 'closed'), () => {
      const cause = thrownBy(() => checkBrowserSafe(root, ['closed/leaf.ts']))
      expect(cause).toBeInstanceOf(Error)
      expect(cause.message).toBe(`cannot look for closed/leaf.ts (EACCES) ${UNCHECKED}`)
    })
  })

  /* ⚠️ **AND THE ALIASES IT DID READ RESOLVED TO NOTHING.** `path.resolve`
     drops a trailing separator, so `@/*` → `src/*` became the target `…/src`,
     and `@/leaf` was looked for at `…/srcleaf` — every aliased edge unseen,
     since the day the note on `aliases` said they were followed. Measured
     2026-09-14 by this case, the first to import through one. Nothing under
     `src/` imports through `@/` today, which is how it survived. */
  it('follows an alias tsconfig.base.json declares, and refuses one it cannot read or parse', () => {
    const aliased = {
      'src/leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'src/top.ts': "import { x } from '@/leaf'\nexport const y = x",
    }
    const root = fixture({
      'tsconfig.base.json':
        '{\n  // a comment, written the way that file writes one\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }\n}\n',
      ...aliased,
    })
    expect(blockedFiles(root, 'src/top.ts')).toEqual(['src/leaf.ts'])

    const unparsed = fixture({
      'tsconfig.base.json': '{ "compilerOptions": { /* a block comment */ "paths": { "@/*": ["src/*"] } } }\n',
      ...aliased,
    })
    expect(thrownBy(() => checkBrowserSafe(unparsed, ['src/top.ts']))?.message).toBe(
      'tsconfig.base.json does not parse as JSON with line comments, so every import through one of its `paths` would go unseen',
    )
    const unread = fixture({ 'tsconfig.base.json/placeholder.txt': '', ...aliased })
    expect(thrownBy(() => checkBrowserSafe(unread, ['src/top.ts']))?.message).toBe(
      `cannot read tsconfig.base.json (EISDIR) ${UNCHECKED}`,
    )
  })

  it('refuses a module argument that is a directory, pointing at the survey that reads one', () => {
    const root = fixture({ 'src/a.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a" })
    const result = cli('--root', root, 'src')
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(
      'check-browser-safe: src is a directory, not a module — `--survey src` checks every module under it\n',
    )
    expect(result.stdout).toBe('')
  })

  it('refuses a survey with a directory in it that it cannot list', (context) => {
    const root = fixture({
      'src/kernel/a.ts': 'export const a = 1',
      'src/kernel/closed/b.ts': "import { b } from '@tauri-apps/api/core'\nexport const x = b",
    })
    sealed(context, join(root, 'src/kernel/closed'), () => {
      const result = cli('--root', root, '--survey', 'src/kernel')
      expect(result.status).toBe(2)
      expect(result.stderr).toBe(`check-browser-safe: cannot read src/kernel/closed (EACCES) ${UNCHECKED}\n`)
      expect(result.stdout).toBe('')
    })
  })

  /* Through the command, a module it cannot read is exit 2 and its words —
     not the "0 blocked" it used to print over it. */
  it('exits 2 naming a module it cannot read, and prints no count', () => {
    const root = fixture({ 'leaf.ts/placeholder.txt': '', 'top.ts': "import { x } from './leaf'\nexport const y = x" })
    const result = cli('--root', root, 'top.ts')
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(`check-browser-safe: cannot read leaf.ts (EISDIR) ${UNCHECKED}\n`)
    expect(result.stdout).toBe('')
  })
})

/**
 * ⚠️ **ONLY A TRAILING STAR WAS EVER READ, AND EVERY OTHER SHAPE WAS MISREAD
 * WITHOUT A WORD.** `tsconfig.base.json` declares two kinds of alias — `@/*` →
 * `src/*`, and the exact `virtual:paper-composition` → one file — and the walk
 * read the exact kind as a PREFIX. A star anywhere but last stayed a literal
 * `*` that matched nothing, and a `prefix*` mapped onto a file had the rest of
 * the specifier appended to that file. Found 2026-09-14 through the mutants the
 * one alias case above could not kill.
 */
describe('the aliases tsconfig.base.json declares', () => {
  const tsconfig = (paths) => JSON.stringify({ compilerOptions: { paths } })

  /* NO `baseUrl`, which TypeScript does not require: a target is then read from
     the directory the file is in, which is the root. */
  it('follows an exact alias for the one specifier it names, and no further', () => {
    const root = fixture({
      'tsconfig.base.json': tsconfig({ '#ui/': ['src/ui'] }),
      'src/ui/index.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'src/ui/platform.ts': "import { b } from '@tauri-apps/plugin-fs'\nexport const y = b",
      'src/panel.ts': "import { x } from '#ui/'\nexport const p = x",
      'src/view.ts': "import { y } from '#ui/platform'\nexport const v = y",
    })
    expect(blockedFiles(root, 'src/panel.ts')).toEqual(['src/ui/index.ts'])
    expect(blockedFiles(root, 'src/view.ts')).toEqual([])
  })

  it('applies an alias only to the specifiers under its own prefix', () => {
    const root = fixture({
      'tsconfig.base.json': tsconfig({ '@/*': ['src/*'], '#/*': ['lib/*'] }),
      'src/leaf.ts': "import { a } from '@tauri-apps/api/core'\nexport const x = a",
      'lib/leaf.ts': 'export const x = 1',
      'lib/top.ts': "import { x } from '#/leaf'\nexport const y = x",
    })
    const { blockers, modules } = blockersOf(root, 'lib/top.ts')
    expect({ blocked: [...blockers.keys()], modules }).toEqual({ blocked: [], modules: 2 })
  })

  it('refuses an alias of any other shape, naming it, rather than misreading it', () => {
    for (const [pattern, targets] of [
      ['@/*/x', ['src/*/x']],
      ['@/**', ['src/**']],
      ['@/*', ['src/*', 'lib/index.ts']],
      ['#leaf', ['src/*']],
    ]) {
      const root = fixture({ 'tsconfig.base.json': tsconfig({ [pattern]: targets }), 'a.ts': 'export const a = 1' })
      const cause = thrownBy(() => checkBrowserSafe(root, ['a.ts']))
      expect(cause, pattern).toBeInstanceOf(Error)
      expect(cause.message).toBe(
        `tsconfig.base.json maps ${JSON.stringify(pattern)} to ${JSON.stringify(targets)}, which this gate cannot follow — ` +
          'it reads an exact name and `prefix*` → `dir*`, and an alias it misread would be an edge it could not see',
      )
    }
  })

  /* Comment lines are taken out and the rest PUT BACK AS LINES. Run together, a
     string broken over two lines — not JSON, and refused by TypeScript — would
     read as one that is whole. */
  it('reads the file line by line as written, so a string broken over two lines is refused', () => {
    const root = fixture({
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@/*": ["src/\n*"] } } }\n',
      'a.ts': 'export const a = 1',
    })
    const cause = thrownBy(() => checkBrowserSafe(root, ['a.ts']))
    expect(cause).toBeInstanceOf(Error)
    expect(cause.message).toBe(
      'tsconfig.base.json does not parse as JSON with line comments, so every import through one of its `paths` would go unseen',
    )
  })
})
