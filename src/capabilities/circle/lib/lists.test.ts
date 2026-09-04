import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { OWN_LISTS_DIR, WIRE_VERSION, canonicalJson, listWork, makeHlc, ownListPathIn, type Hlc, type VaultFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { pageCrypto } from './crypto'
import { DEFAULT_BOUNDS, type Publisher } from './publish'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import {
  createList,
  deleteList,
  listLogOf,
  listPagesFor,
  nextListSeq,
  NOTHING_LISTED,
  ownListIds,
  placeOnList,
  readOwnList,
  removeFromList,
  retitleList,
  stateOf,
  updateOwnList,
  type ListFile,
  MAX_LIST_NOTE,
  MAX_LIST_TITLE,
  MAX_WORK_FIELD,
} from './lists'
import { NOTHING_SHARED } from './store'

/**
 * WI-23.E1's publisher store: the rows are the log, verbatim; the pages a
 * friend takes fold to what the reader sees; the file refuses to read as
 * "nothing" when it is malformed.
 */

hashes.sha512 = sha512

const NOW = 1_700_000_000_000
const DEVICE = 'd'.repeat(64)
/* Written as the store writes it — `updateOwnList` is the one production writer. */
const writeList = (fs: VaultFs, id: string, held: ListFile) => fs.writeFile(ownListPathIn(id), new TextEncoder().encode(JSON.stringify(held)))
let tick = 0
const at = (): Hlc => makeHlc(NOW + ++tick, 0, DEVICE.slice(0, 16))
const by = () => ({ device: DEVICE, at: at() })
const WORK = { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' }

describe('the rows a list keeps', () => {
  it('appends each act as a row stamped with the next sequence of the device', () => {
    let held = createList(NOTHING_LISTED, 'Sea books', by())
    held = placeOnList(held, { pub: 'i1', work: WORK, position: 1, note: 'start here' }, by())
    held = retitleList(held, 'Whales', by())
    held = placeOnList(held, { pub: 'i1', work: WORK, position: 2, note: 'moved' }, by())
    held = removeFromList(held, 'i1', by())
    held = deleteList(held, by())
    expect(held.rows.map((row) => [row.op, row.seq])).toEqual([
      ['create', 1],
      ['place', 2],
      ['retitle', 3],
      ['place', 4],
      ['remove', 5],
      ['delete', 6],
    ])
    expect(nextListSeq(held, DEVICE)).toBe(7)
    expect(nextListSeq(held, 'e'.repeat(64))).toBe(1)
    expect(nextListSeq(NOTHING_LISTED, DEVICE)).toBe(1)
    /* Never rewritten: the first placement is still there, and the fold says what is current. */
    expect(held.rows[1]).toMatchObject({ pub: 'i1', position: 1, note: 'start here' })
    expect(stateOf(held)).toMatchObject({ created: true, title: 'Whales', deleted: true, items: [] })
  })

  it('serves the log in stamp order, whatever order the rows were written', () => {
    const later = { device: DEVICE, at: makeHlc(NOW + 100, 0, DEVICE.slice(0, 16)) }
    const earlier = { device: 'e'.repeat(64), at: makeHlc(NOW + 50, 0, 'e'.repeat(16)) }
    const held = retitleList(createList(NOTHING_LISTED, 'L', later), 'M', earlier)
    expect(listLogOf(held).map((row) => row.at)).toEqual([earlier.at, later.at])
    expect(stateOf(held).title).toBe('L')
  })
})

describe('the pages a list serves', () => {
  const secret = new Uint8Array(32).fill(7)
  const person = bytesToHex(getPublicKey(secret))
  const device = bytesToHex(getPublicKey(new Uint8Array(32).fill(9)))
  const deviceSecret = new Uint8Array(32).fill(9)
  const delegation = () => {
    const body = { person, device, notBefore: NOW - 1_000, notAfter: NOW + 1_000_000, roster: 0 }
    const sig = bytesToHex(sign(utf8ToBytes(delegationBytes({ ...body, sig: '' } as SignedDelegation)), secret))
    return canonicalJson({ ...body, sig })
  }
  const publisher = (listId: string): Publisher => ({
    person,
    device,
    work: listWork(listId),
    roster: [device],
    revocations: 0,
    delegation: delegation(),
    sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), deviceSecret))),
  })
  const ledger = (): Ledger => ({ held: NOTHING_SHARED, devices: [device], revoked: [], epoch: 0, relationshipEpoch: 1, admitted: true })
  const stamp = () => ({ device, at: at() })

  it('cuts pages under the list’s own claim that a recipient folds to the same list', async () => {
    let held = createList(NOTHING_LISTED, 'Sea books', stamp())
    held = placeOnList(held, { pub: 'i1', work: WORK, position: 1, note: 'start here' }, stamp())
    held = placeOnList(held, { pub: 'i2', work: { ...WORK, title: 'Dune' }, position: 2, note: '' }, stamp())
    held = removeFromList(held, 'i2', stamp())
    const built = await listPagesFor(held, publisher('aa11'), {}, pageCrypto.hash, DEFAULT_BOUNDS, WIRE_VERSION)
    expect(built.pages).toHaveLength(1)
    expect(built.more).toBe(false)
    expect(built.held.sealed).toMatchObject([{ device, from: 1, to: 4, v: WIRE_VERSION }])
    const taken = takePages(built.pages, listWork('aa11'), person, ledger(), pageCrypto, NOW, WIRE_VERSION)
    expect(taken.refusals).toEqual([])
    expect(taken.held.list).toMatchObject({ created: true, title: { value: 'Sea books' }, items: [{ pub: 'i1', position: 1 }], removed: ['i2'] })
    /* The same page against another list's claim is refused. */
    expect(takePages(built.pages, listWork('bb22'), person, ledger(), pageCrypto, NOW, WIRE_VERSION).refusals).toEqual(['wrong-work'])
  })

  it('answers nothing from a cursor at the end, and serves a v2 caller nothing — the list is a v3 log', async () => {
    const held = createList(NOTHING_LISTED, 'L', stamp())
    const first = await listPagesFor(held, publisher('aa11'), {}, pageCrypto.hash, DEFAULT_BOUNDS, WIRE_VERSION)
    const again = await listPagesFor(first.held, publisher('aa11'), { [device]: 1 }, pageCrypto.hash, DEFAULT_BOUNDS, WIRE_VERSION)
    expect(again.pages).toEqual([])
    const v2 = await listPagesFor(held, publisher('aa11'), {}, pageCrypto.hash, DEFAULT_BOUNDS, 2)
    expect(v2.pages).toEqual([])
  })
})

describe('the list file', () => {
  const fsOf = () => fakeFs() as unknown as VaultFs & { exists(path: string): Promise<boolean> }

  it('reads an absent file as no list, writes one under its id, lists the ids, and reads it back', async () => {
    const fs = fsOf()
    expect(await readOwnList(fs, 'aa11')).toEqual(NOTHING_LISTED)
    expect(await ownListIds(fs as never)).toEqual([])
    const held = placeOnList(createList(NOTHING_LISTED, 'Sea', by()), { pub: 'i1', work: WORK, position: 1, note: 'n' }, by())
    await writeList(fs, 'bb22', held)
    await writeList(fs, 'aa11', createList(NOTHING_LISTED, 'Other', by()))
    expect(await fs.exists(ownListPathIn('bb22'))).toBe(true)
    expect(ownListPathIn('bb22').startsWith(`${OWN_LISTS_DIR}/`)).toBe(true)
    expect(await ownListIds(fs as never)).toEqual(['aa11', 'bb22'])
    expect(await readOwnList(fs, 'bb22')).toEqual(held)
  })

  const row = () => ({ op: 'place', pub: 'i1', work: WORK, position: 1, note: '', device: DEVICE, seq: 1, at: at() })
  const bad: readonly (readonly [string, string])[] = [
    ['a file that is a string', '"rows"'],
    ['a file that is an array', '[]'],
    ['no rows', JSON.stringify({ sealed: [] })],
    ['rows that are not a list', JSON.stringify({ rows: 'x', sealed: [] })],
    ['a row that is null', JSON.stringify({ rows: [null], sealed: [] })],
    ['a row with no op', JSON.stringify({ rows: [{ ...row(), op: undefined }], sealed: [] })],
    ['a row of another log’s kind', JSON.stringify({ rows: [{ ...row(), op: 'shelf' }], sealed: [] })],
    ['a row with no device', JSON.stringify({ rows: [{ ...row(), device: undefined }], sealed: [] })],
    ['a row whose sequence is not one', JSON.stringify({ rows: [{ ...row(), seq: 1.5 }], sealed: [] })],
    ['a row whose stamp is not one', JSON.stringify({ rows: [{ ...row(), at: 'yesterday' }], sealed: [] })],
    ['a placement with an empty pub', JSON.stringify({ rows: [{ ...row(), pub: '' }], sealed: [] })],
    ['a placement with no work', JSON.stringify({ rows: [{ ...row(), work: undefined }], sealed: [] })],
    ['a placement whose work has no language', JSON.stringify({ rows: [{ ...row(), work: { title: 'T', author: 'A' } }], sealed: [] })],
    ['a placement whose work has a numeric identifier', JSON.stringify({ rows: [{ ...row(), work: { ...WORK, identifier: 1 } }], sealed: [] })],
    ['a placement whose work has a numeric cover', JSON.stringify({ rows: [{ ...row(), work: { ...WORK, cover: 1 } }], sealed: [] })],
    ['a placement with a fractional position', JSON.stringify({ rows: [{ ...row(), position: 1.5 }], sealed: [] })],
    ['a placement with no note', JSON.stringify({ rows: [{ ...row(), note: undefined }], sealed: [] })],
    ['a create with no title', JSON.stringify({ rows: [{ ...row(), op: 'create', title: undefined }], sealed: [] })],
    ['a retitle with a numeric title', JSON.stringify({ rows: [{ ...row(), op: 'retitle', title: 1 }], sealed: [] })],
    ['a removal with an empty pub', JSON.stringify({ rows: [{ ...row(), op: 'remove', pub: '' }], sealed: [] })],
    ['no boundaries', JSON.stringify({ rows: [] })],
    ['a boundary that is null', JSON.stringify({ rows: [], sealed: [null] })],
    ['a boundary with no version', JSON.stringify({ rows: [], sealed: [{ device: DEVICE, from: 1, to: 2 }] })],
  ]
  for (const [what, text] of bad) {
    it(`throws on ${what}`, async () => {
      const fs = fsOf()
      await fs.writeFile(ownListPathIn('aa11'), new TextEncoder().encode(text))
      await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/list aa11/u)
    })
  }

  it('reads every row kind, and a delete with nothing else', async () => {
    const fs = fsOf()
    const rows = [
      { op: 'create', title: 'L', device: DEVICE, seq: 1, at: at() },
      { op: 'retitle', title: 'M', device: DEVICE, seq: 2, at: at() },
      { ...row(), seq: 3, work: { ...WORK, identifier: 'isbn:1', cover: 'ab'.repeat(32) } },
      { op: 'remove', pub: 'i1', device: DEVICE, seq: 4, at: at() },
      { op: 'delete', device: DEVICE, seq: 5, at: at() },
    ]
    await fs.writeFile(ownListPathIn('aa11'), new TextEncoder().encode(JSON.stringify({ rows, sealed: [{ device: DEVICE, from: 1, to: 5, v: 3 }] })))
    const held: ListFile = await readOwnList(fs, 'aa11')
    expect(held.rows.map((one) => one.op)).toEqual(['create', 'retitle', 'place', 'remove', 'delete'])
    expect(held.sealed).toEqual([{ device: DEVICE, from: 1, to: 5, v: 3 }])
  })
})

describe('every clause of the list file — one row each', () => {
  const fsOf = () => fakeFs() as unknown as VaultFs & { exists(path: string): Promise<boolean>; mkdir?(path: string): Promise<void> }
  const write = async (fs: VaultFs, text: string) => fs.writeFile(ownListPathIn('aa11'), new TextEncoder().encode(text))

  for (const [what, text] of [
    ['a string', '"rows"'],
    ['an array', '[]'],
    ['null', 'null'],
  ] as const) {
    it(`says a file that is ${what} is not a list file, before looking for rows`, async () => {
      const fs = fsOf()
      await write(fs, text)
      await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/is not a list file/u)
    })
  }

  it('refuses a file where only SOME rows read', async () => {
    const fs = fsOf()
    const good = { op: 'create', title: 'L', device: DEVICE, seq: 1, at: at() }
    await write(fs, JSON.stringify({ rows: [good, { op: 'create', device: DEVICE, seq: 2, at: at() }], sealed: [] }))
    await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/rows that will not read/u)
  })

  const boundary = { device: DEVICE, from: 1, to: 2, v: 3 }
  for (const [what, sealed] of [
    ['a boundary with no device', [{ ...boundary, device: undefined }]],
    ['a boundary whose device is a number', [{ ...boundary, device: 1 }]],
    ['a boundary whose start is not an integer', [{ ...boundary, from: 1.5 }]],
    ['a boundary whose end is not an integer', [{ ...boundary, to: 'two' }]],
    ['a boundary whose version is not an integer', [{ ...boundary, v: 2.5 }]],
    ['boundaries where only some read', [boundary, {}]],
  ] as const) {
    it(`refuses ${what}`, async () => {
      const fs = fsOf()
      await write(fs, JSON.stringify({ rows: [], sealed }))
      await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/no page boundaries/u)
    })
  }

  const place = { op: 'place', pub: 'i1', work: WORK, position: 1, note: '', device: DEVICE, seq: 1, at: at() }
  for (const [what, row] of [
    ['a placement whose work is null', { ...place, work: null }],
    ['a placement whose work is an array', { ...place, work: [] }],
    ['a placement whose work has no title', { ...place, work: { author: 'A', language: 'en' } }],
    ['a placement whose work has a numeric title', { ...place, work: { ...WORK, title: 1 } }],
    ['a placement whose work has no author', { ...place, work: { title: 'T', language: 'en' } }],
    ['a placement whose pub is a number', { ...place, pub: 1 }],
    ['a removal whose pub is a number', { op: 'remove', pub: 1, device: DEVICE, seq: 1, at: at() }],
    ['a row whose device is a number', { ...place, device: 1 }],
    ['a row whose device is empty', { ...place, device: '' }],
    ['a row with a zero seq', { ...place, seq: 0 }],
    ['a placement carrying a field its kind does not name', { ...place, extra: 1 }],
    ['a placement whose work carries a field the schema does not name', { ...place, work: { ...WORK, extra: 1 } }],
    ['a title past the bound', { op: 'create', title: 'x'.repeat(MAX_LIST_TITLE + 1), device: DEVICE, seq: 1, at: at() }],
    ['a note past the bound', { ...place, note: 'x'.repeat(MAX_LIST_NOTE + 1) }],
    ['a work title past the bound', { ...place, work: { ...WORK, title: 'x'.repeat(MAX_WORK_FIELD + 1) } }],
    ['a placement whose work has a cover that is not a digest', { ...place, work: { ...WORK, cover: 'not a digest' } }],
    ['a placement whose work has a character past the cover digest', { ...place, work: { ...WORK, cover: `${'ab'.repeat(32)}x` } }],
    ['a placement whose work has a character before the cover digest', { ...place, work: { ...WORK, cover: `x${'ab'.repeat(32)}` } }],
  ] as const) {
    it(`refuses ${what}`, async () => {
      const fs = fsOf()
      await write(fs, JSON.stringify({ rows: [row], sealed: [] }))
      await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/rows that will not read/u)
    })
  }

  it('lists only the json files, not a folder or a note left beside them', async () => {
    const fs = fsOf()
    await writeList(fs, 'aa11', NOTHING_LISTED)
    await fs.writeFile(`${OWN_LISTS_DIR}/notes.txt`, new TextEncoder().encode('x'))
    await fs.writeFile(`${OWN_LISTS_DIR}/folder/inside.json`, new TextEncoder().encode('{}'))
    expect(await ownListIds(fs as never)).toEqual(['aa11'])
  })

  it('lists only names that are list ids, so a stray file cannot break every answer', async () => {
    const fs = fsOf()
    await writeList(fs, 'aa11', NOTHING_LISTED)
    await fs.writeFile(`${OWN_LISTS_DIR}/Notes.json`, new TextEncoder().encode('{}'))
    await fs.writeFile(`${OWN_LISTS_DIR}/ff.json`, new TextEncoder().encode('{}'))
    await fs.writeFile(`${OWN_LISTS_DIR}/zz.json`, new TextEncoder().encode('{}'))
    /* `Notes` and `zz` are not hex; `ff` is a list id however short. */
    expect(await ownListIds(fs as never)).toEqual(['aa11', 'ff'])
  })
})

describe('changing a list as one step', () => {
  it('reads inside the lane, writes only what changed, and hands back what it wrote', async () => {
    const fs = fakeFs() as unknown as VaultFs
    const lanes: string[] = []
    const queue = { append: async (lane: string, job: () => Promise<void>) => { lanes.push(lane); await job() } } as never
    const first = await updateOwnList(fs, queue, 'aa11', (held) => createList(held, 'Sea', by()))
    expect(first.rows).toHaveLength(1)
    expect(lanes).toEqual(['circle'])
    expect(await readOwnList(fs, 'aa11')).toEqual(first)
    expect(await updateOwnList(fs, queue, 'aa11', (held) => held)).toEqual(first)
    const second = await updateOwnList(fs, queue, 'aa11', (held) => retitleList(held, 'Whales', by()))
    expect(second.rows.map((row) => row.op)).toEqual(['create', 'retitle'])
  })
})

describe('a list file that reuses a sequence', () => {
  it('will not read: one position, one row', async () => {
    const fs = fakeFs() as unknown as VaultFs
    const row = { op: 'create', title: 'L', device: DEVICE, seq: 1, at: at() }
    await fs.writeFile(ownListPathIn('aa11'), new TextEncoder().encode(JSON.stringify({ rows: [row, { ...row, op: 'retitle', title: 'M' }], sealed: [] })))
    await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/reuses a sequence/u)
  })

  it('refuses to mint a sequence past the safe integers', () => {
    const held: ListFile = { rows: [{ op: 'create', title: 'L', device: DEVICE, seq: Number.MAX_SAFE_INTEGER, at: at() }], sealed: [] }
    expect(() => nextListSeq(held, DEVICE)).toThrow(/run out of sequence numbers/u)
  })
})

describe('the list file, held to the letter', () => {
  it('refuses boundaries out of chain order by name', async () => {
    const fs = fakeFs() as unknown as VaultFs
    await writeList(fs, 'aa11', { rows: [], sealed: [{ device: DEVICE, from: 3, to: 4, v: 3 }, { device: DEVICE, from: 1, to: 2, v: 3 }] })
    await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/list aa11 has page boundaries out of order/u)
  })

  it('lists no file without the extension, however list-like its name', async () => {
    const fs = fakeFs() as unknown as VaultFs & { writeFile(path: string, bytes: Uint8Array): Promise<void> }
    await writeList(fs, 'aa11', NOTHING_LISTED)
    await fs.writeFile(`${OWN_LISTS_DIR}/ff`, new TextEncoder().encode('{}'))
    expect(await ownListIds(fs as never)).toEqual(['aa11'])
  })

  it('reads a title exactly at the bound, and a removal must name a pub', async () => {
    const fs = fakeFs() as unknown as VaultFs
    await writeList(fs, 'aa11', { rows: [{ op: 'create', title: 'x'.repeat(MAX_LIST_TITLE), device: DEVICE, seq: 1, at: at() }], sealed: [] })
    expect((await readOwnList(fs, 'aa11')).rows).toHaveLength(1)
    await writeList(fs, 'bb22', { rows: [{ op: 'remove', pub: '', device: DEVICE, seq: 1, at: at() }] as never, sealed: [] })
    await expect(readOwnList(fs, 'bb22')).rejects.toThrow(/rows that will not read/u)
  })

  it('writes nothing when the change is the same object', async () => {
    const fs = fakeFs() as unknown as VaultFs & { writes(path: string): number }
    const held = createList(NOTHING_LISTED, 'L', by())
    await writeList(fs, 'aa11', held)
    const before = fs.writes(ownListPathIn('aa11'))
    await updateOwnList(fs, { append: (_lane: string, job: () => Promise<void>) => job() } as never, 'aa11', (current) => current)
    expect(fs.writes(ownListPathIn('aa11'))).toBe(before)
  })
})

describe('the next sequence, and whose boundaries a list may hold', () => {
  it('starts past a sealed boundary that outlived its rows', () => {
    const held: ListFile = { rows: [], sealed: [{ device: DEVICE, from: 1, to: 7, v: 3 }] }
    expect(nextListSeq(held, DEVICE)).toBe(8)
    expect(nextListSeq(held, 'e'.repeat(64))).toBe(1)
  })

  it('refuses a boundary that names another list’s claim', async () => {
    const fs = fakeFs() as unknown as VaultFs
    await writeList(fs, 'aa11', { rows: [], sealed: [{ device: DEVICE, from: 1, to: 1, v: 3, work: listWork('bb22') }] })
    await expect(readOwnList(fs, 'aa11')).rejects.toThrow(/page boundary of another list/u)
    await writeList(fs, 'cc33', { rows: [], sealed: [{ device: DEVICE, from: 1, to: 1, v: 3, work: listWork('cc33') }] })
    expect((await readOwnList(fs, 'cc33')).sealed).toHaveLength(1)
  })
})
