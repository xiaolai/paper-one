import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PINNED,
  PLATFORM_PREFIX,
  blockersOf,
  checkBrowserSafe,
  specifiersIn,
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
})

describe('specifiersIn — comments and strings, which a regex cannot tell apart', () => {
  /* The old detector stripped comments with regexes and then matched `from
     '…'`. Both halves were wrong, in opposite directions, and these are the
     four shapes that show it. It parses now. */

  it('ignores a package named in a block comment', () => {
    expect([...specifiersIn("/* it does not import @tauri-apps/plugin-fs */\nconst a = 1")]).toEqual([])
  })

  it('ignores an import written out inside a line comment', () => {
    expect([...specifiersIn("// import x from '@tauri-apps/api'\nconst a = 1")]).toEqual([])
  })

  it('ignores a trailing comment without losing the code before it', () => {
    expect([...specifiersIn("import { a } from './a' // see '@tauri-apps/api'")]).toEqual(['./a'])
  })

  /**
   * A REGEX LITERAL CONTAINING `//` IS NOT A COMMENT, and the stripper thought
   * it was — so everything after it on the line vanished, including a real
   * import. A blocked module read as clean, which is the direction that
   * matters.
   */
  it('is not truncated by a regex literal that contains a comment marker', () => {
    const source = "const web = /https?:\\/\\//; import fs from '@tauri-apps/plugin-fs'"
    expect([...specifiersIn(source)]).toEqual(['@tauri-apps/plugin-fs'])
  })

  /**
   * AND AN ORDINARY STRING IS NOT AN IMPORT. `bookVault.ts` names the package
   * three times in prose to say it does NOT import it; the matcher counted
   * every one. A clean module read as blocked.
   */
  it('is not fooled by a string that merely contains an import', () => {
    const source = "const note = \"from '@tauri-apps/api/core'\"\nconst also = `from '@tauri-apps/plugin-fs'`"
    expect([...specifiersIn(source)]).toEqual([])
  })

  it('is not fooled by a URL, which contains its own //', () => {
    expect([...specifiersIn('const url = "https://example.com/x"')]).toEqual([])
  })
})

describe('specifiersIn', () => {
  /**
   * THE MULTI-LINE CASE, which is the bug that made this gate lie.
   *
   * A clause-matching regex with `[^\n]` between `import` and `from` finds
   * nothing here, and `vaultFsTauri.ts` — whose import is exactly this shape —
   * came back clean.
   */
  it('finds an import wrapped over many lines', () => {
    const source = `import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs'`
    expect([...specifiersIn(source)]).toEqual(['@tauri-apps/plugin-fs'])
  })

  it('finds a dynamic import', () => {
    expect([...specifiersIn("const m = await import('./pdfRange')")]).toEqual(['./pdfRange'])
  })

  it('finds a side-effect import', () => {
    expect([...specifiersIn("import './entry.css'")]).toEqual(['./entry.css'])
  })

  it('finds a re-export', () => {
    expect([...specifiersIn("export { x } from './x'")]).toEqual(['./x'])
  })

  /**
   * A TYPE-ONLY IMPORT IS NOT AN IMPORT, and counting it was a false BLOCK.
   *
   * TypeScript erases `import type` entirely, so a type-only edge to
   * `@tauri-apps` puts no platform code in any bundle. The old scan reported
   * it, which would have refused a module that ships nothing — and the fix for
   * that refusal would have been to delete a type, or to add the module to the
   * pinned list, both of which are worse than the edge.
   */
  it('skips a type-only import, which is erased before anything runs', () => {
    expect([...specifiersIn("import type { A } from '@tauri-apps/api'")]).toEqual([])
    expect([...specifiersIn("export type { A } from '@tauri-apps/api'")]).toEqual([])
  })

  /* …but a MIXED clause still needs the module at runtime for its value half. */
  it('keeps an import whose clause is only partly type-only', () => {
    expect([...specifiersIn("import { type A, b } from './a'")]).toEqual(['./a'])
  })

  it('finds several on one line', () => {
    const found = specifiersIn("import a from './a'; import b from './b'")
    expect([...found].sort()).toEqual(['./a', './b'])
  })

  /* `Array.from(` is not an import, and a scan keyed on `from` has to not
     think it is. */
  it('is not fooled by Array.from', () => {
    expect([...specifiersIn('const xs = Array.from(new Set(ys))')]).toEqual([])
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
  const SCRIPT = fileURLToPath(new URL('./check-browser-safe.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

  it('refuses a survey of a root that does not exist', () => {
    const result = run('--root', join(tmpdir(), 'paper-no-such-root'), '--survey', 'src/kernel')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('not a directory')
  })

  it('refuses a survey of a directory that does not exist under a real root', () => {
    const result = run('--root', fixture({ 'a.ts': '' }), '--survey', 'src/nowhere')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('not a directory')
  })

  it('refuses a survey that found no sources at all', () => {
    /* A directory that exists and holds nothing this gate can read. "0 blocked"
       over an empty scan is the answer that started all of this. */
    const root = fixture({ 'src/kernel/README.md': 'not a module' })
    const result = run('--root', root, '--survey', 'src/kernel')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('a survey of nothing is not a clean survey')
  })

  it('surveys a real tree and exits 0', () => {
    const root = fixture({ 'src/kernel/a.ts': "export const a = 1" })
    const result = run('--root', root, '--survey', 'src/kernel')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('1 browser-safe')
  })
})
