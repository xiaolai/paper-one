import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PLATFORMS } from './lib/architecture.mjs'
import { deletedDirsFor } from './capability-remove.mjs'
import { compositionFile, maskTemplates, stripComments } from './lib/compositions.mjs'
import { isProcessEntry } from './lib/entry.mjs'
import { REPO_ROOT, runSteps, spawnStep } from './verify.mjs'

/**
 * `pnpm verify:without <id>` — the physical proof that deletion is an
 * operation (ADR decision 7, WI-5.12): copy the CURRENT WORKING TREE
 * (uncommitted changes included) to a temporary directory, run
 * `capability:remove <id>` there, and hold the result to the gates.
 *
 * Why a copy and not a worktree: `git worktree add` checks out a COMMIT,
 * and the tree under test is the one being edited, most of it uncommitted
 * during this phase; a stash round-trip would move the very files the
 * proof is about. So the tree is copied — everything but `node_modules`,
 * `.git`, build output and caches — and `node_modules` is symlinked in from
 * here, which is what makes the copy runnable in seconds rather than after
 * an install.
 *
 * What runs in the copy, in order: `capability:remove <id>`; a check that
 * no file under `src/kernel/` changed (the exit criterion's "without
 * touching a kernel file", measured, not assumed); then `typecheck`,
 * `boundaries`, `architecture:check`, `compositions:check`, `test`, `build`
 * (desktop; asserts its bundle), `build:ios` and `build:android` (each
 * asserts its own bundle, now with one capability fewer). Coverage and the
 * Cargo steps are NOT run in the copy, deliberately: coverage floors were
 * measured with the capability's tests in the tree and a removal that
 * lowers the number is not a defect of the removal, and the Cargo steps
 * cost minutes on a fresh target directory. `pnpm verify` on the real tree
 * runs both. The copy is deleted afterwards unless `--keep`.
 *
 * Exit code: the copy's — the first failing step's, or 0.
 */

/** Names skipped at any depth when the tree is copied. */
export const COPY_EXCLUDE = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  '.types',
  'coverage',
  'target', // src-tauri/target
  '.claude',
  '.codex',
  '.agents',
  '.cc-suite',
  '.DS_Store',
])

const USAGE = 'usage: node scripts/verify-without.mjs [id] [--keep]'

/**
 * The steps run in the copy after the removal.
 *
 * ⚠️ **IT WAS MISSING TWO SHIPPING BUILDS** (2026-09-19 audit): `build:web` and
 * `build:cli` are in the canonical `STEPS` and were never run here, so the
 * proof could pass while the post-removal BROWSER bundle or the CLI was broken.
 * Both are exactly the surfaces a capability removal can break — `build:web`
 * runs `assert-bundle`, which fails if any capability module reaches a build
 * that composes none, and `build:cli` bundles `src/cli/`, which imports a
 * capability directly and is the reason the host-import condition exists at
 * all. Neither was a decision; the omissions below are, and say so.
 *
 * `EXCLUDED` names every canonical step this deliberately does NOT run, with
 * the reason, and `verify-without.test.mjs` holds the two lists to each other —
 * so the next step added to `verify.mjs` is either run here or excused by name,
 * and cannot simply go missing again.
 */
export const COPY_STEPS = Object.freeze([
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'boundaries', cmd: 'pnpm', args: ['boundaries'] },
  { name: 'architecture:check', cmd: 'pnpm', args: ['architecture:check'] },
  { name: 'compositions:check', cmd: 'pnpm', args: ['compositions:check'] },
  { name: 'test', cmd: 'pnpm', args: ['test'] },
  { name: 'build', cmd: 'pnpm', args: ['build'] },
  { name: 'build:ios', cmd: 'pnpm', args: ['build:ios'] },
  { name: 'build:android', cmd: 'pnpm', args: ['build:android'] },
  { name: 'build:web', cmd: 'pnpm', args: ['build:web'] },
  { name: 'build:cli', cmd: 'pnpm', args: ['build:cli'] },
])

/**
 * The canonical steps this proof deliberately does not run, and why.
 *
 * A REASON PER STEP, because "not in the list" is indistinguishable from an
 * oversight — which is precisely how `build:web` and `build:cli` went missing.
 */
export const EXCLUDED = Object.freeze({
  'test:coverage':
    'coverage floors were measured with the capability\'s own tests in the tree, so a removal that lowers the number is not a defect of the removal',
  'test:ledger':
    'the ledger records this tree\'s tests; the copy has fewer by construction, which is the point rather than a finding',
  'ledger:check': 'reads `dev-docs/`, which is gitignored and not in every checkout',
  'css:check': 'a removal takes stylesheets with it; unreachable CSS in the copy is the removal working',
  'css:tokens': 'as `css:check` — the token set is the real tree\'s',
  'browser:check': 'its pinned list names modules of the real tree',
  'directives:check': 'counts Stryker directives across the real tree',
  'test:projects': 'counts this tree\'s test files',
  'cargo metadata --locked': 'the Cargo steps cost minutes on a fresh target directory, and `pnpm verify` runs them on the real tree',
  'cargo fmt --check': 'as `cargo metadata --locked`',
  'cargo clippy -D warnings': 'as `cargo metadata --locked`',
  'cargo test --workspace': 'as `cargo metadata --locked`',
  'docs:rust-notices --check': 'as `cargo metadata --locked`',
})

export function parseArgs(argv) {
  let id
  let keep = false
  for (const arg of argv) {
    if (arg === '--keep') keep = true
    else if (arg.startsWith('-')) return { error: `unknown argument ${JSON.stringify(arg)}` }
    else if (id !== undefined) return { error: 'exactly one capability id is expected' }
    else id = arg
  }
  /* NO ID IS THE ORDINARY CALL — see `removableCapabilities`. */
  return { keep, ...(id === undefined ? {} : { id }) }
}

/**
 * The capabilities `capability:remove` can actually take out of this tree.
 *
 * ⚠️ **CI NAMED ONE BY HAND AND WAS WRONG TWICE.** It said `example` for months
 * after the capability called `example` was deleted (19bac0e), and the step
 * failed on every push while the deletion proof proved nothing; it then said
 * `sync`, which `src/cli/paper.ts` imports for `openLocalJournal`, so the
 * removal succeeded and the TYPECHECK failed two steps later. It said
 * `companion` until every AI feature was removed. A hand-written id is a fact
 * with a half-life, and this one goes stale silently — the proof still RUNS,
 * it just stops proving anything.
 *
 * So the id is DERIVED, from the same three conditions the suite asserts:
 *
 *   1. the manifest declares it — `capability:remove` refuses an id it does
 *      not know, which is how the `example` years happened;
 *   2. nothing `requires` it — the remover refuses a capability another
 *      depends on, so naming `peer` would fail as surely as naming a ghost;
 *   3. no HOST imports it. `.dependency-cruiser.cjs` permits a composition
 *      root and `src/cli/` to import a capability index, so this is not a
 *      boundary violation caught elsewhere — it is a fact about which
 *      capabilities are removable, and `capability:remove` has never edited a
 *      host. A composition root is exempt because the remover already edits
 *      those.
 *
 * Returns every one that qualifies, SORTED, and `main` takes the first — so the
 * choice is deterministic and a run is reproducible. It prints the whole list
 * beside what it took, because the two say different things.
 *
 * ⚠️ **WHAT THIS PROVES IS WEAKER THAN WHAT THE HAND-WRITTEN ID CLAIMED, AND
 * THAT IS THE POINT.** Naming `circle` asserted *this capability is removable*;
 * deriving it asserts *some capability is*. The stronger claim is the one that
 * went stale in silence three times. If `circle` grows a host import the picker
 * moves to the next and CI stays green — correctly, because the property being
 * proved is that deletion is an operation, not that any particular leaf is
 * still a leaf.
 */
export function removableCapabilities(repo = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(repo, 'capabilities.manifest.json'), 'utf8'))
  const src = path.join(repo, 'src')
  const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((rel) => /\.tsx?$/.test(rel))
  /* THE COMPOSITION ROOTS, BY NAME — the four files `capability:remove` already
     edits. ⚠️ It was `/^app[\\/]composition\./`, which also exempted any
     helper somebody put beside them (`composition.shared.ts`): such a file could
     hold an import the remover never touches while this still called the
     capability removable. `compositionFile` is the same helper the checker
     resolves them with, so there is one answer to "which files are those". */
  const roots = new Set(PLATFORMS.map((platform) => compositionFile(platform).replace(/^src\//, '')))
  return manifest.capabilities
    .filter((cap) => !manifest.capabilities.some((c) => (c.requires ?? []).includes(cap.id)))
    /* ⚠️ **PATHS ARE `ts`, DEPENDENCIES ARE `id`, AND THIS USED `id` FOR BOTH.**
       The manifest lets a capability's directory differ from its id — that is
       what the `ts` field is for — so one that did would have been checked at a
       path that does not exist and reported removable on the strength of finding
       no importers of nothing. Every entry has `ts === id` today, which is
       exactly why it would have gone unnoticed. */
    .filter((cap) => !importedOutside(src, sources, cap.ts ?? cap.id, roots))
    .map((cap) => cap.id)
    .sort()
}

/**
 * Whether any source outside `dir`'s own tree and outside the composition roots
 * imports `src/capabilities/<dir>`.
 *
 * ⚠️ **THIS WAS `new RegExp("from '[^']*capabilities/" + id + "'")` AND IT WAS
 * WRONG FOUR WAYS** (2026-09-19 audit): it read only single quotes, so a
 * double-quoted import was invisible; it matched inside COMMENTS, so a
 * paragraph naming the path counted as an importer; it missed
 * `await import("…")`; and with no boundary after the name, `public` matched
 * `public-extra`. A picker that under-reports importers hands CI a capability
 * whose removal breaks the typecheck — the exact failure this whole function
 * exists to prevent.
 *
 * Comments are stripped and templates masked with the checker's own helpers, so
 * both gates read a source the same way.
 *
 * ⚠️ **A TYPE-ONLY IMPORT COUNTS HERE**, though `parseCompositionImports` skips
 * one: `capability:remove` deletes the DIRECTORY, so `import type { X } from
 * '…/capabilities/x'` stops resolving exactly as a value import does. That is
 * why this does not simply call that helper.
 */
function importedOutside(src, sources, dir, roots) {
  const own = path.join('capabilities', dir) + path.sep
  /* Either quote, `import`/`export … from`, a bare `import '…'`, and
     `import(…)`; the specifier must end at the directory or continue with `/`. */
  const NAMES = new RegExp(
    String.raw`(?:from|import)\s*\(?\s*['"][^'"]*capabilities/${dir}(?:/[^'"]*)?['"]`,
  )
  return sources
    .filter((rel) => !rel.startsWith(own) && !roots.has(rel.split(path.sep).join('/')))
    .some((rel) => NAMES.test(maskTemplates(stripComments(readFileSync(path.join(src, rel), 'utf8')))))
}

/**
 * Copy `source` to a fresh temporary directory (realpath'd — macOS's tmpdir
 * is a symlink and Vite names modules by real path), skipping COPY_EXCLUDE
 * names, and link `node_modules` in from `source`. Returns the copy's path.
 */
export function copyTree(source, exclude = COPY_EXCLUDE) {
  const dest = mkdtempSync(path.join(realpathSync(tmpdir()), 'paper-verify-without-'))
  const skip = new Set(exclude)
  cpSync(source, dest, {
    recursive: true,
    filter: (src) => !skip.has(path.basename(src)) && !src.endsWith('.capability-remove.tmp'),
  })
  const modules = path.join(source, 'node_modules')
  if (existsSync(modules)) symlinkSync(modules, path.join(dest, 'node_modules'), 'dir')
  return dest
}

/** A digest over every file under `dir` (relative path + bytes), sorted;
 *  '' when the directory does not exist. */
export function digestTree(dir) {
  if (!existsSync(dir)) return ''
  const files = []
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      if (statSync(path.join(dir, child)).isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk('')
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(path.join(dir, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * The whole proof for `id`: `{ code, dir }`. `run(step, cwd)` runs one step
 * (default: a child process); `log` receives the narrative.
 */
/**
 * The name of the capability this proof has just deleted, in the child's env.
 *
 * A GATE INSIDE THE COPY CANNOT OTHERWISE TELL WHERE IT IS. The two trees look
 * identical from within once the removal has run: a workflow naming a
 * capability the manifest does not declare is a real defect in a checkout and
 * is simply the proof doing its job here. The tell used to be the absence of
 * `.git` — true of the copy, and true of any source archive or plain `cp -r` of
 * a checkout, where a gate would then excuse a stale reference for a reason
 * that has nothing to do with this script. This says it outright.
 *
 * A gate must still check that the removal is COMPLETE — the directory gone,
 * not merely the manifest entry — because this variable says which id was
 * removed, not that the tree is in a state worth passing.
 */
export const DELETED_ENV = 'PAPER_VERIFY_WITHOUT'

/**
 * The directories that removal DELETED, colon-separated, in the child's env.
 *
 * ⚠️ **THE ID ALONE IS NOT ENOUGH, AND A GATE GUESSED THE REST AND GUESSED
 * WRONG** (2026-09-19). `checkLedger` excused ledger claims under the deleted
 * capability by spelling the directory itself as `src/capabilities/<id>` — but
 * the manifest permits `ts` to differ from `id`, and a capability with a
 * `crate` also loses `src-tauri/crates/<crate>`. So `verify:without webhost`
 * reported the crate it had just correctly deleted as a missing path, and
 * `circle` — the only capability the proof had ever been run on — has no crate,
 * so nothing had shown it.
 *
 * The guess is gone: the answer is `capability-remove`'s own `deletedDirsFor`,
 * read from the SOURCE manifest before the entry is cut out of the copy, which
 * is the only moment it can still be asked.
 *
 * COLON-SEPARATED because these are repository-relative POSIX paths and none
 * of them can contain a colon; an empty value means nothing was deleted, which
 * is what every gate outside this proof sees.
 */
export const DELETED_DIRS_ENV = 'PAPER_VERIFY_WITHOUT_DIRS'

/**
 * The directories `capability:remove <id>` will delete, read before it runs.
 *
 * An ABSENT manifest answers with none, and an unknown id likewise: both are
 * `capability:remove`'s refusals to make, not this helper's — it is the proof's
 * FIRST step and it names either by hand. Answering with no directories excuses
 * nothing downstream, which is the fail-closed direction, and this function's
 * tests drive a synthetic source tree that has no manifest at all.
 *
 * ⚠️ **ENOENT ONLY.** A manifest that is present and will not parse is a real
 * problem and throws here: swallowing it would turn a corrupt tree into a proof
 * that excused nothing for a reason nobody was told.
 */
export function deletedDirs(id, repo = REPO_ROOT) {
  let text
  try {
    text = readFileSync(path.join(repo, 'capabilities.manifest.json'), 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
  const entry = JSON.parse(text).capabilities.find((cap) => cap.id === id)
  return entry === undefined ? [] : deletedDirsFor(entry)
}

export function verifyWithout(id, { source = REPO_ROOT, keep = false, run = spawnStep, log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const dir = copyTree(source)
  /* BEFORE THE FIRST STEP RUNS, for the reason beside the env line below. */
  const deleted = deletedDirs(id, source).join(':')
  log(`verify-without: copied ${source} → ${dir} (node_modules linked)`)
  let code
  try {
    const kernelBefore = digestTree(path.join(dir, 'src', 'kernel'))
    code = runSteps(
      [
        { name: `capability:remove ${id}`, cmd: 'pnpm', args: ['capability:remove', id] },
        {
          name: 'kernel untouched',
          cmd: 'digest',
          args: ['src/kernel'],
          local: () => {
            const after = digestTree(path.join(dir, 'src', 'kernel'))
            if (after !== kernelBefore) {
              log(`verify-without: capability:remove ${id} changed a file under src/kernel/ — deletion must not touch the kernel`)
              return 1
            }
            log(`verify-without: src/kernel/ unchanged (sha256 ${kernelBefore.slice(0, 12)}…)`)
            return 0
          },
        },
        ...COPY_STEPS,
      ],
      /* `env` carries the deleted id AND what it deleted into every child —
         see `DELETED_ENV` and `DELETED_DIRS_ENV`. ONCE, and from `source`: the
         first step removes the entry from the copy's manifest, so asking the
         copy afterwards answers about a capability that is already gone. */
      (step) => (step.local ? step.local() : run(step, dir, { [DELETED_ENV]: id, [DELETED_DIRS_ENV]: deleted })),
      log,
    )
  } finally {
    if (keep) log(`verify-without: kept ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
  }
  return { code, dir }
}

/**
 * The CLI. `prove` and `out` are injectable so the SELECTION and the
 * stop-at-first-failure can be tested without copying the tree three times —
 * the same shape `verifyWithout` gives its own `run` and `log`.
 */
export function main(argv, { prove = verifyWithout, out = (l) => process.stdout.write(l), err = (l) => process.stderr.write(l) } = {}) {
  const args = parseArgs(argv)
  if (args.error !== undefined) {
    err(`verify-without: ${args.error}\n${USAGE}\n`)
    return 2
  }
  /* AN ID MAY STILL BE NAMED — for asking about one in particular, which is
     what a person debugging the remover wants. With none, the tree is asked,
     and EVERY removable capability is proved. */
  let ids
  if (args.id === undefined) {
    const removable = removableCapabilities()
    if (removable.length === 0) {
      /* NOT A PASS. Every capability being unremovable is the thing this proof
         exists to notice — it means every leaf has grown a host import — and
         answering 0 here would retire the gate by accident. */
      err(
        'verify-without: no capability can be removed from this tree — every one is required by another or imported by a host outside a composition root\n',
      )
      return 2
    }
    ids = removable
    /* ⚠️ **THIS TOOK `removable[0]` AND PRINTED THE REST AS AN ASIDE** — so the
       gate measured ONE THIRD of its subject, and the third it measured was the
       one that could not fail. `removable` sorts, so `circle` was always the
       choice, and `circle` is the only removable capability with no Rust crate.
       Two gates inside the copy — `checkLedger` and `cargo.test.mjs` — assumed
       a removal deletes one directory, which is true only for a capability
       without a crate; `verify:without webhost` failed on both the first time
       anybody ran it, on 2026-09-19, long after either could have been caught.

       So all of them are proved. Roughly 140–170 s each here, and the honest
       lever if that ever matters is a CI matrix over `removableCapabilities()`,
       not measuring fewer of them. */
    out(`verify-without: proving all ${removable.length} removable (${removable.join(', ')})\n`)
  } else {
    ids = [args.id]
  }
  for (const id of ids) {
    if (ids.length > 1) out(`\nverify-without: ── ${id} ──\n`)
    const { code } = prove(id, { keep: args.keep })
    if (code !== 0) {
      /* STOPS AT THE FIRST FAILURE, and names it. Carrying on would spend ten
         minutes producing a second copy of a failure that is almost always the
         same defect — and the id that failed is what the reader needs, which a
         combined exit code cannot carry. */
      out(`\n✗ verify-without: exit ${code} without ${JSON.stringify(id)}\n`)
      return code
    }
    out(`\n✓ verify-without: the tree passes without ${JSON.stringify(id)}\n`)
  }
  return 0
}

if (isProcessEntry(import.meta)) {
  process.exitCode = main(process.argv.slice(2))
}
