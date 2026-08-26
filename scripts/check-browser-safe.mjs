#!/usr/bin/env node
/**
 * What stops a module reaching a browser.
 *
 * `node scripts/check-browser-safe.mjs [module...]`
 *
 * With no arguments it checks `PINNED` — the modules this repository has
 * deliberately made browser-safe — and fails when one of them acquires a
 * `@tauri-apps` import anywhere in its transitive closure. With arguments it
 * answers the same question for those modules and exits non-zero if any is
 * blocked, so it reads as an assertion in a plan's acceptance line.
 *
 * # Why this exists
 *
 * The browser client hand-rolls a UI the kernel already has. The reason given
 * was that the kernel is Tauri-bound — and when it was finally MEASURED, 94 of
 * 109 modules under `src/kernel/ui/` had no `@tauri-apps` import anywhere in
 * their closure, and the public entry `src/kernel/index.ts` was blocked by
 * exactly one module. The fence was mostly imaginary and nobody could see that,
 * because nothing could answer the question.
 *
 * The recurring defect underneath is worth naming, because this repository has
 * now hit it four times — `extensionFor`, `sizePortOver`, `inTauri`,
 * `decideLookUp`:
 *
 * > **A pure function sharing a module with a platform binding takes the whole
 * > subtree down with it.** The import graph does not care that nobody calls
 * > the binding.
 *
 * `bookVault.ts`'s docstring tells that story for the first instance. This gate
 * is the third fix generalised, so the fourth is caught rather than discovered.
 *
 * # ⚠️ Two bugs this instrument had before it worked
 *
 * Both are recorded because both produced CONFIDENT WRONG ANSWERS, and a
 * detector that is quietly wrong is worse than none.
 *
 * 1. **A match anywhere in the file counts doc comments.** `bookVault.ts` names
 *    `@tauri-apps` three times to explain that it does NOT import it, and was
 *    reported as Tauri-bound. Comments are stripped first.
 * 2. **A regex that forbids newlines misses every multi-line import.** A
 *    six-symbol `import { … } from '@tauri-apps/plugin-fs'` spread over eight
 *    lines matched nothing, and the Tauri binding itself came back clean. The
 *    scan now keys on `from '…'` alone, which needs no preceding clause and so
 *    cannot be defeated by how the import is wrapped.
 *
 * `check-browser-safe.test.mjs` asserts a KNOWN POSITIVE for exactly this
 * reason: a detector that finds nothing looks identical to a clean result.
 *
 * Exit 0 when everything checked is browser-safe, 1 on a blocker, 2 on a usage
 * error.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-browser-safe.mjs [--root <dir>] [module...]'

/** The package prefix that cannot exist in a browser. */
export const PLATFORM_PREFIX = '@tauri-apps'

/**
 * Modules that MUST stay reachable from a browser.
 *
 * This list is the whole point of the gate. Each entry was made browser-safe on
 * purpose and would be re-broken by one careless import — silently, because
 * nothing else in the build says a word about it until `assert-bundle` refuses
 * a bundle for reasons that read as unrelated.
 *
 * Add an entry when a module is deliberately freed, never to record that one
 * happens to be clean today.
 */
export const PINNED = Object.freeze([
  /* THE PUBLIC ENTRY. Freed in WI-19.1 by splitting `bookSizesTauri.ts` out of
   * `bookSizes.ts`; one re-export of `tauriSizePort` was the only thing making
   * all 54 of its modules unreachable from a browser, and a bespoke
   * dependency-cruiser rule existed to route around it. This is the pin that
   * rule was replaced BY — put a platform-bound export back on the barrel and
   * this fails, loudly, in milliseconds. */
  'src/kernel/index.ts',
  /* THE BROWSER UI ENTRY (WI-19.4). Every export on it must be browser-safe,
   * and this pin is what makes that a gate rather than an intention — the
   * entry's whole purpose is to be the door a browser client can trust. */
  'src/kernel/ui/browser.ts',

  /* The client's two existing reaches into the kernel. */
  'src/kernel/core/metrics.ts',
  'src/kernel/core/envelope.ts',
  /* The reading surface. Freed in phase 18 by splitting `tauriVaultFs` out of
   * `bookVault.ts`; the whole subtree hangs off this one. */
  'src/kernel/ui/reader/FoliateView.tsx',
  /* The UI state machine — the reducer and the pane model. */
  'src/kernel/ui/state.ts',
  'src/kernel/ui/panes.ts',
  /* THE READING SURFACE ITSELF, eighty modules, freed in WI-19.3. It was held
   * out of a browser by one `invoke` opening macOS Dictionary.app — a control
   * that is absent off macOS anyway. */
  'src/kernel/ui/screens/Reader.tsx',
  /* `inTauri` is a two-line `window` check and MUST stay answerable without a
   * filesystem: the modules that ask it are the ones that cannot assume one. */
  'src/kernel/ui/inTauri.ts',
  'src/kernel/ui/lookUp.ts',
])

/** Strip comments, so prose naming a package is not read as importing it. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    /* NOT `\/\/.*$` — that eats the `//` in `https://` and truncates a line
     * whose real import sits after a URL in a trailing note. */
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Every module specifier a file imports.
 *
 * Keyed on `from '…'`, `import '…'` and `import('…')` rather than on the whole
 * import statement. A specifier can only appear in those three shapes, and none
 * of them needs the preceding clause — which is what makes this immune to how
 * an import is wrapped across lines. See the header for what the clause-matching
 * version missed.
 */
export function specifiersIn(source) {
  const text = stripComments(source)
  const found = new Set()
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(?\s*['"]([^'"]+)['"]/g]) {
    for (const m of text.matchAll(re)) found.add(m[1])
  }
  return found
}

/** Resolve a relative specifier to a file on disk, or null. */
function resolveModule(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx', base]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * What blocks `entry` from a browser, and how it is reached.
 *
 * Returns the modules in the closure and a map of blocking file → the packages
 * it imports. The map is empty for a browser-safe module.
 */
export function blockersOf(root, entry) {
  const start = path.resolve(root, entry)
  const seen = new Set()
  const blockers = new Map()
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return // a specifier that resolves to nothing blocks nothing
    }
    for (const spec of specifiersIn(source)) {
      if (spec.startsWith(PLATFORM_PREFIX)) {
        const rel = path.relative(root, file)
        if (!blockers.has(rel)) blockers.set(rel, new Set())
        blockers.get(rel).add(spec)
      }
      const next = resolveModule(file, spec)
      if (next !== null) walk(next)
    }
  }
  if (!existsSync(start)) return { modules: 0, blockers, missing: true }
  walk(start)
  return { modules: seen.size, blockers, missing: false }
}

/** Every `.ts`/`.tsx` under `dir` that is not a test. */
export function sourcesUnder(root, dir) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.join(rel, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(child)
    }
  }
  walk(dir)
  return out.sort()
}

/** Check a list of modules. Returns one report per module. */
export function checkBrowserSafe(root, modules) {
  return modules.map((module) => {
    const { modules: count, blockers, missing } = blockersOf(root, module)
    return {
      module,
      missing,
      modules: count,
      blockers: [...blockers].map(([file, pkgs]) => ({ file, packages: [...pkgs].sort() })),
    }
  })
}

function main(argv) {
  let root = REPO_ROOT
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[++i]
      if (value === undefined) {
        console.error(USAGE)
        return 2
      }
      root = path.resolve(value)
    } else if (argv[i] === '--survey') {
      /* Every module under a directory, grouped by cause. How the nine leaves
       * were found in the first place; kept so the next survey is one command
       * rather than a throwaway script written under time pressure. */
      const dir = argv[++i] ?? 'src/kernel'
      const causes = new Map()
      let clean = 0
      for (const file of sourcesUnder(root, dir)) {
        const { blockers } = blockersOf(root, file)
        if (blockers.size === 0) {
          clean += 1
          continue
        }
        const key = [...blockers.keys()].sort().join(' + ')
        if (!causes.has(key)) causes.set(key, [])
        causes.get(key).push(file)
      }
      console.log(`${dir}: ${clean} browser-safe, ${[...causes.values()].flat().length} blocked`)
      for (const [cause, list] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`\n  ${cause}`)
        for (const f of list) console.log(`    ${f}`)
      }
      return 0
    } else rest.push(argv[i])
  }

  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory')
  } catch {
    console.error(`check-browser-safe: ${root} is not a directory`)
    return 2
  }

  const modules = rest.length > 0 ? rest : PINNED
  const pinned = rest.length === 0
  const reports = checkBrowserSafe(root, modules)

  let failed = 0
  for (const report of reports) {
    if (report.missing) {
      /* A PINNED MODULE THAT MOVED IS A FINDING, not a pass. Skipping it
       * silently is how a pin stops guarding anything while still looking
       * green — the same shape as a scan that found no files. */
      console.log(`${report.module}  — MISSING (renamed or deleted?)`)
      failed += 1
      continue
    }
    if (report.blockers.length === 0) continue
    failed += 1
    console.log(`${report.module}  (${report.modules} modules)`)
    for (const b of report.blockers) console.log(`    ${b.file}  →  ${b.packages.join(', ')}`)
  }

  const scope = pinned ? `${modules.length} pinned` : `${modules.length}`
  console.log(`check-browser-safe: ${scope} module(s) checked, ${failed} blocked`)
  if (failed > 0) {
    console.log(
      `\nA module reaches ${PLATFORM_PREFIX} through the closure above, so it cannot be\n` +
        'bundled for a browser. Usually the cause is a pure value sharing a module\n' +
        'with a platform binding — split the binding into its own file, the way\n' +
        '`vaultFsTauri.ts` was split from `bookVault.ts`.',
    )
    return 1
  }
  return 0
}

if (isProcessEntry(import.meta)) process.exit(main(process.argv.slice(2)))
