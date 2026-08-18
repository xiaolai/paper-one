import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

const USAGE = 'usage: node scripts/verify-without.mjs <id> [--keep]'

/** The steps run in the copy after the removal. */
export const COPY_STEPS = Object.freeze([
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'boundaries', cmd: 'pnpm', args: ['boundaries'] },
  { name: 'architecture:check', cmd: 'pnpm', args: ['architecture:check'] },
  { name: 'compositions:check', cmd: 'pnpm', args: ['compositions:check'] },
  { name: 'test', cmd: 'pnpm', args: ['test'] },
  { name: 'build', cmd: 'pnpm', args: ['build'] },
  { name: 'build:ios', cmd: 'pnpm', args: ['build:ios'] },
  { name: 'build:android', cmd: 'pnpm', args: ['build:android'] },
])

export function parseArgs(argv) {
  let id
  let keep = false
  for (const arg of argv) {
    if (arg === '--keep') keep = true
    else if (arg.startsWith('-')) return { error: `unknown argument ${JSON.stringify(arg)}` }
    else if (id !== undefined) return { error: 'exactly one capability id is expected' }
    else id = arg
  }
  if (id === undefined) return { error: 'a capability id is required' }
  return { id, keep }
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
export function verifyWithout(id, { source = REPO_ROOT, keep = false, run = spawnStep, log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const dir = copyTree(source)
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
      (step) => (step.local ? step.local() : run(step, dir)),
      log,
    )
  } finally {
    if (keep) log(`verify-without: kept ${dir}`)
    else rmSync(dir, { recursive: true, force: true })
  }
  return { code, dir }
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error !== undefined) {
    process.stderr.write(`verify-without: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { code } = verifyWithout(args.id, { keep: args.keep })
  process.stdout.write(code === 0 ? `\n✓ verify-without: the tree passes without ${JSON.stringify(args.id)}\n` : `\n✗ verify-without: exit ${code}\n`)
  return code
}

if (isProcessEntry(import.meta)) {
  process.exitCode = main(process.argv.slice(2))
}
