import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `scripts/sync-scenario.sh` — what can be checked without two Macs
 * (phase 11, WI-11.7).
 *
 * WHAT THIS DOES NOT PROVE, said first because it is the important half: it
 * does not run the scenario. That needs two machines on one LAN with the app
 * running and frontmost on both, and it is the item's actual Verify. What it
 * DOES prove is everything that would otherwise be discovered on those two
 * machines, at the cost of an afternoon each time:
 *
 *   - the script parses, and every argument path exits with the code it
 *     promises
 *   - a hostile `<user@host>` never reaches a shell
 *   - the preflight fails LOCALLY, before any ssh, when there is no built
 *     `paper` — an unattended harness must not spend a round trip to learn
 *     something it already knew
 *   - it still names every step WI-8.6 left owed, so the scenario cannot
 *     quietly shrink to the parts that were easy
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-scenario.sh')

/**
 * The script's CODE, with comments removed.
 *
 * Nearly every assertion below is `expect(text).toContain(...)` against the
 * whole file — and this file is heavily commented, deliberately, with prose
 * that quotes the very strings being asserted. So a check could pass because
 * the phrase appears in a comment ABOUT the behaviour rather than in the
 * behaviour, which is a check that cannot fail for the reason it claims.
 *
 * Shell comments only: a `#` that begins a line or follows whitespace. A `#`
 * inside a string (`${x#prefix}`, a colour code) is left alone, because
 * cutting there would delete real code and make the opposite mistake.
 */
function codeOf(source) {
  return source
    .split('\n')
    .map((line, at) => (at === 0 && line.startsWith('#!') ? line : line.replace(/(^|\s)#.*$/, '$1')))
    .join('\n')
}

/** The file as written, comments included — for the few assertions that are
 *  ABOUT the prose: the shebang, and the two documentation requirements. */
function proseOf(source) {
  return source
}



/**
 * An `it` whose body EXECUTES the script. POSIX only — named everywhere.
 *
 * `sync-scenario.sh` is a bash harness that drives two Macs over ssh, and
 * eleven cases here run it to check what it does with its arguments. The
 * Windows leg cannot: `spawnSync` of a shebang script is `EFTYPE` there, and
 * under Git Bash the script exits 1 rather than the 2 it promises, before
 * reaching the validation these cases are about. Neither is a defect in the
 * script — nobody drives two Macs from Windows, and no argument here has ever
 * been parsed by a shell this repository ships to.
 *
 * WHY A HELPER AND NOT `describe.skipIf`. A skipped suite is not COLLECTED, so
 * `vitest list` omits it and `tests/ledger.json` — one file for all three
 * platforms — would read eleven names as deleted on Windows and be red there
 * for ever. Measured on the run that first got this far: 5 372 collected on a
 * Mac holding the gitignored config, 5 369 on CI, the difference being exactly
 * the three names the ledger already drops for that reason. So the name is
 * registered on every platform and only the body is conditional, which is the
 * shape `verify.test.mjs` already uses for its one Windows-only assertion.
 *
 * The cases that READ the script's text are not here. Reading is the same
 * everywhere, and it is most of this file.
 */
const RUNS_A_SHELL_SCRIPT = process.platform !== 'win32'
const itRuns = (name, body) => it(name, (...args) => (RUNS_A_SHELL_SCRIPT ? body(...args) : undefined))

function run(args, { cwd = REPO_ROOT, script = SCRIPT, env } = {}) {
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    ...(env === undefined ? {} : { env }),
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

/**
 * Run only far enough to see whether the ARGUMENTS were accepted.
 *
 * An accepted argument list goes on to `ssh`, which on a host that does not
 * exist takes as long as the connection takes to fail — so a test that asks
 * "was this accepted?" must not wait for that. Killed after a moment; what is
 * read is stderr, which the validation writes before anything is dialled.
 */
function validateOnly(args) {
  /* `--out` TO A TEMPORARY PATH, always.
   *
   * The script's default transcript is `dev-docs/plans/evidence/wi-11-7-<stamp>.md`,
   * and it writes the header before it reaches the ssh this test never lets it
   * finish — so every accepted-argument case left a file in the repository.
   * A hundred and twenty-nine of them accumulated before anyone looked at
   * `git status`. A test that litters the tree it is testing is a test nobody
   * will keep running. */
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'paper-scenario-')), 'transcript.md')
  const result = spawnSync('bash', [SCRIPT, ...args, '--out', out], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    /* Short on purpose. Validation writes to stderr before anything is
     * dialled, so waiting longer only waits for a connection that will never
     * be made — and six of these at two seconds each is twelve seconds of
     * suite time to learn something the first fraction of a second says. */
    timeout: 400,
    killSignal: 'SIGKILL',
  })
  return result.stderr ?? ''
}

describe('the script itself', () => {
  it('parses', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  /**
   * EXECUTABLE MEANS THE BIT, not the shebang.
   *
   * This read the file's TEXT and called that executable. `dev-docs/cli.md` tells
   * a reader to run `./scripts/sync-scenario.sh <user@host>` — which is the
   * mode bit, not the first line — and every test in this file invokes it as
   * `bash <path>`, which works on a file with no execute permission at all.
   * So the one thing the claim was about was the one thing nothing looked at,
   * and a lost bit would have gone unnoticed until somebody followed the
   * documentation.
   */
  it('is executable', ({ skip }) => {
    /* Same as the bundle's: NTFS has no execute bit and Node reports 0o666 for
       every file, so this asked Windows for something it does not have. Run
       time, not `skipIf` — see `itRuns` above for why the name must still be
       collected on every platform. */
    if (process.platform === 'win32') skip('Windows has no execute bit')
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0)
  })

  itRuns('runs when invoked directly, not only through bash', () => {
    const result = spawnSync(SCRIPT, ['--help'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("WI-8.6's scenario")
  })

  it('names bash in its shebang and fails loudly', () => {
    const text = proseOf(readFileSync(SCRIPT, 'utf8'))
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(text).toContain('set -euo pipefail')
  })

  /* The scenario is WI-8.6's "Still owed" list. A harness that dropped a step
   * would pass while proving less, and nothing else would say so. */
  it('names every step the scenario owes', () => {
    const text = codeOf(readFileSync(SCRIPT, 'utf8'))
    for (const step of [
      'Cold read',
      'travels to the satchel',
      'highlight made on the satchel',
      'tag rename on the shelf fans out',
      'A removal travels',
      'hub edits, then goes quiet',
    ]) {
      expect(text).toContain(step)
    }
  })

  /* And it says what it is NOT: a harness that implied it synced would draw
   * exactly the wrong conclusion WI-8.6's first run drew about grants. */
  it('says plainly that it does not sync, and that the apps must be frontmost', () => {
    const text = proseOf(readFileSync(SCRIPT, 'utf8'))
    expect(text).toContain('IT DOES NOT SYNC')
    expect(text).toContain('FRONTMOST')
  })
})

describe('arguments', () => {
  itRuns('exits 2 with a usage line and no host', () => {
    const result = run([])
    expect(result.code).toBe(2)
    expect(result.err).toContain('usage: scripts/sync-scenario.sh <user@host>')
  })

  itRuns('exits 0 for --help and prints what it does', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain("WI-8.6's scenario")
  })

  itRuns('exits 2 on an unknown option', () => {
    const result = run(['--nonsense', 'user@host'])
    expect(result.code).toBe(2)
    expect(result.err).toContain("unknown option '--nonsense'")
  })

  itRuns('exits 2 on a second host', () => {
    const result = run(['a@b', 'c@d'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('exactly one')
  })

  /**
   * A `--timeout` MUST BE SECONDS THIS SCRIPT CAN ACTUALLY WAIT.
   *
   * The check was `*[!0-9]*`, and three shapes of digits got past it:
   *
   *   `08` — digits, so accepted here, then read as OCTAL inside `$((…))`
   *          where 8 is not an octal digit. An argument error reported as an
   *          arithmetic one, several steps away from the argument.
   *   `0`  — every wait expires immediately, so the run reports a
   *          non-convergence it never waited for.
   *   a very long number — overflows the comparison itself.
   */
  itRuns('exits 2 on a --timeout that is not usable seconds', () => {
    for (const bad of ['soon', '', '-1', '1.5', '9s', '08', '007', '0', '999999999999999999999']) {
      const result = run(['--timeout', bad, 'a@b'])
      expect({ bad, code: result.code }).toEqual({ bad, code: 2 })
      expect(result.err, bad).toMatch(/--timeout/)
    }
    expect(run(['--timeout']).code).toBe(2)
  })

  itRuns('accepts an ordinary timeout, so the guard is not refusing everything', () => {
    for (const good of ['1', '90', '99999']) {
      expect(validateOnly(['--timeout', good, 'a@b', '--dry-run']), good).not.toMatch(/--timeout/)
    }
  })

  /* THE HOST IS INTERPOLATED INTO A COMMAND. An allowlist is something one
   * can check by reading, which quoting through bash → ssh → a remote shell
   * is not — the same reasoning `second-instance.sh` records. */
  itRuns('refuses a host carrying anything a shell would read', () => {
    for (const hostile of ['a;rm -rf /', 'a$(whoami)@b', 'a`id`@b', 'a b@c', 'a|b', "a'b@c"]) {
      const result = run([hostile])
      expect({ hostile, code: result.code }).toEqual({ hostile, code: 2 })
      expect(result.err).toContain('must look like user@host')
    }
  })

  /**
   * AND THE SHAPE, which the allowlist above says nothing about.
   *
   * The allowlist keeps a shell metacharacter out of a string that reaches
   * `ssh` — that part was right and is tested above. What nothing checked is
   * that the string is a `user@host` at all: every one of these is spelled
   * with permitted characters, was accepted, and failed later inside ssh with
   * a message about something else entirely.
   */
  itRuns('refuses a host that is not a user@host, however it is spelled', () => {
    for (const wrong of ['localhost', '@host', 'user@', 'a@b@c', '@', '.']) {
      const result = run([wrong])
      expect({ wrong, code: result.code }).toEqual({ wrong, code: 2 })
      expect(result.err, wrong).toMatch(/must look like user@host/)
    }
  })

  itRuns('accepts an ordinary user@host, so the guard is not refusing everything', () => {
    for (const good of ['reader@desk.local', 'a@b', 'a.b-c@d.e-f']) {
      expect(validateOnly([good, '--dry-run']), good).not.toMatch(/must look like user@host/)
    }
  })

  it('refuses an environment override that a remote shell would read', () => {
    const hostile = spawnSync('bash', [SCRIPT, 'a@b', '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PAPER_REMOTE_CHECKOUT: 'x; rm -rf /' },
      timeout: 30_000,
    })
    expect(hostile.status).toBe(2)
    expect(hostile.stderr).toContain('PAPER_REMOTE_CHECKOUT')
  })

  /* BOTH OVERRIDES, not one. `PAPER_REMOTE_PATH` is interpolated into the same
   * remote shell string as the checkout, so it is exactly as dangerous — and
   * testing only one of a pair is how the untested half gets edited later by
   * somebody who reads the test as covering the feature. */
  it('refuses a hostile PAPER_REMOTE_PATH the same way', () => {
    const hostile = spawnSync('bash', [SCRIPT, 'a@b', '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PAPER_REMOTE_PATH: 'x; rm -rf /' },
      timeout: 30_000,
    })
    expect(hostile.status).toBe(2)
    expect(hostile.stderr).toContain('PAPER_REMOTE_PATH')
  })
})

/**
 * The body of a shell function, and whether anything CALLS it.
 *
 * A bare `text.toContain('journal.jsonl')` passes wherever that string
 * appears — including inside a function nobody invokes. So a predicate could
 * be defined, correct, and completely dead, and the assertion about it would
 * be satisfied by its own definition. Two things are needed to say a
 * predicate is in use: the body contains what it must, and something outside
 * the definition calls it.
 */
function bodyOf(source, name) {
  const start = source.search(new RegExp(`^${name}\\(\\) \\{`, 'm'))
  if (start === -1) return null
  const rest = source.slice(start)
  /* One-liner form (`f() { …; }`) or a block ending at a bare `}`. */
  const oneLine = rest.slice(0, rest.indexOf('\n'))
  if (oneLine.trimEnd().endsWith('}')) return oneLine
  const end = rest.search(/^\}/m)
  return end === -1 ? rest : rest.slice(0, end + 1)
}

/** How many times `name` appears outside its own definition. */
function callsTo(source, name) {
  const body = bodyOf(source, name) ?? ''
  const without = body === '' ? source : source.replace(body, '')
  return (without.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
}

describe('every predicate is defined AND used', () => {
  const text = codeOf(readFileSync(SCRIPT, 'utf8'))

  /* A DEAD PREDICATE IS NOT A CHECK. Each of these is what one of the
   * scenario's steps converges on, and a definition nothing calls would leave
   * that step proving nothing while every substring assertion still passed. */
  it('calls each convergence predicate from somewhere', () => {
    for (const name of [
      'satchel_has_book',
      'satchel_lacks_book',
      'shelf_has_mark',
      'satchel_has_tag',
      'satchel_has_renamed_tag',
      'shelf_journal_size',
      'satchel_journal_size',
      'probe_journaling',
      'probe_contact',
      'sync_pass',
      'converge',
    ]) {
      expect(bodyOf(text, name), `${name} is not defined`).not.toBeNull()
      expect(callsTo(text, name), `${name} is defined and never called`).toBeGreaterThan(0)
    }
  })
})

describe('the predicates it converges on', () => {
  /* THE CLASS THIS REPO KEEPS GETTING BITTEN BY: a check that cannot fail.
   * Three of these shipped in the first draft — a grep for a spelling the CLI
   * does not print, a negation that read an ssh failure as absence, and a
   * predicate that was already true before the mutation it was meant to
   * observe. Each one passed on every run while proving nothing. */
  const text = codeOf(readFileSync(SCRIPT, 'utf8'))

  /* Two drafts of the quiet step, neither of which was a test. Reading
   * `journalSeq` out of `shelf.status` compared two nulls and passed on every
   * run; demanding a NUMBER turned it into a step that can only ever fail,
   * because `paper` does not compose sync and that field is null everywhere.
   * The file the journal appends to is the thing that would actually move. */
  it('measures quiet from the journal FILE, not from a field the CLI cannot fill', () => {
    /* SCOPED TO THE FUNCTIONS THAT DO IT. `text.toContain('journal.jsonl')`
     * is satisfied by the string appearing anywhere — a comment, a dead
     * helper, the usage block — so it could not tell "the quiet step reads
     * the journal file" from "the words appear in this file". */
    expect(bodyOf(text, 'shelf_journal_size')).toContain('$HOME/$JOURNAL')
    expect(bodyOf(text, 'satchel_journal_size')).toContain('$HOME/$JOURNAL')
    expect(text).toMatch(/^readonly JOURNAL=.*journal\.jsonl/m)
    /* And both are actually used by the quiet step. */
    expect(callsTo(text, 'shelf_journal_size')).toBeGreaterThan(0)
    expect(callsTo(text, 'satchel_journal_size')).toBeGreaterThan(0)
    /* Named in the comment that explains why it went, and used nowhere. */
    expect(text).not.toMatch(/grep[^\n]*journalSeq/)
  })

  it('proves a removal by the not-found refusal, not by any non-zero exit', () => {
    /* IN THE PREDICATE'S OWN BODY. `text.toContain('not-found')` passed on
     * the word appearing anywhere in the file — including in the comment
     * explaining why the old version was wrong. */
    expect(bodyOf(text, 'satchel_lacks_book')).toContain('not-found')
    expect(text).not.toMatch(/satchel_lacks_book\(\) \{ ! /)
  })

  /* THE FIRST REAL RUN, 2026-08-21, found two more of the same class in this
   * very file — which is the argument for running a harness against real
   * machines rather than reasoning about it. */
  it('carries evidence from EVERY predicate, including the tag ones', () => {
    /* Three predicates were fixed to print what they saw; `has_live_tag`
     * returns only an exit code and was missed, so the tag steps still
     * reported `last answer: <none>` on the second real run.
     *
     * Asserted inside the two predicates that were missed, so a fix reverted
     * in one of them fails here rather than being covered by the other's
     * mention of the same helper. */
    expect(bodyOf(text, 'satchel_has_tag')).toContain('satchel_tags')
    expect(bodyOf(text, 'satchel_has_renamed_tag')).toContain('satchel_tags')
    expect(callsTo(text, 'satchel_tags')).toBeGreaterThan(1)
  })

  it('carries evidence in a convergence failure, rather than "<none>"', () => {
    /* Every predicate swallowed its own output, so a timeout reported "last
     * answer: <none>" — a named failure with nothing in it. The operator
     * cannot tell "not replicated yet" from "the ssh died" without it. */
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/satchel book get "\$SCENARIO_BOOK" --json >\/dev\/null/)
    expect(text).toContain('last answer:')
  })

  /* THE PRECONDITION THE WHOLE HARNESS RESTS ON, and the one it did not
   * check. Measured on two real machines: `paper book add` puts the folder on
   * disk and the journal records nothing, because `paper` does not compose
   * the sync capability — and replication is a journal feed. Both runs spent
   * every convergence step waiting for something that could not happen. */
  it('probes whether a CLI write reaches the journal, and cleans up after itself', () => {
    expect(text).toContain('probe_journaling')
    expect(text).toContain('did NOT reach the sync journal')
    /* The probe writes a book; it must remove it, and the trash directory it
     * leaves behind, or a refused preflight litters the reader's library.
     *
     * ⚠️ THIS ASSERTED THE LITERAL `wi_11_7_journal_probe`, which is to say it
     * asserted the FIXED id that made the probe able to delete a book it had
     * not created. A test that pins the defective value is how the defect
     * survives a rewrite. The property is that the cleanup path is DERIVED
     * from the probe's own id, whatever that id is. */
    expect(text).toContain('shelf book remove "$PROBE_BOOK"')
    expect(text).toMatch(/PROBE_TRASH="\$\{PROBE_BOOK\/\/-\/_\}"/)
    expect(text).toContain('trash/$PROBE_TRASH')
  })

  /* THE PRECONDITION THAT COST TWO FULL RUNS before anyone checked it. Every
   * convergence step waits on replication, and replication needs a peer
   * session. `peers.json` answers that from a file in a millisecond — and on
   * 2026-08-21 it answered "thirty-nine hours ago" with both apps running,
   * both frontmost and both machines on one LAN. */
  it('refuses when the two machines are not in contact, and dates the last one', () => {
    expect(text).toContain('probe_contact')
    expect(text).toContain('peer/peers.json')
    expect(text).toContain('lastSeenAt')
    expect(text).toContain('NOT in contact')
  })

  /* `set -euo pipefail` is on, so a bare `said=$(...)` whose substitution
   * exits non-zero ends the SCRIPT. It did: the run stopped mid-preflight
   * with two checks never reported, which is the opposite of what a preflight
   * is for. */
  it('captures the contact probe without tripping set -e', () => {
    expect(text).toContain('|| rc=$?')
    expect(text).not.toMatch(/said=\$\([^)]*\)\n\s*if \[ \$\? -eq 0 \]/)
  })

  /* The two reasons a CLI write does not reach the journal need different
   * things done about them, so they are reported differently. */
  it('probes journalling by doing what a mutation does, not by reading a flag', () => {
    expect(text).toContain('did NOT reach the sync journal')
    /* The probe runs the real sequence — app down, write, look, app back —
     * rather than reading a flag that is up on every machine the app has
     * ever run, which is a check that refuses always. */
    expect(text).toContain('app_quit shelf')
    expect(text).toContain('app_start shelf')
  })

  /* A MUTATION TAKES THE APP DOWN AND PUTS IT BACK, which looks absurd for a
   * sync test and is the only order that works: `paper` journals only with no
   * process holding the library, and only the app can replicate. */
  it('brackets every mutation with a quit and a start, and triggers a pass', () => {
    expect(text).toContain('app_quit "$side"')
    expect(text).toContain('app_start "$side"')
    expect(text).toContain('sync_pass')
    /* The satchel initiates the bidirectional pass, so a shelf-side mutation
     * needs its restart too or nothing goes anywhere. */
    expect(text).toMatch(/\[ "\$side" = shelf \] && sync_pass/)
  })

  /* `set -u` is on, and `app_quit` runs in the PREFLIGHT probe — hundreds of
   * lines before the check that used to declare this. The first real run
   * after the restructure died with `APP_PROCESS: unbound variable`. */
  it('declares APP_PROCESS before the helpers that use it', () => {
    const decl = text.indexOf("readonly APP_PROCESS=")
    const use = text.indexOf('app_quit() {')
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(use)
  })

  /**
   * AN APPLESCRIPT `quit` AND THE APP'S QUIT ITEM ARE DIFFERENT SHUTDOWNS.
   *
   * Only the menu item routes through `AppHandle::exit`, which is the one the
   * app can defer long enough to close the journal. Quitting the other way
   * leaves the dirty flag up and makes the next launch re-verify the shelf.
   */
  it('quits through the app menu, not `quit app`', () => {
    expect(text).toContain('click menu item "Quit Paper"')
    expect(text).not.toMatch(/osascript -e 'quit app/)
  })

  /**
   * A DESKTOP IS A SHELF UNLESS `PAPER_ROLE` SAYS OTHERWISE, and that override
   * is COMPILED OUT of release builds — so the satchel must be launched with
   * it, from a debug build, or pairing fails with `expected Satchel, got
   * Shelf`. That is a real afternoon, spent.
   */
  it('starts the satchel with its role override', () => {
    expect(text).toContain('PAPER_ROLE=satchel')
  })

  it('starts the transcript clean rather than continuing a previous run’s', () => {
    /* `log` writes with `tee -a`, so an explicit `--out` at a previous run's
     * file quietly continued it — two headers, two verdicts, and a claim at
     * the top to be one run. */
    expect(text).toContain(': > "$out"')
  })

  /**
   * THE SINGLE MOST VALUABLE GUARD THIS HARNESS WAS MISSING.
   *
   * The first real run had the app RUNNING on both machines and still timed
   * out six times: the satchel's screen had re-locked while idle, which
   * suspends the webview exactly as an occluded window does. Every other
   * signal said go.
   */
  it('refuses against a locked screen on either machine, and against an unreadable one', () => {
    expect(text).toContain('CGSSessionScreenIsLocked')
    expect(text).toContain('the screen is LOCKED on')
    /* Unknown is refused, not assumed unlocked — `second-instance.sh`'s rule,
     * kept identical rather than reinvented. */
    expect(text).toContain('refused rather than assumed unlocked')
  })

  /**
   * `$out` IS THE TRANSCRIPT PATH, and `log` writes with `tee -a "$out"` — so
   * ANY function declaring a local of that name silently redirects every log
   * line inside it.
   *
   * Three did. The first real run left four files in the repository root named
   * after command output — `paper: mark.add: not-found: no book wi-11-7-book`
   * was one — and the transcript was missing every mutation step. A shell will
   * not catch this; only the name will.
   */
  it('never shadows the transcript path with a local', () => {
    expect(text).not.toMatch(/^\s*local out\b/m)
    expect(text).toContain('tee -a "$out"')
  })

  it('SKIPS a step whose precondition never held, rather than passing it', () => {
    /* "the satchel drops the removed book" converges on ABSENCE, which is
     * trivially true of a book that never arrived — so on the first real run
     * it reported `ok` while proving nothing, and it passes hardest exactly
     * when the scenario has failed worst. */
    expect(text).toContain('satchel_saw_book')
    expect(text).toContain('it never received it, so absence proves nothing')
    /* And a skip is not a pass: the verdict and the exit code both say so. */
    expect(text).toContain('INCOMPLETE')
    expect(text).toContain('[ "$failures" -eq 0 ] && [ "$skipped" -eq 0 ]')
  })

  it('reads the live tags array rather than grepping a row that carries tombstones', () => {
    /* `book.get` answers a `BookDetail`, whose `tagClock` keeps a tombstone
     * for every tag the book has ever carried — spelling included — so a grep
     * matches a tag a previous run switched off. */
    expect(text).toContain('has_live_tag')
    expect(text).toContain('tags.includes')
  })
})

describe('the preflight', () => {
  /* The script does not sync. With the app closed every convergence step
   * times out — six times `--timeout`, AFTER both libraries have been written
   * to. A named failure in a second is the whole difference. */
  it('checks that the app is running on both sides, and does not pretend to check frontmost', () => {
    const text = proseOf(readFileSync(SCRIPT, 'utf8'))
    /* BY BUNDLE PATH. `pgrep -x Paper` can never match — a Tauri bundle names
     * its executable after the Cargo target, so the process is
     * `Paper.app/Contents/MacOS/app`. That check reported "not running" with
     * the app on screen, and cost an hour of diagnosing a healthy install. */
    expect(text).toContain("APP_PROCESS='Paper.app/Contents/MacOS/'")
    /* Named in the comment that explains why it went, and RUN nowhere:
     * comment lines are stripped before the assertion, so the guard is about
     * the code rather than about the prose that documents it. */
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/pgrep -x Paper/)
    expect(code).toMatch(/pgrep -f "\$APP_PROCESS"/)
    expect(code).toMatch(/pgrep -f '\$APP_PROCESS'/)
    expect(text).toContain('Paper is NOT running on this machine')
    expect(text).toContain('Paper is NOT running on $remote')
    /* And it says WHY frontmost is a precondition rather than a check: a
     * guard that claimed to verify it would make a passing run mean less
     * than it appears to.
     *
     * Matched against the comment block UNWRAPPED — a prose assertion that
     * breaks when a sentence rewraps is a test about line lengths. */
    const prose = text.replace(/\n#\s?/g, ' ')
    expect(prose).toContain('stays an operator precondition')
  })

  /* Fatal on the spot, and BEFORE any ssh. The whole scenario reaches for
   * `paper`, so carrying on would spend a round trip discovering a local
   * problem — and, in a harness meant to run unattended, would hang on a host
   * that does not resolve. */
  itRuns('fails locally when there is no built paper, without reaching for the remote', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sync-scenario-'))
    try {
      mkdirSync(path.join(root, 'scripts'), { recursive: true })
      const copy = path.join(root, 'scripts', 'sync-scenario.sh')
      copyFileSync(SCRIPT, copy)
      chmodSync(copy, 0o755)
      const out = path.join(root, 'transcript.md')
      /* SSH IS OBSERVED, not inferred.
       *
       * This used to point at a `.invalid` host and argue that reaching it
       * would blow the timeout — but a name that does not resolve fails
       * IMMEDIATELY with NXDOMAIN, so an ssh that ran would have returned in
       * milliseconds and the test would have passed exactly the same. The
       * assertion proved the run was fast, which it would be either way.
       *
       * A fake `ssh` earlier on PATH records that it was called. Absence of
       * the marker is the evidence; presence names the failure. */
      const bin = path.join(root, 'bin')
      mkdirSync(bin, { recursive: true })
      const marker = path.join(root, 'ssh-was-called')
      const fake = path.join(bin, 'ssh')
      writeFileSync(fake, `#!/bin/sh\necho called >> ${JSON.stringify(marker)}\nexit 0\n`)
      chmodSync(fake, 0o755)

      const result = run(['--dry-run', '--out', out, 'nobody@nowhere.invalid'], {
        cwd: root,
        script: copy,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      })
      expect(result.code).toBe(1)
      expect(result.out).toContain('no ./bin/paper.mjs here')
      expect(result.out).toContain('pnpm build:cli')
      expect(existsSync(marker), 'the preflight reached for ssh before checking locally').toBe(false)
      /* And it left the transcript it promised, with the failure in it. */
      expect(readFileSync(out, 'utf8')).toContain('no ./bin/paper.mjs here')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * TWO CLASSES AN AUDIT FOUND, each pinned so it cannot come back quietly.
 *
 * Both are about what this script hands to a shell on somebody else's Mac.
 */
describe('what reaches the remote shell', () => {
  it('routes every ssh through the one helper that bounds it', () => {
    /* `converge` checks its deadline BETWEEN calls, so a single ssh that hangs
       — a sleeping Mac, a half-open socket, a wedged sshd — blocks past
       `--timeout` for as long as the kernel keeps the connection, and the run
       neither converges nor gives up. Seven call sites had no bound at all.
       Counting them here is what stops an eighth being added without one. */
    const text = proseOf(readFileSync(SCRIPT, 'utf8'))
    const calls = text.match(/\bssh\s+-o\b/g) ?? []
    expect(calls, 'an ssh outside remote_sh — give it the helper, not its own flags').toHaveLength(1)
    expect(text).toContain('remote_sh() {')
    for (const flag of ['BatchMode=yes', 'ConnectTimeout=', 'ServerAliveInterval=', 'ServerAliveCountMax=']) {
      expect(text, `remote_sh lost ${flag}`).toContain(flag)
    }
  })

  it('validates the satchel app path before it is interpolated into a remote command', () => {
    /* `open -a "$HOME/$SATCHEL_APP"` is handed to a remote shell. A value with
       a quote, a `;` or a `$(…)` ran as a command on the far machine —
       arbitrary execution out of an environment variable, in a harness pointed
       at somebody else's Mac. `REMOTE_CHECKOUT` beside it was already
       validated and this was not. */
    const text = proseOf(readFileSync(SCRIPT, 'utf8'))
    expect(text).toContain('readonly SATCHEL_APP=')
    expect(text).toMatch(/case "\$SATCHEL_APP" in/)
    /* THE PROPERTY, not the spelling: the command handed to the remote shell
       must interpolate the CHECKED value. The raw variable may still be named
       in the validator's own error messages, which is where a reader who set
       it badly needs to see it. */
    const opened = text.split('\n').filter((line) => line.includes('open --env PAPER_ROLE=satchel'))
    expect(opened, 'the satchel launch line moved').toHaveLength(1)
    expect(opened[0]).toContain('$SATCHEL_APP')
    expect(opened[0], 'the unchecked variable still reaches the remote shell').not.toContain('PAPER_SATCHEL_APP')
  })
})

/**
 * THE PROBE MUST NOT BE ABLE TO DELETE A BOOK IT DID NOT CREATE.
 *
 * It used the fixed id `wi-11-7-journal-probe`, which made it wrong three ways
 * at once: it grepped the WHOLE append-only journal, so any earlier run's line
 * made every later probe pass — including runs where the CLI write never
 * journaled; it removed that id and deleted its trash unconditionally, so a
 * live or trashed book holding it was destroyed by a diagnostic; and a run
 * that died between the add and the remove left it behind to do it again.
 */
describe('the journaling probe owns what it deletes', () => {
  const text = () => proseOf(readFileSync(SCRIPT, 'utf8'))

  it('uses a per-run id rather than a fixed one', () => {
    const assigned = text().match(/readonly PROBE_BOOK=.*/)?.[0] ?? ''
    expect(assigned, 'PROBE_BOOK is a fixed literal again').toMatch(/\$\$|\$\(date/)
  })

  it('requires its own add to have succeeded before it removes anything', () => {
    /* `|| true` on the add discarded the one fact that made the cleanup safe. */
    const body = text()
    expect(body).toMatch(/if shelf book add "\$PROBE_BOOK"/)
    expect(body).toMatch(/created=yes/)
    expect(body).toMatch(/if \[ "\$created" = yes \]/)
  })

  it('fails by name when it could not add its own book, instead of measuring nothing', () => {
    expect(text()).toMatch(/could not add its own book/)
  })
})

/**
 * TWO FLAGS THAT DID NOT MEAN WHAT THEY SAID.
 *
 * Both were audit findings, and both are the same shape: a contract stated in
 * the usage line and contradicted by the code under it.
 */
describe('the flags keep their promises', () => {
  const text = () => proseOf(readFileSync(SCRIPT, 'utf8'))

  it('honours --dry-run BEFORE the probe that writes a book', () => {
    /* `--dry-run` is documented "preflight only … change nothing" and was not
       read until long after `probe_journaling` had quit the app, created a
       book, removed it and deleted its trash. The run then printed "Nothing
       was changed." over all of it. */
    const body = text()
    /* The probe must only be reachable through the guard, never bare. A bare
       CALL is `probe_journaling` alone on a line — not the definition, which
       is `probe_journaling() {` and also starts a line. */
    expect(body, 'probe_journaling is still called unconditionally').not.toMatch(/^probe_journaling\s*$/m)
    expect(body).toMatch(/if \[ "\$dry_run" -eq 1 \]; then\n\s*skip [\s\S]{0,240}else\n\s*probe_journaling/)
  })

  it('says which question a dry run did not answer', () => {
    /* "Nothing was changed" is true again — and on its own it would imply the
       preflight proved everything it normally proves. */
    expect(text()).toMatch(/NOT proven here/)
  })

  it('says when an app was force-killed rather than quit, and when one never started', () => {
    /* THE SAME ALWAYS-SUCCESS SHAPE `--clean` had, and it matters more here.
       The graceful path is the app's shutdown handshake, which closes the sync
       journal; `pkill` is the DIRTY shutdown the `QUIT_VIA_MENU` comment
       exists to avoid, and it is what happens when Accessibility permission is
       missing and the AppleScript silently does nothing. Both helpers returned
       0 unconditionally, so a run proceeded over a dirty journal, or against a
       machine running nothing, having said neither. */
    const body = text()
    expect(body).toMatch(/force-killed/)
    expect(body).toMatch(/is NOT running after a launch attempt/)
    /* `app_start` must be able to report failure at all. */
    expect(body).toMatch(/app_start\(\) \{[\s\S]*?return 1[\s\S]*?\n\}/)
  })

  it('checks every --clean removal instead of reporting success over all of them', () => {
    /* Each command carried `|| true`, the log said "removed … from both sides"
       unconditionally, and the exit was always 0 — while the app's advisory
       lock refused every write, so the usual outcome was a no-op announcing a
       cleanup. */
    const body = text()
    const block = body.slice(body.indexOf('if [ "$clean" -eq 1 ]'), body.indexOf('# --- the scenario'))
    expect(block).not.toMatch(/(tag|book) remove[^\n]*\|\| true/)
    expect(block, '--clean never exits non-zero').toMatch(/exit 1/)
    expect(block, '--clean writes while the apps hold the lock').toMatch(/app_quit shelf/)
  })
})
