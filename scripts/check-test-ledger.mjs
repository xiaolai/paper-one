import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm test:ledger` — a test that disappears has to say so out loud.
 *
 * WHAT THIS EXISTS FOR, precisely, because a guard without its incident is a
 * guard nobody dares delete and nobody trusts. A scripted edit truncated
 * `pageTurn.test.ts` while splitting a commit, and took four `describe` blocks
 * — twelve tests — with it. Nothing caught it. `pnpm verify` stayed green
 * through two commits, because the same change ADDED fourteen tests: the file
 * went from 15 to 17 and the total went up. Coverage did not move either; the
 * deleted tests asserted attribute WRITES on a fake renderer, and every line
 * they touched was still executed by their replacements.
 *
 * So the hole is specific and none of the existing gates can see it: deleting
 * a test is invisible to every signal that measures how much ran, because the
 * thing that stopped running stopped being counted at the same moment.
 *
 * A RISING TEST COUNT IS NOT EVIDENCE THAT NOTHING WAS LOST. That sentence is
 * the whole design. This does not count tests; it names them, and compares the
 * names against a ledger committed beside them.
 *
 * WHAT IT REFUSES, and what it does not:
 *
 *   - A name in the ledger that no longer exists  → FINDING. Deleted, renamed
 *     or moved between files, all of which are the same to a reader six months
 *     later: an assertion that used to hold and now does not run.
 *   - A name that exists and is not in the ledger → allowed, silently. Adding
 *     tests is the thing this repository wants to be frictionless, and a guard
 *     that made it a chore would be routed around within a week.
 *
 * So the ledger is a RATCHET, not a snapshot. It never blocks growth, and the
 * only way past it is `--write`, which puts every removed name in the diff
 * where a reviewer sees it and has to agree. That is the entire mechanism: it
 * does not prevent deletion, it makes deletion legible.
 *
 * It asks Vitest rather than parsing source, for the same reason
 * `check-test-projects` does: the question is what `pnpm test` actually runs,
 * and a regex over `it(` would answer a different one — it cannot see a suite
 * skipped by `describe.skipIf`, a name built from a template, or a file no
 * project collects.
 *
 * Findings one per line, then a summary; exit 0 when clean, 1 on a finding,
 * 2 on a usage error or when Vitest itself could not answer.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-test-ledger.mjs [--root <dir>] [--write]'
/** Beside the tests it accounts for, and committed. */
export const LEDGER = 'tests/ledger.json'

const require = createRequire(import.meta.url)

/** `{ root, write }` or `{ error }`. Anything not understood is an error. */
export function parseArgs(argv, cwd = process.cwd()) {
  let root
  let write = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--write') {
      write = true
    } else if (arg === '--root') {
      const value = argv[++i]
      if (value === undefined) return { error: '--root needs a directory' }
      if (root !== undefined) return { error: '--root given twice' }
      root = value
    } else {
      return { error: `unknown argument ${arg}` }
    }
  }
  return { root: path.resolve(cwd, root ?? REPO_ROOT), write }
}

/**
 * Every test Vitest would run, as `file > name`, sorted.
 *
 * Throws when Vitest exits non-zero or prints something that is not the shape
 * expected — an unanswerable question must not read as "no tests", which is
 * the exact failure this script exists to catch, arriving through the front
 * door.
 */
export function askVitest(root) {
  const bin = require.resolve('vitest/vitest.mjs')
  const result = spawnSync(process.execPath, [bin, 'list', '--json', '--root', root], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`vitest list exited ${result.status}\n${result.stderr}${result.stdout}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(`vitest list printed something other than JSON:\n${result.stdout}`, { cause })
  }
  if (!Array.isArray(parsed)) throw new Error('vitest list --json did not print an array')
  if (parsed.length === 0) throw new Error('vitest list collected no tests at all')
  return parsed
    .map((entry, i) => {
      if (typeof entry?.name !== 'string') throw new Error(`vitest list entry ${i} has no name`)
      if (typeof entry?.file !== 'string') throw new Error(`vitest list entry ${i} has no file`)
      return `${toPosix(path.relative(root, entry.file))} > ${entry.name}`
    })
    .sort()
}

/** The committed ledger, or `[]` when there is none yet. */
export function readLedger(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, LEDGER), 'utf8'))
    if (!Array.isArray(parsed?.tests)) throw new Error(`${LEDGER} has no "tests" array`)
    return parsed.tests
  } catch (cause) {
    if (cause?.code === 'ENOENT') return []
    throw cause
  }
}

/**
 * Which recorded tests are gone.
 *
 * Only removals. See the head of this file: additions are free on purpose, and
 * a guard that charged for them would be turned off.
 */
export function compare(recorded, current) {
  const live = new Set(current)
  return recorded.filter((name) => !live.has(name))
}

export function writeLedger(root, tests) {
  const body = { note: 'Regenerate with `pnpm test:ledger --write`. See scripts/check-test-ledger.mjs.', tests }
  const file = path.join(root, LEDGER)
  // The directory may not exist — in a fresh worktree, or the first time this
  // runs anywhere. Failing there would make the guard's own bootstrap its first
  // and least useful error.
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error !== undefined) {
    process.stderr.write(`check-test-ledger: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const current = askVitest(args.root)
  const recorded = readLedger(args.root)
  const gone = compare(recorded, current)

  if (args.write) {
    writeLedger(args.root, current)
    const added = current.length - (recorded.length - gone.length)
    process.stdout.write(
      `check-test-ledger: wrote ${current.length} tests (${added} added, ${gone.length} removed)\n`,
    )
    return 0
  }

  const lines = gone.map((name) => `GONE ${name}`)
  if (gone.length > 0) {
    lines.push('')
    lines.push('These tests are in the ledger and Vitest no longer collects them.')
    lines.push('If that is deliberate, run `pnpm test:ledger --write` and commit the')
    lines.push('ledger with the change, so the removal is visible in the diff.')
  }
  lines.push(
    `check-test-ledger: ${current.length} tests collected, ${recorded.length} recorded, ${gone.length} gone`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return gone.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-test-ledger: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
