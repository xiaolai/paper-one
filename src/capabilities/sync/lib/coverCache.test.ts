import { describe, expect, it } from 'vitest'
import { createKernelServices } from '../../../kernel'
import { fakeBlobHash, fakeWire, linkWires } from '../../peer'
import { createPeerPort } from '../../peer'
import { COVER_CAP_SETTING, COVER_INDEX_PATH, createCoverCache } from './coverCache'
import { crashableFs } from './journalFs.testkit'
import type { BlobFacts } from './ledger'

/**
 * WI-C.3 — the cover cache over the fake wire: a fetch lands the jacket
 * and records it; a present jacket is only touched; the legacy `.webp`
 * name is fetched when that is what the shelf serves; the LRU evicts the
 * OLDEST over the byte cap and never the one just used.
 */

async function world() {
  const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-cover' })
  const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-cover' })
  linkWires(shelfWire, satchelWire)
  shelfWire.addPeer({ id: satchelWire.id, role: 'satchel', grants: ['blob:*'] })
  satchelWire.addPeer({ id: shelfWire.id, role: 'shelf', grants: ['blob:*'] })
  await shelfWire.ready()
  await satchelWire.ready()
  const port = createPeerPort(satchelWire)
  await satchelWire.connect(shelfWire.id) // blobs need an open session

  const fs = crashableFs()
  const storage = new Map<string, string>()
  const services = createKernelServices({
    fs,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  })
  satchelWire.landBlob = async (folder, name, bytes) => {
    await fs.writeFile(`books/${folder}/${name}`, bytes)
  }

  /** The shelf's covers, by folder — and what `sync.content` would answer. */
  const shelfCovers = new Map<string, { name: string; bytes: Uint8Array }>()
  const serve = async (folder: string, name: string, bytes: Uint8Array) => {
    shelfWire.blobs.set(`${folder}/${name}`, bytes)
    shelfCovers.set(folder, { name, bytes })
  }
  const lookup = async (book: string) => {
    const folder = `book_${book.slice('book:'.length)}`
    const held = shelfCovers.get(folder)
    if (!held) return { peerId: shelfWire.id, folder, cover: null }
    const cover: BlobFacts = { name: held.name, size: held.bytes.length, hash: await fakeBlobHash(held.bytes) }
    return { peerId: shelfWire.id, folder, cover }
  }

  let now = 1_000
  const cache = createCoverCache({
    fs,
    settings: services.settings,
    lookup,
    fetchBlob: (peerId, folder, blob) =>
      port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash }),
    // The REAL kernel primitive (WI-10.2/10.5), so eviction here proves the
    // closed-name door — not a stand-in that would accept anything.
    removeBlob: (book, name) => services.removeBlob(book, name),
    now: () => ++now,
  })
  return { cache, fs, serve, services }
}

const jacket = (size: number, fill = 7): Uint8Array => new Uint8Array(size).fill(fill)

describe('the cover cache', () => {
  it('fetches a missing cover, records it, and answers cheaply when present', async () => {
    const w = await world()
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.fs.store.get('books/book_a/cover.jpg')).toEqual(jacket(1000))
    expect((await w.cache.index())['book:a']?.size).toBe(1000)

    const opsBefore = w.fs.ops.length
    expect(await w.cache.ensure('book:a')).toBe(true) // present: an LRU touch, no fetch
    expect(w.fs.store.get('books/book_a/cover.jpg')).toEqual(jacket(1000))
    // Only the index write moved — no blob landed again.
    expect(w.fs.ops.slice(opsBefore).every((op) => op.path.includes(COVER_INDEX_PATH) || op.kind === 'fsync')).toBe(true)
  })

  it('a book with no cover answers false and stores nothing', async () => {
    const w = await world()
    expect(await w.cache.ensure('book:none')).toBe(false)
    expect(await w.cache.index()).toEqual({})
  })

  it('fetches the legacy cover.webp when that is what the shelf has', async () => {
    const w = await world()
    await w.serve('book_old', 'cover.webp', jacket(500, 3))
    expect(await w.cache.ensure('book:old')).toBe(true)
    expect(w.fs.store.get('books/book_old/cover.webp')).toEqual(jacket(500, 3))
    expect((await w.cache.index())['book:old']?.name).toBe('cover.webp')
  })

  it('evicts the oldest covers over the cap, never the one just fetched', async () => {
    const w = await world()
    // A 1 MB cap; three ~0.6 MB covers cannot all stay.
    w.services.settings.set(COVER_CAP_SETTING, 1)
    const size = Math.round(0.6 * 1024 * 1024)
    await w.serve('book_a', 'cover.jpg', jacket(size, 1))
    await w.serve('book_b', 'cover.jpg', jacket(size, 2))
    await w.serve('book_c', 'cover.jpg', jacket(size, 3))
    await w.cache.ensure('book:a')
    await w.cache.ensure('book:b') // a is now the oldest — and over the cap, evicted
    let index = await w.cache.index()
    expect(Object.keys(index).sort()).toEqual(['book:b'])
    expect(w.fs.store.has('books/book_a/cover.jpg')).toBe(false)

    await w.cache.ensure('book:c')
    index = await w.cache.index()
    expect(Object.keys(index).sort()).toEqual(['book:c'])
    expect(w.fs.store.has('books/book_b/cover.jpg')).toBe(false)
    expect(w.fs.store.has('books/book_c/cover.jpg')).toBe(true)
    expect(await w.cache.totalBytes()).toBe(size)
  })

  /**
   * A COVER BIGGER THAN THE WHOLE CACHE IS NOT FETCHED.
   *
   * The size in a peer's answer was never read: a "cover" advertised at any
   * size at all was transferred in full and written to this device's disk,
   * and only then measured. Eviction cannot undo a transfer — by the time the
   * cache notices, the disk is already spent — and the entry was ALSO exempt
   * from eviction for as long as it stayed the current cover, so the cache sat
   * permanently over its cap while deleting every other jacket to get under
   * it.
   */
  it('refuses a cover larger than the cap before any bytes move', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1) // 1 MB
    const huge = 2 * 1024 * 1024
    await w.serve('book_big', 'cover.jpg', jacket(huge, 9))
    expect(await w.cache.ensure('book:big')).toBe(false)
    /* Nothing landed, and nothing is tracked. */
    expect(w.fs.store.has('books/book_big/cover.jpg')).toBe(false)
    expect(await w.cache.index()).toEqual({})
    /* And a cover that FITS still arrives, so the guard is a size check and
     * not a refusal of everything. */
    await w.serve('book_ok', 'cover.jpg', jacket(1000, 4))
    expect(await w.cache.ensure('book:ok')).toBe(true)
  })

  /* AND THE SAME ENTRY, ALREADY ON DISK. A cover that predates the cap — or
   * one the cap was lowered under — is discovered rather than fetched, so the
   * fetch guard above never sees it. The exemption must not protect it. */
  it('evicts an oversized cover already here, current or not', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    await w.fs.writeFile('books/book_big/cover.jpg', jacket(2 * 1024 * 1024, 9))
    expect(await w.cache.ensure('book:big')).toBe(true) // it IS here
    /* Over the cap by itself, so it does not survive its own eviction pass. */
    expect(await w.cache.index()).toEqual({})
    expect(w.fs.store.has('books/book_big/cover.jpg')).toBe(false)
  })

  /**
   * AN UNREADABLE INDEX IS NOT AN EMPTY ONE.
   *
   * Every failure used to answer `{}`, and the next write persists that — so
   * one transient read error made the cache forget every cover it was
   * tracking, permanently. The files stay on disk, untracked, counting toward
   * nothing and never evicted, and the cap silently stops applying.
   */
  it('throws rather than reading an unreadable index as an empty one', async () => {
    const w = await world()
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    await w.cache.ensure('book:a')
    const real = w.fs.readFile.bind(w.fs)
    w.fs.readFile = async (path: string) => {
      if (path === COVER_INDEX_PATH) throw new Error('EIO')
      return real(path)
    }
    await expect(w.cache.index()).rejects.toThrow(/EIO/)
    /* And the tracked entry survives the failure. */
    w.fs.readFile = real
    expect(Object.keys(await w.cache.index())).toEqual(['book:a'])
  })

  /* A ROW THAT IS NOT A ROW GOES ALONE. A hand-edited `covers.json` must not
   * cost the entries beside it, and a NaN or negative size poisons the byte
   * total while a NaN stamp scrambles the LRU. */
  it('drops corrupt entries individually and keeps the good ones', async () => {
    const w = await world()
    await w.fs.writeFile(
      COVER_INDEX_PATH,
      new TextEncoder().encode(
        JSON.stringify({
          good: { name: 'cover.jpg', size: 10, usedAt: 1 },
          negative: { name: 'cover.jpg', size: -1, usedAt: 1 },
          fractional: { name: 'cover.jpg', size: 1.5, usedAt: 1 },
          nan: { name: 'cover.jpg', size: Number.NaN, usedAt: 1 },
          huge: { name: 'cover.jpg', size: 2 ** 53, usedAt: 1 },
          noStamp: { name: 'cover.jpg', size: 10 },
          notAnObject: 7,
          alsoGood: { name: 'cover.jpg', size: 20, usedAt: 2 },
        }),
      ),
    )
    expect(Object.keys(await w.cache.index()).sort()).toEqual(['alsoGood', 'good'])
  })

  /**
   * `__proto__` IS A BOOK ID, because a book id comes off the wire.
   *
   * `{}` inherits `Object.prototype`, so a book named `__proto__` did not
   * become an entry — it ran the legacy prototype setter. That cover was never
   * tracked, never counted toward the cap and never evicted, and
   * `index['toString']` answered a function for a book nobody had.
   */
  it('tracks a book named __proto__ like any other', async () => {
    const w = await world()
    /* WRITTEN AS TEXT, not built as a literal: `{ __proto__: … }` in source
     * SETS THE PROTOTYPE and produces no own key at all, so the fixture would
     * have stringified to `{}` and the test would have asserted nothing. */
    await w.fs.writeFile(
      COVER_INDEX_PATH,
      new TextEncoder().encode('{"__proto__":{"name":"cover.jpg","size":10,"usedAt":1}}'),
    )
    const index = await w.cache.index()
    expect(Object.keys(index)).toEqual(['__proto__'])
    /* And nothing inherited answers for a book that does not exist. */
    expect((index as Record<string, unknown>)['toString']).toBeUndefined()
  })

  /**
   * A FILE THAT WOULD NOT DELETE MUST STAY TRACKED.
   *
   * A swallowed delete used to untrack the row anyway and subtract its size,
   * so a file that would not delete became invisible: still on disk, counted
   * by nothing, never retried, and the cap enforced against a total that
   * understated the cache by exactly that much. Repeated, the cache grows
   * without bound while its own arithmetic says it is under the limit.
   */
  it('keeps an entry whose file could not be deleted', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    const size = Math.round(0.6 * 1024 * 1024)
    await w.serve('book_a', 'cover.jpg', jacket(size, 1))
    await w.serve('book_b', 'cover.jpg', jacket(size, 2))
    await w.cache.ensure('book:a')

    const real = w.fs.remove.bind(w.fs)
    w.fs.remove = async (path: string) => {
      if (path.includes('book_a')) throw new Error('EPERM')
      return real(path)
    }
    await w.cache.ensure('book:b')
    /* `book:a` is over the cap and older, so eviction tried it — and it is
     * still tracked, because the file is still there. */
    expect(Object.keys(await w.cache.index()).sort()).toEqual(['book:a', 'book:b'])
    expect(w.fs.store.has('books/book_a/cover.jpg')).toBe(true)
  })

  /**
   * A MEASUREMENT THAT FAILED IS NOT A SIZE OF ZERO.
   *
   * A failed measurement used to record zero — or, worse, the size of a
   * DIFFERENTLY NAMED prior cover — and return success. The entry then counted
   * for nothing against the cap and was never worth evicting, and a same-name
   * touch never measured again, so the wrong number was permanent.
   */
  it('leaves an entry untracked rather than recording an invented size', async () => {
    const w = await world()
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    const real = w.fs.readFile.bind(w.fs)
    w.fs.readFile = async (path: string) => {
      if (path.endsWith('cover.jpg')) throw new Error('EIO')
      return real(path)
    }
    /* The cover IS here — what failed is measuring it. */
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(await w.cache.index()).toEqual({})

    /* And the next attempt measures again rather than trusting a zero. */
    w.fs.readFile = real
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect((await w.cache.index())['book:a']?.size).toBe(1000)
  })

  /* A CAP NOTHING CAN REACH IS NOT A CAP. `capBytes()` multiplies by 1 048 576
   * and the validator asked only for a finite positive number, so a settings
   * file could switch eviction off by naming a number rather than by anyone
   * deciding to. */
  it('refuses a cap that would make the byte limit unreachable', async () => {
    const w = await world()
    const before = w.services.settings.get(COVER_CAP_SETTING)
    for (const bad of [1e300, Number.MAX_VALUE, 2 ** 53, -1, 0, 0.5]) {
      w.services.settings.set(COVER_CAP_SETTING, bad)
      expect(w.services.settings.get(COVER_CAP_SETTING), String(bad)).toBe(before)
    }
    /* An ordinary number still takes. */
    w.services.settings.set(COVER_CAP_SETTING, 50)
    expect(w.services.settings.get(COVER_CAP_SETTING)).toBe(50)
  })
})
