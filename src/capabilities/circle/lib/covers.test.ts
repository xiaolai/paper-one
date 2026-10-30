import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { MAX_COVER_BYTES, NOTHING_SPENT, charge, personFolderIn, type Spend, type VaultFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { base64Of } from './base64'
import { COVER_CAP_SETTING, COVER_INDEX_PATH, coverPathOf, createCoverFetcher, imageTypeOf } from './covers'
import { CIRCLE_SERVICES, COVER_CHUNK_BYTES } from './protocol'

/**
 * The recipient's half of WI-23.C5: a jacket fetched by digest, paid for,
 * verified whole, kept under its person, and never fetched twice at once.
 */

/**
 * ⚠️ **THE FAKE SERVER CHUNKS SMALL, AND THAT IS THE POINT OF THIS CONSTANT.**
 *
 * This test used the real chunk size (512 KiB), so every case built a jacket of
 * half a megabyte and BLAKE3-hashed it twice per fetch and base64'd it a chunk
 * at a time — in JavaScript. Under v8 coverage instrumentation that outran the
 * default fifteen seconds, and the answer at the time was to widen the bound to
 * sixty. It then outran sixty as well, intermittently, and `pnpm test:coverage`
 * was red on `main` for it.
 *
 * The size was never the property under test. What is under test is a jacket
 * that spans MORE THAN ONE CHUNK — the fetcher follows `offset`/`more` and does
 * not read the protocol constant at all, so the number here is the fake
 * server's to choose. 256 bytes proves the same thing ~2000x faster.
 *
 * The real 512 KiB chunking IS still covered, on the side that actually
 * performs it: `exchange.test.ts` holds `answerCover` to it.
 *
 * ⚠️ **TWO CONSTRAINTS, BOTH LEARNED BY BREAKING THEM.** It must exceed every
 * other fixture in this file — `small` is 1000 bytes, and at 256 it spanned
 * four chunks, which hung the fence test: its gated fake registers one
 * `release` per call and overwrites it, so only a single-chunk fixture can be
 * released once. And `+ 100` below must stay smaller than this, or the jacket
 * spans three chunks and the two-call assertion is wrong for a reason that has
 * nothing to do with the code.
 */
const CHUNK = 2048

const ALICE = 'a1'.repeat(32)
const LAPTOP = 'b1'.repeat(32)
const JACKET = new Uint8Array(CHUNK + 100).map((_, i) => (i * 7) % 256)
const DIGEST = bytesToHex(blake3(JACKET))

/** A device that serves one jacket the way `answerCover` does, chunk by chunk. */
function serving(bytes: Uint8Array = JACKET, over: { size?: number; refuse?: boolean } = {}) {
  const calls: { pub: string; offset: number }[] = []
  let closed = 0
  const session = {
    call: (service: string, body: unknown) => {
      const asked = body as { pub: string; offset: number }
      calls.push(asked)
      if (service !== CIRCLE_SERVICES.cover.name || over.refuse) return Promise.reject(new Error('that request is not one this build answers'))
      const size = over.size ?? bytes.length
      const slice = bytes.subarray(asked.offset, Math.min(bytes.length, asked.offset + CHUNK))
      return Promise.resolve({ offset: asked.offset, size, bytes: base64Of(slice), more: asked.offset + slice.length < size })
    },
    close: () => {
      closed += 1
      return Promise.resolve()
    },
  }
  return { session, calls, closed: () => closed }
}

/* `silent` builds the fetcher with no `warn` at all, as the option allows — a
   reason with nobody to hear it must not become a failure of its own. */
function world(serve = serving(), over: { cap?: number; budget?: Spend; silent?: boolean } = {}) {
  const fs = fakeFs() as unknown as VaultFs
  const dial = vi.fn(() => Promise.resolve(serve.session))
  const ledger = new Map<string, Spend>()
  if (over.budget) ledger.set(ALICE, over.budget)
  let now = 1_000
  const warned: { readonly event: string; readonly fields: Record<string, unknown> }[] = []
  const fetcher = createCoverFetcher({
    fs,
    ...(over.silent === true ? {} : { warn: (event: string, fields: Record<string, unknown>) => void warned.push({ event, fields }) }),
    dial,
    /* The ledger as `index.ts` keeps it: read, decided and committed in one step. */
    charge: (person, bytes) => {
      const charged = charge(ledger.get(person) ?? NOTHING_SPENT, 'cover', bytes, ++now)
      if (charged.allowed) ledger.set(person, charged.spend)
      return charged.allowed
    },
    now: () => ++now,
    capBytes: () => over.cap ?? 64 * 1024 * 1024,
  })
  return { fs: fs as unknown as ReturnType<typeof fakeFs>, dial, fetcher, ledger, serve, warned }
}

describe('fetching a friend’s jacket', () => {
  it('asks chunk by chunk from the device that published the entry, verifies the whole, keeps it under the person, and pays', async () => {
    const w = world()
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toEqual(JACKET)
    expect(w.dial).toHaveBeenCalledWith(LAPTOP)
    expect(w.serve.calls).toEqual([
      { pub: 'pub1', offset: 0 },
      { pub: 'pub1', offset: CHUNK },
    ])
    expect(w.serve.closed()).toBe(1)
    expect(w.fs.store.get(coverPathOf(ALICE, DIGEST))).toEqual(JACKET)
    expect(coverPathOf(ALICE, DIGEST).startsWith(`${personFolderIn(ALICE)}/`)).toBe(true)
    expect(w.ledger.get(ALICE)?.total).toBe(JACKET.length)
    expect(w.ledger.get(ALICE)?.byWork['cover']).toBe(JACKET.length)
    /* Kept: the second ask is answered from disk, with no dial. */
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toEqual(JACKET)
    expect(w.dial).toHaveBeenCalledTimes(1)
    const index = JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number }>
    expect(index[`${ALICE}/${DIGEST}`]?.size).toBe(JACKET.length)
  })

  it('keeps nothing that does not hash to the digest on the shelf entry', async () => {
    const w = world(serving(new Uint8Array(JACKET.length).fill(1)))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, DIGEST))).toBe(false)
    expect(w.serve.closed()).toBe(1)
  })

  it.each([
    ['a device that does not answer', () => world({ ...serving(), session: { call: () => Promise.reject(new Error('gone')), close: () => Promise.resolve() } })],
    ['a refusal', () => world(serving(JACKET, { refuse: true }))],
    ['a size that lies about the bytes', () => world(serving(JACKET, { size: JACKET.length + 10 }))],
    ['a jacket past what the circle fetches', () => world(serving(new Uint8Array(MAX_COVER_BYTES + 1)))],
    ['a budget already spent', () => world(serving(), { budget: { since: 1, total: 64 * 1024 * 1024, byWork: {} } })],
  ])('answers null, and keeps nothing, on %s', async (_what, make) => {
    const w = make()
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, DIGEST))).toBe(false)
  })

  it('does not dial again for a digest already on its way', async () => {
    const w = world()
    const [a, b] = await Promise.all([w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST), w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)])
    expect(a).toEqual(JACKET)
    expect(b).toEqual(JACKET)
    expect(w.dial).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently used jackets past the cap, never the one that just landed', async () => {
    const small = new Uint8Array(1000).fill(3)
    const smallDigest = bytesToHex(blake3(small))
    const w = world(serving(small), { cap: 1500 })
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    /* A second jacket, from another device serving other bytes, takes the cache past the cap. */
    const other = new Uint8Array(1000).fill(4)
    const otherDigest = bytesToHex(blake3(other))
    w.dial.mockImplementation(() => Promise.resolve(serving(other).session))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub2', otherDigest)).toEqual(other)
    expect(w.fs.store.has(coverPathOf(ALICE, otherDigest))).toBe(true)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
  })

  /* THE ANSWER STAYS NULL; THE REASON TRAVELS — under its own name, and with
     whose jacket it was and what the wire said. */
  it('says why a jacket could not be fetched, naming the person and the digest', async () => {
    const w = world()
    w.dial.mockImplementation(() => Promise.reject(new Error('the laptop is not answering')))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toBeNull()
    expect(w.warned).toEqual([
      { event: 'circle.cover-fetch-failed', fields: { person: ALICE, digest: DIGEST, message: 'the laptop is not answering' } },
    ])
  })
})

describe('the fetcher, held to the letter', () => {
  it('names its index, its setting and the setting’s bounds', () => {
    expect(COVER_INDEX_PATH).toBe('circle/covers.json')
    expect(COVER_CAP_SETTING.key).toBe('circle.coverCapMB')
    expect(COVER_CAP_SETTING.fallback).toBe(64)
    for (const [raw, kept] of [
      [64, 64],
      [1, 1],
      [1024, 1024],
      [0, undefined],
      [-1, undefined],
      [1.5, undefined],
      [1025, undefined],
      ['64', undefined],
      [null, undefined],
    ] as const) {
      expect(COVER_CAP_SETTING.parse(raw), String(raw)).toBe(kept)
    }
    expect(MAX_COVER_BYTES).toBe(1_048_576)
  })

  it('reads its index back tolerantly — a malformed entry is dropped — and evicts the least recently drawn first', async () => {
    const small = new Uint8Array(1000).fill(3)
    const smallDigest = bytesToHex(blake3(small))
    const w = world(serving(small), { cap: 2500 })
    /* An index with one bad entry and one good stranger already in it. */
    w.fs.store.set(
      COVER_INDEX_PATH,
      new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${'ff'.repeat(32)}`]: { size: 1000, usedAt: 5 }, [`${ALICE}/bad`]: { size: -1, usedAt: 1 }, [`${ALICE}/worse`]: 'x' })),
    )
    w.fs.store.set(coverPathOf(ALICE, 'ff'.repeat(32)), new Uint8Array(1000))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    let index = JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>
    expect(Object.keys(index).sort()).toEqual([`${ALICE}/${'ff'.repeat(32)}`, `${ALICE}/${smallDigest}`].sort())
    expect(index[`${ALICE}/${'ff'.repeat(32)}`]).toEqual({ size: 1000, usedAt: 5 })
    /* A third jacket: the total goes past the cap, and the OLDEST by use goes — the stranger, used at 5, not the one just drawn. */
    const other = new Uint8Array(1000).fill(4)
    const otherDigest = bytesToHex(blake3(other))
    w.dial.mockImplementation(() => Promise.resolve(serving(other).session))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub2', otherDigest)).toEqual(other)
    index = JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>
    expect(Object.keys(index).sort()).toEqual([`${ALICE}/${smallDigest}`, `${ALICE}/${otherDigest}`].sort())
    expect(w.fs.store.has(coverPathOf(ALICE, 'ff'.repeat(32)))).toBe(false)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(true)
    /* A cache exactly at the cap evicts nothing. */
    const exact = world(serving(small), { cap: 1000 })
    expect(await exact.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(true)
  })

  it.each([
    ['an answer whose offset is not the one asked for', (bytes: Uint8Array) => ({ ...serving(bytes), session: { ...serving(bytes).session, call: (_s: string, body: unknown) => { const asked = body as { offset: number }; return Promise.resolve({ offset: asked.offset + 1, size: bytes.length, bytes: base64Of(bytes.subarray(0, 10)), more: false }) } } })],
    ['a size that changes between chunks', (bytes: Uint8Array) => { let n = 0; const base = serving(bytes); return { ...base, session: { ...base.session, call: (s: string, body: unknown) => base.session.call(s, body).then((answer) => ({ ...(answer as { offset: number; size: number; bytes: string; more: boolean }), size: bytes.length + n++ })) } } }],
    ['a chunk with nothing in it', (bytes: Uint8Array) => ({ ...serving(bytes), session: { ...serving(bytes).session, call: () => Promise.resolve({ offset: 0, size: bytes.length, bytes: '', more: false }) } })],
    ['a chunk that is not base64', (bytes: Uint8Array) => ({ ...serving(bytes), session: { ...serving(bytes).session, call: () => Promise.resolve({ offset: 0, size: bytes.length, bytes: '####', more: false }) } })],
    ['more bytes than the size promised', (bytes: Uint8Array) => ({ ...serving(bytes), session: { ...serving(bytes).session, call: (_s: string, body: unknown) => { const asked = body as { offset: number }; return Promise.resolve({ offset: asked.offset, size: 10, bytes: base64Of(bytes.subarray(asked.offset, asked.offset + 20)), more: false }) } } })],
    ['an end before the size promised', (bytes: Uint8Array) => ({ ...serving(bytes), session: { ...serving(bytes).session, call: () => Promise.resolve({ offset: 0, size: bytes.length, bytes: base64Of(bytes.subarray(0, 10)), more: false }) } })],
  ])('keeps nothing from %s', async (_what, make) => {
    const w = world(make(JACKET))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, DIGEST))).toBe(false)
  })

  it('dials again for a digest whose last fetch failed — nothing stays in flight past its end', async () => {
    const w = world(serving(new Uint8Array(JACKET.length).fill(1)))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toBeNull()
    w.dial.mockImplementation(() => Promise.resolve(serving().session))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toEqual(JACKET)
    expect(w.dial).toHaveBeenCalledTimes(2)
  })

  it('touches the index when a kept jacket is drawn again, so it is the last to go', async () => {
    const w = world()
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)
    const before = (JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { usedAt: number }>)[`${ALICE}/${DIGEST}`]!.usedAt
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)
    const after = (JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { usedAt: number }>)[`${ALICE}/${DIGEST}`]!.usedAt
    expect(after).toBeGreaterThan(before)
  })
})

describe('the index and the cap, to the letter', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))
  const seed = (w: ReturnType<typeof world>, text: string) => w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(text))
  const indexOf = (w: ReturnType<typeof world>) => JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>

  /* A malformed ENTRY only. A whole index that is `null`, a number or a list
     was read past here too, as empty, and that was the defect — it is refused
     now, in "an index that will not read" above. */
  it.each([
    ['an entry that is null', JSON.stringify({ [`${ALICE}/x`]: null })],
    ['an entry that is a word', JSON.stringify({ [`${ALICE}/x`]: 'x' })],
    ['an entry with a fractional size', JSON.stringify({ [`${ALICE}/x`]: { size: 1.5, usedAt: 1 } })],
    ['an entry with a negative size', JSON.stringify({ [`${ALICE}/x`]: { size: -1, usedAt: 1 } })],
    ['an entry whose use is not a number', JSON.stringify({ [`${ALICE}/x`]: { size: 1, usedAt: 'x' } })],
  ])('reads past an index that is %s, keeping only the well-formed', async (_what, text) => {
    const w = world(serving(small))
    seed(w, text)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(Object.keys(indexOf(w))).toEqual([`${ALICE}/${smallDigest}`])
  })

  it('keeps an entry of zero bytes — a size, not a lie', async () => {
    const w = world(serving(small))
    seed(w, JSON.stringify({ [`${ALICE}/${'ff'.repeat(32)}`]: { size: 0, usedAt: 1 } }))
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    expect(Object.keys(indexOf(w)).sort()).toEqual([`${ALICE}/${'ff'.repeat(32)}`, `${ALICE}/${smallDigest}`].sort())
  })

  it('evicts by last use and not by the order the index was written in', async () => {
    const w = world(serving(small), { cap: 2500 })
    /* Two strangers: the FIRST written is the more recently used, so the second is the one to go. */
    seed(w, JSON.stringify({ [`${ALICE}/${'aa'.repeat(32)}`]: { size: 1000, usedAt: 50 }, [`${ALICE}/${'bb'.repeat(32)}`]: { size: 1000, usedAt: 5 } }))
    w.fs.store.set(coverPathOf(ALICE, 'aa'.repeat(32)), new Uint8Array(1000))
    w.fs.store.set(coverPathOf(ALICE, 'bb'.repeat(32)), new Uint8Array(1000))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(Object.keys(indexOf(w)).sort()).toEqual([`${ALICE}/${'aa'.repeat(32)}`, `${ALICE}/${smallDigest}`].sort())
    expect(w.fs.store.has(coverPathOf(ALICE, 'bb'.repeat(32)))).toBe(false)
    expect(w.fs.store.has(coverPathOf(ALICE, 'aa'.repeat(32)))).toBe(true)
  })

  it('keeps a cache exactly at the cap whole, and never evicts the jacket that just landed even when it alone is over the cap', async () => {
    const exact = world(serving(small), { cap: 2000 })
    seed(exact, JSON.stringify({ [`${ALICE}/${'aa'.repeat(32)}`]: { size: 1000, usedAt: 5 } }))
    exact.fs.store.set(coverPathOf(ALICE, 'aa'.repeat(32)), new Uint8Array(1000))
    await exact.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    expect(exact.fs.store.has(coverPathOf(ALICE, 'aa'.repeat(32)))).toBe(true)
    const tiny = world(serving(small), { cap: 500 })
    expect(await tiny.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(tiny.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(true)
    expect(Object.keys(indexOf(tiny))).toEqual([`${ALICE}/${smallDigest}`])
  })
})

/**
 * ⚠️ **AN INDEX THAT WILL NOT READ WAS AN EMPTY ONE, AND THE NEXT JACKET WROTE
 * OVER IT.** A stored `[]` answered no entries, so the first `ensure` after it
 * wrote an index holding only the jacket just touched — every tracked cover and
 * the cap's accounting gone, and the files they named left on disk where the cap
 * could no longer see them. This case used to be asserted as the DESIGN, at the
 * end of the tolerant-read test above. Found by the 2026-09-13 verify.
 */
describe('an index that will not read', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))
  const TRACKED = JSON.stringify([{ [`${ALICE}/${'ff'.repeat(32)}`]: { size: 1000, usedAt: 5 } }])

  it.each([
    ['a list', TRACKED, /circle\/covers\.json is not an index of jackets/u],
    ['JSON null', 'null', /circle\/covers\.json is not an index of jackets/u],
    ['a bare number', '42', /circle\/covers\.json is not an index of jackets/u],
    ['a bare string', '"covers"', /circle\/covers\.json is not an index of jackets/u],
    ['not JSON', '{"a1a1', /circle\/covers\.json is not JSON/u],
  ])('refuses an index that is %s: nothing is dialled, nothing kept, and its bytes stay', async (_name, raw, clause) => {
    const w = world(serving(small))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(raw))

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)), 'the index is left as it was').toBe(raw)
    /* REFUSED BEFORE THE WIRE: a download the index could not record would be
       a charge on the friend's budget for a file the cap can never see. */
    expect(w.dial).not.toHaveBeenCalled()
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
  })

  it('refuses to index a jacket already kept, and leaves both the jacket and the index where they are', async () => {
    const w = world(serving(small))
    w.fs.store.set(coverPathOf(ALICE, smallDigest), small)
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(TRACKED))

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/circle\/covers\.json is not an index of jackets/u)
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH))).toBe(TRACKED)
    expect(w.fs.store.get(coverPathOf(ALICE, smallDigest))).toEqual(small)
  })

  /* ⚠️ **THE MISS ASKED THE INDEX, AND THE KEEP WROTE THE JACKET BEFORE ASKING
     IT AGAIN.** An index that read at the miss and failed at the keep — damaged
     or merely busy while the bytes were on their way — left the jacket on disk,
     no entry for it, and a rejection: a file the cap could never see. Reproduced
     by the 2026-09-14 verify. */
  it('writes nothing for a jacket whose index stops reading while it downloads, and leaves the index as it was', async () => {
    const w = world(serving(small))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode('{}'))
    const readFile = w.fs.readFile.bind(w.fs)
    let indexReads = 0
    w.fs.readFile = async (path: string) => {
      if (path === COVER_INDEX_PATH && (indexReads += 1) === 2) throw new Error('the index is busy')
      return readFile(path)
    }

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/the index is busy/u)
    expect(w.dial, 'the miss read the index, so the wire was asked').toHaveBeenCalledTimes(1)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest)), 'a jacket was kept that no index entry names').toBe(false)
    expect(w.fs.store.has(`${coverPathOf(ALICE, smallDigest)}.writing`)).toBe(false)
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH))).toBe('{}')
    /* THE CHARGE STANDS, DELIBERATELY: the bytes crossed the wire before the
       index failed, and the budget is a count of what crossed. See `keep`. */
    expect(w.ledger.get(ALICE)?.total).toBe(small.length)
  })

  it('takes back a jacket it wrote when the index naming it could not be written', async () => {
    const w = world(serving(small))
    const writeFile = w.fs.writeFile.bind(w.fs)
    w.fs.writeFile = async (path: string, bytes: Uint8Array) => {
      if (path.startsWith(COVER_INDEX_PATH)) throw new Error('the disk is full')
      return writeFile(path, bytes)
    }

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/the disk is full/u)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest)), 'a jacket was left that no index entry names').toBe(false)
    expect(w.fs.store.has(COVER_INDEX_PATH)).toBe(false)
  })

  /* ⚠️ **AND AN UNDO THAT FAILS IS SAID.** The removal was `.catch(() => {})`, so
     an index write that failed and a removal that failed as well left the jacket
     on disk, unindexed, with only the index error reported — the unseen file the
     undo exists to prevent, and nothing to say it was there (2026-09-14 verify). */
  it('says a jacket it could not take back, instead of reporting only the index', async () => {
    const w = world(serving(small))
    const writeFile = w.fs.writeFile.bind(w.fs)
    w.fs.writeFile = async (path: string, bytes: Uint8Array) => {
      if (path.startsWith(COVER_INDEX_PATH)) throw new Error('the disk is full')
      return writeFile(path, bytes)
    }
    w.fs.remove = () => Promise.reject(new Error('the jacket is held open'))

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )

    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).message).toMatch(/could not be taken back/u)
    expect((cause as AggregateError).errors.map((one: Error) => one.message)).toEqual([
      'the disk is full',
      'the jacket is held open',
    ])
  })

  /* ⚠️ **BUT IT DOES NOT STOP A PERSON BEING FORGOTTEN.** `index.ts` purges the
     jackets FIRST and the person's folder after, so a purge that threw here would
     leave everything of theirs on disk after the reader said to forget them —
     which bytes that were not JSON already did before this fix. The fence has
     moved by the time the index is read, `purgePerson` removes the jackets with
     the folder, and the index is left alone and SAID, not rewritten. */
  it('still forgets a person over an index that will not read, rewriting nothing and saying why', async () => {
    const w = world(serving(small))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(TRACKED))

    await w.fetcher.purge(ALICE)

    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH))).toBe(TRACKED)
    expect(w.warned).toHaveLength(1)
    expect(w.warned[0]!.event).toBe('circle.cover-index-unreadable')
    expect(w.warned[0]!.fields).toEqual({ person: ALICE, message: 'circle/covers.json is not an index of jackets' })
  })

  /* The refusal names the file; the parser's own complaint says where in it. */
  it('keeps what the parser said as the cause of an index that is not JSON', async () => {
    const w = world(serving(small))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode('{"a1a1'))

    const cause = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('circle/covers.json is not JSON')
    expect((cause as Error).cause, 'the parser’s complaint was dropped').toBeInstanceOf(SyntaxError)
  })
})

describe('forgetting a person’s jackets', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))
  const indexOf = (w: ReturnType<typeof world>) => JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>

  it('drops their index entries and nobody else’s', async () => {
    const w = world(serving(small))
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    const BOB = 'c1'.repeat(32)
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ ...indexOf(w), [`${BOB}/${'ff'.repeat(32)}`]: { size: 1, usedAt: 1 } })))
    await w.fetcher.purge(ALICE)
    expect(Object.keys(indexOf(w))).toEqual([`${BOB}/${'ff'.repeat(32)}`])
  })

  /* ⚠️ **A REWRITE IS NOT NOTHING.** With none of theirs to drop, the index
     written would be the index READ — re-serialised, so the malformed entries
     `readIndex` passes over would be dropped out of somebody else's file by a
     purge that had nothing of theirs to do. */
  it('rewrites nothing when the person forgotten has no jackets of their own', async () => {
    const w = world(serving(small))
    const CAROL = 'd1'.repeat(32)
    const stored = JSON.stringify({ [`${CAROL}/${'ff'.repeat(32)}`]: { size: 1, usedAt: 1 }, [`${CAROL}/bad`]: 'x' })
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(stored))

    await w.fetcher.purge(ALICE)

    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)), 'forgetting a person with no jackets rewrote the index').toBe(stored)
  })

  it('fences a fetch that was on its way: it keeps nothing when it lands, and answers null', async () => {
    /* The dial answers only when told to, so the purge can run in between. */
    let release: (() => void) | null = null
    const base = serving(small)
    const gated = {
      ...base,
      session: {
        ...base.session,
        call: (s: string, body: unknown) =>
          new Promise<{ offset: number; size: number; bytes: string; more: boolean }>((done) => {
            release = () => void base.session.call(s, body).then(done)
          }),
      },
    }
    const w = world(gated)
    const landing = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    await new Promise((done) => setTimeout(done, 0))
    await w.fetcher.purge(ALICE)
    release!()
    expect(await landing).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
    expect(w.fs.store.has(COVER_INDEX_PATH) ? Object.keys(indexOf(w)) : []).toEqual([])
    /* Asked again after the purge, it is fetched afresh and kept. */
    w.dial.mockImplementation(() => Promise.resolve(serving(small).session))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(true)
  })
})

describe('the cache, held to the letter', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))
  const indexOf = (w: ReturnType<typeof world>) => JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>

  it('refetches a kept file that no longer hashes to its digest, rather than trusting it under that digest', async () => {
    const w = world(serving(small))
    w.fs.store.set(coverPathOf(ALICE, smallDigest), new Uint8Array(1000).fill(9))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 1 } })))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(w.dial).toHaveBeenCalledTimes(1)
    expect(w.fs.store.get(coverPathOf(ALICE, smallDigest))).toEqual(small)
  })

  it('keeps counting a file that would not go, so the cap is a number the disk obeys', async () => {
    const w = world(serving(small), { cap: 1500 })
    const stuck = 'aa'.repeat(32)
    w.fs.store.set(coverPathOf(ALICE, stuck), new Uint8Array(1000))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${stuck}`]: { size: 1000, usedAt: 1 } })))
    const remove = w.fs.remove.bind(w.fs)
    w.fs.remove = (path: string) => (path === coverPathOf(ALICE, stuck) ? Promise.reject(new Error('locked')) : remove(path))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    /* Still indexed, still on disk: an entry that lied about being gone would be disk the cap never saw again. */
    expect(Object.keys(indexOf(w)).sort()).toEqual([`${ALICE}/${stuck}`, `${ALICE}/${smallDigest}`].sort())
    expect(w.fs.store.has(coverPathOf(ALICE, stuck))).toBe(true)
    /* A file already gone leaves the index without a removal. */
    w.fs.store.delete(coverPathOf(ALICE, stuck))
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    expect(Object.keys(indexOf(w))).toEqual([`${ALICE}/${smallDigest}`])
  })

  it('makes room on a cache hit too, so a lowered cap is obeyed before the next download', async () => {
    const w = world(serving(small), { cap: 1500 })
    const other = 'bb'.repeat(32)
    w.fs.store.set(coverPathOf(ALICE, smallDigest), small)
    w.fs.store.set(coverPathOf(ALICE, other), new Uint8Array(1000))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 9 }, [`${ALICE}/${other}`]: { size: 1000, usedAt: 1 } })))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
    expect(w.dial).not.toHaveBeenCalled()
    expect(Object.keys(indexOf(w))).toEqual([`${ALICE}/${smallDigest}`])
    expect(w.fs.store.has(coverPathOf(ALICE, other))).toBe(false)
  })

  it('drops an index entry whose use is not finite — `1e400` is valid JSON and sorts nowhere', async () => {
    const w = world(serving(small))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(`{"${ALICE}/${'ff'.repeat(32)}":{"size":1,"usedAt":1e400}}`))
    await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    expect(Object.keys(indexOf(w))).toEqual([`${ALICE}/${smallDigest}`])
  })

  /* THE ENTRY GOES WITH THE FILE, not only when a refetch lands to replace it.
     The case above fetches the jacket again under the same key, which would
     hide an entry left behind; here the device refuses, and nothing names a
     file that is gone. */
  it('drops the entry of a kept file that no longer verifies, even when the refetch fails', async () => {
    const w = world(serving(small, { refuse: true }))
    w.fs.store.set(coverPathOf(ALICE, smallDigest), new Uint8Array(1000).fill(9))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 1 } })))
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
    expect(indexOf(w), 'the index still names a jacket that is not on disk').toEqual({})
  })
})

describe('the cache and a purge, or an eviction, in flight together', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))
  const indexOf = (w: ReturnType<typeof world>) => JSON.parse(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH)!)) as Record<string, { size: number; usedAt: number }>

  it('answers null from the cache for a fetch begun after a purge was asked for, and does not re-index the file', async () => {
    /* The purge's turn comes after the hit's: answered from the file it is
       about to lose, the hit re-indexed a jacket in a folder that was gone. */
    const w = world(serving(small))
    w.fs.store.set(coverPathOf(ALICE, smallDigest), small)
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 1 } })))
    const purged = w.fetcher.purge(ALICE)
    /* Begun after the purge was ASKED for, before its turn: the cache says no — the purge takes the file with the entry — and the wire is asked. */
    const asked = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    await purged
    expect(await asked).toEqual(small)
    expect(w.dial).toHaveBeenCalledTimes(1)
    expect(Object.keys(indexOf(w))).toEqual([`${ALICE}/${smallDigest}`])
    /* The purge removed what its index named. */
    const again = world(serving(small))
    again.fs.store.set(coverPathOf(ALICE, smallDigest), small)
    again.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 1 } })))
    await again.fetcher.purge(ALICE)
    expect(again.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
    /* And one begun BEFORE the purge is fenced at the keep, whichever path it took. */
    w.fs.store.set(coverPathOf(ALICE, 'ff'.repeat(32)), small)
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${'ff'.repeat(32)}`]: { size: 1000, usedAt: 1 } })))
    const before = w.fetcher.ensure(ALICE, LAPTOP, 'pub2', 'ff'.repeat(32))
    const gone = w.fetcher.purge(ALICE)
    await gone
    /* The stale bytes do not verify against that digest, so the hit path drops them and the wire answers `small`, whose digest is not `ff…`: null, and nothing indexed for Alice. */
    expect(await before).toBeNull()
    expect(Object.keys(indexOf(w)).filter((key) => key.startsWith(`${ALICE}/`))).toEqual([])
  })

  it('reads a kept jacket whole before a later keep can evict it — the hit and the eviction take turns', async () => {
    /* Read outside the serialisation, an eviction between the `exists` and
       the read deleted the file under it. A read that yields mid-way is how
       the old race is forced. */
    const w = world(serving(small), { cap: 1500 })
    const other = 'bb'.repeat(32)
    w.fs.store.set(coverPathOf(ALICE, other), new Uint8Array(1000).fill(4))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${other}`]: { size: 1000, usedAt: 1 } })))
    const order: string[] = []
    const readFile = w.fs.readFile.bind(w.fs)
    const remove = w.fs.remove.bind(w.fs)
    w.fs.readFile = async (path: string) => {
      order.push(`read ${path}`)
      await new Promise((done) => setTimeout(done, 5))
      return readFile(path)
    }
    w.fs.remove = (path: string) => {
      order.push(`remove ${path}`)
      return remove(path)
    }
    const otherDigestOf = bytesToHex(blake3(new Uint8Array(1000).fill(4)))
    w.fs.store.set(coverPathOf(ALICE, otherDigestOf), new Uint8Array(1000).fill(4))
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${otherDigestOf}`]: { size: 1000, usedAt: 1 } })))
    /* The hit begins; the download of `small` lands while its read is paused, and its keep must evict the oldest — the very file being read. */
    const hit = w.fetcher.ensure(ALICE, LAPTOP, 'pub-other', otherDigestOf)
    const landing = w.fetcher.ensure(ALICE, LAPTOP, 'pub-small', smallDigest)
    expect(await hit).toEqual(new Uint8Array(1000).fill(4))
    expect(await landing).toEqual(small)
    const read = order.findIndex((one) => one === `read ${coverPathOf(ALICE, otherDigestOf)}`)
    const removed = order.findIndex((one) => one === `remove ${coverPathOf(ALICE, otherDigestOf)}`)
    expect(read).toBeGreaterThanOrEqual(0)
    expect(removed).toBeGreaterThan(read)
    /* AND THE TOUCH DID NOT PUT THE EVICTED ENTRY BACK. Outside the
       serialisation the hit's touch landed after the eviction and re-indexed
       a file the eviction had just removed: the index named a jacket that
       was not on disk. Every entry names a file that is there. */
    const index = indexOf(w)
    expect(Object.keys(index)).toEqual([`${ALICE}/${smallDigest}`])
    expect(w.fs.store.has(coverPathOf(ALICE, otherDigestOf))).toBe(false)
    for (const key of Object.keys(index)) {
      const cut = key.indexOf('/')
      expect(w.fs.store.has(coverPathOf(key.slice(0, cut), key.slice(cut + 1)))).toBe(true)
    }
  })

  /* THE HIT'S OWN FENCE. Begun before the purge was asked for, its turn comes
     FIRST — so without a fence it answers from the very file the purge is
     about to remove, and re-indexes it on the way. The case above staled the
     bytes, which ends in null by the digest check whichever path ran. */
  it('answers null for a hit begun before a purge, even when its turn comes before the purge’s', async () => {
    const w = world(serving(small))
    w.fs.store.set(coverPathOf(ALICE, smallDigest), small)
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ [`${ALICE}/${smallDigest}`]: { size: 1000, usedAt: 1 } })))
    const before = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)
    const purged = w.fetcher.purge(ALICE)
    await purged
    expect(await before, 'answered from a file a purge already asked for had removed').toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
    expect(Object.keys(indexOf(w))).toEqual([])
  })
})

/* THE SIGNAL REACHES THE TRANSFER. A signal that only cancelled the answer
   left the bytes moving — and the budget spending — for a row that had
   scrolled away. One transfer per digest, shared; abandoned when the LAST
   caller has let go, and not before. */
describe('a transfer abandoned', () => {
  /** The first chunk is answered only when the test opens the gate. */
  function gated() {
    const serve = serving()
    let open: () => void = () => {}
    const held = new Promise<void>((done) => {
      open = done
    })
    const session = {
      call: async (service: string, body: unknown) => {
        if (serve.calls.length === 0) await held
        return serve.session.call(service, body)
      },
      close: serve.session.close,
    }
    return { serve, session, open: () => open() }
  }

  it('stops once every caller has let go: the next chunk is not asked for, the session is closed, and a fresh ask dials again', async () => {
    const g = gated()
    const w = world({ ...g.serve, session: g.session })
    const a = new AbortController()
    const b = new AbortController()
    const first = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST, a.signal)
    const second = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST, b.signal)
    await new Promise((done) => setTimeout(done, 0))
    expect(w.dial).toHaveBeenCalledTimes(1)
    a.abort()
    b.abort()
    g.open()
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    /* The first chunk had landed; the second was never asked for. */
    expect(g.serve.calls).toHaveLength(1)
    expect(g.serve.closed()).toBe(1)
    /* Nothing stale in flight: the next ask is a new transfer. */
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)).toEqual(JACKET)
    expect(w.dial).toHaveBeenCalledTimes(2)
  })

  it('keeps going while one caller still wants it, and answers null at once to a signal already aborted', async () => {
    const g = gated()
    const w = world({ ...g.serve, session: g.session })
    const a = new AbortController()
    const first = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST, a.signal)
    /* A second caller with no signal wants it until it lands. */
    const second = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST)
    a.abort()
    g.open()
    expect(await second).toEqual(JACKET)
    expect(await first).toEqual(JACKET)
    expect(g.serve.calls).toHaveLength(2)
    const gone = new AbortController()
    gone.abort()
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub2', 'ee'.repeat(32), gone.signal)).toBeNull()
    expect(w.dial).toHaveBeenCalledTimes(1)
  })

  /* LET GO BEFORE THE WIRE. Every caller abandoned it while the cache was still
     answering, so there is nobody left to dial for — and a dial is a session on
     a friend's device. */
  it('does not dial for a transfer every caller let go of while the cache was still answering', async () => {
    const w = world()
    const row = new AbortController()
    const asked = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST, row.signal)
    row.abort()
    expect(await asked).toBeNull()
    expect(w.dial, 'a transfer nobody wanted still dialled the device').not.toHaveBeenCalled()
  })

  /* A row's signal does not go on holding the transfer it has let go of. */
  it('lets go of a caller’s signal once it has fired', async () => {
    const w = world()
    const row = new AbortController()
    const asked = w.fetcher.ensure(ALICE, LAPTOP, 'pub1', DIGEST, row.signal)
    expect(getEventListeners(row.signal, 'abort')).toHaveLength(1)
    row.abort()
    expect(getEventListeners(row.signal, 'abort'), 'the signal still holds the transfer it let go of').toHaveLength(0)
    expect(await asked).toBeNull()
  })
})

/**
 * What the bytes say they are. `circlePort` draws a jacket as a data URL of
 * this type, so a PNG kept under a digest is not declared a JPEG — and bytes
 * that open like nothing it knows are declared as nothing in particular.
 */
describe('what a jacket’s bytes say it is', () => {
  /* Each kind as it opens, with more after it: the signature is a prefix, not
     the file. WebP's bytes 4–7 are its length, and carry one here. The third
     column is where each signature's bytes sit. */
  const OPENINGS = [
    ['image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], [0, 1, 2]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00], [0, 1, 2, 3, 4, 5, 6, 7]],
    ['image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [0, 1, 2, 3]],
    ['image/webp', [0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50], [0, 1, 2, 3, 8, 9, 10, 11]],
  ] as const

  it.each(OPENINGS)('names %s by its opening bytes', (type, bytes) => {
    expect(imageTypeOf(Uint8Array.from(bytes))).toBe(type)
  })

  /* EVERY BYTE OF A SIGNATURE COUNTS: one changed, anywhere in it, and the file
     is not that kind — nor any other, since no two kinds open with the same
     byte. */
  it.each(OPENINGS)('names nothing in particular for %s with any one signature byte changed', (_type, bytes, signature) => {
    for (const at of signature) {
      const changed = Uint8Array.from(bytes)
      changed[at] = changed[at]! ^ 0xff
      expect(imageTypeOf(changed), `byte ${at}`).toBe('application/octet-stream')
    }
  })

  it('names nothing in particular for bytes too short to open like anything', () => {
    expect(imageTypeOf(new Uint8Array())).toBe('application/octet-stream')
    expect(imageTypeOf(Uint8Array.from([0xff, 0xd8]))).toBe('application/octet-stream')
  })
})

/**
 * ⚠️ **"THE ANSWER IS NULL EITHER WAY" IS NOT THE WHOLE OF WHAT A GUARD DOES.**
 *
 * Every guard in `fetchOne` was exempt from mutation testing, on the reasoning
 * that the digest check at the end reaches the same answer for anything a
 * guard let through. It does. It reaches it AFTER the bytes have crossed the
 * wire, been charged to a friend's budget, and been held in memory — and for
 * two of them, after a property read on `null` has turned a damaged answer
 * into a thrown failure the log then reports as a failed fetch.
 *
 * So these assert what the guard saves rather than only what it answers: the
 * calls made, the bytes charged, and the silence (2026-09-14 mutation debt).
 */
describe('what each guard saves', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))

  /** The shape a device is supposed to answer with — several of these do not. */
  type Answer = { offset: number; size: number; bytes: string; more: boolean }

  /** A device that answers whatever the test says, and records what it was asked. */
  function answering(answer: (asked: { pub: string; offset: number }, n: number) => unknown) {
    const calls: { pub: string; offset: number }[] = []
    let closed = 0
    const session = {
      call: (_service: string, body: unknown) => {
        const asked = body as { pub: string; offset: number }
        calls.push(asked)
        /* CAST, because the point of two of these is an answer that is NOT one:
           `parseCoverAnswer` is what decides the shape, and a fake that could
           only serve well-formed answers could not reach it. */
        return Promise.resolve(answer(asked, calls.length) as Answer)
      },
      close: () => {
        closed += 1
        return Promise.resolve()
      },
    }
    return { session, calls, closed: () => closed }
  }

  it('does not pay for a chunk that arrives at an offset nobody asked for', async () => {
    const serve = answering((asked) => ({ offset: asked.offset + 1, size: small.length, bytes: base64Of(small.subarray(0, 10)), more: false }))
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(serve.calls).toHaveLength(1)
    expect(w.ledger.get(ALICE), 'a chunk at an offset nobody asked for was charged to the friend').toBeUndefined()
  })

  /* An answer `parseCoverAnswer` refuses is `null` here, and a guard that let
     it past read `.offset` off it — a TypeError, reported as a failed fetch. */
  it('ends the fetch on an answer that is not one, with nothing charged and nothing said', async () => {
    const serve = answering(() => ({ nonsense: true }))
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(serve.calls).toHaveLength(1)
    expect(w.warned, 'an answer that would not parse was reported as a failure').toEqual([])
    expect(w.ledger.get(ALICE)).toBeUndefined()
  })

  it('stops at the answer whose size changed, having paid for only what arrived before it', async () => {
    const serve = answering((asked, n) => ({
      offset: asked.offset,
      size: small.length + n - 1,
      bytes: base64Of(small.subarray(asked.offset, asked.offset + 500)),
      more: true,
    }))
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(serve.calls, 'it went on asking after the device changed its mind about the size').toHaveLength(2)
    expect(w.ledger.get(ALICE)?.total).toBe(500)
  })

  it('ends the fetch on a chunk that is not base64, with nothing charged and nothing said', async () => {
    const serve = answering((asked) => ({ offset: asked.offset, size: small.length, bytes: '####', more: false }))
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(w.warned, 'a chunk that would not decode was reported as a failure').toEqual([])
    expect(w.ledger.get(ALICE)).toBeUndefined()
  })

  /* ⚠️ **THE BYTES ARE BOUNDED BY THIS GUARD AND BY NOTHING ELSE.** A device
     that promises ten bytes and serves twenty is cut off at the first chunk;
     read past, the next chunk is asked for and paid for as well. */
  it('stops at the first chunk past the size the device promised, rather than asking for another', async () => {
    const serve = answering((asked) => ({ offset: asked.offset, size: 10, bytes: base64Of(new Uint8Array(20).fill(7)), more: true }))
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(serve.calls, 'it asked for another chunk of a jacket already past its size').toHaveLength(1)
    expect(w.ledger.get(ALICE)?.total, 'only the chunk that had already crossed the wire is charged').toBe(20)
  })

  /* THE CAP IS INCLUSIVE, and that is the one thing `got > MAX_COVER_BYTES`
     says that `got > size` does not: a jacket of exactly the largest size the
     circle fetches is fetched whole. Two chunks, at the protocol's own size. */
  it('keeps a jacket of exactly the largest size the circle fetches', async () => {
    const whole = new Uint8Array(MAX_COVER_BYTES).fill(7)
    const digest = bytesToHex(blake3(whole))
    const serve = answering((asked) => {
      const slice = whole.subarray(asked.offset, asked.offset + COVER_CHUNK_BYTES)
      return { offset: asked.offset, size: whole.length, bytes: base64Of(slice), more: asked.offset + slice.length < whole.length }
    })
    const w = world(serve)
    const got = await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', digest)
    expect(got?.length).toBe(MAX_COVER_BYTES)
    expect(bytesToHex(blake3(got!))).toBe(digest)
    expect(w.fs.store.has(coverPathOf(ALICE, digest))).toBe(true)
  })

  /* AND WHAT ARRIVED MUST BE WHAT WAS PROMISED, even when it verifies: a
     device that sends the whole jacket while claiming a larger one has not
     told the truth about the file, and the digest cannot see that. */
  it('keeps nothing from a device that says the jacket is bigger than what it sent', async () => {
    const serve = answering((asked) => {
      const slice = small.subarray(asked.offset, asked.offset + 500)
      return { offset: asked.offset, size: small.length + 10, bytes: base64Of(slice), more: asked.offset + slice.length < small.length }
    })
    const w = world(serve)
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(w.fs.store.has(coverPathOf(ALICE, smallDigest))).toBe(false)
  })
})

/* `warn` is optional, and a reason with nobody to hear it is still only a
   reason: the answer each operation gives must be the one it gives with a
   listener. */
describe('a reason with nobody listening for it', () => {
  const small = new Uint8Array(1000).fill(3)
  const smallDigest = bytesToHex(blake3(small))

  it('answers null for a jacket that could not be fetched', async () => {
    const w = world(serving(small, { refuse: true }), { silent: true })
    expect(await w.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toBeNull()
    expect(w.dial).toHaveBeenCalledTimes(1)
  })

  it('still forgets a person over an index that will not read', async () => {
    const w = world(serving(small), { silent: true })
    w.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode('[]'))
    await expect(w.fetcher.purge(ALICE)).resolves.toBeUndefined()
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH))).toBe('[]')
  })
})
