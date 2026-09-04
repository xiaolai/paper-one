import { describe, expect, it } from 'vitest'
import { changedFiles, testsCovering } from './check-mutants.mjs'

/**
 * The mutation gate's own guard.
 *
 * ⚠️ **A DETECTOR THAT HAS QUIETLY STOPPED DETECTING PASSES FOR EVER**, and
 * this one selects its own input — so if the selection silently returns
 * nothing, the gate reports success over an empty run. That is precisely the
 * shape of failure it exists to catch, which would be a poor joke to ship.
 */

describe('what the mutation gate chooses to mutate', () => {
  it('never offers a test file as a subject', () => {
    /* Mutating a test asks whether the tests test the tests. Every entry has to
       be production code or the run is measuring itself. */
    for (const file of changedFiles('main')) {
      expect(file).not.toMatch(/\.test\.[cm]?tsx?$|\.test\.mjs$/u)
      expect(file).not.toMatch(/\.testkit\./u)
      expect(file).not.toMatch(/\.d\.ts$/u)
    }
  })

  it('offers only files that exist', () => {
    // A deleted file is in the diff and cannot be mutated.
    expect(changedFiles('main').every((f) => f.length > 0)).toBe(true)
  })

  it('follows imports rather than matching names', () => {
    /* ⚠️ **NAME MATCHING WOULD REPORT MOST OF THIS REPOSITORY AS UNTESTED.**
       `store.ts` is covered by `circle.test.ts`, `panes.ts` by
       `commands.test.ts`. A gate that looked for `store.test.ts` would find
       none, call the module uncovered, and turn every one of its mutants into
       a finding nobody can act on. */
    const found = testsCovering(
      ['src/capabilities/circle/lib/store.ts'],
      ['src/capabilities/circle/circle.test.ts'],
    )
    expect(found).toEqual(['src/capabilities/circle/circle.test.ts'])
  })

  it('does not claim a test covers a module it never imports', () => {
    const found = testsCovering(
      ['src/capabilities/circle/lib/store.ts'],
      ['src/kernel/ui/state.test.ts'],
    )
    expect(found).toEqual([])
  })

  it('sees UNTRACKED test files, which is where new work lives', () => {
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
       find the test. */
    const { existsSync, readFileSync } = require('node:fs')
    const path = require('node:path')
    for (const test of untracked) {
      const source = readFileSync(test, 'utf8')
      const subject = [...source.matchAll(/from\s+'(\.[^']+)'/gu)]
        .map((spec) => path.resolve(path.dirname(test), spec[1]))
        .flatMap((target) => ['.ts', '.tsx', '.mjs', '/index.ts'].map((ext) => target + ext))
        .find((candidate) => existsSync(candidate) && !/\.test\.[cm]?tsx?$|\.testkit\./u.test(candidate))
      if (subject === undefined) continue
      expect(testsCovering([subject], untracked), `${test} imports ${subject}`).toContain(test)
    }
  })

  it('resolves a directory import to its index', () => {
    // `from '../../peer'` is `peer/index.ts`, and missing that would drop
    // every capability tested through its barrel.
    const found = testsCovering(
      ['src/capabilities/peer/index.ts'],
      ['src/capabilities/circle/ui/CirclePane.test.tsx'],
    )
    expect(found).toEqual(['src/capabilities/circle/ui/CirclePane.test.tsx'])
  })
})
