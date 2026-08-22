import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LEDGER,
  compare,
  conditional,
  conditionalSuites,
  parseArgs,
  readLedger,
  writeLedger,
} from './check-test-ledger.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The ledger guard, tested on everything except the part that shells out.
 *
 * `askVitest` is deliberately not exercised here: it spawns Vitest, and a test
 * that ran Vitest from inside Vitest would either recurse or take a minute to
 * say something the guard's own use in `pnpm verify` says every run anyway.
 * What is testable is the decision — which names count as gone — and the
 * round trip, and those are where a mistake would be silent.
 */

const dir = () => mkdtempSync(path.join(tmpdir(), 'ledger-'))

/** A root that already holds a ledger with the given raw body. */
const rootHolding = (body) => {
  const root = dir()
  const file = path.join(root, LEDGER)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  return root
}

describe('what counts as gone', () => {
  /* The incident, in one line: twelve names left, thirteen arrived, the total
   * rose, and every other gate stayed green. A guard that compared COUNTS
   * would report a healthy +1 here. */
  it('reports a removal even when more tests arrived than left', () => {
    const recorded = ['a.test.ts > one', 'a.test.ts > two', 'a.test.ts > three']
    const current = ['a.test.ts > three', 'a.test.ts > four', 'a.test.ts > five', 'a.test.ts > six']
    expect(compare(recorded, current)).toEqual(['a.test.ts > one', 'a.test.ts > two'])
    expect(current.length).toBeGreaterThan(recorded.length)
  })

  it('says nothing when tests are only added', () => {
    const recorded = ['a.test.ts > one']
    expect(compare(recorded, ['a.test.ts > one', 'a.test.ts > two'])).toEqual([])
  })

  /* A test moved between files is a removal from the file that had it. The
   * name carries its file for exactly this reason: renaming the describe, or
   * moving the test, both stop the OLD assertion running, and a reader six
   * months later cannot tell those apart from a deletion. */
  it('treats a move between files as a removal', () => {
    expect(compare(['a.test.ts > one'], ['b.test.ts > one'])).toEqual(['a.test.ts > one'])
  })

  it('treats a rename as a removal', () => {
    expect(compare(['a.test.ts > turns the page'], ['a.test.ts > turns a page'])).toEqual([
      'a.test.ts > turns the page',
    ])
  })

  it('is clean when nothing moved', () => {
    const same = ['a.test.ts > one', 'b.test.ts > two']
    expect(compare(same, same)).toEqual([])
  })
})

describe('the ledger on disk', () => {
  it('round-trips what it wrote', () => {
    const root = dir()
    const tests = ['a.test.ts > one', 'b.test.ts > two']
    writeLedger(root, tests)
    expect(readLedger(root)).toEqual(tests)
  })

  /* ABSENT IS NOT EMPTY, and telling them apart is the guard.
   *
   * This returned `[]` for a missing file, so `rm tests/ledger.json` made
   * every recorded name unrecorded, reported nothing, and exited 0 — the
   * check disabled by one deletion while still saying "pass". `null` lets the
   * caller allow absence only where it is legitimate: `--write`, which is how
   * a first ledger is created.
   *
   * The original worry stands and is still met: a checkout with no ledger
   * does not read as "everything was deleted". It reads as "no ledger", and
   * `--write` is the answer. */
  it('reports an absent ledger as absent, not as empty', () => {
    expect(readLedger(dir())).toBeNull()
  })

  /* But a ledger that is present and unreadable is NOT empty. Swallowing that
   * would turn a corrupted file into a silent all-clear, which is the same
   * shape of failure the guard exists to prevent. */
  it('throws on a ledger it cannot parse, rather than reporting none', () => {
    expect(() => readLedger(rootHolding('{ this is not json'))).toThrow()
  })

  it('throws on a ledger with no tests array', () => {
    expect(() => readLedger(rootHolding(JSON.stringify({ note: 'hi' })))).toThrow(/tests/)
  })

  /* Written for a human to read in a diff — one name per line, sorted — so a
   * removal shows up as a removed LINE rather than as a reflowed blob. */
  it('writes one name per line, so a removal is a line in the diff', () => {
    const root = dir()
    writeLedger(root, ['a.test.ts > one', 'a.test.ts > two'])
    const body = readFileSync(path.join(root, LEDGER), 'utf8')
    expect(body).toMatch(/"a\.test\.ts > one",\n/)
    expect(body.endsWith('\n')).toBe(true)
  })
})

describe('the command line', () => {
  it('defaults to the repository and to checking rather than writing', () => {
    const args = parseArgs([])
    expect(args.error).toBeUndefined()
    expect(args.write).toBe(false)
    expect(path.isAbsolute(args.root)).toBe(true)
  })

  it('takes --write', () => {
    expect(parseArgs(['--write']).write).toBe(true)
  })

  it('refuses an argument it does not understand', () => {
    expect(parseArgs(['--rite']).error).toMatch(/unknown/)
  })

  it('refuses --root without a directory, and --root twice', () => {
    expect(parseArgs(['--root']).error).toMatch(/needs a directory/)
    expect(parseArgs(['--root', 'a', '--root', 'b']).error).toMatch(/twice/)
  })
})

/**
 * THE RULE THAT WAS DOCUMENTED AND ENFORCED BY NOTHING.
 *
 * `0596b95` removed three conditional entries and wrote the paragraph
 * explaining why a clean checkout cannot collect them. `c4fe205` put them
 * straight back — not deliberately, but because `--write` on a machine holding
 * `.claude/tdd-guardian/config.json` records them without comment, and the
 * machine that records them is the one machine where nothing goes red. It
 * surfaced on the next fresh worktree, eight steps into `pnpm verify`.
 *
 * Two occurrences of one shape is a mechanism, not a mistake.
 */
describe('a suite that declares itself conditional', () => {
  const NAME =
    'scripts/word-snap-live.test.mjs > the live lane (skipped when this checkout has no .claude/tdd-guardian/config.json) > does not claim to contribute coverage'

  it('is recognised by the convention the suite already used', () => {
    expect(conditional([NAME, 'a > b > c'])).toEqual([NAME])
  })

  it('is dropped on the way into the ledger, not merely reported', () => {
    /* The half that stops the regression: a `--write` from a developer's
       machine has to produce the ledger a clean checkout would. */
    const root = mkdtempSync(join(tmpdir(), 'paper-ledger-'))
    const skipped = writeLedger(root, [NAME, 'a > b > c'])
    expect(skipped).toBe(1)
    const written = JSON.parse(readFileSync(join(root, LEDGER), 'utf8'))
    expect(written.tests).toEqual(['a > b > c'])
    rmSync(root, { recursive: true, force: true })
  })

  it('is a finding wherever it is found, not only where it fails', () => {
    /* Reported only on the checkout that cannot collect it, the one person who
       could fix it — whoever ran `--write` — is the one person who never sees
       it. `compare` stays about removals; this is its own question. */
    expect(compare([NAME], [NAME])).toEqual([])
    expect(conditional([NAME])).toHaveLength(1)
  })
})

/* Two tests in one file may share a full name — nothing forbids it and
 * copy-paste produces it. A `Set` collapsed them, so deleting ONE of a
 * duplicated pair left the name still "live" and the removal went unreported:
 * the exact disappearance this guard exists to catch, hidden by the shape of
 * the check. */
describe('duplicate names', () => {
  it('reports one gone when two were recorded and one remains', () => {
    expect(compare(['a > x', 'a > x'], ['a > x'])).toEqual(['a > x'])
  })

  it('reports none gone while both remain', () => {
    expect(compare(['a > x', 'a > x'], ['a > x', 'a > x'])).toEqual([])
  })

  it('reports both gone when neither remains', () => {
    expect(compare(['a > x', 'a > x'], [])).toEqual(['a > x', 'a > x'])
  })
})

/* `--root --write` swallowed the flag as the path, so the run went against a
 * directory named `--write`: no tests found, everything reported gone, and
 * the `--write` never happened. */
describe('--root will not eat an option', () => {
  it('refuses an option where a directory belongs', () => {
    expect(parseArgs(['--root', '--write']).error).toMatch(/not --write/)
  })
})

/**
 * THE CLI, END TO END, AGAINST A REAL VITEST PROJECT.
 *
 * Everything above tests the pure pieces — `compare`, `parseArgs`, the ledger
 * file. What none of them reach is the part that actually runs: a subprocess
 * that collects names, the exit codes the gate is read by, and `--write`. Those
 * were exercised only incidentally by `pnpm verify` using them, so a change to
 * the adapter would have been noticed by the whole suite going strange rather
 * than by anything here.
 *
 * A fixture project of two tiny files, so the run is a second rather than the
 * minutes a collection of this repository takes.
 */
describe('the CLI against a real project', () => {
  const made = []

  afterEach(() => {
    while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true })
  })

  /** A minimal Vitest project with the given test files. */
  function project(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-ledger-'))
    made.push(root)
    writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { include: ['*.test.mjs'] } }\n`)
    /* The fixture resolves `vitest` through this repository's own install
     * rather than needing one of its own. */
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ledger-fixture', private: true, type: 'module' }),
    )
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    symlinkSync(path.join(REPO_ROOT, 'node_modules', 'vitest'), path.join(root, 'node_modules', 'vitest'), 'dir')
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(root, name), source)
    return root
  }

  const suite = (names) =>
    `import { afterEach, describe, expect, it } from 'vitest'\n` +
    `describe('s', () => {\n${names.map((n) => `  it('${n}', () => { expect(1).toBe(1) })\n`).join('')}})\n`

  const runCli = (root, args = []) =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-test-ledger.mjs'), '--root', root, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })

  it('writes a ledger, then passes against it', () => {
    const root = project({ 'a.test.mjs': suite(['one', 'two']) })
    const wrote = runCli(root, ['--write'])
    expect(wrote.status, wrote.stderr).toBe(0)
    expect(wrote.stdout).toMatch(/wrote 2 tests/)

    const checked = runCli(root)
    expect(checked.status, checked.stderr).toBe(0)
  })

  /* THE WHOLE POINT: a deleted test is named, and the exit is non-zero even
   * though the file still has tests in it and the total could have risen. */
  it('exits non-zero and names a test that disappeared', () => {
    const root = project({ 'a.test.mjs': suite(['one', 'two']) })
    expect(runCli(root, ['--write']).status).toBe(0)
    /* One removed, two added — a RISING count over a real deletion, which is
     * the exact shape every other signal misses. */
    writeFileSync(path.join(root, 'a.test.mjs'), suite(['one', 'three', 'four']))
    const checked = runCli(root)
    expect(checked.status).toBe(1)
    /* The report goes to STDOUT — it is the gate's answer, not a fault. */
    expect(checked.stdout).toContain('GONE')
    expect(checked.stdout).toContain('> two')
    expect(checked.stdout).not.toContain('GONE s > three')
  })

  it('refuses to check when there is no ledger, rather than starting one', () => {
    const root = project({ 'a.test.mjs': suite(['one']) })
    const checked = runCli(root)
    expect(checked.status).toBe(2)
    expect(checked.stderr).toMatch(/is missing/)
    expect(existsSync(path.join(root, 'tests/ledger.json'))).toBe(false)
  })

  /**
   * A COLLECTION THAT FAILS IS NOT AN EMPTY ONE.
   *
   * A file that will not parse makes Vitest exit non-zero. Reading that as
   * "no tests" would report every recorded name as deleted — a wall of false
   * findings — or, on `--write`, record an empty ledger over a real one.
   */
  it('fails loudly when collection itself fails', () => {
    const root = project({ 'a.test.mjs': suite(['one']) })
    expect(runCli(root, ['--write']).status).toBe(0)
    writeFileSync(path.join(root, 'a.test.mjs'), 'this is not javascript {{{\n')
    const checked = runCli(root)
    expect(checked.status).toBe(2)
    expect(JSON.parse(readFileSync(path.join(root, 'tests/ledger.json'), 'utf8')).tests).toHaveLength(1)
  })

  /**
   * AND `--write` DROPS A CONDITIONAL NAME RATHER THAN RECORDING IT.
   *
   * A `describe.skipIf` suite is collected on some machines and not others,
   * and this ledger cannot hold such a name: "gone" and "not collected here"
   * are the same observation to it. The header said so; nothing enforced it,
   * and a real instance was sitting in the committed ledger.
   *
   * Dropping rather than refusing is the deliberate half: the ledger a
   * developer writes is then the ledger a clean checkout would write, which
   * is the property that actually stops the regression. Refusing would make
   * `--write` impossible on any machine holding the gitignored file — and
   * this repository keeps such a suite on purpose.
   */
  it('drops a name from a conditional suite instead of recording it', () => {
    const root = project({
      'a.test.mjs':
        `import { afterEach, describe, expect, it } from 'vitest'\n` +
        `import { existsSync } from 'node:fs'\n` +
        `describe.skipIf(!existsSync('package.json'))('gated', () => {\n` +
        `  it('runs here and not there', () => { expect(1).toBe(1) })\n` +
        `})\n` +
        `describe('plain', () => { it('always', () => { expect(1).toBe(1) }) })\n`,
    })
    const wrote = runCli(root, ['--write'])
    expect(wrote.status, wrote.stderr).toBe(0)
    expect(wrote.stdout).toMatch(/1 conditional not recorded/)
    const written = JSON.parse(readFileSync(path.join(root, 'tests/ledger.json'), 'utf8'))
    expect(written.tests).toEqual(['a.test.mjs > plain > always'])

    /* AND THE LEDGER IT WROTE IS GREEN HERE TOO — the machine that can
       collect the gated name does not report it as an addition it must
       record, and the clean checkout that cannot does not report it gone. */
    const checked = runCli(root)
    expect(checked.status, checked.stderr).toBe(0)
  })

  /**
   * EXCEPT WHERE THERE IS NOTHING TO DROP.
   *
   * A conditional suite titled by interpolation collects as `a Moby-Dick b`
   * while the source says `a ${name} b`; no collected name can be matched to
   * it, so no name can be dropped, and a ledger written anyway would be a
   * claim this script cannot support. That one case refuses.
   */
  it('refuses a conditional suite whose title it cannot resolve', () => {
    const root = project({
      'a.test.mjs':
        `import { describe, expect, it } from 'vitest'\n` +
        `import { existsSync } from 'node:fs'\n` +
        'const which = existsSync(\'package.json\') ? \'here\' : \'there\'\n' +
        'describe.skipIf(!existsSync(\'package.json\'))(`gated ${which}`, () => {\n' +
        `  it('runs here and not there', () => { expect(1).toBe(1) })\n` +
        `})\n`,
    })
    const wrote = runCli(root, ['--write'])
    expect(wrote.status).toBe(2)
    expect(wrote.stderr).toMatch(/CONDITIONAL suite/)
    expect(wrote.stderr).toMatch(/titled by interpolation/)
    /* Nothing was written — a partial ledger would be worse than none. */
    expect(existsSync(path.join(root, 'tests/ledger.json'))).toBe(false)
  })
})

describe('finding a conditional suite in a source file', () => {
  /**
   * THE CONDITION'S PARENTHESES ARE BALANCED.
   *
   * The first version matched `[^)]*` for the condition, which ends inside
   * `existsSync(FILE)` — so a suite gated on any CALL was invisible, which is
   * the shape most real gates take. A three-name conditional suite was in the
   * committed ledger while the guard reported nothing.
   */
  it('reads a title past a condition that calls something', () => {
    expect(conditionalSuites(`describe.skipIf(!existsSync(LEDGER_FILE))('the committed ledger', () => {})`)).toEqual([
      'the committed ledger',
    ])
    expect(conditionalSuites(`describe.skipIf(a(b(c())))('deep', () => {})`)).toEqual(['deep'])
  })

  it('reads both forms, on describe and on it', () => {
    expect(conditionalSuites(`it.runIf(x)('one', () => {})`)).toEqual(['one'])
    expect(conditionalSuites(`describe.runIf(x)("two", () => {})`)).toEqual(['two'])
    expect(conditionalSuites(`test.skipIf(x)(\`three\`, () => {})`)).toEqual(['three'])
  })

  it('says nothing about an ordinary suite', () => {
    expect(conditionalSuites(`describe('plain', () => { it.skip('one', () => {}) })`)).toEqual([])
  })

  /**
   * A `describe.skipIf` INSIDE A STRING IS NOT A CALL.
   *
   * It is test data, and this very file contains several. Scanning the raw
   * text refused them — a false positive on the one guard whose whole value is
   * being believed, and the first `--write` after the guard landed was
   * rejected by the guard's own fixtures.
   */
  /**
   * COMMENTS ARE SKIPPED BEFORE STRINGS, and the ordering is the whole
   * correctness of it.
   *
   * Prose is full of apostrophes — "the guard's", "this file's" — and a
   * scanner that reads one as an opening quote swallows everything to the next
   * apostrophe, which then covers or uncovers arbitrary code downstream. The
   * first version did exactly that, and reported a call inside a string as
   * real because a comment two hundred lines earlier had shifted its idea of
   * where the strings were.
   */
  it('is not confused by an apostrophe in a comment', () => {
    const source = [
      "// the guard's own prose, with this file's apostrophes in it",
      "const fixture = \"describe.skipIf(x)('not a call', () => {})\"",
      "describe.skipIf(y)('a real one', () => {})",
    ].join('\n')
    expect(conditionalSuites(source)).toEqual(['a real one'])
  })

  it('is not confused by an apostrophe in a block comment either', () => {
    const source = [
      '/* the guard\'s prose */',
      "describe.skipIf(y)('a real one', () => {})",
    ].join('\n')
    expect(conditionalSuites(source)).toEqual(['a real one'])
  })

  it('ignores one written inside a string literal', () => {
    const data = ['const fixture = "describe.skipIf(x)(\'not a call\', () => {})"', ''].join('\n')
    expect(conditionalSuites(data)).toEqual([])
    /* And a REAL one on the next line is still found, so this is not simply
     * refusing everything. */
    expect(conditionalSuites(`${data}\ndescribe.skipIf(y)('a real one', () => {})`)).toEqual(['a real one'])
  })

  /**
   * A TEMPLATED TITLE IS READ, AND THEN REFUSED — not silently missed.
   *
   * The source says `` `a ${'${name}'} b` `` and the collected name says `a Moby-Dick b`;
   * comparing them finds nothing. A guard that merely failed to match here
   * would report success over exactly the case it exists for, so the
   * unresolvable title is reported instead.
   */
  it('reads an interpolated title so it can be refused rather than missed', () => {
    expect(conditionalSuites('describe.skipIf(x)(`a ${name} b`, () => {})')).toEqual(['a ${name} b'])
  })
})

/**
 * AN UNRECORDED TEST IS COUNTED, not charged for.
 *
 * Additions are free on purpose — a guard that made adding a test a chore
 * would be routed around within a week — and that leaves one real gap: a test
 * added in a green commit and never recorded can be DELETED later with nothing
 * to report, because it was never in the ledger to go missing from.
 *
 * Refusing additions would close the gap and break the thing the ratchet is
 * for. Counting them closes it differently: the same treatment deletion gets,
 * which is to be made legible rather than prevented.
 */
describe('tests that are not in the ledger', () => {
  const made = []
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true })
  })

  function project(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'paper-ledger-add-'))
    made.push(root)
    writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: { include: ['*.test.mjs'] } }\n`)
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'f', private: true, type: 'module' }))
    mkdirSync(path.join(root, 'node_modules'), { recursive: true })
    symlinkSync(path.join(REPO_ROOT, 'node_modules', 'vitest'), path.join(root, 'node_modules', 'vitest'), 'dir')
    for (const [name, source] of Object.entries(files)) writeFileSync(path.join(root, name), source)
    return root
  }

  const suite = (names) =>
    `import { describe, expect, it } from 'vitest'\n` +
    `describe('s', () => {\n${names.map((n) => `  it('${n}', () => { expect(1).toBe(1) })\n`).join('')}})\n`

  const runCli = (root, args = []) =>
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-test-ledger.mjs'), '--root', root, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    })

  it('says how many are unrecorded, and still passes', () => {
    const root = project({ 'a.test.mjs': suite(['one']) })
    expect(runCli(root, ['--write']).status).toBe(0)
    writeFileSync(path.join(root, 'a.test.mjs'), suite(['one', 'two', 'three']))

    const checked = runCli(root)
    /* STILL GREEN — the ratchet never blocks growth. */
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain('2 unrecorded')
    expect(checked.stdout).toMatch(/2 collected test\(s\) are not in the ledger/)
  })

  it('says nothing when the ledger is complete', () => {
    const root = project({ 'a.test.mjs': suite(['one', 'two']) })
    expect(runCli(root, ['--write']).status).toBe(0)
    const checked = runCli(root)
    expect(checked.stdout).toContain('0 unrecorded')
    expect(checked.stdout).not.toMatch(/are not in the ledger/)
  })

  /* AND THE COUNT IS RIGHT WHEN BOTH HAPPEN AT ONCE — a removal and an
   * addition in the same change is the shape that hid the original incident:
   * the file went from 15 tests to 17 while losing 12. */
  it('counts additions and removals separately in one change', () => {
    const root = project({ 'a.test.mjs': suite(['one', 'two']) })
    expect(runCli(root, ['--write']).status).toBe(0)
    writeFileSync(path.join(root, 'a.test.mjs'), suite(['one', 'three', 'four', 'five']))

    const checked = runCli(root)
    expect(checked.status).toBe(1)
    expect(checked.stdout).toContain('> two')
    expect(checked.stdout).toContain('1 gone, 3 unrecorded')
  })
})
