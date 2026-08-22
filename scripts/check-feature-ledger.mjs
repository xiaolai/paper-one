import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'
import { checkLedger, formatFinding, formatSummary } from './lib/ledger.mjs'
import { DELETED_ENV } from './verify-without.mjs'

/**
 * `pnpm features:check` — every path `docs/feature-ledger.md` points at exists.
 *
 * The rules are `scripts/lib/ledger.mjs`; this is the shell: read the ledger,
 * probe the tree, print one line per finding, exit 0 clean / 1 findings / 2
 * when the check itself could not run.
 *
 * `--root <dir>` runs it over another tree — the deletion test's copy.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-feature-ledger.mjs [--root <dir>]'
export const LEDGER = 'docs/feature-ledger.md'

/**
 * Every ledger whose `Where` column is checked.
 *
 * `docs/library-ledger.md` was outside this gate until 2026-08-23, and the
 * consequence is the argument for the list: it went from phase 5 to phase 14
 * with every path naming `lib/…`, a directory the kernel carve had emptied,
 * and eighteen rows understating the app — the same drift, in the same shape,
 * that this check was written for after the main ledger showed it. A gate that
 * covers one of two files answers a narrower question than its name suggests.
 */
export const LEDGERS = Object.freeze([LEDGER, 'docs/library-ledger.md'])

export function parseArgs(argv, cwd) {
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

/**
 * Does `rel` name something in the tree?
 *
 * A directory counts: `ui/reader/wordSnap/` is a legitimate answer to "where
 * does this live" for a capability spread over twelve modules.
 *
 * ONLY absence is false. A permission or I/O error reported as "missing" would
 * turn an unreadable tree into a wall of findings that all say the wrong thing,
 * and the run that matters most — CI on a fresh clone — is exactly where an
 * unexpected errno is worth stopping for.
 */
export function makeExists(root) {
  return (rel) => {
    try {
      statSync(path.join(root, rel))
      return true
    } catch (error) {
      if (error && error.code === 'ENOENT') return false
      throw error
    }
  }
}

export function run(root, env = process.env, ledger = LEDGER) {
  let markdown
  try {
    markdown = readFileSync(path.join(root, ledger), 'utf8')
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') {
      /* A tree with no ledger is not a failing ledger. Skipping says so, and
       * says it out loud, rather than reporting zero findings over nothing. */
      return { skipped: `${ledger} is not in this tree`, findings: [], notes: [] }
    }
    throw cause
  }
  /* Inside `verify:without`, the named capability's directory has just been
   * deleted on purpose — see `DELETED_ENV`. */
  return checkLedger({ markdown, exists: makeExists(root), removed: env[DELETED_ENV] })
}

function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`features-check: ${args.error}\n${USAGE}\n`)
    return 2
  }
  /* EVERY LEDGER, AND THE EXIT IS THE WORST OF THEM. Stopping at the first
   * file with findings would hide the second one's behind the first one's,
   * which is how a gate teaches people to fix one thing and re-run. */
  let failed = 0
  const lines = []
  for (const ledger of LEDGERS) {
    const { findings, notes, summary, skipped } = run(args.root, process.env, ledger)
    if (skipped !== undefined) {
      lines.push(`features-check: skipped — ${skipped}`)
      continue
    }
    lines.push(...findings.map((f) => `${ledger}: ${formatFinding(f)}`))
    lines.push(...notes.map((note) => `${ledger} ${note}`))
    lines.push(`${ledger} — ${formatSummary(summary)}`)
    failed += findings.length
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return failed > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`features-check: ${cause?.message ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
