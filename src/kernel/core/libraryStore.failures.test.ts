import { describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import type { IndexFs, IndexedBook } from './bookIndex'
import { fakeFs } from './indexFsFake.testkit'
import { WRITE_WIDTH, createLibrary } from './libraryStore'
import { writeQueue } from './writeQueue'

/**
 * A failed write is SAID, not logged (WI-20.36).
 *
 * Every verb here returned its promise and the hook let it go to
 * `console.error` — so a tag that never reached the disk looked, on the shelf,
 * exactly like one that had, until the next launch disagreed. The store now
 * publishes whether its last write landed and which one did not, the way the
 * marks and the cards already publish `persistent`.
 */

const row = (bookId: string, title = bookId): IndexedBook => ({ bookId, title, author: '', hasContent: true })

/** A shelf on disk: a record and some bytes per book. */
const seeded = (ids: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    ids.flatMap((id) => [
      [`${BOOKS_DIR}/${id}/book.json`, JSON.stringify({ title: id, author: '' })],
      [`${BOOKS_DIR}/${id}/content.epub`, 'B'],
    ]),
  )

/** The fake fs, with writes under `refused` folders failing while the switch is on. */
function world(ids: readonly string[], titles: Record<string, string> = {}) {
  const fs = fakeFs(seeded(ids))
  const refused = new Set<string>()
  const wrapped: IndexFs = {
    ...fs,
    writeFile: async (path, bytes) => {
      for (const id of refused) if (path.startsWith(`${BOOKS_DIR}/${id}/`)) throw new Error('disk full')
      await fs.writeFile(path, bytes)
    },
  }
  const library = createLibrary({
    fs: wrapped,
    queue: writeQueue(),
    initial: ids.map((id) => row(id, titles[id] ?? id)),
  })
  return { fs, library, refuse: (id: string, on: boolean) => (on ? refused.add(id) : refused.delete(id)) }
}

describe('a write that does not land', () => {
  it('is published as the last failure, naming the book, and the store stops being persistent', async () => {
    const { library, refuse } = world(['book_a'], { book_a: 'Moby-Dick' })
    const heard = vi.fn()
    library.subscribe(heard)
    refuse('book_a', true)

    await expect(library.tag('book_a', 'Sea')).rejects.toThrow('disk full')

    expect(library.persistent).toBe(false)
    expect(library.lastFailure()).toMatchObject({ bookId: 'book_a', title: 'Moby-Dick', message: 'disk full' })
    /* Subscribers hear about it — the shelf's status line reads the flag the
       same way the settings pane reads its store's. */
    expect(heard).toHaveBeenCalled()
  })

  /* A page turn in ANOTHER book landing must not make the lost tag look
     saved: the failure names a book, and only that book's next write can
     clear it. The flag itself answers "is it saving now", which the other
     book's success does establish. */
  it('is cleared by the same book writing successfully, and not by another book', async () => {
    const { library, refuse } = world(['book_a', 'book_b'])
    refuse('book_a', true)
    await library.tag('book_a', 'Sea').catch(() => {})
    expect(library.lastFailure()?.bookId).toBe('book_a')

    await library.tag('book_b', 'Sea')
    expect(library.persistent).toBe(true)
    expect(library.lastFailure()?.bookId).toBe('book_a')

    refuse('book_a', false)
    await library.tag('book_a', 'Sea')
    expect(library.lastFailure()).toBeNull()
  })

  it('can be dismissed, which says so to subscribers', async () => {
    const { library, refuse } = world(['book_a'])
    refuse('book_a', true)
    await library.tag('book_a', 'Sea').catch(() => {})
    const heard = vi.fn()
    library.subscribe(heard)

    library.dismissFailure()

    expect(library.lastFailure()).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
    // Dismissing nothing is not a change.
    library.dismissFailure()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('falls back to the id when the row has no title to name', async () => {
    const { library, refuse } = world(['book_a'], { book_a: '' })
    refuse('book_a', true)
    await library.tag('book_a', 'Sea').catch(() => {})
    expect(library.lastFailure()?.title).toBe('book_a')
  })
})

/**
 * The tag import's verb. It looped `tagBooks` once per archived book in one
 * synchronous pass — the flood `addMany` was written to stop — and reported
 * success before a single write had landed.
 */
describe('tagMany', () => {
  it('tags two hundred books a few at a time, and answers how many records changed', async () => {
    /* Two hundred, not the import's two thousand: every commit still rewrites
       the whole index (WI-20.35 is what stops that), so the cost grows with
       the square of the shelf, and two thousand took eight seconds uncovered
       — past the 15 s coverage ceiling on a loaded machine. The properties
       under test do not need the size: a lost update across the eight workers
       shows at any width-8 fan-out (the first draft's `changed += await`
       answered 201 of 2 000), and the fan-out bound is about width, not count.
       `useArchives.test.ts` carries the two-thousand-row import over a fake
       store, where it is cheap. */
    const ids = Array.from({ length: 200 }, (_, i) => `book_${i}`)
    const fs = fakeFs(seeded(ids))
    let inFlight = 0
    let peak = 0
    const gauged: IndexFs = {
      ...fs,
      writeFile: async (path, bytes) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        await fs.writeFile(path, bytes)
        inFlight -= 1
      },
    }
    const library = createLibrary({ fs: gauged, queue: writeQueue(), initial: ids.map((id) => row(id)) })

    const outcome = await library.tagMany(ids.map((bookId) => ({ bookId, tags: ['Sea'] })))

    expect(outcome).toEqual({ changed: 200, failed: 0 })
    /* The records, a slot's worth at a time, plus the one index rewrite that
       coalesces behind them — never two hundred chains in one tick. */
    expect(peak).toBeLessThanOrEqual(WRITE_WIDTH + 1)
    expect(library.getSnapshot().every((one) => one.tags?.includes('Sea'))).toBe(true)
  })

  it('counts the books that could not be saved and saves the rest', async () => {
    const { library, refuse } = world(['book_a', 'book_b', 'book_c'])
    refuse('book_b', true)

    const outcome = await library.tagMany([
      { bookId: 'book_a', tags: ['Sea'] },
      { bookId: 'book_b', tags: ['Sea'] },
      { bookId: 'book_c', tags: ['Sea', 'Sea'] },
    ])

    expect(outcome).toEqual({ changed: 2, failed: 1 })
    expect(library.lastFailure()?.bookId).toBe('book_b')
  })

  it('does not count a book that already carried the tag', async () => {
    const { library } = world(['book_a'])
    await library.tag('book_a', 'Sea')
    expect(await library.tagMany([{ bookId: 'book_a', tags: ['sea'] }])).toEqual({ changed: 0, failed: 0 })
  })
})
