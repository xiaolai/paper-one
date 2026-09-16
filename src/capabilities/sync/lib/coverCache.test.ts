import { describe, expect, it, vi } from 'vitest'
import { createKernelServices } from '../../../kernel'
import { fakeBlobHash, fakeWire, linkWires } from '../../peer'
import { createPeerPort } from '../../peer'
import { COVER_CAP_MAX_MB, COVER_CAP_SETTING, COVER_INDEX_PATH, createCoverCache, type CoverCacheOptions } from './coverCache'
import { crashableFs } from './journalFs.testkit'
import { blobFolderOf, type BlobFacts } from './ledger'

/**
 * WI-C.3 — the cover cache over the fake wire: a fetch lands the jacket
 * and records it; a present jacket is only touched; the legacy `.webp`
 * name is fetched when that is what the shelf serves; the LRU evicts the
 * OLDEST over the byte cap and never the one just used.
 */

/** The host's hasher, over the fake fs: the digest of the bytes that are there. */
const hasherOver = (fs: { store: Map<string, Uint8Array> }) => () => ({
  hashFile: async (folder: string, name: string) => {
    const bytes = fs.store.get(`books/${folder}/${name}`)
    if (!bytes) throw new Error(`no ${name} under ${folder}`)
    return { blake3: await fakeBlobHash(bytes), size: bytes.length }
  },
})

/**
 * A satchel's cover cache over the fake wire.
 *
 * `hasher` binds the host's hasher; `tellNobody` builds the cache with no
 * `stamp` and no `unstamp`, as a composition with no record to tell composes
 * it; `options` replaces any collaborator outright, last.
 */
async function world(
  over: { readonly hasher?: boolean; readonly tellNobody?: boolean; readonly options?: Partial<CoverCacheOptions> } = {},
) {
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
    /* The cache's own folder rule, so a book id of any spelling is served. */
    const folder = blobFolderOf(book)
    const held = shelfCovers.get(folder)
    if (!held) return { peerId: shelfWire.id, folder, cover: null }
    const cover: BlobFacts = { name: held.name, size: held.bytes.length, hash: await fakeBlobHash(held.bytes) }
    return { peerId: shelfWire.id, folder, cover }
  }

  let now = 1_000
  const stamp = vi.fn(() => Promise.resolve())
  const unstamp = vi.fn(() => Promise.resolve())
  const cache = createCoverCache({
    fs,
    settings: services.settings,
    lookup,
    ...(over.tellNobody ? {} : { stamp, unstamp }),
    fetchBlob: (peerId, folder, blob) =>
      port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash }),
    // The REAL kernel primitive (WI-10.2/10.5), so eviction here proves the
    // closed-name door — not a stand-in that would accept anything.
    removeBlob: (book, name) => services.removeBlob(book, name),
    now: () => ++now,
    ...(over.hasher ? { hashes: hasherOver(fs as unknown as { store: Map<string, Uint8Array> }) } : {}),
    ...over.options,
  })
  return { cache, fs, serve, services, stamp, unstamp }
}

const jacket = (size: number, fill = 7): Uint8Array => new Uint8Array(size).fill(fill)

describe('the cover cache', () => {
  it('fetches a missing cover, records it, and answers cheaply when present', async () => {
    const w = await world()
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.fs.store.get('books/book_a/cover.jpg')).toEqual(jacket(1000))
    expect((await w.cache.index())['book:a']?.size).toBe(1000)
    /* Stamped as it landed, so nothing is owed. */
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.jpg', size: 1000, usedAt: expect.any(Number) })
    /* The landing carries its facts onto the record (WI-23.C5) — once, for the fetch. */
    expect(w.stamp).toHaveBeenCalledTimes(1)
    expect(w.stamp).toHaveBeenCalledWith('book:a', expect.objectContaining({ name: 'cover.jpg', size: 1000, hash: expect.any(String) }))

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
    /* Not even an empty index: there was nothing to take out of one. */
    expect(w.fs.store.has(COVER_INDEX_PATH)).toBe(false)
  })

  /* A TRACKED JACKET THE SHELF NO LONGER HAS LEAVES THE INDEX — whether the
   * shelf says it has none, or the fetch that would replace it fails. Either
   * way the cover is not here, and an entry for it is a lie. */
  it('stops tracking a jacket that is gone when the shelf has none, or the fetch fails', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('the shelf went away')))
    const w = await world({ options: { fetchBlob: failing } })
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    await w.fs.writeFile('books/book_b/cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(await w.cache.ensure('book:b')).toBe(true)
    w.fs.store.delete('books/book_a/cover.jpg')
    w.fs.store.delete('books/book_b/cover.jpg')

    /* The shelf has nothing for `a`. */
    expect(await w.cache.ensure('book:a')).toBe(false)
    expect(Object.keys(await w.cache.index())).toEqual(['book:b'])

    /* The shelf has one for `b`, and the fetch fails. */
    await w.serve('book_b', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:b')).toBe(false)
    expect(failing).toHaveBeenCalledTimes(1)
    expect(await w.cache.index()).toEqual({})
  })

  /* THE PEER'S ANSWER IS CHECKED BEFORE A BYTE MOVES: the folder must be this
   * book's, the name a jacket's, and the size a byte count the cap allows. */
  it('fetches nothing for an answer naming another folder, another file, or a size that is not a byte count', async () => {
    const fetched: BlobFacts[] = []
    const answers = new Map<string, { folder: string; cover: BlobFacts }>([
      ['book:folder', { folder: 'book_other', cover: { name: 'cover.jpg', size: 10, hash: 'ab'.repeat(32) } }],
      ['book:bytes', { folder: 'book_bytes', cover: { name: 'content.epub', size: 10, hash: 'ab'.repeat(32) } }],
      ['book:fraction', { folder: 'book_fraction', cover: { name: 'cover.jpg', size: 1.5, hash: 'ab'.repeat(32) } }],
      ['book:negative', { folder: 'book_negative', cover: { name: 'cover.jpg', size: -1, hash: 'ab'.repeat(32) } }],
    ])
    const w = await world({
      options: {
        lookup: async (book) => ({ peerId: 'shelf', ...answers.get(book)! }),
        fetchBlob: async (_peer, _folder, blob) => void fetched.push(blob),
      },
    })
    for (const book of answers.keys()) expect(await w.cache.ensure(book), book).toBe(false)
    expect(fetched).toEqual([])
    expect(await w.cache.index()).toEqual({})
  })

  /* A DECLARED SIZE OF ZERO IS A BYTE COUNT — only a negative one is not. */
  it('fetches a jacket the peer declares empty', async () => {
    const fetched: BlobFacts[] = []
    const w = await world({
      options: {
        lookup: async () => ({ peerId: 'shelf', folder: 'book_empty', cover: { name: 'cover.jpg', size: 0, hash: 'ab'.repeat(32) } }),
        fetchBlob: async (_peer, _folder, blob) => void fetched.push(blob),
      },
    })
    expect(await w.cache.ensure('book:empty')).toBe(true)
    expect(fetched).toHaveLength(1)
    expect((await w.cache.index())['book:empty']?.size).toBe(0)
  })

  it('fetches the legacy cover.webp when that is what the shelf has', async () => {
    const w = await world()
    await w.serve('book_old', 'cover.webp', jacket(500, 3))
    expect(await w.cache.ensure('book:old')).toBe(true)
    expect(w.fs.store.get('books/book_old/cover.webp')).toEqual(jacket(500, 3))
    expect((await w.cache.index())['book:old']?.name).toBe('cover.webp')
  })

  /* THE DEBT OF A STAMP THAT WOULD NOT TAKE. The record refused the jacket's
     facts when it landed; the entry records that a stamp is OWED, and the
     next `ensure` that finds the jacket present pays it from a fresh
     measurement of the file. A swallowed failure used to be permanent — the
     present path had nothing to stamp with, and a phone composes no circle
     pass to do it later. */
  it('keeps a failed stamp as a debt on the entry and pays it, MEASURED, on the next present-cover ensure', async () => {
    const w = await world({ hasher: true })
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    w.stamp.mockRejectedValueOnce(new Error('the record would not take it'))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.jpg', size: 1000, usedAt: expect.any(Number), owed: true })
    expect(w.stamp).toHaveBeenCalledTimes(1)
    /* The jacket is present now: the debt is paid on the touch, from the file, and cleared. */
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(2)
    expect(w.stamp).toHaveBeenLastCalledWith('book:a', { name: 'cover.jpg', size: 1000, hash: await fakeBlobHash(jacket(1000)) })
    expect((await w.cache.index())['book:a']).not.toHaveProperty('owed')
    /* Paid once: a third touch stamps nothing. */
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(2)
  })

  it('reads a digest an older index kept as a stamp owed, and pays it from the file, not from that digest', async () => {
    const w = await world({ hasher: true })
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    await w.fs.writeFile(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ 'book:a': { name: 'cover.jpg', size: 1000, usedAt: 1, pendingHash: 'ab'.repeat(32) } })))
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.jpg', size: 1000, usedAt: 1, owed: true })
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenLastCalledWith('book:a', { name: 'cover.jpg', size: 1000, hash: await fakeBlobHash(jacket(1000)) })
  })

  /* WITHOUT A MEASUREMENT THE DEBT STANDS. A size is not an identity: a
     same-name file replaced since the digest was taken — at another size or
     the SAME size — is not those bytes, and stamping the old digest onto it
     published facts that were wrong. The record carries no facts it cannot
     back, and the debt waits for an `ensure` that can measure. */
  it('leaves a stamp owed unpaid without a hasher, clears the facts it cannot back, and pays nothing onto a same-size replacement', async () => {
    const w = await world()
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    w.stamp.mockRejectedValueOnce(new Error('the record would not take it'))
    expect(await w.cache.ensure('book:a')).toBe(true)
    /* Replaced behind the index's back, under the same name, at the SAME size. */
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000, 9))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(1)
    expect(w.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.jpg', size: 1000, usedAt: expect.any(Number), owed: true })
    /* And still owed on the next touch: nothing was measured. */
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(1)
    expect((await w.cache.index())['book:a']?.owed).toBe(true)
  })

  it('pays a stamp owed from a FRESH measurement of a replaced file — the file that is there, not the digest that was', async () => {
    const w = await world({ hasher: true })
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    w.stamp.mockRejectedValueOnce(new Error('the record would not take it'))
    expect(await w.cache.ensure('book:a')).toBe(true)
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1200, 9))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenLastCalledWith('book:a', { name: 'cover.jpg', size: 1200, hash: await fakeBlobHash(jacket(1200, 9)) })
    expect(w.unstamp).not.toHaveBeenCalled()
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.jpg', size: 1200, usedAt: expect.any(Number) })
  })

  /* THE TRACKED JACKET GONE AND ITS LEGACY SIBLING HERE. The entry used to
     take the new name quietly: the record kept describing the old file, and
     the new one was never measured. */
  it('takes the old name’s facts off and stamps the file under the new name when the tracked jacket is replaced by its sibling', async () => {
    const w = await world({ hasher: true })
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    w.fs.store.delete('books/book_a/cover.jpg')
    await w.fs.writeFile('books/book_a/cover.webp', jacket(700, 5))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
    expect(w.stamp).toHaveBeenLastCalledWith('book:a', { name: 'cover.webp', size: 700, hash: await fakeBlobHash(jacket(700, 5)) })
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.webp', size: 700, usedAt: expect.any(Number) })
    /* Without a hasher: the old facts go, the new file is tracked as owed, and nothing false is stamped. */
    const bare = await world()
    await bare.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await bare.cache.ensure('book:a')).toBe(true)
    bare.fs.store.delete('books/book_a/cover.jpg')
    await bare.fs.writeFile('books/book_a/cover.webp', jacket(700, 5))
    expect(await bare.cache.ensure('book:a')).toBe(true)
    expect(bare.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
    expect(bare.stamp).toHaveBeenCalledTimes(1)
    expect((await bare.cache.index())['book:a']).toEqual({ name: 'cover.webp', size: 700, usedAt: expect.any(Number), owed: true })
  })

  /* THE FACTS GO WITH THE FILE. A jacket the cache was tracking that is gone
     behind its back — a folder replaced or restored — leaves a record whose
     facts name a digest this device cannot serve; the cache says so when it
     finds out, and only for a jacket it was tracking. */
  it('unstamps a tracked jacket it finds missing — before any fetch — and says nothing for a book it never tracked', async () => {
    const w = await world()
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(1)
    /* A book the cache never tracked is not the cache's to speak for. */
    expect(await w.cache.ensure('book:none')).toBe(false)
    expect(w.unstamp).not.toHaveBeenCalled()
    /* Gone behind the index's back. The facts are cleared the moment the
       cache finds out, BEFORE the shelf is asked again — and the jacket that
       then lands is stamped afresh, so the record ends up describing the
       file that is actually there. */
    w.fs.store.delete('books/book_a/cover.jpg')
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.unstamp).toHaveBeenCalledTimes(1)
    expect(w.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
    expect(w.stamp).toHaveBeenCalledTimes(2)
    expect(w.unstamp.mock.invocationCallOrder[0]).toBeLessThan(w.stamp.mock.invocationCallOrder[1]!)
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

  /* OLDEST FIRST, AND ONLY UNTIL IT FITS. Three half-megabyte jackets under a
   * one-megabyte cap: the oldest goes, and the cache is then exactly at its
   * cap — which is within it, so the other two stay. Written newest first, so
   * an eviction that took the index's own order would take the wrong one. */
  it('evicts oldest first, and stops as soon as the cache is within its cap', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    const half = 512 * 1024
    for (const folder of ['book_new', 'book_mid', 'book_old']) await w.fs.writeFile(`books/${folder}/cover.jpg`, jacket(half))
    await w.fs.writeFile(
      COVER_INDEX_PATH,
      new TextEncoder().encode(
        JSON.stringify({
          'book:new': { name: 'cover.jpg', size: half, usedAt: 30 },
          'book:mid': { name: 'cover.jpg', size: half, usedAt: 20 },
          'book:old': { name: 'cover.jpg', size: half, usedAt: 10 },
        }),
      ),
    )
    await w.cache.evict()
    expect(Object.keys(await w.cache.index()).sort()).toEqual(['book:mid', 'book:new'])
    expect(w.fs.store.has('books/book_old/cover.jpg')).toBe(false)
    expect(w.fs.store.has('books/book_mid/cover.jpg')).toBe(true)
    expect(w.fs.store.has('books/book_new/cover.jpg')).toBe(true)
    expect(await w.cache.totalBytes()).toBe(2 * half)
  })

  /* THE JUST-FETCHED COVER IS EXEMPT UP TO AND INCLUDING THE CAP. One exactly
   * the cap's size is affordable; the entry that goes instead is the other
   * one, however recently its clock says it was used. */
  it('keeps a fetched cover exactly the size of the cap, and evicts the other entry instead', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    await w.fs.writeFile('books/book_later/cover.jpg', jacket(100))
    /* A clock from another device, far ahead of this one's. */
    await w.fs.writeFile(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ 'book:later': { name: 'cover.jpg', size: 100, usedAt: 1e15 } })))
    await w.serve('book_a', 'cover.jpg', jacket(1024 * 1024))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(Object.keys(await w.cache.index())).toEqual(['book:a'])
    expect(w.fs.store.has('books/book_a/cover.jpg')).toBe(true)
    expect(w.fs.store.has('books/book_later/cover.jpg')).toBe(false)
  })

  /* ⚠️ **A ROW THAT NAMES THE BOOK'S OWN BYTES IS NOT A JACKET, AND EVICTION
   * DELETED THEM.** `content.epub` is in the closed set the kernel's remove
   * primitive accepts — it is how a download is reclaimed — so a covers index
   * row naming it (a hand edit, a damaged file) sent this jackets-only cache to
   * delete the book itself. The name is checked where the row is read now. */
  it('never deletes a book’s own bytes for an index row that names them', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    await w.fs.writeFile('books/book_x/content.epub', jacket(2 * 1024 * 1024))
    await w.fs.writeFile(COVER_INDEX_PATH, new TextEncoder().encode(JSON.stringify({ 'book:x': { name: 'content.epub', size: 2 * 1024 * 1024, usedAt: 1 } })))
    await w.cache.evict()
    expect(w.fs.store.has('books/book_x/content.epub')).toBe(true)
    expect(await w.cache.index()).toEqual({})
  })

  /* ⚠️ **AND A ROW THAT NAMES NO REMOVABLE FILE STAYED FOREVER, OVER THE CAP.**
   * The primitive refuses such a name with a plain `Error`, not a refusal, so
   * the branch meant to drop the row never ran: it stayed tracked, its size
   * kept the total over the cap, and every pass deleted the real jackets
   * trying to get under it. */
  it('does not evict real jackets on account of a row that names no jacket', async () => {
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    await w.fs.writeFile(
      COVER_INDEX_PATH,
      new TextEncoder().encode(
        JSON.stringify({
          'book:odd': { name: 'notes.txt', size: 2 * 1024 * 1024, usedAt: 1 },
          'book:a': { name: 'cover.jpg', size: 1000, usedAt: 2 },
        }),
      ),
    )
    await w.cache.evict()
    expect(w.fs.store.has('books/book_a/cover.jpg')).toBe(true)
    expect(Object.keys(await w.cache.index())).toEqual(['book:a'])
  })

  it('clears the facts of an evicted jacket whose file was already gone — the primitive’s no-op clears nothing', async () => {
    /* The kernel's `removeBlob` takes the facts with a file it deletes; a
       file already gone resolves as the documented no-op and leaves them,
       and the record kept describing a jacket this device could not serve. */
    const w = await world()
    w.services.settings.set(COVER_CAP_SETTING, 1)
    const size = Math.round(0.6 * 1024 * 1024)
    await w.serve('book_a', 'cover.jpg', jacket(size, 1))
    await w.serve('book_b', 'cover.jpg', jacket(size, 2))
    await w.cache.ensure('book:a')
    /* Gone behind the index's back, before the eviction its turn. */
    w.fs.store.delete('books/book_a/cover.jpg')
    w.unstamp.mockClear()
    await w.cache.ensure('book:b')
    expect(Object.keys(await w.cache.index()).sort()).toEqual(['book:b'])
    expect(w.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
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

  /* ⚠️ **AND JSON OF THE WRONG SHAPE IS UNREADABLE TOO — IT USED TO ANSWER
     `{}`.** Bytes that are not JSON already threw out of the read and were
     re-raised because the file exists; a document that parsed but was not an
     index took the swallowing path instead, and `writeIndex` then persisted
     that emptiness. That is the same permanent forgetting the case above
     exists to prevent, through the door beside it. Found by the 2026-09-13
     audit. */
  it.each([
    ['JSON null', 'null'],
    ['a bare number', '42'],
    ['a bare string', '"covers"'],
    ['a bare boolean', 'true'],
  ])('refuses an index that is %s, in its own words, and leaves its bytes where they are', async (_name, raw) => {
    const w = await world()
    await w.fs.writeFile(COVER_INDEX_PATH, new TextEncoder().encode(raw))
    const cause = await w.cache.index().then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('the covers index is not an object')
    await w.cache.evict().catch(() => {})
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH) ?? new Uint8Array())).toBe(raw)
  })

  /* THE PATH IS WHERE EVERY EARLIER BUILD WROTE IT: another name reads as an
   * empty index, and every tracked jacket stops counting toward the cap. */
  it('reads the index from sync/covers.json', async () => {
    const w = await world()
    await w.fs.writeFile('sync/covers.json', new TextEncoder().encode(JSON.stringify({ 'book:a': { name: 'cover.jpg', size: 10, usedAt: 1 } })))
    expect(await w.cache.index()).toEqual({ 'book:a': { name: 'cover.jpg', size: 10, usedAt: 1 } })
  })

  it('refuses an index that is not an object, and leaves its bytes where they are', async () => {
    const w = await world()
    const raw = '[1,2]'
    await w.fs.writeFile(COVER_INDEX_PATH, new TextEncoder().encode(raw))

    const cause = await w.cache.index().then(
      () => null,
      (thrown: unknown) => thrown,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/the covers index is not an object/u)

    /* AND NOTHING WRITES OVER IT. `ensure` reads the index before it records,
       so a refused read must leave the file exactly as it found it. */
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    await w.cache.ensure('book:a').catch(() => {})
    expect(new TextDecoder().decode(w.fs.store.get(COVER_INDEX_PATH) ?? new Uint8Array())).toBe(raw)
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
          sizeText: { name: 'cover.jpg', size: '10', usedAt: 1 },
          noStamp: { name: 'cover.jpg', size: 10 },
          stampText: { name: 'cover.jpg', size: 10, usedAt: '1' },
          noName: { size: 10, usedAt: 1 },
          numberName: { name: 7, size: 10, usedAt: 1 },
          notAJacket: { name: 'notes.txt', size: 10, usedAt: 1 },
          theBookItself: { name: 'content.epub', size: 10, usedAt: 1 },
          notAnObject: 7,
          nothing: null,
          empty: { name: 'cover.webp', size: 0, usedAt: 3 },
          alsoGood: { name: 'cover.jpg', size: 20, usedAt: 2 },
        }),
      ),
    )
    expect(Object.keys(await w.cache.index()).sort()).toEqual(['alsoGood', 'empty', 'good'])
  })

  /* WRITTEN AS TEXT: `JSON.stringify` spells Infinity as `null`, and `1e999`
   * is how a file can hold a stamp that parses as Infinity. */
  it('drops an entry whose stamp is not finite', async () => {
    const w = await world()
    await w.fs.writeFile(
      COVER_INDEX_PATH,
      new TextEncoder().encode('{"endless":{"name":"cover.jpg","size":10,"usedAt":1e999},"good":{"name":"cover.jpg","size":10,"usedAt":1}}'),
    )
    expect(Object.keys(await w.cache.index())).toEqual(['good'])
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

  /* ⚠️ **AND THE COPY `ensure` WORKS ON LOST THAT, ONE LINE LATER.** The read
   * built a null-prototype index and `ensure` spread it into `{}`, so a book
   * named `toString` was "in" the index before anything tracked it — and was
   * told its facts were gone — and a `__proto__` jacket that landed ran the
   * prototype setter instead of becoming an entry, so it was never tracked. */
  it('tracks a __proto__ jacket it fetches, and speaks for no toString it never tracked', async () => {
    const w = await world()
    expect(await w.cache.ensure('toString')).toBe(false)
    expect(w.unstamp).not.toHaveBeenCalled()
    await w.serve(blobFolderOf('__proto__'), 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('__proto__')).toBe(true)
    expect(Object.keys(await w.cache.index())).toEqual(['__proto__'])
    expect(w.unstamp).not.toHaveBeenCalled()
  })

  /* THE SIZE PORT, NOT A READ. A jacket is accepted from a peer, so its size
   * is not this device's decision, and reading it into the webview to take
   * its length is what the port exists to avoid. And a jacket already
   * measured is not measured again: the touch path stays one read cheap. */
  it('measures a discovered jacket through the size port, once, without reading it', async () => {
    const measured: string[] = []
    const w = await world({
      options: {
        bytesAt: async (path) => {
          measured.push(path)
          return w.fs.store.get(path)?.length ?? null
        },
      },
    })
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    const real = w.fs.readFile.bind(w.fs)
    w.fs.readFile = async (path: string) => {
      if (path.endsWith('cover.jpg')) throw new Error('read the jacket')
      return real(path)
    }
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect((await w.cache.index())['book:a']?.size).toBe(1000)
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(measured).toEqual(['books/book_a/cover.jpg'])
  })

  /* A SIZE NOBODY CAN GIVE LEAVES THE ENTRY EXACTLY AS IT WAS — absent stays
   * absent, and a jacket tracked under its sibling's name keeps that entry,
   * with nothing said about facts nobody has measured. */
  it('leaves the entry as it was when the size port cannot say', async () => {
    let sizes = true
    const w = await world({
      options: { bytesAt: async (path) => (sizes ? (w.fs.store.get(path)?.length ?? null) : null) },
    })
    await w.fs.writeFile('books/book_new/cover.jpg', jacket(1000))
    sizes = false
    expect(await w.cache.ensure('book:new')).toBe(true)
    expect(await w.cache.index()).toEqual({})

    sizes = true
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    const held = (await w.cache.index())['book:a']
    w.fs.store.delete('books/book_a/cover.jpg')
    await w.fs.writeFile('books/book_a/cover.webp', jacket(700))
    sizes = false
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect((await w.cache.index())['book:a']).toEqual(held)
    expect(w.unstamp).not.toHaveBeenCalled()
  })

  /* A HASHER THAT WILL NOT ANSWER IS NO MEASUREMENT: the debt stands, and the
   * record is told to carry no facts for the file nobody could measure. */
  it('leaves a stamp owed unpaid when the hasher will not answer', async () => {
    const w = await world({
      options: {
        hashes: () => ({
          hashFile: () => Promise.reject(new Error('the hasher is busy')),
        }),
      },
    })
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    w.stamp.mockRejectedValueOnce(new Error('the record would not take it'))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(w.stamp).toHaveBeenCalledTimes(1)
    expect(w.unstamp).toHaveBeenCalledWith('book:a', 'cover.jpg')
    expect((await w.cache.index())['book:a']?.owed).toBe(true)
  })

  /* ⚠️ **HOW A HASHER FAILS IS NOT A DECISION ABOUT WHAT IS KEPT.** A port that
     THROWS where another rejects is the same "would not answer" — and it took
     the whole `ensure` down with it: nothing unstamped, nothing written, the
     record left carrying facts for a file this device could not measure, while
     the identical failure delivered as a rejection cleared them and carried on.
     Found by the 2026-09-14 review. The same failure is run both ways here. */
  it('treats a hasher that throws exactly as one that rejects', async () => {
    const offline = () => new Error('the hasher is offline')
    const failing = {
      throws: () => {
        throw offline()
      },
      rejects: () => Promise.reject(offline()),
    }
    const ran = async (how: 'throws' | 'rejects') => {
      const w = await world({ options: { hashes: () => ({ hashFile: failing[how] }) } })
      await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
      await w.fs.writeFile(
        COVER_INDEX_PATH,
        new TextEncoder().encode(JSON.stringify({ 'book:a': { name: 'cover.jpg', size: 1000, usedAt: 1, owed: true } })),
      )
      const answered: unknown = await w.cache.ensure('book:a').then(
        (one) => one,
        (thrown: unknown) => `ensure rejected: ${String(thrown)}`,
      )
      return { answered, unstamped: w.unstamp.mock.calls, entry: (await w.cache.index())['book:a'] }
    }

    const thrown = await ran('throws')
    const rejected = await ran('rejects')
    expect(thrown).toEqual(rejected)
    /* And what both do: say the cover is here, take the facts off the record,
       and write the entry back still owing its stamp — `usedAt` moved off the
       1 the fixture wrote, which is the write. */
    expect(thrown.answered).toBe(true)
    expect(thrown.unstamped).toEqual([['book:a', 'cover.jpg']])
    expect(thrown.entry).toEqual({ name: 'cover.jpg', size: 1000, usedAt: expect.any(Number), owed: true })
    expect(thrown.entry?.usedAt).not.toBe(1)
  })

  /* A MEASUREMENT NOBODY COULD TAKE WRITES NOTHING, and that is a change
     rather than a tidy-up: this used to write the index back unchanged, so an
     index write that failed turned "the jacket could not be MEASURED" into
     "`ensure` failed". There is nothing to save, so nothing is saved. */
  it('writes nothing when the size port cannot say, whatever the index writer would do', async () => {
    const w = await world({ options: { bytesAt: async () => null } })
    await w.fs.writeFile('books/book_a/cover.jpg', jacket(1000))
    const real = w.fs.writeFile.bind(w.fs)
    const wrote: string[] = []
    w.fs.writeFile = async (path: string, bytes: Uint8Array) => {
      wrote.push(path)
      if (path.startsWith(COVER_INDEX_PATH)) throw new Error('ENOSPC')
      return real(path, bytes)
    }
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect(wrote).toEqual([])
    expect(await w.cache.index()).toEqual({})
  })

  /* NOBODY TO TELL IS A COMPOSITION, NOT A CRASH. Every path that tells the
   * record something — a sibling replacing the jacket, a debt it cannot pay, a
   * jacket found missing, an eviction — runs to the end without a record. */
  it('runs every path that would tell the record something, with no record to tell', async () => {
    const w = await world({ tellNobody: true })
    w.services.settings.set(COVER_CAP_SETTING, 1)
    const size = Math.round(0.6 * 1024 * 1024)
    await w.serve('book_a', 'cover.jpg', jacket(1000))
    expect(await w.cache.ensure('book:a')).toBe(true)
    /* Replaced by its sibling, with no hasher: the old name's facts, then the debt. */
    w.fs.store.delete('books/book_a/cover.jpg')
    await w.fs.writeFile('books/book_a/cover.webp', jacket(700))
    expect(await w.cache.ensure('book:a')).toBe(true)
    expect((await w.cache.index())['book:a']).toEqual({ name: 'cover.webp', size: 700, usedAt: expect.any(Number), owed: true })
    /* Found missing, and fetched again. */
    w.fs.store.delete('books/book_a/cover.webp')
    expect(await w.cache.ensure('book:a')).toBe(true)
    /* Evicted. */
    await w.serve('book_b', 'cover.jpg', jacket(size, 2))
    await w.serve('book_c', 'cover.jpg', jacket(size, 3))
    expect(await w.cache.ensure('book:b')).toBe(true)
    expect(await w.cache.ensure('book:c')).toBe(true)
    expect(Object.keys(await w.cache.index())).toEqual(['book:c'])
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
    for (const bad of [1e300, Number.MAX_VALUE, 2 ** 53, -1, 0, 0.5, COVER_CAP_MAX_MB + 1]) {
      w.services.settings.set(COVER_CAP_SETTING, bad)
      expect(w.services.settings.get(COVER_CAP_SETTING), String(bad)).toBe(before)
    }
    /* An ordinary number still takes, and so does the bound itself. */
    w.services.settings.set(COVER_CAP_SETTING, 50)
    expect(w.services.settings.get(COVER_CAP_SETTING)).toBe(50)
    w.services.settings.set(COVER_CAP_SETTING, COVER_CAP_MAX_MB)
    expect(w.services.settings.get(COVER_CAP_SETTING)).toBe(COVER_CAP_MAX_MB)
  })
})
