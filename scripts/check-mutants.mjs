import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { loadConfigFromFile } from 'vite'
import { configDefaults } from 'vitest/config'
import { isProcessEntry } from './lib/entry.mjs'
import { runtimeSpecifiers } from './lib/specifiers.mjs'

/**
 * `pnpm mutants` — a test that cannot fail is a red gate.
 *
 * ## What this exists for, precisely
 *
 * ⚠️ **EVERY OTHER GATE HERE MEASURES HOW MUCH CODE RAN. NONE OF THEM ASKS
 * WHETHER A TEST WOULD NOTICE IF THE CODE WERE WRONG.** Coverage says a line
 * executed. `test:ledger` says a test still exists. Both are satisfied by an
 * assertion that holds whatever the code does — and this repository has now
 * produced six of those in one branch, each found only by planting the defect
 * back by hand and watching:
 *
 *   - a race test that RELEASED two threads and hoped they would interleave;
 *   - an unsubscribe test that needed the same listener in two sets to tell the
 *     bug apart, and did not have it;
 *   - a "covers the window" test asserting only that a class name existed;
 *   - a "refused without verifying" test built on a VALID signature, so it read
 *     the same whether verification ran first or not;
 *   - a frame-cap test that tried `MAX + 1` and never the cap itself;
 *   - a phrase test that swapped the whole component instead of one identity.
 *
 * Two of the SHIPPED defects on the same branch were the identical mistake in
 * production: a `RosterTie` branch asking the same question as the line above
 * it, and a "whitelist" that only refused values which were already strings. So
 * this is not a testing habit — it is a reasoning habit, and the reason it is
 * worth a gate is that it is invisible to review. A green non-discriminating
 * test looks exactly like a green discriminating one.
 *
 * Mutation testing is that check, mechanised: break the code on purpose, and
 * report every break no test objected to.
 *
 * ## Scoped to the diff, and why that is the whole design
 *
 * ⚠️ **MUTATING THE WHOLE TREE IS NOT AFFORDABLE AND WOULD BE ROUTED AROUND.**
 * Measured on this machine: one 217-line module is ~17s once the run is scoped;
 * the same run against the repository's own vitest config took **8m26s and did
 * not finish**, because Stryker's dry run executes the entire suite before it
 * mutates anything. A gate nobody can afford to run is a gate nobody runs.
 *
 * So this mutates only what the branch changed, and runs only the tests that
 * import those files. Both narrowings are what make the cost proportional to
 * the change rather than to the repository.
 *
 * ## One file at a time, because batching MEASURES WRONG
 *
 * ⚠️ **THE BATCHED RUN DID NOT MERELY TAKE LONGER — IT REPORTED FALSE
 * NUMBERS.** Measured on this branch: `store.ts` mutated ALONE against its own
 * test file gives 85 killed, 43 survived, 1 uncovered in 20s. The identical
 * file inside a 38-file run reports **129 uncovered and 0 survived** — Stryker's
 * per-test coverage attribution collapses across 109 test files spanning two
 * environments (every jsdom file here declares its own with a pragma, so one
 * run is not one pool). `foreign.ts` likewise scored 87.5% alone and showed 56
 * uncovered in the batch.
 *
 * A slow gate is an annoyance. A gate that reports "no test covers this" about
 * code with forty-five passing tests is worse than no gate: it trains a reader
 * to disbelieve it, and the first real finding then reads as more noise. So
 * each subject is mutated in its own run, against only its own covering tests.
 * The cost is linear in the size of the diff — which is the property that makes
 * it affordable for the change somebody is actually making.
 *
 * ## Why a survivor fails rather than a score
 *
 * ⚠️ **NO THRESHOLD, BECAUSE A THRESHOLD IS A NUMBER SOMEBODY LOWERS.** The
 * sample that motivated this had SIX survivors and zero equivalent mutants —
 * every one was a real gap. Scoped to a diff the count is small enough to
 * triage, which is what makes "none may survive" honest rather than punitive.
 *
 * The escape hatch is Stryker's own `// Stryker disable next-line <mutator>:
 * <reason>` — written beside the code, in words, the way every other decision
 * in this repository is recorded. That is deliberately more effort than a
 * number in a config file.
 *
 * ## Whole files, and why not only the changed lines
 *
 * ⚠️ **A CHANGE'S EFFECT LANDS ON LINES IT DID NOT TOUCH** (decided 2026-09-14,
 * after an independent review). Mutating only the lines a branch changed was
 * proposed and rejected on exactly that: a guard that changed makes an untouched
 * branch beneath it reachable, and a value that changed makes an untouched
 * reader of it wrong — and those untouched lines are what the change must still
 * be tested through. So every changed file is mutated whole, and none of its
 * mutants may survive. What that costs is why a sweep can be sharded — see
 * `planSweep`.
 */

/**
 * A path under `src` or `scripts` that could be mutated.
 *
 * ⚠️ **`.` STOPS AT A LINE FEED, AND A NAME THAT CARRIES ONE THEN VANISHED
 * SILENTLY.** Reading git NUL-delimited was half the fix — it delivers
 * `src/we<LF>ird.ts` whole rather than quoting it — and this pattern then
 * rejected it as not source, so it dropped out of the subject list without a
 * word, which is worse than the quoted form that at least matched nothing at
 * all. A line feed is a legal character in a file name on every filesystem
 * here. `s` makes `.` mean any character, which is what this always meant.
 */
const SRC = /^(src|scripts)\/.+\.(ts|tsx|mjs)$/su
const NOT_A_SUBJECT = /\.(test|testkit|contract\.test)\.(ts|tsx|mjs)$|\.d\.ts$/u

/**
 * The branch's own changes: committed since the base, plus what is uncommitted.
 *
 * `requireBase` turns an unresolvable base into a REFUSAL instead of a smaller
 * scope — see the note at the fallback below.
 *
 * `root` is the checkout asked — this process's own working directory when it is
 * left out, which is what a real sweep wants. ⚠️ **IT WAS NOT ASKED AT ALL, SO
 * EVERY TEST OF THIS READ WHATEVER REPOSITORY THE RUNNER WAS STANDING IN** —
 * inside a sweep that is Stryker's sandbox, where git answers for the enclosing
 * checkout and lists nothing under an ignored directory. Every assertion over the
 * answer held whatever this did, which is the shape the header calls a poor joke
 * to ship; and the one test that did reach a repository of its own reached it
 * through a CHILD process, which carries no mutant and so could object to none
 * (2026-09-14).
 */
export function changedFiles(base = 'main', requireBase = false, root = process.cwd()) {
  const from = mergeBaseOf(base, requireBase, root)
  /* ⚠️ **STAGED WORK WAS INVISIBLE WHEN THERE WAS NO BASE.** `git diff` with no
     commit compares the working tree with the INDEX, so a change that had been
     `git add`ed was in neither that list nor the untracked one — a file created
     and staged vanished from the scope, which came back `[]` in a scratch
     repository on 2026-09-13. With a base, the first list holds staged work
     already; `--cached` is what the fallback was missing. */
  const names = new Set([
    ...sinceBase(from, root),
    ...gitNames(['diff', '--name-only', '-z', '--'], root),
    ...gitNames(['diff', '--cached', '--name-only', '-z', '--'], root),
    ...gitNames(['ls-files', '-z', '--others', '--exclude-standard'], root),
  ])
  return [...names].filter((f) => SRC.test(f) && !NOT_A_SUBJECT.test(f) && existsSync(path.join(root, f)))
}

/** What `git diff` names as committed since `from` in the checkout at `root`, and nothing where there is no base to compare with. */
function sinceBase(from, root) {
  // Stryker disable next-line ArrayDeclaration: a name added here is not a path under `src` or `scripts`, so `changedFiles`' own filter drops it and no answer can differ
  if (from === null) return []
  return gitNames(['diff', '--name-only', '-z', from, '--'], root)
}

/**
 * The merge base of HEAD with `base` in the repository at `cwd` — the one this
 * process runs in when it is left out — or `null` when there is none.
 */
function mergeBaseOf(base, requireBase, cwd) {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', base], { encoding: 'utf8', cwd }).trim()
  } catch {
    /* No such base — a detached checkout, or a clone with one branch. Falling
       back to the working tree alone is the honest answer LOCALLY: it is a
       smaller scope, never a wrong one.
     *
     * ⚠️ **AND IT IS A VACUOUS PASS IN CI, WHICH IS WHY `requireBase` EXISTS.**
     * A CI checkout is shallow and has everything committed, so a failed
     * `merge-base` leaves the working tree as the whole scope — and the working
     * tree is clean there. Zero subjects, "nothing changed to mutate", exit 0:
     * a gate that scanned nothing, reporting success, on every pull request.
     * That is the one failure shape this repository refuses everywhere else, so
     * the caller that depends on the base says so and is refused rather than
     * narrowed. */
    if (requireBase) {
      throw new Error(
        `check-mutants: cannot resolve a merge base with ${JSON.stringify(base)}, so there is nothing to compare ` +
          'against and a run here would mutate nothing while reporting success. Fetch the base branch ' +
          '(`fetch-depth: 0`, or `git fetch origin ' +
          base +
          '`) and try again.',
      )
    }
    return null
  }
}

/**
 * The commits a sweep is planned at: HEAD, and its merge base with `base`, in
 * the repository at `cwd`.
 *
 * ⚠️ **A SHARD'S SCOPE IS A FUNCTION OF BOTH, AND NEITHER IS FIXED BETWEEN
 * JOBS.** Each shard is a checkout of its own, made minutes after its plan; a
 * HEAD commit or a merge base that is not the plan's gives it another change to
 * sweep under the plan's name. So the plan records both, and a shard refuses a
 * checkout at any other — see `shardSweep`.
 *
 * ⚠️ **THE BASE BRANCH'S TIP IS NOT RECORDED, DELIBERATELY** (decided
 * 2026-09-14). Every subject derives from the merge base, so a target branch
 * that takes an unrelated commit mid-run changes nothing a shard sweeps — and
 * refusing it would fail CI for no defect. A tip that moves while the merge base
 * stays put proceeds.
 */
export function commitsOf(base, requireBase, cwd) {
  let head
  try {
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      cwd,
      /* Given at all, so `execFileSync` does not ALSO write git's stderr to this
         process's own — it inherits it whenever `stdio` is left out — while the
         refusal below still carries git's reason, which it reads from the pipe. */
      // Stryker disable next-line ArrayDeclaration: a short array is padded with pipes, so an empty one differs only in the child's stdin, which `git rev-parse` never reads
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (cause) {
    throw new Error(
      `check-mutants: ${cwd ?? process.cwd()} has no HEAD commit, so there is nothing to plan a sweep against — ${messageOf(cause).trim()}`,
    )
  }
  return { head, mergeBase: mergeBaseOf(base, requireBase, cwd) }
}

/**
 * The working tree at `root` against HEAD, as `{ path: digest }`: every path
 * `git diff HEAD` names — staged or not, renames as both of their paths, `null`
 * where the file is gone — and every untracked file `.gitignore` does not cover.
 * Each digest is taken over the path's kind, its executable bit and its bytes; a
 * link's over its own target, never what it points at.
 *
 * ⚠️ **A LOCAL SHARD COULD SWEEP UNCOMMITTED WORK ITS PLAN NEVER SAW** (review,
 * 2026-09-14). HEAD and each subject's own inputs were compared and nothing
 * else, so a testkit a test imports, a config file, or a test left out of the run
 * could change between plan and shard unnoticed. In CI, HEAD covers all of it —
 * every job checks out one commit — but a local run sweeps uncommitted work. The
 * inputs are NOT listed, because a list always misses one: the whole tree is
 * recorded, path by path so that a refusal can name where it differs. What
 * `.gitignore` covers — generated names, `dev-docs/`, `node_modules` — is not in
 * it, and so is never compared.
 */
export function worktreeOf(root) {
  const names = new Set([
    ...gitNames(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], root),
    ...gitNames(['ls-files', '-z', '--others', '--exclude-standard'], root),
  ])
  return Object.fromEntries([...names].sort(byName).map((name) => [name, entryDigestOf(path.join(root, name))]))
}

/**
 * The files git tracks at or under `dir` — relative to `root`, `''` for all of
 * it — in the repository at `root`. `caseless` asks git to match the name
 * without case, as a filesystem that ignores it would.
 */
export function trackedUnder(root, dir, caseless = false) {
  /* ⚠️ **A PATH WENT TO GIT AS A PATTERN** (fifth review, 2026-09-14): a pathspec
     reads `*` and `?` as wildcards, so an output directory named `src*` was
     refused as tracked on the strength of `src-tauri/.gitignore`. `:(literal)`
     asks git for the name itself.

     ⚠️ **AND `''` HAD A PATHSPEC OF ITS OWN, `'.'`, WHICH ANSWERED THE SAME
     THING** (2026-09-14). A BARE empty pathspec is what git refuses — "empty
     string is not a valid pathspec" — and one behind magic is not bare: measured
     against git 2.50.1, `:(literal)` and `:(icase,literal)` each list everything
     tracked under the working directory, exactly as `.` does, from the root and
     from a subdirectory alike. So the branch decided nothing, and no test could
     tell it from its absence. */
  return gitNames(['ls-files', '-z', '--', `:(${caseless ? 'icase,literal' : 'literal'})${dir}`], root)
}

/**
 * `file`'s real path: the deepest ancestor that EXISTS resolved by the operating
 * system's own `realpath`, with whatever does not exist yet joined back on.
 *
 * ⚠️ **`..` IS REFUSED RATHER THAN RESOLVED** (fourth review, 2026-09-14).
 * Collapsing it here is not what the filesystem does: `path.resolve` removes
 * `link/..` textually, so `node_modules/../package.json` was checked as one place
 * and written in another, the one the link's target sits in. A path this gate
 * writes to, or reads a plan from, must say plainly where it goes.
 */
function realPathOf(file) {
  noDots(file)
  const absolute = path.resolve(file)
  for (const existing of ancestorsOf(absolute)) {
    try {
      return path.join(realpathSync.native(existing), path.relative(existing, absolute))
    } catch (cause) {
      if (codeOf(cause) !== 'ENOENT' && codeOf(cause) !== 'ENOTDIR') throw cause
    }
  }
  /* Not even the root resolved — a drive letter that is not there, which is
     Windows' own answer and no POSIX path's, since `/` always resolves. So the
     path is whatever it was given as. */
  return absolute
}

/**
 * `absolute` and every directory above it, DEEPEST FIRST and ending at its root
 * — the order a search for what exists asks in. Answers `[root]` for the root
 * itself, and takes a path as `path.resolve` answers one.
 *
 * ⚠️ **THE CHAIN IS BUILT FROM THE PARTS, NOT CLIMBED UNTIL A GUARD SAYS STOP**
 * (2026-09-16). `dirname` answers a path its own self at the root, so a climb
 * ends on `parent === existing` — a comparison that on POSIX is reached only if
 * `realpath('/')` fails, which it does not, and whose mutant therefore does not
 * answer differently but fails to TERMINATE. Counted off the parts, the end of
 * the chain is the end of a list.
 */
export function ancestorsOf(absolute) {
  const { root } = path.parse(absolute)
  /* `path.relative` answers `''` at the root, which is no part at all. */
  const parts = path.relative(root, absolute).split(path.sep).filter((one) => one !== '')
  const chain = [root]
  for (const part of parts) chain.unshift(path.join(chain[0], part))
  return chain
}

/** Refuses a path with a `..` in it, naming the path as it was given — see `realPathOf`. */
function noDots(file) {
  if (!file.split(/[\\/]/u).includes('..')) return
  throw new Refusal(
    `check-mutants: ${file} has a ".." in it, and a path this gate writes to or reads a plan from must say plainly where it goes — pass one without`,
  )
}

/**
 * Whether the filesystem holding `dir` ignores case — ASKED OF THE CHECKOUT, by
 * looking one of its own directories up under another case, rather than assumed
 * from the platform. On a filesystem that ignores case, `SRC` is `src` while git
 * lists nothing tracked under `SRC`: see `overlapOf`.
 *
 * The last part of `dir` is asked first, and a part with no case at all — a
 * directory named in digits — is climbed past to the one above it: see
 * `caseSwaps`, which decides which parts are asked about at all. Where nothing
 * can be looked at the answer is no, and that is the safe way round: reading a
 * case-SENSITIVE checkout as caseless would fold two different paths into one.
 */
export function caselessAt(dir) {
  for (const swapped of caseSwaps(dir.split(path.sep))) {
    try {
      const [here, there] = [statSync(dir), statSync(swapped.join(path.sep))]
      return (
        here.ino === there.ino &&
        // Stryker disable next-line ConditionalExpression: only two separate mounts at these two names answer with different devices, and a test may not mount anything
        here.dev === there.dev
      )
    } catch (cause) {
      if (codeOf(cause) === 'ENOENT' || codeOf(cause) === 'ENOTDIR') return false
      throw cause
    }
  }
  return false
}

/**
 * Each way ONE part of a path can be spelt in another case, deepest part first
 * and as parts again — the other name to ask a filesystem about. A part with no
 * case at all has no other spelling and is not offered, so the part above it is
 * what `caselessAt` asks about instead.
 *
 * ⚠️ **THE FIRST PART IS NEVER SWAPPED, AND IT IS LEFT OUT RATHER THAN COUNTED
 * PAST** (2026-09-16). On an absolute path that part is the root: empty on
 * POSIX, and a DRIVE LETTER on Windows, whose case Windows ignores whatever the
 * filesystem under it keeps — so offering it would answer yes for every Windows
 * path, over the deepest part's own answer. Written as `[first, ...rest]`
 * because as an index the loop stopped one short of, nothing could observe it:
 * on POSIX the first part of an absolute path is empty, so it has no swap
 * either, and the bound decided the same thing the swap already had.
 */
export function caseSwaps([first, ...rest]) {
  const swaps = []
  for (const [at, part] of rest.entries()) {
    const swapped = [...part].map((one) => (one === one.toLowerCase() ? one.toUpperCase() : one.toLowerCase())).join('')
    /* Deepest first: the part nearest the file is the one whose filesystem is
       being asked about, and the ones above it are only what to fall back on. */
    if (swapped !== part) swaps.unshift([first, ...rest.slice(0, at), swapped, ...rest.slice(at + 1)])
  }
  return swaps
}

/** Every path a plan fingerprints: its subjects, their covering tests and the ones left out, and every path in its working tree. */
function fingerprinted(subjects, worktree) {
  return [
    ...new Set([...subjects.flatMap((subject) => [subject.path, ...subject.tests, ...subject.leftOut]), ...Object.keys(worktree)]),
  ].sort(byName)
}

/**
 * A path relative to the checkout as this gate records, prints and compares one:
 * separated by `/` on every platform, which is how git names a path and how a
 * plan written on any runner must spell it.
 *
 * ⚠️ **`path.relative`, `path.resolve` AND `readlink` ANSWER IN THE HOST'S
 * SEPARATOR, AND WINDOWS' IS `\`** (measured 2026-09-15 on Windows 11). A plan
 * recorded `src\a.test.mjs` beside git's `src/a.ts`, so the overlap refusal
 * matched the wrong input, a link's digest held `..\z.ts`, and a module reached
 * through its importer was named `src\kernel\ui\pane\Settings.tsx`. On macOS and
 * Linux the two spellings are one string, which is how every one of them passed
 * there. Absolute paths stay the host's own: they are read, never recorded.
 */
function slashed(relative) {
  return relative.split(path.sep).join('/')
}

/**
 * How two paths inside one checkout are compared, and how one is asked whether it
 * holds the other: `fold` drops the case where the checkout's own filesystem
 * does, `within` answers whether `inner` IS `outer` or sits under it, and `''`
 * as `outer` is the checkout itself, which holds everything.
 *
 * ⚠️ **TWO COPIES OF THIS DECIDED TWO DIFFERENT REFUSALS**, and the half that
 * runs where a filesystem KEEPS case could be reached on neither, because the
 * machine the sweep is written on ignores it (2026-09-14). One copy, asked
 * directly with each answer, is a comparison a test can hold on any machine.
 */
export function pathsAt(caseless) {
  const fold = (one) => (caseless ? one.toLowerCase() : one)
  const same = (one, other) => fold(one) === fold(other)
  return {
    fold,
    within: (inner, outer) => outer === '' || same(inner, outer) || same(inner.slice(0, outer.length + 1), `${outer}/`),
  }
}

/**
 * Why a path the sharded modes WRITE to, or read a plan from, may not be where
 * it is — it overlaps an input the plan fingerprints, or git tracks something
 * there — or `null` when it may.
 *
 * ⚠️ **A SHARD LEAVES BOTH ITS MANIFEST AND ITS RESULTS OUT OF DRIFT DETECTION**,
 * so an input at either path could change unseen — `--results src` hid a changed
 * testkit, and `--plan` over a tracked JSON fixture replaced one outright (second
 * and third reviews, 2026-09-14).
 *
 * ⚠️ **AND THE CHECK WAS LEXICAL, WHICH TWO ALIASES WALKED PAST** (third review):
 * a path through a symbolic link to the checkout read as outside it, and where
 * the filesystem ignores case `SRC` is `src` while git tracks nothing under
 * `SRC`. Both sides are real paths here, and the comparison drops case exactly
 * where the checkout's own filesystem does.
 */
function overlapOf(given, { root, inputs, tracked }) {
  /* Named as it was given, before any part of it is resolved. */
  noDots(given)
  const top = realPathOf(root)
  const caseless = caselessAt(top)
  /* ⚠️ **THE FOLDING CAME AFTER THE DECISION TO LOOK AT ALL** (fourth review,
   * 2026-09-14): where the filesystem ignores case, the CHECKOUT'S OWN name in
   * another case made `path.relative` answer with `..`, the path read as one
   * outside the checkout, and nothing was compared. Both sides are folded before
   * that decision now.
   *
   * ⚠️ **AND A LINK IS TWO PLACES.** A tracked link out of the tree resolves to
   * somewhere outside it while the name git tracks is inside — so both the path
   * AS WRITTEN and the path it resolves to are checked, and either being an input
   * or tracked is a refusal. */
  const { fold, within } = pathsAt(caseless)
  /* The path as written — its directories resolved, so that `/var` and
     `/private/var` are one place, but its own last part left as it is, which is
     where a tracked link lives — and the path it finally resolves to. */
  const asWritten = path.join(realPathOf(path.dirname(given)), path.basename(given))
  const names = [asWritten, realPathOf(given)]
    .map((one) => path.relative(fold(top), fold(one)))
    .filter((at) => !outsideCheckout(at))
    .map(slashed)
  for (const name of [...new Set(names)]) {
    const input = inputs.find((one) => within(one, name) || within(name, one))
    if (input !== undefined) return { input }
    let held
    try {
      held = tracked(root, name, caseless)
    } catch (cause) {
      throw new Refusal(`check-mutants: cannot ask git what it tracks in ${given} — ${messageOf(cause)}`)
    }
    if (held.length > 0) return { held: held[0] }
  }
  return null
}

/**
 * What is at `file`, without following a link, or `null` when nothing is there.
 *
 * ⚠️ **ABSENT AND UNREADABLE ARE TWO ANSWERS, AND TWO PLACES SPELT THEM THE SAME
 * WAY** (2026-09-16). Anything but `ENOENT` is a failure to LOOK rather than an
 * absence — a directory this user may not open answers `EACCES` — and a gate
 * that read that as "nothing is there" would digest a plan around a file it
 * never saw, or write over one it was told it could not read. Thrown as it came,
 * in one place, so one test holds both callers to it.
 */
export function entryAt(file) {
  try {
    return lstatSync(file)
  } catch (cause) {
    if (codeOf(cause) !== 'ENOENT') throw cause
    return null
  }
}

/** A path's kind, executable bit and bytes as one digest, or `null` when nothing is there. */
function entryDigestOf(file) {
  const stat = entryAt(file)
  if (stat === null) return null
  if (stat.isSymbolicLink()) return digestOf(`link\0${slashed(readlinkSync(file))}`)
  if (!stat.isFile()) return digestOf('not a file\0')
  return createHash('sha256')
    .update(`file\0${(stat.mode & 0o111) === 0 ? '-' : 'x'}\0`)
    .update(readFileSync(file))
    .digest('hex')
}

/**
 * The paths a git listing prints, read NUL-delimited.
 *
 * ⚠️ **SPLIT ON NEWLINES, A NAME OUTSIDE PRINTABLE ASCII VANISHED.** Without
 * `-z` git QUOTES such a path — `src/café.ts` arrives as
 * `"src/caf\303\251.ts"` — and the quoted form matches neither `SRC` nor a file
 * on disk, so it was filtered out as though it did not exist. Measured
 * 2026-09-13 in a scratch repository. With `-z` a path arrives as written,
 * tabs and newlines included.
 *
 * `cwd` is the repository asked; left out, the one this process runs in.
 */
function gitNames(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).split('\0').filter(Boolean)
}

/**
 * Vite's `resolve.extensions` default, in its order — which is the order this
 * project resolves in, because neither `vite.config.ts` nor `vitest.config.ts`
 * overrides it.
 *
 * ⚠️ **THE ORDER WAS `.ts, .tsx, .mjs`, AND IT IS THE OTHER WAY ROUND.**
 * MEASURED 2026-09-13 by planting both files and asking a vitest run which one
 * it had loaded: `./which` beside a `which.mjs` and a `which.ts` gave `mjs`,
 * `./two` gave `js` over `ts`, `./dir` gave `dir/index.mjs` over
 * `dir/index.ts`. Read back from vite 7.1's own `DEFAULT_EXTENSIONS`, which
 * says the same. So where two files answered one specifier this gate mutated
 * the one the tests do NOT load, against tests that could not object to it.
 */
const EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']

/** Tried after the specifier as written, in order: a file before a directory,
 *  which is how every resolver this tree is built with reads one.
 *
 *  ⚠️ **IN THE HOST'S SEPARATOR, BECAUSE WHAT IT IS APPENDED TO IS `path.resolve`'s.**
 *  A `/index.ts` on a Windows path named a file that exists — so the import was
 *  found — as `…\bar/index.ts`, which is not the string `path.resolve` gives
 *  for that file, and no test covered a directory's index there: `resolves a
 *  directory import to its index` failed on every Windows run (2026-09-15). */
const RESOLVED_AS = ['', ...EXTENSIONS, ...EXTENSIONS.map((extension) => `${path.sep}index${extension}`)]

/**
 * The files a module imports — relative specifiers only, each resolved to the
 * one file that answers it.
 *
 * ⚠️ **THIS WAS `from\s+'(\.[^']+)'`, AND TEN TESTS IMPORTED A MODULE IT COULD
 * NOT SEE THEM IMPORT.** A test that mocks first and loads its subject after —
 * `await import('./lock')` in `node/lock.test.ts`, `await import('./index')` in
 * `webhost/index.test.ts` and `public/receive.test.ts` — has no `from` for that
 * subject at all, so none of them counted as covering the module it exists
 * for. Double quotes and a bare `import './x'` went the same way, while a
 * `from '…'` inside a comment or a string counted. Measured 2026-09-13 across
 * every test in the tree. Parsed now, which also leaves out `import type`, a
 * clause that runs nothing a mutant could change.
 *
 * ⚠️ **AND EVERY CANDIDATE COUNTED AS RESOLVED.** `./foo` was attributed to
 * `foo.ts` and to `foo/index.ts` at once, and a directory's `index.tsx` or
 * `index.mjs` was never tried. The first file that exists is the answer.
 *
 * The reading itself is `runtimeSpecifiers`, shared with `check-browser-safe`
 * since 2026-09-14: this gate had fixed two clauses in its own copy and written
 * down that the other copy still misread both. See `lib/specifiers.mjs`.
 */
export function importsOf(file) {
  const found = new Set()
  for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'), file)) {
    const target = resolveRelative(file, specifier)
    if (target !== null) found.add(target)
  }
  return [...found]
}

function resolveRelative(importer, specifier) {
  const relative =
    specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')
  if (!relative) return null
  /* A query or a fragment and everything after it: unanchored, because `s` makes
     `.` mean any character and `*` is greedy, so `$` decided nothing here and was
     a mutant no test could tell from its absence (2026-09-16). */
  const target = path.resolve(path.dirname(importer), specifier.replace(/[?#].*/su, ''))
  for (const suffix of RESOLVED_AS) {
    if (isFile(target + suffix)) return target + suffix
  }
  return null
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    /* Nothing there, or nothing that may be looked at: not a file either way. */
  }
  return false
}

/**
 * `read`, asked once per file for as long as the returned function is kept —
 * one sweep.
 *
 * The climb in `coveringTests` asks every test the same question at every level
 * for every subject, and each question is a parse now: 861 files took 6.6 s to
 * parse once on this machine, so unremembered, choosing the tests would cost
 * minutes before Stryker started.
 */
export function remembered(read) {
  const answers = new Map()
  return (file) => {
    const key = path.resolve(file)
    if (!answers.has(key)) answers.set(key, read(file))
    return answers.get(key)
  }
}

/**
 * The test files that import a module, by resolved path.
 *
 * ⚠️ **NOT THE SAME-NAME TEST FILE.** Plenty here are not named after what they
 * test — `store.ts` is covered by `circle.test.ts`, `panes.ts` by
 * `commands.test.ts` — so matching on the name would report those modules as
 * having no coverage and turn every one of their mutants into a false finding.
 * Following the imports is the question actually being asked: which tests would
 * have had a chance to object.
 */
export function testsCovering(subjects, allTests, imports = importsOf) {
  const wanted = new Set(subjects.map((f) => path.resolve(f)))
  return allTests.filter((test) => imports(test).some((target) => wanted.has(target)))
}

/**
 * The covering tests that read each subject's own TEXT, by subject. A subject no
 * such test reads is not in the answer.
 *
 * ⚠️ **THIS REPOSITORY DELIBERATELY TESTS SOME SOURCE AS SOURCE** — 33 files
 * read a module and assert on what it says, which is how `capabilityStyle`,
 * `composition.contract` and `cookieLeak` catch what a type cannot. Stryker
 * rewrites a mutated file to insert its switches, so those assertions compare
 * against instrumented text and fail in the DRY RUN — before a single mutant is
 * evaluated, taking the whole gate down with a message about an unrelated test.
 *
 * ⚠️ **AND THE SUBJECT WAS THEN DROPPED WHOLE, SO A SWEEP OF ONLY SUCH SUBJECTS
 * EXITED 0** (decided 2026-09-14). The incompatibility is between Stryker and
 * the reading TEST, not the subject: four subjects on `feat/looking-up`, about
 * 1 048 mutants, passed unmutated behind "a test asserts on their source text".
 * So the answer is per test now, and a sweep leaves exactly those tests out of
 * the subject's run and mutates it against the rest — see `discover`. A mutant
 * only such a test could kill survives, and that is intended: reading text is
 * not testing behaviour. What is left out is PRINTED on every run, test by test.
 * A silent exclusion list is the thing this gate exists to avoid becoming; one
 * that announces itself can be argued with.
 */
export function sourceReaders(subjects, allTests, covering = (subject) => testsCovering([subject], allTests)) {
  const sources = allTests.map((t) => [t, readFileSync(t, 'utf8')])
  /* Cheap first: a file with no `readFile` in it anywhere reads nothing, and
     parsing the other 300 to learn that costs seconds a sweep. Written apart so
     that what it saves can be said beside it: dropping it, or widening it to
     every file, parses more files to exactly the same answer. */
  // Stryker disable next-line MethodExpression,StringLiteral: `pathsRead` finds no read in a file that names none, so every file this leaves out would answer with no path anyway
  const reading = sources.filter(([, source]) => source.includes('readFile'))
  const readsText = new Map(reading.map(([t, source]) => [t, pathsRead(source, t)]))
  const found = new Map()
  for (const subject of subjects) {
    const readers = covering(subject).filter((test) => readsText.has(test) && namesFile(readsText.get(test), subject))
    if (readers.length > 0) found.set(subject, readers)
  }
  return found
}

/**
 * Whether a test's strings name a module's FILE — the file Stryker rewrites.
 *
 * ⚠️ **"READS ANY SOURCE" BLOCKED MODULES THAT NO TEST READS.** Instrumentation
 * rewrites only the subject, so only a test reading the subject's own text can
 * see it change. `sentenceCorpus.test.ts` reads `sentenceCorpus.ts` and imports
 * `sentenceOf.ts`, and the old rule skipped `sentenceOf.ts` — where phase 17's
 * whole sentence-edge rule lives — with a line saying a test asserted on its
 * text. Measured 2026-09-13: four modules skipped that way, `sentenceOf.ts`,
 * `useGloss.ts`, `panes.ts` and `CompanionPane.tsx`, all four ran cleanly when
 * mutated, and two had surviving mutants on lines the branch had changed.
 *
 * ⚠️ **AND "NAMES" THEN MATCHED FAR MORE THAN NAMES: SEVEN OF THE TEN MODULES
 * IT BLOCKED THE SAME DAY WERE NOT READ BY ANY TEST.** It was a substring and a
 * stem pattern over the whole source, so it counted an import
 * (`from './check-mutants.mjs'`, which reads no text), a comment mentioning
 * `commands.ts`, `accel.ts` or `metrics.ts`, the event name `'gloss.sentence'`
 * and the pane id `'settings'` (a stem beside a quote or a dot), and
 * `companion/index.test.ts` reading ITS OWN `./index.ts` as naming
 * `src/kernel/index.ts`. Each dropped a changed module from the sweep behind a
 * line claiming a test asserted on its text.
 *
 * So a name counts only in a path that can reach a READ (see `pathsRead`).
 *
 * ⚠️ **AND A BARE NAME WAS STILL TAKEN AT ITS WORD, SO A FILE NAME ALONE BLOCKED
 * EVERY FILE OF THAT NAME.** Each string was matched on its own, so
 * `path.join('fixtures', 'leaf.mjs')` offered `leaf.mjs` with its directory in
 * another string, and blocked the `src/leaf.mjs` its test imports — a
 * different file, never mutated, and the sweep exited 0. Finding #5,
 * reproduced 2026-09-14; the same shape was blocking `peer/lib/wire.ts` here,
 * behind `webhost/lib/wire.contract.test.ts` reading its own `wire.ts`.
 *
 * So a path must BE the subject's file, resolved as the test resolves it.
 *
 * ⚠️ **AND A PATH WITH A PART THAT CANNOT BE KNOWN BLOCKS NOTHING, WHATEVER
 * DIRECTORIES FOLLOW IT.** The rule before this one let a known end block any
 * subject whose own path ended the same way. Measured over this tree on
 * 2026-09-14, every block that rule made on an evaluated path was a test
 * reading its OWN scratch copy — `path.join(root, 'src/kernel/index.ts')` under
 * a `mkdtemp` root, in `capability-remove.test.mjs` and
 * `verify-without.test.mjs` — which no instrumented file can reach. The root is
 * exactly the part nobody can name.
 *
 * The bias is deliberate, and it is the reverse of the obvious one. A block that
 * should not have happened drops a module and still exits 0. A block that should
 * have happened and did not either fails the dry run — which this gate reports
 * as no score, not a pass — or costs nothing, because instrumented text is the
 * same under every mutant and so cannot kill one. Named, not proved: a test
 * that reaches a file by a path this cannot resolve is not seen here, and that
 * case is the loud one.
 *
 * ⚠️ **SINCE 2026-09-14 THE FIRST HALF OF THAT IS NO LONGER A PASS.** A test
 * wrongly taken for a reader is left out of its subject's run rather than the
 * subject dropped, and leaving a test out can only lose a kill — a survivor, or
 * a file no covering test was found for, both red. The bias stands; what it
 * guards against is loud in both directions now.
 */
function namesFile(paths, subject) {
  const own = path.resolve(subject)
  return paths.some((one) => {
    const file = asPath(one)
    return file !== null && path.resolve(file) === own
  })
}

/** A `file:` URL as the path it names; any other path as it was. `null` is a
 *  path with a part that cannot be known — and so is a URL naming no local path. */
function asPath(value) {
  if (value === null || !value.startsWith('file:')) return value
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

/** Where `new URL(spec, base)` points. A base the URL constructor refuses
 *  throws in the test too, and reaches nothing.
 *
 *  ⚠️ **ONLY THE SPEC IS ASKED ABOUT.** A base that cannot be known is `null`,
 *  which the constructor stringifies to `"null"` and then refuses as a URL, so
 *  asking about it separately decided nothing (2026-09-16). A SPEC that cannot
 *  be known is the case worth a line: unasked, it resolves against a real base
 *  and names the file called `null` beside it. */
function urlOf(spec, base) {
  if (spec === null) return null
  try {
    return new URL(spec, base).href
  } catch {
    return null
  }
}

/**
 * Every way `heads` then `tails` are written together, `between` apart.
 *
 * ⚠️ **THE CROSS PRODUCT GREW PAST WHAT AN ARRAY CAN HOLD** (2026-09-14): a name
 * this gate follows takes every value it has anywhere in the file, so a template
 * built from a few such names multiplies them, and `check-mutants.test.mjs`
 * reached `RangeError: Invalid array length` — the gate crashing rather than
 * answering. Past a bound, the answer is the one honest one: a part that cannot
 * be known, which blocks nothing.
 *
 * ⚠️ **AND THE BOUND WAS THEN THE ONLY THING BETWEEN A MUTANT AND THE HEAP,
 * WHICH IS NOT SOMETHING A TEST CAN ASSERT** (2026-09-16). Taken away, the parse
 * of this file's own 5 900-line test exhausted 1.5 GB in fifteen seconds; a
 * sweep of 3 055 mutants reported that as a wall-clock timeout, and the settle
 * run, at four times the deadline, reported it as one again. What made the lists
 * large enough for that was the DUPLICATES — the same path spelt over and over,
 * 1 332 297 of them where 2 773 are distinct — so `valuesOf` answers one of
 * each, and the unguarded parse now finishes in a second with a WRONG ANSWER,
 * which `expands a path built from exactly as many names as it will` asserts. It
 * is the same bound either way: `COMBINATIONS` counts the ways a path may be
 * SPELT, and a spelling twice over is not a second way. Measured over the 108
 * reading tests in this tree — no path lost anywhere, 707 gained in that one
 * file, and not one of them names a file that exists.
 */
function joined(heads, tails, between) {
  if (heads.length * tails.length > COMBINATIONS) return UNKNOWN
  return heads.flatMap((head) => tails.map((tail) => (head === null || tail === null ? null : head + between + tail)))
}

/** How many ways one path may be spelt before the answer is that it cannot be
 *  known. Exported so that a test can ask about the bound itself rather than
 *  about a number of its own, which would be a second place to change it. */
export const COMBINATIONS = 4096

/**
 * A part that cannot be known, as `pathsRead` answers it — one list, because
 * every answer of it is the same answer.
 *
 * ⚠️ **WHAT IT HOLDS IS UNOBSERVABLE, AND THAT IS WHY IT IS WRITTEN ONCE**
 * (2026-09-14). `namesFile` asks whether any path it was handed IS the subject,
 * and neither a list holding `null` nor an empty one holds a path — so the
 * seven places that each spelt this out carried seven mutants no test could
 * tell apart. Nothing writes to it: every reader here maps, filters or spreads.
 */
// Stryker disable next-line ArrayDeclaration: what this holds reaches `namesFile` as "no path", whatever it is, so no answer can differ
const UNKNOWN = [null]

/** What a call is named, when it is one `pathsRead` follows through: a bare
 *  `join(…)`, or `path.join(…)` and `process.cwd()`. */
function callName(callee) {
  if (ts.isIdentifier(callee)) return callee.text
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && RECEIVERS.has(callee.expression.text)
    ? callee.name.text
    : null
}

const RECEIVERS = new Set(['path', 'process'])

/** The calls that hand back a file's CONTENTS — the only ones instrumented text
 *  can reach. `statSync`, `existsSync` and `readdirSync` see a file without
 *  reading a byte of it, so a mutant cannot change what they answer. */
const READ_CALLS = new Set(['readFileSync', 'readFile'])

/** Methods that hand each element of the thing they are called on to a
 *  callback — so a name read inside one is a name the collection carried. */
const OVER_EACH = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'some', 'every'])

/**
 * Every path a test's reads can be handed — see `namesFile` — each as the path
 * it is, or `null` where any part of it cannot be known.
 *
 * ⚠️ **THIS WAS EVERY STRING THE FILE SPELLS, AND A NAME SPELLED IS NOT A FILE
 * READ.** `describe('leaf.mjs')` beside a `readFileSync` of an unrelated JSON
 * file blocked `leaf.mjs`. Measured across this repository on 2026-09-13: of
 * the 24 subjects blocked where a reading test also REACHES them, thirteen
 * were named by a spawn argument (`new URL('./verify-without.mjs', …)` handed
 * to a child process), by an expectation, by an `expect` message — and twice by
 * the filter that EXCLUDES the file from the walk being read
 * (`!file.endsWith('/peer/index.ts')`, `!one.endsWith('core/notify.ts')`).
 * `scripts/check-mutants.mjs` was one of the thirteen, so this gate had quietly
 * stopped mutating itself.
 *
 * So a string counts only where it can flow into a read: directly, through a
 * variable, through a helper's parameter at the call that passes it, or as the
 * collection a `for … of` or a `map`/`filter` callback reads over. All four
 * spellings are in this tree, which is why all four are followed.
 *
 * ⚠️ **AND THOSE STRINGS WERE THEN MATCHED ONE BY ONE, SO A PATH BUILT FROM
 * PARTS LOST THE PARTS THAT SAID WHERE IT WAS** — finding #5, 2026-09-14; see
 * `namesFile`. A read's argument is EVALUATED now, across the ways this tree
 * builds a path: a literal or a template, `join`, `resolve` and `dirname` bare
 * or on `path`, `new URL(spec, base)`, `fileURLToPath`, `.pathname`,
 * `import.meta.url` as this test's own, and `process.cwd()`. Anything else — a
 * call, a parameter nothing passes, a method on a collection — is a part that
 * cannot be known.
 *
 * ⚠️ **AND A CALLBACK'S BODY IS NOT A VALUE.** A chain's earlier `.filter(…)`
 * used to bring its callback's strings along as though the chain could read
 * them, so the file a walk EXCLUDES stayed blocked: `lib/entry.mjs` behind
 * `lib/entry.test.mjs` (`file !== helper`), `peer/index.ts` behind
 * `devicePort.test.ts` and `core/notify.ts` behind `notify.test.ts` — three of
 * the thirteen above, still blocked on 2026-09-14 though none of them is read.
 *
 * ⚠️ **WHAT THIS CANNOT SEE IS A PATH IT CANNOT RESOLVE** — a walk over a
 * directory, where the name read is whatever `readdirSync` returned, or a path
 * a helper returns. That case stays the LOUD one: the dry run fails, which this
 * gate reports as no score rather than as a pass.
 */
export function pathsRead(source, test) {
  /* Parents are not set: nothing below asks a node what encloses it, and an
     argument whose absence changes no answer is a mutant no test can kill. */
  const tree = ts.createSourceFile(test, source, ts.ScriptTarget.Latest)
  /* A name, against every expression that can become its value. */
  const flows = new Map()
  /* A name, against every function declared under it. */
  const functions = new Map()
  const add = (map, key, value) => {
    const at = map.get(key)
    if (at === undefined) map.set(key, [value])
    else at.push(value)
  }
  /* Everything bound here is a declaration's, a parameter's or a binding
     element's own name, and the language gives each of those an identifier or a
     binding pattern and nothing else — so the else IS the pattern. It asked which
     pattern until 2026-09-14, and that question had no second answer: nothing
     could reach it with the answer no, so no test could tell the guard from its
     absence. */
  const bind = (target, value) => {
    if (ts.isIdentifier(target)) add(flows, target.text, value)
    else for (const element of target.elements) if (ts.isBindingElement(element)) bind(element.name, value)
  }
  const isFunction = (node) => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))

  /* Declarations first, whole file: a helper is called before it is written as
     often as after. */
  const declare = (node) => {
    /* A declaration with no initializer — `let spec`, ahead of the assignments
       that give it its values — is bound to nothing, and `valuesOf` answers for
       that exactly as it answers for a name it never saw. Asking first decided
       nothing, and could not be told from not asking. */
    if (ts.isVariableDeclaration(node)) {
      bind(node.name, node.initializer)
      if (ts.isIdentifier(node.name) && isFunction(node.initializer)) add(functions, node.name.text, node.initializer)
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      add(functions, node.name.text, node)
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const bound = node.initializer
      /* Filed under the loop variable's own name, and under no name at all where
         the loop assigns somewhere else — `for (at.here of …)`, which leaves no
         name to look up again. Asking whether it had one decided nothing: a value
         filed under `undefined` is one no identifier can reach, since an
         identifier's own text is always a string. */
      if (ts.isVariableDeclarationList(bound)) for (const one of bound.declarations) bind(one.name, node.expression)
      else add(flows, bound.text, node.expression)
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      add(flows, node.left.text, node.right)
    }
    ts.forEachChild(node, declare)
  }
  ts.forEachChild(tree, declare)

  /* Every call, filed under the name it is made by — so the reads below are
     taken from `READ_CALLS` rather than each call asked whether it is one. */
  const calls = new Map()
  const wire = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const named = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      add(calls, named, node)
      /* Each argument against the parameter it lands on — driven by the
         ARGUMENTS, because under the other spelling a parameter with no argument
         was bound to `undefined`, and a name bound to nothing answers exactly
         what an unbound name answers, so nothing could tell that guard from its
         absence either. A call with more arguments than the function takes is the
         case that says the pairing is real (2026-09-14). */
      for (const fn of functions.get(named) ?? []) {
        node.arguments.forEach((argument, at) => {
          const parameter = fn.parameters[at]
          if (parameter !== undefined) bind(parameter.name, argument)
        })
      }
      const callback = node.arguments[0]
      if (
        ts.isPropertyAccessExpression(callee) &&
        OVER_EACH.has(callee.name.text) &&
        isFunction(callback) &&
        callback.parameters.length > 0
      ) {
        /* What the method was called ON, which is the collection — not the
           callback's own body, where a test writes the name it is filtering
           OUT. In a CHAIN that subject is itself a call, and so a part that
           cannot be known; see above. */
        bind(callback.parameters[0].name, callee.expression)
      }
    }
    ts.forEachChild(node, wire)
  }
  ts.forEachChild(tree, wire)

  const here = pathToFileURL(path.resolve(test)).href
  /* The names being evaluated, so a name whose value reaches itself is a part
     that cannot be known rather than a loop. */
  const open = new Set()
  /* One of each, at every step of the walk rather than only at the end of it —
     see `joined`, which is the step a list carrying duplicates multiplies. */
  const valuesOf = (node) => [...new Set(everyValueOf(node))]
  const everyValueOf = (node) => {
    if (node === undefined) return UNKNOWN
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce(
        (so, span) => joined(joined(so, valuesOf(span.expression), ''), [span.literal.text], ''),
        [node.head.text],
      )
    }
    /* A collection, taken one element at a time — which is what a loop or a
       callback bound to it reads. */
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(valuesOf)
    if (ts.isIdentifier(node)) {
      const values = flows.get(node.text)
      if (values === undefined || open.has(node.text)) return UNKNOWN
      open.add(node.text)
      const found = values.flatMap(valuesOf)
      open.delete(node.text)
      return found
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isMetaProperty(node.expression) && node.name.text === 'url') return [here]
      return node.name.text === 'pathname' ? valuesOf(node.expression).map(asPath) : UNKNOWN
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [spec, base] = node.arguments
      const bases = valuesOf(base)
      const specs = valuesOf(spec)
      /* The same bound `joined` keeps, for the same reason: past it, a part that
         cannot be known — which blocks nothing (fifth review, 2026-09-14). */
      if (specs.length * bases.length > COMBINATIONS) return UNKNOWN
      return specs.flatMap((one) => bases.map((from) => urlOf(one, from)))
    }
    if (!ts.isCallExpression(node)) return UNKNOWN
    const [first, ...rest] = node.arguments
    switch (callName(node.expression)) {
      case 'cwd':
        return [process.cwd()]
      case 'fileURLToPath':
        return valuesOf(first).map(asPath)
      case 'dirname':
        return valuesOf(first).map((one) => (one === null ? null : path.dirname(one)))
      case 'join':
        return rest.reduce((so, part) => joined(so, valuesOf(part), '/'), valuesOf(first))
      case 'resolve':
        /* From the working directory; an absolute part starts again, and the rest join on. */
        return node.arguments.reduce(
          (so, part) => {
            const parts = valuesOf(part)
            const absolute = parts.filter((one) => one !== null && path.isAbsolute(one))
            return [...absolute, ...joined(so, parts.filter((one) => !absolute.includes(one)), '/')]
          },
          [process.cwd()],
        )
      default:
        return UNKNOWN
    }
  }
  /* A read's FIRST argument, whatever it is. Neither `named !== null` nor a
     count of the arguments is asked: no read is named `null`, and a call with no
     argument offers `undefined`, which `valuesOf` answers for exactly as it
     answers a part that cannot be known — so both guards decided nothing and
     neither could be told from its absence (2026-09-16).

     ⚠️ **AND ASKED THE OTHER WAY ROUND, AS `if (READ_CALLS.has(named))` AT EACH
     CALL, IT CARRIED A MUTANT NO TEST COULD KILL IN TIME** (2026-09-16). Taking
     every call for a read is 19 times the work — 3 415 005 `joined` calls where
     182 721 are real — and over this file's own 5 900-line test that is 34 s
     against 1.4 s. The sweep reported it as a wall-clock timeout, and the settle
     run, at four times the deadline, reported it as one again. Driven by the
     read NAMES there is no such mutant: nothing this list holds can be the
     argument of a call named anything else. */
  const reads = [...READ_CALLS].flatMap((name) => (calls.get(name) ?? []).map((call) => call.arguments[0]))
  return reads.flatMap(valuesOf)
}

/**
 * Who imports each module: every resolved import target, mapped to the files
 * that import it. Built once per sweep — the graph does not change between
 * subjects.
 */
export function reverseImports(sources, imports = importsOf) {
  const index = new Map()
  for (const source of sources) {
    for (const target of imports(source)) {
      if (!index.has(target)) index.set(target, [])
      index.get(target).push(path.resolve(source))
    }
  }
  return index
}

/**
 * The tests that reach a subject: those importing it, or — when none does —
 * those importing the NEAREST modules that do, climbing one level at a time.
 * `through` names that level, so the log says how the subject was reached.
 *
 * ⚠️ **DIRECT IMPORTERS ALONE LET A MODULE THROUGH UNMUTATED.** A component
 * rendered only by its parent's tests — `PaneGroup.tsx` inside `Settings`,
 * `CompanionPane.tsx` inside its capability — had no test importing it, so the
 * gate printed "no test imports it" and exited 0 having mutated nothing, while
 * `test:coverage`, which counts what a test EXECUTES, called the same lines
 * covered. Each gate deferred to the other and neither measured it. The tests
 * that render a module are the tests that can object to its mutants.
 *
 * ⚠️ **THE NEAREST LEVEL, NOT EVERY TEST ABOVE IT — AND THAT IS THE COST, NOT
 * AN OVERSIGHT.** Measured 2026-09-13 over this branch's 35 changed modules: the
 * nearest level chose 160 test files in all, and every test reachable by any
 * chain would have chosen 1 219 — `metrics.ts` alone from 21 to 167,
 * `settings.ts` from 6 to 138. That is a large part of the suite per subject — the dry run the
 * header measured at 8m26s without finishing, and a larger set than the batch
 * whose per-test coverage attribution it measured collapsing. What stopping
 * early can cost is a mutant only a distant test would kill, and that is
 * reported as a SURVIVOR, red and named — never as a pass, because leaving a
 * test out can only lose a kill.
 */
export function coveringTests(subject, tests, importers, imports = importsOf) {
  const direct = testsCovering([subject], tests, imports)
  if (direct.length > 0) return { tests: direct, through: [] }
  for (const level of levelsAbove(path.resolve(subject), importers)) {
    const found = testsCovering(level, tests, imports)
    if (found.length > 0) return { tests: found, through: level.map((file) => slashed(path.relative(process.cwd(), file))) }
  }
  return { tests: [], through: [] }
}

/**
 * The files that import `subject`, then the files that import THOSE, and so on:
 * one list per level, nearest first, with no file in two levels and none in one
 * twice. `subject` is a resolved path and so is every file answered.
 *
 * ⚠️ **THE TURNS ARE COUNTED OFF THE GRAPH, NOT TAKEN UNTIL A GUARD SAYS STOP**
 * (2026-09-16) — the same shape as `ancestorsOf`, and for the same reason. Every
 * level before the last holds at least one file that is a KEY of `importers`,
 * the one the next level was found through, and the subject is a key too
 * whenever there is any level at all; the levels share no file, so the keys are
 * at least as many as the levels and are more turns than any climb can need. The
 * `for (;;)` this replaced had one turn a mutant could stay in: with
 * `next.length === 0` never true the climb did not answer differently, it failed
 * to TERMINATE, and a 40-minute sweep reported that as a wall-clock timeout its
 * settle run could not settle either. A list to walk has no such turn, and the
 * guard below is an ordinary killable one. Measured over this checkout: 469
 * subjects climbed in 8 ms, deepest 4 levels, 433 keys.
 */
export function levelsAbove(subject, importers) {
  const seen = new Set([subject])
  const levels = []
  let frontier = [subject]
  for (const _turn of importers.keys()) {
    frontier = [...new Set(frontier.flatMap((file) => importers.get(file) ?? []))].filter((file) => !seen.has(file))
    if (frontier.length === 0) return levels
    for (const file of frontier) seen.add(file)
    levels.push(frontier)
  }
  return levels
}

/**
 * Every file under `src` and `scripts` of the checkout at `root` that exists,
 * tracked or not, each named relative to `root` — see `allTestFiles` for why
 * the untracked half matters.
 *
 * `root` is asked rather than assumed so a test can hand it a repository of its
 * own. ⚠️ **ONE THAT ASKED THIS CHECKOUT WOULD MEASURE NOTHING IN A SWEEP**:
 * Stryker runs the tests from `.stryker-tmp/sandbox-…`, where git answers for
 * the enclosing repository and finds only an ignored directory — `ls-files`
 * lists nothing there, so every assertion about what it listed would hold
 * whatever the mutant did.
 */
export function repositoryFiles(root) {
  return [
    ...new Set([
      ...gitNames(['ls-files', '-z', 'src', 'scripts'], root),
      ...gitNames(['ls-files', '-z', '--others', '--exclude-standard', 'src', 'scripts'], root),
    ]),
  ].filter((f) => existsSync(path.join(root, f)))
}

/**
 * Every module a test could reach a subject through.
 *
 * ⚠️ **TEST KITS INCLUDED, THOUGH THEY ARE NEVER SUBJECTS.** This filtered on
 * `NOT_A_SUBJECT` — the rule for what may be MUTATED — as though it were the
 * rule for what a test may reach a module THROUGH, so a test using
 * `servicesWorld.testkit.ts` or `markCorpus.testkit.ts` reached nothing past
 * the kit as far as the climb could see. Measured 2026-09-13 it had left no
 * module unreached yet; the two questions differ all the same, and a kit is
 * exactly where a module under test is wired up.
 */
export function allSourceFiles(files) {
  return files.filter((f) => SRC.test(f) && !A_TEST.test(f) && !f.endsWith('.d.ts'))
}

const A_TEST = /\.test\.(ts|tsx|mjs)$/u

/**
 * Every test file, tracked or not.
 *
 * ⚠️ **`git ls-files` ALONE MISSES EVERY UNTRACKED ONE, AND THAT IS THE SET
 * THAT MATTERS MOST.** New work on a branch is new files; on this branch the
 * whole of `src/capabilities/circle/` is untracked, so the first version of
 * this function found none of its tests, decided the changed modules had no
 * coverage, and printed "none imported by any test" — a green, confident,
 * completely empty run. A gate that quietly measures nothing looks exactly
 * like a gate that passed, which is the failure mode every other check in this
 * repository is written to avoid.
 *
 * `--others --exclude-standard` is the second half: untracked, minus anything
 * `.gitignore` covers.
 */
function allTestFiles(files) {
  return files.filter((f) => A_TEST.test(f))
}

/**
 * How many mutants Stryker's own instrumenter makes in `file`, less each one
 * disabled beside the code — which a run reports `Ignored` and never tries.
 *
 * ⚠️ **COUNTED, NOT READ OFF A SHAPE** (2026-09-14). What has none is usually a
 * type-only module or a re-export barrel, and a rule that recognised those
 * shapes would go on exempting a file after it grew a line of logic. Nor is a
 * constants file one of them: every string in it is a `StringLiteral` mutant.
 * So the instrumenter a sweep runs is asked, in memory and writing nothing,
 * over the same text and with the options a sweep leaves at Stryker's defaults
 * — `plugins: null` and `excludedMutations: []` in `@stryker-mutator/core`
 * 10.0.0's `stryker-schema.json`, and no ignorers. `strykerConfig`'s test holds
 * it to leaving them there.
 *
 * RESOLVED THROUGH `@stryker-mutator/core`, which is not a detour: the
 * instrumenter is core's dependency and not this repository's, and the copy
 * core loads is the one whose count means anything.
 */
export async function mutantsIn(file) {
  return (await mutantIdentitiesIn(file)).length
}

/**
 * Each mutant `mutantsIn` counts, by IDENTITY — its mutator, its replacement and
 * its location, placed as a Stryker report places it — in location order.
 *
 * ⚠️ **A COUNT COULD BE MET BY COPIES OF ONE MUTANT** (second review,
 * 2026-09-14): eight copies of one real killed mutant satisfied a file planned
 * with eight, and the aggregate said every mutant was killed. So a plan records
 * each subject's identities, and the aggregate requires a report to hold exactly
 * that set — see `reportMismatch`.
 *
 * The instrumenter counts lines and columns from 0, and a report from 1: measured
 * the same day against a real report of one file, every start and end there was
 * one more than in memory, and the mutator and replacement were the same text.
 */
export async function mutantIdentitiesIn(file) {
  const core = createRequire(import.meta.url).resolve('@stryker-mutator/core')
  const { Instrumenter } = await import(pathToFileURL(createRequire(core).resolve('@stryker-mutator/instrumenter')).href)
  const { mutants } = await new Instrumenter(QUIET).instrument(
    [{ name: path.resolve(file), mutate: true, content: readFileSync(file, 'utf8') }],
    {
      plugins: null,
      // Stryker disable next-line ArrayDeclaration: no mutator is named "Stryker was here", so excluding it excludes nothing and no count can differ
      excludedMutations: [],
      ignorers: [],
    },
  )
  const fromOne = ({ line, column }) => ({ line: line + 1, column: column + 1 })
  return mutants
    .filter((mutant) => mutant.status !== 'Ignored')
    .map((mutant) => ({
      mutatorName: mutant.mutatorName,
      replacement: mutant.replacement,
      location: { start: fromOne(mutant.location.start), end: fromOne(mutant.location.end) },
    }))
    .sort(byIdentity)
}

/** A mutant's identity as a list — start, end, mutator, replacement — whatever shape it arrives in. */
function identityParts(identity) {
  const location = isRecord(identity) && isRecord(identity.location) ? identity.location : {}
  const start = isRecord(location.start) ? location.start : {}
  const end = isRecord(location.end) ? location.end : {}
  return [start.line, start.column, end.line, end.column, identity?.mutatorName, identity?.replacement]
}

/** Location order, then mutator and replacement: one order for any list of identities. */
function byIdentity(a, b) {
  const [left, right] = [identityParts(a), identityParts(b)]
  for (const [at, one] of left.entries()) {
    if (one === right[at]) continue
    return typeof one === 'number' && typeof right[at] === 'number' ? one - right[at] : byName(String(one), String(right[at]))
  }
  return 0
}

/** How a refusal names a mutant. */
function namedIdentity(identity) {
  const [line, column, endLine, endColumn, mutatorName, replacement] = identityParts(identity)
  return `${mutatorName} at ${line}:${column}-${endLine}:${endColumn} replaced with ${JSON.stringify(replacement)}`
}

/**
 * The instrumenter's logger, silenced. It says how many mutants it placed, and
 * warns of a `Stryker disable` naming no mutator — which changes nothing
 * counted, since that directive disables nothing. Every method answers nothing,
 * `isDebugEnabled` included, which reads as no.
 */
const QUIET = { isDebugEnabled() {}, debug() {}, info() {}, warn() {} }

/**
 * Says, by name, which changed files have mutants and no covering test that
 * discovery found — see `run`.
 *
 * ⚠️ **IT ANSWERED WHETHER THERE WERE ANY, AND NOBODY ASKED** (2026-09-14):
 * `summarise` calls this for what it writes, and has already decided on the
 * same list. Two returns nothing could read is two mutants nothing could kill.
 */
function sayNoTestFound(found, stderr) {
  if (found.length === 0) return
  stderr.write(
    `check-mutants: no covering test was found for ${found.length} file(s) that Stryker makes mutants in — a discovery or testability failure, not a mutation result, and not a pass:\n` +
      found.map(([subject, mutants]) => `  ${subject} — ${mutants} mutant(s)\n`).join('') +
      '  Reach each through an import a test makes, directly or through a module that imports it. Coverage does not excuse it: a sweep can only mutate against the tests it found.\n',
  )
}

const USAGE =
  'usage: node scripts/check-mutants.mjs [--base <ref>] [--only <substring>] [--require-base]\n' +
  '       node scripts/check-mutants.mjs --plan <manifest> --shards <count> [--isolate <heaviest>] [--base <ref>] [--only <substring>] [--require-base]\n' +
  '         (a plan and its shards assume clean checkouts: nothing .gitignore covers is fingerprinted, the install included, so a local run with ignored fixtures present is outside their guarantee)\n' +
  '       node scripts/check-mutants.mjs --shard <index>/<count> --manifest <manifest> --results <dir>\n' +
  '       node scripts/check-mutants.mjs --aggregate --manifest <manifest> --results <dir>'

/**
 * The command line, refused rather than guessed at.
 *
 * `--only <substring>` narrows to one module while working on it — the whole
 * value of this gate is being cheap enough to run mid-change. `--require-base`
 * is what CI passes: there, a base that cannot be resolved means the run would
 * mutate nothing and say it passed. See `changedFiles`.
 *
 * ⚠️ **A FLAG MISSING ITS VALUE WAS A PASS.** `argv[argv.indexOf('--only') + 1]`
 * read past the end as `undefined`, `f.includes(undefined)` looks for the text
 * "undefined", nothing matched, and the run printed "nothing changed to mutate"
 * and exited 0. A trailing `--base` fell back to `main` as quietly, and a
 * misspelt flag was ignored outright. `parseArgs` in strict mode refuses all
 * three, and an empty value is refused beside it.
 *
 * `--plan`, `--shard` and `--aggregate` are the three modes of a sharded sweep —
 * see `planSweep` — and each flag is read by the modes that use it and REFUSED by
 * the rest: a `--base` handed to a shard, which reads its plan's own, would
 * otherwise be ignored as quietly as the trailing flag above.
 */
export function argumentsOf(argv) {
  const { values } = parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false })
  /* Asked of every flag rather than of the string-valued ones: a boolean flag is
     `true` or absent and never empty, so the type decided nothing (2026-09-16). */
  for (const flag of Object.keys(FLAGS)) {
    if (values[flag] === '') throw new Error(`--${flag} needs a value, and was given an empty one`)
  }
  const modes = ['plan', 'shard', 'aggregate'].filter((mode) => values[mode] !== undefined)
  if (modes.length > 1) throw new Error(`--${modes[0]} and --${modes[1]} are two modes, and one run is one of them`)
  const mode = modes[0] ?? 'sweep'
  for (const flag of Object.keys(FLAGS)) {
    if (values[flag] === undefined || READ_BY[mode].includes(flag)) continue
    const where = mode === 'sweep' ? 'a plain sweep' : `--${mode}`
    /* Only a shard and the aggregate can be handed a flag a plain sweep reads:
       a sweep reads its own, and a plan reads every one of them beside its own,
       so neither reaches here with one. Asking which mode this was decided
       nothing, and nothing could tell the question from its absence. */
    const why = READ_BY.sweep.includes(flag) ? " — a shard and the aggregate read the plan's own from its manifest" : ''
    throw new Error(`--${flag} is not read by ${where}${why}`)
  }
  for (const flag of NEEDED_BY[mode]) {
    if (values[flag] === undefined) throw new Error(`--${mode} needs --${flag}`)
  }
  const scope = { base: values.base ?? 'main', only: values.only ?? null, requireBase: values['require-base'] === true }
  if (mode === 'sweep') return scope
  if (mode === 'shard') return { mode, manifest: values.manifest, results: values.results, ...shardSpecOf(values.shard) }
  if (mode === 'aggregate') return { mode, manifest: values.manifest, results: values.results }
  const shards = wholeNumber(values.shards)
  /* `wholeNumber` answers `null` for anything that is not one, and `null < 1` is
     true, so asking about it separately decided nothing (2026-09-16). */
  if (shards < 1) {
    throw new Error(`--shards needs a whole number of at least 1, and was given ${JSON.stringify(values.shards)}`)
  }
  const isolate = values.isolate === undefined ? 0 : wholeNumber(values.isolate)
  if (isolate === null) throw new Error(`--isolate needs a whole number, and was given ${JSON.stringify(values.isolate)}`)
  if (isolate >= shards) {
    throw new Error(`--isolate ${isolate} leaves no shard for the other files — it must be less than --shards ${shards}`)
  }
  return { mode, manifest: values.plan, shards, isolate, ...scope }
}

/** Every flag, in the order a refusal meets them. */
const FLAGS = {
  base: { type: 'string' },
  only: { type: 'string' },
  'require-base': { type: 'boolean' },
  plan: { type: 'string' },
  shards: { type: 'string' },
  isolate: { type: 'string' },
  shard: { type: 'string' },
  manifest: { type: 'string' },
  results: { type: 'string' },
  aggregate: { type: 'boolean' },
}

/** The flags each mode reads. A plain sweep is the mode no flag names. */
const READ_BY = {
  sweep: ['base', 'only', 'require-base'],
  plan: ['plan', 'shards', 'isolate', 'base', 'only', 'require-base'],
  shard: ['shard', 'manifest', 'results'],
  aggregate: ['aggregate', 'manifest', 'results'],
}

/** The flags each mode cannot run without. */
const NEEDED_BY = { sweep: [], plan: ['shards'], shard: ['manifest', 'results'], aggregate: ['manifest', 'results'] }

/** `text` as a whole number written plainly in digits, or `null`. */
function wholeNumber(text) {
  if (!/^\d+$/u.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

/** A `--shard <index>/<count>`, refused unless it names a whole shard of a whole count of at least one. */
function shardSpecOf(text) {
  const parts = /^(\d+)\/(\d+)$/u.exec(text)
  const [index, count] = parts === null ? [null, null] : [wholeNumber(parts[1]), wholeNumber(parts[2])]
  if (index === null || count === null) {
    throw new Error(`--shard needs <index>/<count>, two whole numbers, and was given ${JSON.stringify(text)}`)
  }
  if (count < 1) throw new Error(`--shard ${text}: the count must be at least 1`)
  if (index < 1 || index > count) throw new Error(`--shard ${text}: the index must be from 1 to ${count}`)
  return { index, count }
}

/** What a thrown value says, whether or not it is an `Error`. */
function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Which failure a thrown value names — `ENOENT`, `EEXIST`, `ELOOP` — and nothing
 * when it names none.
 *
 * ⚠️ **ASKED IN ONE PLACE, BECAUSE `cause?.code` IS A CLAIM NO TEST CAN CHECK
 * TWELVE TIMES OVER.** A throw need not be an `Error` — `messageOf` is the same
 * question about its message — so every `catch` here read the code through an
 * optional chain of its own, and every one of those was a mutant no test could
 * kill: `fs` throws an `Error` at all twelve, so dropping the `?.` changed
 * nothing observable at any of them. One helper is one mutant, and `codeOf(null)`
 * is what kills it.
 */
export function codeOf(cause) {
  return cause?.code
}

/**
 * One sweep, start to finish, as the exit code `pnpm mutants` ends with.
 *
 * ⚠️ **THIS WAS THE ONE PART OF THE GATE NO TEST COULD REACH, AND THE GATE NOW
 * MUTATES ITSELF.** It read git, spawned Stryker, took the checkout's lock and
 * wrote to the real streams, so its own test measured 68.7 % of this file's
 * lines on 2026-09-14 with the whole of this function among the rest — and
 * once `namesFile` stopped blocking it, `scripts/check-mutants.mjs` became a
 * subject of its own sweep, where an uncovered line is a `NoCoverage` mutant
 * and `NoCoverage` is a survivor.
 *
 * So what a sweep does to the world outside its arguments comes in beside them:
 * `changed` and `files` for what git says — names relative to the checkout, as
 * git gives them — `commits` for the commits a plan is made at, `lock` for the
 * checkout's lock, `stryker` for the run itself, `clock` for how long each file
 * took, and the two streams. What stays real is the
 * filesystem under `root` — the generated files, the report, Stryker's sandbox
 * and `vitest.config.ts` all live there — so a test drives a whole sweep over a
 * directory of its own and reads back what was actually written and removed,
 * rather than a list of calls somebody expected to be made.
 *
 * `root` is `.` for a real sweep, and the entry below passes exactly that:
 * every generated path is joined onto it and handed to Stryker, which runs
 * COPIES in its sandbox, so what it is handed must mean the same thing there as
 * here. Joined onto `.` each is the relative name this gate always wrote; an
 * absolute root would hand Stryker paths into this checkout instead, and
 * nothing here has measured what it makes of those.
 */
export async function run(
  argv,
  {
    root,
    stdout = process.stdout,
    stderr = process.stderr,
    changed = changedFiles,
    files = repositoryFiles,
    lock = lockCheckout,
    stryker = strykerRun,
    commits = commitsOf,
    worktree = worktreeOf,
    tracked = trackedUnder,
    clock = () => performance.now(),
  },
) {
  let options
  try {
    options = argumentsOf(argv)
  } catch (cause) {
    stderr.write(`check-mutants: ${messageOf(cause)}\n${USAGE}\n`)
    return 2
  }
  const world = { root, stdout, stderr, changed, files, lock, stryker, commits, worktree, tracked, clock }
  try {
    return await (MODES[options.mode] ?? sweepChanges)(options, world)
  } catch (cause) {
    if (!(cause instanceof Refusal)) throw cause
    stderr.write(`${cause.message}\n`)
    return 2
  }
}

/**
 * A refusal, said in its own words: a run that meets one ends with 2. Anything
 * else thrown is a defect, and propagates as it came. `detail` is the refusal
 * without its framing — what a stopped shard's results record as the reason.
 */
class Refusal extends Error {
  constructor(message, detail = message) {
    super(message)
    this.detail = detail
  }
}

/** A plain sweep: every changed file, one Stryker run each, in this checkout. */
async function sweepChanges({ base, only, requireBase }, world) {
  const { root, stdout } = world
  const subjects = chosen(world, base, only, requireBase).map(({ at }) => at)
  if (subjects.length === 0) {
    stdout.write('check-mutants: nothing changed to mutate\n')
    return 0
  }
  const found = discover(subjects, world)
  sayLeftOut(subjects, found, stdout)
  /* ⚠️ **A CHANGED FILE NO TEST REACHED WAS A PASS, AND THAT IS THE DEFECT THIS
   * GATE EXISTS FOR, WEARING GREEN** (decided 2026-09-14). A sweep that reached
   * none, and each subject inside one that no test reached, exited 0 with
   * "see test:coverage" — so a miss in FINDING the tests read exactly like a
   * module with nothing to test. The review that measured this branch found
   * two: a re-export barrel, and `app/bootApp.ts` with 101 mutants and no test
   * importing it.
   *
   * So what no test reaches is COUNTED, by Stryker's own instrumenter — see
   * `mutantsIn`. None is nothing to kill, and passes by name. Any is a failure
   * by name, in words of its own: not a survivor, because nothing was tried
   * against it, and not coverage's to excuse, because coverage counts lines
   * run and never which tests a sweep can find. No file is exempt by name — an
   * exemption by name outlives the reason for it.
   *
   * A subject whose every covering test reads its source is one of these too
   * since 2026-09-14: once those tests are left out, no test is run against it. */
  const reached = subjects.filter((subject) => found.get(subject).tests.length > 0)
  const noMutants = []
  /* Each as `[subject, mutants]`. */
  const noTestFound = []
  for (const subject of subjects.filter((one) => !reached.includes(one))) {
    const mutants = await countedIn(subject)
    if (mutants === 0) noMutants.push(subject)
    else noTestFound.push([subject, mutants])
  }
  sayNoMutants(noMutants, stdout)
  /* ⚠️ **A REACHED FILE WITH NO MUTANT FAILED EVERY SWEEP IT WAS IN** (measured
   * 2026-09-14 on the real sweep). `src/kernel/index.ts` and `kernel/ui/boot.ts`
   * are re-export barrels that Stryker instruments 0 mutants in, and tests reach
   * both — so each went to Stryker, which wrote a report naming no file, which
   * `outcomeOf` reads as a run with no score, and the sweep ended "Stryker did
   * not finish for 2 file(s)", exit 1. The unreached path had counted first and
   * passed zero as nothing to kill; the reached path does the same now, before
   * the project is read, the lock taken or Stryker started. A report about no
   * file is still no score for a subject that HAS mutants. */
  const nothingToKill = []
  const toStryker = []
  /* What each file this sweep will run held when it was counted, so its report
     can be reconciled against it afterwards — see `reportUnlike`. */
  const counted = new Map()
  for (const subject of reached) {
    const identities = await identifiedIn(subject, 'whether Stryker has anything to run in it')
    if (identities.length === 0) nothingToKill.push(subject)
    else {
      toStryker.push(subject)
      counted.set(subject, { identities, sha256: digestOf(readFileSync(subject)) })
    }
  }
  /* Nothing to sweep: neither the project's configuration nor the lock is needed. */
  if (toStryker.length === 0) return summarise({ noTestFound, nothingToKill }, world)
  const swept = await strykerEach(toStryker, found, await testOptionsOf(root), world, {
    judge: (subject, report) =>
      reportUnlike(reportEntryOf(subject, report), { named: subject, ...counted.get(subject), whose: 'this sweep' }),
  })
  return summarise({ ...swept, nothingToKill: [...nothingToKill, ...swept.nothingToKill], noTestFound }, world)
}

/** The changed files `changed` names, narrowed by `only` — each as git names it, and at `root`. */
function chosen({ root, changed }, base, only, requireBase) {
  let names
  try {
    names = changed(base, requireBase)
  } catch (cause) {
    throw new Refusal(messageOf(cause))
  }
  /* Git names a file relative to the checkout, and both `SRC` and `--only` read
     it that way; everything after is about the file itself, at `root`. */
  return names.filter((name) => only === null || name.includes(only)).map((name) => ({ name, at: path.join(root, name) }))
}

/**
 * What discovery found for each subject: the covering tests it is mutated
 * against, the covering tests left out of that run because they read its source
 * — see `sourceReaders` — and the modules it was reached through.
 */
function discover(subjects, { root, files }) {
  const tree = files(root)
  const inCheckout = (file) => path.join(root, file)
  const all = allTestFiles(tree).map(inCheckout)
  /* One parse per file for the whole sweep — see `remembered`. */
  const imports = remembered(importsOf)
  const importers = reverseImports(allSourceFiles(tree).map(inCheckout), imports)
  const reach = new Map(subjects.map((subject) => [subject, coveringTests(subject, all, importers, imports)]))
  const readers = sourceReaders(subjects, all, (subject) => reach.get(subject).tests)
  return new Map(
    subjects.map((subject) => {
      const { tests, through } = reach.get(subject)
      const leftOut = readers.get(subject) ?? []
      return [subject, { tests: tests.filter((test) => !leftOut.includes(test)), leftOut, through }]
    }),
  )
}

/** Names, test by test, what each subject is mutated without — see `sourceReaders`. */
function sayLeftOut(subjects, found, stdout) {
  const reading = subjects.filter((subject) => found.get(subject).leftOut.length > 0)
  if (reading.length === 0) return
  stdout.write(
    `check-mutants: ${reading.length} file(s) are mutated without the covering tests that read their source text — Stryker rewrites the very file such a test reads, so it would fail the dry run; a mutant only it could kill survives, because reading text is not testing behaviour:\n` +
      reading
        .map((subject) => {
          const { tests, leftOut } = found.get(subject)
          const remaining = tests.length === 0 ? 'no covering test remains' : `${tests.length} covering test(s) remain`
          return `  ${subject} — ${remaining}; left out:\n` + leftOut.map((test) => `    ${test} — reads its source text\n`).join('')
        })
        .join(''),
  )
}

/** Names the changed files no test is run against that Stryker makes no mutant in. */
function sayNoMutants(noMutants, stdout) {
  if (noMutants.length === 0) return
  stdout.write(
    `check-mutants: ${noMutants.length} file(s) no test reaches have no mutant in them — Stryker's own instrumenter makes none, or every one is disabled beside the code — so there is nothing a test could kill:\n` +
      noMutants.map((f) => `  ${f}\n`).join(''),
  )
}

/** How many mutants Stryker makes in `subject` — refused rather than guessed at when it cannot say. */
async function countedIn(subject, why) {
  return (await identifiedIn(subject, why)).length
}

/** The mutants Stryker makes in `subject`, by identity — see `mutantIdentitiesIn` — refused when it cannot say. */
async function identifiedIn(subject, why = 'whether a test must reach it') {
  try {
    return await mutantIdentitiesIn(subject)
  } catch (cause) {
    throw new Refusal(`check-mutants: Stryker cannot count the mutants in ${subject}, so ${why} is unknown — ${messageOf(cause)}`)
  }
}

/**
 * How the covering tests are run, read from the project before anything is
 * written or locked — see `carriedTestOptions`. A config this cannot read is a
 * sweep that cannot say what it ran, so it is refused, not guessed at.
 */
async function testOptionsOf(root) {
  try {
    const carried = carriedTestOptions(await loadTestConfig(root))
    /* And what the generated config inherits without reading — see `loadViteTestBlock`. */
    await loadViteTestBlock(root)
    return carried
  } catch (cause) {
    throw new Refusal(`check-mutants: ${messageOf(cause)}`)
  }
}

/**
 * One Stryker run per subject, under the checkout's lock, each against only its
 * own covering tests. `record` is handed each subject's outcome the moment it has
 * one — see `shardSweep`. Answers the subjects, by outcome.
 */
async function strykerEach(
  reached,
  found,
  carried,
  { root, stdout, lock, stryker, clock },
  { record = () => {}, before = () => {}, between = () => {}, after = () => {}, judge = () => null } = {},
) {
  /* ⚠️ **BOTH GENERATED FILES LIVE IN THE REPOSITORY, NOT IN `tmpdir()`.**
   * Stryker copies the tree into a sandbox and runs from there, so a config in
   * `/tmp` is never copied — and even read in place it cannot resolve
   * `vitest/config`, because node_modules is not reachable from outside the
   * project. At the root, the config lands at the sandbox root and every
   * relative path in it resolves the same way it does here. Both are removed in
   * the `finally` below, and `.gitignore` covers the window in between. */
  const vitestConfig = path.join(root, 'vitest.mutants.mjs')
  const config = path.join(root, 'stryker.mutants.json')
  const report = path.join(root, REPORT)
  const sandbox = path.join(root, '.stryker-tmp')

  stdout.write(`check-mutants: mutating ${reached.length} changed file(s), one run each\n`)
  /* Subjects with a kill in them, and subjects with no mutant to kill — both
     pass, and the summary names which is which. `notRun` is the subjects
     Stryker never scored — see `outcomeOf`. Not survivors. `staticSurvivors`
     names where each survivor Stryker marks static sits — see `summarise`. */
  const swept = {
    // Stryker disable next-line ArrayDeclaration: the only thing read of this list is whether it is empty, and every run that reaches that read has put a subject in it — see `summarise`
    killed: [],
    nothingToKill: [],
    notRun: [],
    unkilled: [],
    timedOut: [],
    staticSurvivors: [],
    mismatched: [],
  }
  const into = { killed: swept.killed, 'nothing-to-kill': swept.nothingToKill, 'did-not-run': swept.notRun, survived: swept.unkilled }
  /* Before the first write to any shared name — see `acquireLock`. */
  let release
  try {
    release = lock()
  } catch (cause) {
    throw new Refusal(`check-mutants: ${messageOf(cause)}`)
  }
  try {
    /* ⚠️ **A LINK AT A GENERATED NAME WAS WRITTEN THROUGH, AND HANDED TO STRYKER
     * TO LEAVE OUT** (second review, 2026-09-14). Whatever sits at one of these
     * names now belongs to no live sweep — the lock says so — so it is removed
     * before the tree's links are listed, and each file is then created anew,
     * exclusively: see `writeFresh`. */
    for (const generated of [vitestConfig, config, report]) rmSync(generated, { force: true })
    rmSync(sandbox, { recursive: true, force: true })
    /* Once per sweep: the tree does not grow symlinks between subjects. */
    const symlinks = symlinksIn(root)
    /* One Stryker run of one subject, under `deadline`, and what it amounted to.
       The generated vitest config is the subject's own and is written once, so a
       settle run is the same subject against the same covering tests. */
    const runOnce = async (subject, deadline) => {
      writeFresh(config, JSON.stringify(strykerConfig(subject, vitestConfig, symlinks, deadline), null, 2))
      /* A report left by the previous run would pass this one's crash off as a
         scored run. */
      rmSync(report, { force: true })
      const started = clock()
      const exitedCleanly = (await stryker(config)) === true
      return { exitedCleanly, report: reportFrom(report), durationMs: Math.round(clock() - started) }
    }
    for (const [at, subject] of reached.entries()) {
      const { tests: covering, through } = found.get(subject)
      stdout.write(
        `  [${at + 1}/${reached.length}] ${subject}${through.length > 0 ? ` — through ${through.join(', ')}` : ''}\n`,
      )
      /* Immediately before this subject's run: a shard asks the checkout again
         here, and stops if it changed — see `shardSweep`. */
      await before(subject)
      /* Only THIS subject's tests, so per-test coverage attribution stays
         sound — see the header. */
      writeFresh(vitestConfig, vitestConfigFor(covering, carried))
      const first = await runOnce(subject, FIRST_RUN)
      /* ⚠️ **A FRESH REPORT NAMING THE RIGHT FILE IS NOT A REPORT OF IT** (fourth
         review, 2026-09-14): one holding no mutant passed as a file with nothing
         left to kill, though the count taken minutes before had found one. What a
         sweep counted is what its report must hold — see `reportUnlike`. */
      const unlike = judge(subject, first.report)
      /* ⚠️ **THE SETTLE RUN — A WALL-CLOCK TIMEOUT IS NOT A KILL, IT IS AN
         UNANSWERED QUESTION** (2026-09-15; the whole of the evidence is beside
         `HIT_LIMIT`). A report holding one gets the file re-run WHOLE, once,
         immediately: the same subject, the same covering tests, the same
         generated vitest config, with room to finish — see `SETTLE_RUN`, which
         says why the deadline and not the runner count is what settles one. Every check around a
         run holds for it unchanged, this one included.
         A report that is not of this file is judged already, and its timeouts
         say nothing about anything, so there is nothing to settle. */
      const toSettle = unlike === null ? timeoutsIn(reportEntryOf(subject, first.report)).unsettled.length : 0
      let settle = null
      if (toSettle > 0) {
        /* Between the two runs, as before the first and after the second: a
           checkout that changes mid-settle stops a shard exactly as one that
           changes mid-sweep does. */
        await between(subject)
        settle = await runOnce(subject, SETTLE_RUN)
      }
      const verdict = settledVerdict(subject, first, settle)
      const settleUnlike = settle === null ? null : judge(subject, settle.report)
      const problem = unlike ?? (settleUnlike === null ? null : `the settle run's report: ${settleUnlike}`)
      if (problem !== null) swept.mismatched.push([subject, problem])
      else {
        stdout.write(sayTimeouts(subject, verdict))
        /* A repeat is named whatever else the file also is: a survivor outranks
           it as the file's OUTCOME — a survivor is the finding, a repeat the
           absence of one — and does not replace it as a thing to fix. So a file
           with both is in both lists, and `timed-out` is the outcome of a file
           that has a repeat and nothing worse. The places come with the file:
           see `summarise`. */
        if (verdict.repeated.length > 0) swept.timedOut.push([subject, verdict.repeated])
        if (verdict.outcome !== 'timed-out') into[verdict.outcome].push(subject)
        for (const place of staticSurvivorsIn(subject, [first.report, settle === null ? null : settle.report])) {
          swept.staticSurvivors.push(`${subject}:${place}`)
        }
      }
      record({
        subject,
        outcome: verdict.outcome,
        exitedCleanly: first.exitedCleanly,
        mutants: mutantsReported(subject, first.report),
        durationMs: first.durationMs,
        report: first.report,
        settle,
      })
      /* Nothing of this subject's is left for the next one's check of the
         checkout to find. */
      rmSync(report, { force: true })
      rmSync(sandbox, { recursive: true, force: true })
      /* Both were written for this subject's run a few lines above and are still
         there, so `force` is the habit rather than the thing that removes them. */
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: `writeFresh` made this file for this subject's run and nothing since has removed it, so forcing decides nothing
      rmSync(vitestConfig, { force: true })
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: `writeFresh` made this file for this subject's run and nothing since has removed it, so forcing decides nothing
      rmSync(config, { force: true })
      /* And again now the run is over: what changed DURING it changed what
         Stryker swept — see `shardSweep`. Last subject included, which is the
         one a check only before each run never covered. */
      await after(subject)
    }
  } finally {
    rmSync(vitestConfig, { force: true })
    rmSync(config, { force: true })
    rmSync(report, { force: true })
    rmSync(sandbox, { recursive: true, force: true })
    release()
  }
  return swept
}

/**
 * Writes `data` as a NEW file at `file`: whatever was there is removed first,
 * and the create is exclusive, so a link planted at the name is never written
 * through — one that reappears in between fails the create, loudly.
 */
function writeFresh(file, data) {
  /* ⚠️ **REMOVING A LINK IS STILL ACTING ON WHAT IT POINTS AT** (fourth review,
   * 2026-09-14): a link put at one of these names after the sweep began sent the
   * write into tracked fixtures, and the removal here deleted them on the way. A
   * link at the name is refused instead — nothing this gate writes belongs
   * anywhere but where it says. */
  const there = entryAt(file)
  if (there?.isSymbolicLink()) {
    throw new Refusal(`check-mutants: ${file} is a symbolic link, and this gate writes through none — remove it if nothing is using it`)
  }
  rmSync(file, { force: true })
  /* An EXCLUSIVE create, so a link put back at the name between the removal
     above and this line is never written through. That window is between two
     synchronous calls in this process, so only another writer can open it — and
     a test in this suite is not one, which is why both spellings that drop the
     exclusivity are marked here rather than killed. */
  // Stryker disable next-line ObjectLiteral,StringLiteral: the removal a line above leaves nothing at this name, and nothing a test can do puts something back between two synchronous calls
  writeFileSync(file, data, { flag: 'wx' })
}

/**
 * The name a subject's result is written under: a readable slug and a digest of
 * the subject's own path, which is inside the record for whoever reads it.
 *
 * ⚠️ **THE NAME WAS THE WHOLE PATH, PERCENT-ENCODED** (fourth review,
 * 2026-09-14), and 27 Chinese characters — 84 bytes — became 264, past the 255 a
 * name may hold, so the write failed outright. A digest is 16 characters whatever
 * the path, and the slug is what a reader recognises.
 *
 * ⚠️ **AND THE SLUG THEN LEFT A DOT LEADING, WHICH IS A HIDDEN FILE** (fifth
 * review): a basename with no ASCII in it slugged away to nothing but its
 * extension, `.ts`, and `actions/upload-artifact` leaves hidden files out — so a
 * shard would have uploaded its receipt without the result, and the aggregate
 * would have called a file missing that had been scored. The slug is trimmed to
 * something that BEGINS with a letter or a digit, or is dropped for one that
 * does; the digest of the whole path is what keeps two files of one name apart.
 */
export function resultFileFor(subject) {
  const slug = path
    .basename(subject)
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, '')
    .slice(0, 40)
  return `${slug === '' ? 'file' : slug}-${digestOf(subject).slice(0, 16)}.result.json`
}

/**
 * Where each mutant that SURVIVED and that Stryker marks `static` sits in
 * `reports` of `subject`, as `line:column`, once each.
 *
 * ⚠️ **BOTH RUNS ARE READ, NOT ONLY THE FIRST.** 42 of 140 replayed wall-clock
 * timeouts came back `Survived` — so a survivor the settle run alone observes is
 * the ordinary case here, and one of those is as likely to be static as any
 * other. A place found in both runs is named once.
 */
function staticSurvivorsIn(subject, reports) {
  const places = reports.flatMap((report) => {
    const entry = reportEntryOf(subject, report)
    if (entry === null) return []
    return entry.mutants.filter((mutant) => isRecord(mutant) && mutant.status === 'Survived' && mutant.static === true).map(placeOf)
  })
  return [...new Set(places)]
}

/** How many mutants a report holds for `subject`, or `null` when it holds no list of them this gate can read. */
function mutantsReported(subject, report) {
  const files = isRecord(report) ? report.files : undefined
  if (!isRecord(files)) return null
  const name = Object.keys(files).find((one) => path.resolve(one) === path.resolve(subject))
  const mutants = name === undefined || !isRecord(files[name]) ? undefined : files[name].mutants
  return Array.isArray(mutants) ? mutants.length : null
}

/**
 * What a sweep's outcomes add up to, as its exit code, with each class named.
 * `complete` is false when the outcomes do not account for every planned file —
 * see `aggregateSweep` — and then no pass is claimed whatever they hold.
 * `errors` says where a run Stryker never scored left its own error.
 */
function summarise(outcomes, { stdout, stderr }, { complete = true, errors = 'Its own error is above' } = {}) {
  /* Three of these defaults are reached by no caller, and are kept for the one
     that comes next: every mode names its own files no test was found for and its
     own files with nothing to kill, and `staticSurvivors` is written out beside
     survivors alone, which a caller leaving it out has none of. */
  const {
    killed = [],
    // Stryker disable next-line ArrayDeclaration: every caller passes its own, so no run reads this default and no answer can differ
    nothingToKill = [],
    notRun = [],
    unkilled = [],
    timedOut = [],
    // Stryker disable next-line ArrayDeclaration: every caller passes its own, so no run reads this default and no answer can differ
    noTestFound = [],
    // Stryker disable next-line ArrayDeclaration: the callers that leave this out pass no survivors either, and it is written out beside survivors alone
    staticSurvivors = [],
    mismatched = [],
  } = outcomes
  /* ⚠️ **"EVERY MUTANT WAS KILLED" WAS PRINTED OVER SUBJECTS THAT HAD NONE.**
   * Nothing to kill passes, but a reader could not tell it from a module whose
   * every mutant a test had caught. Finding #9, 2026-09-14. So those subjects
   * are named for what they are, and the kill is claimed only where one
   * happened. */
  if (nothingToKill.length > 0) {
    stdout.write(
      `check-mutants: ${nothingToKill.length} file(s) had no mutant to kill — Stryker made none, or every one is disabled beside the code — so they pass without any test having been tried against them:\n` +
        nothingToKill.map((f) => `  ${f}\n`).join(''),
    )
  }
  /* ⚠️ **A FILE AND THE PLACES ITS TIMEOUT REPEATED AT ARE ONE ENTRY, NOT TWO
     LISTS** (2026-09-16). They were two, filled under one condition and so empty
     together — which made a second test of the same fact a condition nothing
     could be observed through, and the second list's own default a value no
     caller ever read. Carried together, neither can be had without the other. */
  if (unkilled.length === 0 && notRun.length === 0 && noTestFound.length === 0 && mismatched.length === 0 && timedOut.length === 0) {
    if (!complete) return 1
    if (killed.length > 0) stdout.write('check-mutants: every mutant was killed\n')
    return 0
  }
  sayNoTestFound(noTestFound, stderr)
  if (mismatched.length > 0) {
    stderr.write(
      `check-mutants: the report does not match the file swept in ${mismatched.length} file(s) — Stryker's own report is not of what this sweep counted, so nothing about their mutants is known:\n` +
        mismatched.map(([file, why]) => `  ${file} — ${why}\n`).join(''),
    )
  }
  if (notRun.length > 0) {
    stderr.write(
      `check-mutants: Stryker did not finish for ${notRun.length} file(s), or finished having scored nothing — there is no score for them, and no score is not a pass.\n` +
        notRun.map((f) => `  ${f}\n`).join('') +
        `  ${errors}; nothing about these files' tests is known yet.\n`,
    )
  }
  /* ⚠️ **AND THE SETTLE RUN'S OWN FAILURE: A TIMEOUT THAT WOULD NOT SETTLE.**
     Rare — 3 of 140 replayed, all in one `isReactNode` loop, all provable
     non-termination — and it is the one answer the second run cannot give, so
     it is neither a kill nor a survivor but a question left open, named as
     that. */
  if (timedOut.length > 0) {
    stderr.write(
      `check-mutants: a wall-clock timeout came back a wall-clock timeout in ${timedOut.length} file(s) — the settle run, with a ${SETTLE_RUN.timeoutMS / 1000} s deadline and a ${SETTLE_RUN.timeoutFactor}× factor, could not resolve it, so whether a test kills it is unknown.\n` +
        timedOut.map(([file]) => `  ${file}\n`).join('') +
        '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
        '  mutation genuinely never terminates, say so beside the code:\n' +
        '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n' +
        timedOut.flatMap(([file, places]) => places.map((at) => `  repeated: ${file}:${at}\n`)).join(''),
    )
  }
  if (unkilled.length > 0) {
    stderr.write(
      `check-mutants: a mutant survived in ${unkilled.length} file(s) — a test that cannot fail is not a test.\n` +
        unkilled.map((f) => `  ${f}\n`).join('') +
        '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
        '  mutation is genuinely equivalent, say so beside the code:\n' +
        "    // Stryker disable next-line <mutator>: <why it cannot be observed>\n" +
        /* ⚠️ **A STATIC MUTANT THAT THROWS AT IMPORT IS REPORTED `Survived`**
         * (measured 2026-09-14, `/tmp/cc-audit/static-probe`). A suite whose module
         * throws while loading fails no test, so Stryker's vitest runner saw
         * nothing killed: `define('')` at module level, `if (true) throw` and
         * `key !== ''` all came back `Survived` while vitest by hand failed the
         * file. A generated load probe that killed them was tried and REMOVED — it
         * made kills of its own where Vite excluded a test, where a DOM guard was
         * reversed, and broke modules that touch `window` at import. So nothing
         * passes differently: each static survivor is only named, with how to
         * tell the false kind from a real one. */
        staticSurvivors
          .map(
            (at) =>
              `  static: ${at} — a static mutant that throws while the module is imported is reported Survived by Stryker's vitest runner, because the suite fails to load; verify it by hand, and if it does throw, disable it beside the code with that reason\n`,
          )
          .join(''),
    )
  }
  return 1
}

/**
 * ⚠️ **ONE RUNNER COULD NOT HOLD A SWEEP, AND THE ONE CI JOB THAT TRIED HAD NEVER
 * RUN** (measured 2026-09-14). This branch changes 79 files carrying 15 898
 * whole-file mutants. Locally, with nine Stryker runners, `check-mutants.mjs`
 * alone took 18 min 5 s; CI gave the whole sweep one 4-vCPU runner and 45
 * minutes. So a sweep can be PLANNED once and swept in shards, each a checkout of
 * its own — and the three modes below exist to make that no weaker than one
 * sweep in one place:
 *
 * - `--plan` decides everything a sweep decides — the subjects, each one's
 *   content hash, the covering tests it runs against and the ones left out, its
 *   class and its mutant count — and assigns each a shard, into a manifest that
 *   is the same bytes for the same inputs. It records what it was decided FROM:
 *   the HEAD commit, the merge base, and the working tree against HEAD.
 * - `--shard i/N` DERIVES ALL OF IT AGAIN and refuses a checkout where anything
 *   differs, before it writes a result or takes the lock; then sweeps only its
 *   own files, writing each one's result the moment it has one, and a receipt
 *   once it has finished.
 * - `--aggregate` is the only mode that can say the sweep passed. It requires a
 *   receipt from every shard, and exactly one readable result — from the right
 *   plan, shard and content — for every planned file.
 *
 * The one-sweep-per-checkout lock is untouched: shards never share a checkout.
 */
async function planSweep({ manifest, shards, isolate, base, only, requireBase }, world) {
  const { root, stdout, commits, worktree, tracked } = world
  const { head, mergeBase } = committed(commits, base, requireBase)
  const tree = treeOf(worktree, root)
  const picked = chosen(world, base, only, requireBase).sort((a, b) => byName(a.name, b.name))
  const { found, rows } = inventory(picked, world)
  /* Where the plan may not be written: the rule its shards meet for `--results`
     — see `overlapOf` — because a shard leaves the manifest's own path out of
     drift detection too. Refused before a byte is written. */
  const trespass = overlapOf(manifest, { root, inputs: fingerprinted(rows, tree), tracked })
  if (trespass?.input !== undefined) {
    throw new Refusal(
      `check-mutants: --plan ${manifest} overlaps ${trespass.input}, an input this plan fingerprints — its shards leave the manifest out of drift detection, so an input there could change unseen; write the plan apart from every input`,
    )
  }
  if (trespass?.held !== undefined) {
    throw new Refusal(
      `check-mutants: --plan ${manifest} is a path git tracks — it holds ${trespass.held} — so a plan written there would replace a tracked file its shards then leave out of drift detection; write the plan where git tracks nothing`,
    )
  }
  const counted = []
  for (const row of rows) {
    const identities = await identifiedIn(path.join(root, row.path))
    const mutants = identities.length
    /* No mutant is nothing to run, whether or not a test reaches it: see `sweepChanges`. */
    counted.push({ ...row, class: mutants === 0 ? 'no-mutants' : row.tests.length > 0 ? 'mutated' : 'no-test-found', mutants, identities })
  }
  const assigned = assignShards(counted, shards, isolate)
  const plan = {
    version: RECORD_VERSION,
    head,
    mergeBase,
    worktree: tree,
    base,
    only,
    requireBase,
    shards,
    isolate,
    subjects: counted.map((row, at) => ({
      path: row.path,
      sha256: row.sha256,
      class: row.class,
      mutants: row.mutants,
      identities: row.identities,
      shard: assigned[at],
      tests: row.tests,
      testsDigest: row.testsDigest,
      leftOut: row.leftOut,
      through: row.through,
    })),
  }
  /* A plan the shards would refuse is this gate's defect, and is thrown here
     rather than met on every shard minutes later. */
  const problem = planProblem(plan)
  if (problem !== null) throw new Error(`check-mutants: the plan built for ${manifest} would not read back — ${problem}`)
  mkdirSync(path.dirname(path.resolve(manifest)), { recursive: true })
  writeFresh(manifest, `${JSON.stringify(plan, null, 2)}\n`)
  if (plan.subjects.length === 0) {
    stdout.write(`check-mutants: nothing changed to mutate — ${manifest} plans no file, over ${shards} shard(s)\n`)
    return 0
  }
  sayLeftOut(
    picked.map(({ at }) => at),
    found,
    stdout,
  )
  const alone = Math.min(isolate, plan.subjects.filter((subject) => weightOf(subject) > 0).length)
  stdout.write(
    `check-mutants: planned ${plan.subjects.length} changed file(s) over ${shards} shard(s) into ${manifest}:\n` +
      Array.from({ length: shards }, (_, at) => {
        const mine = plan.subjects.filter((subject) => subject.shard === at + 1)
        const toRun = mine.reduce((sum, subject) => sum + weightOf(subject), 0)
        return `  shard ${at + 1}/${shards} — ${mine.length} file(s), ${toRun} mutant(s) to run${at < alone ? ', a shard of its own' : ''}\n`
      }).join('') +
      "  Mutant counts are an estimate of what a shard costs, not a measure of it: one mutant cost about fifteen times as much in one measured file as in another. Every result records the file's measured duration.\n",
  )
  return 0
}

/** The version of every file the sharded modes write, and the only one they read. */
const RECORD_VERSION = 1

/** The commits `commits` says a checkout is at — refused in its own words when it cannot say. */
function committed(commits, base, requireBase) {
  try {
    return commits(base, requireBase)
  } catch (cause) {
    throw new Refusal(messageOf(cause))
  }
}

/** The working tree `worktree` reads at `root` — see `worktreeOf` — refused in its own words when it cannot say. */
function treeOf(worktree, root) {
  try {
    return worktree(root)
  } catch (cause) {
    throw new Refusal(`check-mutants: cannot read the working tree at ${root} — ${messageOf(cause)}`)
  }
}

/**
 * Each picked subject as a plan records it — content hash, covering tests and a
 * digest of their contents, the tests left out, and the modules it was reached
 * through, every path relative to `root` and every list in code-point order —
 * beside what `discover` found, for the run itself.
 */
function inventory(picked, world) {
  if (picked.length === 0) return { found: new Map(), rows: [] }
  const found = discover(
    picked.map(({ at }) => at),
    world,
  )
  const named = (file) => slashed(path.relative(world.root, path.resolve(file)))
  const listed = (list) => list.map(named).sort(byName)
  const rows = picked.map(({ name, at }) => {
    const { tests, leftOut, through } = found.get(at)
    const contents = tests.map((test) => [named(test), digestOf(readFileSync(test))]).sort(([a], [b]) => byName(a, b))
    return {
      path: name,
      sha256: digestOf(readFileSync(at)),
      tests: listed(tests),
      testsDigest: digestOf(JSON.stringify(contents)),
      leftOut: listed(leftOut),
      through: listed(through),
    }
  })
  return { found, rows }
}

/** `data`'s SHA-256, as hex. */
function digestOf(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Code-point order, which no locale can reorder: a plan is the same bytes on every runner. */
export function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** What a subject weighs in a shard: its mutants when a Stryker run will try them, and nothing when none will. */
function weightOf(subject) {
  return subject.class === 'mutated' ? subject.mutants : 0
}

/**
 * The shard, from 1, each of `subjects` is swept in: the `isolate` heaviest get a
 * shard of their own, and the rest go one at a time, heaviest first, to whichever
 * remaining shard is lightest — ties to the lowest shard, and equal weights in
 * path order, so the answer does not depend on the order `subjects` arrive in.
 *
 * ⚠️ **THE WEIGHT IS A MUTANT COUNT, AND A MUTANT COUNT IS AN ESTIMATE OF TIME.**
 * Measured 2026-09-14: `check-browser-safe.mjs`, 290 mutants, 17 s; and
 * `check-mutants.mjs`, 1 200 mutants, 18 min 5 s — about fifteen times the cost a
 * mutant. So the heaviest are isolated rather than trusted to balance, and every
 * result records its measured duration, which is what a better weight would be
 * built from. A file no Stryker run will try weighs nothing.
 */
export function assignShards(subjects, count, isolate = 0) {
  const order = subjects
    .map((subject, at) => ({ at, weight: weightOf(subject), path: subject.path }))
    .sort((a, b) => b.weight - a.weight || byName(a.path, b.path))
  const shards = []
  const load = Array.from({ length: count }, () => 0)
  let alone = 0
  for (const { at, weight } of order) {
    if (alone < isolate && weight > 0) {
      load[alone] = weight
      alone += 1
      shards[at] = alone
      continue
    }
    /* The lightest shard that is not one of the isolated ones — ties to the
       lowest, since only a strictly lighter one replaces the shard in hand.
       Scanned over the candidates THEMSELVES rather than counted up to `count`:
       as a bound, an off-by-one to `shard <= count` reads `load[count]`, which is
       `undefined` and is never less than anything, so it changes no answer and
       there is no test that could observe it. */
    let lightest = alone
    for (const [after, carried] of load.slice(alone).entries()) {
      if (carried < load[lightest]) lightest = alone + after
    }
    load[lightest] += weight
    shards[at] = lightest + 1
  }
  return shards
}

/**
 * One shard of a plan: re-derived, compared, and swept only if nothing differs.
 *
 * ⚠️ **A SHARD THAT RE-READ ITS SCOPE ON ITS OWN RUNNER COULD SWEEP A DIFFERENT
 * CHANGE UNDER THE PLAN'S NAME** (acceptance criterion a, 2026-09-14). Each shard
 * is a fresh checkout made minutes after the plan: another HEAD commit or merge
 * base, a file that changed, a test that appeared, gives it other subjects, other
 * covering tests or another assignment — and its results would still reconcile,
 * because they would be results. So everything the plan decided is decided again
 * here and compared, the working tree it was decided from included, and any
 * difference is refused by name before a result is written or the lock taken.
 * What is compared is exactly that: the HEAD commit, the merge base, the working
 * tree against HEAD, and each subject's inventory — never the base branch's tip
 * (see `commitsOf`).
 *
 * ⚠️ **AND A SHARD'S FINDINGS ARE ITS FILES, NOT ITS LOG** (criterion e). Every
 * assigned file leaves a result — whatever its outcome, the moment it has one —
 * holding Stryker's own report and the time it took; a shard that finished
 * leaves a receipt. A shard's exit covers its own files only, and says so: an
 * empty shard passes nothing (criterion b).
 */
async function shardSweep({ manifest, results, index, count }, world) {
  const { root, stdout, commits, worktree, tracked, clock } = world
  const { plan, digest } = readPlan(manifest)
  if (plan.shards !== count) {
    throw new Refusal(
      `check-mutants: --shard ${index}/${count} does not match ${manifest}, which was planned over ${plan.shards} shard(s)`,
    )
  }
  /* ⚠️ **`--results` COULD EXEMPT A REAL INPUT FROM DRIFT DETECTION** (second
   * review, 2026-09-14). A shard leaves its own results out of the working-tree
   * comparison, so `--results src` hid a change to `src/helper.testkit.ts`. So a
   * results directory inside the checkout may hold, and sit inside, nothing the
   * plan fingerprints — no subject, covering test or working-tree path — and git
   * may track nothing in it; either is refused before anything is written or
   * locked. The manifest's own exemption cannot hide an input the same way: what
   * sits at its path is the plan this shard just read. */
  const inputs = fingerprinted(plan.subjects, plan.worktree)
  const onManifest = overlapOf(manifest, { root, inputs, tracked })
  if (onManifest?.input !== undefined) {
    throw new Refusal(
      `check-mutants: --manifest ${manifest} overlaps ${onManifest.input}, an input it fingerprints — a shard leaves its manifest out of drift detection, so an input there could change unseen; keep the plan apart from every input`,
    )
  }
  if (onManifest?.held !== undefined) {
    throw new Refusal(
      `check-mutants: --manifest ${manifest} is a path git tracks — it holds ${onManifest.held} — and a shard leaves its manifest out of drift detection, so a tracked file there could change unseen; keep the plan where git tracks nothing`,
    )
  }
  const onResults = overlapOf(results, { root, inputs, tracked })
  if (onResults?.input !== undefined) {
    throw new Refusal(
      `check-mutants: --results ${results} overlaps ${onResults.input}, an input ${manifest} fingerprints — a shard leaves its own results out of drift detection, so an input there could change unseen; pass a directory apart from every input`,
    )
  }
  if (onResults?.held !== undefined) {
    throw new Refusal(
      `check-mutants: --results ${results} is a directory git tracks — it holds ${onResults.held} — and a shard's results belong in a directory of their own; pass one git does not track`,
    )
  }
  /* Results another run left would be read by the aggregate as this one's —
     refused, never removed. */
  const own = path.join(results, `shard-${index}`)
  if (existsSync(own)) {
    throw new Refusal(
      `check-mutants: ${own} already exists — a shard writes into a directory of its own, and results another run left there would be read as this one's; remove it, or pass another --results`,
    )
  }
  const here = { ...committed(commits, plan.base, plan.requireBase), worktree: treeOf(worktree, root) }
  const picked = chosen(world, plan.base, plan.only, plan.requireBase).sort((a, b) => byName(a.name, b.name))
  const { found, rows } = inventory(picked, world)
  /* What the sharded modes write into the checkout themselves — the plan's
     manifest, and this shard's results — is no difference in the tree. By real
     path, and without case where the checkout's filesystem drops it, so no alias
     of either exempts anything else; neither may overlap an input at all. */
  const top = realPathOf(root)
  const caseless = caselessAt(top)
  /* Asked whether each lies outside BEFORE it is slashed: `outsideCheckout` reads
     `path.relative`'s own separator, and a Windows `..\results` slashed first was
     no longer a path that climbs out. */
  const written = [manifest, results]
    .map((file) => path.relative(top, realPathOf(file)))
    .filter((name) => name !== '' && !outsideCheckout(name))
    .map(slashed)
  const differences = differencesFrom(plan, here, rows, written, caseless)
  const mine = plan.subjects.filter((subject) => subject.shard === index)
  const unrun = mine.filter((subject) => subject.class !== 'mutated')
  /* Counted only once nothing else differs: a file that changed may not be there to count. */
  const counts = new Map()
  for (const subject of differences.length === 0 ? unrun : []) {
    const started = clock()
    const mutants = await countedIn(path.join(root, subject.path))
    counts.set(subject.path, { mutants, durationMs: Math.round(clock() - started) })
    if (mutants !== subject.mutants) {
      differences.push(`${subject.path} has ${mutants} mutant(s) here, and the plan counted ${subject.mutants}`)
    }
  }
  if (differences.length > 0) {
    throw new Refusal(
      `check-mutants: this checkout is not the one ${manifest} was planned for, so shard ${index}/${count} would sweep something other than its plan — refused:\n` +
        differences.map((line) => `  ${line}`).join('\n'),
    )
  }

  /* ⚠️ **CLAIMING THE DIRECTORY WAS NOT ATOMIC** (third review, 2026-09-14): two
     runs of one shard could both find none, both make it, and write over each
     other. The parent is made, and the shard's own directory CLAIMED with one
     exclusive create — whoever loses that is refused, as a run finding a
     directory already there is. */
  mkdirSync(results, { recursive: true })
  try {
    mkdirSync(own)
  } catch (cause) {
    if (codeOf(cause) !== 'EEXIST') throw cause
    throw new Refusal(
      `check-mutants: ${own} already exists — a shard writes into a directory of its own, and results another run left there would be read as this one's; remove it, or pass another --results`,
    )
  }
  /* ⚠️ **THE CLAIM PROTECTED THE DIRECTORY ONLY AT THAT MOMENT** (fourth review,
     2026-09-14): the parent renamed and a link left in its place afterwards sent
     every later write somewhere else. What was claimed is remembered by identity,
     and every write asks whether it is still that directory.
     The two halves of that identity are read as ONE value: an inode number is
     unique only within its device, and comparing the device SEPARATELY left a
     condition no portable test can reach — it would need two filesystems whose
     inode numbers collide. */
  const claimed = directoryIdentity(statSync(own))
  const write = (file, record) => {
    if (directoryIdentity(statSync(own, { throwIfNoEntry: false })) !== claimed) {
      throw new Refusal(
        `check-mutants: ${own} is no longer the directory this shard claimed — something moved or replaced it while the shard was writing, and nothing more goes there`,
      )
    }
    writeFresh(file, `${JSON.stringify(record, null, 2)}\n`)
  }
  /* Every result this shard has written, so a shard that stops can mark them. */
  const writtenResults = []
  const resultOf = (subject, fields) => {
    const file = path.join(own, resultFileFor(subject.path))
    write(file, {
      kind: 'result',
      version: RECORD_VERSION,
      plan: digest,
      shard: index,
      subject: subject.path,
      sha256: subject.sha256,
      ...fields,
    })
    writtenResults.push(file)
  }
  const receipt = () =>
    write(path.join(own, 'receipt.json'), {
      kind: 'receipt',
      version: RECORD_VERSION,
      plan: digest,
      shard: index,
      count,
      subjects: mine.map((subject) => subject.path),
    })
  const scope = `shard ${index}/${count} of ${manifest}`
  const deferred = 'whether the sweep passed is for --aggregate to say, over every shard'
  if (mine.length === 0) {
    stdout.write(`check-mutants: ${scope} has no file to sweep — it passes nothing on its own; ${deferred}\n`)
    receipt()
    return 0
  }
  stdout.write(`check-mutants: ${scope} — ${mine.length} file(s) are this shard's; ${deferred}\n`)
  const inCheckout = (subject) => path.join(root, subject.path)
  sayLeftOut(mine.map(inCheckout), found, stdout)
  const noMutants = []
  const nothingToKill = []
  const noTestFound = []
  /* ⚠️ **AN INPUT COULD CHANGE AFTER THE SHARD'S ONE CHECK** (second review,
   * 2026-09-14): a helper edited before a later subject's run was swept under
   * the plan's name. So the checkout is asked again immediately before each
   * subject, and again after it — the HEAD commit, the merge base and the working
   * tree, which together determine everything else the plan decided. A difference
   * stops the shard by name; what it has written stays, marked as a stopped
   * shard's, and it leaves no receipt.
   *
   * ⚠️ **AND A FILE THE SHARD SKIPS GETS BOTH CHECKS TOO** (fourth review): one
   * counted as having no mutant was written up as a pass with neither, so a
   * `Stryker disable all` removed just after the count left a passing result, and
   * a receipt, for a file that by then had a mutant.
   *
   * ⚠️ **AND A SETTLE RUN IS A SECOND RUN, SO IT IS BRACKETED TOO** (2026-09-15):
   * before the first, BETWEEN the two, and after the second. A tree that changes
   * mid-settle stops the shard exactly as one that changes mid-sweep does. */
  const recheck = (named, when) => {
    const now = { ...committed(commits, plan.base, plan.requireBase), worktree: treeOf(worktree, root) }
    const lines = driftFrom(plan, now, written, caseless)
    if (lines.length === 0) return
    throw new Refusal(
      `check-mutants: the checkout changed while ${scope} was sweeping, so ${SWEPT_WHEN[when](named)} from something other than its plan — stopped:\n` +
        lines.map((line) => `  ${line}`).join('\n'),
      lines.join('; '),
    )
  }
  let swept = {}
  try {
    for (const subject of unrun) {
      recheck(subject.path, 'before')
      const { mutants, durationMs } = counts.get(subject.path)
      resultOf(subject, { outcome: subject.class, exitedCleanly: null, mutants, durationMs, report: null, settle: null })
      recheck(subject.path, 'after')
      /* A file with no mutant that tests DO reach had nothing to kill; one no test
         reaches is named for that as well — see `sweepChanges`. */
      if (subject.class === 'no-mutants') (subject.tests.length > 0 ? nothingToKill : noMutants).push(inCheckout(subject))
      else noTestFound.push([inCheckout(subject), mutants])
    }
    sayNoMutants(noMutants, stdout)
    const toRun = new Map(mine.filter((subject) => subject.class === 'mutated').map((subject) => [inCheckout(subject), subject]))
    if (toRun.size > 0) {
      swept = await strykerEach([...toRun.keys()], found, await testOptionsOf(root), world, {
        record: ({ subject, ...fields }) => resultOf(toRun.get(subject), fields),
        before: (at) => recheck(toRun.get(at).path, 'before'),
        between: (at) => recheck(toRun.get(at).path, 'between'),
        after: (at) => recheck(toRun.get(at).path, 'after'),
      })
    }
  } catch (cause) {
    if (cause instanceof Refusal) {
      // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — measured, both parse the same record
      for (const file of writtenResults) write(file, { ...JSON.parse(readFileSync(file, 'utf8')), stopped: cause.detail })
    }
    throw cause
  }
  receipt()
  return summarise({ ...swept, nothingToKill: [...nothingToKill, ...(swept.nothingToKill ?? [])], noTestFound }, world)
}

/**
 * What a shard was doing when it found the checkout changed, in its own words —
 * the three points a subject's sweep is bracketed at. Each says what the
 * difference would have made untrue, because "the tree changed" alone leaves a
 * reader to work out whether anything was swept from it.
 */
const SWEPT_WHEN = {
  before: (named) => `${named} and every file after it would be swept`,
  between: (named) => `${named}'s settle run would re-sweep it`,
  after: (named) => `${named} was swept`,
}

/**
 * What identifies the directory a shard claimed, as one value, or `null` where
 * nothing is at the path any more. Device and inode together, because an inode
 * number is unique only within its own device.
 */
function directoryIdentity(at) {
  return at === undefined ? null : JSON.stringify([at.dev, at.ino])
}

/** Whether a path `path.relative` gave from the checkout's root lies outside it — `..` as a whole part, not a name that begins with it. */
function outsideCheckout(relative) {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

/**
 * How the checkout's HEAD commit, merge base and working tree differ from the
 * plan's, each in words of its own — `written` being what the sharded modes
 * write into the checkout themselves.
 */
function driftFrom(plan, here, written, caseless) {
  const lines = []
  if (here.head !== plan.head) lines.push(`the HEAD commit differs: planned at ${plan.head}, here ${here.head}`)
  if (here.mergeBase !== plan.mergeBase) {
    lines.push(
      `the merge base with ${JSON.stringify(plan.base)} differs: planned at ${plan.mergeBase ?? 'none'}, here ${here.mergeBase ?? 'none'}`,
    )
  }
  const { within } = pathsAt(caseless)
  const ours = (name) => written.some((one) => within(name, one))
  const digestAt = (tree, name) => (Object.hasOwn(tree, name) ? tree[name] : undefined)
  const paths = new Set([...Object.keys(plan.worktree), ...Object.keys(here.worktree)])
  for (const name of [...paths].filter((one) => !ours(one)).sort(byName)) {
    if (digestAt(plan.worktree, name) !== digestAt(here.worktree, name)) {
      lines.push(`the working tree differs from the plan's at ${name}`)
    }
  }
  return lines
}

/** Every way this checkout differs from what `plan` decided, each in words of its own; none is the same checkout. */
function differencesFrom(plan, here, rows, written, caseless) {
  const lines = driftFrom(plan, here, written, caseless)
  const planned = new Map(plan.subjects.map((subject) => [subject.path, subject]))
  const found = new Map(rows.map((row) => [row.path, row]))
  for (const row of rows) {
    if (!planned.has(row.path)) lines.push(`${row.path} is a changed file here, and the plan does not hold it`)
  }
  for (const subject of plan.subjects) {
    const row = found.get(subject.path)
    if (row === undefined) {
      lines.push(`${subject.path} is in the plan, and is not a changed file here`)
      continue
    }
    if (row.sha256 !== subject.sha256) lines.push(`${subject.path} changed content since the plan`)
    if (!sameList(row.tests, subject.tests)) lines.push(`${subject.path} is reached by other covering tests than the plan's`)
    else if (row.testsDigest !== subject.testsDigest) lines.push(`${subject.path}: a covering test changed content since the plan`)
    if (!sameList(row.leftOut, subject.leftOut)) lines.push(`${subject.path} leaves out other source-reading tests than the plan's`)
    if (!sameList(row.through, subject.through)) lines.push(`${subject.path} is reached through other modules than the plan's`)
  }
  return lines
}

function sameList(a, b) {
  return a.length === b.length && a.every((one, at) => one === b[at])
}

/**
 * The only mode that can say a sharded sweep passed.
 *
 * ⚠️ **"EVERY SHARD PASSED" IS NOT "THE SWEEP PASSED"** (acceptance criteria b
 * and f, 2026-09-14). A shard that never ran, a result that never arrived or
 * arrived twice, one written for another plan, shard or content, and one that
 * cannot be read, each leave a planned file unaccounted for — or accounted for
 * wrongly — while every shard job is green. So this requires a receipt from
 * every shard and exactly one readable result for every planned file, names
 * everything else it finds, and claims no pass unless all of it holds. An
 * outcome is not taken on a shard's word either: a Stryker run's is derived
 * again from the report it carries.
 */
async function aggregateSweep({ manifest, results }, world) {
  const { root, stdout, stderr } = world
  const { plan, digest } = readPlan(manifest)
  if (statSync(results, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Refusal(`check-mutants: ${results} is not a directory of shard results, so nothing can be reconciled against ${manifest}`)
  }
  const planned = new Map(plan.subjects.map((subject) => [subject.path, subject]))
  const resultsOf = new Map(plan.subjects.map((subject) => [subject.path, []]))
  const receiptsOf = new Map(Array.from({ length: plan.shards }, (_, at) => [at + 1, []]))
  const problems = []
  for (const { file, regular } of filesUnder(results)) {
    const { record, problem } = recordIn(file, regular)
    if (problem !== undefined) {
      problems.push(`unreadable: ${file} — ${problem}`)
      continue
    }
    if (record.plan !== digest) {
      problems.push(`unexpected: ${file} — written for another plan`)
      continue
    }
    /* A stopped shard vouches for nothing: see `shardSweep`. */
    if (record.kind === 'result' && record.stopped !== undefined) {
      problems.push(`stopped: ${file} — written by shard ${record.shard}/${plan.shards}, which stopped before its end: ${record.stopped}`)
      continue
    }
    const misfit = record.kind === 'receipt' ? receiptMisfit(record, plan) : resultMisfit(record, planned, plan.shards)
    if (misfit !== null) {
      problems.push(`unexpected: ${file} — ${misfit}`)
    } else if (record.kind === 'receipt') {
      receiptsOf.get(record.shard).push(file)
    } else {
      const subject = planned.get(record.subject)
      const disagreement = disagreementOf(record, subject, root)
      /* Asked of every result, not only the ones that agree: `reportMismatch` is
         a question about the report and answers it whatever the outcome said, so
         a guard here was one nothing could be observed through. */
      const mismatch = reportMismatch(record, subject, root)
      if (disagreement !== null) problems.push(`unreadable: ${file} — ${disagreement}`)
      else if (mismatch !== null) problems.push(`mismatched: ${file} — report does not match the plan: ${mismatch}`)
      else resultsOf.get(record.subject).push({ file, record })
    }
  }
  for (const [shard, files] of receiptsOf) {
    if (files.length === 0) problems.push(`missing: shard ${shard}/${plan.shards} left no receipt — it did not finish`)
    if (files.length > 1) problems.push(`duplicated: shard ${shard}/${plan.shards} left ${files.length} receipts: ${files.join(', ')}`)
  }
  for (const subject of plan.subjects) {
    const found = resultsOf.get(subject.path)
    if (found.length === 0) {
      problems.push(`missing: ${subject.path} — no result from shard ${subject.shard}/${plan.shards} that reconciles with the plan`)
    }
    if (found.length > 1) {
      problems.push(`duplicated: ${subject.path} — ${found.length} results: ${found.map(({ file }) => file).join(', ')}`)
    }
  }

  const complete = problems.length === 0
  if (!complete) {
    stderr.write(
      `check-mutants: the shards do not account for every file in ${manifest} exactly once, so the sweep is not complete:\n` +
        problems.map((line) => `  ${line}\n`).join(''),
    )
  } else if (plan.subjects.length === 0) {
    stdout.write('check-mutants: nothing changed to mutate\n')
    return 0
  } else {
    stdout.write(`check-mutants: every file in ${manifest} has exactly one result, from ${plan.shards} shard(s) that each finished\n`)
  }
  const outcomes = { killed: [], nothingToKill: [], notRun: [], unkilled: [], timedOut: [], noTestFound: [], staticSurvivors: [] }
  const noMutants = []
  for (const subject of plan.subjects) {
    const found = resultsOf.get(subject.path)
    if (found.length !== 1) continue
    const [{ record }] = found
    const at = path.join(root, subject.path)
    if (record.outcome === 'no-mutants' && subject.tests.length === 0) noMutants.push(at)
    else if (record.outcome === 'no-test-found') outcomes.noTestFound.push([at, record.mutants])
    else if (record.outcome === 'no-mutants') outcomes.nothingToKill.push(at)
    else {
      /* Both runs, derived again here: what a shard's result says is never taken
         on its word — see `disagreementOf`, which has already required this to
         agree with the outcome the result carries. */
      const verdict = settledVerdict(at, record, record.settle)
      stdout.write(sayTimeouts(at, verdict))
      /* Named in both lists where it is both, exactly as a plain sweep names it. */
      if (verdict.repeated.length > 0) outcomes.timedOut.push([at, verdict.repeated])
      if (verdict.outcome !== 'timed-out') outcomes[SWEPT_AS[verdict.outcome]].push(at)
      for (const place of staticSurvivorsIn(at, [record.report, record.settle === null ? null : record.settle.report])) {
        outcomes.staticSurvivors.push(`${at}:${place}`)
      }
    }
  }
  sayNoMutants(noMutants, stdout)
  return summarise(outcomes, world, { complete, errors: 'Its own error is in the log of the shard that ran it' })
}

/**
 * Where each outcome of a Stryker run is summarised. `timed-out` is not here: a
 * file with a repeat is named for it whatever its outcome — see `strykerEach`.
 *
 * Neither is `nothing-to-kill`, which no Stryker run of a PLANNED file can end
 * in: `reportMismatch` requires the report to hold exactly the mutants the plan
 * counted, and a file the plan counted as `mutated` has at least one, so
 * `outcomeOf` always finds a status to answer from. A file with nothing to kill
 * is counted before any run is tried and named at `record.outcome` above. The
 * entry was here, unreachable, and `disagreementOf` refusing a result that
 * claims it is what holds this true — asserted, not remembered.
 */
const SWEPT_AS = { killed: 'killed', 'did-not-run': 'notRun', survived: 'unkilled' }

/**
 * Every file under `dir`, in code-point order of its PATH, each with whether it
 * is a regular file.
 *
 * ⚠️ **THE DIRENTS WERE SORTED AND THE PATHS WERE NOT**, which is a different
 * order and not the one this said it answered in: a walk that sorts each
 * directory's own entries reaches `s0/deep.json` before `s0.json` beside it,
 * because it descends at `s0` and `/` sorts above `.`. It also made the sort
 * unobservable on any filesystem that already lists a directory in order —
 * macOS and Windows both do — so nothing could hold it to either order.
 */
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? filesUnder(file) : [{ file, regular: entry.isFile() }]
    })
    .sort((a, b) => byName(a.file, b.file))
}

/** A result or a receipt read from `file`, as `{ record }`, or what is wrong with it, as `{ problem }`. */
function recordIn(file, regular) {
  /* Never opened: a FIFO would never answer. */
  if (!regular) return { problem: 'not a regular file' }
  if (!file.endsWith('.json')) return { problem: 'not a result or a receipt' }
  let record
  try {
    // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — measured, both parse the same record
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    return { problem: messageOf(cause) }
  }
  if (!isRecord(record) || (record.kind !== 'result' && record.kind !== 'receipt')) return { problem: 'not a result or a receipt' }
  const problem = record.kind === 'result' ? resultProblem(record) : receiptProblem(record)
  return problem === null ? { record } : { problem }
}

/** Why a readable result belongs to no planned file of this shard, or `null` when it does. */
function resultMisfit(result, planned, shards) {
  const subject = planned.get(result.subject)
  if (subject === undefined) return `${result.subject} is not in the plan`
  if (result.shard !== subject.shard) {
    return `${result.subject} is shard ${subject.shard}/${shards}'s, and this result says shard ${result.shard}`
  }
  if (result.sha256 !== subject.sha256) return `${result.subject} had other content when this result was written`
  return null
}

/** Why a readable receipt is not the one the plan's shard would leave, or `null` when it is. */
function receiptMisfit(receipt, plan) {
  if (receipt.count !== plan.shards || receipt.shard > plan.shards) {
    return `a receipt for shard ${receipt.shard}/${receipt.count}, and the plan has ${plan.shards} shard(s)`
  }
  const given = plan.subjects.filter((subject) => subject.shard === receipt.shard).map((subject) => subject.path)
  return sameList(receipt.subjects, given) ? null : `shard ${receipt.shard}/${plan.shards} names other files than the plan gave it`
}

/**
 * Why a result's outcome does not follow from what it carries and what the plan
 * counted, or `null` when it does. A Stryker run's outcome is derived again from
 * its own report, exactly as `outcomeOf` derived it on the shard.
 */
function disagreementOf(result, subject, root) {
  if (subject.class === 'mutated') {
    if (!SWEPT.has(result.outcome)) return `says ${result.outcome} for a file the plan counted as mutated`
    const verdict = settledVerdict(path.join(root, subject.path), result, result.settle)
    /* ⚠️ **A SHARD THAT DID NOT SETTLE MAY NOT BE BELIEVED ABOUT A TIMEOUT**
       (2026-09-15). Without this, a result carrying a wall-clock timeout and no
       settle run re-derives as the kill Stryker called it — which is precisely
       the weaker evidence the settle run exists to refuse, arriving through the
       one door the aggregate leaves open. */
    if (result.settle === null && verdict.unsettled > 0) {
      return `says ${result.outcome} over ${verdict.unsettled} wall-clock timeout(s) its shard never settled, and a timeout under load is not a kill`
    }
    return verdict.outcome === result.outcome ? null : `says ${result.outcome}, and its own report says ${verdict.outcome}`
  }
  if (result.outcome !== subject.class) return `says ${result.outcome} for a file the plan counted as ${subject.class}`
  return result.mutants === subject.mutants ? null : `counts ${shown(result.mutants)} mutant(s) in a file the plan counted ${subject.mutants} in`
}

/**
 * Why a Stryker run's report is not a report OF the file the plan counted, or
 * `null` when it is.
 *
 * ⚠️ **AN OUTCOME DERIVED FROM A REPORT SAID NOTHING ABOUT WHICH FILE THE REPORT
 * WAS OF** (review, 2026-09-14). A subject planned with 100 mutants passed with
 * an empty report, or with a single killed mutant; a stale report of other
 * source passed under a result whose own hash was right. So a report must carry
 * the source the plan hashed — a real report's `source` hashes to the file's
 * bytes, measured the same day — and exactly the mutants the plan counted. Both
 * counts leave `Ignored` mutants out: `mutantsIn` drops them, and a report lists
 * them — measured on `check-mutants.mjs` itself, 1 200 instrumented, 26
 * `Ignored`, 1 174 counted, and 1 174 in the real sweep's score table.
 *
 * A report of no file at all passes through: `outcomeOf` has already made that a
 * run that did not happen, which fails on its own.
 */
function reportMismatch(result, subject, root) {
  if (subject.class !== 'mutated') return null
  const at = path.join(root, subject.path)
  const against = { named: subject.path, sha256: subject.sha256, identities: subject.identities, whose: 'the plan' }
  const unlike = reportUnlike(reportEntryOf(at, result.report), against)
  /* A settle run is a run of the same file against the same plan, so its report
     answers to the same account — and a result carrying a first report of the
     planned file beside a settle report of something else would otherwise
     reconcile. */
  if (unlike !== null || result.settle === null) return unlike
  const settled = reportUnlike(reportEntryOf(at, result.settle.report), against)
  return settled === null ? null : `the settle run's report: ${settled}`
}

/**
 * Why `entry` — a report's account of one file — is not of what `whose` counted
 * in it, or `null` when it is: the source it carries must hash to the content
 * counted, and its mutants must be exactly the identities counted, `Ignored`
 * ones aside. A report of no file at all is no account, and says nothing here;
 * `outcomeOf` has already made that a run with no score.
 */
function reportUnlike(entry, { named, sha256, identities, whose }) {
  if (entry === null) return null
  if (typeof entry.source !== 'string') return `it carries no source for ${named}`
  if (digestOf(entry.source) !== sha256) return `its source of ${named} is not the content ${whose} hashed`
  const counted = countedByIdentity(identities)
  const reported = countedByIdentity(entry.mutants.filter((mutant) => !isRecord(mutant) || !NOT_A_MUTANT.has(mutant.status)))
  const either = new Map([...reported, ...counted].map(([key, { identity }]) => [key, identity]))
  for (const [key, identity] of [...either].sort(([, a], [, b]) => byIdentity(a, b))) {
    const want = counted.get(key)?.count ?? 0
    const got = reported.get(key)?.count ?? 0
    if (want === got) continue
    if (got === 0) return `it lacks the mutant ${namedIdentity(identity)}, which ${whose} counted`
    if (want === 0) return `it holds the mutant ${namedIdentity(identity)}, which ${whose} did not count`
    return `it holds the mutant ${namedIdentity(identity)} ${got} times, and ${whose} counted it ${want}`
  }
  return null
}

/** Identities, each with how many times it occurs: a set in which copies count. */
function countedByIdentity(identities) {
  const counted = new Map()
  for (const identity of identities) {
    const key = JSON.stringify(identityParts(identity))
    counted.set(key, { identity, count: (counted.get(key)?.count ?? 0) + 1 })
  }
  return counted
}

/** The one entry a report holds for `subject` with a list of mutants — `null` for exactly the reports `outcomeOf` scores as a run that did not happen. */
function reportEntryOf(subject, report) {
  const files = isRecord(report) ? report.files : undefined
  if (!isRecord(files)) return null
  const names = Object.keys(files)
  if (names.length !== 1 || path.resolve(names[0]) !== path.resolve(subject)) return null
  const entry = files[names[0]]
  return isRecord(entry) && Array.isArray(entry.mutants) ? entry : null
}

/** The outcomes a Stryker run ends in — see `settledVerdict` — and those of a file no run is tried against. */
const SWEPT = new Set(['killed', 'survived', 'did-not-run', 'nothing-to-kill', 'timed-out'])
const COUNTED = new Set(['no-test-found', 'no-mutants'])
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const DIGEST = /^[0-9a-f]{64}$/u

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWhole(value, least = 0) {
  return Number.isSafeInteger(value) && value >= least
}

function isPaths(value) {
  return Array.isArray(value) && value.every((one) => typeof one === 'string' && one !== '')
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value)
}

/** A mutant's identity as `mutantIdentitiesIn` writes one: a mutator, a replacement, and a location counted from 1. */
function isIdentity(value) {
  if (!isRecord(value) || typeof value.mutatorName !== 'string' || typeof value.replacement !== 'string' || !isRecord(value.location)) {
    return false
  }
  return [value.location.start, value.location.end].every((at) => isRecord(at) && isWhole(at.line, 1) && isWhole(at.column, 1))
}

/** A value as a refusal names it: never a whole object spelt out. */
function shown(value) {
  if (value === undefined) return 'missing'
  if (Array.isArray(value)) return 'a list'
  return isRecord(value) ? 'an object' : JSON.stringify(value)
}

/** The plan at `file` and the digest of its bytes — refused, by what is wrong, unless this gate wrote it. */
function readPlan(file) {
  let bytes
  try {
    bytes = readFileSync(file)
  } catch (cause) {
    throw new Refusal(`check-mutants: cannot read the plan ${file} — ${messageOf(cause)}`)
  }
  let plan
  try {
    plan = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Refusal(`check-mutants: ${file} is not a plan — ${messageOf(cause)}`)
  }
  const problem = planProblem(plan)
  if (problem !== null) throw new Refusal(`check-mutants: ${file} is not a plan this gate wrote — ${problem}`)
  return { plan, digest: digestOf(bytes) }
}

/**
 * What is wrong with a plan, or `null` when nothing is. Every field a shard or
 * the aggregate acts on is checked here, once, so neither acts on a value this
 * gate would never have written.
 */
function planProblem(plan) {
  if (!isRecord(plan)) return 'it is not an object'
  if (plan.version !== RECORD_VERSION) return `its version is ${shown(plan.version)}, and this gate reads version ${RECORD_VERSION}`
  if (typeof plan.head !== 'string' || !COMMIT.test(plan.head)) return `its head is ${shown(plan.head)}, which is not a commit`
  if (plan.mergeBase !== null && (typeof plan.mergeBase !== 'string' || !COMMIT.test(plan.mergeBase))) {
    return `its mergeBase is ${shown(plan.mergeBase)}, which is neither a commit nor null`
  }
  if (!isRecord(plan.worktree)) return `its worktree is ${shown(plan.worktree)}, which is not a map of paths`
  for (const [name, digest] of Object.entries(plan.worktree)) {
    if (name === '' || (digest !== null && !isDigest(digest))) {
      return `its worktree names ${JSON.stringify(name)} with ${shown(digest)}, which is neither a digest nor null`
    }
  }
  if (typeof plan.base !== 'string' || plan.base === '') return `its base is ${shown(plan.base)}, which is not a ref`
  if (plan.only !== null && (typeof plan.only !== 'string' || plan.only === '')) {
    return `its only is ${shown(plan.only)}, which is neither a substring nor null`
  }
  if (typeof plan.requireBase !== 'boolean') return `its requireBase is ${shown(plan.requireBase)}, which is neither true nor false`
  if (!isWhole(plan.shards, 1)) return `its shards is ${shown(plan.shards)}, which is not a count of shards`
  if (!isWhole(plan.isolate) || plan.isolate >= plan.shards) return `its isolate is ${shown(plan.isolate)}, which is not a whole number below its shards`
  if (!Array.isArray(plan.subjects)) return `its subjects is ${shown(plan.subjects)}, which is not a list`
  const seen = new Set()
  for (const [at, subject] of plan.subjects.entries()) {
    if (!isRecord(subject)) return `subject ${at + 1} is not an object`
    const name = subject.path
    if (typeof name !== 'string' || name === '') return `subject ${at + 1} has path ${shown(name)}, which is not a path`
    if (seen.has(name)) return `${name} is planned twice`
    seen.add(name)
    if (!isDigest(subject.sha256)) return `${name} has sha256 ${shown(subject.sha256)}, which is not a digest`
    if (subject.class !== 'mutated' && !COUNTED.has(subject.class)) return `${name} has class ${shown(subject.class)}, which this gate does not plan`
    if (!isWhole(subject.mutants)) return `${name} has mutants ${shown(subject.mutants)}, which is not a count`
    if (!isWhole(subject.shard, 1) || subject.shard > plan.shards) return `${name} has shard ${shown(subject.shard)}, and the plan has ${plan.shards} shard(s)`
    for (const key of ['tests', 'leftOut', 'through']) {
      if (!isPaths(subject[key])) return `${name} has ${key} ${shown(subject[key])}, which is not a list of paths`
    }
    if (!isDigest(subject.testsDigest)) return `${name} has testsDigest ${shown(subject.testsDigest)}, which is not a digest`
    /* No mutant is nothing to run whoever reaches it; with mutants, it is what
       reaches the file that decides — see `planSweep`. */
    const plans = subject.mutants === 0 ? 'no-mutants' : subject.tests.length > 0 ? 'mutated' : 'no-test-found'
    if (subject.class !== plans) {
      return `${name} is ${subject.class} with ${subject.tests.length} covering test(s) and ${subject.mutants} mutant(s), which this gate plans as ${plans}`
    }
    if (!Array.isArray(subject.identities) || !subject.identities.every(isIdentity)) {
      return `${name} has identities ${shown(subject.identities)}, which is not a list of mutants`
    }
    if (subject.identities.length !== subject.mutants) {
      return `${name} counts ${subject.mutants} mutant(s) and names ${subject.identities.length}`
    }
  }
  return null
}

/** What is wrong with a result a shard wrote, or `null`. */
function resultProblem(result) {
  const shared = sharedProblem(result)
  if (shared !== null) return shared
  if (typeof result.subject !== 'string' || result.subject === '') return `its subject is ${shown(result.subject)}, which is not a path`
  if (!isDigest(result.sha256)) return `its sha256 is ${shown(result.sha256)}, which is not a digest`
  const swept = SWEPT.has(result.outcome)
  if (!swept && !COUNTED.has(result.outcome)) return `its outcome is ${shown(result.outcome)}, which this gate does not write`
  if (swept ? typeof result.exitedCleanly !== 'boolean' : result.exitedCleanly !== null) {
    return `its exitedCleanly is ${shown(result.exitedCleanly)}, which does not go with ${result.outcome}`
  }
  if (result.mutants !== null && !isWhole(result.mutants)) return `its mutants is ${shown(result.mutants)}, which is not a count`
  if (!isDuration(result.durationMs)) return `its durationMs is ${shown(result.durationMs)}, which is not a duration`
  if (result.report !== null && !isRecord(result.report)) return `its report is ${shown(result.report)}, which is not a report`
  const settle = settleProblem(result.settle)
  if (settle !== null) return settle
  if (!swept && result.settle !== null) return `its settle is an object, and ${result.outcome} is no run to settle`
  if (result.stopped !== undefined && (typeof result.stopped !== 'string' || result.stopped === '')) {
    return `its stopped is ${shown(result.stopped)}, which is not a reason`
  }
  return null
}

/**
 * What is wrong with the settle run a result carries, or `null`.
 *
 * ⚠️ **A RESULT FROM BEFORE THE SETTLE RUN EXISTED CARRIES NO `settle` AT ALL,
 * AND `undefined` IS NOT `null`.** One would re-derive as whatever Stryker
 * called its timeouts, which is the weaker evidence this whole mechanism
 * removes — so a record that does not say either way is refused by name here,
 * rather than read as a sweep that had nothing to settle.
 */
function settleProblem(settle) {
  if (settle === null) return null
  if (!isRecord(settle)) return `its settle is ${shown(settle)}, which is neither a settle run nor null`
  if (typeof settle.exitedCleanly !== 'boolean') return `its settle.exitedCleanly is ${shown(settle.exitedCleanly)}, which is not an exit`
  if (!isDuration(settle.durationMs)) return `its settle.durationMs is ${shown(settle.durationMs)}, which is not a duration`
  if (settle.report !== null && !isRecord(settle.report)) return `its settle.report is ${shown(settle.report)}, which is not a report`
  return null
}

/**
 * Whether a value is a length of time this gate would have written.
 *
 * `Number.isFinite` does not coerce — unlike the global `isFinite` — so it
 * already answers `false` for everything that is not a number, and asking the
 * type first was a second test of the same fact that nothing could observe.
 */
function isDuration(value) {
  return Number.isFinite(value) && value >= 0
}

/** What is wrong with a receipt a shard wrote, or `null`. */
function receiptProblem(receipt) {
  const shared = sharedProblem(receipt)
  if (shared !== null) return shared
  if (!isWhole(receipt.count, 1)) return `its count is ${shown(receipt.count)}, which is not a count of shards`
  if (!isPaths(receipt.subjects)) return `its subjects is ${shown(receipt.subjects)}, which is not a list of paths`
  return null
}

/** What both kinds of record must hold: this gate's version, a plan's digest, and a shard. */
function sharedProblem(record) {
  if (record.version !== RECORD_VERSION) return `its version is ${shown(record.version)}, and this gate reads version ${RECORD_VERSION}`
  if (!isDigest(record.plan)) return `its plan is ${shown(record.plan)}, which is not a digest`
  if (!isWhole(record.shard, 1)) return `its shard is ${shown(record.shard)}, which is not a shard`
  return null
}

/** Each mode a command line can name, by name; a plain sweep names none. */
const MODES = { plan: planSweep, shard: shardSweep, aggregate: aggregateSweep }

// Stryker disable all: the two things a real sweep does that no test may — start Stryker, and take this checkout's own lock, which a live sweep holds while these very tests run in its sandbox. `run` takes both as parameters, and every decision about either is measured there.
/**
 * Stryker, run over one generated config: `true` when it exited 0.
 *
 * ⚠️ **WITH A TEMPORARY DIRECTORY OF ITS OWN, REMOVED WHEN THE RUN ENDS.**
 * Stryker ends a mutant that times out by restarting its test runner — killing
 * the process — and no hook in a killed process runs, so whatever the case in
 * flight had made under `tmpdir()` stayed there: once per timeout, however
 * carefully the test cleans up. Every process Stryker starts inherits this
 * directory as its `tmpdir()` instead, and it goes with the run.
 */
function strykerRun(config) {
  const temp = mkdtempSync(path.join(tmpdir(), 'check-mutants-stryker-'))
  try {
    execFileSync('npx', ['stryker', 'run', config], { stdio: 'inherit', env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp } })
    return true
  } catch {
    return false
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/** The lock's name inside the git directory — see `acquireLock`. Beside the one
 *  thing that reads it, since that is what decides whether anything can. */
const LOCK = 'check-mutants.lock'

/** This checkout's sweep lock, in its git directory — see `acquireLock`. */
function lockCheckout() {
  return acquireLock(execFileSync('git', ['rev-parse', '--git-path', LOCK], { encoding: 'utf8' }).trim())
}
// Stryker restore all

/**
 * The `test` block of `<root>/vitest.config.ts`, as Vitest itself loads it —
 * through Vite's config loader, so a value the file computes is read after it
 * is computed. `check-coverage` reads the same file the same way, for the same
 * reason: what is gated is what Vitest was configured with, not a copy of it.
 */
export async function loadTestConfig(root) {
  const file = path.resolve(root, 'vitest.config.ts')
  if (!existsSync(file)) {
    throw new Error(`${file}: no such file — the covering tests are run as this project runs them, and nothing says how`)
  }
  return (await loadConfigFromFile(AS_VITEST, file, path.resolve(root), QUIETLY)).config.test
}

/** The environment both config files are loaded in: the one Vitest loads them in, so a value either computes from it is the value a sweep runs under. */
const AS_VITEST = { command: 'serve', mode: 'test' }

/** And with Vite's own logging off, because a sweep's output is this gate's. */
// Stryker disable next-line StringLiteral: Vite's logger compares a level against `LogLevels[level]`, so one it does not know is `undefined` and suppresses every call exactly as `silent` does — measured against vite 7.3.6
const QUIETLY = 'silent'

/**
 * Vitest's bound for a test that declares none — restated, because Vitest does
 * not export it: 4.1.11 sets `testTimeout ??= browser.enabled ? 15e3 : 5e3`
 * inside `resolveConfig`, out of `configDefaults`' reach. A browser run cannot
 * reach this file's arithmetic, since `test.browser` is refused as a key it has
 * not been taught. `check-mutants.test.mjs` holds the number to what Vitest
 * itself resolves.
 */
export const VITEST_DEFAULT_TIMEOUT = 5_000

/** What the generated config may inherit from `vite.config.ts`'s `test` block — see `loadViteTestBlock`. */
const INHERITED = new Set(['exclude'])

/**
 * The `test` block of `<root>/vite.config.ts`, refused unless it holds only
 * what the generated config is merged in to inherit.
 *
 * ⚠️ **THAT BLOCK REACHED EVERY SWEEP, AND NOTHING READ IT.** `vitestConfigFor`
 * merges `vite.config.ts` whole, and Vite's `mergeConfig` CONCATENATES arrays:
 * an `include` there would have widened each subject's tests past its own, a
 * `setupFiles` would have run twice — inherited, and carried again from the
 * merged block `carriedTestOptions` reads — a `projects` would have undone the
 * flattening, and a `passWithNoTests` would have passed an empty run. Found
 * with the last of those by review on 2026-09-14. So the block may hold
 * `exclude`, which is what the merge is FOR, and anything else belongs in
 * `vitest.config.ts`, where a sweep reads and decides it.
 */
export async function loadViteTestBlock(root) {
  const file = path.resolve(root, 'vite.config.ts')
  if (!existsSync(file)) {
    throw new Error(`${file}: no such file — the generated config merges it, as vitest.config.ts does`)
  }
  const test = (await loadConfigFromFile(AS_VITEST, file, path.resolve(root), QUIETLY)).config.test ?? {}
  for (const key of Object.keys(test)) {
    if (!INHERITED.has(key)) {
      throw new Error(
        `vite.config.ts sets \`test.${key}\`, which the generated config would inherit through its merge without a sweep reading it — set it in vitest.config.ts, where a sweep reads it`,
      )
    }
  }
  return test
}

/** Per-test settings one run carries, so each covering test runs as its project runs it. */
const CARRIED = new Set(['environment', 'setupFiles', 'testTimeout'])

/**
 * Settings about a WHOLE run, which a sweep's run decides for itself.
 *
 * `passWithNoTests` above all: carried, an `include` that matched nothing would
 * be a pass — the one answer this gate exists to refuse. `include` is the
 * subject's own tests, `exclude` arrives with `vite.config.ts` itself,
 * `projects` is flattened below, and workers, output and coverage are
 * Stryker's to decide.
 */
const LEFT_BEHIND = new Set(['projects', 'include', 'exclude', 'passWithNoTests', 'coverage', 'maxWorkers', 'silent'])

/** What a project may set and still be flattened: which files are its own, and the two carried settings one run can widen to cover it. */
const PER_PROJECT = new Set(['name', 'include', 'exclude', 'environment', 'testTimeout'])

/**
 * What a sweep's vitest run carries from the project's own `test` block.
 *
 * ⚠️ **THE GENERATED CONFIG RESTATED THE PROJECT, AND GOT IT WRONG.** It wrote
 * `testTimeout: 15000` where `vitest.config.ts` gives the `scripts` and `app`
 * projects 60 s — every file in the first exercises a gate, and the second
 * mounts whole screens — and it dropped every plugin `vite.config.ts` declares
 * (see `vitestConfigFor`). A subject whose covering tests needed either could
 * fail its dry run, and the gate would report it as a run Stryker never
 * scored: loud, and wrong about why. Finding #11, 2026-09-14.
 *
 * So nothing is restated. The block is READ, and every setting in it is either
 * carried or deliberately left behind; one this has not been taught about is
 * REFUSED rather than dropped, because a per-test setting dropped in silence is
 * exactly how the 15 s bound went unnoticed. So is a project one run cannot
 * honour — one with a setting of its own that its files alone would get.
 *
 * ⚠️ **ONE RUN HAS ONE BOUND, SO IT IS THE LOOSEST ANY COVERING TEST RUNS
 * UNDER — AND THAT IS THE STRICT CHOICE, NOT THE LENIENT ONE.** A test the
 * clock stops FAILS, and a failing test kills the mutant: a bound tighter than
 * a project's own turns machine load into kills no assertion made. A mutant
 * that truly hangs is still stopped — by this bound or by Stryker's own
 * `timeoutMS`, whichever is shorter, and by `timeoutMS` alone when the loosest
 * bound is Vitest's `0` for none — and `outcomeOf` counts either as a kill.
 * This said "the loosest any project DECLARES" until 2026-09-14, which is not
 * the same set: see the note inside.
 */
export function carriedTestOptions(test) {
  if (test === null || typeof test !== 'object') {
    throw new Error('vitest.config.ts has no `test` block, so nothing says how its tests run')
  }
  for (const key of Object.keys(test)) {
    if (!CARRIED.has(key) && !LEFT_BEHIND.has(key)) {
      throw new Error(
        `vitest.config.ts sets \`test.${key}\`, which a sweep neither carries nor leaves behind — teach \`carriedTestOptions\` which it is`,
      )
    }
  }
  const projects = test.projects ?? []
  if (!Array.isArray(projects)) {
    throw new Error(
      `vitest.config.ts lists its projects as ${JSON.stringify(projects)}, and a sweep reads a list of inline projects`,
    )
  }
  const blocks = [test]
  for (const project of projects) {
    if (project === null || typeof project !== 'object' || project.extends !== true || project.test === null || typeof project.test !== 'object') {
      throw new Error(
        'vitest.config.ts has a project that does not extend the root `test` block, so the root’s settings are not its settings',
      )
    }
    const own = [
      ...Object.keys(project).filter((key) => key !== 'extends' && key !== 'test'),
      ...Object.keys(project.test).filter((key) => !PER_PROJECT.has(key)),
    ]
    if (own.length > 0) {
      throw new Error(
        `vitest.config.ts gives project \`${project.test.name}\` its own \`${own[0]}\`, which one run over every covering test cannot give to its files alone`,
      )
    }
    blocks.push(project.test)
  }
  for (const { testTimeout: bound } of blocks) {
    if (bound !== undefined && (typeof bound !== 'number' || Number.isNaN(bound))) {
      throw new Error(
        `vitest.config.ts gives \`testTimeout\` as ${typeof bound === 'number' ? String(bound) : JSON.stringify(bound)}, which is not a number of milliseconds`,
      )
    }
  }
  /* ⚠️ **WHAT A TEST RUNS UNDER, NOT WHAT A BLOCK SPELT.** Only spelt values
   * were compared, so a project that declared nothing — and ran under the
   * root's value, or Vitest's own — was left out of the comparison it belonged
   * to: an unspecified bound beside a project's `10` became 10 ms for every
   * covering test, and an unspecified environment beside a project's `jsdom`
   * became jsdom for all of them. Found by review on 2026-09-14. With projects,
   * the root block runs no test of its own and reaches one only through a
   * project that leaves the key unset; without them, it is the one run. */
  const runs = projects.length === 0 ? [test] : projects.map((project) => project.test)
  const effective = (key, otherwise) => runs.map((block) => block[key] ?? test[key] ?? otherwise)
  const declares = (key) => blocks.some((block) => block[key] !== undefined)
  const environments = [...new Set(effective('environment', configDefaults.environment))]
  if (environments.length > 1) {
    throw new Error(
      `vitest.config.ts runs its tests in ${environments.map((one) => `\`${one}\``).join(' and ')}, and one run has one environment`,
    )
  }
  /* ⚠️ **`0` IS NO BOUND, AND `Math.max` READ IT AS THE TIGHTEST.** Vitest's
   * runner bounds nothing for a value `<= 0` or `Infinity` — `withTimeout` in
   * `@vitest/runner` 4.1.11 — so a project with one is the loosest there is,
   * and is carried as the `0` that says so: `Infinity` has no JSON spelling. */
  const loosest = Math.max(...effective('testTimeout', VITEST_DEFAULT_TIMEOUT).map((bound) => (bound <= 0 ? Infinity : bound)))
  /* What the project leaves unsaid stays unsaid: Vitest's own default then
     applies here exactly as it does to every other run. */
  return {
    ...(declares('environment') ? { environment: environments[0] } : {}),
    ...(test.setupFiles === undefined ? {} : { setupFiles: test.setupFiles }),
    ...(declares('testTimeout') ? { testTimeout: loosest === Infinity ? 0 : loosest } : {}),
  }
}

/**
 * The vitest config one subject's run is handed: the project's own
 * `vite.config.ts`, the options `carriedTestOptions` read, and only `covering`.
 *
 * ⚠️ **IT WAS A PLAIN OBJECT, AND SO IT DROPPED EVERY PLUGIN.** `vitest.config.ts`
 * merges `vite.config.ts` in so that tests "see the same plugins and resolution
 * the app is built with" — `paperComposition()`, which is what resolves
 * `virtual:paper-composition`, and React's among them. The generated file did
 * not, and said it was "one import fewer to resolve in a sandbox".
 *
 * It merges now, with the same `mergeConfig` and from the same relative path
 * `vitest.config.ts` uses: the generated file sits beside it at the root, and
 * so at the root of Stryker's sandbox too. `mergeConfig` rather than a spread
 * because it REFUSES a config written as a function, where a spread would
 * quietly carry no plugins at all — the loud default over the quiet one.
 *
 * ⚠️ **AND WHAT A MERGE INHERITS, NOBODY READ.** `passWithNoTests` was left
 * out of what is carried, which kept `vitest.config.ts`'s `true` away — and
 * `vite.config.ts` declaring the same key would have handed it straight back
 * through this merge, turning an `include` that matched nothing into a pass.
 * Found by review on 2026-09-14. So the run says `false` ITSELF, which no
 * inherited value and no Vitest default can undo; and `loadViteTestBlock`
 * refuses the rest of that block before this is ever written, because an
 * inherited array is concatenated rather than overridden.
 */
export function vitestConfigFor(covering, carried) {
  return (
    "import { mergeConfig } from 'vitest/config'\n" +
    "import viteConfig from './vite.config'\n\n" +
    '/* Written by scripts/check-mutants.mjs for one subject, and removed when the sweep ends. */\n' +
    `export default mergeConfig(viteConfig, { test: ${JSON.stringify({ ...carried, passWithNoTests: false, include: covering }, null, 2)} })\n`
  )
}

/**
 * One sweep per checkout at a time: takes the lock at `file` and returns what
 * gives it back.
 *
 * ⚠️ **TWO SWEEPS IN ONE TREE DESTROYED EACH OTHER.** Both write
 * `vitest.mutants.mjs`, `stryker.mutants.json` and one report, and each deletes
 * `.stryker-tmp` whole after every subject — so a second run rewrote the first
 * one's test selection, took its report for its own, and removed the sandbox it
 * was running in. The names are fixed on purpose (`.gitignore` holds them), so
 * the sweeps are serialised instead: a second one is REFUSED, by pid and path,
 * rather than left to corrupt the first.
 *
 * The lock lives in the git directory — one per worktree, never copied into a
 * sandbox, never in `git status`. A lock whose pid is gone is a crashed sweep
 * and is taken over. One that cannot be read is refused, because its holder may
 * be between creating the file and writing its pid.
 *
 * ⚠️ **AND THE TAKEOVER ITSELF WAS A RACE THE LOCK EXISTS TO PREVENT.** Reading
 * the stale pid and removing the file are two steps, so two contenders could
 * both read it, both find it dead, and both remove and recreate — the second
 * unlinking the FIRST one's live lock on its way past. Both then swept the same
 * tree over the same three generated names, which is the whole failure this
 * lock was written for, reached through the recovery path.
 *
 * So a stale lock is removed only from inside `takeOver`, which holds a marker
 * created exclusively — one takeover at a time — and re-reads the holder under
 * it. Between that read and the removal nobody can create the lock, because the
 * stale file is still there; and a contender that arrives while the marker is
 * held is refused rather than allowed to delete anything. `alive` is a
 * parameter so a test can drive the interleaving at the one point it happens.
 *
 * `holderOf` is the read after a refused create, a parameter for the same
 * reason: the lock can go in the one line between that refusal and this read,
 * and the create that comes round again decides it. Nothing else can put a
 * test inside that line (2026-09-14).
 */
export function acquireLock(file, pid = process.pid, alive = isAlive, holderOf = lockHolder) {
  for (;;) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: 'wx' })
      return () => {
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: `force` decides only what a MISSING file does, and the line before has just read this one's pid
        if (lockHolder(file) === pid) rmSync(file, { force: true })
      }
    } catch (cause) {
      if (codeOf(cause) !== 'EEXIST') throw cause
    }
    const holder = holderOf(file)
    if (holder === undefined) continue
    if (holder === null || alive(holder)) throw heldBy(file, holder)
    takeOver(file, pid, alive)
  }
}

/** What a sweep is told when somebody else has the lock. */
function heldBy(file, holder) {
  return new Error(
    `another sweep ${holder === null ? '' : `(pid ${holder}) `}holds ${file} — wait for it, or remove the file if no sweep is running`,
  )
}

/**
 * Remove a crashed sweep's lock, under a marker only one sweep can hold.
 *
 * The marker is the compare-and-swap: whoever creates it exclusively is the
 * only one who may read the lock and then delete it, and the lock cannot change
 * hands in between because it is still on disk the whole time. A marker left
 * behind by a sweep killed mid-takeover is refused BY NAME rather than removed
 * — removing it would be the same unguarded delete one level up.
 */
function takeOver(file, pid, alive) {
  const marker = `${file}.takeover`
  try {
    writeFileSync(
      marker,
      // Stryker disable next-line StringLiteral: nothing reads a marker's contents — its NAME is the compare-and-swap, and the pid in it is for whoever finds one left behind
      `${pid}\n`,
      { flag: 'wx' },
    )
  } catch (cause) {
    if (codeOf(cause) !== 'EEXIST') throw cause
    throw new Error(
      `another sweep is taking ${file} over — wait for it, or remove ${marker} if no sweep is running`,
    )
  }
  try {
    const holder = lockHolder(file)
    /* Gone since: nothing to remove, and the caller's next create decides it. */
    if (holder === undefined) return
    if (holder === null || alive(holder)) throw heldBy(file, holder)
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: `force` decides only what a MISSING file does, and the read above has just found this one
    rmSync(file, { force: true })
  } finally {
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: `force` decides only what a MISSING file does, and this marker was created by the line that opened this block
    rmSync(marker, { force: true })
  }
}

/**
 * The pid a lock names; `null` when it names none, `undefined` when it is gone.
 *
 * ⚠️ **READ WITHOUT FOLLOWING A LINK, BECAUSE CREATING IT DOES NOT FOLLOW ONE.**
 * An exclusive create refuses any existing name, a dangling symlink included,
 * and a read that followed that link found nothing and answered "gone" — so
 * `acquireLock` retried the create, was refused again, and spun at full CPU
 * with nothing printed. Measured 2026-09-14. Both halves now see the link
 * itself, and a link is refused by name: no sweep ever writes one.
 *
 * ⚠️ **AND OPENED WITHOUT BLOCKING, BECAUSE A FIFO NEVER ANSWERS.** The
 * exclusive create refuses a FIFO's name like any other, and opening it to
 * read then waited for a writer that never came — the sweep hung before it
 * printed a word. Found by review on 2026-09-14, from the source. `O_NONBLOCK`
 * returns at once whatever is at the path, and only what `fstat` calls a
 * REGULAR file is read: a FIFO or a directory is refused by name, as a link is.
 * Any other failure to open — a lock file this user may not read — is thrown
 * as it came, and nothing is taken over.
 */
function lockHolder(file) {
  let descriptor
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    if (codeOf(cause) === 'ENOENT') return undefined
    if (codeOf(cause) === 'ELOOP') {
      throw new Error(`${file} is a symbolic link, which no sweep writes — remove it if no sweep is running`)
    }
    throw cause
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`${file} is not a regular file, which no sweep writes — remove it if no sweep is running`)
    }
    // Stryker disable next-line MethodExpression: `Number` ignores exactly the whitespace `trim` removes, so no lock file can be read differently for it
    const pid = Number(readFileSync(descriptor, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } finally {
    closeSync(descriptor)
  }
}

/** Signal 0 delivers nothing and says whether the process exists; EPERM means
 *  it does, under somebody else. */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return codeOf(cause) === 'EPERM'
  }
}

/**
 * Where each run's JSON report is written — and what tells a SCORED run from
 * one that never started.
 */
export const REPORT = 'stryker.mutants.report.json'

/** A run's JSON report, or `null` when there is none that parses. */
export function reportFrom(file) {
  try {
    // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — measured, both parse the same report
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * What one Stryker run amounted to, from its exit and its parsed JSON report
 * (`null` when it wrote none).
 *
 * ⚠️ **A CRASH WAS REPORTED AS A SURVIVOR.** Every non-zero exit went into
 * "a mutant survived in N file(s) — a test that cannot fail is not a test", and
 * Stryker exits non-zero for two unrelated reasons: a score under the break
 * threshold, and an error before any mutant ran. On 2026-09-13 both phase-17
 * sweeps died copying a dangling symlink into the sandbox — see `symlinksIn` —
 * and the gate told the reader three modules had tests that could not fail,
 * about modules no mutant had touched. That sends somebody hunting weak tests
 * that are not there, and it is the finding this gate exists to make, spent on
 * a sandbox error.
 *
 * THE REPORT IS THE WITNESS. The JSON reporter writes when mutation testing
 * completes — before the threshold is judged — and never when the run dies
 * earlier.
 *
 * ⚠️ **AND ITS PRESENCE WAS NOT ENOUGH — IT IS READ NOW.** An exit code and a
 * file existing were the whole test, so three runs were misnamed:
 *
 * - **Nothing scored passed.** Stryker breaks on `score < break`, and a file
 *   whose every mutant is a `RuntimeError` or `CompileError` scores `NaN`,
 *   which is not less than 100 — so it exits 0 and read as every mutant killed.
 *   Read in `@stryker-mutator/core` 10.0.0's `determineExitCode` and
 *   `mutation-testing-metrics` 3.8.4's default score.
 * - **A failure after a clean report was survivors** — a wrap-up or cleanup
 *   error pointed the reader at tests with nothing wrong in them.
 * - **A clean exit with no report was a pass.**
 *
 * So a survivor is a `Survived` or `NoCoverage` mutant in the report and
 * nothing else, and every other doubt is a run with no score. A module with no
 * mutants, or with every one disabled beside the code, has nothing left to
 * kill and passes: that is the escape hatch in the header, used as written.
 *
 * ⚠️ **AND WHAT THE REPORT DID NOT SAY WAS STILL READ AS A CLEAN SWEEP.**
 * Measured 2026-09-13: `{ files: {} }` — a run that mutated nothing — reached
 * the end with no survivor and no unscored mutant in it, which is exactly the
 * shape of a module whose every mutant was killed, so it exited 0. So did a
 * `files` entry that was not a file, a `mutants` that was not a list (both
 * contributed no statuses at all), and a status Stryker has never written
 * beside a real kill. Nothing is a pass here now unless it is POSITIVELY
 * understood: every file entry must carry a list of mutants, and every mutant a
 * status from the eight `@stryker-mutator/core` 10.0.0 writes.
 */
const KILLS = new Set(['Killed', 'Timeout'])
const SURVIVALS = new Set(['Survived', 'NoCoverage'])
/** Nothing to kill — Stryker was told to leave this mutant alone. */
const NOT_A_MUTANT = new Set(['Ignored'])
/** Known, and measuring nothing: the mutant never ran, or never compiled.
 *  Stryker leaves these out of the score, and a file that has one beside a kill
 *  was still scored. */
const NO_SCORE = new Set(['CompileError', 'RuntimeError'])
/**
 * Every status that is a VERDICT about one mutant. Stryker 10.0.0 writes one
 * more, `Pending`, and it is left out on purpose: a pending mutant is one the
 * run had not got to, so a report carrying one is a run in progress and nothing
 * in it is finished — not even the kills beside it.
 */
const VERDICTS = new Set([...KILLS, ...SURVIVALS, ...NOT_A_MUTANT, ...NO_SCORE])

/**
 * ⚠️ **AND NOTHING ASKED WHOSE REPORT IT WAS.** `{ files: { 'different.ts':
 * { mutants: [] } } }` had nothing left to kill, so it read as a pass for
 * whichever subject had just been run. Found by review on 2026-09-14. Stryker
 * is handed ONE file to mutate and names it relative to the directory it runs
 * in — `normalizeFileName(path.relative(process.cwd(), fileName))` in
 * `@stryker-mutator/core` 10.0.0's `mutation-test-report-helper.js` — which is
 * this gate's own. So a report of this run names `subject` and nothing else,
 * compared as the file each name resolves to; a report naming no file, another
 * file, or another file beside it has no score for `subject`.
 */
export function outcomeOf(subject, exitedCleanly, report) {
  const files = report === null || typeof report !== 'object' ? undefined : report.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return 'did-not-run'
  const names = Object.keys(files)
  /* A report about no file is a run that mutated nothing, whatever its exit —
     and one naming any file but the subject is not a report of this run. */
  if (names.length !== 1 || path.resolve(names[0]) !== path.resolve(subject)) return 'did-not-run'
  const file = files[names[0]]
  if (file === null || typeof file !== 'object' || !Array.isArray(file.mutants)) return 'did-not-run'
  const statuses = file.mutants.map((mutant) =>
    mutant === null || typeof mutant !== 'object' ? undefined : mutant.status,
  )
  if (statuses.some((status) => SURVIVALS.has(status))) return 'survived'
  if (statuses.some((status) => !VERDICTS.has(status))) return 'did-not-run'
  if (!exitedCleanly) return 'did-not-run'
  if (statuses.some((status) => KILLS.has(status))) return 'killed'
  /* ⚠️ **AND A SUBJECT WITH NOTHING TO KILL CAME BACK `killed`.** No mutant, or
   * every one `Ignored`, passes — the escape hatch above, used as written — but
   * under that name the summary said "every mutant was killed" about a module
   * no test had been tried against. Finding #9, 2026-09-14. It passes as
   * `nothing-to-kill` now, and `run` says so by name. */
  return statuses.some((status) => NO_SCORE.has(status)) ? 'did-not-run' : 'nothing-to-kill'
}

/**
 * Stryker's own words for a timeout it DETECTED, and the whole of how the two
 * kinds are told apart.
 *
 * ⚠️ **A `Timeout` COUNTS AS A KILL, AND LOAD TURNS SURVIVORS INTO TIMEOUTS**
 * (measured 2026-09-15). A sharded sweep of 86 files, under an external load
 * average of 50 to 170, passed 85 of them carrying 731 `Timeout` mutants. A
 * sample of those was replayed alone with a looser deadline, and the two kinds
 * behaved nothing alike:
 *
 * | `statusReason` | how many | what it is | what this gate does |
 * |---|---|---|---|
 * | `Hit limit reached (330901/330900)` | 56 of 731 | the mutated code ran a hundred times the original's hit count and was STILL going — a detection, and deterministic: 13 of 13 reproduced their exact counter across three concurrency settings and two files | counts it a kill, with no re-run |
 * | absent | 675 of 731 | the run's wall clock expired, which load alone causes: of 140 replayed, 137 resolved and **42 came back `Survived`** | re-runs the whole file once, alone — see `strykerEach` |
 * | anything else | none seen | a reason this gate has never been shown | fails closed: settled as a wall-clock one, and named as unrecognised if it repeats |
 *
 * A green sweep had therefore hidden about two hundred real survivors, most of
 * them in this file. A repeated wall-clock timeout is genuinely rare — 3 of 140,
 * all in one `isReactNode` loop, all provable non-termination — which is why the
 * second one is a failure rather than another re-run.
 *
 * ⚠️ **THE COUNTERS ARE NOT MATCHED, AND THAT IS DELIBERATE.**
 * `determineHitLimitReached` in `@stryker-mutator/api` 10.0.0 is the only thing
 * in the whole of Stryker that writes a reason beside a `Timeout` — the
 * wall-clock one, in `timeout-decorator.js`, writes the status alone and nothing
 * else — so the WORDS are the evidence and the numbers are the volatile half of
 * the sentence. A wording this gate does not know comes back `unclear`, which is
 * settled like a wall-clock one and never passes as a kill.
 */
const HIT_LIMIT = 'Hit limit reached ('

/** Which kind of timeout a `Timeout` mutant's `statusReason` says it is — see `HIT_LIMIT`. */
export function timeoutKindOf(reason) {
  if (reason === undefined) return 'wall-clock'
  return typeof reason === 'string' && reason.startsWith(HIT_LIMIT) ? 'hit-limit' : 'unclear'
}

/**
 * A report entry's mutants, each against its own identity, so one run's answer
 * for a mutant can be found from another's.
 *
 * One identity twice in a report is refused by `reportUnlike`, on both runs, so
 * which copy answers for it can decide nothing this gate goes on to say.
 */
function answersIn(entry) {
  if (entry === null) return new Map()
  return new Map(entry.mutants.filter(isRecord).map((mutant) => [keyOf(mutant), mutant]))
}

/** A mutant's identity as one string, so two reports' mutants can be matched by it. */
function keyOf(mutant) {
  return JSON.stringify(identityParts(mutant))
}

/** Where a mutant sits, as `line:column`. */
function placeOf(mutant) {
  return identityParts(mutant).slice(0, 2).join(':')
}

/**
 * A report entry's timeouts, split by what they measure: the ones Stryker
 * detected at the hit limit, which are kills, and the ones a settle run must
 * answer for.
 */
function timeoutsIn(entry) {
  if (entry === null) return { detected: [], unsettled: [] }
  const timeouts = entry.mutants.filter((mutant) => isRecord(mutant) && mutant.status === 'Timeout')
  const kinds = timeouts.map((mutant) => timeoutKindOf(mutant.statusReason))
  return {
    detected: timeouts.filter((_, at) => kinds[at] === 'hit-limit'),
    unsettled: timeouts.filter((_, at) => kinds[at] !== 'hit-limit'),
  }
}

/**
 * What the runs of one subject add up to. `first` and `settle` are each
 * `{ exitedCleanly, report, durationMs }`, and `settle` is `null` where the
 * first run left no wall-clock timeout to settle.
 *
 * The verdict, mutant by mutant:
 *
 * | in the first run | in the settle run | verdict |
 * |---|---|---|
 * | `Survived` or `NoCoverage` | anything | **a survivor** — an observed survivor is never averaged away |
 * | anything | `Survived` or `NoCoverage` | **a survivor**, including one the first run called `Killed` |
 * | a wall-clock timeout | a wall-clock timeout | **fails**: `timed-out`, named with where it sits |
 * | a wall-clock timeout | a kill, or a detection at the hit limit | the settle run's answer |
 * | a wall-clock timeout | no answer at all, or one that is no verdict | **fails**: `did-not-run` |
 * | a timeout at the hit limit | not re-run at all | a kill |
 *
 * And for the file: a survivor outranks a repeat as the OUTCOME, because a
 * survivor is the finding this gate exists to make and a repeat is the absence
 * of one — so `timed-out` is what a file with a repeat and nothing worse is.
 * That is a precedence between outcomes and not between findings: a file with
 * both is named in both lists, with both remedies — see `strykerEach`.
 *
 * A settle run that Stryker scored nothing for is `did-not-run` where it shows
 * no repeat, and `timed-out` where it shows one: both fail, and the repeat is
 * the half a reader can act on. Nothing here can pass on a settle run's silence
 * — the only outcomes a pass is claimed from are `killed` and `nothing-to-kill`.
 *
 * ⚠️ **AND SILENCE ABOUT ONE MUTANT WAS NOT SILENCE, SO AN UNRESOLVED TIMEOUT
 * PASSED** (2026-09-16). `outcomeOf` reads the settle run WHOLE, and a report
 * carrying thousands of kills beside one `RuntimeError` is a report with kills
 * in it — so where nothing repeated, a mutant the settle run crashed on or never
 * answered for was counted `unresolved`, printed in the line, and then decided
 * nothing. Found in this gate's own sweep: 4 wall-clock timeouts, a settle run
 * of 3 055 kills, 19 timeouts and one `RuntimeError` with two OOM-killed
 * runners in its log, so 3 repeated and 1 unresolved. Only the three repeats
 * failed the file. An unresolved mutant is a mutant with no score, which is what
 * `did-not-run` says, and it fails like every other no-score.
 */
export function settledVerdict(subject, first, settle) {
  const entry = reportEntryOf(subject, first.report)
  const { detected, unsettled } = timeoutsIn(entry)
  const ran = outcomeOf(subject, first.exitedCleanly, first.report)
  const counted = { detected: detected.length, unsettled: unsettled.length }
  if (settle === null) return { ...counted, outcome: ran, repeated: [], answers: null }
  const answers = answersIn(reportEntryOf(subject, settle.report))
  const tally = { killed: 0, survived: 0, repeated: 0, unresolved: 0 }
  const repeated = []
  for (const mutant of unsettled) {
    const answer = answers.get(keyOf(mutant))
    const status = answer === undefined ? undefined : answer.status
    const again = status === 'Timeout' && timeoutKindOf(answer.statusReason) !== 'hit-limit'
    if (SURVIVALS.has(status)) tally.survived += 1
    else if (again) {
      tally.repeated += 1
      repeated.push(unrecognised(answer))
    } else if (KILLS.has(status)) tally.killed += 1
    else tally.unresolved += 1
  }
  const settled = outcomeOf(subject, settle.exitedCleanly, settle.report)
  const survived = ran === 'survived' || settled === 'survived'
  const outcome = survived
    ? 'survived'
    : repeated.length > 0
      ? 'timed-out'
      : tally.unresolved > 0
        ? 'did-not-run'
        : settled
  return { ...counted, outcome, repeated, answers: tally, durationMs: settle.durationMs }
}

/**
 * Where a timeout that repeated sits — and, where its reason is one this gate
 * does not know, that it was settled as a wall-clock one rather than passed as a
 * kill. Fail-closed, and said out loud: a Stryker that changes its wording is a
 * finding here, not a silent reclassification.
 */
function unrecognised(mutant) {
  if (timeoutKindOf(mutant.statusReason) !== 'unclear') return placeOf(mutant)
  return `${placeOf(mutant)} — its reason, ${JSON.stringify(mutant.statusReason)}, is one this gate does not know, so it was settled as a wall-clock timeout`
}

/**
 * What a subject's timeouts amounted to, as one line, and nothing where it had
 * none. Printed wherever a verdict is reached — a sweep as it runs, the
 * aggregate as it reconciles — so a reader sees what the counts of a green sweep
 * are made of rather than trusting them.
 *
 * A verdict with timeouts to settle and no settle run never reaches here: such a
 * file is either `mismatched`, whose report says nothing, or a result the
 * aggregate has already refused — see `disagreementOf`.
 */
function sayTimeouts(subject, { detected, unsettled, answers, durationMs }) {
  if (detected === 0 && unsettled === 0) return ''
  const hit = `${detected} timeout(s) reached the original's hit limit, which is a detection and needs no re-run`
  if (answers === null) return `  ${subject}: ${hit}, and none was on the wall clock\n`
  return (
    `  ${subject}: ${hit}; ${unsettled} on the wall clock, re-run alone in ${durationMs} ms: ` +
    `${answers.killed} killed, ${answers.survived} survived, ${answers.repeated} repeated, ${answers.unresolved} unresolved\n`
  )
}

/**
 * Every symbolic link under `root`, as a `/`-separated path relative to it.
 *
 * ⚠️ **THE SANDBOX COPY DIES ON A SYMLINK, AND THE LIST OF THEM WAS WRITTEN BY
 * HAND.** `copyFile` refuses a live link with `ENOTSUP` — `.agents/skills` and
 * `.claude/skills/*` are why `.agents` and `.claude` are ignored below — and a
 * DANGLING one with `ENOENT`. On 2026-09-13 both phase-17 sweeps died on the
 * second kind: `src-tauri/gen/android/app/src/main/jniLibs/*\/libapp_lib.so`, links an
 * Android build leaves pointing into `src-tauri/target/<triple>/debug/`, whose
 * targets had since been cleaned away. Gitignored, so invisible to every other
 * check, and fatal to this one before a single mutant ran.
 *
 * A hand-kept list only ever learns the last link that broke it, so the links
 * are FOUND instead, at the start of every sweep. `node_modules` is skipped —
 * Stryker links it into the sandbox itself — as are `.git` and the build tree,
 * which are ignored below and are the two directories large enough to cost a
 * walk real time.
 */
export function symlinksIn(root) {
  const skipped = new Set(['.git', '.stryker-tmp', 'src-tauri/target'])
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const at = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.name === 'node_modules' || skipped.has(at)) continue
      if (entry.isSymbolicLink()) found.push(at)
      else if (entry.isDirectory()) walk(at)
    }
  }
  walk('')
  return found.sort()
}

/**
 * The deadline a sweep's FIRST run of each subject gets: Stryker's own
 * `timeoutFactor` of 1.5 and as many runners as the machine has.
 */
export const FIRST_RUN = { timeoutMS: 20_000 }

/**
 * And the deadline the settle run gets — one subject, alone, with room to
 * finish.
 *
 * ⚠️ **THE DEADLINE MATTERS AS MUCH AS THE CONCURRENCY** (measured 2026-09-15).
 * At this gate's own `timeoutMS: 20000, timeoutFactor: 1.5` with concurrency 1,
 * 4 of 32 `App.tsx` mutants still repeated — and two of those four were real
 * survivors, which a harsher deadline would have gone on calling kills. At
 * `30000` with a factor of 4 none repeated, and the run took about HALF the
 * time, because a repeated timeout costs a full deadline plus a runner restart.
 * Loosening it is therefore both the more truthful and the cheaper setting.
 *
 * ⚠️ **AND THE SETTLE RUN KEEPS THE RUNNERS, MEASURED 2026-09-16.** It was
 * written with `concurrency: 1`, on the reasoning that contention is what makes
 * a mutant miss its deadline. The measurement says the DEADLINE does that work:
 * alone at this gate's own 20 s and ×1.5, 4 of 32 mutants still repeated, and
 * at 30 s and ×4 none did. What one runner buys is cost — a whole second run of
 * the file, serialised. On a 4-vCPU Linux container, THIS file's first run is
 * 55 min at 4 runners and leaves 23 of 3 164 mutants timed out (0.7 %); the
 * settle run at one runner was still going an hour later, restarting its runner
 * on memory each time. So the settle run is an ordinary second run with the
 * looser deadline, which costs about what the first did and leaves the failure
 * mode fail-CLOSED: a wall-clock timeout that repeats is named and fails, and a
 * reader who suspects the machine rather than the mutant re-runs that file
 * alone. A CI shard therefore costs at most about twice its first run — 110 min
 * for this file against a step bounded at 210, measured rather than scaled.
 */
export const SETTLE_RUN = { timeoutMS: 30_000, timeoutFactor: 4 }

/**
 * Stryker's settings for one subject. `symlinks` is `symlinksIn`'s answer for
 * the tree, and `deadline` is `FIRST_RUN` or `SETTLE_RUN`.
 */
export function strykerConfig(subject, vitestConfig, symlinks = [], deadline = FIRST_RUN) {
  return {
    packageManager: 'pnpm',
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    /* `json` is what `outcomeOf` reads — every mutant's status in it. */
    reporters: ['clear-text', 'json'],
    jsonReporter: { fileName: REPORT },
    coverageAnalysis: 'perTest',
    mutate: [subject],
    vitest: { configFile: vitestConfig },
    /* ⚠️ Stryker copies the tree into a sandbox and `copyFile` REFUSES a
       symlink — `.agents/skills` and `.claude/skills/*` are symlinks here, and
       the run died on them with `ENOTSUP` before mutating anything. Every OTHER
       link in the tree arrives through `symlinks` — see `symlinksIn`. */
    ignorePatterns: [
      ...new Set([
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
        ...symlinks,
      ]),
    ],
    ...deadline,
    /* A survivor is the finding; the score is only how it is summarised. */
    thresholds: { high: 100, low: 100, break: 100 },
  }
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `run`, which is measured in-process
if (isProcessEntry(import.meta)) process.exitCode = await run(process.argv.slice(2), { root: '.' })
