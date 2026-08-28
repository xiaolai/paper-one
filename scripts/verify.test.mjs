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
  it('are the plan\'s, in order: manifest, compositions, dead CSS, undefined CSS tokens, browser safety, inert directives, boundaries (and the test-project check and the test ledger), types, coverage, the desktop build, the browser build, the CLI bundle, then Cargo', () => {
    /* THE CHEAP STATIC CHECKS COME FIRST, before the ones that spend a minute
       compiling — `css:check`, `css:tokens` and `directives:check` are a walk of
       `src` and answer in milliseconds, so failing there costs the reader
       nothing. All three were added after the same kind of discovery: three
       orphaned CSS rules, seven suppression comments for a linter this repo has
       never had, and five invented custom properties on the browser client's
       reading surface. A class found twice by hand is a class that needs a
       check rather than a third fix.

       `css:check` and `css:tokens` ask different questions and neither implies
       the other: one asks whether a RULE can be reached, the other whether a
       VALUE resolves. A stylesheet can be entirely live and still style
       nothing, because an undefined custom property is dropped in silence.

       `browser:check` is here rather than later because it is the same shape:
       a walk of `src` that answers in milliseconds. It holds the modules this
       repository deliberately made browser-safe TO that, and the failure it
       catches is silent in every other gate — one careless import re-blocks a
       subtree, and nothing says so until `assert-bundle` refuses a bundle for
       a reason that reads as unrelated. */
    expect(STEPS.map((s) => s.name)).toEqual([
      'architecture:check',
      'compositions:check',
      'css:check',
      'css:tokens',
      'browser:check',
      'directives:check',
      'boundaries',
      'test:projects',
      'test:ledger',
      'typecheck',
      'test:coverage',
      'build',
      'build:web',
      'build:cli',
      'cargo metadata --locked',
      'cargo fmt --check',
      'cargo clippy -D warnings',
      'cargo test --workspace',
    ])
    /* THE SELFTEST STEP IS GONE ON PURPOSE, and this pins it so putting it
       back is a deliberate act rather than a reflex. Its cases run under
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
    /* `build` IS THE DESKTOP BUNDLE ONLY, and the browser client is a separate
     * Vite config, entry and composition root with its own bundle assertion.
     * `dist-web/` is gitignored and `tauri-plugin-webhost/build.rs` compiles
     * with an empty asset set when it is missing, so without this step the
     * browser client can stop building while every other gate stays green and
     * the release ships a host that answers 503. */
    expect(STEPS.find((s) => s.name === 'build:web').args).toEqual(['build:web'])
    expect(STEPS.map((s) => s.name).indexOf('build:web')).toBeGreaterThan(STEPS.map((s) => s.name).indexOf('typecheck'))
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
    expect(parseArgs(['--from', 'build']).steps.map((s) => s.name)).toEqual(['build', 'build:web', 'build:cli', 'cargo metadata --locked', 'cargo fmt --check', 'cargo clippy -D warnings', 'cargo test --workspace'])
    expect(parseArgs(['--only', 'boundaries']).steps.map((s) => s.name)).toEqual(['boundaries'])
    expect(parseArgs(['--from', 'build', '--only', 'cargo fmt --check']).steps.map((s) => s.name)).toEqual(['cargo fmt --check'])
    expect(parseArgs(['--list'])).toEqual({ list: true })
    expect(parseArgs(['--from'])).toEqual({ error: '--from needs a step name' })
    expect(parseArgs(['--only', 'nope'])).toEqual({ error: 'no step named "nope"; see --list' })
    expect(parseArgs(['--wat'])).toEqual({ error: 'unknown argument "--wat"' })
  })

  /* `--until` IS THE JS HALF OF THE GATE ON A PLATFORM WHOSE CARGO HALF IS A
     SEPARATE JOB — the Windows leg runs `pnpm verify --until build:cli` and
     then `cargo check` (WI-20.38, D10). Inclusive, and narrowed after
     `--from`, so a window that names two real steps in the wrong order is the
     same refused-empty selection the other two flags already give. */
  it('stops after a step with --until, inclusive, and refuses an empty window', () => {
    expect(parseArgs(['--until', 'compositions:check']).steps.map((s) => s.name)).toEqual(['architecture:check', 'compositions:check'])
    expect(parseArgs(['--until', 'build:cli']).steps.map((s) => s.name).at(-1)).toBe('build:cli')
    expect(parseArgs(['--until', 'build:cli']).steps.map((s) => s.name)).not.toContain('cargo metadata --locked')
    expect(parseArgs(['--from', 'build', '--until', 'build:web']).steps.map((s) => s.name)).toEqual(['build', 'build:web'])
    expect(parseArgs(['--from', 'build:web', '--until', 'build'])).toEqual({
      error: '--from "build:web" and --until "build" select no steps; --until and --only must name a step at or after --from',
    })
    expect(parseArgs(['--until'])).toEqual({ error: '--until needs a step name' })
    expect(parseArgs(['--list', '--until', 'build'])).toEqual({ error: '--list cannot be combined with --from, --until or --only' })
  })

  /* A GATE THAT VERIFIES NOTHING MUST NOT EXIT 0. Both selectors name real
     steps, so neither is rejected on its own; their intersection is empty and
     the run used to print "all 0 steps passed". Green having done nothing looks
     exactly like green having done everything, which is the whole failure. */
  it('refuses a selection that resolves to no steps', () => {
    const empty = parseArgs(['--from', 'build', '--only', 'typecheck'])
    expect(empty.steps).toBeUndefined()
    expect(empty.error).toMatch(/select no steps/)
  })

  /* `--list` used to win silently, so `--list --only build` printed the whole
     list and ran nothing while looking like a plan for the one step asked for. */
  it('refuses --list combined with a selector rather than ignoring it', () => {
    expect(parseArgs(['--list', '--only', 'build'])).toEqual({ error: '--list cannot be combined with --from, --until or --only' })
    expect(parseArgs(['--from', 'build', '--list'])).toEqual({ error: '--list cannot be combined with --from, --until or --only' })
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
