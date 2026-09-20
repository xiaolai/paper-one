import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  REPORT,
  assignShards,
  byName,
  carriedTestOptions,
  loadTestConfig,
  loadViteTestBlock,
  measureAtBase,
  outcomeOf,
  resultFileFor,
  run,
  settledVerdict,
  sourceReaders,
  strykerConfig,
  symlinksIn,
  vitestConfigFor,
} from './check-mutants.mjs'

/**
 * The sharded half of the gate — `--plan`, `--shard` and `--aggregate`, the
 * drift checks they refuse on, the records they write and read, and the settle
 * run's verdict as the aggregate derives it again.
 *
 * ⚠️ **APART FROM `check-mutants.test.mjs` BECAUSE THAT FILE IS THE GATE'S OWN
 * READER.** It names `scripts/check-mutants.mjs` where it asserts it is no
 * reader of it, and `pathsRead` follows a name across a whole file — so a
 * parameter here that took a value from there would leave the gate out of its
 * own sweep. Nothing in this file reads the gate's source, and the last case in
 * it says so rather than trusting that it stays true.
 */

/** A scratch directory, removed after `act` whatever `act` does, and again when the case finishes. */
function inScratch(prefix, act) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  const remove = () => rmSync(root, { recursive: true, force: true })
  onTestFinished(remove)
  const result = act(root)
  return typeof result?.then === 'function' ? result.finally(remove) : result
}

/** Writes each `name → contents` under `root`, in the order given, and answers each one's absolute path. */
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

/** What a record a shard wrote holds. */
const readJson = async (recordAt) => JSON.parse(await readFile(recordAt, 'utf8'))

/** `text`'s SHA-256, as the gate digests a file's bytes. */
const digestOf = (text) => createHash('sha256').update(text).digest('hex')

/** What a stood-in git answers for the commits a checkout is at. */
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const commitsAt =
  (head = HEAD, mergeBase = BASE) =>
  () => ({ head, mergeBase })

/** A checkout of its own for `run` to sweep: a project shaped like this repository's, with `files` beside it. */
function checkout(root, files = {}) {
  /* ⚠️ **WHERE THE INSTALL IS MUST BE FOUND, NOT ASSUMED — AND TWO WRONG
     ASSUMPTIONS ABOUT IT EACH LOOKED RIGHT** (2026-09-17, both reproduced).

     It was the bare name `node_modules` handed to `path.resolve`, which resolves
     such a name against `process.cwd()`. From the repository that is the repository's install; from
     anywhere else it is a path that does not exist, and the link dangles. That
     is why a base measurement of a module the GATE imports — `lib/entry.mjs`,
     `lib/specifiers.mjs` — could never be made: it sweeps this very file inside
     a Stryker sandbox whose cwd is not the repository, so every case that loads
     the generated config died with `Cannot find package 'vitest' imported from
     <scratch>/vitest.mutants.mjs.timestamp-*.mjs`, and the measurement refused.

     ⚠️ **AND `../node_modules` FROM THIS FILE IS NOT THE ANSWER EITHER.**
     Measured inside a live sandbox rather than assumed: Stryker does NOT link
     an install into its sandbox when the project's `node_modules` is itself a
     symbolic link, which is exactly what a base worktree has. The sandbox has
     none at all, and ordinary imports resolve only because Node walks UP to the
     worktree's. A fixed relative depth therefore points at nothing.

     So it is SEARCHED for, upwards, which is what Node itself does — and the
     first one that exists is the one every other import in this process already
     resolved through. `fileURLToPath`, never `.pathname`: see AGENTS.md. */
  symlinkSync(installAbove(fileURLToPath(new URL('.', import.meta.url))), path.join(root, 'node_modules'))
  return plant(root, {
    'vitest.config.ts': "export default { test: {\n  passWithNoTests: true,\n  testTimeout: 15000,\n} }\n",
    'vite.config.ts': "export default { plugins: [{ name: 'planted' }] }\n",
    ...files,
  })
}

/** A clock that moves on 250 ms each time it is read. */
function ticking() {
  let now = 0
  return () => (now += 250)
}

/** `run` over `root`, with git, the lock and Stryker replaced and both streams captured. */
async function sweep(root, { argv = [], subjects = [], tree = [], ...options } = {}) {
  const said = { stdout: '', stderr: '' }
  const locks = { taken: 0, released: 0 }
  const code = await run(argv, {
    root,
    stdout: { write: (text) => void (said.stdout += text) },
    stderr: { write: (text) => void (said.stderr += text) },
    changed: () => subjects,
    files: () => tree,
    lock: () => {
      locks.taken += 1
      return () => void (locks.released += 1)
    },
    stryker: () => {
      throw new Error('no subject here should have reached Stryker')
    },
    commits: () => {
      throw new Error('no plain sweep asks git which commits it is at')
    },
    worktree: () => ({}),
    tracked: () => [],
    /* Neither question is asked of a real git here: a plan freezes where the
       base is and what each subject came from, and these checkouts are scratch
       directories with no history to trace through. A case that needs an origin
       gives one. */
    mergeBase: () => null,
    origins: (names) => new Map(names.map((name) => [name, null])),
    measure: () => {
      throw new Error('no sweep here should have measured a merge base')
    },
    clock: ticking(),
    ...options,
  })
  return { code, ...said, locks }
}

/** Stands in for Stryker: writes the report it is told to for each subject, and answers its exit. */
function strykerSaying(root, { reports = {}, exits = {}, settled = {}, settleExits = {} } = {}) {
  const seen = []
  const stryker = async (config) => {
    const settings = JSON.parse(await readFile(config, 'utf8'))
    const [subject] = settings.mutate
    const settling = settings.timeoutFactor !== undefined
    seen.push({ subject, settling })
    const answer = (settling ? settled : reports)[subject]
    if (answer !== undefined) writeFileSync(path.join(root, REPORT), JSON.stringify(answer))
    return (settling ? settleExits : exits)[subject] ?? true
  }
  return { stryker, seen }
}

/**
 * A checkout of three changed files, one of each class a plan gives: `a.ts`,
 * which a test imports; `n.ts`, with a mutant and no test; and `z.ts`, with
 * neither a mutant nor a test.
 */
const A_SOURCE = "export const a = 'a'\n"
function threeKinds(root) {
  return checkout(root, {
    'src/a.ts': A_SOURCE,
    'src/a.test.mjs': "import './a'\n",
    'src/n.ts': "export const n = 'n'\n",
    'src/z.ts': 'export const z = 1\n',
  })
}
const THREE = ['src/a.ts', 'src/n.ts', 'src/z.ts']
const THREE_TREE = ['src/a.ts', 'src/a.test.mjs', 'src/n.ts', 'src/z.ts']

/** Plans `subjects` of the checkout at `root`, and answers the manifest's path. */
async function planOver(root, { subjects = THREE, shards = 1, isolate = 0, ...options } = {}) {
  const manifest = path.join(root, 'plan.json')
  const result = await sweep(root, {
    argv: ['--plan', manifest, '--shards', String(shards), '--isolate', String(isolate)],
    subjects,
    tree: THREE_TREE,
    commits: commitsAt(),
    ...options,
  })
  expect(result.code, result.stderr).toBe(0)
  return { manifest, stdout: result.stdout }
}

/** Shard `spec` of the plan at `manifest`, into `results`. */
function shardOf(root, manifest, spec, { subjects = THREE, results = path.join(root, 'results'), ...options } = {}) {
  return sweep(root, {
    argv: ['--shard', spec, '--manifest', manifest, '--results', results],
    subjects,
    tree: THREE_TREE,
    commits: commitsAt(),
    ...options,
  })
}

/** The aggregate over `results`, with git and the tree refusing to be asked. */
function aggregateOf(root, manifest, results = path.join(root, 'results')) {
  const refused = (what) => () => {
    throw new Error(`the aggregate ${what}`)
  }
  return sweep(root, {
    argv: ['--aggregate', '--manifest', manifest, '--results', results],
    changed: refused('asked git what changed'),
    commits: refused('asked git for commits'),
    files: refused('listed the tree'),
  })
}

const resultIn = (results, shard, subject) => path.join(results, `shard-${shard}`, resultFileFor(subject))
const receiptIn = (results, shard) => path.join(results, `shard-${shard}`, 'receipt.json')

const ESTIMATE =
  "  Mutant counts are an estimate of what a shard costs, not a measure of it: one mutant cost about fifteen times as much in one measured file as in another. Every result records the file's measured duration.\n"
const reconcileFails = (manifest) =>
  `check-mutants: the shards do not account for every file in ${manifest} exactly once, so the sweep is not complete:\n`
const reconciled = (manifest, shards) =>
  `check-mutants: every file in ${manifest} has exactly one result, from ${shards} shard(s) that each finished\n`

/* ─── what a plan and its records are made of, fabricated by hand ─────────────
   The aggregate reads no file of the checkout: it hashes the source a report
   carries against the content the plan recorded. So a plan, its results and its
   receipts can be written out whole, which is what these cases do — no plan run,
   no shard run, no Vite and no Stryker. */

/** Where a one-quote string literal's mutant sits in `A_SOURCE`, and what it is. */
const IDENTITY = { mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 1, column: 18 }, end: { line: 1, column: 21 } } }
const PLACE = '1:18'
const A_SHA = digestOf(A_SOURCE)
const SOME_DIGEST = digestOf('some tests')

/**
 * One planned subject — mutated, of one mutant, on shard 1, its own file at the
 * merge base — with whatever `fields` change.
 */
const subjectOf = (fields = {}) => {
  const planned = {
    path: 'src/a.ts',
    sha256: A_SHA,
    class: 'mutated',
    mutants: 1,
    identities: [IDENTITY],
    shard: 1,
    tests: ['src/a.test.mjs'],
    testsDigest: SOME_DIGEST,
    leftOut: [],
    through: [],
    ...fields,
  }
  /* After the spread, and from the subject's own path, so that a case changing
     the path does not silently leave an origin naming another file — which a
     plan this gate wrote never holds. Asked by KEY rather than by value, because
     `null` is the answer for a new file and is one a case gives on purpose. */
  return { ...planned, origin: Object.hasOwn(fields, 'origin') ? fields.origin : { path: planned.path, how: 'itself', sha256: A_SHA } }
}

/** A whole plan of `subjects`, with whatever `fields` change. */
const planOf = (subjects = [subjectOf()], fields = {}) => ({
  version: 1,
  head: HEAD,
  mergeBase: BASE,
  worktree: {},
  base: 'main',
  only: null,
  requireBase: false,
  shards: 1,
  isolate: 0,
  subjects,
  ...fields,
})

/** A report of `at` carrying the source the plan hashed and `mutants`, each with the planned identity unless it says otherwise. */
const reportOf = (at, mutants, source = A_SOURCE) => ({
  files: { [at]: { source, mutants: mutants.map((one, id) => ({ id: String(id), static: false, ...IDENTITY, ...one })) } },
})

/** A result a shard would have written for `subject`, with whatever `fields` change. */
const resultOf = (plan, fields = {}) => ({
  kind: 'result',
  version: 1,
  plan,
  shard: 1,
  subject: 'src/a.ts',
  sha256: A_SHA,
  outcome: 'killed',
  exitedCleanly: true,
  mutants: 1,
  durationMs: 250,
  report: null,
  settle: null,
  base: null,
  ...fields,
})

/** A receipt shard 1 would have left, with whatever `fields` change. */
const receiptOf = (plan, fields = {}) => ({ kind: 'receipt', version: 1, plan, shard: 1, count: 1, subjects: ['src/a.ts'], ...fields })

/**
 * Writes `plan` as a manifest and whatever `records` names — each `name →
 * record`, the name relative to `<root>/results` — then aggregates over them.
 * `records` is handed the plan's own digest, which every record must carry.
 */
async function reconcile(root, plan, records = () => ({})) {
  const text = `${JSON.stringify(plan, null, 2)}\n`
  const digest = digestOf(text)
  const files = { 'plan.json': text }
  for (const [name, record] of Object.entries(records(digest))) {
    files[path.join('results', name)] = typeof record === 'string' ? record : `${JSON.stringify(record, null, 2)}\n`
  }
  plant(root, files)
  const manifest = path.join(root, 'plan.json')
  return { manifest, digest, ...(await aggregateOf(root, manifest)) }
}

/** The whole of a plan that holds one mutated file, its one result and its receipt — a sweep that passes. */
const onePassing = (at) => (digest) => ({
  'shard-1/a.result.json': resultOf(digest, { report: reportOf(at, [{ status: 'Killed' }]) }),
  'shard-1/receipt.json': receiptOf(digest),
})

describe('the name a result is written under', () => {
  /* ⚠️ **A NAME OF 264 BYTES FAILED THE WRITE OUTRIGHT, AND A SLUG THAT FELL
     AWAY TO `.ts` MADE A HIDDEN FILE** that `actions/upload-artifact` leaves
     out. So the name is a trimmed slug and a digest of fixed width, and both
     halves are asserted rather than the shape of one of them. */
  it('keeps the subject’s own name as a slug, trims what a name may not begin or end with, and digests the path to sixteen characters', () => {
    expect(resultFileFor('src/a.ts')).toMatch(/^a\.ts-[0-9a-f]{16}\.result\.json$/u)
    expect(resultFileFor('src/.hidden.ts')).toMatch(/^hidden\.ts-[0-9a-f]{16}\.result\.json$/u)
    expect(resultFileFor('src/_a_')).toMatch(/^a-[0-9a-f]{16}\.result\.json$/u)
    /* Nothing of a name survives the trim, so the slug is a word rather than nothing. */
    expect(resultFileFor('src/测.ts')).toMatch(/^ts-[0-9a-f]{16}\.result\.json$/u)
    expect(resultFileFor('src/测')).toMatch(/^file-[0-9a-f]{16}\.result\.json$/u)
    /* And the digest is of the WHOLE path, so two files of one name are two results. */
    expect(resultFileFor('src/a.ts')).not.toBe(resultFileFor('lib/a.ts'))
  })
})

describe('the order everything a plan lists is written in', () => {
  /* Code-point order, which no locale can reorder: a plan is the same bytes on
     every runner, so the comparator must answer for equal names as well as for
     ordered ones. */
  it('answers nothing for two names that are the same, and the lower one first whichever way round it is asked', () => {
    expect(byName('a', 'a')).toBe(0)
    expect(byName('a', 'b')).toBe(-1)
    expect(byName('b', 'a')).toBe(1)
    expect(['b', 'a', 'B'].sort(byName)).toEqual(['B', 'a', 'b'])
  })
})

describe('how a plan spreads its files over shards', () => {
  const weighing = (...weights) => weights.map((mutants, at) => ({ path: `src/${at}.ts`, class: 'mutated', mutants }))

  /* ⚠️ **THE SCAN FOR THE LIGHTEST SHARD COUNTED UP TO `count`**, where an
     off-by-one read `load[count]` — `undefined`, and never less than anything —
     so a bound no test could observe sat in the middle of the balancing. It
     walks the candidates themselves now, and these hold the walk to its two
     ends: where it starts, and what it answers. */
  it('places each file after the isolated ones in the lightest shard that is not one of them, counting from the first that is not', () => {
    /* The heaviest gets shard 1 to itself; the three that follow fill 2, 3 and
       4 in turn, and the fourth of them goes back to whichever is lightest. */
    expect(assignShards(weighing(20, 5, 5, 5), 4, 1)).toEqual([1, 2, 3, 4])
    expect(assignShards(weighing(20, 5, 5, 5, 5), 4, 1)).toEqual([1, 2, 3, 4, 2])
    /* An isolated shard is never a candidate again, however heavy the rest get. */
    expect(assignShards(weighing(10, 6, 6, 6), 2, 1)).toEqual([1, 2, 2, 2])
    /* And with none isolated the scan starts at the first shard of all. */
    expect(assignShards(weighing(4, 3, 2), 3)).toEqual([1, 2, 3])
    expect(assignShards(weighing(4, 3, 2, 1), 3)).toEqual([1, 2, 3, 3])
  })
})

describe('what a plan says of the shards it spread its files over', () => {
  /* A file no Stryker run will try weighs nothing, so it is never one of the
     heaviest — and the count of shards given a file of their own is the count of
     files that HAVE something to run, never the count of files. */
  it('calls a shard one file’s own only for as many files as have mutants to run', async () => {
    await inScratch('mutants-plan-', async (root) => {
      threeKinds(root)

      const { manifest, stdout } = await planOver(root, { shards: 4, isolate: 3 })

      expect(stdout).toBe(
        `check-mutants: planned 3 changed file(s) over 4 shard(s) into ${manifest}:\n` +
          '  shard 1/4 — 1 file(s), 1 mutant(s) to run, a shard of its own\n' +
          '  shard 2/4 — 2 file(s), 0 mutant(s) to run\n' +
          '  shard 3/4 — 0 file(s), 0 mutant(s) to run\n' +
          '  shard 4/4 — 0 file(s), 0 mutant(s) to run\n' +
          ESTIMATE,
      )
    })
  })
})

describe('what a shard writes down about a report that is not of its subject', () => {
  /* The count a result carries is the count the report holds FOR THAT FILE. A
     report of anything else counts nothing — and a report naming the string
     `undefined` is the one that tells a missing answer from a found one, since
     `files[undefined]` is a key a report may hold. */
  it('counts no mutant from a report that names another file, the name `undefined` included', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = threeKinds(root)
      const subjects = ['src/a.ts']
      const { manifest } = await planOver(root, { subjects })
      const { stryker } = strykerSaying(root, {
        reports: { [files['src/a.ts']]: { files: { undefined: { mutants: [{ id: '0', status: 'Killed' }, { id: '1', status: 'Killed' }] } } } },
      })

      const result = await shardOf(root, manifest, '1/1', { subjects, stryker })

      expect(result.code).toBe(1)
      const written = await readJson(resultIn(path.join(root, 'results'), 1, 'src/a.ts'))
      expect(written.outcome).toBe('did-not-run')
      expect(written.mutants).toBe(null)
    })
  })

  it('counts no mutant from a report whose entry for its subject is not one it can read', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = threeKinds(root)
      const subjects = ['src/a.ts']
      const { manifest } = await planOver(root, { subjects })
      const { stryker } = strykerSaying(root, { reports: { [files['src/a.ts']]: { files: { [files['src/a.ts']]: null } } } })

      const result = await shardOf(root, manifest, '1/1', { subjects, stryker })

      expect(result.code).toBe(1)
      const written = await readJson(resultIn(path.join(root, 'results'), 1, 'src/a.ts'))
      expect(written.outcome).toBe('did-not-run')
      expect(written.mutants).toBe(null)
    })
  })
})

describe('a shard refuses a checkout that is not the one its plan was made for', () => {
  /* Every difference is named in one order whatever order git answers in, so two
     runs of one shard on one checkout say the same thing. */
  it('names the changed files its plan does not hold in one order, whichever order git names them in', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const { manifest } = await planOver(root, { subjects: ['src/a.ts'] })

      const result = await shardOf(root, manifest, '1/1', { subjects: ['src/z.ts', 'src/n.ts', 'src/a.ts'] })

      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/1 would sweep something other than its plan — refused:\n` +
          '  src/n.ts is a changed file here, and the plan does not hold it\n' +
          '  src/z.ts is a changed file here, and the plan does not hold it\n',
      )
      expect(result.code).toBe(2)
    })
  })

  it('names the paths its working tree differs at in one order, whichever order the plan recorded them in', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const planted = { 'src/z.ts': 'd'.repeat(64), 'src/a.ts': 'e'.repeat(64) }
      const { manifest } = await planOver(root, { subjects: [], worktree: () => planted })

      const result = await shardOf(root, manifest, '1/1', { subjects: [] })

      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/1 would sweep something other than its plan — refused:\n` +
          "  the working tree differs from the plan's at src/a.ts\n" +
          "  the working tree differs from the plan's at src/z.ts\n",
      )
      expect(result.code).toBe(2)
    })
  })

  /* ⚠️ **THE CHECKOUT ITSELF IS NOT WHAT A SHARD WRITES.** What the sharded
     modes write is left out of drift detection, and `path.relative` answers `''`
     for the checkout's own root — which holds every path there is. Left in, a
     `--results` of the root would have exempted the WHOLE TREE from the
     comparison, and the shard would have swept a changed checkout without a
     word. */
  it('still sees the working tree change when its own results are the checkout itself', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const { manifest } = await planOver(root, { subjects: [] })

      const result = await shardOf(root, manifest, '1/1', {
        subjects: [],
        results: root,
        worktree: () => ({ 'src/x.ts': 'f'.repeat(64) }),
      })

      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/1 would sweep something other than its plan — refused:\n` +
          "  the working tree differs from the plan's at src/x.ts\n",
      )
      expect(result.code).toBe(2)
      expect(existsSync(receiptIn(root, 1))).toBe(false)
    })
  })

  /* A file that changed may not be there to count, so nothing is counted until
     everything else agrees. */
  it('counts no mutant in a file it would skip while anything else already differs', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const subjects = ['src/a.ts', 'src/z.ts']
      const { manifest } = await planOver(root, { subjects })
      rmSync(path.join(root, 'src/z.ts'))

      const result = await shardOf(root, manifest, '1/1', {
        subjects: ['src/a.ts'],
        tree: THREE_TREE.filter((name) => name !== 'src/z.ts'),
      })

      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/1 would sweep something other than its plan — refused:\n` +
          '  src/z.ts is in the plan, and is not a changed file here\n',
      )
      expect(result.code).toBe(2)
    })
  })

  /* ⚠️ **A SUBJECT'S SWEEP IS BRACKETED AT THREE POINTS, AND EACH SAYS WHAT THE
     DIFFERENCE WOULD HAVE MADE UNTRUE** — a shard with no file to skip reaches
     the first of them only through the Stryker run's own hook. */
  it('says what it was about to sweep when the checkout changed before a Stryker run', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const subjects = ['src/a.ts']
      const { manifest } = await planOver(root, { subjects })
      let looks = 0
      const worktree = () => (++looks >= 2 ? { 'src/helper.testkit.ts': 'e'.repeat(64) } : {})

      const result = await shardOf(root, manifest, '1/1', { subjects, worktree })

      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/a.ts and every file after it would be swept from something other than its plan — stopped:\n` +
          "  the working tree differs from the plan's at src/helper.testkit.ts\n",
      )
      expect(result.code).toBe(2)
    })
  })
})

describe('a shard writes nowhere but the directory it claimed', () => {
  /* ⚠️ **THE CLAIM PROTECTED THE DIRECTORY ONLY AT THE MOMENT IT WAS MADE.**
     What it claimed is remembered by identity and asked again before every
     write — and a directory that is GONE is answered for, not thrown on, so the
     shard stops in its own words rather than in the filesystem's. */
  it('stops in its own words when the directory it claimed has gone, rather than on the failure of a read', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)
      const subjects = ['src/z.ts']
      const { manifest } = await planOver(root, { subjects })
      const results = path.join(root, 'results')
      const own = path.join(results, 'shard-1')
      let gone = false
      const stdout = {
        write: (text) => {
          if (gone || !text.includes("are this shard's")) return
          gone = true
          rmSync(results, { recursive: true, force: true })
        },
      }

      const result = await shardOf(root, manifest, '1/1', { subjects, stdout })

      expect(result.stderr).toBe(
        `check-mutants: ${own} is no longer the directory this shard claimed — something moved or replaced it while the shard was writing, and nothing more goes there\n`,
      )
      expect(result.code).toBe(2)
    })
  })
})

describe('what an aggregate refuses in a record a shard could not have written', () => {
  it('refuses a plan whose head or merge base is not a commit, and reads one whose commits are the longer kind', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const refusals = [
        [{ head: [HEAD] }, 'its head is a list, which is not a commit'],
        [{ head: `zzz${HEAD}` }, `its head is ${JSON.stringify(`zzz${HEAD}`)}, which is not a commit`],
        [{ head: `${HEAD}zz` }, `its head is ${JSON.stringify(`${HEAD}zz`)}, which is not a commit`],
        [{ mergeBase: [BASE] }, 'its mergeBase is a list, which is neither a commit nor null'],
        [{ base: 42 }, 'its base is 42, which is not a ref'],
      ]
      let made = 0
      for (const [fields, why] of refusals) {
        const here = path.join(root, `refused-${(made += 1)}`)
        mkdirSync(here, { recursive: true })
        const { manifest, stderr, code } = await reconcile(here, planOf([], fields), (digest) => ({ 'receipt.json': receiptOf(digest, { subjects: [] }) }))
        expect(stderr, why).toBe(`check-mutants: ${manifest} is not a plan this gate wrote — ${why}\n`)
        expect(code).toBe(2)
      }
      /* And a checkout whose commits are SHA-256 is a checkout this gate plans. */
      const taken = path.join(root, 'taken')
      mkdirSync(taken)
      const long = 'a'.repeat(64)
      const { stdout, code } = await reconcile(taken, planOf([], { head: long, mergeBase: long }), (digest) => ({
        'receipt.json': receiptOf(digest, { subjects: [] }),
      }))
      expect(stdout).toBe('check-mutants: nothing changed to mutate\n')
      expect(code).toBe(0)
    })
  })

  it('refuses a plan whose subject names a path, a digest, a list of tests or a mutant this gate would never have written', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const located = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
      const refusals = [
        [{ path: 42 }, 'subject 1 has path 42, which is not a path'],
        [{ sha256: `zz${A_SHA}` }, `src/a.ts has sha256 ${JSON.stringify(`zz${A_SHA}`)}, which is not a digest`],
        [{ sha256: `${A_SHA}zz` }, `src/a.ts has sha256 ${JSON.stringify(`${A_SHA}zz`)}, which is not a digest`],
        [{ sha256: [A_SHA] }, 'src/a.ts has sha256 a list, which is not a digest'],
        [{ tests: [1] }, 'src/a.ts has tests a list, which is not a list of paths'],
        /* Each of these has everything a mutant's identity needs but one. */
        [{ identities: [{ replacement: '""', location: located }] }, 'src/a.ts has identities a list, which is not a list of mutants'],
        [{ identities: [{ mutatorName: 'StringLiteral', location: located }] }, 'src/a.ts has identities a list, which is not a list of mutants'],
        [
          { identities: [{ mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 1, column: 1 }, end: { line: 0, column: 1 } } }] },
          'src/a.ts has identities a list, which is not a list of mutants',
        ],
        [
          { identities: [{ mutatorName: 'StringLiteral', replacement: '""', location: { start: { column: 1 }, end: { column: 1 } } }] },
          'src/a.ts has identities a list, which is not a list of mutants',
        ],
      ]
      let at = 0
      for (const [fields, why] of refusals) {
        const here = path.join(root, `refused-${(at += 1)}`)
        mkdirSync(here, { recursive: true })
        const { manifest, stderr, code } = await reconcile(here, planOf([subjectOf(fields)]))
        expect(stderr, why).toBe(`check-mutants: ${manifest} is not a plan this gate wrote — ${why}\n`)
        expect(code).toBe(2)
      }
    })
  })

  /* ⚠️ **THE ORIGIN DECIDES WHICH FILE A SHARD GOES AND MEASURES**, so the two
     things that decide it are held here as well as its shape: a file that is its
     own origin is its own PATH, and a plan with no merge base has no origin for
     anything at all. */
  it('refuses a plan whose subject names a base file this gate would never have traced it to', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const refusals = [
        [planOf([subjectOf({ origin: 'src/a.ts' })]), 'src/a.ts has origin "src/a.ts", which is not a base file this gate traces to'],
        [
          planOf([subjectOf({ origin: { path: 'src/a.ts', how: 'borrowed' } })]),
          'src/a.ts has origin an object, which is not a base file this gate traces to',
        ],
        [
          planOf([subjectOf({ origin: { path: '', how: 'itself' } })]),
          'src/a.ts has origin an object, which is not a base file this gate traces to',
        ],
        /* A path is a string with something in it: a number taken for one would
           be handed to a shard to measure, and to git as a pathspec. */
        [
          planOf([subjectOf({ origin: { path: 42, how: 'itself' } })]),
          'src/a.ts has origin an object, which is not a base file this gate traces to',
        ],
        /* ⚠️ **AND THE CONTENT THE MERGE BASE HOLDS THERE.** A plan freezes it,
           and it is the whole of what makes a shard's base evidence evidence
           rather than a claim — so an origin that names no content is an origin
           against which nothing could be reconciled. */
        [
          planOf([subjectOf({ origin: { path: 'src/a.ts', how: 'itself' } })]),
          'src/a.ts has origin.sha256 missing, which is not a digest',
        ],
        [
          planOf([subjectOf({ origin: { path: 'src/a.ts', how: 'itself', sha256: 'not a digest' } })]),
          'src/a.ts has origin.sha256 "not a digest", which is not a digest',
        ],
        [
          planOf([subjectOf({ origin: { path: 'src/b.ts', how: 'itself', sha256: A_SHA } })]),
          'src/a.ts is its own origin at src/b.ts, which is another file',
        ],
        [planOf([subjectOf()], { mergeBase: null }), 'src/a.ts has an origin at src/a.ts, and the plan has no merge base for it to be in'],
      ]
      let at = 0
      for (const [plan, why] of refusals) {
        const here = path.join(root, `refused-${(at += 1)}`)
        mkdirSync(here, { recursive: true })

        const { manifest, stderr, code } = await reconcile(here, plan)

        expect(stderr, why).toBe(`check-mutants: ${manifest} is not a plan this gate wrote — ${why}\n`)
        expect(code, why).toBe(2)
      }
      /* And a plan with no merge base and no origin for anything is one this gate
         writes, on a checkout with no base to compare against. */
      const taken = path.join(root, 'taken')
      mkdirSync(taken)
      const { code } = await reconcile(taken, planOf([], { mergeBase: null }), (digest) => ({
        'receipt.json': receiptOf(digest, { subjects: [] }),
      }))

      expect(code).toBe(0)
    })
  })

  it('refuses a result whose subject, duration or shared fields are not what a shard writes, and takes a duration of none at all', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const refusals = [
        [{ subject: 42 }, 'its subject is 42, which is not a path'],
        [{ durationMs: '5' }, 'its durationMs is "5", which is not a duration'],
        [{ durationMs: -1 }, 'its durationMs is -1, which is not a duration'],
      ]
      let at = 0
      for (const [fields, why] of refusals) {
        const here = path.join(root, `refused-${(at += 1)}`)
        mkdirSync(here, { recursive: true })
        const { manifest, stderr, code } = await reconcile(here, planOf(), (digest) => ({
          'shard-1/a.result.json': resultOf(digest, fields),
          'shard-1/receipt.json': receiptOf(digest),
        }))
        expect(stderr, why).toContain(`unreadable: ${path.join(here, 'results', 'shard-1', 'a.result.json')} — ${why}\n`)
        expect(stderr).toContain(reconcileFails(manifest))
        expect(code).toBe(1)
      }
      /* A file swept in no time at all is a duration, and the shortest there is. */
      const instant = path.join(root, 'instant')
      mkdirSync(instant)
      const swept = await reconcile(instant, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, { durationMs: 0, report: reportOf(path.join(instant, 'src/a.ts'), [{ status: 'Killed' }]) }),
        'shard-1/receipt.json': receiptOf(digest),
      }))
      expect(swept.stderr).toBe('')
      expect(swept.code).toBe(0)
    })
  })

  it('refuses a receipt written for another version of this gate, and one naming a shard the plan does not have', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const old = path.join(root, 'old')
      mkdirSync(old)
      const first = await reconcile(old, planOf(), (digest) => ({
        ...onePassing(path.join(old, 'src/a.ts'))(digest),
        'shard-1/stale.json': receiptOf(digest, { version: 2 }),
      }))
      expect(first.stderr).toBe(
        reconcileFails(first.manifest) +
          `  unreadable: ${path.join(old, 'results', 'shard-1', 'stale.json')} — its version is 2, and this gate reads version 1\n`,
      )
      expect(first.code).toBe(1)

      const far = path.join(root, 'far')
      mkdirSync(far)
      const second = await reconcile(far, planOf(), (digest) => ({
        ...onePassing(path.join(far, 'src/a.ts'))(digest),
        'shard-1/ninth.json': receiptOf(digest, { shard: 9, subjects: [] }),
      }))
      expect(second.stderr).toBe(
        reconcileFails(second.manifest) +
          `  unexpected: ${path.join(far, 'results', 'shard-1', 'ninth.json')} — a receipt for shard 9/1, and the plan has 1 shard(s)\n`,
      )
      expect(second.code).toBe(1)
    })
  })

  it('refuses a receipt that names as many files as the plan gave its shard and not the same ones', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const { manifest, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, { report: reportOf(path.join(root, 'src/a.ts'), [{ status: 'Killed' }]) }),
        'shard-1/receipt.json': receiptOf(digest, { subjects: ['src/b.ts'] }),
      }))

      expect(stderr).toBe(
        reconcileFails(manifest) +
          `  unexpected: ${path.join(root, 'results', 'shard-1', 'receipt.json')} — shard 1/1 names other files than the plan gave it\n` +
          '  missing: shard 1/1 left no receipt — it did not finish\n',
      )
      expect(code).toBe(1)
    })
  })

  /* A receipt is not a result, and `stopped` is a thing only a result carries —
     so a receipt that holds one says nothing about whether its shard finished. */
  it('takes a receipt that carries a field only a result would, rather than reading it as a shard that stopped', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const { manifest, stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, { report: reportOf(path.join(root, 'src/a.ts'), [{ status: 'Killed' }]) }),
        'shard-1/receipt.json': receiptOf(digest, { stopped: 'because' }),
      }))

      expect(stderr).toBe('')
      expect(stdout).toBe(reconciled(manifest, 1) + 'check-mutants: every mutant was killed\n')
      expect(code).toBe(0)
    })
  })

  /* ⚠️ **AND THE ENTRY THIS ASSERTS THE UNREACHABILITY OF WAS IN `SWEPT_AS`.** A
     result of a mutated file cannot end `nothing-to-kill`: its report must hold
     exactly the mutants the plan counted, which is at least one, so there is
     always a status to answer from. One that claims it is refused here, which is
     what makes the missing entry safe. */
  it('refuses a result claiming there was nothing to kill in a file the plan counted mutants in', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const { manifest, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'nothing-to-kill',
          report: reportOf(path.join(root, 'src/a.ts'), [{ status: 'Killed' }]),
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        `  unreadable: ${path.join(root, 'results', 'shard-1', 'a.result.json')} — says nothing-to-kill, and its own report says killed\n`,
      )
      expect(stderr).toContain(reconcileFails(manifest))
      expect(code).toBe(1)
    })
  })
})

describe('what an aggregate makes of a report a result carries', () => {
  /* A report of the file, of the right content, holding the right mutants — and
     the FIRST run's report is answered for whether or not there is a settle run
     beside it. */
  it('refuses a first report that is not of the content the plan hashed, though the settle run’s report is', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const { manifest, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'killed',
          report: reportOf(at, [{ status: 'Timeout' }], 'export const a = "something else"\n'),
          settle: { exitedCleanly: true, durationMs: 90, report: reportOf(at, [{ status: 'Killed' }]) },
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        `  mismatched: ${path.join(root, 'results', 'shard-1', 'a.result.json')} — report does not match the plan: its source of src/a.ts is not the content the plan hashed\n`,
      )
      expect(stderr).toContain(reconcileFails(manifest))
      expect(code).toBe(1)
    })
  })

  /* A report whose entry for the subject carries no list of mutants is no
     account of it at all — the run scored nothing, which fails on its own, and
     nothing downstream reads an entry it could not understand. */
  it('takes a report whose entry holds no list of mutants for a run that scored nothing, and reads nothing out of it', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const { manifest, stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, { outcome: 'did-not-run', exitedCleanly: false, report: { files: { [at]: {} } } }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe(
        'check-mutants: Stryker did not finish for 1 file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n' +
          `  ${at}\n` +
          "  Its own error is in the log of the shard that ran it; nothing about these files' tests is known yet.\n",
      )
      expect(stdout).toBe(reconciled(manifest, 1))
      expect(code).toBe(1)
    })
  })

  /* A file the plan counted no mutant in had no Stryker run to answer for, so a
     report on such a result is not held to anything — the counts are. */
  it('reconciles a file with nothing to run from its counts, whatever report its result carries', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const bare = subjectOf({ path: 'src/z.ts', sha256: digestOf('export const z = 1\n'), class: 'no-mutants', mutants: 0, identities: [] })
      const { manifest, stdout, stderr, code } = await reconcile(root, planOf([bare]), (digest) => ({
        'shard-1/z.result.json': resultOf(digest, {
          subject: 'src/z.ts',
          sha256: bare.sha256,
          outcome: 'no-mutants',
          exitedCleanly: null,
          mutants: 0,
          report: { files: { [path.join(root, 'src/z.ts')]: { mutants: [] } } },
        }),
        'shard-1/receipt.json': receiptOf(digest, { subjects: ['src/z.ts'] }),
      }))

      expect(stderr).toBe('')
      expect(stdout).toBe(
        reconciled(manifest, 1) +
          'check-mutants: 1 file(s) had no mutant to kill — Stryker made none, or every one is disabled beside the code — so they pass without any test having been tried against them:\n' +
          `  ${path.join(root, 'src/z.ts')}\n`,
      )
      expect(code).toBe(0)
    })
  })

  /* ⚠️ **42 OF 140 REPLAYED WALL-CLOCK TIMEOUTS CAME BACK `Survived`**, so a
     survivor the settle run alone observes is the ordinary case — and a static
     one it alone observes must be named, or the reader is told to verify a
     mutant nobody pointed at. */
  it('names a static survivor the settle run alone found, with where it sits', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      /* A file the merge base has no origin for, so the survivor is the change's
         own and no evidence is owed — see the cases on the merge base below. */
      const { stdout, stderr, code } = await reconcile(root, planOf([subjectOf({ origin: null })]), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'survived',
          report: reportOf(at, [{ status: 'Timeout' }]),
          settle: { exitedCleanly: true, durationMs: 90, report: reportOf(at, [{ status: 'Survived', static: true }]) },
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(`check-mutants: a mutant survived in 1 file(s)`)
      /* On stdout, and not under the survivors: a static survivor is named
         wherever there is one, including in a file the merge base authorised —
         which is the case that used to pass in silence. See `summarise`. */
      expect(stdout).toContain(
        `  static: ${at}:${PLACE} — a static mutant that throws while the module is imported is reported Survived by Stryker's vitest runner, because the suite fails to load; verify it by hand, and if it does throw, disable it beside the code with that reason\n`,
      )
      expect(code).toBe(1)
    })
  })
})

/**
 * ## What a shard records of the merge base, and what the aggregate does with it
 *
 * ⚠️ **A SHARD'S WORD FOR "AUTHORISED" IS NOT TAKEN, EXACTLY AS ITS WORD FOR AN
 * OUTCOME IS NOT.** A result carries the EVIDENCE — the survivors the merge base
 * had, what measuring them cost, and the verdict the shard reached — and the
 * aggregate identifies this file's survivors again from the report the result
 * carries, runs the pairing again, and refuses a verdict its own arithmetic does
 * not reach.
 */
describe('the merge base, measured in a shard and reconciled by an aggregate', () => {
  /** The survivor `A_SOURCE`'s one mutant is, as both sides of a comparison identify one. */
  const A_SURVIVOR = {
    file: 'src/a.ts',
    identity: { mutatorName: 'StringLiteral', replacement: '""', original: "'a'", statement: "export const a = 'a'", scope: [] },
  }
  /**
   * The merge base's evidence for that file, with whatever `fields` change: the
   * content it swept and Stryker's own report of sweeping it, which is what the
   * aggregate derives the survivors from — never a list beside them.
   */
  const owedAtBase = (at, fields = {}) => ({
    origin: { path: 'src/a.ts', how: 'itself', sha256: A_SHA },
    outcome: 'survived',
    install: 'linked',
    durationMs: 900,
    sha256: A_SHA,
    source: A_SOURCE,
    first: { exitedCleanly: false, durationMs: 900, report: reportOf(at, [{ status: 'Survived' }]) },
    settle: null,
    authorised: 1,
    added: [],
    /* What the merge base could not run, by content — see `changedSinceBase`. */
    excluded: [],
    unseen: [],
    /* The repeat pairing, which an evidence has carried since 2026-09-20 — a
       wall-clock timeout that repeated is compared with the merge base like a
       survivor, in its own pool. Nothing repeated here, so both are empty, and
       they are asserted rather than ignored: a shape this reads past is a
       field a record could stop carrying unseen. */
    hangsAuthorised: 0,
    hangsAdded: [],
    refusal: null,
    ...fields,
  })
  /** The same, for a merge base that KILLED the mutant — a complete measurement holding no survivor for anything here to be answered by. */
  const killedAtBase = (at, fields = {}) =>
    owedAtBase(at, {
      outcome: 'killed',
      first: { exitedCleanly: true, durationMs: 900, report: reportOf(at, [{ status: 'Killed' }]) },
      authorised: 0,
      ...fields,
    })
  /** A merge base that could not be measured at all: a refusal, and nothing measured beside it. */
  const refusedAtBase = (refusal) => ({
    origin: { path: 'src/a.ts', how: 'itself', sha256: A_SHA },
    outcome: null,
    install: null,
    durationMs: 0,
    sha256: null,
    source: null,
    first: null,
    settle: null,
    authorised: 0,
    added: [],
    /* One shape for every evidence, measured or refused — see `judgedAtBase`. */
    excluded: [],
    unseen: [],
    /* The repeat pairing, which an evidence has carried since 2026-09-20 — a
       wall-clock timeout that repeated is compared with the merge base like a
       survivor, in its own pool. Nothing repeated here, so both are empty, and
       they are asserted rather than ignored: a shape this reads past is a
       field a record could stop carrying unseen. */
    hangsAuthorised: 0,
    hangsAdded: [],
    refusal,
  })
  /** Every subject is its own file at the merge base. */
  const itsOwn = (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: A_SHA }]))
  /** A result of `src/a.ts` whose one mutant survived, carrying `base` as its evidence. */
  const survivedWith = (digest, at, base) =>
    resultOf(digest, { outcome: 'survived', exitedCleanly: false, report: reportOf(at, [{ status: 'Survived' }]), base })
  /** Why the merge base answers for none of them, in `matchedSurvivors`' own words. */
  const NOT_THERE = 'the merge base has no survivor with this identity in src/a.ts'
  /** The same one-quote literal, inside a class method — so the survivor identified from it sits in a chain of declarations. */
  const SCOPED_SOURCE = "export class Reader {\n  read() {\n    return 'a'\n  }\n}\n"
  const SCOPED_IDENTITY = { mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 3, column: 12 }, end: { line: 3, column: 15 } } }

  /* ⚠️ **A SHARD ASKED THE SAME QUESTION ONCE PER SUBJECT, NOT ONCE PER BASE
     FILE** (a second opinion's fifth round, 2026-09-17). A plain sweep caches by
     origin and says why where it does: two subjects traced to one base file ask
     the same thing of the same commit, so asking twice costs a second worktree,
     a second install and a second sweep — and then invites the two answers to
     differ, which `matchedAcross` can only settle by leaving that identity
     undecided. A shard had no cache at all, so a change that copies one file
     into two paid twice on the one job with the tightest time budget. */
  it('measures one base file once, however many of its subjects a shard holds', async () => {
    await inScratch('mutants-shard-', async (root) => {
      /* One file copied into two, which is the shape that asks one base file the
         same question twice — see `sweptTogether`. */
      const files = checkout(root, { 'src/a.ts': A_SOURCE, 'src/b.ts': A_SOURCE, 'src/a.test.mjs': "import './a'\nimport './b'\n" })
      const tree = ['src/a.ts', 'src/b.ts', 'src/a.test.mjs']
      const subjects = ['src/a.ts', 'src/b.ts']
      const origin = { path: 'src/moved.ts', how: 'copied', sha256: A_SHA }
      const { manifest } = await planOver(root, { subjects, tree, origins: (names) => new Map(names.map((name) => [name, origin])) })
      const asked = []
      const { stryker } = strykerSaying(root, {
        reports: Object.fromEntries(subjects.map((name) => [files[name], reportOf(files[name], [{ status: 'Survived' }])])),
        exits: Object.fromEntries(subjects.map((name) => [files[name], false])),
      })
      const atBase = { exitedCleanly: false, durationMs: 900, report: reportOf(path.join(root, 'src/moved.ts'), [{ status: 'Survived' }]) }

      await shardOf(root, manifest, '1/1', {
        subjects,
        tree,
        stryker,
        measure: (named, commit) => {
          asked.push([named, commit])
          return { install: 'linked', outcome: 'survived', durationMs: 900, sha256: A_SHA, source: A_SOURCE, first: atBase, settle: null }
        },
      })

      expect(asked).toEqual([['src/moved.ts', BASE]])
    })
  })

  /* ⚠️ **A SHARD RESOLVES NEITHER THE MERGE BASE NOR THE ORIGIN FOR ITSELF** —
     it reads both out of the plan, which is the contract. The subject here is
     one the plan traced to ANOTHER file, so a shard that measured the file it is
     now would measure the wrong thing and this would say so. */
  it('measures the file the plan traced it to, at the commit the plan froze, and writes what that said into the result', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = threeKinds(root)
      const subjects = ['src/a.ts']
      const moved = { path: 'src/moved.ts', how: 'renamed', sha256: A_SHA }
      const { manifest } = await planOver(root, { subjects, origins: (names) => new Map(names.map((name) => [name, moved])) })
      const asked = []
      const { stryker } = strykerSaying(root, {
        reports: { [files['src/a.ts']]: reportOf(files['src/a.ts'], [{ status: 'Survived' }]) },
        exits: { [files['src/a.ts']]: false },
      })
      /* What the base measurement answers: the content it swept — which the plan
         froze out of the merge base's own commit — and the report of sweeping it,
         under the name the plan traced this file TO. */
      const atBase = { exitedCleanly: false, durationMs: 900, report: reportOf(path.join(root, 'src/moved.ts'), [{ status: 'Survived' }]) }

      const result = await shardOf(root, manifest, '1/1', {
        subjects,
        stryker,
        measure: (named, commit) => {
          asked.push([named, commit])
          return { install: 'linked', outcome: 'survived', durationMs: 900, sha256: A_SHA, source: A_SOURCE, first: atBase, settle: null }
        },
      })

      expect(asked).toEqual([['src/moved.ts', BASE]])
      expect(result.code).toBe(0)
      const written = await readJson(resultIn(path.join(root, 'results'), 1, 'src/a.ts'))
      expect(written.outcome).toBe('survived')
      expect(written.base).toEqual({
        origin: moved,
        outcome: 'survived',
        install: 'linked',
        durationMs: 900,
        /* This stand-in measured nothing it had to leave out — see `changedSinceBase`. */
        excluded: [],
        unseen: [],
        /* The repeat pairing, which an evidence has carried since 2026-09-20 — a
           wall-clock timeout that repeated is compared with the merge base like a
           survivor, in its own pool. Nothing repeated here, so both are empty, and
           they are asserted rather than ignored: a shape this reads past is a
           field a record could stop carrying unseen. */
        hangsAuthorised: 0,
        hangsAdded: [],
        sha256: A_SHA,
        source: A_SOURCE,
        first: atBase,
        settle: null,
        authorised: 1,
        added: [],
        refusal: null,
      })
    })
  })

  /* ⚠️ **THE DRIFT CHECK BRACKETS THE BASE MEASUREMENT TOO.** It runs between
     this subject's settle run and the check that follows it, so a checkout that
     changes while the merge base is being measured is a checkout the result was
     not swept from — and the shard stops, leaving what it wrote marked as a
     stopped shard's and no receipt. */
  it('stops the shard when the checkout changes while the merge base is being measured', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = threeKinds(root)
      const subjects = ['src/a.ts']
      let edited = false
      const worktree = () => (edited ? { 'src/helper.testkit.ts': 'e'.repeat(64) } : {})
      const { manifest } = await planOver(root, { subjects, origins: itsOwn, worktree })
      const { stryker } = strykerSaying(root, {
        reports: { [files['src/a.ts']]: reportOf(files['src/a.ts'], [{ status: 'Survived' }]) },
        exits: { [files['src/a.ts']]: false },
      })

      const result = await shardOf(root, manifest, '1/1', {
        subjects,
        stryker,
        worktree,
        measure: () => {
          edited = true
          return {
            install: 'linked',
            outcome: 'survived',
            durationMs: 900,
            sha256: A_SHA,
            source: A_SOURCE,
            first: { exitedCleanly: false, durationMs: 900, report: reportOf(path.join(root, 'src/a.ts'), [{ status: 'Survived' }]) },
            settle: null,
          }
        },
      })

      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/a.ts was swept from ` +
          "something other than its plan — stopped:\n  the working tree differs from the plan's at src/helper.testkit.ts\n",
      )
      expect(result.code).toBe(2)
      const written = await readJson(resultIn(path.join(root, 'results'), 1, 'src/a.ts'))
      expect(written.stopped).toBe("the working tree differs from the plan's at src/helper.testkit.ts")
      expect(existsSync(receiptIn(path.join(root, 'results'), 1))).toBe(false)
    })
  })

  /* ⚠️ **A REFUSAL MEASURED NOTHING, SO IT CARRIES NOTHING.** Survivors written
     beside one would be survivors at a merge base nobody looked at — read by the
     aggregate as an authorisation for exactly the mutants that were left
     standing because the base could not be measured. */
  it('writes no survivor, no outcome and no cost beside a merge base it could not measure', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = threeKinds(root)
      const subjects = ['src/a.ts']
      const { manifest } = await planOver(root, { subjects, origins: itsOwn })
      const { stryker } = strykerSaying(root, {
        reports: { [files['src/a.ts']]: reportOf(files['src/a.ts'], [{ status: 'Survived' }]) },
        exits: { [files['src/a.ts']]: false },
      })

      /* The real measurement, against a merge base this checkout does not have —
         which is what a shallow clone gives, and the refusal a reader meets. */
      const result = await shardOf(root, manifest, '1/1', { subjects, stryker, measure: measureAtBase })

      expect(result.code).toBe(1)
      const written = await readJson(resultIn(path.join(root, 'results'), 1, 'src/a.ts'))
      expect(written.base).toEqual(
        refusedAtBase({ reason: 'no-commit', message: expect.stringContaining(`the merge base ${BASE} is not in this checkout`) }),
      )
    })
  })

  /* ⚠️ **A NAME THE ORIGINS HOLD NO ANSWER FOR IS A NAME WITH NO ORIGIN.** An
     `undefined` there would reach a shard as an origin it cannot read, and the
     plan would be refused minutes later on every one of them; a file with no
     answer is a file nothing at the merge base can answer for, which is what a
     new file is. */
  it('plans no origin at all for a subject the traced origins hold no answer for', async () => {
    await inScratch('mutants-shard-', async (root) => {
      threeKinds(root)

      const { manifest } = await planOver(root, { subjects: ['src/a.ts'], origins: () => new Map() })

      expect((await readJson(manifest)).subjects.map((one) => [one.path, one.origin])).toEqual([['src/a.ts', null]])
    })
  })

  it('passes a file whose survivor the merge base owed too, deriving the difference again from the evidence', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at)),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(stdout).toContain(
        'check-mutants: 1 file(s) had a mutant survive, so the merge base was measured for what each already owed there:\n' +
          `  ${at} — 1 of 1 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, 900 ms)\n`,
      )
      expect(stdout).not.toContain('every mutant was killed')
    })
  })

  /* ⚠️ **AND IT PASSED THE SAME FILE WITH A MUTANT NOTHING HAD SCORED** — a
     second opinion's fifth round, 2026-09-17, reproduced. The aggregate is the
     only mode that can pass a sharded sweep, so the channel a plain sweep gained
     has to be filled here too, and filled from evidence the aggregate derives
     rather than from the shard's own word for it. One survivor the base answered
     for, one wall-clock timeout the settle run crashed on: the first used to
     outrank the second, and both were reported while neither failed. */
  it('fails a file the merge base answered for when the settle run reached no verdict for another mutant', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const second = { mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 2, column: 18 }, end: { line: 2, column: 21 } } }

      const { stdout, stderr, code } = await reconcile(root, planOf([subjectOf({ mutants: 2, identities: [IDENTITY, second] })]), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'survived',
          exitedCleanly: false,
          mutants: 2,
          report: reportOf(at, [{ status: 'Survived' }, { ...second, status: 'Timeout' }]),
          settle: { exitedCleanly: false, durationMs: 40, report: reportOf(at, [{ status: 'Survived' }, { ...second, status: 'RuntimeError' }]) },
          base: owedAtBase(at),
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      /* The merge base answered for the survivor, exactly as in the case above. */
      expect(stdout).toContain('1 of 1 survivor(s) were there too')
      /* And the file fails on the mutant the base was never asked about. */
      expect(code).toBe(1)
      expect(stderr).toContain('check-mutants: the settle run reached no verdict for 1 mutant(s) in 1 file(s)')
      expect(stderr).toContain(`  unresolved: ${at}:2:18 — the settle run answered "RuntimeError", which is no verdict\n`)
    })
  })

  /* And the other half of the same reproduction: a wall-clock timeout with NO
     settle run to read. `sayTimeouts`' header argues such a result never reaches
     the verdict at all, because reconciliation has already refused it — and that
     is what this measures, rather than assuming it. It holds: the result is
     refused as one that does not reconcile with the plan, so the file is
     `missing` and the aggregate exits 1 without ever weighing the timeout.

     `settledVerdict` was still made fail-closed for the same shape (a named
     unresolved mutant per unanswered timeout), because that argument is about
     the roads known today and the cost of the backstop is one map. Nothing here
     may assert that backstop through the aggregate, since reconciliation gets
     there first — which is the honest reading and is why this case pins the
     refusal by its own words. */
  it('refuses a result carrying a wall-clock timeout and no settle run, before any verdict is reached on it', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const second = { mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 2, column: 18 }, end: { line: 2, column: 21 } } }

      const { stderr, code } = await reconcile(root, planOf([subjectOf({ mutants: 2, identities: [IDENTITY, second] })]), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'survived',
          exitedCleanly: false,
          mutants: 2,
          report: reportOf(at, [{ status: 'Survived' }, { ...second, status: 'Timeout' }]),
          settle: null,
          base: owedAtBase(at),
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stderr).toContain('  missing: src/a.ts — no result from shard 1/1 that reconciles with the plan\n')
    })
  })

  /**
   * ⚠️ **A MUTANT THE MERGE BASE COULD NOT DECIDE IS ITS OWN ANSWER, AND THE
   * AGGREGATE DERIVES IT** (2026-09-17). The base run here scored the file — every
   * mutant a kill by Stryker's own reckoning, a `Timeout` among them — and met
   * that one timeout again in its settle run, so the identity is unknown at the
   * merge base and nothing else in the file is. The shard's word for which class a
   * survivor falls in is worth no more than its word for anything else: the
   * aggregate reads the reports and works it out again.
   */
  const undecidedAt = (at) =>
    owedAtBase(at, {
      outcome: 'killed',
      first: { exitedCleanly: true, durationMs: 900, report: reportOf(at, [{ status: 'Timeout' }]) },
      settle: { exitedCleanly: true, durationMs: 300, report: reportOf(at, [{ status: 'Timeout' }]) },
      authorised: 0,
    })
  /** How the merge base names the one mutant it could not decide in these cases, and how a survivor here is billed for it. */
  const REPEATED = `its settle run met the same wall-clock timeout again at ${PLACE}`
  const UNDECIDED = `the merge base could not decide this mutant in src/a.ts: ${REPEATED}`

  it('bills a survivor the merge base could not decide as the reader’s to settle, in a sentence of its own', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const added = [{ file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why: UNDECIDED, class: 'undecided' }]

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, { ...undecidedAt(at), added }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stdout).toContain(
        `  ${at} — 0 of 1 survivor(s) were there too, in itself at the merge base (killed, dependencies linked, 900 ms); ` +
          '1 the merge base could not decide\n',
      )
      /* The whole block, remedy and all: a reader told a mutant is theirs to
         settle and not told what settling one looks like is told half of it.

         ⚠️ **AND IT SAID "this change did not add them" UNTIL 2026-09-17**, which
         the evidence does not support: a merge base that never answered for a
         mutant says nothing either way about who added it. */
      expect(stderr).toContain(
        'check-mutants: the merge base could not decide 1 mutant(s) that survived here — it never answered for them, so ' +
          'whether this change added them is not something this run can say, and a mutant the merge base never answered ' +
          'for is not one it authorises; they are yours to settle:\n' +
          `  undecided: src/a.ts:${PLACE} — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${UNDECIDED}\n` +
          '  Settle one by killing it here, or, if the mutation is genuinely\n' +
          '  equivalent, say so beside the code:\n' +
          '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n',
      )
      /* The other sentence is NOT used for it: a reader told this change added a
         mutant goes looking at their own diff for something that is not there. */
      expect(stderr).not.toContain('  added:')
    })
  })

  /* ⚠️ **A MERGE BASE THIS GATE MAKES NO MUTANT IN ANSWERS FOR NOTHING, AND IS
     NOT A REFUSAL EITHER.** It is a complete measurement of a file that had
     nothing to kill — a barrel the change put code into — so every survivor here
     is plainly the change's own, and neither a survivor nor an undecided mutant
     comes out of it. */
  it('answers for nothing from a merge base that had no mutant at all, and bills the change for every survivor', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const bare = 'export const z = 1\n'
      const held = digestOf(bare)
      const plan = planOf([subjectOf({ origin: { path: 'src/a.ts', how: 'itself', sha256: held } })])
      const base = owedAtBase(at, {
        outcome: 'no-mutants',
        sha256: held,
        source: bare,
        first: null,
        authorised: 0,
        added: [{ file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why: NOT_THERE, class: 'added' }],
      })

      const { stdout, stderr, code } = await reconcile(root, plan, (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, base),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stdout).toContain(
        `  ${at} — 0 of 1 survivor(s) were there too, in itself at the merge base (no-mutants, dependencies linked, 900 ms); ` +
          '1 this change added\n',
      )
      expect(stderr).toContain(`  added: src/a.ts:${PLACE} — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${NOT_THERE}\n`)
    })
  })

  /* ⚠️ **AND A SHARD THAT DID NOT SETTLE MAY NOT BE BELIEVED ABOUT A TIMEOUT AT
     THE MERGE BASE EITHER** — the same rule `disagreementOf` applies to a run
     here. A wall-clock timeout Stryker scores as a kill is a kill nobody
     re-tried, so the identity is unknown rather than answered, and it says which
     of the two it is. */
  it('names a wall-clock timeout the merge base never settled as one it could not decide', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const why = `the merge base could not decide this mutant in src/a.ts: its run left a wall-clock timeout at ${PLACE} that nothing settled`
      const base = owedAtBase(at, {
        outcome: 'killed',
        first: { exitedCleanly: true, durationMs: 900, report: reportOf(at, [{ status: 'Timeout' }]) },
        authorised: 0,
        added: [{ file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why, class: 'undecided' }],
      })

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, base),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stderr).toContain(`  undecided: src/a.ts:${PLACE} — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${why}\n`)
    })
  })

  /* ⚠️ **A SURVIVOR THE FIRST RUN SAW IS A SURVIVOR THE FILE HAD, WHATEVER THE
     SETTLE RUN WENT ON TO SAY.** The outcome of a measured file is `survived`
     where EITHER run saw one — an observed survivor is never averaged away — and
     the disagreement about that mutant is the mutant's own answer, not the
     file's. Read off the settle run alone, this file would be `killed`, and a
     record honestly saying `survived` would be refused as one that disagrees with
     its own report. */
  it('measures a file as survived where only the first run saw it, and names the disagreement as the mutant’s', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const why = `the merge base could not decide this mutant in src/a.ts: its two runs answered for the mutant at ${PLACE} with Survived and then with Killed`
      const base = owedAtBase(at, {
        settle: { exitedCleanly: true, durationMs: 300, report: reportOf(at, [{ status: 'Killed' }]) },
        authorised: 0,
        added: [{ file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why, class: 'undecided' }],
      })

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, base),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stderr).toContain(`  undecided: src/a.ts:${PLACE} — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${why}\n`)
    })
  })

  /* ⚠️ **AND THE OUTCOME A MEASUREMENT CARRIES IS HELD TO ITS OWN REPORT**, at
     the file's scale: what the runs made of the FILE, with the mutants they could
     not decide left out of it. A record saying one thing over a report that says
     another is a record nothing in can be believed. */
  it('refuses base evidence whose outcome is not what its own reports measured', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at, { outcome: 'killed', authorised: 0 })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: its run of src/a.ts at the merge base says killed, and its own " +
          'report says survived',
      )
      expect(code).toBe(1)
    })
  })

  it('refuses a shard that bills a mutant the merge base could not decide as one the change added', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const added = [{ file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why: NOT_THERE, class: 'added' }]

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, { ...undecidedAt(at), added }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: it says what this change added, and its own evidence says 1 were " +
          'added, the first differing one being StringLiteral replacing "\'a\'" with "\\"\\"" in the file itself at src/a.ts:1:18',
      )
      expect(code).toBe(1)
    })
  })

  /**
   * ⚠️ **A SUPPLIED LIST OF SURVIVORS BOUGHT EVERYTHING IT CLAIMED** (review,
   * 2026-09-17). The probe that found it claimed `no-mutants` at the merge base
   * and copied this file's own survivor into the evidence's `survivors`: the
   * aggregate re-derived the PAIRING and then ran it against the shard's list, so
   * a result with no base measurement behind it at all exited 0.
   *
   * There is no such list now. The evidence carries the CONTENT the merge base
   * holds — which the plan froze out of the merge base's own commit — and
   * Stryker's reports of sweeping it, and the survivors are read out of those. A
   * shard claiming the merge base had nothing to mutate has to carry a source
   * this gate makes no mutant in, which is not the file the plan traced it to.
   */
  it('refuses a shard claiming the merge base had nothing to mutate, over content this gate makes a mutant in', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at, { outcome: 'no-mutants', first: null })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: its run of src/a.ts at the merge base says it had nothing to " +
          'mutate, and this gate makes 1 mutant(s) in what it carries',
      )
      expect(code).toBe(1)
    })
  })

  /* ⚠️ **AND THE CONTENT ITSELF IS HELD TO THE COMMIT.** A shard that measured
     nothing and carried THIS file's content as the merge base's would otherwise
     produce evidence that answers for every survivor here by construction: the
     same source gives the same identities. The plan froze what the merge base
     holds, and that is the whole of what makes evidence evidence. */
  it('refuses evidence measured over content the merge base does not hold at that file', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const held = digestOf("export const a = 'was'\n")
      const plan = planOf([subjectOf({ origin: { path: 'src/a.ts', how: 'itself', sha256: held } })])

      const { stderr, code } = await reconcile(root, plan, (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at)),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        `the merge base's evidence does not support it: its run of src/a.ts at the merge base measured content hashing ` +
          `to "${A_SHA}", and the merge base holds "${held}" at src/a.ts`,
      )
      expect(code).toBe(1)
    })
  })

  /**
   * ⚠️ **ONE HISTORICAL SURVIVOR WAS SPENT ONCE PER SUBJECT** (review,
   * 2026-09-17). A shard pairs its own subject against its own measurement of the
   * base file, because a shard sees one subject — so a change that copies a file
   * into two, both traced to one origin, had the origin's single survivor
   * authorise both, in two processes neither of which could see the other. Each
   * result's own arithmetic is right, and the sweep's is not.
   *
   * The aggregate is the only thing that sees every subject at once, so the pool
   * is made there: one per base file, spent across the whole sweep. One of the two
   * copies takes it and the other owes — which of them is named decides nothing,
   * and the count is the whole of the guarantee.
   */
  it('spends one survivor at the merge base once across the whole sweep, not once per subject', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const base = path.join(root, 'src/a.ts')
      const copies = ['src/one.ts', 'src/two.ts']
      const traced = { path: 'src/a.ts', how: 'copied', sha256: A_SHA }
      const plan = planOf(copies.map((path) => subjectOf({ path, origin: traced })))

      const { stdout, stderr, code } = await reconcile(root, plan, (digest) => ({
        ...Object.fromEntries(
          copies.map((named) => [
            `shard-1/${path.basename(named)}.json`,
            resultOf(digest, {
              subject: named,
              outcome: 'survived',
              exitedCleanly: false,
              report: reportOf(path.join(root, named), [{ status: 'Survived' }]),
              /* Each shard measured the same file at the merge base and reached
                 the same answer, and each paired its own subject against it. */
              base: owedAtBase(base, { origin: traced }),
            }),
          ]),
        ),
        'shard-1/receipt.json': receiptOf(digest, { subjects: copies }),
      }))

      expect(code).toBe(1)
      const spent =
        'the merge base has 1 survivor(s) with this identity in src/a.ts, and each of them answers for another survivor here'
      expect(stderr).toContain(`  added: src/two.ts:${PLACE} — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${spent}\n`)
      expect(stderr).not.toContain('  added: src/one.ts:')
      /* And the numbers a reader is shown are the sweep's own, not each shard's:
         each shard paired its own subject against the same one survivor and
         reached 1 of 1, and the sweep reaches 1 of 1 once. */
      expect(stdout).toContain(`  ${path.join(root, 'src/one.ts')} — 1 of 1 survivor(s) were there too`)
      expect(stdout).toContain(`  ${path.join(root, 'src/two.ts')} — 0 of 1 survivor(s) were there too`)
    })
  })

  /**
   * ⚠️ **TWO MEASUREMENTS THAT DIFFERED THREW THE WHOLE FILE'S POOL AWAY, WHICH IS
   * THE FILE-WIDE PENALTY THIS DESIGN EXISTS TO END** (review, 2026-09-17). The
   * rule was that ANY difference between two shards' survivor lists refused the
   * origin outright — so two measurements agreeing about `'a'` and differing about
   * `'b'` left BOTH head subjects with zero authorisations, and a survivor of
   * `'a'`, in code nobody touched, was billed because a second mutant elsewhere in
   * that file had answered twice.
   *
   * The reconciliation is per BASE MUTANT now, which is the granularity every
   * other hole here is read at: `'a'` was found alive by both measurements, so it
   * stands in the pool and answers for the survivor here; `'b'` was found alive by
   * only one, so it is UNDECIDED — authorising nothing, and naming the survivor
   * here as one the merge base could not decide rather than as one the change
   * added. Both classes still fail; what the file around them owes is unchanged.
   *
   * ⚠️ **AND THIS CASE HAS TO BE THE SHARDED PATH.** A plain sweep measures each
   * origin once and remembers it, so it can never have two measurements to
   * reconcile — only an aggregate over shards can.
   */
  it('reconciles two shards’ measurements of one base file per mutant, and keeps the pool they agree on', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const base = path.join(root, 'src/a.ts')
      /* Two mutants at the merge base, so one of them can be disagreed about
         while the other is not. */
      const both = "export const a = 'a'\nexport const b = 'b'\n"
      const sha = digestOf(both)
      const isB = { ...IDENTITY, location: { start: { line: 2, column: 18 }, end: { line: 2, column: 21 } } }
      const B_SURVIVOR = { mutatorName: 'StringLiteral', replacement: '""', original: "'b'", statement: "export const b = 'b'", scope: [] }
      const traced = { path: 'src/a.ts', how: 'copied', sha256: sha }
      const copies = ['src/one.ts', 'src/two.ts']
      const plan = planOf(copies.map((named) => subjectOf({ path: named, origin: traced, sha256: sha, mutants: 2, identities: [IDENTITY, isB] })))
      /* Each copy carries both mutants and survives a different one, so which
         head survivor the pool answers for is visible one file at a time. */
      const alive = { 'src/one.ts': ['Survived', 'Killed'], 'src/two.ts': ['Killed', 'Survived'] }
      /* What each shard's own measurement of `src/a.ts` found: they agree that
         `'a'` was alive there and differ about `'b'`. */
      const measured = { 'src/one.ts': ['Survived', 'Survived'], 'src/two.ts': ['Survived', 'Killed'] }
      const reportBoth = (at, statuses) => ({
        files: {
          [at]: {
            source: both,
            mutants: [IDENTITY, isB].map((identity, id) => ({ id: String(id), static: false, ...identity, status: statuses[id] })),
          },
        },
      })
      const owedForB = [
        { file: 'src/two.ts', at: '2:18', identity: B_SURVIVOR, why: 'the merge base has no survivor with this identity in src/a.ts', class: 'added' },
      ]

      const { stdout, stderr, code } = await reconcile(root, plan, (digest) => ({
        ...Object.fromEntries(
          copies.map((named) => [
            `shard-1/${path.basename(named)}.json`,
            resultOf(digest, {
              subject: named,
              sha256: sha,
              mutants: 2,
              outcome: 'survived',
              exitedCleanly: false,
              report: reportBoth(path.join(root, named), alive[named]),
              base: {
                ...owedAtBase(base, { origin: traced, sha256: sha, source: both }),
                first: { exitedCleanly: false, durationMs: 900, report: reportBoth(base, measured[named]) },
                /* Each shard's own arithmetic, which the aggregate holds it to
                   before it pools anything: one.ts's survivor of `'a'` is answered
                   for by its own measurement, two.ts's survivor of `'b'` is not. */
                authorised: named === 'src/one.ts' ? 1 : 0,
                added: named === 'src/one.ts' ? [] : owedForB,
              },
            }),
          ]),
        ),
        'shard-1/receipt.json': receiptOf(digest, { subjects: copies }),
      }))

      expect(code).toBe(1)
      /* The agreed mutant still answers, and only the file holding the contested
         one owes anything. */
      expect(stdout).toContain(`  ${path.join(root, 'src/one.ts')} — 1 of 1 survivor(s) were there too`)
      expect(stdout).toContain(`  ${path.join(root, 'src/two.ts')} — 0 of 1 survivor(s) were there too`)
      expect(stderr).toContain(
        `  undecided: src/two.ts:2:18 — StringLiteral replacing "'b'" with "\\"\\"" in the file itself — the merge base ` +
          'could not decide this mutant in src/a.ts: 1 of the 2 measurements of src/a.ts found it alive and the rest did not\n',
      )
      /* And the disagreement is REPORTED as well as acted on — see
         `sayContested`. It changes no verdict, and it is the cheapest sign that
         the merge base's runs are not reproducing each other, which is the thing
         every authorisation rests on. Without it a contested identity that no
         survivor here consumes is invisible, and the sweep passes in silence. */
      expect(stdout).toContain(
        "check-mutants: 1 mutant(s) were contested between measurements of the same merge-base file — this does not change what any file owes, and it does say the base's runs did not reproduce each other:\n" +
          '  src/a.ts — measured 2 time(s), 1 identity(ies) contested\n',
      )
      /* And nothing is refused whole: the file whose survivor the pool answered
         for is not among the ones a mutant survived in. */
      expect(stderr).not.toContain(path.join(root, 'src/one.ts'))
      expect(stderr).not.toContain('measured it differently')
    })
  })

  it('refuses a shard that claims the merge base answered for a survivor its own evidence never held', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { manifest, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, killedAtBase(at, { authorised: 1 })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe(
        reconcileFails(manifest) +
          `  mismatched: ${path.join(root, 'results/shard-1/a.result.json')} — the merge base's evidence does not support it: ` +
          'it says the merge base answered for 1 of the mutants that survived, and its own evidence answers for 0\n' +
          '  missing: src/a.ts — no result from shard 1/1 that reconciles with the plan\n',
      )
      expect(code).toBe(1)
    })
  })

  it('refuses a shard whose list of what the change added is not the one its evidence gives', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      /* A survivor nothing here mutated — so the refusal has to say what it is,
         and not merely how many there are. */
      const invented = { file: 'src/a.ts', at: '9:9', identity: { ...A_SURVIVOR.identity, original: "'elsewhere'" }, why: 'made up', class: 'added' }

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, killedAtBase(at, { added: [invented] })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: it says what this change added, and its own evidence says 1 were " +
          'added, the first differing one being StringLiteral replacing "\'a\'" with "\\"\\"" in the file itself at src/a.ts:1:18',
      )
      expect(code).toBe(1)
    })
  })

  it('refuses a shard whose evidence names another count of added survivors than its own arithmetic gives', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const added = { file: 'src/a.ts', at: PLACE, identity: A_SURVIVOR.identity, why: NOT_THERE, class: 'added' }

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, killedAtBase(at, { added: [added, { ...added, at: '2:2' }] })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: it says what this change added, and its own evidence says 1 " +
          'survivor(s) were added, against the 2 it records',
      )
      expect(code).toBe(1)
    })
  })

  /* ⚠️ **A SURVIVOR IS NAMED BY THE DECLARATIONS IT SAT IN.** Two classes may
     each have a `read`, so the chain is what a reader needs in order to find the
     mutant at all — and a separator that fell away would run the names together
     into one that names nothing. */
  it('names an added survivor by what was mutated and the chain of declarations it sat in', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const nested = { mutatorName: 'StringLiteral', replacement: '""', original: "'a'", statement: "return 'a'", scope: ['Reader', 'read'] }
      const added = { file: 'src/a.ts', at: '3:12', identity: nested, why: NOT_THERE, class: 'added' }
      const planned = subjectOf({ sha256: digestOf(SCOPED_SOURCE), identities: [SCOPED_IDENTITY] })

      const { stderr, code } = await reconcile(root, planOf([planned]), (digest) => ({
        'shard-1/a.result.json': {
          ...survivedWith(digest, at, killedAtBase(at, { added: [added] })),
          sha256: digestOf(SCOPED_SOURCE),
          report: { files: { [at]: { source: SCOPED_SOURCE, mutants: [{ id: '0', static: false, ...SCOPED_IDENTITY, status: 'Survived' }] } } },
        },
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stderr).toContain(
        `  added: src/a.ts:3:12 — StringLiteral replacing "'a'" with "\\"\\"" in Reader → read — ${NOT_THERE}\n`,
      )
    })
  })

  it('refuses a shard that measured another file, or reached it another way, than the plan traced this one', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const traced = [
        [
          { path: 'src/other.ts', how: 'itself' },
          'it measured src/other.ts (itself) at the merge base, and the plan traced this file to src/a.ts (itself)',
        ],
        [
          { path: 'src/a.ts', how: 'copied' },
          'it measured src/a.ts (copied) at the merge base, and the plan traced this file to src/a.ts (itself)',
        ],
      ]
      let made = 0
      for (const [origin, why] of traced) {
        const here = path.join(root, `traced-${(made += 1)}`)
        mkdirSync(here, { recursive: true })

        const { stderr, code } = await reconcile(here, planOf(), (digest) => ({
          'shard-1/a.result.json': survivedWith(digest, path.join(here, 'src/a.ts'), owedAtBase(path.join(here, 'src/a.ts'), { origin })),
          'shard-1/receipt.json': receiptOf(digest),
        }))

        expect(stderr, why).toContain(`the merge base's evidence does not support it: ${why}`)
        expect(code, why).toBe(1)
      }
    })
  })

  /* Both ways a merge base's dependencies can be supplied are ways this gate
     supplies them — lent this checkout's where the two commits pin the same
     bytes, installed from the base's own lockfile where they do not — so
     evidence naming either is evidence this gate wrote. */
  it('takes evidence from a merge base that installed its own dependencies, as readily as one lent this checkout’s', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at, { install: 'installed' })),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(stdout).toContain('(survived, dependencies installed, 900 ms)')
    })
  })

  /* ⚠️ **A SURVIVOR ONLY THE SETTLE RUN FOUND IS STILL ONE HERE.** The first run
     left this mutant timed out and the second answered it with a survivor: read
     from the first report alone the file has nothing alive in it, and the
     evidence authorising one would read as a shard inventing an excuse for a
     survivor nobody can see. */
  it('derives the difference from both runs, so a survivor only the settle run found is still answered for', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'survived',
          exitedCleanly: false,
          report: reportOf(at, [{ status: 'Timeout' }]),
          settle: { exitedCleanly: false, durationMs: 90, report: reportOf(at, [{ status: 'Survived' }]) },
          base: owedAtBase(at),
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(stdout).toContain('1 of 1 survivor(s) were there too')
    })
  })

  /* ⚠️ **A SURVIVOR IN BOTH RUNS IS ONE SURVIVOR.** A settle run re-sweeps the
     WHOLE file, so a mutant that survived the first run is in both reports —
     counted twice, one survivor at the merge base could answer for only one of
     them and the other would read as the change's own. */
  it('counts a survivor both runs found once, so a settle run cannot double what a file owes', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const survived = reportOf(at, [{ status: 'Survived' }])

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': {
          ...survivedWith(digest, at, owedAtBase(at)),
          settle: { exitedCleanly: false, durationMs: 90, report: survived },
        },
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(stdout).toContain('1 of 1 survivor(s) were there too')
    })
  })
  it('refuses a result that left a survivor with no evidence, in a file the plan traced to the merge base', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, null),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: it leaves the mutants that survived in it with no evidence at " +
          'all, and the plan traced it to src/a.ts',
      )
      expect(code).toBe(1)
    })
  })

  it('refuses evidence carried by a file the plan traced to nothing at the merge base', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')

      const { stderr, code } = await reconcile(root, planOf([subjectOf({ origin: null })]), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, owedAtBase(at)),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(
        "the merge base's evidence does not support it: it carries the merge base's evidence for a file the plan traced " +
          'to no file at the merge base',
      )
      expect(code).toBe(1)
    })
  })

  /* ⚠️ **"COULD NOT RUN" IS NEVER "IT ALREADY SURVIVED".** A refusal carries no
     survivors, so anything asking only whether the added list was empty would
     have passed every file whose base could not be measured. */
  it('fails a file whose merge base could not be measured, naming the refusal and what it cost nothing', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const at = path.join(root, 'src/a.ts')
      const refusal = { reason: 'install', message: 'check-mutants: the merge base’s own dependencies cannot be installed' }
      const base = refusedAtBase(refusal)

      const { stdout, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': survivedWith(digest, at, base),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(code).toBe(1)
      expect(stdout).toContain(`  ${at} — it could not be measured (install), so nothing here is authorised — ${refusal.message}\n`)
      expect(stderr).toContain(
        'check-mutants: the merge base could not be measured for 1 file(s), so nothing authorises the mutants that ' +
          'survived in them — a failure to measure is never permission, and "could not run" is never "it already survived":\n' +
          `  ${at} — install: ${refusal.message}\n`,
      )
      /* ⚠️ **AND IT IS STILL NAMED AS A SURVIVOR**, because it IS one: Stryker
         observed it, and the excuse that might have covered it is the thing that
         could not be got. Both remedies are the reader's — kill it, or make the
         merge base measurable — and neither is a substitute for the other. */
      expect(stderr).toContain('check-mutants: a mutant survived in 1 file(s)')
    })
  })

  it('refuses evidence this gate would never have written, field by field', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const survivor = { file: 'src/a.ts', identity: { mutatorName: 'S', replacement: '""', original: "'a'", statement: "const a = 'a'", scope: [] } }
      /* Every case here is refused by SHAPE, before anything reads a report, so
         the report these carry is of a path no case reconciles against. */
      const owed = (fields) => owedAtBase(path.join(root, 'src/a.ts'), fields)
      const refusals = [
        [{ base: undefined }, 'its base is missing, and a result that does not say what the merge base owed cannot be reconciled'],
        [{ base: 'owed' }, 'its base is "owed", which is neither the merge base\'s evidence nor null'],
        [{ base: owed({ origin: null }) }, 'its base.origin is null, which is not a file at the merge base this gate traces to'],
        [
          { base: owed({ origin: { path: 'src/a.ts', how: 'borrowed' } }) },
          'its base.origin is an object, which is not a file at the merge base this gate traces to',
        ],
        /* A path is a string with something in it. Either of these taken as one
           would be compared with the plan's traced origin, and what a reader got
           would be an argument about which file was measured. */
        [
          { base: owed({ origin: { path: 42, how: 'itself' } }) },
          'its base.origin is an object, which is not a file at the merge base this gate traces to',
        ],
        [
          { base: owed({ origin: { path: '', how: 'itself' } }) },
          'its base.origin is an object, which is not a file at the merge base this gate traces to',
        ],
        /* A refusal is a record of two strings or it is not a refusal: read off
           anything else, its reason and its message are `undefined`, and the
           aggregate would report a base that could not be measured in nobody's
           words. */
        [
          { base: owed({ refusal: 'it would not install' }) },
          'its base.refusal is "it would not install", which is neither a refusal nor null',
        ],
        [{ base: owed({ refusal: { reason: 'install' } }) }, 'its base.refusal.message is missing, which is not a reason'],
        [{ base: owed({ refusal: { reason: '', message: 'x' } }) }, 'its base.refusal.reason is "", which is not a reason'],
        [{ base: owed({ outcome: 'nearly' }) }, 'its base.outcome is "nearly", which this gate does not measure'],
        [
          { base: owed({ install: 'borrowed' }) },
          "its base.install is \"borrowed\", which is not how a merge base's dependencies are supplied",
        ],
        [{ base: owed({ durationMs: -1 }) }, 'its base.durationMs is -1, which is not a duration'],
        [{ base: owed({ authorised: 1.5 }) }, 'its base.authorised is 1.5, which is not a count'],
        /* ⚠️ **EVERY FIELD THE SURVIVORS ARE DERIVED FROM.** The evidence carries
           no list of them: it carries the content the merge base held and the
           reports of sweeping it, and a field of those that is not what this gate
           writes is a derivation made over somebody else's shapes. */
        [{ base: owed({ sha256: 'not a digest' }) }, 'its base.sha256 is "not a digest", which is not a digest'],
        [{ base: owed({ source: 42 }) }, 'its base.source is 42, which is not the content it swept'],
        [{ base: owed({ first: 'it ran' }) }, 'its base.first is "it ran", which is neither a first run nor null'],
        [
          { base: owed({ settle: { exitedCleanly: 'yes', durationMs: 1, report: null } }) },
          'its base.settle.exitedCleanly is "yes", which is not an exit',
        ],
        [{ base: owed({ added: {} }) }, 'its base.added is an object, which is not a list'],
        [
          { base: owed({ added: [{ ...survivor, at: '1:1' }] }) },
          'its base.added 1 is an object, which is not a survivor the merge base failed to answer for',
        ],
        /* An added survivor with no reason in it is the one line a reader is
           given for why the change is billed for it — blank, it names the
           mutant and says nothing about the merge base at all. */
        [
          { base: owed({ added: [{ ...survivor, at: '1:1', why: '' }] }) },
          'its base.added 1 is an object, which is not a survivor the merge base failed to answer for',
        ],
        /* And a survivor that says neither which of the two ways the merge base
           failed to answer for it: a class this gate does not write is one
           nothing downstream would print in either sentence. */
        [
          { base: owed({ added: [{ ...survivor, at: '1:1', why: 'x', class: 'perhaps' }] }) },
          'its base.added 1 is an object, which is not a survivor the merge base failed to answer for',
        ],
        /* ⚠️ **AND AN IDENTITY MISSING THE STATEMENT IS A PAIRING MADE OVER
           ANOTHER GATE'S SHAPE.** Every field the pool is keyed on is asked for
           by name: one that is not a string here would key `undefined`, which
           equals every other record that left it out. */
        [
          {
            base: owed({
              added: [{ ...survivor, identity: { ...survivor.identity, statement: 42 }, at: '1:1', why: 'x', class: 'added' }],
            }),
          },
          'its base.added 1 is an object, which is not a survivor the merge base failed to answer for',
        ],
        [{ outcome: 'killed', base: owed({}) }, 'its base is an object, and killed is no survivor for the merge base to answer for'],
      ]
      let made = 0
      for (const [fields, why] of refusals) {
        const here = path.join(root, `refused-${(made += 1)}`)
        mkdirSync(here, { recursive: true })

        const { stderr, code } = await reconcile(here, planOf(), (digest) => ({
          'shard-1/a.result.json': resultOf(digest, fields),
          'shard-1/receipt.json': receiptOf(digest),
        }))

        expect(stderr, why).toContain(`unreadable: ${path.join(here, 'results/shard-1/a.result.json')} — ${why}\n`)
        expect(code, why).toBe(1)
      }
    })
  })
})

describe('what an aggregate says of a sweep that failed', () => {
  /** A plan of `count` mutated files, one per name, each on shard 1. */
  const spread = (count) =>
    Array.from({ length: count }, (_, at) => subjectOf({ path: `src/a${at + 1}.ts` }))

  it('names every file Stryker never scored, one to a line', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = spread(2)
      const { manifest, stdout, stderr, code } = await reconcile(root, planOf(files), (digest) => ({
        ...Object.fromEntries(
          files.map((one, at) => [
            `shard-1/r${at}.json`,
            resultOf(digest, { subject: one.path, outcome: 'did-not-run', exitedCleanly: false, mutants: null }),
          ]),
        ),
        'shard-1/receipt.json': receiptOf(digest, { subjects: files.map((one) => one.path) }),
      }))

      expect(stdout).toBe(reconciled(manifest, 1))
      expect(stderr).toBe(
        'check-mutants: Stryker did not finish for 2 file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n' +
          `  ${path.join(root, 'src/a1.ts')}\n` +
          `  ${path.join(root, 'src/a2.ts')}\n` +
          "  Its own error is in the log of the shard that ran it; nothing about these files' tests is known yet.\n",
      )
      expect(code).toBe(1)
    })
  })

  it('names every file whose wall-clock timeout repeated, and every place one repeated at, one to a line', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = spread(2)
      const timedOut = (one) => {
        const at = path.join(root, one.path)
        return { report: reportOf(at, [{ status: 'Timeout' }]), settle: { exitedCleanly: true, durationMs: 90, report: reportOf(at, [{ status: 'Timeout' }]) } }
      }
      const { stderr, code } = await reconcile(root, planOf(files), (digest) => ({
        ...Object.fromEntries(
          files.map((one, at) => [`shard-1/r${at}.json`, resultOf(digest, { subject: one.path, outcome: 'timed-out', ...timedOut(one) })]),
        ),
        'shard-1/receipt.json': receiptOf(digest, { subjects: files.map((one) => one.path) }),
      }))

      expect(stderr).toBe(
        'check-mutants: a wall-clock timeout came back a wall-clock timeout in 2 file(s) — the settle run, with a 30 s deadline and a 4× factor, could not resolve it, so whether a test kills it is unknown.\n' +
          `  ${path.join(root, 'src/a1.ts')}\n` +
          `  ${path.join(root, 'src/a2.ts')}\n` +
          '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
          '  mutation genuinely never terminates, say so beside the code:\n' +
          '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n' +
          `  repeated: ${path.join(root, 'src/a1.ts')}:${PLACE}\n` +
          `  repeated: ${path.join(root, 'src/a2.ts')}:${PLACE}\n`,
      )
      expect(code).toBe(1)
    })
  })

  /* Every problem is named in code-point order of the file it was found in, so
     two aggregates over one directory of results say the same thing whatever
     order the filesystem answers in — and the walk's own order is the
     filesystem's in two ways at once. `s0/deep.json` is read while the walk is
     inside `s0`, before `s0.json` beside it, and `/` sorts ABOVE `.`, so a
     depth-first walk of a directory listed in order still reads out of order;
     the eight beside them are written in reverse, for a filesystem that lists
     what it was given in the order it was given. */
  it('names what it found wrong in code-point order of the files it read, not the order it read them in', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const strays = ['s8.json', 's7.json', 's6.json', 's5.json', 's4.json', 's3.json', 's2.json', 's1.json', 's0.json', 's0/deep.json']
      const { manifest, stderr, code } = await reconcile(root, planOf(), (digest) => ({
        ...Object.fromEntries(strays.map((name) => [name, resultOf('0'.repeat(64))])),
        ...onePassing(path.join(root, 'src/a.ts'))(digest),
      }))

      expect(stderr).toBe(
        reconcileFails(manifest) +
          ['s0.json', 's0/deep.json', 's1.json', 's2.json', 's3.json', 's4.json', 's5.json', 's6.json', 's7.json', 's8.json']
            .map((name) => `  unexpected: ${path.join(root, 'results', name)} — written for another plan\n`)
            .join(''),
      )
      expect(code).toBe(1)
    })
  })
})

describe('what the two runs of one subject add up to', () => {
  const SUBJECT = 'src/x.ts'

  /* A settle run's report may hold anything; a mutant it cannot read answers for
     nothing, rather than being the answer to a timeout that names no place. */
  it('reads no answer out of a settle report’s mutant it cannot read, even for a timeout that names nothing either', () => {
    const first = { exitedCleanly: true, report: { files: { [SUBJECT]: { mutants: [{ id: '0', status: 'Timeout' }] } } } }
    const settle = { exitedCleanly: true, durationMs: 7, report: { files: { [SUBJECT]: { mutants: [null] } } } }

    expect(settledVerdict(SUBJECT, first, settle)).toEqual({
      detected: 0,
      unsettled: 1,
      outcome: 'did-not-run',
      /* And the merge base's reading of the same pair — see `survivorsAtBase`.
         The settle run scored NOTHING here, which is a file that was not
         measured rather than one mutant that was not decided, so the two
         readings agree. */
      measured: 'did-not-run',
      repeated: [],
      /* The same mutants as identities — see `settledVerdict`. */
      repeats: [],
      /* Named as well as counted, and the name is what fails the file — see
         `noVerdictFor`. The place is empty because this fixture's mutant has no
         location, which is the point of the case above it. */
      unresolved: [": — the settle run's report says nothing about it"],
      answers: { killed: 0, survived: 0, repeated: 0, unresolved: 1 },
      durationMs: 7,
    })
  })

  /* ⚠️ **AND WHERE THEY DIFFER IS THE WHOLE OF THE SPLIT.** A settle run that
     scored the file and met one wall-clock timeout again is `timed-out` here — a
     finding a sweep reports — and `killed` to the merge base, which is asked
     whether it MEASURED the file and not what it found. The mutant it could not
     decide is named on its own; see `undecidedAtBase`. */
  it('reads a repeated timeout as this sweep’s finding and as a file the merge base did measure', () => {
    const at = (line) => ({ location: { start: { line, column: 1 }, end: { line, column: 4 } } })
    const timedOut = { files: { [SUBJECT]: { mutants: [{ id: '0', ...at(1), status: 'Timeout' }, { id: '1', ...at(2), status: 'Killed' }] } } }
    const verdict = settledVerdict(SUBJECT, { exitedCleanly: true, report: timedOut }, { exitedCleanly: true, durationMs: 7, report: timedOut })

    expect(verdict.outcome).toBe('timed-out')
    expect(verdict.measured).toBe('killed')
    expect(verdict.repeated).toEqual(['1:1'])
  })
})

describe('what one Stryker run amounted to', () => {
  const SUBJECT = 'src/x.ts'
  /* A function is the only value that both fails `typeof === 'object'` and can
     carry the fields a report holds — which is the whole of what these guards
     are for: nothing but an object is read as a report, a file entry or a
     mutant. */
  const carrying = (fields) => Object.assign(() => undefined, fields)

  it('is a run that did not happen when the report, its file entry or a mutant in it is not an object at all', () => {
    const killed = [{ id: '0', status: 'Killed' }]
    expect(outcomeOf(SUBJECT, true, carrying({ files: { [SUBJECT]: { mutants: killed } } }))).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: carrying({ mutants: killed }) } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: { mutants: [carrying({ status: 'Killed' })] } } })).toBe('did-not-run')
    /* And a survivor carried the same way is no survivor either. */
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: { mutants: [carrying({ status: 'Survived' })] } } })).toBe('did-not-run')
  })
})

describe('the links the sandbox copy cannot take', () => {
  it('skips the three directories whose links are none of a sweep’s business, and nothing else', () => {
    inScratch('mutants-links-', (root) => {
      for (const dir of ['.git', '.stryker-tmp', 'src-tauri/target', 'src', 'node_modules']) {
        mkdirSync(path.join(root, dir), { recursive: true })
        symlinkSync(path.join(root, 'gone'), path.join(root, dir, 'link'))
      }

      expect(symlinksIn(root)).toEqual(['src/link'])
    })
  })

  /* The list is the same on every runner, so a config built from it is the same
     bytes — where the WALK's order is the filesystem's, and is the filesystem's
     in two ways at once. `m/x` is found while the walk is inside `m`, before it
     reaches `m.z` beside it, and `/` sorts ABOVE `.` — so a depth-first walk of
     a directory listed in order still answers out of order. The eight beside
     them are made in reverse, for a filesystem that lists what it was given in
     the order it was given. */
  it('answers in code-point order however the filesystem answers, and wherever in the tree a link was found', () => {
    inScratch('mutants-links-', (root) => {
      const gone = path.join(root, 'gone')
      for (const name of ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']) symlinkSync(gone, path.join(root, name))
      mkdirSync(path.join(root, 'm'))
      symlinkSync(gone, path.join(root, 'm', 'x'))
      symlinkSync(gone, path.join(root, 'm.z'))

      expect(symlinksIn(root)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'm.z', 'm/x'])
    })
  })
})

describe('what a sweep asks Stryker for', () => {
  it('names the package manager, the runner, its plugin, both reporters and a threshold that breaks on one survivor', () => {
    expect(strykerConfig('src/x.ts', 'v.mjs')).toEqual({
      packageManager: 'pnpm',
      testRunner: 'vitest',
      plugins: ['@stryker-mutator/vitest-runner'],
      reporters: ['clear-text', 'json'],
      jsonReporter: { fileName: REPORT },
      coverageAnalysis: 'perTest',
      /* ⚠️ **STRYKER'S DRY RUN HAS ITS OWN DEADLINE, DEFAULTING TO FIVE MINUTES,
         AND THE MERGE BASE'S WIDE TEST SET PASSES IT** (2026-09-17). A base
         measurement runs every test that reaches the subject before one mutant is
         tried — `flatten.ts` pulls 1 079 of them — and the SETTLE run repeats
         that dry run. Under load it went past five minutes: no report, the
         measurement refused, and the change billed for debt it had not added.
         Found by the first cross-shard run that completed; no unit test can see
         it, because they all stand Stryker in and no dry run ever happens. */
      dryRunTimeoutMinutes: 20,
      mutate: ['src/x.ts'],
      vitest: { configFile: 'v.mjs' },
      ignorePatterns: ['.agents', '.claude', '.codex', '.cc-suite', '.stryker-tmp', 'src-tauri/target', 'coverage', 'dist', 'dist-mobile', 'bin', 'dev-docs', 'docs', '.git'],
      timeoutMS: 20_000,
      thresholds: { high: 100, low: 100, break: 100 },
    })
  })

  it('says in the generated config who wrote it and what becomes of it', () => {
    expect(vitestConfigFor(['a.test.mjs'], {})).toContain(
      '/* Written by scripts/check-mutants.mjs for one subject, and removed when the sweep ends. */\n',
    )
  })
})

describe('how a sweep runs the covering tests', () => {
  it('refuses a test block that is nothing at all, rather than reading fields off it', () => {
    for (const block of [null, undefined, 'a block']) {
      expect(() => carriedTestOptions(block), String(block)).toThrow(
        new Error('vitest.config.ts has no `test` block, so nothing says how its tests run'),
      )
    }
  })

  it('refuses a project that is not an object, extends nothing, or whose own test block is not one', () => {
    const extending = Object.assign(() => undefined, { extends: true, test: { name: 'callable' } })
    const why = 'vitest.config.ts has a project that does not extend the root `test` block, so the root’s settings are not its settings'
    for (const project of [null, 'a project', extending, { extends: false, test: {} }, { extends: true, test: null }]) {
      expect(() => carriedTestOptions({ projects: [project] }), String(project)).toThrow(new Error(why))
    }
    /* A project whose `test` is not an object at all is refused there too, and
       never read for keys of its own. */
    expect(() => carriedTestOptions({ projects: [{ extends: true, test: 'a block' }] })).toThrow(new Error(why))
  })

  it('leaves out the setup files a project does not declare, rather than carrying that it has none', () => {
    expect(Object.hasOwn(carriedTestOptions({}), 'setupFiles')).toBe(false)
    expect(carriedTestOptions({ setupFiles: ['./s.ts'] })).toEqual({ setupFiles: ['./s.ts'] })
  })

  /* Both config files are loaded in the environment VITEST loads them in, so a
     value either computes from `command` or `mode` is the value a sweep runs
     under rather than one it made up. */
  it('loads both config files as a serve-time test run, which is what Vitest asks Vite for', async () => {
    await inScratch('mutants-config-', async (root) => {
      checkout(root, {
        'vitest.config.ts': 'export default ({ command, mode }) => ({ test: { setupFiles: [command, mode] } })\n',
        'vite.config.ts': 'export default ({ command, mode }) => ({ test: { exclude: [command, mode] } })\n',
      })

      expect(await loadTestConfig(root)).toEqual({ setupFiles: ['serve', 'test'] })
      expect(await loadViteTestBlock(root)).toEqual({ exclude: ['serve', 'test'] })
    })
  })
})

/* ⚠️ **THE GATE LEAVES A COVERING TEST THAT READS ITS SUBJECT'S SOURCE OUT OF
   THE RUN**, and `pathsRead` follows a name across a whole FILE rather than one
   scope. So a path bound to a name here that also reaches a read would leave the
   gate out of its own sweep — silently, and looking exactly like a pass. It is
   asserted rather than remembered. */
describe('this file is no reader of the gate’s own source', () => {
  const readersOf = (...args) => [...sourceReaders(...args).keys()]

  it('does not take this file for a test that reads what it covers', () => {
    const mine = 'scripts/check-mutants.sharding.test.mjs'
    expect(readersOf(['scripts/check-mutants.mjs'], [mine], () => [mine])).toEqual([])
  })
})

/**
 * The nearest `node_modules` at or above `from`, which is the one Node resolves
 * this file's own imports through. Searched rather than assumed: see `checkout`.
 */
function installAbove(from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const at = path.join(dir, 'node_modules')
    if (existsSync(at)) return at
    if (path.dirname(dir) === dir) throw new Error(`no node_modules at or above ${from}`)
  }
}
