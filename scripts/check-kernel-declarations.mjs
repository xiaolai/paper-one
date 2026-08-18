import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm boundaries:decls` — the kernel's public type surface names no
 * capability.
 *
 * `tsc -b` (`pnpm typecheck`) emits the kernel's declarations to
 * `.types/kernel`. Those files are what a capability or a composition root
 * sees when it imports the kernel: every exported type, and the imports those
 * types reach for. If any of them mentions `capabilities/`, the kernel's
 * TYPES depend on a capability even where its values do not — a `import type`
 * that dependency-cruiser's value graph would also catch, but this reads the
 * emitted surface itself, which is the thing that would leak.
 *
 * Two more findings, because a scan that finds nothing must mean "nothing is
 * there" and not "nothing was looked at":
 *
 * - `.types/kernel` missing or holding no declarations at all is a finding,
 *   not a pass. The scan has nothing to read; run `pnpm typecheck` first.
 * - A declaration with no source under `src/kernel` is STALE — `tsc -b`
 *   never deletes the output of a source that was removed or renamed, so a
 *   stale file could carry a mention the current kernel does not have, or
 *   hide the fact that the scan ran over an old tree. `pnpm typecheck`
 *   rebuilds from clean, so this only appears when the scan is run alone.
 *
 * Findings, one per line, then a summary; exit 0 when clean, 1 on a finding,
 * 2 on a usage error.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-kernel-declarations.mjs [--root <dir>]'
export const DECLARATIONS = path.join('.types', 'kernel')
export const SOURCES = path.join('src', 'kernel')
/** The forbidden mention. A path segment, so `capabilities.manifest.json` in
 *  a doc comment is not one; `capabilities/` in any position is. */
export const NEEDLE = 'capabilities/'

/** `{ root }` or `{ error }`. Anything not understood is an error. */
function parseArgs(argv, cwd) {
  let root
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: '--root needs a directory' }
      if (root !== undefined) return { error: '--root given twice' }
      root = path.resolve(cwd, value)
      i++
      continue
    }
    return { error: `unknown argument ${JSON.stringify(arg)}` }
  }
  return { root: root ?? REPO_ROOT }
}

/** Every `.d.ts` under `dir`, as paths relative to `dir`, sorted. Empty when
 *  the directory does not exist. */
function listDeclarations(dir) {
  if (!existsSync(dir)) return []
  const found = []
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.d.ts')) found.push(path.relative(dir, full))
    }
  }
  walk(dir)
  return found.sort()
}

/**
 * Findings for the declarations under `root`. Pure apart from reading the
 * tree: `{ code, path, message }` per finding, plus the number of files read.
 */
export function checkDeclarations(root) {
  const declDir = path.join(root, DECLARATIONS)
  const files = listDeclarations(declDir)
  const findings = []
  if (files.length === 0) {
    findings.push({
      code: 'MISSING',
      path: toPosix(DECLARATIONS),
      message: 'no declarations to scan — run `pnpm typecheck` (tsc -b) first',
    })
    return { findings, scanned: 0 }
  }
  for (const rel of files) {
    const posix = toPosix(path.join(DECLARATIONS, rel))
    const stem = rel.slice(0, -'.d.ts'.length)
    const sourceExists = ['.ts', '.tsx'].some((ext) => existsSync(path.join(root, SOURCES, stem + ext)))
    if (!sourceExists) {
      findings.push({
        code: 'STALE',
        path: posix,
        message: `no source ${toPosix(path.join(SOURCES, stem))}.ts(x) — run \`pnpm typecheck\`, which rebuilds .types from clean`,
      })
    }
    const text = readFileSync(path.join(declDir, rel), 'utf8')
    if (!text.includes(NEEDLE)) continue
    text.split('\n').forEach((line, i) => {
      if (line.includes(NEEDLE)) {
        findings.push({ code: 'MENTION', path: `${posix}:${i + 1}`, message: line.trim() })
      }
    })
  }
  return { findings, scanned: files.length }
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`check-kernel-declarations: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { findings, scanned } = checkDeclarations(args.root)
  const lines = findings.map((f) => `${f.code} ${f.path}: ${f.message}`)
  lines.push(`check-kernel-declarations: ${scanned} declaration files, ${findings.length} findings`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return findings.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-kernel-declarations: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
