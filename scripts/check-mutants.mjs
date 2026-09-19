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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'
import { loadConfigFromFile } from 'vite'
import { configDefaults } from 'vitest/config'
import { isProcessEntry } from './lib/entry.mjs'
import { hiddenLoads, runtimeSpecifiers } from './lib/specifiers.mjs'

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
  return identitiesOfSource(file, readFileSync(file, 'utf8'))
}

/**
 * The same, over a source that is not on this disk — the merge base's own
 * content, as the evidence carrying it must be reconciled against.
 *
 * ⚠️ **AND THE INSTRUMENTER IS THE ONE INSTALLED WHERE THIS RUNS, NOT THE ONE
 * BESIDE THIS FILE** (review, 2026-09-17). Resolved through `import.meta.url`,
 * the base's mutants were enumerated by HEAD's instrumenter while the base's own
 * Stryker executed them — two halves of one measurement from two installs, with
 * only a major version compared between them. `process.cwd()` is the checkout
 * being measured: the child that measures the merge base runs THERE, so it
 * enumerates and executes out of one install, and a plain sweep, a plan, a shard
 * and the aggregate all run in this checkout and are unchanged.
 */
export async function identitiesOfSource(name, source) {
  /* The file the require is anchored at, on a line of its own so the directive
     below covers it alone. Anchored instead at the directory — `""` — resolution
     starts one level up, which outside a sandbox finds nothing and fails loudly;
     but every mutant run happens INSIDE Stryker's sandbox, which sits inside the
     checkout, so one level up still reaches the checkout's own install and no
     run under Stryker can tell the two apart (a sweep left it surviving,
     2026-09-18; the merge base's apparent kill of it was not reproducible). */
  // Stryker disable next-line StringLiteral: indistinguishable inside a sandbox that sits in the checkout — see above
  const anchor = path.resolve('package.json')
  const core = createRequire(anchor).resolve('@stryker-mutator/core')
  const { Instrumenter } = await import(pathToFileURL(createRequire(core).resolve('@stryker-mutator/instrumenter')).href)
  const { mutants } = await new Instrumenter(QUIET).instrument(
    [{ name: path.resolve(name), mutate: true, content: source }],
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
 * A SURVIVOR'S identity — what a survivor at the merge base must share with one
 * here before it may answer for it: the mutator, the replacement, the text of
 * the node that was mutated, the text of the STATEMENT that node sat in, and the
 * chain of named declarations around it.
 *
 * ⚠️ **A MUTANT'S own identity — `mutantIdentitiesIn` above — CANNOT BE USED FOR
 * THIS, AND THE DIFFERENCE IS THE WHOLE POINT.** That one is a mutant's PLACE, so
 * that one run's report can be held to what another counted in the same bytes;
 * it is a line and a column, and every line below an inserted one moves. This one
 * is what was mutated, so that the same code compared across two commits — and,
 * since a file may be split, across two FILES — is recognised as the same debt.
 *
 * ⚠️ **THE REPLACEMENT ALONE LETS CHANGED CODE INHERIT OLD DEBT.** Measured
 * against the instrumenter on 2026-09-16: Stryker gives `return "old"` and
 * `return "new"` the same `StringLiteral` replacement `""` and the same
 * `BlockStatement` replacement `{}`. So the identity carries the ORIGINAL TEXT,
 * which is what separates "move the code, then fix it" from "move it and change
 * it in the same breath" — the first keeps its pairing, the second does not.
 *
 * ⚠️ **AND THE MUTATED TEXT ALONE IS OFTEN A FRAGMENT OF A STATEMENT.** What
 * Stryker replaces is not always what a reader would call the code: an
 * `OptionalChaining` mutant's text is the CALLEE, so two calls of one method with
 * different arguments shared an identity — and the acceptance run refused 14
 * survivors of an untouched file on collisions of exactly that shape. So the
 * statement the node sits in is part of the identity too; `statementAround` is
 * what it is and what it costs.
 *
 * ⚠️ **AND AN ORDINAL WITHIN A SCOPE TRANSFERS ACCEPTANCE.** Numbering a scope's
 * mutants makes `return "secret"` the first one the moment `audit("log")` above
 * it is deleted, so an accepted survivor on the deleted line answers for a new
 * one on the line that stayed. Nothing here counts occurrences: survivors that
 * share an identity are told apart by `matchedSurvivors` counting them on both
 * sides, never by where they sit.
 *
 * `mutant` is a mutant as a Stryker REPORT carries one, which is the convention
 * `mutantIdentitiesIn` answers in: lines and columns from 1, the end one past the
 * last character. `file` must be the subject's own name, because it decides how
 * the source is parsed — a `.tsx` read as a `.ts` is another tree.
 *
 * ⚠️ **THE TEXT IS COMPARED AS TOKENS, BECAUSE A REGULAR EXPRESSION OVER IT
 * ERASED MEANING AND STILL MISSED FORMATTING** (review, 2026-09-17). It read
 * `\s*[\n\r]\s*` as one space, which made all three of these wrong at once:
 *
 * | | before | now |
 * |---|---|---|
 * | a template literal holding a line break, against one holding a space | the SAME identity — two different strings, one debt | different: a literal's own text is kept exactly as it is |
 * | `return` ⏎ `1` against `return 1` | the same, though the first returns nothing and the second returns 1 | different: a line break between two tokens stays a line break |
 * | `a+b` against `a + b` | different, which is the formatting case the rule existed for | the same |
 *
 * So the text is rebuilt from the tokens the parse found: each token's own text
 * verbatim, and between two of them a single line break where the source had one
 * and a single space where it did not. Re-indenting is then still not rewriting —
 * a block that moves under a new guard, or a file run through a formatter, keeps
 * every line break it had and changes only the spaces, so it keeps its pairing —
 * while a formatter that JOINS two lines into one does change the identity, which
 * is a pairing lost to a reflow and is the side to be wrong on.
 *
 * What this still cannot tell apart is two strings differing only in a run of
 * spaces inside the quotes: both mutate to the same empty string, and a test that
 * notices neither is the same gap twice.
 */
export function survivorIdentity(mutant, source, file) {
  return identityIn(mutant, parsedSource(source, file))
}

/**
 * A source parsed ONCE — its tree and every token in it — for every mutant of it
 * to be identified against.
 *
 * ⚠️ **IT WAS PARSED PER MUTANT, AND A BASE NO TEST REACHES TAKES THAT PATH FOR
 * EVERY MUTANT IT HAS** (review, 2026-09-17). A file of a thousand mutants was a
 * thousand parses of the same bytes. Passed as a value rather than remembered in
 * a cache of its own, because a cache is unobservable: every mutant of one would
 * survive, and this gate may not hold a mutant nothing can kill.
 */
export function parsedSource(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
  return { tree, file, source, tokens: tokensOf(tree) }
}

/** One mutant's identity against a source already parsed — see `survivorIdentity`, which is this over one mutant. */
function identityIn(mutant, parsed) {
  const [start, end] = positionsOf(parsed.tree, mutant, parsed.file)
  return {
    mutatorName: mutant.mutatorName,
    replacement: mutant.replacement,
    original: tokenisedBetween(parsed, start, end),
    statement: statementAround(parsed, start, end),
    scope: scopeAround(parsed.tree, start, end),
  }
}

/**
 * Every token of `tree` that has any text, in the order they sit in, each as the
 * two offsets it spans. Whatever is BETWEEN two of them is whitespace or a
 * comment, which is what `tokenisedBetween` is left free to normalise.
 */
function tokensOf(tree) {
  const found = []
  const walk = (node) => {
    const children = node.getChildren(tree)
    if (children.length === 0) {
      /* The end-of-file token spans nothing, and a token of no text would put a
         separator into the answer for a token nobody wrote. */
      if (node.getEnd() > node.getStart(tree)) found.push([node.getStart(tree), node.getEnd()])
      return
    }
    for (const child of children) walk(child)
  }
  walk(tree)
  return found
}

/**
 * The text between two offsets as an identity compares it: each token verbatim,
 * separated by one line break where the source had one between them and one
 * space where it did not — see `survivorIdentity`.
 *
 * The LINE MAP answers whether there was a break, rather than a search for a
 * character: it is the same map `positionsOf` reads the mutant's own place out
 * of, so a paragraph separator and a lone carriage return count here exactly as
 * they count there.
 */
function tokenisedBetween({ tree, source, tokens }, start, end) {
  const lineAt = (at) => tree.getLineAndCharacterOfPosition(at).line
  const parts = []
  let after = null
  for (const [from, to] of tokens) {
    if (to <= start || end <= from) continue
    if (after !== null) parts.push(lineAt(from) > lineAt(after) ? '\n' : ' ')
    parts.push(source.slice(Math.max(from, start), Math.min(to, end)))
    after = to
  }
  return parts.join('')
}

/**
 * Where a mutant's location falls in the source, as two offsets.
 *
 * TypeScript's own line map is what answers, rather than arithmetic over `\n`
 * here: it counts a paragraph separator and a lone carriage return as line
 * breaks, which is the set Babel counts and so the set the instrumenter's
 * locations were made against. It REFUSES a line or a column that is at no place
 * in the text — measured 2026-09-16, every one of a line past the end, a negative
 * line, a column past the line's own end and a missing number throws — so a
 * location that does not belong to this source is named here rather than sliced
 * into an empty string that would then match every other empty one.
 */
function positionsOf(tree, mutant, file) {
  try {
    const { start, end } = mutant.location
    return [
      ts.getPositionOfLineAndCharacter(tree, start.line - 1, start.column - 1),
      ts.getPositionOfLineAndCharacter(tree, end.line - 1, end.column - 1),
    ]
  } catch (cause) {
    throw new Error(`check-mutants: ${namedIdentity(mutant)} is at no place in ${file} — ${messageOf(cause)}`)
  }
}

/**
 * The STATEMENT the text between two offsets sits in, as an identity compares it
 * — the nearest one, looking outward from the mutated text itself, and never
 * past the scope that text sits in.
 *
 * ⚠️ **WITHOUT IT, TWO CALLS OF ONE METHOD ARE ONE DEBT.** What Stryker mutates
 * is often a fragment that says nothing about the statement it belongs to: an
 * `OptionalChaining` mutant's text is the CALLEE, so
 * `noteRenderer?.setAttribute('max-column-count', '1')` and
 * `noteRenderer?.setAttribute('flow', 'scrolled')` had one identity between them
 * — and the acceptance run billed a developer for both, for a file the change
 * had added a comment to. Measured 2026-09-17: of the 14 survivors that run owed,
 * every one was a collision this separates or a repetition `matchedSurvivors`
 * now counts.
 *
 * ⚠️ **AND THE WALK STOPS AT THE MUTANT'S OWN SCOPE, BECAUSE A CLASS IS A
 * STATEMENT TOO.** `ts.isStatement` is true of a `ClassDeclaration` and of a
 * `FunctionDeclaration`, so a mutant sitting in no ordinary statement — a class
 * field's initialiser, a default parameter's value — would take the whole
 * declaration's text: measured on `src/kernel/ui/reader/session.ts`, whose
 * `#disposed = false` would have carried an identity of 68 593 characters, re-billed
 * by every edit anywhere in the class. That is the complaint this comparison
 * exists to answer, so the answer there is the last thing the walk stood on
 * instead — the field, the parameter — which is the smallest thing written around
 * the mutant that its scope is made of.
 *
 * Where there is neither — a mutant OF a whole arrow, or a span covering parts of
 * two declarations — the mutated text answers for itself, which is what the
 * identity held before this field existed. `scope` is what tells two of those
 * apart.
 *
 * The text is rebuilt from the parse's own tokens, exactly as `original` is, so a
 * statement that moved under a new guard or through a formatter keeps its pairing
 * and one whose tokens changed does not.
 *
 * ⚠️ **WHAT IT COSTS IS THAT A STATEMENT IS AS BIG AS IT IS.** A mutant on the
 * condition of an `if` carries the whole `if` — its body included — so an edit
 * inside that body re-bills the condition's survivors. Measured 2026-09-17, the
 * statement runs past 300 characters for a tenth of the mutants in `session.ts`,
 * an eighth of this file's, and a quarter of `kernel/ui/state.ts`'s, where a
 * `switch` carries every mutant of every case it holds. Taking a statement's
 * HEADER instead was considered and not done: it would make `if (a) return x` and
 * `if (a) return y` one identity again, which is the collision this field exists
 * to end.
 *
 * ⚠️ **AND A COMMENT WRITTEN INSIDE A STATEMENT IS AN EDIT TO IT.** A statement's
 * span begins AFTER its leading trivia, so a comment between two statements
 * changes no identity — which is the premise of the acceptance run, and is
 * measured. One written on its own line INSIDE a statement puts two of its tokens
 * on two lines where they sat on one, so the statement's text changes and every
 * survivor in it is re-billed. A comment cost something before this field only
 * where the mutated text ITSELF spanned the break; now it costs the statement.
 */
function statementAround(parsed, start, end) {
  const { tree } = parsed
  const holding = (node) => ts.forEachChild(node, (child) => (child.getStart(tree) <= start && end <= child.getEnd() ? child : undefined))
  /* `found` is the nearest statement seen INSIDE the scope currently being
     walked, and `below` the first node under that scope — both forgotten at each
     scope the walk enters, which is what keeps an outer statement from answering
     for a mutant in an inner scope. Recursion rather than a loop with a guard, for
     `scopeAround`'s reason: each step takes a child of the node before it, so a
     tree of finite depth ends the walk. */
  const under = (node, found, below) => {
    const child = holding(node)
    if (child === undefined) return found ?? below ?? null
    if (SCOPES.has(child.kind)) return under(child, null, null)
    if (ts.isStatement(child)) return under(child, child, child)
    return under(child, found, below ?? child)
  }
  const statement = under(tree, null, null)
  if (statement === null) return tokenisedBetween(parsed, start, end)
  return tokenisedBetween(parsed, statement.getStart(tree), statement.getEnd())
}

/**
 * The named declarations enclosing the text between two offsets, outermost
 * first — a class, then its method, then a function nested in that.
 *
 * ⚠️ **THE INNERMOST NAME ALONE IS NOT A PLACE.** Two classes may each have a
 * `read`, and a `read` nested in `outer` is not the one nested in `other`; with
 * only the last name, the same three lines in either would answer for the other.
 *
 * The walk descends into the mutated node itself where that node is a scope — an
 * `ArrowFunction` mutant covers a whole arrow — so `const pick = () => …` and
 * `const other = () => …` are told apart though their text is the same.
 *
 * Recursion rather than a loop with a guard: each step takes a child of the node
 * before it, so a tree of finite depth ends the walk. A mutant that stopped it
 * ending would overflow the stack, which fails a test rather than hanging a
 * sweep — the trap `levelsAbove` records, avoided by having no turn to stay in.
 */
function scopeAround(tree, start, end) {
  const holding = (node) => ts.forEachChild(node, (child) => (child.getStart(tree) <= start && end <= child.getEnd() ? child : undefined))
  const under = (node) => {
    const child = holding(node)
    if (child === undefined) return []
    const name = scopeNameOf(child, node)
    return name === null ? under(child) : [name, ...under(child)]
  }
  return under(tree)
}

/** The declarations that make a scope of their own — a class, a function, a method however it is spelt. */
const SCOPES = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.SetAccessor,
])

/**
 * What a node is CALLED where it makes a scope, and `null` where it makes none:
 * its own name, else the name of whatever it is declared as, else its kind.
 *
 * The middle one is what most of this tree needs — nearly every function here is
 * an arrow given to a `const` — and without it every one of them would be the
 * same anonymous scope, so two identical expressions in two different functions
 * would share an identity and neither could answer for the other.
 *
 * The last one keeps a genuinely anonymous scope from vanishing: a callback is
 * `ArrowFunction`, a constructor `Constructor`.
 *
 * ⚠️ **AND THE KIND ALONE LET A DELETED CALLBACK PAY FOR A NEW ONE** (review,
 * 2026-09-17, reproduced against the real instrumenter). `scopeAround` keeps only
 * the scopes it passes through, so the CALL an anonymous callback is passed to is
 * discarded — and with it the only thing that told two of them apart:
 *
 * | | |
 * |---|---|
 * | at the merge base | `function f() { first(() => false); second(() => false) }` |
 * | here | `function f() { first(() => false); third(() => false) }` |
 * | what the scope said | `["f","ArrowFunction"]` for all four, and the statement is `false` for all four — 2 authorised, 0 added |
 *
 * `second`'s deleted callback paid for `third`'s new one, which is the laundering
 * the statement answers everywhere a statement exists — and inside a callback
 * body there is no statement above it but the callback itself. So an anonymous
 * scope carries WHAT HOLDS IT: `ArrowFunction in first` is not
 * `ArrowFunction in third`.
 *
 * ⚠️ **AND IT IS THE CALLEE'S OWN SPELLING, NEVER THE CALL'S TEXT.** A call's
 * text holds every argument, the callback among them, so taking it would put a
 * scope's whole body inside the identity of every mutant in it — the 68 593-character
 * identity `statementAround` exists to avoid, arriving through the fix. A callee
 * that is not a name answers with its KIND, so nothing here grows with the code
 * around it.
 *
 * What is left indistinguishable is narrower than it was and is still real: two
 * identical callbacks passed to one call, which is why `matchedSurvivors` pairs a
 * colliding group by COUNT rather than guessing which of them is which.
 */
function scopeNameOf(node, parent) {
  if (!SCOPES.has(node.kind)) return null
  return node.name?.text ?? declaringName(parent) ?? anonymousName(node, parent)
}

/** What a nameless scope is called: its kind, and the call that holds it where one does — see `scopeNameOf`. */
function anonymousName(node, parent) {
  const kind = ts.SyntaxKind[node.kind]
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return kind
  /* ⚠️ **TWO CALLBACKS TO ONE CALL SHARED ONE NAME, AND PERMISSION PASSED
     BETWEEN THEM** (a second opinion's fifth round, 2026-09-17, reproduced with
     real instrumenter mutants). `p.then(onResolve, onReject)` gave both arrows
     the same `ArrowFunction in p.then`, so a change that swaps the two bodies —
     updating both tests with them, so both suites pass — had the success
     callback's new survivor paid for by the rejection callback's old one. Four
     survivors, all four authorised, and one of them genuinely new.
     `bus.on("publish", …)` beside `bus.on("delete", …)` collided the same way.

     Two things separate them, and neither grows with the code inside the
     callback — which is the whole constraint here, since an identity that
     carries a function body changes whenever anything in it is edited: WHERE the
     callback sits in the argument list, which is what distinguishes `then`'s two
     roles, and the call's own LITERAL arguments, which is what distinguishes one
     registration from another. */
  const args = parent.arguments ?? []
  const at = args.indexOf(node)
  const where = at === -1 ? '' : ` ${at + 1}/${args.length}`
  return `${kind}${where} in ${calledName(parent.expression)}(${literalArguments(args).join(', ')})`
}

/**
 * A call's arguments that are literals, as their own text — bounded, because an
 * identity that grows with the source is one that changes when anything near it
 * is edited. Anything that is not a literal contributes nothing: its text is
 * whatever expression was written, which is exactly what must not be in here.
 */
function literalArguments(args) {
  return args
    .filter((one) => ts.isStringLiteralLike(one) || ts.isNumericLiteral(one) || one.kind === ts.SyntaxKind.TrueKeyword || one.kind === ts.SyntaxKind.FalseKeyword)
    /* ⚠️ **NEVER `getText()`, WHICH NEEDS A NODE'S SOURCE FILE AND CRASHED THE
       SWEEP** (2026-09-17, found by the first sharded run that ever completed).
       `getText()` reads `node.getSourceFile().text`, and a node reached the way
       these are has no source file bound to it: it threw `Cannot read properties
       of undefined (reading 'text')` out of TypeScript, out of `anonymousName`,
       and took the whole shard down — no receipt, and an aggregate that could
       only say the sweep was incomplete. Every literal carries its own value
       without asking the tree for it, so nothing here needs the tree. */
    .map((one) => {
      if (ts.isStringLiteralLike(one)) return JSON.stringify(one.text.slice(0, 40))
      if (ts.isNumericLiteral(one)) return one.text
      return one.kind === ts.SyntaxKind.TrueKeyword ? 'true' : 'false'
    })
}

/**
 * How a callee is spelt, in as many characters as the name itself and no more: a
 * name, a chain of property accesses ending in one, and the KIND of anything
 * else — a call, an element access, a parenthesised expression — because those
 * carry text that grows with the code inside them.
 *
 * Recursion rather than a loop with a guard: each step takes the expression
 * BEFORE the dot, so a chain of finite length ends the walk.
 */
function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return `${calledName(expression.expression)}.${expression.name.text}`
  return ts.SyntaxKind[expression.kind]
}

/** The name the declaration holding a nameless class or function gives it, and nothing where it gives none. */
function declaringName(parent) {
  const declares = ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
  return declares ? parent.name.text : undefined
}

/**
 * Which survivors HERE the merge base answers for, and which it does not: a
 * one-to-one pairing over `survivorIdentity`, and a reason for every survivor
 * left over.
 *
 * Each side is a list of `{ file, identity }`; a survivor HERE carries `from` as
 * well — the base file that may answer for it, which is its own path where the
 * base has that file, the file git says it was renamed or copied from where it
 * does not, and `null` where it is new. Every `from` named must be a file that
 * was MEASURED at the base: one that was not has no survivors here, so it answers
 * for nothing, which fails closed.
 *
 * ⚠️ **ONE SURVIVOR AT THE MERGE BASE ANSWERS FOR AT MOST ONE HERE, WHATEVER
 * FILE IT LANDS IN.** Without that, one accepted survivor copied into four files
 * is four accepted survivors, and a duplication launders debt it did not have.
 * So each is spent as it answers, and what is left over is named with how many
 * there were and where.
 *
 * ⚠️ **AND A FILE TAKES ITS OWN SURVIVORS BEFORE A FILE COPIED FROM IT** — the
 * two passes below. A change that copies `session.ts` into `sessionCopy.ts`
 * leaves `session.ts` exactly as it was, so its own survivors are plainly the
 * same debt; matching by origin alone would let the COPY take them and bill the
 * untouched file for what it has always owed.
 *
 * ⚠️ **A GROUP THAT STILL COLLIDES IS COUNTED, AND THE COUNT IS THE EVIDENCE.**
 * The laundering this rule was written against was a count over an identity too
 * COARSE to carry the call it sat in — reproduced against the real instrumenter:
 *
 * | | |
 * |---|---|
 * | at the merge base | `function f() { first("x"); second("x") }` |
 * | here | `function f() { first("x"); third("x") }` |
 * | what the identity said without the statement | one identity for all four — 2 authorised, 0 added |
 * | what it says with it | two a side; `first("x")` keeps its pairing, `third("x")` is added |
 *
 * `second`'s deleted occurrence paid for `third`'s new one. That is answered in
 * the IDENTITY now — `statementAround` carries the statement, so those two are
 * not the same debt and `third("x")` is added — and refusing the group as
 * ambiguous on top of it billed the wrong people: measured 2026-09-17, one comment
 * added to an untouched 1 403-mutant file owed 14 survivors, every one of them a
 * refusal of this kind and not one of them changed code.
 *
 * ⚠️ **WHAT REMAINS AFTER THE STATEMENT IS A MULTISET, AND THIS PARAGRAPH USED TO
 * CLAIM MORE THAN THAT** (review, 2026-09-17). It said a collision "means
 * literally the same statement, mutated the same way, in the same scope", and
 * that "swapping one for another changes nothing a reader could observe". **The
 * second sentence is false**, and the first is narrower than what the identity
 * actually compares. The identity carries the NEAREST statement and the scope and
 * NOTHING BETWEEN THEM, so:
 *
 * | at the merge base | here | what the count says |
 * |---|---|---|
 * | `emit("x")` ×3 | `emit("x")` ×2 and `other("x")` | 2 answered, `other("x")` added — the call changed, so the statement did |
 * | `emit("x")` ×3 | `emit("x")` ×2 and `if (isAdmin) emit("x")` | **all three answered** — the nearest statement of the third is still `emit("x")` |
 *
 * The second row is a change a reader can plainly observe, and it is authorised.
 * What is true is the weaker thing: **a collision means the same statement,
 * mutated the same way, in the same scope, and the identity cannot see what
 * ENCLOSES that statement below the scope.** They are paired by count —
 * `min(there, here)` answered, the remainder added — because no text this identity
 * holds can tell them apart.
 *
 * ⚠️ **WHAT THAT GIVES UP, SAID PLAINLY.** Two things, and the second is the one
 * that was missing: a change that deletes one of three identical statements and
 * writes another identical one in the same scope is authorised for both, because
 * the before and the after are the same multiset; and a statement that MOVED under
 * a new guard keeps its pairing, because the guard is not in its identity.
 *
 * The second is the same trade the re-indentation rule already takes on purpose,
 * at its full width. Putting the enclosing statements in would close it and would
 * re-bill every mutant under a `switch` or an `if` for an edit anywhere inside it
 * — the file-wide re-billing this whole comparison exists to answer. The
 * alternative to the count was measured and is worse still: refusing a colliding
 * group bills a developer for survivors in code nobody touched, every time such a
 * repetition exists.
 *
 * The pairing is in the order given, which is the order a report lists mutants;
 * where one base survivor answers for one here, which of them is named decides
 * nothing.
 *
 * `undecided` is the mutants the merge base could not DECIDE — see
 * `undecidedAtBase`. None of them authorises anything, so none is part of the
 * pairing above; what they decide is which SENTENCE an unanswered survivor gets,
 * and that is `classed`'s — where they are spent one-to-one, exactly as survivors
 * are, so one undecided occurrence cannot describe two survivors here.
 */
export function matchedSurvivors(atBase, atHead, undecided = []) {
  const pools = new Map()
  for (const survivor of atBase) {
    const at = pools.get(poolKey(survivor.file, survivor.identity)) ?? { counted: 0, unspent: [] }
    pools.set(poolKey(survivor.file, survivor.identity), { counted: at.counted + 1, unspent: [...at.unspent, survivor] })
  }
  const unknown = new Map()
  for (const one of undecided) {
    const at = unknown.get(poolKey(one.file, one.identity)) ?? { counted: 0, unspent: [] }
    unknown.set(poolKey(one.file, one.identity), { counted: at.counted + 1, unspent: [...at.unspent, one] })
  }
  const authorised = []
  let waiting = atHead.map((here) => ({ here, why: null }))
  for (const whose of [(here) => here.file, (here) => here.from]) {
    const left = []
    for (const { here } of waiting) {
      const pool = pools.get(poolKey(whose(here), here.identity)) ?? { counted: 0, unspent: [] }
      const base = pool.unspent.shift()
      /* The LAST pass's reading is the one a refusal reports, and it is the pass
         that asked the merge base's own file — which is the file the words below
         name. */
      if (base === undefined) left.push({ here, why: unanswered(here, pool.counted) })
      else authorised.push({ base, here })
    }
    waiting = left
  }
  return { authorised, added: waiting.map(({ here, why }) => classed(here, why, unknown)) }
}

/**
 * Which of the two things an unanswered survivor here IS, in the words a reader
 * acts on: one this change added, or one the merge base could not decide.
 *
 * ⚠️ **THEY WERE ONE SENTENCE, AND IT WAS THE WRONG ONE** (2026-09-17). A mutant
 * the merge base never answered for was billed as the change's own, which sends a
 * reader to a diff that does not hold it. Neither class authorises anything and
 * both fail the build; what differs is where the reader looks.
 *
 * The question is asked of `from` — the file this survivor is JUDGED AGAINST, and
 * the name every measurement is under — and of nothing else. Asking a head file's
 * own name would tell it about a measurement of a file it is not judged against,
 * in the one case where the two differ: a name that is some OTHER subject's
 * origin.
 *
 * ⚠️ **AND ONE UNDECIDED OCCURRENCE EXCUSED THE DIAGNOSIS OF UNLIMITED ONES**
 * (review, 2026-09-17). The unknowns were a map, LOOKED UP and never spent, so one
 * mutant the merge base could not decide labelled two survivors here "the merge
 * base could not decide this mutant" — a sentence about a mutant it has only one
 * of. Neither passed, so nothing was authorised that should not have been; what
 * was wrong is what a reader was told. They are spent one-to-one now, exactly as
 * survivors are, and the second such survivor here falls back to the count it is
 * really against.
 */
function classed(here, why, unknown) {
  const pool = unknown.get(poolKey(here.from, here.identity)) ?? { counted: 0, unspent: [] }
  const undecided = pool.unspent.shift()
  if (undecided !== undefined) {
    return { here, why: `the merge base could not decide this mutant in ${undecided.file}: ${undecided.why}`, class: 'undecided' }
  }
  if (pool.counted === 0) return { here, why, class: 'added' }
  return { here, why: `${why}, and the ${pool.counted} mutant(s) it could not decide there each answer for another survivor here`, class: 'added' }
}

/** A survivor's identity in one file, as one string: what two survivors must share to be the same debt. */
function poolKey(file, identity) {
  return JSON.stringify([file, identity.mutatorName, identity.replacement, identity.original, identity.statement, identity.scope])
}

/** Why the merge base answers for a survivor here with nothing: it had none of them, or it had none left. */
function unanswered(here, counted) {
  if (here.from === null) return 'it is in a file the merge base does not have, and git names no file it was copied or renamed from'
  if (counted === 0) return `the merge base has no survivor with this identity in ${here.from}`
  return `the merge base has ${counted} survivor(s) with this identity in ${here.from}, and each of them answers for another survivor here`
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
  '       node scripts/check-mutants.mjs --aggregate --manifest <manifest> --results <dir>\n' +
  '       node scripts/check-mutants.mjs --measure <path> --into <file>\n' +
  '         (what one file owes in the checkout this runs in — how a sweep measures the merge base, in a worktree of its own)'

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
 *
 * `--measure` is the fourth, and is not a sweep at all: one named path, in this
 * process's own directory, with no git and no lock — see `measureSweep`. Every
 * other flag is refused to it, because each of them is about a scope it does not
 * have.
 */
export function argumentsOf(argv) {
  const { values } = parseArgs({ args: argv, options: FLAGS, strict: true, allowPositionals: false })
  /* Asked of every flag rather than of the string-valued ones: a boolean flag is
     `true` or absent and never empty, so the type decided nothing (2026-09-16). */
  for (const flag of Object.keys(FLAGS)) {
    if (values[flag] === '') throw new Error(`--${flag} needs a value, and was given an empty one`)
  }
  const modes = ['plan', 'shard', 'aggregate', 'measure'].filter((mode) => values[mode] !== undefined)
  if (modes.length > 1) throw new Error(`--${modes[0]} and --${modes[1]} are two modes, and one run is one of them`)
  const mode = modes[0] ?? 'sweep'
  for (const flag of Object.keys(FLAGS)) {
    if (values[flag] === undefined || READ_BY[mode].includes(flag)) continue
    const where = mode === 'sweep' ? 'a plain sweep' : `--${mode}`
    throw new Error(`--${flag} is not read by ${where}${READ_BY.sweep.includes(flag) ? insteadOf(mode) : ''}`)
  }
  for (const flag of NEEDED_BY[mode]) {
    if (values[flag] === undefined) throw new Error(`--${mode} needs --${flag}`)
  }
  const scope = { base: values.base ?? 'main', only: values.only ?? null, requireBase: values['require-base'] === true }
  if (mode === 'sweep') return scope
  if (mode === 'shard') return { mode, manifest: values.manifest, results: values.results, ...shardSpecOf(values.shard) }
  if (mode === 'aggregate') return { mode, manifest: values.manifest, results: values.results }
  if (mode === 'measure') return { mode, measure: values.measure, into: values.into }
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

/**
 * Where a mode that is not a plain sweep gets a scope from instead, for a flag
 * that names one.
 *
 * Only a shard, the aggregate and a measurement reach here: a plain sweep reads
 * all three of those flags, and a plan reads every one of them beside its own.
 */
function insteadOf(mode) {
  if (mode === 'measure') return ' — a measurement of one named file has no scope of its own'
  return " — a shard and the aggregate read the plan's own from its manifest"
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
  measure: { type: 'string' },
  into: { type: 'string' },
}

/** The flags each mode reads. A plain sweep is the mode no flag names. */
const READ_BY = {
  sweep: ['base', 'only', 'require-base'],
  plan: ['plan', 'shards', 'isolate', 'base', 'only', 'require-base'],
  shard: ['shard', 'manifest', 'results'],
  aggregate: ['aggregate', 'manifest', 'results'],
  measure: ['measure', 'into'],
}

/** The flags each mode cannot run without. */
const NEEDED_BY = {
  sweep: [],
  plan: ['shards'],
  shard: ['manifest', 'results'],
  aggregate: ['manifest', 'results'],
  measure: ['into'],
}

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
    /* The three seams the merge-base comparison is made of: where the base IS,
       which base file each subject may be answered by, and the measurement
       itself. A plain sweep asks the first two only when a subject has a survivor
       to authorise, so a tree at 100 % asks git nothing more than it did. */
    mergeBase = mergeBaseOf,
    origins = originsAtBase,
    measure = measureAtBase,
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
  const world = { root, stdout, stderr, changed, files, lock, stryker, commits, worktree, tracked, mergeBase, origins, measure, clock }
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
  const picked = chosen(world, base, only, requireBase)
  /* Git's spelling of each subject, which is what the comparison with the merge
     base is in: a base file is named as git names it, never as this run's root
     happens to reach it. */
  const named = new Map(picked.map(({ name, at }) => [at, name]))
  const traced = tracedOnce([...named.values()], { base, requireBase }, world)
  const subjects = picked.map(({ at }) => at)
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
  /* One measurement per BASE FILE, not per subject: two subjects traced to one
     origin ask the same question of the same commit, and asking it twice costs a
     second worktree, a second install and a second sweep of it — and then invites
     the two answers to differ. `matchedAcross` leaves a mutant two measurements
     disagree about undecided; this is why a plain sweep never has one to leave. */
  const measured = new Map()
  const measure = (origin, mergeBase, asked) => {
    if (!measured.has(origin)) measured.set(origin, world.measure(origin, mergeBase, asked))
    return measured.get(origin)
  }
  const swept = await strykerEach(toStryker, found, await testOptionsOf(root), world, {
    judge: (subject, report) =>
      reportUnlike(reportEntryOf(subject, report), { named: subject, ...counted.get(subject), whose: 'this sweep' }),
    base: (subject, reports, spent) => {
      const { mergeBase, origins } = traced()
      return judgedAtBase(subject, named.get(subject), origins.get(named.get(subject)) ?? null, reports, { mergeBase, measure, world, spent })
    },
  })
  return summarise({ ...swept, ...sweptTogether(swept, world.stdout), nothingToKill: [...nothingToKill, ...swept.nothingToKill], noTestFound }, world)
}

/**
 * A sweep's own verdict over every subject at once — see `matchedAcross` — as the
 * outcomes `summarise` is given: the evidence each file carries with the sweep's
 * numbers in place of its own, and the files whose survivors nothing at the merge
 * base is left to answer for.
 *
 * ⚠️ **A SUBJECT'S OWN PAIRING IS OPTIMISTIC AND THIS IS THE ANSWER**, so what
 * `strykerEach` decided per file is REPLACED rather than added to: a file it
 * passed on its own pool can be a file the sweep's one pool cannot pay for.
 */
function sweptTogether(swept, stdout = null) {
  const { byFile, contested, measurements } = matchedAcross(swept.paired)
  if (stdout !== null) stdout.write(sayContested(contested, measurements))
  /* The subject as a sweep NAMES it against the subject as git names it, which
     is what the pairing answers under. Carried rather than computed back, because
     computing it back is `path.relative` and a separator this gate would then
     have to slash. */
  const named = new Map(swept.paired.map(({ at, named: name }) => [at, name]))
  const base = swept.base.map(([subject, evidence]) => [subject, { ...evidence, ...(byFile.get(named.get(subject)) ?? {}) }])
  const stands = base.filter(([, evidence]) => survivorsStand(evidence)).map(([subject]) => subject)
  return {
    base,
    /* Named once: a file already among them for another reason — a run that
       scored nothing cannot reach here, but a file both timed out and survived
       can — is not named twice for this one. */
    unkilled: [...new Set([...swept.unkilled, ...stands])],
  }
}

/**
 * What two measurements of one base file disagreed about, as one line per file
 * and nothing at all where they agreed — which is every sweep that measured each
 * base file once, and so almost all of them.
 *
 * It is written whether the sweep passes or fails, deliberately: a contested
 * identity only changes an ANSWER when a survivor here consumes it, so the
 * signal that the base's runs are not reproducible is otherwise invisible in
 * exactly the runs where it is still true and not yet expensive.
 */
function sayContested(contested, measurements) {
  const twice = measurements.filter(([, runs]) => runs > 1)
  if (contested.length === 0 || twice.length === 0) return ''
  const where = new Map()
  for (const one of contested) where.set(one.file, (where.get(one.file) ?? 0) + 1)
  return (
    `check-mutants: ${contested.length} mutant(s) were contested between measurements of the same merge-base file — this does not change what any file owes, and it does say the base's runs did not reproduce each other:\n` +
    twice.map(([named, runs]) => `  ${named} — measured ${runs} time(s), ${where.get(named) ?? 0} identity(ies) contested\n`).join('')
  )
}

/**
 * Where the merge base is, and which base file may answer for each of `names` —
 * asked ONCE, and only when something asks.
 *
 * ⚠️ **A TREE AT 100 % MUST ASK GIT NOTHING MORE THAN IT USED TO.** Both
 * questions cost a git process, and the second of them a whole-repository
 * rename detection with no limit — see `renamesAtBase` — which is a real cost to
 * pay on every sweep that has nothing to authorise. Nothing is asked until the
 * first survivor, and nothing is asked twice.
 */
function tracedOnce(names, { base, requireBase }, world) {
  let asked = null
  return () => {
    if (asked !== null) return asked
    let at
    try {
      at = world.mergeBase(base, requireBase, world.root)
    } catch (cause) {
      throw new Refusal(messageOf(cause))
    }
    asked = { mergeBase: at, origins: world.origins(names, at, world.root) }
    return asked
  }
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
 *
 * `reaching` is which tests count as covering, and is asked rather than assumed
 * because the two sides of a comparison answer it differently: a sweep here stops
 * at the nearest level that reaches a subject, and a measurement at the merge base
 * takes every test there is — see `reachingAtBase` for why, and `measuredHere` for
 * what that asymmetry costs.
 */
function discover(subjects, { root, files }, reaching = coveringTests) {
  const tree = files(root)
  const inCheckout = (file) => path.join(root, file)
  const all = allTestFiles(tree).map(inCheckout)
  /* One parse per file for the whole sweep — see `remembered`. */
  const imports = remembered(importsOf)
  const importers = reverseImports(allSourceFiles(tree).map(inCheckout), imports)
  const reach = new Map(subjects.map((subject) => [subject, reaching(subject, all, importers, imports)]))
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
 *
 * `base` is asked about a subject whose run left a survivor, and about no other:
 * it answers `{ outcome, evidence }` — see `judgedAtBase` — where the outcome
 * REPLACES `survived` with what the merge base makes of it, and the evidence is
 * what a result carries and the aggregate re-derives the answer from. A sweep at
 * 100 % never reaches it, which is why measuring the base costs a tree with no
 * survivors nothing at all.
 */
/**
 * Stop the sweep when a file this subject's tests read has moved under it.
 *
 * ⚠️ **A REFUSAL RATHER THAN A FAILED SUBJECT, AND THAT IS THE WHOLE POINT.**
 * What changed is an INPUT to the measurement, so the measurement did not
 * happen — it is the `untested-base` argument on the other side of the gate:
 * *could not run* must never become an answer. Marking the subject failed would
 * bill whoever is editing for a run that measured two different projects, and
 * passing it would be worse. Every later subject is equally suspect, because
 * whatever is writing is still writing, so the sweep ends here and says which
 * file moved.
 */
function stillTheInputs(subject, inputs, root) {
  const moved = inputsMoved(inputs, root)
  if (moved.length === 0) return
  throw new Refusal(
    `check-mutants: a file ${subject}'s covering tests read changed during its run, so the run measured two different projects — ${moved.join('; ')}`,
    `read-input-changed: ${moved.join('; ')}`,
  )
}

async function strykerEach(
  reached,
  found,
  carried,
  { root, stdout, lock, stryker, clock },
  { record = () => {}, before = () => {}, between = () => {}, after = () => {}, judge = () => null, base = () => null, settling = true } = {},
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
    unresolved: [],
    staticSurvivors: [],
    mismatched: [],
    /* What the merge base said, for each subject one was measured for — see
       `summarise`, which is where a file whose survivors were all there too stops
       being a failure. */
    base: [],
    /* And both sides' survivors, derived, for the one pairing that sees every
       subject at once — see `matchedAcross`. A shard records the evidence and
       leaves these where they are: the aggregate derives its own. */
    paired: [],
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
    /* And once per sweep: what each test READS, parsed at most once however
       many subjects it covers — see `readInputsOf`, which measured the other
       way at 10.3 s for this gate's own three. */
    const readPaths = new Map()
    /* One Stryker run of one subject, under `deadline`, and what it amounted to.
       The generated vitest config is the subject's own and is written once, so a
       settle run is the same subject against the same covering tests. */
    const runOnce = async (subject, deadline) => {
      writeFresh(config, JSON.stringify(strykerConfig(subject, vitestConfig, symlinks, deadline), null, 2))
      /* A report left by the previous run would pass this one's crash off as a
         scored run. */
      rmSync(report, { force: true })
      const started = clock()
      /* ⚠️ **THE ROOT IS WHERE STRYKER RUNS, NOT ONLY WHERE ITS FILES ARE
         WRITTEN** (measured 2026-09-16). It sandboxes the project it is started
         IN, so a sweep of a checkout other than this process's own — a measurement
         at the merge base — must start it there. */
      const exitedCleanly = (await stryker(config, root)) === true
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
      /* And what this subject's covering tests READ, which no drift check above
         can see: git's working tree leaves out everything `.gitignore` covers,
         and a plain sweep compares nothing at all. See `readInputsOf` for the
         file that found it. Taken AFTER `before`, so a shard that is stopping
         stops on its own reason rather than on a consequence of one. */
      const inputs = readInputsOf(covering, root, readPaths)
      /* PRINTED, because a guard nobody can see the reach of is a guard nobody
         can argue with — the rule the excluded-reader list already follows. The
         second number is what it could not watch: a read `pathsRead` cannot
         resolve, or a directory. */
      if (inputs.files.size > 0 || inputs.unwatched > 0) {
        stdout.write(
          `      watching ${inputs.files.size} file(s) its tests read${inputs.unwatched > 0 ? `, and ${inputs.unwatched} it cannot` : ''}\n`,
        )
      }
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
      /* `settling` is how a caller that cannot use a settle run says so. Every
         caller in this gate wants one — see `killedWhenWidened`, which tried
         going without and reverted, and says why. It is here because the option
         is what makes that decision visible and reversible rather than implicit
         in the absence of a flag. */
      const toSettle = unlike === null && settling ? timeoutsIn(reportEntryOf(subject, first.report)).unsettled.length : 0
      let settle = null
      if (toSettle > 0) {
        stillTheInputs(subject, inputs, root)
        /* Between the two runs, as before the first and after the second: a
           checkout that changes mid-settle stops a shard exactly as one that
           changes mid-sweep does. */
        await between(subject)
        settle = await runOnce(subject, SETTLE_RUN)
      }
      const verdict = settledVerdict(subject, first, settle)
      const settleUnlike = settle === null ? null : judge(subject, settle.report)
      const problem = unlike ?? (settleUnlike === null ? null : `the settle run's report: ${settleUnlike}`)
      /* What the merge base said about this file's survivors, and `null` where
         nothing was asked of it — see `judgedAtBase`. A report that is not of this
         file says nothing about its survivors either, so a mismatch is never
         measured against the base. */
      let evidence = null
      if (problem !== null) swept.mismatched.push([subject, problem])
      else {
        stdout.write(sayTimeouts(subject, verdict))
        /* What this file's own sweep cost, which is what a second wide pass over
           it would cost again — see `judgedAtBase`, which spends it or does not. */
        const spent = first.durationMs + (settle === null ? 0 : settle.durationMs)
        const judged = verdict.outcome === 'survived' ? await base(subject, [first.report, settle === null ? null : settle.report], spent) : null
        evidence = judged === null ? null : judged.evidence
        if (judged !== null && judged.paired !== null) swept.paired.push(judged.paired)
        /* A repeat is named whatever else the file also is: a survivor outranks
           it as the file's OUTCOME — a survivor is the finding, a repeat the
           absence of one — and does not replace it as a thing to fix. So a file
           with both is in both lists, and `timed-out` is the outcome of a file
           that has a repeat and nothing worse. The places come with the file:
           see `summarise`. */
        if (verdict.repeated.length > 0) swept.timedOut.push([subject, verdict.repeated])
        /* And an unresolved mutant the same way, on its own channel — see
           `unanswered`. It is NOT an outcome, because an outcome is one answer
           per file and a survivor outranks every other; a mutant with no score
           has to survive that precedence, and the base cannot excuse it. */
        if (verdict.unresolved.length > 0) swept.unresolved.push([subject, verdict.unresolved])
        /* A survivor the merge base answered for is no longer this file's
           failure, so the file is not named among the ones a mutant survived in;
           what the base said is carried instead, and `summarise` is where a base
           that could not be measured becomes a failure of its own. */
        if (verdict.outcome !== 'timed-out' && (evidence === null || survivorsStand(evidence))) into[verdict.outcome].push(subject)
        if (evidence !== null) swept.base.push([subject, evidence])
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
        base: evidence,
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
      stillTheInputs(subject, inputs, root)
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
 * ## What the same file owed at the MERGE BASE
 *
 * A survivor here that was there too is debt the change did not make. Deciding
 * that needs the file measured at the base — base content, base tests, base
 * dependencies — and every one of the three is a way to get it wrong:
 *
 * ⚠️ **NEVER AN OVERLAY.** Base files written into this tree let a test from the
 * base import a helper from here, which can leave a survivor that existed at
 * neither commit — permission invented out of the mixture. The base is a
 * `git worktree add --detach` of its own, OUTSIDE this checkout, removed when the
 * measurement ends.
 *
 * ⚠️ **AND OUTSIDE IS NOT A TIDINESS RULE.** A shard compares the whole working
 * tree around every file it sweeps, so a worktree checked out inside the checkout
 * is a difference that stops the shard that asked for the measurement.
 *
 * ⚠️ **BASE CODE WITH BASE TESTS.** Head's tests against base code hide a
 * weakened assertion — both sides survive, and the gap reads as old — and base's
 * tests against head's code refuse an intended change of API. The POLICY is
 * head's, this file's: the same identities, the same deadline, the same settle
 * run for a wall-clock timeout. The PROJECT is the base's.
 *
 * ⚠️ **AND FAILING TO MEASURE IS NEVER PERMISSION.** Every way this can fail is a
 * refusal that says which one it is, so that "could not run" can never be read as
 * "it already survived": a merge base that is not here, a path the merge base
 * does not have, an install that cannot run, a runner of another major version, a
 * run that scored nothing, a wall-clock timeout that repeated, a report that is
 * not of what was swept, a base no test reaches.
 *
 * ⚠️ **AND THE MEASUREMENT ITSELF RUNS IN A CHILD PROCESS, BECAUSE AN ABSOLUTE
 * `mutate` GLOB MATCHES NOTHING** — measured rather than suspected, 2026-09-16,
 * against a scratch project with `@stryker-mutator/core` 10.0.0. With an
 * absolute `mutate` and an absolute `vitest.configFile`, Stryker answered
 * *"Glob pattern … did not result in any files"*, instrumented 0 mutants, and
 * died in the dry run; with both made relative and the run started IN that
 * project, the same file gave 7 mutants, 6 killed and 1 survived, reported under
 * `src/a.ts`. A plain sweep never meets this because its root is `.`, where
 * relative and absolute are the same string — and `strykerEach`, `outcomeOf` and
 * `reportEntryOf` all assume exactly that.
 *
 * So the base is swept by THIS FILE, run as `node <this gate> --measure <path>
 * --into <file>` with its working directory set to the worktree. Its root is `.`
 * there, so every path it writes and reads is relative in the one place that
 * matters. **The POLICY is head's** — the settle run, the deadlines, the
 * identities, every refusal — because the file the child runs is this one; **the
 * PROJECT is the base's**, because `npx stryker`, vitest and the generated config
 * all resolve from the directory the child runs in. `--measure` reads no git,
 * takes no lock, plans nothing and discovers no changed file: it is handed one
 * path and answers for that path alone — see `measureSweep`.
 */

/** A refusal that says WHICH failure it is, so a caller can tell a base it cannot measure from a file the base does not have. */
class BaseRefusal extends Refusal {
  constructor(reason, message) {
    super(message)
    this.reason = reason
  }
}

/**
 * What `subject` owed at the merge base: its survivors, each identified as
 * `survivorIdentity` identifies one, or a refusal saying why that cannot be
 * known. `subject` is a path as git names it — the BASE's own path, which is not
 * this file's where a change renamed it; see `originAtBase`.
 *
 * `world` is the sweep's, with three seams of its own: `install`, because a real
 * dependency install is the one thing a test may not run; `scratch`, so a case
 * can put the worktree where it can watch it; and `child`, which is the
 * measurement itself — see `spawnMeasurement`. The checkout's own `lock` is
 * deliberately NOT used — the sweep that asked for this measurement is holding
 * it, and the base worktree is this process's own under a name nothing else can
 * know, so there is nothing there for a lock to protect.
 */
export async function measureAtBase(subject, baseCommit, world) {
  const { root, install = installAt, scratch = baseScratch, child = spawnMeasurement, clock = () => performance.now() } = world
  const started = clock()
  if (!gitAnswers(['cat-file', '-e', `${baseCommit}^{commit}`], root)) {
    throw new BaseRefusal(
      'no-commit',
      `check-mutants: the merge base ${baseCommit} is not in this checkout, so what ${subject} owed there cannot be ` +
        'measured — fetch it (`fetch-depth: 0`) and run again',
    )
  }
  if (!gitAnswers(['cat-file', '-e', `${baseCommit}:${subject}`], root)) {
    throw new BaseRefusal(
      'absent-at-base',
      `check-mutants: the merge base ${baseCommit} has no ${subject}, so there is nothing there to measure — a file the ` +
        'merge base does not have is new, and what a new file owes is not this measurement’s to say',
    )
  }
  const temp = scratch()
  const at = path.join(temp, 'base')
  try {
    const measured = await measuredIn(at, { subject, baseCommit, root, install, child, temp, clock, started })
    /* ⚠️ **WHAT IT COST IS WHAT THE WHOLE OPERATION COST**, not what Stryker
       reported: the child's own number leaves out the worktree, the install and
       the child's own startup, which on a cold base is most of it — and those
       numbers are what a CI bound is supposed to be re-derived from. */
    return { ...measured, durationMs: Math.round(clock() - started) }
  } finally {
    /* Whatever happened: what is not removed here is a worktree git goes on
       listing and a checkout of an old commit left on the disk. */
    try {
      execFileSync('git', ['worktree', 'remove', '--force', at], silently(root))
    } catch {
      /* There is none — refused before it was made. */
    }
    rmSync(temp, { recursive: true, force: true })
  }
}

/** The measurement itself, with the worktree's removal already promised by `measureAtBase`. */
async function measuredIn(at, { subject, baseCommit, root, install, child, temp, clock, started }) {
  const under = path.relative(realPathOf(root), realPathOf(temp))
  if (!outsideCheckout(under)) {
    throw new BaseRefusal(
      'scratch-inside',
      `check-mutants: the merge base would be checked out at ${temp}, which is inside the checkout at ${root} — a ` +
        'worktree there is a change to the very tree a plan fingerprints; give it a directory outside',
    )
  }
  /* Given at all so `execFileSync` does not ALSO write git's stderr to this
     process's own — it inherits it whenever `stdio` is left out — while the
     refusal below still carries git's reason, which it reads from the pipe: the
     same reasoning as `commitsOf`. No `encoding`, because nothing reads what this
     run RETURNS and `cause.message` is a string whatever the encoding, so the
     option decided nothing (measured 2026-09-17).

     ⚠️ **EVERY ENTRY HERE IS LOAD-BEARING, THOUGH ONLY THE LAST ONE LOOKS IT**
     (measured 2026-09-17). An entry Node does not know TRUNCATES the list rather
     than defaulting: `['', 'pipe', 'pipe']` gives a child two streams, not
     three, and git's reason is then in nobody's hands. So the case that asserts
     git's own words is what holds all three, not just the pipe it names. */
  // Stryker disable next-line ArrayDeclaration: a short stdio list is padded with pipes, so an empty one differs only in the child's stdin, which `git worktree add` never reads
  const said = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  try {
    execFileSync('git', ['worktree', 'add', '--detach', at, baseCommit], said)
  } catch (cause) {
    throw new BaseRefusal('worktree', `check-mutants: cannot check the merge base ${baseCommit} out at ${at} — ${messageOf(cause).trim()}`)
  }
  /* ⚠️ **THE ORDER OF THESE TWO LINES IS THE WHOLE OF WHETHER THE BASE CAN BE
     MEASURED AT ALL.** A runner version is read out of an INSTALL, so the base's
     can be read only once the base has one — and it cannot be read before the
     worktree exists either. Provision first, then ask both sides. Asking earlier
     to save the install on a base that turns out to be incompatible is not
     possible: what the base pins is exactly what the answer would need. */
  const supplied = suppliedTo(at, root, install, left(clock, started, INSTALL_DEADLINE_MS))
  const unlike = runnerUnlike(runnerVersionsAt(root), runnerVersionsAt(at))
  if (unlike !== null) throw new BaseRefusal('runner', `check-mutants: ${unlike} — refused rather than interpreted`)
  const into = path.join(temp, 'measured.json')
  /* ⚠️ **NOTHING BOUNDED ANY OF THIS UNTIL 2026-09-17** (review). Every subject
     with a survivor makes another worktree, possibly another install, and a
     Stryker run of a file whose history nothing about this branch predicts — and
     a base no covering test was found for is now measured against the merge
     base's WHOLE suite. A hung install or a hung child would take the sweep's
     whole CI budget and report nothing at all; expiry refuses instead, which is
     a failure to measure and so authorises nothing.
     The caps are provisional and stated as such — re-derive them from measured
     end-to-end durations on the runners that pay for them, which is why a
     measurement now records what the WHOLE operation cost. What is not bounded
     here is the SWEEP: a shard has no budget of its own to subtract from, so a
     shard of many surviving files can still spend many of these. */
  const remaining = left(clock, started, BASE_DEADLINE_MS)
  if (remaining <= 0) {
    throw new BaseRefusal(
      'expired',
      `check-mutants: measuring ${subject} at the merge base took longer than the ${BASE_DEADLINE_MS / 60_000} minute(s) ` +
        'this gate allows for one file, so what it owed there is unmeasured — and unmeasured is never permission',
    )
  }
  let ended = null
  try {
    await child(at, subject, into, { timeoutMs: remaining })
  } catch (cause) {
    /* Kept, not thrown: a child that REFUSED exits 2 having written its record,
       and that record says which refusal it was. Only a child that left none is
       answered with this. */
    ended = messageOf(cause)
  }
  const { record, problem } = measurementIn(into)
  if (problem !== undefined) {
    throw new BaseRefusal(
      'child',
      `check-mutants: the run that was to measure ${subject} at the merge base left no measurement at ${into} — ${problem}` +
        (ended === null ? '' : `; it ended with: ${ended}`),
    )
  }
  /* ⚠️ **A MEASUREMENT OF ANOTHER FILE IS NOT THIS FILE'S**, and it would read as
     one: the record is a file on disk, so a stale one from an earlier subject, or
     a child handed the wrong path, would otherwise authorise this subject's
     survivors with another subject's debt. */
  if (record.subject !== subject) {
    throw new BaseRefusal(
      'mismatched',
      `check-mutants: the run that was to measure ${subject} at the merge base measured ${JSON.stringify(record.subject)} instead`,
    )
  }
  if (record.refusal !== null) throw new BaseRefusal(record.refusal.reason, record.refusal.message)
  /* ⚠️ **`excluded` WAS WRITTEN BY THE CHILD AND DROPPED HERE** (found
     2026-09-18). This copied the record field by field and left it out, so
     `judgedAtBase` always saw an empty list and `reading-changed` could never
     fire in a real sweep — while both of its cases passed, because they hand
     `judgedAtBase` a measurement directly and never come through this reader. */
  return {
    install: supplied,
    outcome: record.outcome,
    durationMs: record.durationMs,
    sha256: record.sha256,
    source: record.source,
    first: record.first,
    settle: record.settle,
    excluded: record.excluded,
    unseen: record.unseen,
  }
}

/**
 * THIS gate, run over one path, in the checkout at `at` — the base measurement
 * itself, and the whole of what makes the policy head's and the project base's.
 *
 * `process.execPath` and `import.meta.url` are both THIS process's: the child is
 * the same node running the same file, so its deadlines, its identities, its
 * settle run and every refusal it can make are the ones a sweep here would make.
 * What differs is `cwd`, and that is what the whole child exists for — Stryker
 * resolves `mutate`, `vitest.configFile` and its own sandbox from the directory
 * it is started in, and an ABSOLUTE `mutate` matches nothing (see the section
 * header above).
 *
 * Its stdin is closed, because nothing it runs reads one and a child left waiting
 * on a terminal would hang the sweep; its output is this sweep's, so Stryker's
 * own progress for the base run appears where the reader is already looking.
 *
 * ⚠️ **A NON-ZERO EXIT IS NOT THE ANSWER HERE.** A child that REFUSES writes its
 * refusal to `into` and exits 2, and that record is the evidence; `execFileSync`
 * throws on it, and `measuredIn` keeps the throw only to name a child that left
 * no record at all.
 */
function spawnMeasurement(at, subject, into, { timeoutMs }) {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--measure', subject, '--into', into], {
    cwd: at,
    /* A child that hangs would spend the sweep's whole budget and report
       nothing — see `measuredIn`, which works out what is left of it. */
    timeout: timeoutMs,
    /* ⚠️ **THE LIST AND ITS ENTRIES ARE TWO DIFFERENT QUESTIONS HERE, AND THIS
       LINE CARRIED A `Stryker disable ArrayDeclaration` UNTIL 2026-09-17** on
       the ground that nothing reads the child's streams back. The ground was
       false for the LIST: an empty one pads to PIPES, `execFileSync` puts a
       failed child's stderr into the message it throws, and `measuredIn` carries
       that message into its refusal — so the child's own words would arrive
       spliced into this gate's. The case that asserts only how the run ended
       kills it, and the directive was hiding it.

       An ENTRY is the other way round. An entry Node does not know TRUNCATES the
       list rather than defaulting — `['', 'inherit', 'inherit']` hands the child
       one stream, not three — so what it takes away is a stream, never one that
       reaches back here. What changes is what a person sees on a terminal, and
       no test watches one (both measured 2026-09-17). */
    // Stryker disable next-line StringLiteral: an unknown entry truncates the list, so what any of these takes away is a stream the child writes to and nothing here reads — a difference only a person at a terminal can see
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

/**
 * `--measure <path> --into <file>`: what ONE named file owes, in the checkout
 * this process is RUNNING IN, written to `into` as a record and nowhere else.
 *
 * It reads no git, takes no lock, plans nothing and discovers no changed file —
 * it is handed a path and answers for that path. That is what makes it usable as
 * the base half of a comparison: `measureAtBase` checks the merge base out, hands
 * it the path, and reads the record back.
 *
 * ⚠️ **NO LOCK MEANS NO LOCK, AND A HAND-RUN IN THIS CHECKOUT IS NOT PROTECTED.**
 * The base worktree a sweep makes is that process's own, under a name nothing
 * else can know, and the checkout's lock is held by the sweep that asked — so
 * taking one there would refuse this gate to itself. Run by HAND in an ordinary
 * checkout, though, this writes `vitest.mutants.mjs`, `stryker.mutants.json` and
 * the report at the same names a sweep does, with nothing stopping the two. Quit
 * the sweep first, or measure a worktree of your own.
 *
 * ⚠️ **A REFUSAL IS WRITTEN DOWN AND THEN RAISED.** Every way a measurement can
 * fail has to reach the sweep that asked for it, and a message on a child's
 * stderr is not a value a parent can act on — so the reason and the words go into
 * the record, the record is written, and the exit is 2. A defect — anything that
 * is not a refusal — propagates instead, and leaves no record, which is what
 * `measuredIn` reads as a child that could not measure.
 *
 * ⚠️ **WHERE THE RECORD GOES IS DECIDED BEFORE ANYTHING IS MEASURED, AND BEFORE
 * ANYTHING IS WRITTEN.** An output over the subject is refused OUT of this
 * function rather than recorded in it: a record written at that name is the very
 * write the refusal exists to stop.
 */
async function measureSweep({ measure: subject, into }, world) {
  const { stderr, root } = world
  if (writtenOverSubject(subject, into, root)) {
    throw new Refusal(
      `check-mutants: --into ${into} is the file --measure ${subject} reads, and a record written there replaces the very ` +
        'file this was to measure — name one outside the checkout, as a sweep does',
    )
  }
  const named = { kind: 'measurement', version: RECORD_VERSION, subject }
  let record
  try {
    record = { ...named, refusal: null, ...(await measuredHere(subject, world)) }
  } catch (cause) {
    if (!(cause instanceof Refusal)) throw cause
    record = { ...named, refusal: { reason: cause.reason ?? 'refused', message: cause.message } }
  }
  mkdirSync(path.dirname(into), { recursive: true })
  writeFresh(into, `${JSON.stringify(record, null, 2)}\n`)
  if (record.refusal === null) return 0
  stderr.write(`${record.refusal.message}\n`)
  return 2
}

/**
 * What `subject` owes in THIS checkout — the merge base's own — as the EVIDENCE
 * a comparison is made from: the content that was measured, the reports of the
 * runs that measured it, and the outcome they add up to. The survivors are not
 * among them: they are derived from this, here and again by everything that
 * reads it — see `survivorsAtBase`.
 *
 * ⚠️ **A FILE NO TEST REACHES WAS A FILE WHERE EVERY MUTANT SURVIVED, AND THAT
 * MADE A DISCOVERY FAILURE INTO PERMISSION** (review, 2026-09-17). The reasoning
 * was that nothing ran, so nothing killed anything — true of a file nothing
 * tests, and equally true of a file whose test this gate could not FIND. A base
 * test written `const p = './a'; await import(p)` kills mutants in `a.ts` and is
 * in no import graph: delete it, leave a weak discoverable one, and the survivors
 * it uncovered read as debt the base already had. Walking every level of the
 * import graph does not make the graph complete.
 *
 * ⚠️ **AND FIRING ONLY WHERE NOTHING WAS FOUND LEFT THE SAME HOLE OPEN** (review,
 * 2026-09-17). One weak static importer was enough to suppress the wider run —
 * so a base with a discoverable `a.test.ts` that asserts almost nothing, BESIDE a
 * computed-import test that kills half the file, was measured against the weak
 * one alone. Deleting the strong test and keeping the weak one still read as debt
 * the merge base already had, which is the very trade this fix was made against.
 *
 * So the merge base is measured against EVERY test it has, always, and discovery
 * decides nothing there. The condition it replaces could never be written: what
 * would have to hold is that the import graph is COMPLETE, and this gate follows
 * relative specifiers and nothing else — an alias, a bare specifier that resolves
 * back into the checkout, a plugin's own resolution and a computed path are each
 * invisible to it. "At least one test was found" is not evidence of completeness
 * and never was.
 *
 * ⚠️ **"EVERY TEST IT HAS" IS WHAT THIS OFFERS, NOT WHAT STRYKER RUNS** (measured
 * 2026-09-18). Stryker's Vitest runner turns on Vitest's `related` filter by
 * default, and that filter keeps only the offered files whose imports — static
 * ones, and dynamic ones with a literal specifier — reach the mutated file. A
 * test that reaches it through `await import(where)` is dropped: a two-file
 * probe with that as its only test found no test at all, and with
 * `vitest: { related: false }` the same test ran and killed four mutants. So the
 * computed-import case above is still decided by an import graph — Vitest's
 * rather than this gate's. Turning the filter off is not the way out: it runs
 * the whole suite in worker threads, and the first test that calls
 * `process.chdir()` ends the dry run (measured, 20 s in). So what Vitest drops
 * is recorded instead — every offered test it never ran whose route reaches a
 * load no graph can follow, by content — and `judgedAtBase` authorises nothing
 * once a file on such a route has moved (`unseen-changed`). See `unseenAtBase`.
 *
 * It is sound in one direction only, which is why it is the BASE side's rule:
 * more tests there can only KILL more, which can only leave less to be excused
 * by. The same widening HERE would be a way to pass, so `sweepChanges` still
 * fails a file no test was found for.
 *
 * ⚠️ **WHAT IT COSTS, AND THE ONE THING THAT COST IS COUPLED TO.** Stryker runs
 * per-test coverage (`coverageAnalysis: 'perTest'`), so a wider set costs the
 * tests it runs ONCE, as a dry run plus its coverage pass, and not a wider run
 * per mutant — the tests the `related` filter keeps, as above, which is how
 * `flatten.ts`'s merge base ran 1 079 tests rather than the whole suite. What it
 * couples to is the base suite being GREEN: a
 * failed dry run there is `ConfigError: There were failed tests in the initial
 * test run`, Stryker scores nothing, and the file is refused — which bills the
 * change for every survivor in it. That is the correct answer to "the merge base
 * cannot be measured" and it is now reachable for every file with a survivor,
 * where before it was reachable only for one nothing was found for.
 *
 * ⚠️ **AND WHERE THAT LEAVES NO TEST AT ALL, IT REFUSES.** A merge base with
 * nothing to run is a merge base this gate cannot measure, and never a file that
 * survived everything: automatic survival is the shape of the defect above.
 *
 * What is authorised is bounded by the identity, not by the outcome: a survivor
 * here is excused only if the SAME mutator, replacement, mutated text and scope
 * path were there too — so a file nothing covered at the merge base still owes
 * 100 % of whatever the change rewrote, and owes nothing for the code it left
 * alone. That is the case this whole comparison exists for: a one-line fix in a
 * large old file whose tests reach almost none of it.
 *
 * ⚠️ **AND IT IS THE BASE SIDE'S ANSWER ALONE.** A file no test reaches HERE is
 * still `no-test-found` and still fails — see `sweepChanges` — because a sweep
 * that cannot find a test cannot tell a testability failure from a discovery
 * defect of its own. Widening to every test is the base side's rule because more
 * tests there can only KILL more, which can only leave less to be excused by.
 *
 * ⚠️ **AND WHAT IS MEASURED MUST BE CONTENT THIS CHECKOUT HOLDS.** A tracked
 * SYMBOLIC LINK is a path git has and content it does not: `cat-file -e` proves
 * the merge base has an entry at the name, and every read below then follows the
 * link to whatever the machine running this happens to have there. Committed at a
 * subject's name it would hand the measurement a stranger's file. Refused by where
 * the name really goes, so that a link among its directories is refused with it.
 */
async function measuredHere(subject, world, { settling = true } = {}) {
  const { root, files = repositoryFiles } = world
  const at = path.join(root, subject)
  const elsewhere = reachedOutside(at, root)
  if (elsewhere !== null) {
    throw new BaseRefusal(
      'outside',
      `check-mutants: ${subject} is reached at ${elsewhere.real}, which is outside the checkout at ${elsewhere.top} — what ` +
        'the merge base owes is measured in the merge base’s own content, never in whatever a link points at here',
    )
  }
  const source = readFileSync(at, 'utf8')
  const sha256 = digestOf(readFileSync(at))
  const identities = await identifiedIn(at, 'what it owed at the merge base')
  /* Nothing to kill, so nothing survived: answered without a run, and without
     asking which tests reach it, because no answer to that could change this
     one. */
  if (identities.length === 0) return { outcome: 'no-mutants', durationMs: 0, sha256, source, first: null, settle: null, excluded: [], unseen: [] }
  const found = discover([at], { root, files }, reachingAtBase)
  if (found.get(at).tests.length === 0) {
    throw new BaseRefusal(
      'untested-base',
      `check-mutants: the merge base has no test this gate can run against ${subject} — every test in it was offered and ` +
        'none remains, so what it owed there cannot be measured, and a base nothing was run against is not a base where ' +
        'everything survived',
    )
  }
  /* ⚠️ **WHAT THE MEASUREMENT COULD NOT RUN IS PART OF THE MEASUREMENT.** A test
     that reads the subject's source is left out of BOTH sweeps, because Stryker
     rewrites the very file it reads — and a test may read the source AND assert
     behaviour, so what is left out can be a real killer. While such a test is
     the same on both sides that costs nothing: it is missing from head's run
     too, so a mutant it would have killed survives in both and the comparison is
     like with like. It stops being like with like the moment the CHANGE touches
     that test, which is exactly the hole a second opinion's fifth round
     reproduced — delete the strong reader, append a comment to the subject, and
     the mutant it used to kill comes back authorised by a base that had excluded
     its killer. So the base carries what it left out, by content, and
     `judgedAtBase` refuses to authorise anything once one of them has changed. */
  const excluded = found.get(at).leftOut.map((test) => ({
    path: slashed(path.relative(root, test)),
    sha256: digestOf(readFileSync(test)),
  }))
  let scored = null
  const swept = await strykerEach([at], found, await testOptionsOf(root), { ...world, lock: unlocked }, {
    settling,
    record: (result) => void (scored = result),
    judge: (file, report) => reportUnlike(reportEntryOf(file, report), { named: subject, sha256, identities, whose: 'the merge base' }),
  })
  const [mismatch] = swept.mismatched
  if (mismatch !== undefined) {
    throw new BaseRefusal('mismatched', `check-mutants: the merge base’s run of ${subject} did not report on what it swept — ${mismatch[1]}`)
  }
  const first = { exitedCleanly: scored.exitedCleanly, report: scored.report, durationMs: scored.durationMs }
  /* And what Vitest never ran of what it was offered, where nothing proves it
     unrelated — the same kind of evidence as `excluded`, missing from both sides
     for a different reason. See `unseenAtBase`. */
  const unseen = unseenAtBase(found.get(at).tests, [scored.report, scored.settle?.report], root)
  const measured = {
    /* ⚠️ **WHAT THE RUNS MADE OF THE FILE, NOT WHAT A SWEEP HERE WOULD REPORT.**
       `scored.outcome` is `timed-out` for a repeat and `did-not-run` for a mutant
       the settle run never answered for, which are findings about one MUTANT — and
       neither is an outcome a measurement may carry, because the whole file was
       measured. Those mutants are named by `undecidedAtBase`; see
       `settledVerdict` for the two readings. */
    outcome: settledVerdict(at, first, scored.settle).measured,
    durationMs: scored.durationMs + (scored.settle === null ? 0 : scored.settle.durationMs),
    sha256,
    source,
    first,
    settle: scored.settle,
    excluded,
    unseen,
  }
  /* The evidence is held to what it must answer for before it leaves here, so a
     measurement that could not be read back is refused where it was made rather
     than where it is used — and by exactly the reading every later one makes. */
  const { problem } = await survivorsAtBase(measured, { at, named: subject, frozen: sha256 })
  if (problem !== undefined) throw new BaseRefusal(problem.reason, `check-mutants: the merge base’s run of ${subject} ${problem.why}`)
  return measured
}

/**
 * Which tests a subject is measured against AT THE MERGE BASE: every test the
 * merge base has — see `measuredHere` for why that is the closing of a bypass and
 * not one.
 *
 * ⚠️ **IT USED TO ASK DISCOVERY FIRST AND WIDEN ONLY WHERE DISCOVERY FOUND
 * NOTHING**, which one weak discoverable test was enough to suppress. The
 * condition is gone rather than tightened, because no condition over an
 * incomplete import graph can establish that the graph is complete.
 *
 * `through` is empty because nothing carried the subject to these tests: they are
 * run because discovery could not prove they do not reach it, which is a
 * different claim and is not one to dress as a chain of imports. A base
 * measurement's own log says so by naming the subject with no `through` clause.
 */
export function reachingAtBase(subject, tests) {
  return { tests, through: [] }
}

/**
 * Every mutant these reports left alive, each as a survivor of `named` — the
 * file as the comparison names it, which is git's spelling and not the path a
 * run was given. `from` is the base file that may answer for it; at the base
 * that is the file itself.
 *
 * A survivor in EITHER run is a survivor, counted once: the settle run is a
 * second chance for a timeout, never a second chance to call an observed
 * survivor a kill. Each is identified against the source ITS OWN report carries,
 * which `reportUnlike` has already held to the content the run was counted over.
 *
 * `except` is the mutants a measurement could not DECIDE — see `undecidedAtBase`
 * — and it is how the one the two runs disagreed about leaves the pool: it was
 * observed alive in one of them, so the union holds it, and evidence that
 * disagrees with itself authorises nothing. A sweep HERE passes none, because
 * there the union is exactly what is wanted.
 */
function survivorsFound(subject, named, from, reports, except = new Set()) {
  const found = new Map()
  for (const report of reports) {
    /* A report that is of no file left no survivor to find: `survivorsIn`
       answers nothing for it, so the loop below simply does not run, and a guard
       here would be one nothing could be observed through. */
    const entry = reportEntryOf(subject, report)
    /* Parsed once for the whole report rather than once per mutant — see
       `parsedSource`. A report of no file has no source to parse, and no mutant
       to ask for one. */
    const parsed = entry === null ? null : parsedSource(entry.source, named)
    for (const mutant of survivorsIn([entry])) {
      if (!except.has(keyOf(mutant))) found.set(keyOf(mutant), survivorOf(mutant, named, from, parsed))
    }
  }
  return [...found.values()]
}

/** One survivor as both sides of the comparison carry one: where it sits, for a reader, and what it IS, for the pairing. */
function survivorOf(mutant, named, from, parsed) {
  return { file: named, from, at: placeOf(mutant), identity: identityIn(mutant, parsed) }
}

/**
 * What the merge base said about the survivors one run left here, as the
 * evidence a result carries and the aggregate derives its answer from again.
 *
 * Three answers, and the difference between them is the whole of this design:
 *
 * | | evidence | what a sweep does with it |
 * |---|---|---|
 * | the merge base has no file this could have come from | `null` | it is a NEW file, it owes 100 %, and nothing is measured |
 * | every survivor here was there too | no `added` | passes, and the numbers are printed |
 * | one was not, or the base could not be measured | `added`, or a `refusal` | fails, naming which — see `survivorsStand` |
 *
 * ⚠️ **A FAILURE TO MEASURE IS ITS OWN OUTCOME AND NEVER AN EMPTY ANSWER.** Every
 * refusal `measureAtBase` can make is carried into the evidence by name, so a
 * base that could not be measured fails LOUDLY rather than silently authorising
 * nothing, which is what an empty survivor list would have done — and rather than
 * silently authorising everything, which is what a caught-and-ignored error
 * would have done.
 *
 * ⚠️ **AND THIS SUBJECT'S VERDICT IS NOT THE SWEEP'S.** The pairing here is over
 * one subject, because that is all a shard can see — two subjects traced to one
 * base file are measured in two processes — and one base survivor spent in each
 * of them is one historical occurrence spent twice. So this number is an
 * arithmetic a reader can check and a lying shard is caught by, and the sweep's
 * own answer is the one pairing that sees every subject at once: `matchedAcross`,
 * run by the only two things that ever see a whole sweep — a plain sweep at its
 * end, and the aggregate.
 */
/**
 * The first test the merge base left out that is not here, unchanged — or `null`
 * where every one of them still is.
 *
 * Only the BASE's exclusions are asked about, and deliberately: head's set is the
 * narrower discovery's, so a reading test the base reached and head did not is
 * ordinary and says nothing. What matters is evidence the base could not weigh
 * and this change then moved. A reading test ADDED here is no risk either — it
 * cannot have killed anything at a commit that did not have it.
 */
function changedSinceBase(excluded, root) {
  for (const { path: named, sha256, why } of excluded) {
    const here = path.join(root, named)
    if (!existsSync(here)) return { path: named, how: 'is gone', why }
    if (digestOf(readFileSync(here)) !== sha256) return { path: named, how: 'has changed', why }
  }
  return null
}

/**
 * What the merge base offered and Vitest never ran, where nothing can prove the
 * test unrelated: each such test, every file on its import route to a load no
 * static graph can follow, and the file holding that load — by content, so that
 * `judgedAtBase` can refuse once one of them has moved.
 *
 * ⚠️ **VITEST RUNS WHAT IT CAN TRACE, NOT WHAT IT IS OFFERED** (measured
 * 2026-09-18). Stryker's runner turns on Vitest's `related` filter, which keeps
 * only the offered files whose import graph reaches the subject. That graph
 * cannot follow a computed `import(where)` — a probe with such a test as its only
 * test found none — nor, read in Vitest 4.1.11's `filterTestsBySource`, a module
 * that is not a file on disk (a plugin's `virtual:` one) or a path containing
 * `node_modules`. Turning the filter off is not the way out: the base is offered
 * every test it has, Stryker runs them in worker threads, and the first test that
 * calls `process.chdir()` ends the dry run — measured the same day, 20 s in.
 *
 * So a killer on such a route is missing from BOTH sides, exactly as a test that
 * reads the subject's source is (`excluded`), and the answer is the same one:
 * like with like while it is unchanged, and nothing authorised once the change
 * has touched it. What is recorded is the route as well as the test, because a
 * helper that stops making the hidden load weakens the test as surely as an edit
 * to the test does. What the load then REACHES is unknowable by construction —
 * that is what makes it hidden — and is the one part of the evidence this cannot
 * hold.
 *
 * Which tests ran is read from Stryker's own report, `testFiles`. A report that
 * names none leaves every offered test unrun, which records more rather than
 * less.
 */
export function unseenAtBase(offered, reports, root, { imports = remembered(importsOf), loads = remembered(hiddenIn(root)) } = {}) {
  const ran = new Set()
  for (const report of reports) {
    for (const name of Object.keys(report?.testFiles ?? {})) {
      ran.add(slashed(path.isAbsolute(name) ? path.relative(realPathOf(root), name) : path.normalize(name)))
    }
  }
  const entries = new Map()
  const record = (file, why) => {
    const named = slashed(path.relative(root, file))
    if (!entries.has(named)) entries.set(named, { path: named, sha256: digestOf(readFileSync(file)), why })
  }
  for (const test of offered) {
    const named = slashed(path.relative(root, test))
    if (ran.has(named)) continue
    for (const { route, how } of hiddenRoutes(test, imports, loads)) {
      const site = slashed(path.relative(root, route.at(-1)))
      for (const file of route) record(file, `${named} reaches ${how} in ${site}, which the merge base never ran`)
    }
  }
  /* In code-unit order, which no locale decides. */
  return [...entries.keys()].sort().map((named) => entries.get(named))
}

/**
 * Every load on `test`'s import route that no static graph can follow, each with
 * the route that reaches it — `test` first, the file holding the load last. The
 * shortest route to each file is the one kept: while it is unchanged the load is
 * still reached, which is all the record needs to know.
 */
function hiddenRoutes(test, imports, loads) {
  const found = []
  /* ⚠️ **THE MAP IS THE WALK, SO NO MUTANT OF IT CAN HANG** (2026-09-18). A
     queue with a parent map and a loop reading routes back through it had four
     mutants that looped for ever — a dropped cycle guard, a start with no entry —
     which a sweep can only time out on, never kill. A Map is iterated in
     insertion order and visits what is added while it is iterated, and setting a
     key it already has adds nothing, so every walk ends; each file keeps the
     route that first reached it. */
  const routes = new Map([[path.resolve(test), [path.resolve(test)]]])
  for (const [file, route] of routes) {
    for (const how of loads(file)) found.push({ route, how })
    for (const next of imports(file).map((target) => path.resolve(target))) {
      if (!routes.has(next)) routes.set(next, [...route, next])
    }
  }
  return found
}

/**
 * What one module loads that no static graph can follow, in a checkout at `root`:
 * `hiddenLoads`, plus an import that resolves to no installed package — an alias,
 * a plugin's `virtual:` module, a package's own `#` import, a root-absolute path —
 * and a relative one that lands under `node_modules`, which Vitest's walk skips.
 */
function hiddenIn(root) {
  return (file) => {
    const source = readFileSync(file, 'utf8')
    const found = hiddenLoads(source, file)
    for (const specifier of runtimeSpecifiers(source, file)) {
      if (specifier.startsWith('.')) {
        const target = resolveRelative(file, specifier)
        if (target !== null && target.split(path.sep).includes('node_modules')) found.push(`an import under node_modules, '${specifier}'`)
      } else if (!isBuiltin(specifier) && !isInstalled(specifier, root)) {
        found.push(`import '${specifier}', which is no installed package`)
      }
    }
    return found
  }
}

/**
 * Whether a bare specifier names a package installed at `root` — `@scope/name` or
 * `name`, before any subpath — by its manifest, which is what makes a directory a
 * package. A root-absolute path or a `#` import names none, and needs no case of
 * its own: no `node_modules/<name>/package.json` is spelled by either.
 */
function isInstalled(specifier, root) {
  const parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return existsSync(path.join(root, 'node_modules', name, 'package.json'))
}

/**
 * Whether a second, wider pass over this file can be afforded — and a line
 * saying so where it cannot.
 *
 * ⚠️ **THE WIDENED SWEEP HAD NO BOUND, AND A CI STEP HAS ONE** (2026-09-17). It
 * costs a whole extra sweep of the file, plus that sweep's settle run: measured
 * on `session.ts`, 31 and 30 minutes against a 12-minute narrow run. On the
 * heaviest subject this gate has — itself, estimated at 204 minutes for ONE
 * plain pass — starting a second one unbounded is how a 210-minute step ends
 * with no answer at all, which is worse than the wrong answer it was trying to
 * correct.
 *
 * A file's own sweep is the honest estimate of what sweeping it again costs, so
 * that is what is spent against the budget. Refusing to widen leaves the NARROW
 * bill standing, which is the conservative direction — this pass only ever
 * removes a charge — and the reader is told, because the remedy is to re-run
 * that one file alone, where there is no budget to share.
 */
function affordable(spent, named, stdout) {
  if (spent <= WIDEN_BUDGET_MS) return true
  stdout.write(
    `check-mutants: ${named} took ${Math.round(spent / 60_000)} minute(s) to sweep here, past the ${WIDEN_BUDGET_MS / 60_000} this gate ` +
      'will spend again to check a bill against the merge base\'s own wider set of tests. What it owes below is measured against ' +
      `the nearest tests alone, which can only ever bill MORE than the wider set would: re-run this file by itself — node scripts/check-mutants.mjs --only ${named} — before taking it as owed.\n`,
  )
  return false
}

/**
 * This subject's survivors HERE, measured against the same wide set of tests the
 * merge base is measured against — or `null` where that could not be done.
 *
 * `measuredHere` is already exactly this sweep: a whole file, discovered with
 * `reachingAtBase`, run with the settle run, reconciled against its own content.
 * It is written for the base's checkout and takes the world it is handed, so
 * handed head's world it answers for head. The one thing that must not be reused
 * is its FRAME: the survivors are named against `origin.path`, as `here` is, so
 * the two sides can be paired at all.
 *
 * A refusal answers `null` and the narrow bill stands. That is the conservative
 * way round in the one place it has to be: this run exists to REMOVE a charge,
 * so failing to make it may leave one standing but can never invent permission.
 */
async function killedWhenWidened(subject, named, origin, world) {
  let measured
  /* `named`, never `origin.path`: the first is what this file is called HERE and
     the second what it was called at the merge base, and a renamed subject has
     no file at the second one in this checkout. */
  try {
    measured = await measuredHere(named, world)
  } catch (cause) {
    if (!(cause instanceof BaseRefusal)) throw cause
    return null
  }
  if (measured.first === null) return null
  const at = path.join(world.root, named)
  const entry = reportEntryOf(at, measured.first.report)
  if (entry === null) return null
  /* ⚠️ **AND THIS RUN DOES SETTLE ITS TIMEOUTS, THOUGH IT COSTS A SECOND PASS.**
     Dropping the settle was tried and reverted the same day: it saves a
     30-minute sweep, and it pays for that by keeping a charge on any mutant the
     wide run merely ran out of clock on. A wall-clock timeout is usually LOAD —
     this gate has measured `App.tsx` at 58 timeouts busy and 0 quiet — so that
     trade re-introduces exactly the false bill this whole path exists to remove,
     and re-introduces it on the machines least able to argue with it. The cost
     is paid only by a file that would otherwise FAIL, which is the one case
     where being right is worth thirty minutes.
     A kill in EITHER run is evidence a test decided the mutant, which is all
     that may discharge a charge; the settle run re-runs the whole file, so its
     answer stands for any mutant it names. */
  const settled = measured.settle === null ? new Map() : answersIn(reportEntryOf(at, measured.settle.report))
  const parsed = parsedSource(entry.source, named)
  return entry.mutants
    .filter(isRecord)
    .filter((mutant) => definitelyKilled(mutant) || definitelyKilled(settled.get(keyOf(mutant)) ?? mutant))
    .map((mutant) => survivorOf(mutant, named, origin.path, parsed))
}

/**
 * Whether a report says a test DECIDED this mutant — the only answer that may
 * take a charge away.
 *
 * `KILLS` is too coarse for that: it holds `Timeout`, because Stryker scores one
 * as a kill and the head side rightly keeps that. Here the question is narrower.
 * A timeout at the ORIGINAL's hit limit is a detection and decides the mutant; a
 * WALL-CLOCK timeout decides nothing, and is exactly what a settle run exists to
 * resolve — which this sweep deliberately does not run. So it is not a kill here,
 * the bill it would have discharged stands, and the conservative answer is the
 * one reached by doing less work rather than more.
 */
function definitelyKilled(mutant) {
  if (mutant.status === 'Killed') return true
  return mutant.status === 'Timeout' && timeoutKindOf(mutant.statusReason) === 'hit-limit'
}

async function judgedAtBase(subject, named, origin, reports, { mergeBase, measure, world, spent = 0 }) {
  if (origin === null) return null
  const here = survivorsFound(subject, named, origin.path, reports)
  // Stryker disable next-line ArrayDeclaration: a refusal carries no measurement, so nothing reads this list — it is here so every evidence has one shape
  const empty = { origin, outcome: null, install: null, durationMs: 0, sha256: null, source: null, first: null, settle: null, authorised: 0, added: [], excluded: [], unseen: [] }
  const refused = (reason, message) => ({ evidence: { ...empty, refusal: { reason, message } }, paired: null })
  let measured
  try {
    measured = await measure(origin.path, mergeBase, world)
  } catch (cause) {
    if (!(cause instanceof BaseRefusal)) throw cause
    return refused(cause.reason, cause.message)
  }
  const evidence = { ...empty, ...measured, refusal: null }
  /* ⚠️ **AND WHAT THE MERGE BASE COULD NOT RUN MUST STILL BE THERE, UNCHANGED.**
     See `measuredHere`: a test that reads the subject's source is left out of
     both sweeps, so a mutant only it could kill survives on both sides and is
     rightly authorised — but ONLY while that test is the same on both sides. A
     change that deletes or edits one takes away evidence the base was never able
     to weigh, and the base's silence about the mutant then reads as debt. It is
     not: it is a killer this change removed. Nothing is authorised once one has
     moved, and the file is billed instead — the conservative way round, and the
     one a reader can act on, because the test is named. */
  const moved = changedSinceBase(evidence.excluded ?? [], world.root)
  if (moved !== null) {
    return refused(
      'reading-changed',
      `check-mutants: ${moved.path} reads ${origin.path}'s own source, so neither sweep could run it — and it ${moved.how} ` +
        'since the merge base, which is evidence this comparison cannot weigh. Nothing in this file is authorised by a base ' +
        'whose excluded test is not the one here: kill the mutants it used to, or restore it.',
    )
  }
  /* ⚠️ **AND THE SAME FOR A TEST VITEST NEVER RAN.** A test on a route no static
     graph follows was offered at the merge base and dropped by Vitest's
     `related` filter there, as it is here — missing from both sides, exactly as
     an excluded reader is, and for the same reason harmless only while nothing on
     that route has moved. See `unseenAtBase`. */
  const unseen = changedSinceBase(evidence.unseen, world.root)
  if (unseen !== null) {
    return refused(
      'unseen-changed',
      `check-mutants: ${unseen.path} ${unseen.how} since the merge base — ${unseen.why}. A killer on that route was never run ` +
        `on either side, so nothing in ${origin.path} is authorised by a base whose route is not the one here: kill the ` +
        'mutants with a test Vitest can trace to the file, or leave the route as it was.',
    )
  }
  /* Read back exactly as the aggregate will read it, and against the content the
     merge base itself holds — which the origin froze, and which is the whole of
     what stops a measurement of something else being carried as this one's. */
  const { survivors, undecided, problem } = await survivorsAtBase(evidence, {
    at: path.join(world.root, origin.path),
    named: origin.path,
    frozen: origin.sha256,
  })
  /* ⚠️ **AND WHERE ITS REASON IS, BECAUSE THIS TRAVELS AND THE REASON DOES NOT.**
     The child that measures the base writes Stryker's own words to THIS process's
     stderr (`spawnMeasurement` inherits both streams), so in a plain sweep they
     are already on screen above this line. In a sharded run they are in the log
     of the shard that ran it — a different job from the aggregate that reports
     this, with no stdout of that run anywhere near it. A refusal that says a run
     scored nothing and does not say where it said why sends a reader to their own
     diff for a failure that was never about their change; measured 2026-09-17,
     when a shard's base measurement wrote no report and the container holding the
     only copy of the reason had already been thrown away. */
  if (problem !== undefined) {
    return refused(
      problem.reason,
      `check-mutants: the merge base’s run of ${origin.path} ${problem.why}. Its own output is above in a plain sweep, and in the ` +
        'log of the shard that ran it in a sharded one — read that before reading any test, because a run that scored nothing ' +
        'failed for a reason of its own',
    )
  }
  /* ⚠️ **THE TWO SIDES DO NOT DISCOVER THE SAME TESTS, AND THE DIFFERENCE WAS
     BILLED TO THE CHANGE.** Head sweeps a subject against the NEAREST level of
     tests that reaches it; the merge base sweeps it against every test that
     reaches it by any chain — `coveringTests` against `reachingAtBase`. More
     tests can only kill more, so the asymmetry can never authorise a mutant that
     was not there, which is why it was taken as safe. It is safe in that
     direction and wrong in the other: a mutant a DISTANT test kills at the base
     and no near test even runs at head is a survivor here, no survivor there,
     and therefore billed as one this change added — although the change added
     nothing.

     Measured 2026-09-17 on the real thing: one comment appended to
     `session.ts`, head sweeping 215 tests and the base 527, and BOTH of the two
     mutants it billed were of exactly this kind. The bill for a comment is zero.

     So a bill is never taken on the narrow run alone. When the comparison would
     charge for something, the subject is swept again HERE against the same wide
     set the base used, and the answer is REPLACED rather than unioned — a union
     would keep precisely the false bill the second run exists to discharge. It
     costs a sweep, it is paid only by a file that would otherwise fail, and a
     file that was going to pass never pays it. A run that cannot be made leaves
     the narrow bill standing, because refusing to measure is never permission. */
  const narrow = differenceAtBase(survivors, undecided, here)
  if (narrow.added.some((one) => one.class === 'added') && affordable(spent, origin.path, world.stdout)) {
    const wide = await killedWhenWidened(subject, named, origin, world)
    if (wide !== null) {
      /* ⚠️ **THE SECOND RUN MAY ONLY TAKE A CHARGE AWAY, NEVER ADD ONE.** The
         whole argument for widening is that more tests kill more — and a second
         opinion's fifth round declined to grant that of THIS runner, pointing at
         a configuration in this gate's own history that turned 85 kills into
         uncovered mutants. If the wide run can report a mutant the narrow one
         killed as surviving, then replacing one answer with the other would
         invent a bill, which is the very thing this is here to stop.

         So the wide run is read for one thing only: which of these mutants a
         test there DEFINITELY decided. Those stop being billed, which is the
         point. Everything else — a survivor, a wall-clock timeout, no coverage,
         a runner that died — leaves the charge exactly where the narrow run put
         it. Nothing the wide run says can create one, so this needs no
         monotonicity to be sound, and that is why it is a filter over kills
         rather than the recomputation it looks like it should be. */
      const killed = new Set(wide.map((one) => JSON.stringify(one.identity)))
      const kept = here.filter((one) => !killed.has(JSON.stringify(one.identity)))
      return {
        evidence: { ...evidence, ...differenceAtBase(survivors, undecided, kept), widened: true },
        paired: { at: subject, named, origin, here: kept, atBase: survivors, undecided },
      }
    }
  }
  return {
    evidence: { ...evidence, ...narrow },
    /* What the sweep's own pairing needs, and what no record carries: both sides'
       survivors and the mutants the merge base could not decide, derived. A result
       carries the evidence they were derived FROM. */
    paired: { at: subject, named, origin, here, atBase: survivors, undecided },
  }
}

/**
 * What a merge base's evidence holds, derived from the evidence and never taken
 * from a list beside it: the survivors it found, and the mutants it could not
 * DECIDE — or `{ problem }` saying why it holds nothing that can be believed.
 *
 * ⚠️ **THOSE ARE TWO DIFFERENT FAILURES AND WERE ONE** (2026-09-17). A failure to
 * MEASURE THE FILE is a `problem`: the file is refused whole and nothing in it is
 * authorised. A failure to DECIDE ONE MUTANT — `undecidedAtBase` — leaves that
 * identity unknown and every other mutant of the file exactly where it was.
 * Measured on an isolated runner with real history: one comment added to a
 * 1 403-mutant file left 545 mutants unkilled here, and five mutants the merge
 * base could not decide had been refusing the 540 it could.
 *

 * ⚠️ **A SUPPLIED LIST BOUGHT EVERYTHING IT CLAIMED** (review, 2026-09-17). A
 * result claiming `no-mutants` at the merge base with this file's own survivors
 * copied into its `survivors` exited 0, with no base measurement having happened
 * at all: the aggregate re-derived the PAIRING and then ran it against a list the
 * shard wrote. So there is no such list any more. What a measurement carries is
 * what head's own run carries — the content it swept, and Stryker's reports of
 * sweeping it — and every reader hashes the content against what the merge base
 * holds, holds each report to being of that content and of exactly its mutants,
 * and reads the survivors out of the reports. A shard's word for what the merge
 * base owed is now worth exactly what its word for its own outcome is worth: the
 * reports it carries, which nothing can derive again, and everything else derived
 * again from them.
 *
 * `frozen` is the content hash the merge base's own commit holds for this file —
 * from the plan for a shard, from the traced origin for a plain sweep. The
 * measurement itself passes its own, which is a tautology there and is the point:
 * the child measures what it has, and the freezing is the caller's to enforce.
 *
 * ⚠️ **WHAT THIS IS STILL WORTH, SAID PLAINLY.** It is exactly what head's own
 * reconciliation is worth and no more: the content is pinned, the report must be
 * OF that content and hold exactly its mutants, and the survivors are read out of
 * it — but a STATUS in a report is nobody's to derive again without running the
 * measurement again. A shard that lies about a status is not caught here, and is
 * not caught on the head side either.
 *
 * ⚠️ **AND THE MUTANTS ARE COUNTED HERE BY THIS CHECKOUT'S INSTRUMENTER.** The
 * measurement's own were counted by the base's — see `identitiesOfSource` — so
 * two installs that enumerate the same source differently, within one major
 * version, make this refuse a report that was honest. That is a false refusal
 * and it fails the build rather than passing it; the alternative is taking the
 * inventory from the record, which is the supplied list this exists to remove.
 */
export async function survivorsAtBase(evidence, { at, named, frozen }) {
  const { outcome, sha256, source, first, settle } = evidence
  if (sha256 !== frozen) {
    return { problem: { reason: 'content', why: `measured content hashing to ${shown(sha256)}, and the merge base holds ${shown(frozen)} at ${named}` } }
  }
  if (typeof source !== 'string' || digestOf(source) !== sha256) {
    return { problem: { reason: 'content', why: 'carries a source that is not the content it says it measured' } }
  }
  const identities = await identitiesOfSource(named, source)
  if (outcome === 'no-mutants') {
    if (identities.length > 0) return { problem: { reason: 'mismatched', why: `says it had nothing to mutate, and this gate makes ${identities.length} mutant(s) in what it carries` } }
    if (first !== null) return { problem: { reason: 'mismatched', why: 'says it had nothing to mutate and carries a run of it' } }
    return { survivors: [], undecided: [] }
  }
  if (first === null) return { problem: { reason: 'did-not-run', why: `says ${outcome} and carries no run at all, and a run nobody has is not a survivor that was already there` } }
  const against = { named, sha256, identities, whose: 'the merge base' }
  const entry = reportEntryOf(at, first.report)
  const unlike = reportUnlike(entry, against)
  if (unlike !== null) return { problem: { reason: 'mismatched', why: `did not report on what it swept — ${unlike}` } }
  const settled = settle === null ? null : reportUnlike(reportEntryOf(at, settle.report), against)
  if (settled !== null) return { problem: { reason: 'mismatched', why: `did not report on what its settle run swept — ${settled}` } }
  const verdict = settledVerdict(at, first, settle)
  const unmeasured = unmeasuredAtBase(at, verdict, first, settle)
  if (unmeasured !== null) return { problem: unmeasured }
  /* ⚠️ **A REPORT OF NO FILE SAYS NOTHING, AND `reportUnlike` LETS IT PASS** —
     deliberately, since `outcomeOf` makes it a run with no score, which the
     verdict above has just refused. What it does NOT refuse is a first run that
     reported on nothing beside a settle run that reported a survivor: a survivor
     outranks every other outcome, so the whole verdict would rest on the second
     run alone. */
  if (entry === null) {
    return { problem: { reason: 'did-not-run', why: `says ${outcome} over a run that reported on no file, and a report of nothing is no measurement` } }
  }
  /* ⚠️ **AND THE SETTLE RUN HAD NO SUCH CHECK, SO ITS SILENCE WAS READ AS A
     MUTANT-LEVEL HOLE** (review, 2026-09-17). The check above exists because a
     survivor outranks every other outcome, so a first run that reported on
     nothing beside a settle run that found one would rest the whole verdict on
     the second; the mirror image is exactly as bad and was not refused. With a
     survivor in the FIRST run, `measured` is `survived` whatever the settle run
     did — so a settle report that was `null`, `{files:{}}` or about another file
     passed, the survivor was authorised, and the wall-clock timeout beside it was
     named as one mutant the base could not decide. It is not one mutant: nothing
     measured the settle run at all, and a settle run that measured nothing
     settles nothing. `noScoreOf` says WHICH of its seven failures it was, because
     this refusal travels as a value into an aggregate with no stdout of that run
     anywhere near it. */
  if (settle !== null && reportEntryOf(at, settle.report) === null) {
    return {
      problem: {
        reason: 'did-not-run',
        why:
          `says ${outcome} over a settle run that measured nothing: it ${noScoreOf(at, settle.exitedCleanly, settle.report)}. ` +
          'A run that could not measure is not a survivor that was already there',
      },
    }
  }
  if (verdict.measured !== outcome) return { problem: { reason: 'mismatched', why: `says ${outcome}, and its own report says ${verdict.measured}` } }
  const unknown = alsoStatic(undecidedAtBase(entry, settle === null ? null : reportEntryOf(at, settle.report)), entry)
  const spent = new Set(unknown.map(({ mutant }) => keyOf(mutant)))
  const parsed = parsedSource(entry.source, named)
  return {
    survivors: survivorsFound(at, named, named, [first.report, settle === null ? null : settle.report], spent),
    undecided: unknown.map(({ mutant, why }) => ({ ...survivorOf(mutant, named, named, parsed), why })),
  }
}

/**
 * The merge base's undecided mutants, plus every survivor its report marks
 * `static` — which this gate already knows may not be a survivor at all.
 *
 * ⚠️ **A FALSE SURVIVOR AT THE BASE HAD BECOME PERMISSION HERE** (a second
 * opinion's fifth round, 2026-09-17). Stryker's vitest runner reports a mutant
 * that makes the module throw while it is IMPORTED as `Survived`, because a
 * suite that fails to load fails no test — this file's own header measures it,
 * and names three live examples. Until the merge base was consulted that error
 * was harmless in the conservative direction: a false survivor FAILED a sweep,
 * and the remedy was to check it by hand. Reading the same status at the base
 * turns it the other way round, and a mutant that may never have run becomes a
 * reason not to bill one here.
 *
 * So a static survivor at the base decides nothing, exactly like a mutant its
 * two runs disagreed about: it is named, it is not permission, and the identity
 * is the change's to settle. **That has an end**, and it is the one AGENTS.md
 * already prescribes: verify it by hand and, where it does throw at import,
 * disable it beside the code with that reason. A disabled mutant is `Ignored` in
 * both sweeps, so it is never a survivor again on either side, and the file
 * stops being billed for it for good.
 */
function alsoStatic(unknown, entry) {
  const already = new Set(unknown.map(({ mutant }) => keyOf(mutant)))
  /* Every entry is a mutant: `survivorsAtBase`, the only caller, reaches here only
     after `reportUnlike` has matched each one to a mutant this gate counted. */
  const statics = entry.mutants
    .filter((mutant) => mutant.static === true && SURVIVALS.has(mutant.status) && !already.has(keyOf(mutant)))
    .map((mutant) => ({
      mutant,
      why:
        'the merge base’s report marks it static, and a static mutant that throws while the module is imported is reported ' +
        'Survived by Stryker’s vitest runner because the suite fails to load — so whether it survived there or never ran is ' +
        'not something that report can say',
    }))
  return [...unknown, ...statics]
}

/**
 * How a merge base's measurement failed to measure THE FILE, or `null` where it
 * did measure it.
 *
 * ⚠️ **A SURVIVOR BESIDE IT SUPPRESSED THIS** (review, 2026-09-17). A survivor
 * outranks everything else as a file's OUTCOME — rightly, on the head side, where
 * the survivor is the finding — so a base run that scored nothing beside one came
 * back `survived` and was taken as an answer. What is asked of the base is not an
 * outcome but whether it MEASURED, so `measured` is what is read: the outcome with
 * the mutant-level holes left out, which is `did-not-run` for a run Stryker scored
 * nothing of, however many mutants it went on to answer for.
 *
 * ⚠️ **AND EVERY HOLE WAS ONCE READ THIS WAY, WHICH IS THE WRONG GRANULARITY**
 * (2026-09-17). A repeated wall-clock timeout, a mutant the settle run never
 * answered for and two runs that disagreed each refused the whole file — so five
 * undecided mutants in a 1 403-mutant file made the 540 it had decided perfectly
 * well worthless, and a one-comment change owed all of them. Those three are
 * `undecidedAtBase`'s now: one identity each, and nothing else. What is left here
 * is the file itself, and it is unchanged.
 *
 * ⚠️ **AND IT SAID "SCORED NOTHING" AND NOTHING ELSE, WHICH IS A REFUSAL NOBODY
 * CAN ACT ON** (2026-09-17). Seven different failures reach here under one word —
 * see `noScoreOf` — and this message carried none of them, so a base measurement
 * that died on its runner read exactly like one that reported on the wrong file.
 * The RUN that decided is named too, and which one it is follows from
 * `settledVerdict`'s own rule: `measured` is the settle run's outcome where there
 * is a settle run, and the first run's where there is not.
 */
function unmeasuredAtBase(at, verdict, first, settle) {
  if (verdict.measured !== 'did-not-run') return null
  const run = settle ?? first
  const whose = settle === null ? 'it' : 'its settle run'
  return {
    reason: 'did-not-run',
    why:
      `scored nothing (did-not-run): ${whose} ${noScoreOf(at, run.exitedCleanly, run.report)}. ` +
      'A run that could not measure is not a survivor that was already there',
  }
}

/**
 * Which mutants a merge base's two runs could not DECIDE, each with the reason in
 * the base's own voice — a wall-clock timeout its settle run met again, a mutant
 * the settle run never answered for, a mutant the runs ended at the original's HIT
 * LIMIT, and a mutant the two runs disagreed about.
 *
 * ⚠️ **THE QUESTION IS WHAT THE BASE'S FINAL ANSWER WAS, AND A HIT LIMIT IS NOT
 * ONE** (review, 2026-09-17). Every wall-clock timeout was read here and the four
 * ways one can end were not told apart:
 *
 * | the first run | the settle run | the base's answer |
 * |---|---|---|
 * | a wall-clock timeout | `Survived` | a SURVIVOR — it was observed alive, and authorises a survivor here |
 * | a wall-clock timeout | a test failed on it | a KILL — a survivor here is one this change added |
 * | a wall-clock timeout | a wall-clock timeout | undecided, and it fails |
 * | a wall-clock timeout | the original's hit limit | **undecided**, and it fails |
 * | the original's hit limit | not re-run | **undecided**, and it fails |
 *
 * The last two are the change. Stryker SCORES a hit-limit timeout a kill and this
 * gate keeps that on the head side, where "the mutated code ran a hundred times
 * the original's hit count" is a perfectly good reason not to ask a developer for
 * a test. As the merge base's answer it is a different thing: nothing ASSERTED
 * anything about that mutant — a bound was reached — so "the merge base has no
 * survivor with this identity" would send a reader to a diff on the strength of a
 * resource observation. It authorises nothing either way, so what changes is the
 * sentence and never the verdict. The reading it replaces is defensible — the
 * detection is deterministic, measured 13 of 13 across three concurrency settings
 * — which is exactly why this is a SENTENCE and not an authorisation.
 *
 * ⚠️ **NONE OF THESE IS A SURVIVOR AT THE MERGE BASE, AND NONE IS A FAILURE OF
 * THE FILE.** An unanswered mutant is unanswered about ITSELF: every other mutant
 * in the report carries its own observation, and load does not turn a kill into a
 * survival. What it does turn is a survivor into a timeout — measured 2026-09-15,
 * 42 of 140 replayed wall-clock timeouts came back `Survived` — so a loaded base
 * run reports FEWER survivors than the truth, which authorises less rather than
 * more. That is the whole of why one hole may be named without the file around it
 * being refused.
 *
 * ⚠️ **THE UNION IS CONSERVATIVE FOR HEAD AND BACKWARDS FOR THE BASE** (review,
 * 2026-09-17). `survivorsIn` takes a survivor in either run, because an observed
 * survivor is never averaged away — which is right where a survivor is a failure,
 * and inverted where it is PERMISSION. A mutant the first run killed and the
 * settle run left alive entered the authorisation pool through that union, so a
 * flaky base kill turned into a licence for a survivor here. It is named here
 * instead, and `survivorsAtBase` takes it back out of the survivors: conflicting
 * evidence authorises nothing.
 *
 * A wall-clock timeout in the FIRST run is the one status that is not a
 * disagreement. It is the question the settle run exists to answer, so whatever
 * the settle run says of it stands — which is what `settledVerdict` says of the
 * same pair, and which the loop above has already decided.
 */
function undecidedAtBase(first, settle) {
  const answers = answersIn(settle)
  const found = []
  const { detected, unsettled } = timeoutsIn(first)
  for (const { mutant, answer, how } of settledEach(unsettled, answers)) {
    if (how === 'repeated') found.push({ mutant, why: `its settle run met the same wall-clock timeout again at ${unrecognised(answer)}` })
    else if (how === 'unresolved') {
      const why =
        settle === null
          ? `its run left a wall-clock timeout at ${placeOf(mutant)} that nothing settled`
          : `its settle run never answered for the mutant at ${placeOf(mutant)}`
      found.push({ mutant, why })
    } else if (how === 'killed' && answer.status === 'Timeout') {
      found.push({ mutant, why: `its settle run answered the wall-clock timeout at ${placeOf(mutant)} by reaching the original’s hit limit, which is a bound and not a test` })
    }
  }
  /* The first run's own hit limits, which nothing re-runs: Stryker scores them
     kills and a sweep HERE keeps that, because a mutant that will not stop is not
     a test a developer owes. At the merge base the same status is a bound the run
     reached, not an answer about the mutant. */
  for (const mutant of detected) {
    found.push({ mutant, why: `its run reached the original’s hit limit at ${placeOf(mutant)}, which is a bound and not a test` })
  }
  /* Every entry is a mutant — see `alsoStatic`, which is reached by the same road. */
  for (const mutant of first.mutants) {
    const again = answers.get(keyOf(mutant))
    if (again === undefined) continue
    /* ⚠️ **A TIMEOUT OF EITHER KIND IS ALREADY ANSWERED FOR ABOVE**, and every
       mutant in `found` is one: a wall-clock timeout by what its settle run said,
       a hit-limit one as the bound it is, whatever the settle run said. So
       skipping them here is also what names each mutant once — which a set of
       what was found used to do, and which after this line could never match
       (2026-09-18: both it and a test of the timeout's KIND here were mutants no
       test could kill). */
    if (mutant.status === 'Timeout') continue
    if (SURVIVALS.has(mutant.status) === SURVIVALS.has(again.status)) continue
    found.push({
      mutant,
      why: `its two runs answered for the mutant at ${placeOf(mutant)} with ${mutant.status} and then with ${again.status}`,
    })
  }
  return found
}

/**
 * Whether evidence leaves a survivor standing — one the merge base did not
 * answer for, or a merge base that could not be measured at all.
 *
 * ⚠️ **"COULD NOT RUN" MUST NEVER READ AS "IT ALREADY SURVIVED".** A refusal
 * carries no survivors, so anything that asked only whether `added` was empty
 * would have passed every file whose base could not be measured — the exact
 * inversion this comparison exists to refuse. Both questions, and either one
 * standing fails the file.
 */
function survivorsStand(evidence) {
  return evidence.refusal !== null || evidence.added.length > 0
}

/**
 * Which of the survivors here the merge base's own survivors answer for, and
 * which they do not — the difference a result records and the aggregate derives
 * AGAIN from the same evidence, so that a shard's word for "authorised" is never
 * taken.
 */
function differenceAtBase(atBase, undecided, here) {
  const { authorised, added } = matchedSurvivors(atBase, here, undecided)
  return {
    authorised: authorised.length,
    added: added.map(({ here: one, why, class: how }) => ({ file: one.file, at: one.at, identity: one.identity, why, class: how })),
  }
}

/**
 * The pairing over a WHOLE sweep: every subject's survivors against one pool per
 * base file, answered `file → { authorised, added }`.
 *
 * ⚠️ **ONE HISTORICAL OCCURRENCE WAS SPENT ONCE PER SUBJECT** (review,
 * 2026-09-17). `judgedAtBase` pairs one subject at a time, because a shard sees
 * one subject at a time — so a change that copies a file into two, each traced to
 * the same origin, had the origin's single survivor authorise BOTH, in two
 * processes neither of which could see the other. The guarantee that survived
 * that was only "each of them has an equivalent shape somewhere at the merge
 * base", which is not the one this gate states.
 *
 * So the two things that ever see a whole sweep run it again over every subject
 * at once: a plain sweep at its end, and the aggregate, which is the only mode
 * that can say a sharded sweep passed. Each base file contributes ONE pool
 * however many subjects were traced to it.
 *
 * ⚠️ **AND TWO MEASUREMENTS THAT DIFFERED THREW THE WHOLE FILE'S POOL AWAY**
 * (review, 2026-09-17), which is the file-wide penalty the rest of this change
 * exists to end, arriving through the fix for something else. Two shards measuring
 * one origin, agreeing about A and B and differing about C, left both head
 * subjects with ZERO authorisations — so a survivor of A, in code nobody touched,
 * was billed because a THIRD mutant somewhere else in that file had answered twice.
 *
 * The reconciliation is per BASE MUTANT, which is the granularity every other hole
 * in this design is read at. A mutant every measurement of the origin found alive
 * stands in the pool; one only some of them found is UNDECIDED — it authorises
 * nothing, and a survivor here matching it is named as one the merge base could
 * not decide rather than as one the change added. The file around it is judged
 * exactly as it would have been, and there is no file-level refusal left: this is
 * the same flakiness `undecidedAtBase` already reads per mutant when ONE
 * measurement's two runs disagree, at a larger radius.
 *
 * ⚠️ **AND THE UNDECIDED ARE TAKEN FROM EVERY MEASUREMENT.** An identity ANY
 * measurement could not decide is one the merge base did not decide, and nothing
 * about it authorises anything, so a union can only improve the sentence a reader
 * gets.
 */
export function matchedAcross(entries) {
  const measured = new Map()
  for (const { origin, atBase } of entries) {
    measured.set(origin.path, [...(measured.get(origin.path) ?? []), atBase])
  }
  const pooled = []
  const contested = []
  for (const [named, runs] of measured) {
    const found = new Map()
    for (const [which, run] of runs.entries()) {
      for (const survivor of run) {
        const at = found.get(survivorKey(survivor)) ?? { survivor, seen: new Set() }
        at.seen.add(which)
        found.set(survivorKey(survivor), at)
      }
    }
    for (const { survivor, seen } of found.values()) {
      if (seen.size === runs.length) pooled.push(survivor)
      else contested.push({ ...survivor, why: `${seen.size} of the ${runs.length} measurements of ${named} found it alive and the rest did not` })
    }
  }
  const { authorised, added } = matchedSurvivors(pooled, entries.flatMap(({ here }) => here), [
    ...entries.flatMap(({ undecided }) => undecided),
    ...contested,
  ])
  const byFile = new Map(entries.map(({ named }) => [named, { authorised: 0, added: [] }]))
  for (const { here } of authorised) byFile.get(here.file).authorised += 1
  for (const { here, why, class: how } of added) {
    byFile.get(here.file).added.push({ file: here.file, at: here.at, identity: here.identity, why, class: how })
  }
  /* ⚠️ **AND THE DISAGREEMENTS THEMSELVES ARE REPORTED, NOT ONLY ACTED ON** (a
     second opinion's fifth round, 2026-09-17). A contested identity changes what
     a run SAYS only when a survivor here consumes it; where none does, two
     measurements of one base file could disagree about any number of mutants and
     the sweep would pass without a word. That is measurement health, and it is
     the cheapest early sign of a base whose runs are not reproducible — which is
     the thing this whole comparison rests on. The pass is unchanged; the reader
     is told. */
  return { byFile, contested, measurements: [...measured].map(([named, runs]) => [named, runs.length]) }
}

/** One survivor of one base file as two measurements of it name the same one: where it sits, and what it is. */
function survivorKey(survivor) {
  return JSON.stringify([survivor.at, poolKey(survivor.file, survivor.identity)])
}

/** A measurement read from `file`, as `{ record }`, or what is wrong with it, as `{ problem }`. */
function measurementIn(file) {
  let record
  try {
    // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — measured, both parse the same record
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    return { problem: messageOf(cause) }
  }
  const problem = measurementProblem(record)
  return problem === null ? { record } : { problem }
}

/**
 * The outcomes a measurement can end in — every one of them an answer, where a
 * refusal is the absence of one.
 *
 * ⚠️ **`no-test-at-base` WAS ONE OF THEM AND IS NOW A REFUSAL** — see
 * `measuredHere`. It said "nothing there reaches it, so everything survived",
 * which is what a discovery failure says too.
 */
const MEASURED = new Set(['killed', 'survived', 'nothing-to-kill', 'no-mutants'])

/** What is wrong with a measurement a child wrote, or `null` when nothing is. */
function measurementProblem(record) {
  if (!isRecord(record) || record.kind !== 'measurement') return 'it is not a measurement'
  if (record.version !== RECORD_VERSION) return `its version is ${shown(record.version)}, and this gate reads version ${RECORD_VERSION}`
  if (typeof record.subject !== 'string' || record.subject === '') return `its subject is ${shown(record.subject)}, which is not a path`
  if (record.refusal !== null) {
    if (!isRecord(record.refusal)) return `its refusal is ${shown(record.refusal)}, which is neither a refusal nor null`
    for (const key of ['reason', 'message']) {
      if (typeof record.refusal[key] !== 'string' || record.refusal[key] === '') {
        return `its refusal.${key} is ${shown(record.refusal[key])}, which is not a reason`
      }
    }
    return null
  }
  if (!MEASURED.has(record.outcome)) return `its outcome is ${shown(record.outcome)}, which this gate does not measure`
  if (!isDuration(record.durationMs)) return `its durationMs is ${shown(record.durationMs)}, which is not a duration`
  return measuredProblem(record, 'its ')
}

/**
 * What is wrong with the EVIDENCE a measurement is made of — the content it
 * swept and the runs that swept it — or `null` when nothing is. `whose` names it
 * as a measurement's own fields or as a result's `base.` ones, which are the
 * same fields read by the same derivation.
 */
function measuredProblem(record, whose) {
  if (!isDigest(record.sha256)) return `${whose}sha256 is ${shown(record.sha256)}, which is not a digest`
  if (typeof record.source !== 'string') return `${whose}source is ${shown(record.source)}, which is not the content it swept`
  return (
    runProblem(record.first, whose, 'first') ??
    runProblem(record.settle, whose, 'settle') ??
    unweighedProblem(record.excluded, `${whose}excluded`, 'a test the merge base left out') ??
    unweighedProblem(record.unseen, `${whose}unseen`, 'a file on a route the merge base never ran', true)
  )
}

/**
 * What is wrong with a list of files the merge base could not weigh — `excluded`
 * or `unseen` — or `null` when nothing is.
 *
 * Each names a file `changedSinceBase` will read, by a path joined to the
 * checkout, so a path that could leave it is refused here rather than followed
 * there: relative, `/`-separated, and with no `..` in it — the same rule every
 * path given to this gate is held to.
 */
function unweighedProblem(list, field, what, explained = false) {
  if (!Array.isArray(list)) return `${field} is ${shown(list)}, which is not a list`
  for (const [at, one] of list.entries()) {
    const said = !explained || (typeof one?.why === 'string' && one.why !== '')
    if (!isRecord(one) || !isCheckoutPath(one.path) || !isDigest(one.sha256) || !said) {
      return `${field} ${at + 1} is ${shown(one)}, which is not ${what}`
    }
  }
  return null
}

/** A path inside a checkout as a record spells one: relative, `/`-separated, and never climbing out. */
function isCheckoutPath(named) {
  if (typeof named !== 'string' || named === '' || named.includes('\\') || path.posix.isAbsolute(named) || path.win32.isAbsolute(named)) {
    return false
  }
  return !named.split('/').includes('..')
}

/** A survivor as `survivorOf` writes one: a file, and the identity a pairing is made over. */
function isSurvivor(value) {
  if (!isRecord(value) || typeof value.file !== 'string' || value.file === '' || !isRecord(value.identity)) return false
  const { mutatorName, replacement, original, statement, scope } = value.identity
  if ([mutatorName, replacement, original, statement].some((one) => typeof one !== 'string')) return false
  return Array.isArray(scope) && scope.every((one) => typeof one === 'string')
}

/**
 * Whether the record a measurement writes would land on the file it measures.
 *
 * ⚠️ **`--measure src/a.ts --into src/a.ts` PARSED, MEASURED, AND THEN WROTE JSON
 * OVER THE SOURCE** (review, 2026-09-17). Nothing inside this gate can spell
 * that — a sweep names a file in a scratch directory of its own — but the mode is
 * on the command line, and what a hand can type it must refuse.
 *
 * Both spellings are compared, as in `overlapOf` and for its reason: the output
 * with its directories resolved but its own last part left alone, which is where
 * a link at the output's name lives, and the output resolved the whole way. So
 * neither a link planted at the name nor a link among the directories above it
 * can reach the subject under another spelling. Git is not asked, because a
 * measurement asks git nothing.
 */
function writtenOverSubject(subject, into, root) {
  const { fold } = pathsAt(caselessAt(realPathOf(root)))
  const measured = fold(realPathOf(path.join(root, subject)))
  const asWritten = path.join(realPathOf(path.dirname(into)), path.basename(into))
  return [asWritten, realPathOf(into)].some((one) => fold(one) === measured)
}

/**
 * Where `at` really is when that is outside the checkout at `root`, as
 * `{ real, top }`, and `null` when it is inside it — see `measuredHere`, which is
 * the only caller and carries the argument.
 *
 * The checkout's own root is resolved too, rather than taken as it was given: a
 * scratch checkout under `/tmp` on a Mac IS `/private/tmp`, so comparing a
 * resolved path against an unresolved root would put every file in this suite
 * outside its own checkout.
 */
function reachedOutside(at, root) {
  const top = realPathOf(root)
  const { fold } = pathsAt(caselessAt(top))
  const real = realPathOf(at)
  return outsideCheckout(path.relative(fold(top), fold(real))) ? { real, top } : null
}

/**
 * Whether git exits cleanly, for a question whose answer is its exit and nothing
 * else.
 *
 * ⚠️ **WRITTEN OVER A VARIABLE RATHER THAN AS TWO RETURNS, SO THAT EMPTYING THE
 * CATCH IS A DIFFERENCE** (2026-09-17). `catch { return false }` emptied returns
 * `undefined`, which every caller here reads through a `!` — so the mutant that
 * removes the whole refusal is equivalent, and a directive cannot reach it
 * either: Babel attaches no leading comment to a catch clause, so one written
 * above `} catch {` is inert and looks exactly like one that works. With the
 * answer in a variable, an emptied catch leaves it `true` and a commit that is
 * not here reads as one that is.
 */
function gitAnswers(args, cwd) {
  let answered = true
  try {
    execFileSync('git', args, silently(cwd))
  } catch {
    answered = false
  }
  return answered
}

/**
 * How git is run where nothing it SAYS is wanted — neither this gate's output nor
 * its evidence.
 *
 * The shorthand rather than a list of three, because each entry of a list is a
 * `StringLiteral` mutant of its own and all three carry the same argument: one
 * spelling, one argument, one directive (2026-09-17). There is no way to say
 * "discard every stream" without a string, so unlike `spawnMeasurement`'s
 * descriptors this one cannot be removed — only stated.
 */
function silently(cwd) {
  // Stryker disable next-line StringLiteral: nothing this gate can observe reads what git says here — every caller discards both the answer and the throw — so what another spelling changes is what a person sees on a terminal, which no test watches
  return { cwd, stdio: 'ignore' }
}

/** A base worktree's own lock: there is none — see `measureAtBase`. Written as
 *  two declarations, because as one arrow returning another the inner one's
 *  mutant is equivalent and shares its line with the outer one's, which is not. */
function unlocked() {
  return released
}

/** And so nothing to release. */
function released() {}

/** Where a base worktree is checked out, which is never inside the checkout it is measured against. */
function baseScratch() {
  return mkdtempSync(path.join(tmpdir(), 'check-mutants-base-'))
}

/**
 * What the base's tests are run against: this checkout's install where the base
 * pins exactly what this checkout pins, and the base's own otherwise.
 *
 * ⚠️ **THE LOCKFILE IS THE WHOLE OF THAT QUESTION, AND `package.json` IS THE
 * REST OF IT.** A lockfile pins every dependency, so two commits carrying the
 * same bytes there have the same dependency tree by identity — linking this
 * checkout's `node_modules` is then not an overlay but the same install. What a
 * lockfile does NOT carry is what pnpm reads beside it — its `pnpm` block, its
 * `packageManager` — so the manifest is compared too. Neither the same, and the
 * base is installed from its own lockfile.
 *
 * ⚠️ **AND AN INSTALL THAT CANNOT RUN IS A REFUSAL, NEVER THIS CHECKOUT'S
 * INSTALL INSTEAD.** Base tests against head's dependency tree measure neither
 * commit. The operational cost is that a base measurement needs a warm store or
 * a network — and it is paid only for a file that has survivors.
 */
function suppliedTo(at, root, install, timeoutMs) {
  if (PINS.every((name) => sameBytes(path.join(root, name), path.join(at, name)))) {
    /* ⚠️ **AN ABSOLUTE TARGET, BECAUSE A RELATIVE ONE IS RESOLVED BESIDE THE LINK
       AND NOT BESIDE THIS PROCESS** (measured 2026-09-17, and it made the whole
       comparison inert). `run` passes `root` as `.`, so `path.join(root,
       'node_modules')` is the bare name `node_modules` — which as a link's target
       means "node_modules in the directory this link is in", and the link is IN
       the base worktree. The base's `node_modules` therefore pointed at itself,
       reading through it answered `ELOOP`, and every base measurement refused
       with "the merge base's @stryker-mutator/core is missing" — a refusal that
       reads exactly like a base on another major version. Every case here passed
       an absolute root, which is why none of them saw it.

       `junction`, because a Windows symbolic link to a directory needs a
       privilege a runner may not have, and is ignored everywhere else. */
    symlinkSync(path.resolve(root, 'node_modules'), path.join(at, 'node_modules'), 'junction')
    return 'linked'
  }
  if (timeoutMs <= 0) {
    throw new BaseRefusal(
      'expired',
      `check-mutants: there is no time left to install the merge base’s own dependencies at ${at} — this gate allows ` +
        `${INSTALL_DEADLINE_MS / 60_000} minute(s) for one, and an install nobody waited for is not a measurement`,
    )
  }
  try {
    install(at, { timeoutMs })
  } catch (cause) {
    throw new BaseRefusal('install', `check-mutants: the merge base’s own dependencies cannot be installed at ${at} — ${messageOf(cause)}`)
  }
  return 'installed'
}

/** What decides whether two commits have the same install. */
const PINS = ['pnpm-lock.yaml', 'package.json']

/** Whether two files are there and are the same bytes — a file that is not there is not the same as anything. */
function sameBytes(one, other) {
  const digest = (file) => (entryAt(file) === null ? null : digestOf(readFileSync(file)))
  const first = digest(one)
  return first !== null && first === digest(other)
}

/**
 * The base's own install, from the base's own lockfile.
 *
 * `--ignore-scripts` is deliberate: a lifecycle script from a commit somebody is
 * merely comparing against is code this gate would be running on their machine,
 * and nothing in this project needs one to run its tests.
 */
// Stryker disable all: a real install is the second thing a test may not do — it reaches the network and writes a dependency tree; `measureAtBase` takes it as a parameter, and every decision about it — the deadline it is given included — is measured there
function installAt(at, { timeoutMs }) {
  const install = ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']
  const options = { cwd: at, stdio: 'inherit', timeout: timeoutMs }
  /* ⚠️ **PNPM IS A `.cmd` ON WINDOWS**, which Node will not spawn without a
     shell — the same death as `strykerRun`'s `npx` (2026-09-18). The command is
     fixed words with nothing from anywhere, so the shell has nothing to quote,
     and it goes as ONE string because a command plus arguments under
     `shell: true` is what Node's DEP0190 warns about; `assert-bundle.test.mjs`
     measured the same fix on the Windows leg. */
  if (process.platform === 'win32') execFileSync(install.join(' '), { ...options, shell: true })
  else execFileSync(install[0], install.slice(1), options)
}
// Stryker restore all

/**
 * How long one merge-base measurement may take, and how much of that its install
 * may take — PROVISIONAL, and to be replaced by numbers measured end to end on
 * the runners that pay for them. A measurement records what the whole operation
 * cost for exactly that reason.
 */
const INSTALL_DEADLINE_MS = 10 * 60_000
const BASE_DEADLINE_MS = 90 * 60_000
/* What a file's own sweep may have cost and still be worth sweeping again wide
   to check a bill — see `affordable`. Half of what one shard's CI step allows
   for everything it holds, so one file can never spend the whole of it twice. */
const WIDEN_BUDGET_MS = 20 * 60_000

/**
 * How much of `budget` is left, from `started`, by `clock` — whole milliseconds,
 * because a clock answers fractions and `execFileSync`'s `timeout` refuses one:
 * `The value of "timeout" is out of range. It must be an unsigned integer.`,
 * thrown BEFORE the child starts, which reads as a child that left no
 * measurement (measured 2026-09-17, by the case that runs the real command).
 */
function left(clock, started, budget) {
  return Math.round(budget - (clock() - started))
}

/**
 * The packages whose version decides whether this gate's settings mean anything
 * for a checkout.
 *
 * ⚠️ **THE RUNNER PLUGIN WAS NOT AMONG THEM, AND IT IS HALF THE STACK** (review,
 * 2026-09-17). `strykerConfig` names `@stryker-mutator/vitest-runner` as the
 * runner and writes a per-project vitest block for it to carry; a base pinning
 * another major of it is a base this gate's settings say nothing about, exactly
 * as a base on another major of vitest is.
 */
const RUNNERS = ['@stryker-mutator/core', '@stryker-mutator/vitest-runner', 'vitest']

/** Each runner's version in the install at `root`, and `null` for one that cannot be read. */
export function runnerVersionsAt(root) {
  return Object.fromEntries(RUNNERS.map((name) => [name, versionAt(path.join(root, 'node_modules', name, 'package.json'))]))
}

/** The `version` a package manifest declares, and `null` where there is no manifest, no JSON, or no string there. */
function versionAt(file) {
  try {
    // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — measured, both read the same manifest, the same reasoning as `measurementIn`
    const { version } = JSON.parse(readFileSync(file, 'utf8'))
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * Why the merge base's runner is not one this gate's generated settings mean
 * anything for, or `null` where it is.
 *
 * The gate writes a Stryker config and a Vitest config of its own — a runner
 * name, a reporter, a per-project block — and both are a major version's shape.
 * A base on another major version is REFUSED rather than run and interpreted: a
 * dry run that fails because a key moved reads exactly like a base that could
 * not measure, and neither is evidence. A version that cannot be read is refused
 * on the same ground rather than assumed to match.
 */
export function runnerUnlike(here, atBase) {
  for (const name of RUNNERS) {
    if (majorOf(here[name]) !== null && majorOf(here[name]) === majorOf(atBase[name])) continue
    return (
      `the merge base’s ${name} is ${atBase[name] ?? 'missing'} and this checkout’s is ${here[name] ?? 'missing'}, ` +
      'and a sweep’s settings are written for one major version'
    )
  }
  return null
}

/** A version's major, and `null` for anything that does not begin with one — a
 *  version that is not there among them, since `exec` reads `null` as the word. */
function majorOf(version) {
  const [, major] = /^(\d+)\./u.exec(version) ?? [null, null]
  return major
}

/**
 * Every mutant these report entries left alive — a `Survived` or a `NoCoverage`
 * in ANY of them, each counted once.
 *
 * Both runs of a subject are asked, because a survivor in either is a survivor:
 * the settle run is a second chance for a timeout to be answered, never a second
 * chance to call an observed survivor a kill. An entry that is `null` is a run
 * that reported on nothing, which left no survivor to find.
 *
 * The `null` entry is SKIPPED rather than read as an empty list: written as
 * `entry === null ? [] : entry.mutants`, whatever stands in for that empty list
 * is a mutant nothing can observe, since anything it holds fails the record test
 * a line below (2026-09-17). Skipping leaves nothing to stand in for.
 */
export function survivorsIn(entries) {
  const found = new Map()
  for (const entry of entries) {
    if (entry === null) continue
    for (const mutant of entry.mutants) {
      if (isRecord(mutant) && SURVIVALS.has(mutant.status)) found.set(keyOf(mutant), mutant)
    }
  }
  return [...found.values()]
}

/**
 * The base file whose survivors may answer for a subject's: the subject itself
 * where the merge base has it, the file git traced it to where it does not, and
 * `null` where there is none — which is a new file, and a new file owes all of
 * its own.
 *
 * ⚠️ **A TRACED ORIGIN IS A CANDIDATE AND NEVER A PROOF.** What authorises a
 * survivor is the identity — the mutator, the replacement, the mutated node's own
 * text and its scope path — and this only bounds WHICH base file may be asked,
 * which is what stops a copy-paste from laundering debt out of an unrelated file
 * and what keeps the cost to one base measurement.
 *
 * ⚠️ **AND AN UNTRACKED FILE IS TRACED TO NOTHING.** `git diff` reads tracked
 * content, so a new file that has not been committed is in no diff and has no
 * origin here. In CI that case does not arise — every job checks out a commit —
 * and locally it means an uncommitted extraction owes what a new file owes until
 * it is committed. Named rather than worked around: the alternative is
 * `git add -N`, and this gate does not write to anybody's index.
 */
export function originAtBase(subject, baseCommit, root, renames) {
  const traced = tracedTo(subject, renames, gitAnswers(['cat-file', '-e', `${baseCommit}:${subject}`], root))
  if (traced === null) return null
  const held = blobAtBase(traced.path, baseCommit, root)
  /* ⚠️ **A TRACED PATH WHOSE CONTENT CANNOT BE READ IS NO ORIGIN AT ALL.** Every
     one of these comes from git — a name it says the commit has, or a name it
     says a file came from — so a commit that then will not hand over the bytes is
     a repository this gate cannot freeze anything against, and a candidate with
     nothing frozen would be a base measurement nothing could be held to. */
  if (held === null) return null
  return { ...traced, sha256: digestOf(held) }
}

/** Which base file a subject may be answered by, before its content is asked for: itself where the merge base has it, what git traced it to otherwise. */
function tracedTo(subject, renames, hasItself) {
  if (hasItself) return { path: subject, how: 'itself' }
  const traced = renames.get(subject)
  /* A file a sweep could not mutate cannot have owed anything, so being traced
     to one is being traced to nothing. */
  if (traced === undefined || !SRC.test(traced.path) || NOT_A_SUBJECT.test(traced.path)) return null
  return traced
}

/**
 * The bytes a commit holds at `named`, or `null` where it holds none that can be
 * read — the content a measurement of the merge base must turn out to have swept.
 *
 * ⚠️ **THE FROZEN HASH IS THE WHOLE OF WHAT MAKES BASE EVIDENCE EVIDENCE**, and
 * it is taken from the commit rather than from any checkout: a shard measures in
 * a worktree of its own making, and without this the only claim about what it
 * measured would be its own.
 *
 * ⚠️ **AND IT IS THE BLOB, NOT THE WORKING-TREE FILE.** Where a repository runs
 * content through a filter — `.gitattributes`, an end-of-line conversion — a
 * checkout of that blob is not these bytes, and the measurement's own hash will
 * not match. That is a refusal rather than a silent mismatch, and it is named
 * here because nothing in this repository configures one.
 */
function blobAtBase(named, baseCommit, root) {
  try {
    return execFileSync('git', ['cat-file', 'blob', `${baseCommit}:${named}`], { cwd: root, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/**
 * Every file git traces to another between the merge base and the working tree,
 * as `destination → { path, how }`.
 *
 * ⚠️ **THE THRESHOLD IS 1 %, AND THE REASON IS ARITHMETIC RATHER THAN TASTE.**
 * git scores a copy against the LARGER of the two files, so pulling a fifth of a
 * module into a file of its own scores about a fifth — measured 2026-09-16:
 * 12 of 60 functions extracted scored `C019`, 30 of 60 `C049`, 45 of 60 `C074`.
 * At git's own default of 50 % an extraction is reported as an added file, which
 * is precisely the refactor this comparison exists to make affordable.
 *
 * ⚠️ **AND THE THRESHOLD IS A FLOOR, NOT A DIAL.** Measured the same day: below
 * roughly a tenth of its source, git reports an extraction as added at EVERY
 * threshold, so nothing lower buys anything; and the answer is not monotonic in
 * the threshold — a genuinely new file sharing one import line with another came
 * back added at `-C5` and `C020` at `-C10`. So the number is what this gate lets
 * through rather than what it can tune, and the identity comparison is what
 * actually authorises.
 *
 * `-l0` because git SILENTLY stops looking when there are more pairs than its
 * limit — an answer of "no origin" that is really "did not ask", which would bill
 * a refactor for the whole of a file it moved.
 */
export function renamesAtBase(baseCommit, root) {
  const told = gitNames(['diff', '--name-status', '-z', '--find-copies-harder', '-C1', '-l0', baseCommit, '--'], root)
  const renames = new Map()
  let record = []
  for (const token of told) {
    record.push(token)
    /* A rename or a copy names two paths, and every other status names one — so
       what a record IS decides both how long it is and what it leaves behind. A
       record that leaves one under no name at all would be an entry nothing can
       look up, and so one nothing can refuse. */
    const how = TRACED[record[0][0]]
    if (record.length < (how === undefined ? 2 : 3)) continue
    if (how !== undefined) renames.set(record[2], { path: record[1], how })
    record = []
  }
  return renames
}

/** The statuses that name where a file came from as well as where it is, by what each one is. */
const TRACED = { C: 'copied', R: 'renamed' }

/**
 * Each of `names` against the base file whose survivors may answer for it, as
 * `name → { path, how } | null` — `originAtBase` for a list, with git asked for
 * the traced origins ONCE.
 *
 * A checkout with no merge base has no base file for anything, and git is not
 * asked at all: there is nothing to diff against, so every subject is a subject
 * nothing can answer for. That is the same fail-closed answer a new file gets,
 * and it is how a local run with no base behaves — the scope is the working tree
 * and 100 % is owed, exactly as before this comparison existed.
 */
export function originsAtBase(names, mergeBase, root) {
  if (mergeBase === null) return new Map(names.map((name) => [name, null]))
  const renames = renamesAtBase(mergeBase, root)
  return new Map(names.map((name) => [name, originAtBase(name, mergeBase, root, renames)]))
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
    unresolved = [],
    // Stryker disable next-line ArrayDeclaration: every caller passes its own, so no run reads this default and no answer can differ
    noTestFound = [],
    // Stryker disable next-line ArrayDeclaration: the callers that leave this out pass no survivors either, and it is written out beside survivors alone
    staticSurvivors = [],
    mismatched = [],
    base = [],
  } = outcomes
  sayBase(base, stdout)
  const refused = base.filter(([, evidence]) => evidence.refusal !== null)
  /* Every survivor here the merge base answered for with nothing, in both of the
     two ways it can fail to — see `classed`, and the two paragraphs below. */
  const unanswered = base.flatMap(([, evidence]) => evidence.added)
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
  /* ⚠️ **A STATIC MUTANT THAT THROWS AT IMPORT IS REPORTED `Survived`**
   * (measured 2026-09-14, `/tmp/cc-audit/static-probe`). A suite whose module
   * throws while loading fails no test, so Stryker's vitest runner saw nothing
   * killed: `define('')` at module level, `if (true) throw` and `key !== ''` all
   * came back `Survived` while vitest by hand failed the file. A generated load
   * probe that killed them was tried and REMOVED — it made kills of its own
   * where Vite excluded a test, where a DOM guard was reversed, and broke
   * modules that touch `window` at import. So nothing passes differently: each
   * static survivor is only named, with how to tell the false kind from a real
   * one.
   *
   * ⚠️ **AND IT USED TO BE NAMED ONLY UNDER THE SURVIVORS, WHICH IS THE ONE CASE
   * THAT NO LONGER ALWAYS HAPPENS** (a second opinion's fifth round,
   * 2026-09-17). The notice sat inside the block that fails a file a mutant
   * survived in — correct while every survivor failed, and wrong from the moment
   * the merge base could answer for one. A file whose survivors the base
   * authorised passes, and passed in silence, static survivors and all. It is
   * written wherever there are any, on the same stream as the rest of the
   * measurement, whether the file passes or fails. */
  if (staticSurvivors.length > 0) {
    stdout.write(
      `check-mutants: ${staticSurvivors.length} survivor(s) are static, and a static mutant is the one kind this gate cannot read off a report:\n` +
        staticSurvivors
          .map(
            (at) =>
              `  static: ${at} — a static mutant that throws while the module is imported is reported Survived by Stryker's vitest runner, because the suite fails to load; verify it by hand, and if it does throw, disable it beside the code with that reason\n`,
          )
          .join(''),
    )
  }
  /* ⚠️ **A FILE AND THE PLACES ITS TIMEOUT REPEATED AT ARE ONE ENTRY, NOT TWO
     LISTS** (2026-09-16). They were two, filled under one condition and so empty
     together — which made a second test of the same fact a condition nothing
     could be observed through, and the second list's own default a value no
     caller ever read. Carried together, neither can be had without the other. */
  /* A merge base that could not be measured is not tested for here, and that is
     not an omission: `survivorsStand` has already put such a file among the ones
     a mutant survived in, because a mutant DID survive in it and nothing
     authorised it. Asking a second time would be a condition no run could be
     observed through — measured by hand, 2026-09-16, and it survived. The
     section below says which of them are there for that reason. */
  if (
    unkilled.length === 0 &&
    notRun.length === 0 &&
    noTestFound.length === 0 &&
    mismatched.length === 0 &&
    timedOut.length === 0 &&
    unresolved.length === 0
  ) {
    if (!complete) return 1
    /* ⚠️ **AND NOT OVER A SURVIVOR THE MERGE BASE MERELY AUTHORISED.** A file
       that passed because its survivors were there too has mutants alive in it,
       and saying every one was killed of a sweep that measured a base would be
       the one sentence a reader would take at face value. What the base said is
       above; this line is claimed only where nothing needed one. */
    if (killed.length > 0 && base.length === 0) stdout.write('check-mutants: every mutant was killed\n')
    return 0
  }
  sayNoTestFound(noTestFound, stderr)
  if (refused.length > 0) {
    stderr.write(
      `check-mutants: the merge base could not be measured for ${refused.length} file(s), so nothing authorises the mutants that survived in them — a failure to measure is never permission, and "could not run" is never "it already survived":\n` +
        refused.map(([file, { refusal }]) => `  ${file} — ${refusal.reason}: ${refusal.message}\n`).join(''),
    )
  }
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
  /* ⚠️ **AND A MUTANT THE SETTLE RUN LEFT WITH NO SCORE AT ALL, WHICH IS NOT THE
     SAME FINDING AND USED TO BE OUTRANKED BY ONE** — see `noVerdictFor`. It is
     reported and failed on its own, beside whatever else the file is, because a
     mutant nothing scored is a mutant nothing measured: the merge base was never
     asked about it, so no authorisation can answer for it. */
  if (unresolved.length > 0) {
    stderr.write(
      `check-mutants: the settle run reached no verdict for ${unresolved.flatMap(([, places]) => places).length} mutant(s) in ${unresolved.length} file(s) — a crash, an OOM-killed runner, or a report that simply does not mention them. A mutant with no score was not measured, and an unmeasured mutant is never a pass.\n` +
        unresolved.map(([file]) => `  ${file}\n`).join('') +
        '  Re-run the file alone, on a quiet machine, and read the settle run’s log\n' +
        '  for the runner that died:\n' +
        `    node scripts/check-mutants.mjs --only ${unresolved[0][0]}\n` +
        unresolved.flatMap(([file, places]) => places.map((at) => `  unresolved: ${file}:${at}\n`)).join(''),
    )
  }
  if (unkilled.length > 0) {
    stderr.write(
      `check-mutants: a mutant survived in ${unkilled.length} file(s) — a test that cannot fail is not a test.\n` +
        unkilled.map((f) => `  ${f}\n`).join('') +
        '  Kill it by asserting the behaviour the mutation changed, or, if the\n' +
        '  mutation is genuinely equivalent, say so beside the code:\n' +
        "    // Stryker disable next-line <mutator>: <why it cannot be observed>\n" +
        /* Which survivors the merge base did NOT answer for — the whole of what
           a change is billed for, named one by one so that a reader is not left
           to diff two survivor lists by eye. */
        unanswered
          .filter((one) => one.class === 'added')
          .map(({ file, at, identity, why }) => `  added: ${file}:${at} — ${namedSurvivor(identity)} — ${why}\n`)
          .join(''),
    )
  }
  /* ⚠️ **AND THE OTHER SENTENCE, WHICH WAS THE SAME ONE UNTIL 2026-09-17.** A
     mutant the merge base could not decide was billed as one this change added,
     which sends a reader to look for it in a diff that does not hold it — and
     before that, one such mutant refused the whole file and billed them for every
     survivor in it. Both classes fail, neither is authorised, and a reader acts on
     them differently: the first is a gap to close in what they wrote, the second
     is an old gap the merge base never answered for and has now fallen to them. */
  const undecided = unanswered.filter((one) => one.class === 'undecided')
  if (undecided.length > 0) {
    stderr.write(
      /* ⚠️ **AND THIS SENTENCE SAID "this change did not add them", WHICH THE
         EVIDENCE DOES NOT SUPPORT** (review, 2026-09-17). The merge base never
         answered for these, so nothing here can say whether the change added them
         — that is the whole of what "could not decide" means, and claiming the
         stronger thing would send a reader away from a diff that may well hold
         it. What IS known is that nothing authorises them. */
      `check-mutants: the merge base could not decide ${undecided.length} mutant(s) that survived here — it never answered for them, so whether this change added them is not something this run can say, and a mutant the merge base never answered for is not one it authorises; they are yours to settle:\n` +
        undecided.map(({ file, at, identity, why }) => `  undecided: ${file}:${at} — ${namedSurvivor(identity)} — ${why}\n`).join('') +
        '  Settle one by killing it here, or, if the mutation is genuinely\n' +
        '  equivalent, say so beside the code:\n' +
        '    // Stryker disable next-line <mutator>: <why it cannot be observed>\n',
    )
  }
  return 1
}

/**
 * What the merge base owed, file by file, for every file one was measured for.
 * Written on a PASS as well as on a failure: a sweep that passes because the
 * merge base already owed these mutants has mutants alive in it, and a reader who
 * is not told that reads a green gate as a clean file.
 */
function sayBase(base, stdout) {
  if (base.length === 0) return
  stdout.write(
    `check-mutants: ${base.length} file(s) had a mutant survive, so the merge base was measured for what each already owed there:\n` +
      base.map(([file, evidence]) => `  ${file} — ${saidAtBase(evidence)}\n`).join(''),
  )
}

/** What one file's merge base said, in one line — the two ways it answered for nothing counted apart, because they are two different bills. */
function saidAtBase(evidence) {
  const { origin, refusal, authorised, added, outcome, install, durationMs } = evidence
  const where = origin.how === 'itself' ? 'itself at the merge base' : `${origin.path}, which it was ${origin.how} from`
  if (refusal !== null) return `it could not be measured (${refusal.reason}), so nothing here is authorised — ${refusal.message}`
  const owed = added.filter((one) => one.class === 'added').length
  const unknown = added.length - owed
  return (
    `${authorised} of ${authorised + added.length} survivor(s) were there too, in ${where} ` +
    `(${outcome}, dependencies ${install}, ${durationMs} ms)` +
    `${owed === 0 ? '' : `; ${owed} this change added`}${unknown === 0 ? '' : `; ${unknown} the merge base could not decide`}`
  )
}

/** How a refusal names a survivor: what was mutated, what it became, and where in the file's own declarations it sat. */
function namedSurvivor({ mutatorName, original, replacement, scope }) {
  const where = scope.length === 0 ? 'the file itself' : scope.join(' → ')
  return `${mutatorName} replacing ${JSON.stringify(original)} with ${JSON.stringify(replacement)} in ${where}`
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
  const { root, stdout, commits, worktree, tracked, origins } = world
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
  /* ⚠️ **THE PLAN IS THE CONTRACT, SO IT FREEZES WHERE THE BASE IS AND WHAT EACH
     SUBJECT CAME FROM** — the merge base as a COMMIT rather than the ref `base`
     names, and per subject the base file whose survivors may answer for its own.
     A shard re-resolving either would be a shard deciding its own scope from its
     own checkout minutes later, which is the whole defect `shardSweep` exists to
     refuse; a ref is the easiest of those to move. */
  const traced = origins(
    rows.map((row) => row.path),
    mergeBase,
    root,
  )
  const counted = []
  for (const row of rows) {
    const identities = await identifiedIn(path.join(root, row.path))
    const mutants = identities.length
    /* No mutant is nothing to run, whether or not a test reaches it: see `sweepChanges`. */
    counted.push({
      ...row,
      class: mutants === 0 ? 'no-mutants' : row.tests.length > 0 ? 'mutated' : 'no-test-found',
      mutants,
      identities,
      origin: traced.get(row.path) ?? null,
    })
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
      origin: row.origin,
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

/**
 * The files a subject's covering tests READ, by digest — the one class of input
 * a sweep's answer depends on and nothing else watches.
 *
 * ⚠️ **A FILE A TEST READS CAN CHANGE UNDER A SWEEP, AND EVERY GUARD AROUND IT
 * LOOKS THE OTHER WAY** (2026-09-19). The shard's drift check compares the HEAD
 * commit, the merge base and the working tree — and the working tree is git's
 * answer, so **nothing `.gitignore` covers is in it**. `ledger.test.mjs` reads
 * `dev-docs/feature-ledger.md`, which is gitignored whole; editing that file
 * during a sweep of `scripts/lib/ledger.mjs` changes what the subject's covering
 * tests assert, between the first run and the settle run, with no signal
 * anywhere. The measurement is then of two different projects and reads as one.
 *
 * A plain sweep had no such check at all, tracked or not, which is the wider
 * half: `SidePane.test.tsx` reads `SidePane.module.css`, `commands.test.ts`
 * reads `ui/commands.ts`, and an agent editing either mid-sweep moves the same
 * ground. 59 paths inside this checkout are read by its 381 test files, measured
 * the day this was written — a small set, which is why watching it is cheap.
 *
 * **What it covers, said exactly, because a guard that quietly covers less than
 * it claims is the defect this file keeps finding.** A read whose path
 * `pathsRead` can resolve, that is inside the checkout, and that is a FILE. Not
 * a directory — a `readdir`'s answer changes with its entries and hashing a
 * recursive listing per subject is a cost this does not carry. Not a path
 * outside the checkout — a test's own tmpdir fixture is meant to change. Not a
 * read `pathsRead` cannot resolve, which is the case its own header calls the
 * LOUD one. **Everything it cannot watch is COUNTED rather than dropped**, so
 * the number a sweep prints is the number it actually watched.
 *
 * ⚠️ **`pathsRead` ANSWERS IN FOUR SPELLINGS AND ONLY TWO ARE PATHS** — found
 * by writing this function's own test, which is the only reason it was found.
 * A bare `new URL(spec, import.meta.url)` comes back as `file:///…`, a string
 * `path.relative` reads as somewhere else entirely; a `path.join(here, '..', x)`
 * comes back unnormalised, with the `..` still in it. Both were silently
 * dropped by a `startsWith('..')` test — a guard that watched nothing and said
 * nothing, which is the shape it exists to prevent. A `file:` URL is converted,
 * and every path is resolved through the operating system's own `realpath`
 * rather than `path.resolve`, which collapses `link/..` textually and is the
 * defect this file records against its own writes.
 */
/** The paths one test reads, or none where it names no read or cannot be read. */
function readsIn(test) {
  let source
  try {
    source = readFileSync(test, 'utf8')
  } catch {
    /* A test that cannot be read is the dry run's failure to report, not this
       function's: it answers about inputs, and there are none. */
    // Stryker disable next-line ArrayDeclaration: a path in this list is resolved by `realpathSync` in the caller and a made-up one throws ENOENT there, so a non-empty answer is indistinguishable from an empty one
    return []
  }
  /* The same cheap first pass `sourceReaders` takes, and for its reason: a file
     naming no read reads nothing, and parsing it costs a sweep seconds. */
  // Stryker disable next-line MethodExpression,StringLiteral,ArrayDeclaration: `pathsRead` finds no read in a file that names none, so widening the test only costs time; and a made-up path in the empty branch is resolved by `realpathSync` in the caller, which throws ENOENT on it
  return source.includes('readFile') ? pathsRead(source, test) : []
}

export function readInputsOf(tests, root, parsed = new Map()) {
  const files = new Map()
  let unwatched = 0
  /* The checkout's own real path, so a scratch root under a symlinked `/tmp`
     — which is what macOS gives — compares against what `realpath` answers. */
  const base = realpathSync.native(root)
  for (const test of tests) {
    /* ⚠️ **PARSED ONCE PER SWEEP, NOT ONCE PER SUBJECT** (measured 2026-09-19,
       after writing it the other way). `pathsRead` builds a TypeScript source
       file, and this gate's own three covering tests cost **10.3 s** to parse —
       every test file in the tree, 56 s. Paid per subject that is minutes added
       to a sweep for an answer that cannot change between two subjects of the
       same run: the test's own bytes are what the parse reads, and a test that
       changed mid-sweep is what this whole function exists to refuse. The
       caller passes one map for the whole sweep; `sourceReaders` already takes
       the same shape of answer for the same reason. */
    if (!parsed.has(test)) parsed.set(test, readsIn(test))
    for (const found of parsed.get(test)) {
      if (found === null) {
        unwatched += 1
        continue
      }
      let real
      try {
        real = realpathSync.native(found.startsWith('file:') ? fileURLToPath(found) : found)
      } catch {
        /* Named but absent — a fixture the test writes itself, or a path built
           from a value this cannot know. It is watched from the moment it
           exists and not before: appearing is not a change to an input a run
           has already read. */
        continue
      }
      const rel = path.relative(base, real)
      /* Outside the checkout, which a test's own tmpdir fixture is and is meant
         to be. Not counted as unwatched: it is not an input to the project.
         ⚠️ **`rel === ''` — THE CHECKOUT ROOT ITSELF — USED TO BE SKIPPED HERE**
         and it was both a wart and two surviving mutants (2026-09-20 sweep). A
         test that reads the root is reading a DIRECTORY, which is exactly what
         the count below means by "cannot watch", so letting it fall through is
         the truer answer as well as the one with no branch to mutate. */
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      if (!statSync(real).isFile()) {
        unwatched += 1
        continue
      }
      files.set(slashed(rel), digestOf(readFileSync(real)))
    }
  }
  return { files, unwatched }
}

/**
 * Which of `inputs` are no longer what they were — by name, with what happened.
 *
 * Absent counts, and so does a file that has become something else: the claim is
 * *the bytes this subject's tests read have not moved*, and a deleted file
 * breaks it exactly as an edited one does.
 */
export function inputsMoved({ files }, root) {
  const moved = []
  const base = realpathSync.native(root)
  for (const [rel, was] of files) {
    const at = path.join(base, rel)
    let now
    try {
      now = statSync(at).isFile() ? digestOf(readFileSync(at)) : null
    } catch {
      now = null
    }
    if (now === null) moved.push(`${rel} — gone, or no longer a file`)
    else if (now !== was) moved.push(`${rel} — its bytes changed`)
  }
  return moved
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
      resultOf(subject, { outcome: subject.class, exitedCleanly: null, mutants, durationMs, report: null, settle: null, base: null })
      recheck(subject.path, 'after')
      /* A file with no mutant that tests DO reach had nothing to kill; one no test
         reaches is named for that as well — see `sweepChanges`. */
      if (subject.class === 'no-mutants') (subject.tests.length > 0 ? nothingToKill : noMutants).push(inCheckout(subject))
      else noTestFound.push([inCheckout(subject), mutants])
    }
    sayNoMutants(noMutants, stdout)
    const toRun = new Map(mine.filter((subject) => subject.class === 'mutated').map((subject) => [inCheckout(subject), subject]))
    /* ⚠️ **ONE MEASUREMENT PER BASE FILE HERE TOO, AND THERE WAS NONE** (a second
       opinion's fifth round, 2026-09-17). A plain sweep caches by origin, for the
       reason written where it does: two subjects traced to one base file ask the
       same question of the same commit, and asking twice costs a second
       worktree, a second install and a second sweep of it — and then invites the
       two answers to differ, which `matchedAcross` can only resolve by leaving
       the identity undecided. A shard called `world.measure` per subject and so
       had neither half. The plan puts every subject sharing an origin on one
       shard only by accident, so this is a real cost as well as a real risk:
       three near-budget base measurements already pass the 210-minute step. */
    const measured = new Map()
    const measureOnce = (origin, mergeBase, asked) => {
      if (!measured.has(origin)) measured.set(origin, world.measure(origin, mergeBase, asked))
      return measured.get(origin)
    }
    if (toRun.size > 0) {
      swept = await strykerEach([...toRun.keys()], found, await testOptionsOf(root), world, {
        record: ({ subject, ...fields }) => resultOf(toRun.get(subject), fields),
        before: (at) => recheck(toRun.get(at).path, 'before'),
        between: (at) => recheck(toRun.get(at).path, 'between'),
        after: (at) => recheck(toRun.get(at).path, 'after'),
        /* The plan's own merge base and the plan's own origin: a shard resolves
           neither for itself — see `planSweep`. The measurement happens between
           this subject's `between` and its `after`, so the checkout is asked
           again once it is over, exactly as it is after a settle run. */
        base: (at, reports, spent) =>
          judgedAtBase(at, toRun.get(at).path, toRun.get(at).origin, reports, { mergeBase: plan.mergeBase, measure: measureOnce, world, spent }),
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
  /* Every subject's two sides, derived, for the pairing this mode alone can make
     — the one that sees the whole sweep at once. See `matchedAcross`. */
  const paired = []
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
      else {
        /* Only once the report is known to be of the planned file: the difference
           at the merge base is derived from that report's own source, so a report
           of something else would be identified as something else. */
        const unsupported = await baseDisagreement(record, subject, root)
        if (unsupported?.why !== undefined) problems.push(`mismatched: ${file} — the merge base's evidence does not support it: ${unsupported.why}`)
        else {
          if (unsupported !== null) paired.push(unsupported.paired)
          resultsOf.get(record.subject).push({ file, record })
        }
      }
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
  /* ⚠️ **AND THE PAIRING IS THE SWEEP'S, NOT EACH SHARD'S.** Every shard paired
     its own subject against its own measurement of the base file, which spends
     one historical survivor once per shard; this is the only place every subject
     is in one process, so this is where one pool answers for all of them — see
     `matchedAcross`. */
  const { byFile, contested, measurements } = matchedAcross(paired)
  /* And here above all, because this is the mode where one base file really is
     measured more than once: shards do not share a process, so two subjects of
     one origin on two shards are two measurements. See `sayContested`. */
  stdout.write(sayContested(contested, measurements))
  const outcomes = { killed: [], nothingToKill: [], notRun: [], unkilled: [], timedOut: [], unresolved: [], noTestFound: [], staticSurvivors: [], base: [] }
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
      /* Derived here too, and not read off the shard's word, for the reason the
         comment above gives — and on its own channel, which no authorisation
         reaches. See `unanswered`. */
      if (verdict.unresolved.length > 0) outcomes.unresolved.push([at, verdict.unresolved])
      /* And a survivor the merge base answered for stops being this file's
         failure here on the same terms a plain sweep applies — over evidence
         `baseDisagreement` has already derived the answer from again, and over
         the sweep's own pairing, so the shard's own word for "authorised" is
         nowhere in this. */
      const evidence = record.base === null ? null : { ...record.base, ...(byFile.get(subject.path) ?? {}) }
      if (verdict.outcome !== 'timed-out' && (evidence === null || survivorsStand(evidence))) {
        outcomes[SWEPT_AS[verdict.outcome]].push(at)
      }
      if (evidence !== null) outcomes.base.push([at, evidence])
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
 * Why a result's merge-base evidence does not support what it records, or `null`
 * when it does.
 *
 * ⚠️ **A SHARD'S WORD FOR "AUTHORISED" IS NOT TAKEN, EXACTLY AS ITS WORD FOR AN
 * OUTCOME IS NOT** — see `disagreementOf`, which this is the companion of. The
 * survivors HERE are identified again from the report the result carries; the
 * survivors AT THE MERGE BASE are identified again from the base's own reports,
 * which must be reports of the content the PLAN froze out of the merge base's
 * commit; and the pairing is run again over both.
 *
 * ⚠️ **IT MATCHED AGAINST A SUPPLIED LIST UNTIL 2026-09-17, AND A SUPPLIED LIST
 * IS NOT EVIDENCE.** A result claiming the merge base had nothing to mutate,
 * with this file's own survivors copied into its `survivors`, exited 0 — no base
 * measurement, no contradiction, nothing to notice. There is no such list now;
 * see `survivorsAtBase` for what replaced it and what it is still worth.
 *
 * Which files owe evidence is derived too, from the PLAN rather than from the
 * result's own claim: a run that left a survivor, in a file the plan traced to
 * the merge base, owes it. What each of the checks below is left to decide is
 * narrower than it looks, and deliberately so — `resultProblem` has already
 * refused evidence beside any outcome but `survived`, and `disagreementOf` has
 * already held that outcome to the result's own report, so a result that reaches
 * here carrying evidence is one whose run left a survivor.
 *
 * Answers `null` where there is nothing to reconcile, `{ why }` where the
 * evidence does not support the result, and `{ paired }` — both sides' derived
 * survivors — where it does, for the one pairing that sees the whole sweep.
 */
async function baseDisagreement(result, subject, root) {
  if (subject.origin === null) {
    return result.base === null ? null : { why: "it carries the merge base's evidence for a file the plan traced to no file at the merge base" }
  }
  if (result.outcome !== 'survived') return null
  if (result.base === null) {
    return { why: `it leaves the mutants that survived in it with no evidence at all, and the plan traced it to ${subject.origin.path}` }
  }
  if (result.base.origin.path !== subject.origin.path || result.base.origin.how !== subject.origin.how) {
    return {
      why:
        `it measured ${result.base.origin.path} (${result.base.origin.how}) at the merge base, and the plan traced this ` +
        `file to ${subject.origin.path} (${subject.origin.how})`,
    }
  }
  /* A refusal is evidence of its own and there is nothing in it to derive again:
     it carries no measurement, and `survivorsStand` fails the file on it. */
  if (result.base.refusal !== null) return null
  const at = path.join(root, subject.path)
  const here = survivorsFound(at, subject.path, subject.origin.path, [result.report, result.settle === null ? null : result.settle.report])
  const { survivors, undecided, problem } = await survivorsAtBase(result.base, {
    at: path.join(root, subject.origin.path),
    named: subject.origin.path,
    frozen: subject.origin.sha256,
  })
  if (problem !== undefined) return { why: `its run of ${subject.origin.path} at the merge base ${problem.why}` }
  const derived = differenceAtBase(survivors, undecided, here)
  if (derived.authorised !== result.base.authorised) {
    return {
      why:
        `it says the merge base answered for ${result.base.authorised} of the mutants that survived, and its own evidence ` +
        `answers for ${derived.authorised}`,
    }
  }
  const unlike = addedUnlike(result.base.added, derived.added)
  if (unlike !== null) return { why: `it says what this change added, and its own evidence says ${unlike}` }
  return { paired: { at, named: subject.path, origin: subject.origin, here, atBase: survivors, undecided } }
}

/** How a recorded list of added survivors differs from the derived one, or `null` where it does not. */
function addedUnlike(recorded, derived) {
  if (JSON.stringify(recorded) === JSON.stringify(derived)) return null
  const [first] = derived.filter((one, at) => JSON.stringify(one) !== JSON.stringify(recorded[at]))
  if (first === undefined) return `${derived.length} survivor(s) were added, against the ${recorded.length} it records`
  return `${derived.length} were added, the first differing one being ${namedSurvivor(first.identity)} at ${first.file}:${first.at}`
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
    const origin = originProblem(subject.origin, name, plan.mergeBase)
    if (origin !== null) return origin
  }
  return null
}

/**
 * What is wrong with the base file a plan says a subject's survivors may answer
 * to, or `null` when nothing is.
 *
 * Two invariants beyond the shape, because each of them decides which base file
 * a shard will go and MEASURE: a file that is its own origin is its own PATH, and
 * a plan with no merge base has no origin for anything at all — see
 * `originsAtBase`.
 */
function originProblem(origin, name, mergeBase) {
  if (origin === null) return null
  if (!isRecord(origin) || typeof origin.path !== 'string' || origin.path === '' || !TRACED_AS.has(origin.how)) {
    return `${name} has origin ${shown(origin)}, which is not a base file this gate traces to`
  }
  /* The content the merge base's own commit holds there, frozen when the plan was
     written — what every measurement of that file is then held to having swept,
     and the reason a shard's evidence is evidence. */
  if (!isDigest(origin.sha256)) return `${name} has origin.sha256 ${shown(origin.sha256)}, which is not a digest`
  if (origin.how === 'itself' && origin.path !== name) return `${name} is its own origin at ${origin.path}, which is another file`
  if (mergeBase === null) return `${name} has an origin at ${origin.path}, and the plan has no merge base for it to be in`
  return null
}

/** How a subject reaches the base file that may answer for it — `originAtBase`'s own three answers, one of them being `null`. */
const TRACED_AS = new Set(['itself', ...Object.values(TRACED)])

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
  const base = baseProblem(result.base)
  if (base !== null) return base
  if (result.outcome !== 'survived' && result.base !== null) {
    return `its base is an object, and ${result.outcome} is no survivor for the merge base to answer for`
  }
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
  return runProblem(settle, 'its ', 'settle')
}

/**
 * What is wrong with one Stryker run as a record carries one — an exit, a report
 * and what it cost — or `null`. `named` is the field it sits at, because a
 * measurement carries two of them and a result's settle run is the same shape.
 */
function runProblem(run, whose, named) {
  if (run === null) return null
  if (!isRecord(run)) return `${whose}${named} is ${shown(run)}, which is neither a ${named} run nor null`
  if (typeof run.exitedCleanly !== 'boolean') return `${whose}${named}.exitedCleanly is ${shown(run.exitedCleanly)}, which is not an exit`
  if (!isDuration(run.durationMs)) return `${whose}${named}.durationMs is ${shown(run.durationMs)}, which is not a duration`
  if (run.report !== null && !isRecord(run.report)) return `${whose}${named}.report is ${shown(run.report)}, which is not a report`
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

/**
 * What is wrong with the merge base's evidence a result carries, or `null` when
 * nothing is.
 *
 * Every field the aggregate acts on is checked here, once — because a record is a
 * file on disk and the aggregate's whole answer about a survivor comes out of
 * this object. A refusal carries no measurement and a measurement carries no
 * refusal: one record cannot be both, and reading it as either would be reading
 * an unmeasured base as a measured one.
 *
 * ⚠️ **A RESULT FROM BEFORE THIS EXISTED CARRIES NO `base` AT ALL, AND
 * `undefined` IS NOT `null`.** One would reconcile as a file whose survivors
 * nobody asked the base about — which is a pass, over a survivor. So a record
 * that does not say either way is refused here by name.
 */
function baseProblem(base) {
  if (base === undefined) return 'its base is missing, and a result that does not say what the merge base owed cannot be reconciled'
  if (base === null) return null
  if (!isRecord(base)) return `its base is ${shown(base)}, which is neither the merge base's evidence nor null`
  /* Never `null` here, where a plan's may be: evidence exists only for a subject
     the merge base HAS a file for, and a measurement is of that file. Whether it
     is the file the PLAN traced is the aggregate's question — see
     `baseDisagreement`. */
  const { path: from, how } = isRecord(base.origin) ? base.origin : {}
  if (typeof from !== 'string' || from === '' || !TRACED_AS.has(how)) {
    return `its base.origin is ${shown(base.origin)}, which is not a file at the merge base this gate traces to`
  }
  if (base.refusal !== null) {
    if (!isRecord(base.refusal)) return `its base.refusal is ${shown(base.refusal)}, which is neither a refusal nor null`
    for (const key of ['reason', 'message']) {
      if (typeof base.refusal[key] !== 'string' || base.refusal[key] === '') {
        return `its base.refusal.${key} is ${shown(base.refusal[key])}, which is not a reason`
      }
    }
    return null
  }
  if (!MEASURED.has(base.outcome)) return `its base.outcome is ${shown(base.outcome)}, which this gate does not measure`
  if (base.install !== 'linked' && base.install !== 'installed') {
    return `its base.install is ${shown(base.install)}, which is not how a merge base's dependencies are supplied`
  }
  if (!isDuration(base.durationMs)) return `its base.durationMs is ${shown(base.durationMs)}, which is not a duration`
  if (!isWhole(base.authorised)) return `its base.authorised is ${shown(base.authorised)}, which is not a count`
  const measured = measuredProblem(base, 'its base.')
  if (measured !== null) return measured
  if (!Array.isArray(base.added)) return `its base.added is ${shown(base.added)}, which is not a list`
  for (const [at, one] of base.added.entries()) {
    if (!isSurvivor(one) || typeof one.why !== 'string' || one.why === '' || !UNANSWERED.has(one.class)) {
      return `its base.added ${at + 1} is ${shown(one)}, which is not a survivor the merge base failed to answer for`
    }
  }
  return null
}

/**
 * The two ways the merge base can answer for a survivor here with nothing — see
 * `classed`. A record naming neither says which sentence a reader gets, so it is
 * refused rather than printed under whichever one a `filter` happens to leave.
 */
const UNANSWERED = new Set(['added', 'undecided'])

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
const MODES = { plan: planSweep, shard: shardSweep, aggregate: aggregateSweep, measure: measureSweep }

// Stryker disable all: the two things a real sweep does that no test may — start Stryker, and take this checkout's own lock, which a live sweep holds while these very tests run in its sandbox. `run` takes both as parameters, and every decision about either is measured there.
/**
 * Stryker, run over one generated config IN the checkout at `root`: `true` when
 * it exited 0.
 *
 * ⚠️ **WHERE IT RUNS DECIDES WHAT IT SWEEPS.** Stryker copies the project it is
 * started in into its sandbox and resolves every pattern there, so a sweep of a
 * checkout other than this process's own runs with that checkout as its
 * directory. A plain sweep passes `.`, which is where it always ran.
 *
 * ⚠️ **WITH A TEMPORARY DIRECTORY OF ITS OWN, REMOVED WHEN THE RUN ENDS.**
 * Stryker ends a mutant that times out by restarting its test runner — killing
 * the process — and no hook in a killed process runs, so whatever the case in
 * flight had made under `tmpdir()` stayed there: once per timeout, however
 * carefully the test cleans up. Every process Stryker starts inherits this
 * directory as its `tmpdir()` instead, and it goes with the run.
 *
 * ⚠️ **IT WAS `npx stryker`, AND ON WINDOWS STRYKER NEVER STARTED** (found
 * 2026-09-18, by the Windows leg). `npx` is a `.cmd` there, and since the fix
 * for CVE-2024-27980 Node will not spawn one without a shell — so the spawn threw
 * before Stryker printed a line, this answered `false`, and the sweep called it a
 * run that wrote no report. A shell is no way out, because `config` is a path
 * `cmd.exe` would have to be trusted to quote. So Stryker's own entry, the script
 * `.bin/stryker` points at, is run by this node: see `strykerEntry`.
 *
 * ⚠️ **AND IT RUNS IN `root` AS THE FILESYSTEM SPELLS IT, BECAUSE ON WINDOWS
 * THAT IS NOT ALWAYS HOW IT WAS GIVEN** (found 2026-09-18, on CI's Windows
 * runner). There the temporary directory is `C:\Users\RUNNER~1\…`, an 8.3 short
 * name, so a merge-base worktree made under it — and Stryker's sandbox, and
 * Vitest's root, and the file Stryker marks as mutated — all carried
 * `RUNNER~1`. Vite resolves every import to its native real path,
 * `C:\Users\runneradmin\…`, and Vitest's `related` filter compares the two as
 * strings: the test that imports the subject was judged to import something
 * else, the dry run found no test, and the measurement was refused. A Windows
 * process keeps the spelling of the directory it was started in, where macOS
 * and Linux answer `getcwd` with the real path, so this is Windows' alone. Every
 * path a run's configs carry is relative to `root`, so the same directory under
 * its own name changes nothing else.
 */
function strykerRun(config, root) {
  const temp = mkdtempSync(path.join(tmpdir(), 'check-mutants-stryker-'))
  try {
    execFileSync(process.execPath, [strykerEntry(root), 'run', config], {
      cwd: realpathSync.native(path.resolve(root)),
      stdio: 'inherit',
      env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
    })
    return true
  } catch {
    return false
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * The script Stryker's own `bin` names, in the install at `root` — what
 * `npx stryker` would have found there, read from the package rather than
 * spelled out, so it follows the package if the package moves it. Absolute,
 * because the child resolves a relative one against `root` and this process
 * against its own directory.
 */
function strykerEntry(root) {
  const core = path.resolve(root, 'node_modules', '@stryker-mutator', 'core')
  const { bin } = JSON.parse(readFileSync(path.join(core, 'package.json'), 'utf8'))
  return path.join(core, typeof bin === 'string' ? bin : bin.stryker)
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
 *
 * ⚠️ **`include` IS A LIST OF GLOBS, AND A GLOB READS `\` AS AN ESCAPE.** Vitest
 * hands it to its glob library unchanged, so a Windows path — `C:\…\a.test.ts`,
 * which is what `covering` holds there — is a pattern with its separators
 * escaped away. Each is written with `/`, the separator every glob reads, which
 * on macOS and Linux changes nothing.
 */
export function vitestConfigFor(covering, carried) {
  const include = covering.map(slashed)
  return (
    "import { mergeConfig } from 'vitest/config'\n" +
    "import viteConfig from './vite.config'\n\n" +
    '/* Written by scripts/check-mutants.mjs for one subject, and removed when the sweep ends. */\n' +
    `export default mergeConfig(viteConfig, { test: ${JSON.stringify({ ...carried, passWithNoTests: false, include }, null, 2)} })\n`
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
  return scoredOutcome(subject, exitedCleanly, report).outcome
}

/**
 * WHY a run scored nothing, as a phrase that follows the run — "wrote no report
 * at all", "did not exit cleanly" — and `null` for a run that scored.
 *
 * ⚠️ **`did-not-run` IS SEVEN DIFFERENT FAILURES UNDER ONE WORD, AND EVERY
 * MESSAGE BUILT ON IT CARRIED NONE OF THEM** (2026-09-17). The two cases beside
 * each other in `check-mutants.base.test.mjs` — a Stryker that reported on no
 * file, and one that fell over with a complete report — produced BYTE-IDENTICAL
 * refusals, and so did a Stryker that died before writing anything. A sweep can
 * afford that, because its stdout carries Stryker's own error a line above; a
 * MEASUREMENT AT THE MERGE BASE cannot, because its refusal travels as a VALUE —
 * into the record the child writes, into the evidence a result carries, and into
 * an aggregate running in another job with no stdout of that run anywhere near
 * it. Measured on the acceptance run of 2026-09-17: a base measurement of
 * `src/kernel/ui/reader/session.ts` came back `did-not-run` in seconds, and
 * neither the log nor the record could say whether Stryker had died, written a
 * report of the wrong file, or never been started — three readings, three
 * evenings, no evidence. The reason is derived HERE, beside the decision that
 * makes it, rather than by a second reading of the same report somewhere else:
 * two readings that could drift apart are one defect waiting.
 */
export function noScoreOf(subject, exitedCleanly, report) {
  return scoredOutcome(subject, exitedCleanly, report).why
}

/** What one run amounted to, and why it amounted to nothing — see `outcomeOf` and `noScoreOf`, which are this answered one field each. */
function scoredOutcome(subject, exitedCleanly, report) {
  const scored = (outcome) => ({ outcome, why: null })
  const nothing = (why) => ({ outcome: 'did-not-run', why })
  if (report === null || typeof report !== 'object') return nothing('wrote no report at all')
  const { files } = report
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    return nothing(`wrote a report whose files are ${shown(files)}`)
  }
  const names = Object.keys(files)
  /* A report about no file is a run that mutated nothing, whatever its exit —
     and one naming any file but the subject is not a report of this run. */
  if (names.length !== 1) return nothing(`wrote a report of ${names.length} file(s), and this gate sweeps one at a time`)
  if (path.resolve(names[0]) !== path.resolve(subject)) return nothing(`wrote a report of ${names[0]}, and this gate swept ${subject}`)
  const file = files[names[0]]
  if (file === null || typeof file !== 'object' || !Array.isArray(file.mutants)) {
    return nothing('wrote a report whose one file carries no list of mutants')
  }
  const statuses = file.mutants.map((mutant) =>
    mutant === null || typeof mutant !== 'object' ? undefined : mutant.status,
  )
  if (statuses.some((status) => SURVIVALS.has(status))) return scored('survived')
  const unknown = statuses.filter((status) => !VERDICTS.has(status))
  if (unknown.length > 0) return nothing(`wrote a report carrying ${shown(unknown[0])}, which is no verdict this gate knows`)
  if (!exitedCleanly) return nothing('did not exit cleanly, and nothing in its report is a survivor or a kill')
  if (statuses.some((status) => KILLS.has(status))) return scored('killed')
  /* ⚠️ **AND A SUBJECT WITH NOTHING TO KILL CAME BACK `killed`.** No mutant, or
   * every one `Ignored`, passes — the escape hatch above, used as written — but
   * under that name the summary said "every mutant was killed" about a module
   * no test had been tried against. Finding #9, 2026-09-14. It passes as
   * `nothing-to-kill` now, and `run` says so by name. */
  if (!statuses.some((status) => NO_SCORE.has(status))) return scored('nothing-to-kill')
  return nothing(`scored none of its ${statuses.length} mutant(s) — every one is Ignored, a CompileError or a RuntimeError`)
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
 * ⚠️ **`measured` IS THE SAME ANSWER WITH THE MUTANT-LEVEL HOLES LEFT OUT** —
 * what the runs made of the FILE, `survived` where either saw a survivor and the
 * settle run's own outcome otherwise. `outcome` is what a sweep HERE reports,
 * where a repeat and an unresolved mutant are findings of their own; `measured`
 * is what the merge base is asked, where they are not the file's failure but one
 * identity's. See `survivorsAtBase`, which refuses on `measured` and names the
 * holes by mutant.
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
  if (settle === null) {
    /* Fail-closed: a wall-clock timeout with no settle run at all is a mutant
       nothing answered for, which is the same hole as one the settle run
       crashed on. The paragraph above `sayTimeouts` argues such a file is
       refused before it reaches here; that argument is about the roads known
       today, and naming them costs one map. */
    const none = unsettled.map((mutant) => `${placeOf(mutant)} — there was no settle run, so nothing answered for it`)
    return { ...counted, outcome: ran, measured: ran, repeated: [], unresolved: none, answers: null }
  }
  const answered = settledEach(unsettled, answersIn(reportEntryOf(subject, settle.report)))
  const tally = { killed: 0, survived: 0, repeated: 0, unresolved: 0 }
  for (const { how } of answered) tally[how] += 1
  const repeated = answered.filter(({ how }) => how === 'repeated').map(({ answer }) => unrecognised(answer))
  const unresolved = answered.filter(({ how }) => how === 'unresolved').map(({ mutant, answer }) => noVerdictFor(mutant, answer))
  const settled = outcomeOf(subject, settle.exitedCleanly, settle.report)
  const survived = ran === 'survived' || settled === 'survived'
  const measured = survived ? 'survived' : settled
  const outcome = survived
    ? 'survived'
    : repeated.length > 0
      ? 'timed-out'
      : tally.unresolved > 0
        ? 'did-not-run'
        : settled
  return { ...counted, outcome, measured, repeated, unresolved, answers: tally, durationMs: settle.durationMs }
}

/**
 * How an unresolved timeout is named: the mutant, and which of the two silences
 * it was.
 *
 * ⚠️ **AN UNRESOLVED MUTANT USED TO BE COUNTED AND THEN OUTRANKED** (found by a
 * second opinion's fifth round, 2026-09-17, and reproduced). `settledVerdict`
 * collapsed every finding into ONE `outcome`, and `survived` came first in that
 * chain — so a file with a survivor and an unresolved timeout reported
 * `survived`, the unresolved count was printed and decided nothing, and the
 * merge base then authorised the survivor and the file PASSED. Both halves were
 * needed to hide it, which is why neither alone was caught: the 2026-09-16 fix
 * above made an unresolved mutant fail only where nothing survived.
 *
 * A mutant with no score is not a mutant that was measured, and no answer about
 * a DIFFERENT mutant can stand in for it. So it travels beside the outcome now
 * rather than inside it, and it fails the file on its own terms — which base
 * authorisation cannot reach, because the merge base was never asked about a
 * mutant this run never scored.
 */
function noVerdictFor(mutant, answer) {
  if (answer === undefined) return `${placeOf(mutant)} — the settle run's report says nothing about it`
  return `${placeOf(mutant)} — the settle run answered ${JSON.stringify(answer.status)}, which is no verdict`
}

/**
 * What the settle run said about each wall-clock timeout the first run left, one
 * entry each: `survived`, `repeated`, `killed`, or `unresolved` for an answer
 * that is no verdict at all — the four rows of `settledVerdict`'s own table.
 *
 * Shared with `undecidedAtBase`, which needs the MUTANTS rather than a tally: two
 * readings of one report that could drift apart are one defect waiting, and this
 * one decides which mutants a base measurement never answered for.
 */
function settledEach(unsettled, answers) {
  return unsettled.map((mutant) => {
    const answer = answers.get(keyOf(mutant))
    const status = answer === undefined ? undefined : answer.status
    if (SURVIVALS.has(status)) return { mutant, answer, how: 'survived' }
    if (status === 'Timeout' && timeoutKindOf(answer.statusReason) !== 'hit-limit') return { mutant, answer, how: 'repeated' }
    return { mutant, answer, how: KILLS.has(status) ? 'killed' : 'unresolved' }
  })
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
    /* ⚠️ **STRYKER'S DRY RUN HAS ITS OWN DEADLINE, AND ITS DEFAULT IS FIVE
       MINUTES — WHICH THE MERGE BASE'S WIDE TEST SET PASSES** (measured
       2026-09-17, by the first cross-shard run that completed). A base
       measurement sweeps a subject against every test that reaches it, and the
       dry run must execute all of them before a single mutant is tried:
       `flatten.ts` pulls 1 079 tests and took 2 min 58 s quiet. The settle run
       repeats that dry run, and under load it went past five minutes —
       `ERROR DryRunExecutor Initial test run timed out!`, no report, and the
       whole measurement refused as `did-not-run`. The change was then billed for
       debt it had not added, which is fail-closed and still wrong.
       `session.ts` never showed it at 527 tests, so only a file with a large
       covering set meets this, and only when a settle run is needed — which is
       exactly the combination no unit test and no plain sweep had reached.
       Twenty minutes is far above any dry run measured here and still a bound: a
       run that hangs fails rather than spending the whole sweep's budget. */
    dryRunTimeoutMinutes: 20,
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
