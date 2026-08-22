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
 * WRITE FROM A CLEAN CHECKOUT, and this is not a style note. The ledger
 * records what Vitest COLLECTS, and collection can depend on files the
 * repository does not contain: `word-snap-live.test.mjs` gates a suite on
 * `.claude/tdd-guardian/config.json`, which is gitignored. A `--write` run on
 * a machine holding that file records three tests no clean checkout can
 * collect, and every clean checkout then reports them GONE — which is exactly
 * how `main` went red on 2026-08-21 with no code change behind it.
 *
 * The asymmetry is what makes the cure work: extra tests on a developer's
 * machine are ADDITIONS, which are free and silent. So a ledger written
 * without the machine-local files is green everywhere, and one written with
 * them is red everywhere else.
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

/**
 * A suite that says, in its own name, that it may not be collected here.
 *
 * THE RULE ABOVE WAS DOCUMENTED AND ENFORCED BY NOTHING, and it broke twice.
 * `0596b95` removed three such entries and wrote the paragraph explaining why;
 * `c4fe205` put them straight back, because a `--write` on a machine holding
 * `.claude/tdd-guardian/config.json` records them without comment. The second
 * occurrence is what makes this a mechanism rather than a mistake: a rule that
 * only a prose paragraph defends is a rule the next `--write` will break.
 *
 * The convention it keys on already existed — `word-snap-live.test.mjs` names
 * its own condition, "the live lane (skipped when this checkout has no
 * .claude/tdd-guardian/config.json)". A suite that declares itself conditional
 * is a suite the ledger must not record, and that is now checkable rather than
 * merely written down.
 */
export const CONDITIONAL = /\(skipped when this checkout has no /

/** The recorded names that declare themselves conditional — always a finding. */
export function conditional(names) {
  return names.filter((name) => CONDITIONAL.test(name))
}

export function writeLedger(root, tests) {
  /* DROPPED ON THE WAY IN, so a `--write` from a developer's machine produces
     the same ledger a clean checkout would. This is the half that stops the
     regression rather than reporting it. */
  const keep = tests.filter((name) => !CONDITIONAL.test(name))
  const body = { note: 'Regenerate with `pnpm test:ledger --write`. See scripts/check-test-ledger.mjs.', tests: keep }
  const file = path.join(root, LEDGER)
  // The directory may not exist — in a fresh worktree, or the first time this
  // runs anywhere. Failing there would make the guard's own bootstrap its first
  // and least useful error.
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
  return tests.length - keep.length
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
    const skipped = writeLedger(args.root, current)
    const kept = current.length - skipped
    const added = kept - (recorded.length - gone.length)
    const note = skipped > 0 ? `, ${skipped} conditional not recorded` : ''
    process.stdout.write(
      `check-test-ledger: wrote ${kept} tests (${added} added, ${gone.length} removed${note})\n`,
    )
    return 0
  }

  /* CHECKED EVERYWHERE, not only where it bites. A conditional entry is
     invisible on the machine that recorded it and fatal on every other, so
     reporting it only where it fails would leave the person who can fix it as
     the one person who never sees it. */
  const conditionals = conditional(recorded)
  const lines = conditionals.map((name) => `CONDITIONAL ${name}`)
  if (conditionals.length > 0) {
    lines.push('')
    lines.push('These names say they are skipped unless a gitignored file is present,')
    lines.push('so a clean checkout reports them GONE. Re-run `pnpm test:ledger --write`,')
    lines.push('which now drops them, and commit the ledger.')
    lines.push('')
  }
  lines.push(...gone.map((name) => `GONE ${name}`))
  if (gone.length > 0) {
    lines.push('')
    lines.push('These tests are in the ledger and Vitest no longer collects them.')
    lines.push('If that is deliberate, run `pnpm test:ledger --write` and commit the')
    lines.push('ledger with the change, so the removal is visible in the diff.')
  }
  lines.push(
    `check-test-ledger: ${current.length} tests collected, ${recorded.length} recorded, ${gone.length} gone, ${conditionals.length} conditional`,
  )
  process.stdout.write(`${lines.join('\n')}\n`)
  return gone.length > 0 || conditionals.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-test-ledger: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
