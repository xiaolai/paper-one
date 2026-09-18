import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  REPORT,
  matchedSurvivors,
  measureAtBase,
  mutantIdentitiesIn,
  originAtBase,
  originsAtBase,
  reachingAtBase,
  renamesAtBase,
  run,
  runnerUnlike,
  runnerVersionsAt,
  sourceReaders,
  survivorsAtBase,
  survivorsIn,
} from './check-mutants.mjs'

/**
 * What the gate measures AT THE MERGE BASE, and what it refuses to measure.
 *
 * ⚠️ **THE BASE IS A CHECKOUT OF ITS OWN, NEVER BASE FILES DROPPED INTO THIS
 * TREE.** An overlay lets a test from the base import a helper from here, which
 * can manufacture a survivor that never existed at the base — permission
 * invented out of the mixture. So every case here drives a real `git worktree
 * add --detach` against a real repository, and asserts what was actually
 * checked out, installed and removed rather than which calls were made.
 *
 * ⚠️ **AND NOTHING HERE READS THE GATE'S OWN SOURCE.** `pathsRead` follows a
 * name across a whole FILE rather than one scope, so a path bound to a name in
 * this file that also reaches a read would leave `check-mutants.mjs` out of its
 * own sweep — silently, looking exactly like a pass. The last case asserts it.
 */

/** How the generated vitest config spells a covering test: its own path, with
 *  `/` on every platform — `include` is a list of globs, and a glob reads `\` as
 *  an escape. See `vitestConfigFor`. */
const asGlob = (file) => file.split(path.sep).join('/')

/** A scratch directory, removed after `act` whatever `act` does, and again when the case finishes. */
function inScratch(prefix, act) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  const remove = () => rmSync(root, { recursive: true, force: true })
  onTestFinished(remove)
  const result = act(root)
  return typeof result?.then === 'function' ? result.finally(remove) : result
}

/** Writes each `name → contents` under `root`, and answers each one's absolute path. */
function plant(root, files) {
  const at = {}
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
    at[name] = file
  }
  return at
}

/** A repository of its own, with the hooks and identity a runner may not have. */
const gitIn =
  (root) =>
  (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    ).trim()

/**
 * The installed packages whose version decides whether a base can be measured at
 * all — the runner PLUGIN among them, which is half the stack.
 *
 * ⚠️ **AND CORE'S STUB NAMES THE REAL ONE**, because the gate resolves the
 * instrumenter it COUNTS with out of the checkout it is running in — so a child
 * run in one of these scratch worktrees resolves it from here, and a package with
 * a version and no entry point is one nothing can load.
 */
const RUNNERS = {
  'node_modules/@stryker-mutator/core/package.json': `{ "version": "10.0.0", "main": ${JSON.stringify(createRequire(import.meta.url).resolve('@stryker-mutator/core'))} }\n`,
  'node_modules/@stryker-mutator/vitest-runner/package.json': '{ "version": "10.0.0" }\n',
  'node_modules/vitest/package.json': '{ "version": "4.1.11" }\n',
}

/** What every checkout here holds: a project shaped like this one, a module, and a test that reaches it. */
const PROJECT = {
  '.gitignore': 'node_modules\n',
  ...RUNNERS,
  'package.json': '{ "name": "scratch", "private": true }\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'vitest.config.ts': 'export default { test: { passWithNoTests: true } }\n',
  'vite.config.ts': 'export default { plugins: [] }\n',
  'src/a.ts': "export const grade = (n) => (n > 1 ? 'big' : 'small')\n",
  'src/a.test.ts': "import { grade } from './a'\nit('grades', () => grade(2))\n",
}

/**
 * THIS checkout's own install, for the one case that runs a real Stryker over a
 * real worktree — the same directory `suppliedTo` links when a base pins the same
 * bytes, reached the same way.
 *
 * `fileURLToPath` rather than a URL's `pathname`, which on Windows is
 * `/C:/…` and is no path at all — the trap the Windows leg found.
 */
const THIS_INSTALL = installAbove(fileURLToPath(new URL('.', import.meta.url)))

/**
 * A project the real toolchain can run: a function with mutants of several kinds,
 * and one test that reaches exactly one of its two branches, so a real run leaves
 * real survivors in the branch it never takes.
 *
 * It replaces `PROJECT`'s stubbed runner manifests — those describe an install
 * that is not there, and this case needs one that is.
 */
const INSTALLED_PROJECT = {
  'vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'] } }\n",
  'src/a.ts': "export function grade(n: number): string {\n  return n > 1 ? 'big' : 'small'\n}\n",
  'src/a.test.ts': "import { expect, it } from 'vitest'\nimport { grade } from './a'\n\nit('grades a big number', () => {\n  expect(grade(2)).toBe('big')\n})\n",
}

/** A committed checkout, and the commit it is at — `without` naming what this one does not have. */
function repository(root, files = {}, without = []) {
  const git = gitIn(root)
  git('init', '-q', '-b', 'main')
  plant(root, Object.fromEntries(Object.entries({ ...PROJECT, ...files }).filter(([name]) => !without.includes(name))))
  git('add', '-A')
  git('commit', '-qm', 'base')
  return { git, at: git('rev-parse', 'HEAD') }
}

/**
 * Stands in for Stryker: one `plan` per run, each naming the mutants it leaves
 * alive, the ones it leaves timed out and the ones it crashes on, by where they
 * sit in the instrumenter's own order. A run with no plan of its own kills
 * everything.
 *
 * It reads the subject THROUGH the config it was handed, so what it reports is
 * whatever was really checked out — which is what these cases are about.
 */
function strykerReporting(...plans) {
  const seen = []
  const stryker = async (config, root) => {
    const settings = JSON.parse(await readFile(config, 'utf8'))
    const [subject] = settings.mutate
    const source = await readFile(subject, 'utf8')
    const { survived = [], timedOut = [], hitLimit = [], errored = [], exit } = plans[seen.length] ?? {}
    seen.push({
      subject,
      root,
      source,
      timeoutMS: settings.timeoutMS,
      installed: existsSync(path.join(path.dirname(config), 'node_modules')),
      /* The generated config as it was handed over, which names the tests the
         run was given — the whole of what a base measurement is measured
         AGAINST. */
      against: await readFile(settings.vitest.configFile, 'utf8'),
    })
    const statusOf = (at) => {
      if (survived.includes(at)) return { status: 'Survived' }
      /* The WORDS are the evidence and the counters are the volatile half of the
         sentence — `determineHitLimitReached` in `@stryker-mutator/api` 10.0.0 is
         the only thing in Stryker that writes a reason beside a `Timeout`. */
      if (hitLimit.includes(at)) return { status: 'Timeout', statusReason: 'Hit limit reached (330901/330900)' }
      if (timedOut.includes(at)) return { status: 'Timeout' }
      /* A mutant the run crashed on has no score — which is what a settle run
         answering for nothing looks like, mutant by mutant. */
      return { status: errored.includes(at) ? 'RuntimeError' : 'Killed' }
    }
    const mutants = (await mutantIdentitiesIn(subject)).map((one, at) => ({ ...one, id: String(at), ...statusOf(at) }))
    await writeFile(path.join(path.dirname(config), REPORT), JSON.stringify({ files: { [subject]: { source, mutants } } }))
    return exit ?? (survived.length === 0 && timedOut.length === 0)
  }
  return { stryker, seen }
}

/** Where `'big'` sits in the instrumenter's own order for the module above — after the arrow, two conditionals and two equality operators. */
const BIG = 5

/** A survivor's identity as this gate writes one, for cases about the fields AROUND it. */
const IDENTITY = { mutatorName: 'StringLiteral', replacement: '""', original: "'big'", scope: ['grade'] }

/** `text`'s SHA-256, as this gate digests a file's bytes. */
const digestOf = (text) => createHash('sha256').update(text).digest('hex')

/** The content the merge base holds at `src/a.ts` in every checkout here, and its digest — what a measurement of it must turn out to have swept. */
const A_SOURCE = PROJECT['src/a.ts']
const A_SHA = digestOf(A_SOURCE)

/**
 * A measurement as the child writes one: the content it swept, the runs that
 * swept it, and what they amounted to. The survivors are not among them — every
 * reader derives those, which is what makes this evidence rather than a claim.
 */
const measurement = (fields = {}) => ({
  kind: 'measurement',
  version: 1,
  subject: 'src/a.ts',
  refusal: null,
  outcome: 'no-mutants',
  durationMs: 0,
  sha256: A_SHA,
  source: A_SOURCE,
  first: null,
  settle: null,
  ...fields,
})

/** A clock that moves on 250 ms each time it is read. */
function ticking() {
  let now = 0
  return () => (now += 250)
}

/**
 * Stands in for the child that does the measuring: records where it was run,
 * what it was asked for and what it found THERE — which is how these cases
 * assert that a real worktree of the merge base was what it read — and writes
 * whatever `answer` says over a measurement of everything killed.
 */
function childWriting(answer = () => ({})) {
  const seen = []
  const child = (at, subject, into) => {
    const file = path.join(at, subject)
    seen.push({
      at,
      subject,
      into,
      source: existsSync(file) ? readFileSync(file, 'utf8') : null,
      installed: existsSync(path.join(at, 'node_modules')),
    })
    writeFileSync(into, JSON.stringify({ ...measurement({ subject }), ...answer(at, subject) }))
  }
  return { child, seen }
}

/** `measureAtBase` over a scratch checkout, with the install, the scratch root and the child that measures stood in for. */
async function measure(root, subject, commit, { child = childWriting().child, ...options } = {}) {
  const installs = []
  const answer = await measureAtBase(subject, commit, {
    root,
    child,
    install: (at) => void (installs.push(at), plant(at, RUNNERS)),
    ...options,
  })
  return { answer, installs }
}

/**
 * `run` in `--measure` mode over the checkout at `root`, with Stryker and both
 * streams stood in for — the child's own half of a base measurement, driven
 * exactly as the child drives it.
 */
async function measuring(root, subject, { stryker = strykerReporting().stryker, into = path.join(root, 'measured.json'), ...options } = {}) {
  const said = { stdout: '', stderr: '' }
  const code = await run(['--measure', subject, '--into', into], {
    root,
    stdout: { write: (text) => void (said.stdout += text) },
    stderr: { write: (text) => void (said.stderr += text) },
    stryker,
    clock: ticking(),
    changed: () => {
      throw new Error('a measurement of one named file discovers no changed file')
    },
    commits: () => {
      throw new Error('a measurement of one named file asks git nothing')
    },
    lock: () => {
      throw new Error('a measurement may not take the checkout’s own lock')
    },
    ...options,
  })
  return { code, into, record: existsSync(into) ? JSON.parse(readFileSync(into, 'utf8')) : null, ...said }
}

/** What a refusal left behind, or `null` when nothing was thrown. */
async function refusedBy(act) {
  try {
    await act()
    return null
  } catch (cause) {
    return cause
  }
}

/** The worktrees git knows about in the checkout at `root`, besides the checkout itself. */
const worktreesOf = (root) =>
  gitIn(root)('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .slice(1)

describe('what the merge base is asked, before it is measured', () => {
  it('refuses a merge base this checkout does not have, naming it as evidence it cannot get', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      const missing = 'c'.repeat(40)

      const refusal = await refusedBy(() => measure(root, 'src/a.ts', missing))

      expect(refusal.reason).toBe('no-commit')
      expect(refusal.message).toBe(
        `check-mutants: the merge base ${missing} is not in this checkout, so what src/a.ts owed there cannot be measured — ` +
          'fetch it (`fetch-depth: 0`) and run again',
      )
      expect(worktreesOf(root)).toEqual([])
    })
  })

  /* A missing COMMIT is evidence the gate cannot get; a missing PATH is a file
     the base does not have, which is the caller's policy and not a measurement.
     They are told apart because one of them is not a failure at all. */
  it('refuses a path the merge base does not have as a different answer from a merge base it cannot find', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() => measure(root, 'src/added.ts', at))

      expect(refusal.reason).toBe('absent-at-base')
      expect(refusal.message).toBe(
        `check-mutants: the merge base ${at} has no src/added.ts, so there is nothing there to measure — a file the merge ` +
          'base does not have is new, and what a new file owes is not this measurement’s to say',
      )
      expect(worktreesOf(root)).toEqual([])
    })
  })

  /* ⚠️ **A WORKTREE INSIDE THE CHECKOUT IS A CHANGE TO THE TREE A PLAN
     FINGERPRINTS**, and a shard compares that tree around every file it sweeps —
     so a base checked out there stops the shard that asked for it. */
  it('refuses to check the merge base out inside the checkout it is measuring against', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const inside = path.join(root, 'scratch')

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          scratch: () => {
            mkdirSync(inside)
            return inside
          },
        }),
      )

      expect(refusal.reason).toBe('scratch-inside')
      expect(refusal.message).toBe(
        `check-mutants: the merge base would be checked out at ${inside}, which is inside the checkout at ${root} — a ` +
          'worktree there is a change to the very tree a plan fingerprints; give it a directory outside',
      )
      expect(existsSync(inside)).toBe(false)
    })
  })
})

describe('the merge base as a checkout of its own', () => {
  it('measures the base’s own content, not this tree’s, and removes the worktree afterwards', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      plant(root, { 'src/a.ts': "export const grade = (n) => (n > 1 ? 'huge' : 'tiny')\n" })
      const measuring = childWriting()
      const made = []

      const { answer } = await measure(root, 'src/a.ts', at, {
        child: measuring.child,
        scratch: () => {
          const dir = mkdtempSync(path.join(tmpdir(), 'mutants-watched-'))
          made.push(dir)
          return dir
        },
      })

      expect(measuring.seen[0].source).toBe("export const grade = (n) => (n > 1 ? 'big' : 'small')\n")
      /* ⚠️ **AND THE CHILD IS RUN IN THE BASE WORKTREE**, measured 2026-09-16:
         Stryker sandboxes the project it is started in, so a child started here
         would sweep this checkout under the merge base's name. */
      expect(measuring.seen[0].at).toBe(path.join(made[0], 'base'))
      expect(measuring.seen[0].subject).toBe('src/a.ts')
      expect(answer.sha256).toBe(A_SHA)
      expect(worktreesOf(root)).toEqual([])
      /* Off the disk as well as out of git's list: a directory left behind is a
         checkout of an old commit nobody will ever come back for. */
      expect(made.map(existsSync)).toEqual([false])
    })
  })

  /**
   * ⚠️ **THE COMMAND LINE PASSES `.` AS ITS ROOT, AND THAT MADE THE WHOLE
   * COMPARISON INERT** — measured 2026-09-17, sweeping this gate against the
   * released 0.3.5 on a runner with real history. The base's install was linked
   * with `path.join(root, 'node_modules')` as the link's TARGET, which for a root
   * of `.` is the bare name `node_modules`; a relative target is resolved beside
   * the LINK, and the link is in the base worktree, so the base's `node_modules`
   * pointed at itself. Reading a runner version through it answered nothing, and
   * every base measurement refused with "the merge base's @stryker-mutator/core
   * is missing" — which is word for word the refusal a base on another major
   * version gets, so the failure read as a real incompatibility.
   *
   * Every other case here hands `measureAtBase` an absolute root, which is why
   * none of them saw it. This one runs from inside the checkout and names it as
   * the command line does.
   */
  it('links this checkout’s install by a target that does not depend on where the link sits', async () => {
    /* ⚠️ **IN A CHILD WHOSE WORKING DIRECTORY IS THE CHECKOUT, NOT BY `chdir`.**
       This case called `process.chdir(root)`, which Node refuses inside a worker
       thread — and Stryker runs every test in one, so the dry run of this gate's
       own sweep died on it and the gate could not be mutation-tested at all
       (found 2026-09-18). The same move as `changedFiles`' case: the question is
       asked by a process started there. */
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const script = new URL('./check-mutants.mjs', import.meta.url).href
      const program = [
        "import { realpathSync, writeFileSync } from 'node:fs'",
        "import path from 'node:path'",
        `import { measureAtBase, runnerVersionsAt } from ${JSON.stringify(script)}`,
        'const seen = []',
        `const answer = await measureAtBase('src/a.ts', ${JSON.stringify(at)}, {`,
        "  root: '.',",
        '  child: (where, subject, into) => {',
        /* Read INSIDE the child, because the worktree is gone by the time
           `measureAtBase` answers. */
        "    seen.push({ linked: realpathSync(path.join(where, 'node_modules')), versions: runnerVersionsAt(where) })",
        `    writeFileSync(into, ${JSON.stringify(JSON.stringify(measurement({ subject: 'src/a.ts' })))})`,
        '  },',
        "  install: () => { throw new Error('two commits pinning the same bytes share an install') },",
        '})',
        "process.stdout.write('\\n' + RESULT + JSON.stringify({ install: answer.install, seen }))",
      ].join('\n')

      const printed = execFileSync(process.execPath, ['--input-type=module', '-e', `const RESULT = ${JSON.stringify(RESULT)}\n${program}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const { install, seen } = JSON.parse(printed.slice(printed.lastIndexOf(RESULT) + RESULT.length))

      expect(install).toBe('linked')
      /* The measurement RAN, which is the half a refusal hides: with the link
         pointing at itself the child was never started at all. */
      expect(seen).toHaveLength(1)
      expect(seen[0].linked).toBe(realpathSync(path.join(root, 'node_modules')))
      /* And what is read THROUGH the link is this checkout's own install,
         which is the question that refused every base measurement. */
      expect(seen[0].versions).toEqual({ '@stryker-mutator/core': '10.0.0', '@stryker-mutator/vitest-runner': '10.0.0', vitest: '4.1.11' })
    })
  })

  /** Where a child's answer starts in what it printed — after anything else it said on the way. */
  const RESULT = '@@measured@@'

  it('refuses when the merge base cannot be checked out at all, in git’s own words', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          scratch: () =>
            inScratch('mutants-taken-', (taken) => {
              plant(taken, { base: 'something is already here\n' })
              return taken
            }),
        }),
      )

      expect(refusal.reason).toBe('worktree')
      expect(refusal.message).toMatch(new RegExp(`^check-mutants: cannot check the merge base ${at} out at .+ — `, 'u'))
      /* ⚠️ **GIT'S OWN REASON, AND NOTHING AFTER IT.** The words come off the
         pipe `stdio` asks for — with stderr ignored the message is node's
         "Command failed" and no reason at all — and the trim is what stops the
         line break git wrote from ending this gate's sentence. `$` in JavaScript
         does not forgive a trailing newline, so it asserts both. */
      expect(refusal.message).toMatch(/fatal: .+ already exists$/su)
    })
  })

  /* A directory this run never made is not one it may fail to remove: the
     refusal above happens before the worktree is added, and a removal that
     insisted on its own scratch existing would throw from the `finally` and
     replace the refusal with `ENOENT`. */
  it('leaves the refusal standing when the scratch directory it refused was never made', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const inside = path.join(root, 'scratch')

      const refusal = await refusedBy(() => measure(root, 'src/a.ts', at, { scratch: () => inside }))

      expect(refusal.reason).toBe('scratch-inside')
      expect(existsSync(inside)).toBe(false)
    })
  })

  /* The scratch checkout carries this gate's name, so one left behind by a run
     that was killed can be found and removed by hand. Nothing else names it. */
  it('names the scratch checkout it made, so one left on the disk can be recognised', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() => measure(root, 'src/a.ts', at, { child: () => {} }))

      expect(refusal.reason).toBe('child')
      expect(refusal.message).toMatch(/at .*[/\\]check-mutants-base-[^/\\]+[/\\]measured\.json — /u)
    })
  })

  it('leaves no worktree behind when the measurement itself refuses', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          child: () => {
            throw new Error('the child fell over')
          },
        }),
      )

      expect(refusal).toBeInstanceOf(Error)
      expect(worktreesOf(root)).toEqual([])
    })
  })
})

/**
 * ⚠️ **THE MEASUREMENT IS A CHILD PROCESS, AND EVERY WAY IT CAN FAIL TO ANSWER
 * IS A REFUSAL.** It writes what it found to a file the parent names, so the
 * parent's evidence is that file and nothing else — not an exit code, which a
 * deliberate refusal also makes non-zero, and not a message on a stream.
 */
describe('the child that does the measuring, and what it is refused for', () => {
  it('refuses a child that left no measurement at all, carrying how it ended', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          child: () => {
            throw new Error('spawn node ENOENT')
          },
        }),
      )

      expect(refusal.reason).toBe('child')
      expect(refusal.message).toMatch(
        /^check-mutants: the run that was to measure src\/a\.ts at the merge base left no measurement at .+ — ENOENT[^;]+; it ended with: spawn node ENOENT$/u,
      )
    })
  })

  it('refuses a measurement it cannot read as one this gate wrote', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const written = [
        ['not json at all', /Unexpected token/u],
        [JSON.stringify({ kind: 'result' }), /it is not a measurement$/u],
        [JSON.stringify({ kind: 'measurement', version: 9, subject: 'src/a.ts' }), /its version is 9, and this gate reads version 1$/u],
        [JSON.stringify({ kind: 'measurement', version: 1, subject: 42 }), /its subject is 42, which is not a path$/u],
        /* A path of no characters is a string and is no path: taken as one it
           would go on to be compared with the subject, and the refusal a reader
           got would be about a measurement of the wrong file. */
        [JSON.stringify({ kind: 'measurement', version: 1, subject: '' }), /its subject is "", which is not a path$/u],
        [
          JSON.stringify({ kind: 'measurement', version: 1, subject: 'src/a.ts', refusal: 'it went wrong' }),
          /its refusal is "it went wrong", which is neither a refusal nor null$/u,
        ],
        [
          JSON.stringify({ kind: 'measurement', version: 1, subject: 'src/a.ts', refusal: { reason: 5, message: 'x' } }),
          /its refusal\.reason is 5, which is not a reason$/u,
        ],
        [
          JSON.stringify({ kind: 'measurement', version: 1, subject: 'src/a.ts', refusal: { reason: '', message: 'x' } }),
          /its refusal\.reason is "", which is not a reason$/u,
        ],
        [
          JSON.stringify({ kind: 'measurement', version: 1, subject: 'src/a.ts', refusal: null, outcome: 'sort of' }),
          /its outcome is "sort of", which this gate does not measure$/u,
        ],
        [
          JSON.stringify({ kind: 'measurement', version: 1, subject: 'src/a.ts', refusal: null, outcome: 'killed', durationMs: '5' }),
          /its durationMs is "5", which is not a duration$/u,
        ],
        /* ⚠️ **EVERY FIELD THE SURVIVORS ARE DERIVED FROM, ONE AT A TIME.** A
           measurement carries no list of survivors any more — it carries what it
           swept and what swept it, and every reader works the survivors out of
           those, so a field of it that is not what this gate writes is a
           derivation that would be made over somebody else's shapes. */
        [JSON.stringify(measurement({ outcome: 'killed', sha256: 'not a digest' })), /its sha256 is "not a digest", which is not a digest$/u],
        [JSON.stringify(measurement({ outcome: 'killed', source: 42 })), /its source is 42, which is not the content it swept$/u],
        [JSON.stringify(measurement({ outcome: 'killed', first: 'ran' })), /its first is "ran", which is neither a first run nor null$/u],
        [
          JSON.stringify(measurement({ outcome: 'killed', first: { exitedCleanly: 'yes', report: null, durationMs: 1 } })),
          /its first\.exitedCleanly is "yes", which is not an exit$/u,
        ],
        [
          JSON.stringify(measurement({ outcome: 'killed', first: { exitedCleanly: true, report: null, durationMs: '1' } })),
          /its first\.durationMs is "1", which is not a duration$/u,
        ],
        [
          JSON.stringify(measurement({ outcome: 'killed', first: { exitedCleanly: true, report: 'a report', durationMs: 1 } })),
          /its first\.report is "a report", which is not a report$/u,
        ],
        [
          JSON.stringify(measurement({ outcome: 'killed', settle: { exitedCleanly: true, report: [], durationMs: 1 } })),
          /its settle\.report is a list, which is not a report$/u,
        ],
      ]

      for (const [bytes, why] of written) {
        const refusal = await refusedBy(() => measure(root, 'src/a.ts', at, { child: (_at, _subject, into) => writeFileSync(into, bytes) }))

        expect(refusal.reason, bytes).toBe('child')
        expect(refusal.message, bytes).toMatch(why)
      }
    })
  })

  /* ⚠️ **A MEASUREMENT OF ANOTHER FILE WOULD AUTHORISE THIS FILE WITH ANOTHER
     FILE'S DEBT**, and a record is a file on disk: a stale one from an earlier
     subject reads exactly like this one's. */
  it('refuses a measurement of another file, naming the file it measured instead', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, { child: childWriting(() => ({ subject: 'src/other.ts' })).child }),
      )

      expect(refusal.reason).toBe('mismatched')
      expect(refusal.message).toBe(
        'check-mutants: the run that was to measure src/a.ts at the merge base measured "src/other.ts" instead',
      )
    })
  })

  /* A refusal the CHILD made is the parent's refusal, by its own reason and in
     its own words: the child is the one that knows which of them it met. The
     record is written whole here rather than over a measurement's fields,
     because a refusal is what a child writes INSTEAD of one — it carries no
     outcome, no duration and no survivors, and reading it as though it did
     would be reading an unmeasured base as a measured one. */
  it('raises the child’s own refusal, by the reason the child gave it', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const refused = { reason: 'did-not-run', message: 'check-mutants: the merge base’s run of src/a.ts scored nothing' }
      const child = (_at, subject, into) =>
        writeFileSync(into, JSON.stringify({ kind: 'measurement', version: 1, subject, refusal: refused }))

      const refusal = await refusedBy(() => measure(root, 'src/a.ts', at, { child }))

      expect(refusal.reason).toBe('did-not-run')
      expect(refusal.message).toBe('check-mutants: the merge base’s run of src/a.ts scored nothing')
      expect(worktreesOf(root)).toEqual([])
    })
  })

  /* Every outcome a measurement can END in is an answer the parent takes; the
     ones that are not are refused a case above. A file with nothing to kill and
     a file no test at the base reaches are both measurements — the second is the
     worst answer a file can have, and it is still an answer — so a parent that
     did not take them would refuse the very cases this comparison exists for. */
  it('takes every outcome a measurement can end in as an answer about the merge base', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)

      for (const outcome of ['killed', 'survived', 'nothing-to-kill', 'no-mutants']) {
        const { answer } = await measure(root, 'src/a.ts', at, { child: childWriting(() => ({ outcome })).child })

        expect(answer.outcome, outcome).toBe(outcome)
      }
    })
  })

  /**
   * ⚠️ **AND THE REAL COMMAND, RUN FOR REAL** — because everything above stands
   * in for it, and a spawn that cannot start looks exactly like one that can
   * until it is tried. The subject here is a re-export with no mutant in it, so
   * the child answers without ever starting Stryker: that is the one shape of
   * this run a test can afford, and it still proves the whole chain — this node,
   * this gate file, `--measure`, the worktree as its directory, and a record
   * read back.
   */
  it('runs this gate over the merge base’s own checkout, and reads back what it wrote', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root, { 'src/a.ts': "export { grade } from './b'\n", 'src/b.ts': 'export const grade = 1\n' })

      /* `measureAtBase` itself, with nothing stood in for but the install — which
         is never reached, because both commits pin the same bytes and the base
         is handed this checkout's own `node_modules`. */
      const answer = await measureAtBase('src/a.ts', at, {
        root,
        install: () => {
          throw new Error('two commits pinning the same bytes share an install')
        },
      })

      expect(answer).toEqual({
        install: 'linked',
        outcome: 'no-mutants',
        /* ⚠️ **WHAT IT COST IS WHAT THE WHOLE OPERATION COST** — the worktree, the
           install and the child's own startup, not the number Stryker reported
           for a run that never happened. It is a real clock here, so what is
           asserted is that it is one. */
        durationMs: expect.any(Number),
        sha256: digestOf("export { grade } from './b'\n"),
        source: "export { grade } from './b'\n",
        first: null,
        settle: null,
      })
      expect(worktreesOf(root)).toEqual([])
    })
  })

  /**
   * ⚠️ **AND THE WHOLE THING, MEASURING SOMETHING — A REAL STRYKER OVER A REAL
   * INSTALL.** The case above proves the SPAWN: this node, this gate file,
   * `--measure`, the worktree as its directory, a record read back. What it
   * cannot prove is that anything was MEASURED, because its subject is a
   * re-export with no mutant in it, so the child answers before Stryker is ever
   * started — and every other case here stands in for Stryker, for the child, or
   * for both.
   *
   * ⚠️ **THAT GAP IS EXACTLY THE SHAPE OF THE ONE THIS SUITE MISSED** (2026-09-17).
   * 397 unit cases passed over a merge-base measurement that came back
   * `did-not-run` in seconds on a real branch, because not one of them ran the
   * two halves against each other: a child that really starts Stryker, in a
   * worktree that really has an install, over a file that really has mutants. A
   * stub cannot fail the way an install, a sandbox or a runner fails. So this one
   * is slow and heavy on purpose, and it asserts a measurement with real
   * survivors in it rather than a call that was made.
   *
   * The install is THIS checkout's, reached by a link — which is what
   * `suppliedTo` does for a base pinning the same bytes, so the base worktree
   * gets it the same way the real thing does.
   */
  it('measures the merge base for real — a spawned child, a real Stryker, a real report, real survivors', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root, INSTALLED_PROJECT, Object.keys(RUNNERS))
      symlinkSync(THIS_INSTALL, path.join(root, 'node_modules'), 'junction')

      const answer = await measureAtBase('src/a.ts', at, {
        root,
        install: () => {
          throw new Error('two commits pinning the same bytes share an install')
        },
      })

      expect(answer.install).toBe('linked')
      /* A real run of a real file: `grade(2)` is the only call any test makes, so
         the `'small'` branch is never taken and its mutants are alive. */
      expect(answer.outcome).toBe('survived')
      expect(answer.sha256).toBe(digestOf(INSTALLED_PROJECT['src/a.ts']))
      expect(answer.first.exitedCleanly).toBe(false)
      /* ⚠️ **A REAL REPORT NAMES THE FILE RELATIVE TO WHERE STRYKER RAN**, which
         is the worktree — and every reader compares it by `path.resolve`, in the
         reader's own directory. The two agree because both sides spell it the
         same RELATIVE way, which is what a sweep does with its root of `.`; an
         absolute `at` here resolves somewhere else and the report reads as another
         file's. The stubbed cases never meet this, because a stub reports back
         whatever absolute path it was handed. */
      expect(Object.keys(answer.first.report.files)).toEqual(['src/a.ts'])
      const { survivors, problem } = await survivorsAtBase(answer, { at: 'src/a.ts', named: 'src/a.ts', frozen: answer.sha256 })
      expect(problem).toBeUndefined()
      /* Stryker's own mutants, identified by this gate's own reading of them —
         both halves real, which is the whole point of the case. The `'small'`
         branch is the one no test takes. */
      const small = survivors.find((one) => one.identity.original === "'small'")
      expect(small?.identity).toEqual({
        mutatorName: 'StringLiteral',
        replacement: '""',
        original: "'small'",
        statement: "return n > 1 ? 'big' : 'small'",
        scope: ['grade'],
      })
      expect(survivors.every((one) => one.file === 'src/a.ts' && one.from === 'src/a.ts')).toBe(true)
      expect(worktreesOf(root)).toEqual([])
    })
  }, 300_000)

  /**
   * ⚠️ **THE CHILD'S STREAMS ARE THE READER'S, AND THIS GATE'S EVIDENCE IS THE
   * RECORD.** The child is handed this process's own stdout and stderr, so a base
   * run's progress appears where somebody is already looking — and nothing it
   * says is read back. Given a list Node pads into pipes instead, a child that
   * fails has its own words spliced into the refusal below, which is how a
   * measurement that could not be made would start explaining itself in a
   * stranger's voice.
   *
   * The child refuses here on the one path that leaves NO record — a link at the
   * name it was told to write — so what it says is one line rather than a stack,
   * and the parent has nothing to read but how the run ended.
   */
  it('leaves the child’s own streams to the reader, and carries back only how the run ended', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root, { 'src/a.ts': "export { grade } from './b'\n", 'src/b.ts': 'export const grade = 1\n' })

      const refusal = await refusedBy(() =>
        measureAtBase('src/a.ts', at, {
          root,
          install: () => {
            throw new Error('two commits pinning the same bytes share an install')
          },
          scratch: () =>
            inScratch('mutants-linked-', (temp) => {
              symlinkSync(path.join(temp, 'nowhere.json'), path.join(temp, 'measured.json'))
              return temp
            }),
        }),
      )

      expect(refusal.reason).toBe('child')
      expect(refusal.message).toMatch(/; it ended with: Command failed: [^\n]+--measure src\/a\.ts [^\n]+$/u)
    })
  })
})

describe('the dependencies the merge base’s own tests are run with', () => {
  it('uses this checkout’s install where the base pins exactly what it pins', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      const measuring = childWriting()

      const { answer, installs } = await measure(root, 'src/a.ts', at, { child: measuring.child })

      expect(installs).toEqual([])
      expect(answer.install).toBe('linked')
      expect(measuring.seen[0].installed).toBe(true)
    })
  })

  it('installs the base’s own dependencies where its lockfile or its manifest is not this one', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at, git } = repository(root)
      plant(root, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n" })
      git('add', '-A')
      git('commit', '-qm', 'head')

      const { answer, installs } = await measure(root, 'src/a.ts', at)

      expect(answer.install).toBe('installed')
      expect(installs).toHaveLength(1)
      expect(installs[0].startsWith(root)).toBe(false)
    })
  })

  /* A pin that is not there on either side is not a pin they share: two commits
     that both lack a lockfile have said nothing about their dependencies, and
     `linked` would be a claim about an install nobody described. */
  it('installs the base’s own dependencies where neither commit pins anything at all', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root, {}, ['pnpm-lock.yaml'])

      const { answer, installs } = await measure(root, 'src/a.ts', at)

      expect(answer.install).toBe('installed')
      expect(installs).toHaveLength(1)
    })
  })

  /**
   * ⚠️ **NOTHING BOUNDED A BASE MEASUREMENT IN TIME** (review, 2026-09-17).
   * Every surviving file makes another worktree, possibly another install, and a
   * Stryker run whose size nothing about the change predicts — and a base no
   * covering test was found for is measured against the merge base's whole suite.
   * A hung install or a hung child would spend a CI job's entire budget and
   * report nothing at all. Both are bounded now, and expiry is a refusal, which
   * authorises nothing.
   *
   * The caps are provisional; what makes them replaceable is that a measurement
   * records what the WHOLE operation cost, install and child startup included,
   * rather than what Stryker reported.
   */
  it('gives the install and the child what is left of the time it allows, and refuses when there is none', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at, git } = repository(root)
      plant(root, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n" })
      git('add', '-A')
      git('commit', '-qm', 'head')
      const given = []
      /* A clock that moves on a minute each time it is read, so that the budget
         is spent by the reading rather than by waiting. */
      let minutes = 0
      const clock = () => (minutes += 1) * 60_000

      const { answer } = await measure(root, 'src/a.ts', at, {
        clock,
        install: (into, options) => {
          given.push(['install', options.timeoutMs])
          plant(into, RUNNERS)
        },
        child: (where, subject, into, options) => {
          given.push(['child', options.timeoutMs])
          writeFileSync(into, JSON.stringify(measurement({ subject })))
        },
      })

      /* Ten minutes for the install and ninety for the whole of it, each less
         whatever had gone by when it was asked — one minute by the install, two
         by the child, on a clock that moves a minute a reading. */
      expect(given).toEqual([
        ['install', 10 * 60_000 - 60_000],
        ['child', 90 * 60_000 - 2 * 60_000],
      ])
      /* And what it cost is the whole operation, by the same clock. */
      expect(answer.durationMs).toBe(3 * 60_000)
    })
  })

  it('refuses a merge base whose measurement has taken longer than this gate allows for one file', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at } = repository(root)
      let readings = 0
      /* Two hours gone by the time the child would start. */
      const clock = () => (readings += 1) * 60 * 60_000

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          clock,
          child: () => {
            throw new Error('a measurement with no time left is never started')
          },
        }),
      )

      expect(refusal.reason).toBe('expired')
      expect(refusal.message).toBe(
        'check-mutants: measuring src/a.ts at the merge base took longer than the 90 minute(s) this gate allows for one ' +
          'file, so what it owed there is unmeasured — and unmeasured is never permission',
      )
      expect(worktreesOf(root)).toEqual([])
    })
  })

  it('refuses an install with no time left rather than starting one nobody will wait for', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at, git } = repository(root)
      plant(root, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n" })
      git('add', '-A')
      git('commit', '-qm', 'head')
      let readings = 0
      const clock = () => (readings += 1) * 20 * 60_000

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          clock,
          install: () => {
            throw new Error('an install with no time left is never started')
          },
        }),
      )

      expect(refusal.reason).toBe('expired')
      expect(refusal.message).toMatch(
        /^check-mutants: there is no time left to install the merge base’s own dependencies at .+ — this gate allows 10 minute\(s\) for one, and an install nobody waited for is not a measurement$/u,
      )
    })
  })

  /* ⚠️ **AN INSTALL THAT CANNOT RUN IS EVIDENCE THE GATE DOES NOT HAVE.** It is
     never this checkout's install instead: the base's tests are the base's, and
     running them against another dependency tree measures neither commit. */
  it('refuses when the base’s own install cannot run, rather than falling back to this checkout’s', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at, git } = repository(root)
      plant(root, { 'package.json': '{ "name": "scratch", "private": true, "type": "module" }\n' })
      git('add', '-A')
      git('commit', '-qm', 'head')

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          install: () => {
            throw new Error('ERR_PNPM_NO_OFFLINE_META')
          },
        }),
      )

      expect(refusal.reason).toBe('install')
      expect(refusal.message).toMatch(
        /^check-mutants: the merge base’s own dependencies cannot be installed at .+ — ERR_PNPM_NO_OFFLINE_META$/u,
      )
      expect(worktreesOf(root)).toEqual([])
    })
  })
})

describe('whether the merge base’s runner is one this gate’s settings mean anything for', () => {
  const versions = { '@stryker-mutator/core': '10.0.0', '@stryker-mutator/vitest-runner': '10.0.0', vitest: '4.1.11' }
  const nothing = { '@stryker-mutator/core': null, '@stryker-mutator/vitest-runner': null, vitest: null }

  it('reads each package’s version from the install itself, and says so where it cannot', async () => {
    await inScratch('mutants-versions-', (root) => {
      plant(root, RUNNERS)

      expect(runnerVersionsAt(root)).toEqual(versions)
      expect(runnerVersionsAt(path.join(root, 'nowhere'))).toEqual(nothing)
      /* A manifest with no version a reader can use is a version this gate does
         not have: a number is not one, and neither is a file that is not JSON.
         Carried on as they are, `10` and `undefined` reach `runnerUnlike`, which
         reports them as what the merge base "is". */
      plant(root, {
        'node_modules/@stryker-mutator/core/package.json': '{ "version": 10 }\n',
        'node_modules/@stryker-mutator/vitest-runner/package.json': '{}\n',
        'node_modules/vitest/package.json': 'not json at all\n',
      })

      expect(runnerVersionsAt(root)).toEqual(nothing)
    })
  })

  /* ⚠️ **THE RUNNER PLUGIN IS HALF THE STACK AND WAS NOT ASKED ABOUT** (review,
     2026-09-17). `strykerConfig` names it as the test runner and writes a vitest
     block for it to carry, so a base on another major of it is a base this
     gate's settings say nothing about. */
  it('refuses a base whose Stryker vitest runner is another major version, as it does for vitest itself', () => {
    expect(runnerUnlike(versions, { ...versions, '@stryker-mutator/vitest-runner': '9.4.0' })).toBe(
      'the merge base’s @stryker-mutator/vitest-runner is 9.4.0 and this checkout’s is 10.0.0, and a sweep’s settings are ' +
        'written for one major version',
    )
    expect(runnerUnlike(versions, { ...versions, '@stryker-mutator/vitest-runner': '10.9.9' })).toBe(null)
  })

  it('passes a base on the same major version, and refuses one on another', () => {
    expect(runnerUnlike(versions, { ...versions, vitest: '4.9.0' })).toBe(null)
    expect(runnerUnlike(versions, { ...versions, vitest: '3.2.0' })).toBe(
      'the merge base’s vitest is 3.2.0 and this checkout’s is 4.1.11, and a sweep’s settings are written for one major version',
    )
    expect(runnerUnlike(versions, { ...versions, '@stryker-mutator/core': '9.0.0' })).toBe(
      'the merge base’s @stryker-mutator/core is 9.0.0 and this checkout’s is 10.0.0, and a sweep’s settings are written for one major version',
    )
  })

  it('refuses a version it cannot read rather than taking it for one it knows', () => {
    expect(runnerUnlike(versions, { ...versions, vitest: null })).toBe(
      'the merge base’s vitest is missing and this checkout’s is 4.1.11, and a sweep’s settings are written for one major version',
    )
    /* And missing on THIS side is named as missing too — an install this gate
       cannot read is not a version it may take for the base's. */
    expect(runnerUnlike({ ...versions, vitest: null }, versions)).toBe(
      'the merge base’s vitest is 4.1.11 and this checkout’s is missing, and a sweep’s settings are written for one major version',
    )
    expect(runnerUnlike({ ...versions, vitest: 'next' }, versions)).toBe(
      'the merge base’s vitest is 4.1.11 and this checkout’s is next, and a sweep’s settings are written for one major version',
    )
    /* A major is the whole of the number a version BEGINS with: read as one
       digit, 1 and 12 are the same release; read from anywhere in the string,
       `v4.1.11` is a version this gate would go on to interpret. */
    expect(runnerUnlike({ ...versions, vitest: '1.2.3' }, { ...versions, vitest: '12.0.0' })).toBe(
      'the merge base’s vitest is 12.0.0 and this checkout’s is 1.2.3, and a sweep’s settings are written for one major version',
    )
    expect(runnerUnlike(versions, { ...versions, vitest: 'v4.1.11' })).toBe(
      'the merge base’s vitest is v4.1.11 and this checkout’s is 4.1.11, and a sweep’s settings are written for one major version',
    )
    /* And two versions nobody can read are not the same version: an unknown that
       equals another unknown is how "cannot tell" becomes "the same". */
    expect(runnerUnlike({ ...versions, vitest: 'next' }, { ...versions, vitest: 'next' })).toBe(
      'the merge base’s vitest is next and this checkout’s is next, and a sweep’s settings are written for one major version',
    )
  })

  it('refuses a merge base whose runner is a major version this gate’s settings were not written for', async () => {
    await inScratch('mutants-base-', async (root) => {
      const { at, git } = repository(root)
      plant(root, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n" })
      git('add', '-A')
      git('commit', '-qm', 'head')

      const refusal = await refusedBy(() =>
        measure(root, 'src/a.ts', at, {
          install: (into) => plant(into, { ...RUNNERS, 'node_modules/vitest/package.json': '{ "version": "3.2.0" }\n' }),
        }),
      )

      expect(refusal.reason).toBe('runner')
      expect(refusal.message).toBe(
        'check-mutants: the merge base’s vitest is 3.2.0 and this checkout’s is 4.1.11, and a sweep’s settings are ' +
          'written for one major version — refused rather than interpreted',
      )
      expect(worktreesOf(root)).toEqual([])
    })
  })
})

/**
 * `--measure <path> --into <file>` — the child's own half, which is where the
 * measurement actually happens. It is this gate, so the policy is head's; it
 * runs in the checkout it is started in, so the project is the base's.
 */
describe('what the merge base’s run amounts to', () => {
  /** The survivors a record's own evidence holds, derived as every reader of it derives them. */
  const derived = async (root, record, named = 'src/a.ts') =>
    survivorsAtBase(record, { at: path.join(root, named), named, frozen: record.sha256 })

  /* ⚠️ **A MEASUREMENT CARRIES NO LIST OF SURVIVORS** (review, 2026-09-17). It
     carries the content it swept and Stryker's own reports of sweeping it, and
     every reader works the survivors out of those — which is what makes a shard's
     word worth exactly what its word about its own run is worth. */
  it('carries the content it swept and the report of sweeping it, from which its survivors are read', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: strykerReporting({ survived: [BIG] }).stryker })

      expect(code).toBe(0)
      expect(record.sha256).toBe(A_SHA)
      expect(record.source).toBe(A_SOURCE)
      expect(record.outcome).toBe('survived')
      expect(record.durationMs).toBe(250)
      expect(record.refusal).toBe(null)
      expect(record.settle).toBe(null)
      expect(record.first.exitedCleanly).toBe(false)
      const { survivors } = await derived(root, record)
      expect(survivors.map((one) => [one.file, one.at, one.identity.original, one.identity.scope])).toEqual([
        ['src/a.ts', '1:38', "'big'", ['grade']],
      ])
      /* What a record says it IS, which is the whole of how a parent tells this
         gate's measurement from a file that happens to be JSON at that name. */
      expect(record.kind).toBe('measurement')
      expect(record.version).toBe(1)
      expect(record.subject).toBe('src/a.ts')
    })
  })

  /* A survivor in EITHER run is a survivor — the settle run is a second chance
     for a timeout, never a second chance to call a survivor a kill. */
  it('takes a mutant that survived the settle run, though the first run left it timed out', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      const reporting = strykerReporting({ timedOut: [BIG], exit: false }, { survived: [BIG], exit: false })

      const { record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(reporting.seen).toHaveLength(2)
      const { survivors } = await derived(root, record)
      expect(survivors.map((one) => one.identity.original)).toEqual(["'big'"])
      /* Both runs are what the file cost, because both were run on its account. */
      expect(record.durationMs).toBe(500)
    })
  })

  /**
   * ## A mutant the merge base could not decide, against a merge base that could not be measured
   *
   * ⚠️ **ONE UNDECIDED MUTANT REFUSED THE WHOLE FILE, AND THAT IS THE WRONG
   * GRANULARITY** (measured 2026-09-17, on an isolated runner with real history).
   * Adding one comment to a 1 403-mutant file left 545 mutants unkilled here; the
   * merge base ran fine and left FIVE wall-clock timeouts its settle run met
   * again — and the file-wide refusal made all 540 it had decided perfectly well
   * worthless, so the developer owed every one of them for a comment.
   *
   * The two failures are not the same failure. A failure to MEASURE THE FILE — no
   * report, the wrong content, an install that would not run — refuses the file
   * whole, exactly as it always did. A failure to DECIDE ONE MUTANT leaves that
   * IDENTITY unknown at the merge base, and nothing else.
   *
   * That this is SOUND rests on what load does to a run: it turns survivors into
   * timeouts, never kills into survivals (measured 2026-09-15 — of 140 replayed
   * wall-clock timeouts, 42 came back `Survived`). So a loaded base run reports
   * FEWER survivors than the truth, which authorises less rather than more, and
   * every mutant it did answer for carries its own observation.
   */
  it('names a wall-clock timeout that repeated as a mutant it could not decide, and answers for the survivor beside it', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      const reporting = strykerReporting({ survived: [BIG], timedOut: [0], exit: false }, { survived: [BIG], timedOut: [0], exit: false })

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(code).toBe(0)
      expect(record.refusal).toBe(null)
      expect(record.outcome).toBe('survived')
      const { survivors, undecided } = await derived(root, record)
      /* What it DID decide still answers for what it answers for. */
      expect(survivors.map((one) => one.identity.original)).toEqual(["'big'"])
      expect(undecided.map((one) => [one.file, one.at, one.why])).toEqual([
        ['src/a.ts', '1:22', 'its settle run met the same wall-clock timeout again at 1:22'],
      ])
    })
  })

  /* And the settle run's silence about one mutant is the same kind of hole, at
     the same granularity: a mutant with no score is a mutant nobody measured, and
     nobody measured THAT ONE. */
  it('names a mutant its settle run never answered for as one it could not decide', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      const reporting = strykerReporting({ survived: [BIG], timedOut: [0], exit: false }, { survived: [BIG], errored: [0], exit: false })

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(code).toBe(0)
      const { survivors, undecided } = await derived(root, record)
      expect(survivors.map((one) => one.identity.original)).toEqual(["'big'"])
      expect(undecided.map((one) => [one.at, one.why])).toEqual([['1:22', 'its settle run never answered for the mutant at 1:22']])
    })
  })

  /**
   * ## What the base's FINAL answer for a timeout was
   *
   * ⚠️ **EVERY WALL-CLOCK TIMEOUT WAS READ AND THE FOUR WAYS ONE CAN END WERE NOT
   * TOLD APART** (review, 2026-09-17). A `Timeout` is the one status whose meaning
   * depends on the run rather than on the code, and Stryker writes two different
   * things under that one word: a wall-clock expiry, which load alone causes, and
   * a detection at the ORIGINAL's hit limit, which says the mutated code was still
   * going after a hundred times the original's hit count.
   *
   * Stryker scores both a kill and a sweep HERE keeps that — a mutant that will not
   * stop is not a test a developer owes. As the MERGE BASE's answer a hit limit is
   * a bound the run reached and not a test deciding anything, so a survivor here of
   * that identity is named as one the merge base could not decide rather than as
   * one this change added. It authorises nothing either way: what changes is the
   * sentence, never the verdict.
   */
  it('classes the base’s final answer for a timeout — alive authorises, killed bills, a hit limit is undecided', async () => {
    /* Each row: how the first run ended, how the settle run answered, and what
       the merge base then says about a survivor HERE of that identity. */
    const rows = [
      ['a settle run that found it alive', { timedOut: [BIG], exit: true }, { survived: [BIG], exit: false }, 'authorised'],
      ['a settle run whose tests killed it', { timedOut: [BIG], exit: true }, { exit: true }, 'added'],
      ['no re-run at all, because it was never on the wall clock', { hitLimit: [BIG], exit: true }, null, 'undecided'],
      ['a settle run that reached the original’s hit limit', { timedOut: [BIG], exit: true }, { hitLimit: [BIG], exit: true }, 'undecided'],
    ]

    for (const [ended, ran, settling, expected] of rows) {
      await inScratch('mutants-base-', async (root) => {
        repository(root)
        const plans = settling === null ? [ran] : [ran, settling]

        const { code, record } = await measuring(root, 'src/a.ts', { stryker: strykerReporting(...plans).stryker })
        /* The same mutant, alive HERE — taken from a reference run rather than
           written by hand, so the identity is the instrumenter's own. */
        const reference = await measuring(root, 'src/a.ts', {
          stryker: strykerReporting({ survived: [BIG] }).stryker,
          into: path.join(root, 'reference.json'),
        })
        const [here] = (await derived(root, reference.record)).survivors
        const { survivors, undecided } = await derived(root, record)
        const match = matchedSurvivors(survivors, [here], undecided)
        const said = match.authorised.length === 1 ? 'authorised' : match.added[0].class

        expect(code).toBe(0)
        /* The row is in the assertion so a failure names which of the four it was. */
        expect(`${ended}: ${said}`).toBe(`${ended}: ${expected}`)
      })
    }
  })

  it('names a hit limit as the bound it is, in the merge base’s own voice', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { record } = await measuring(root, 'src/a.ts', {
        stryker: strykerReporting({ timedOut: [0], exit: true }, { hitLimit: [0], exit: true }).stryker,
      })
      const first = await derived(root, record)
      const { record: never } = await measuring(root, 'src/a.ts', { stryker: strykerReporting({ hitLimit: [BIG], exit: true }).stryker })
      const alone = await derived(root, never)

      expect(first.undecided.map((one) => one.why)).toEqual([
        'its settle run answered the wall-clock timeout at 1:22 by reaching the original’s hit limit, which is a bound and not a test',
      ])
      expect(alone.undecided.map((one) => one.why)).toEqual([
        'its run reached the original’s hit limit at 1:38, which is a bound and not a test',
      ])
      /* And neither is a survivor: nothing there authorises anything. */
      expect([first.survivors, alone.survivors]).toEqual([[], []])
    })
  })

  /* A repeat with nothing else alive beside it is the same answer with no
     survivor in it: the file was measured — Stryker scored every other mutant a
     kill — and one identity in it is unknown. */
  it('measures a base whose only hole is a repeated timeout, and leaves that one identity unknown', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts', {
        stryker: strykerReporting({ timedOut: [BIG], exit: true }, { timedOut: [BIG], exit: true }).stryker,
      })

      expect(code).toBe(0)
      expect(record.outcome).toBe('killed')
      const { survivors, undecided } = await derived(root, record)
      expect(survivors).toEqual([])
      expect(undecided.map((one) => [one.at, one.identity.original])).toEqual([['1:38', "'big'"]])
    })
  })

  /**
   * ⚠️ **THE UNION OF TWO RUNS IS CONSERVATIVE FOR HEAD AND BACKWARDS FOR THE
   * BASE** (review, 2026-09-17). A survivor in either run is a survivor, because
   * an observed survivor is never averaged away — and on the base side that turns
   * a flaky KILL into a licence: the mutant enters the authorisation pool through
   * the union, and a survivor here is excused by a base run that said both things.
   *
   * So the mutant the two runs disagree about is taken OUT of the survivors and
   * named as one the merge base could not decide. Conflicting evidence still
   * authorises nothing; what it no longer does is refuse the file around it.
   */
  it('takes the mutant its two runs disagree about out of the survivors, and names it undecided', async () => {
    await inScratch('mutants-base-', async (root) => {
      /* The settle run happens at all because of the timeout at 0; the
         disagreement is about `'big'`, which the first run killed. */
      const reporting = strykerReporting({ timedOut: [0], exit: false }, { survived: [BIG], exit: false })
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(code).toBe(0)
      const { survivors, undecided } = await derived(root, record)
      expect(survivors).toEqual([])
      expect(undecided.map((one) => [one.at, one.why])).toEqual([
        ['1:38', 'its two runs answered for the mutant at 1:38 with Killed and then with Survived'],
      ])
    })
  })

  it('refuses a base run that scored nothing, rather than reading its silence as a survivor that was already there', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record, stderr } = await measuring(root, 'src/a.ts', {
        stryker: async (config) => {
          await writeFile(path.join(path.dirname(config), REPORT), JSON.stringify({ files: {} }))
          return true
        },
      })

      expect(code).toBe(2)
      expect(record.refusal).toEqual({
        reason: 'did-not-run',
        message:
          'check-mutants: the merge base’s run of src/a.ts scored nothing (did-not-run): it wrote a report of 0 file(s), ' +
          'and this gate sweeps one at a time. A run that could not measure is not a survivor that was already there',
      })
      expect(stderr).toBe(`${record.refusal.message}\n`)
    })
  })

  /* ⚠️ **AND A RUN THAT DID NOT EXIT CLEANLY IS A FILE-LEVEL REFUSAL STILL**, so
     the split above narrows nothing here: a Stryker that fell over scored nothing,
     whatever its report holds, and a measurement nobody can believe authorises no
     mutant of that file rather than all but one of them. */
  it('refuses a base run that did not exit cleanly, however complete the report beside it', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: strykerReporting({ exit: false }).stryker })

      expect(code).toBe(2)
      expect(record.refusal.reason).toBe('did-not-run')
      expect(record.refusal.message).toBe(
        'check-mutants: the merge base’s run of src/a.ts scored nothing (did-not-run): it did not exit cleanly, and ' +
          'nothing in its report is a survivor or a kill. A run that could not measure is not a survivor that was ' +
          'already there',
      )
    })
  })

  /**
   * ⚠️ **AND THE TWO CASES ABOVE WROTE THE SAME SENTENCE UNTIL 2026-09-17** —
   * byte for byte, though one is a Stryker that reported on no file and the other
   * a Stryker that fell over holding a complete one. This is the third of them,
   * and the one that matters: a Stryker that DIED, leaving no report at all.
   *
   * ⚠️ **AND A SWEEP'S STDOUT IS NOT AN ANSWER HERE.** A plain sweep can afford a
   * bare `did-not-run`, because Stryker's own error is a line above it on the
   * terminal. A measurement at the merge base cannot: this refusal is a VALUE, and
   * it travels into the record the child writes, into the evidence a result
   * carries, and into an aggregate reading that result in another job on another
   * machine, with no stdout of that run anywhere. The acceptance run of
   * 2026-09-17 is what this is for — a base measurement that came back
   * `did-not-run` in seconds, over a log that could not say whether Stryker had
   * died, been handed the wrong file, or never started.
   */
  it('names WHICH reading of the run made it a no-score, so a base that died is not a base that reported on nothing', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      /* No report at all, which is what a Stryker that dies before it finishes
         leaves — `strykerRun` answers `false` for it and says nothing else. */
      const { code, record } = await measuring(root, 'src/a.ts', { stryker: async () => false })

      expect(code).toBe(2)
      expect(record.refusal.reason).toBe('did-not-run')
      expect(record.refusal.message).toBe(
        'check-mutants: the merge base’s run of src/a.ts scored nothing (did-not-run): it wrote no report at all. ' +
          'A run that could not measure is not a survivor that was already there',
      )
    })
  })

  /* The SETTLE run is what decides where there is one — `settledVerdict`'s own
     rule — so it is the run the refusal describes, and it says which run it is
     describing rather than leaving a reader to work that out. */
  it('names the settle run as the run that scored nothing, where a settle run is what decided', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      /* A timeout in the first run is what buys a settle run at all; the settle
         run then dies without writing anything. */
      const first = strykerReporting({ timedOut: [BIG], exit: true }).stryker
      let runs = 0

      const { code, record } = await measuring(root, 'src/a.ts', {
        stryker: async (config, at) => (runs++ === 0 ? first(config, at) : false),
      })

      expect(code).toBe(2)
      expect(runs).toBe(2)
      expect(record.refusal.message).toBe(
        'check-mutants: the merge base’s run of src/a.ts scored nothing (did-not-run): its settle run wrote no report ' +
          'at all. A run that could not measure is not a survivor that was already there',
      )
    })
  })

  /**
   * ⚠️ **AND A SURVIVOR IN THE FIRST RUN HID EVERY FAILURE OF THE SETTLE RUN**
   * (review, 2026-09-17). A survivor outranks every other outcome, so `measured`
   * is `survived` whatever the second run did — and with no presence check of its
   * own, a settle report that was `null`, `{files:{}}` or about another file was
   * ACCEPTED: the survivor was authorised and the wall-clock timeout beside it was
   * named as one mutant the merge base could not decide.
   *
   * It is not one mutant. Nothing measured the settle run at all, which is a
   * failure to measure THE FILE and refuses it whole — exactly as the same three
   * shapes do in the FIRST run, whose own presence check has been there since the
   * review before this one.
   */
  it('refuses a base whose settle run measured nothing, though a survivor in the first run made the file look measured', async () => {
    const wrote = (files) => async (config) => {
      await writeFile(path.join(path.dirname(config), REPORT), JSON.stringify({ files }))
      return true
    }
    /* Each shape of silence, and the words `noScoreOf` gives it — a refusal that
       travels as a value has to say which of the seven it was. */
    const shapes = [
      () => [async () => false, 'wrote no report at all'],
      () => [wrote({}), 'wrote a report of 0 file(s), and this gate sweeps one at a time'],
      (root) => {
        const other = path.join(root, 'src/elsewhere.ts')
        return [wrote({ [other]: { source: '', mutants: [] } }), `wrote a report of ${other}, and this gate swept ${path.join(root, 'src/a.ts')}`]
      },
    ]

    for (const shapeOf of shapes) {
      await inScratch('mutants-base-', async (root) => {
        repository(root)
        /* A survivor AND a wall-clock timeout: the survivor is what made the file
           read as measured, and the timeout is what bought a settle run at all. */
        const first = strykerReporting({ survived: [BIG], timedOut: [0], exit: false }).stryker
        const [settling, words] = shapeOf(root)
        let runs = 0

        const { code, record } = await measuring(root, 'src/a.ts', {
          stryker: async (config, at) => (runs++ === 0 ? first(config, at) : settling(config, at)),
        })

        expect(runs).toBe(2)
        expect(code).toBe(2)
        expect(record.refusal).toEqual({
          reason: 'did-not-run',
          message:
            `check-mutants: the merge base’s run of src/a.ts says survived over a settle run that measured nothing: it ` +
            `${words}. A run that could not measure is not a survivor that was already there`,
        })
      })
    }
  })

  it('refuses a report that is not of what the base holds, exactly as a sweep here does', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts', {
        stryker: async (config) => {
          const [subject] = JSON.parse(await readFile(config, 'utf8')).mutate
          const files = { [subject]: { source: 'export const grade = 1\n', mutants: [] } }
          await writeFile(path.join(path.dirname(config), REPORT), JSON.stringify({ files }))
          return true
        },
      })

      expect(code).toBe(2)
      expect(record.refusal.reason).toBe('mismatched')
      expect(record.refusal.message).toMatch(/^check-mutants: the merge base’s run of src\/a\.ts did not report on what it swept — /u)
      /* WHOSE run is being described, which is what tells this apart from the
         same refusal about a sweep in this checkout. */
      expect(record.refusal.message).toMatch(/is not the content the merge base hashed$/u)
    })
  })

  /* The instrumenter is what says how many mutants a file holds, and a file it
     cannot read is a file this gate cannot count — which is not a file that owed
     nothing. It is a plain refusal rather than one of the named ones, and it is
     carried to the sweep that asked exactly the same way. */
  it('refuses a base file Stryker cannot count the mutants in', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root, { 'src/a.ts': 'export const grade = ((\n' })

      const { code, record } = await measuring(root, 'src/a.ts')

      expect(code).toBe(2)
      expect(record.refusal.reason).toBe('refused')
      expect(record.refusal.message).toMatch(/cannot count the mutants in .+ so what it owed at the merge base is unknown — /u)
    })
  })

  /**
   * ⚠️ **"NO TEST REACHES IT, SO EVERY MUTANT SURVIVED" WAS AN ANSWER UNTIL
   * 2026-09-17, AND IT IS WHAT A DISCOVERY FAILURE SAYS TOO** (review). A base
   * test written `const p = './a'; await import(p)` kills mutants in `a.ts` and is
   * in no import graph — so deleting it and leaving a weak discoverable one made
   * the survivors it had been killing read as debt the merge base already had.
   * Walking every level of the import graph does not make the graph complete.
   *
   * ⚠️ **AND IT FIRED ONLY WHERE DISCOVERY FOUND NOTHING, WHICH ONE WEAK TEST WAS
   * ENOUGH TO SUPPRESS** (review, 2026-09-17). The fixture here is that pair: a
   * `weak.test.ts` that imports `./a` and asserts nothing, beside a computed-import
   * test that is the only thing killing anything. Discovery finds the weak one, so
   * the old rule measured the merge base WITHOUT the strong one — and a change that
   * deleted the strong test read as debt the base already had.
   *
   * So the merge base is OFFERED every test it has, always, and discovery decides
   * nothing there — which is what this asserts, through the config Stryker is
   * handed. What Stryker then RUNS is narrower: Vitest's `related` filter drops a
   * test that reaches the subject only through a computed import, so against a
   * real Stryker the strong test here would not run. See `measuredHere`.
   */
  it('measures a base against every test it has, though discovery found a weak one beside the computed import', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root, {
        /* Reaches `src/a.ts` and says so to nobody: a specifier through a
           variable is a path no import graph holds. */
        'src/a.test.ts': "const where = './a'\nconst { grade } = await import(where)\nit('grades', () => grade(2))\n",
        /* And the one discovery DOES find, which asserts nothing — the whole of
           what used to suppress the wider run. */
        'src/weak.test.ts': "import { grade } from './a'\nit('names it', () => typeof grade)\n",
      })
      const reporting = strykerReporting({ survived: [BIG] })

      const { code, record, stdout } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(code).toBe(0)
      expect(record.outcome).toBe('survived')
      /* It RAN, and it ran against BOTH — the one nothing could trace to it and
         the one that would have stood in for it. */
      expect(reporting.seen).toHaveLength(1)
      expect(reporting.seen[0].against).toContain(asGlob(path.join(root, 'src/a.test.ts')))
      expect(reporting.seen[0].against).toContain(asGlob(path.join(root, 'src/weak.test.ts')))
      /* And nothing is claimed about HOW they reach it: they are run because
         discovery could not prove they do not, which is a different sentence. */
      expect(stdout).toContain(`  [1/1] ${path.join(root, 'src/a.ts')}\n`)
    })
  })

  /* And where every test there is was offered and none can be run against it,
     the answer is a refusal: a base nothing was run against is not a base where
     everything survived, which is the whole of the defect above. */
  it('refuses a merge base with no test it can run against the subject at all', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root, {}, ['src/a.test.ts'])
      const reporting = strykerReporting()

      const { code, record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(code).toBe(2)
      expect(record.refusal.reason).toBe('untested-base')
      expect(record.refusal.message).toBe(
        'check-mutants: the merge base has no test this gate can run against src/a.ts — every test in it was offered and ' +
          'none remains, so what it owed there cannot be measured, and a base nothing was run against is not a base where ' +
          'everything survived',
      )
      expect(reporting.seen).toEqual([])
    })
  })

  it('answers no survivor for a base file Stryker makes no mutant in, without running anything', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root, { 'src/a.ts': "export { grade } from './b'\n", 'src/b.ts': 'export const grade = 1\n' })
      const reporting = strykerReporting()

      const { record } = await measuring(root, 'src/a.ts', { stryker: reporting.stryker })

      expect(record.outcome).toBe('no-mutants')
      expect(record.first).toBe(null)
      expect(reporting.seen).toEqual([])
    })
  })

  /* ⚠️ **A DEFECT IS NOT A REFUSAL, AND MUST NOT BE WRITTEN DOWN AS ONE.** A
     record is what the sweep that asked reads; one carrying a bug's message
     under a refusal's name would turn a broken gate into an ordinary "could not
     measure", which is a thing CI is expected to meet. It propagates instead,
     and the absence of a record is what the parent reports. */
  it('writes no measurement at all when something that is not a refusal goes wrong', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)
      const into = path.join(root, 'measured.json')

      const broke = await refusedBy(() =>
        measuring(root, 'src/a.ts', {
          into,
          stryker: () => {
            throw new Error('Stryker fell over')
          },
        }),
      )

      expect(broke.message).toBe('Stryker fell over')
      expect(existsSync(into)).toBe(false)
    })
  })

  /* The checkout's own lock is held by the sweep that asked for this
     measurement. A base worktree is that process's own, under a name nothing
     else can know, so there is nothing there for a lock to protect — and taking
     one would refuse this gate to itself. */
  it('takes no lock, discovers no changed file and asks git nothing', async () => {
    await inScratch('mutants-base-', async (root) => {
      repository(root)

      const { code, record } = await measuring(root, 'src/a.ts')

      expect(code).toBe(0)
      expect(record.outcome).toBe('killed')
    })
  })

  /**
   * ⚠️ **`--measure src/a.ts --into src/a.ts` PARSED, MEASURED, AND THEN WROTE
   * JSON OVER THE SOURCE** (review, 2026-09-17). Nothing inside this gate can
   * spell that — a sweep always names a file in a scratch directory of its own —
   * but the mode is on the command line, and what a hand can type it must refuse.
   *
   * Both spellings of the output are compared, as `overlapOf` compares a shard's,
   * so neither a link planted at the output's own name nor a link among the
   * directories above it reaches the subject by another route. It is refused OUT
   * of the measurement rather than recorded in it, because a record written at
   * that name is the very write being refused.
   */
  it('refuses to write its record over the file it was told to measure, however the output is spelt', async () => {
    await inScratch('mutants-measure-', async (root) => {
      repository(root)
      symlinkSync(path.join(root, 'src/a.ts'), path.join(root, 'link.json'))
      symlinkSync(path.join(root, 'src'), path.join(root, 'through'))

      for (const into of ['src/a.ts', 'link.json', 'through/a.ts']) {
        const said = { stdout: '', stderr: '' }

        const code = await run(['--measure', 'src/a.ts', '--into', path.join(root, into)], {
          root,
          stdout: { write: (text) => void (said.stdout += text) },
          stderr: { write: (text) => void (said.stderr += text) },
        })

        expect(code, into).toBe(2)
        expect(said.stderr, into).toBe(
          `check-mutants: --into ${path.join(root, into)} is the file --measure src/a.ts reads, and a record written ` +
            'there replaces the very file this was to measure — name one outside the checkout, as a sweep does\n',
        )
        expect(readFileSync(path.join(root, 'src/a.ts'), 'utf8'), into).toBe(PROJECT['src/a.ts'])
      }
    })
  })

  /**
   * ⚠️ **A TRACKED SYMBOLIC LINK IS A PATH GIT HAS AND CONTENT IT DOES NOT**
   * (review, 2026-09-17). `cat-file -e <commit>:<path>` proves the merge base has
   * an entry at the name, and every read after it follows the link to whatever
   * the machine running this happens to have there — so a link committed at a
   * subject's name hands the measurement a stranger's file. In the branch where
   * no test reaches the subject that is the worst of it: every mutant of that
   * stranger's file becomes an authorisation, with Stryker never run.
   */
  it('refuses a subject reached outside the checkout, rather than measuring whatever a link points at', async () => {
    await inScratch('mutants-measure-', async (root) => {
      await inScratch('mutants-elsewhere-', async (elsewhere) => {
        plant(elsewhere, { 'b.ts': "export const grade = (n) => (n > 1 ? 'big' : 'small')\n" })
        repository(root)
        rmSync(path.join(root, 'src/a.ts'))
        symlinkSync(path.join(elsewhere, 'b.ts'), path.join(root, 'src/a.ts'))

        const measured = await measuring(root, 'src/a.ts')

        expect(measured.code).toBe(2)
        expect(measured.record.refusal.reason).toBe('outside')
        expect(measured.record.refusal.message).toBe(
          `check-mutants: src/a.ts is reached at ${realpathSync.native(path.join(elsewhere, 'b.ts'))}, which is outside ` +
            `the checkout at ${realpathSync.native(root)} — what the merge base owes is measured in the merge base’s own ` +
            'content, never in whatever a link points at here',
        )
      })
    })
  })
})

/**
 * ⚠️ **DISCOVERY DECIDED THIS UNTIL 2026-09-17, AND ITS ANSWER WAS TAKEN AS
 * EVIDENCE OF ITS OWN COMPLETENESS** (review). The rule was "every test that
 * reaches the subject by any chain of imports, and every test there is where that
 * found none" — so ONE weak discoverable test suppressed the wide run, and a base
 * with a computed-import test beside it was measured without it.
 *
 * The condition is gone rather than tightened. What it would have to establish is
 * that the import graph is COMPLETE, and this gate follows relative specifiers and
 * nothing else: an alias, a bare specifier resolving back into the checkout, a
 * plugin's own resolution and a computed path are each invisible to it. "At least
 * one test was found" was never evidence of that.
 */
describe('which tests the merge base is measured against', () => {
  it('takes every test the merge base has, and says nothing carried the subject to them', () => {
    const tests = ['/near.test.ts', '/far.test.ts', '/nothing-to-do-with-it.test.ts']

    expect(reachingAtBase('/s.ts', tests)).toEqual({ tests, through: [] })
  })
})

describe('the base file a subject’s survivors may answer to', () => {
  it('names the subject itself where the merge base has it', async () => {
    await inScratch('mutants-origin-', (root) => {
      const { at } = repository(root)

      expect(originAtBase('src/a.ts', at, root, new Map())).toEqual({ path: 'src/a.ts', how: 'itself', sha256: A_SHA })
    })
  })

  it('names the file a renamed one was renamed from', async () => {
    await inScratch('mutants-origin-', (root) => {
      const { at, git } = repository(root)
      git('mv', 'src/a.ts', 'src/renamed.ts')
      git('commit', '-qam', 'head')

      const renames = renamesAtBase(at, root)

      expect(originAtBase('src/renamed.ts', at, root, renames)).toEqual({ path: 'src/a.ts', how: 'renamed', sha256: A_SHA })
      /* Whole, because what else it might hold is the question: a file that was
         merely changed has no origin to name, and naming one under no key at all
         is a record nobody can find and nobody can refuse. */
      expect(renames).toEqual(new Map([['src/renamed.ts', { path: 'src/a.ts', how: 'renamed' }]]))
    })
  })

  /* ⚠️ **A COPY'S SOURCE NEED NOT HAVE CHANGED**, and git only looks at
     unchanged files for one when it is told to look harder. Without that, a
     function copied out of a module nobody touched is traced to nothing. */
  it('names the file a copy was taken from, though that file did not change', async () => {
    await inScratch('mutants-origin-', (root) => {
      const parts = Array.from({ length: 40 }, (_, at) => `export function helper${at}(n) {\n  return n + ${at}\n}\n`)
      const { at, git } = repository(root, { 'src/session.ts': parts.join('\n') })
      plant(root, { 'src/sessionCopy.ts': parts.slice(0, 20).join('\n') })
      git('add', '-A')
      git('commit', '-qm', 'head')

      expect(originAtBase('src/sessionCopy.ts', at, root, renamesAtBase(at, root))).toEqual({
        path: 'src/session.ts',
        how: 'copied',
        sha256: digestOf(parts.join('\n')),
      })
    })
  })

  /* ⚠️ **AN EXTRACTION IS A COPY, AND ITS SIMILARITY IS SCORED AGAINST THE
     LARGER FILE** — so pulling a fifth of a module into a file of its own scores
     about a fifth, and git's own default of 50 % would name no origin for the
     refactor this exists to make affordable. */
  it('names the file an extraction was taken out of', async () => {
    await inScratch('mutants-origin-', (root) => {
      const parts = Array.from({ length: 40 }, (_, at) => `export function helper${at}(n) {\n  return n + ${at}\n}\n`)
      const { at, git } = repository(root, { 'src/session.ts': parts.join('\n') })
      plant(root, { 'src/session.ts': parts.slice(10).join('\n'), 'src/sessionHelpers.ts': parts.slice(0, 10).join('\n') })
      git('add', '-A')
      git('commit', '-qm', 'head')

      const renames = renamesAtBase(at, root)

      expect(originAtBase('src/sessionHelpers.ts', at, root, renames)).toEqual({
        path: 'src/session.ts',
        how: 'copied',
        sha256: digestOf(parts.join('\n')),
      })
      /* Whole, and this diff also holds the file the extraction came OUT of —
         which git names as changed and traces to nothing. A record that names one
         path must leave no trace at all, rather than one filed under no name:
         that entry is one nothing can look up, and so one nothing can refuse. */
      expect(renames).toEqual(new Map([['src/sessionHelpers.ts', { path: 'src/session.ts', how: 'copied' }]]))
    })
  })

  it('names nothing for a file the merge base has no origin for, which is a new file', async () => {
    await inScratch('mutants-origin-', (root) => {
      const { at, git } = repository(root)
      plant(root, { 'src/fresh.ts': 'export const fresh = (n) => n * 3\n' })
      git('add', '-A')
      git('commit', '-qm', 'head')

      expect(originAtBase('src/fresh.ts', at, root, renamesAtBase(at, root))).toBe(null)
    })
  })

  /* A file git cannot see is a file git cannot trace: an untracked one is in no
     diff, so a local sweep's new file owes what a new file owes until it is
     committed. Named here rather than discovered later. */
  it('names nothing for a file that is not committed, whatever it was copied from', async () => {
    await inScratch('mutants-origin-', (root) => {
      const parts = Array.from({ length: 40 }, (_, at) => `export function helper${at}(n) {\n  return n + ${at}\n}\n`)
      const { at } = repository(root, { 'src/session.ts': parts.join('\n') })
      plant(root, { 'src/sessionHelpers.ts': parts.slice(0, 10).join('\n') })

      expect(originAtBase('src/sessionHelpers.ts', at, root, renamesAtBase(at, root))).toBe(null)
    })
  })

  /* One question, asked of git once, for every subject a sweep or a plan holds:
     the rename detection is a whole-repository diff with no limit, and asking it
     per subject would pay for that as many times as there are subjects. */
  it('answers for a whole list of subjects at once, each by what the merge base has for it', async () => {
    await inScratch('mutants-origin-', (root) => {
      const { at, git } = repository(root)
      git('mv', 'src/a.ts', 'src/renamed.ts')
      plant(root, { 'src/fresh.ts': 'export const fresh = (n) => n * 3\n' })
      git('add', '-A')
      git('commit', '-qm', 'head')

      expect(originsAtBase(['src/renamed.ts', 'src/fresh.ts', 'src/a.test.ts'], at, root)).toEqual(
        new Map([
          ['src/renamed.ts', { path: 'src/a.ts', how: 'renamed', sha256: A_SHA }],
          ['src/fresh.ts', null],
          ['src/a.test.ts', { path: 'src/a.test.ts', how: 'itself', sha256: digestOf(PROJECT['src/a.test.ts']) }],
        ]),
      )
    })
  })

  /* ⚠️ **NO MERGE BASE IS NO ORIGIN FOR ANYTHING, AND GIT IS NOT ASKED AT ALL.**
     There is nothing to diff against, so every subject is one nothing can answer
     for — which is the same fail-closed answer a new file gets, and is what a
     local run with no base has always done. */
  it('answers nothing for every subject where there is no merge base, without asking git', async () => {
    await inScratch('mutants-origin-', (root) => {
      /* Not a repository at all, so any git question would throw rather than
         answer — which is what makes this a measurement and not a guess. */
      expect(originsAtBase(['src/a.ts', 'src/b.ts'], null, root)).toEqual(
        new Map([
          ['src/a.ts', null],
          ['src/b.ts', null],
        ]),
      )
    })
  })

  it('names nothing where what git traced it to is not a file a sweep could mutate', async () => {
    await inScratch('mutants-origin-', (root) => {
      const { at, git } = repository(root, { 'notes.md': 'a'.repeat(400) })
      git('mv', 'notes.md', 'src/notes.ts')
      git('commit', '-qam', 'head')

      expect(renamesAtBase(at, root).get('src/notes.ts')).toEqual({ path: 'notes.md', how: 'renamed' })
      expect(originAtBase('src/notes.ts', at, root, renamesAtBase(at, root))).toBe(null)
    })
  })
})

describe('the survivors a run leaves', () => {
  const mutantAt = (line, status) => ({ status, mutatorName: 'StringLiteral', replacement: '""', location: { start: { line, column: 1 }, end: { line, column: 4 } } })

  it('takes a mutant no test objected to, and one no test reached', () => {
    const entry = { mutants: [mutantAt(1, 'Killed'), mutantAt(2, 'Survived'), mutantAt(3, 'NoCoverage'), mutantAt(4, 'Timeout')] }

    expect(survivorsIn([entry]).map((one) => one.location.start.line)).toEqual([2, 3])
  })

  it('takes a survivor from either run, and counts one that survived both once', () => {
    const first = { mutants: [mutantAt(1, 'Survived'), mutantAt(2, 'Timeout')] }
    const settle = { mutants: [mutantAt(1, 'Survived'), mutantAt(2, 'Survived')] }

    expect(survivorsIn([first, settle]).map((one) => one.location.start.line)).toEqual([1, 2])
  })

  it('reads a run that reported on nothing as having left no survivor', () => {
    expect(survivorsIn([null, { mutants: [mutantAt(1, 'Survived')] }])).toEqual([mutantAt(1, 'Survived')])
  })
})

/* ⚠️ **THE GATE LEAVES A COVERING TEST THAT READS ITS SUBJECT'S SOURCE OUT OF
   THE RUN**, and `pathsRead` follows a name across a whole FILE rather than one
   scope. So a path bound to a name here that also reaches a read would leave the
   gate out of its own sweep — silently, and looking exactly like a pass. */
describe('this file is no reader of the gate’s own source', () => {
  const readersOf = (...args) => [...sourceReaders(...args).keys()]

  it('does not take this file for a test that reads what it covers', () => {
    const mine = 'scripts/check-mutants.base.test.mjs'

    expect(readersOf(['scripts/check-mutants.mjs'], [mine], () => [mine])).toEqual([])
  })
})

/**
 * The nearest `node_modules` at or above `from`, which is the one Node resolves
 * this file's own imports through — SEARCHED, never assumed at a fixed depth.
 *
 * ⚠️ **`../node_modules` FROM THIS FILE MADE THE GATE UNMEASURABLE AT ITS OWN
 * MERGE BASE** (found 2026-09-18, by a real sweep). Stryker links no install into
 * the sandbox of a base worktree, whose own `node_modules` is a link, so from
 * inside that sandbox the fixed depth named nothing: the real-Stryker case died
 * with "@stryker-mutator/core is missing", the base's dry run failed, and every
 * survivor in `check-mutants.mjs` was billed, however old. The same fix
 * `check-mutants.sharding.test.mjs` and `check-mutants.discovery.test.mjs` made
 * for their `checkout()`.
 */
function installAbove(from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.join(dir, 'node_modules')
    if (existsSync(at)) return at
    if (path.dirname(dir) === dir) throw new Error(`no node_modules at or above ${from}`)
  }
}
