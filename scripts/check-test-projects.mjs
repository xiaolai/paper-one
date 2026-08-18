import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm test:projects` — every test file belongs to exactly one Vitest project.
 *
 * `vitest.config.ts` declares projects, and from that moment a test file is
 * run only if some project's `include` matches it. A file no project matches
 * DROPS OUT SILENTLY with the run still green; a file two projects match runs
 * twice under two names. Neither is an error to Vitest. This script makes
 * both one.
 *
 * It does not re-implement Vitest's globbing. It asks Vitest which files each
 * project collects (`vitest list --filesOnly --json`, which globs without
 * importing anything) and compares that answer with the tree: every
 * `*.test.*` file under `src/` and `scripts/` must appear exactly once. That
 * way the check measures what `pnpm test` actually does, and a pattern the
 * two would read differently cannot open a gap between them.
 *
 * Findings, one per line, then a summary; exit 0 when clean, 1 on a finding,
 * 2 on a usage error or when Vitest itself could not answer.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-test-projects.mjs [--root <dir>]'
/** Directories holding test files, relative to the root. A project whose
 *  include reaches outside these is reported: the walk would not see its
 *  files, so an orphan there could never be found. */
export const SCAN_ROOTS = ['src', 'scripts']
/** `foo.test.ts`, `foo.test.tsx`, `foo.test.mjs`, `foo.contract.test.ts` —
 *  a basename with a `.test.` segment. `foo.testkit.ts` is not one. */
const TEST_FILE = /\.test\.[^./]+$/

const require = createRequire(import.meta.url)

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

/** Every test file under the scan roots, as root-relative posix paths, sorted.
 *  A scan root that does not exist is skipped: `scripts/` is optional in a
 *  fixture tree, and an absent directory holds no orphans. */
export function listTestFiles(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && TEST_FILE.test(entry.name)) found.push(toPosix(path.relative(root, full)))
    }
  }
  for (const name of SCAN_ROOTS) {
    const dir = path.join(root, name)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(dir)
  }
  return found.sort()
}

/**
 * What Vitest would collect: `[{ file, projectName }]` from
 * `vitest list --filesOnly --json`, with `file` made root-relative. Throws
 * when Vitest exits non-zero or prints something that is not that shape —
 * an unanswerable question must not read as "no files".
 */
export function askVitest(root) {
  const bin = require.resolve('vitest/vitest.mjs')
  const result = spawnSync(process.execPath, [bin, 'list', '--filesOnly', '--json', '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`vitest list exited ${result.status}\n${result.stderr}${result.stdout}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`vitest list printed something other than JSON:\n${result.stdout}\n${result.stderr}`, { cause })
  }
  if (!Array.isArray(parsed)) throw new Error('vitest list --json did not print an array')
  return parsed.map((entry, i) => {
    if (typeof entry?.file !== 'string') throw new Error(`vitest list entry ${i} has no file`)
    return {
      file: toPosix(path.relative(root, entry.file)),
      project: typeof entry.projectName === 'string' ? entry.projectName : '(unnamed)',
    }
  })
}

/**
 * Compare the tree with Vitest's answer. Pure: takes the file list and the
 * collected list, returns findings and per-project counts.
 *
 * Findings:
 * - `ORPHAN` — a test file no project collects;
 * - `DOUBLE` — a test file more than one project collects;
 * - `OUTSIDE` — a project collects a file outside the scan roots (the walk
 *   would never see an orphan beside it, so the check is not covering it).
 */
export function compare(files, collected) {
  const byFile = new Map()
  for (const { file, project } of collected) {
    const projects = byFile.get(file) ?? []
    projects.push(project)
    byFile.set(file, projects)
  }
  const counts = new Map()
  for (const { project } of collected) counts.set(project, (counts.get(project) ?? 0) + 1)

  const findings = []
  const known = new Set(files)
  for (const file of files) {
    const projects = byFile.get(file)
    if (!projects) findings.push({ code: 'ORPHAN', file, message: 'no project includes this test file' })
    else if (projects.length > 1) {
      findings.push({ code: 'DOUBLE', file, message: `included by ${projects.length} projects: ${projects.sort().join(', ')}` })
    }
  }
  const inScanRoots = (file) => SCAN_ROOTS.some((r) => file === r || file.startsWith(`${r}/`))
  for (const [file, projects] of [...byFile].sort()) {
    if (known.has(file)) continue
    findings.push({
      code: inScanRoots(file) ? 'UNSCANNED' : 'OUTSIDE',
      file,
      message: inScanRoots(file)
        ? `collected by ${projects.join(', ')} but not a *.test.* file this check recognises`
        : `collected by ${projects.join(', ')} outside ${SCAN_ROOTS.join('/, ')}/ — extend SCAN_ROOTS`,
    })
  }
  return { findings, counts }
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`check-test-projects: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const files = listTestFiles(args.root)
  const collected = askVitest(args.root)
  const { findings, counts } = compare(files, collected)
  const lines = findings.map((f) => `${f.code} ${f.file}: ${f.message}`)
  for (const [project, n] of [...counts].sort()) lines.push(`  ${project}: ${n} file${n === 1 ? '' : 's'}`)
  lines.push(`check-test-projects: ${files.length} test files, ${counts.size} projects, ${findings.length} findings`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return findings.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-test-projects: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
