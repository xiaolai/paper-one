import { describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import { INDEX_FILE, type IndexFs, type IndexedBook } from './bookIndex'
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

/** What `index.json` holds, or null when nothing has written one. */
const indexOn = (fs: ReturnType<typeof fakeFs>): { books: IndexedBook[] } | null => {
  const bytes = fs.store.get(INDEX_FILE)
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as { books: IndexedBook[] }) : null
}

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

describe('what the disk write answered', () => {
  it('reconciles the published row with the record the write actually produced', async () => {
    /* `updateBook` applies the change to what is ON DISK — deliberately,
       because the cached row can be one write behind after a crash — and
       answers the merged record. `commit` used to discard that answer: the
       optimistic row built from the stale cache stayed published and was
       then serialised into the index, writing the lie back over the truth
       the write had just merged. */
    const fs = fakeFs({
      [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'Moby-Dick', author: '', finished: true }),
      [`${BOOKS_DIR}/book_a/content.epub`]: 'B',
    })
    /* The cache is BEHIND the disk: its row does not know the book was
       finished. */
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_a', 'Moby-Dick')] })

    await library.tag('book_a', 'Sea')

    const after = library.getSnapshot().find((one) => one.bookId === 'book_a')!
    expect(after.tags).toEqual(['Sea'])
    expect(after.finished).toBe(true)
  })

  /**
   * ⚠️ **A WRITE THAT ANSWERED NOTHING LEFT THE ROW ON THE SHELF AND IN THE
   * INDEX.**
   *
   * `updateBook` answers `null` when the folder holds no `book.json` —
   * present-but-unreadable throws, so `null` is genuinely absent — and the
   * reconciliation only acted on a record, so the optimistic row stayed
   * published and was then serialised. Folder membership does not change when
   * a phantom is added to the cache, so `loadShelf` trusts it and an idle
   * book's record is never re-read to contradict it: the lie outlived the
   * session.
   */
  it('takes the row off the shelf when the write answered that nothing landed', async () => {
    const fs = fakeFs({})
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_a', 'Moby-Dick')] })

    await library.tag('book_a', 'Sea')

    expect(library.getSnapshot()).toEqual([])
    expect(indexOn(fs)?.books).toEqual([])
  })

  /* THE POSITION TICK TOO, whose index policy is `defer`. A row leaving the
     shelf is structural, and leaving that correction to the throttle is how a
     quit outruns it. */
  it('writes the index at once when a position tick discovers its book is gone', async () => {
    const fs = fakeFs({})
    const library = createLibrary({ fs, queue: writeQueue(), initial: [row('book_a')] })

    await library.rememberPosition('book_a', 'epubcfi(/6/4!/4/2)', 0.25)

    expect(library.getSnapshot()).toEqual([])
    expect(indexOn(fs)?.books).toEqual([])
  })
})

/**
 * A REMOTE BATCH GETS THE SAME REPAIR AS `commit`, and used to get half of it
 * (round 2, #79). It reconciled a row that landed and left one that did not
 * exactly where the optimistic publish had put it — on the shelf, and then in
 * the ONE index write the batch ends with.
 */
describe('applyRemoteRows and a row that did not land', () => {
  it('drops a row whose folder holds no record, and writes the index without it', async () => {
    const fs = fakeFs(seeded(['book_a']))
    const library = createLibrary({
      fs,
      queue: writeQueue(),
      initial: [row('book_a'), row('book_gone')],
    })

    await library.applyRemoteRows([
      { bookId: 'book_a', change: (record) => ({ ...record, finished: true }) },
      { bookId: 'book_gone', change: (record) => ({ ...record, finished: true }) },
    ])

    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
    expect(indexOn(fs)?.books.map((one) => one.bookId)).toEqual(['book_a'])
  })

  it('drops a row whose write failed and whose folder cannot back it either', async () => {
    /* PRESENT BUT UNREADABLE. `updateBook` throws rather than answering
       `null` — the record is there and cannot be read — and the repair's own
       read has nothing to correct the row from. That is `commit`'s case, and
       this path used to leave the row published for the batch write. */
    const fs = fakeFs(seeded(['book_a', 'book_broken']))
    const wrapped: IndexFs = {
      ...fs,
      readFile: async (path) => {
        if (path === `${BOOKS_DIR}/book_broken/book.json`) throw new Error('EIO')
        return fs.readFile(path)
      },
    }
    const library = createLibrary({
      fs: wrapped,
      queue: writeQueue(),
      initial: [row('book_a'), row('book_broken')],
    })

    await expect(
      library.applyRemoteRows([
        { bookId: 'book_a', change: (record) => ({ ...record, finished: true }) },
        { bookId: 'book_broken', change: (record) => ({ ...record, finished: true }) },
      ]),
    ).rejects.toThrow(/could not be read/)

    expect(library.getSnapshot().map((one) => one.bookId)).toEqual(['book_a'])
    expect(indexOn(fs)?.books.map((one) => one.bookId)).toEqual(['book_a'])
  })

  /**
   * THE LAST RESORT, and only with a row that did not land. The corrected
   * picture is what the batch index write carries; without it the cache on
   * disk may hold a phantom another book's commit serialised, and `loadShelf`
   * trusts a cache whose folder listing agrees. Leaving none to trust costs a
   * rescan, which is the price of not knowing.
   */
  it('leaves no index to trust when the corrected picture could not be written', async () => {
    const fs = fakeFs({ ...seeded(['book_a']), [INDEX_FILE]: '{"version":1,"books":[]}' })
    const wrapped: IndexFs = {
      ...fs,
      writeFile: async (path, bytes) => {
        if (path.startsWith(`${BOOKS_DIR}/book_a/`) || path.startsWith(INDEX_FILE)) {
          throw new Error('disk full')
        }
        await fs.writeFile(path, bytes)
      },
    }
    const library = createLibrary({ fs: wrapped, queue: writeQueue(), initial: [row('book_a')] })

    await expect(
      library.applyRemoteRows([{ bookId: 'book_a', change: (record) => ({ ...record, finished: true }) }]),
    ).rejects.toThrow('disk full')

    expect(fs.store.has(INDEX_FILE)).toBe(false)
  })

  /* AND NOT OTHERWISE. Every row landed, so the shelf in memory is right and
     the next write rewrites the cache — throwing away a good index over one
     failed write would buy a full rescan for nothing. */
  it('keeps the index when every row landed and only the index write failed', async () => {
    const fs = fakeFs({ ...seeded(['book_a']), [INDEX_FILE]: '{"version":1,"books":[]}' })
    const wrapped: IndexFs = {
      ...fs,
      writeFile: async (path, bytes) => {
        if (path.startsWith(INDEX_FILE)) throw new Error('disk full')
        await fs.writeFile(path, bytes)
      },
    }
    const library = createLibrary({ fs: wrapped, queue: writeQueue(), initial: [row('book_a')] })

    await expect(
      library.applyRemoteRows([{ bookId: 'book_a', change: (record) => ({ ...record, finished: true }) }]),
    ).rejects.toThrow('disk full')

    expect(fs.store.has(INDEX_FILE)).toBe(true)
  })
})

describe('the undo offer and a write that fails', () => {
  it('keeps the offer when putting the tag back could not be written', async () => {
    /* Cleared before the restoring writes and left cleared on failure, a
       transient disk error spent the reader's one retry on nothing. */
    const { library, refuse } = world(['book_a'])
    await library.tag('book_a', 'Sea')
    await library.untagBooks(['book_a'], 'Sea')
    expect(library.lastRemoval()).toMatchObject({ tag: 'Sea', bookIds: ['book_a'] })

    refuse('book_a', true)
    await expect(library.undoRemoveTag()).rejects.toThrow()
    expect(library.lastRemoval()).toMatchObject({ tag: 'Sea', bookIds: ['book_a'] })

    /* And with the disk back, the same offer goes through. */
    refuse('book_a', false)
    await library.undoRemoveTag()
    expect(library.lastRemoval()).toBeNull()
    expect(library.getSnapshot()[0]?.tags).toEqual(['Sea'])
  })
})
