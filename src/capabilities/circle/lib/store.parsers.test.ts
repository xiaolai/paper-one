import { describe, expect, it } from 'vitest'
import { circlePathIn, hlcOf, type IndexFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { readForeign } from './store'

/**
 * The held file's parsers, one row per clause — the shape of what the
 * recipient reads back of a friend. Every register and every row carries the
 * stamp it was taken under (`device`, `seq`) and the relationship epoch it
 * belongs to, and a file with a malformed one is a file that will not read:
 * a row read with a wrong stamp would take part in the tie rule as though it
 * had one.
 */

const BOOK = 'book:moby'
const PERSON = 'a1'.repeat(32)
const AT = hlcOf(5)

const raw = (over: Record<string, unknown> = {}) => ({ entries: [], withdrawn: [], heads: {}, cursor: {}, v: 3, ...over })
const fileWith = (over: Record<string, unknown>) => fakeFs({ [circlePathIn(BOOK, PERSON)]: JSON.stringify(raw(over)) }) as unknown as IndexFs
const read = (over: Record<string, unknown>) => readForeign(fileWith(over), BOOK, PERSON)

const work = (over: Record<string, unknown> = {}) => ({ pub: 's1', at: AT, work: { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' }, ...over })
const register = (over: Record<string, unknown> = {}) => ({ value: 'reading', at: AT, device: 'd1', seq: 1, ...over })
const entry = (over: Record<string, unknown> = {}, passage: Record<string, unknown> = {}) => ({
  pub: 'p1',
  person: PERSON,
  passage: { quote: 'Call me Ishmael', prefix: '', suffix: '', chapter: 'One', ...passage },
  epoch: 1,
  receivedAt: 1000,
  ...over,
})

describe('a held shelf row', () => {
  it('keeps a stamped row with its epoch and cover, and an unstamped one', async () => {
    const held = await read({ works: [work({ device: 'd1', seq: 2, epoch: 3, work: { title: 'T', author: 'A', language: 'en', cover: 'ab'.repeat(32) } }), work({ pub: 's2' })] })
    expect(held.works[0]).toMatchObject({ device: 'd1', seq: 2, epoch: 3, work: { cover: 'ab'.repeat(32) } })
    expect(held.works[1]).not.toHaveProperty('device')
    expect(held.works[1]).not.toHaveProperty('epoch')
  })

  it.each([
    ['an epoch of zero', work({ epoch: 0 })],
    ['a fractional epoch', work({ epoch: 1.5 })],
    ['a device with no seq', work({ device: 'd1' })],
    ['a seq with no device', work({ seq: 1 })],
    ['an empty device', work({ device: '', seq: 1 })],
    ['a seq of zero', work({ device: 'd1', seq: 0 })],
    ['a cover with a character past the digest', work({ work: { title: 'T', author: 'A', language: 'en', cover: `${'ab'.repeat(32)}x` } })],
    ['a cover with a character before the digest', work({ work: { title: 'T', author: 'A', language: 'en', cover: `x${'ab'.repeat(32)}` } })],
    ['a numeric cover', work({ work: { title: 'T', author: 'A', language: 'en', cover: 1 } })],
  ])('refuses %s as a shelf that will not read', async (_what, row) => {
    await expect(read({ works: [row] })).rejects.toThrow(/has a shelf that will not read/u)
  })
})

describe('a held register', () => {
  it('keeps the epoch each register was taken under, and none for one taken before epochs', async () => {
    const held = await read({ opinion: { status: register({ epoch: 2 }), stars: register({ value: 4, epoch: 3 }), tags: register({ value: ['sea'], epoch: 4 }) } })
    expect(held.opinion.status).toMatchObject({ value: 'reading', device: 'd1', seq: 1, epoch: 2 })
    expect(held.opinion.stars).toMatchObject({ value: 4, epoch: 3 })
    expect(held.opinion.tags).toMatchObject({ value: ['sea'], epoch: 4 })
    const older = await read({ opinion: { status: register(), stars: register({ value: 4 }), tags: register({ value: ['sea'] }) } })
    expect(older.opinion.status).not.toHaveProperty('epoch')
    expect(older.opinion.stars).not.toHaveProperty('epoch')
    expect(older.opinion.tags).not.toHaveProperty('epoch')
  })

  it.each([
    ['status', 'an empty device', { status: register({ device: '' }) }],
    ['status', 'a seq of zero', { status: register({ seq: 0 }) }],
    ['status', 'a fractional seq', { status: register({ seq: 1.5 }) }],
    ['status', 'an epoch of zero', { status: register({ epoch: 0 }) }],
    ['status', 'no stamp at all', { status: { value: 'reading', at: AT } }],
    ['stars', 'an empty device', { stars: register({ value: 4, device: '' }) }],
    ['stars', 'an epoch of zero', { stars: register({ value: 4, epoch: 0 }) }],
    ['tags', 'an empty device', { tags: register({ value: ['sea'], device: '' }) }],
    ['tags', 'an epoch of zero', { tags: register({ value: ['sea'], epoch: 0 }) }],
  ])('refuses a %s register with %s as an opinion that will not read', async (_which, _what, opinion) => {
    await expect(read({ opinion })).rejects.toThrow(/has an opinion that will not read/u)
  })
})

describe('a held passage', () => {
  it('keeps a stamped entry with its own stamp and note, and drops one whose stamp or note is malformed', async () => {
    const kept = await read({ entries: [entry({ at: AT, device: 'd1', seq: 1 }, { note: 'a note' })] })
    expect(kept.entries[0]).toMatchObject({ at: AT, device: 'd1', seq: 1, passage: { note: 'a note' } })
    for (const [what, bad] of [
      ['a stamp that is not an HLC', entry({ at: 'yesterday' })],
      ['a numeric note', entry({}, { note: 7 })],
      ['a device with no seq', entry({ device: 'd1' })],
      ['an empty device', entry({ device: '', seq: 1 })],
      ['a seq of zero', entry({ device: 'd1', seq: 0 })],
    ] as const) {
      expect((await read({ entries: [bad] })).entries, what).toEqual([])
    }
  })
})

describe('a held list item', () => {
  it('needs the stamp a shelf row may omit — an item is an entry of the list’s log', async () => {
    const item = { pub: 'i1', at: AT, device: 'd1', seq: 1, position: 1, note: '', work: { title: 'T', author: 'A', language: 'en' } }
    const held = await read({ list: { created: true, deleted: false, items: [item], removed: [] } })
    expect(held.list.items).toHaveLength(1)
    for (const [what, bad] of [
      ['no device and no seq', { ...item, device: undefined, seq: undefined }],
      ['a fractional seq', { ...item, seq: 1.5 }],
    ] as const) {
      await expect(read({ list: { created: true, deleted: false, items: [bad], removed: [] } }), what).rejects.toThrow(/has a list that will not read/u)
    }
  })
})

describe('a held list’s epoch', () => {
  const item = { pub: 'i1', at: AT, device: 'd1', seq: 1, position: 1, note: '', work: { title: 'T', author: 'A', language: 'en' } }
  it('is kept on the creation, on the title and on each item — each its own — and absent on a list kept before it was', async () => {
    const title = { value: 'L', at: AT, device: 'd1', seq: 1, epoch: 3 }
    const held = await read({ list: { created: true, createdEpoch: 3, title, deleted: false, items: [{ ...item, epoch: 2 }], removed: [] } })
    expect(held.list.createdEpoch).toBe(3)
    expect(held.list.title).toMatchObject({ value: 'L', epoch: 3 })
    expect(held.list.items[0]).toMatchObject({ pub: 'i1', epoch: 2 })
    const older = await read({ list: { created: true, title: { value: 'L', at: AT, device: 'd1', seq: 1 }, deleted: false, items: [item], removed: [] } })
    expect(older.list).not.toHaveProperty('createdEpoch')
    expect(older.list.title).not.toHaveProperty('epoch')
    expect(older.list.items[0]).not.toHaveProperty('epoch')
  })

  it.each([
    ['an epoch of zero on the creation', { created: true, createdEpoch: 0, deleted: false, items: [], removed: [] }],
    ['a fractional epoch on the creation', { created: true, createdEpoch: 1.5, deleted: false, items: [], removed: [] }],
    ['an epoch of zero on the title', { created: true, title: { value: 'L', at: AT, device: 'd1', seq: 1, epoch: 0 }, deleted: false, items: [], removed: [] }],
    ['an epoch of zero on an item', { created: true, deleted: false, items: [{ ...item, epoch: 0 }], removed: [] }],
  ])('refuses %s as a list that will not read', async (_what, list) => {
    await expect(read({ list })).rejects.toThrow(/has a list that will not read/u)
  })
})
