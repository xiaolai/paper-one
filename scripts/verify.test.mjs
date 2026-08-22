import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STEPS, parseArgs, runSteps, spawnStep } from './verify.mjs'

/**
 * `pnpm verify` — the runner, not the gates it runs (each has its own
 * suite): the steps are the plan's, in the plan's order; a failing step
 * stops the run and its exit code comes out; `--list`, `--from` and
 * `--only` select; a step that cannot start or is killed is a code, not a
 * crash.
 */

const SCRIPT = fileURLToPath(new URL('./verify.mjs', import.meta.url))

describe('the steps', () => {
  it('are the plan\'s, in order: manifest, compositions, dead CSS, inert directives, the feature ledger, boundaries (and the test-project check and the test ledger), types, coverage, build, the CLI bundle, then Cargo', () => {
    /* THE CHEAP STATIC CHECKS COME FIRST, before the ones that spend a minute
       compiling — `css:check` and `directives:check` are a walk of `src` and
       answer in milliseconds, so failing there costs the reader nothing. Both
       were added after three orphaned CSS rules and seven suppression comments
       for a linter this repo has never had were found by hand; a class found
       twice by hand is a class that needs a check rather than a third fix. */
    expect(STEPS.map((s) => s.name)).toEqual([
      'architecture:check',
      'compositions:check',
      'css:check',
      'directives:check',
      'features:check',
      'boundaries',
      'test:projects',
      'test:ledger',
      'typecheck',
      'test:coverage',
      'build',
      'build:cli',
      'cargo metadata --locked',
      'cargo fmt --check',
      'cargo clippy -D warnings',
      'cargo test --workspace',
    ])
    /* THE SELFTEST STEP IS GONE ON PURPOSE, and this pins it so putting it
       back is a deliberate act rather than a reflex. Its 27 cases run under
       `test:coverage` via `check-boundaries.test.mjs`, which is what puts them
       in `tests/ledger.json`; as a step they ran a second time for no extra
       signal. Re-adding it here restores the duplicate cruise. */
    expect(STEPS.map((s) => s.name)).not.toContain('boundaries:selftest')
    for (const step of STEPS.filter((s) => s.cmd === 'cargo')) expect(step.args).toContain('src-tauri/Cargo.toml')
    expect(STEPS.find((s) => s.name === 'cargo clippy -D warnings').args.slice(-3)).toEqual(['--', '-D', 'warnings'])
    /* The peer plugin's endpoint tests race each other for the machine and miss
       their own waits; serial is the fix and it has to stay pinned, because the
       failure it prevents is intermittent and would come back looking like bad
       luck rather than like a deleted flag. See the note beside the step. */
    expect(STEPS.find((s) => s.name === 'cargo test --workspace').args.slice(-2)).toEqual(['--', '--test-threads=1'])
    expect(STEPS.find((s) => s.name === 'build').args).toEqual(['build'])
    /* The CLI's bundle is gitignored, so no other step here would notice it
     * stop compiling — and `bin/paper.mjs` is what `sync-scenario.sh` runs. */
    expect(STEPS.find((s) => s.name === 'build:cli').args).toEqual(['build:cli'])
  })
})

describe('runSteps', () => {
  const steps = [
    { name: 'a', cmd: 'x', args: ['1'] },
    { name: 'b', cmd: 'y', args: [] },
    { name: 'c', cmd: 'z', args: ['--flag'] },
  ]

  it('runs every step in order and returns 0 when all pass', () => {
    const ran = []
    const log = []
    const code = runSteps(steps, (s) => (ran.push(s.name), 0), (l) => log.push(l))
    expect(code).toBe(0)
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(log[0]).toBe('\n▶ verify [1/3] a — x 1')
    expect(log.filter((l) => l.startsWith('✓ verify: ')).length).toBe(3)
    expect(log.at(-1)).toMatch(/^\n✓ verify: all 3 steps passed in \d+\.\ds$/)
  })

  it('stops at the first failure and returns its exit code', () => {
    const ran = []
    const log = []
    const code = runSteps(steps, (s) => (ran.push(s.name), s.name === 'b' ? 3 : 0), (l) => log.push(l))
    expect(code).toBe(3)
    expect(ran).toEqual(['a', 'b'])
    expect(log.at(-1)).toMatch(/^\n✗ verify: b failed \(exit 3\) after \d+\.\ds; 1 of 3 steps had passed$/)
  })
})

describe('spawnStep', () => {
  it('returns the child\'s exit code, 127 when it cannot start, and runs in the directory given', () => {
    expect(spawnStep({ name: 'true', cmd: process.execPath, args: ['-e', 'process.exit(0)'] })).toBe(0)
    expect(spawnStep({ name: 'seven', cmd: process.execPath, args: ['-e', 'process.exit(7)'] })).toBe(7)
    expect(spawnStep({ name: 'quiet', cmd: process.execPath, args: ['-e', 'console.log("hidden"); process.exit(0)'], quiet: true })).toBe(0)
    expect(spawnStep({ name: 'missing', cmd: '/nonexistent/binary-for-verify-test', args: [] })).toBe(127)
    expect(spawnStep({ name: 'killed', cmd: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGKILL")'] })).toBe(128)
  })
})

describe('parseArgs', () => {
  it('selects steps with --from and --only, lists with --list, refuses the rest', () => {
    expect(parseArgs([]).steps.map((s) => s.name)).toEqual(STEPS.map((s) => s.name))
    expect(parseArgs(['--from', 'build']).steps.map((s) => s.name)).toEqual(['build', 'build:cli', 'cargo metadata --locked', 'cargo fmt --check', 'cargo clippy -D warnings', 'cargo test --workspace'])
    expect(parseArgs(['--only', 'boundaries']).steps.map((s) => s.name)).toEqual(['boundaries'])
    expect(parseArgs(['--from', 'build', '--only', 'cargo fmt --check']).steps.map((s) => s.name)).toEqual(['cargo fmt --check'])
    expect(parseArgs(['--list'])).toEqual({ list: true })
    expect(parseArgs(['--from'])).toEqual({ error: '--from needs a step name' })
    expect(parseArgs(['--only', 'nope'])).toEqual({ error: 'no step named "nope"; see --list' })
    expect(parseArgs(['--wat'])).toEqual({ error: 'unknown argument "--wat"' })
  })
})

describe('the CLI', () => {
  it('--list prints one line per step; a bad flag is exit 2', () => {
    const list = spawnSync(process.execPath, [SCRIPT, '--list'], { encoding: 'utf8' })
    expect(list.status).toBe(0)
    const lines = list.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(STEPS.length)
    expect(lines[0]).toMatch(/^architecture:check\s+pnpm architecture:check$/)
    const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('unknown argument "--nope"')
  })
})
