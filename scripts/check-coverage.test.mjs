import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkCoverage,
  formatTotals,
  loadCoverageOptions,
  readSummary,
  staticPrefix,
  summaryFiles,
} from './check-coverage.mjs'

/**
 * `check-coverage`: the comparison, the summary reader, and the CLI over a
 * real `vitest.config.ts` in a temporary root. The CLI cases go through
 * Vite's config loader on purpose — the thing under test is that the script
 * gates what Vitest actually configured, so a case that hands it the include
 * list directly would not be testing that.
 */

const SCRIPT = fileURLToPath(new URL('./check-coverage.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A root holding `files` (path → content, or `null` for a directory), with
 *  this repository's `node_modules` linked in so a `vitest.config.ts` there
 *  can import `vitest/config`. */
function fixture(files) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'check-coverage-'))
  roots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    if (content === null) {
      mkdirSync(file, { recursive: true })
      continue
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  return root
}

function config({ include, thresholds = {}, reportsDirectory }) {
  const coverage = { provider: 'v8', include, thresholds, reporter: ['json-summary'] }
  if (reportsDirectory !== undefined) coverage.reportsDirectory = reportsDirectory
  return (
    "import { defineConfig } from 'vitest/config'\n" +
    `export default defineConfig({ test: { coverage: ${JSON.stringify(coverage)} } })\n`
  )
}

function metric(covered, total) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : Math.round((10000 * covered) / total) / 100 }
}

/** A json-summary report: `total` plus one entry per file, keyed by
 *  absolute path as Vitest writes it. `files` maps root-relative path →
 *  `[covered, total]` lines. */
function summary(root, files) {
  const report = {}
  let covered = 0
  let total = 0
  for (const [rel, [c, t]] of Object.entries(files)) {
    covered += c
    total += t
    report[join(root, rel)] = {
      lines: metric(c, t),
      statements: metric(c, t),
      functions: metric(1, 1),
      branches: metric(1, 1),
    }
  }
  report.total = {
    lines: metric(covered, total),
    statements: metric(covered, total),
    functions: metric(Object.keys(files).length, Object.keys(files).length),
    branches: metric(Object.keys(files).length, Object.keys(files).length),
  }
  return report
}

function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8', timeout: 120_000 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('staticPrefix', () => {
  it('is the directory before the first glob segment, and empty for a leading wildcard', () => {
    expect(staticPrefix('src/kernel/**')).toBe('src/kernel')
    expect(staticPrefix('src/kernel/core/**/*.ts')).toBe('src/kernel/core')
    expect(staticPrefix('scripts/**')).toBe('scripts')
    expect(staticPrefix('**/*.ts')).toBe('')
    expect(staticPrefix('src/{a,b}/**')).toBe('src')
    expect(staticPrefix('src/lib')).toBe('src/lib')
  })
})

describe('checkCoverage', () => {
  const root = '/repo'
  const dirs = new Set(['src/kernel', 'src/kernel/core', 'scripts', 'scripts/lib'])
  const isDirectory = (rel) => dirs.has(rel)
  const include = ['src/kernel/**', 'src/capabilities/**', 'scripts/**']
  const thresholds = { lines: 40, 'src/kernel/core/**': { lines: 80 }, 'scripts/lib/**': { lines: 90 } }

  it('is clean when every present area and every threshold glob has a measured file', () => {
    const report = summary(root, {
      'src/kernel/core/a.ts': [8, 10],
      'src/kernel/ui/b.tsx': [0, 10],
      'scripts/lib/c.mjs': [9, 10],
      'scripts/d.mjs': [1, 10],
    })
    expect(checkCoverage({ summary: report, include, thresholds, root, isDirectory })).toEqual([])
  })

  it('MISSING pre-empts everything when there is no summary at all', () => {
    const findings = checkCoverage({ summary: undefined, include, thresholds, root, isDirectory })
    expect(findings.map((f) => f.code)).toEqual(['MISSING'])
  })

  it('EMPTY when the total has zero lines — a report over nothing', () => {
    const report = summary(root, {})
    const codes = checkCoverage({ summary: report, include, thresholds, root, isDirectory }).map((f) => f.code)
    expect(codes).toContain('EMPTY')
  })

  it('EMPTY_AREA for an include whose directory exists with nothing measured, not for an absent one', () => {
    const report = summary(root, { 'src/kernel/core/a.ts': [8, 10], 'scripts/lib/c.mjs': [9, 10] })
    const findings = checkCoverage({
      summary: report,
      include: ['src/kernel/**', 'src/capabilities/**', 'scripts/**', 'src/kernel/nowhere/**'],
      thresholds: {},
      root,
      isDirectory: (rel) => dirs.has(rel) || rel === 'src/kernel/nowhere',
    })
    expect(findings).toEqual([expect.objectContaining({ code: 'EMPTY_AREA', subject: 'src/kernel/nowhere/**' })])
  })

  it('EMPTY_THRESHOLD for a glob threshold matching no measured file, and skips the option keys', () => {
    const report = summary(root, { 'src/kernel/core/a.ts': [8, 10] })
    const findings = checkCoverage({
      summary: report,
      include: ['src/kernel/**'],
      thresholds: {
        lines: 40,
        branches: 1,
        perFile: false,
        autoUpdate: false,
        100: false,
        'src/kernel/core/**': { lines: 80 },
        'scripts/lib/**': { lines: 90 },
      },
      root,
      isDirectory,
    })
    expect(findings).toEqual([expect.objectContaining({ code: 'EMPTY_THRESHOLD', subject: 'scripts/lib/**' })])
  })

  it('reads relative summary keys as already root-relative', () => {
    const report = { total: summary(root, { 'x.ts': [1, 1] }).total, 'src/kernel/core/a.ts': {} }
    expect(summaryFiles(report, root)).toEqual(['src/kernel/core/a.ts'])
  })
})

describe('readSummary', () => {
  it('is undefined for a missing file and throws for anything that is not a json-summary', () => {
    const root = fixture({
      'not-json.json': '{',
      'no-total.json': '{"a":{}}',
      'bad-total.json': '{"total":{"lines":{}}}',
    })
    expect(readSummary(join(root, 'absent.json'))).toBeUndefined()
    expect(() => readSummary(join(root, 'not-json.json'))).toThrow(/not JSON/)
    expect(() => readSummary(join(root, 'no-total.json'))).toThrow(/no "total"/)
    expect(() => readSummary(join(root, 'bad-total.json'))).toThrow(/total\.lines\.total/)
  })
})

describe('formatTotals', () => {
  it('prints the four metrics with counts, then the file count', () => {
    const report = summary('/repo', { 'a.ts': [1, 4] })
    expect(formatTotals(report, 1)).toEqual([
      '  lines           25%  (1/4)',
      '  statements      25%  (1/4)',
      '  functions      100%  (1/1)',
      '  branches       100%  (1/1)',
      '  files             1',
    ])
  })
})

describe('loadCoverageOptions', () => {
  it('reads include, thresholds and reportsDirectory from the config Vitest would load', async () => {
    const root = fixture({
      'vitest.config.ts': config({
        include: ['src/**'],
        thresholds: { lines: 1, 'src/core/**': { lines: 2 } },
        reportsDirectory: './out',
      }),
    })
    expect(await loadCoverageOptions(root)).toEqual({
      include: ['src/**'],
      thresholds: { lines: 1, 'src/core/**': { lines: 2 } },
      reportsDirectory: './out',
    })
  })

  it('defaults reportsDirectory to coverage, and refuses a config with no coverage block', async () => {
    const root = fixture({
      'vitest.config.ts': config({ include: ['src/**'] }),
      'bare/vitest.config.ts': "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: {} })\n",
    })
    expect((await loadCoverageOptions(root)).reportsDirectory).toBe('coverage')
    await expect(loadCoverageOptions(join(root, 'bare'))).rejects.toThrow(/no test\.coverage block/)
    await expect(loadCoverageOptions(join(root, 'nowhere'))).rejects.toThrow(/no such file/)
  })

  it('reads this repository: the six source areas and glob thresholds on the pure core', async () => {
    const options = await loadCoverageOptions(REPO_ROOT)
    /* `src/hosts/**` and `src/cli/**` joined in phase 11: a Node host and the
     * `paper` CLI are source, and an area not listed here is measured by
     * nothing while the run stays green.
     *
     * ⚠️ EACH ONE NAMES AN EXTENSION, and that is load-bearing under vitest 4:
     * its v8 provider PARSES every included file, so a bare `scripts/**` fed
     * three shell scripts to Rollup and got a syntax error per file. It
     * recovers by excluding them and the run stays green, so the spelling is
     * asserted here rather than left to whoever reads the log. */
    expect(options.include).toEqual([
      'src/kernel/**/*.{ts,tsx}',
      'src/capabilities/**/*.{ts,tsx}',
      'src/hosts/**/*.{ts,tsx}',
      'src/cli/**/*.{ts,tsx}',
      'src/app/**/*.{ts,tsx}',
      'scripts/**/*.mjs',
    ])
    expect(Object.keys(options.thresholds)).toEqual(
      expect.arrayContaining(['lines', 'statements', 'functions', 'branches', 'src/kernel/core/**', 'scripts/lib/**']),
    )
    expect(options.reportsDirectory).toBe('./coverage')
  })
})

describe('the CLI', () => {
  const INCLUDE = ['src/kernel/**', 'src/capabilities/**', 'scripts/**']
  const THRESHOLDS = { lines: 40, 'src/kernel/core/**': { lines: 80 } }

  it('exits 0 on a summary with a file in every present area, and prints the totals', () => {
    const root = fixture({
      'vitest.config.ts': config({ include: INCLUDE, thresholds: THRESHOLDS }),
      'src/kernel/core': null,
      'scripts': null,
    })
    mkdirSync(join(root, 'coverage'))
    writeFileSync(
      join(root, 'coverage', 'coverage-summary.json'),
      JSON.stringify(summary(root, { 'src/kernel/core/a.ts': [8, 10], 'scripts/x.mjs': [2, 10] })),
    )
    const { code, out, err } = run(root)
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('lines           50%  (10/20)')
    expect(out).toContain('src/capabilities/** (absent, not required)')
    expect(out).toContain('check-coverage: 0 findings')
  })

  it('exits 1 with MISSING when the run wrote no summary', () => {
    const root = fixture({ 'vitest.config.ts': config({ include: INCLUDE }), 'src/kernel': null })
    const { code, out } = run(root)
    expect(code).toBe(1)
    expect(out).toContain('MISSING coverage-summary.json')
    expect(out).toContain('check-coverage: 1 finding')
  })

  it('exits 1 with EMPTY and EMPTY_AREA when the summary measured nothing under a present area', () => {
    const root = fixture({ 'vitest.config.ts': config({ include: INCLUDE, thresholds: THRESHOLDS }), 'src/kernel/core': null })
    mkdirSync(join(root, 'coverage'))
    writeFileSync(join(root, 'coverage', 'coverage-summary.json'), JSON.stringify(summary(root, {})))
    const { code, out } = run(root)
    expect(code).toBe(1)
    expect(out).toContain('EMPTY total')
    expect(out).toContain('EMPTY_AREA src/kernel/**')
    expect(out).toContain('EMPTY_THRESHOLD src/kernel/core/**')
    expect(out).toContain('check-coverage: 3 findings')
  })

  it('exits 2 on a usage error, a config with no coverage block, and a summary that is not JSON', () => {
    const root = fixture({ 'vitest.config.ts': config({ include: INCLUDE }) })
    const usage = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('usage:')

    mkdirSync(join(root, 'coverage'))
    writeFileSync(join(root, 'coverage', 'coverage-summary.json'), '{')
    const { code, err } = run(root)
    expect(code).toBe(2)
    expect(err).toContain('not JSON')

    const bare = fixture({ 'vitest.config.ts': "import { defineConfig } from 'vitest/config'\nexport default defineConfig({})\n" })
    const noCoverage = run(bare)
    expect(noCoverage.code).toBe(2)
    expect(noCoverage.err).toContain('no test.coverage block')
  })
})
