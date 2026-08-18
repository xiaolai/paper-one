import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfigFromFile } from 'vite'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm test:coverage` — the second half: `vitest run --coverage` writes
 * `coverage/coverage-summary.json`, and this refuses to call the run green
 * over nothing.
 *
 * Vitest's thresholds compare percentages, and Istanbul reports 0 of 0 as
 * 100%. So a coverage `include` whose glob has drifted away from its files,
 * or a glob threshold whose glob matches no file, does not fail — it passes,
 * at 100%, and keeps passing after every file it was meant to guard has been
 * deleted. Vitest has no option that says "and there must have been
 * something". This script is that option.
 *
 * It reads the same `vitest.config.ts` Vitest ran with (through Vite's own
 * config loader, so what it sees is what Vitest saw — not a second copy of
 * the include list that could drift on its own) and the summary that run
 * produced, and reports:
 *
 * - `MISSING`         — no summary was written (the run did not reach the
 *                       reporter, or `json-summary` is no longer configured);
 * - `EMPTY`           — a summary with zero measurable lines in total;
 * - `EMPTY_AREA`      — a `coverage.include` glob whose directory exists on
 *                       disk but under which nothing was measured;
 * - `EMPTY_THRESHOLD` — a glob threshold matching no measured file, which is
 *                       the 0-of-0 case exactly.
 *
 * Then the totals, so the number that was gated is in the log rather than
 * only in a JSON file. Exit 0 when clean, 1 on a finding, 2 on a usage error
 * or when the config or the summary could not be read at all.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-coverage.mjs [--root <dir>]'
const CONFIG_FILE = 'vitest.config.ts'
const SUMMARY_FILE = 'coverage-summary.json'
const METRICS = ['lines', 'statements', 'functions', 'branches']
/** Keys of `coverage.thresholds` that are not glob patterns. Mirrors the
 *  list Vitest skips when it resolves glob thresholds. */
const THRESHOLD_OPTION_KEYS = new Set([...METRICS, 'perFile', 'autoUpdate', '100'])
const GLOB_CHARS = /[*?[\]{}()!]/

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

/**
 * The `test.coverage` block of `<root>/vitest.config.ts`, as Vitest would
 * read it: `{ include, thresholds, reportsDirectory }`. Loaded with Vite's
 * config loader in test mode, so a config that computes its globs is read
 * after computing them. Throws when the file is missing, does not export a
 * config, or has no coverage block — a check that could not find what it
 * gates must not answer "clean".
 */
export async function loadCoverageOptions(root) {
  const configFile = path.join(root, CONFIG_FILE)
  if (!existsSync(configFile)) throw new Error(`${configFile}: no such file — is --root the repository root?`)
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile, root, 'silent')
  if (loaded === null) throw new Error(`${configFile}: Vite could not load a config from it`)
  const coverage = loaded.config?.test?.coverage
  if (typeof coverage !== 'object' || coverage === null) {
    throw new Error(`${configFile}: no test.coverage block — nothing here is gated`)
  }
  const include = Array.isArray(coverage.include) ? coverage.include.map(String) : []
  const thresholds =
    typeof coverage.thresholds === 'object' && coverage.thresholds !== null ? coverage.thresholds : {}
  const reportsDirectory =
    typeof coverage.reportsDirectory === 'string' ? coverage.reportsDirectory : 'coverage'
  return { include, thresholds, reportsDirectory }
}

/**
 * The parsed summary, or `undefined` when the file does not exist. Throws on
 * anything else — unreadable, not JSON, or JSON without the `total` block
 * `json-summary` always writes.
 */
export function readSummary(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${file}: not JSON (${cause.message})`, { cause })
  }
  if (typeof parsed?.total !== 'object' || parsed.total === null) {
    throw new Error(`${file}: no "total" — not a json-summary report`)
  }
  for (const metric of METRICS) {
    if (typeof parsed.total[metric]?.total !== 'number') {
      throw new Error(`${file}: total.${metric}.total is not a number`)
    }
  }
  return parsed
}

/** The leading path segments of `glob` that contain no glob character, as
 *  a relative posix path — `src/kernel` for `src/kernel/**`, and empty for
 *  a glob that opens with a wildcard. The directory an include glob is
 *  "about". */
export function staticPrefix(glob) {
  const segments = []
  for (const segment of glob.split('/')) {
    if (segment === '' || GLOB_CHARS.test(segment)) break
    segments.push(segment)
  }
  return segments.join('/')
}

/** Files named by a json-summary report, root-relative posix, sorted. */
export function summaryFiles(summary, root) {
  return Object.keys(summary)
    .filter((key) => key !== 'total')
    .map((key) => toPosix(path.isAbsolute(key) ? path.relative(root, key) : key))
    .sort()
}

/**
 * Compare what was measured with what the config says should be. Pure but
 * for `isDirectory`, which answers whether a root-relative path is a
 * directory on disk (so an include area declared ahead of its first file —
 * the config lists `src/capabilities/**` before WI-5.6 lands it — is not a
 * finding, and becomes one the day the directory appears with nothing
 * measured under it).
 *
 * `summary` is `undefined` when no report exists; that is the one finding
 * that pre-empts every other, since there is nothing to compare.
 */
export function checkCoverage({ summary, include, thresholds, root, isDirectory }) {
  if (summary === undefined) {
    return [
      {
        code: 'MISSING',
        subject: SUMMARY_FILE,
        message: 'no coverage summary was written — the run did not reach the reporter, or json-summary is not configured',
      },
    ]
  }
  const findings = []
  const files = summaryFiles(summary, root)
  if (summary.total.lines.total === 0) {
    findings.push({ code: 'EMPTY', subject: 'total', message: 'zero measurable lines — nothing was covered by anything' })
  }
  for (const glob of include) {
    const prefix = staticPrefix(glob)
    if (prefix === '' || !isDirectory(prefix)) continue
    if (!files.some((file) => path.matchesGlob(file, glob))) {
      findings.push({
        code: 'EMPTY_AREA',
        subject: glob,
        message: `${prefix}/ exists but nothing under it was measured — the include glob has drifted from its files, or the area holds nothing measurable`,
      })
    }
  }
  for (const glob of Object.keys(thresholds)) {
    if (THRESHOLD_OPTION_KEYS.has(glob)) continue
    if (!files.some((file) => path.matchesGlob(file, glob))) {
      findings.push({
        code: 'EMPTY_THRESHOLD',
        subject: glob,
        message: 'threshold glob matches no measured file — 0 of 0 reads as 100% and gates nothing',
      })
    }
  }
  return findings
}

/** The four totals as `metric: pct% (covered/total)` lines, then a file count. */
export function formatTotals(summary, fileCount) {
  const width = Math.max(...METRICS.map((m) => m.length))
  const lines = METRICS.map((metric) => {
    const { pct, covered, total } = summary.total[metric]
    return `  ${metric.padEnd(width)}  ${String(pct).padStart(6)}%  (${covered}/${total})`
  })
  lines.push(`  ${'files'.padEnd(width)}  ${String(fileCount).padStart(7)}`)
  return lines
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

async function main(argv) {
  const args = parseArgs(argv, process.cwd())
  if (args.error !== undefined) {
    process.stderr.write(`check-coverage: ${args.error}\n${USAGE}\n`)
    return 2
  }
  const { root } = args
  const { include, thresholds, reportsDirectory } = await loadCoverageOptions(root)
  const summaryFile = path.resolve(root, reportsDirectory, SUMMARY_FILE)
  const summary = readSummary(summaryFile)
  const isDirectory = (rel) => {
    try {
      return statSync(path.join(root, rel)).isDirectory()
    } catch {
      return false
    }
  }
  const findings = checkCoverage({ summary, include, thresholds, root, isDirectory })

  const lines = findings.map((f) => `${f.code} ${f.subject}: ${f.message}`)
  if (summary !== undefined) {
    lines.push(`coverage totals (${toPosix(path.relative(root, summaryFile))}):`)
    lines.push(...formatTotals(summary, summaryFiles(summary, root).length))
  }
  const areas = include.map((glob) => {
    const prefix = staticPrefix(glob)
    return `${glob}${prefix !== '' && !isDirectory(prefix) ? ' (absent, not required)' : ''}`
  })
  lines.push(`  areas: ${areas.join(', ')}`)
  lines.push(`check-coverage: ${findings.length} finding${findings.length === 1 ? '' : 's'}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return findings.length > 0 ? 1 : 0
}

if (isProcessEntry(import.meta)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`check-coverage: ${cause?.stack ?? String(cause)}\n`)
    process.exitCode = 2
  }
}
