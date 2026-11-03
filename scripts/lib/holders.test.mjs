import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, onTestFinished } from 'vitest'
import { followHolders } from './holders.mjs'

/**
 * What `followHolders` costs, which its two gates cannot see.
 *
 * `check-dead-css.mjs` and `check-residue.mjs` test what the walk FINDS. The type
 * of what a member is read from is the slow question the walk asks, and it is
 * asked only of a name something in the file could answer — an answer the gates
 * get either way, so only a count of the questions tells the two apart.
 */

/** How many types the walk asked the checker for, following `styles` through `text`. */
function typesAskedFor(text) {
  const dir = mkdtempSync(join(tmpdir(), 'holders-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'a.ts')
  writeFileSync(file, text)
  const program = ts.createProgram([file], { noLib: true, noResolve: true, types: [] })
  const real = program.getTypeChecker()
  let asked = 0
  const checker = new Proxy(real, {
    get: (target, key) =>
      key === 'getTypeAtLocation'
        ? (...args) => {
            asked += 1
            return target.getTypeAtLocation(...args)
          }
        : target[key],
  })
  followHolders({
    source: program.getSourceFile(file),
    checker,
    rootName: 'styles',
    rootOrigin: 'styles',
    rootOf: () => [],
    seeds: [],
    elementSeeds: [],
    returning: [],
    read: () => {},
    enumerated: () => {},
    escaped: () => {},
    handedOn: () => true,
  })
  return asked
}

describe('the type of what a member is read from', () => {
  it('is not asked for when nothing in the file holds the value under that name', () => {
    /* `other` is a name, a key and a member read, and holds nothing each time. */
    expect(typesAskedFor('const other = 1\nconst box = { other: 2 }\nexport const f = (x: { other: number }) => x.other + box.other\n')).toBe(0)
  })

  it('is asked for once something holds the value under that name', () => {
    expect(typesAskedFor('const box = { other: styles }\nexport const f = (x: typeof box) => x.other\n')).toBeGreaterThan(0)
  })
})
