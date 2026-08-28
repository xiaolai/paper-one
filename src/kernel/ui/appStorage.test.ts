import { describe, expect, it } from 'vitest'
import { damageNotice, freeQuarantinePath } from './appStorage'

/**
 * ⚠️ **A SECOND CORRUPTION MUST NOT ERASE THE FIRST.**
 *
 * `fileStore` asks for `<path>.corrupt` every time it moves a damaged store
 * aside, and `rename` REPLACES its destination — so a store that went bad
 * twice quarantined twice to one name and the earlier copy was gone. The Node
 * host was given a guarded destination and the webview host, which is the one
 * almost every reader runs, was left with the plain rename.
 *
 * This is the destination choice on its own, because that is the whole of it:
 * the rename around it is the plugin's.
 */
describe('choosing where a damaged store goes', () => {
  /** A fake directory: the names in it are taken, everything else is free. */
  const holding = (...taken: readonly string[]) => {
    const there = new Set(taken)
    return async (path: string) => there.has(path)
  }

  const ASIDE = 'store.json.corrupt'

  /* The ordinary single-fault case keeps the name the caller asked for, which
     is also the name `damageNotice` tells the reader to look for. */
  it('uses the plain name when nothing is there', async () => {
    expect(await freeQuarantinePath(ASIDE, holding())).toBe(ASIDE)
    expect(damageNotice({ aside: ASIDE })).toContain(ASIDE)
  })

  it('takes a suffix rather than replacing an earlier quarantine', async () => {
    expect(await freeQuarantinePath(ASIDE, holding(ASIDE))).toBe(`${ASIDE}.1`)
  })

  it('keeps counting past a run of them', async () => {
    const there = holding(ASIDE, `${ASIDE}.1`, `${ASIDE}.2`)
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.3`)
  })

  /**
   * ⚠️ **ONLY A DEFINITE "NOT THERE" MEANS FREE.** `exists` rejects for a path
   * it cannot interrogate, and reading that as absence hands the rename a
   * destination it silently replaces — the one outcome this exists to prevent.
   */
  it('skips a candidate it could not interrogate', async () => {
    const there = async (path: string) => {
      if (path === ASIDE) throw new Error('permission denied')
      return false
    }
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.1`)
  })

  /* REFUSES rather than falling back on the last candidate. A
     hundred-and-first copy clarifies nothing; overwriting the hundredth
     clarifies less. */
  it('refuses when every candidate is taken', async () => {
    const every = async () => true
    await expect(freeQuarantinePath(ASIDE, every)).rejects.toThrow(/\.1 through \.100 all exist/)
  })

  /* THE LAST CANDIDATE IS TESTED, which is the off-by-one the Node host had:
     a loop that assigns `.100` and then exits holds a name it never asked
     about, and the rename below replaces it. */
  it('uses the hundredth when only it is free', async () => {
    const there = async (path: string) => path !== `${ASIDE}.100`
    expect(await freeQuarantinePath(ASIDE, there)).toBe(`${ASIDE}.100`)
  })
})
