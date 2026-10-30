import { describe, expect, it } from 'vitest'
import { createKernelServices, readBook, type BookRecord } from '../../../kernel'
import { createBackfill } from './backfill'
import { crashableFs, memoryStorage } from './journalFs.testkit'

/**
 * WI-C.3 — the lazy contentHash backfill: a copy with bytes and no hash is
 * stamped from `hashFile` in small batches; hashed and byteless copies are
 * left alone; a copy whose hash cannot be computed is skipped, not retried
 * in a loop, and does not sink the batch.
 */

const HASH = 'ab'.repeat(32)

async function world() {
  const fs = crashableFs()
  const storage = memoryStorage()
  const services = createKernelServices({ fs, storage })
  const rec = (title: string): BookRecord => ({ title, author: 'A', addedAt: 1, ext: 'epub' })
  const seed = async (book: string, withBytes: boolean, withHash = false) => {
    await services.library.add(book, withHash ? { ...rec(book), contentHash: HASH } : rec(book))
    if (withBytes) {
      const folder = `book_${book.slice('book:'.length)}`
      await fs.writeFile(`books/${folder}/content.epub`, new TextEncoder().encode(book))
      await services.library.refreshContent(book)
    }
  }
  return { fs, services, seed }
}

describe('the contentHash backfill', () => {
  it('stamps unhashed copies in batches and converges to zero', async () => {
    const w = await world()
    await w.seed('book:a', true)
    await w.seed('book:b', true)
    await w.seed('book:c', false) // no bytes — nothing to hash
    await w.seed('book:d', true, true) // already hashed — left alone

    const hashed: string[] = []
    const backfill = createBackfill({
      services: w.services,
      hashFile: async (folder, name) => {
        hashed.push(`${folder}/${name}`)
        return { blake3: 'cd'.repeat(32), size: 6 }
      },
      batch: 1,
    })
    expect(await backfill.runOnce()).toBe(1)
    expect(await backfill.runOnce()).toBe(1)
    expect(await backfill.runOnce()).toBe(0) // done
    expect(hashed.sort()).toEqual(['book_a/content.epub', 'book_b/content.epub'])
    expect((await readBook(w.fs, 'book:a'))?.contentHash).toBe('cd'.repeat(32))
    expect((await readBook(w.fs, 'book:d'))?.contentHash).toBe(HASH)
    expect((await readBook(w.fs, 'book:c'))?.contentHash).toBeUndefined()
  })

  it('a failing hash skips the book without sinking the pass', async () => {
    const w = await world()
    await w.seed('book:bad', true)
    await w.seed('book:good', true)
    let calls = 0
    const backfill = createBackfill({
      services: w.services,
      hashFile: async (folder) => {
        calls += 1
        if (folder === 'book_bad') throw new Error('no such file')
        return { blake3: 'ef'.repeat(32), size: 6 }
      },
    })
    expect(await backfill.runOnce()).toBe(1) // good stamped, bad skipped
    expect(await backfill.runOnce()).toBe(0) // bad not retried
    expect(calls).toBe(2)
    expect((await readBook(w.fs, 'book:good'))?.contentHash).toBe('ef'.repeat(32))
    expect((await readBook(w.fs, 'book:bad'))?.contentHash).toBeUndefined()
  })
})
