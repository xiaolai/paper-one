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

describe('the reader’s own opinion, through `patch` — WI-23.B3', () => {
  it('moves status and finished together, under one stamp, from either verb', async () => {
    const { library } = world(['book_1'])
    await library.patch('book_1', { status: 'finished' })
    let held = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(held.status?.state).toBe('finished')
    expect(held.finished).toBe(true)
    expect(held.finishedAt).toBe(held.status?.at)

    /* The menu's verb: unfinishing a book with no position makes it wanted. */
    await library.setFinished('book_1', false)
    held = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(held.status?.state).toBe('want')
    expect(held.finished).toBe(false)

    /* And with a position to come back to, reading. */
    await library.patch('book_1', { position: { position: 'epubcfi(/6/4)', progress: 0.3 }, finished: true })
    await library.setFinished('book_1', false)
    held = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(held.status?.state).toBe('reading')
  })

  it('stamps a rating and a review each with its own clock reading, and takes a review back as empty', async () => {
    const { library } = world(['book_1'])
    await library.patch('book_1', { rating: 4, review: 'a whale of a book' })
    let held = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(held.rating).toBe(4)
    expect(held.ratingAt).toBeDefined()
    expect(held.review?.text).toBe('a whale of a book')
    expect(held.review?.at).toBe(held.ratingAt)
    /* A rating says nothing about where the reader is with the book. */
    expect(held).not.toHaveProperty('status')
    expect(held).not.toHaveProperty('finished')

    await library.patch('book_1', { review: '' })
    held = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(held.review?.text).toBe('')
    expect(held.rating).toBe(4)
  })

  it('does not re-stamp a status or a review that is already what the patch says', async () => {
    /* Every stamp is a word two replicas compare; re-saying the same thing
       with a newer stamp would win merges it has no business winning. */
    const { library } = world(['book_1'])
    await library.patch('book_1', { status: 'reading', review: 'r' })
    const first = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    await library.patch('book_1', { status: 'reading', review: 'r' })
    const again = library.getSnapshot().find((one) => one.bookId === 'book_1')!
    expect(again.status).toEqual(first.status)
    expect(again.review).toEqual(first.review)
    expect(again.finishedAt).toBe(first.finishedAt)
  })

  it('writes nothing for a patch that changes nothing', async () => {
    const { library, fs } = world(['book_1'])
    await library.patch('book_1', { rating: 3 })
    const before = new TextDecoder().decode(await fs.readFile('books/book_1/book.json'))
    await library.patch('book_1', { rating: 3 })
    const after = new TextDecoder().decode(await fs.readFile('books/book_1/book.json'))
    expect(after).toBe(before)
  })
})

describe('every clause of the opinion patch — WI-23.B3, one row each', () => {
  it('derives the status a finished flag implies, from the position it has', async () => {
    const { library } = world(['book_1'])
    await library.patch('book_1', { finished: false })
    expect(library.getSnapshot()[0]!.status?.state).toBe('want')
    await library.patch('book_1', { position: { position: 'epubcfi(/6/4)', progress: 0.3 }, finished: false })
    expect(library.getSnapshot()[0]!.status?.state).toBe('reading')
    await library.patch('book_1', { finished: true })
    expect(library.getSnapshot()[0]!.status?.state).toBe('finished')
  })

  it('writes nothing when the patch says the same again, and only the register it changes otherwise', async () => {
    const { fs, library } = world(['book_1'])
    const record = `${BOOKS_DIR}/book_1/book.json`
    await library.patch('book_1', { status: 'reading', rating: 3, review: 'first words' })
    const written = fs.writes(record)
    const before = library.getSnapshot()[0]!
    await library.patch('book_1', { status: 'reading' })
    await library.patch('book_1', { review: 'first words' })
    await library.patch('book_1', { rating: 3 })
    expect(fs.writes(record)).toBe(written)
    await library.patch('book_1', { rating: 5 })
    expect(fs.writes(record)).toBe(written + 1)
    const after = library.getSnapshot()[0]!
    expect(after.status).toEqual(before.status)
    expect(after.review).toEqual(before.review)
    expect(after.rating).toBe(5)
  })
})

describe('a patch that contradicts itself', () => {
  it('is refused rather than letting one of its two words win', async () => {
    const { library } = world(['book_1'])
    await expect(library.patch('book_1', { status: 'reading', finished: true })).rejects.toThrow(/cannot say status "reading" and finished true/u)
    await expect(library.patch('book_1', { status: 'finished', finished: false })).rejects.toThrow(/cannot say/u)
    /* Said the same way twice: fine. */
    await library.patch('book_1', { status: 'finished', finished: true })
    expect(library.getSnapshot()[0]!.status?.state).toBe('finished')
    await library.patch('book_1', { status: 'want', finished: false })
    expect(library.getSnapshot()[0]!.finished).toBe(false)
  })
})

describe('marking a book unfinished', () => {
  it('reads a null position as no place to come back to, and says want rather than reading', async () => {
    const fs = fakeFs(seeded(['book_1']))
    /* A record written with `position: null` — the type allows it, and an
       older writer produced it. */
    fs.store.set(`${BOOKS_DIR}/book_1/book.json`, new TextEncoder().encode(JSON.stringify({ title: 'book_1', author: '', position: null })))
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_1')] })
    await library.patch('book_1', { finished: false })
    expect(library.getSnapshot()[0]!.status?.state).toBe('want')
    const written = JSON.parse(new TextDecoder().decode(fs.store.get(`${BOOKS_DIR}/book_1/book.json`)!)) as { status?: { state: string } }
    expect(written.status?.state).toBe('want')
  })
})

describe('marking a book unfinished with an empty position', () => {
  it('reads an empty position as no place to come back to', async () => {
    const fs = fakeFs(seeded(['book_1']))
    fs.store.set(`${BOOKS_DIR}/book_1/book.json`, new TextEncoder().encode(JSON.stringify({ title: 'book_1', author: '', position: '' })))
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_1')] })
    await library.patch('book_1', { finished: false })
    const written = JSON.parse(new TextDecoder().decode(fs.store.get(`${BOOKS_DIR}/book_1/book.json`)!)) as { status?: { state: string } }
    expect(written.status?.state).toBe('want')
  })
})

describe('a subscriber hears once per change', () => {
  it('is not told again when the write lands and the record on disk says what the row already said', async () => {
    const { library } = world(['book_1'])
    const heard = vi.fn()
    library.subscribe(heard)
    await library.patch('book_1', { rating: 3 })
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('a position remembered without a progress', () => {
  it('keeps the record’s progress, and a progress given moves it', async () => {
    const { library } = world(['book_1'])
    await library.rememberPosition('book_1', 'p1', 0.4)
    await library.rememberPosition('book_1', 'p2')
    expect(library.getSnapshot()[0]).toMatchObject({ position: 'p2', progress: 0.4 })
    await library.rememberPosition('book_1', 'p3', 0.9)
    expect(library.getSnapshot()[0]).toMatchObject({ position: 'p3', progress: 0.9 })
  })
})

describe('a tag taken off the whole shelf', () => {
  it('leaves no book carrying it, and records the removal the way a selection’s does', async () => {
    const { library } = world(['book_1', 'book_2'])
    await library.tagBooks(['book_1', 'book_2'], ['sea'])
    await library.removeTag('sea')
    expect(library.getSnapshot().every((one) => !(one.tags ?? []).includes('sea'))).toBe(true)
    expect(library.lastRemoval()).toMatchObject({ tag: 'sea', bookIds: ['book_1', 'book_2'] })
  })

  it('takes it off a book whose record carries it and whose row does not — the disk is asked, not the cache', async () => {
    /* The crash window: `book.json` a write ahead of `index.json`, and the
       row built from the index. Judged from the snapshot, the removal left
       this tag standing while claiming the whole shelf. */
    const { fs, library } = world(['book_1', 'book_2'])
    await library.tagBooks(['book_1'], ['sea'])
    fs.store.set(`${BOOKS_DIR}/book_2/book.json`, new TextEncoder().encode(JSON.stringify({ title: 'book_2', author: '', tags: ['sea'] })))
    expect(library.getSnapshot()[1]?.tags ?? []).not.toContain('sea')
    await library.removeTag('sea')
    const written = JSON.parse(new TextDecoder().decode(fs.store.get(`${BOOKS_DIR}/book_2/book.json`)!)) as { tags?: string[] }
    expect(written.tags ?? []).not.toContain('sea')
    expect(library.getSnapshot().every((one) => !(one.tags ?? []).includes('sea'))).toBe(true)
    /* And the way back names it, with the one the index knew about. */
    expect([...(library.lastRemoval()?.bookIds ?? [])].sort()).toEqual(['book_1', 'book_2'])
    await library.undoRemoveTag()
    expect(library.getSnapshot().map((one) => one.tags)).toEqual([['sea'], ['sea']])
  })
})

describe('a jacket the store keeps is measured — WI-23.C5', () => {
  it('stamps the facts through the hash port once the jacket is there, keeps a stamp another writer made, and does nothing with no port', async () => {
    const fs = fakeFs(seeded(['book_1']))
    fs.store.set(`${BOOKS_DIR}/book_1/cover.jpg`, new TextEncoder().encode('jacket'))
    const hashFile = vi.fn(() => Promise.resolve({ blake3: 'ab'.repeat(32), size: 6 }))
    let port: { hashFile: typeof hashFile } | null = null
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_1')], hashes: () => port })
    await library.keepJacket('book_1', new Blob(['ignored']))
    expect(library.getSnapshot()[0]).not.toHaveProperty('coverFacts')
    port = { hashFile }
    await library.keepJacket('book_1', new Blob(['ignored']))
    expect(hashFile).toHaveBeenCalledWith('book_1', 'cover.jpg')
    expect(library.getSnapshot()[0]?.coverFacts).toEqual({ name: 'cover.jpg', size: 6, hash: 'ab'.repeat(32) })
    /* Stamped already: the next keep measures again but writes nothing new. */
    hashFile.mockResolvedValueOnce({ blake3: 'cd'.repeat(32), size: 7 })
    await library.keepJacket('book_1', new Blob(['ignored']))
    expect(library.getSnapshot()[0]?.coverFacts).toEqual({ name: 'cover.jpg', size: 6, hash: 'ab'.repeat(32) })
    /* A port that refuses leaves the record alone. */
    const refusing = fakeFs(seeded(['book_2']))
    refusing.store.set(`${BOOKS_DIR}/book_2/cover.jpg`, new TextEncoder().encode('jacket'))
    const other = createLibrary({ fs: refusing, queue: writeQueue(), initial: [row('book_2')], hashes: () => ({ hashFile: () => Promise.reject(new Error('no')) }) })
    await other.keepJacket('book_2', new Blob(['ignored']))
    expect(other.getSnapshot()[0]).not.toHaveProperty('coverFacts')
  })
})
