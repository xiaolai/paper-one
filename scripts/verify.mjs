import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm verify` — the unified gate (WI-5.12), one command, the same one CI
 * runs. Every check the phase added, in an order that fails fast and cheap:
 * the manifest, the compositions, the boundaries (and the check that every
 * test file is in exactly one project), the types, the tests with their
 * coverage floors — which is where the boundary selftest's own cases run, see
 * the note beside `boundaries` below — the literal desktop build (which
 * asserts its own bundle), the CLI's bundle (which asserts its own output),
 * then Cargo — the lockfile, formatting, clippy, tests — for the whole
 * workspace.
 *
 * Sequential, with a header per step and a stop at the first failure, whose
 * exit code becomes this script's. There is no "continue past a red step":
 * a summary that distinguishes "my failures" from "their failures" is
 * bookkeeping, not a gate.
 *
 * `--list` prints the steps and exits; `--from <name>` starts at a step
 * (for re-running the tail after a fix); `--only <name>` runs one.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CARGO = ['--manifest-path', 'src-tauri/Cargo.toml']

/** The steps, in order. `cmd` is argv[0], `args` the rest. */
export const STEPS = Object.freeze([
  { name: 'architecture:check', cmd: 'pnpm', args: ['architecture:check'] },
  { name: 'compositions:check', cmd: 'pnpm', args: ['compositions:check'] },
  { name: 'css:check', cmd: 'pnpm', args: ['css:check'] },
  { name: 'directives:check', cmd: 'pnpm', args: ['directives:check'] },
  /* THE LEDGERS DESCRIBE CODE THAT EXISTS. `docs/feature-ledger.md` and
   * `docs/library-ledger.md` are read to decide what to build next, which
   * makes a stale row worse than no row: a feature listed Absent when it ships
   * is work about to be redone. Re-audited 2026-08-21, eleven rows of the
   * first had drifted and nine understated the app, while every path in it
   * still named `lib/…` — a directory the kernel carve emptied months earlier.
   *
   * BOTH, since 2026-08-23, and the second is the argument for the first being
   * too narrow: `library-ledger.md` was outside this gate, and went from phase
   * 5 to phase 14 with eighteen understating rows and every path naming that
   * same dead directory. The check ran green throughout, over one file, under
   * a name that reads as though it covered the subject.
   *
   * The State column needs a human; the Where column is a claim about the
   * filesystem, and this is the filesystem answering. See
   * scripts/lib/ledger.mjs. */
  { name: 'features:check', cmd: 'pnpm', args: ['features:check'] },
  { name: 'boundaries', cmd: 'pnpm', args: ['boundaries'] },
  /* `boundaries:selftest` IS NOT A STEP, AND THE CASES DID NOT STOP RUNNING.
   *
   * It ran the same `CASES` that `check-boundaries.test.mjs` runs under
   * `test:coverage` below — the same list, through the same `runCase`,
   * asserting the same two conditions (`missing` empty, `unexpected` empty;
   * neither side had a third). So every `pnpm verify` cruised those fixture
   * trees TWICE, for one gate's worth of signal, at 21.6s a pass when this
   * was decided.
   *
   * The vitest run is the one kept, and the deciding argument is `test:ledger`:
   * it names TESTS. Cases behind a standalone script are not in
   * `tests/ledger.json`, so deleting one is invisible — which is precisely the
   * defect that ledger was bought for, after twelve `pageTurn` tests vanished
   * behind a rising count. Independence, the argument for keeping this step,
   * protects against vitest being broken, and that failure is loud.
   *
   * `pnpm boundaries:selftest` still exists and still works; it is a thing to
   * run by hand, not a gate that duplicates one. */
  { name: 'test:projects', cmd: 'pnpm', args: ['test:projects'] },
  /* A DELETED TEST IS INVISIBLE TO EVERY OTHER STEP HERE. Coverage cannot see
   * it — the lines go on being executed by whatever replaced it — and the run
   * is green because the thing that stopped running stopped being counted at
   * the same moment. This one names them. See scripts/check-test-ledger.mjs
   * for the incident that bought it. */
  { name: 'test:ledger', cmd: 'pnpm', args: ['test:ledger'] },
  { name: 'typecheck', cmd: 'pnpm', args: ['typecheck'] },
  { name: 'test:coverage', cmd: 'pnpm', args: ['test:coverage'] },
  { name: 'build', cmd: 'pnpm', args: ['build'] },
  /* THE CLI IS A SECOND BUILD, and it is gitignored — so nothing else in this
   * list would notice it stop compiling. `bin/paper.mjs` is what
   * `scripts/sync-scenario.sh` runs and what `package.json`'s `bin` points at;
   * a `paper` that no longer builds is discovered by whoever next reaches for
   * it, at the worst moment, unless it is discovered here. The build asserts
   * its own output size, because a bundler that wrote nothing exits 0 exactly
   * like one that wrote everything. */
  { name: 'build:cli', cmd: 'pnpm', args: ['build:cli'] },
  { name: 'cargo metadata --locked', cmd: 'cargo', args: ['metadata', '--locked', '--format-version', '1', ...CARGO], quiet: true },
  { name: 'cargo fmt --check', cmd: 'cargo', args: ['fmt', ...CARGO, '--all', '--', '--check'] },
  { name: 'cargo clippy -D warnings', cmd: 'cargo', args: ['clippy', ...CARGO, '--workspace', '--all-targets', '--', '-D', 'warnings'] },
  /* ONE TEST THREAD, AND THE REASON IS MEASURED. `tauri-plugin-peer`'s pairing,
   * session and blob tests stand up real iroh endpoints and wait on real
   * sockets, and their deadlines — "an event within 2s" (`node.rs:388`), "all
   * frames within 20s" (`session.rs:888`) — are the harness's patience, not the
   * property under test. Under libtest's default pool those waits compete with
   * the other 90-odd tests for the machine and lose: measured 2026-08-21 on a
   * 10-core Mac, the parallel run failed 1–3 tests with a DIFFERENT set each
   * time, and `--test-threads=1` passed 95/95 twice.
   *
   * It is close to free on a warm build: the serial step measured 15.9s inside
   * a 135s gate. (A standalone `cargo test -p tauri-plugin-peer` reads 74s, but
   * that figure is mostly compilation and is not what this step pays.) Even had
   * it been dear, a gate that fails at random costs more — the first thing
   * anyone does with one is re-run it, and the second is stop believing it.
   *
   * Widening the deadlines would have bought the same green by making the
   * harness wait longer for a machine that is still oversubscribed: the number
   * would move, the race would not. */
  { name: 'cargo test --workspace', cmd: 'cargo', args: ['test', ...CARGO, '--workspace', '--all-targets', '--', '--test-threads=1'] },
])

/**
 * Run `steps` in order with `run(step)` → exit code (0 ok), writing headers
 * through `log`. Stops at the first non-zero code and returns it; 0 when
 * every step passed. Pure but for the two functions it is handed, so a test
 * can drive it with a fake runner.
 */
export function runSteps(steps, run, log = (line) => process.stdout.write(`${line}\n`)) {
  const started = Date.now()
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    log(`\n▶ verify [${i + 1}/${steps.length}] ${step.name} — ${[step.cmd, ...step.args].join(' ')}`)
    const t = Date.now()
    const code = run(step)
    const took = `${((Date.now() - t) / 1000).toFixed(1)}s`
    if (code !== 0) {
      log(`\n✗ verify: ${step.name} failed (exit ${code}) after ${took}; ${i} of ${steps.length} steps had passed`)
      return code
    }
    log(`✓ verify: ${step.name} passed in ${took}`)
  }
  log(`\n✓ verify: all ${steps.length} steps passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  return 0
}

/** Run one step as a child process in `cwd`, inheriting the terminal (or
 *  discarding stdout for a `quiet` step, whose output is a JSON blob). */
export function spawnStep(step, cwd = REPO_ROOT, extraEnv = undefined) {
  const result = spawnSync(step.cmd, step.args, {
    cwd,
    stdio: step.quiet ? ['inherit', 'ignore', 'inherit'] : 'inherit',
    /* `extraEnv` is how `verify:without` tells the gates inside its copy which
       capability it has just deleted — see `DELETED_ENV`. Nothing sets it on
       the real tree, which is exactly the distinction the gates need. */
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  })
  if (result.error) {
    process.stderr.write(`verify: could not start ${step.cmd}: ${result.error.message}\n`)
    return 127
  }
  if (result.status === null) {
    process.stderr.write(`verify: ${step.name} was killed by ${result.signal}\n`)
    return 128
  }
  return result.status
}

/** `{ steps }` to run, or `{ error }`; `{ list: true }` for `--list`. */
export function parseArgs(argv, steps = STEPS) {
  let from
  let only
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') list = true
    else if (arg === '--from' || arg === '--only') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a step name` }
      if (!steps.some((s) => s.name === value)) return { error: `no step named ${JSON.stringify(value)}; see --list` }
      if (arg === '--from') from = value
      else only = value
      i++
    } else return { error: `unknown argument ${JSON.stringify(arg)}` }
  }
  if (list) return { list: true }
  let selected = [...steps]
  if (from !== undefined) selected = selected.slice(selected.findIndex((s) => s.name === from))
  if (only !== undefined) selected = selected.filter((s) => s.name === only)
  return { steps: selected }
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error !== undefined) {
    process.stderr.write(`verify: ${args.error}\nusage: node scripts/verify.mjs [--list] [--from <step>] [--only <step>]\n`)
    return 2
  }
  if (args.list) {
    for (const step of STEPS) process.stdout.write(`${step.name.padEnd(28)} ${[step.cmd, ...step.args].join(' ')}\n`)
    return 0
  }
  return runSteps(args.steps, (step) => spawnStep(step, REPO_ROOT))
}

if (isProcessEntry(import.meta)) {
  process.exitCode = main(process.argv.slice(2))
}
