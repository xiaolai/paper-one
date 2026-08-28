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
 * (for re-running the tail after a fix); `--until <name>` stops after one
 * (the JS half of the gate on a platform whose Cargo half is a separate
 * job — see `.github/workflows/verify.yml`'s Windows leg); `--only <name>`
 * runs one.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CARGO = ['--manifest-path', 'src-tauri/Cargo.toml']

/** The steps, in order. `cmd` is argv[0], `args` the rest. */
export const STEPS = Object.freeze([
  { name: 'architecture:check', cmd: 'pnpm', args: ['architecture:check'] },
  { name: 'compositions:check', cmd: 'pnpm', args: ['compositions:check'] },
  { name: 'css:check', cmd: 'pnpm', args: ['css:check'] },
  { name: 'css:tokens', cmd: 'pnpm', args: ['css:tokens'] },
  { name: 'browser:check', cmd: 'pnpm', args: ['browser:check'] },
  { name: 'directives:check', cmd: 'pnpm', args: ['directives:check'] },
  /* THE FEATURE-LEDGER GATE IS GONE, and this note is what is left of it.
   * It read `dev-docs/feature-ledger.md` and `dev-docs/library-ledger.md` and checked
   * that every path claim named a file that exists — the Where column being a
   * claim about the filesystem, answered by the filesystem. Both ledgers moved
   * out of the repository with the rest of `dev-docs/`, so the gate had no input
   * on a clean checkout and was removed rather than made conditional on an
   * untracked path, which is the failure this repository has already had.
   *
   * NOTHING REPLACES IT. Stale rows in those ledgers are now caught by nobody.
   */
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
  /* THE BROWSER CLIENT IS A THIRD BUILD, and until phase 18 nothing here ran
   * it. `build` is the DESKTOP bundle: a different Vite config, a different
   * entry (`src/main.web.tsx`), a different composition root, and its own
   * `assert-bundle` pass that refuses a transitive `@tauri-apps` import. None
   * of that is exercised by `pnpm build`.
   *
   * WHAT THAT COST, precisely: `dist-web/` is gitignored, and
   * `tauri-plugin-webhost/build.rs` deliberately compiles with an EMPTY asset
   * set when it is absent. So the browser client could stop compiling, the
   * Rust host would still build, `pnpm verify` would still be green, and the
   * first symptom would be a phone served a 503 by a release nobody suspected.
   * Two gates each doing their job, and the gap between them invisible to both.
   *
   * It costs ~2s on a warm tree. */
  { name: 'build:web', cmd: 'pnpm', args: ['build:web'] },
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
    /* WINDOWS ONLY: `pnpm` there is `pnpm.cmd`, and since Node 20.12 a
     * `.cmd` cannot be spawned without a shell (EINVAL, by design). Every
     * argument in `STEPS` is a plain token — no spaces, no shell characters —
     * so the shell has nothing to misread. Off everywhere else: a shell
     * between this runner and the gate it runs is one more thing to trust. */
    shell: process.platform === 'win32',
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
  let until
  let only
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') list = true
    else if (arg === '--from' || arg === '--until' || arg === '--only') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a step name` }
      if (!steps.some((s) => s.name === value)) return { error: `no step named ${JSON.stringify(value)}; see --list` }
      if (arg === '--from') from = value
      else if (arg === '--until') until = value
      else only = value
      i++
    } else return { error: `unknown argument ${JSON.stringify(arg)}` }
  }
  /* `--list` USED TO WIN SILENTLY. `--list --only build` printed every step and
     ran nothing, which reads as "here is what I am about to do" and is not. A
     selector the reader typed and this ignored is the shape worth refusing. */
  if (list) {
    if (from !== undefined || until !== undefined || only !== undefined) {
      return { error: '--list cannot be combined with --from, --until or --only' }
    }
    return { list: true }
  }
  let selected = [...steps]
  if (from !== undefined) selected = selected.slice(selected.findIndex((s) => s.name === from))
  /* INCLUSIVE, and on the already-narrowed list, so `--from a --until b` with
     b before a is the same empty selection `--from`/`--only` already refuse
     below — a window that names two real steps and contains none is an
     error, not a pass. */
  if (until !== undefined) selected = selected.slice(0, selected.findIndex((s) => s.name === until) + 1)
  if (only !== undefined) selected = selected.filter((s) => s.name === only)
  /* AN EMPTY SELECTION IS AN ERROR, NOT A PASS. `--from build --only typecheck`
     names two real steps and intersects to nothing, and this used to print
     "all 0 steps passed" and exit 0 — a gate reporting success having verified
     literally nothing, which is the worst failure a gate has. */
  if (selected.length === 0) {
    const named = [from !== undefined && `--from ${JSON.stringify(from)}`, until !== undefined && `--until ${JSON.stringify(until)}`, only !== undefined && `--only ${JSON.stringify(only)}`]
      .filter(Boolean)
      .join(' and ')
    return { error: `${named} select no steps; --until and --only must name a step at or after --from` }
  }
  return { steps: selected }
}

function main(argv) {
  const args = parseArgs(argv)
  if (args.error !== undefined) {
    process.stderr.write(`verify: ${args.error}\nusage: node scripts/verify.mjs [--list] [--from <step>] [--until <step>] [--only <step>]\n`)
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
