import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import { INDEX_DIRTY_FILE, INDEX_FILE, loadShelf, readDirtyMarker, type IndexFs, type IndexedBook } from './bookIndex'
import { fakeFs } from './indexFsFake.testkit'
import { INDEX_FLUSH_MS, createLibrary } from './libraryStore'
import { writeQueue } from './writeQueue'

/**
 * A POSITION DOES NOT REWRITE THE INDEX (phase 20, D3 and D4).
 *
 * Every position save used to rewrite `index.json` whole — ~1 MB every two
 * seconds at 2 000 books, against a header that promised "a few hundred
 * bytes" — and nothing in the write path synced anything, so a power cut
 * after a rename could leave an empty `book.json` that `scanFolder` skips.
 * The tick now writes the record at the barrier level and puts the book on a
 * dirty list; the index is rewritten on a throttle, at quit, on blur, and
 * `loadShelf` re-reads the listed records before trusting the cache.
 *
 * The two Codex cases (round 1 #3, round 2 #4) are the acceptance: a crash
 * between a tick and the flush, and the interleaving that refuted a one-bit
 * marker — a flush that captured the world, a tick that landed while it was
 * writing, and a marker that must survive it.
 */

const row = (bookId: string, title = bookId): IndexedBook => ({ bookId, title, author: '', hasContent: true })

const seeded = (ids: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    ids.flatMap((id) => [
      [`${BOOKS_DIR}/${id}/book.json`, JSON.stringify({ title: id, author: '' })],
      [`${BOOKS_DIR}/${id}/content.epub`, 'B'],
    ]),
  )

const recordOn = (fs: ReturnType<typeof fakeFs>, id: string): { position?: string } =>
  JSON.parse(new TextDecoder().decode(fs.store.get(`${BOOKS_DIR}/${id}/book.json`)!)) as { position?: string }

const indexOn = (fs: ReturnType<typeof fakeFs>): { books: IndexedBook[] } | null => {
  const bytes = fs.store.get(INDEX_FILE)
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as { books: IndexedBook[] }) : null
}

function world(ids: readonly string[]) {
  const fs = fakeFs(seeded(ids))
  const queue = writeQueue()
  const library = createLibrary({ fs, queue, initial: ids.map((id) => row(id)) })
  return { fs, queue, library }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a position tick', () => {
  it('writes the record at the barrier level and the index not at all, and the marker once per period', async () => {
    const { fs, queue, library } = world(['book_a', 'book_b'])
    await library.rememberPosition('book_a', 'p1', 0.1)
    await library.rememberPosition('book_a', 'p2', 0.2)
    await library.rememberPosition('book_a', 'p3', 0.3)
    await queue.idle()

    const records = fs.synced().filter((one) => one.path === `${BOOKS_DIR}/book_a/book.json`)
    expect(records.map((one) => one.level)).toEqual(['barrier', 'barrier', 'barrier'])
    expect(fs.writes(INDEX_FILE)).toBe(0)
    /* ONE marker write for the period, at full, however many ticks. */
    const markers = fs.synced().filter((one) => one.path === INDEX_DIRTY_FILE)
    expect(markers).toEqual([{ path: INDEX_DIRTY_FILE, level: 'full', kind: 'write' }])
    expect(await readDirtyMarker(fs)).toMatchObject({ version: 1, books: ['book_a'] })
    expect(recordOn(fs, 'book_a').position).toBe('p3')
    expect(library.getSnapshot().find((one) => one.bookId === 'book_a')?.position).toBe('p3')
  })

  it('is rewritten into the index by the throttle, which then clears the marker', async () => {
    const { fs, queue, library } = world(['book_a'])
    await library.rememberPosition('book_a', 'p1', 0.1)
    expect(indexOn(fs)).toBeNull()

    await vi.advanceTimersByTimeAsync(INDEX_FLUSH_MS)
    await queue.idle()

    expect(indexOn(fs)?.books[0]?.position).toBe('p1')
    expect(fs.synced().filter((one) => one.path === INDEX_FILE).map((one) => one.level)).toEqual(['full'])
    expect(fs.store.has(INDEX_DIRTY_FILE)).toBe(false)
  })

  it('is rewritten into the index by a structural write, at full', async () => {
    const { fs, queue, library } = world(['book_a', 'book_b'])
    await library.rememberPosition('book_a', 'p1', 0.1)
    await library.tag('book_b', 'Sea')
    await queue.idle()

    const index = indexOn(fs)!
    expect(index.books.find((one) => one.bookId === 'book_a')?.position).toBe('p1')
    expect(index.books.find((one) => one.bookId === 'book_b')?.tags).toEqual(['Sea'])
    expect(fs.synced().filter((one) => one.path === INDEX_FILE).map((one) => one.level)).toEqual(['full'])
    expect(fs.store.has(INDEX_DIRTY_FILE)).toBe(false)
  })

  it('is flushed on demand, once for two callers, and a clean shelf flushes nothing', async () => {
    const { fs, queue, library } = world(['book_a'])
    await library.rememberPosition('book_a', 'p1', 0.1)
    await Promise.all([library.flushIndex(), library.flushIndex()])
    await queue.idle()
    expect(fs.writes(INDEX_FILE)).toBe(1)
    expect(fs.store.has(INDEX_DIRTY_FILE)).toBe(false)

    await library.flushIndex()
    await queue.idle()
    expect(fs.writes(INDEX_FILE)).toBe(1)
  })
})

describe('the next launch', () => {
  /* Codex, round 1 #3: the index says P1, `book.json` says P2, the folder set
     is unchanged, the marker is present. The cache would be trusted on the
     folder check alone; the marker is what makes it re-read the record. */
  it('re-reads a book the marker names before trusting the cache — index P1, record P2, shelf P2', async () => {
    const { fs, queue, library } = world(['book_a', 'book_b'])
    await library.rememberPosition('book_a', 'p1', 0.1)
    await library.flushIndex()
    await queue.idle()
    expect(indexOn(fs)?.books.find((one) => one.bookId === 'book_a')?.position).toBe('p1')

    await library.rememberPosition('book_a', 'p2', 0.2)
    await queue.idle()
    /* The crash: no flush. The index still says P1. */
    expect(indexOn(fs)?.books.find((one) => one.bookId === 'book_a')?.position).toBe('p1')

    const shelf = await loadShelf(fs)
    expect(shelf.rescanned).toBe(false)
    expect(shelf.books.find((one) => one.bookId === 'book_a')?.position).toBe('p2')
    expect(shelf.books.find((one) => one.bookId === 'book_a')?.hasContent).toBe(true)
    /* And the launch that read it wrote it down, so the next one need not. */
    expect(indexOn(fs)?.books.find((one) => one.bookId === 'book_a')?.position).toBe('p2')
    expect(fs.store.has(INDEX_DIRTY_FILE)).toBe(false)
  })

  /* Codex, round 2 #4 — the interleaving that refuted a one-bit marker. P2
     marks generation 1; a structural flush serialises P2 and STALLS before its
     rename; P3 lands in `book.json` and bumps the generation; the flush
     resumes and installs P2. The marker must REMAIN — the flush's world is
     older than the record — so a crash before the next timer still re-reads
     the book, and the shelf comes up at P3. */
  it('leaves the marker standing when a tick lands while the index is being written', async () => {
    const ids = ['book_a']
    const fs = fakeFs(seeded(ids))
    let gate: (() => void) | null = null
    const stalled = new Promise<void>((resolve) => {
      gate = resolve
    })
    let stalls = 0
    const gated: IndexFs = {
      ...fs,
      rename: async (from, to) => {
        if (to === INDEX_FILE && stalls++ === 0) await stalled
        await fs.rename(from, to)
      },
    }
    const queue = writeQueue()
    const library = createLibrary({ fs: gated, queue, initial: ids.map((id) => row(id)) })

    await library.rememberPosition('book_a', 'p2', 0.2)
    const flush = library.flushIndex()
    /* Let the flush serialise P2 and reach the stalled rename. */
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stalls).toBe(1)

    await library.rememberPosition('book_a', 'p3', 0.3)
    expect(recordOn(fs, 'book_a').position).toBe('p3')

    gate!()
    await flush
    await queue.idle()

    /* The index installed the older world, and the marker says so. */
    expect(indexOn(fs)?.books[0]?.position).toBe('p2')
    expect(await readDirtyMarker(fs)).toMatchObject({ books: ['book_a'] })

    /* The crash before the next timer. */
    const shelf = await loadShelf(fs)
    expect(shelf.books[0]?.position).toBe('p3')
  })
})

describe('what a minute of reading writes', () => {
  /* The measurement, over the fake: thirty ticks — a minute at one every two
     seconds — of a 2 000-book shelf, once through the structural path a
     position save used to take (`patch`, which still rewrites the index) and
     once through the tick. The numbers are printed so the report can quote
     them; the assertion is the ratio, which is the claim. */
  it('is the records and one marker, not thirty copies of the index', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `book_${i}`)
    const fs = fakeFs(seeded(ids))
    let bytes = 0
    const counted: IndexFs = {
      ...fs,
      writeFile: async (path, data) => {
        bytes += data.byteLength
        await fs.writeFile(path, data)
      },
    }
    const queue = writeQueue()
    const library = createLibrary({ fs: counted, queue, initial: ids.map((id) => row(id)) })

    bytes = 0
    for (let tick = 0; tick < 30; tick += 1) {
      await library.patch('book_7', { position: { position: `structural-${tick}`, progress: tick / 30 } })
    }
    await queue.idle()
    const before = bytes

    bytes = 0
    for (let tick = 0; tick < 30; tick += 1) {
      await library.rememberPosition('book_7', `tick-${tick}`, tick / 30)
    }
    await queue.idle()
    const after = bytes
    await library.flushIndex()
    await queue.idle()

    console.info(`index write-through: ${before} bytes for 30 saves; dirty list: ${after} bytes for 30 ticks`)
    expect(before).toBeGreaterThan(30 * 100_000)
    expect(after).toBeLessThan(before / 100)
  })
})
