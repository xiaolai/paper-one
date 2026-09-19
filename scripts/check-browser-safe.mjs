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
 *    reported as Tauri-bound.
 * 2. **A regex that forbids newlines misses every multi-line import.** A
 *    six-symbol `import { … } from '@tauri-apps/plugin-fs'` spread over eight
 *    lines matched nothing, and the Tauri binding itself came back clean.
 *
 * ⚠️ **THIS SAID BOTH WERE FIXED BY STRIPPING COMMENTS AND KEYING ON
 * `from '…'` ALONE**, and those fixes were the third and fourth wrong answers —
 * a stripper that took a regex literal for a comment, a matcher that took a
 * string for an import. The module is PARSED now, by `runtimeSpecifiers` in
 * `scripts/lib/specifiers.mjs`, which `check-mutants` reads imports through as
 * well; that file carries the rest of the history, including the two clauses
 * this gate's own parse still misread until 2026-09-14.
 *
 * `check-browser-safe.test.mjs` asserts a KNOWN POSITIVE for exactly this
 * reason: a detector that finds nothing looks identical to a clean result.
 *
 * Exit 0 when everything checked is browser-safe, 1 on a blocker, 2 on a usage
 * error or on a path it could not read — a directory named as a module, a file
 * or directory it may not open, a `tsconfig.base.json` that does not parse or
 * that maps an alias in a shape this gate cannot follow. Until 2026-09-14 every
 * one of those was swallowed and read as clean; see `unchecked`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { hiddenLoads, runtimeSpecifiers } from './lib/specifiers.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-browser-safe.mjs [--root <dir>] [--survey [<dir>] | <module>...]'

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
])

/**
 * The repository's own `paths` aliases, read from `tsconfig.base.json`.
 *
 * ⚠️ `resolveModule` DISCARDED EVERY NON-RELATIVE SPECIFIER, which silently
 * included `@/…`. That alias is declared in `tsconfig.base.json` and resolves
 * to `src/*`, so an aliased path to a Tauri-bound module was a real edge this
 * walk could not see — and a pinned module reached one through it would have
 * passed. The aliases are read rather than restated so the two cannot drift.
 *
 * ⚠️ **AND A FILE IT COULD NOT READ OR PARSE WAS A TREE WITH NO ALIASES.** The
 * whole body sat in a `catch` answering `[]`, so a block comment or a trailing
 * comma added to `tsconfig.base.json` would have made every `@/…` edge
 * invisible without a word. Only ABSENCE means no aliases now — a fixture tree
 * has no such file — and anything else is refused. 2026-09-14.
 */
function aliases(root) {
  const file = path.join(root, 'tsconfig.base.json')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (cause) {
    // Stryker disable next-line ArrayDeclaration: an entry that is not an alias has no `wildcard` and no `prefix`, so `resolveModule` compares each specifier with `undefined` and follows none — no answer can differ
    if (cause.code === 'ENOENT') return []
    throw unchecked(root, file, cause)
  }
  let json
  try {
    /* JSON with comments: strip them the safe way round — line comments only
     * at the start of a trimmed line, which is how this file writes them. */
    json = JSON.parse(
      raw
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    )
  } catch {
    throw new Error(
      'tsconfig.base.json does not parse as JSON with line comments, so every import through one of its `paths` would go unseen',
    )
  }
  const options = json.compilerOptions ?? {}
  // Stryker disable next-line StringLiteral: `path.resolve` reads an empty segment as `.`, so either spelling is the root itself
  const base = path.resolve(root, options.baseUrl ?? '.')
  return Object.entries(options.paths ?? {}).map(([pattern, targets]) => {
    /* ⚠️ **ONLY A TRAILING STAR WAS EVER READ, AND EVERY OTHER SHAPE WAS
     * MISREAD WITHOUT A WORD.** An exact alias was matched as a PREFIX, so
     * `virtual:paper-compositionX` would have been followed to the desktop
     * composition; a star anywhere but last stayed a literal `*` that matched
     * nothing; and a `prefix*` mapped onto a file had the rest of the specifier
     * appended to that file. TypeScript reads none of those that way, and two of
     * the three hide an edge. An exact alias names one specifier now, `prefix*`
     * → `dir*` names a family, and any other shape is refused by name rather
     * than read wrong. 2026-09-14. */
    const wildcard = pattern.endsWith('*')
    const followed = (spelling) => spelling.indexOf('*') === (wildcard ? spelling.length - 1 : -1)
    if (![pattern, ...targets].every(followed)) {
      throw new Error(
        `tsconfig.base.json maps ${JSON.stringify(pattern)} to ${JSON.stringify(targets)}, which this gate cannot follow — ` +
          'it reads an exact name and `prefix*` → `dir*`, and an alias it misread would be an edge it could not see',
      )
    }
    return {
      prefix: wildcard ? pattern.slice(0, -1) : pattern,
      wildcard,
      targets: targets.map((target) => path.resolve(base, wildcard ? target.slice(0, -1) : target)),
    }
  })
}

/**
 * Resolve a specifier — relative or aliased — to a file on disk, or null.
 *
 * ⚠️ **THE ALIASES IT WAS HANDED RESOLVED TO NOTHING.** `path.resolve` drops a
 * trailing separator, so the target of `@/*` → `src/*` is `…/src`, and the
 * rest of the specifier was APPENDED to it: `@/leaf` was looked for at
 * `…/srcleaf`. Every aliased edge went unseen from the day the note on
 * `aliases` said they were followed. It is resolved against the target now.
 * Measured 2026-09-14 by the first test to import through one; nothing under
 * `src/` imports through `@/` yet, which is how it survived.
 */
function resolveModule(root, fromFile, spec, aliasList) {
  // Stryker disable next-line ArrayDeclaration: the one base that is not a path is a name no module has, looked for against the working directory — tried first, found absent, and every real base is tried after it
  const bases = []
  if (spec.startsWith('.')) {
    bases.push(path.resolve(path.dirname(fromFile), spec))
  } else {
    for (const alias of aliasList) {
      /* An exact alias names one specifier and only `prefix*` a family of them —
       * see `aliases` — so what an exact match leaves over is nothing. */
      if (alias.wildcard ? !spec.startsWith(alias.prefix) : spec !== alias.prefix) continue
      for (const target of alias.targets) bases.push(path.resolve(target, spec.slice(alias.prefix.length)))
    }
  }
  for (const base of bases) {
    /* ⚠️ **A DIRECTORY'S INDEX IS JOINED, NOT APPENDED WITH `/`.** `base` is
       `path.resolve`'s, in the host's separator, so on Windows `./pkg` found
       `…\pkg/index.ts` while `./pkg/index` found `…\pkg\index.ts` — one module
       under two names, walked and counted twice (2026-09-15). */
    for (const candidate of [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx'), base]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsAt(root, candidate)) return candidate
    }
  }
  return null
}

/**
 * Whether anything is at `candidate`.
 *
 * ⚠️ **`existsSync` ANSWERS `false` FOR A PATH IT CANNOT STAT**, so a module
 * behind a directory this user may not search was a module that did not exist
 * — its edge dropped, and every blocker past it with it. Only absence is
 * `false` here; any other failure is refused, naming the path.
 */
function existsAt(root, candidate) {
  try {
    statSync(candidate)
    return true
  } catch (cause) {
    if (isAbsence(cause)) return false
    throw unchecked(root, candidate, cause, 'look for')
  }
}

/** A stat that failed because nothing is there — the one failure that is an answer. */
const isAbsence = (cause) => cause.code === 'ENOENT' || cause.code === 'ENOTDIR'

/**
 * A path the walk could not check. Thrown, never answered as "nothing here":
 * a detector that could not look has to be distinguishable from one that found
 * nothing, and `main` turns this into exit 2 with these words.
 */
function unchecked(root, file, cause, doing = 'read') {
  return new Error(
    `cannot ${doing} ${toPosix(path.relative(root, file))} (${cause.code ?? String(cause)}) — ` +
      'nothing past it was checked, and a path this gate could not check is not a clean one',
  )
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
  /** file → the loads this gate cannot follow, so cannot clear. See `readEdges`. */
  const unprovable = new Map()
  const cache = shared ?? newWalkCache(root)
  const walk = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    /* READ AND PARSED ONCE PER `checkBrowserSafe` CALL, not once per entry —
     * see `newWalkCache`. `seen` and `blockers` stay per-entry, because each
     * entry reports its OWN module count and its own blocking files. */
    const edges = cache.edgesOf(file)
    /* AFTER `edgesOf`, which is the read that fills this. */
    const loads = cache.hiddenIn(file)
    if (loads.length > 0) unprovable.set(toPosix(path.relative(root, file)), loads)
    for (const { spec, next } of edges) {
      if (spec.startsWith(PLATFORM_PREFIX)) {
        const rel = toPosix(path.relative(root, file))
        if (!blockers.has(rel)) blockers.set(rel, new Set())
        blockers.get(rel).add(spec)
      }
      if (next !== null) walk(next)
    }
  }
  /* ⚠️ `existsSync` HERE TOO, after `existsAt` was written to replace it: an
     entry behind a directory this user may not search came back MISSING,
     "renamed or deleted?", when it was neither. 2026-09-14. */
  if (!existsAt(root, start)) return { modules: 0, blockers, unprovable, missing: true }
  walk(start)
  return { modules: seen.size, blockers, unprovable, missing: false }
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
  /** Per file, the loads no import graph can follow — see `readEdges`. */
  const hidden = new Map()
  /** `file`'s edges, read off disk and parsed, and remembered for the next asker. */
  function readEdges(file) {
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (cause) {
      /* ⚠️ THIS ANSWERED `null`, WHICH THE WALK READ AS "NO EDGES": a module
         it could not read — a directory named as one, a file it may not
         open — ended its branch clean. See `unchecked`. 2026-09-14. */
      throw unchecked(root, file, cause)
    }
    /* Read as the language reads it — see `runtimeSpecifiers`, which this
     * gate shares with `check-mutants` so the two cannot read one clause two
     * ways again. A Set, so spread before mapping. */
    const out = [...runtimeSpecifiers(source, file)].map((spec) => ({
      spec,
      next: resolveModule(root, file, spec, aliasList),
    }))
    /* ⚠️ **A LOAD NO GRAPH CAN FOLLOW MADE THIS GATE ANSWER "CLEAN".**
       `runtimeSpecifiers` names each of `import(p)`, `require(p)` and
       `createRequire()` with NOTHING — there is no single module to name — so a
       module whose only reach to the platform was one of those walked to a leaf
       with no edges and was certified browser-safe. The gate cannot see where
       such a load lands, and "I could not look" is not "there is nothing
       there": stating it as a proof is the one failure mode a gate must not
       have. Read from the same bytes, through the same shared helper
       `check-mutants` uses, so the two cannot come to read one clause two
       ways. Found by the 2026-09-19 audit. */
    hidden.set(file, hiddenLoads(source, file))
    // Stryker disable next-line CallExpression: with nothing remembered the next asker reads and parses the file again and is given the same list — the cache decides the cost, never the answer
    edges.set(file, out)
    return out
  }
  return {
    /* ⚠️ **NOT `if (edges.has(file)) return edges.get(file)`**, which needed a
     * directive over its whole line to hide the one mutant that cannot be seen
     * — the cache never consulted — and so hid `if (true)` with it, which hands
     * the walk `undefined` for a file nobody has read and is anything but
     * invisible. An edge list is an array and never `undefined`, so `??` falls
     * through on a miss and on nothing else, and no line here needs a directive
     * but the one that remembers. 2026-09-14. */
    edgesOf(file) {
      return edges.get(file) ?? readEdges(file)
    },
    /* Populated by the same read as the edges, so asking for one has always
       filled the other — `edgesOf` first is the walk's own order. */
    hiddenIn(file) {
      return hidden.get(file) ?? []
    },
  }
}

/**
 * Every `.ts`/`.tsx` under `dir` that is not a test.
 *
 * ⚠️ **A DIRECTORY IT COULD NOT LIST WAS A DIRECTORY WITH NOTHING IN IT**, so a
 * survey counted every module it could reach and said nothing of the ones it
 * could not. Refused now, naming the directory — see `unchecked`. 2026-09-14.
 */
export function sourcesUnder(root, dir) {
  const out = []
  const walk = (rel) => {
    let entries
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch (cause) {
      throw unchecked(root, path.join(root, rel), cause)
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
    const { modules: count, blockers, unprovable, missing } = blockersOf(root, module, shared)
    return {
      module,
      missing,
      modules: count,
      blockers: [...blockers].map(([file, pkgs]) => ({ file, packages: [...pkgs].sort() })),
      unprovable: [...unprovable].map(([file, loads]) => ({ file, loads })),
    }
  })
}

/**
 * Is `dir` a directory that exists?
 *
 * ⚠️ **A PATH IT COULD NOT STAT WAS "NOT A DIRECTORY"**, the diagnosis
 * `existsAt` had already stopped giving: a `--root` behind a directory this
 * user may not search was refused for being absent, which sends the reader
 * looking for a tree that is there. Only absence is `false`; any other failure
 * is thrown in node's own words, which name the path. 2026-09-14.
 */
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch (cause) {
    if (isAbsence(cause)) return false
    throw cause
  }
}

/**
 * The command, as its exit code.
 *
 * A path the walk could not check is THROWN — see `unchecked` — and reported
 * here as exit 2 in its own words, never as a count. A count printed over a
 * walk that stopped short is the confident all-clear this file's header
 * records, and 1 is taken: it means a module IS blocked, which nobody knows.
 *
 * What it prints goes to the two streams it is handed — the process's own
 * unless a caller says otherwise, which is the seam `run` has in
 * `check-mutants.mjs`. ⚠️ **EVERY TEST OF THIS COMMAND SPAWNED IT**, and a
 * spawned child never runs the mutant under test, so the whole command —
 * `--survey`, the walk of a directory, every line it prints — was 139 of this
 * file's 290 mutants with no coverage while each of those tests passed.
 * 2026-09-14.
 */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (line) => void stdout.write(`${line}\n`)
  const err = (line) => void stderr.write(`${line}\n`)
  try {
    return command(argv, { out, err })
  } catch (cause) {
    err(`check-browser-safe: ${cause instanceof Error ? cause.message : String(cause)}`)
    return 2
  }
}

function command(argv, { out, err }) {
  let root = REPO_ROOT
  /* The directory `--survey` names, or null when the question is about modules. */
  let survey = null
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const value = argv[++i]
      if (value === undefined) {
        err(USAGE)
        return 2
      }
      root = path.resolve(value)
    } else if (argv[i] === '--survey') {
      /* Every module under a directory, grouped by cause. How the nine leaves
       * were found in the first place; kept so the next survey is one command
       * rather than a throwaway script written under time pressure. */
      survey = argv[++i] ?? 'src/kernel'
    } else rest.push(argv[i])
  }

  /* ⚠️ **A SURVEY THAT SCANNED NOTHING USED TO EXIT 0**, and printed
   * "0 browser-safe, 0 blocked" while doing it. The root was validated only
   * after the survey had returned, so `--root /nowhere --survey src/kernel` was
   * an authoritative-looking all-clear about a tree that does not exist — the
   * precise failure this file's header records twice. A detector that finds
   * nothing has to be distinguishable from one that looked nowhere.
   *
   * ⚠️ **AND IT ANSWERED BEFORE IT HAD READ THE REST OF ITS ARGUMENTS.** The
   * survey ran inside the loop above, so `--survey src/kernel --root <other>`
   * surveyed THIS checkout and exited 0, and a module named beside it was never
   * checked or mentioned. Every argument is read first now. 2026-09-14. */
  if (!isDirectory(root)) {
    err(`check-browser-safe: ${root} is not a directory`)
    return 2
  }

  if (survey !== null) {
    if (rest.length > 0) {
      err(`check-browser-safe: --survey checks a directory, not modules — ${rest.join(', ')} would go unchecked`)
      return 2
    }
    if (!isDirectory(path.resolve(root, survey))) {
      err(`check-browser-safe: ${survey} is not a directory under ${root}`)
      return 2
    }
    const sources = sourcesUnder(root, survey)
    if (sources.length === 0) {
      err(`check-browser-safe: ${survey} holds no .ts/.tsx sources — a survey of nothing is not a clean survey`)
      return 2
    }
    const causes = new Map()
    let clean = 0
    for (const file of sources) {
      const { blockers, unprovable } = blockersOf(root, file)
      if (blockers.size === 0 && unprovable.size === 0) {
        clean += 1
        continue
      }
      /* A file the walk could not follow is grouped by the LOAD, beside the
         blocking modules, so a survey answers the same question the module
         check does: what stops this reaching a browser, or stops us saying. */
      const key = [...blockers.keys(), ...[...unprovable.keys()].map((f) => `${f} (not followable)`)]
        .sort()
        .join(' + ')
      if (!causes.has(key)) causes.set(key, [])
      causes.get(key).push(file)
    }
    out(`${survey}: ${clean} browser-safe, ${[...causes.values()].flat().length} blocked`)
    for (const [cause, list] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
      out(`\n  ${cause}`)
      for (const f of list) out(`    ${f}`)
    }
    return 0
  }

  /* ⚠️ A DIRECTORY NAMED AS A MODULE WAS ONE MODULE, CHECKED CLEAN: `src`
     printed "1 module(s) checked, 0 blocked" and exited 0 on 2026-09-14. The
     walk refuses what it cannot read now; this answers first, and says which
     command reads a directory. */
  for (const module of rest) {
    if (isDirectory(path.resolve(root, module))) {
      err(`check-browser-safe: ${module} is a directory, not a module — \`--survey ${module}\` checks every module under it`)
      return 2
    }
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
      out(`${report.module}  — MISSING (renamed or deleted?)`)
      failed += 1
      continue
    }
    if (report.blockers.length === 0 && report.unprovable.length === 0) continue
    failed += 1
    out(`${report.module}  (${report.modules} modules)`)
    for (const b of report.blockers) out(`    ${b.file}  →  ${b.packages.join(', ')}`)
    /* A SEPARATE LINE FROM A BLOCKER, because the remedy differs: a blocker is
       split into its own file, while this is made static or moved off the
       closure. Same exit code — both mean the module is not cleared. */
    for (const u of report.unprovable) out(`    ${u.file}  ?  ${u.loads.join(', ')} — not followable`)
  }

  const scope = pinned ? `${modules.length} pinned` : `${modules.length}`
  const unprovable = reports.reduce((n, r) => n + r.unprovable.length, 0)
  out(
    `check-browser-safe: ${scope} module(s) checked, ${failed} blocked` +
      (unprovable > 0 ? `, ${unprovable} file(s) not followable` : ''),
  )
  if (failed > 0) {
    out(
      `\nA module reaches ${PLATFORM_PREFIX} through the closure above, so it cannot be\n` +
        'bundled for a browser. Usually the cause is a pure value sharing a module\n' +
        'with a platform binding — split the binding into its own file, the way\n' +
        '`vaultFsTauri.ts` was split from `bookVault.ts`.',
    )
    return 1
  }
  return 0
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `main`, which is measured in-process
if (isProcessEntry(import.meta)) process.exit(main(process.argv.slice(2)))
