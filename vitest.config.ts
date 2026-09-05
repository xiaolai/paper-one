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
 * above test. An untested file counts as ZERO rather than vanishing from the
 * total, so a source area no project reaches reports nothing and drags nothing
 * down — that was `all: true` on vitest 3, and vitest 4 REMOVED the option
 * because it is now the only behaviour: everything matching `include` is
 * counted whether a test reached it or not.
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
/**
 * ⚠️ **EXTENSIONS, NOT BARE DIRECTORIES — vitest 4 PARSES what it includes.**
 * `scripts/**` matched `drive-window.sh`, `shot-window.sh` and
 * `bump-version.sh`, and v4's AST-aware v8 remapping fed each to Rollup and got
 * `Expected ';', '}' or <eof>`. It recovers — "Failed to parse … Excluding it
 * from coverage" — so the run stays green and the noise is easy to scroll past,
 * which is exactly why it is pinned here instead. Vitest 3 never parsed the
 * files it merely counted, so a bare directory cost nothing there.
 */
const COVERAGE_INCLUDE = [
  'src/kernel/**/*.{ts,tsx}',
  'src/capabilities/**/*.{ts,tsx}',
  'src/hosts/**/*.{ts,tsx}',
  'src/cli/**/*.{ts,tsx}',
  'src/app/**/*.{ts,tsx}',
  'scripts/**/*.mjs',
]

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
 *
 * ## WOUND ONCE MORE 2026-08-28, after three audit-fix rounds
 *
 * The rounds that followed added roughly six hundred tests, and the gates
 * they were set against went slack again by a point and a half. Measured at
 * 5 363 tests:
 *   global            78.66 lines / 78.66 statements / 83.16 functions / 89.76 branches
 *   src/kernel/ui     66.70 / 66.70 / 73.53 / 82.76
 *   src/kernel/core   94.43 / 94.43 / 94.84 / 94.30
 *   scripts/lib       99.59 / 99.59 / 100.00 / 96.23
 *
 * Every gate is its measurement minus one, to two decimals where the areas
 * were whole points before — the rounding was never the rule, and a whole
 * point is up to a point of slack the rule does not intend. Functions moves
 * this time (82 → 82.16) because 83.16 − 1 is above the old gate rather than
 * below it, which is the condition the note above set for touching it.
 * `scripts/lib` branches goes 95 → 96: the Rust-notice generator arrived with
 * its own tests and carried the area up.
 */
/**
 * ⚠️ **RE-BASELINED FOR VITEST 4 ON 2026-09-05, AND THE NUMBERS ARE NOT
 * COMPARABLE TO THE ONES THEY REPLACE.** v4's v8 provider remaps coverage
 * through the AST, so it counts far more branches and functions than v3 did.
 * The percentage can FALL while the code covered RISES: functions went from
 * 2 521/3 038 covered to 4 985/6 329 — nearly twice as many functions counted,
 * and 2 464 more of them covered.
 *
 * | | v3 threshold | v4 measured |
 * |---|---|---|
 * | lines | 77.66 | **83.53** |
 * | statements | 77.66 | **81.76** |
 * | functions | 82.16 | 78.76 |
 * | branches | 88.76 | 78.71 |
 * | `core` branches | 93.3 | 90.04 |
 * | `ui` functions | 72.53 | 69.12 |
 * | **`ui` branches** | **81.76** | **67.42** |
 *
 * Lines and statements went UP and are raised accordingly — a re-baseline is
 * not an amnesty, and leaving them at 77.66 would have quietly given away six
 * points of the gate.
 *
 * ⚠️ **`src/kernel/ui` BRANCHES FALLING FOURTEEN POINTS IS THE ONE TO DISTRUST.**
 * A single measurement cannot tell "v4 counts branches v3 never saw" from "v4
 * found a real gap v3's metric hid", and this file's earlier note said exactly
 * that before the upgrade was taken. It is set to the measurement so the gate
 * is honest about where the suite actually stands; it is NOT evidence that the
 * reader's UI is well covered. Raising it back is real test-writing work on
 * `src/kernel/ui`, and it is the obvious next piece of it.
 */
const COVERAGE_THRESHOLDS = {
  lines: 83.28,
  statements: 81.51,
  functions: 78.51,
  branches: 78.46,
  'src/kernel/core/**': { lines: 95.12, statements: 93.04, functions: 92.99, branches: 89.79 },
  'src/kernel/ui/**': { lines: 76.71, statements: 74.04, functions: 68.87, branches: 67.17 },
  'scripts/lib/**': { lines: 99.24, statements: 98.21, functions: 100, branches: 95.55 },
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
 */
const CORES = availableParallelism()
/**
 * ⚠️ **A KNOWN FLAKE LIVES HERE AND `cpus − 2` IS NOT THE FIX — do not spend
 * another afternoon on it without reading this.**
 *
 * Under `--coverage`, in the full multi-project run, vitest intermittently
 * reports `[vitest-worker]: Timeout calling "onTaskUpdate"` as an unhandled
 * error and exits 1 **with every test passing**. `defaultWidth` in
 * `scripts/check-boundaries.selftest.mjs` already named that exact string as
 * something "the gate has been failing on", so it predates the branch that
 * finally measured it.
 *
 * Measured 2026-09-01 on a 10-core machine, full `pnpm test:coverage`, all
 * tests passing in every one of these runs:
 *
 * | workers | cruiser fan-out | scripts pool | result |
 * |---|---|---|---|
 * | 8 (`cpus − 2`) | 6 | threads | ✗ ✗ ✗ ✓ |
 * | 8 | 2 | threads | ✓ ✓ ✗ |
 * | 5 (`cpus − 5`) | 6 | threads | ✓ ✗ |
 * | 5 | 6 | forks | ✗ |
 *
 * And two more hypotheses ruled out, recorded so nobody re-runs them:
 * **the reporter** (`--reporter=dot` removes the live tree for 5 965 tests from
 * the main thread — still red) and **worker pool type** (`forks` gives the
 * scripts project its own heap and GC — still red). Per-test timeouts were a
 * separate, real finding and are fixed; they are not this.
 *
 * ⚠️ **IT REPRODUCES ON `main` WITH NONE OF THIS BRANCH'S CODE** — verified by
 * stashing the whole working tree and running the same command: one green, one
 * red, 5904 tests passing in both. So it is not something the circle work
 * introduced; a bigger suite only makes the dice land badly more often.
 *
 * **Every lever was green at least once and red at least once**, which is what
 * says the mechanism is not CPU contention — that would respond monotonically.
 * Two facts narrow it: it needs `--coverage`, and it needs more than one
 * project. The main thread merges a v8 coverage payload per file for 299 files
 * and must still answer birpc inside 60 s; a burst of completions is the
 * likeliest starver, and the fan-out levers only change how bursts happen to
 * line up.
 *
 * So the value is left where it was. Reducing it made one run the fastest seen
 * (169 s) and did not make the gate reliable, and a permanent CI slowdown for a
 * flake it does not fix is a bad trade.
 *
 * ## ⚠️ VITEST 4 LANDED ON 2026-09-05, AND THE FLAKE IS GONE
 *
 * Everything above is kept as the record of what was ruled out, because the
 * levers it names are the ones anybody would reach for first and every one of
 * them was measured and rejected. Do not re-run them.
 *
 * MEASURED after the upgrade, four consecutive `pnpm test:coverage` runs:
 * **zero `onTaskUpdate` errors**, against roughly one run in two before it. The
 * run is also three to five times faster — 35-80 s against 163-250 s.
 *
 * Four migration defects, all fixed in the commits that landed it. Three were
 * scouted earlier — `scripts/lib/vitestBin.mjs` (v4 dropped `./vitest.mjs`
 * from its `exports`), `%p` to `%o` in two `it.each` tables (v4 stops
 * substituting `%p`, collapsing six test names into one and blinding
 * `check-test-ledger` to five deletions), and the ledger rewritten. The fourth
 * only appeared on the real run: **`COVERAGE_INCLUDE` named bare directories**,
 * and v4 PARSES what it includes, so three shell scripts under `scripts/**`
 * went to Rollup and came back as syntax errors. See that constant.
 *
 * The coverage re-baseline is done and is the one thing here a human should
 * still look at — see the note on `COVERAGE_THRESHOLDS`, and in particular
 * `src/kernel/ui` branches, which fell fourteen points because v4 counts
 * branches v3 never saw. The gate is now honest about where the suite stands;
 * that is not the same as the suite being good there.
 *
 * SMALL MACHINES KEEP THE DEFAULT. A 3- or 4-core CI runner is dedicated —
 * nothing else competes for its main thread — and a subtraction there would
 * halve the fan-out for a case it never meets.
 */
const MAX_WORKERS = CORES >= 6 ? CORES - 2 : undefined

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
      /* One line, in one file: `findBy*`/`waitFor` get a bound that matches
         what this suite's async UI actually costs. See `vitest.setup.ts`. */
      setupFiles: ['./vitest.setup.ts'],
      maxWorkers: MAX_WORKERS,
      /**
       * A PASSING TEST'S CONSOLE OUTPUT IS MAIN-THREAD WORK, and this suite
       * makes a lot of it.
       *
       * Every `console.*` inside a test is an `onUserConsoleLog` RPC to the
       * main thread, which then formats it and writes it to a terminal — the
       * same thread that must answer `onTaskUpdate` within birpc's 60 s, and
       * the same starvation the worker cap above exists for. Measured on one
       * `pnpm verify` run: 163 forwarded lines, 122 of them from
       * `session.test.ts` alone, which exercises error paths on purpose and
       * reports them on purpose.
       *
       * `passed-only` keeps every line of a FAILING test — the output a
       * failure is diagnosed from is untouched — and drops the output of tests
       * that passed, which nobody reads and which no gate asserts. Nothing is
       * silenced that was ever a signal.
       */
      silent: 'passed-only',
      // 15s, not the 5s default: v8 coverage instrumentation makes tests 3–5×
      // slower, and a handful of compute-heavy ones (large-buffer hashing in
      // marks, a deep requires-graph in the architecture validator) can exceed
      // 5s under `--coverage` on a loaded or slow CI runner. Still fast enough
      // to catch a genuine hang.
      testTimeout: 15000,
      coverage: {
        provider: 'v8',
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
          /**
           * ⚠️ **THE `scripts` PROJECT GETS 60 s, BECAUSE NOTHING IN IT IS A
           * UNIT TEST.** Every file there exercises a GATE: it walks the whole
           * of `src/`, or spawns `node` against a CLI, or runs
           * dependency-cruiser over a fixture tree. The root `testTimeout` of
           * 15 s is a hang detector sized for tests that touch a few modules,
           * and applying it here makes the gate decide on machine load.
           *
           * Measured 2026-09-01 on a 10-core machine — standalone against the
           * same test inside a full `pnpm test:coverage`:
           *
           * | test | alone | under the full run |
           * |---|---|---|
           * | `check-browser-safe` pinned-module walk | 0.44 s | **25 s ✗** |
           * | `check-coverage` CLI usage errors | 1.8 s | **20 s ✗** |
           *
           * ⚠️ **TWO INSTANCES ARE A CLASS.** The first was fixed with a
           * timeout on one `describe`, and the second arrived four hours later
           * in a different file for the identical reason — a subprocess-spawning
           * gate test measured in single-digit seconds, killed at 15 under
           * contention. Fixing the class here rather than instance by instance
           * is what stops a third.
           *
           * A hang is unbounded, so 60 s still catches one. Nothing about what
           * these tests assert is relaxed, and the other four projects — which
           * really are unit tests — keep the tighter bound.
           */
          ...(project.name === 'scripts' ? { testTimeout: 60_000 } : {}),
        },
      })),
    },
  }),
)
