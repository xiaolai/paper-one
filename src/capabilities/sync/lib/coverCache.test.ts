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
})
