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
 * `decideLookUp` (whose platform half, `hasDictionary`, has since been deleted
 * outright along with the system-dictionary hand-off — the fix outlived the
 * feature that needed it):
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
import ts from 'typescript'
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
/**
 * A module path as this repository spells one: forward slashes, always.
 *
 * `PINNED` below, every argument a caller passes and every line this prints
 * are written with `/`. `path.relative` and `path.join` answer in the HOST's
 * separator, so on Windows a blocked module came back as
 * `src\\kernel\\core\\vaultFsTauri.ts` and matched nothing in the list it
 * exists to check — the gate compared two spellings of the same module and
 * found a difference in the separator. Nothing on a Mac or a Linux box can
 * see it, because there the two spellings are identical.
 */
const toPosix = (p) => p.split(path.sep).join('/')

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
   * that was absent off macOS anyway, and that no longer exists at all. */
  'src/kernel/ui/screens/Reader.tsx',
  /* `inTauri` is a two-line `window` check and MUST stay answerable without a
   * filesystem: the modules that ask it are the ones that cannot assume one. */
  'src/kernel/ui/inTauri.ts',
  /* PURE BY CONSTRUCTION SINCE THE HAND-OFF WENT. This was freed by splitting
   * `lookUpTauri.ts` out of it; that file is now deleted with the command it
   * wrapped, so there is no binding left to split. The pin stays — it is what
   * makes putting one back loud. */
  'src/kernel/ui/lookUp.ts',
])

/**
 * Every module specifier a file imports, **parsed rather than matched**.
 *
 * ⚠️ **THIS WAS TWO REGEXES OVER A COMMENT-STRIPPED STRING, AND BOTH HALVES
 * WERE WRONG IN OPPOSITE DIRECTIONS.**
 *
 *   - The stripper was not JavaScript-aware. A regex literal containing `//`
 *     — `/https?:\/\//` — opened a line comment as far as it was concerned,
 *     and everything after it on that line disappeared, including a real
 *     import. A blocked module read as clean.
 *   - The matcher had no idea what a string was. An ordinary literal
 *     containing `from '@tauri-apps/api/core'` — this file's own header holds
 *     several, and `bookVault.ts` names the package three times to say it does
 *     NOT import it — counted as an import. A clean module read as blocked.
 *
 * The file's own header records that this detector "shipped two confident
 * wrong answers before it worked". These are the third and fourth, and they
 * share one cause: reading a language with a pattern instead of a parser.
 *
 * TYPE-ONLY IMPORTS ARE NOT IMPORTS. `import type { X } from '@tauri-apps/…'`
 * is erased before anything runs, so a type-only edge cannot put a platform
 * binding in a bundle. Counting it blocked a module that ships nothing.
 * Only `import type`/`export type` — the whole-clause form TypeScript always
 * erases — is skipped; a mixed `import { type A, B }` still needs the module
 * at runtime for `B`.
 */
export function specifiersIn(source, fileName = 'module.tsx') {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found = new Set()
  const add = (node) => {
    if (node && ts.isStringLiteral(node)) found.add(node.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      /* `import type …` is erased entirely; a bare `import '…'` (no clause) is
       * a side effect and very much runs. */
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(tree, visit)
  return found
}

/**
 * The repository's own `paths` aliases, read from `tsconfig.base.json`.
 *
 * ⚠️ `resolveModule` DISCARDED EVERY NON-RELATIVE SPECIFIER, which silently
 * included `@/…`. That alias is declared in `tsconfig.base.json` and resolves
 * to `src/*`, so an aliased path to a Tauri-bound module was a real edge this
 * walk could not see — and a pinned module reached one through it would have
 * passed. The aliases are read rather than restated so the two cannot drift.
 */
function aliases(root) {
  try {
    const raw = readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8')
    /* JSON with comments: strip them the safe way round — line comments only
     * at the start of a trimmed line, which is how this file writes them. */
    const json = JSON.parse(
      raw
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    )
    const options = json.compilerOptions ?? {}
    const base = path.resolve(root, options.baseUrl ?? '.')
    return Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
      prefix: pattern.replace(/\*$/u, ''),
      wildcard: pattern.endsWith('*'),
      targets: targets.map((t) => path.resolve(base, t.replace(/\*$/u, ''))),
    }))
  } catch {
    return []
  }
}

/** Resolve a specifier — relative or aliased — to a file on disk, or null. */
function resolveModule(fromFile, spec, aliasList = []) {
  const bases = []
  if (spec.startsWith('.')) {
    bases.push(path.resolve(path.dirname(fromFile), spec))
  } else {
    for (const alias of aliasList) {
      if (!spec.startsWith(alias.prefix)) continue
      const rest = alias.wildcard ? spec.slice(alias.prefix.length) : ''
      for (const target of alias.targets) bases.push(path.resolve(target + rest))
    }
  }
  for (const base of bases) {
    for (const candidate of [base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx', base]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * What blocks `entry` from a browser, and how it is reached.
 *
 * Returns the modules in the closure and a map of blocking file → the packages
 * it imports. The map is empty for a browser-safe module.
 */
export function blockersOf(root, entry, shared = null) {
  const start = path.resolve(root, entry)
  const seen = new Set()
  const blockers = new Map()
  const cache = shared ?? newWalkCache(root)
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    /* READ AND PARSED ONCE PER `checkBrowserSafe` CALL, not once per entry —
     * see `newWalkCache`. `seen` and `blockers` stay per-entry, because each
     * entry reports its OWN module count and its own blocking files. */
    const edges = cache.edgesOf(file)
    if (edges === null) return // a specifier that resolves to nothing blocks nothing
    for (const { spec, next } of edges) {
      if (spec.startsWith(PLATFORM_PREFIX)) {
        const rel = toPosix(path.relative(root, file))
        if (!blockers.has(rel)) blockers.set(rel, new Set())
        blockers.get(rel).add(spec)
      }
      if (next !== null) walk(next)
    }
  }
  if (!existsSync(start)) return { modules: 0, blockers, missing: true }
  walk(start)
  return { modules: seen.size, blockers, missing: false }
}

/**
 * One file's outgoing edges, read and parsed once and shared across entries.
 *
 * ⚠️ **THE TEN PINNED GRAPHS OVERLAP ALMOST ENTIRELY**, and this used to
 * re-walk each from scratch: `blockersOf` built a fresh `seen` per entry, so a
 * module reachable from several of them was read off disk and parsed once per
 * entry, and `aliases(root)` — which reads and parses `tsconfig.base.json` —
 * was recomputed for every one.
 *
 * That is why the gate's own test could exceed a 15 s `testTimeout` under
 * `--coverage` while taking 2 s standalone: `scripts/**` is in
 * `COVERAGE_INCLUDE`, so every one of those redundant parses ran instrumented.
 * The cost was real work, not a slow machine, and the fix is to stop doing it
 * rather than to raise the bound.
 *
 * ⚠️ **WHAT IS CACHED IS PURE, AND WHAT IS NOT IS NOT.** An edge list is a
 * function of the file's bytes and the alias table, both fixed for the
 * lifetime of one call. `seen`, `blockers` and `modules` are per-entry answers
 * and are deliberately NOT shared — sharing them would merge ten reports into
 * one and silently change what the gate says.
 *
 * The cache is per-call, never module-global: a long-lived one would go stale
 * against a tree the caller had edited between calls, which is exactly the
 * shape of bug a detector must not have.
 */
function newWalkCache(root) {
  const aliasList = aliases(root)
  const edges = new Map()
  return {
    edgesOf(file) {
      if (edges.has(file)) return edges.get(file)
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        edges.set(file, null)
        return null
      }
      /* `specifiersIn` returns a Set — spread it before mapping. */
      const out = [...specifiersIn(source, file)].map((spec) => ({
        spec,
        next: resolveModule(file, spec, aliasList),
      }))
      edges.set(file, out)
      return out
    },
  }
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
      const child = toPosix(path.join(rel, entry.name))
      if (entry.isDirectory()) walk(child)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(child)
    }
  }
  walk(dir)
  return out.sort()
}

/** Check a list of modules. Returns one report per module. */
export function checkBrowserSafe(root, modules) {
  /* ONE CACHE FOR THE WHOLE CALL — see `newWalkCache`. */
  const shared = newWalkCache(root)
  return modules.map((module) => {
    const { modules: count, blockers, missing } = blockersOf(root, module, shared)
    return {
      module,
      missing,
      modules: count,
      blockers: [...blockers].map(([file, pkgs]) => ({ file, packages: [...pkgs].sort() })),
    }
  })
}

/** Is `dir` a directory that exists? */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
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
      /* ⚠️ **A SURVEY THAT SCANNED NOTHING USED TO EXIT 0**, and printed
       * "0 browser-safe, 0 blocked" while doing it. The root validation below
       * runs after this branch returns, so `--root /nowhere --survey src/kernel`
       * was an authoritative-looking all-clear about a tree that does not
       * exist — the precise failure this file's header records twice. A
       * detector that finds nothing has to be distinguishable from one that
       * looked nowhere. */
      if (!isDirectory(root)) {
        console.error(`check-browser-safe: ${root} is not a directory`)
        return 2
      }
      if (!isDirectory(path.resolve(root, dir))) {
        console.error(`check-browser-safe: ${dir} is not a directory under ${root}`)
        return 2
      }
      const sources = sourcesUnder(root, dir)
      if (sources.length === 0) {
        console.error(
          `check-browser-safe: ${dir} holds no .ts/.tsx sources — a survey of nothing is not a clean survey`,
        )
        return 2
      }
      const causes = new Map()
      let clean = 0
      for (const file of sources) {
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

  if (!isDirectory(root)) {
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
