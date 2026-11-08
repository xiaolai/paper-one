import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { scanSources } from './check-dead-css.mjs'

/**
 * What following a stylesheet COSTS, which `check-dead-css.test.mjs` cannot see.
 *
 * That file tests what the walk in `lib/holders.mjs` FINDS. The type of what a
 * member is read from is the slow question the walk asks, and it is asked only
 * of a name something in the file could answer — an answer the gate gets either
 * way, so only a count of the questions tells the two apart.
 *
 * ⚠️ **A FILE OF ITS OWN, AND IT GOES THROUGH THE GATE, NOT `holders.mjs`.** The
 * compiler is replaced here by one that counts, which no other test should
 * share. And the mutation gate runs the tests that import a module, or, when
 * none does, the tests one level up: a test importing `holders.mjs` directly
 * would be the ONLY test run against its mutants, and the two gates' tests,
 * which kill the rest, would no longer be.
 */

const asked = vi.hoisted(() => ({ count: 0 }))

/* `typescript`'s exports are getters that cannot be redefined, so it is replaced
   whole: the same compiler, with the checker of every program counting. */
vi.mock('typescript', async (importOriginal) => {
  const real = (await importOriginal()).default
  const counting = (checker) =>
    new Proxy(checker, {
      get: (target, key) =>
        key === 'getTypeAtLocation'
          ? (...args) => {
              asked.count += 1
              return target.getTypeAtLocation(...args)
            }
          : target[key],
    })
  const createProgram = (...args) => {
    const program = real.createProgram(...args)
    const checker = counting(program.getTypeChecker())
    return new Proxy(program, { get: (target, key) => (key === 'getTypeChecker' ? () => checker : target[key]) })
  }
  const ts = { ...real, createProgram }
  return { ...ts, default: ts }
})

/** How many types the gate asked for, scanning a tree of a stylesheet and `source`. */
function typesAskedFor(source) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dead-css-cost-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, body] of Object.entries({ 'src/A.module.css': '.live { color: red; }\n', 'src/A.tsx': source })) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  asked.count = 0
  scanSources(root)
  return asked.count
}

describe('the type of what a member is read from', () => {
  it('is not asked for when nothing in the file holds the stylesheet under that name', () => {
    /* `other` is a name, a key and a member read, and holds nothing each time. */
    expect(
      typesAskedFor(
        "import styles from './A.module.css'\nconst other = 1\nconst box = { other: 2 }\nexport const f = (x: { other: number }) => x.other + box.other + other + styles.live\n",
      ),
    ).toBe(0)
  })

  it('is asked for once something holds the stylesheet under that name', () => {
    expect(
      typesAskedFor("import styles from './A.module.css'\nconst box = { other: styles }\nexport const f = (x: typeof box) => x.other.live\n"),
    ).toBeGreaterThan(0)
  })
})
