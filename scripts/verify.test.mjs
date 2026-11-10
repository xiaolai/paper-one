import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { REPO_ROOT, STEPS, main, needsShell, parseArgs, plainToken, runSteps, spawnStep } from './verify.mjs'

/* THE REAL `spawnSync`, UNLESS A TEST SAYS OTHERWISE. The suites below start
   real children; the ones that need to see the options a child was handed,
   or to stand where no child can (a Windows shell, a signal on demand), swap
   in a fake for the length of one call through `faking`. */
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, spawnSync: vi.fn(real.spawnSync) }
})
const { spawnSync: realSpawnSync } = await vi.importActual('node:child_process')

/** Run `fn` with `fake` in place of `spawnSync`, then put the real one back. */
function faking(fake, fn) {
  vi.mocked(spawnSync).mockImplementation(fake)
  try {
    return fn()
  } finally {
    vi.mocked(spawnSync).mockImplementation(realSpawnSync)
  }
}

/** What `fn` wrote to `stream`, which sees none of it. */
function capture(stream, fn) {
  let text = ''
  const write = vi.spyOn(stream, 'write').mockImplementation((chunk) => ((text += chunk), true))
  try {
    fn()
  } finally {
    write.mockRestore()
  }
  return text
}

/** Run `fn` with `process.platform` reading `platform`, then restore it. */
function onPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...real, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

/**
 * `pnpm verify` — the runner, not the gates it runs (each has its own
 * suite): the steps are the plan's, in the plan's order; a failing step
 * stops the run and its exit code comes out; `--list`, `--from` and
 * `--only` select; a step that cannot start or is killed is a code, not a
 * crash.
 */

const SCRIPT = fileURLToPath(new URL('./verify.mjs', import.meta.url))

describe('the steps', () => {
  it('are the plan\'s, in order: manifest, compositions, dead CSS, undefined CSS tokens, browser safety, inert directives, boundaries (and the test-project check and the test ledger), types, coverage, the desktop build, the browser build, the CLI bundle, Cargo, then the notice\'s Rust half', () => {
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
      /* ⚠️ THIS STEP SKIPS ON CI AND THAT IS THE DESIGN, NOT A BUG. `dev-docs/`
         is gitignored whole, so a clean checkout has no ledger to check; it
         prints one line naming `.gitignore:65` rather than passing quietly,
         which is the difference between this and the gate `a1f256f` deleted.
         What binds CI is `scripts/surfaces.mjs`, whose test runs under
         `test:coverage` everywhere. */
      'ledger:check',
      'boundaries',
      'residue:check',
      'test:projects',
      'test:ledger',
      'typecheck',
      'test:coverage',
      'build',
      'build:ios',
      'build:android',
      'build:web',
      'build:cli',
      'cargo metadata --locked',
      'cargo fmt --check',
      'cargo clippy -D warnings',
      'cargo test --workspace',
      'docs:rust-notices --check',
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
    /* THE NOTICE'S RUST HALF IS LAST, AFTER CARGO, and that position is the
     * fix rather than an accident of ordering. Enumerating the crates the
     * binary links needs `cargo metadata` over four targets and a populated
     * registry; the notices test used to ask for it itself, with `--offline`,
     * from inside `test:coverage` — eight steps before cargo runs at all.
     * `--offline` exits 101 on a fresh clone and on a CI runner with a
     * rust-cache keyed on an older lockfile, so a pull request touching
     * `Cargo.lock` could redden the gate for a reason unrelated to it.
     * Anything moving this step above `cargo test --workspace` reintroduces
     * exactly that. */
    expect(STEPS.map((s) => s.name).indexOf('docs:rust-notices --check')).toBeGreaterThan(
      STEPS.map((s) => s.name).indexOf('cargo test --workspace'),
    )
    expect(STEPS.find((s) => s.name === 'docs:rust-notices --check').args).toEqual(['docs:rust-notices', '--check'])
  })
})

describe('the command each step runs', () => {
  /* THE NAMES ARE NOT THE COMMANDS. Every assertion above reads `name`, and the
     runner spawns `cmd` and `args` — so a step could keep its name and run
     nothing (`cmd: ''`, `args: []`) with every name check still green. This
     pins what each step actually executes, and which one discards stdout. */
  it('is the pnpm script or cargo invocation the step is named for, and only the metadata step is quiet', () => {
    const cargo = '--manifest-path src-tauri/Cargo.toml'
    expect(STEPS.map((s) => [s.cmd, ...s.args].join(' '))).toEqual([
      'pnpm architecture:check',
      'pnpm compositions:check',
      'pnpm css:check',
      'pnpm css:tokens',
      'pnpm browser:check',
      'pnpm directives:check',
      'pnpm ledger:check',
      'pnpm boundaries',
      'pnpm residue:check',
      'pnpm test:projects',
      'pnpm test:ledger',
      'pnpm typecheck',
      'pnpm test:coverage',
      'pnpm build',
      'pnpm build:ios',
      'pnpm build:android',
      'pnpm build:web',
      'pnpm build:cli',
      `cargo metadata --locked --format-version 1 ${cargo}`,
      `cargo fmt ${cargo} --all -- --check`,
      `cargo clippy ${cargo} --workspace --all-targets -- -D warnings`,
      `cargo test ${cargo} --workspace --all-targets -- --test-threads=1`,
      'pnpm docs:rust-notices --check',
    ])
    /* `quiet` discards the child's stdout, which for `cargo metadata` is a JSON
       blob nobody reads; on any other step it would hide the gate's output. */
    expect(STEPS.filter((s) => s.quiet === true).map((s) => s.name)).toEqual(['cargo metadata --locked'])
    expect(STEPS.filter((s) => s.quiet !== undefined).map((s) => s.name)).toEqual(['cargo metadata --locked'])
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

  it('times each step and the whole run by the clock, in seconds to one place', () => {
    const now = vi.spyOn(Date, 'now')
    /* Started; a starts and ends; b starts and ends; the run ends. */
    for (const ms of [1_000, 1_200, 3_700, 3_750, 4_050, 9_000]) now.mockReturnValueOnce(ms)
    const log = []
    try {
      expect(runSteps(steps.slice(0, 2), () => 0, (l) => log.push(l))).toBe(0)
    } finally {
      now.mockRestore()
    }
    expect(log).toEqual([
      '\n▶ verify [1/2] a — x 1',
      '✓ verify: a passed in 2.5s',
      '\n▶ verify [2/2] b — y',
      '✓ verify: b passed in 0.3s',
      '\n✓ verify: all 2 steps passed in 8.0s',
    ])
  })

  it('writes to stdout, one line at a time, when handed no log', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000)
    let code
    let out
    try {
      out = capture(process.stdout, () => {
        code = runSteps([], () => 0)
      })
    } finally {
      now.mockRestore()
    }
    expect(code).toBe(0)
    expect(out).toBe('\n✓ verify: all 0 steps passed in 0.0s\n')
  })
})

describe('spawnStep', () => {
  it('returns the child\'s exit code, 127 when it cannot start, and runs in the directory given', () => {
    expect(spawnStep({ name: 'true', cmd: process.execPath, args: ['-e', 'process.exit(0)'] })).toBe(0)
    expect(spawnStep({ name: 'seven', cmd: process.execPath, args: ['-e', 'process.exit(7)'] })).toBe(7)
    expect(spawnStep({ name: 'quiet', cmd: process.execPath, args: ['-e', 'console.log("hidden"); process.exit(0)'], quiet: true })).toBe(0)
    expect(spawnStep({ name: 'missing', cmd: '/nonexistent/binary-for-verify-test', args: [] })).toBe(127)
    /* WINDOWS HAS NO SIGNALS. `process.kill(pid, 'SIGKILL')` there is
       `TerminateProcess`, which sets an exit CODE — `status` is never null, so
       the 128 arm cannot be reached and asserting it would redden the Windows
       leg for a reason that has nothing to do with this runner. */
    if (process.platform !== 'win32') {
      expect(spawnStep({ name: 'killed', cmd: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGKILL")'] })).toBe(128)
    }
  })

  /**
   * THE WINDOWS-ONLY HALF, ASSERTED FROM ANYWHERE.
   *
   * `needsShell` decides both the shell and the plain-token refusal, and the
   * refusal keyed on the platform alone made the whole block above return 126
   * on the Windows leg — which runs `test:coverage` through
   * `pnpm verify --until build:cli`. Nothing on a Mac could see that, so the
   * predicate takes the platform as an argument and both answers are checked
   * here rather than discovered by CI.
   */
  it('takes cmd.exe only for the shims that cannot start without it', () => {
    /* The `.cmd` shims — this is why a shell is used at all. */
    expect(needsShell('pnpm', 'win32')).toBe(true)
    expect(needsShell('cargo', 'win32')).toBe(true)
    /* A full path is an executable Node starts itself; the tests spawn one. */
    expect(needsShell('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(false)
    expect(needsShell('/nonexistent/binary-for-verify-test', 'win32')).toBe(false)
    /* Nowhere else, whatever the command. */
    expect(needsShell('pnpm', 'darwin')).toBe(false)
    expect(needsShell('pnpm', 'linux')).toBe(false)
    /* And the refusal follows it: the arguments the suite above spawns are
       legitimate precisely because no shell reads them. */
    for (const step of STEPS) expect(needsShell(step.cmd, 'win32'), step.name).toBe(true)
    expect(needsShell(process.execPath, process.platform)).toBe(false)
  })

  it('hands the child the directory, the terminal (less stdout when quiet), and the parent\'s environment', () => {
    const seen = []
    const fake = (cmd, args, options) => (seen.push({ cmd, args, options }), { status: 0, signal: null })
    faking(fake, () => {
      expect(spawnStep({ name: 'loud', cmd: process.execPath, args: ['a'] }, '/some/dir')).toBe(0)
      expect(spawnStep({ name: 'quiet', cmd: process.execPath, args: [], quiet: true }, '/some/dir', { VERIFY_TEST_EXTRA: 'yes' })).toBe(0)
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ cmd: process.execPath, args: ['a'], options: { cwd: '/some/dir', stdio: 'inherit', shell: false, env: process.env } })
    expect(seen[0].options.env).toBe(process.env)
    expect(seen[1].options).toEqual({
      cwd: '/some/dir',
      stdio: ['inherit', 'ignore', 'inherit'],
      shell: false,
      env: { ...process.env, VERIFY_TEST_EXTRA: 'yes' },
    })
  })

  it('says why a step could not start, or what killed it', () => {
    let codes
    const err = capture(process.stderr, () => {
      codes = [
        faking(() => ({ error: new Error('spawn gone ENOENT'), status: null, signal: null }), () => spawnStep({ name: 'gone', cmd: process.execPath, args: [] })),
        faking(() => ({ status: null, signal: 'SIGTERM' }), () => spawnStep({ name: 'stopped', cmd: process.execPath, args: [] })),
      ]
    })
    expect(codes).toEqual([127, 128])
    expect(err).toBe(`verify: could not start ${process.execPath}: spawn gone ENOENT\nverify: stopped was killed by SIGTERM\n`)
  })

  /* THE REFUSAL ITSELF, WHERE IT FIRES. The predicate is asserted above for
     both platforms; this drives `spawnStep` as the Windows leg would, with a
     fake in place of the spawn so no shell is ever started here. */
  it('refuses, where cmd.exe would read them, arguments that are not plain tokens', () => {
    const shells = []
    const fake = (cmd, args, options) => (shells.push(options.shell), { status: 0, signal: null })
    let codes
    const err = onPlatform('win32', () =>
      capture(process.stderr, () => {
        codes = faking(fake, () => [
          spawnStep({ name: 'risky', cmd: 'pnpm', args: ['ok', 'a b'] }),
          spawnStep({ name: 'plain', cmd: 'pnpm', args: ['ok', 'also-ok'] }),
        ])
      }),
    )
    expect(codes).toEqual([126, 0])
    expect(err).toBe('verify: refusing to run risky: argument "a b" is not a plain token\n')
    expect(shells).toEqual([true])
  })
})

describe('parseArgs', () => {
  it('selects steps with --from and --only, lists with --list, refuses the rest', () => {
    expect(parseArgs([]).steps.map((s) => s.name)).toEqual(STEPS.map((s) => s.name))
    expect(parseArgs(['--from', 'build']).steps.map((s) => s.name)).toEqual(['build', 'build:ios', 'build:android', 'build:web', 'build:cli', 'cargo metadata --locked', 'cargo fmt --check', 'cargo clippy -D warnings', 'cargo test --workspace', 'docs:rust-notices --check'])
    expect(parseArgs(['--only', 'boundaries']).steps.map((s) => s.name)).toEqual(['boundaries'])
    expect(parseArgs(['--from', 'build', '--only', 'cargo fmt --check']).steps.map((s) => s.name)).toEqual(['cargo fmt --check'])
    expect(parseArgs(['--list'])).toEqual({ list: true })
    expect(parseArgs(['--from'])).toEqual({ error: '--from needs a step name' })
    expect(parseArgs(['--only', 'nope'])).toEqual({ error: 'no step named "nope"; see --list' })
    expect(parseArgs(['--wat'])).toEqual({ error: 'unknown argument "--wat"' })
    /* A repeated selector used to win silently — the second `--only` replaced
       the first with no word about it. */
    expect(parseArgs(['--only', 'build', '--only', 'typecheck'])).toEqual({ error: '--only was given twice' })
    expect(parseArgs(['--from', 'build', '--from', 'typecheck'])).toEqual({ error: '--from was given twice' })
  })

  it('holds the step table frozen all the way down, and its arguments plain tokens', () => {
    for (const step of STEPS) {
      expect(Object.isFrozen(step), `${step.name} is frozen`).toBe(true)
      expect(Object.isFrozen(step.args), `${step.name}'s args are frozen`).toBe(true)
      /* Every real argument must be what the Windows shell cannot misread —
         the refusal in `spawnStep` only fires there, so this is the half a
         macOS run can hold. */
      for (const arg of step.args) expect(plainToken(arg), `${step.name}: ${arg}`).toBe(true)
    }
    expect(plainToken('capability-id')).toBe(true)
    expect(plainToken('a;rm -rf /')).toBe(false)
    expect(plainToken('x&y')).toBe(false)
    expect(plainToken('$(boom)')).toBe(false)
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
    expect(parseArgs(['--from', 'build', '--until', 'build:web']).steps.map((s) => s.name)).toEqual(['build', 'build:ios', 'build:android', 'build:web'])
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

  describe('over a table of its own', () => {
    const steps = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const names = (argv) => parseArgs(argv, steps).steps?.map((s) => s.name)

    it('takes a flag after a selector as a missing value, not as a step name', () => {
      expect(parseArgs(['--only', '--list'], steps)).toEqual({ error: '--only needs a step name' })
    })

    it('refuses only the selector that is repeated, whatever came before it', () => {
      expect(parseArgs(['--until', 'b', '--until', 'c'], steps)).toEqual({ error: '--until was given twice' })
      expect(names(['--until', 'c', '--from', 'b'])).toEqual(['b', 'c'])
      expect(names(['--only', 'b', '--until', 'c'])).toEqual(['b'])
      expect(names(['--until', 'c', '--only', 'b'])).toEqual(['b'])
    })

    it('names exactly the selectors given when they select nothing', () => {
      const why = 'select no steps; --until and --only must name a step at or after --from'
      expect(parseArgs(['--until', 'a', '--only', 'b'], steps)).toEqual({ error: `--until "a" and --only "b" ${why}` })
      expect(parseArgs(['--from', 'c', '--only', 'a'], steps)).toEqual({ error: `--from "c" and --only "a" ${why}` })
    })
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

describe('main', () => {
  const usage = 'usage: node scripts/verify.mjs [--list] [--from <step>] [--until <step>] [--only <step>]\n'

  it('refuses a bad argument with 2 and the usage, and runs nothing', () => {
    const spawned = []
    let code
    const err = capture(process.stderr, () => {
      code = faking((...call) => (spawned.push(call), { status: 0, signal: null }), () => main(['--nope']))
    })
    expect(code).toBe(2)
    expect(err).toBe(`verify: unknown argument "--nope"\n${usage}`)
    expect(spawned).toEqual([])
  })

  it('lists each step, padded, beside the command it runs, and runs nothing', () => {
    const spawned = []
    let code
    const out = capture(process.stdout, () => {
      code = faking((...call) => (spawned.push(call), { status: 0, signal: null }), () => main(['--list']))
    })
    expect(code).toBe(0)
    expect(spawned).toEqual([])
    const lines = out.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines).toHaveLength(STEPS.length)
    expect(lines[0]).toBe('architecture:check           pnpm architecture:check')
  })

  it('runs the steps selected from the repository root, and returns their code', () => {
    const spawned = []
    let codes
    capture(process.stdout, () => {
      codes = [0, 5].map((status) => faking((cmd, args, options) => (spawned.push({ cmd, args, cwd: options.cwd }), { status, signal: null }), () => main(['--only', 'boundaries'])))
    })
    expect(codes).toEqual([0, 5])
    const boundaries = STEPS.find((s) => s.name === 'boundaries')
    expect(spawned).toEqual([0, 5].map(() => ({ cmd: boundaries.cmd, args: [...boundaries.args], cwd: REPO_ROOT })))
  })
})
