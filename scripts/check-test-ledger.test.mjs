import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER, compare, conditional, parseArgs, readLedger, writeLedger } from './check-test-ledger.mjs'

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

  /* The first run in a checkout that has no ledger yet must not read as
   * "everything was deleted" — that would make the guard's own introduction
   * its loudest false positive. */
  it('reads an absent ledger as empty rather than as a catastrophe', () => {
    expect(readLedger(dir())).toEqual([])
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
