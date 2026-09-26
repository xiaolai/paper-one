import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfigFromFile } from 'vite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolveConfig } from 'vitest/node'
import {
  FIRST_RUN,
  REPORT,
  SETTLE_RUN,
  VITEST_DEFAULT_TIMEOUT,
  acquireLock,
  allSourceFiles,
  argumentsOf,
  assignShards,
  carriedTestOptions,
  caselessAt,
  changedFiles,
  codeOf,
  commitsOf,
  coveringTests,
  importsOf,
  loadTestConfig,
  loadViteTestBlock,
  measureAtBase,
  identitiesOfSource,
  mutantIdentitiesIn,
  mutantsIn,
  noScoreOf,
  outcomeOf,
  pathsAt,
  remembered,
  reportFrom,
  repositoryFiles,
  resultFileFor,
  reverseImports,
  run,
  settledVerdict,
  sourceReaders,
  strykerConfig,
  symlinksIn,
  testsCovering,
  timeoutKindOf,
  trackedUnder,
  vitestConfigFor,
  worktreeOf,
  readInputsOf,
  inputsMoved,
} from './check-mutants.mjs'
import { DELETED_ENV } from './verify-without.mjs'

/** A scratch directory, removed after `act` whatever `act` does — after the
 *  promise settles when `act` returns one, since a sweep is asynchronous and a
 *  directory removed under it would fail it for a reason of the test's own.
 *
 *  ⚠️ **AND WHEN THE CASE FINISHES, WHICH IS NOT THE SAME MOMENT.** A sweep
 *  that never settles — the case timed out — never reaches that `finally`, and
 *  the cases that run whole sweeps are the ones that can; so the case removes it
 *  too. Both stay: a sweep that settles only AFTER its case timed out has already
 *  been removed under once, and `plant` or the sweep itself makes the directory
 *  again, which only the removal on settling takes away. */
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

/** What a throw leaves behind, or `null` when nothing was thrown. */
function thrownBy(act) {
  try {
    act()
    return null
  } catch (cause) {
    return cause
  }
}

/**
 * Why a case cannot run on Windows, by what it needs that Windows cannot make —
 * each measured on Windows 11 with Node 24, 2026-09-15.
 *
 * ⚠️ **SKIPPED AT RUN TIME, THROUGH THE TEST'S OWN `context`, NEVER `it.skipIf`.**
 * `vitest list` leaves a statically skipped case out, and `pnpm test:ledger`
 * reads a recorded name that is not collected as one that was deleted — see
 * `src/hosts/node/fs.test.ts`. So every name is still collected on Windows, and
 * reported there as skipped in these words rather than passing. Each case keeps
 * its own precondition after the skip: that is what still catches root on Linux.
 */
const WINDOWS = process.platform === 'win32'
const WINDOWS_CANNOT = {
  closeADirectory: 'a Windows directory has no mode bits, so chmod leaves it open to this user',
  closeAFile: 'Windows keeps no read bit, so chmod 000 only marks a file read-only and it stays readable',
  markAProgram: 'Windows keeps no executable bit, so chmod 755 leaves a file no different from a plain one',
  makeAFifo: 'Windows has no FIFO for a path to name',
  countDescriptors: 'Windows has no /dev/fd to count what this process holds open',
  nameALineFeed: 'a line feed is not a legal character in a Windows file name',
  nameAStar: '`*` is not a legal character in a Windows file name',
  refuseALink:
    'Node has no O_NOFOLLOW on Windows, so an exclusive create writes through a dangling link and a read follows a live one',
  deliverASignal:
    'Windows has no POSIX signals: `child.kill` calls TerminateProcess, so the target dies with no handler run and cannot let go of anything — the lock is left for `takeOver`, exactly as it is after a SIGKILL, and the case below and the takeover cases are what cover that',
}

/**
 * A pid that exists and that this user may not signal, so `kill(pid, 0)` answers
 * `EPERM`: pid 1 — root's init on macOS and on a Linux runner — and pid 4 on
 * Windows, the System process. Pid 1 does not exist on Windows and answers
 * `ESRCH` there, which is no precondition at all (measured 2026-09-15).
 */
const UNSIGNALLABLE = WINDOWS ? 4 : 1

/**
 * Whether this run is inside the deletion proof's copy, where git has no
 * repository to answer from.
 *
 * ⚠️ **`pnpm verify:without <id>` RUNS THIS SUITE IN A COPY TAKEN WITHOUT
 * `.git`** (`COPY_EXCLUDE` in `verify-without.mjs`), and every case that asks
 * git about THIS checkout failed there with "not a git repository" — on `main`
 * as well, found 2026-09-15 by running the proof on a clean tree. What those
 * cases measure is the repository, which cutting a capability does not change,
 * and the real tree's `pnpm verify` runs them. Asked of git itself, and only
 * under the proof's own marker, so a checkout git cannot read anywhere else
 * still fails them loudly.
 */
const OUTSIDE_A_REPOSITORY =
  process.env[DELETED_ENV] !== undefined &&
  spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim() !== 'true'
const NO_REPOSITORY = "the deletion proof's copy has no .git, so git cannot answer for this checkout; the real tree's pnpm verify runs this"

/** How a sweep names a module it reached a subject through: relative to where it
 *  runs, and separated by `/` on every platform — the host's `path.relative`
 *  spelling is `\` on Windows, and the gate records none of those. */
const throughName = (file) => path.relative(process.cwd(), file).split(path.sep).join('/')

/** How the generated vitest config spells a covering test: its own path, with
 *  `/` on every platform — `include` is a list of globs, and a glob reads `\` as
 *  an escape. See `vitestConfigFor`. */
const asGlob = (file) => file.split(path.sep).join('/')

/** The subjects `sourceReaders` found a reading test for, in the order they were asked about. */
const subjectsRead = (...args) => [...sourceReaders(...args).keys()]

/**
 * ⚠️ **A RUN THAT NEVER STARTED WAS REPORTED AS SURVIVING MUTANTS.** Stryker
 * exits non-zero for a score under the threshold AND for an error before any
 * mutant ran; the gate called both "a test that cannot fail". The JSON report
 * is the witness that tells them apart — and its CONTENTS, not its presence,
 * since a report can exist for a run that scored nothing. See `outcomeOf`.
 */
describe('what one Stryker run amounted to', () => {
  /* Every report here is about `SUBJECT` unless the case says otherwise. */
  const SUBJECT = 'src/x.ts'
  const mutantsOf = (...statuses) => ({ mutants: statuses.map((status, id) => ({ id: String(id), status })) })
  const reportOf = (...statuses) => ({ files: { [SUBJECT]: mutantsOf(...statuses) } })

  it('is every mutant killed when Stryker exits cleanly and nothing in the report survived', () => {
    expect(outcomeOf(SUBJECT, true, reportOf('Killed', 'Timeout', 'Ignored'))).toBe('killed')
    /* A mutant that crashed beside one that was killed still leaves a score, and
       one that never compiled is the same — both are statuses Stryker writes and
       leaves out of the score, not statuses this gate cannot read. */
    expect(outcomeOf(SUBJECT, true, reportOf('Killed', 'RuntimeError'))).toBe('killed')
    expect(outcomeOf(SUBJECT, true, reportOf('Killed', 'CompileError'))).toBe('killed')
  })

  it('is survivors when the report holds one, an uncovered mutant included', () => {
    expect(outcomeOf(SUBJECT, false, reportOf('Killed', 'Survived'))).toBe('survived')
    expect(outcomeOf(SUBJECT, false, reportOf('Killed', 'NoCoverage'))).toBe('survived')
  })

  /* The 2026-09-13 case: the sandbox copy died on a dangling symlink, no mutant
     ran, and no report was written. */
  it('is a run that did not happen when it exits non-zero with no report', () => {
    expect(outcomeOf(SUBJECT, false, null)).toBe('did-not-run')
  })

  it('is not a pass when a clean exit left no report, or a report with no files in it', () => {
    expect(outcomeOf(SUBJECT, true, null)).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, {})).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: null })).toBe('did-not-run')
  })

  /* Stryker breaks on `score < break`, and a score of NaN is not less than
     anything — so it exits 0 over a run in which no mutant was scored. */
  it('is not a pass when nothing was scored, though Stryker exits 0 on that', () => {
    expect(outcomeOf(SUBJECT, true, reportOf('RuntimeError', 'CompileError'))).toBe('did-not-run')
  })

  it('is not survivors when Stryker failed after writing a report with none in it', () => {
    expect(outcomeOf(SUBJECT, false, reportOf('Killed'))).toBe('did-not-run')
  })

  /* ⚠️ **NOTHING TO KILL WAS REPORTED AS EVERY MUTANT KILLED.** A report with an
     empty mutant list — or with every mutant disabled beside the code — passes,
     as decided; but it answered `killed`, so the summary said "every mutant was
     killed" about a module in which no test had been tried at all. Finding #9,
     2026-09-14. It passes under its own name now, and a failed run is still no
     score whatever its report holds. */
  it('passes a module that has nothing left to kill as having nothing to kill, not as a kill', () => {
    expect(outcomeOf(SUBJECT, true, reportOf())).toBe('nothing-to-kill')
    expect(outcomeOf(SUBJECT, true, reportOf('Ignored', 'Ignored'))).toBe('nothing-to-kill')
    expect(outcomeOf(SUBJECT, false, reportOf())).toBe('did-not-run')
  })

  /* ⚠️ **A REPORT ABOUT ANOTHER FILE WAS A PASS FOR THIS ONE.** Nothing asked
     whose report it was, so `{ files: { 'different.ts': { mutants: [] } } }`
     had nothing left to kill and read as every mutant killed — for whichever
     subject had just been run. Found by review on 2026-09-14. Stryker is handed
     ONE file to mutate, so a report of this run is about that file alone:
     another file's name in it — beside the subject or instead of it — makes it
     a report of some other run, and its survivors are not this subject's. */
  it('is a run that did not happen when the report is not about the subject alone', () => {
    expect(outcomeOf(SUBJECT, true, { files: { 'different.ts': { mutants: [] } } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { 'src/y.ts': mutantsOf('Killed') } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, false, { files: { 'src/y.ts': mutantsOf('Survived') } })).toBe('did-not-run')
    expect(
      outcomeOf(SUBJECT, true, { files: { [SUBJECT]: mutantsOf('Killed'), 'src/y.ts': mutantsOf('Killed') } }),
    ).toBe('did-not-run')
  })

  /* Stryker names a file relative to the directory it runs in —
     `normalizeFileName(path.relative(process.cwd(), fileName))`, read from
     `@stryker-mutator/core` 10.0.0's `mutation-test-report-helper.js` — and
     this gate starts it in its own. So a name is compared as the file it
     names, not as the text it is spelt with. */
  it('matches the subject however either side spells the same file', () => {
    expect(outcomeOf(path.resolve(SUBJECT), true, reportOf('Killed'))).toBe('killed')
    expect(outcomeOf(`./${SUBJECT}`, true, { files: { [path.resolve(SUBJECT)]: mutantsOf('Killed') } })).toBe('killed')
  })

  /* ⚠️ **WHAT THE REPORT DID NOT SAY WAS READ AS A CLEAN SWEEP.** Every shape
     below held no survivor and no unscored mutant, which is also what a module
     whose every mutant was killed looks like — so each exited 0. A `files` with
     nothing in it is a run that mutated nothing; an entry that is not a file,
     and a `mutants` that is not a list, are a report this gate cannot read at
     all. None of them is evidence of a kill. */
  it('is a run that did not happen when the report holds nothing this gate can read', () => {
    expect(outcomeOf(SUBJECT, true, { files: {} })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: [] })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: null } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: {} } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: { mutants: 'two of them' } } })).toBe('did-not-run')
    expect(outcomeOf(SUBJECT, true, { files: { [SUBJECT]: { mutants: [null] } } })).toBe('did-not-run')
  })

  /* The eight statuses Stryker writes are `Killed`, `Survived`, `NoCoverage`,
     `Timeout`, `CompileError`, `RuntimeError`, `Ignored` and `Pending` — read
     from `@stryker-mutator/core` 10.0.0. Anything else is a report from
     something this gate has not been taught to read, and a mutant whose fate is
     unknown is not a mutant that was killed. */
  it('is a run that did not happen when a mutant carries a status Stryker does not write', () => {
    for (const status of ['Bogus', 'killed', undefined, null, 3]) {
      expect(outcomeOf(SUBJECT, true, reportOf('Killed', status)), String(status)).toBe('did-not-run')
    }
    expect(outcomeOf(SUBJECT, true, reportOf('Killed', 'Pending'))).toBe('did-not-run')
  })

  /* A survivor is still the finding when the rest of the report is unreadable:
     it is a mutant Stryker positively reported as unkilled. */
  it('is survivors when one is named beside a status it cannot read', () => {
    expect(outcomeOf(SUBJECT, true, reportOf('Survived', 'Bogus'))).toBe('survived')
  })

  it('asks Stryker for the report it reads', () => {
    const config = strykerConfig('src/x.ts', 'v.mjs')

    expect(config.reporters).toContain('json')
    expect(config.jsonReporter).toEqual({ fileName: REPORT })
  })

  /**
   * ⚠️ **SEVEN FAILURES WORE ONE WORD, AND EVERY MESSAGE BUILT ON IT CARRIED
   * NONE OF THEM** (2026-09-17). `did-not-run` is a Stryker that died before
   * writing anything, one that wrote a report of no file, one that wrote a report
   * of the WRONG file, one whose report this gate cannot read, one carrying a
   * status it does not know, one that fell over holding a complete report, and
   * one that scored none of its mutants. A sweep can afford to say only the word,
   * because Stryker's own error is a line above it on the terminal; the merge-base
   * refusal cannot, because it travels as a value into another process and another
   * job. Each phrase is asserted in its own words here — a shared prefix between
   * two of them would let a mutant that picks the wrong reading survive.
   */
  it('says WHICH reading of a run made it a no-score, in words of that reading’s own', () => {
    const why = (exitedCleanly, report, subject = SUBJECT) => noScoreOf(subject, exitedCleanly, report)

    expect(why(false, null)).toBe('wrote no report at all')
    expect(why(true, {})).toBe('wrote a report whose files are missing')
    expect(why(true, { files: null })).toBe('wrote a report whose files are null')
    expect(why(true, { files: [] })).toBe('wrote a report whose files are a list')
    expect(why(true, { files: {} })).toBe('wrote a report of 0 file(s), and this gate sweeps one at a time')
    expect(why(true, { files: { [SUBJECT]: mutantsOf('Killed'), 'src/y.ts': mutantsOf('Killed') } })).toBe(
      'wrote a report of 2 file(s), and this gate sweeps one at a time',
    )
    expect(why(true, { files: { 'src/y.ts': mutantsOf('Killed') } })).toBe('wrote a report of src/y.ts, and this gate swept src/x.ts')
    expect(why(true, { files: { [SUBJECT]: null } })).toBe('wrote a report whose one file carries no list of mutants')
    expect(why(true, { files: { [SUBJECT]: { mutants: 'two of them' } } })).toBe('wrote a report whose one file carries no list of mutants')
    expect(why(true, reportOf('Killed', 'Bogus'))).toBe('wrote a report carrying "Bogus", which is no verdict this gate knows')
    expect(why(true, reportOf('Killed', 'Pending'))).toBe('wrote a report carrying "Pending", which is no verdict this gate knows')
    expect(why(false, reportOf('Killed'))).toBe('did not exit cleanly, and nothing in its report is a survivor or a kill')
    expect(why(true, reportOf('RuntimeError', 'CompileError'))).toBe(
      'scored none of its 2 mutant(s) — every one is Ignored, a CompileError or a RuntimeError',
    )
  })

  /* The first unreadable status is the one named, because naming a later one
     would send a reader to a mutant that is not the one that stopped the read. */
  it('names the first status it could not read, not a later one', () => {
    expect(noScoreOf(SUBJECT, true, reportOf('Killed', 'Bogus', 'Nonsense'))).toBe(
      'wrote a report carrying "Bogus", which is no verdict this gate knows',
    )
  })

  /* A run that SCORED has no such reason, and answering one for it would put a
     failure's words on a file that passed. */
  it('answers nothing at all for a run that scored', () => {
    expect(noScoreOf(SUBJECT, true, reportOf('Killed'))).toBeNull()
    expect(noScoreOf(SUBJECT, false, reportOf('Survived'))).toBeNull()
    expect(noScoreOf(SUBJECT, true, reportOf())).toBeNull()
    expect(noScoreOf(SUBJECT, true, reportOf('Ignored'))).toBeNull()
  })

  /* One reading, asked twice: a reason for every run this gate calls a no-score,
     and none for every run it does not. Two readings of one report that could
     drift apart are one defect waiting, so they are derived together. */
  it('answers a reason for exactly the runs it calls a no-score', () => {
    const reports = [
      null,
      {},
      { files: null },
      { files: {} },
      { files: { 'src/y.ts': mutantsOf('Killed') } },
      { files: { [SUBJECT]: null } },
      reportOf(),
      reportOf('Ignored'),
      reportOf('Killed'),
      reportOf('Killed', 'Bogus'),
      reportOf('Survived'),
      reportOf('RuntimeError'),
    ]

    for (const report of reports) {
      for (const exitedCleanly of [true, false]) {
        const named = noScoreOf(SUBJECT, exitedCleanly, report) !== null
        expect(named, `${JSON.stringify(report)} exited ${exitedCleanly}`).toBe(outcomeOf(SUBJECT, exitedCleanly, report) === 'did-not-run')
      }
    }
  })
})

/**
 * ⚠️ **A `Timeout` COUNTS AS A KILL, AND LOAD TURNS SURVIVORS INTO TIMEOUTS**
 * (measured 2026-09-15). A sharded sweep under an external load average of 50 to
 * 170 passed 85 of 86 files carrying 731 `Timeout` mutants; of 140 wall-clock
 * ones replayed alone, 137 resolved and **42 came back `Survived`**. The 56 at
 * the hit limit were deterministic — 13 of 13 reproduced their exact counter
 * across three concurrency settings and two files. So the two kinds are told
 * apart by Stryker's own words, and only the first is evidence.
 */
describe('which kind of timeout a report says a mutant met', () => {
  it('reads Stryker’s own hit-limit wording as a detection, a reason that is absent as the wall clock, and anything else as one it cannot tell apart', () => {
    /* `determineHitLimitReached` in `@stryker-mutator/api` 10.0.0, verbatim —
       and the counters are not matched, because they are the volatile half of a
       sentence whose words are the evidence. */
    expect(timeoutKindOf('Hit limit reached (330901/330900)')).toBe('hit-limit')
    expect(timeoutKindOf('Hit limit reached (1/0)')).toBe('hit-limit')
    /* JSON leaves an absent reason out, which is what the wall-clock timeout in
       `timeout-decorator.js` writes: the status alone. */
    expect(timeoutKindOf(undefined)).toBe('wall-clock')
    /* And everything else fails closed rather than passing as a kill. */
    for (const reason of [
      'hit limit reached (1/2)',
      'Hit limit reached',
      'Hit limit',
      ' Hit limit reached (1/2)',
      'the Hit limit reached (1/2)',
      '',
      'Error: the test timed out',
      null,
      5,
      { reached: true },
    ]) {
      expect(timeoutKindOf(reason), String(reason)).toBe('unclear')
    }
  })

  it('takes a timeout at the hit limit for a kill needing no settle run, and a wall-clock one for a question', () => {
    const at = (line) => ({ mutatorName: 'StringLiteral', replacement: '""', location: { start: { line, column: 3 }, end: { line, column: 8 } } })
    const report = {
      files: {
        'src/x.ts': {
          mutants: [
            { id: '0', status: 'Timeout', statusReason: 'Hit limit reached (200/199)', ...at(1) },
            { id: '1', status: 'Timeout', ...at(2) },
            { id: '2', status: 'Timeout', statusReason: 'something new', ...at(3) },
            { id: '3', status: 'Killed', ...at(4) },
          ],
        },
      },
    }

    const verdict = settledVerdict('src/x.ts', { exitedCleanly: true, report }, null)

    /* `measured` is the same answer with the mutant-level holes left out — see
       `survivorsAtBase`, which is what asks it. The two readings are one here,
       because what the runs made of the FILE is a kill either way.

       ⚠️ **AND THE TWO WALL-CLOCK TIMEOUTS ARE STILL HOLES, WITH NO SETTLE RUN
       TO FILL THEM.** This expectation read `killed` and nothing else until
       2026-09-17, which said a file with two mutants nothing had decided was a
       file every mutant of which was killed. A settle run is what answers them;
       where there is none, nothing has. See `noVerdictFor`. */
    expect(verdict).toEqual({
      detected: 1,
      unsettled: 2,
      outcome: 'killed',
      measured: 'killed',
      repeated: [],
      /* The same mutants as identities, for the merge-base comparison a repeat
         has had since 2026-09-20 — empty here, as `repeated` is, and asserted
         beside it so the two can never drift into disagreeing about what
         repeated. */
      repeats: [],
      unresolved: [
        '2:3 — there was no settle run, so nothing answered for it',
        '3:3 — there was no settle run, so nothing answered for it',
      ],
      answers: null,
    })
  })

  /* The verdict table in `settledVerdict`, one row at a time. */
  describe('what the two runs of one subject add up to', () => {
    const SUBJECT = 'src/x.ts'
    const at = (line) => ({ mutatorName: 'StringLiteral', replacement: '""', location: { start: { line, column: 3 }, end: { line, column: 8 } } })
    const mutant = (line, status, rest = {}) => ({ id: String(line), status, ...at(line), ...rest })
    const reportOf = (...mutants) => ({ files: { [SUBJECT]: { mutants } } })
    const verdictOf = (first, settle) =>
      settledVerdict(SUBJECT, { exitedCleanly: true, report: reportOf(...first) }, { exitedCleanly: true, report: reportOf(...settle), durationMs: 7 })

    it('keeps a survivor the first run observed, whatever the settle run then said', () => {
      const verdict = verdictOf([mutant(1, 'Survived'), mutant(2, 'Timeout')], [mutant(1, 'Killed'), mutant(2, 'Killed')])

      expect(verdict.outcome).toBe('survived')
      expect(verdict.answers).toEqual({ killed: 1, survived: 0, repeated: 0, unresolved: 0 })
    })

    it('keeps a survivor the settle run alone observed, though the first run called that mutant killed', () => {
      const verdict = verdictOf([mutant(1, 'Timeout'), mutant(2, 'Killed')], [mutant(1, 'Survived'), mutant(2, 'Killed')])

      expect(verdict.outcome).toBe('survived')
      expect(verdict.answers).toEqual({ killed: 0, survived: 1, repeated: 0, unresolved: 0 })
      expect(verdict.repeated).toEqual([])
    })

    it('takes the settle run’s answer where it resolved — a kill, an uncovered mutant, or a detection at the hit limit', () => {
      const resolved = verdictOf([mutant(1, 'Timeout')], [mutant(1, 'Killed')])
      const detected = verdictOf([mutant(1, 'Timeout')], [mutant(1, 'Timeout', { statusReason: 'Hit limit reached (9/8)' })])
      const uncovered = verdictOf([mutant(1, 'Timeout')], [mutant(1, 'NoCoverage')])

      expect(resolved.outcome).toBe('killed')
      expect(detected.outcome).toBe('killed')
      expect(detected.answers).toEqual({ killed: 1, survived: 0, repeated: 0, unresolved: 0 })
      expect(uncovered.outcome).toBe('survived')
      expect(uncovered.answers).toEqual({ killed: 0, survived: 1, repeated: 0, unresolved: 0 })
    })

    it('fails a wall-clock timeout that is a wall-clock timeout again, naming where it sits and any reason it does not know', () => {
      const plain = verdictOf([mutant(1, 'Timeout'), mutant(2, 'Killed')], [mutant(1, 'Timeout'), mutant(2, 'Killed')])
      const strange = verdictOf([mutant(1, 'Timeout')], [mutant(1, 'Timeout', { statusReason: 'wedged' })])

      expect(plain.outcome).toBe('timed-out')
      expect(plain.repeated).toEqual(['1:3'])
      expect(plain.answers).toEqual({ killed: 0, survived: 0, repeated: 1, unresolved: 0 })
      expect(strange.outcome).toBe('timed-out')
      expect(strange.repeated).toEqual([unrecognisedAt('1:3', 'wedged')])
    })

    /* A mutant the settle run said nothing about, and one it crashed on, are
       both unresolved — neither is a kill. A settle report that answers for
       other mutants than the run counted is refused whole, by the identity
       multiset every report is held to (see the whole-sweep cases below), so
       `missing` here is a shape the gate never goes on to believe. */
    it('counts a mutant the settle run did not answer for as unresolved, and one it crashed on as a run with no score', () => {
      const missing = verdictOf([mutant(1, 'Timeout')], [mutant(2, 'Killed')])
      const crashed = verdictOf([mutant(1, 'Timeout')], [mutant(1, 'RuntimeError')])

      expect(missing.answers).toEqual({ killed: 0, survived: 0, repeated: 0, unresolved: 1 })
      expect(crashed.answers).toEqual({ killed: 0, survived: 0, repeated: 0, unresolved: 1 })
      expect(crashed.outcome).toBe('did-not-run')
    })

    /* ⚠️ **AND AN UNRESOLVED MUTANT PASSED, SO LONG AS ANYTHING BESIDE IT IN THE
       SETTLE RUN WAS KILLED** (2026-09-16). The case above crashes on the settle
       run's ONLY mutant, so `outcomeOf` had no kill left to find and the file
       failed for the report's shape rather than for the unresolved mutant — and
       that hid the hole. A real settle run is thousands of kills beside the one
       crash, and `outcomeOf` calls THAT `killed`: with no repeat beside it the
       count of unresolved mutants was printed and then decided nothing.

       Found in this gate's own sweep of 2026-09-16, where 4 wall-clock timeouts
       went to a settle run that came back with 3 055 kills, 19 timeouts and one
       `RuntimeError` — two OOM-killed test runners in its log — so 3 repeated
       and 1 was unresolved. Three repeats failed the file, which is the only
       reason the fourth was not passed over. A settle run's silence about ONE
       mutant is silence: whether a test kills it is unknown, and unknown is what
       the settle run exists to refuse. */
    it('fails a wall-clock timeout the settle run left unresolved, though every mutant beside it was killed', () => {
      const crashed = verdictOf([mutant(1, 'Timeout'), mutant(2, 'Killed')], [mutant(1, 'RuntimeError'), mutant(2, 'Killed')])
      const silent = verdictOf([mutant(1, 'Timeout'), mutant(2, 'Killed')], [mutant(2, 'Killed')])

      expect(crashed.outcome).toBe('did-not-run')
      expect(crashed.answers).toEqual({ killed: 0, survived: 0, repeated: 0, unresolved: 1 })
      expect(silent.outcome).toBe('did-not-run')
      expect(silent.answers).toEqual({ killed: 0, survived: 0, repeated: 0, unresolved: 1 })
    })

    /* A survivor outranks a repeat: a survivor is the finding this gate exists
       to make, and the repeat is still in the line the sweep writes. */
    it('names a file with both a survivor and a repeat a survivor, and keeps the repeat in its counts', () => {
      const verdict = verdictOf(
        [mutant(1, 'Timeout'), mutant(2, 'Timeout')],
        [mutant(1, 'Timeout'), mutant(2, 'Survived')],
      )

      expect(verdict.outcome).toBe('survived')
      expect(verdict.answers).toEqual({ killed: 0, survived: 1, repeated: 1, unresolved: 0 })
      expect(verdict.durationMs).toBe(7)
    })
  })

  it('gives the settle run a looser deadline and a factor of four, and the first run neither', () => {
    /* ⚠️ At this gate's own 20 s and ×1.5, alone, 4 of 32 `App.tsx` mutants still
       repeated and two of the four were real survivors; at 30 s and ×4 none did,
       and the run took about half the time — a repeated timeout costs a full
       deadline plus a runner restart. */
    expect(SETTLE_RUN).toEqual({ timeoutMS: 30_000, timeoutFactor: 4 })
    /* ⚠️ AND NOT A RUNNER COUNT: measured 2026-09-16 on a 4-vCPU Linux
       container, one runner was still settling this file an hour after a 55 min
       first run, restarting on memory; the deadline is what settles a mutant. */
    expect(SETTLE_RUN.concurrency).toBeUndefined()
    expect(FIRST_RUN).toEqual({ timeoutMS: 20_000 })
    expect(strykerConfig('src/x.ts', 'v.mjs', [], SETTLE_RUN)).toMatchObject(SETTLE_RUN)
    const first = strykerConfig('src/x.ts', 'v.mjs')
    expect(first.timeoutMS).toBe(20_000)
    expect(first.concurrency).toBeUndefined()
    expect(first.timeoutFactor).toBeUndefined()
  })
})

/**
 * ⚠️ **TWO SWEEPS IN ONE TREE DESTROYED EACH OTHER** — the same generated file
 * names, the same report, and each deleting `.stryker-tmp` under the other. A
 * second sweep is refused now; these hold that it is refused, that a crashed
 * one does not block for ever, and that nobody releases a lock they do not hold.
 */
describe('one sweep per checkout', () => {
  it('refuses a second sweep while the first holds the lock, naming both, and lets go when released', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const release = acquireLock(lock)

      expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
      const refusal = thrownBy(() => acquireLock(lock))
      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(
        `another sweep (pid ${process.pid}) holds ${lock} — wait for it, or remove the file if no sweep is running`,
      )

      release()
      expect(existsSync(lock)).toBe(false)
      acquireLock(lock)()
      expect(existsSync(lock)).toBe(false)
    })
  })

  /**
   * ⚠️ **A SWEEP IS INTERRUPTED FAR MORE OFTEN THAN IT CRASHES, AND `finally`
   * NEVER SEES A SIGNAL.** The sweep's own `finally` covers a normal end and a
   * throw; Node runs no `finally` for an unhandled `SIGINT`, so a 20-minute run
   * stopped with Ctrl-C left its lock behind — which is precisely when somebody
   * stops one.
   *
   * ⚠️ **AND A LEFTOVER IS NOT MERELY UNTIDY.** `isAlive` is
   * `process.kill(pid, 0)`: liveness with NO identity. While the stale pid
   * stays dead `takeOver` reclaims the lock silently; once the system recycles
   * that pid onto any unrelated process, the next sweep refuses to start,
   * naming a "sweep" that is not one. Found 2026-09-25 on a real lock left from
   * the day before.
   *
   * These drive a REAL child through a REAL signal, because that is the whole
   * mechanism: a handler asserted in-process proves only that it was
   * registered.
   */
  describe('a sweep stopped by a signal lets go of its lock', () => {
    /* ⚠️ **A `file:` URL, NOT A PATH — AND ON WINDOWS THAT IS THE DIFFERENCE
       BETWEEN A TEST AND A TIMEOUT.** An ES module specifier is a URL. A POSIX
       path happens to work as one because it begins with `/`; `D:\a\...` does
       not, so the child died at its first line, never printed `held`, and all
       four cases failed after ten seconds saying *"the holder never took the
       lock"* — about a lock the child had never reached the code to take. Every
       push to `main` was red on the Windows leg from 2026-09-25 for this.
       `check-mutants.mjs` already writes its generated Vitest `include` with
       forward slashes for the same family of reason. */
    const holder = (lock) =>
      `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/check-mutants.mjs')).href)}\n` +
      `acquireLock(${JSON.stringify(lock)})\n` +
      `process.stdout.write('held\\n')\n` +
      `setInterval(() => {}, 1000)\n`

    /** Start a child holding the lock, and wait until it really holds it. */
    const holding = async (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const script = path.join(root, 'holder.mjs')
      writeFileSync(script, holder(lock))
      /* ⚠️ **STDERR IS KEPT, BECAUSE THROWING IT AWAY IS WHAT MADE THE WINDOWS
         FAILURE UNREADABLE.** With `'ignore'` here, a child that cannot even
         import reports exactly the same thing as a child whose `acquireLock`
         is broken: silence, then a timeout naming the lock. The child's own
         words are the whole diagnosis, and they cost one pipe. */
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let cried = ''
      child.stderr.on('data', (chunk) => {
        cried += String(chunk)
      })
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('error', reject)
        child.once('exit', (status, why) =>
          reject(new Error(`the holder exited (${status ?? why}) before taking the lock: ${cried.trim() || '<nothing on stderr>'}`)),
        )
        setTimeout(
          () => reject(new Error(`the holder never took the lock: ${cried.trim() || '<nothing on stderr>'}`)),
          10_000,
        )
      })
      expect(existsSync(lock)).toBe(true)
      return { lock, child }
    }

    const stoppedBy = async (root, signal) => {
      const { lock, child } = await holding(root)
      const code = await new Promise((resolve) => {
        child.once('exit', (status, why) => resolve(status ?? why))
        child.kill(signal)
      })
      return { lock, code }
    }

    it.each([
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ])('releases on %s, and exits 128 plus the signal', async (signal, expected, context) => {
      /* ⚠️ **NOT A PLATFORM QUIRK TO WORK AROUND — THERE IS NO HANDLER TO RUN.**
         Node's own documentation is explicit that on Windows 'SIGINT', 'SIGTERM'
         and 'SIGKILL' cause unconditional termination of the target, so releasing
         the lock on the way out is a mechanism that cannot exist there. What
         Windows relies on instead is `takeOver`, which is what the SIGKILL case
         below and the takeover cases beside it measure — on every platform. */
      if (WINDOWS) return context.skip(WINDOWS_CANNOT.deliverASignal)
      await inScratch('mutants-signal-', async (root) => {
        const { lock, code } = await stoppedBy(root, signal)
        expect(existsSync(lock)).toBe(false)
        /* The shell's own convention, so a caller can still tell an interrupted
           sweep from a failed one. */
        expect(code).toBe(expected)
      })
    })

    it('cannot release on SIGKILL, which is why takeOver still exists', async () => {
      /* ⚠️ **THE HONEST LIMIT, MEASURED RATHER THAN ASSERTED.** A harness memory
         kill is a SIGKILL and no handler runs for one, so the signal release
         NARROWS the window and does not close it. A case that only proved the
         catchable signals would imply a guarantee this does not give. */
      await inScratch('mutants-signal-', async (root) => {
        const { lock } = await stoppedBy(root, 'SIGKILL')
        expect(existsSync(lock)).toBe(true)
      })
    })
  })

  it('takes over a lock whose sweep has gone', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const gone = spawnSync(process.execPath, ['-e', '']).pid
      writeFileSync(lock, `${gone}\n`)

      const release = acquireLock(lock)

      expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`)
      release()
    })
  })

  it('refuses a lock that names no pid, because its holder may still be writing it', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      writeFileSync(lock, '')

      const refusal = thrownBy(() => acquireLock(lock))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(
        `another sweep holds ${lock} — wait for it, or remove the file if no sweep is running`,
      )
      expect(readFileSync(lock, 'utf8')).toBe('')
    })
  })

  /**
   * ⚠️ **TWO SWEEPS COULD BOTH TAKE OVER ONE CRASHED SWEEP'S LOCK, AND THE
   * SECOND DELETED THE FIRST'S.** Each read the stale pid, each found it dead,
   * and each then removed the file and created its own — so the one that got
   * there first held a lock that the other had already unlinked, and both ran
   * in the same tree over the same three generated files. The interleaving is
   * driven here at the only point it can happen: while a contender is asking
   * whether the pid it read is still alive, the rival completes a whole
   * takeover. `alive` answers truthfully about both pids; taking the lock is
   * the side effect.
   */
  it('does not take over a lock that another sweep took while it was looking', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const crashed = spawnSync(process.execPath, ['-e', '']).pid
      const rival = process.pid
      writeFileSync(lock, `${crashed}\n`)
      let rivalHolds = null
      const alive = (asked) => {
        rivalHolds ??= acquireLock(lock, rival)
        return asked === rival
      }

      const refusal = thrownBy(() => acquireLock(lock, 7, alive))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(
        `another sweep (pid ${rival}) holds ${lock} — wait for it, or remove the file if no sweep is running`,
      )
      expect(readFileSync(lock, 'utf8')).toBe(`${rival}\n`)
      rivalHolds()
      expect(existsSync(lock)).toBe(false)
      expect(existsSync(`${lock}.takeover`)).toBe(false)
    })
  })

  /* Only one sweep may be inside a takeover, and the marker that says so is a
     file created exclusively — so a contender that finds one refuses, and
     leaves the lock it was about to remove exactly where it is. */
  it('refuses while another sweep is mid-takeover, and removes nothing', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const marker = `${lock}.takeover`
      const crashed = spawnSync(process.execPath, ['-e', '']).pid
      writeFileSync(lock, `${crashed}\n`)
      writeFileSync(marker, `${process.pid}\n`)

      const refusal = thrownBy(() => acquireLock(lock, 7))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(
        `another sweep is taking ${lock} over — wait for it, or remove ${marker} if no sweep is running`,
      )
      expect(readFileSync(lock, 'utf8')).toBe(`${crashed}\n`)

      /* With the marker gone, the same call takes the crashed sweep's lock and
         leaves no marker of its own. */
      rmSync(marker)
      const release = acquireLock(lock, 7)
      expect(readFileSync(lock, 'utf8')).toBe('7\n')
      expect(existsSync(marker)).toBe(false)
      release()
    })
  })

  /* ⚠️ **A LOCK THAT NAMES NO PID IS NOT A DEAD SWEEP'S**, so nothing is asked
     about it: its holder may be between creating the file and writing its pid,
     and a question about a pid that is not there has no answer worth acting on.
     And one that STOPS naming a pid while it is being taken over is the same
     answer arriving late — the takeover is abandoned and the lock left where it
     is, rather than removed on the strength of the earlier reading. */
  it('asks nothing about a lock that names no pid, and abandons a takeover of one that stops naming one', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const held = `another sweep holds ${lock} — wait for it, or remove the file if no sweep is running`
      const asked = []
      writeFileSync(lock, '')

      const unasked = thrownBy(() => acquireLock(lock, 7, (pid) => (asked.push(pid), false)))

      expect(unasked).toBeInstanceOf(Error)
      expect(unasked.message).toBe(held)
      expect(asked, 'a pid that is not there was asked about').toEqual([])

      const gone = spawnSync(process.execPath, ['-e', '']).pid
      writeFileSync(lock, `${gone}\n`)
      /* Emptied while the takeover marker is held, which is the one moment the
         holder is read a second time. */
      const emptied = thrownBy(() =>
        acquireLock(lock, 7, (pid) => {
          asked.push(pid)
          writeFileSync(lock, '')
          return false
        }),
      )

      expect(emptied).toBeInstanceOf(Error)
      expect(emptied.message).toBe(held)
      expect(asked).toEqual([gone])
      expect(readFileSync(lock, 'utf8'), 'the lock was removed on a reading that had gone stale').toBe('')
      expect(existsSync(`${lock}.takeover`)).toBe(false)

      /* And one that has GONE by then is nobody's: there is nothing to remove
         and nothing to ask about, and the create that comes round again decides
         it. */
      writeFileSync(lock, `${gone}\n`)
      const release = acquireLock(lock, 7, (pid) => {
        asked.push(pid)
        rmSync(lock)
        return false
      })

      expect(asked, 'a pid was asked about after the lock it came from had gone').toEqual([gone, gone])
      expect(readFileSync(lock, 'utf8')).toBe('7\n')
      expect(existsSync(`${lock}.takeover`)).toBe(false)
      release()
    })
  })

  /* ⚠️ **A LOCK THAT CANNOT BE CREATED FOR ANY REASON BUT "IT IS ALREADY THERE"
     IS NOT CONTENTION**, and reading it as contention is a loop: the holder is
     then read from a path where there is nothing, which answers "gone", which
     sends the create round again. That is the failure the symbolic-link case
     recorded — full CPU, nothing printed — reached through the other door. */
  it('throws a lock it cannot create for any reason but one already being there', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    inScratch('mutants-lock-', (root) => {
      const shut = path.join(root, 'shut')
      mkdirSync(shut)
      const stale = path.join(shut, 'stale.lock')
      const gone = spawnSync(process.execPath, ['-e', '']).pid
      writeFileSync(stale, `${gone}\n`)
      chmodSync(shut, 0o500)
      try {
        /* Root writes anywhere, and this would then pass having created one. */
        expect(thrownBy(() => writeFileSync(path.join(shut, 'probe'), 'x'))?.code, 'this case needs a user permissions apply to').toBe('EACCES')

        expect(thrownBy(() => acquireLock(path.join(shut, 'check-mutants.lock'), 7, () => false))?.code).toBe('EACCES')
        /* And the takeover's own marker, made under the same rule: a crashed
           sweep's lock in a directory this one may not write in is that failure,
           never "another sweep is taking it over". */
        expect(thrownBy(() => acquireLock(stale, 7, () => false))?.code).toBe('EACCES')
        expect(existsSync(`${stale}.takeover`)).toBe(false)
      } finally {
        chmodSync(shut, 0o700)
      }
      expect(readFileSync(stale, 'utf8'), 'a lock was removed by a takeover that could not begin').toBe(`${gone}\n`)
    })
  })

  /* ⚠️ **A LOCK ANOTHER USER HOLDS IS HELD.** `kill` refuses it rather than
     answering, and a refusal read as "no such process" takes over a lock whose
     sweep is running — two sweeps in one tree, which is the whole failure this
     lock exists to prevent. Asked of `UNSIGNALLABLE`, which the machine has and
     no ordinary user may signal. */
  it('takes a lock held by a process it may not signal for a live one, not a gone one', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      writeFileSync(lock, `${UNSIGNALLABLE}\n`)
      /* Root signals anything, and this would then pass having asked nothing. */
      expect(thrownBy(() => process.kill(UNSIGNALLABLE, 0))?.code, `this case needs a user that may not signal pid ${UNSIGNALLABLE}`).toBe('EPERM')

      const refusal = thrownBy(() => acquireLock(lock, 7))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(`another sweep (pid ${UNSIGNALLABLE}) holds ${lock} — wait for it, or remove the file if no sweep is running`)
      expect(readFileSync(lock, 'utf8'), 'a live sweep’s lock was taken over').toBe(`${UNSIGNALLABLE}\n`)
    })
  })

  /* ⚠️ **A DESCRIPTOR THE HOLDER READ AND NEVER GAVE BACK IS A SWEEP THAT STOPS
     AFTER A FEW HUNDRED REFUSALS**, and nothing about the refusal itself would
     look wrong until then. Found rather than waited for: what the process has
     open is on show in `/dev/fd`.

     ⚠️ **ONLY THE LOCK'S OWN DESCRIPTORS ARE LOOKED FOR, NOT THE PROCESS'S
     COUNT** (2026-09-18). A worker thread shares its process's table — and
     Stryker runs every test in one — so counting every descriptor read the other
     threads' files opening and closing: in one thread, after the rest of the
     suite, this saw 30 where it expected 33 and failed a dry run for a leak that
     was not there. A descriptor is the lock's when it is the same file, device
     and inode, which nothing else in the process can be. */
  it('gives back the descriptor it read the holder through, whether it takes the lock or is refused by it', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.countDescriptors)
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      /** The descriptors this process holds on the file `file` was, found by what they are rather than by how many there are. */
      const openOn = (file) =>
        readdirSync('/dev/fd').filter((name) => {
          try {
            const at = fstatSync(Number(name))
            return at.dev === file.dev && at.ino === file.ino
          } catch {
            // closed between the listing and the look, which makes it nobody's
            return false
          }
        })
      writeFileSync(lock, `${UNSIGNALLABLE}\n`)
      expect(thrownBy(() => process.kill(UNSIGNALLABLE, 0))?.code, `this case needs a user that may not signal pid ${UNSIGNALLABLE}`).toBe('EPERM')
      const held = statSync(lock)

      for (let at = 0; at < 20; at += 1) expect(thrownBy(() => acquireLock(lock, 7))).toBeInstanceOf(Error)
      const afterRefusals = openOn(held)
      rmSync(lock)
      const release = acquireLock(lock, 7)
      const taken = statSync(lock)
      release()

      expect(afterRefusals, 'a descriptor was left open by every refusal').toEqual([])
      expect(openOn(taken), 'a descriptor was left open by taking and releasing the lock').toEqual([])
    })
  })

  /* ⚠️ **A LOCK THAT GOES BETWEEN THE REFUSED CREATE AND THE READ IS NOBODY'S**,
     and the create that comes round again decides it — nothing is asked about a
     holder that was never read, and no takeover begins for a lock that is not
     there. The window is one line wide, so the read is handed in and made to
     find the lock gone exactly there, the way `alive` drives the takeover's. */
  it('creates the lock again, asking nothing, when it has gone by the time its holder is read', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      writeFileSync(lock, `${process.pid}\n`)
      const reads = []
      const asked = []
      const goneOnRead = (at) => {
        reads.push(at)
        rmSync(at)
        return undefined
      }

      /* Answers "gone" if it is ever asked, so a wrong path runs to its end and
         fails on what it asked rather than on a refusal. */
      const release = acquireLock(lock, 7, (pid) => (asked.push(pid), false), goneOnRead)

      expect(reads).toEqual([lock])
      expect(asked, 'a holder that was never read was asked whether it is alive').toEqual([])
      expect(readFileSync(lock, 'utf8')).toBe('7\n')
      expect(existsSync(`${lock}.takeover`), 'a takeover began for a lock that was not there').toBe(false)
      release()
      expect(existsSync(lock)).toBe(false)
    })
  })

  /* A lock file that has gone by the time it is released — removed by hand
     after a crash, say — is nobody's to remove, and releasing it is not an
     error. */
  it('releases quietly a lock that has already gone', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const release = acquireLock(lock)
      rmSync(lock)

      expect(thrownBy(release)).toBe(null)
      expect(existsSync(lock)).toBe(false)
    })
  })

  /* Only a lock that is GONE is retried. One that is there and cannot be read
     — a lock file its permissions close — is refused with the reason reading
     gave, and never taken over. This was a directory until 2026-09-14, which
     is refused by name now; see the case below. */
  it('refuses a lock it cannot read rather than taking it over', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeAFile)
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      writeFileSync(lock, '1\n')
      chmodSync(lock, 0o000)
      try {
        /* Root reads straight through, and this would then pass having closed nothing. */
        expect(thrownBy(() => readFileSync(lock))?.code, 'this case needs a user file permissions apply to').toBe('EACCES')

        const refusal = thrownBy(() => acquireLock(lock, 7, () => false))

        expect(refusal?.code).toBe('EACCES')
        expect(existsSync(`${lock}.takeover`)).toBe(false)
      } finally {
        chmodSync(lock, 0o600)
      }
      expect(readFileSync(lock, 'utf8')).toBe('1\n')
    })
  })

  /**
   * ⚠️ **A FIFO AT THE LOCK'S PATH HUNG THE SWEEP BEFORE IT PRINTED A WORD.**
   * Creating the lock refuses the name because it exists, and reading the
   * holder then OPENED it to read — which, for a FIFO nobody is writing to,
   * does not return. Found by review on 2026-09-14, from the source. The holder
   * is opened without blocking now and read only when what was opened is a
   * regular file; anything else at that path — a FIFO, a directory — is refused
   * by name, as a link already was, and nothing is taken over.
   *
   * Asked of a child first, with a deadline, for the reason the link case is:
   * a regression fails here by name rather than hanging the suite.
   *
   * The directory is asked before the FIFO, because Windows has the one and not
   * the other: there a directory at the lock's path is refused in these same
   * words (measured 2026-09-15), and only the FIFO half is skipped.
   */
  it('refuses anything at the lock’s path that is not a regular file by name, a FIFO included, rather than hanging on it', (context) => {
    inScratch('mutants-lock-', (root) => {
      const refusedByName = (lock) => {
        const refusal = thrownBy(() => acquireLock(lock, 7, () => false))
        expect(refusal, lock).toBeInstanceOf(Error)
        expect(refusal.message).toBe(
          `${lock} is not a regular file, which no sweep writes — remove it if no sweep is running`,
        )
        expect(existsSync(`${lock}.takeover`)).toBe(false)
      }
      const directory = path.join(root, 'directory.lock')
      mkdirSync(directory)
      refusedByName(directory)

      if (WINDOWS) return context.skip(WINDOWS_CANNOT.makeAFifo)
      const fifo = path.join(root, 'fifo.lock')
      execFileSync('mkfifo', [fifo])
      const script = new URL('./check-mutants.mjs', import.meta.url).href

      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { acquireLock } from ${JSON.stringify(script)}\ntry { acquireLock(${JSON.stringify(fifo)}) } catch { process.exit(3) }`,
        ],
        { timeout: 20_000 },
      )
      expect(child.signal, 'acquireLock never returned').toBe(null)
      expect(child.status).toBe(3)
      refusedByName(fifo)
    })
  })

  /**
   * ⚠️ **A SYMLINK AT THE LOCK'S PATH SPUN FOR EVER, AT FULL CPU, SAYING
   * NOTHING.** Creating the lock refuses any existing name, a dangling link
   * included — but reading it FOLLOWED the link, found nothing, took that for a
   * lock released a moment ago, and tried again. Measured 2026-09-14: the child
   * below was still spinning when it was killed. A gate that hangs looks exactly
   * like a gate that is running.
   *
   * Asked of a child first, with a deadline, so a regression fails here by name
   * rather than hanging the suite; then in-process, where the words are read.
   */
  it('refuses a symbolic link at the lock’s path by name, rather than spinning on it', (context) => {
    /* So the refusal this case holds is POSIX's alone. Measured on Windows
       2026-09-15: a dangling link at the lock's path had its target created
       with this sweep's pid in it, and a live one holding a dead pid was taken
       over — AGENTS.md says so beside the guarantee this narrows. */
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.refuseALink)
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      symlinkSync(path.join(root, 'nowhere', 'pid'), lock)
      const script = new URL('./check-mutants.mjs', import.meta.url).href

      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { acquireLock } from ${JSON.stringify(script)}\ntry { acquireLock(${JSON.stringify(lock)}) } catch { process.exit(3) }`,
        ],
        { timeout: 20_000 },
      )
      expect(child.signal, 'acquireLock never returned').toBe(null)
      expect(child.status).toBe(3)

      const refusal = thrownBy(() => acquireLock(lock))
      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(
        `${lock} is a symbolic link, which no sweep writes — remove it if no sweep is running`,
      )
    })
  })

  it('does not release a lock that another sweep has taken since', () => {
    inScratch('mutants-lock-', (root) => {
      const lock = path.join(root, 'check-mutants.lock')
      const release = acquireLock(lock)
      writeFileSync(lock, '1\n')

      release()

      expect(readFileSync(lock, 'utf8')).toBe('1\n')
    })
  })
})

/**
 * ⚠️ **A FLAG MISSING ITS VALUE WAS A PASS** — a trailing `--only` filtered on
 * the text "undefined" and the run exited 0 over nothing. Refused, with
 * Node's own code for each shape, so a caller can tell them apart.
 */
describe('the command line', () => {
  it('reads the three flags, and defaults to main with no narrowing', () => {
    expect(argumentsOf([])).toEqual({ base: 'main', only: null, requireBase: false })
    expect(argumentsOf(['--base', 'origin/main', '--only', 'gloss', '--require-base'])).toEqual({
      base: 'origin/main',
      only: 'gloss',
      requireBase: true,
    })
  })

  it('refuses a flag missing its value rather than reading past it', () => {
    for (const argv of [['--only'], ['--base'], ['--base', '--require-base']]) {
      expect(thrownBy(() => argumentsOf(argv))?.code, JSON.stringify(argv)).toBe('ERR_PARSE_ARGS_INVALID_OPTION_VALUE')
    }
  })

  it('refuses a flag it does not know, and an argument that is not a flag', () => {
    expect(thrownBy(() => argumentsOf(['--bogus']))?.code).toBe('ERR_PARSE_ARGS_UNKNOWN_OPTION')
    expect(thrownBy(() => argumentsOf(['stray']))?.code).toBe('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL')
  })

  it('refuses an empty value, which would narrow to everything or compare with nothing', () => {
    for (const flag of ['base', 'only']) {
      const refusal = thrownBy(() => argumentsOf([`--${flag}=`]))

      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message).toBe(`--${flag} needs a value, and was given an empty one`)
    }
  })
})

/**
 * ⚠️ **A SHARD SPEC READ LOOSELY IS A SHARD THAT SWEEPS NOTHING** — acceptance
 * criterion (c), 2026-09-14. `7/6` names a shard no plan has, and `1.5/6` and
 * `2/0` are the same miss spelt differently; any of them, read generously,
 * matches no planned file and sweeps nothing. So a spec is refused unless it is
 * a whole index within a whole count of at least one, and each flag is read only
 * by the mode that uses it — a `--base` handed to a shard would otherwise be
 * silently ignored beside the plan's own.
 */
describe('the command line of a sharded sweep', () => {
  it('reads a plan, a shard and an aggregate into modes of their own, and a plain sweep as it was', () => {
    expect(
      argumentsOf(['--plan', 'm.json', '--shards', '6', '--isolate', '2', '--base', 'origin/main', '--require-base']),
    ).toEqual({ mode: 'plan', manifest: 'm.json', shards: 6, isolate: 2, base: 'origin/main', only: null, requireBase: true })
    expect(argumentsOf(['--plan', 'm.json', '--shards', '1', '--only', 'gloss'])).toEqual({
      mode: 'plan',
      manifest: 'm.json',
      shards: 1,
      isolate: 0,
      base: 'main',
      only: 'gloss',
      requireBase: false,
    })
    expect(argumentsOf(['--shard', '2/6', '--manifest', 'm.json', '--results', 'r'])).toEqual({
      mode: 'shard',
      manifest: 'm.json',
      results: 'r',
      index: 2,
      count: 6,
    })
    expect(argumentsOf(['--aggregate', '--manifest', 'm.json', '--results', 'r'])).toEqual({
      mode: 'aggregate',
      manifest: 'm.json',
      results: 'r',
    })
    expect(argumentsOf(['--only', 'x'])).toEqual({ base: 'main', only: 'x', requireBase: false })
  })

  it('refuses a shard spec that is not a whole index within a whole count of at least one, naming it', () => {
    const shard = (spec) =>
      thrownBy(() => argumentsOf([`--shard=${spec}`, '--manifest', 'm.json', '--results', 'r']))?.message
    for (const spec of ['2', '2/', '/6', 'a/6', '2/b', '1.5/6', '2/6.0', '-1/6', '2/-6', '2/6/1', ' 2/6', '2 /6', '0x2/6', '1e1/20', '1/99999999999999999999']) {
      expect(shard(spec), spec).toBe(`--shard needs <index>/<count>, two whole numbers, and was given ${JSON.stringify(spec)}`)
    }
    expect(shard('1/0')).toBe('--shard 1/0: the count must be at least 1')
    expect(shard('0/0')).toBe('--shard 0/0: the count must be at least 1')
    expect(shard('0/6')).toBe('--shard 0/6: the index must be from 1 to 6')
    expect(shard('7/6')).toBe('--shard 7/6: the index must be from 1 to 6')
    /* Both edges are shards. */
    expect(argumentsOf(['--shard', '1/6', '--manifest', 'm', '--results', 'r']).index).toBe(1)
    expect(argumentsOf(['--shard', '6/6', '--manifest', 'm', '--results', 'r']).index).toBe(6)
    expect(argumentsOf(['--shard', '1/1', '--manifest', 'm', '--results', 'r']).count).toBe(1)
  })

  it('refuses a shard count below one or not whole, an isolation not whole, and one that leaves no shard for the rest', () => {
    const plan = (...more) => thrownBy(() => argumentsOf(['--plan', 'm.json', ...more]))?.message
    for (const count of ['0', '1.5', 'six', '6x', '-1']) {
      expect(plan(`--shards=${count}`), count).toBe(`--shards needs a whole number of at least 1, and was given ${JSON.stringify(count)}`)
    }
    for (const isolate of ['-1', '1.5', 'x']) {
      expect(plan('--shards', '6', `--isolate=${isolate}`), isolate).toBe(`--isolate needs a whole number, and was given ${JSON.stringify(isolate)}`)
    }
    expect(plan('--shards', '3', '--isolate', '3')).toBe('--isolate 3 leaves no shard for the other files — it must be less than --shards 3')
    expect(plan('--shards', '1', '--isolate', '1')).toBe('--isolate 1 leaves no shard for the other files — it must be less than --shards 1')
    expect(argumentsOf(['--plan', 'm.json', '--shards', '3', '--isolate', '2']).isolate).toBe(2)
  })

  it('refuses two modes at once, a flag outside the mode that reads it, and a mode missing what it needs', () => {
    const PLANS_OWN = " — a shard and the aggregate read the plan's own from its manifest"
    const cases = [
      [['--plan', 'm', '--shards', '2', '--aggregate'], '--plan and --aggregate are two modes, and one run is one of them'],
      [['--shard', '1/2', '--aggregate'], '--shard and --aggregate are two modes, and one run is one of them'],
      [['--shards', '2'], '--shards is not read by a plain sweep'],
      [['--isolate', '1'], '--isolate is not read by a plain sweep'],
      [['--manifest', 'm'], '--manifest is not read by a plain sweep'],
      [['--results', 'r'], '--results is not read by a plain sweep'],
      [['--plan', 'm', '--shards', '2', '--results', 'r'], '--results is not read by --plan'],
      [['--plan', 'm', '--shards', '2', '--manifest', 'm'], '--manifest is not read by --plan'],
      [['--aggregate', '--manifest', 'm', '--results', 'r', '--shards', '2'], '--shards is not read by --aggregate'],
      [['--shard', '1/2', '--manifest', 'm', '--results', 'r', '--isolate', '1'], '--isolate is not read by --shard'],
      [['--shard', '1/2', '--manifest', 'm', '--results', 'r', '--base', 'origin/main'], `--base is not read by --shard${PLANS_OWN}`],
      [['--aggregate', '--manifest', 'm', '--results', 'r', '--only', 'x'], `--only is not read by --aggregate${PLANS_OWN}`],
      [['--aggregate', '--manifest', 'm', '--results', 'r', '--require-base'], `--require-base is not read by --aggregate${PLANS_OWN}`],
      [['--plan', 'm'], '--plan needs --shards'],
      [['--shard', '1/2', '--results', 'r'], '--shard needs --manifest'],
      [['--shard', '1/2', '--manifest', 'm'], '--shard needs --results'],
      [['--aggregate', '--results', 'r'], '--aggregate needs --manifest'],
      [['--aggregate', '--manifest', 'm'], '--aggregate needs --results'],
    ]

    for (const [argv, words] of cases) {
      const refusal = thrownBy(() => argumentsOf(argv))
      expect(refusal, words).toBeInstanceOf(Error)
      expect(refusal.message).toBe(words)
    }
    for (const flag of ['plan', 'shards', 'isolate', 'shard', 'manifest', 'results']) {
      expect(thrownBy(() => argumentsOf([`--${flag}=`]))?.message, flag).toBe(`--${flag} needs a value, and was given an empty one`)
    }
  })

  /* ⚠️ **`--measure` IS A MODE AND NOT A SWEEP**: one named path, in this
     process's own directory, with no scope of its own — so every flag that names
     a scope is refused to it, as loudly as one handed to a shard. */
  it('reads a measurement of one named file as a mode of its own, and refuses it every flag about a scope', () => {
    const NO_SCOPE = ' — a measurement of one named file has no scope of its own'
    expect(argumentsOf(['--measure', 'src/a.ts', '--into', 'm.json'])).toEqual({
      mode: 'measure',
      measure: 'src/a.ts',
      into: 'm.json',
    })
    const cases = [
      [['--measure', 'src/a.ts'], '--measure needs --into'],
      [['--into', 'm.json'], '--into is not read by a plain sweep'],
      [['--measure', 'src/a.ts', '--into', 'm.json', '--base', 'origin/main'], `--base is not read by --measure${NO_SCOPE}`],
      [['--measure', 'src/a.ts', '--into', 'm.json', '--only', 'x'], `--only is not read by --measure${NO_SCOPE}`],
      [['--measure', 'src/a.ts', '--into', 'm.json', '--require-base'], `--require-base is not read by --measure${NO_SCOPE}`],
      [['--measure', 'src/a.ts', '--into', 'm.json', '--manifest', 'm'], '--manifest is not read by --measure'],
      [['--shard', '1/2', '--manifest', 'm', '--results', 'r', '--into', 'm.json'], '--into is not read by --shard'],
      [['--plan', 'm', '--shards', '2', '--measure', 'src/a.ts'], '--plan and --measure are two modes, and one run is one of them'],
    ]

    for (const [argv, words] of cases) {
      const refusal = thrownBy(() => argumentsOf(argv))
      expect(refusal, words).toBeInstanceOf(Error)
      expect(refusal.message).toBe(words)
    }
    for (const flag of ['measure', 'into']) {
      expect(thrownBy(() => argumentsOf([`--${flag}=`]))?.message, flag).toBe(`--${flag} needs a value, and was given an empty one`)
    }
  })
})

/**
 * ⚠️ **THE SANDBOX COPY DIES ON A SYMLINK, LIVE OR DANGLING**, and it died on
 * three dangling ones on 2026-09-13 before mutating anything — see
 * `symlinksIn`. The links are found now rather than listed, and these hold both
 * halves: that every link is found, and that what is found reaches Stryker.
 */
describe('the links the sandbox copy cannot take', () => {
  it('finds every symlink, live or dangling, and skips node_modules', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mutants-links-'))
    try {
      mkdirSync(path.join(root, 'a'))
      mkdirSync(path.join(root, 'b/deep'), { recursive: true })
      mkdirSync(path.join(root, 'node_modules'))
      writeFileSync(path.join(root, 'a/real.txt'), 'x')
      symlinkSync(path.join(root, 'a/real.txt'), path.join(root, 'a/live'))
      symlinkSync(path.join(root, 'nowhere/lib.so'), path.join(root, 'b/deep/dangling.so'))
      symlinkSync(path.join(root, 'a'), path.join(root, 'node_modules/linked'))

      expect(symlinksIn(root)).toEqual(['a/live', 'b/deep/dangling.so'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hands every link it was given to Stryker to leave out, once each', () => {
    const { ignorePatterns } = strykerConfig('src/x.ts', 'v.mjs', ['b/deep/dangling.so', '.agents'])

    expect(ignorePatterns).toContain('b/deep/dangling.so')
    expect(ignorePatterns.filter((one) => one === '.agents')).toHaveLength(1)
  })
})

/**
 * The mutation gate's own guard.
 *
 * ⚠️ **A DETECTOR THAT HAS QUIETLY STOPPED DETECTING PASSES FOR EVER**, and
 * this one selects its own input — so if the selection silently returns
 * nothing, the gate reports success over an empty run. That is precisely the
 * shape of failure it exists to catch, which would be a poor joke to ship.
 */

describe('what the mutation gate chooses to mutate', () => {
  it('never offers a test file as a subject', (context) => {
    if (OUTSIDE_A_REPOSITORY) return context.skip(NO_REPOSITORY)
    /* Mutating a test asks whether the tests test the tests. Every entry has to
       be production code or the run is measuring itself. */
    for (const file of changedFiles('main')) {
      expect(file).not.toMatch(/\.test\.[cm]?tsx?$|\.test\.mjs$/u)
      expect(file).not.toMatch(/\.testkit\./u)
      expect(file).not.toMatch(/\.d\.ts$/u)
    }
  })

  it('offers only files that exist', (context) => {
    if (OUTSIDE_A_REPOSITORY) return context.skip(NO_REPOSITORY)
    // A deleted file is in the diff and cannot be mutated.
    expect(changedFiles('main').every((f) => f.length > 0)).toBe(true)
  })

  /**
   * ⚠️ **THE VACUOUS-PASS THIS GATE WOULD HAVE HAD IN CI.** A CI checkout is
   * shallow and has everything committed, so `merge-base` fails and the
   * fallback leaves the WORKING TREE as the whole scope — which is clean there.
   * Zero subjects, "nothing changed to mutate", exit 0: the gate scanning
   * nothing and reporting success, on every pull request, which is exactly the
   * failure shape the paragraph at the top of this file calls a poor joke to
   * ship.
   *
   * So the caller that depends on a base says so, and an unresolvable one is a
   * refusal rather than a narrowing. Locally, with no flag, the narrowing stays
   * — there it is a smaller scope and never a wrong one.
   */
  it('refuses an unresolvable base when the caller depends on it, and narrows when it does not', (context) => {
    if (OUTSIDE_A_REPOSITORY) return context.skip(NO_REPOSITORY)
    const refusal = thrownBy(() => changedFiles('no-such-base-exists-here', true))

    expect(refusal).toBeInstanceOf(Error)
    /* Whole, because the refusal is the only place the way OUT of it is written
       down, and a pattern over its opening clause holds however much of the rest
       falls away. */
    expect(refusal.message).toBe(
      'check-mutants: cannot resolve a merge base with "no-such-base-exists-here", so there is nothing to compare ' +
        'against and a run here would mutate nothing while reporting success. Fetch the base branch ' +
        '(`fetch-depth: 0`, or `git fetch origin no-such-base-exists-here`) and try again.',
    )
    /* The same base, without the flag: an answer rather than a refusal. */
    expect(Array.isArray(changedFiles('no-such-base-exists-here'))).toBe(true)
  })

  /* ⚠️ THE NARROWED SCOPE LOST THREE KINDS OF CHANGE. With no base, a file that
     had been `git add`ed was in neither the unstaged list nor the untracked
     one; a name outside printable ASCII came back QUOTED and matched nothing;
     and a name carrying a LINE FEED — which `-z` delivers whole and which is a
     legal file name on every filesystem here — was read as source by neither
     `SRC` nor the test rule, because an unflagged `.` stops at a newline. The
     first two returned `[]` from a scratch repository; the third dropped one
     file out of a list that still looked right, which is the worse shape.
     `changedFiles` reads the working directory's repository, so it runs in a
     child whose working directory is one — `process.chdir` is not this runner's
     to call. */
  it('keeps staged work, non-ASCII names and a name with a line feed in it when there is no base', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.nameALineFeed)
    inScratch('mutants-git-', (root) => {
      const git = (...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
          { cwd: root, stdio: 'pipe' },
        )
      git('init', '-q')
      plant(root, { 'src/kept.ts': 'export const kept = 1\n' })
      git('add', '.')
      git('commit', '-qm', 'start')
      plant(root, { 'src/staged.ts': 'export const staged = 1\n' })
      git('add', 'src/staged.ts')
      /* Written as a code point rather than an escape: an editor, a patch or a
         tool that decodes JSON can turn `\n` in a source file into a real line
         break, and this string would then be the one thing it cannot be. */
      const feed = `src/we${String.fromCharCode(10)}ird.ts`
      plant(root, {
        'src/café.ts': 'export const cafe = 1\n',
        [feed]: 'export const weird = 1\n',
        'src/kept.ts': 'export const kept = 2\n',
      })

      const script = new URL('./check-mutants.mjs', import.meta.url).href
      const printed = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { changedFiles } from ${JSON.stringify(script)}\nprocess.stdout.write(JSON.stringify(changedFiles('no-such-base')))`,
        ],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )

      expect(JSON.parse(printed).sort()).toEqual([feed, 'src/café.ts', 'src/kept.ts', 'src/staged.ts'].sort())
    })
  })

  /* ⚠️ **THE CASES ABOVE ASK WHATEVER REPOSITORY THE RUNNER IS STANDING IN, AND
     A SWEEP STANDS IN STRYKER'S SANDBOX**, where git answers for the enclosing
     checkout and lists nothing under an ignored directory — so every assertion
     over the answer held whatever this function did. The one case that does
     reach a repository of its own reaches it through a CHILD process, which
     carries no mutant and so can object to none either. This asks a repository
     of its own IN PROCESS, with every list git keeps in a state of its own:
     committed since the base, unstaged, staged, untracked, and a file staged for
     deletion, which is in the diff and cannot be mutated. */
  it('reads every list git keeps for the checkout it is given, and falls back to main when no base is named', () => {
    inScratch('mutants-changed-', (root) => {
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      plant(root, {
        'src/based.ts': 'export const based = 1\n',
        'src/gone.ts': 'export const gone = 1\n',
        'src/edited.ts': 'export const edited = 1\n',
      })
      git('add', '.')
      git('commit', '-qm', 'base')
      git('checkout', '-qb', 'work')
      plant(root, { 'src/committed.ts': 'export const committed = 1\n' })
      git('add', 'src/committed.ts')
      git('commit', '-qm', 'work')
      plant(root, { 'src/edited.ts': 'export const edited = 2\n', 'src/staged.ts': 'export const staged = 1\n' })
      git('add', 'src/staged.ts')
      git('rm', '-q', 'src/gone.ts')
      plant(root, {
        'src/untracked.ts': 'export const untracked = 1\n',
        'src/untracked.test.ts': "import './untracked'\n",
        'notes.md': 'not source at all\n',
      })
      const uncommitted = ['src/edited.ts', 'src/staged.ts', 'src/untracked.ts']

      expect(changedFiles('main', false, root).sort()).toEqual([...uncommitted, 'src/committed.ts'].sort())
      /* The base is what the commit since it is read against, so with none there
         is no committed change here — only the working tree and the index. */
      expect(changedFiles('no-such-base', false, root).sort()).toEqual([...uncommitted].sort())
      /* And asked with no base at all it compares against `main`, which is the
         branch CI's own default names. */
      expect(changedFiles(undefined, false, root).sort()).toEqual([...uncommitted, 'src/committed.ts'].sort())
    })
  })

  /* ⚠️ **REAL FILES, AND THEY USED TO BE A CAPABILITY'S.** This pair read
     `capabilities/circle/`, which `pnpm verify:without` deletes in its copy —
     so the two cases threw ENOENT the first time the deletion proof chose
     `circle`, for a defect in neither the gate nor the removal. A KERNEL pair
     cannot be cut: the proof asserts no file under `src/kernel/` changes. */
  it('follows imports rather than matching names', () => {
    /* ⚠️ **NAME MATCHING WOULD REPORT MOST OF THIS REPOSITORY AS UNTESTED.**
       `panes.ts` is covered by `commands.test.ts`. A gate that looked for
       `panes.test.ts` would find none — it exists, and it is not the only
       cover — call the module uncovered, and turn every one of its mutants
       into a finding nobody can act on. */
    const found = testsCovering(['src/kernel/ui/panes.ts'], ['src/kernel/ui/commands.test.ts'])
    expect(found).toEqual(['src/kernel/ui/commands.test.ts'])
  })

  it('does not claim a test covers a module it never imports', () => {
    const found = testsCovering(['src/kernel/ui/panes.ts'], ['src/kernel/core/marks.test.ts'])
    expect(found).toEqual([])
  })

  /* ⚠️ `from\s+'…'` WAS THE WHOLE READING OF AN IMPORT. A test that loads its
     subject with `await import(…)` — ten in this tree, `node/lock.test.ts`
     among them — covered nothing; double quotes and a bare `import './x'` went
     the same way; and `from '…'` in a comment or a string counted. */
  it('reads imports as the language does — dynamic, double-quoted and bare — and nothing that only looks like one', () => {
    inScratch('mutants-imports-', (root) => {
      const at = plant(root, {
        'leaf.ts': 'export const leaf = 1\n',
        'side.ts': 'export {}\n',
        'later.ts': 'export const later = 1\n',
        'ghost.ts': 'export const ghost = 1\n',
        'shape.ts': 'export interface Shape { a: number }\n',
        'probe.test.ts':
          "import './side'\n" +
          'import { leaf } from "./leaf"\n' +
          "import type { Shape } from './shape'\n" +
          "// import { ghost } from './ghost'\n" +
          "const text = \"import { ghost } from './ghost'\"\n" +
          "export const load = async () => (await import('./later')).later\n",
      })
      const test = at['probe.test.ts']

      expect(importsOf(test).sort()).toEqual([at['later.ts'], at['leaf.ts'], at['side.ts']].sort())
      for (const covered of ['leaf.ts', 'side.ts', 'later.ts']) {
        expect(testsCovering([at[covered]], [test]), covered).toEqual([test])
      }
      for (const uncovered of ['ghost.ts', 'shape.ts']) {
        expect(testsCovering([at[uncovered]], [test]), uncovered).toEqual([])
      }
    })
  })

  /* ⚠️ TWO CLAUSES WERE STILL READ WRONG AFTER THE PARSE LANDED. A dynamic
     import whose specifier is a TEMPLATE — `await import(`./later`)`, which the
     language resolves exactly as it does the quoted form — was invisible, so a
     test that loads its subject that way covered nothing; and `import type x =
     require('./ghost')` counted, though the clause is erased and runs nothing a
     mutant could change. Measured 2026-09-13 against the reading itself. */
  it('reads a dynamic import written as a template, and not a type-only import-equals', () => {
    inScratch('mutants-imports-', (root) => {
      const at = plant(root, {
        'later.ts': 'export const later = 1\n',
        'ghost.ts': 'export type Ghost = { a: number }\n',
        'probe.test.ts':
          'export const load = async () => (await import(`./later`)).later\n' +
          "import type ghost = require('./ghost')\n" +
          'export type G = ghost.Ghost\n',
      })
      const test = at['probe.test.ts']

      expect(importsOf(test)).toEqual([at['later.ts']])
      expect(testsCovering([at['later.ts']], [test])).toEqual([test])
      expect(testsCovering([at['ghost.ts']], [test])).toEqual([])
    })
  })

  /* ⚠️ EVERY CANDIDATE COUNTED. `./foo` covered `foo.ts` AND `foo/index.ts`,
     and a directory's `index.tsx` or `index.mjs` was never tried. */
  it('resolves an import to the one file that answers it, a directory’s index.tsx and index.mjs included', () => {
    inScratch('mutants-resolve-', (root) => {
      const at = plant(root, {
        'foo.ts': 'export const foo = 1\n',
        'foo/index.ts': 'export const foo = 2\n',
        'bar/index.tsx': 'export const bar = 1\n',
        'baz/index.mjs': 'export const baz = 1\n',
        'a.test.ts': "import { foo } from './foo'\nimport { bar } from './bar'\nimport { baz } from './baz'\n",
      })
      const test = at['a.test.ts']

      expect(testsCovering([at['foo.ts']], [test])).toEqual([test])
      expect(testsCovering([at['foo/index.ts']], [test])).toEqual([])
      expect(testsCovering([at['bar/index.tsx']], [test])).toEqual([test])
      expect(testsCovering([at['baz/index.mjs']], [test])).toEqual([test])
    })
  })

  /* ⚠️ THE ORDER WAS `.ts, .tsx, .mjs`, AND THIS PROJECT'S RESOLVER READS
     `.mjs` FIRST. Vitest resolves through Vite, whose `resolve.extensions`
     default is `['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']` —
     nothing here overrides it. MEASURED 2026-09-13 by planting both files and
     asking a vitest run which one it loaded: `./which` gave `mjs` beside a
     `which.ts`, `./two` gave `js` beside a `two.ts`, and `./dir` gave
     `dir-mjs` beside a `dir/index.ts`. So a subject the tests do NOT run was
     the one this gate mutated, against tests that could not object to it. */
  it('picks the file this project’s own resolver picks when several answer one specifier', () => {
    inScratch('mutants-precedence-', (root) => {
      const at = plant(root, {
        'one.mjs': 'export const one = 1\n',
        'one.ts': 'export const one = 2\n',
        'two.js': 'export const two = 1\n',
        'two.ts': 'export const two = 2\n',
        'three.mts': 'export const three = 1\n',
        'three.ts': 'export const three = 2\n',
        'four.jsx': 'export const four = 1\n',
        'four.tsx': 'export const four = 2\n',
        'dir/index.mjs': 'export const five = 1\n',
        'dir/index.ts': 'export const five = 2\n',
        'a.test.ts':
          "import { one } from './one'\nimport { two } from './two'\nimport { three } from './three'\n" +
          "import { four } from './four'\nimport { five } from './dir'\n",
      })
      const test = at['a.test.ts']

      for (const won of ['one.mjs', 'two.js', 'three.mts', 'four.jsx', 'dir/index.mjs']) {
        expect(testsCovering([at[won]], [test]), won).toEqual([test])
      }
      for (const lost of ['one.ts', 'two.ts', 'three.ts', 'four.tsx', 'dir/index.ts']) {
        expect(testsCovering([at[lost]], [test]), lost).toEqual([])
      }
    })
  })

  it('sees UNTRACKED test files, which is where new work lives', (context) => {
    if (OUTSIDE_A_REPOSITORY) return context.skip(NO_REPOSITORY)
    /* ⚠️ **`git ls-files` ALONE MISSED EVERY ONE.** On the branch that
       motivated this gate the whole of `src/capabilities/circle/` was
       untracked, so the selector found none of its tests, concluded the changed
       modules had no coverage, and printed a confident empty run. A gate that
       measures nothing looks exactly like a gate that passed.

       Asserted through the real selector on the real repository: whatever is
       untracked right now, every test file it reports must exist. */
    const { execFileSync } = require('node:child_process')
    const untracked = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', 'src'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => /\.test\.(ts|tsx)$/u.test(f))

    if (untracked.length === 0) return
    /* Those files are importable subjects for `testsCovering`, which is the
       thing that broke: it was handed a list that did not contain them.

       ASSERTED ON WHATEVER IS UNTRACKED, NOT ON ONE NAMED MODULE. This used to
       ask whether the untracked files covered the circle's `store.ts` — true
       on the day it was written, when that module's new test was the
       untracked one, and false on any tree whose only untracked test is about
       something else: the gate was then reported broken by an unrelated file
       sitting in the working copy. Each untracked test names, by its own
       imports, a module that exists; handed that module, the selector must
       find the test. The module is read with `importsOf`, so this cannot keep
       a second, older reading of an import alive beside it. */
    for (const test of untracked) {
      const subject = importsOf(test).find((candidate) => !/\.test\.[cm]?tsx?$|\.testkit\./u.test(candidate))
      if (subject === undefined) continue
      expect(testsCovering([subject], untracked), `${test} imports ${subject}`).toContain(test)
    }
  })

  /* ⚠️ A COMPONENT RENDERED ONLY BY ITS PARENT'S TESTS WAS NEVER MUTATED.
     `PaneGroup.tsx` is imported by no test; `Settings.tsx` imports it and
     `Settings.test.tsx` renders `Settings`. The gate printed "no test imports
     it" and exited 0, while coverage counted the lines run. */
  it('follows a module tested only through the one that renders it, and names that one', () => {
    const importers = reverseImports(['src/kernel/ui/pane/Settings.tsx', 'src/kernel/ui/pane/SidePane.tsx'])

    const reached = coveringTests('src/kernel/ui/pane/PaneGroup.tsx', ['src/kernel/ui/pane/Settings.test.tsx'], importers)

    expect(reached.tests).toEqual(['src/kernel/ui/pane/Settings.test.tsx'])
    expect(reached.through).toEqual(['src/kernel/ui/pane/Settings.tsx'])
  })

  it('keeps a direct importer and climbs no further', () => {
    const importers = reverseImports(['src/kernel/ui/pane/Settings.tsx'])

    expect(
      coveringTests('src/kernel/ui/pane/Settings.tsx', ['src/kernel/ui/pane/Settings.test.tsx'], importers),
    ).toEqual({ tests: ['src/kernel/ui/pane/Settings.test.tsx'], through: [] })
  })

  it('reaches nothing when no chain of imports ends in a test', () => {
    const importers = reverseImports(['src/kernel/ui/pane/Settings.tsx'])

    expect(
      coveringTests('src/kernel/ui/pane/PaneGroup.tsx', ['src/kernel/ui/state.test.ts'], importers),
    ).toEqual({ tests: [], through: [] })
  })

  /* ⚠️ THE GRAPH USED THE RULE FOR WHAT MAY BE MUTATED, so a test kit — never a
     subject — was never a module a test could reach anything THROUGH. */
  it('climbs through a test kit, which is never a subject but is how tests wire modules up', () => {
    expect(
      allSourceFiles(['src/a.ts', 'src/a.testkit.ts', 'src/a.test.ts', 'src/a.d.ts', 'scripts/b.mjs', 'docs/c.ts']),
    ).toEqual(['src/a.ts', 'src/a.testkit.ts', 'scripts/b.mjs'])

    inScratch('mutants-kit-', (root) => {
      const at = plant(root, {
        'leaf.ts': 'export const leaf = 1\n',
        'world.testkit.ts': "export { leaf } from './leaf'\n",
        'world.test.ts': "import { leaf } from './world.testkit'\n",
      })

      const reached = coveringTests(at['leaf.ts'], [at['world.test.ts']], reverseImports([at['world.testkit.ts']]))

      expect(reached).toEqual({
        tests: [at['world.test.ts']],
        through: [throughName(at['world.testkit.ts'])],
      })
    })
  })

  /* The source-text rule follows the same reach: a test that reads files and
     renders the subject through its parent blocks it exactly as a direct one
     would. Both tests are planted — this used to name two real test files and
     assert that one of them blocked `a.ts`, which depended on a string neither
     file reads and would have gone on passing after the reading rule changed
     underneath it. */
  it('blocks a subject whose reaching tests read source text', () => {
    inScratch('mutants-reach-', (root) => {
      const at = plant(root, {
        'reads.test.mjs': "import { readFileSync } from 'node:fs'\nreadFileSync('a.ts', 'utf8')\n",
        'plain.test.mjs': "import { it } from 'vitest'\nit('reads nothing', () => {})\n",
      })
      const reading = at['reads.test.mjs']
      const plain = at['plain.test.mjs']

      expect(
        subjectsRead(['a.ts', 'b.ts'], [reading, plain], (subject) =>
          subject === 'a.ts' ? [reading] : [plain],
        ),
      ).toEqual(['a.ts'])
    })
  })

  /* ⚠️ **A SUBJECT A TEST READ THE TEXT OF WAS NEVER MUTATED AT ALL** (decided
     2026-09-14). The answer is per TEST now, not per subject: which covering
     tests read the subject's own file — so a sweep leaves exactly those out of
     the subject's run and mutates it against the rest. A test that reads one
     subject's file is no reader of the other's. */
  it('names, for each subject, the covering tests that read its own file and no other test', () => {
    inScratch('mutants-readers-', (root) => {
      const reads = (name) =>
        "import { readFileSync } from 'node:fs'\nimport './a'\nimport './b'\n" +
        `readFileSync(new URL('./${name}', import.meta.url), 'utf8')\n`
      const at = plant(root, {
        'a.ts': "export const a = 'a'\n",
        'b.ts': "export const b = 'b'\n",
        'reads-a.test.mjs': reads('a.ts'),
        'reads-b.test.mjs': reads('b.ts'),
        'plain.test.mjs': "import './a'\nimport './b'\n",
      })
      const tests = [at['reads-a.test.mjs'], at['reads-b.test.mjs'], at['plain.test.mjs']]

      const readers = sourceReaders([at['a.ts'], at['b.ts'], path.join(root, 'c.ts')], tests, () => tests)

      expect([...readers.entries()]).toEqual([
        [at['a.ts'], [at['reads-a.test.mjs']]],
        [at['b.ts'], [at['reads-b.test.mjs']]],
      ])
    })
  })

  /* ⚠️ **THIS FILE HAS STOPPED THE GATE MUTATING ITSELF TWICE.** Once because a
     name spelled was taken for a name read (2026-09-13, see `pathsRead`), and
     once because a destructured `file` inherited every value of every
     `subjects` in this file (2026-09-14, see `leftOutOf`). Either way the sweep
     saw a test reading the gate's source, and left this file — the gate's only
     covering test — out of the gate's own run. So it is asserted, not
     remembered. */
  it('does not take this file for a reader of the gate’s own source', () => {
    expect(
      subjectsRead(['scripts/check-mutants.mjs'], ['scripts/check-mutants.test.mjs'], () => ['scripts/check-mutants.test.mjs']),
    ).toEqual([])
  })

  /**
   * ⚠️ **A NAME SPELLED ANYWHERE COUNTED AS A NAME THAT WAS READ.** Every
   * string in a test that read ANY file counted, so a `describe('leaf.mjs')`
   * beside a `readFileSync` of an unrelated JSON file dropped `leaf.mjs` from
   * the sweep. Measured over this repository on 2026-09-13: of the 24 subjects
   * blocked where a reading test also reaches them, THIRTEEN were named by a
   * spawn argument, an expectation, a comment-like message or — twice — by the
   * very filter that EXCLUDES the file from the walk being read.
   * `scripts/check-mutants.mjs` was one of them, so the mutation gate had
   * silently stopped mutating itself.
   *
   * A name counts now only where it can reach a read: through a variable, a
   * helper's parameter, or the collection a loop reads over. What that cannot
   * see is a path built with no literal in it — a walk over a directory — and
   * that case stays the loud one, as before.
   */
  it('blocks a subject only where its name can reach a read, not wherever it is spelled', () => {
    inScratch('mutants-reads-', (root) => {
      const at = plant(root, {
        'data.json': '{}\n',
        'titled.mjs': 'export const titled = 1\n',
        'spawned.mjs': 'export const spawned = 1\n',
        'expected.mjs': 'export const expected = 1\n',
        'held.mjs': 'export const held = 1\n',
        'helped.mjs': 'export const helped = 1\n',
        'looped.mjs': 'export const looped = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "describe('titled.mjs', () => {\n" +
          "  it('runs ./spawned.mjs', () => {\n" +
          "    spawnSync(process.execPath, [new URL('./spawned.mjs', import.meta.url).pathname])\n" +
          "    expect(listed).toEqual(['expected.mjs'])\n" +
          "    readFileSync(new URL('./data.json', import.meta.url), 'utf8')\n" +
          '  })\n' +
          '})\n' +
          "const SOURCE = new URL('./held.mjs', import.meta.url)\n" +
          "readFileSync(SOURCE, 'utf8')\n" +
          "const sourceOf = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')\n" +
          "sourceOf('./helped.mjs')\n" +
          "for (const name of ['./looped.mjs']) readFileSync(new URL(name, import.meta.url), 'utf8')\n",
      })
      const test = at['probe.test.mjs']
      const named = ['titled.mjs', 'spawned.mjs', 'expected.mjs']
      const read = ['held.mjs', 'helped.mjs', 'looped.mjs']

      expect(subjectsRead([...named, ...read].map((f) => at[f]), [test], () => [test])).toEqual(
        read.map((f) => at[f]),
      )
    })
  })

  /* ⚠️ READING SOME SOURCE IS NOT READING THIS SOURCE. `sentenceCorpus.test.ts`
     reads its corpus file as text and imports `sentenceOf.ts`, whose text it
     never reads — instrumenting `sentenceOf.ts` cannot touch what it compares. */
  it('blocks a subject only where a reading test names that subject’s file', () => {
    const reading = 'src/kernel/ui/reader/wordSnap/sentenceCorpus.test.ts'
    const corpus = 'src/kernel/ui/reader/wordSnap/sentenceCorpus.ts'
    const policy = 'src/kernel/ui/reader/wordSnap/sentenceOf.ts'

    expect(subjectsRead([corpus, policy], [reading], () => [reading])).toEqual([corpus])
  })

  /* ⚠️ SEVEN OF TEN BLOCKS ON 2026-09-13 NAMED NOTHING THE TEST READ: an
     import, an event name, a pane id, a sibling test file, another directory's
     `index.ts`. Each dropped a changed module from the sweep and exited 0. */
  it('does not take an import, a lookalike string or another directory’s file for naming the subject', () => {
    inScratch('mutants-names-', (root) => {
      const at = plant(root, {
        'leaf.mjs': 'export const leaf = 1\n',
        'data.json': '{}\n',
        'companion/index.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import { leaf } from '../leaf.mjs'\n" +
          "vi.mock('../gloss.ts')\n" +
          "const data = readFileSync(new URL('../data.json', import.meta.url), 'utf8')\n" +
          "const event = 'gloss.sentence'\n" +
          "const pane = 'settings'\n" +
          "const sibling = 'scripts/check-mutants.test.mjs'\n" +
          "const own = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')\n" +
          '// reads commands.ts, as a comment says\n',
      })
      const test = at['companion/index.test.mjs']
      const subjects = [
        at['leaf.mjs'],
        path.join(root, 'gloss.ts'),
        'src/kernel/core/settings.ts',
        'scripts/check-mutants.mjs',
        'src/kernel/index.ts',
        'src/kernel/ui/commands.ts',
      ]

      expect(subjectsRead(subjects, [test], () => [test])).toEqual([])
    })
  })

  /* This case let a BARE name block a file of that name anywhere until
     2026-09-14 — `${HERE}plugin.ts` blocked `anywhere/plugin.ts`, which is the
     defect the next case is about. The directory `HERE` names is known, so the
     path is known, and only the file it reaches is blocked. */
  it('still blocks a subject that a reading test names by a path reaching it, and not its namesake elsewhere', () => {
    inScratch('mutants-names-', (root) => {
      const at = plant(root, {
        'a/reads.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "const HERE = new URL('.', import.meta.url).pathname\n" +
          "readFileSync(new URL('./state.ts', import.meta.url), 'utf8')\n" +
          "readFileSync('src/kernel/ui/pane/SidePane.tsx', 'utf8')\n" +
          'readFileSync(`${HERE}plugin.ts`, "utf8")\n',
      })
      const test = at['a/reads.test.mjs']
      const subjects = [
        path.join(root, 'a/state.ts'),
        path.join(root, 'b/state.ts'),
        'src/kernel/ui/pane/SidePane.tsx',
        'src/app/pane/SidePane.tsx',
        path.join(root, 'a/plugin.ts'),
        'anywhere/plugin.ts',
      ]

      expect(subjectsRead(subjects, [test], () => [test])).toEqual([
        path.join(root, 'a/state.ts'),
        'src/kernel/ui/pane/SidePane.tsx',
        path.join(root, 'a/plugin.ts'),
      ])
    })
  })

  /**
   * ⚠️ **A FILE NAME ALONE BLOCKED EVERY FILE OF THAT NAME, WHATEVER DIRECTORY
   * THE READ WAS BUILT FROM.** Each string reaching a read was matched on its
   * own, so `path.join('fixtures', 'leaf.mjs')` offered `leaf.mjs` bare, and a
   * bare name was taken at its word: a test reading its fixture stopped the
   * `src/leaf.mjs` it imports — a different file — from ever being mutated, and
   * the sweep exited 0. Finding #5, reproduced by an independent review on
   * 2026-09-14. The same shape was live in this tree: `wire.contract.test.ts`
   * reads its own `new URL('wire.ts', HERE)` and blocked `peer/lib/wire.ts`.
   *
   * The path is resolved now as the test resolves it — the first read below
   * reaches `fixtures/leaf.mjs` from the working directory, and is blocked for
   * THAT — and a path with any part that cannot be known, here the directory a
   * helper returns, blocks nothing at all.
   */
  it('resolves a read path built from parts as the test would, and blocks nothing on a file name alone', () => {
    inScratch('mutants-parts-', (root) => {
      const at = plant(root, {
        'src/leaf.mjs': 'export const leaf = 1\n',
        'src/leaf.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import path, { join } from 'node:path'\n" +
          "import { leaf } from './leaf.mjs'\n" +
          "readFileSync(path.join('fixtures', 'leaf.mjs'), 'utf8')\n" +
          "readFileSync(join(fixturesOf(), 'leaf.mjs'), 'utf8')\n" +
          'readFileSync(`${fixturesOf()}leaf.mjs`, "utf8")\n' +
          "readFileSync(new URL('../leaf.mjs', fixturesOf()), 'utf8')\n",
      })
      const test = at['src/leaf.test.mjs']
      const subject = at['src/leaf.mjs']

      expect(testsCovering([subject], [test])).toEqual([test])
      expect(subjectsRead([subject, 'fixtures/leaf.mjs'], [test], () => [test])).toEqual(['fixtures/leaf.mjs'])
    })
  })

  /* Every way this tree builds a read path, each reaching a file of its own, so
     a way read wrongly fails by name — and beside each file its namesake one
     directory off, which no read reaches. The last reads reach nothing a
     subject can be: a root or a base nobody can name, however many directories
     follow it; a base that is a path rather than a URL, which throws in the
     test; and a call given no path at all. */
  it('resolves each way this tree spells a read path, and tells the file from its namesake one directory off', () => {
    inScratch('mutants-spellings-', (root) => {
      const at = plant(root, {
        'src/probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import path, { dirname, join, resolve } from 'node:path'\n" +
          "import { fileURLToPath } from 'node:url'\n" +
          'const HERE = dirname(fileURLToPath(import.meta.url))\n' +
          "const BASE = new URL('./based/', import.meta.url)\n" +
          "readFileSync(join(HERE, 'fixtures', 'joined.mjs'), 'utf8')\n" +
          "readFileSync(path.resolve(HERE, '..', 'resolved.mjs'), 'utf8')\n" +
          "readFileSync(resolve(somewhere(), '/absolute/reset.mjs'), 'utf8')\n" +
          'readFileSync(`${process.cwd()}/cwd.mjs`, "utf8")\n' +
          "readFileSync(new URL('url.mjs', BASE), 'utf8')\n" +
          "readFileSync(new URL('./named.mjs', import.meta.url).pathname, 'utf8')\n" +
          "readFileSync(join(somewhere(), 'kept', 'suffix.mjs'), 'utf8')\n" +
          "readFileSync(new URL('./kept/unbased.mjs', somewhere()), 'utf8')\n" +
          'readFileSync(`${somewhere()}/kept/templated.mjs`, "utf8")\n' +
          "readFileSync(new URL('kept/thrown.mjs', HERE), 'utf8')\n" +
          "readFileSync(fileURLToPath(), 'utf8')\n" +
          "readFileSync(somewhere().pathname, 'utf8')\n",
      })
      const test = at['src/probe.test.mjs']
      const under = (name) => path.join(root, name)
      const reached = [
        under('src/fixtures/joined.mjs'),
        under('resolved.mjs'),
        '/absolute/reset.mjs',
        'cwd.mjs',
        under('src/based/url.mjs'),
        under('src/named.mjs'),
      ]
      const namesakes = [
        under('src/joined.mjs'),
        under('src/resolved.mjs'),
        under('absolute/reset.mjs'),
        under('src/cwd.mjs'),
        under('src/url.mjs'),
        under('named.mjs'),
        under('kept/suffix.mjs'),
        under('kept/unbased.mjs'),
        under('kept/templated.mjs'),
        under('kept/thrown.mjs'),
        under('src/kept/thrown.mjs'),
      ]

      expect(subjectsRead([...reached, ...namesakes], [test], () => [test])).toEqual(reached)
    })
  })

  /* ⚠️ **A URL BUILT FROM MANY NAMES MULTIPLIED THEM** (fifth review,
     2026-09-14): `new URL(spec, base)` took every value each side could have, so
     65 of one against 65 of the other made 4 225 paths — where the same expansion
     through `path.join` had already answered "a part that cannot be known". Past
     the bound that is the answer here too, and it blocks nothing. */
  it('answers that it cannot know a read whose URL is built from more names than it will expand', () => {
    inScratch('mutants-bound-', (root) => {
      const assigned = (name, values) => values.map((one) => `${name} = ${JSON.stringify(one)}\n`).join('')
      const specs = [...Array.from({ length: 65 }, (_, at) => `./spec-${at}.mjs`), './leaf.mjs']
      const bases = [...Array.from({ length: 65 }, (_, at) => `./base-${at}/`), './']
      const at = plant(root, {
        'leaf.mjs': 'export const leaf = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          'let spec\nlet base\n' +
          assigned('spec', specs) +
          assigned('base', bases) +
          'readFileSync(new URL(spec, new URL(base, import.meta.url)), "utf8")\n',
      })

      expect(subjectsRead([at['leaf.mjs']], [at['probe.test.mjs']], () => [at['probe.test.mjs']])).toEqual([])
    })
  })

  /* The three ways a name gets its value that the probes above do not spell: a
     pattern that takes one element of a collection — and takes the whole
     collection with it, since which element is which is not decided here — a
     helper written as a function DECLARATION, and a parameter with no argument
     against it. A hole in a pattern binds nothing, and an argument past the end
     of a parameter list lands on nothing. */
  it('follows a name bound by destructuring, by a declared helper’s parameter, and past a hole or a spare argument', () => {
    inScratch('mutants-bound-', (root) => {
      const at = plant(root, {
        'first.mjs': 'export const first = 1\n',
        'second.mjs': 'export const second = 1\n',
        'declared.mjs': 'export const declared = 1\n',
        'anonymous.mjs': 'export const anonymous = 1\n',
        'elsewhere.mjs': 'export const elsewhere = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "const rows = ['./first.mjs', './second.mjs']\n" +
          'const [, held] = rows\n' +
          "readFileSync(new URL(held, import.meta.url), 'utf8')\n" +
          "function reads(name) {\n  return readFileSync(new URL(name, import.meta.url), 'utf8')\n}\n" +
          "reads('./declared.mjs', 'utf8')\n" +
          "export default function () {\n  return readFileSync(new URL('./anonymous.mjs', import.meta.url), 'utf8')\n}\n",
      })
      const test = at['probe.test.mjs']
      const reached = ['first.mjs', 'second.mjs', 'declared.mjs', 'anonymous.mjs']

      expect(subjectsRead([...reached, 'elsewhere.mjs'].map((f) => at[f]), [test], () => [test])).toEqual(
        reached.map((f) => at[f]),
      )
    })
  })

  /* A method that hands each element of a collection to a callback is a name
     bound to that collection — and a call that hands it no callback at all, or
     one that takes no element, binds nothing and reaches nothing. */
  it('follows the element a map’s callback is handed, and nothing from a call that has no callback or no parameter', () => {
    inScratch('mutants-bound-', (root) => {
      const at = plant(root, {
        'mapped.mjs': 'export const mapped = 1\n',
        'elsewhere.mjs': 'export const elsewhere = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "const over = ['./mapped.mjs']\n" +
          "over.map((name) => readFileSync(new URL(name, import.meta.url), 'utf8'))\n" +
          'over.map()\n' +
          'over.map(() => 0)\n',
      })
      const test = at['probe.test.mjs']

      expect(subjectsRead([at['mapped.mjs'], at['elsewhere.mjs']], [test], () => [test])).toEqual([at['mapped.mjs']])
    })
  })

  /* ⚠️ **A COMPARISON IS NOT AN ASSIGNMENT**, and reading one as the other gives
     a name every value it was ever compared WITH — which blocks a file the test
     mentions only to say it is not the one. */
  it('follows what a name is assigned, and not what it is compared with', () => {
    inScratch('mutants-bound-', (root) => {
      const at = plant(root, {
        'assigned.mjs': 'export const assigned = 1\n',
        'compared.mjs': 'export const compared = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "let picked\npicked = './assigned.mjs'\n" +
          "export const elsewhere = picked === './compared.mjs'\n" +
          "readFileSync(new URL(picked, import.meta.url), 'utf8')\n",
      })
      const test = at['probe.test.mjs']

      expect(subjectsRead([at['assigned.mjs'], at['compared.mjs']], [test], () => [test])).toEqual([at['assigned.mjs']])
    })
  })

  /* ⚠️ **A PATH IS THE ONE PROPERTY OF A URL THAT IS A PATH.** Its `href` is a
     URL, and a read handed one reaches no file — a rule that took any property
     for `pathname` would block a file on the strength of a string that names it
     only as a URL. And `join` is not `resolve`: the one before an absolute part
     keeps what came before it and the other starts again. */
  it('tells a URL’s path from the rest of it, and joining from resolving', () => {
    inScratch('mutants-shapes-', (root) => {
      const at = plant(root, {
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import path, { dirname, join } from 'node:path'\n" +
          "import { fileURLToPath } from 'node:url'\n" +
          'const HERE = dirname(fileURLToPath(import.meta.url))\n' +
          "readFileSync(new URL('./hrefed.mjs', import.meta.url).href, 'utf8')\n" +
          "readFileSync(join(HERE, '/absolute.mjs'), 'utf8')\n" +
          "readFileSync(path.resolve('relative', 'resolved.mjs'), 'utf8')\n" +
          "readFileSync(path.resolve('/rooted', 'after.mjs'), 'utf8')\n",
      })
      const test = at['probe.test.mjs']
      const here = path.dirname(test)
      const reached = [path.join(here, 'absolute.mjs'), path.resolve('relative', 'resolved.mjs'), '/rooted/after.mjs']
      const namesakes = [
        path.join(here, 'hrefed.mjs'),
        /* What `resolve` would have made of the join, and what dropping the
           restart at an absolute part would have made of the resolve. */
        '/absolute.mjs',
        path.resolve('resolved.mjs'),
        path.resolve('rooted', 'after.mjs'),
      ]

      expect(subjectsRead([...reached, ...namesakes], [test], () => [test])).toEqual(reached)
    })
  })

  /* ⚠️ **THE RECEIVER IS THE WHOLE OF WHAT MAKES `join` THIS `join`.** Every
     collection in the language has one, and reading `rows.join('/')` as a path
     built from parts blocks whatever the parts happen to spell. Only the
     identifiers `path` and `process` carry the calls this follows — not a
     property that ends in one of those names, and not a literal spelling it. */
  it('follows join and resolve only from the receivers that mean them, and nothing from a lookalike', () => {
    inScratch('mutants-shapes-', (root) => {
      const at = plant(root, {
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "const fixtures = { resolve: (...parts) => parts.join('/'), paths: [] }\n" +
          "readFileSync(fixtures.resolve('kept', 'resolved.mjs'), 'utf8')\n" +
          "readFileSync(fixtures.paths.join('/', 'chained.mjs'), 'utf8')\n" +
          "readFileSync(`path`.join('/', 'templated.mjs'), 'utf8')\n",
      })
      const test = at['probe.test.mjs']
      const namesakes = [path.resolve('kept', 'resolved.mjs'), '/chained.mjs', '/templated.mjs']

      expect(subjectsRead(namesakes, [test], () => [test])).toEqual([])
    })
  })

  /* ⚠️ **A PART THAT CANNOT BE KNOWN IS NOT A PART SPELT `null`.** Written into
     the path rather than answered with, it names a file of its own — one nobody
     wrote, which the sweep would then leave unmutated behind a line claiming a
     test reads it. */
  it('answers that it cannot know a path with an unknown part, on either side of the join', () => {
    inScratch('mutants-shapes-', (root) => {
      const at = plant(root, {
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import { join } from 'node:path'\n" +
          "readFileSync(join(somewhere(), 'concatenated.mjs'), 'utf8')\n" +
          "readFileSync(join('kept', somewhere()), 'utf8')\n",
      })
      const test = at['probe.test.mjs']
      const spelt = [path.resolve('null', 'concatenated.mjs'), path.resolve('kept', 'null')]

      expect(subjectsRead(spelt, [test], () => [test])).toEqual([])
    })
  })

  /* ⚠️ **THE BOUND IS ON THE PRODUCT, AND IT IS THE LAST COUNT THAT STILL
     ANSWERS** (fifth review, 2026-09-14): a name takes every value it has
     anywhere in the file, so two of them in one path multiply, and
     `check-mutants.test.mjs` reached `RangeError: Invalid array length`. Exactly
     the bound is answered; past it, a part that cannot be known. */
  it('expands a path built from exactly as many names as it will, and no more', () => {
    inScratch('mutants-bound-', (root) => {
      const spelt = (name, count, last) =>
        `const ${name} = ${JSON.stringify([...Array.from({ length: count - 1 }, (_, at) => `v-${at}`), last])}\n`
      const at = plant(root, {
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import { join } from 'node:path'\n" +
          spelt('most', 64, './atTheBound') +
          spelt('rest', 64, 'kept.mjs') +
          spelt('more', 66, './pastTheBound') +
          spelt('over', 66, 'lost.mjs') +
          "readFileSync(join(most, rest), 'utf8')\n" +
          "readFileSync(join(more, over), 'utf8')\n",
      })
      const test = at['probe.test.mjs']
      const reached = path.resolve('atTheBound', 'kept.mjs')
      const past = path.resolve('pastTheBound', 'lost.mjs')

      expect(subjectsRead([reached, past], [test], () => [test])).toEqual([reached])
    })
  })

  /* A file URL that names no local path is a part that cannot be known, not a
     path — the conversion throws, and a read handed the throw would take the
     whole sweep down rather than block nothing. */
  it('answers that it cannot know a read whose file URL names no local path', () => {
    inScratch('mutants-shapes-', (root) => {
      const at = plant(root, {
        'nowhere.mjs': 'export const nowhere = 1\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "import { fileURLToPath } from 'node:url'\n" +
          "readFileSync(fileURLToPath('file://elsewhere/nowhere.mjs'), 'utf8')\n",
      })
      const test = at['probe.test.mjs']

      expect(subjectsRead([at['nowhere.mjs'], '/nowhere.mjs'], [test], () => [test])).toEqual([])
    })
  })

  it('resolves a directory import to its index', () => {
    // `boot.test.ts` imports the kernel by its directory, which is
    // `kernel/index.ts`; missing that would drop every module tested through
    // its barrel. This case was `CirclePane.test.tsx` and `peer/` until
    // 2026-09-13 — but that import is `import type`, which runs nothing and
    // stopped counting when imports began to be parsed. See `importsOf`.
    const found = testsCovering(['src/kernel/index.ts'], ['src/app/boot.test.ts'])
    expect(found).toEqual(['src/app/boot.test.ts'])
  })
})

/**
 * A checkout of its own for `run` to sweep, at `root`: a `vitest.config.ts`
 * shaped like this repository's — a root bound and a project that declares a
 * looser one — a `vite.config.ts` with a plugin to find again, this
 * repository's `node_modules` linked so a generated config can import
 * `vitest/config`, and `files` beside them.
 */
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
    'vitest.config.ts':
      'export default { test: {\n' +
      "  passWithNoTests: true,\n  setupFiles: ['./vitest.setup.ts'],\n  testTimeout: 15000,\n  projects: [\n" +
      "    { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },\n" +
      "    { extends: true, test: { name: 'gates', include: ['src/**/*.test.mjs'], environment: 'node', testTimeout: 60_000 } },\n" +
      '  ],\n} }\n',
    'vite.config.ts': "export default { plugins: [{ name: 'planted' }], test: { exclude: ['planted/**'] } }\n",
    ...files,
  })
}

/**
 * `run` over `root`, with git, the lock and Stryker replaced and both streams
 * captured. Anything in `options` replaces the stand-in of the same name.
 */
async function sweep(root, { argv = [], subjects = [], tree = [], ...options } = {}) {
  const said = { stdout: '', stderr: '' }
  const locks = { taken: 0, released: 0 }
  const asked = []
  const code = await run(argv, {
    root,
    stdout: { write: (text) => void (said.stdout += text) },
    stderr: { write: (text) => void (said.stderr += text) },
    changed: (...args) => {
      asked.push(args)
      return subjects
    },
    files: (at) => {
      expect(at).toBe(root)
      return tree
    },
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
    /* A checkout of its own has no history for git to trace through, so where
       the merge base is and what each subject came from are both answered as
       "nothing" here — which is what a NEW file gets, and leaves every survivor
       standing exactly as it stood before this comparison existed. A case about
       the merge base gives its own. */
    mergeBase: () => null,
    origins: (names) => new Map(names.map((name) => [name, null])),
    measure: () => {
      throw new Error('no sweep here should have measured a merge base')
    },
    clock: ticking(),
    ...options,
  })
  return { code, ...said, locks, asked }
}

/** A clock that moves on 250 ms each time it is read, so a duration a sweep records is one a test can name. */
function ticking() {
  let now = 0
  return () => (now += 250)
}

/**
 * What a sweep says of the subjects it mutates without the covering tests that
 * read their source, each as `[subject, remaining, [left out…]]`.
 *
 * ⚠️ **THE DESTRUCTURED NAME HERE WAS `file`, AND IT MADE THIS FILE A READER OF
 * THE GATE'S OWN SOURCE** (measured 2026-09-14). `pathsRead` follows a name
 * across the whole file, not one scope, so `file` took every value any
 * `subjects` in this file holds — one of which lists `scripts/check-mutants.mjs`
 * — and handed it to the reads in `sha` and `readJson`. The gate then left this,
 * its only covering test, out of its own run. Loud, as designed: no covering
 * test was found for 2 278 mutants.
 */
const leftOutOf = (...subjects) =>
  `check-mutants: ${subjects.length} file(s) are mutated without the covering tests that read their source text — Stryker rewrites the very file such a test reads, so it would fail the dry run; a mutant only it could kill survives, because reading text is not testing behaviour:\n` +
  subjects
    .map(
      ([named, remaining, tests]) =>
        `  ${named} — ${remaining === 0 ? 'no covering test remains' : `${remaining} covering test(s) remain`}; left out:\n` +
        tests.map((test) => `    ${test} — reads its source text\n`).join(''),
    )
    .join('')

/** A report in which `subject`'s one mutant ended `status`. */
const reportFor = (subject, status) => ({ files: { [subject]: { mutants: [{ id: '0', status }] } } })

/**
 * A report as Stryker writes one: the file's own source — measured 2026-09-14,
 * a real report's `source` hashes to the file's bytes — beside `mutants`.
 */
const reportWith = (planted, mutants) => ({ files: { [planted]: { source: readFileSync(planted, 'utf8'), mutants } } })

/** A report of `source` under the name `planted`, every mutant of it at `status` — a run of content that is not what is on the disk there, which is what the merge base's own is. */
const reportOfSource = async (planted, source, status) => ({
  files: {
    [planted]: {
      source,
      mutants: (await identitiesOfSource(planted, source)).map((identity, id) => ({ id: String(id), static: false, ...identity, status })),
    },
  },
})

/** Where an `Ignored` mutant in a stood-in report sits: nowhere a counted one is. */
const IGNORED_AT = { mutatorName: 'Ignored', replacement: '', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } }

/**
 * A timeout Stryker DETECTED at the hit limit, in Stryker's own words —
 * `determineHitLimitReached` in `@stryker-mutator/api` 10.0.0 — which this gate
 * reads as a kill and never re-runs. A bare `'Timeout'` is the other kind: the
 * wall clock expired, which says nothing about the mutant and everything about
 * the load, and which the settle run exists to answer.
 */
const DETECTED = { status: 'Timeout', statusReason: 'Hit limit reached (330901/330900)' }

/**
 * A report of `planted` in which the file's own mutants — each the identity
 * Stryker's instrumenter gives it, in order — ended with `statuses`, one each;
 * an `Ignored` status is a mutant of its own beside them, as Stryker lists one.
 * A status given as an object carries its own fields, `statusReason` included.
 *
 * ⚠️ Named apart from the `reportOf` the first group of tests keeps: `pathsRead`
 * binds a parameter at every call to a function OF THAT NAME, so sharing it
 * handed the read below every `subject` in this file — one of which is the
 * gate's own path — and the self-reader test caught it (2026-09-14).
 */
async function plantedReport(planted, ...statuses) {
  const identities = await mutantIdentitiesIn(planted)
  let next = 0
  const mutants = statuses.map((one, id) => {
    const said = typeof one === 'string' ? { status: one } : one
    const identity = said.status === 'Ignored' ? IGNORED_AT : identities[next++]
    if (identity === undefined) throw new Error(`${planted} has ${identities.length} mutant(s), fewer than the statuses given`)
    return { id: String(id), static: false, ...identity, ...said }
  })
  return reportWith(planted, mutants)
}

/** What a sweep says of the changed files no test reaches that Stryker makes no mutant in. */
const noMutantIn = (...files) =>
  `check-mutants: ${files.length} file(s) no test reaches have no mutant in them — Stryker's own instrumenter makes none, or every one is disabled beside the code — so there is nothing a test could kill:\n` +
  files.map((f) => `  ${f}\n`).join('')

/** And what it fails with for the ones it does make mutants in, each given as `[file, mutants]`. */
const noTestFoundFor = (...found) =>
  `check-mutants: no covering test was found for ${found.length} file(s) that Stryker makes mutants in — a discovery or testability failure, not a mutation result, and not a pass:\n` +
  found.map(([f, count]) => `  ${f} — ${count} mutant(s)\n`).join('') +
  '  Reach each through an import a test makes, directly or through a module that imports it. Coverage does not excuse it: a sweep can only mutate against the tests it found.\n'

/**
 * Stands in for Stryker: reads the config it is handed the way Stryker does —
 * the vitest config through Vite's own loader — records what it found, leaves a
 * sandbox behind as Stryker does, and writes `reports[subject]` if there is one.
 *
 * A SETTLE run is told apart the way a reader of the log would tell it apart:
 * it is the run Stryker is asked to give room to finish, and nothing else sets
 * `timeoutFactor` — see `SETTLE_RUN`. It answers from `settled` and `settleExits`,
 * so a test says what the second run found rather than repeating the first.
 */
function strykerStandIn(root, { reports = {}, exits = {}, settled = {}, settleExits = {} } = {}) {
  const seen = []
  const stryker = async (config) => {
    const settings = JSON.parse(readFileSync(config, 'utf8'))
    const [subject] = settings.mutate
    const settling = settings.timeoutFactor !== undefined
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, settings.vitest.configFile, root, 'silent')
    seen.push({
      subject,
      settling,
      settings,
      vitest: loaded.config,
      reportLeft: existsSync(path.join(root, REPORT)),
      sandboxLeft: existsSync(path.join(root, '.stryker-tmp')),
    })
    mkdirSync(path.join(root, '.stryker-tmp', 'sandbox-1'), { recursive: true })
    writeFileSync(path.join(root, '.stryker-tmp', 'sandbox-1', 'copied.ts'), 'export {}\n')
    const answer = (settling ? settled : reports)[subject]
    if (answer !== undefined) writeFileSync(path.join(root, REPORT), JSON.stringify(answer))
    return (settling ? settleExits : exits)[subject] ?? true
  }
  return { stryker, seen }
}

/** The four names a sweep writes at `root`, each with whether it is still there. */
const leftAt = (root) =>
  Object.fromEntries(
    ['vitest.mutants.mjs', 'stryker.mutants.json', REPORT, '.stryker-tmp'].map((name) => [
      name,
      existsSync(path.join(root, name)),
    ]),
  )
const NOTHING_LEFT = { 'vitest.mutants.mjs': false, 'stryker.mutants.json': false, [REPORT]: false, '.stryker-tmp': false }

/**
 * ⚠️ **THE SWEEP ITSELF WAS THE ONE PART OF THIS GATE NO TEST REACHED.** `run`
 * read git, spawned Stryker, took the checkout's lock and wrote to the real
 * streams, so its test measured 68.7 % of the file's lines on 2026-09-14 —
 * and this file is now a subject of its own sweep, where an uncovered line is
 * a `NoCoverage` mutant and a `NoCoverage` mutant is a survivor. These drive
 * whole sweeps over a directory of their own, with only git, the lock and
 * Stryker stood in for.
 */
describe('a whole sweep, driven with no Stryker', () => {
  it('refuses a command line it cannot read before asking git anything', async () => {
    const message = thrownBy(() => argumentsOf(['--bogus'])).message

    const result = await sweep(tmpdir(), {
      argv: ['--bogus'],
      changed: () => {
        throw new Error('git was asked')
      },
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toBe(
      `check-mutants: ${message}\n` +
        'usage: node scripts/check-mutants.mjs [--base <ref>] [--only <substring>] [--require-base]\n' +
        '       node scripts/check-mutants.mjs --plan <manifest> --shards <count> [--isolate <heaviest>] [--base <ref>] [--only <substring>] [--require-base]\n' +
        '         (a plan and its shards assume clean checkouts: nothing .gitignore covers is fingerprinted, the install included, so a local run with ignored fixtures present is outside their guarantee)\n' +
        '       node scripts/check-mutants.mjs --shard <index>/<count> --manifest <manifest> --results <dir>\n' +
        '       node scripts/check-mutants.mjs --aggregate --manifest <manifest> --results <dir>\n' +
        '       node scripts/check-mutants.mjs --measure <path> --into <file>\n' +
        '         (what one file owes in the checkout this runs in — how a sweep measures the merge base, in a worktree of its own)\n',
    )
    expect(result.stdout).toBe('')
  })

  it('refuses a base it cannot resolve in the refusal’s own words, whatever was thrown', async () => {
    for (const thrown of [new Error('cannot resolve a merge base with "x"'), 'a thrown string']) {
      const result = await sweep(tmpdir(), {
        changed: () => {
          throw thrown
        },
      })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(`${thrown instanceof Error ? thrown.message : thrown}\n`)
    }
  })

  it('says nothing changed when nothing did, or when --only narrows every change away', async () => {
    const files = () => {
      throw new Error('the tree was listed')
    }
    const none = await sweep(tmpdir(), { subjects: [], files })
    const narrowed = await sweep(tmpdir(), {
      argv: ['--only', 'zzz', '--base', 'origin/main', '--require-base'],
      subjects: ['src/a.ts'],
      files,
    })

    for (const result of [none, narrowed]) {
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('check-mutants: nothing changed to mutate\n')
    }
    expect(none.asked).toEqual([['main', false]])
    expect(narrowed.asked).toEqual([['origin/main', true]])
  })

  /* ⚠️ **A SUBJECT A TEST READ THE SOURCE OF WAS LEFT UNMUTATED, AND A SWEEP OF
   * ONLY SUCH SUBJECTS EXITED 0** — "nothing left to mutate" (decided
   * 2026-09-14). Four subjects and about 1 048 mutants passed that way on
   * `feat/looking-up`. Stryker rewrites the file the test reads, so THAT TEST
   * cannot run; the subject can, without it. With no covering test left, it is a
   * file no covering test was found for — counted, and failed by name. */
  it('fails a subject whose only covering test reads its source, as a file no covering test was found for, naming the test left out', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = plant(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs':
          "import { readFileSync } from 'node:fs'\nimport { a } from './a'\n" +
          "readFileSync(new URL('./a.ts', import.meta.url), 'utf8')\n",
      })

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: Object.keys(at) })

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(leftOutOf([at['src/a.ts'], 0, [at['src/a.test.mjs']]]))
      expect(result.stderr).toBe(noTestFoundFor([at['src/a.ts'], 1]))
      expect(result.locks.taken).toBe(0)
    })
  })

  /* A mutant only the reading test could kill now survives, red and named —
     which is the decision, not a cost of it: reading a file's text is not
     testing what the file does. */
  it('mutates a subject a test reads the source of, against its other covering tests alone', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs':
          "import { readFileSync } from 'node:fs'\nimport { a } from './a'\n" +
          "readFileSync(new URL('./a.ts', import.meta.url), 'utf8')\n",
        'src/a.behaviour.test.mjs': "import { a } from './a'\n",
      })
      const { stryker, seen } = strykerStandIn(root, { reports: { [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed') } })

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs', 'src/a.behaviour.test.mjs'],
        stryker,
      })

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(
        leftOutOf([at['src/a.ts'], 1, [at['src/a.test.mjs']]]) +
          `check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${at['src/a.ts']}\n` +
          'check-mutants: every mutant was killed\n',
      )
      expect(seen.map(({ subject, vitest }) => [subject, vitest.test.include])).toEqual([
        [at['src/a.ts'], [asGlob(at['src/a.behaviour.test.mjs'])]],
      ])
      expect(result.locks).toEqual({ taken: 1, released: 1 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* No `vitest.config.ts` is planted: reaching the project's configuration at
     all would refuse, so a result here is also proof it was never asked.
   *
   * ⚠️ **THIS WAS A PASS — "none reached by any test — see test:coverage", EXIT
   * 0 — AND THAT IS A DISCOVERY MISS WEARING GREEN** (decided 2026-09-14). A
   * changed file Stryker makes mutants in, with no covering test found, now
   * fails by name. One it makes none in — a re-export, a type-only module —
   * passes, named as having none: counted by Stryker, not read off its shape. */
  it('stops before reading the project or locking when no test reaches any change', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = plant(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/barrel.ts': "export { a } from './a'\nexport type { A } from './types'\n",
        'src/types.ts': 'export type A = string\n',
        'src/b.test.mjs': "import './b'\n",
      })

      const failing = await sweep(root, { subjects: ['src/a.ts', 'src/barrel.ts', 'src/types.ts'], tree: Object.keys(at) })
      const passing = await sweep(root, { subjects: ['src/barrel.ts', 'src/types.ts'], tree: Object.keys(at) })

      expect(failing.code).toBe(1)
      expect(failing.stdout).toBe(noMutantIn(at['src/barrel.ts'], at['src/types.ts']))
      expect(failing.stderr).toBe(noTestFoundFor([at['src/a.ts'], 1]))
      expect(passing.code).toBe(0)
      expect(passing.stdout).toBe(noMutantIn(at['src/barrel.ts'], at['src/types.ts']))
      expect(passing.stderr).toBe('')
      for (const result of [failing, passing]) expect(result.locks.taken).toBe(0)
    })
  })

  /* A file the instrumenter cannot read has no count, and so no answer to
     whether a test must reach it — which is neither "none" nor a finding. */
  it('refuses a changed file no test reaches that Stryker cannot count the mutants in, before reading the project or locking', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = plant(root, { 'src/a.ts': 'export const = 1\n' })

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: Object.keys(at) })

      const refusal = `check-mutants: Stryker cannot count the mutants in ${at['src/a.ts']}, so whether a test must reach it is unknown — `
      expect(result.code).toBe(2)
      expect(result.stderr.startsWith(refusal), result.stderr).toBe(true)
      expect(result.stderr.length, 'the instrumenter’s own reason follows the refusal').toBeGreaterThan(refusal.length + 1)
      expect(result.stdout).toBe('')
      expect(result.locks.taken).toBe(0)
    })
  })

  it('refuses a project it cannot read how to run, before writing or locking anything', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = plant(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: Object.keys(at) })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: ${path.join(root, 'vitest.config.ts')}: no such file — the covering tests are run as this project runs them, and nothing says how\n`,
      )
      expect(result.stdout).toBe('')
      expect(result.locks.taken).toBe(0)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  it('refuses a sweep another holds the lock for, having written nothing', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        lock: () => {
          throw new Error('another sweep (pid 7) holds the lock')
        },
      })

      expect(result.code).toBe(2)
      expect(result.stdout).toBe('check-mutants: mutating 1 changed file(s), one run each\n')
      expect(result.stderr).toBe('check-mutants: another sweep (pid 7) holds the lock\n')
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* Three subjects: one a test imports, one a test reaches only through the
     module that imports it, and one nothing reaches that has no mutant in it —
     `1` is a number, which no Stryker 10.0.0 mutator changes — beside a fourth
     change `--only` leaves out. A stale report from a crashed sweep is on disk
     first, and a dangling link is in the tree. */
  it('runs Stryker once per reached subject, on its own tests, and removes every name it wrote', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import { a } from './a'\nimport './gone'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/c.ts': "export { b } from './b'\n",
        'src/c.test.mjs': "import { b } from './c'\n",
        'src/d.ts': 'export const d = 1\n',
        [REPORT]: JSON.stringify(reportFor('stale', 'Killed')),
      })
      symlinkSync(path.join(root, 'nowhere.so'), path.join(root, 'src/dangling.so'))
      const subjects = ['src/a.ts', 'src/b.ts', 'src/d.ts', 'elsewhere/x.ts']
      const tree = ['src/a.ts', 'src/a.test.mjs', 'src/b.ts', 'src/c.ts', 'src/c.test.mjs', 'src/d.ts']
      const { stryker, seen } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed'),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], DETECTED),
        },
      })

      const result = await sweep(root, { argv: ['--only', 'src/'], subjects, tree, stryker })

      expect(result.stderr).toBe('')
      expect(result.stdout).toBe(
        noMutantIn(at['src/d.ts']) +
          'check-mutants: mutating 2 changed file(s), one run each\n' +
          `  [1/2] ${at['src/a.ts']}\n` +
          `  [2/2] ${at['src/b.ts']} — through ${throughName(at['src/c.ts'])}\n` +
          detectedIn(at['src/b.ts']) +
          'check-mutants: every mutant was killed\n',
      )
      expect(result.code).toBe(0)
      expect(seen.map(({ subject, settings, vitest, reportLeft, sandboxLeft }) => ({
        subject,
        mutate: settings.mutate,
        configFile: settings.vitest.configFile,
        linkIgnored: settings.ignorePatterns.includes('src/dangling.so'),
        include: vitest.test.include,
        reportLeft,
        sandboxLeft,
      }))).toEqual([
        {
          subject: at['src/a.ts'],
          mutate: [at['src/a.ts']],
          configFile: path.join(root, 'vitest.mutants.mjs'),
          linkIgnored: true,
          include: [asGlob(at['src/a.test.mjs'])],
          reportLeft: false,
          sandboxLeft: false,
        },
        {
          subject: at['src/b.ts'],
          mutate: [at['src/b.ts']],
          configFile: path.join(root, 'vitest.mutants.mjs'),
          linkIgnored: true,
          include: [asGlob(at['src/c.test.mjs'])],
          reportLeft: false,
          sandboxLeft: false,
        },
      ])
      expect(result.asked).toEqual([['main', false]])
      expect(result.locks).toEqual({ taken: 1, released: 1 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* ⚠️ **A REACHED FILE WITH NO MUTANT FAILED EVERY SWEEP IT WAS IN** (measured
     2026-09-14 on the real sweep): `src/kernel/index.ts` and
     `src/kernel/ui/boot.ts` are re-export barrels, Stryker instruments 0 mutants
     in each, tests reach both — so each went to Stryker, which wrote a report
     naming no file, which is a run with no score, and the sweep ended "Stryker
     did not finish for 2 file(s)", exit 1. A file no test reaches was already
     counted first and passed with none; a reached one is counted the same way
     now, before the configuration is read, the lock taken or Stryker run. */
  it('passes a reached file Stryker makes no mutant in as having none to kill, without reading the project, locking or running Stryker', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = plant(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/barrel.ts': "export { a } from './a'\n",
        'src/barrel.test.mjs': "import './barrel'\n",
        'src/second.ts': "export { a } from './a'\n",
        'src/second.test.mjs': "import './second'\n",
      })

      /* Two of them, so the list of files that pass without a test is read as a list. */
      const result = await sweep(root, { subjects: ['src/barrel.ts', 'src/second.ts'], tree: Object.keys(at) })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(
        'check-mutants: 2 file(s) had no mutant to kill — Stryker made none, or every one is disabled beside the code — so they pass without any test having been tried against them:\n' +
          `  ${at['src/barrel.ts']}\n  ${at['src/second.ts']}\n`,
      )
      expect(result.locks.taken).toBe(0)
    })
  })

  /* And the line that fix must not cross: a file with mutants whose report
     names no file is still a run Stryker never scored. */
  it('still fails a reached file with mutants whose report names no file, as a run Stryker never scored', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const { stryker, seen } = strykerStandIn(root, { reports: { [at['src/a.ts']]: { files: {} } } })

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'], stryker })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(notRunIn(RUN_TAIL, at['src/a.ts']))
      /* A report of no file holds no timeout either, so nothing is said about
         one and nothing is re-run: a run with no score is not a question the
         settle run can answer. */
      expect(result.stdout).toBe(`check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${at['src/a.ts']}\n`)
      expect(seen.map(({ subject }) => subject)).toEqual([at['src/a.ts']])
    })
  })

  /* ⚠️ **A STATIC MUTANT THAT THROWS AT IMPORT IS REPORTED `Survived`, AND NOTHING
     SAID SO** (measured 2026-09-14, `/tmp/cc-audit/static-probe`): a suite whose
     module throws while loading fails no test, so Stryker's vitest runner reports
     the mutant as a survivor — `define('')` at module level, `if (true) throw` and
     `key !== ''` all came back `Survived` although vitest by hand failed the
     file. A generated load probe was tried and REMOVED: it made kills of its own.
     So nothing passes differently; a static survivor is only named, with how to
     tell the false kind from the real one. */
  it('names each survivor Stryker marks static as one to verify by hand, and says nothing of one that is not static', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\nexport const b = 'b'\nexport const c = 'c'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      /* Each of `a.ts`'s three mutants as Stryker would place it: the first
         static and surviving — the one to verify — the second static and killed,
         the third surviving and not static. */
      const [first, second, third] = await mutantIdentitiesIn(at['src/a.ts'])
      const mutant = (status, isStatic, identity) => ({ id: `${identity.location.start.line}`, status, static: isStatic, ...identity })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: reportWith(at['src/a.ts'], [
            mutant('Survived', true, first),
            mutant('Killed', true, second),
            mutant('Survived', false, third),
          ]),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], 'Survived'),
        },
        exits: { [at['src/a.ts']]: false, [at['src/b.ts']]: false },
      })

      const result = await sweep(root, { subjects: ['src/a.ts', 'src/b.ts'], tree: ['src/a.ts', 'src/a.test.mjs', 'src/b.ts', 'src/b.test.mjs'], stryker })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(survivedIn(at['src/a.ts'], at['src/b.ts']))
      expect(result.stdout).toContain(staticNote(`${at['src/a.ts']}:1:18`))
    })
  })

  /* ⚠️ **A `Timeout` COUNTS AS A KILL, AND LOAD TURNS SURVIVORS INTO TIMEOUTS**
     (measured 2026-09-15). These are the settle run, one failure mode each: a
     wall-clock timeout is a question nobody asked, so the file is re-run WHOLE,
     once, alone — and a hit-limit one is a detection, which is not re-run at
     all. The plain sweep and the sharded one settle alike; the sharded cases are
     in the group below. */
  const settleSweep = async (root, { first, settle, exit = true, settleExit = true } = {}) => {
    const at = checkout(root, { 'src/a.ts': "export const a = 'a'\nexport const b = 'b'\n", 'src/a.test.mjs': "import './a'\n" })
    const a = at['src/a.ts']
    const { stryker, seen } = strykerStandIn(root, {
      reports: { [a]: await first(a) },
      settled: settle === undefined ? {} : { [a]: await settle(a) },
      exits: { [a]: exit },
      settleExits: { [a]: settleExit },
    })
    const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'], stryker })
    return { a, result, seen }
  }

  it('runs nothing twice for a timeout Stryker detected at the hit limit, and names the detection', async () => {
    await inScratch('mutants-settle-', async (root) => {
      /* No settle report is given, so a second run would leave none and fail as
         a run with no score — the pass below is the whole evidence that none
         happened, and `seen` names the runs there were. */
      const { a, result, seen } = await settleSweep(root, { first: (planted) => plantedReport(planted, DETECTED, 'Killed') })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(detectedIn(a))
      expect(seen.map(({ settling: again }) => again)).toEqual([false])
    })
  })

  it('settles a wall-clock timeout by re-running the whole file alone, against the same covering tests, and takes the settle run’s kill', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result, seen } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout', 'Killed'),
        settle: (planted) => plantedReport(planted, 'Killed', 'Killed'),
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(settledIn(a, { killed: 1 }))
      expect(result.stdout).toContain('check-mutants: every mutant was killed\n')
      /* The same subject, the same covering tests and the same runners — only
         the deadline differs, because a settle run is the file's own run again
         with room to finish. */
      expect(seen.map(({ settling: again, subject, settings, vitest }) => [
        again,
        subject,
        settings.mutate,
        vitest.test.include,
        [settings.timeoutMS, settings.timeoutFactor, settings.concurrency],
      ])).toEqual([
        [false, a, [a], [asGlob(path.join(root, 'src/a.test.mjs'))], [20_000, undefined, undefined]],
        [true, a, [a], [asGlob(path.join(root, 'src/a.test.mjs'))], [30_000, 4, undefined]],
      ])
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* The finding the settle run exists for: 42 of 140 replayed wall-clock
     timeouts came back `Survived`, each one a weak test a green sweep had hidden. */
  it('fails a wall-clock timeout the settle run answers with a survivor, though the first run reported it as a kill', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout', 'Killed'),
        settle: (planted) => plantedReport(planted, 'Survived', 'Killed'),
        settleExit: false,
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(survivedIn(a))
      expect(result.stdout).toContain(settledIn(a, { survived: 1 }))
      expect(result.stdout).not.toContain('every mutant was killed')
    })
  })

  it('fails a wall-clock timeout that is a wall-clock timeout again, naming the file and where the mutant sits', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Killed', 'Timeout'),
        settle: (planted) => plantedReport(planted, 'Killed', 'Timeout'),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(timedOutIn([a], [`${a}:2:18`]))
      expect(result.stdout).toContain(settledIn(a, { repeated: 1 }))
      expect(result.stdout).not.toContain('every mutant was killed')
    })
  })

  /* Fail-closed on a wording this gate has never been shown: settled as a
     wall-clock timeout, and named as one it could not tell apart rather than
     passed as a kill. */
  it('settles a timeout whose reason it does not recognise, and says so where it repeats', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const unknown = { status: 'Timeout', statusReason: 'Hit limit reached' }
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, unknown, 'Killed'),
        settle: (planted) => plantedReport(planted, unknown, 'Killed'),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(timedOutIn([a], [unrecognisedAt(`${a}:1:18`, 'Hit limit reached')]))
      expect(result.stdout).toContain(settledIn(a, { repeated: 1 }))
    })
  })

  it('fails a settle run that wrote no report, as a run Stryker never scored', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result, seen } = await settleSweep(root, { first: (planted) => plantedReport(planted, 'Timeout', 'Killed') })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(notRunIn(RUN_TAIL, a) + unresolvedIn(a, "1:18 — the settle run's report says nothing about it"))
      expect(seen.map(({ settling: again }) => again)).toEqual([false, true])
      expect(result.stdout).not.toContain('every mutant was killed')
    })
  })

  it('fails a settle run whose report is about another file, as a run Stryker never scored', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout', 'Killed'),
        settle: () => reportFor(path.join(root, 'src/elsewhere.ts'), 'Killed'),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(notRunIn(RUN_TAIL, a) + unresolvedIn(a, "1:18 — the settle run's report says nothing about it"))
    })
  })

  /* Every check around a run holds for the settle run unchanged, the
     reconciliation against what the sweep counted included: a second run whose
     report holds other mutants than the first is a report of nothing. */
  it('fails a settle run whose report does not hold the mutants the sweep counted, naming it as the settle run’s', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout', 'Killed'),
        settle: (planted) => plantedReport(planted, 'Killed'),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(
        "check-mutants: the report does not match the file swept in 1 file(s) — Stryker's own report is not of what this sweep counted, so nothing about their mutants is known:\n" +
          `  ${a} — the settle run's report: it lacks the mutant ${namedLiteralAt(2)}, which this sweep counted\n`,
      )
      expect(result.stdout).not.toContain('re-run alone')
    })
  })

  /* And a FIRST report that is not of the file swept is judged already: its
     timeouts say nothing about anything, so there is nothing to settle. */
  it('re-runs nothing for a first report that is not of the file swept, though it holds a wall-clock timeout', async () => {
    await inScratch('mutants-settle-', async (root) => {
      /* The settle run this would have had answers every mutant, so a run that
         DID happen would pass — the failure below is evidence that none did. */
      const { a, result, seen } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout'),
        settle: (planted) => plantedReport(planted, 'Killed', 'Killed'),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(
        "check-mutants: the report does not match the file swept in 1 file(s) — Stryker's own report is not of what this sweep counted, so nothing about their mutants is known:\n" +
          `  ${a} — it lacks the mutant ${namedLiteralAt(2)}, which this sweep counted\n`,
      )
      expect(seen.map(({ settling: again }) => again)).toEqual([false])
    })
  })

  /* A survivor outranks a repeat as the file's OUTCOME, and does not replace it
     as a finding: the file is named in both lists, with both remedies. */
  it('names a file with both a survivor and a repeated timeout in both lists, with the survivor as its outcome', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const { a, result } = await settleSweep(root, {
        first: (planted) => plantedReport(planted, 'Timeout', 'Timeout'),
        settle: (planted) => plantedReport(planted, 'Timeout', 'Survived'),
        settleExit: false,
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(timedOutIn([a], [`${a}:1:18`]) + survivedIn(a))
      expect(result.stdout).toContain(settledIn(a, { unsettled: 2, survived: 1, repeated: 1 }))
    })
  })

  /* ⚠️ **AND A SURVIVOR THE SETTLE RUN ALONE OBSERVES IS THE ORDINARY CASE, SO
     ITS STATIC NOTE MUST COME FROM THERE TOO.** Both runs are read for static
     survivors, and a place found in both is named once. */
  it('names a static survivor either run found, once, however many runs found it', async () => {
    await inScratch('mutants-settle-', async (root) => {
      const a = path.join(root, 'src/a.ts')
      const statics = async (planted) => {
        const [one, two] = await mutantIdentitiesIn(planted)
        return reportWith(planted, [
          { id: '0', status: 'Survived', static: true, ...one },
          { id: '1', status: 'Timeout', static: false, ...two },
        ])
      }
      const { result } = await settleSweep(root, {
        first: statics,
        settle: async (planted) => {
          const [one, two] = await mutantIdentitiesIn(planted)
          return reportWith(planted, [
            { id: '0', status: 'Survived', static: true, ...one },
            { id: '1', status: 'Survived', static: true, ...two },
          ])
        },
        exit: false,
        settleExit: false,
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(survivedIn(a))
      expect(result.stdout).toContain(staticNote(`${a}:1:18`, `${a}:2:18`))
    })
  })

  /* ⚠️ **A GENERATED NAME THAT WAS ALREADY A LINK WAS WRITTEN THROUGH** (second
     review, 2026-09-14). `writeFileSync` follows a symbolic link, so a link
     committed at `vitest.mutants.mjs`, `stryker.mutants.json` or a plan's path
     sent the gate's output wherever it pointed — and the link, still in the tree
     when the links were listed, was also handed to Stryker to leave out. Every
     generated file is now removed and created anew, exclusively, under the lock
     where one is taken. */
  it('never writes a generated file, or a plan, through a link planted at its name', async () => {
    await inScratch('mutants-links-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n", 'victim.txt': 'untouched\n' })
      for (const name of ['vitest.mutants.mjs', 'stryker.mutants.json', 'plan.json']) symlinkSync(at['victim.txt'], path.join(root, name))
      const { stryker, seen } = strykerStandIn(root, { reports: { [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed') } })
      const tree = ['src/a.ts', 'src/a.test.mjs']

      const swept = await sweep(root, { subjects: ['src/a.ts'], tree, stryker })
      const plan = await sweep(root, { argv: ['--plan', path.join(root, 'plan.json'), '--shards', '1'], subjects: ['src/a.ts'], tree, commits: commitsAt() })

      /* The generated names are the gate's own, and whatever sits at one when a
         sweep starts is no live sweep's — so they are removed under the lock and
         written anew. A PLAN's path is not the gate's to clear: a link there is
         refused, and what it points at is left alone (fourth review, 2026-09-14). */
      expect(swept.stderr).toBe('')
      expect(swept.code).toBe(0)
      expect(plan.stderr).toBe(
        `check-mutants: ${path.join(root, 'plan.json')} is a symbolic link, and this gate writes through none — remove it if nothing is using it\n`,
      )
      expect(plan.code).toBe(2)
      expect(readFileSync(at['victim.txt'], 'utf8')).toBe('untouched\n')
      expect(seen[0].settings.mutate).toEqual([at['src/a.ts']])
      expect(seen[0].settings.ignorePatterns).not.toContain('vitest.mutants.mjs')
      expect(lstatSync(path.join(root, 'plan.json')).isSymbolicLink()).toBe(true)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* ⚠️ **A CHANGED FILE NO TEST WAS FOUND FOR WAS SKIPPED, AND THE SWEEP STILL
     EXITED 0** (decided 2026-09-14). Nothing was tried against it, so it is not
     a survivor and not a run Stryker never scored: it fails in words of its
     own, while the subjects a test does reach are swept as before — and no
     kill is claimed over a sweep that failed. */
  it('fails naming each changed file with mutants that no covering test was found for, and still sweeps the ones a test reaches', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/d.ts': "export const d = 'd'\n",
        'src/e.ts': "export const e = 'e'\nexport const f = 'f'\n",
      })
      const { stryker, seen } = strykerStandIn(root, { reports: { [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed') } })

      /* Two of them, each with its own count, so the list is read as a list. */
      const result = await sweep(root, { subjects: ['src/d.ts', 'src/a.ts', 'src/e.ts'], tree: Object.keys(at), stryker })

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(`check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${at['src/a.ts']}\n`)
      expect(result.stderr).toBe(noTestFoundFor([at['src/d.ts'], 1], [at['src/e.ts'], 2]))
      expect(seen.map(({ subject }) => subject)).toEqual([at['src/a.ts']])
      expect(result.locks).toEqual({ taken: 1, released: 1 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* ⚠️ **"EVERY MUTANT WAS KILLED" WAS PRINTED OVER A SUBJECT WITH NONE.** A
     report holding an empty mutant list passes — that was decided, and stands —
     but the summary could not tell it from a module whose every mutant a test
     had caught, which is the one distinction this gate exists to draw. Finding
     #9, 2026-09-14. A subject with nothing to kill is named as having nothing,
     and the kill is claimed only where one happened. */
  /* ⚠️ **A FRESH REPORT NAMING THE RIGHT FILE IS NOT A REPORT OF IT** (fourth
     review, 2026-09-14). A plain sweep took Stryker's report as it found it: one
     holding no mutant passed as a file with nothing left to kill, though the
     count taken minutes earlier had found one. The aggregate has reconciled
     reports against the plan since the second review; a plain sweep reconciles
     against what it counted ITSELF — the source it hashed, and every mutant
     identity it counted — the same way. */
  /**
   * ⚠️ **A FILE A COVERING TEST READS CAN CHANGE UNDER A SWEEP, AND EVERY GUARD
   * AROUND IT LOOKED THE OTHER WAY** (2026-09-19).
   *
   * The shard's drift check compares the HEAD commit, the merge base and the
   * WORKING TREE — and the working tree is git's answer, so nothing
   * `.gitignore` covers is in it. `scripts/lib/ledger.test.mjs` reads
   * `dev-docs/feature-ledger.md`, gitignored whole; editing that document during
   * a sweep of `scripts/lib/ledger.mjs` changes what the subject's covering
   * tests assert, between the first run and the settle run, with no signal
   * anywhere. A plain sweep compared nothing at all, tracked or not, which is
   * the wider half — `SidePane.test.tsx` reads `SidePane.module.css`.
   *
   * It is a REFUSAL rather than a failed subject: what moved is an INPUT, so
   * the measurement did not happen, and *could not run* must never become an
   * answer. Whatever is writing is still writing, so every later subject is
   * equally suspect and the sweep ends.
   */
  /**
   * ⚠️ **`pathsRead` ANSWERS IN FOUR SPELLINGS AND ONLY TWO OF THEM ARE PATHS**,
   * which `readInputsOf` did not know until this case was written — and which is
   * the whole argument for writing it. A bare `new URL(spec, import.meta.url)`
   * comes back `file:///…`, and a `path.join(here, '..', x)` comes back with the
   * `..` still in it. A `path.relative(root, …)` on either starts with `..`, so
   * both were dropped by the test meant to exclude a tmpdir fixture: the guard
   * watched nothing and said nothing, in exactly the two forms a test in this
   * repository is most likely to use.
   */
  describe('readInputsOf', () => {
    const reading = (body) =>
      "import { readFileSync } from 'node:fs'\n" +
      "import path from 'node:path'\n" +
      "import { fileURLToPath } from 'node:url'\n" +
      body +
      '\n'

    it('resolves every spelling `pathsRead` can answer in — a bare file: URL and an unnormalised join included', async () => {
      await inScratch('mutants-reads-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        mkdirSync(path.join(root, 'src'), { recursive: true })
        const spellings = {
          bareUrl: "readFileSync(new URL('../notes.md', import.meta.url), 'utf8')",
          fileUrlToPath: "readFileSync(fileURLToPath(new URL('../notes.md', import.meta.url)), 'utf8')",
          joinDotDot:
            "const here = path.dirname(fileURLToPath(import.meta.url))\nreadFileSync(path.join(here, '..', 'notes.md'), 'utf8')",
          literal: `readFileSync(${JSON.stringify(path.join(root, 'notes.md'))}, 'utf8')`,
        }
        for (const [name, body] of Object.entries(spellings)) {
          const test = path.join(root, 'src', `${name}.test.mjs`)
          writeFileSync(test, reading(body))
          const { files, unwatched } = readInputsOf([test], root)
          expect([...files.keys()], name).toEqual(['notes.md'])
          expect(unwatched, name).toBe(0)
        }
      })
    })

    it('counts what it cannot watch rather than dropping it — a directory, and a read it cannot resolve', async () => {
      await inScratch('mutants-reads-', async (root) => {
        mkdirSync(path.join(root, 'src'), { recursive: true })
        mkdirSync(path.join(root, 'fixtures'), { recursive: true })
        const test = path.join(root, 'src', 'a.test.mjs')
        writeFileSync(
          test,
          reading(
            `readFileSync(${JSON.stringify(path.join(root, 'fixtures'))}, 'utf8')\nreadFileSync(whateverThisIs(), 'utf8')`,
          ),
        )
        const { files, unwatched } = readInputsOf([test], root)
        expect([...files.keys()]).toEqual([])
        /* Both of them, and a number a sweep prints beside what it watched —
           the rule the excluded-reader list already follows. */
        expect(unwatched).toBe(2)
      })
    })

    it('leaves a path OUTSIDE the checkout alone, and does not count it against the guarantee', async () => {
      await inScratch('mutants-reads-', async (root) => {
        await inScratch('mutants-elsewhere-', async (other) => {
          writeFileSync(path.join(other, 'fixture.json'), '{}\n')
          mkdirSync(path.join(root, 'src'), { recursive: true })
          const test = path.join(root, 'src', 'a.test.mjs')
          writeFileSync(test, reading(`readFileSync(${JSON.stringify(path.join(other, 'fixture.json'))}, 'utf8')`))
          const { files, unwatched } = readInputsOf([test], root)
          /* A test's own tmpdir fixture is MEANT to change, and it is not an
             input to the project — so it is neither watched nor counted. */
          expect([...files.keys()]).toEqual([])
          expect(unwatched).toBe(0)
        })
      })
    })

    it('skips a path named but absent, because appearing is not a change to an input already read', async () => {
      await inScratch('mutants-reads-', async (root) => {
        mkdirSync(path.join(root, 'src'), { recursive: true })
        const test = path.join(root, 'src', 'a.test.mjs')
        writeFileSync(test, reading(`readFileSync(${JSON.stringify(path.join(root, 'written-later.json'))}, 'utf8')`))
        expect(readInputsOf([test], root)).toEqual({ files: new Map(), unwatched: 0 })
      })
    })

    /* ⚠️ **PARSING COSTS 10.3 s FOR THIS GATE'S OWN THREE COVERING TESTS**,
       measured 2026-09-19, and it was written once per SUBJECT before it was
       measured — minutes added to a sweep for an answer that cannot change
       between two subjects of one run. The caller passes one map for the whole
       sweep. Asserted by DELETING the test after the first call: a second call
       that still answers did not go back to the file. */
    it('parses a test at most once, however many subjects it covers', async () => {
      await inScratch('mutants-reads-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        mkdirSync(path.join(root, 'src'), { recursive: true })
        const test = path.join(root, 'src', 'a.test.mjs')
        writeFileSync(test, `import { readFileSync } from 'node:fs'\nreadFileSync(${JSON.stringify(path.join(root, 'notes.md'))}, 'utf8')\n`)
        const parsed = new Map()
        expect([...readInputsOf([test], root, parsed).files.keys()]).toEqual(['notes.md'])

        rmSync(test)
        expect([...readInputsOf([test], root, parsed).files.keys()]).toEqual(['notes.md'])
        /* And without the map it goes back to the file, which is now gone — so
           the assertion above is about the map and not about some other cache. */
        expect([...readInputsOf([test], root).files.keys()]).toEqual([])
      })
    })

    it('reads nothing from a test that names no read at all', async () => {
      await inScratch('mutants-reads-', async (root) => {
        mkdirSync(path.join(root, 'src'), { recursive: true })
        const test = path.join(root, 'src', 'a.test.mjs')
        writeFileSync(test, "import './a'\nexport const x = 1\n")
        expect(readInputsOf([test], root)).toEqual({ files: new Map(), unwatched: 0 })
      })
    })
  })

  describe('inputsMoved', () => {
    const watching = async (root, contents) => {
      writeFileSync(path.join(root, 'notes.md'), contents)
      mkdirSync(path.join(root, 'src'), { recursive: true })
      const test = path.join(root, 'src', 'a.test.mjs')
      writeFileSync(test, `import { readFileSync } from 'node:fs'\nreadFileSync(${JSON.stringify(path.join(root, 'notes.md'))}, 'utf8')\n`)
      return readInputsOf([test], root)
    }

    it('answers nothing while the bytes hold, names the file when they change, and names it when it goes', async () => {
      await inScratch('mutants-moved-', async (root) => {
        const inputs = await watching(root, 'one\n')
        expect(inputsMoved(inputs, root)).toEqual([])

        writeFileSync(path.join(root, 'notes.md'), 'two\n')
        expect(inputsMoved(inputs, root)).toEqual(['notes.md — its bytes changed'])

        /* CONTENT, not mtime: a file written back identically has not moved,
           and refusing there would fail a sweep beside any editor that saves. */
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        expect(inputsMoved(inputs, root)).toEqual([])

        rmSync(path.join(root, 'notes.md'))
        expect(inputsMoved(inputs, root)).toEqual(['notes.md — gone, or no longer a file'])
      })
    })

    it('names a file that has become a directory, because the claim is about the bytes and there are none', async () => {
      await inScratch('mutants-moved-', async (root) => {
        const inputs = await watching(root, 'one\n')
        rmSync(path.join(root, 'notes.md'))
        mkdirSync(path.join(root, 'notes.md'))
        expect(inputsMoved(inputs, root)).toEqual(['notes.md — gone, or no longer a file'])
      })
    })
  })

  /** A test that imports the subject AND reads `notes.md` beside the checkout. */
  const READS_NOTES =
    "import { readFileSync } from 'node:fs'\n" +
    "import './a'\n" +
    "readFileSync(new URL('../notes.md', import.meta.url), 'utf8')\n"

  describe('a file the subject\'s tests read, changing mid-run', () => {
    it('stops the sweep and names the file, rather than scoring two different projects as one', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          /* `pathsRead` follows `new URL(spec, import.meta.url)` — see its own
             header — so this read resolves to `<root>/notes.md`. */
          'src/a.test.mjs': READS_NOTES,
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const { stryker } = strykerStandIn(root, { reports: { [a]: report } })
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs', 'notes.md'],
          /* The edit lands WHILE Stryker is running, which is the real shape:
             an agent writing a document beside a sweep it did not start. */
          stryker: async (config) => {
            const answer = await stryker(config)
            writeFileSync(path.join(root, 'notes.md'), 'two\n')
            return answer
          },
        })
        expect(result.code).toBe(2)
        /* The subject is named as every other message in this gate names one —
           absolutely, the way Stryker was given it. */
        expect(result.stderr).toContain(`a file ${a}'s covering tests read changed during its run`)
        expect(result.stderr).toContain('notes.md — its bytes changed')
        expect(result.stderr).toContain('measured two different projects')
        expect(result.stdout).not.toContain('every mutant was killed')
      })
    })

    it('says how many files it is watching, and how many it cannot', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          /* `pathsRead` follows `new URL(spec, import.meta.url)` — see its own
             header — so this read resolves to `<root>/notes.md`. */
          'src/a.test.mjs': READS_NOTES,
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs', 'notes.md'],
          stryker: strykerStandIn(root, { reports: { [a]: report } }).stryker,
        })
        expect(result.code).toBe(0)
        /* PRINTED, on the rule the excluded-reader list already follows: a
           guard nobody can see the reach of is a guard nobody can argue with.
           ⚠️ **AND THE SECOND HALF OF THE LINE NEEDS ITS OWN CASE** — this
           asserted only the first, with a fixture whose `unwatched` was 0, so
           the clause that says what it CANNOT watch was covered by nothing.
           Five mutants of that ternary survived the first sweep to run on this
           code, which is the gate doing precisely its job: a test whose TITLE
           claims more than its assertion is the shape it exists to catch. */
        expect(result.stdout).toContain('watching 1 file(s) its tests read\n')
        expect(result.stdout).not.toContain('it cannot')
      })
    })

    it('says the line even when it can watch NOTHING, because the count it cannot watch is the news', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        mkdirSync(path.join(root, 'fixtures'), { recursive: true })
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          /* A DIRECTORY and nothing else, so `files` is empty and `unwatched`
             is 1 — the shape `capability-remove.mjs` has in a real sweep. */
          'src/a.test.mjs':
            "import { readFileSync } from 'node:fs'\nimport './a'\n" +
            `readFileSync(${JSON.stringify(path.join(root, 'fixtures'))}, 'utf8')\n`,
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs'],
          stryker: strykerStandIn(root, { reports: { [a]: report } }).stryker,
        })
        expect(result.code).toBe(0)
        /* ⚠️ **THE GUARD USED TO SAY NOTHING AT ALL HERE**, because the line was
           printed only where it had something to report — and "I watched none of
           this subject's inputs" is the one answer a reader most needs. */
        expect(result.stdout).toContain('watching 0 file(s) its tests read, and 1 it cannot\n')
      })
    })

    it('names EVERY file that moved, separated, rather than only the first', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        writeFileSync(path.join(root, 'other.md'), 'one\n')
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          'src/a.test.mjs':
            READS_NOTES + `readFileSync(${JSON.stringify(path.join(root, 'other.md'))}, 'utf8')\n`,
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const { stryker } = strykerStandIn(root, { reports: { [a]: report } })
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs', 'notes.md', 'other.md'],
          stryker: async (config) => {
            const answer = await stryker(config)
            writeFileSync(path.join(root, 'notes.md'), 'two\n')
            rmSync(path.join(root, 'other.md'))
            return answer
          },
        })
        expect(result.code).toBe(2)
        /* Both, and the separator between them: a message that named one of two
           would send a reader to fix half of what moved. */
        expect(result.stderr).toContain(
          'notes.md — its bytes changed; other.md — gone, or no longer a file',
        )
      })
    })

    it('stops BEFORE the settle run, not after it, when an input moved during the first', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': READS_NOTES })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        /* A WALL-CLOCK timeout — no `statusReason`, so it is not a hit-limit
           detection — which is what gives the first run something to settle. */
        const report = reportWith(a, [{ id: '0', status: 'Timeout', static: false, ...identity }])
        const { stryker, seen } = strykerStandIn(root, { reports: { [a]: report } })
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs', 'notes.md'],
          stryker: async (config) => {
            const answer = await stryker(config)
            writeFileSync(path.join(root, 'notes.md'), 'two\n')
            return answer
          },
        })

        expect(result.code).toBe(2)
        expect(result.stderr).toContain('notes.md — its bytes changed')
        /* ⚠️ **THE CHECK BETWEEN THE TWO RUNS IS A SEPARATE CALL AND NEEDED ITS
           OWN CASE.** Removing it survived every test above, because the check
           after the last run caught the same move a few seconds later — the
           difference is that the SETTLE RUN had by then been carried out
           against a project that had changed, which is the whole thing this
           refuses. So what is asserted is that no settle run ever started. */
        expect(seen.filter(({ settling }) => settling)).toEqual([])
        expect(seen).toHaveLength(1)
      })
    })

    it("records WHY it stopped in a shard's own result, short, and names every file", async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        writeFileSync(path.join(root, 'other.md'), 'one\n')
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          'src/a.test.mjs':
            READS_NOTES + `readFileSync(${JSON.stringify(path.join(root, 'other.md'))}, 'utf8')\n`,
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const subjects = ['src/a.ts']
        const tree = ['src/a.ts', 'src/a.test.mjs', 'notes.md', 'other.md']
        const results = path.join(root, 'results')
        const manifest = await planOver(root, { subjects, tree, shards: 1, isolate: 0 })

        const { stryker } = strykerStandIn(root, { reports: { [a]: report } })
        const shard = await shardOf(root, manifest, '1/1', {
          subjects,
          tree,
          stryker: async (config) => {
            const answer = await stryker(config)
            writeFileSync(path.join(root, 'notes.md'), 'two\n')
            rmSync(path.join(root, 'other.md'))
            return answer
          },
        })

        expect(shard.code).toBe(2)
        /* ⚠️ **THE REASON A SHARD RECORDS IS A SEPARATE STRING FROM THE ONE IT
           PRINTS**, and nothing observed it until this case: the long sentence
           goes to stderr, and this short one is stamped onto the result the
           shard had already written, which is what the aggregate reads back.
           Both joins matter — a reader sent to repair one of two moved files
           repairs half of what moved. */
        expect(readJson(resultIn(results, 1, 'src/a.ts')).stopped).toBe(
          'read-input-changed: notes.md — its bytes changed; other.md — gone, or no longer a file',
        )
        expect(existsSync(receiptIn(results, 1))).toBe(false)
      })
    })

    it('says what it CANNOT watch on the same line, where there is any', async () => {
      await inScratch('mutants-inputs-', async (root) => {
        writeFileSync(path.join(root, 'notes.md'), 'one\n')
        mkdirSync(path.join(root, 'fixtures'), { recursive: true })
        const at = checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          /* One file, one DIRECTORY and one read no static answer can resolve —
             so the count is 1 watched and 2 it cannot. */
          'src/a.test.mjs':
            READS_NOTES +
            `readFileSync(${JSON.stringify(path.join(root, 'fixtures'))}, 'utf8')\n` +
            "readFileSync(whateverThisIs(), 'utf8')\n",
        })
        const a = at['src/a.ts']
        const [identity] = await mutantIdentitiesIn(a)
        const report = reportWith(a, [{ id: '0', status: 'Killed', static: false, ...identity }])
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs', 'notes.md'],
          stryker: strykerStandIn(root, { reports: { [a]: report } }).stryker,
        })
        expect(result.code).toBe(0)
        expect(result.stdout).toContain('watching 1 file(s) its tests read, and 2 it cannot\n')
      })
    })
  })

  it('fails a subject whose report is not of what the sweep counted — no mutant of its own, another identity, or other source — and names it', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const a = at['src/a.ts']
      const [identity] = await mutantIdentitiesIn(a)
      const elsewhere = { ...identity, location: { start: { line: 9, column: 1 }, end: { line: 9, column: 4 } } }
      const killedAt = (one) => ({ id: '0', status: 'Killed', static: false, ...one })
      const swept = (report) =>
        sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs'],
          stryker: strykerStandIn(root, { reports: { [a]: report } }).stryker,
        })
      const unlike = (why) =>
        `check-mutants: the report does not match the file swept in 1 file(s) — Stryker's own report is not of what this sweep counted, so nothing about their mutants is known:\n  ${a} — ${why}\n`

      const none = await swept(reportWith(a, []))
      const other = await swept(reportWith(a, [killedAt(elsewhere)]))
      const stale = await swept({ files: { [a]: { source: "export const a = 'stale'\n", mutants: [killedAt(identity)] } } })

      expect(none.stderr).toBe(unlike(`it lacks the mutant ${namedLiteralAt(1)}, which this sweep counted`))
      expect(other.stderr).toBe(unlike(`it lacks the mutant ${namedLiteralAt(1)}, which this sweep counted`))
      expect(stale.stderr).toBe(unlike(`its source of ${a} is not the content this sweep hashed`))
      for (const result of [none, other, stale]) {
        expect(result.code).toBe(1)
        expect(result.stdout).not.toContain('every mutant was killed')
      }
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* And two of them are a list: each is named with its own reason, because a
     summary that ran them together would say nothing about either. */
  it('names every subject whose report is not of what the sweep counted, each with its own reason', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const [a, b] = [at['src/a.ts'], at['src/b.ts']]
      const { stryker } = strykerStandIn(root, {
        reports: { [a]: reportWith(a, []), [b]: { files: { [b]: { mutants: await mutantIdentitiesIn(b) } } } },
      })

      const result = await sweep(root, { subjects: ['src/a.ts', 'src/b.ts'], tree: Object.keys(at), stryker })

      expect(result.code).toBe(1)
      expect(result.stderr).toBe(
        "check-mutants: the report does not match the file swept in 2 file(s) — Stryker's own report is not of what this sweep counted, so nothing about their mutants is known:\n" +
          `  ${a} — it lacks the mutant ${namedLiteralAt(1)}, which this sweep counted\n` +
          `  ${b} — it carries no source for ${b}\n`,
      )
      expect(result.stdout).not.toContain('every mutant was killed')
    })
  })

  /* ⚠️ A RUN WITH NO SCORE IS NOT A SURVIVOR, AND NEITHER IS A PASS. Each list
     is printed only when it has a subject in it, in its own words, and either
     one fails the sweep. */
  it('fails naming each subject with a survivor, and each Stryker never scored, in their own words', async () => {
    const SURVIVED =
      '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
      '  mutation is genuinely equivalent, say so beside the code:\n' +
      '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n'
    const once = (reportOf, exited) =>
      inScratch('mutants-sweep-', async (root) => {
        const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
        /* Named apart from `subject`, which `pathsRead` follows across this whole
           file: handing that name to a helper that reads made this file a reader
           of the gate's own source once already (2026-09-14). */
        const mutatedFile = at['src/a.ts']
        const report = await reportOf(mutatedFile)
        const { stryker } = strykerStandIn(root, {
          reports: report === null ? {} : { [mutatedFile]: report },
          exits: { [mutatedFile]: exited },
        })
        const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'], stryker })
        expect(result.locks).toEqual({ taken: 1, released: 1 })
        expect(leftAt(root)).toEqual(NOTHING_LEFT)
        return { ...result, subject: mutatedFile }
      })

    const survived = await once((mutatedFile) => plantedReport(mutatedFile, 'Survived'), false)
    const unscored = await once(() => null, false)
    /* A clean exit over a report about some OTHER file is no score for this
       one — see `outcomeOf`. */
    const elsewhere = await once((mutatedFile) => reportFor(path.join(path.dirname(mutatedFile), 'other.ts'), 'Killed'), true)

    expect(survived.code).toBe(1)
    expect(survived.stderr).toBe(
      'check-mutants: a mutant survived in 1 file(s) — a test that cannot fail is not a test.\n' +
        `  ${survived.subject}\n${SURVIVED}`,
    )
    for (const result of [unscored, elsewhere]) {
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(
        'check-mutants: Stryker did not finish for 1 file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n' +
          `  ${result.subject}\n` +
          "  Its own error is above; nothing about these files' tests is known yet.\n",
      )
    }
    for (const result of [survived, unscored, elsewhere]) expect(result.stdout).not.toContain('every mutant was killed')

    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: { [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'NoCoverage') },
        exits: { [at['src/a.ts']]: false, [at['src/b.ts']]: false },
      })

      const both = await sweep(root, { subjects: ['src/a.ts', 'src/b.ts'], tree: Object.keys(at), stryker })

      expect(both.code).toBe(1)
      expect(both.stderr).toBe(
        'check-mutants: Stryker did not finish for 1 file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n' +
          `  ${at['src/b.ts']}\n` +
          "  Its own error is above; nothing about these files' tests is known yet.\n" +
          'check-mutants: a mutant survived in 1 file(s) — a test that cannot fail is not a test.\n' +
          `  ${at['src/a.ts']}\n${SURVIVED}`,
      )
    })
  })

  /* A sweep that dies part-way — here the stream it prints to, and Stryker
     itself — still removes whatever it wrote and gives the lock back, and the
     failure that stopped it is the one reported, not a cleanup's. Nothing is
     on disk yet when the stream fails, which is what makes a removal that
     insists on finding its file throw. */
  it('removes what it wrote and gives the lock back when it fails part-way', async () => {
    for (const failing of ['stream', 'stryker']) {
      await inScratch('mutants-sweep-', async (root) => {
        const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
        const broke = new Error(`the ${failing} broke`)
        const locks = { taken: 0, released: 0 }
        let wroteConfig = null

        const outcome = await run([], {
          root,
          stdout: {
            write: (text) => {
              if (failing === 'stream' && text.startsWith('  [1/1]')) throw broke
            },
          },
          stderr: { write: () => {} },
          changed: () => ['src/a.ts'],
          files: () => ['src/a.ts', 'src/a.test.mjs'],
          lock: () => {
            locks.taken += 1
            return () => void (locks.released += 1)
          },
          stryker: () => {
            wroteConfig = existsSync(path.join(root, 'stryker.mutants.json'))
            throw broke
          },
        }).then(
          () => null,
          (cause) => cause,
        )

        expect(outcome, failing).toBe(broke)
        expect(wroteConfig, failing).toBe(failing === 'stryker' ? true : null)
        expect(locks, failing).toEqual({ taken: 1, released: 1 })
        expect(leftAt(root), failing).toEqual(NOTHING_LEFT)
      })
    }
  })
})

/**
 * ⚠️ **THE GENERATED CONFIG RESTATED THE PROJECT, AND GOT IT WRONG** — finding
 * #11. It wrote `testTimeout: 15000` where `vitest.config.ts` gives the
 * `scripts` and `app` projects 60 s, and it dropped every plugin
 * `vite.config.ts` declares. A subject whose dry run failed for either reason
 * was reported as a run Stryker never scored: loud, and wrong about why.
 */
describe('how a sweep runs the covering tests', () => {
  it('writes a config Vite loads with vite.config.ts’s plugins, the project’s loosest bound and only the subject’s tests', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const { stryker, seen } = strykerStandIn(root, { reports: { [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed') } })

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'], stryker })

      expect(result.code).toBe(0)
      expect(seen).toHaveLength(1)
      expect(seen[0].vitest.plugins.map((plugin) => plugin.name)).toEqual(['planted'])
      expect(seen[0].vitest.test).toEqual({
        exclude: ['planted/**'],
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        testTimeout: 60_000,
        passWithNoTests: false,
        include: [asGlob(at['src/a.test.mjs'])],
      })
    })
  })

  /* ⚠️ **`passWithNoTests` WAS LEFT BEHIND, AND COULD STILL ARRIVE.** Leaving it
     out of what is carried kept `vitest.config.ts`'s `true` away from a sweep,
     but the generated config merges `vite.config.ts` WHOLE — so the same key
     declared there would have been inherited, and a run whose `include`
     matched nothing would have passed. Vitest also sets it on its own for a
     `--changed` run. The generated config says `false` itself now, held here
     against a vite config that says otherwise. Found by review on 2026-09-14. */
  it('writes a config that fails a run with no tests, whatever vite.config.ts declares', async () => {
    await inScratch('mutants-config-', async (root) => {
      checkout(root, { 'vite.config.ts': 'export default { test: { passWithNoTests: true } }\n' })
      const generated = path.join(root, 'vitest.mutants.mjs')
      const covering = [path.join(root, 'src/a.test.mjs')]
      writeFileSync(generated, vitestConfigFor(covering, {}))

      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, generated, root, 'silent')

      expect(loaded.config.test.passWithNoTests).toBe(false)
      expect(loaded.config.test.include).toEqual(covering.map(asGlob))
    })
  })

  /* ⚠️ **AND IT WAS ONE KEY OF A WHOLE BLOCK THE MERGE TOOK IN UNREAD.** Vite's
     `mergeConfig` CONCATENATES arrays: an `include` in `vite.config.ts` would
     have widened every subject's tests past its own, a `setupFiles` there would
     have run twice — inherited once, and carried again from the merged block
     `carriedTestOptions` reads — and a `projects` would have undone the
     flattening. So that block may hold what the generated config is merged in
     to inherit, `exclude`, and nothing else: the rest belongs in
     `vitest.config.ts`, where a sweep reads it. Refused before a file is
     written or the lock is taken. */
  it('refuses a vite.config.ts test block holding more than its exclude, before writing or locking', async () => {
    for (const [key, value] of [
      ['passWithNoTests', 'true'],
      ['include', "['src/**']"],
      ['setupFiles', "['./again.ts']"],
    ]) {
      await inScratch('mutants-sweep-', async (root) => {
        checkout(root, {
          'src/a.ts': "export const a = 'a'\n",
          'src/a.test.mjs': "import './a'\n",
          'vite.config.ts': `export default { test: { exclude: ['planted/**'], ${key}: ${value} } }\n`,
        })

        const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'] })

        expect(result.code, key).toBe(2)
        expect(result.stderr).toBe(
          `check-mutants: vite.config.ts sets \`test.${key}\`, which the generated config would inherit through its merge without a sweep reading it — set it in vitest.config.ts, where a sweep reads it\n`,
        )
        expect(result.stdout).toBe('')
        expect(result.locks.taken).toBe(0)
        expect(leftAt(root)).toEqual(NOTHING_LEFT)
      })
    }
  })

  it('refuses a project with no vite.config.ts for the generated config to merge, before writing or locking', async () => {
    await inScratch('mutants-sweep-', async (root) => {
      checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      rmSync(path.join(root, 'vite.config.ts'))

      const result = await sweep(root, { subjects: ['src/a.ts'], tree: ['src/a.ts', 'src/a.test.mjs'] })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: ${path.join(root, 'vite.config.ts')}: no such file — the generated config merges it, as vitest.config.ts does\n`,
      )
      expect(result.stdout).toBe('')
      expect(result.locks.taken).toBe(0)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  it('carries the loosest bound any project declares, the setup files and the one environment, and leaves the rest', () => {
    const project = (name, test = {}) => ({ extends: true, test: { name, include: [`${name}/**`], exclude: ['x'], ...test } })

    expect(
      carriedTestOptions({
        passWithNoTests: true,
        setupFiles: ['./setup.ts'],
        maxWorkers: 8,
        silent: 'passed-only',
        testTimeout: 15_000,
        coverage: { provider: 'v8' },
        include: ['**/*.test.ts'],
        exclude: ['dist/**'],
        projects: [project('unit', { environment: 'node' }), project('gates', { environment: 'node', testTimeout: 60_000 })],
      }),
    ).toEqual({ environment: 'node', setupFiles: ['./setup.ts'], testTimeout: 60_000 })
    /* Nothing restated when the project declares nothing — Vitest's own
       defaults then apply as they do to every other run. */
    expect(carriedTestOptions({})).toEqual({})
    expect(carriedTestOptions({ projects: [project('unit'), project('gates')] })).toEqual({})
  })

  /* ⚠️ **THE BOUND WAS THE LOOSEST ANY BLOCK SPELT, NOT THE LOOSEST ANY TEST RUNS
     UNDER — AND THE TWO DIFFER IN BOTH DIRECTIONS.** A project that declares
     nothing runs under the root's bound, or under Vitest's own 5 s when the root
     declares none either; only what was spelt was compared, so an unspecified
     bound beside a project declaring `10` became 10 ms for every covering test.
     And `0` is Vitest's word for NO bound, which `Math.max` read as the
     tightest, so a root of `0` beside a project's 60 s gave tests that had no
     bound one of 60 s. Found by review on 2026-09-14, both measured here. */
  it('carries the loosest bound a covering test runs under — inherited, defaulted and disabled bounds included', () => {
    const project = (name, test = {}) => ({ extends: true, test: { name, ...test } })

    expect(carriedTestOptions({ projects: [project('unit'), project('gates', { testTimeout: 10 })] })).toEqual({
      testTimeout: 5_000,
    })
    expect(
      carriedTestOptions({ testTimeout: 0, projects: [project('unit'), project('gates', { testTimeout: 60_000 })] }),
    ).toEqual({ testTimeout: 0 })
    /* Vitest's runner bounds nothing for any value `<= 0` or `Infinity` —
       `withTimeout` in `@vitest/runner` 4.1.11 — and `Infinity` has no JSON
       spelling, so each is carried as the `0` that means the same. */
    for (const disabled of [-1, Infinity]) {
      expect(
        carriedTestOptions({
          testTimeout: 15_000,
          projects: [project('unit', { testTimeout: disabled }), project('gates', { testTimeout: 60_000 })],
        }),
        String(disabled),
      ).toEqual({ testTimeout: 0 })
    }
    /* A root bound every project overrides is the bound of no test at all; it
       was carried as the loosest until this case existed. */
    expect(carriedTestOptions({ testTimeout: 90_000, projects: [project('gates', { testTimeout: 60_000 })] })).toEqual({
      testTimeout: 60_000,
    })
    /* With no projects, the root block is the one run. */
    expect(carriedTestOptions({ testTimeout: 20_000 })).toEqual({ testTimeout: 20_000 })
  })

  /* ⚠️ **AN UNDECLARED ENVIRONMENT BESIDE A DECLARED ONE BECAME THE DECLARED
     ONE.** Only what a block spelt was compared, so a project running in
     Vitest's default `node` beside one declaring `jsdom` handed every covering
     test jsdom — the widening a refusal exists to prevent. Found by review on
     2026-09-14. */
  it('reads the environment each project runs in, and refuses two rather than widening one over both', () => {
    const project = (name, test = {}) => ({ extends: true, test: { name, ...test } })
    const TWO = 'vitest.config.ts runs its tests in `node` and `jsdom`, and one run has one environment'

    expect(
      thrownBy(() => carriedTestOptions({ projects: [project('unit'), project('ui', { environment: 'jsdom' })] }))?.message,
    ).toBe(TWO)
    expect(
      thrownBy(() =>
        carriedTestOptions({ environment: 'jsdom', projects: [project('unit', { environment: 'node' }), project('ui')] }),
      )?.message,
    ).toBe(TWO)
    /* One environment, however each project comes by it. */
    expect(
      carriedTestOptions({ environment: 'jsdom', projects: [project('unit'), project('ui', { environment: 'jsdom' })] }),
    ).toEqual({ environment: 'jsdom' })
    expect(carriedTestOptions({ projects: [project('unit'), project('gates', { environment: 'node' })] })).toEqual({
      environment: 'node',
    })
    expect(carriedTestOptions({ environment: 'jsdom' })).toEqual({ environment: 'jsdom' })
  })

  /* ⚠️ A SETTING DROPPED SILENTLY IS HOW THE 15 s BOUND WENT UNNOTICED. So
     one this has not been taught about is refused by name — carried wrongly
     it fails a dry run, dropped it changes what the tests mean — and so is a
     project one flat run cannot honour. */
  it('refuses what it has not been taught to carry or to leave behind, naming it', () => {
    const refusal = (test) => thrownBy(() => carriedTestOptions(test))
    const project = (test, extra = {}) => ({ extends: true, test: { name: 'jsdom-ui', ...test }, ...extra })
    const cases = [
      [undefined, 'vitest.config.ts has no `test` block, so nothing says how its tests run'],
      [
        { globals: true },
        'vitest.config.ts sets `test.globals`, which a sweep neither carries nor leaves behind — teach `carriedTestOptions` which it is',
      ],
      [
        { projects: 'packages/*' },
        'vitest.config.ts lists its projects as "packages/*", and a sweep reads a list of inline projects',
      ],
      [
        { projects: [{ test: { name: 'alone' } }] },
        'vitest.config.ts has a project that does not extend the root `test` block, so the root’s settings are not its settings',
      ],
      [
        { projects: [project({ setupFiles: ['./dom.ts'] })] },
        'vitest.config.ts gives project `jsdom-ui` its own `setupFiles`, which one run over every covering test cannot give to its files alone',
      ],
      [
        { projects: [project({}, { plugins: [] })] },
        'vitest.config.ts gives project `jsdom-ui` its own `plugins`, which one run over every covering test cannot give to its files alone',
      ],
      [
        { projects: [project({ environment: 'node' }), project({ environment: 'jsdom' })] },
        'vitest.config.ts runs its tests in `node` and `jsdom`, and one run has one environment',
      ],
      [
        { testTimeout: '60s' },
        'vitest.config.ts gives `testTimeout` as "60s", which is not a number of milliseconds',
      ],
      /* `NaN` is a number, compares with nothing, and has no JSON spelling — so
         it reached the generated config as `null`, which a merge ignores. */
      [
        { projects: [project({ testTimeout: Number.NaN })] },
        'vitest.config.ts gives `testTimeout` as NaN, which is not a number of milliseconds',
      ],
    ]

    for (const [test, words] of cases) {
      const cause = refusal(test)
      expect(cause, words).toBeInstanceOf(Error)
      expect(cause.message).toBe(words)
    }
  })

  /* Asserted against what the file DECLARES rather than a number copied out
     of it — the number is the thing that drifted. What is pinned is the case
     the finding was about: some project declares a looser bound than the
     root, and that looser bound is what a sweep runs with. */
  it('reads this repository: no covering test gets a tighter bound than its own project declares', async () => {
    const test = await loadTestConfig(process.cwd())
    const declared = [test, ...test.projects.map((project) => project.test)]
      .map((block) => block.testTimeout)
      .filter((bound) => bound !== undefined)

    const carried = carriedTestOptions(test)

    for (const bound of declared) expect(carried.testTimeout).toBeGreaterThanOrEqual(bound)
    expect(declared).toContain(carried.testTimeout)
    expect(carried.testTimeout).toBeGreaterThan(test.testTimeout)
    expect(carried.setupFiles).toEqual(test.setupFiles)
    /* And the block the generated config inherits unread holds only what it is
       merged in for — see the refusal above. */
    expect(Object.keys(await loadViteTestBlock(process.cwd()))).toEqual(['exclude'])
  })

  /* RESTATED, BECAUSE VITEST DOES NOT EXPORT IT: 4.1.11 sets it inside
     `resolveConfig` (`testTimeout ??= browser.enabled ? 15e3 : 5e3`), where
     `configDefaults` never sees it. So the number is held to what Vitest itself
     resolves for a project that declares nothing, and an upgrade that moves it
     fails here rather than quietly in a sweep's arithmetic. */
  it('assumes the bound Vitest itself gives a test that declares none', async () => {
    await inScratch('mutants-default-', async (root) => {
      const { vitestConfig } = await resolveConfig({ config: false, root })

      expect(vitestConfig.testTimeout).toBe(VITEST_DEFAULT_TIMEOUT)
    })
  })
})

describe('the pieces a sweep is built from', () => {
  /* ⚠️ **"NO MUTANT IN IT" IS STRYKER'S ANSWER, NOT A SHAPE'S** (2026-09-14). A
     rule that recognised a type-only module or a re-export would keep exempting
     the file after it grew a line of logic. A constants file is not one of
     those — a string is a mutant — and a number is neither shape and still has
     none. What is disabled beside the code is left out one mutant at a time. */
  it('counts the mutants Stryker itself makes: none in types, a re-export or a number, one per string, less each one disabled beside the code', async () => {
    await inScratch('mutants-count-', async (root) => {
      const at = plant(root, {
        'types.ts': 'export type Row = { readonly id: string }\nexport interface Shelf { readonly rows: readonly Row[] }\n',
        'barrel.ts': "export { LABEL } from './constants'\nexport type { Row } from './types'\nexport * from './types'\n",
        'number.mjs': 'export const LIMIT = 3\n',
        'constants.ts': "export const LABEL = 'Library'\nexport const EMPTY = 'Nothing here'\nexport const LIMIT = 3\n",
        'disabled.ts':
          "// Stryker disable next-line StringLiteral: a label is copy, not behaviour\nexport const LABEL = 'Library'\n" +
          "export const EMPTY = 'Nothing here'\nexport const MORE = 'More'\n",
        'many.ts': Array.from({ length: 11 }, (_, line) => `export const AT_${line + 1} = 'row'\n`).join(''),
      })

      const counted = {}
      for (const name of Object.keys(at)) counted[name] = await mutantsIn(at[name])

      expect(counted).toEqual({ 'types.ts': 0, 'barrel.ts': 0, 'number.mjs': 0, 'constants.ts': 2, 'disabled.ts': 2, 'many.ts': 11 })
      /* And the same mutants by identity, as a REPORT places them: the
         instrumenter counts lines and columns from 0, a report from 1 — measured
         2026-09-14 against a real report of one file, every start and end one
         more than in memory. The disabled mutant is not among them. */
      const literal = (line, from, to) => ({
        mutatorName: 'StringLiteral',
        replacement: '""',
        location: { start: { line, column: from }, end: { line, column: to } },
      })
      expect(await mutantIdentitiesIn(at['constants.ts'])).toEqual([literal(1, 22, 31), literal(2, 22, 36)])
      expect(await mutantIdentitiesIn(at['disabled.ts'])).toEqual([literal(3, 22, 36), literal(4, 21, 27)])
      expect(await mutantIdentitiesIn(at['types.ts'])).toEqual([])
      /* ⚠️ **IN LINE ORDER, WHICH IS NOT THE ORDER THE DIGITS SPELL.** A plan's
         identities and a report's are compared in one order, and past nine lines
         a comparison that read the numbers as text would put 10 before 2 — so the
         first identity a refusal names would be a different one at each end. */
      expect((await mutantIdentitiesIn(at['many.ts'])).map((one) => one.location.start.line)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ])
      /* Counted with Stryker's own defaults, so they are the sweep's only while
         `strykerConfig` leaves both alone. */
      const config = strykerConfig('src/x.ts', 'v.mjs')
      expect(Object.keys(config), 'a sweep configured to mutate differently from the count').not.toContain('mutator')
      expect(Object.keys(config), 'a sweep configured to ignore what the count does not').not.toContain('ignorers')
    })
  })

  /* ⚠️ **A NAME THAT BEGINS WITH A DOT WOULD NEVER HAVE BEEN UPLOADED** (fifth
     review, 2026-09-14): the slug of a basename with no ASCII in it fell away and
     left the extension's own dot leading, and `actions/upload-artifact` leaves
     hidden files out unless told otherwise — so a shard would upload its receipt
     without the result beside it, and the aggregate would report a file missing
     that had in fact been scored. The NAME is what is fixed, not the workflow. */
  it('names a result file so it can never be hidden, never empty, and never another subject’s', () => {
    /* The last two slug away to nothing at all, which is what the readable half
       of the name is replaced for. */
    const subjects = [`src/${'测'.repeat(27)}.ts`, 'src/.ts', 'src/.hidden.ts', 'src/a.ts', 'lib/a.ts', 'src/测.ts', 'src/测', 'src/__']

    const named = subjects.map(resultFileFor)

    for (const [at, name] of named.entries()) {
      expect(name.startsWith('.'), subjects[at]).toBe(false)
      /* Not merely "not a dot": a name that begins with anything but a letter or
         a digit is one more thing an uploader may be taught to leave out. */
      expect(/^[A-Za-z0-9]/u.test(name), `${subjects[at]} → ${name}`).toBe(true)
      expect(name.endsWith('.result.json'), subjects[at]).toBe(true)
      expect(Buffer.byteLength(name, 'utf8'), subjects[at]).toBeLessThanOrEqual(255)
    }
    /* One basename, two files: the digest of the whole path tells them apart. */
    expect(new Set(named).size).toBe(subjects.length)
  })

  it('reads a report that parses, and answers null for one that is missing or is not JSON', () => {
    inScratch('mutants-report-', (root) => {
      const at = plant(root, { 'good.json': '{"files":{}}', 'torn.json': '{"files":' })

      expect(reportFrom(at['good.json'])).toEqual({ files: {} })
      expect(reportFrom(at['torn.json'])).toBe(null)
      expect(reportFrom(path.join(root, 'absent.json'))).toBe(null)
    })
  })

  it('asks once per file for as long as it is kept, however the file is spelt', () => {
    const asked = []
    const ask = remembered((file) => {
      asked.push(file)
      return { answer: file }
    })

    const first = ask('scripts/x.mjs')

    expect(ask('./scripts/x.mjs')).toBe(first)
    expect(ask(path.resolve('scripts/x.mjs'))).toBe(first)
    expect(ask('scripts/y.mjs')).not.toBe(first)
    expect(asked).toEqual(['scripts/x.mjs', 'scripts/y.mjs'])
  })

  /* Asked of a repository of its own: from inside Stryker's sandbox, git
     answers for this checkout's ignored `.stryker-tmp` and lists nothing, so a
     test of this checkout would hold whatever the listing did. */
  it('lists the files under src and scripts that exist, tracked or untracked, and nothing ignored', () => {
    inScratch('mutants-files-', (root) => {
      const git = (...args) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
          { cwd: root, stdio: 'pipe' },
        )
      git('init', '-q')
      plant(root, {
        '.gitignore': 'src/ignored.ts\n',
        'src/kept.ts': '',
        'src/gone.ts': '',
        'scripts/tool.mjs': '',
        'docs/other.ts': '',
      })
      git('add', '.')
      git('commit', '-qm', 'start')
      rmSync(path.join(root, 'src/gone.ts'))
      plant(root, { 'src/new.ts': '', 'src/ignored.ts': '' })

      expect(repositoryFiles(root).sort()).toEqual(['scripts/tool.mjs', 'src/kept.ts', 'src/new.ts'])
    })
  })

  /* With no reach handed in, the tests that reach a subject are the ones that
     import it — so a test reading a file it never imports blocks nothing. Both
     read `a.ts` beside themselves: a bare `'a.ts'` is read from the working
     directory, which is not where this one was planted. */
  it('blocks through the tests that import a subject when not told which reach it', () => {
    inScratch('mutants-reach-', (root) => {
      const read = "readFileSync(new URL('./a.ts', import.meta.url), 'utf8')\n"
      const at = plant(root, {
        'a.ts': 'export const a = 1\n',
        'imports.test.mjs': `import { readFileSync } from 'node:fs'\nimport './a'\n${read}`,
        'only-reads.test.mjs': `import { readFileSync } from 'node:fs'\n${read}`,
      })

      expect(subjectsRead([at['a.ts']], [at['imports.test.mjs']])).toEqual([at['a.ts']])
      expect(subjectsRead([at['a.ts']], [at['only-reads.test.mjs']])).toEqual([])
    })
  })

  /* ⚠️ **A PATHSPEC IS A PATTERN UNLESS IT IS TOLD NOT TO BE** — `src*` was
     refused as tracked on the strength of `src-tauri/.gitignore` (fifth review,
     2026-09-14) — and CASE is git's own question, not the filesystem's, so it is
     asked of git and answered by it. Only `overlapOf` calls this, and only to
     refuse a path, so a listing that quietly widens or narrows is a refusal
     nobody asked for or one nobody got. */
  it('asks git for the name itself rather than a pattern, everything it tracks for an empty name, and without case only when told', () => {
    inScratch('mutants-tracked-', (root) => {
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      plant(root, { 'docs/readme.md': 'tracked\n', 'src/a.ts': 'export const a = 1\n', 'src-extra/keep.txt': 'tracked\n' })
      git('add', '.')
      git('commit', '-qm', 'tracked')

      expect(trackedUnder(root, '').sort()).toEqual(['docs/readme.md', 'src-extra/keep.txt', 'src/a.ts'])
      expect(trackedUnder(root, 'docs')).toEqual(['docs/readme.md'])
      expect(trackedUnder(root, 'src/a.ts')).toEqual(['src/a.ts'])
      /* A wildcard would catch `src-extra/keep.txt`, which is what the literal
         pathspec is there to stop. */
      expect(trackedUnder(root, 'src*')).toEqual([])
      expect(trackedUnder(root, 'DOCS')).toEqual([])
      expect(trackedUnder(root, 'DOCS', true)).toEqual(['docs/readme.md'])
      expect(trackedUnder(root, 'nowhere')).toEqual([])
    })
  })

  /* ⚠️ **ASKED OF THE CHECKOUT, NEVER OF THE PLATFORM** — a Mac's own disk
     ignores case and a volume beside it need not, and the one that decides is the
     one the checkout is on. The parts with no case at all are climbed past, and
     what cannot be looked at answers no, which is the safe way round: reading a
     case-sensitive checkout as caseless folds two different paths into one and
     exempts the second from every refusal `overlapOf` makes. */
  it('asks the checkout’s own filesystem whether it ignores case, climbs past a name that has none, and answers no where it cannot look', () => {
    inScratch('mutants-case-', (root) => {
      mkdirSync(path.join(root, '123'))
      mkdirSync(path.join(root, 'Cased'))
      plant(root, { 'notes.txt': 'not a directory\n' })
      /* Measured of this filesystem rather than assumed of this platform. */
      const ignoresCase = existsSync(path.join(root, 'cased'))

      /* A name with no case in it carries no answer, so the one above it does. */
      expect(caselessAt(path.join(root, '123'))).toBe(ignoresCase)
      expect(caselessAt(root)).toBe(ignoresCase)
      /* Nothing there to look at, and nothing that can be: absent, under a file,
         and a relative path whose every part is caseless. */
      expect(caselessAt(path.join(root, 'absent', 'sub'))).toBe(false)
      expect(caselessAt(path.join(root, 'notes.txt', 'sub'))).toBe(false)
      expect(caselessAt(path.join('123', '456'))).toBe(false)
    })
  })

  /* And a directory it may not look inside is not an answer of no: that is a
     failure, and it is thrown as it came. A case of its own since 2026-09-15, so
     that Windows, which cannot close a directory, still asks everything above. */
  it('throws where it may not look inside a directory, rather than answering no', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    inScratch('mutants-case-', (root) => {
      const closed = path.join(root, 'closed')
      mkdirSync(closed)
      chmodSync(closed, 0o000)
      try {
        /* Root walks straight through, and this would then pass having asked nothing. */
        expect(thrownBy(() => statSync(path.join(closed, 'sub')))?.code, 'this case needs a user permissions apply to').toBe('EACCES')

        expect(thrownBy(() => caselessAt(path.join(closed, 'sub')))?.code).toBe('EACCES')
      } finally {
        chmodSync(closed, 0o700)
      }
    })
  })

  /* ⚠️ **A PLAN'S WHOLE POINT IS THAT ITS SHARDS SWEEP THE SAME TREE**, so what
     this digest cannot tell apart is what a shard cannot refuse. Each kind is its
     own: a link's digest is over its own target and never what it points at, a
     path that is gone is `null` rather than a digest of nothing, an entry that is
     neither is named as that, and the executable bit is part of a file. The order
     is fixed too — a plan is the same bytes on every runner. */
  it('digests each kind in the working tree as its own, names what is gone as gone, and lists them in one order', (context) => {
    inScratch('mutants-tree-', (root) => {
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      plant(root, { 'src/z.ts': 'export const z = 1\n', 'src/gone.ts': 'export const gone = 1\n' })
      git('add', '.')
      git('commit', '-qm', 'start')
      rmSync(path.join(root, 'src/gone.ts'))
      /* `src/z.ts` is a tracked change and `src/a.ts` an untracked one, so the
         two lists arrive out of order and the sort is what puts them in one. */
      plant(root, { 'src/z.ts': 'export const z = 2\n', 'src/a.ts': 'export const a = 1\n', 'x/run.sh': 'echo\n', 'x/plain.sh': 'echo\n' })
      chmodSync(path.join(root, 'x/run.sh'), 0o755)
      symlinkSync('z.ts', path.join(root, 'src/here.ts'))
      symlinkSync('../z.ts', path.join(root, 'src/there.ts'))
      const hashOf = (...parts) => parts.reduce((so, one) => so.update(one), createHash('sha256')).digest('hex')

      const tree = worktreeOf(root)

      expect(Object.keys(tree)).toEqual(['src/a.ts', 'src/gone.ts', 'src/here.ts', 'src/there.ts', 'src/z.ts', 'x/plain.sh', 'x/run.sh'])
      expect(tree['src/gone.ts']).toBe(null)
      /* Two links on the same bytes, pointing at two places. */
      expect(tree['src/here.ts']).toBe(hashOf('link\0z.ts'))
      expect(tree['src/there.ts']).toBe(hashOf('link\0../z.ts'))
      /* And two files of the same bytes, one of them a program — which Windows
         cannot make, so the program is asked last and skipped there. Everything
         above is asked on Windows too, the link targets in `/` included. */
      expect(tree['x/plain.sh']).toBe(hashOf('file\0-\0', 'echo\n'))
      if (WINDOWS) return context.skip(WINDOWS_CANNOT.markAProgram)
      expect(tree['x/run.sh']).toBe(hashOf('file\0x\0', 'echo\n'))
    })
  })

  /* An entry git names that is neither a file nor a link — a tracked path
     replaced by a directory — is a change like any other, and reading it as a
     file would fail the plan rather than record it. */
  it('digests an entry that is neither a file nor a link as the kind it is', () => {
    inScratch('mutants-tree-', (root) => {
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      plant(root, { 'src/z.ts': 'export const z = 1\n' })
      git('add', '.')
      git('commit', '-qm', 'start')
      rmSync(path.join(root, 'src/z.ts'))
      mkdirSync(path.join(root, 'src/z.ts'))

      expect(worktreeOf(root)['src/z.ts']).toBe(createHash('sha256').update('not a file\0').digest('hex'))
    })
  })

  /* ⚠️ **A READ THAT FAILS FOR ANY OTHER REASON IS NOT A PATH THAT IS GONE** — a
     digest of `null` for one this user may not look at would put a shard's
     refusal to sleep over exactly the file nobody can see. */
  it('throws a read of the working tree it cannot make, rather than recording the path as gone', (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    inScratch('mutants-tree-', (root) => {
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      plant(root, { 'closed/kept.ts': 'export const kept = 1\n' })
      git('add', '.')
      git('commit', '-qm', 'start')
      plant(root, { 'closed/kept.ts': 'export const kept = 2\n' })
      chmodSync(path.join(root, 'closed'), 0o000)
      try {
        /* Root walks straight through, and this would then pass having read it. */
        expect(thrownBy(() => lstatSync(path.join(root, 'closed', 'kept.ts')))?.code, 'this case needs a user permissions apply to').toBe('EACCES')

        expect(thrownBy(() => worktreeOf(root))?.code).toBe('EACCES')
      } finally {
        chmodSync(path.join(root, 'closed'), 0o700)
      }
    })
  })

  /* ⚠️ **THE HALF OF THIS THAT RUNS WHERE A FILESYSTEM KEEPS CASE IS REACHED BY
     NO SWEEP ON A MAC**, whose own disk ignores it — so both answers are asked
     for here rather than left to whichever one the machine happens to have. What
     it decides is every refusal `--plan` and `--results` meet, and a comparison
     that folds where it should not exempts a second path from all of them. */
  it('compares two paths as a checkout that ignores case does, and as one that keeps it does', () => {
    const ignoring = pathsAt(true)
    const keeping = pathsAt(false)

    expect(ignoring.fold('SRC/A.ts')).toBe('src/a.ts')
    expect(keeping.fold('SRC/A.ts')).toBe('SRC/A.ts')
    for (const [inner, outer, ignored, kept] of [
      ['src/a.ts', 'src/a.ts', true, true],
      ['SRC/a.ts', 'src/a.ts', true, false],
      ['src/a.ts', 'src', true, true],
      ['src/a.ts', 'SRC', true, false],
      /* A name that merely begins the same is not a name underneath it. */
      ['src-extra/a.ts', 'src', false, false],
      ['src', 'src/a.ts', false, false],
      /* The checkout itself, which holds everything in it. */
      ['anywhere/at/all', '', true, true],
    ]) {
      expect(ignoring.within(inner, outer), `ignoring: ${inner} in ${outer}`).toBe(ignored)
      expect(keeping.within(inner, outer), `keeping: ${inner} in ${outer}`).toBe(kept)
    }
  })

  /* ⚠️ **A THROW NEED NOT BE AN `Error`**, and every `catch` in this gate reads
     the code off whatever it caught — so the one place that asks is the one place
     that can be held to answering rather than throwing itself. */
  it('reads the failure a thrown value names, and nothing from one that names none', () => {
    expect(codeOf(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(codeOf(new Error('no code'))).toBe(undefined)
    expect(codeOf(null)).toBe(undefined)
    expect(codeOf(undefined)).toBe(undefined)
  })

  /* The links a tree carries are found per sweep and handed on; a config asked
     for without them leaves out the fixed names and nothing else. */
  it('leaves out the directories Stryker cannot copy, and only those, when no link was found', () => {
    expect(strykerConfig('src/x.ts', 'v.mjs').ignorePatterns).toEqual([
      '.agents',
      '.claude',
      '.codex',
      '.cc-suite',
      '.stryker-tmp',
      'src-tauri/target',
      'coverage',
      'dist',
      'dist-mobile',
      'bin',
      'dev-docs',
      'docs',
      '.git',
    ])
  })

  /* The two ways a name reaches a read that the probe above does not spell: a
     variable assigned after it is declared, and a loop over a binding declared
     outside it. Both are the language's own, so both are followed. */
  it('follows a name assigned after its declaration, and a loop binding declared outside the loop', () => {
    inScratch('mutants-reads-', (root) => {
      const at = plant(root, {
        'assigned.mjs': 'export {}\n',
        'looped.mjs': 'export {}\n',
        'probe.test.mjs':
          "import { readFileSync } from 'node:fs'\n" +
          "let target\ntarget = './assigned.mjs'\nreadFileSync(new URL(target, import.meta.url), 'utf8')\n" +
          "let each\nfor (each of ['./looped.mjs']) readFileSync(new URL(each, import.meta.url), 'utf8')\n",
      })
      const test = at['probe.test.mjs']

      expect(subjectsRead([at['assigned.mjs'], at['looped.mjs']], [test], () => [test])).toEqual([
        at['assigned.mjs'],
        at['looped.mjs'],
      ])
    })
  })
})

/**
 * ⚠️ **A SHARD'S COMMITS ARE PART OF ITS PLAN.** A shard that re-derived its
 * subjects from a merge base, or at a HEAD commit, that was not the plan's would
 * sweep a different change under the plan's name. Asked of a repository of its
 * own, so what HEAD and the merge base are is known exactly.
 */
describe('the commits a plan is made at', () => {
  const inGit = (root) => (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    ).trim()

  it('reads HEAD and the merge base with the base, and refuses an unresolvable base only when told to depend on it', () => {
    inScratch('mutants-commits-', (root) => {
      const git = inGit(root)
      git('init', '-q', '-b', 'main')
      plant(root, { 'src/a.ts': "export const a = 'a'\n" })
      git('add', '.')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      git('checkout', '-qb', 'work')
      plant(root, { 'src/a.ts': 'export const a = 2\n' })
      git('commit', '-qam', 'work')
      const head = git('rev-parse', 'HEAD')

      expect(commitsOf('main', true, root)).toEqual({ head, mergeBase: base })
      expect(commitsOf('no-such-base', false, root)).toEqual({ head, mergeBase: null })
      const refusal = thrownBy(() => commitsOf('no-such-base', true, root))
      expect(refusal).toBeInstanceOf(Error)
      expect(refusal.message.startsWith('check-mutants: cannot resolve a merge base with "no-such-base", so there is nothing to compare against')).toBe(true)
    })
  })

  it('refuses a checkout with no commit to plan against', () => {
    inScratch('mutants-commits-', (root) => {
      inGit(root)('init', '-q')

      const refusal = thrownBy(() => commitsOf('main', false, root))

      expect(refusal).toBeInstanceOf(Error)
      const words = `check-mutants: ${root} has no HEAD commit, so there is nothing to plan a sweep against — `
      expect(refusal.message.startsWith(words), refusal.message).toBe(true)
      expect(refusal.message.length, 'git’s own reason follows').toBeGreaterThan(words.length)
      /* And git's reason arrives trimmed: its own message ends with a line
         break, which would end this refusal mid-air wherever it is printed
         beside anything else. */
      expect(refusal.message, refusal.message).toBe(refusal.message.trim())
    })
  })
})

/**
 * ⚠️ **SHARDING SPLITS THE FILES, NEVER THE SLOWEST FILE** — acceptance
 * criterion (g), measured 2026-09-14. `scripts/check-mutants.mjs` took 18 min 5 s
 * with 210 mutants timing out; `scripts/check-browser-safe.mjs`, 290 mutants, took
 * 17 s. So the heaviest files get shards of their own, and the rest are spread by
 * mutant count — an ESTIMATE, since one mutant cost about fifteen times as much in
 * the first file as in the second. Placement is decided by weight and then path, so
 * the same files land in the same shards whatever order they were listed in.
 */
describe('how a plan spreads its files over shards', () => {
  const subject = (path, mutants, kind = 'mutated') => ({ path, class: kind, mutants })

  it('gives each of the heaviest files a shard of its own and balances the rest by mutant count, weighing a file it will not run at nothing', () => {
    const subjects = [
      subject('src/f.ts', 591),
      subject('scripts/check-mutants.mjs', 1174),
      subject('src/e.ts', 604),
      subject('src/App.tsx', 876),
      subject('src/c.ts', 735),
      subject('src/d.ts', 609),
      subject('src/unreached.ts', 5000, 'no-test-found'),
    ]

    expect(assignShards(subjects, 4, 2)).toEqual([3, 1, 4, 2, 3, 4, 4])
    /* With nothing isolated, the lightest shard takes the next file whoever is
       already in it — here the file with nothing to run joins `App.tsx`. */
    expect(assignShards(subjects, 4, 0)).toEqual([3, 1, 4, 2, 3, 4, 2])
    expect(assignShards(subjects, 4)).toEqual(assignShards(subjects, 4, 0))
  })

  it('places each file in the same shard whatever order the files arrive in, breaking ties by path and then by the lowest shard', () => {
    const subjects = [subject('src/b.ts', 10), subject('src/a.ts', 10), subject('src/c.ts', 10), subject('src/z.ts', 0, 'no-mutants')]
    const byPath = (list, shards) => Object.fromEntries(list.map((one, at) => [one.path, shards[at]]))
    const reversed = [...subjects].reverse()

    expect(byPath(subjects, assignShards(subjects, 2))).toEqual({ 'src/a.ts': 1, 'src/b.ts': 2, 'src/c.ts': 1, 'src/z.ts': 2 })
    expect(byPath(reversed, assignShards(reversed, 2))).toEqual(byPath(subjects, assignShards(subjects, 2)))
  })

  it('leaves shards empty when there are more shards than files, and isolates only files with mutants to run', () => {
    expect(assignShards([subject('src/a.ts', 3), subject('src/b.ts', 0, 'no-test-found')], 5, 2)).toEqual([1, 2])
    expect(assignShards([subject('src/a.ts', 0), subject('src/b.ts', 0)], 3, 1)).toEqual([1, 1])
    expect(assignShards([], 3, 1)).toEqual([])
  })
})

/** A file's content hash, as a plan records it. */
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** What a stood-in git answers for the commits a checkout is at — the plan's, unless a case moves one. */
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const commitsAt =
  (head = HEAD, mergeBase = BASE) =>
  () => ({ head, mergeBase })

/** git in the repository at `root`, with an identity of its own and no hooks of this machine's. */
const gitIn =
  (root) =>
  (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' },
    ).trim()

/**
 * Reports in which every mutant the plan counts in `a.ts`, `b.ts` and `r.ts` was
 * killed — beside an `Ignored` one, which the count leaves out as Stryker does,
 * and a timeout Stryker DETECTED at the hit limit, which is a kill and is not
 * re-run.
 */
const allKilled = async (files) => ({
  [files['src/a.ts']]: await plantedReport(files['src/a.ts'], 'Killed'),
  [files['src/b.ts']]: await plantedReport(files['src/b.ts'], 'Killed', 'Ignored', DETECTED),
  [files['src/r.ts']]: await plantedReport(files['src/r.ts'], 'Killed'),
})

/** What a sweep says of a subject whose timeouts Stryker all detected at the hit limit, so none was re-run. */
const detectedIn = (subject, detected = 1) =>
  `  ${subject}: ${detected} timeout(s) reached the original's hit limit, which is a detection and needs no re-run, and none was on the wall clock\n`

/** And what it says of one whose wall-clock timeouts were re-run alone. */
const settledIn = (subject, { detected = 0, unsettled = 1, ms = 250, killed = 0, survived = 0, repeated = 0, unresolved = 0 }) =>
  `  ${subject}: ${detected} timeout(s) reached the original's hit limit, which is a detection and needs no re-run; ` +
  `${unsettled} on the wall clock, re-run alone in ${ms} ms: ${killed} killed, ${survived} survived, ${repeated} repeated, ${unresolved} unresolved\n`

/** The planned identity of a one-quote string literal's mutant, at `line` of a `export const x = '…'` fixture. */
const literalAt = (line) => ({
  mutatorName: 'StringLiteral',
  replacement: '""',
  location: { start: { line, column: 18 }, end: { line, column: 21 } },
})

/** How a refusal names that identity. */
const namedLiteralAt = (line) => `StringLiteral at ${line}:18-${line}:21 replaced with ${JSON.stringify('""')}`

/**
 * A checkout holding a changed file of every kind a plan names: `a.ts`, which a
 * test imports; `b.ts`, which a test reaches only through `c.ts`; `n.ts`, with a
 * mutant and no test; `r.ts`, whose own test reads its source beside two that do
 * not; and `z.ts`, with neither a mutant nor a test.
 */
function planned(root) {
  return checkout(root, {
    'src/a.ts': "export const a = 'a'\n",
    'src/a.test.mjs': "import './a'\n",
    'src/b.ts': "export const b = 'b'\nexport const c = 'c'\n",
    'src/c.ts': "export { b, c } from './b'\n",
    'src/c.test.mjs': "import './c'\n",
    'src/n.ts': "export const n = 'n'\n",
    'src/r.ts': "export const r = 'r'\n",
    'src/r.test.mjs':
      "import { readFileSync } from 'node:fs'\nimport './r'\nreadFileSync(new URL('./r.ts', import.meta.url), 'utf8')\n",
    'src/r.behaviour.test.mjs': "import './r'\n",
    'src/r.more.test.mjs': "import './r'\n",
    'src/z.ts': 'export const z = 1\n',
  })
}
const PLANNED = ['src/a.ts', 'src/b.ts', 'src/n.ts', 'src/r.ts', 'src/z.ts']
/** The same, less the one file that fails however it is swept. */
const PASSING = PLANNED.filter((file) => file !== 'src/n.ts')
const PLANNED_TREE = [
  'src/a.ts',
  'src/a.test.mjs',
  'src/b.ts',
  'src/c.ts',
  'src/c.test.mjs',
  'src/n.ts',
  'src/r.ts',
  'src/r.test.mjs',
  'src/r.behaviour.test.mjs',
  'src/r.more.test.mjs',
  'src/z.ts',
]

/** Plans `subjects` of `planned(root)` over `shards`, and answers the manifest's path. */
async function planOver(root, { subjects = PLANNED, shards = 3, isolate = 1, ...options } = {}) {
  const manifest = path.join(root, 'plan.json')
  const result = await sweep(root, {
    argv: ['--plan', manifest, '--shards', String(shards), '--isolate', String(isolate)],
    subjects,
    tree: PLANNED_TREE,
    commits: commitsAt(),
    ...options,
  })
  expect(result.code, result.stderr).toBe(0)
  return manifest
}

/** Shard `spec` of the plan at `manifest`, into `<root>/results`. */
function shardOf(root, manifest, spec, { subjects = PLANNED, ...options } = {}) {
  return sweep(root, {
    argv: ['--shard', spec, '--manifest', manifest, '--results', path.join(root, 'results')],
    subjects,
    tree: PLANNED_TREE,
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

/** Plans `subjects` over three shards and sweeps all three with Stryker stood in. */
async function plannedAndSwept(root, { subjects = PLANNED, reports = {}, exits = {} } = {}) {
  const manifest = await planOver(root, { subjects })
  const { stryker } = strykerStandIn(root, { reports, exits })
  for (const spec of ['1/3', '2/3', '3/3']) await shardOf(root, manifest, spec, { subjects, stryker })
  return manifest
}

const resultIn = (results, shard, subject) => path.join(results, `shard-${shard}`, resultFileFor(subject))
const receiptIn = (results, shard) => path.join(results, `shard-${shard}`, 'receipt.json')

const ESTIMATE =
  "  Mutant counts are an estimate of what a shard costs, not a measure of it: one mutant cost about fifteen times as much in one measured file as in another. Every result records the file's measured duration.\n"
const shardSays = (manifest, spec, files) =>
  `check-mutants: shard ${spec} of ${manifest} — ${files} file(s) are this shard's; whether the sweep passed is for --aggregate to say, over every shard\n`
const emptyShardSays = (manifest, spec) =>
  `check-mutants: shard ${spec} of ${manifest} has no file to sweep — it passes nothing on its own; whether the sweep passed is for --aggregate to say, over every shard\n`
const reconcileFails = (manifest) =>
  `check-mutants: the shards do not account for every file in ${manifest} exactly once, so the sweep is not complete:\n`
const reconciled = (manifest, shards) =>
  `check-mutants: every file in ${manifest} has exactly one result, from ${shards} shard(s) that each finished\n`
const survivedIn = (...files) =>
  `check-mutants: a mutant survived in ${files.length} file(s) — a test that cannot fail is not a test.\n` +
  files.map((f) => `  ${f}\n`).join('') +
  '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
  '  mutation is genuinely equivalent, say so beside the code:\n' +
  '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n'
/** What a sweep fails with for each file whose wall-clock timeout came back a wall-clock timeout. */
const timedOutIn = (files, places) =>
  `check-mutants: a wall-clock timeout came back a wall-clock timeout in ${files.length} file(s) — the settle run, with a 30 s deadline and a 4× factor, could not resolve it, so whether a test kills it is unknown.\n` +
  files.map((f) => `  ${f}\n`).join('') +
  '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
  '  mutation genuinely never terminates, say so beside the code:\n' +
  '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n' +
  places.map((at) => `  repeated: ${at}\n`).join('')

/** And how it names one whose reason it does not recognise, which it settled as a wall-clock timeout anyway. */
const unrecognisedAt = (at, reason) =>
  `${at} — its reason, ${JSON.stringify(reason)}, is one this gate does not know, so it was settled as a wall-clock timeout`

const notRunIn = (tail, ...files) =>
  `check-mutants: Stryker did not finish for ${files.length} file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n` +
  files.map((f) => `  ${f}\n`).join('') +
  tail
const RUN_TAIL = "  Its own error is above; nothing about these files' tests is known yet.\n"

/**
 * And what it adds for each mutant the settle run reached no verdict for. A file
 * whose settle run scored NOTHING gets both this and `notRunIn`: the second says
 * the run has no score, and this one says which mutants were left undecided by
 * it — which is the half that survives a survivor in the same file, where the
 * file-level outcome becomes `survived` and the no-score is lost. See
 * `noVerdictFor`.
 */
const unresolvedIn = (file, ...places) =>
  `check-mutants: the settle run reached no verdict for ${places.length} mutant(s) in 1 file(s) — a crash, an OOM-killed runner, or a report that simply does not mention them. A mutant with no score was not measured, and an unmeasured mutant is never a pass.\n` +
  `  ${file}\n` +
  '  Re-run the file alone, on a quiet machine, and read the settle run’s log\n' +
  '  for the runner that died:\n' +
  `    node scripts/check-mutants.mjs --only ${file}\n` +
  places.map((at) => `  unresolved: ${file}:${at}\n`).join('')

/**
 * What a sweep writes for the survivors Stryker marks static — on stdout, beside
 * the rest of the measurement, and whether the file passes or fails. It used to
 * sit under the survivors on stderr, which stopped being everywhere it belonged
 * the moment the merge base could authorise one. See `summarise`.
 */
const staticNote = (...ats) =>
  `check-mutants: ${ats.length} survivor(s) are static, and a static mutant is the one kind this gate cannot read off a report:\n` +
  ats
    .map(
      (at) =>
        `  static: ${at} — a static mutant that throws while the module is imported is reported Survived by Stryker's vitest runner, because the suite fails to load; verify it by hand, and if it does throw, disable it beside the code with that reason\n`,
    )
    .join('')
const AGGREGATE_TAIL = "  Its own error is in the log of the shard that ran it; nothing about these files' tests is known yet.\n"

/**
 * ## What a survivor costs, measured against the merge base
 *
 * ⚠️ **THE GATE BILLED WHOEVER TOUCHED A FILE FOR WHOEVER WROTE THE DEBT**, and
 * the owner's verdict was that the repository had become undevelopable: removing
 * one unused three-line reader from `scripts/lib/ledger.mjs` brought its 389
 * mutants under the 100 % rule and left 97 unkilled, and fixing one word in a
 * comment in `scripts/word-snap-live.mjs` left 240. A one-line fix in a large old
 * file bills the fixer for years of accumulated debt, which argues for not making
 * the fix. See `dev-docs/adr/0002-mutation-gate-judges-what-a-change-adds.md`.
 *
 * So: the file is still mutated WHOLE, and at 100 % nothing else happens. With a
 * survivor, the same file is measured at the merge base and the two are compared
 * by identity — and only what the change ADDED fails. Every way that measurement
 * can fail is a refusal that fails the build, because "could not run" must never
 * become "it already survived".
 */
describe('a survivor measured against the merge base', () => {
  /** What the merge base holds at each file these cases plant, which is what they hold here too. */
  const A_SOURCE = "export const a = 'a'\n"
  const sourceOf = (named) => (named === 'src/b.ts' ? "export const b = 'b'\n" : A_SOURCE)
  const hashOf = (text) => createHash('sha256').update(text).digest('hex')
  const A_SHA = hashOf(A_SOURCE)
  /**
   * What a base measurement of `named` answers, with whatever `fields` change:
   * the content it swept and Stryker's own report of sweeping it. The survivors
   * are DERIVED from those by everything that reads them — a measurement carries
   * no list of them, because a list beside the evidence is not evidence.
   */
  const measuredAt = async (root, named, fields = {}) => ({
    install: 'linked',
    outcome: 'survived',
    durationMs: 900,
    sha256: hashOf(sourceOf(named)),
    source: sourceOf(named),
    first: { exitedCleanly: false, durationMs: 900, report: await reportOfSource(path.join(root, named), sourceOf(named), 'Survived') },
    settle: null,
    ...fields,
  })
  /** And the same for a merge base that KILLED it: a complete measurement holding no survivor at all. */
  const killedAt = async (root, named) =>
    measuredAt(root, named, {
      outcome: 'killed',
      first: { exitedCleanly: true, durationMs: 900, report: await reportOfSource(path.join(root, named), sourceOf(named), 'Killed') },
    })
  /** Every subject is its own file at the merge base, at the content the merge base holds there. */
  const itsOwn = (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: hashOf(sourceOf(name)) }]))

  /** A sweep of one file whose one mutant survived, with the merge base stood in for. */
  const sweeping = (options) =>
    inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutatedFile = at['src/a.ts']
      const { stryker } = strykerStandIn(root, {
        reports: { [mutatedFile]: await plantedReport(mutatedFile, 'Survived') },
        exits: { [mutatedFile]: false },
      })
      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        measure: (named, _commit, asked) => measuredAt(asked.root, named),
        ...options,
      })
      return { ...result, subject: mutatedFile, root }
    })

  /**
   * ⚠️ **AND THE SAME FOR A HANG, WHICH NEVER REACHED THE MERGE BASE AT ALL
   * UNTIL 2026-09-20.** A wall-clock timeout that repeats is not a survivor — it
   * is *whether a test kills it is unknown* — so it failed outright and nothing
   * asked whether the base hung on it too. Driven through a whole sweep rather
   * than against the pairing alone: the pairing had cases from the day it was
   * written, and the WIRING that reaches it is what was missing.
   */
  describe('a hang the merge base hung on too', () => {
    /** A run that meets a wall-clock timeout, and a settle run that meets it again. */
    const hanging = async (planted) => ({
      report: await plantedReport(planted, { status: 'Timeout' }),
      settled: await plantedReport(planted, { status: 'Timeout' }),
    })

    const sweepingAHang = (measure) =>
      inScratch('mutants-hang-', async (root) => {
        const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
        const planted = at['src/a.ts']
        const { report, settled } = await hanging(planted)
        const { stryker } = strykerStandIn(root, {
          reports: { [planted]: report },
          settled: { [planted]: settled },
          exits: { [planted]: true },
          settleExits: { [planted]: true },
        })
        const result = await sweep(root, {
          subjects: ['src/a.ts'],
          tree: ['src/a.ts', 'src/a.test.mjs'],
          stryker,
          mergeBase: () => BASE,
          origins: itsOwn,
          measure: (named, _commit, asked) => measure(asked.root, named),
        })
        return { ...result, subject: planted, root }
      })

    it('passes, where the base met the same wall-clock timeout twice', async () => {
      const result = await sweepingAHang(async (root, named) => {
        const { report, settled } = await hanging(path.join(root, named))
        return measuredAt(root, named, {
          outcome: 'killed',
          first: { exitedCleanly: true, durationMs: 900, report },
          settle: { exitedCleanly: true, durationMs: 400, report: settled },
        })
      })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain('came back a wall-clock timeout')
    })

    it('fails, where the base settled the same mutant to a kill', async () => {
      const result = await sweepingAHang(killedAt)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('came back a wall-clock timeout in 1 file(s)')
    })

    it('fails, where the merge base could not be measured at all', async () => {
      /* "Could not run" is never "it already hung", exactly as it is never "it
         already survived". */
      const result = await sweepingAHang(async (root, named) => {
        const { report, settled } = await hanging(path.join(root, named))
        /* A measurement of content the merge base does not hold there, which is
           refused for `content` — a real refusal through a real road, rather
           than a thrown shape standing in for one. It hangs on the same mutant,
           so anything that read past the refusal would authorise it. */
        return measuredAt(root, named, {
          outcome: 'killed',
          sha256: 'a'.repeat(64),
          first: { exitedCleanly: true, durationMs: 900, report },
          settle: { exitedCleanly: true, durationMs: 400, report: settled },
        })
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('came back a wall-clock timeout in 1 file(s)')
    })
  })

  it('passes a survivor the merge base owed too, and says how many, from where, and what measuring it cost', async () => {
    const result = await sweeping()

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(
      'check-mutants: 1 file(s) had a mutant survive, so the merge base was measured for what each already owed there:\n' +
        `  ${result.subject} — 1 of 1 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, 900 ms)\n`,
    )
    /* ⚠️ **AND IT NEVER CLAIMS EVERY MUTANT WAS KILLED.** One is alive in that
       file; the merge base owed it, which is a reason not to bill this change and
       not a reason to tell a reader the file is clean. */
    expect(result.stdout).not.toContain('every mutant was killed')
  })

  /* ⚠️ **AN UNRESOLVED TIMEOUT USED TO LEAVE UNDER A SURVIVOR THE BASE HAD
     AUTHORISED, AND THE SWEEP PASSED** — found by a second opinion's fifth
     round, 2026-09-17, and reproduced exactly here. Two findings shared one
     `outcome`, and `survived` came first in that chain: the unresolved mutant
     was counted, printed in the timeout line, and then decided nothing, after
     which the merge base answered for the survivor and no failure was left. It
     took BOTH halves to hide, which is why the 2026-09-16 fix — which made an
     unresolved mutant fail where nothing survived — did not catch it.

     A mutant with no score was never measured, and the merge base was never
     asked about it, so no authorisation can answer for it. It fails on its own
     channel now; see `noVerdictFor`. */
  it('fails a mutant the settle run reached no verdict for, though the merge base answered for every survivor', async () =>
    inScratch('mutants-unresolved-', async (root) => {
      const source = "export const a = 'a'\nexport const b = 'b'\n"
      const at = checkout(root, { 'src/a.ts': source, 'src/a.test.mjs': "import './a'\n" })
      const mutated = at['src/a.ts']
      const { stryker } = strykerStandIn(root, {
        reports: { [mutated]: await plantedReport(mutated, 'Survived', { status: 'Timeout' }) },
        settled: { [mutated]: await plantedReport(mutated, 'Survived', { status: 'RuntimeError' }) },
        exits: { [mutated]: false },
      })
      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: () => BASE,
        origins: (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: hashOf(source) }])),
        measure: async (named, _commit, asked) => ({
          install: 'linked',
          outcome: 'survived',
          durationMs: 900,
          sha256: hashOf(source),
          source,
          first: { exitedCleanly: false, durationMs: 900, report: await reportOfSource(path.join(asked.root, named), source, 'Survived') },
          settle: null,
        }),
      })

      /* The merge base did answer for the survivor, and that half is unchanged. */
      expect(result.stdout).toContain('1 of 1 survivor(s) were there too')
      /* And the file fails anyway, on the mutant nothing scored. */
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('check-mutants: the settle run reached no verdict for 1 mutant(s) in 1 file(s)')
      expect(result.stderr).toContain(`  unresolved: ${mutated}:2:18 — the settle run answered "RuntimeError", which is no verdict\n`)
    }))

  /* ⚠️ **A TEST NEITHER SWEEP COULD RUN USED TO BE FREE EVIDENCE TO DELETE** — a
     second opinion's fifth round, 2026-09-17. A test may read the subject's
     source AND assert its behaviour; both sweeps leave it out, because Stryker
     rewrites the file it reads. While it is the same on both sides that costs
     nothing — the mutant it would kill survives in both, and authorising it is
     right. Delete it, though, and head loses a real killer while the base still
     shows the mutant surviving, so the base authorises a survivor THIS CHANGE
     caused. The base carries what it left out by content now, and a file whose
     excluded test has moved authorises nothing. */
  it('authorises nothing when a test the merge base could not run is gone from here', async () => {
    const result = await sweeping({
      measure: async (named, _commit, asked) => ({
        ...(await measuredAt(asked.root, named)),
        excluded: [{ path: 'src/reads.test.mjs', sha256: 'f'.repeat(64) }],
      }),
    })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('it could not be measured (reading-changed)')
    expect(result.stdout).toContain("check-mutants: src/reads.test.mjs reads src/a.ts's own source, so neither sweep could run it — and it is gone")
  })

  /* And the other half, which is what stops the rule above from billing every
     file that has a reading test at all: one that is still here, unchanged, is
     the same missing evidence on both sides and authorises exactly as before. */
  it('authorises as usual when the test the merge base could not run is still here unchanged', async () => {
    const result = await sweeping({
      measure: async (named, _commit, asked) => ({
        ...(await measuredAt(asked.root, named)),
        excluded: [{ path: 'src/a.test.mjs', sha256: hashOf("import './a'\n") }],
      }),
    })

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1 of 1 survivor(s) were there too')
  })

  /* ⚠️ **AND THE SAME FOR A TEST VITEST NEVER RAN** (2026-09-18). One whose route
     reaches a load no import graph can follow is dropped by Vitest's `related`
     filter at the merge base and here alike — missing from both sides, as a
     reader is — so the base carries that route by content, and authorises
     nothing once a file on it has moved. */
  const UNSEEN = 'src/a.test.mjs reaches a computed import() in src/a.test.mjs, which the merge base never ran'

  it('authorises nothing when a file on a route the merge base never ran has changed or gone', async () => {
    for (const [sha256, named, how] of [
      ['f'.repeat(64), 'src/a.test.mjs', 'has changed'],
      [hashOf("import './a'\n"), 'src/gone.test.mjs', 'is gone'],
    ]) {
      const result = await sweeping({
        measure: async (subject, _commit, asked) => ({
          ...(await measuredAt(asked.root, subject)),
          unseen: [{ path: named, sha256, why: UNSEEN }],
        }),
      })

      expect(result.code, how).toBe(1)
      expect(result.stdout, how).toContain('it could not be measured (unseen-changed)')
      expect(result.stdout, how).toContain(
        `check-mutants: ${named} ${how} since the merge base — ${UNSEEN}. A killer on that route was never run on either side, ` +
          'so nothing in src/a.ts is authorised by a base whose route is not the one here: kill the mutants with a test Vitest ' +
          'can trace to the file, or leave the route as it was.',
      )
    }
  })

  it('authorises as usual when every file on a route the merge base never ran is unchanged', async () => {
    const result = await sweeping({
      measure: async (named, _commit, asked) => ({
        ...(await measuredAt(asked.root, named)),
        unseen: [{ path: 'src/a.test.mjs', sha256: hashOf("import './a'\n"), why: UNSEEN }],
      }),
    })

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1 of 1 survivor(s) were there too')
  })

  /* ⚠️ **A FALSE SURVIVOR AT THE BASE HAD BECOME PERMISSION** — a second
     opinion's fifth round, 2026-09-17. Stryker's vitest runner reports a mutant
     that throws while the module is IMPORTED as `Survived`, because a suite that
     fails to load fails no test; this gate has measured that and names three
     live examples. While every survivor failed a sweep, the error was harmless
     in the safe direction. Read at the merge base it points the other way: a
     mutant that may never have run becomes a reason not to bill one here. So it
     decides nothing, and is named as undecided — see `alsoStatic`. */
  it('authorises nothing from a base survivor Stryker marks static, because that status may mean the module never loaded', async () => {
    const result = await sweeping({
      measure: async (named, _commit, asked) => {
        const measured = await measuredAt(asked.root, named)
        const planted = path.join(asked.root, named)
        const entry = measured.first.report.files[planted]
        const statics = { ...entry, mutants: entry.mutants.map((one) => ({ ...one, static: true })) }
        return { ...measured, first: { ...measured.first, report: { files: { [planted]: statics } } } }
      },
    })

    expect(result.code).toBe(1)
    /* Not authorised, and not billed as added either: it is an identity the base
       could not answer for, which is its own class — see `differenceAtBase`. */
    expect(result.stdout).toContain('0 of 1 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, 900 ms); 1 the merge base could not decide')
    expect(result.stderr).toContain('report marks it static')
  })

  /* ⚠️ **THE BILL FOR A ONE-COMMENT CHANGE WAS TWO, AND BOTH WERE THE
     ASYMMETRY** — measured 2026-09-17 on the real `session.ts`, head sweeping
     215 tests and the merge base 527. A mutant a distant test kills at the base,
     which no near test even runs here, is a survivor here and none there, so it
     was billed as one the change added. The change was a comment.

     A bill is taken on the narrow run alone no longer: what would be charged is
     swept again here against the base's own wide set, and that answer REPLACES
     the narrow one. Here the second run kills it, so nothing is owed. */
  it('drops a bill the wider set of tests kills here, rather than charging the discovery difference to the change', async () =>
    inScratch('mutants-widened-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutated = at['src/a.ts']
      const survived = await plantedReport(mutated, 'Survived')
      const killed = await plantedReport(mutated, 'Killed')
      /* The narrow run first, then the wide one — which is the only difference
         between them, and stands in for the tests the near level never runs. */
      let runs = 0
      const stryker = async (config) => {
        const settling = JSON.parse(readFileSync(config, 'utf8')).timeoutFactor !== undefined
        const report = settling || runs++ === 0 ? survived : killed
        writeFileSync(path.join(root, REPORT), JSON.stringify(report))
        return report === killed
      }

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        /* The merge base killed it, so the narrow comparison would bill it. */
        measure: (named, _commit, asked) => killedAt(asked.root, named),
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      /* And the second sweep really happened: three runs is narrow, then wide. */
      expect(runs).toBe(2)
    }))

  /* And the property that makes the second run safe to trust at all: it may take
     a survivor away and may never add one. A second opinion declined to grant
     that more tests always kill more of THIS runner, naming a configuration in
     this gate's own history that turned 85 kills into uncovered mutants — so the
     wide answer is intersected with the narrow one rather than replacing it. The
     mutant the wide run alone calls a survivor is discarded, not charged. */
  it('never turns the wider run’s own new survivor into a bill', async () =>
    inScratch('mutants-widened-', async (root) => {
      const source = "export const a = 'a'\nexport const b = 'b'\n"
      const at = checkout(root, { 'src/a.ts': source, 'src/a.test.mjs': "import './a'\n" })
      const mutated = at['src/a.ts']
      const narrow = await plantedReport(mutated, 'Survived', 'Killed')
      const wide = await plantedReport(mutated, 'Killed', 'Survived')
      let runs = 0
      const stryker = async (config) => {
        const settling = JSON.parse(readFileSync(config, 'utf8')).timeoutFactor !== undefined
        const report = settling || runs++ === 0 ? narrow : wide
        writeFileSync(path.join(root, REPORT), JSON.stringify(report))
        return false
      }

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: () => BASE,
        origins: (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: hashOf(source) }])),
        /* The merge base killed both, so the narrow survivor would be billed. */
        measure: async (named, _commit, asked) => ({
          install: 'linked',
          outcome: 'killed',
          durationMs: 900,
          sha256: hashOf(source),
          source,
          first: { exitedCleanly: true, durationMs: 900, report: await reportOfSource(path.join(asked.root, named), source, 'Killed') },
          settle: null,
        }),
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(runs).toBe(2)
    }))

  /* ⚠️ **AND THE WIDENED SWEEP SETTLES ITS OWN TIMEOUTS, THOUGH IT COSTS A
     SECOND PASS.** Going without was tried and reverted the same day: it saves a
     30-minute sweep and pays for it by keeping a charge on any mutant the wide
     run merely ran out of clock on — and a wall-clock timeout is usually LOAD,
     which this gate has measured at 58 timeouts busy against 0 quiet in one
     file. That is the false bill this whole path exists to remove, arriving on
     the machines least able to argue with it. Three runs, and the charge goes. */
  it('settles the widened sweep’s own timeouts, so a mutant the clock beat still discharges its charge', async () =>
    inScratch('mutants-widened-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutated = at['src/a.ts']
      const survived = await plantedReport(mutated, 'Survived')
      /* No `statusReason`, so a wall-clock timeout: no verdict on its own. */
      const timedOut = await plantedReport(mutated, { status: 'Timeout' })
      const killed = await plantedReport(mutated, 'Killed')
      let runs = 0
      const stryker = async (config) => {
        const settling = JSON.parse(readFileSync(config, 'utf8')).timeoutFactor !== undefined
        const report = settling ? killed : runs === 0 ? survived : timedOut
        runs += 1
        writeFileSync(path.join(root, REPORT), JSON.stringify(report))
        return report === killed
      }

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        /* The merge base killed it, so the narrow comparison bills it. */
        measure: (named, _commit, asked) => killedAt(asked.root, named),
      })

      /* The narrow run, the widened one, and the widened one's settle pass. */
      expect(runs).toBe(3)
      /* And the settle run's kill is what discharges the charge. */
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
    }))

  /* ⚠️ **AND A SECOND WIDE PASS IS NOT ALWAYS AFFORDABLE.** It costs a whole
     sweep of the file again: measured on `session.ts`, 31 minutes against a
     12-minute narrow run. On this gate's own heaviest subject — itself, at an
     estimated 204 minutes for one plain pass — starting a second one unbounded
     is how a 210-minute CI step ends with no answer at all, which is worse than
     the answer it was trying to correct. The file's own sweep is what a second
     one would cost, so that is what is spent against the budget; refusing leaves
     the NARROW bill standing, which is the safe direction, and says so. */
  it('spends no second sweep on a file whose own sweep was already too long, and names the bill as the narrow one', async () =>
    inScratch('mutants-widened-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutated = at['src/a.ts']
      const { stryker } = strykerStandIn(root, {
        reports: { [mutated]: await plantedReport(mutated, 'Survived') },
        exits: { [mutated]: false },
      })
      let runs = 0
      /* Every reading is 21 minutes past the last, so the one sweep this file
         gets is already over the budget a second one would need. */
      let now = 0
      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker: (config) => {
          runs += 1
          return stryker(config)
        },
        clock: () => (now += 21 * 60_000),
        mergeBase: () => BASE,
        origins: itsOwn,
        measure: (named, _commit, asked) => killedAt(asked.root, named),
      })

      /* The narrow sweep, and no second one. */
      expect(runs).toBe(1)
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('past the 20 this gate will spend again')
      expect(result.stdout).toContain('can only ever bill MORE than the wider set would')
    }))

  it('fails a survivor the merge base did not owe, naming what was mutated and why nothing there answers for it', async () => {
    const result = await sweeping({ measure: (named, _commit, { root }) => killedAt(root, named) })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      `  ${result.subject} — 0 of 1 survivor(s) were there too, in itself at the merge base (killed, dependencies linked, 900 ms); 1 this change added\n`,
    )
    expect(result.stderr).toContain('check-mutants: a mutant survived in 1 file(s) — a test that cannot fail is not a test.\n')
    expect(result.stderr).toContain(
      '  added: src/a.ts:1:18 — StringLiteral replacing "\'a\'" with "\\"\\"" in the file itself — ' +
        'the merge base has no survivor with this identity in src/a.ts\n',
    )
  })

  /* ⚠️ **A SURVIVOR OF THE SAME SHAPE IN OTHER CODE IS NOT THE SAME SURVIVOR.**
     The identity carries the text that was mutated, because Stryker gives
     `return "old"` and `return "new"` one replacement — so without it a line the
     change REWROTE would inherit the debt of the line it replaced. */
  it('fails a survivor whose mutated text is not the text the merge base had', async () => {
    /* The merge base's own content, which is where the difference lives: its one
       survivor is a mutant of `'was'`, and nothing here mutated that. */
    const wasThere = "export const a = 'was'\n"
    const held = createHash('sha256').update(wasThere).digest('hex')

    const result = await sweeping({
      origins: (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: held }])),
      measure: async (named, _commit, { root }) => ({
        ...(await measuredAt(root, named)),
        sha256: held,
        source: wasThere,
        first: { exitedCleanly: false, durationMs: 900, report: await reportOfSource(path.join(root, named), wasThere, 'Survived') },
      }),
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('  added: src/a.ts:1:18 — StringLiteral replacing "\'a\'"')
  })

  /* ⚠️ **A FAILURE TO MEASURE IS NEVER PERMISSION.** The refusal here is the real
     one: a merge base this checkout does not have, which is exactly what a
     shallow clone gives — and the honest answer to it is to fetch the base, never
     to read the silence as a survivor that was already there. */
  it('fails a file whose merge base cannot be measured at all, in the refusal’s own words', async () => {
    const missing = 'c'.repeat(40)

    const result = await sweeping({ mergeBase: () => missing, measure: measureAtBase })

    expect(result.code).toBe(1)
    expect(result.stdout).toContain(
      `  ${result.subject} — it could not be measured (no-commit), so nothing here is authorised — check-mutants: the merge base ${missing} is not in this checkout`,
    )
    expect(result.stderr).toContain(
      'check-mutants: the merge base could not be measured for 1 file(s), so nothing authorises the mutants that survived in them — ' +
        'a failure to measure is never permission, and "could not run" is never "it already survived":\n' +
        `  ${result.subject} — no-commit: check-mutants: the merge base ${missing} is not in this checkout`,
    )
  })

  /* ⚠️ **A DEFECT IN THE MEASUREMENT IS NOT EVIDENCE OF ANYTHING.** Only a
     refusal — a named way the merge base could not be measured — becomes
     evidence; anything else is a broken gate, and a broken gate that reported
     "could not measure" would be indistinguishable from a shallow clone. */
  it('lets a failure that is not a refusal out, rather than recording it as a merge base it could not measure', async () => {
    const broke = await sweeping({
      measure: () => {
        throw new Error('the measurement broke')
      },
    }).then(
      () => null,
      (cause) => cause,
    )

    expect(broke).toBeInstanceOf(Error)
    expect(broke.message).toBe('the measurement broke')
  })

  /* A file the merge base has no origin for is NEW, and a new file owes all of
     its own: nothing is measured, and it fails exactly as it did before any of
     this existed. */
  it('measures nothing for a file the merge base has no origin for, and fails it as it always did', async () => {
    const result = await sweeping({
      origins: (names) => new Map(names.map((name) => [name, null])),
      measure: () => {
        throw new Error('a new file owes all of its own, and has nothing at the merge base to ask')
      },
    })

    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('the merge base was measured')
    expect(result.stderr).toBe(
      'check-mutants: a mutant survived in 1 file(s) — a test that cannot fail is not a test.\n' +
        `  ${result.subject}\n` +
        '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
        '  mutation is genuinely equivalent, say so beside the code:\n' +
        '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n',
    )
  })

  /* ⚠️ **AND A NAME THE ORIGINS ANSWER NOTHING FOR IS A NAME WITH NO ORIGIN** —
     fail-closed, rather than a measurement of `undefined`. */
  it('treats a subject the origins hold no answer for as a file with none', async () => {
    const result = await sweeping({
      origins: () => new Map(),
      measure: () => {
        throw new Error('there is no base file to measure')
      },
    })

    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('the merge base was measured')
  })

  /**
   * ⚠️ **ONE HISTORICAL SURVIVOR WAS SPENT ONCE PER SUBJECT** (review,
   * 2026-09-17). The pairing is one subject's, because a shard sees one subject —
   * so a change that copies a file into two, both traced to one origin, had that
   * origin's single survivor authorise both. Here they are in one process, and
   * still each was judged alone.
   *
   * The sweep's own pairing is made over every subject at once, with one pool per
   * base file: one of the two copies takes the survivor and the other owes it,
   * so the one historical occurrence is spent once however many copies ask.
   */
  it('spends one survivor at the merge base once over the whole sweep, not once per file copied from it', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, {
        'src/one.ts': A_SOURCE,
        'src/one.test.mjs': "import './one'\n",
        'src/two.ts': A_SOURCE,
        'src/two.test.mjs': "import './two'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/one.ts']]: await plantedReport(at['src/one.ts'], 'Survived'),
          [at['src/two.ts']]: await plantedReport(at['src/two.ts'], 'Survived'),
        },
        exits: { [at['src/one.ts']]: false, [at['src/two.ts']]: false },
      })
      const asked = []

      const result = await sweep(root, {
        subjects: ['src/one.ts', 'src/two.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => BASE,
        origins: (names) => new Map(names.map((name) => [name, { path: 'src/a.ts', how: 'copied', sha256: A_SHA }])),
        measure: (named, _commit, world) => {
          asked.push(named)
          return measuredAt(world.root, named)
        },
      })

      expect(result.code).toBe(1)
      /* ⚠️ **AND THE MERGE BASE IS MEASURED ONCE PER BASE FILE**, not once per
         subject: the second subject asks the same question of the same commit,
         and asking it twice costs a second worktree and a second install — and
         then invites the two answers to differ. */
      expect(asked).toEqual(['src/a.ts'])
      const spent = 'the merge base has 1 survivor(s) with this identity in src/a.ts, and each of them answers for another survivor here'
      expect(result.stderr).toContain(`  added: src/two.ts:1:18 — StringLiteral replacing "'a'" with "\\"\\"" in the file itself — ${spent}\n`)
      expect(result.stderr).not.toContain('  added: src/one.ts:')
      expect(result.stdout).toContain(`  ${at['src/one.ts']} — 1 of 1 survivor(s) were there too`)
      expect(result.stdout).toContain(`  ${at['src/two.ts']} — 0 of 1 survivor(s) were there too`)
    })
  })

  it('measures the file the merge base traced it to, not the file it is now', async () => {
    const asked = []

    const result = await sweeping({
      origins: (names) => new Map(names.map((name) => [name, { path: 'src/old.ts', how: 'renamed', sha256: A_SHA }])),
      measure: (named, commit, { root }) => {
        asked.push([named, commit])
        /* Reported under the name the plan traced this file TO, which is the file
           the merge base has and not the one this checkout holds. */
        return measuredAt(root, named)
      },
    })

    expect(asked).toEqual([['src/old.ts', BASE]])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1 of 1 survivor(s) were there too, in src/old.ts, which it was renamed from')
  })

  /* ⚠️ **A TREE AT 100 % MUST ASK GIT NOTHING MORE THAN IT USED TO.** Both
     questions cost a git process, and the rename detection is a whole-repository
     diff with no limit — a real cost to pay on every sweep that has nothing to
     authorise. */
  it('asks neither where the merge base is nor what anything came from when every mutant was killed', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutatedFile = at['src/a.ts']
      const { stryker } = strykerStandIn(root, { reports: { [mutatedFile]: await plantedReport(mutatedFile, 'Killed') } })
      const refuse = (what) => () => {
        throw new Error(`a sweep with nothing to authorise asked ${what}`)
      }

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: ['src/a.ts', 'src/a.test.mjs'],
        stryker,
        mergeBase: refuse('where the merge base is'),
        origins: refuse('what each subject came from'),
        measure: refuse('for a measurement'),
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('check-mutants: every mutant was killed\n')
    })
  })

  /* ⚠️ **"EVERY MUTANT WAS KILLED" OVER AN AUTHORISED SURVIVOR IS THE ONE
     SENTENCE A READER WOULD TAKE AT FACE VALUE.** A file that passed because the
     merge base owed its survivor has a mutant alive in it, and the sweep's own
     summary must not say otherwise — even where every OTHER file was clean. */
  it('does not claim every mutant was killed when a file passed only on what the merge base owed', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Killed'),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], 'Survived'),
        },
        exits: { [at['src/b.ts']]: false },
      })

      const result = await sweep(root, {
        subjects: ['src/a.ts', 'src/b.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        measure: (named, _commit, asked) => measuredAt(asked.root, named),
      })

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('check-mutants: 1 file(s) had a mutant survive')
      expect(result.stdout).not.toContain('every mutant was killed')
    })
  })

  it('asks where the merge base is once, however many files have survivors', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Survived'),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], 'Survived'),
        },
        exits: { [at['src/a.ts']]: false, [at['src/b.ts']]: false },
      })
      let asked = 0
      let traced = 0

      const result = await sweep(root, {
        subjects: ['src/a.ts', 'src/b.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => (asked += 1) && BASE,
        origins: (names) => {
          traced += 1
          return itsOwn(names)
        },
        measure: (named, _commit, asked) => measuredAt(asked.root, named),
      })

      expect([asked, traced]).toEqual([1, 1])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('check-mutants: 2 file(s) had a mutant survive')
      /* One file to a line: run together, two files' accounts read as one
         sentence about neither. */
      expect(result.stdout).toContain(
        `  ${at['src/a.ts']} — 1 of 1 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, 900 ms)\n` +
          `  ${at['src/b.ts']} — 1 of 1 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, 900 ms)\n`,
      )
    })
  })

  /* ⚠️ **WHAT A CHANGE IS BILLED FOR IS NAMED ONE SURVIVOR TO A LINE**, so that
     a reader is not left diffing two survivor lists by eye — and two names run
     together are two survivors nobody can find. */
  it('names every survivor the merge base did not answer for, one to a line', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Survived'),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], 'Survived'),
        },
        exits: { [at['src/a.ts']]: false, [at['src/b.ts']]: false },
      })

      const result = await sweep(root, {
        subjects: ['src/a.ts', 'src/b.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        measure: (named, _commit, asked) => killedAt(asked.root, named),
      })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(
        '  added: src/a.ts:1:18 — StringLiteral replacing "\'a\'" with "\\"\\"" in the file itself — ' +
          'the merge base has no survivor with this identity in src/a.ts\n' +
          '  added: src/b.ts:1:18 — StringLiteral replacing "\'b\'" with "\\"\\"" in the file itself — ' +
          'the merge base has no survivor with this identity in src/b.ts\n',
      )
    })
  })

  /**
   * ## The two sentences, side by side
   *
   * ⚠️ **A MUTANT THE MERGE BASE COULD NOT DECIDE IS NOT ONE THIS CHANGE ADDED,
   * AND UNTIL 2026-09-17 IT REFUSED THE WHOLE FILE.** Measured on an isolated
   * 4-vCPU runner with real history: one comment added to a 1 403-mutant file left
   * 545 mutants unkilled here, and the merge base — which ran fine — left five
   * wall-clock timeouts its settle run met again. The file-wide refusal made the
   * 540 it had decided perfectly well worthless, and billed a comment for all of
   * them.
   *
   * Both classes fail the build and neither authorises anything. What differs is
   * what a reader is told: one says the change added a gap, the other says the
   * merge base never answered for this mutant and it is now theirs to settle.
   */
  it('bills a survivor the merge base could not decide as the reader’s to settle, and authorises the ones it did', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const both = "export const a = 'a'\nexport const b = 'b'\n"
      const at = checkout(root, { 'src/a.ts': both, 'src/a.test.mjs': "import './a'\n" })
      const mutatedFile = at['src/a.ts']
      const { stryker } = strykerStandIn(root, {
        reports: { [mutatedFile]: await plantedReport(mutatedFile, 'Survived', 'Survived') },
        exits: { [mutatedFile]: false },
      })
      /* The merge base held the same two mutants: it answered for the first with
         a survivor, and met the second's wall-clock timeout again in its settle
         run — which is the shape the acceptance run measured. */
      const ran = async (statuses) => ({
        files: {
          [mutatedFile]: {
            source: both,
            mutants: (await identitiesOfSource(mutatedFile, both)).map((identity, id) => ({
              id: String(id),
              static: false,
              ...identity,
              status: statuses[id],
            })),
          },
        },
      })

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => BASE,
        origins: (names) => new Map(names.map((name) => [name, { path: name, how: 'itself', sha256: hashOf(both) }])),
        measure: async () => ({
          install: 'linked',
          outcome: 'survived',
          durationMs: 900,
          sha256: hashOf(both),
          source: both,
          first: { exitedCleanly: false, durationMs: 600, report: await ran(['Survived', 'Timeout']) },
          settle: { exitedCleanly: false, durationMs: 300, report: await ran(['Survived', 'Timeout']) },
        }),
      })

      expect(result.code).toBe(1)
      expect(result.stdout).toContain(
        `  ${mutatedFile} — 1 of 2 survivor(s) were there too, in itself at the merge base (survived, dependencies linked, ` +
          '900 ms); 1 the merge base could not decide\n',
      )
      /* The second sentence, in full — and no `added:` line, because nothing here
         is answered for by the merge base's own survivors.

         ⚠️ **IT SAID "this change did not add them" UNTIL 2026-09-17**, which the
         evidence does not support: a merge base that never answered for a mutant
         says nothing either way about who added it. What IS known is that nothing
         authorises it. */
      expect(result.stderr).toContain(
        'check-mutants: the merge base could not decide 1 mutant(s) that survived here — it never answered for them, so ' +
          'whether this change added them is not something this run can say, and a mutant the merge base never answered ' +
          'for is not one it authorises; they are yours to settle:\n' +
          '  undecided: src/a.ts:2:18 — StringLiteral replacing "\'b\'" with "\\"\\"" in the file itself — the merge base ' +
          'could not decide this mutant in src/a.ts: its settle run met the same wall-clock timeout again at 2:18\n',
      )
      expect(result.stderr).not.toContain('  added:')
    })
  })

  /* And every file whose merge base could not be measured is named the same way:
     the refusals are different questions for the reader — one per file — and
     glued together they read as one. */
  it('names every file whose merge base could not be measured, one to a line', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/a.test.mjs': "import './a'\n",
        'src/b.ts': "export const b = 'b'\n",
        'src/b.test.mjs': "import './b'\n",
      })
      const { stryker } = strykerStandIn(root, {
        reports: {
          [at['src/a.ts']]: await plantedReport(at['src/a.ts'], 'Survived'),
          [at['src/b.ts']]: await plantedReport(at['src/b.ts'], 'Survived'),
        },
        exits: { [at['src/a.ts']]: false, [at['src/b.ts']]: false },
      })
      const missing = 'c'.repeat(40)

      const result = await sweep(root, {
        subjects: ['src/a.ts', 'src/b.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => missing,
        origins: itsOwn,
        measure: measureAtBase,
      })

      expect(result.code).toBe(1)
      /* The files are named as the reader's own paths, so in the host's
         separator — `\` on Windows, where `src\/a` never matched. */
      expect(result.stderr).toMatch(
        /\n {2}\S*src[\\/]a\.ts — no-commit: check-mutants: [^\n]+\n {2}\S*src[\\/]b\.ts — no-commit: check-mutants: /u,
      )
    })
  })

  /* ⚠️ **A SURVIVOR ONLY THE SETTLE RUN FOUND IS STILL MEASURED AGAINST THE
     MERGE BASE.** The first run here left the mutant timed out and the second
     answered it with a survivor: counted from the first report alone the file has
     nothing alive in it, so everything the merge base owed would go unclaimed and
     the sweep would report a comparison of nothing against nothing. */
  it('measures a survivor only the settle run found against the merge base, like any other', async () => {
    await inScratch('mutants-owed-', async (root) => {
      const at = checkout(root, { 'src/a.ts': "export const a = 'a'\n", 'src/a.test.mjs': "import './a'\n" })
      const mutatedFile = at['src/a.ts']
      const { stryker } = strykerStandIn(root, {
        reports: { [mutatedFile]: await plantedReport(mutatedFile, 'Timeout') },
        exits: { [mutatedFile]: false },
        settled: { [mutatedFile]: await plantedReport(mutatedFile, 'Survived') },
        settleExits: { [mutatedFile]: false },
      })

      const result = await sweep(root, {
        subjects: ['src/a.ts'],
        tree: Object.keys(at),
        stryker,
        mergeBase: () => BASE,
        origins: itsOwn,
        measure: (named, _commit, asked) => measuredAt(asked.root, named),
      })

      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`  ${mutatedFile} — 1 of 1 survivor(s) were there too, in itself at the merge base`)
    })
  })

  /* The base ref a sweep was given, and whether one is required, reach the
     question about where the merge base IS — not only the question about which
     files changed. A sweep told `--base origin/trunk` that resolved its merge
     base against `main` would compare against another commit entirely, and the
     numbers it printed would be about a comparison nobody asked for. */
  it('asks where the merge base is with the base ref it was given, and whether one is required', async () => {
    const asked = []

    const result = await sweeping({
      argv: ['--base', 'origin/trunk', '--require-base'],
      mergeBase: (...args) => {
        asked.push(args)
        return BASE
      },
    })

    expect(result.code).toBe(0)
    expect(asked).toEqual([['origin/trunk', true, result.root]])
  })

  /* `--require-base` is what CI passes, and a base it cannot resolve there means
     the comparison would be made against nothing. Refused in the words
     `changedFiles` refuses it with, and with a refusal's exit. */
  it('refuses a base it cannot resolve when one is required, rather than measuring against nothing', async () => {
    const words = 'check-mutants: cannot resolve a merge base with "origin/main"'

    const result = await sweeping({
      mergeBase: () => {
        throw new Error(words)
      },
    })

    expect(result.code).toBe(2)
    expect(result.stderr).toBe(`${words}\n`)
  })
})

/**
 * ⚠️ **ONE RUNNER COULD NOT HOLD THIS SWEEP, AND THE JOB THAT TRIED HAD NEVER
 * RUN** (measured 2026-09-14). This branch changes 79 files carrying 15 898
 * whole-file mutants; a local sweep spent 18 min 5 s on one of them, and CI gave
 * the whole of it one 4-vCPU runner and 45 minutes. Sharding answers that only if
 * no shard can quietly sweep less than its plan — so the plan is FROZEN, a shard
 * re-derives it and refuses any difference, and nothing but the aggregate, which
 * accounts for every planned file exactly once, can say the sweep passed.
 */
describe('a sweep planned once, swept in shards and reconciled by an aggregate', () => {
  it('plans every changed file with its content hash, covering tests, class, mutant count and shard, and plans it the same way twice', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const files = planned(root)
      const manifest = path.join(root, 'plan', 'plan.json')
      const again = path.join(root, 'plan', 'again.json')
      const argv = (file) => ['--plan', file, '--shards', '3', '--isolate', '1', '--base', 'origin/main', '--require-base']
      /* ⚠️ **THE PLAN IS THE CONTRACT, SO THE BASE FILE EACH SUBJECT MAY BE
         ANSWERED BY IS FROZEN IN IT** — a shard re-resolving it would decide its
         own scope from its own checkout, minutes later. Git is asked ONCE, here,
         at the merge base the plan records. */
      const tracedAt = []
      /* Each origin carries the content the merge base's own commit holds there —
         frozen here, and what every measurement of it is later held to. */
      const held = createHash('sha256').update('what the merge base held').digest('hex')
      const origins = (names, mergeBase) => {
        tracedAt.push(mergeBase)
        return new Map(
          names.map((name) => [
            name,
            name === 'src/b.ts' ? { path: 'src/moved.ts', how: 'renamed', sha256: held } : { path: name, how: 'itself', sha256: held },
          ]),
        )
      }

      const first = await sweep(root, { argv: argv(manifest), subjects: PLANNED, tree: PLANNED_TREE, commits: commitsAt(), origins })
      const second = await sweep(root, {
        argv: argv(again),
        subjects: [...PLANNED].reverse(),
        tree: [...PLANNED_TREE].reverse(),
        commits: commitsAt(),
        origins,
      })

      expect(first.stderr).toBe('')
      expect(first.code).toBe(0)
      expect(second.code).toBe(0)
      expect(first.asked).toEqual([['origin/main', true]])
      expect(tracedAt).toEqual([BASE, BASE])
      const digest = expect.stringMatching(/^[0-9a-f]{64}$/u)
      expect(readJson(manifest)).toEqual({
        version: 1,
        head: HEAD,
        mergeBase: BASE,
        worktree: {},
        base: 'origin/main',
        only: null,
        requireBase: true,
        shards: 3,
        isolate: 1,
        subjects: [
          { path: 'src/a.ts', sha256: sha(files['src/a.ts']), class: 'mutated', mutants: 1, identities: [literalAt(1)], origin: { path: 'src/a.ts', how: 'itself', sha256: held }, shard: 2, tests: ['src/a.test.mjs'], testsDigest: digest, leftOut: [], through: [] },
          { path: 'src/b.ts', sha256: sha(files['src/b.ts']), class: 'mutated', mutants: 2, identities: [literalAt(1), literalAt(2)], origin: { path: 'src/moved.ts', how: 'renamed', sha256: held }, shard: 1, tests: ['src/c.test.mjs'], testsDigest: digest, leftOut: [], through: ['src/c.ts'] },
          { path: 'src/n.ts', sha256: sha(files['src/n.ts']), class: 'no-test-found', mutants: 1, identities: [literalAt(1)], origin: { path: 'src/n.ts', how: 'itself', sha256: held }, shard: 2, tests: [], testsDigest: digest, leftOut: [], through: [] },
          {
            path: 'src/r.ts',
            sha256: sha(files['src/r.ts']),
            class: 'mutated',
            mutants: 1,
            identities: [literalAt(1)],
            origin: { path: 'src/r.ts', how: 'itself', sha256: held },
            shard: 3,
            tests: ['src/r.behaviour.test.mjs', 'src/r.more.test.mjs'],
            testsDigest: digest,
            leftOut: ['src/r.test.mjs'],
            through: [],
          },
          { path: 'src/z.ts', sha256: sha(files['src/z.ts']), class: 'no-mutants', mutants: 0, identities: [], origin: { path: 'src/z.ts', how: 'itself', sha256: held }, shard: 2, tests: [], testsDigest: digest, leftOut: [], through: [] },
        ],
      })
      expect(readFileSync(again, 'utf8')).toBe(readFileSync(manifest, 'utf8'))
      expect(first.stdout).toBe(
        leftOutOf([files['src/r.ts'], 2, [files['src/r.test.mjs']]]) +
          `check-mutants: planned 5 changed file(s) over 3 shard(s) into ${manifest}:\n` +
          '  shard 1/3 — 1 file(s), 2 mutant(s) to run, a shard of its own\n' +
          '  shard 2/3 — 3 file(s), 1 mutant(s) to run\n' +
          '  shard 3/3 — 1 file(s), 1 mutant(s) to run\n' +
          ESTIMATE,
      )
      expect(first.locks.taken).toBe(0)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  it('refuses to plan without its commits or its changed files, and writes no plan', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const manifest = path.join(root, 'plan.json')
      const argv = ['--plan', manifest, '--shards', '2']

      const noHead = await sweep(root, {
        argv,
        subjects: ['src/a.ts'],
        commits: () => {
          throw new Error('check-mutants: no HEAD here')
        },
      })
      const noBase = await sweep(root, {
        argv,
        changed: () => {
          throw new Error('cannot resolve a merge base with "x"')
        },
        commits: commitsAt(),
      })

      /* And without the working tree it was decided from, or an answer from git
         about where the manifest may go — a plan that recorded neither is one its
         shards could not hold themselves to. */
      const noTree = await sweep(root, {
        argv,
        commits: commitsAt(),
        worktree: () => {
          throw new Error('cannot list the tree')
        },
      })
      const noGit = await sweep(root, {
        argv,
        commits: commitsAt(),
        tracked: () => {
          throw new Error('fatal: not a git repository')
        },
      })

      for (const [result, words] of [
        [noHead, 'check-mutants: no HEAD here\n'],
        [noBase, 'cannot resolve a merge base with "x"\n'],
        [noTree, `check-mutants: cannot read the working tree at ${root} — cannot list the tree\n`],
        [noGit, `check-mutants: cannot ask git what it tracks in ${manifest} — fatal: not a git repository\n`],
      ]) {
        expect(result.code).toBe(2)
        expect(result.stderr).toBe(words)
        expect(result.stdout).toBe('')
      }
      expect(existsSync(manifest)).toBe(false)
    })
  })

  it('plans a change of nothing as a plan with no file, which every shard receipts and the aggregate passes', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const manifest = path.join(root, 'plan.json')
      const listed = () => {
        throw new Error('the tree was listed')
      }

      const planning = await sweep(root, { argv: ['--plan', manifest, '--shards', '2'], commits: commitsAt(), files: listed })
      const shards = []
      for (const spec of ['1/2', '2/2']) shards.push(await shardOf(root, manifest, spec, { subjects: [], files: listed }))
      const aggregate = await aggregateOf(root, manifest)

      expect(planning.code).toBe(0)
      expect(planning.stdout).toBe(`check-mutants: nothing changed to mutate — ${manifest} plans no file, over 2 shard(s)\n`)
      expect(readJson(manifest).subjects).toEqual([])
      expect(shards.map(({ code, stdout }) => [code, stdout])).toEqual([
        [0, emptyShardSays(manifest, '1/2')],
        [0, emptyShardSays(manifest, '2/2')],
      ])
      expect(aggregate.stderr).toBe('')
      expect(aggregate.code).toBe(0)
      expect(aggregate.stdout).toBe('check-mutants: nothing changed to mutate\n')
    })
  })

  /* (a) ⚠️ **A SHARD THAT RE-READ ITS SCOPE ON ITS OWN RUNNER COULD SWEEP A
     DIFFERENT CHANGE UNDER THE PLAN'S NAME.** Each shard is a fresh checkout,
     minutes after the plan: another HEAD commit, another merge base, a file
     that changed or a test that appeared would give it other subjects, other
     tests, or another assignment — and its results would still reconcile. So
     it re-derives everything the plan decided and refuses any difference,
     before it writes a result or takes the lock. The base branch's TIP is not
     among those things: see the case after this one. */
  it('refuses a shard whose checkout is not its plan’s — a file added, removed or changed, other covering tests, another HEAD commit or merge base, another working tree — before writing or locking anything', async () => {
    const other = 'c'.repeat(40)
    const readsR =
      "import { readFileSync } from 'node:fs'\nimport './r'\nreadFileSync(new URL('./r.ts', import.meta.url), 'utf8')\n"
    const cases = [
      [
        (root) => (plant(root, { 'src/new.ts': "export const x = 'x'\n" }), { subjects: [...PLANNED, 'src/new.ts'], tree: [...PLANNED_TREE, 'src/new.ts'] }),
        ['src/new.ts is a changed file here, and the plan does not hold it'],
      ],
      [() => ({ subjects: PLANNED.filter((file) => file !== 'src/z.ts') }), ['src/z.ts is in the plan, and is not a changed file here']],
      [(root) => (plant(root, { 'src/a.ts': "export const a = 'changed'\n" }), {}), ['src/a.ts changed content since the plan']],
      [
        (root) => (plant(root, { 'src/a.more.test.mjs': "import './a'\n" }), { tree: [...PLANNED_TREE, 'src/a.more.test.mjs'] }),
        ["src/a.ts is reached by other covering tests than the plan's"],
      ],
      [
        (root) => (plant(root, { 'src/a.test.mjs': "import './a'\nexport const changed = true\n" }), {}),
        ['src/a.ts: a covering test changed content since the plan'],
      ],
      [
        (root) => (plant(root, { 'src/r.behaviour.test.mjs': readsR }), {}),
        ["src/r.ts is reached by other covering tests than the plan's", "src/r.ts leaves out other source-reading tests than the plan's"],
      ],
      [() => ({ commits: commitsAt(other) }), [`the HEAD commit differs: planned at ${HEAD}, here ${other}`]],
      [() => ({ commits: commitsAt(HEAD, other) }), [`the merge base with "main" differs: planned at ${BASE}, here ${other}`]],
      [() => ({ commits: commitsAt(HEAD, null) }), [`the merge base with "main" differs: planned at ${BASE}, here none`]],
      [
        () => ({ worktree: () => ({ 'src/new.test.mjs': 'e'.repeat(64) }) }),
        ["the working tree differs from the plan's at src/new.test.mjs"],
      ],
    ]

    for (const [change, words] of cases) {
      await inScratch('mutants-refuse-', async (root) => {
        planned(root)
        const manifest = await planOver(root)

        const result = await shardOf(root, manifest, '1/3', change(root))

        expect(result.stderr, words[0]).toBe(
          `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/3 would sweep something other than its plan — refused:\n` +
            words.map((line) => `  ${line}\n`).join(''),
        )
        expect(result.code).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.locks.taken).toBe(0)
        expect(existsSync(path.join(root, 'results'))).toBe(false)
      })
    }
  })

  /* (a) ⚠️ **A LOCAL SHARD COULD SWEEP UNCOMMITTED WORK THE PLAN NEVER SAW**
     (review, 2026-09-14). HEAD, the subjects and their covering tests were
     compared — and nothing else, so a testkit a test imports, a config file, or
     a test left out of the run could change between plan and shard unnoticed.
     In CI every job checks out one commit and HEAD covers it; the hole is a
     local run over uncommitted work. The inputs are not listed, because a list
     always misses one: the plan records the whole working tree against HEAD,
     and a shard refuses any path that differs — its own manifest and results
     directory excepted, which the plan and the shards write themselves. Asked
     of a real repository, with real uncommitted work already in it. */
  it('refuses a shard wherever the working tree differs from the plan’s — a testkit helper, a config file, a test left out of the run — but not for its own manifest and results', async () => {
    const changes = [
      ['src/world.testkit.mjs', () => "export const world = 'changed'\n"],
      ['vitest.config.ts', (files) => `${readFileSync(files['vitest.config.ts'], 'utf8')}// changed after the plan\n`],
      ['src/r.test.mjs', (files) => `${readFileSync(files['src/r.test.mjs'], 'utf8')}// changed after the plan\n`],
    ]

    for (const [changed, contents] of changes) {
      await inScratch('mutants-worktree-', async (root) => {
        const files = { ...planned(root), ...plant(root, { 'src/world.testkit.mjs': "export const world = 'w'\n" }) }
        const git = gitIn(root)
        git('init', '-q', '-b', 'main')
        git('add', '.')
        git('commit', '-qm', 'start')
        plant(root, { 'src/a.ts': "export const a = 'uncommitted'\n" })
        const real = { commits: (base, requireBase) => commitsOf(base, requireBase, root), worktree: worktreeOf }
        const manifest = await planOver(root, real)
        const { stryker } = strykerStandIn(root, { reports: { [files['src/b.ts']]: await plantedReport(files['src/b.ts'], 'Killed', 'Killed') } })

        const first = await shardOf(root, manifest, '1/3', { ...real, stryker })
        plant(root, { [changed]: contents(files) })
        const refused = await shardOf(root, manifest, '2/3', real)

        expect(Object.keys(readJson(manifest).worktree)).toEqual(['src/a.ts'])
        expect(first.stderr, changed).toBe('')
        expect(first.code).toBe(0)
        expect(refused.stderr, changed).toBe(
          `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 2/3 would sweep something other than its plan — refused:\n` +
            `  the working tree differs from the plan's at ${changed}\n`,
        )
        expect(refused.code).toBe(2)
        expect(refused.locks.taken).toBe(0)
        expect(existsSync(path.join(root, 'results', 'shard-2'))).toBe(false)
      })
    }
  })

  /* ⚠️ **`--results` COULD EXEMPT A REAL INPUT FROM DRIFT DETECTION** (second
     review, 2026-09-14). A shard leaves its own results directory out of the
     working-tree comparison, so `--results src` hid a change to
     `src/helper.testkit.ts` and the comparison found nothing. A results
     directory that holds, or sits inside, anything the plan fingerprints — a
     subject, a covering test, a working-tree path — is refused, and so is one
     git tracks, before anything is written or locked. */
  it('refuses a results directory that overlaps an input the plan fingerprints, or that git tracks, before writing or locking', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      plant(root, { 'docs/readme.md': 'tracked\n', 'fixtures/helper.testkit.ts': 'export {}\n' })
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', 'docs/readme.md')
      git('commit', '-qm', 'docs')
      const tree = { 'fixtures/helper.testkit.ts': 'e'.repeat(64) }
      const manifest = await planOver(root, { shards: 1, isolate: 0, worktree: () => tree })
      const refused = async (results) => {
        const result = await shardOf(root, manifest, '1/1', {
          argv: ['--shard', '1/1', '--manifest', manifest, '--results', results],
          worktree: () => tree,
          tracked: trackedUnder,
        })
        expect(result.code, results).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.locks.taken).toBe(0)
        return result.stderr
      }
      const overlapping = (results, input) =>
        `check-mutants: --results ${results} overlaps ${input}, an input ${manifest} fingerprints — a shard leaves its own results out of drift detection, so an input there could change unseen; pass a directory apart from every input\n`

      for (const [results, input] of [
        [path.join(root, 'src'), 'src/a.test.mjs'],
        [path.join(root, 'fixtures'), 'fixtures/helper.testkit.ts'],
        [path.join(root, 'src', 'a.ts', 'out'), 'src/a.ts'],
        [root, 'fixtures/helper.testkit.ts'],
      ]) {
        expect(await refused(results)).toBe(overlapping(results, input))
      }
      const docs = path.join(root, 'docs')
      expect(await refused(docs)).toBe(
        `check-mutants: --results ${docs} is a directory git tracks — it holds docs/readme.md — and a shard's results belong in a directory of their own; pass one git does not track\n`,
      )
      /* ⚠️ **AND THE CHECK WAS LEXICAL, SO AN ALIAS WALKED PAST IT** (third
         review, 2026-09-14): a path through a symbolic link to the checkout was
         taken for one outside it, and on a filesystem that ignores case `SRC` is
         `src` while git lists nothing tracked under `SRC`. Both are real paths
         now, compared without case where the checkout's own filesystem ignores
         it — which this asks of the checkout, as the gate does, rather than of
         the platform. */
      await inScratch('mutants-alias-', async (outside) => {
        const alias = path.join(outside, 'checkout')
        symlinkSync(root, alias)
        const through = path.join(alias, 'src')
        expect(await refused(through)).toBe(overlapping(through, 'src/a.test.mjs'))
      })
      if (existsSync(path.join(root, 'SRC'))) {
        const upper = path.join(root, 'SRC')
        expect(await refused(upper)).toBe(overlapping(upper, 'src/a.test.mjs'))
        /* ⚠️ And the CHECKOUT'S OWN name in another case, which read as a path
           outside the checkout until the folding moved ahead of that decision
           (fourth review, 2026-09-14). */
        const aliased = path.join(path.dirname(root), path.basename(root).toUpperCase(), 'src')
        expect(await refused(aliased)).toBe(overlapping(aliased, 'src/a.test.mjs'))
        const tracked = path.join(root, 'DOCS')
        expect(await refused(tracked)).toBe(
          `check-mutants: --results ${tracked} is a directory git tracks — it holds docs/readme.md — and a shard's results belong in a directory of their own; pass one git does not track\n`,
        )
      }
      expect(existsSync(path.join(root, 'src', 'shard-1'))).toBe(false)
      expect(existsSync(path.join(docs, 'shard-1'))).toBe(false)
    })
  })

  /* ⚠️ **A PATH WENT TO GIT AS A PATTERN** (fifth review, 2026-09-14): `src*` is
     a wildcard to a pathspec, so a perfectly ordinary output directory of that
     name was refused as one git tracks — naming a file nowhere near it. Paths go
     to git literally now, and a directory it really does track is refused still. */
  it('takes a results directory whose name holds a git wildcard literally, and still refuses one git tracks', async (context) => {
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.nameAStar)
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      /* `src-extra/` is what a wildcard `src*` catches and the literal name does not. */
      plant(root, { 'docs/readme.md': 'tracked\n', 'src-extra/keep.txt': 'tracked\n' })
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', 'docs/readme.md', 'src-extra/keep.txt')
      git('commit', '-qm', 'docs')
      const subjects = ['src/z.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const starred = path.join(root, 'src*')
      const shardInto = (results) =>
        sweep(root, {
          argv: ['--shard', '1/1', '--manifest', manifest, '--results', results],
          subjects,
          tree: PLANNED_TREE,
          commits: commitsAt(),
          tracked: trackedUnder,
        })

      const wild = await shardInto(starred)
      const tracked = await shardInto(path.join(root, 'docs'))

      expect(wild.stderr).toBe('')
      expect(wild.code).toBe(0)
      expect(existsSync(receiptIn(starred, 1))).toBe(true)
      expect(tracked.code).toBe(2)
      expect(tracked.stderr).toContain('is a directory git tracks — it holds docs/readme.md')
    })
  })

  /* ⚠️ **A PLAN COULD BE WRITTEN OVER A TRACKED FIXTURE A TEST READS** (third
     review, 2026-09-14). `--plan` wrote wherever it was pointed, and a shard
     leaves its manifest's path out of drift detection — so a plan written over a
     tracked JSON fixture replaced the input, and plan, shard and aggregate all
     exited 0 against it. `--plan` now meets the rule `--results` meets — nothing
     git tracks, nothing the plan fingerprints — before anything is written, and a
     shard refuses to read its plan from such a path, so its exemption never
     covers an input. */
  it('refuses a plan written over a tracked file or an input it fingerprints, and a shard reading its plan from one, leaving the file as it was', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const files = {
        ...planned(root),
        ...plant(root, {
          'src/fixture.json': '{"rows":[1,2,3]}\n',
          'src/a.fixture.test.mjs':
            "import { readFileSync } from 'node:fs'\nimport './a'\nreadFileSync(new URL('./fixture.json', import.meta.url), 'utf8')\n",
          'fixtures/helper.testkit.ts': 'export {}\n',
        }),
      }
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', 'src/fixture.json')
      git('commit', '-qm', 'fixture')
      const tree = { 'fixtures/helper.testkit.ts': 'e'.repeat(64) }
      const options = { tree: [...PLANNED_TREE, 'src/a.fixture.test.mjs'], commits: commitsAt(), worktree: () => tree, tracked: trackedUnder }
      const planInto = (target) => sweep(root, { argv: ['--plan', target, '--shards', '1'], subjects: PLANNED, ...options })
      const fixture = files['src/fixture.json']
      const original = readFileSync(fixture)

      const intoFixture = await planInto(fixture)

      expect(intoFixture.stderr).toBe(
        `check-mutants: --plan ${fixture} is a path git tracks — it holds src/fixture.json — so a plan written there would replace a tracked file its shards then leave out of drift detection; write the plan where git tracks nothing\n`,
      )
      expect(intoFixture.code).toBe(2)
      expect(intoFixture.stdout).toBe('')
      expect(readFileSync(fixture)).toEqual(original)
      for (const [target, input] of [
        [files['src/a.ts'], 'src/a.ts'],
        [path.join(root, 'fixtures', 'helper.testkit.ts'), 'fixtures/helper.testkit.ts'],
      ]) {
        const before = readFileSync(target)
        const intoInput = await planInto(target)
        expect(intoInput.stderr).toBe(
          `check-mutants: --plan ${target} overlaps ${input}, an input this plan fingerprints — its shards leave the manifest out of drift detection, so an input there could change unseen; write the plan apart from every input\n`,
        )
        expect(intoInput.code).toBe(2)
        expect(readFileSync(target)).toEqual(before)
      }

      /* A plan copied onto a tracked path afterwards is refused by the shard that reads it. */
      const good = path.join(root, 'plan.json')
      expect((await planInto(good)).code).toBe(0)
      writeFileSync(fixture, readFileSync(good))
      const shard = await sweep(root, {
        argv: ['--shard', '1/1', '--manifest', fixture, '--results', path.join(root, 'results')],
        subjects: PLANNED,
        ...options,
      })
      expect(shard.stderr).toBe(
        `check-mutants: --manifest ${fixture} is a path git tracks — it holds src/fixture.json — and a shard leaves its manifest out of drift detection, so a tracked file there could change unseen; keep the plan where git tracks nothing\n`,
      )
      expect(shard.code).toBe(2)
      expect(shard.locks.taken).toBe(0)
      expect(existsSync(path.join(root, 'results'))).toBe(false)

      /* And one copied over an input the plan fingerprints is refused for that,
         which is the exemption that would otherwise hide a changed helper. */
      const helper = path.join(root, 'fixtures', 'helper.testkit.ts')
      writeFileSync(helper, readFileSync(good))
      const onInput = await sweep(root, {
        argv: ['--shard', '1/1', '--manifest', helper, '--results', path.join(root, 'results')],
        subjects: PLANNED,
        ...options,
      })

      expect(onInput.stderr).toBe(
        `check-mutants: --manifest ${helper} overlaps fixtures/helper.testkit.ts, an input it fingerprints — a shard leaves its manifest out of drift detection, so an input there could change unseen; keep the plan apart from every input\n`,
      )
      expect(onInput.code).toBe(2)
      expect(existsSync(path.join(root, 'results'))).toBe(false)
    })
  })

  /* ⚠️ **AN INPUT COULD CHANGE AFTER THE SHARD'S ONE CHECK** (second review,
     2026-09-14): a helper edited before a later subject's Stryker run was swept
     under the plan's name. So the HEAD commit, the merge base and the working
     tree are checked again immediately before each subject's run — those three
     determine everything else the plan decided — and a difference stops the
     shard by name. What it had written stays, marked as a stopped shard's, and
     the aggregate takes none of it. */
  it('checks the checkout again before each Stryker run, stops the shard naming what changed, and marks what it wrote as a stopped shard’s', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const manifest = await planOver(root, { shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      /* The shard's first look is clean; the helper has changed by its look
         immediately before the first file it writes up — `n.ts`, which it skips,
         since a skipped file gets the same checks as a swept one. */
      let looks = 0
      const worktree = () => (++looks >= 2 ? { 'src/helper.testkit.ts': 'e'.repeat(64) } : {})
      const why = "the working tree differs from the plan's at src/helper.testkit.ts"

      const result = await shardOf(root, manifest, '1/1', { worktree })

      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/n.ts and every file after it would be swept from something other than its plan — stopped:\n  ${why}\n`,
      )
      expect(result.code).toBe(2)
      for (const subject of ['src/n.ts', 'src/z.ts', 'src/a.ts']) expect(existsSync(resultIn(results, 1, subject)), subject).toBe(false)
      expect(existsSync(receiptIn(results, 1))).toBe(false)
      /* Stopped before the first file was written up, which is before the lock a Stryker run needs. */
      expect(result.locks).toEqual({ taken: 0, released: 0 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* ⚠️ **AND NOTHING ASKED AFTER THE LAST RUN** (third review, 2026-09-14). A
     helper changed DURING a subject's Stryker run changes what that run swept,
     while the subject's source and mutant identities still reconcile — so the
     last subject's result, and the receipt, went out as the plan's, and the
     aggregate exited 0. The checkout is asked again after each run as well as
     before it; a change stops the shard, its results marked, with no receipt. */
  it('checks the checkout again after each Stryker run, the last included, and stops the shard with no receipt when it changed during the run', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      let edited = false
      const worktree = () => (edited ? { 'src/helper.testkit.ts': 'e'.repeat(64) } : {})
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0, worktree })
      const results = path.join(root, 'results')
      const { stryker: standIn, seen } = strykerStandIn(root, { reports: { [files['src/a.ts']]: await plantedReport(files['src/a.ts'], 'Killed') } })
      const stryker = async (config) => {
        edited = true
        return standIn(config)
      }
      const why = "the working tree differs from the plan's at src/helper.testkit.ts"

      const result = await shardOf(root, manifest, '1/1', { subjects, stryker, worktree })
      const aggregate = await aggregateOf(root, manifest)

      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/a.ts was swept from something other than its plan — stopped:\n  ${why}\n`,
      )
      expect(result.code).toBe(2)
      expect(seen.map(({ subject }) => subject)).toEqual([files['src/a.ts']])
      expect(readJson(resultIn(results, 1, 'src/a.ts')).stopped).toBe(why)
      expect(existsSync(receiptIn(results, 1))).toBe(false)
      expect(result.locks).toEqual({ taken: 1, released: 1 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
      expect(aggregate.code).toBe(1)
      expect(aggregate.stderr).toContain(
        `  stopped: ${resultIn(results, 1, 'src/a.ts')} — written by shard 1/1, which stopped before its end: ${why}\n`,
      )
      expect(aggregate.stdout).not.toContain('every mutant was killed')
    })
  })

  /* ⚠️ **BOTH SWEEP MODES SETTLE, AND A SHARD'S RESULT MUST CARRY ENOUGH FOR THE
     AGGREGATE TO REACH THE SAME VERDICT WITHOUT IT** — both runs' reports, both
     exits and both durations. The aggregate derives the merged verdict again
     from those, as it derives a single run's, and holds BOTH reports to the
     plan's identities. */
  it('settles a wall-clock timeout inside a shard, writes both runs and both durations, and lets the aggregate re-derive the verdict', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const a = files['src/a.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      const first = await plantedReport(a, 'Timeout')
      const answered = await plantedReport(a, 'Killed')
      const { stryker, seen } = strykerStandIn(root, { reports: { [a]: first }, settled: { [a]: answered } })

      const shard = await shardOf(root, manifest, '1/1', { subjects, stryker })
      const aggregate = await aggregateOf(root, manifest)

      expect(seen.map(({ settling: again, subject }) => [again, subject])).toEqual([
        [false, a],
        [true, a],
      ])
      expect(readJson(resultIn(results, 1, 'src/a.ts'))).toEqual({
        kind: 'result',
        version: 1,
        plan: sha(manifest),
        shard: 1,
        subject: 'src/a.ts',
        sha256: sha(a),
        outcome: 'killed',
        exitedCleanly: true,
        mutants: 1,
        durationMs: 250,
        report: first,
        settle: { exitedCleanly: true, report: answered, durationMs: 250 },
        /* The settle run answered the timeout with a kill, so nothing survived
           and the merge base was never asked. */
        base: null,
      })
      expect(shard.stdout).toContain(settledIn(a, { killed: 1 }))
      expect(aggregate.code).toBe(0)
      expect(aggregate.stderr).toBe('')
      expect(aggregate.stdout).toBe(reconciled(manifest, 1) + settledIn(a, { killed: 1 }) + 'check-mutants: every mutant was killed\n')
    })
  })

  /* ⚠️ **A SETTLE RUN IS A SECOND RUN, SO THE DRIFT CHECK BRACKETS IT TOO**: the
     checkout is asked before the first run, BETWEEN the two, and after the
     second. A tree that changes mid-settle stops the shard exactly as one that
     changes mid-sweep does — and the settle run never starts. */
  it('checks the checkout between a file’s two runs, and stops the shard naming the settle run that would have re-swept it', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const a = files['src/a.ts']
      let edited = false
      const worktree = () => (edited ? { 'src/helper.testkit.ts': 'e'.repeat(64) } : {})
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0, worktree })
      const results = path.join(root, 'results')
      const { stryker: standIn, seen } = strykerStandIn(root, {
        reports: { [a]: await plantedReport(a, 'Timeout') },
        settled: { [a]: await plantedReport(a, 'Killed') },
      })
      const stryker = async (config) => {
        edited = true
        return standIn(config)
      }
      const why = "the working tree differs from the plan's at src/helper.testkit.ts"

      const result = await shardOf(root, manifest, '1/1', { subjects, stryker, worktree })

      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/a.ts's settle run would re-sweep it from something other than its plan — stopped:\n  ${why}\n`,
      )
      expect(result.code).toBe(2)
      expect(seen.map(({ settling: again }) => again)).toEqual([false])
      expect(existsSync(resultIn(results, 1, 'src/a.ts'))).toBe(false)
      expect(existsSync(receiptIn(results, 1))).toBe(false)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* ⚠️ **AND THE ONE DOOR THE AGGREGATE LEFT OPEN: A RESULT THAT NEVER SETTLED.**
     Without this, a result carrying a wall-clock timeout and no settle run
     re-derives as the kill Stryker called it, which is exactly the weaker
     evidence the settle run exists to refuse. A settle report of other mutants
     than the plan's is refused the same way a first report is.

     ⚠️ **AND THE SECOND SETTLE REPORT HOLDS THE PLANNED MUTANT BESIDE THE
     UNPLANNED ONE, DELIBERATELY** (2026-09-16). It used to hold the unplanned
     one alone, which left the first run's wall-clock timeout with no answer —
     and since an unresolved timeout is now `did-not-run`, the result's own
     `killed` disagreed with it and `disagreementOf` refused it one step before
     `reportMismatch` was ever asked. That is a true refusal and a worse one to
     read, and it would have left the settle half of `reportMismatch` with no
     test through the aggregate at all. Answered, the two checks are separate
     again: this measures the report against the PLAN. */
  it('refuses a result that carries a wall-clock timeout its shard never settled, and one whose settle report is not of the planned file', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const a = files['src/a.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const { stryker } = strykerStandIn(root, {
        reports: { [a]: await plantedReport(a, 'Timeout') },
        settled: { [a]: await plantedReport(a, 'Killed') },
      })
      await shardOf(root, manifest, '1/1', { subjects, stryker })
      const clean = path.join(root, 'results')
      const rewrite = (dir, change) => {
        cpSync(clean, dir, { recursive: true })
        const target = resultIn(dir, 1, 'src/a.ts')
        writeFileSync(target, JSON.stringify(change(readJson(target))))
        return target
      }
      const [identity] = await mutantIdentitiesIn(a)
      const elsewhere = { ...identity, location: { start: { line: 9, column: 1 }, end: { line: 9, column: 4 } } }
      const namedElsewhere = `StringLiteral at 9:1-9:4 replaced with ${JSON.stringify('""')}`
      const neverDir = path.join(root, 'unsettled')
      const otherDir = path.join(root, 'elsewhere')

      const never = rewrite(neverDir, (one) => ({ ...one, settle: null }))
      const other = rewrite(otherDir, (one) => ({
        ...one,
        settle: {
          ...one.settle,
          report: reportWith(a, [
            { id: '0', status: 'Killed', static: false, ...identity },
            { id: '1', status: 'Killed', static: false, ...elsewhere },
          ]),
        },
      }))
      const unsettled = await aggregateOf(root, manifest, neverDir)
      const mismatched = await aggregateOf(root, manifest, otherDir)

      expect(unsettled.stderr).toBe(
        reconcileFails(manifest) +
          `  unreadable: ${never} — says killed over 1 wall-clock timeout(s) its shard never settled, and a timeout under load is not a kill\n` +
          '  missing: src/a.ts — no result from shard 1/1 that reconciles with the plan\n',
      )
      expect(unsettled.code).toBe(1)
      expect(mismatched.stderr).toBe(
        reconcileFails(manifest) +
          `  mismatched: ${other} — report does not match the plan: the settle run's report: it holds the mutant ${namedElsewhere}, which the plan did not count\n` +
          '  missing: src/a.ts — no result from shard 1/1 that reconciles with the plan\n',
      )
      expect(mismatched.code).toBe(1)
    })
  })

  /* ⚠️ **AND THE AGGREGATE HAD NO CASE OF A FILE THAT TIMED OUT AT ALL** — found
     by planting the two mutants that decide it (2026-09-15): dropping the file
     from the timed-out list, and routing `timed-out` through the outcome table
     it is deliberately absent from, both SURVIVED. A reconciled sweep must reach
     the same words a plain sweep reaches, over the same two reports. */
  it('names a file whose wall-clock timeout repeated in the settle run, and where the mutant sits, exactly as a plain sweep does', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const a = files['src/a.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      const { stryker } = strykerStandIn(root, {
        reports: { [a]: await plantedReport(a, 'Timeout') },
        settled: { [a]: await plantedReport(a, 'Timeout') },
      })

      const shard = await shardOf(root, manifest, '1/1', { subjects, stryker })
      const aggregate = await aggregateOf(root, manifest)

      expect(readJson(resultIn(results, 1, 'src/a.ts')).outcome).toBe('timed-out')
      expect(shard.code).toBe(1)
      expect(shard.stderr).toBe(timedOutIn([a], [`${a}:1:18`]))
      expect(shard.stdout).toContain(settledIn(a, { repeated: 1 }))
      expect(aggregate.code).toBe(1)
      expect(aggregate.stderr).toBe(timedOutIn([a], [`${a}:1:18`]))
      expect(aggregate.stdout).toBe(reconciled(manifest, 1) + settledIn(a, { repeated: 1 }))
    })
  })

  /* The same barrel, planned and swept: zero identities is nothing to run, so
     the plan says `no-mutants` though tests reach it, the shard writes its result
     without Stryker, and the aggregate reconciles it as a pass — named as a file
     with no mutant to kill, not as one no test reaches. */
  it('plans a reached file with no mutant as nothing to run, sweeps it without Stryker, and reconciles it as a pass', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const at = checkout(root, {
        'src/a.ts': "export const a = 'a'\n",
        'src/barrel.ts': "export { a } from './a'\n",
        'src/barrel.test.mjs': "import './barrel'\n",
      })
      const options = { subjects: ['src/barrel.ts'], tree: ['src/a.ts', 'src/barrel.ts', 'src/barrel.test.mjs'], commits: commitsAt() }
      const manifest = path.join(root, 'plan.json')
      const results = path.join(root, 'results')
      const none = `check-mutants: 1 file(s) had no mutant to kill — Stryker made none, or every one is disabled beside the code — so they pass without any test having been tried against them:\n  ${at['src/barrel.ts']}\n`

      const plan = await sweep(root, { argv: ['--plan', manifest, '--shards', '1'], ...options })
      /* No clock is handed in, so this shard times itself the way a real one
         does — every other case here stands one in, and a duration nothing
         measures is one every later plan would balance on. */
      const shard = await sweep(root, {
        argv: ['--shard', '1/1', '--manifest', manifest, '--results', results],
        ...options,
        clock: undefined,
      })
      const aggregate = await aggregateOf(root, manifest)

      expect(plan.code).toBe(0)
      expect(readJson(manifest).subjects).toEqual([
        expect.objectContaining({ path: 'src/barrel.ts', class: 'no-mutants', mutants: 0, identities: [], tests: ['src/barrel.test.mjs'] }),
      ])
      expect(shard.stderr).toBe('')
      expect(shard.code).toBe(0)
      /* Its own file and no other: a shard that ran no Stryker at all still
         summarises exactly the files it was given. */
      expect(shard.stdout).toBe(shardSays(manifest, '1/1', 1) + none)
      expect(shard.locks.taken).toBe(0)
      expect(readJson(resultIn(results, 1, 'src/barrel.ts'))).toMatchObject({ outcome: 'no-mutants', exitedCleanly: null, mutants: 0, report: null })
      /* And its duration is the clock's, not a stand-in's: this shard was given none. */
      expect(readJson(resultIn(results, 1, 'src/barrel.ts')).durationMs).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(readJson(resultIn(results, 1, 'src/barrel.ts')).durationMs)).toBe(true)
      expect(aggregate.stderr).toBe('')
      expect(aggregate.code).toBe(0)
      expect(aggregate.stdout).toBe(reconciled(manifest, 1) + none)
    })
  })

  /* ⚠️ **ONLY A REFUSAL MARKS WHAT A SHARD WROTE.** What stops a shard other
     than a refusal is this gate's own defect, and a result written before it
     says nothing about the checkout — so it is left exactly as the shard wrote
     it. The error here carries a `detail` of its own, as anything thrown may:
     without one, a result marked with it would read the same as one left alone,
     and nothing could tell which rule ran. */
  it('leaves the results it wrote unmarked when what stopped it was not a refusal', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const subjects = ['src/a.ts', 'src/z.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      const broke = Object.assign(new Error('Stryker itself broke'), { detail: 'not a refusal, whatever it carries' })

      const thrown = await shardOf(root, manifest, '1/1', {
        subjects,
        stryker: () => {
          throw broke
        },
      }).then(
        () => null,
        (cause) => cause,
      )

      expect(thrown).toBe(broke)
      const written = readJson(resultIn(results, 1, 'src/z.ts'))
      expect(written.outcome).toBe('no-mutants')
      expect(Object.hasOwn(written, 'stopped'), 'a result was marked stopped for no reason anybody wrote').toBe(false)
      expect(existsSync(receiptIn(results, 1))).toBe(false)
    })
  })

  /* ⚠️ **A FILE A SHARD SKIPS IS STILL COUNTED, AND THE COUNT IS COMPARED** — a
     `Stryker disable all` taken off between the plan and the shard leaves a file
     with a mutant nobody will try, under a plan that says there is nothing to
     try. Its content is read before the count, so this is the one difference the
     comparison above cannot have caught. */
  it('refuses a shard where a file it would skip has other mutants in it than the plan counted', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const at = checkout(root, {
        'src/guarded.ts': "// Stryker disable all: measured, and none of this is behaviour\nexport const guarded = 'guarded'\n",
        'src/guarded.test.mjs': "import './guarded'\n",
      })
      const subjects = ['src/guarded.ts']
      const tree = ['src/guarded.ts', 'src/guarded.test.mjs']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0, tree })
      /* The directive goes between the shard's own reading of the file and its
         count of what Stryker makes in it. */
      let ticks = 0
      const clock = () => {
        ticks += 1
        if (ticks === 1) writeFileSync(at['src/guarded.ts'], "export const guarded = 'guarded'\n")
        return ticks * 250
      }

      const result = await shardOf(root, manifest, '1/1', { subjects, tree, clock })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/1 would sweep something other than its plan — refused:\n` +
          '  src/guarded.ts has 1 mutant(s) here, and the plan counted 0\n',
      )
      expect(existsSync(path.join(root, 'results', 'shard-1'))).toBe(false)
    })
  })

  /* ⚠️ **A CHECK THAT REFUSES EVERY VALUE IS AS WRONG AS ONE THAT REFUSES NONE**,
     and only a value it must ACCEPT tells the two apart: every refusal above
     would still read the same if `--only` were refused outright, or a working
     tree with a deleted file in it. Both are ordinary — a sweep narrowed while
     working on one module, on a branch that removed another. */
  it('reads back a plan narrowed with --only whose working tree holds a file that is gone', async () => {
    await inScratch('mutants-plan-', async (root) => {
      planned(root)
      const manifest = path.join(root, 'plan.json')
      const tree = { 'src/gone.ts': null }
      const options = { subjects: PLANNED, tree: PLANNED_TREE, commits: commitsAt(), worktree: () => tree }

      const plan = await sweep(root, { argv: ['--plan', manifest, '--shards', '1', '--only', 'src/z'], ...options })
      const shard = await sweep(root, { argv: ['--shard', '1/1', '--manifest', manifest, '--results', path.join(root, 'results')], ...options })

      expect(plan.stderr).toBe('')
      expect(plan.code).toBe(0)
      expect(readJson(manifest)).toMatchObject({ only: 'src/z', worktree: { 'src/gone.ts': null } })
      expect(readJson(manifest).subjects.map((one) => one.path)).toEqual(['src/z.ts'])
      expect(shard.stderr).toBe('')
      expect(shard.code).toBe(0)
    })
  })

  /* A plan this gate could not read back is this gate's own defect, and it is
     thrown where it is made rather than met on every shard minutes later — as a
     plain error, because nothing a reader can do about their checkout fixes it. */
  it('throws where it builds a plan its own shards would refuse, and writes nothing', async () => {
    await inScratch('mutants-plan-', async (root) => {
      planned(root)
      const manifest = path.join(root, 'plan.json')

      const thrown = await sweep(root, {
        argv: ['--plan', manifest, '--shards', '2'],
        subjects: PLANNED,
        tree: PLANNED_TREE,
        commits: () => ({ head: 'HEAD', mergeBase: BASE }),
      }).then(
        () => null,
        (cause) => cause,
      )

      expect(thrown).toBeInstanceOf(Error)
      expect(thrown.message).toBe(
        `check-mutants: the plan built for ${manifest} would not read back — its head is "HEAD", which is not a commit`,
      )
      expect(existsSync(manifest)).toBe(false)
    })
  })

  /* The two differences the cases above do not reach: a plan made with NO merge
     base against a checkout that has one, which is the first half of that
     sentence; and a subject reached through another module than the plan's,
     while the tests that reach it and their contents are exactly the plan's. */
  it('refuses a shard whose merge base appeared since the plan, or that reaches a subject through other modules', async () => {
    await inScratch('mutants-refuse-', async (root) => {
      planned(root)
      const baseless = await planOver(root, { commits: commitsAt(HEAD, null) })
      const based = await shardOf(root, baseless, '1/3', { commits: commitsAt(HEAD, BASE) })

      expect(based.code).toBe(2)
      expect(based.stderr).toBe(
        `check-mutants: this checkout is not the one ${baseless} was planned for, so shard 1/3 would sweep something other than its plan — refused:\n` +
          `  the merge base with "main" differs: planned at none, here ${BASE}\n`,
      )
    })
    await inScratch('mutants-refuse-', async (root) => {
      planned(root)
      const manifest = await planOver(root)
      /* Another module that re-exports `b.ts`, reached by the same test through
         `c.ts`: the covering tests and their contents are the plan's, and the
         modules the subject is reached through are not. */
      plant(root, { 'src/d.ts': "export { b } from './b'\n" })

      const result = await shardOf(root, manifest, '1/3', { tree: [...PLANNED_TREE, 'src/d.ts'] })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: this checkout is not the one ${manifest} was planned for, so shard 1/3 would sweep something other than its plan — refused:\n` +
          "  src/b.ts is reached through other modules than the plan's\n",
      )
    })
  })

  /* ⚠️ **A SHARD THAT STOPS NAMES EVERY DIFFERENCE, NOT THE FIRST** — the lines
     go to the log one to a row, and into the result it has already written as
     one reason, because a result marked with half of why it was stopped is a
     result somebody argues with. */
  it('names every difference that stopped it, in the log and in the results it had already written', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const other = 'c'.repeat(40)
      /* The tree is read four times over the two runs — once to plan, once as
         the shard begins, and once on each side of the one Stryker run — and both
         commits and tree change at the last of them, which is the look after the
         file was swept. The commits are asked immediately before the tree, so
         they count one behind it. */
      let looks = 0
      const commits = () => ({ head: looks >= 3 ? other : HEAD, mergeBase: BASE })
      const worktree = () => {
        looks += 1
        return looks >= 4 ? { 'src/helper.testkit.mjs': 'e'.repeat(64) } : {}
      }
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0, commits, worktree })
      const results = path.join(root, 'results')
      const { stryker } = strykerStandIn(root, { reports: { [files['src/a.ts']]: await plantedReport(files['src/a.ts'], 'Killed') } })
      const why = [
        `the HEAD commit differs: planned at ${HEAD}, here ${other}`,
        "the working tree differs from the plan's at src/helper.testkit.mjs",
      ]

      const result = await shardOf(root, manifest, '1/1', { subjects, commits, worktree, stryker })

      expect(result.code).toBe(2)
      expect(result.stderr).toBe(
        `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so src/a.ts was swept from something other than its plan — stopped:\n` +
          why.map((line) => `  ${line}`).join('\n') +
          '\n',
      )
      expect(readJson(resultIn(results, 1, 'src/a.ts')).stopped).toBe(why.join('; '))
    })
  })

  /* ⚠️ **A RESULTS DIRECTORY OUTSIDE THE CHECKOUT IS NOT ONE GIT TRACKS**, and
     the parent of the checkout is the one path whose name for that is exactly
     `..` — a comparison that read it as a name rather than as a step out would
     ask git about the whole repository above and refuse a perfectly good
     directory. */
  it('takes a results directory that is the checkout’s own parent, which nothing in the plan can reach', async () => {
    await inScratch('mutants-outside-', async (outer) => {
      const root = path.join(outer, 'checkout')
      mkdirSync(root)
      planned(root)
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', '.')
      git('commit', '-qm', 'start')
      const manifest = path.join(outer, 'plan.json')
      const options = { subjects: ['src/z.ts'], tree: PLANNED_TREE, commits: commitsAt(), tracked: trackedUnder }

      const plan = await sweep(root, { argv: ['--plan', manifest, '--shards', '1'], ...options })
      const shard = await sweep(root, { argv: ['--shard', '1/1', '--manifest', manifest, '--results', outer], ...options })

      expect(plan.code, plan.stderr).toBe(0)
      expect(shard.stderr).toBe('')
      expect(shard.code).toBe(0)
      expect(existsSync(receiptIn(outer, 1))).toBe(true)
    })
  })

  /* Results another run left are found BEFORE git is asked anything, so a shard
     that cannot derive its scope at all still says what is actually in its way;
     and a directory it cannot create for any other reason is that reason, never
     the one message this gate has for a directory that is already there. */
  it('finds results another run left before it asks git anything, and does not read every failed claim as one', async (context) => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const manifest = await planOver(root)
      const results = path.join(root, 'results')
      const own = path.join(results, 'shard-1')
      mkdirSync(own, { recursive: true })

      const early = await shardOf(root, manifest, '1/3', {
        changed: () => {
          throw new Error('git is unhappy here')
        },
      })

      expect(early.code).toBe(2)
      expect(early.stderr).toBe(
        `check-mutants: ${own} already exists — a shard writes into a directory of its own, and results another run left there would be read as this one's; remove it, or pass another --results\n`,
      )
    })
    /* The half above holds on Windows, and is asked there; this half needs a
       directory closed to this user. Skipped between the two rather than split,
       because either half alone is not what this recorded name says. */
    if (WINDOWS) return context.skip(WINDOWS_CANNOT.closeADirectory)
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const manifest = await planOver(root)
      const shut = path.join(root, 'shut')
      mkdirSync(shut)
      chmodSync(shut, 0o500)
      try {
        /* Root creates directories anywhere, and this would then pass having made one. */
        expect(thrownBy(() => mkdirSync(path.join(shut, 'probe')))?.code, 'this case needs a user permissions apply to').toBe('EACCES')

        const thrown = await shardOf(root, manifest, '1/3', {
          argv: ['--shard', '1/3', '--manifest', manifest, '--results', shut],
        }).then(
          () => null,
          (cause) => cause,
        )

        expect(thrown?.code).toBe('EACCES')
      } finally {
        chmodSync(shut, 0o700)
      }
    })
  })

  /* ⚠️ **THREE WAYS PAST THE SAME PROTECTION** (fourth review, 2026-09-14):
     `--plan` with the CHECKOUT ROOT'S own case changed read as a path outside the
     checkout, because the folding came after that decision; a `..` was collapsed
     before links were resolved, so `link/../x` was validated as one place and
     written in another; and a TRACKED SYMLINK out of the tree was neither an
     input nor, once resolved, inside the checkout — so the plan removed the link
     and wrote the manifest in its place. */
  it('refuses a plan whose path reaches an input by another case, through a "..", or through a link out of the tree', async () => {
    await inScratch('mutants-plan-', async (root) => {
      const outside = mkdtempSync(path.join(realpathSync(tmpdir()), 'mutants-outside-'))
      onTestFinished(() => rmSync(outside, { recursive: true, force: true }))
      const kept = path.join(outside, 'victim.json')
      writeFileSync(kept, '{"outside":true}\n')
      const files = { ...planned(root), ...plant(root, { 'src/fixture.json': '{"rows":[1,2,3]}\n' }) }
      symlinkSync(kept, path.join(root, 'src', 'linked.json'))
      symlinkSync(kept, path.join(root, 'loose.json'))
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', 'src/fixture.json', 'src/linked.json')
      git('commit', '-qm', 'fixtures')
      const planInto = (target) =>
        sweep(root, {
          argv: ['--plan', target, '--shards', '1'],
          subjects: PLANNED,
          tree: PLANNED_TREE,
          commits: commitsAt(),
          worktree: () => ({}),
          tracked: trackedUnder,
        })
      const tracks = (target, held) =>
        `check-mutants: --plan ${target} is a path git tracks — it holds ${held} — so a plan written there would replace a tracked file its shards then leave out of drift detection; write the plan where git tracks nothing\n`

      const upperRoot = path.join(path.dirname(root), path.basename(root).toUpperCase())
      if (existsSync(upperRoot)) {
        const aliased = path.join(upperRoot, 'src', 'fixture.json')
        const cased = await planInto(aliased)
        expect(cased.stderr).toBe(tracks(aliased, 'src/fixture.json'))
        expect(cased.code).toBe(2)
      }
      const dotted = `${root}/src/../src/fixture.json`
      const dots = await planInto(dotted)
      const linked = path.join(root, 'src', 'linked.json')
      const throughLink = await planInto(linked)
      const loose = path.join(root, 'loose.json')
      const ontoLink = await planInto(loose)

      expect(dots.stderr).toBe(
        `check-mutants: ${dotted} has a ".." in it, and a path this gate writes to or reads a plan from must say plainly where it goes — pass one without\n`,
      )
      expect(dots.code).toBe(2)
      expect(throughLink.stderr).toBe(tracks(linked, 'src/linked.json'))
      expect(throughLink.code).toBe(2)
      expect(ontoLink.stderr).toBe(
        `check-mutants: ${loose} is a symbolic link, and this gate writes through none — remove it if nothing is using it\n`,
      )
      expect(ontoLink.code).toBe(2)
      expect(readFileSync(kept, 'utf8')).toBe('{"outside":true}\n')
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
      expect(lstatSync(loose).isSymbolicLink()).toBe(true)
      expect(readFileSync(files['src/fixture.json'], 'utf8')).toBe('{"rows":[1,2,3]}\n')
    })
  })

  /* ⚠️ **THE SKIP WALKED PAST THE DRIFT CHECKS** (fourth review, 2026-09-14). A
     file counted as having no mutant was written up as a pass without the checks
     around it that a file Stryker runs gets — so a `Stryker disable all` removed
     right after the count left the shard writing a passing result, and a receipt,
     for a file that by then had a mutant. A skipped file gets both checks. */
  it('checks the checkout around a file it skips for having no mutant, as around one it runs', async () => {
    for (const when of ['counted', 'written']) {
      await inScratch('mutants-shard-', async (root) => {
        const at = checkout(root, {
          'src/barrel.ts': "export { guarded } from './guarded'\n",
          'src/barrel.test.mjs': "import './barrel'\n",
          'src/guarded.ts': "// Stryker disable all: measured, and none of this is behaviour\nexport const guarded = 'guarded'\n",
          'src/guarded.test.mjs': "import './guarded'\n",
        })
        const subjects = ['src/barrel.ts', 'src/guarded.ts']
        const tree = [...subjects, 'src/barrel.test.mjs', 'src/guarded.test.mjs']
        const directiveGone = () => writeFileSync(at['src/guarded.ts'], "export const guarded = 'guarded'\n")
        const changed = () => !readFileSync(at['src/guarded.ts'], 'utf8').includes('Stryker disable')
        /* `counted`: the directive goes once both files have been counted, so no
           count can differ. `written`: it goes after the first file's result is
           written, which only a check AFTER that file can catch. */
        let ticks = 0
        let looks = 0
        const clock = () => {
          ticks += 1
          if (when === 'counted' && ticks === 4) directiveGone()
          return ticks * 250
        }
        const worktree = () => {
          looks += 1
          if (when === 'written' && looks === 3) directiveGone()
          return changed() ? { 'src/guarded.ts': 'e'.repeat(64) } : {}
        }
        const manifest = await planOver(root, { subjects, shards: 1, isolate: 0, tree, worktree: () => ({}) })
        const results = path.join(root, 'results')
        const why = "the working tree differs from the plan's at src/guarded.ts"
        const stopped = when === 'counted' ? 'src/barrel.ts and every file after it would be swept' : 'src/barrel.ts was swept'

        const result = await shardOf(root, manifest, '1/1', { subjects, tree, worktree, clock })

        expect(result.stderr).toBe(
          `check-mutants: the checkout changed while shard 1/1 of ${manifest} was sweeping, so ${stopped} from something other than its plan — stopped:\n  ${why}\n`,
        )
        expect(result.code).toBe(2)
        expect(existsSync(receiptIn(results, 1))).toBe(false)
        expect(existsSync(resultIn(results, 1, 'src/guarded.ts'))).toBe(false)
        if (when === 'counted') expect(existsSync(resultIn(results, 1, 'src/barrel.ts'))).toBe(false)
        else expect(readJson(resultIn(results, 1, 'src/barrel.ts')).stopped).toBe(why)
      })
    }
  })

  /* ⚠️ **CLAIMING THE DIRECTORY PROTECTED IT ONLY AT THAT MOMENT** (fourth
     review, 2026-09-14): with the results parent renamed and a symbolic link put
     in its place afterwards, every later write followed the link into tracked
     fixtures — which `writeFresh` removed on its way. The directory's identity is
     taken when it is claimed and checked before every write. */
  it('writes nothing more once the directory it claimed is no longer the one it claimed', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const subjects = ['src/z.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      const own = path.join(results, 'shard-1')
      const decoy = path.join(root, 'decoy')
      const fixture = path.join(decoy, 'shard-1', resultFileFor('src/z.ts'))
      plant(root, { [`decoy/shard-1/${resultFileFor('src/z.ts')}`]: '{"kept":true}\n' })
      let moved = false
      const stdout = {
        write: (text) => {
          if (moved || !text.includes("are this shard's")) return
          moved = true
          renameSync(results, `${results}-gone`)
          symlinkSync(decoy, results)
        },
      }

      const result = await shardOf(root, manifest, '1/1', { subjects, stdout })

      expect(result.stderr).toBe(
        `check-mutants: ${own} is no longer the directory this shard claimed — something moved or replaced it while the shard was writing, and nothing more goes there\n`,
      )
      expect(result.code).toBe(2)
      expect(readFileSync(fixture, 'utf8')).toBe('{"kept":true}\n')
    })
  })

  /* ⚠️ **THE RESULT'S NAME WAS THE WHOLE SUBJECT PATH, ENCODED** (fourth review,
     2026-09-14): 27 Chinese characters are 84 bytes, and percent-encoding made
     264 of them — past `NAME_MAX`, so the write failed outright. The name is
     bounded now: a readable slug and a digest of the path, with the path itself
     inside the record, where the aggregate reads it. */
  it('names a result file within a filesystem’s bounds whatever the subject is called, and keeps the subject’s own path inside it', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const wide = `src/${'测'.repeat(27)}.ts`
      checkout(root, {
        [wide]: "export { wide } from './wide'\n",
        'src/wide.ts': "export const wide = 'wide'\n",
        'src/wide.test.mjs': `import './${'测'.repeat(27)}.ts'\n`,
      })
      const subjects = [wide]
      const tree = [wide, 'src/wide.ts', 'src/wide.test.mjs']
      const options = { subjects, tree, commits: commitsAt() }
      const manifest = path.join(root, 'plan.json')
      const results = path.join(root, 'results')

      const plan = await sweep(root, { argv: ['--plan', manifest, '--shards', '1'], ...options })
      const shard = await sweep(root, { argv: ['--shard', '1/1', '--manifest', manifest, '--results', results], ...options })
      const aggregate = await aggregateOf(root, manifest)

      expect(plan.code).toBe(0)
      expect(shard.stderr).toBe('')
      expect(shard.code).toBe(0)
      const [name] = readdirSync(path.join(results, 'shard-1')).filter((one) => one !== 'receipt.json')
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255)
      expect(readJson(path.join(results, 'shard-1', name)).subject).toBe(wide)
      expect(aggregate.stderr).toBe('')
      expect(aggregate.code).toBe(0)
    })
  })

  /* ⚠️ **CLAIMING A SHARD'S DIRECTORY WAS NOT ATOMIC** (third review,
     2026-09-14). Two runs of one shard could both find no directory, both
     create it recursively, and write over each other. The directory is claimed
     with one exclusive create now, and a claimant that finds it already made is
     refused. The race is driven at the point it happens: the first run's claim
     and receipt land between the second run's first look and its claim. */
  it('claims its shard directory exclusively, so a second run of the shard that got past the first look is refused and the first run’s receipt survives', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const subjects = ['src/z.ts']
      const manifest = await planOver(root, { subjects, shards: 1, isolate: 0 })
      const results = path.join(root, 'results')
      const own = path.join(results, 'shard-1')
      const firstReceipt = '{"kind":"receipt","by":"the first run"}\n'
      let raced = false
      const commits = (...args) => {
        if (!raced) {
          raced = true
          mkdirSync(own, { recursive: true })
          writeFileSync(receiptIn(results, 1), firstReceipt)
        }
        return commitsAt()(...args)
      }

      const second = await shardOf(root, manifest, '1/1', { subjects, commits })

      expect(second.stderr).toBe(
        `check-mutants: ${own} already exists — a shard writes into a directory of its own, and results another run left there would be read as this one's; remove it, or pass another --results\n`,
      )
      expect(second.code).toBe(2)
      expect(readFileSync(receiptIn(results, 1), 'utf8')).toBe(firstReceipt)
      expect(readdirSync(own)).toEqual(['receipt.json'])
    })
  })

  /* ⚠️ **WHAT IS CHECKED IS THE HEAD COMMIT AND THE MERGE BASE — NOT THE BASE
     BRANCH'S TIP** (decided 2026-09-14, after a review showed a moved tip was
     accepted). Every subject derives from the merge base, so a target branch
     that takes an unrelated commit mid-run changes nothing a shard sweeps, and
     refusing it would fail CI for no defect. This pins that it proceeds. */
  it('proceeds when the base branch has moved on but the HEAD commit and the merge base are the plan’s', async () => {
    await inScratch('mutants-base-', async (root) => {
      const files = planned(root)
      const git = gitIn(root)
      git('init', '-q', '-b', 'main')
      git('add', '.')
      git('commit', '-qm', 'base')
      git('checkout', '-qb', 'work')
      plant(root, { 'src/a.ts': "export const a = 'work'\n" })
      git('commit', '-qam', 'work')
      const commits = (base, requireBase) => commitsOf(base, requireBase, root)
      const manifest = await planOver(root, { commits })
      const tip = git('rev-parse', 'main')
      git('update-ref', 'refs/heads/main', git('commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'unrelated'))
      const { stryker } = strykerStandIn(root, { reports: { [files['src/b.ts']]: await plantedReport(files['src/b.ts'], 'Killed', 'Killed') } })

      const result = await shardOf(root, manifest, '1/3', { commits, stryker })

      expect(git('rev-parse', 'main')).not.toBe(tip)
      expect(readJson(manifest).mergeBase).toBe(git('merge-base', 'HEAD', 'main'))
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.locks).toEqual({ taken: 1, released: 1 })
    })
  })

  it('refuses a plan it cannot read or did not write, a shard spec its plan was not made over, and results a previous run left, before sweeping anything', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const manifest = await planOver(root)
      const plan = readJson(manifest)
      const results = path.join(root, 'results')
      const variant = (name, contents) =>
        plant(root, { [name]: typeof contents === 'string' ? contents : JSON.stringify(contents) })[name]
      const refused = async (spec, file) => {
        const result = await shardOf(root, file, spec)
        expect(result.code, `${spec} ${file}`).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.locks.taken).toBe(0)
        return result.stderr
      }
      const notWritten = (file, problem) => `check-mutants: ${file} is not a plan this gate wrote — ${problem}\n`
      /* One planned subject rewritten, the rest of the plan as it was. */
      const rewritten = (named, fields) => ({
        ...plan,
        subjects: plan.subjects.map((one) => (one.path === named ? { ...one, ...fields } : one)),
      })

      expect(await refused('1/4', manifest)).toBe(`check-mutants: --shard 1/4 does not match ${manifest}, which was planned over 3 shard(s)\n`)
      const absent = path.join(root, 'absent.json')
      const unread = await refused('1/3', absent)
      expect(unread.startsWith(`check-mutants: cannot read the plan ${absent} — `), unread).toBe(true)
      expect(unread.length).toBeGreaterThan(`check-mutants: cannot read the plan ${absent} — \n`.length)
      const torn = variant('torn.json', '{"version":')
      expect(await refused('1/3', torn)).toBe(`check-mutants: ${torn} is not a plan — ${thrownBy(() => JSON.parse('{"version":')).message}\n`)
      for (const [name, contents, problem] of [
        ['list.json', [], 'it is not an object'],
        ['v2.json', { ...plan, version: 2 }, 'its version is 2, and this gate reads version 1'],
        ['far.json', { ...plan, subjects: plan.subjects.map((one) => (one.path === 'src/a.ts' ? { ...one, shard: 4 } : one)) }, 'src/a.ts has shard 4, and the plan has 3 shard(s)'],
        ['twice.json', { ...plan, subjects: [...plan.subjects, plan.subjects[0]] }, 'src/a.ts is planned twice'],
        [
          'untested.json',
          { ...plan, subjects: plan.subjects.map((one) => (one.path === 'src/a.ts' ? { ...one, tests: [] } : one)) },
          'src/a.ts is mutated with 0 covering test(s) and 1 mutant(s), which this gate plans as no-test-found',
        ],
        [
          'counted.json',
          { ...plan, subjects: plan.subjects.map((one) => (one.path === 'src/z.ts' ? { ...one, mutants: 3 } : one)) },
          'src/z.ts is no-mutants with 0 covering test(s) and 3 mutant(s), which this gate plans as no-test-found',
        ],
        ['headless.json', { ...plan, head: 'HEAD' }, 'its head is "HEAD", which is not a commit'],
        ['treeless.json', { ...plan, worktree: undefined }, 'its worktree is missing, which is not a map of paths'],
        /* ⚠️ **EVERY FIELD BELOW WAS CHECKED AND NONE OF THEM WAS TESTED** (the
           mutation sweep of 2026-09-14 counted 70 mutants in these refusals that
           no test reached). A shard and the aggregate both act on a plan's
           fields, so a check that has quietly stopped naming what is wrong with
           one is a shard acting on a value this gate would never have written. */
        ['based.json', { ...plan, mergeBase: 'HEAD~1' }, 'its mergeBase is "HEAD~1", which is neither a commit nor null'],
        ['unnamed-tree.json', { ...plan, worktree: { '': null } }, 'its worktree names "" with null, which is neither a digest nor null'],
        ['baseless.json', { ...plan, base: '' }, 'its base is "", which is not a ref'],
        ['onlyless.json', { ...plan, only: '' }, 'its only is "", which is neither a substring nor null'],
        ['numbered.json', { ...plan, only: 5 }, 'its only is 5, which is neither a substring nor null'],
        ['asked.json', { ...plan, requireBase: 'yes' }, 'its requireBase is "yes", which is neither true nor false'],
        ['shardless.json', { ...plan, shards: 0 }, 'its shards is 0, which is not a count of shards'],
        ['alone.json', { ...plan, isolate: 3 }, 'its isolate is 3, which is not a whole number below its shards'],
        ['mapped.json', { ...plan, subjects: {} }, 'its subjects is an object, which is not a list'],
        ['flat.json', { ...plan, subjects: ['src/a.ts'] }, 'subject 1 is not an object'],
        ['pathless.json', rewritten('src/a.ts', { path: '' }), 'subject 1 has path "", which is not a path'],
        ['unhashed.json', rewritten('src/a.ts', { sha256: 'nope' }), 'src/a.ts has sha256 "nope", which is not a digest'],
        ['classless.json', rewritten('src/a.ts', { class: 'guessed' }), 'src/a.ts has class "guessed", which this gate does not plan'],
        ['uncounted.json', rewritten('src/a.ts', { mutants: 'one' }), 'src/a.ts has mutants "one", which is not a count'],
        ['listless.json', rewritten('src/a.ts', { leftOut: 5 }), 'src/a.ts has leftOut 5, which is not a list of paths'],
        ['blank.json', rewritten('src/a.ts', { through: [''] }), 'src/a.ts has through a list, which is not a list of paths'],
        ['undigested.json', rewritten('src/a.ts', { testsDigest: 'no' }), 'src/a.ts has testsDigest "no", which is not a digest'],
        [
          'unnamed.json',
          { ...plan, subjects: plan.subjects.map((one) => (one.path === 'src/a.ts' ? { ...one, identities: [] } : one)) },
          'src/a.ts counts 1 mutant(s) and names 0',
        ],
        [
          'misnamed.json',
          { ...plan, subjects: plan.subjects.map((one) => (one.path === 'src/a.ts' ? { ...one, identities: [{ mutatorName: 'StringLiteral' }] } : one)) },
          'src/a.ts has identities a list, which is not a list of mutants',
        ],
        [
          'untreed.json',
          { ...plan, worktree: { 'src/a.ts': 'nope' } },
          'its worktree names "src/a.ts" with "nope", which is neither a digest nor null',
        ],
      ]) {
        const file = variant(name, contents)
        expect(await refused('1/3', file), name).toBe(notWritten(file, problem))
      }
      expect(existsSync(results)).toBe(false)

      mkdirSync(path.join(results, 'shard-2'), { recursive: true })
      expect(await refused('2/3', manifest)).toBe(
        `check-mutants: ${path.join(results, 'shard-2')} already exists — a shard writes into a directory of its own, and results another run left there would be read as this one's; remove it, or pass another --results\n`,
      )
    })
  })

  /* (e) ⚠️ **A SHARD'S FINDINGS ARE ITS RESULT FILES, NOT ITS LOG.** A shard
     that failed wrote nothing the aggregate could read, and a report Stryker
     wrote was deleted as the next subject began. So every subject leaves a result
     — whatever its outcome, and as soon as it has one — holding Stryker's own
     report and the time it took, which is what a later plan can balance on. */
  it('sweeps only its own files and writes each one’s result — outcome, duration, mutant count and Stryker’s own report — whether it passed, failed or never ran, then a receipt', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const manifest = await planOver(root)
      const plan = sha(manifest)
      const results = path.join(root, 'results')
      const survived = await plantedReport(files['src/a.ts'], 'Survived')
      const killed = await plantedReport(files['src/r.ts'], 'Killed')
      const { stryker, seen } = strykerStandIn(root, {
        reports: { [files['src/a.ts']]: survived, [files['src/r.ts']]: killed },
        exits: { [files['src/a.ts']]: false, [files['src/b.ts']]: false },
      })

      const second = await shardOf(root, manifest, '2/3', { stryker })
      const third = await shardOf(root, manifest, '3/3', { stryker })
      const first = await shardOf(root, manifest, '1/3', { stryker })

      expect(seen.map(({ subject, vitest }) => [subject, vitest.test.include])).toEqual([
        [files['src/a.ts'], [asGlob(files['src/a.test.mjs'])]],
        [files['src/r.ts'], [asGlob(files['src/r.behaviour.test.mjs']), asGlob(files['src/r.more.test.mjs'])]],
        [files['src/b.ts'], [asGlob(files['src/c.test.mjs'])]],
      ])
      const result = (shard, subject, fields) => ({
        kind: 'result',
        version: 1,
        plan,
        shard,
        subject,
        sha256: sha(files[subject]),
        durationMs: 250,
        settle: null,
        /* Nothing the merge base was asked about: this plan traces no subject to
           a file there, so `src/a.ts`'s survivor is the change's own. */
        base: null,
        ...fields,
      })
      expect(readJson(resultIn(results, 2, 'src/a.ts'))).toEqual(result(2, 'src/a.ts', { outcome: 'survived', exitedCleanly: false, mutants: 1, report: survived }))
      expect(readJson(resultIn(results, 2, 'src/n.ts'))).toEqual(result(2, 'src/n.ts', { outcome: 'no-test-found', exitedCleanly: null, mutants: 1, report: null }))
      expect(readJson(resultIn(results, 2, 'src/z.ts'))).toEqual(result(2, 'src/z.ts', { outcome: 'no-mutants', exitedCleanly: null, mutants: 0, report: null }))
      expect(readJson(resultIn(results, 3, 'src/r.ts'))).toEqual(result(3, 'src/r.ts', { outcome: 'killed', exitedCleanly: true, mutants: 1, report: killed }))
      expect(readJson(resultIn(results, 1, 'src/b.ts'))).toEqual(result(1, 'src/b.ts', { outcome: 'did-not-run', exitedCleanly: false, mutants: null, report: null }))
      expect(readdirSync(path.join(results, 'shard-2')).sort()).toEqual(
        ['receipt.json', ...['src/a.ts', 'src/n.ts', 'src/z.ts'].map(resultFileFor)].sort(),
      )
      for (const [shard, subjects] of [
        [1, ['src/b.ts']],
        [2, ['src/a.ts', 'src/n.ts', 'src/z.ts']],
        [3, ['src/r.ts']],
      ]) {
        expect(readJson(receiptIn(results, shard))).toEqual({ kind: 'receipt', version: 1, plan, shard, count: 3, subjects })
      }

      expect(second.code).toBe(1)
      expect(second.stdout).toBe(
        shardSays(manifest, '2/3', 3) +
          noMutantIn(files['src/z.ts']) +
          `check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${files['src/a.ts']}\n`,
      )
      expect(second.stderr).toBe(noTestFoundFor([files['src/n.ts'], 1]) + survivedIn(files['src/a.ts']))
      expect(third.code).toBe(0)
      expect(third.stderr).toBe('')
      expect(third.stdout).toBe(
        shardSays(manifest, '3/3', 1) +
          leftOutOf([files['src/r.ts'], 2, [files['src/r.test.mjs']]]) +
          `check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${files['src/r.ts']}\n` +
          'check-mutants: every mutant was killed\n',
      )
      expect(first.code).toBe(1)
      expect(first.stdout).toBe(
        shardSays(manifest, '1/3', 1) +
          `check-mutants: mutating 1 changed file(s), one run each\n  [1/1] ${files['src/b.ts']} — through ${throughName(files['src/c.ts'])}\n`,
      )
      expect(first.stderr).toBe(notRunIn(RUN_TAIL, files['src/b.ts']))
      for (const one of [first, second, third]) expect(one.locks).toEqual({ taken: 1, released: 1 })
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* (d) The lock is the CHECKOUT'S, and a shard takes it exactly as a plain
     sweep does: sharding spreads a sweep across checkouts, never inside one. */
  it('takes the checkout’s lock for its Stryker runs as a plain sweep does, and is refused by it the same way, leaving no receipt', async () => {
    await inScratch('mutants-shard-', async (root) => {
      planned(root)
      const manifest = await planOver(root)

      const held = await shardOf(root, manifest, '3/3', {
        lock: () => {
          throw new Error('another sweep (pid 7) holds the lock')
        },
      })

      expect(held.code).toBe(2)
      expect(held.stderr).toBe('check-mutants: another sweep (pid 7) holds the lock\n')
      expect(existsSync(receiptIn(path.join(root, 'results'), 3))).toBe(false)
      expect(leftAt(root)).toEqual(NOTHING_LEFT)
    })
  })

  /* (b), (c) ⚠️ **AN EMPTY SHARD IS GREEN AND PROVES NOTHING.** More shards than
     files is a valid plan, and a shard with no file has nothing to fail — so its
     exit says nothing about the sweep, and it says so. What it leaves is a
     RECEIPT, and the aggregate requires one from every shard: a shard that never
     ran is found there even when it had nothing to sweep. */
  it('receipts a shard with no file to sweep without passing anything on its own, and lets only the aggregate reconcile — more shards than files included', async () => {
    await inScratch('mutants-shard-', async (root) => {
      const files = planned(root)
      const subjects = ['src/a.ts']
      const manifest = await planOver(root, { subjects, isolate: 0 })
      const results = path.join(root, 'results')
      const { stryker } = strykerStandIn(root, { reports: { [files['src/a.ts']]: await plantedReport(files['src/a.ts'], 'Killed') } })

      const shards = []
      for (const spec of ['1/3', '2/3', '3/3']) shards.push(await shardOf(root, manifest, spec, { subjects, stryker }))

      expect(shards.map(({ code }) => code)).toEqual([0, 0, 0])
      for (const [at, spec] of [
        [1, '2/3'],
        [2, '3/3'],
      ]) {
        expect(shards[at].stdout).toBe(emptyShardSays(manifest, spec))
        expect(shards[at].locks.taken).toBe(0)
        expect(readJson(receiptIn(results, at + 1))).toEqual({ kind: 'receipt', version: 1, plan: sha(manifest), shard: at + 1, count: 3, subjects: [] })
      }
      const whole = await aggregateOf(root, manifest)
      expect(whole.stderr).toBe('')
      expect(whole.code).toBe(0)
      expect(whole.stdout).toBe(reconciled(manifest, 3) + 'check-mutants: every mutant was killed\n')

      rmSync(path.join(results, 'shard-3'), { recursive: true })
      const unfinished = await aggregateOf(root, manifest)
      expect(unfinished.code).toBe(1)
      expect(unfinished.stderr).toBe(reconcileFails(manifest) + '  missing: shard 3/3 left no receipt — it did not finish\n')
      expect(unfinished.stdout).toBe('')
    })
  })

  it('passes only when every planned file has exactly one result and every result passes, naming each class as a plain sweep does', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const killed = await allKilled(files)
      const manifest = await plannedAndSwept(root, { subjects: PASSING, reports: killed })

      const result = await aggregateOf(root, manifest)

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(
        reconciled(manifest, 3) +
          detectedIn(files['src/b.ts']) +
          noMutantIn(files['src/z.ts']) +
          'check-mutants: every mutant was killed\n',
      )
      expect(result.locks.taken).toBe(0)
    })
  })

  it('fails a reconciled sweep in a plain sweep’s words for each file that failed', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const [literal] = await mutantIdentitiesIn(files['src/a.ts'])
      const manifest = await plannedAndSwept(root, {
        reports: {
          [files['src/a.ts']]: reportWith(files['src/a.ts'], [{ id: '0', status: 'Survived', static: true, ...literal }]),
          [files['src/r.ts']]: await plantedReport(files['src/r.ts'], 'Killed'),
        },
        exits: { [files['src/a.ts']]: false, [files['src/b.ts']]: false },
      })

      const result = await aggregateOf(root, manifest)

      expect(result.code).toBe(1)
      expect(result.stdout).toBe(reconciled(manifest, 3) + noMutantIn(files['src/z.ts']) + staticNote(`${files['src/a.ts']}:1:18`))
      expect(result.stderr).toBe(
        noTestFoundFor([files['src/n.ts'], 1]) + notRunIn(AGGREGATE_TAIL, files['src/b.ts']) + survivedIn(files['src/a.ts']),
      )
    })
  })

  /* (b) ⚠️ **"EVERY SHARD PASSED" IS NOT "THE SWEEP PASSED".** A result that
     never arrived, arrived twice, belongs to another plan, another shard or
     other content, or cannot be read at all, each leaves some planned file
     unaccounted for or accounted for wrongly — and every shard job can still be
     green. The aggregate names each one, and fails. */
  it('fails naming every result missing, duplicated, unexpected or unreadable, and every shard that left no receipt', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const killed = await allKilled(files)
      const manifest = await plannedAndSwept(root, { subjects: PASSING, reports: killed })
      const clean = path.join(root, 'results')
      const copied = (from, to, change = (one) => one) => {
        mkdirSync(path.dirname(to), { recursive: true })
        writeFileSync(to, JSON.stringify(change(readJson(from))))
      }
      const stray = (dir, name) => path.join(dir, 'stray', name)
      const torn = thrownBy(() => JSON.parse('{"kind":')).message
      const cases = [
        [(dir) => rmSync(resultIn(dir, 2, 'src/a.ts')), () => ['missing: src/a.ts — no result from shard 2/3 that reconciles with the plan']],
        [
          (dir) => copied(resultIn(dir, 3, 'src/r.ts'), path.join(dir, 'again', 'r.result.json')),
          (dir) => [`duplicated: src/r.ts — 2 results: ${path.join(dir, 'again', 'r.result.json')}, ${resultIn(dir, 3, 'src/r.ts')}`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'zzz.result.json'), (one) => ({ ...one, subject: 'src/zzz.ts' })),
          (dir) => [`unexpected: ${stray(dir, 'zzz.result.json')} — src/zzz.ts is not in the plan`],
        ],
        [
          (dir) => copied(resultIn(dir, 3, 'src/r.ts'), stray(dir, 'r.result.json'), (one) => ({ ...one, shard: 2 })),
          (dir) => [`unexpected: ${stray(dir, 'r.result.json')} — src/r.ts is shard 3/3's, and this result says shard 2`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, plan: '0'.repeat(64) })),
          (dir) => [`unexpected: ${stray(dir, 'a.result.json')} — written for another plan`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, sha256: 'f'.repeat(64) })),
          (dir) => [`unexpected: ${stray(dir, 'a.result.json')} — src/a.ts had other content when this result was written`],
        ],
        [(dir) => plant(dir, { 'stray/torn.result.json': '{"kind":' }), (dir) => [`unreadable: ${stray(dir, 'torn.result.json')} — ${torn}`]],
        [
          (dir) => plant(dir, { 'stray/bare.result.json': JSON.stringify({ kind: 'result', version: 1 }) }),
          (dir) => [`unreadable: ${stray(dir, 'bare.result.json')} — its plan is missing, which is not a digest`],
        ],
        [
          (dir) => copied(resultIn(dir, 3, 'src/r.ts'), stray(dir, 'r.result.json'), (one) => ({ ...one, outcome: 'survived' })),
          (dir) => [`unreadable: ${stray(dir, 'r.result.json')} — says survived, and its own report says killed`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/z.ts'), stray(dir, 'z.result.json'), (one) => ({ ...one, outcome: 'no-test-found' })),
          (dir) => [`unreadable: ${stray(dir, 'z.result.json')} — says no-test-found for a file the plan counted as no-mutants`],
        ],
        [(dir) => plant(dir, { 'stray/notes.txt': 'x' }), (dir) => [`unreadable: ${stray(dir, 'notes.txt')} — not a result or a receipt`]],
        /* ⚠️ **EVERY FIELD A RESULT AND A RECEIPT CARRY IS CHECKED, AND NONE OF
           THOSE CHECKS WAS TESTED** (the sweep of 2026-09-14 counted them as
           mutants no test reached). A shard's own files are all the aggregate
           has, so a check that has stopped naming what is wrong with one is the
           aggregate reconciling a value this gate would never have written —
           which is the whole of what it exists to refuse. */
        [
          (dir) => plant(dir, { 'stray/other.json': JSON.stringify({ kind: 'guess', version: 1 }) }),
          (dir) => [`unreadable: ${stray(dir, 'other.json')} — not a result or a receipt`],
        ],
        [
          (dir) => {
            mkdirSync(path.dirname(stray(dir, 'x')), { recursive: true })
            symlinkSync(resultIn(dir, 3, 'src/r.ts'), stray(dir, 'linked.result.json'))
          },
          (dir) => [`unreadable: ${stray(dir, 'linked.result.json')} — not a regular file`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, version: 2 })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its version is 2, and this gate reads version 1`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, shard: 0 })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its shard is 0, which is not a shard`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, subject: '' })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its subject is "", which is not a path`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, sha256: 'nope' })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its sha256 is "nope", which is not a digest`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, outcome: 'guessed' })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its outcome is "guessed", which this gate does not write`],
        ],
        [
          (dir) => copied(resultIn(dir, 3, 'src/r.ts'), stray(dir, 'r.result.json'), (one) => ({ ...one, exitedCleanly: null })),
          (dir) => [`unreadable: ${stray(dir, 'r.result.json')} — its exitedCleanly is null, which does not go with killed`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/z.ts'), stray(dir, 'z.result.json'), (one) => ({ ...one, exitedCleanly: true })),
          (dir) => [`unreadable: ${stray(dir, 'z.result.json')} — its exitedCleanly is true, which does not go with no-mutants`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, mutants: 'two' })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its mutants is "two", which is not a count`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, durationMs: -1 })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its durationMs is -1, which is not a duration`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, report: [] })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its report is a list, which is not a report`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, stopped: '' })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its stopped is "", which is not a reason`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, stopped: 5 })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its stopped is 5, which is not a reason`],
        ],
        /* ⚠️ **A RESULT FROM BEFORE THE SETTLE RUN EXISTED CARRIES NO `settle`
           AT ALL, AND `undefined` IS NOT `null`** (2026-09-15): one would
           re-derive as whatever Stryker called its timeouts, which is the
           weaker evidence the settle run removes. Every field of a settle run
           is checked here too — a shard's own files are all the aggregate has. */
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, settle: undefined })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its settle is missing, which is neither a settle run nor null`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({ ...one, settle: 5 })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its settle is 5, which is neither a settle run nor null`],
        ],
        [
          (dir) =>
            copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({
              ...one,
              settle: { exitedCleanly: 'yes', durationMs: 1, report: null },
            })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its settle.exitedCleanly is "yes", which is not an exit`],
        ],
        [
          (dir) =>
            copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({
              ...one,
              settle: { exitedCleanly: true, durationMs: -1, report: null },
            })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its settle.durationMs is -1, which is not a duration`],
        ],
        [
          (dir) =>
            copied(resultIn(dir, 2, 'src/a.ts'), stray(dir, 'a.result.json'), (one) => ({
              ...one,
              settle: { exitedCleanly: true, durationMs: 1, report: [] },
            })),
          (dir) => [`unreadable: ${stray(dir, 'a.result.json')} — its settle.report is a list, which is not a report`],
        ],
        /* And a file no Stryker run was tried against has no run to settle. */
        [
          (dir) =>
            copied(resultIn(dir, 2, 'src/z.ts'), stray(dir, 'z.result.json'), (one) => ({
              ...one,
              settle: { exitedCleanly: true, durationMs: 1, report: null },
            })),
          (dir) => [`unreadable: ${stray(dir, 'z.result.json')} — its settle is an object, and no-mutants is no run to settle`],
        ],
        /* A result whose outcome could only have come from a Stryker run, for a
           file the plan said no run would be tried against — and one that counts
           other mutants than the plan did. */
        [
          (dir) =>
            copied(resultIn(dir, 3, 'src/r.ts'), stray(dir, 'r.result.json'), (one) => ({
              ...one,
              outcome: 'no-mutants',
              exitedCleanly: null,
              mutants: 0,
              report: null,
            })),
          (dir) => [`unreadable: ${stray(dir, 'r.result.json')} — says no-mutants for a file the plan counted as mutated`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/z.ts'), stray(dir, 'z.result.json'), (one) => ({ ...one, mutants: 3 })),
          (dir) => [`unreadable: ${stray(dir, 'z.result.json')} — counts 3 mutant(s) in a file the plan counted 0 in`],
        ],
        [
          (dir) => copied(resultIn(dir, 2, 'src/z.ts'), stray(dir, 'z.result.json'), (one) => ({ ...one, mutants: null })),
          (dir) => [`unreadable: ${stray(dir, 'z.result.json')} — counts null mutant(s) in a file the plan counted 0 in`],
        ],
        [
          (dir) => copied(receiptIn(dir, 1), stray(dir, 'receipt.json'), (one) => ({ ...one, count: 0 })),
          (dir) => [`unreadable: ${stray(dir, 'receipt.json')} — its count is 0, which is not a count of shards`],
        ],
        [
          (dir) => copied(receiptIn(dir, 1), stray(dir, 'receipt.json'), (one) => ({ ...one, subjects: 'src/b.ts' })),
          (dir) => [`unreadable: ${stray(dir, 'receipt.json')} — its subjects is "src/b.ts", which is not a list of paths`],
        ],
        [
          (dir) => copied(receiptIn(dir, 1), stray(dir, 'receipt.json'), (one) => ({ ...one, count: 2 })),
          (dir) => [`unexpected: ${stray(dir, 'receipt.json')} — a receipt for shard 1/2, and the plan has 3 shard(s)`],
        ],
        [(dir) => rmSync(receiptIn(dir, 3)), () => ['missing: shard 3/3 left no receipt — it did not finish']],
        [
          (dir) => copied(receiptIn(dir, 1), stray(dir, 'receipt.json')),
          (dir) => [`duplicated: shard 1/3 left 2 receipts: ${receiptIn(dir, 1)}, ${stray(dir, 'receipt.json')}`],
        ],
        [
          (dir) => copied(receiptIn(dir, 2), receiptIn(dir, 2), (one) => ({ ...one, subjects: ['src/a.ts'] })),
          (dir) => [`unexpected: ${receiptIn(dir, 2)} — shard 2/3 names other files than the plan gave it`, 'missing: shard 2/3 left no receipt — it did not finish'],
        ],
      ]

      for (const [at, [change, lines]] of cases.entries()) {
        const dir = path.join(root, `case-${at}`)
        cpSync(clean, dir, { recursive: true })
        change(dir)

        const result = await aggregateOf(root, manifest, dir)

        expect(result.stderr, String(at)).toBe(reconcileFails(manifest) + lines(dir).map((line) => `  ${line}\n`).join(''))
        expect(result.code).toBe(1)
        expect(result.stdout).not.toContain('every mutant was killed')
        expect(result.stdout).not.toContain('has exactly one result')
      }

      const absent = path.join(root, 'absent')
      const nowhere = await aggregateOf(root, manifest, absent)
      expect(nowhere.code).toBe(2)
      expect(nowhere.stderr).toBe(`check-mutants: ${absent} is not a directory of shard results, so nothing can be reconciled against ${manifest}\n`)
    })
  })

  /* ⚠️ **A RESULT WHOSE REPORT WAS NOT OF THE PLANNED FILE PASSED** (review,
     2026-09-14). The aggregate derived each outcome from the report a result
     carries and never asked whether that report was OF the file the plan
     counted: a subject planned with 100 mutants passed with an empty report or
     with one killed mutant, and a stale report of other source passed under a
     result whose own hash was right. So the report must hold exactly the
     mutants the plan counted — `Ignored` ones left out, as the count leaves
     them out, which a real file measured the same day confirms — and source
     that hashes to the planned content. A report of no file at all is a run
     with no score, and fails as that. */
  /* ⚠️ **AND A COUNT COULD BE MET BY COPIES OF ONE MUTANT** (second review,
     2026-09-14): eight copies of one real killed mutant, for a file planned
     with eight, exited 0 with "every mutant was killed". So the plan records
     each mutant's IDENTITY — mutator, location, replacement, as Stryker's
     instrumenter gives them — and the report must hold exactly that set: none
     missing, none extra, none twice. The first identity that differs is named. */
  it('fails a result whose report does not match the plan — a planned mutant missing, one twice, one unplanned, other source, or no source — by name', async () => {
    await inScratch('mutants-aggregate-', async (root) => {
      const files = planned(root)
      const manifest = await plannedAndSwept(root, { subjects: PASSING, reports: await allKilled(files) })
      const clean = path.join(root, 'results')
      const rewrite = (dir, shard, subject, report, outcome) => {
        const target = resultIn(dir, shard, subject)
        writeFileSync(target, JSON.stringify({ ...readJson(target), outcome, report }))
        return target
      }
      const b = files['src/b.ts']
      const killedAt = (identity) => ({ id: '0', status: 'Killed', static: false, ...identity })
      const stale = { files: { [files['src/a.ts']]: { source: "export const a = 'stale'\n", mutants: [killedAt(literalAt(1))] } } }
      const cases = [
        [
          reportWith(b, [killedAt(literalAt(1))]),
          'killed',
          `it lacks the mutant ${namedLiteralAt(2)}, which the plan counted`,
          ['src/b.ts', 1],
        ],
        [reportWith(b, []), 'nothing-to-kill', `it lacks the mutant ${namedLiteralAt(1)}, which the plan counted`, ['src/b.ts', 1]],
        [
          await plantedReport(b, 'Ignored', 'Ignored'),
          'nothing-to-kill',
          `it lacks the mutant ${namedLiteralAt(1)}, which the plan counted`,
          ['src/b.ts', 1],
        ],
        [
          reportWith(b, [killedAt(literalAt(1)), killedAt(literalAt(1))]),
          'killed',
          `it holds the mutant ${namedLiteralAt(1)} 2 times, and the plan counted it 1`,
          ['src/b.ts', 1],
        ],
        [
          reportWith(b, [killedAt(literalAt(1)), killedAt(literalAt(2)), killedAt(literalAt(3))]),
          'killed',
          `it holds the mutant ${namedLiteralAt(3)}, which the plan did not count`,
          ['src/b.ts', 1],
        ],
        [stale, 'killed', 'its source of src/a.ts is not the content the plan hashed', ['src/a.ts', 2]],
        [reportFor(files['src/a.ts'], 'Killed'), 'killed', 'it carries no source for src/a.ts', ['src/a.ts', 2]],
      ]

      for (const [at, [report, outcome, words, [named, shard]]] of cases.entries()) {
        const dir = path.join(root, `mismatch-${at}`)
        cpSync(clean, dir, { recursive: true })
        const target = rewrite(dir, shard, named, report, outcome)

        const result = await aggregateOf(root, manifest, dir)

        expect(result.stderr, String(at)).toBe(
          reconcileFails(manifest) +
            `  mismatched: ${target} — report does not match the plan: ${words}\n` +
            `  missing: ${named} — no result from shard ${shard}/3 that reconciles with the plan\n`,
        )
        expect(result.code).toBe(1)
        expect(result.stdout).not.toContain('every mutant was killed')
      }
    })
  })
})

/**
 * The jobs of a workflow, each as the lines of its block — read by indentation,
 * as `verify.yml` is written: block style, two spaces a level. Comment lines are
 * dropped first, so the paragraph above one job is not read as the end of the job
 * before it. This repository has no YAML dependency, and a layout this does not
 * know reads as a key that is not there — so the assertion on it fails rather
 * than passing.
 */
function jobsIn(text) {
  const lines = text.split('\n').filter((line) => !/^\s*#/u.test(line))
  const jobs = new Map()
  let job = null
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const header = /^ {2}([\w-]+):\s*$/u.exec(line)
    if (header !== null) jobs.set(header[1], (job = []))
    else if (/^\S/u.test(line)) break
    else if (job !== null) job.push(line)
  }
  return jobs
}

/** The lines nested under `key:` written at `indent` spaces, or none. */
function blockOf(lines, indent, key) {
  const start = lines.indexOf(`${' '.repeat(indent)}${key}:`)
  if (start === -1) return []
  const end = lines.findIndex((line, at) => at > start && line.trim() !== '' && line.search(/\S/u) <= indent)
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

/** The value of `key:` written at `indent` spaces, less a trailing comment; `undefined` when it is not there. */
function valueAt(lines, indent, key) {
  const pattern = new RegExp(`^ {${indent}}${key}:\\s*(.*?)(?:\\s+#.*)?$`, 'u')
  for (const line of lines) {
    const found = pattern.exec(line)
    if (found !== null) return found[1]
  }
  return undefined
}

/** A job's steps, each as its lines, with the leading `- ` read as the indent it stands for. */
function stepsOf(job) {
  const steps = []
  for (const line of blockOf(job, 4, 'steps')) {
    if (/^ {6}- /u.test(line)) steps.push([line.replace(/^ {6}- /u, ' '.repeat(8))])
    else if (steps.length > 0) steps[steps.length - 1].push(line)
  }
  return steps
}

/**
 * ⚠️ **THE WORKFLOW IS HALF THIS GATE, AND NOTHING READ IT.** Every guarantee
 * above — a frozen plan, a receipt per shard, one result per file, an aggregate
 * that alone can pass — holds only if CI runs the three modes in the shape they
 * assume: shards as separate checkouts that cannot cancel one another, results
 * uploaded whether or not a shard failed, an aggregate that runs whatever the
 * shards did, and a bound no shard's slowest file can outrun. Each is read back
 * from `verify.yml` here (acceptance criteria d–g, 2026-09-14).
 */
describe('the workflow sweeps in isolated shards of one frozen plan, reconciled by an aggregate', () => {
  const jobs = jobsIn(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'))
  const job = (name) => {
    const found = jobs.get(name)
    expect(found, `a job named ${name}`).toBeDefined()
    return found
  }
  const running = (steps, command) => steps.filter((step) => step.join('\n').includes(command))
  const using = (steps, action) => steps.filter((step) => valueAt(step, 8, 'uses') === action)
  const SWEEPS = 'node scripts/check-mutants.mjs --shard '

  it('plans once, against the pull request’s base and refusing without one, and hands the shards their count', () => {
    const plan = job('mutants-plan')
    expect(valueAt(plan, 4, 'if')).toBe("github.event_name == 'pull_request'")
    const steps = stepsOf(plan)
    expect(using(steps, 'actions/checkout@v4').map((step) => valueAt(step, 10, 'fetch-depth'))).toEqual(['0'])
    const [planning] = running(steps, 'node scripts/check-mutants.mjs --plan mutants-plan/plan.json')
    expect(planning, 'a step that plans').toBeDefined()
    const text = planning.join('\n')
    expect(text).toContain('--shards "$SHARDS" --isolate "$ISOLATE" --base "origin/$BASE_REF" --require-base')
    expect(valueAt(planning, 8, 'id')).toBe('plan')
    expect(valueAt(planning, 10, 'BASE_REF')).toBe('${{ github.base_ref }}')
    expect(text).toContain('echo "count=$SHARDS" >> "$GITHUB_OUTPUT"')
    expect(text).toContain('echo "shards=[$(seq -s, 1 "$SHARDS")]" >> "$GITHUB_OUTPUT"')
    const outputs = blockOf(plan, 4, 'outputs')
    expect(valueAt(outputs, 6, 'count')).toBe('${{ steps.plan.outputs.count }}')
    expect(valueAt(outputs, 6, 'shards')).toBe('${{ steps.plan.outputs.shards }}')
    const uploads = using(steps, 'actions/upload-artifact@v4')
    expect(uploads.map((step) => [valueAt(step, 10, 'name'), valueAt(step, 10, 'path'), valueAt(step, 10, 'if-no-files-found')])).toEqual([
      ['mutants-plan', 'mutants-plan/plan.json', 'error'],
    ])
  })

  it('sweeps each shard as a matrix job of its own checkout, from the plan it downloads, and lets no shard cancel another', () => {
    const shard = job('mutants-shard')
    expect(valueAt(shard, 4, 'needs')).toBe('mutants-plan')
    const strategy = blockOf(shard, 4, 'strategy')
    expect(valueAt(strategy, 6, 'fail-fast')).toBe('false')
    expect(valueAt(blockOf(strategy, 6, 'matrix'), 8, 'shard')).toBe('${{ fromJSON(needs.mutants-plan.outputs.shards) }}')
    const steps = stepsOf(shard)
    expect(using(steps, 'actions/checkout@v4').map((step) => valueAt(step, 10, 'fetch-depth'))).toEqual(['0'])
    expect(using(steps, 'actions/download-artifact@v4').map((step) => [valueAt(step, 10, 'name'), valueAt(step, 10, 'path')])).toEqual([
      ['mutants-plan', 'mutants-plan'],
    ])
    const sweeps = running(steps, SWEEPS)
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].join('\n')).toContain('--shard "$SHARD" --manifest mutants-plan/plan.json --results mutants-results')
    expect(valueAt(sweeps[0], 10, 'SHARD')).toBe('${{ matrix.shard }}/${{ needs.mutants-plan.outputs.count }}')
    /* Only the matrix job sweeps, so no two sweeps ever share a checkout — and
       the one-sweep-per-checkout lock is never what keeps them apart. */
    for (const [name, lines] of jobs) {
      if (name !== 'mutants-shard') expect(lines.join('\n'), name).not.toContain('check-mutants.mjs --shard ')
    }
  })

  it('uploads a shard’s results whether or not its sweep passed, and bounds the sweep inside the job so the upload still runs', () => {
    const shard = job('mutants-shard')
    const steps = stepsOf(shard)
    const sweepAt = steps.findIndex((step) => step.join('\n').includes(SWEEPS))
    const uploads = steps.flatMap((step, at) => (valueAt(step, 8, 'uses') === 'actions/upload-artifact@v4' ? [[step, at]] : []))

    expect(sweepAt).toBeGreaterThan(-1)
    expect(uploads).toHaveLength(1)
    const [[upload, uploadAt]] = uploads
    expect(uploadAt).toBeGreaterThan(sweepAt)
    expect({
      if: valueAt(upload, 8, 'if'),
      name: valueAt(upload, 10, 'name'),
      path: valueAt(upload, 10, 'path'),
      'if-no-files-found': valueAt(upload, 10, 'if-no-files-found'),
    }).toEqual({ if: 'always()', name: 'mutants-shard-${{ matrix.shard }}', path: 'mutants-results/', 'if-no-files-found': 'error' })
    expect(Number(valueAt(steps[sweepAt], 8, 'timeout-minutes'))).toBeLessThan(Number(valueAt(shard, 4, 'timeout-minutes')))
  })

  it('reconciles in one job that runs whatever the shards did, and no other job can pass the sweep', () => {
    const aggregate = job('mutants')
    expect(valueAt(aggregate, 4, 'needs')).toBe('[mutants-plan, mutants-shard]')
    expect(valueAt(aggregate, 4, 'if')).toBe("always() && github.event_name == 'pull_request'")
    expect(aggregate.join('\n')).not.toContain('continue-on-error')
    const steps = stepsOf(aggregate)
    expect(
      using(steps, 'actions/download-artifact@v4').map((step) => [valueAt(step, 10, 'name'), valueAt(step, 10, 'pattern'), valueAt(step, 10, 'path')]),
    ).toEqual([
      ['mutants-plan', undefined, 'mutants-plan'],
      [undefined, 'mutants-shard-*', 'mutants-results'],
    ])
    expect(running(steps, 'node scripts/check-mutants.mjs --aggregate --manifest mutants-plan/plan.json --results mutants-results')).toHaveLength(1)
    for (const [name, lines] of jobs) {
      if (name !== 'mutants') expect(lines.join('\n'), name).not.toContain('--aggregate')
      /* The single job that swept everything on one runner is gone, not kept beside the shards. */
      expect(lines.join('\n'), name).not.toMatch(/check-mutants\.mjs --base/u)
    }
  })

  /* (g) The slowest file measured, scaled from the 9 Stryker runners it had to
     the 4 vCPUs an ubuntu-24.04 runner gives a shard, with a margin of two for a
     slower core and a runner count Stryker may set one lower.
   *
   * ⚠️ **AND THE SLOWEST FILE IS THIS GATE, WHICH THE CHANGE THAT SHARDED IT
   * GREW.** 18 min 5 s was measured when Stryker's own instrumenter counted
   * 1 174 mutants in `check-mutants.mjs`; after that change and the three
   * rounds of review fixes that followed it counts 2 941. Scaling the time by the count is an
   * ESTIMATE — the new mutants sit in code the slowest tests here drive — and is
   * replaced by the first measured `durationMs` for that file, not trusted past
   * it.
   *
   * ⚠️ **AND THE SETTLE RUN HAS MADE BOTH HALVES OF THAT ARITHMETIC LOW, SO THE
   * BOUND BELOW IS KNOWN TO BE AN UNDER-ESTIMATE AND NOT A MEASUREMENT**
   * (2026-09-15). The count is 3 139 here now, measured with the instrumenter;
   * and a file with a wall-clock timeout is swept TWICE, the second time alone —
   * see `SETTLE_RUN`, which states the worst case. This file has 586 wall-clock
   * timeouts of its own under load, so it settles on any loaded sweep. Neither
   * number is raised here, because raising one without the other buys a green
   * assertion over a bound nobody has measured: what replaces both is the first
   * shard's own `durationMs` from a 4-vCPU CI run, and the workflow's step and
   * job bounds re-derived from it. Until then a shard that overruns ENDS AT ITS
   * STEP TIMEOUT, which leaves no receipt, which the aggregate refuses — red,
   * never green. */
  it('bounds a shard by the slowest file measured, scaled to the runner with a margin, and gives the heaviest files shards of their own', () => {
    const MEASURED_MINUTES = 18 + 5 / 60
    const COUNTED_WHEN_MEASURED = 1174
    const COUNTED_NOW = 2941
    const LOCAL_RUNNERS = 9
    const CI_VCPUS = 4
    const MARGIN = 2
    const sized = Math.ceil(((MEASURED_MINUTES * (COUNTED_NOW / COUNTED_WHEN_MEASURED) * LOCAL_RUNNERS) / CI_VCPUS) * MARGIN)
    const shard = job('mutants-shard')
    const [sweep] = running(stepsOf(shard), SWEEPS)

    expect(valueAt(shard, 4, 'runs-on')).toBe('ubuntu-24.04')
    expect(Number(valueAt(sweep, 8, 'timeout-minutes'))).toBeGreaterThanOrEqual(sized)
    const env = blockOf(job('mutants-plan'), 4, 'env')
    const [shards, isolate] = [Number(valueAt(env, 6, 'SHARDS')), Number(valueAt(env, 6, 'ISOLATE'))]
    expect(isolate).toBeGreaterThanOrEqual(1)
    expect(shards).toBeGreaterThan(isolate)
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
