import { describe, expect, it, vi } from 'vitest'
import { circlePathIn, hlcOf, mergeRelationship, newRelationship, personFolderIn, relationshipPathIn, showShelf, type IndexFs, type Relationship, type WriteQueue } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { purgePerson, readRelationship, writeRelationship } from './relationships'

/**
 * WI-23.C2's store and WI-23.C3's purge.
 *
 * ⚠️ **THE PURGE FALSIFIER**: block a person with `retain: 'purge'` — here,
 * remove them — and `fs.exists` on their shelf file must be `false`. Then the
 * table: one row per clause of the file's parser.
 */

const PERSON = 'a1'.repeat(32)
const queue = (): WriteQueue => ({
  append: (_key, task) => task(),
  push: (_key, task) => task(),
  idle: () => Promise.resolve(),
})
const fsWith = (files: Record<string, string> = {}) => fakeFs(files) as unknown as IndexFs

describe('the relationship record on disk', () => {
  it('reads the default for a person nothing has been decided about', async () => {
    /* Stamped at the beginning of time — undecided — not at the clock. */
    expect(await readRelationship(fsWith(), PERSON)).toEqual(newRelationship(PERSON, hlcOf(0)))
  })

  it('round-trips a record, and merges a stale writer by changedAt', async () => {
    const fs = fsWith()
    const on = showShelf(newRelationship(PERSON, hlcOf(1)), true, hlcOf(20))
    expect(await writeRelationship(fs, queue(), on)).toEqual(on)
    expect(await readRelationship(fs, PERSON)).toEqual(on)

    /* A writer holding an OLDER copy cannot put the switch back off. */
    const stale = showShelf(newRelationship(PERSON, hlcOf(1)), false, hlcOf(10))
    expect(await writeRelationship(fs, queue(), stale)).toEqual(on)
    expect((await readRelationship(fs, PERSON)).shelf).toBe(true)
    /* And a newer one moves it. */
    const off = showShelf(on, false, hlcOf(30))
    expect(await writeRelationship(fs, queue(), off)).toEqual(off)
    expect((await readRelationship(fs, PERSON)).shelf).toBe(false)
  })

  it('writes on the person’s own lane', async () => {
    const lanes: string[] = []
    const q: WriteQueue = { ...queue(), append: (key, task) => { lanes.push(key); return task() } }
    await writeRelationship(fsWith(), q, newRelationship(PERSON, hlcOf(1)))
    expect(lanes).toEqual([personFolderIn(PERSON)])
  })

  describe('every clause of the record shape', () => {
    const record = (): Record<string, unknown> => ({ ...newRelationship(PERSON, hlcOf(1)) })
    const bad: readonly (readonly [string, unknown])[] = [
      ['a file that is a string', 'admitted'],
      ['a file that is null', null],
      ['a file that is a list', []],
      ['a record about somebody else', { ...record(), person: 'b2'.repeat(32) }],
      ['a state this build does not know', { ...record(), state: 'friends' }],
      ['a state that is a number', { ...record(), state: 1 }],
      ['an epoch of zero', { ...record(), epoch: 0 }],
      ['a fractional epoch', { ...record(), epoch: 1.5 }],
      ['an admittedAt that is not a stamp', { ...record(), admittedAt: 'yesterday' }],
      ['a changedAt that is not a stamp', { ...record(), changedAt: 'yesterday' }],
      ['a retain this build does not know', { ...record(), retain: 'archive' }],
      ['a shelf that is a string', { ...record(), shelf: 'yes' }],
    ]
    for (const [what, value] of bad) {
      it(`throws on ${what}`, async () => {
        const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify(value) })
        await expect(readRelationship(fs, PERSON)).rejects.toThrow(/will not read/u)
      })
    }

    it('reads every state and both retains, so none of the above is vacuous', async () => {
      for (const state of ['admitted', 'muted', 'blocked', 'exited'] as const) {
        for (const retain of ['keep', 'purge'] as const) {
          const value: Relationship = { ...newRelationship(PERSON, hlcOf(1)), state, retain, epoch: 3, shelf: true }
          const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify(value) })
          expect(await readRelationship(fs, PERSON)).toEqual(value)
        }
      }
    })
  })
})

describe('purging a person — WI-23.C3', () => {
  const LANE = (bookId: string) => `books/${bookId.replace(/[^a-zA-Z0-9]/gu, '_')}`

  it('removes their per-book files and their folder, shelf included — the falsifier', async () => {
    const fs = fsWith({
      [circlePathIn('book:a', PERSON)]: '{}',
      [circlePathIn('book:b', PERSON)]: '{}',
      [`${personFolderIn(PERSON)}/shelf.json`]: '{}',
      [relationshipPathIn(PERSON)]: '{}',
      /* Somebody else's, which must be untouched. */
      [circlePathIn('book:a', 'b2'.repeat(32))]: '{}',
    })
    const changed = vi.fn()
    await purgePerson(fs, queue(), LANE, PERSON, ['book:a', 'book:b', 'book:c'], changed)
    expect(await fs.exists(`${personFolderIn(PERSON)}/shelf.json`)).toBe(false)
    expect(await fs.exists(relationshipPathIn(PERSON))).toBe(false)
    expect(await fs.exists(personFolderIn(PERSON))).toBe(false)
    expect(await fs.exists(circlePathIn('book:a', PERSON))).toBe(false)
    expect(await fs.exists(circlePathIn('book:b', PERSON))).toBe(false)
    expect(await fs.exists(circlePathIn('book:a', 'b2'.repeat(32)))).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a person who sent nothing purges without error', async () => {
    await expect(purgePerson(fsWith(), queue(), LANE, PERSON, ['book:a'], () => {})).resolves.toBeUndefined()
  })

  it('takes the folder on the person’s lane and each file on its book’s', async () => {
    const lanes: string[] = []
    const q: WriteQueue = { ...queue(), append: (key, task) => { lanes.push(key); return task() } }
    await purgePerson(fsWith(), q, LANE, PERSON, ['book:a'], () => {})
    expect(lanes).toEqual([LANE('book:a'), personFolderIn(PERSON)])
  })
})

describe('every clause of the record on disk — one row each', () => {
  const stamp = hlcOf(5)
  const record = (over: Record<string, unknown> = {}) => ({ person: PERSON, state: 'admitted', epoch: 1, admittedAt: stamp, changedAt: stamp, retain: 'keep', shelf: true, ...over })

  it('refuses to write over a record that will not read, rather than guessing at it', async () => {
    const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify(record({ state: 'admitted-ish' })) })
    const written = showShelf(newRelationship(PERSON, hlcOf(1)), true, hlcOf(2))
    await expect(writeRelationship(fs, queue(), written)).rejects.toThrow(/will not read/u)
    /* The file is left as it was, for the reader to see. */
    await expect(readRelationship(fs, PERSON)).rejects.toThrow(/will not read/u)
  })

  for (const [what, changedAt] of [
    ['a stamp with a prefix', `x${hlcOf(5)}`],
    ['a stamp with a suffix', `${hlcOf(5)}x`],
    ['a stamp that is a number', 5],
  ] as const) {
    it(`refuses a record whose changedAt is ${what}`, async () => {
      const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify(record({ changedAt })) })
      await expect(readRelationship(fs, PERSON)).rejects.toThrow(/relationship/u)
    })
  }
})

describe('a person with no record on this disk', () => {
  it('reads as undecided — stamped at the beginning of time, so any decision elsewhere wins the merge', async () => {
    const fs = fakeFs({}) as unknown as IndexFs
    const read = await readRelationship(fs, PERSON)
    expect(read).toMatchObject({ state: 'admitted', epoch: 1, shelf: false, changedAt: hlcOf(0), shelfAt: hlcOf(0) })
    /* The phone turned the shelf on; the laptop had merely never read the file. */
    const decided = showShelf(newRelationship(PERSON, hlcOf(5)), true, hlcOf(6))
    expect(mergeRelationship(read, decided).shelf).toBe(true)
    expect(mergeRelationship(decided, read).shelf).toBe(true)
  })

  it('reads a record written before the shelf switch existed as shelf off', async () => {
    const { shelf: _shelf, shelfAt: _shelfAt, ...older } = newRelationship(PERSON, hlcOf(1))
    const fs = fakeFs({ [relationshipPathIn(PERSON)]: JSON.stringify(older) }) as unknown as IndexFs
    const read = await readRelationship(fs, PERSON)
    expect(read.shelf).toBe(false)
    expect(read.state).toBe('admitted')
  })
})

describe('purging a person whose files will not all go', () => {
  it('attempts every step and raises what failed together, leaving nothing it could remove', async () => {
    const fs = fakeFs({
      [circlePathIn('book:a', PERSON)]: '{}',
      [circlePathIn('book:b', PERSON)]: '{}',
      [relationshipPathIn(PERSON)]: JSON.stringify(newRelationship(PERSON, hlcOf(1))),
    })
    const stubborn = {
      ...fs,
      remove: (path: string) => (path === circlePathIn('book:a', PERSON) ? Promise.reject(new Error('locked')) : fs.remove(path)),
    } as unknown as IndexFs
    const queue: WriteQueue = { append: (_lane, job) => job() } as WriteQueue
    await expect(purgePerson(stubborn, queue, (id) => id, PERSON, ['book:a', 'book:b'], () => {})).rejects.toThrow(/could not purge everything/u)
    expect(await fs.exists(circlePathIn('book:b', PERSON))).toBe(false)
    expect(await fs.exists(personFolderIn(PERSON))).toBe(false)
    expect(await fs.exists(circlePathIn('book:a', PERSON))).toBe(true)
  })
})

describe('the switch’s stamp on disk, held to the letter', () => {
  it('is kept when given, refused when malformed, and left to the kernel when the switch is there without it', async () => {
    const base = newRelationship(PERSON, hlcOf(1))
    const read = async (record: Record<string, unknown>) => readRelationship(fakeFs({ [relationshipPathIn(PERSON)]: JSON.stringify(record) }) as unknown as IndexFs, PERSON)
    expect((await read({ ...base, shelfAt: hlcOf(7) })).shelfAt).toBe(hlcOf(7))
    await expect(read({ ...base, shelfAt: 'yesterday' })).rejects.toThrow(/will not read/u)
    const { shelfAt: _gone, ...withoutStamp } = base
    expect('shelfAt' in (await read(withoutStamp))).toBe(false)
  })
})

describe('a purge that cannot finish', () => {
  it('attempts every step, and names how many failed out of how many', async () => {
    const fs = fsWith({
      [circlePathIn('book:a', PERSON)]: '{}',
      [circlePathIn('book:b', PERSON)]: '{}',
      [`${personFolderIn(PERSON)}/shelf.json`]: '{}',
    })
    const refusing = {
      ...fs,
      remove: (path: string) => (path === circlePathIn('book:a', PERSON) ? Promise.reject(new Error('locked')) : fs.remove(path)),
    } as unknown as IndexFs
    const changed = vi.fn()
    const lane = (bookId: string) => `books/${bookId.replace(/[^a-zA-Z0-9]/gu, '_')}`
    await expect(purgePerson(refusing, queue(), lane, PERSON, ['book:a', 'book:b'], changed)).rejects.toThrow(/1 of 3 steps failed/u)
    /* The steps after the failing one still ran. */
    expect(await fs.exists(circlePathIn('book:b', PERSON))).toBe(false)
    expect(await fs.exists(personFolderIn(PERSON))).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('counts the folder step among the failures when it is the one that fails', async () => {
    const fs = fsWith({ [circlePathIn('book:a', PERSON)]: '{}', [`${personFolderIn(PERSON)}/shelf.json`]: '{}' })
    const refusing = { ...fs, removeDir: () => Promise.reject(new Error('busy')) } as unknown as IndexFs
    const lane = (bookId: string) => `books/${bookId.replace(/[^a-zA-Z0-9]/gu, '_')}`
    await expect(purgePerson(refusing, queue(), lane, PERSON, ['book:a'], vi.fn())).rejects.toThrow(/1 of 2 steps failed/u)
    expect(await fs.exists(circlePathIn('book:a', PERSON))).toBe(false)
  })
})

describe('the shelf stamp of a record written before the switch existed', () => {
  const base = { person: PERSON, state: 'admitted', epoch: 1, admittedAt: hlcOf(3), changedAt: hlcOf(4), retain: 'keep' }
  it('is undecided when the record has no switch at all, so any decision elsewhere wins', async () => {
    const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify(base) })
    expect((await readRelationship(fs, PERSON)).shelfAt).toBe(hlcOf(0))
  })

  it('is the record’s own stamp when the record has the switch but not its stamp', async () => {
    const fs = fsWith({ [relationshipPathIn(PERSON)]: JSON.stringify({ ...base, shelf: true }) })
    const read = await readRelationship(fs, PERSON)
    expect(read.shelf).toBe(true)
    expect(read.shelfAt).toBeUndefined()
  })
})
