import { blake3 } from '@noble/hashes/blake3.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { MAX_COVER_BYTES, NOTHING_SPENT, charge, personFolderIn, type Spend, type VaultFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { base64Of } from './base64'
import { COVER_CAP_SETTING, COVER_INDEX_PATH, coverPathOf, createCoverFetcher } from './covers'
import { CIRCLE_SERVICES } from './protocol'

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

function world(serve = serving(), over: { cap?: number; budget?: Spend } = {}) {
  const fs = fakeFs() as unknown as VaultFs
  const dial = vi.fn(() => Promise.resolve(serve.session))
  const ledger = new Map<string, Spend>()
  if (over.budget) ledger.set(ALICE, over.budget)
  let now = 1_000
  const fetcher = createCoverFetcher({
    fs,
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
  return { fs: fs as unknown as ReturnType<typeof fakeFs>, dial, fetcher, ledger, serve }
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

  it('reads its index back tolerantly — a malformed entry is dropped, a malformed index is empty — and evicts the least recently drawn first', async () => {
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
    /* And an index that is not an object reads as empty rather than throwing. */
    const broken = world(serving(small))
    broken.fs.store.set(COVER_INDEX_PATH, new TextEncoder().encode('[1, 2]'))
    expect(await broken.fetcher.ensure(ALICE, LAPTOP, 'pub1', smallDigest)).toEqual(small)
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

  it.each([
    ['null', 'null'],
    ['a number', '5'],
    ['a list', '[1]'],
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
})
