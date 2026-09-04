import { MAX_WORK_FIELD } from './lists'
import { getPublicKey, hashes, sign } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { OWN_SHELF_PATH, SHELF_WORK, canonicalJson, makeHlc, type Hlc, type VaultFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { pageCrypto } from './crypto'
import { MAX_PAGE_CHARS } from './protocol'
import { DEFAULT_BOUNDS, type Publisher } from './publish'
import { delegationBytes, takePages, type Ledger, type SignedDelegation } from './receive'
import {
  liveShelfRows,
  nextShelfSeq,
  NOTHING_SHELVED,
  readOwnShelf,
  shelfLogOf,
  shelfPagesFor,
  shelvedNow,
  syncShelf,
  updateOwnShelf,
  workOf,
  type ShelfFile,
  type ShelvedBook,
} from './shelf'
import { NOTHING_SHARED } from './store'

hashes.sha512 = sha512

/**
 * WI-23.C1 — the shelf log, published.
 *
 * ⚠️ **THE ITEM'S FALSIFIER**: serialise a shelf page and grep it for
 * `epubcfi` and for any path under `books/`. Any hit is a leak. Then remove a
 * book and re-serve: the page count must grow by one and the last entry must
 * be `unshelf`.
 */

const NOW = 1_700_000_000_000
const DEVICE = 'd'.repeat(64)
let tick = 0
const at = (): Hlc => makeHlc(NOW + ++tick, 0, DEVICE.slice(0, 16))
let minted = 0
const mint = () => `shelf${++minted}`

const moby: ShelvedBook = { bookId: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:1', languages: ['en-GB'] }
const dune: ShelvedBook = { bookId: 'book:dune', title: 'Dune', author: 'Frank Herbert', languages: ['en'] }

describe('the work a book publishes as', () => {
  it('is the claim’s inputs in clear, with the primary language subtag', () => {
    expect(workOf(moby)).toEqual({ title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:1', language: 'en' })
    expect(workOf({ bookId: 'b' })).toEqual({ title: '', author: '', language: '' })
    expect(workOf({ ...dune, cover: 'ab'.repeat(32) }).cover).toBe('ab'.repeat(32))
  })
})

describe('bringing the published shelf up to the library', () => {
  it('shelves what is new, and the log reproduces the shelf exactly', () => {
    const held = syncShelf(NOTHING_SHELVED, [moby, dune], DEVICE, at(), mint)
    expect([...shelvedNow(held).keys()].sort()).toEqual(['book:dune', 'book:moby'])
    expect(shelfLogOf(held).map((one) => one.op)).toEqual(['shelf', 'shelf'])
    expect(shelfLogOf(held).map((one) => one.seq)).toEqual([1, 2])
    /* Nothing changed: the same store, not a rewritten one. */
    expect(syncShelf(held, [moby, dune], DEVICE, at(), mint)).toBe(held)
  })

  it('publishes `unshelf` for a removed book — the acceptance', () => {
    const two = syncShelf(NOTHING_SHELVED, [moby, dune], DEVICE, at(), mint)
    const one = syncShelf(two, [moby], DEVICE, at(), mint)
    const log = shelfLogOf(one)
    expect(log).toHaveLength(3)
    expect(log.at(-1)).toMatchObject({ op: 'unshelf', seq: 3 })
    expect([...shelvedNow(one).keys()]).toEqual(['book:moby'])
    /* The row stays, tombstoned: a page that carried it must reproduce. */
    expect(one.works).toHaveLength(2)
  })

  it('re-publishes a book whose metadata changed, under a new pub', () => {
    const first = syncShelf(NOTHING_SHELVED, [moby], DEVICE, at(), mint)
    const corrected = syncShelf(first, [{ ...moby, title: 'Moby-Dick; or, The Whale' }], DEVICE, at(), mint)
    expect(shelfLogOf(corrected).map((one) => one.op)).toEqual(['shelf', 'unshelf', 'shelf'])
    const live = shelvedNow(corrected).get('book:moby')!
    expect(live.work.title).toBe('Moby-Dick; or, The Whale')
    expect(live.pub).not.toBe(first.works[0]!.pub)
    /* And a cover arriving later is a change too. */
    const covered = syncShelf(corrected, [{ ...moby, title: 'Moby-Dick; or, The Whale', cover: 'ab'.repeat(32) }], DEVICE, at(), mint)
    expect(shelvedNow(covered).get('book:moby')!.work.cover).toBe('ab'.repeat(32))
  })

  it('never reissues a sequence number, removals included', () => {
    let held = syncShelf(NOTHING_SHELVED, [moby, dune], DEVICE, at(), mint)
    held = syncShelf(held, [], DEVICE, at(), mint)
    held = syncShelf(held, [moby], DEVICE, at(), mint)
    const seqs = shelfLogOf(held).map((one) => one.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(nextShelfSeq(held, DEVICE)).toBe(6)
    expect(nextShelfSeq(held, 'e'.repeat(64))).toBe(1)
  })
})

/* ── served, signed, and taken ─────────────────────────────────────────── */

function keypair(seed: string) {
  const secret = utf8ToBytes(seed.padEnd(32, '.')).slice(0, 32)
  return { secret, id: bytesToHex(getPublicKey(secret)) }
}
const PERSON = keypair('person')
const LAPTOP = keypair('laptop')

function delegationFor(device: string): string {
  const body = { person: PERSON.id, device, notBefore: NOW - 1_000, notAfter: NOW + 1_000_000, roster: 0 }
  const sig = bytesToHex(sign(utf8ToBytes(delegationBytes({ ...body, sig: '' } as SignedDelegation)), PERSON.secret))
  return canonicalJson({ ...body, sig })
}
const publisher: Publisher = {
  person: PERSON.id,
  device: LAPTOP.id,
  work: SHELF_WORK,
  roster: [LAPTOP.id],
  revocations: 0,
  delegation: delegationFor(LAPTOP.id),
  sign: (message) => Promise.resolve(bytesToHex(sign(utf8ToBytes(message), LAPTOP.secret))),
}
const ledger = (): Ledger => ({ held: NOTHING_SHARED, devices: [LAPTOP.id], revoked: [], epoch: 0, relationshipEpoch: 1, admitted: true })
const stamp = (n: number) => makeHlc(NOW + n, 0, LAPTOP.id.slice(0, 16))

describe('the shelf served as pages', () => {
  it('leaks no anchor and no path — the falsifier — and a recipient takes it under the reserved claim', async () => {
    let held = syncShelf(NOTHING_SHELVED, [moby, dune], LAPTOP.id, stamp(1), mint)
    const built = await shelfPagesFor(held, publisher, {}, pageCrypto.hash, DEFAULT_BOUNDS, 2)
    expect(built.pages).toHaveLength(1)
    for (const page of built.pages) {
      expect(page).not.toContain('epubcfi')
      expect(page).not.toContain('books/')
      /* And this copy's id — derived from the bytes — never travels. */
      expect(page).not.toContain('book:moby')
    }
    const taken = takePages(built.pages, SHELF_WORK, PERSON.id, ledger(), pageCrypto, NOW, 2)
    expect(taken.refusals).toEqual([])
    expect(taken.held.works.map((one) => one.work.title).sort()).toEqual(['Dune', 'Moby-Dick'])

    /* Remove a book and re-serve: one more page, ending in `unshelf`. */
    held = syncShelf(built.held, [moby], LAPTOP.id, stamp(2), mint)
    const again = await shelfPagesFor(held, publisher, {}, pageCrypto.hash, DEFAULT_BOUNDS, 2)
    expect(again.pages.length - built.pages.length).toBe(1)
    const last = JSON.parse(again.pages.at(-1)!) as { entries: { op: string }[] }
    expect(last.entries.at(-1)?.op).toBe('unshelf')
    const after = takePages(again.pages, SHELF_WORK, PERSON.id, ledger(), pageCrypto, NOW, 2)
    expect(after.held.works.map((one) => one.work.title)).toEqual(['Moby-Dick'])
  })

  it('serves nothing under v1, which has no shelf', async () => {
    const held = syncShelf(NOTHING_SHELVED, [moby], LAPTOP.id, stamp(1), mint)
    const built = await shelfPagesFor(held, publisher, {}, pageCrypto.hash, DEFAULT_BOUNDS, 1)
    expect(built.pages).toEqual([])
    expect(built.held.sealed).toEqual([])
  })
})

describe('the published shelf on disk', () => {
  const fs = () => fakeFs({}) as unknown as VaultFs
  const queue = { append: (_k: string, task: () => Promise<void>) => task(), push: (_k: string, task: () => Promise<void>) => task(), idle: () => Promise.resolve() }

  it('reads nothing where there is no file, and round-trips what it wrote', async () => {
    const store = fs()
    expect(await readOwnShelf(store)).toEqual(NOTHING_SHELVED)
    const held = syncShelf(NOTHING_SHELVED, [moby], DEVICE, at(), mint)
    await store.writeFile(OWN_SHELF_PATH, new TextEncoder().encode(JSON.stringify(held)))
    expect(await readOwnShelf(store)).toEqual(held)
  })

  describe('every clause of the file shape', () => {
    const row = () => ({ pub: 's1', bookId: 'book:moby', work: workOf(moby), device: DEVICE, seq: 1, at: at() })
    const boundary = () => ({ device: DEVICE, from: 1, to: 1, v: 2 })
    const fileWith = (over: Record<string, unknown>) =>
      fakeFs({ [OWN_SHELF_PATH]: JSON.stringify({ works: [], sealed: [], ...over }) }) as unknown as VaultFs
    const bad: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
      ['a file that is a list', { works: undefined, sealed: undefined }, /work list|not a shelf/u],
      ['works that are a string', { works: 'works' }, /work list/u],
      ['a work that is null', { works: [null] }, /work list/u],
      ['a work with an empty pub', { works: [{ ...row(), pub: '' }] }, /work list/u],
      ['a work with no bookId', { works: [{ ...row(), bookId: undefined }] }, /work list/u],
      ['a work with no device', { works: [{ ...row(), device: undefined }] }, /work list/u],
      ['a work with no stamp', { works: [{ ...row(), at: undefined }] }, /work list/u],
      ['a work with a fractional seq', { works: [{ ...row(), seq: 1.5 }] }, /work list/u],
      ['a work whose work is a string', { works: [{ ...row(), work: 'Moby-Dick' }] }, /work list/u],
      ['a work with no title', { works: [{ ...row(), work: { author: 'A', language: 'en' } }] }, /work list/u],
      ['a work with no author', { works: [{ ...row(), work: { title: 'T', language: 'en' } }] }, /work list/u],
      ['a work with no language', { works: [{ ...row(), work: { title: 'T', author: 'A' } }] }, /work list/u],
      ['a work with a numeric identifier', { works: [{ ...row(), work: { ...workOf(moby), identifier: 1 } }] }, /work list/u],
      ['a work with a numeric cover', { works: [{ ...row(), work: { ...workOf(moby), cover: 1 } }] }, /work list/u],
      ['a work with a cover that is not a digest', { works: [{ ...row(), work: { ...workOf(moby), cover: 'not a digest' } }] }, /work list/u],
      ['a work with an upper-case cover digest', { works: [{ ...row(), work: { ...workOf(moby), cover: 'AB'.repeat(32) } }] }, /work list/u],
      ['a work with a character past the cover digest', { works: [{ ...row(), work: { ...workOf(moby), cover: `${'ab'.repeat(32)}x` } }] }, /work list/u],
      ['a work with a character before the cover digest', { works: [{ ...row(), work: { ...workOf(moby), cover: `x${'ab'.repeat(32)}` } }] }, /work list/u],
      ['a work whose pub is a number', { works: [{ ...row(), pub: 1 }] }, /work list/u],
      ['a work whose work is null', { works: [{ ...row(), work: null }] }, /work list/u],
      ['a work whose work is a list', { works: [{ ...row(), work: [] }] }, /work list/u],
      ['a removal that is null', { works: [{ ...row(), unshelved: null }] }, /work list/u],
      ['a removal that is a string', { works: [{ ...row(), unshelved: 'gone' }] }, /work list/u],
      ['a removal with a fractional seq', { works: [{ ...row(), unshelved: { seq: 1.5, at: at() } }] }, /work list/u],
      ['a removal with no stamp', { works: [{ ...row(), unshelved: { seq: 2 } }] }, /work list/u],
      ['a row with a zero seq', { works: [{ ...row(), seq: 0 }] }, /work list/u],
      ['a row whose stamp is not an HLC', { works: [{ ...row(), at: 'yesterday' }] }, /work list/u],
      ['a removal whose stamp is not an HLC', { works: [{ ...row(), unshelved: { seq: 2, at: 'yesterday' } }] }, /work list/u],
      ['a removal not after the row it removes', { works: [{ ...row(), seq: 3, unshelved: { seq: 3, at: at() } }] }, /work list/u],
      ['two rows on one sequence', { works: [{ ...row(), seq: 4 }, { ...row(), pub: 'other', seq: 4 }] }, /reuses a sequence/u],
      ['a removal on the sequence of another row', { works: [{ ...row(), seq: 4 }, { ...row(), pub: 'other', seq: 2, unshelved: { seq: 4, at: at() } }] }, /reuses a sequence/u],
      ['a removal in another device’s stream on a sequence that device holds', { works: [{ ...row(), device: 'e'.repeat(64), seq: 1 }, { ...row(), pub: 'other', seq: 2, unshelved: { seq: 1, at: at(), device: 'e'.repeat(64) } }] }, /reuses a sequence/u],
      ['a removal with a field the build does not know', { works: [{ ...row(), unshelved: { seq: 2, at: at(), extra: 1 } }] }, /work list/u],
      ['a removal by another device with an empty name', { works: [{ ...row(), unshelved: { seq: 1, at: at(), device: '' } }] }, /work list/u],
      ['a removal by the row’s own device, named, not after the row', { works: [{ ...row(), seq: 3, unshelved: { seq: 3, at: at(), device: DEVICE } }] }, /work list/u],
      ['a list where only SOME are works', { works: [row(), 'no'] }, /work list/u],
      ['boundaries that are a string', { sealed: 'sealed' }, /page boundaries/u],
      ['a boundary with no chain version', { sealed: [{ ...boundary(), v: undefined }] }, /page boundaries/u],
      ['a boundary with a fractional from', { sealed: [{ ...boundary(), from: 1.5 }] }, /page boundaries/u],
      ['a boundary with a to that is a string', { sealed: [{ ...boundary(), to: '1' }] }, /page boundaries/u],
      ['a boundary with no device', { sealed: [{ ...boundary(), device: undefined }] }, /page boundaries/u],
      ['a boundary that is null', { sealed: [null] }, /page boundaries/u],
      ['a boundary that is a string', { sealed: ['sealed'] }, /page boundaries/u],
    ]
    for (const [what, over, why] of bad) {
      it(`throws on ${what}`, async () => {
        await expect(readOwnShelf(fileWith(over))).rejects.toThrow(why)
      })
    }

    for (const [what, text] of [
      ['a list', '[]'],
      ['a string', '"shelf"'],
      ['null', 'null'],
    ] as const) {
      it(`says a file that is ${what} is not a shelf file, before looking for works`, async () => {
        const store = fakeFs({ [OWN_SHELF_PATH]: text }) as unknown as VaultFs
        await expect(readOwnShelf(store)).rejects.toThrow(/is not a shelf file/u)
      })
    }

    it('reads every good shape, so none of the above is vacuous', async () => {
      const works = [
        row(),
        /* Each row on its own sequence, and a removal after the row it removes. */
        { ...row(), pub: 's2', seq: 2, unshelved: { seq: 3, at: at() } },
        { ...row(), pub: 's3', seq: 4, work: { ...workOf(moby), cover: 'ab'.repeat(32) } },
        /* No identifier at all — most books have none. */
        { ...row(), pub: 's4', seq: 5, bookId: 'book:dune', work: workOf(dune) },
      ]
      const held = await readOwnShelf(fileWith({ works, sealed: [boundary()] }))
      expect(held.works).toHaveLength(4)
      expect(held.sealed).toEqual([boundary()])
    })

    it('changes the shelf on the circle’s own lane', async () => {
      const store = fs()
      const lanes: string[] = []
      const spy = { ...queue, append: (lane: string, task: () => Promise<void>) => { lanes.push(lane); return task() } }
      await updateOwnShelf(store, spy as never, () => syncShelf(NOTHING_SHELVED, [moby], DEVICE, at(), mint))
      expect(lanes).toEqual(['circle'])
      expect((await readOwnShelf(store)).works).toHaveLength(1)
    })
  })
})

/* The narrowed shape the exchange hands the shelf store. */
void (null as unknown as ShelfFile)

describe('a cover on a shelf entry — WI-23.C5’s falsifier', () => {
  it('rides the page as a digest, under the frame by the same margin as an entry without one', async () => {
    const bare = syncShelf(NOTHING_SHELVED, [moby], LAPTOP.id, stamp(1), mint)
    const withCover = syncShelf(NOTHING_SHELVED, [{ ...moby, cover: 'ab'.repeat(32) }], LAPTOP.id, stamp(1), mint)
    const [plain, covered] = await Promise.all([
      shelfPagesFor(bare, publisher, {}, pageCrypto.hash, DEFAULT_BOUNDS, 2),
      shelfPagesFor(withCover, publisher, {}, pageCrypto.hash, DEFAULT_BOUNDS, 2),
    ])
    const a = plain.pages[0]!.length
    const b = covered.pages[0]!.length
    /* A digest is 64 hex characters and a key; bytes would be tens of thousands. */
    expect(b - a).toBeLessThan(80)
    expect(b - a).toBeGreaterThan(64)
    expect(MAX_PAGE_CHARS - b).toBeGreaterThan(MAX_PAGE_CHARS - a - 80)
    expect((JSON.parse(covered.pages[0]!) as { entries: { work: { cover?: string } }[] }).entries[0]!.work.cover).toBe('ab'.repeat(32))
  })
})

describe('every clause of the shelf’s own rules — one row each', () => {
  it('publishes no identifier and no cover key for a book with none', () => {
    const work = workOf({ bookId: 'b' })
    expect('identifier' in work).toBe(false)
    expect('cover' in work).toBe(false)
  })

  it('re-publishes on a change of author, identifier or language alone, each under a new pub', () => {
    const held = syncShelf(NOTHING_SHELVED, [moby], DEVICE, at(), mint)
    const after = (change: Partial<ShelvedBook>) => syncShelf(held, [{ ...moby, ...change }], DEVICE, at(), mint)
    expect(shelfLogOf(after({ author: 'H. Melville' })).map((one) => one.op)).toEqual(['shelf', 'unshelf', 'shelf'])
    expect(shelfLogOf(after({ identifier: 'isbn:2' })).map((one) => one.op)).toEqual(['shelf', 'unshelf', 'shelf'])
    expect(shelfLogOf(after({ languages: ['de'] })).map((one) => one.op)).toEqual(['shelf', 'unshelf', 'shelf'])
    /* The same words again: nothing. */
    expect(after({})).toBe(held)
  })

  it('serves the log in stamp order, whatever order the rows were written', () => {
    const later = syncShelf(NOTHING_SHELVED, [moby], DEVICE, makeHlc(NOW + 500, 0, DEVICE.slice(0, 16)), mint)
    const both = syncShelf(later, [moby, dune], DEVICE, makeHlc(NOW + 100, 0, DEVICE.slice(0, 16)), mint)
    const log = shelfLogOf(both)
    expect(log.map((one) => one.seq)).toEqual([2, 1])
    expect(log[0]!.at < log[1]!.at).toBe(true)
  })
})

describe('changing the published shelf as one step', () => {
  it('reads inside the lane, writes only what changed, and hands back what it wrote', async () => {
    const store = fakeFs({}) as unknown as VaultFs
    const lanes: string[] = []
    const spy = { append: async (lane: string, task: () => Promise<void>) => { lanes.push(lane); await task() } } as never
    const first = await updateOwnShelf(store, spy, (held) => syncShelf(held, [moby], DEVICE, at(), mint))
    expect(first.works).toHaveLength(1)
    expect(lanes).toEqual(['circle'])
    expect(await readOwnShelf(store)).toEqual(first)
    const same = await updateOwnShelf(store, spy, (held) => held)
    expect(same).toEqual(first)
    /* The transform is given what is on disk — the second sees the first's work. */
    const second = await updateOwnShelf(store, spy, (held) => syncShelf(held, [moby, dune], DEVICE, at(), mint))
    expect(second.works).toHaveLength(2)
  })
})

describe('the shelf file, held to the letter', () => {
  it('refuses boundaries out of chain order by name', async () => {
    const fs = fakeFs({ [OWN_SHELF_PATH]: JSON.stringify({ works: [], sealed: [{ device: DEVICE, from: 3, to: 4, v: 2 }, { device: DEVICE, from: 1, to: 2, v: 2 }] }) }) as unknown as VaultFs
    await expect(readOwnShelf(fs)).rejects.toThrow(/the published shelf has page boundaries out of order/u)
  })

  it('writes nothing when the change is the same object', async () => {
    const fs = fakeFs({ [OWN_SHELF_PATH]: JSON.stringify(NOTHING_SHELVED) }) as unknown as VaultFs & { writes(path: string): number }
    const before = fs.writes(OWN_SHELF_PATH)
    await updateOwnShelf(fs, { append: (_lane: string, job: () => Promise<void>) => job() } as never, (current) => current)
    expect(fs.writes(OWN_SHELF_PATH)).toBe(before)
  })
})

describe('the shelf’s next sequence', () => {
  it('starts past a sealed boundary that outlived its rows', () => {
    expect(nextShelfSeq({ works: [], sealed: [{ device: DEVICE, from: 1, to: 4, v: 2 }] }, DEVICE)).toBe(5)
  })
})

describe('the shelf file’s rows, held to the letter', () => {
  const okay = () => ({ pub: 's1', bookId: 'book:moby', work: { title: 'T', author: 'A', language: 'en' }, device: DEVICE, seq: 1, at: at() })
  const fileWith = (works: unknown[]) => fakeFs({ [OWN_SHELF_PATH]: JSON.stringify({ works, sealed: [] }) }) as unknown as VaultFs
  it('refuses a row or a work carrying a field the schema does not name, and holds each field to its bound', async () => {
    await expect(readOwnShelf(fileWith([{ ...okay(), extra: 1 }]))).rejects.toThrow(/work list/u)
    await expect(readOwnShelf(fileWith([{ ...okay(), work: { title: 'T', author: 'A', language: 'en', extra: 1 } }]))).rejects.toThrow(/work list/u)
    await expect(readOwnShelf(fileWith([{ ...okay(), work: { title: 'x'.repeat(MAX_WORK_FIELD + 1), author: 'A', language: 'en' } }]))).rejects.toThrow(/work list/u)
    expect((await readOwnShelf(fileWith([{ ...okay(), work: { title: 'x'.repeat(MAX_WORK_FIELD), author: 'A', language: 'en' } }]))).works).toHaveLength(1)
  })
  it('counts only this device’s boundaries towards its next sequence, and refuses to run out', () => {
    expect(nextShelfSeq({ works: [], sealed: [{ device: 'e'.repeat(64), from: 1, to: 9, v: 2 }] }, DEVICE)).toBe(1)
    expect(() => nextShelfSeq({ works: [{ ...okay(), seq: Number.MAX_SAFE_INTEGER }] as never, sealed: [] }, DEVICE)).toThrow(/run out of sequence numbers/u)
  })
})

describe('a book shelved from two devices', () => {
  const OTHER = 'e'.repeat(64)

  it('is taken back on BOTH rows, each removal stamped in the syncing device’s stream', () => {
    /* Two stores that met: each device shelved Moby-Dick before they synced.
       A removal that tombstoned only the row it looked at left the other on
       the wire, still disclosing the book. */
    const held: ShelfFile = {
      works: [
        { pub: 'a', bookId: 'book:moby', work: workOf(moby), device: DEVICE, seq: 1, at: at() },
        { pub: 'b', bookId: 'book:moby', work: workOf(moby), device: OTHER, seq: 1, at: at() },
      ],
      sealed: [],
    }
    const removed = syncShelf(held, [], DEVICE, at(), mint)
    expect(shelvedNow(removed).size).toBe(0)
    expect(liveShelfRows(removed)).toEqual([])
    const gone = shelfLogOf(removed).filter((one) => one.op === 'unshelf')
    expect(gone.map((one) => [one.device, one.seq])).toEqual([
      [DEVICE, 2],
      [DEVICE, 3],
    ])
    /* The other device's own count is untouched: the removals are not in its stream. */
    expect(nextShelfSeq(removed, OTHER)).toBe(2)
  })

  it('keeps ONE row while the book stays — the earliest in log order — and takes the duplicate back', () => {
    const first = at()
    const held: ShelfFile = {
      works: [
        { pub: 'later', bookId: 'book:moby', work: workOf(moby), device: OTHER, seq: 1, at: at() },
        { pub: 'earlier', bookId: 'book:moby', work: workOf(moby), device: DEVICE, seq: 1, at: first },
      ],
      sealed: [],
    }
    const synced = syncShelf(held, [moby], DEVICE, at(), mint)
    expect(liveShelfRows(synced).map((row) => row.pub)).toEqual(['earlier'])
    expect(shelvedNow(synced).get('book:moby')?.pub).toBe('earlier')
    expect(shelfLogOf(synced).find((one) => one.op === 'unshelf')).toMatchObject({ pub: 'later', device: DEVICE, seq: 2 })
    /* Settled: nothing more to say. */
    expect(syncShelf(synced, [moby], DEVICE, at(), mint)).toBe(synced)
  })

  it('reads a removal made by another device from the first sequence of that device’s stream', async () => {
    const works = [{ pub: 's1', bookId: 'book:moby', work: workOf(moby), device: DEVICE, seq: 5, at: at(), unshelved: { seq: 1, at: at(), device: OTHER } }]
    const store = fakeFs({ [OWN_SHELF_PATH]: JSON.stringify({ works, sealed: [] }) }) as unknown as VaultFs
    const held = await readOwnShelf(store)
    expect(shelfLogOf(held).find((one) => one.op === 'unshelf')).toMatchObject({ device: OTHER, seq: 1 })
    expect(nextShelfSeq(held, OTHER)).toBe(2)
    expect(nextShelfSeq(held, DEVICE)).toBe(6)
  })
})

describe('a work’s fields, held to their bound', () => {
  it('cuts a title past MAX_WORK_FIELD, never inside a surrogate pair, so the row written is one the store reads back', async () => {
    /* A row written past the bound was a shelf that would not read back, for ever. */
    const long = `${'a'.repeat(MAX_WORK_FIELD - 1)}😀`
    const work = workOf({ bookId: 'b', title: long, author: 'x'.repeat(MAX_WORK_FIELD + 5) })
    expect(work.title).toBe('a'.repeat(MAX_WORK_FIELD - 1))
    expect(work.author).toHaveLength(MAX_WORK_FIELD)
    const held = syncShelf(NOTHING_SHELVED, [{ bookId: 'book:long', title: long, author: 'A', languages: ['en'] }], DEVICE, at(), mint)
    const store = fakeFs({}) as unknown as VaultFs
    await store.writeFile(OWN_SHELF_PATH, new TextEncoder().encode(JSON.stringify(held)))
    expect((await readOwnShelf(store)).works[0]?.work.title).toBe('a'.repeat(MAX_WORK_FIELD - 1))
  })
})
