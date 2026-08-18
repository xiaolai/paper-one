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
 * it. `passWithNoTests` is set because several projects are declared before
 * they have a file (`kernel-contract` lands with WI-5.5, `capabilities`,
 * `composition-contract` and `service-envelope` with WI-5.6): an empty project
 * must not fail the run, and `vitest run --project <name>` on one must not
 * either. `test:projects` is what stops that from hiding a project whose glob
 * has drifted away from its files.
 *
 * Environment is Node everywhere, deliberately: several kernel tests assert
 * that no DOM exists, and nothing here needs jsdom.
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
    exclude: ['src/kernel/**/*.contract.test.ts'],
  },
  { name: 'kernel-contract', include: ['src/kernel/**/*.contract.test.ts'] },
  {
    name: 'capabilities',
    include: ['src/capabilities/**/*.test.{ts,tsx}'],
    exclude: ['src/capabilities/peer/**/*.envelope.test.ts'],
  },
  { name: 'service-envelope', include: ['src/capabilities/peer/**/*.envelope.test.ts'] },
  { name: 'composition-contract', include: ['src/app/**/*.contract.test.ts'] },
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
 * `include` names source areas, not test areas: `src/capabilities/**` and
 * `src/app/**` are listed before they exist (WI-5.6) so their first file is
 * measured from the day it lands. Test files, test kits, self-tests, the
 * Vite entry and the emitted `.types/` declarations are excluded because a
 * test's own lines being "covered" is not information.
 *
 * Thresholds are the measured baseline (see WI-5.10 in
 * `docs/plans/phase-05-kernel-capabilities.md`), global minus one point so the
 * gate only ratchets up, and the pure-core areas held at their own measured
 * floor. The global set is checked over every file; each glob key is checked
 * again over the files it matches (root-relative), so a core file counts in
 * both. Fail-on-empty is not a Vitest option — Istanbul reads 0 of 0 as 100%,
 * so a drifted glob passes — which is why `pnpm test:coverage` chains
 * `scripts/check-coverage.mjs` after the run: it reads this config back and
 * refuses a summary with no lines, an include area present on disk with
 * nothing measured under it, or a glob threshold matching no file.
 */
const COVERAGE_INCLUDE = ['src/kernel/**', 'src/capabilities/**', 'src/app/**', 'scripts/**']

/** On top of Vitest's own defaults (test files, config files, node_modules,
 *  dist), which setting `exclude` would otherwise replace. */
const COVERAGE_EXCLUDE = [
  ...coverageConfigDefaults.exclude,
  '**/*.test.{ts,tsx,mjs}',
  '**/*.testkit.{ts,tsx}',
  '**/*.selftest.mjs',
  '**/*.d.ts',
  '**/*.d.mts',
  'src/main.tsx',
  'src/vite-env.d.ts',
  '.types/**',
]

/**
 * Measured 2026-08-18 by `pnpm test:coverage` (WI-5.10), rounded as the
 * plan says: global is baseline minus one point, so a change may cost at
 * most that before the gate refuses it and nothing lower can be re-declared
 * a baseline; the pure-core areas are held at their own baseline, rounded
 * down to the integer. Raise these when coverage rises; never lower them to
 * pass — lowering is a decision that belongs in the plan, with the reason.
 */
const COVERAGE_THRESHOLDS = {
  // Baseline, measured AFTER K.5 landed (the earlier numbers were taken while
  // the kernel-API extraction was still in flight, and the plan's order is
  // K.5 before K.10 — so this is the honest floor the ratchet starts from):
  // lines 50.67, statements 50.67, functions 73.61, branches 87.39.
  lines: 49.67,
  statements: 49.67,
  functions: 72.61,
  branches: 86.39,
  // src/kernel/core after K.5: 83.01 / 83.01 / 84.78 / 89.01 (the new stores are
  // exercised by the contract suite, not yet line-for-line; the ratchet only rises).
  'src/kernel/core/**': { lines: 83, statements: 83, functions: 84, branches: 89 },
  // Baseline: 97.86 / 97.86 / 100 / 95.65.
  'scripts/lib/**': { lines: 97, statements: 97, functions: 100, branches: 95 },
}

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
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
