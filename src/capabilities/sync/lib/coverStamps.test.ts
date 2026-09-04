import { describe, expect, it } from 'vitest'
import { createKernelServices, folderOf, recordPath, type IndexFs } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { stampMeasured, unstampUnlessVerified } from './coverStamps'

/**
 * The facts describe the file, or they are not written — and they are taken
 * back only when the file they describe is not the one there. Over the real
 * kernel library, so the lane and the record write are the production ones.
 */

const BOOK = 'book:abc'
const FOLDER = folderOf(BOOK)
const jacket = (fill: string) => new TextEncoder().encode(fill)

/** A hasher over the fake fs: the digest of the bytes that are there. */
function hasherOver(fs: ReturnType<typeof fakeFs>) {
  return {
    hashFile: async (segment: string, name: string) => {
      const bytes = fs.store.get(`books/${segment}/${name}`)
      if (!bytes) throw new Error(`no ${name}`)
      return { blake3: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64), size: bytes.length }
    },
  }
}

function world(over: { readonly hasher?: boolean } = {}) {
  const fs = fakeFs({ [recordPath(BOOK)]: JSON.stringify({ title: 'A', author: 'B' }) })
  const services = createKernelServices({
    fs: fs as unknown as IndexFs,
    storage: null,
    initialBooks: [{ bookId: BOOK, title: 'A', author: 'B', hasContent: true }],
  })
  const hasher = hasherOver(fs)
  const deps = { library: services.library, hashes: () => (over.hasher === false ? null : hasher) }
  const facts = () => services.library.getSnapshot().find((one) => one.bookId === BOOK)?.coverFacts
  return { fs, services, deps, hasher, facts }
}

describe('stamping a jacket that landed', () => {
  it('writes the measurement taken in the lane, not the offer — a replaced file gets its own digest, a missing one nothing', async () => {
    const w = world()
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('landed'))
    const offered = { name: 'cover.jpg' as const, size: 6, hash: 'ab'.repeat(32) }
    await stampMeasured(w.deps, BOOK, offered)
    await w.services.drain()
    const own = await w.hasher.hashFile('book_abc', 'cover.jpg')
    expect(w.facts()).toEqual({ name: 'cover.jpg', size: 6, hash: own.blake3 })
    /* Replaced under the same name before the stamp's turn: measured as itself. */
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('replacement'))
    await stampMeasured(w.deps, BOOK, offered)
    await w.services.drain()
    const fresh = await w.hasher.hashFile('book_abc', 'cover.jpg')
    expect(w.facts()).toEqual({ name: 'cover.jpg', size: 11, hash: fresh.blake3 })
    /* Gone before the stamp's turn: nothing is written. */
    w.fs.store.delete(`${FOLDER}/cover.jpg`)
    await unstampUnlessVerified(w.deps, BOOK, 'cover.jpg')
    await stampMeasured(w.deps, BOOK, offered)
    await w.services.drain()
    expect(w.facts()).toBeUndefined()
  })

  it('stamps the verified transfer’s facts by presence alone when the composition has no hasher', async () => {
    const w = world({ hasher: false })
    const offered = { name: 'cover.jpg' as const, size: 6, hash: 'ab'.repeat(32) }
    await stampMeasured(w.deps, BOOK, offered)
    await w.services.drain()
    expect(w.facts()).toBeUndefined()
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('landed'))
    await stampMeasured(w.deps, BOOK, offered)
    await w.services.drain()
    expect(w.facts()).toEqual(offered)
  })
})

describe('taking a jacket’s facts back', () => {
  it('keeps facts that describe the file there, clears facts that do not — a replacement landed but not yet stamped — and clears for a file gone', async () => {
    const w = world()
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('landed'))
    await stampMeasured(w.deps, BOOK, { name: 'cover.jpg', size: 6, hash: 'ab'.repeat(32) })
    await w.services.drain()
    const stamped = w.facts()
    /* Kept: the file is the one the facts describe. */
    await unstampUnlessVerified(w.deps, BOOK, 'cover.jpg')
    await w.services.drain()
    expect(w.facts()).toEqual(stamped)
    /* Cleared: a replacement landed under the name and nothing has stamped it yet — the old digest must not stand for it. */
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('replacement'))
    await unstampUnlessVerified(w.deps, BOOK, 'cover.jpg')
    await w.services.drain()
    expect(w.facts()).toBeUndefined()
    /* Cleared: gone. */
    await stampMeasured(w.deps, BOOK, { name: 'cover.jpg', size: 11, hash: 'cd'.repeat(32) })
    await w.services.drain()
    expect(w.facts()).toBeDefined()
    w.fs.store.delete(`${FOLDER}/cover.jpg`)
    await unstampUnlessVerified(w.deps, BOOK, 'cover.jpg')
    await w.services.drain()
    expect(w.facts()).toBeUndefined()
  })

  it('takes only the named jacket’s facts, and clears facts it cannot verify without a hasher', async () => {
    const w = world({ hasher: false })
    w.fs.store.set(`${FOLDER}/cover.jpg`, jacket('landed'))
    await stampMeasured(w.deps, BOOK, { name: 'cover.jpg', size: 6, hash: 'ab'.repeat(32) })
    await w.services.drain()
    /* Another name's facts are not this call's to take. */
    await unstampUnlessVerified(w.deps, BOOK, 'cover.webp')
    await w.services.drain()
    expect(w.facts()).toEqual({ name: 'cover.jpg', size: 6, hash: 'ab'.repeat(32) })
    /* Present, but nothing can say it is the file the facts describe: cleared, so nothing false is advertised. */
    await unstampUnlessVerified(w.deps, BOOK, 'cover.jpg')
    await w.services.drain()
    expect(w.facts()).toBeUndefined()
  })
})
