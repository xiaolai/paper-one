import { describe, expect, it } from 'vitest'
import { hiddenLoads, runtimeSpecifiers } from './specifiers.mjs'

/**
 * The one reading of an import that both `check-browser-safe` and
 * `check-mutants` share.
 *
 * These cases were `check-browser-safe.test.mjs`'s own until 2026-09-14, when
 * the reader moved here: it belongs to neither gate, and a reader's cases kept
 * beside one of its callers are deleted with that caller. Each gate keeps the
 * cases that go through its OWN use of it — the walk, the covering tests.
 */

/** What a module named `fileName` loads — a `.tsx` unless the case says. */
const read = (source, fileName = 'module.tsx') => [...runtimeSpecifiers(source, fileName)]

describe('runtimeSpecifiers — comments and strings, which a regex cannot tell apart', () => {
  /* The old detector stripped comments with regexes and then matched `from
     '…'`. Both halves were wrong, in opposite directions, and these are the
     four shapes that show it. It parses now. */

  it('ignores a package named in a block comment', () => {
    expect(read("/* it does not import @tauri-apps/plugin-fs */\nconst a = 1")).toEqual([])
  })

  it('ignores an import written out inside a line comment', () => {
    expect(read("// import x from '@tauri-apps/api'\nconst a = 1")).toEqual([])
  })

  it('ignores a trailing comment without losing the code before it', () => {
    expect(read("import { a } from './a' // see '@tauri-apps/api'")).toEqual(['./a'])
  })

  /**
   * A REGEX LITERAL CONTAINING `//` IS NOT A COMMENT, and the stripper thought
   * it was — so everything after it on the line vanished, including a real
   * import. A blocked module read as clean, which is the direction that
   * matters.
   */
  it('is not truncated by a regex literal that contains a comment marker', () => {
    const source = "const web = /https?:\\/\\//; import fs from '@tauri-apps/plugin-fs'"
    expect(read(source)).toEqual(['@tauri-apps/plugin-fs'])
  })

  /**
   * AND AN ORDINARY STRING IS NOT AN IMPORT. `bookVault.ts` names the package
   * three times in prose to say it does NOT import it; the matcher counted
   * every one. A clean module read as blocked.
   */
  it('is not fooled by a string that merely contains an import', () => {
    const source = "const note = \"from '@tauri-apps/api/core'\"\nconst also = `from '@tauri-apps/plugin-fs'`"
    expect(read(source)).toEqual([])
  })

  it('is not fooled by a URL, which contains its own //', () => {
    expect(read('const url = "https://example.com/x"')).toEqual([])
  })
})

describe('runtimeSpecifiers', () => {
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
    expect(read(source)).toEqual(['@tauri-apps/plugin-fs'])
  })

  it('finds a dynamic import', () => {
    expect(read("const m = await import('./pdfRange')")).toEqual(['./pdfRange'])
  })

  it('finds a side-effect import', () => {
    expect(read("import './entry.css'")).toEqual(['./entry.css'])
  })

  it('finds a re-export', () => {
    expect(read("export { x } from './x'")).toEqual(['./x'])
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
    expect(read("import type { A } from '@tauri-apps/api'")).toEqual([])
    expect(read("export type { A } from '@tauri-apps/api'")).toEqual([])
  })

  /* …but a MIXED clause still needs the module at runtime for its value half. */
  it('keeps an import whose clause is only partly type-only', () => {
    expect(read("import { type A, b } from './a'")).toEqual(['./a'])
  })

  it('finds several on one line', () => {
    expect(read("import a from './a'; import b from './b'").sort()).toEqual(['./a', './b'])
  })

  /* `Array.from(` is not an import, and a scan keyed on `from` has to not
     think it is. */
  it('is not fooled by Array.from', () => {
    expect(read('const xs = Array.from(new Set(ys))')).toEqual([])
  })

  /* AND NEITHER IS AN ORDINARY CALL HANDED A PATH. `import(…)` parses as a call
     expression like any other, so the `import` keyword is the whole of what
     tells it from `load('./later')` — and a reader that counted every call
     taking a path would claim an edge nothing loads. */
  it('is not fooled by a call that is handed a path', () => {
    expect(read("const m = load('./later')")).toEqual([])
  })

  /* An `import()` with no specifier is not valid JavaScript, and the parser
     recovers rather than refusing the file — so the reader answers for the rest
     of it instead of throwing on a call with no argument to read. */
  it('claims nothing from an import with no specifier, and keeps reading', () => {
    expect(read("const m = await import()\nimport a from './a'")).toEqual(['./a'])
  })

  /* ⚠️ THE TWO CLAUSES BOTH GATES READ WRONG UNTIL 2026-09-13. A template names
     its module as plainly as a quote does; `import type x = require(…)` is
     erased whole. `check-mutants` fixed its copy and `check-browser-safe` kept
     the old one — which is why there is one reading now. */
  it('finds a dynamic import written as a template with nothing substituted into it', () => {
    expect(read('const m = await import(`./later`)')).toEqual(['./later'])
  })

  /* ⚠️ A SPECIFIER IN PARENTHESES WAS NO SPECIFIER AT ALL. `import(('./x'))`
     loads `./x` exactly as `import('./x')` does — the parentheses evaluate to
     the same string — and only a bare literal counted, so the edge was
     invisible to both gates: a browser dependency hidden from one, a covering
     test not counted by the other. `as`, `satisfies`, `!` and `<T>` are the
     same case one step along: each is erased before anything runs, so none can
     change which module loads. Found by review on 2026-09-14; nothing in the
     tree is spelt this way today, which is how it went unnoticed. */
  it('reads a dynamic import through parentheses and the type-only wrappers the emit erases', () => {
    expect(read("const m = await import(('./x'))")).toEqual(['./x'])
    expect(read('const m = await import(((`./y`)))')).toEqual(['./y'])
    expect(read("const m = await import('./as' as string)")).toEqual(['./as'])
    expect(read("const m = await import(('./sat') satisfies string)")).toEqual(['./sat'])
    expect(read("const m = await import('./bang'!)")).toEqual(['./bang'])
    expect(read("const m = await import(<string>'./cast')", 'cast.ts')).toEqual(['./cast'])
    /* Unwrapped, a value that names no single module still claims none. */
    expect(read('const m = await import((`./pages/${name}`))')).toEqual([])
    expect(read("const m = await import((flag ? './a' : './b'))")).toEqual([])
  })

  it('skips a type-only import-equals, and keeps one that runs', () => {
    expect(read("import type fs = require('@tauri-apps/plugin-fs')")).toEqual([])
    expect(read("import fs = require('./fs')")).toEqual(['./fs'])
  })

  /* Nothing to resolve, so nothing is claimed: a template WITH a substitution
     names no single module, an import-equals of a namespace names none at all,
     and an export with no `from` re-exports a local. */
  it('claims no module where the syntax names none', () => {
    expect(read('const m = await import(`./pages/${name}`)')).toEqual([])
    expect(read('import Inner = Outer.Inner')).toEqual([])
    expect(read('const a = 1\nexport { a }')).toEqual([])
  })

  /* The file name decides the dialect. `<number>(x)` is a cast in `.ts` and an
     unclosed element in `.tsx`, and the `.tsx` reading recovers by swallowing
     the import after it — measured, so a reader that ignored the name would
     lose this edge. */
  it('reads the dialect its file name gives it', () => {
    expect(read("const n = <number>(x)\nimport a from './a'", 'cast.ts')).toEqual(['./a'])
  })
})

/** How a module named `fileName` loads code that no static import graph shows — a `.ts` unless the case says. */
const hidden = (source, fileName = 'module.ts') => hiddenLoads(source, fileName)

/**
 * ⚠️ **WHAT NO IMPORT GRAPH CAN FOLLOW, NAMED RATHER THAN SKIPPED.**
 * `runtimeSpecifiers` answers a computed `import(where)` with nothing — there is
 * no single module to name — and so does Vitest's `related` filter, which drops
 * a test that reaches its subject only that way. The mutation gate cannot see
 * where such a load lands, so it records that one is there; these are the
 * shapes it recognises.
 */
describe('hiddenLoads', () => {
  it('finds nothing hidden in the loads an import graph does show', () => {
    expect(
      hidden(
        "import a from './a'\nexport { b } from './b'\nconst c = await import('./c')\nconst d = await import(`./d`)\n" +
          "const e = await import(('./e'))",
      ),
    ).toEqual([])
  })

  it('names a dynamic import whose path is computed', () => {
    expect(hidden("const where = './a'\nconst m = await import(where)")).toEqual(['a computed import()'])
    expect(hidden('const m = await import(`./pages/${name}`)')).toEqual(['a computed import()'])
    expect(hidden("const m = await import(flag ? './a' : './b')")).toEqual(['a computed import()'])
  })

  /* CommonJS never enters Vite's graph at all, so a `require` of a path is hidden
     however literal it is — while one of a builtin or a package cannot land in
     the checkout's own code. */
  it('names a require of a path or of a computed value, and not one of a builtin or a package', () => {
    expect(hidden("const a = require('./a')\nconst b = require('../b.cjs')\nconst c = require('/abs/c.js')")).toEqual([
      "require('./a')",
      "require('../b.cjs')",
      "require('/abs/c.js')",
    ])
    expect(hidden('const d = require(name)')).toEqual(['a computed require()'])
    expect(hidden("const fs = require('node:fs')\nconst p = require('path')\nconst r = require('react')\nconst s = require('@scope/pkg/x')")).toEqual([])
  })

  it('names a require made by createRequire, which may load anything under any name', () => {
    expect(hidden("import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)")).toEqual([
      'createRequire()',
    ])
  })

  /**
   * ⚠️ **`createRequire(x).resolve(y)` LOADS NOTHING, AND FLAGGING IT COST THE
   * MERGE-BASE GATE ITS REACH** (2026-09-20). `resolve` answers where a package
   * is; the rule matched the callee's NAME and so made every module holding one
   * a route no static graph can follow. `check-mutants.mjs` records such routes
   * per subject, and the base offers every test for every subject, so one
   * `.resolve` of a package put its file into every subject's evidence — and
   * changing that file then refused every base measurement in a sweep.
   *
   * The line is the one `require` already draws two rules up: a BARE package
   * specifier reaches a package and never a file in the checkout. Everything
   * else about a `createRequire` stays hidden, the catch-all included — a
   * require function kept under a name can load anything, and the name it is
   * called by is not one this can match.
   */
  it('does not name a createRequire immediately resolved on a bare package', () => {
    expect(hidden("import { createRequire } from 'node:module'\nconst at = createRequire(import.meta.url).resolve('@stryker-mutator/core')")).toEqual([])
  })

  it('still names one resolved on a PATH, which answers a file in the project', () => {
    for (const spec of ['./local.mjs', '../up.mjs', '/abs.mjs']) {
      expect(
        hidden(`import { createRequire } from 'node:module'\nconst at = createRequire(import.meta.url).resolve('${spec}')`),
        spec,
      ).toEqual(['createRequire()'])
    }
  })

  it('still names one whose specifier is not spelled out, and one resolved later', () => {
    /* A specifier this cannot read could name anything, and a `resolve` reached
       through a variable is the catch-all case the rule above is carved out of. */
    expect(hidden("import { createRequire } from 'node:module'\nconst at = createRequire(import.meta.url).resolve(wherever)")).toEqual([
      'createRequire()',
    ])
    expect(hidden("import { createRequire } from 'node:module'\nconst req = createRequire(import.meta.url)\nconst at = req.resolve('pkg')")).toEqual([
      'createRequire()',
    ])
  })

  it('still names one whose result is CALLED rather than resolved, under any name', () => {
    expect(hidden("import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nload('./thing')")).toEqual([
      'createRequire()',
    ])
    expect(hidden("import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('pkg')")).toEqual(['createRequire()'])
  })

  it("names Vitest's own runtime loads", () => {
    expect(hidden("const a = await vi.importActual('./a')\nconst b = await vi.importMock('./b')")).toEqual([
      "vi.importActual('./a')",
      "vi.importMock('./b')",
    ])
    expect(hidden('const a = await vi.importActual(where)')).toEqual(['vi.importActual()'])
  })

  /* `vi` is Vitest's own object; the same method on anything else, or another
     member of `vi`, loads nothing of a module's. */
  it('names neither the same method on another object nor another member of vi', () => {
    expect(
      hidden(
        "importActual('./a')\nmock.importActual('./a')\nthe.vi.importMock('./b')\nvi.mock('./c')\nvi.fn()\n" +
          "const u = new URL('./d', import.meta.url)\nconst m = new Map()\nconst v = new vm.Context()",
      ),
    ).toEqual([])
  })

  it('names code run from text', () => {
    expect(
      hidden(
        "eval('1')\nconst f = new Function('return 1')\nvm.runInNewContext(code)\nvm.runInContext(code, box)\n" +
          'runInThisContext(code)\nconst s = new vm.Script(code)\nconst g = vm.compileFunction(code)',
      ),
    ).toEqual(['eval()', 'new Function()', 'runInNewContext()', 'runInContext()', 'runInThisContext()', 'new Script()', 'compileFunction()'])
  })

  /* A call with no argument has nothing to read a path from: a `require()` of
     nothing names no module, which is as computed as a load gets. */
  it('reads a call with no argument without tripping on it', () => {
    expect(hidden('run()\nconst r = require()\nsetup()')).toEqual(['a computed require()'])
  })

  it('is not fooled by the same words in a comment or a string', () => {
    expect(hidden("// await import(where), require('./a'), eval(x)\nconst note = \"require('./b') and new Function()\"")).toEqual([])
  })

  it('reads the dialect its file name gives it', () => {
    expect(hidden("const n = <number>(x)\nconst m = await import(where)", 'cast.ts')).toEqual(['a computed import()'])
  })
})

