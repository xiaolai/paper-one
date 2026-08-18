import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORMS, createFsProbe, parseManifest, validateManifest } from './lib/architecture.mjs'
import { dependencyForCrate, readCargoManifest, rustName } from './lib/cargo.mjs'
import { compositionFile, registersPlugin } from './lib/compositions.mjs'
import { isProcessEntry } from './lib/entry.mjs'
import {
  RemovalRefused,
  removeAclGrants,
  removeCargoDependency,
  removeFromComposition,
  removeManifestEntry,
  removePluginRegistration,
} from './lib/removal.mjs'
import { readAclFiles } from './check-compositions.mjs'

/**
 * `pnpm capability:remove <id>` — deletion as an operation (ADR decision 7,
 * WI-5.12).
 *
 * Removes one capability from every registration surface: its manifest
 * entry; its import and array element in every `src/app/composition.*.ts`;
 * and, when the entry names a `crate`, the app crate's dependency on it and
 * the feature items that forward to it in `src-tauri/Cargo.toml`, the
 * `.plugin(<crate>::init())` line in `src-tauri/src/lib.rs`, every grant
 * under its namespace in `src-tauri/capabilities/*.json`, and (unless
 * `--keep-files`) the directories `src/capabilities/<ts>` and
 * `src-tauri/crates/<crate>` — through `git rm` when they are tracked.
 *
 * ALL OR NOTHING. Every edit is computed first, over the files as they are,
 * through the pure functions in `scripts/lib/removal.mjs`; a surface that
 * cannot be edited (an unrecognised shape, a residual reference, another
 * entry that `requires` this one, an inconsistent tree) is a refusal before
 * anything is written. Only when every edit exists are files written — each
 * to a temporary file beside it and renamed into place — and only then are
 * directories deleted. When the entry had a crate the lockfile is pruned
 * afterwards with `cargo metadata --offline`, which drops the crate's
 * packages without touching any other version.
 *
 * Idempotence is by refusal: a second run finds no such id and exits 1
 * having changed nothing. `--dry-run` prints the plan and stops.
 *
 * Exit 0 done · 1 unknown id, refused, or a surface could not be edited ·
 * 2 usage error or the tree could not be read.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/capability-remove.mjs <id> [--root <dir>] [--keep-files] [--dry-run] [--no-cargo] [--no-rustfmt]'
export const MANIFEST_NAME = 'capabilities.manifest.json'
export const CARGO_TOML = 'src-tauri/Cargo.toml'
export const LIB_RS = 'src-tauri/src/lib.rs'

export class UsageError extends Error {}

/** `{ id, root, deleteFiles, dryRun, cargo, rustfmt }` or throws UsageError. */
export function parseArgs(argv, cwd) {
  const out = { id: undefined, root: REPO_ROOT, deleteFiles: true, dryRun: false, cargo: true, rustfmt: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError('--root needs a directory')
      out.root = path.resolve(cwd, value)
      i++
    } else if (arg === '--keep-files') out.deleteFiles = false
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--no-cargo') out.cargo = false
    else if (arg === '--no-rustfmt') out.rustfmt = false
    else if (arg.startsWith('-')) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`)
    else if (out.id !== undefined) throw new UsageError('exactly one capability id is expected')
    else out.id = arg
  }
  if (out.id === undefined) throw new UsageError('a capability id is required')
  return out
}

/* ------------------------------------------------------------------ plan */

/**
 * The plan: every edit and deletion the removal of `id` under `root`
 * consists of, computed and validated, nothing written.
 *
 *   { id, entry, edits: [{ file, text, note }], deletions: [{ dir, tracked }],
 *     notes: string[], crate: string|null }
 *
 * `hooks.rustfmt(text)` formats a lib.rs text (default: the real rustfmt);
 * `hooks.isTracked(root, rel)` answers whether git tracks a directory.
 * Throws RemovalRefused (exit 1) or Error (exit 2).
 */
export function planRemoval(root, id, options = {}) {
  const hooks = { rustfmt: runRustfmt, isTracked: gitTracks, ...options.hooks }
  const deleteFiles = options.deleteFiles ?? true
  const useRustfmt = options.rustfmt ?? true

  const manifestText = readOrThrow(root, MANIFEST_NAME)
  const parsed = parseManifest(manifestText)
  const findings = parsed.findings.length > 0 ? parsed.findings : validateManifest(parsed.manifest, createFsProbe(root))
  if (findings.length > 0) {
    const lines = findings.map((f) => `  ${f.code} ${f.path === '' ? '(root)' : f.path}: ${f.message}`)
    throw new RemovalRefused(`${MANIFEST_NAME} is invalid (${findings.length} findings; see pnpm architecture:check):\n${lines.join('\n')}`)
  }
  const manifest = parsed.manifest
  const entry = manifest.capabilities.find((e) => e.id === id)
  if (!entry) {
    const known = manifest.capabilities.map((e) => e.id)
    throw new RemovalRefused(`unknown capability ${JSON.stringify(id)}; the manifest declares ${known.length === 0 ? 'none' : known.map((k) => JSON.stringify(k)).join(', ')}`)
  }

  const edits = []
  const notes = []
  const deletions = []

  edits.push({ file: MANIFEST_NAME, text: removeManifestEntry(manifestText, id).text, note: `remove entry ${JSON.stringify(id)}` })

  for (const platform of PLATFORMS) {
    const file = compositionFile(platform)
    const source = readOrNull(root, file)
    if (source === null) throw new RemovalRefused(`${file} does not exist; every platform has a static composition (pnpm compositions:check)`)
    const result = removeFromComposition(source, entry.ts)
    if (result.changed) edits.push({ file, text: result.text, note: `remove import of ../capabilities/${entry.ts} and ${result.names.map((n) => JSON.stringify(n)).join(', ')}` })
    else notes.push(`${file}: does not import ${entry.ts}; nothing to remove`)
  }

  const crate = typeof entry.crate === 'string' ? entry.crate : null
  if (crate !== null) {
    const cargoText = readOrThrow(root, CARGO_TOML)
    const cargo = readCargoManifest(cargoText)
    const dep = dependencyForCrate(cargo, crate)
    if (dep === null) {
      throw new RemovalRefused(`${CARGO_TOML} has no [dependencies] entry with path = "crates/${crate}"; the tree is inconsistent (pnpm compositions:check)`)
    }
    const cargoEdit = removeCargoDependency(cargoText, dep.name)
    edits.push({
      file: CARGO_TOML,
      text: cargoEdit.text,
      note: `remove dependency ${dep.name}${cargoEdit.removedFeatureItems.length ? ` and feature items ${cargoEdit.removedFeatureItems.join(', ')}` : ''}`,
    })

    const libText = readOrThrow(root, LIB_RS)
    const snake = rustName(dep.name)
    if (!registersPlugin(libText, snake)) {
      throw new RemovalRefused(`${LIB_RS} does not call .plugin(${snake}::init()); the tree is inconsistent (pnpm compositions:check)`)
    }
    const libEdit = removePluginRegistration(libText, snake)
    const formatted = useRustfmt ? hooks.rustfmt(libEdit.text, path.join(root, LIB_RS)) : libEdit.text
    edits.push({ file: LIB_RS, text: formatted, note: `remove .plugin(${snake}::init())${useRustfmt ? ', rustfmt' : ''}` })

    const namespace = typeof entry.plugin === 'string' ? entry.plugin : id
    for (const { file, text } of readAclFiles(root)) {
      const acl = removeAclGrants(text, namespace)
      if (acl.changed) edits.push({ file, text: acl.text, note: `remove grants ${acl.removed.map((r) => JSON.stringify(r)).join(', ')}` })
    }
  }

  if (deleteFiles) {
    for (const dir of [`src/capabilities/${entry.ts}`, ...(crate !== null ? [`src-tauri/crates/${crate}`] : [])]) {
      deletions.push({ dir, tracked: hooks.isTracked(root, dir) })
    }
  }

  return { id, entry, edits, deletions, notes, crate }
}

/* ----------------------------------------------------------------- apply */

/**
 * Write the plan. Every edited file goes to `<file>.capability-remove.tmp`
 * first — all of them — and only then is each renamed over its original, so
 * a write failure leaves the originals untouched. Deletions follow; then,
 * for a crate, the lockfile prune. Returns the lines it printed.
 */
export function applyPlan(root, plan, options = {}) {
  const hooks = { gitRm: gitRmCached, cargoPrune: cargoPruneLock, ...options.hooks }
  const lines = []
  const staged = []
  try {
    for (const edit of plan.edits) {
      const target = path.join(root, edit.file)
      const tmp = `${target}.capability-remove.tmp`
      writeFileSync(tmp, edit.text)
      staged.push({ tmp, target })
    }
  } catch (cause) {
    for (const { tmp } of staged) rmSync(tmp, { force: true })
    throw new Error(`could not stage edits: ${cause.message}`, { cause })
  }
  for (const { tmp, target } of staged) renameSync(tmp, target)
  for (const edit of plan.edits) lines.push(`edited  ${edit.file} — ${edit.note}`)

  for (const { dir, tracked } of plan.deletions) {
    if (tracked) hooks.gitRm(root, dir)
    rmSync(path.join(root, dir), { recursive: true, force: true })
    lines.push(`deleted ${dir}/${tracked ? ' (git rm --cached, then removed)' : ''}`)
  }

  if (plan.crate !== null && (options.cargo ?? true)) {
    hooks.cargoPrune(root)
    lines.push(`pruned  src-tauri/Cargo.lock (cargo metadata --offline)`)
  }
  return lines
}

/* --------------------------------------------------------------- helpers */

function readOrThrow(root, rel) {
  try {
    return readFileSync(path.join(root, rel), 'utf8')
  } catch (cause) {
    throw new Error(`cannot read ${rel} under ${root}: ${cause?.code ?? cause?.message}`, { cause })
  }
}

function readOrNull(root, rel) {
  try {
    return readFileSync(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

/** Does git, from `root`, track anything under `rel`? False when `root` is
 *  not itself the top of a work tree (a copy under /tmp must never reach a
 *  parent repository's index). */
export function gitTracks(root, rel) {
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (top.status !== 0) return false
  let same = false
  try {
    same = realpathSync(top.stdout.trim()) === realpathSync(root)
  } catch {
    return false
  }
  if (!same) return false
  const ls = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { encoding: 'utf8' })
  return ls.status === 0
}

function gitRmCached(root, rel) {
  const result = spawnSync('git', ['-C', root, 'rm', '-r', '-q', '--cached', '--', rel], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git rm --cached ${rel} failed: ${result.stderr.trim()}`)
}

/**
 * Format a lib.rs text with the toolchain's rustfmt, through a temporary
 * file in the same directory (so a `rustfmt.toml` up the tree still
 * applies), before anything is written into place. A missing rustfmt is a
 * refusal — a registration cut out by hand is right, but a `pnpm verify`
 * that then fails `cargo fmt --check` would present the operation as
 * broken; `--no-rustfmt` skips this for a tree without a toolchain.
 */
export function runRustfmt(text, libPath) {
  const dir = path.dirname(libPath)
  const tmp = path.join(dir, `.lib.rs.capability-remove.${process.pid}.rs`)
  writeFileSync(tmp, text)
  try {
    const result = spawnSync('rustfmt', ['--edition', '2021', tmp], { encoding: 'utf8' })
    if (result.error) throw new RemovalRefused(`rustfmt is not available (${result.error.code}); install it or pass --no-rustfmt`)
    if (result.status !== 0) throw new RemovalRefused(`rustfmt refused the edited lib.rs:\n${result.stderr.trim()}`)
    return readFileSync(tmp, 'utf8')
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Drop the removed crate's packages from Cargo.lock without a network. */
export function cargoPruneLock(root) {
  const manifest = path.join(root, CARGO_TOML)
  const result = spawnSync('cargo', ['metadata', '--offline', '--format-version', '1', '--manifest-path', manifest], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw new Error(`cargo is not available (${result.error.code}); the edits are applied, run \`cargo metadata --offline --manifest-path ${CARGO_TOML}\` to prune Cargo.lock`)
  if (result.status !== 0) throw new Error(`cargo metadata --offline failed after the edits (Cargo.lock not pruned):\n${result.stderr.trim()}`)
}

/* ------------------------------------------------------------------ main */

export function describePlan(plan) {
  const lines = [`capability-remove: ${plan.id}${plan.crate ? ` (crate ${plan.crate})` : ''}`]
  for (const edit of plan.edits) lines.push(`  edit    ${edit.file} — ${edit.note}`)
  for (const { dir, tracked } of plan.deletions) lines.push(`  delete  ${dir}/${tracked ? ' (tracked: git rm --cached)' : ''}`)
  for (const note of plan.notes) lines.push(`  keep    ${note}`)
  return lines
}

function main(argv) {
  let args
  try {
    args = parseArgs(argv, process.cwd())
  } catch (cause) {
    process.stderr.write(`capability-remove: ${cause.message}\n${USAGE}\n`)
    return 2
  }
  if (!existsSync(args.root) || !statSync(args.root).isDirectory()) {
    process.stderr.write(`capability-remove: ${args.root} is not a directory\n`)
    return 2
  }
  let plan
  try {
    plan = planRemoval(args.root, args.id, { deleteFiles: args.deleteFiles, rustfmt: args.rustfmt })
  } catch (cause) {
    if (cause instanceof RemovalRefused) {
      process.stderr.write(`capability-remove: refused — ${cause.message}\n`)
      return 1
    }
    throw cause
  }
  process.stdout.write(`${describePlan(plan).join('\n')}\n`)
  if (args.dryRun) {
    process.stdout.write('capability-remove: dry run, nothing written\n')
    return 0
  }
  const done = applyPlan(args.root, plan, { cargo: args.cargo })
  process.stdout.write(`${done.map((l) => `  ${l}`).join('\n')}\ncapability-remove: ${plan.id} removed from ${plan.edits.length} files${plan.deletions.length ? `, ${plan.deletions.length} directories deleted` : ''}\n`)
  return 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`capability-remove: ${cause?.message ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
