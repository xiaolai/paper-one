import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PINNED,
  PLATFORM_PREFIX,
  blockersOf,
  checkBrowserSafe,
  specifiersIn,
  stripComments,
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
    for (const report of checkBrowserSafe(process.cwd(), [...PINNED])) {
      expect({ module: report.module, missing: report.missing, blockers: report.blockers }).toEqual({
        module: report.module,
        missing: false,
        blockers: [],
      })
    }
  })

  it('pins modules that exist', () => {
    for (const report of checkBrowserSafe(process.cwd(), [...PINNED])) {
      expect(report.missing).toBe(false)
      expect(report.modules).toBeGreaterThan(0)
    }
  })
})

describe('stripComments', () => {
  it('removes a block comment that names the platform', () => {
    expect(stripComments("/* it does not import @tauri-apps/plugin-fs */\nconst a = 1")).not.toMatch(
      /@tauri-apps/,
    )
  })

  it('removes a line comment', () => {
    expect(stripComments("// import x from '@tauri-apps/api'\nconst a = 1")).not.toMatch(/@tauri-apps/)
  })

  /* NOT `\/\/.*$`. That eats the `//` in a URL and truncates whatever follows
     on the line — including, in a doc comment, the sentence that matters. */
  it('leaves a URL alone', () => {
    expect(stripComments('const url = "https://example.com/x"')).toContain('https://example.com/x')
  })

  it('removes a trailing comment without eating the code before it', () => {
    const out = stripComments("import { a } from './a' // see '@tauri-apps/api'")
    expect(out).toContain("from './a'")
    expect(out).not.toMatch(/@tauri-apps/)
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

  it('finds a type-only import', () => {
    expect([...specifiersIn("import type { A } from './a'")]).toEqual(['./a'])
  })

  it('finds several on one line', () => {
    const found = specifiersIn("import a from './a'; import b from './b'")
    expect([...found].sort()).toEqual(['./a', './b'])
  })

  /* `Array.from(` is not an import, and a scan keyed on `from` has to not
     think it is. The quote is what distinguishes them. */
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
    expect(blockedFiles(root, 'top.ts')).toEqual([join('pkg', 'index.ts')])
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
