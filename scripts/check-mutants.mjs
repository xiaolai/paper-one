import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm mutants` — a test that cannot fail is a red gate.
 *
 * ## What this exists for, precisely
 *
 * ⚠️ **EVERY OTHER GATE HERE MEASURES HOW MUCH CODE RAN. NONE OF THEM ASKS
 * WHETHER A TEST WOULD NOTICE IF THE CODE WERE WRONG.** Coverage says a line
 * executed. `test:ledger` says a test still exists. Both are satisfied by an
 * assertion that holds whatever the code does — and this repository has now
 * produced six of those in one branch, each found only by planting the defect
 * back by hand and watching:
 *
 *   - a race test that RELEASED two threads and hoped they would interleave;
 *   - an unsubscribe test that needed the same listener in two sets to tell the
 *     bug apart, and did not have it;
 *   - a "covers the window" test asserting only that a class name existed;
 *   - a "refused without verifying" test built on a VALID signature, so it read
 *     the same whether verification ran first or not;
 *   - a frame-cap test that tried `MAX + 1` and never the cap itself;
 *   - a phrase test that swapped the whole component instead of one identity.
 *
 * Two of the SHIPPED defects on the same branch were the identical mistake in
 * production: a `RosterTie` branch asking the same question as the line above
 * it, and a "whitelist" that only refused values which were already strings. So
 * this is not a testing habit — it is a reasoning habit, and the reason it is
 * worth a gate is that it is invisible to review. A green non-discriminating
 * test looks exactly like a green discriminating one.
 *
 * Mutation testing is that check, mechanised: break the code on purpose, and
 * report every break no test objected to.
 *
 * ## Scoped to the diff, and why that is the whole design
 *
 * ⚠️ **MUTATING THE WHOLE TREE IS NOT AFFORDABLE AND WOULD BE ROUTED AROUND.**
 * Measured on this machine: one 217-line module is ~17s once the run is scoped;
 * the same run against the repository's own vitest config took **8m26s and did
 * not finish**, because Stryker's dry run executes the entire suite before it
 * mutates anything. A gate nobody can afford to run is a gate nobody runs.
 *
 * So this mutates only what the branch changed, and runs only the tests that
 * import those files. Both narrowings are what make the cost proportional to
 * the change rather than to the repository.
 *
 * ## One file at a time, because batching MEASURES WRONG
 *
 * ⚠️ **THE BATCHED RUN DID NOT MERELY TAKE LONGER — IT REPORTED FALSE
 * NUMBERS.** Measured on this branch: `store.ts` mutated ALONE against its own
 * test file gives 85 killed, 43 survived, 1 uncovered in 20s. The identical
 * file inside a 38-file run reports **129 uncovered and 0 survived** — Stryker's
 * per-test coverage attribution collapses across 109 test files spanning two
 * environments (every jsdom file here declares its own with a pragma, so one
 * run is not one pool). `foreign.ts` likewise scored 87.5% alone and showed 56
 * uncovered in the batch.
 *
 * A slow gate is an annoyance. A gate that reports "no test covers this" about
 * code with forty-five passing tests is worse than no gate: it trains a reader
 * to disbelieve it, and the first real finding then reads as more noise. So
 * each subject is mutated in its own run, against only its own covering tests.
 * The cost is linear in the size of the diff — which is the property that makes
 * it affordable for the change somebody is actually making.
 *
 * ## Why a survivor fails rather than a score
 *
 * ⚠️ **NO THRESHOLD, BECAUSE A THRESHOLD IS A NUMBER SOMEBODY LOWERS.** The
 * sample that motivated this had SIX survivors and zero equivalent mutants —
 * every one was a real gap. Scoped to a diff the count is small enough to
 * triage, which is what makes "none may survive" honest rather than punitive.
 *
 * The escape hatch is Stryker's own `// Stryker disable next-line <mutator>:
 * <reason>` — written beside the code, in words, the way every other decision
 * in this repository is recorded. That is deliberately more effort than a
 * number in a config file.
 */

const SRC = /^(src|scripts)\/.+\.(ts|tsx|mjs)$/u
const NOT_A_SUBJECT = /\.(test|testkit|contract\.test)\.(ts|tsx|mjs)$|\.d\.ts$/u

/** The branch's own changes: committed since the base, plus what is uncommitted. */
export function changedFiles(base = 'main') {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
  let from = base
  try {
    from = execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8' }).trim()
  } catch {
    /* No such base — a detached checkout, or a clone with one branch. Falling
       back to the working tree alone is the honest answer: it is a smaller
       scope, never a wrong one. */
    from = null
  }
  const names = new Set([
    ...(from === null ? [] : git(['diff', '--name-only', from, '--'])),
    ...git(['diff', '--name-only', '--']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])
  return [...names].filter((f) => SRC.test(f) && !NOT_A_SUBJECT.test(f) && existsSync(f))
}

/**
 * The test files that import a module, by resolved path.
 *
 * ⚠️ **NOT THE SAME-NAME TEST FILE.** Plenty here are not named after what they
 * test — `store.ts` is covered by `circle.test.ts`, `panes.ts` by
 * `commands.test.ts` — so matching on the name would report those modules as
 * having no coverage and turn every one of their mutants into a false finding.
 * Following the imports is the question actually being asked: which tests would
 * have had a chance to object.
 */
export function testsCovering(subjects, allTests) {
  const wanted = new Set(subjects.map((f) => path.resolve(f)))
  const found = new Set()
  for (const test of allTests) {
    const source = readFileSync(test, 'utf8')
    for (const spec of source.matchAll(/from\s+'(\.[^']+)'/gu)) {
      const target = path.resolve(path.dirname(test), spec[1])
      for (const ext of ['.ts', '.tsx', '.mjs', '/index.ts']) {
        if (wanted.has(target + ext) || wanted.has(target)) found.add(test)
      }
    }
  }
  return [...found]
}

/**
 * Subjects that cannot be instrumented, because a test asserts on their TEXT.
 *
 * ⚠️ **THIS REPOSITORY DELIBERATELY TESTS SOME SOURCE AS SOURCE** — 33 files
 * read a module and assert on what it says, which is how `capabilityStyle`,
 * `composition.contract` and `cookieLeak` catch what a type cannot. Stryker
 * rewrites a mutated file to insert its switches, so those assertions compare
 * against instrumented text and fail in the DRY RUN — before a single mutant is
 * evaluated, taking the whole gate down with a message about an unrelated test.
 *
 * That is a permanent incompatibility between the two techniques, not a defect
 * in either. The subject is dropped, and — this is the part that matters —
 * PRINTED on every run. A silent exclusion list is the thing this gate exists
 * to avoid becoming; one that announces itself can be argued with.
 */
export function cannotBeInstrumented(subjects, allTests) {
  const readsText = allTests.filter((t) => readFileSync(t, 'utf8').includes('readFileSync'))
  const blocked = new Set(testsCovering(subjects, readsText).flatMap((t) => t))
  return subjects.filter((subject) => testsCovering([subject], [...blocked]).length > 0)
}

const A_TEST = /\.test\.(ts|tsx|mjs)$/u

/**
 * Every test file, tracked or not.
 *
 * ⚠️ **`git ls-files` ALONE MISSES EVERY UNTRACKED ONE, AND THAT IS THE SET
 * THAT MATTERS MOST.** New work on a branch is new files; on this branch the
 * whole of `src/capabilities/circle/` is untracked, so the first version of
 * this function found none of its tests, decided the changed modules had no
 * coverage, and printed "none imported by any test" — a green, confident,
 * completely empty run. A gate that quietly measures nothing looks exactly
 * like a gate that passed, which is the failure mode every other check in this
 * repository is written to avoid.
 *
 * `--others --exclude-standard` is the second half: untracked, minus anything
 * `.gitignore` covers.
 */
function allTestFiles() {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
  return [
    ...new Set([
      ...git(['ls-files', 'src', 'scripts']),
      ...git(['ls-files', '--others', '--exclude-standard', 'src', 'scripts']),
    ]),
  ].filter((f) => A_TEST.test(f) && existsSync(f))
}

function run(argv) {
  const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'main'
  /* `--only <substring>` narrows to one module while working on it. The whole
     value of this gate is being cheap enough to run mid-change. */
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
  const subjects = changedFiles(base).filter((f) => only === null || f.includes(only))
  if (subjects.length === 0) {
    process.stdout.write('check-mutants: nothing changed to mutate\n')
    return 0
  }
  const all = allTestFiles()
  const blocked = cannotBeInstrumented(subjects, all)
  const mutable = subjects.filter((f) => !blocked.includes(f))
  if (blocked.length > 0) {
    process.stdout.write(
      `check-mutants: ${blocked.length} file(s) not mutated — a test asserts on their source text:\n` +
        blocked.map((f) => `  ${f}\n`).join(''),
    )
  }
  if (mutable.length === 0) {
    process.stdout.write('check-mutants: nothing left to mutate\n')
    return 0
  }
  const tests = testsCovering(mutable, all)
  if (tests.length === 0) {
    /* ⚠️ NOT A PASS AND NOT A FAILURE OF THIS GATE. Changed code that no test
       imports is `test:coverage`'s finding, and reporting it here as a mutation
       result would put one fact under two names. */
    process.stdout.write(
      `check-mutants: ${subjects.length} changed file(s), none imported by any test — see test:coverage\n`,
    )
    return 0
  }

  /* ⚠️ **BOTH GENERATED FILES LIVE IN THE REPOSITORY, NOT IN `tmpdir()`.**
   * Stryker copies the tree into a sandbox and runs from there, so a config in
   * `/tmp` is never copied — and even read in place it cannot resolve
   * `vitest/config`, because node_modules is not reachable from outside the
   * project. At the root, the config lands at the sandbox root and every
   * relative path in it resolves the same way it does here. Both are removed in
   * the `finally` below, and `.gitignore` covers the window in between. */
  const vitestConfig = 'vitest.mutants.mjs'
  const config = 'stryker.mutants.json'

  process.stdout.write(
    `check-mutants: mutating ${mutable.length} changed file(s), one run each\n`,
  )
  const unkilled = []
  try {
    for (const [at, subject] of mutable.entries()) {
      const covering = testsCovering([subject], all)
      if (covering.length === 0) {
        /* Changed code no test imports is `test:coverage`'s finding. Naming it
           here as well would put one fact under two gates. */
        process.stdout.write(`  [${at + 1}/${mutable.length}] ${subject} — no test imports it\n`)
        continue
      }
      process.stdout.write(`  [${at + 1}/${mutable.length}] ${subject}\n`)
      /* A plain object rather than `defineConfig`: one import fewer to resolve
         in a sandbox, and vitest accepts either. Only THIS subject's tests, so
         per-test coverage attribution stays sound — see the header. */
      writeFileSync(
        vitestConfig,
        `export default { test: {\n` +
          `  environment: 'node',\n` +
          `  setupFiles: ['./vitest.setup.ts'],\n` +
          `  include: ${JSON.stringify(covering)},\n` +
          `  testTimeout: 15000,\n` +
          `} }\n`,
      )
      writeFileSync(config, JSON.stringify(strykerConfig(subject, vitestConfig), null, 2))
      try {
        execFileSync('npx', ['stryker', 'run', config], { stdio: 'inherit' })
      } catch {
        unkilled.push(subject)
      }
      rmSync('.stryker-tmp', { recursive: true, force: true })
    }
  } finally {
    rmSync(vitestConfig, { force: true })
    rmSync(config, { force: true })
    rmSync('.stryker-tmp', { recursive: true, force: true })
  }

  if (unkilled.length === 0) {
    process.stdout.write('check-mutants: every mutant was killed\n')
    return 0
  }
  process.stderr.write(
    `check-mutants: a mutant survived in ${unkilled.length} file(s) — a test that cannot fail is not a test.\n` +
      unkilled.map((f) => `  ${f}\n`).join('') +
      '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
      '  mutation is genuinely equivalent, say so beside the code:\n' +
      "    // Stryker disable next-line <mutator>: <why it cannot be observed>\n",
  )
  return 1
}

/** Stryker's settings for one subject. */
function strykerConfig(subject, vitestConfig) {
  return {
    packageManager: 'pnpm',
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    reporters: ['clear-text'],
    coverageAnalysis: 'perTest',
    mutate: [subject],
    vitest: { configFile: vitestConfig },
    /* ⚠️ Stryker copies the tree into a sandbox and `copyFile` REFUSES a
       symlink — `.agents/skills` and `.claude/skills/*` are symlinks here, and
       the run died on them with `ENOTSUP` before mutating anything. */
    ignorePatterns: [
      '.agents',
      '.claude',
      '.codex',
      '.cc-suite',
      '.stryker-tmp',
      'src-tauri/target',
      'coverage',
      'dist',
      'dist-mobile',
      'bin',
      'dev-docs',
      'docs',
      '.git',
    ],
    timeoutMS: 20000,
    /* A survivor is the finding; the score is only how it is summarised. */
    thresholds: { high: 100, low: 100, break: 100 },
  }
}

if (isProcessEntry(import.meta)) {
  process.exitCode = run(process.argv.slice(2))
}
