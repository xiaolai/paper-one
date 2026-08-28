import { availableParallelism } from 'node:os'
import { configDefaults, coverageConfigDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

/**
 * The test topology: one Vitest project per boundary.
 *
 * Every test file under `src/` and `scripts/` must land in EXACTLY ONE of the
 * projects below. Vitest does not enforce that — a file no project's `include`
 * matches simply never runs, with the run still green, and a file two projects
 * match runs twice under two names. `pnpm test:projects`
 * (`scripts/check-test-projects.mjs`) is the assertion: it asks Vitest which
 * files each project collects and compares that with the tree.
 *
 * Add a project here when a plan item lands its first test file there; add the
 * matching `exclude` to whichever broader project would otherwise also match
 * it. Every project has files now; `passWithNoTests` stays because
 * `pnpm verify:without <id>` runs this config over a tree with a capability
 * removed — a project emptied by the removal must not fail that run.
 * `test:projects` is what stops the flag from hiding a project whose glob
 * has drifted away from its files.
 *
 * Environment is Node everywhere by default, deliberately: several kernel tests
 * assert that no DOM exists, and the other fifty-odd suites should not pay
 * jsdom's start-up for a DOM they never touch. A suite that genuinely mounts a
 * hook opts in per FILE with `// @vitest-environment jsdom` on its first line —
 * `kernel/ui/hooks/useLibrary.test.ts` is the exemplar; see `dev-docs/hook-tests.md`.
 *
 * `vite.config.ts` is merged in rather than duplicated so the tests see the
 * same plugins and resolution the app is built with — before this file existed
 * Vitest read `vite.config.ts` directly, and this keeps that true.
 */

interface Project {
  readonly name: string
  readonly include: readonly string[]
  /** Narrower projects that would otherwise be matched by this one too. */
  readonly exclude?: readonly string[]
}

const PROJECTS: readonly Project[] = [
  {
    name: 'kernel-unit',
    include: ['src/kernel/**/*.test.{ts,tsx}', 'src/*.test.{ts,tsx}'],
    exclude: ['src/kernel/**/*.contract.test.{ts,tsx}', 'src/kernel/**/*.envelope.test.ts'],
  },
  /* `{ts,tsx}` like every other project's glob. A `.contract.test.tsx`
   matched the broad project instead of this one and ran without the
   contract project's settings — silently, because it still ran. */
  { name: 'kernel-contract', include: ['src/kernel/**/*.contract.test.{ts,tsx}'] },
  {
    name: 'capabilities',
    include: ['src/capabilities/**/*.test.{ts,tsx}'],
    exclude: ['src/capabilities/**/*.envelope.test.ts'],
  },
  /* The envelope's own suites, and — since phase 11 — the CLI's client
   * speaking to a router over the fake wire, which is the same protocol under
   * test from the other end. One project, because "does a command survive the
   * envelope" is one question. */
  {
    name: 'service-envelope',
    /* `src/kernel/core/` since phase 18: the envelope moved there when a second
     * transport needed it, and its suites moved with it. The glob follows the
     * CODE rather than naming a capability — pinned to `peer/` it silently
     * dropped both files into `kernel-unit`, where they still ran and this
     * project quietly became one file. A suite that runs under the wrong
     * project's settings is the failure the note above this list describes. */
    include: [
      'src/kernel/**/*.envelope.test.ts',
      'src/capabilities/**/*.envelope.test.ts',
      'src/cli/**/*.envelope.test.ts',
    ],
  },
  { name: 'hosts', include: ['src/hosts/**/*.test.{ts,tsx}'] },
  {
    name: 'cli',
    include: ['src/cli/**/*.test.{ts,tsx}'],
    exclude: ['src/cli/**/*.envelope.test.ts'],
  },
  { name: 'composition-contract', include: ['src/app/**/*.contract.test.{ts,tsx}'] },
  /* The composition root's own units — the boot orchestration extracted out of
   * `main.tsx` so it CAN be tested. Distinct from the contract project above,
   * which is about what a composition may import; these are about what it
   * does. Without this project a `src/app/*.test.ts` matched nothing at all
   * and ran nowhere, which is the quietest way for a suite to be absent. */
  { name: 'app', include: ['src/app/**/*.test.{ts,tsx}'], exclude: ['src/app/**/*.contract.test.{ts,tsx}'] },
  { name: 'scripts', include: ['scripts/**/*.test.mjs'] },
]

/**
 * Coverage: one root configuration, because Vitest reads `coverage` from the
 * root only — a project-level `coverage` block is silently ignored — so
 * "per project" here means one `include` glob per source area the projects
 * above test. `all: true` makes an untested file count as zero rather than
 * vanish from the total; without it a source area no project reaches reports
 * nothing and drags nothing down.
 *
 * `include` names source areas, not test areas. Test files, test kits, self-tests, the
 * Vite entry and the emitted `.types/` declarations are excluded because a
 * test's own lines being "covered" is not information.
 *
 * Thresholds are the measured baseline (see WI-5.10 in
 * `dev-docs/plans/phase-05-kernel-capabilities.md`), global minus one point so the
 * gate only ratchets up, and the pure-core areas held at their own measured
 * floor. The global set is checked over every file; each glob key is checked
 * again over the files it matches (root-relative), so a core file counts in
 * both. Fail-on-empty is not a Vitest option — Istanbul reads 0 of 0 as 100%,
 * so a drifted glob passes — which is why `pnpm test:coverage` chains
 * `scripts/check-coverage.mjs` after the run: it reads this config back and
 * refuses a summary with no lines, an include area present on disk with
 * nothing measured under it, or a glob threshold matching no file.
 */
const COVERAGE_INCLUDE = ['src/kernel/**', 'src/capabilities/**', 'src/hosts/**', 'src/cli/**', 'src/app/**', 'scripts/**']

/** On top of Vitest's own defaults (test files, config files, node_modules,
 *  dist), which setting `exclude` would otherwise replace. */
const COVERAGE_EXCLUDE = [
  ...coverageConfigDefaults.exclude,
  /* Only what the defaults do NOT already cover: Vitest's own list holds the
   * test-file and declaration-file globs, and repeating them here read as
   * "these are ours to maintain" — so a future change to the defaults would
   * look like a local decision. The three below are this repository's own
   * conventions and belong to it. */
  '**/*.testkit.{ts,tsx}',
  '**/*.selftest.mjs',
  '**/*.d.mts',
  /* The two PROCESS ENTRIES, excluded for one reason: each reads `process`
   * or `document`, writes to a real stream and sets an exit code or mounts a
   * root, so neither can be called by a test — and a file that cannot be
   * called counts as zero and says nothing about the code that can.
   * Everything either of them does beyond wiring lives in a module beside it
   * (`src/cli/paper.ts`, `src/kernel/ui`, `src/app/shutdown.ts`), which IS
   * measured.
   *
   * `main.tsx` IS STILL EXCLUDED AND THE EXCLUSION IS NARROWER THAN IT WAS.
   * It held three hundred lines of migration, shelf recovery, cleanup,
   * composition and the cross-language quit handshake — none of it reachable,
   * all of it unmeasured, and "an untestable entry shim" was not an honest
   * description of it. The handshake now lives in `src/app/shutdown.ts` with
   * its own suite; what remains here genuinely is wiring around a `document`
   * and a native import. */
  'src/main.tsx',
  'src/cli/main.ts',
]

/**
 * A RATCHET, and it only means anything if it is wound.
 *
 * The rule the plan sets: the global gate is the measured baseline MINUS ONE
 * POINT — so a change may cost at most that before it is refused, and nothing
 * lower can be re-declared a baseline — and the pure-core areas are held at
 * their own baseline rounded down. Raise these when coverage rises; never
 * lower them to pass. Lowering is a decision that belongs in a plan, with a
 * reason beside it.
 *
 * THEY HAD NOT BEEN WOUND SINCE PHASE 5. Coverage had risen fifteen points
 * past the global gate and ten past the kernel-core one, so a change could
 * have deleted a third of the kernel's tests and still passed — a ratchet
 * with that much slack is a number, not a gate.
 *
 * Re-baselined 2026-08-23 from `pnpm test:coverage`:
 *   global            65.24 lines / 65.24 statements / 83.59 functions / 89.14 branches
 *   src/kernel/core   93.51 / 93.51 / 93.14 / 93.85
 *   scripts/lib       99.05 / 99.05 / 100.00 / 95.71
 *
 * WOUND AGAIN the same day, and the reason is worth keeping because it will
 * recur. The library screen had no test that so much as IMPORTED it, and a
 * file no test loads is reported by the v8 provider as ONE function rather
 * than its real count. So the first test to render `Library.tsx` did not
 * lower coverage — it revealed it: the denominator grew by eighty-odd
 * functions across `Library`, `BookRow`, `BookCell`, `NarrowMenu`,
 * `TagEditor`, `ToolbarMenu` and `OverlaySheet` at once, and the functions
 * figure fell more than a point with nothing having become less tested.
 *
 * The gate was flattering rather than passing, and no ratchet can see that
 * about a file nothing imports. `LibraryShelf`, `LibraryBulk`,
 * `BookMenuActions` and `BookSelection` are what put the covered side back.
 *
 * Re-measured 2026-08-23 after those:
 *   global            70.33 lines / 70.33 statements / 82.72 functions / 88.68 branches
 *   src/kernel/core   93.86 / 93.86 / 94.03 / 93.61
 *   scripts/lib       99.07 / 99.07 / 100.00 / 95.76
 *
 * Only the two that ROSE past their gate are moved. Functions and branches
 * measure above the line already and below their previous baseline, and the
 * rule against lowering is what makes the number mean anything.
 *
 * ## IT RECURRED, exactly as predicted, 2026-08-25
 *
 * Phase 18 mounted `FoliateView` in the browser client, and that was the FIRST
 * TEST EVER TO IMPORT IT — 741 lines of reader, reported as seven functions
 * because nothing loaded it. It has thirty-four. `makePdf.ts` went from one to
 * fourteen the same way.
 *
 * Measured before and after, per file:
 *
 *   FoliateView.tsx    4/7  ->  13/34
 *   makePdf.ts         0/1  ->   2/14
 *   global          1884/2273 (82.88%) -> 1901/2317 (82.04%)
 *
 * SEVENTEEN MORE FUNCTIONS ARE COVERED THAN BEFORE. Forty of the forty-four
 * that appeared were always there. Nothing became less tested; the denominator
 * became honest, which is the same event this note describes above and the
 * reason it was written down.
 *
 * `foliateSettings.test.ts` and `FoliateView.test.tsx` are what put the covered
 * side back as far as it goes without a real renderer: `applyLayout`'s unit,
 * floor, page-width, gap and ordering rules are each a defect that already
 * happened once, and each now fails the suite when reverted. What is left
 * uncovered needs foliate's `View` custom element and a book to paginate, which
 * jsdom cannot give it — the browser client's own run is where those execute.
 *
 * THE FUNCTIONS GATE IS LOWERED TO 82, and that is a decision rather than a
 * consequence. It is deliberately TIGHTER than this file's own rule of
 * baseline-minus-one — which would allow 81.04 — because a number that has
 * just been shown to have been flattering should not be handed a fresh point
 * of slack. Slack is what let it flatter.
 *
 * ## WOUND AGAIN 2026-08-28 (WI-20.38), and a floor the UI never had
 *
 * The phase-20 audit found the global line gate at 69.33 against a measured
 * 73.73 — four points of slack, the exact thing the rule above forbids — and
 * `src/kernel/ui/**` with no floor at all: 56% of its lines, 46 files at 0%,
 * `App.tsx` among them. Phase 20 itself then added a hundred-odd suites.
 *
 * Measured after WI-20.35, at 5 001 tests:
 *   global            77.11 lines / 77.11 statements / 82.84 functions / 89.14 branches
 *   src/kernel/ui     64.46 / 64.46 / 73.63 / 82.88
 *   src/kernel/core   94.20 / 94.20 / 94.37 / 93.96
 *   scripts/lib       99.48 / 99.48 / 100.00 / 95.26
 *
 * Lines and statements go to 76.11, the rule's minus-one. Branches at 88.14
 * IS the rule's answer already. Functions STAY at 82: 82.84 − 1 would lower
 * the gate, and the rule against lowering is the whole gate. The UI area gets
 * its floor by the same rule, rounded down to whole points as the core areas
 * are — 63 / 63 / 72 / 81 — which is higher than the 55 the plan guessed
 * before this phase's suites landed, and is used because a floor set below
 * the measurement is slack on the day it is written.
 */
const COVERAGE_THRESHOLDS = {
  lines: 76.11,
  statements: 76.11,
  functions: 82,
  branches: 88.14,
  'src/kernel/core/**': { lines: 93, statements: 93, functions: 93, branches: 93 },
  'src/kernel/ui/**': { lines: 63, statements: 63, functions: 72, branches: 81 },
  'scripts/lib/**': { lines: 99, statements: 99, functions: 100, branches: 95 },
}

/**
 * TWO CORES OF HEADROOM FOR THE MAIN THREAD, on a machine that has them.
 *
 * The main thread is not idle while the workers run: it serves every
 * worker's `transform` and `fetch`, and it answers every `onTaskUpdate`.
 * Vitest's default fan-out gives it no core of its own, and under load from
 * OTHER applications — a load average of 25 on this 10-core Mac, measured
 * 2026-08-28 — the coverage step took 130 s and failed TWICE with every one
 * of 4 931 tests passing: `[vitest-worker]: Timeout calling "onTaskUpdate"`,
 * birpc's 60 s timeout, for which Vitest has no option. Not a test failure; a
 * starved main thread. The audit had already recorded the symptom as the
 * gate's third kind of load sensitivity (NEXT.md).
 *
 * Measured the same day, same machine, `pnpm vitest run --coverage`:
 *   default fan-out   61.0 s  (load 11.6)      130 s + RPC timeout ×2 (load 25)
 *   cpus − 2 (= 8)    54.2 s  (load 81.7!)
 *   4                 85.5 s  (load 67.6)       86 s, clean (load 25)
 * `transform` fell from 13 s to 9 s between default and 4 workers — the
 * main thread's own work, measured getting a core back. Eight is faster than
 * the default even under a load spike, and four costs forty percent on a
 * quiet machine; the cap is the first, not the second.
 *
 * SMALL MACHINES KEEP THE DEFAULT. A 3- or 4-core CI runner is dedicated —
 * nothing else competes for its main thread — and `cpus − 2` there would
 * halve the fan-out for a case it never meets.
 */
const CORES = availableParallelism()
const MAX_WORKERS = CORES >= 6 ? CORES - 2 : undefined

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
      maxWorkers: MAX_WORKERS,
      // 15s, not the 5s default: v8 coverage instrumentation makes tests 3–5×
      // slower, and a handful of compute-heavy ones (large-buffer hashing in
      // marks, a deep requires-graph in the architecture validator) can exceed
      // 5s under `--coverage` on a loaded or slow CI runner. Still fast enough
      // to catch a genuine hang.
      testTimeout: 15000,
      coverage: {
        provider: 'v8',
        all: true,
        include: COVERAGE_INCLUDE,
        exclude: COVERAGE_EXCLUDE,
        reporter: ['text-summary', 'json-summary', 'lcov'],
        reportsDirectory: './coverage',
        thresholds: COVERAGE_THRESHOLDS,
      },
      projects: PROJECTS.map((project) => ({
        extends: true,
        test: {
          name: project.name,
          environment: 'node',
          include: [...project.include],
          exclude: [...configDefaults.exclude, ...(project.exclude ?? [])],
        },
      })),
    },
  }),
)
