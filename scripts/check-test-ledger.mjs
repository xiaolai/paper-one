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
 *   - A name that exists and is not in the ledger → ALLOWED, and COUNTED.
 *     Adding tests is the thing this repository wants to be frictionless, and
 *     a guard that made it a chore would be routed around within a week — so
 *     it never blocks. But an unrecorded test is a real gap: added in a green
 *     commit and never written down, it can be deleted later with nothing to
 *     report, because it was never in the ledger to go missing from. The
 *     summary says how many there are, which is the same treatment deletion
 *     gets — made legible rather than prevented.
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
      /* AN OPTION IS NOT A DIRECTORY. `--root --write` swallowed the flag as
       * the path, so the check ran against a directory literally named
       * `--write` — which does not exist, so it found no tests, reported
       * everything gone, and the `--write` the caller asked for never
       * happened. A mistyped command must say so, not do something else. */
      if (value.startsWith('--')) return { error: `--root needs a directory, not ${value}` }
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

/**
 * The committed ledger, or `null` when there is none.
 *
 * NULL AND NOT `[]`, because the difference is the whole guard. An absent
 * ledger used to read as an empty one, so `rm tests/ledger.json` turned the
 * check into a no-op that still exited 0 — every recorded name gone, nothing
 * reported, green. A guard that a single deletion disables while continuing
 * to say "pass" is worse than no guard, because it is trusted.
 *
 * Absence is only legitimate under `--write`, which is how the first ledger
 * gets written; checking against one that is not there is refused by name.
 */
export function readLedger(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, LEDGER), 'utf8'))
    if (!Array.isArray(parsed?.tests)) throw new Error(`${LEDGER} has no "tests" array`)
    return parsed.tests
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null
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
  /* COUNTED, not membership-tested.
   *
   * Two tests in one file can share a full name — the same `it` text under the
   * same `describe`, which nothing forbids and copy-paste produces. A `Set`
   * collapses them, so deleting ONE of a duplicated pair left the name still
   * "live" and the removal went unreported: exactly the disappearance this
   * guard exists to catch, hidden by the shape of the check.
   *
   * A multiset says two were recorded and one remains, so one is gone. */
  const live = new Map()
  for (const name of current) live.set(name, (live.get(name) ?? 0) + 1)
  const gone = []
  for (const name of recorded) {
    const left = live.get(name) ?? 0
    if (left > 0) live.set(name, left - 1)
    else gone.push(name)
  }
  return gone
}

/**
 * The ledger's own header, written by this script so it survives every
 * regeneration — which is the only way a rule about the ledger stays with it.
 *
 * THE SECOND SENTENCE IS A MEASURED FINDING, not advice. Three names under
 * `scripts/word-snap-live.test.mjs`'s `describe.skipIf(noConfig)` were once
 * recorded here from a machine that happened to have
 * `.claude/tdd-guardian/config.json`. That path is gitignored, so no fresh
 * clone has it, so Vitest does not COLLECT those names anywhere else — and
 * this gate, and `pnpm verify` with it, was red for everyone but that one
 * machine. A ledger cannot hold a conditional name: "gone" and "not
 * collected here" are the same observation to it, and the whole design rests
 * on that observation meaning deletion.
 */
export const LEDGER_NOTE =
  'Regenerate with `pnpm test:ledger --write`. See scripts/check-test-ledger.mjs. ' +
  'Do not record a test whose suite is gated on something a fresh clone does not have ' +
  '(a `describe.skipIf` over an untracked file): it is not collected there, this gate reads ' +
  'that as a deletion, and the run is red for everyone but the machine that wrote it.'

export function writeLedger(root, tests) {
  const body = { note: LEDGER_NOTE, tests }
  const file = path.join(root, LEDGER)
  // The directory may not exist — in a fresh worktree, or the first time this
  // runs anywhere. Failing there would make the guard's own bootstrap its first
  // and least useful error.
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * The suite titles a file gates on a CONDITION, in order.
 *
 * `describe.skipIf(x)('TITLE', …)` and its `runIf` twin are collected or not
 * depending on `x` — so their names are collected on one machine and absent on
 * another, and this ledger cannot hold such a name: "gone" and "not collected
 * here" are the same observation to it, and the whole design rests on that
 * observation meaning deletion.
 *
 * This is what makes the header's warning enforceable rather than advisory.
 * Three names under `word-snap-live.test.mjs`'s `describe.skipIf(noConfig)`
 * were once recorded from a machine that happened to have a gitignored config
 * file; every other checkout was red, and `pnpm verify` with it.
 *
 * A TEMPLATED TITLE IS NOT MATCHED, and that is stated rather than papered
 * over: the regex reads a plain string literal. A conditional suite titled by
 * interpolation would slip past this and is caught by the same red run it
 * always was.
 */
/**
 * The character ranges of `source` that a scan must not read as code: string
 * literals, and comments.
 *
 * A `describe.skipIf(…)` written INSIDE A STRING is not a call — it is test
 * data, and this file's own suite contains several. Scanning the raw text
 * refused them, which is a false positive on the one guard whose job is to be
 * believed.
 *
 * COMMENTS ARE SKIPPED BEFORE STRINGS, and that ordering is the whole
 * correctness of this function. Prose is full of apostrophes — "the guard's",
 * "this file's" — and a scanner that treats one as a quote swallows everything
 * to the next apostrophe, which then covers or uncovers arbitrary code. The
 * first version did exactly that and reported a call inside a string as real
 * anyway, because a comment two hundred lines earlier had shifted its idea of
 * where the strings were.
 *
 * A regex literal containing a quote would still confuse it; none of this
 * repository's test sources has one, and a false REFUSAL is loud rather than
 * silent.
 */
function opaqueRanges(source) {
  const ranges = []
  let at = 0
  while (at < source.length) {
    const two = source.slice(at, at + 2)
    if (two === '//') {
      const end = source.indexOf('\n', at)
      at = end === -1 ? source.length : end + 1
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', at + 2)
      at = end === -1 ? source.length : end + 2
      continue
    }
    const ch = source[at]
    if (ch === "'" || ch === '"' || ch === '`') {
      const from = at
      at += 1
      while (at < source.length) {
        if (source[at] === '\\') at += 2
        else if (source[at] === ch) break
        else at += 1
      }
      ranges.push([from, Math.min(at, source.length - 1)])
      at += 1
      continue
    }
    at += 1
  }
  return ranges
}

const insideString = (ranges, at) => ranges.some(([from, to]) => at > from && at < to)

export function conditionalSuites(source) {
  const strings = opaqueRanges(source)
  const titles = []
  const opener = /\b(?:describe|it|test)\s*\.\s*(?:skipIf|runIf)\s*\(/g
  for (const match of source.matchAll(opener)) {
    /* THE CONDITION'S PARENTHESES ARE BALANCED, not stopped at the first `)`.
     *
     * The first version used `[^)]*`, which ends inside `existsSync(FILE)` —
     * so a suite gated on any call at all was invisible to this, which is the
     * shape most real gates take. A three-name conditional suite was recorded
     * in the ledger while this guard reported nothing. */
    if (insideString(strings, match.index ?? 0)) continue
    let at = (match.index ?? 0) + match[0].length
    let depth = 1
    while (at < source.length && depth > 0) {
      if (source[at] === '(') depth += 1
      else if (source[at] === ')') depth -= 1
      at += 1
    }
    if (depth !== 0) continue
    const after = source.slice(at)
    const title = /^\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(after)
    if (title) titles.push(title[2])
  }
  return titles
}

/**
 * The collected names that sit under a conditional suite, by file.
 *
 * Returns `[]` when nothing does, which is the ordinary case and the one that
 * must stay silent.
 */
export function conditionalNames(root, names) {
  const byFile = new Map()
  for (const name of names) {
    const file = name.slice(0, name.indexOf(' > '))
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(name)
  }
  const refused = []
  for (const [file, held] of byFile) {
    let source
    try {
      source = readFileSync(path.join(root, file), 'utf8')
    } catch {
      /* A collected file that cannot be read is a different problem, and the
       * collection itself would have failed first. */
      continue
    }
    for (const title of conditionalSuites(source)) {
      /* AN INTERPOLATED TITLE CANNOT BE MATCHED, so it is REFUSED rather than
       * missed. The source says `describe.skipIf(x)(\`a ${'${name}'} b\`)` and the
       * collected name says `a Moby-Dick b`; comparing them finds nothing, so
       * a guard that merely failed to match here would report success over
       * exactly the case it exists for. Refusing names the file and asks for a
       * literal title, which costs one edit. */
      if (title.includes('${')) {
        refused.push(`${file} > <a conditional suite titled by interpolation: ${title}>`)
        continue
      }
      const prefix = `${file} > ${title}`
      for (const name of held) if (name === prefix || name.startsWith(`${prefix} > `)) refused.push(name)
    }
  }
  return refused
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
  /* THE LEDGER IS READ FIRST, before Vitest is asked to collect.
   *
   * Collection takes minutes on a loaded machine, and refusing afterwards
   * means paying all of it to say "there was nothing to check against". It
   * also made the refusal hard to observe: a run that timed out inside
   * `askVitest` exited 2 as well, which is the same code this returns, and
   * the two are indistinguishable from the outside. Cheap check first. */
  const held = readLedger(args.root)
  if (held === null && !args.write) {
    process.stderr.write(
      `check-test-ledger: ${LEDGER} is missing, so there is nothing to check against.\n` +
        'A deleted ledger is not an empty one — restore it from version control, or\n' +
        'run `pnpm test:ledger --write` deliberately to start a new one.\n',
    )
    return 2
  }
  const recorded = held ?? []
  const current = askVitest(args.root)
  const gone = compare(recorded, current)

  if (args.write) {
    /* REFUSED, NOT WARNED. The header has always said not to record a
     * conditional name; nothing enforced it, so the only thing standing
     * between the ledger and a machine-dependent entry was whoever happened
     * to run `--write` remembering the rule. */
    const conditional = conditionalNames(args.root, current)
    if (conditional.length > 0) {
      process.stderr.write(
        `check-test-ledger: refusing to record ${conditional.length} name(s) collected from a CONDITIONAL suite:\n` +
          conditional.map((name) => `  ${name}\n`).join('') +
          '\nA `describe.skipIf`/`runIf` suite is collected on some machines and not others, and\n' +
          'this ledger cannot hold such a name: "gone" and "not collected here" are the same\n' +
          'observation to it. Make the suite unconditional, or move it to a file this gate does\n' +
          'not collect.\n',
      )
      return 2
    }
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
  /* UNRECORDED TESTS ARE COUNTED, not charged for.
   *
   * Additions are free on purpose — a guard that made adding a test a chore
   * would be routed around within a week — and that leaves one real gap: a
   * test added in a green commit and never recorded can be DELETED later with
   * nothing to report, because it was never in the ledger to go missing from.
   *
   * Refusing additions would close it and break the thing the ratchet is for.
   * Saying how many there are closes it differently: the same treatment
   * deletion gets, which is to be made LEGIBLE rather than prevented. Exit
   * code unchanged, so nothing is blocked. */
  const unrecorded = current.length - (recorded.length - gone.length)
  if (unrecorded > 0) {
    lines.push('')
    lines.push(`${unrecorded} collected test(s) are not in the ledger, so their later removal`)
    lines.push('would not be reported. `pnpm test:ledger --write` records them.')
  }
  lines.push(
    `check-test-ledger: ${current.length} tests collected, ${recorded.length} recorded, ` +
      `${gone.length} gone, ${unrecorded} unrecorded`,
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
