import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  REPORT,
  assignShards,
  byName,
  carriedTestOptions,
  loadTestConfig,
  loadViteTestBlock,
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
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'))
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

/** One planned subject — mutated, of one mutant, on shard 1 — with whatever `fields` change. */
const subjectOf = (fields = {}) => ({
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
})

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
      const { stderr, code } = await reconcile(root, planOf(), (digest) => ({
        'shard-1/a.result.json': resultOf(digest, {
          outcome: 'survived',
          report: reportOf(at, [{ status: 'Timeout' }]),
          settle: { exitedCleanly: true, durationMs: 90, report: reportOf(at, [{ status: 'Survived', static: true }]) },
        }),
        'shard-1/receipt.json': receiptOf(digest),
      }))

      expect(stderr).toContain(`check-mutants: a mutant survived in 1 file(s)`)
      expect(stderr).toContain(
        `  static: ${at}:${PLACE} — a static mutant that throws while the module is imported is reported Survived by Stryker's vitest runner, because the suite fails to load; verify it by hand, and if it does throw, disable it beside the code with that reason\n`,
      )
      expect(code).toBe(1)
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
      repeated: [],
      answers: { killed: 0, survived: 0, repeated: 0, unresolved: 1 },
      durationMs: 7,
    })
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
