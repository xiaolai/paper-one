// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import { INDEX_FILE, loadShelf, parseIndex, type IndexedBook } from './bookIndex'
import { fakeFs } from './indexFsFake.testkit'
import { writeQueue } from './writeQueue'
import { asRow, useLibrary } from './useLibrary'
import { keepCover } from './coverArt'

/* The cover writer is MOCKED, for one seam only: `keepJacket` must not invoke
 * it for a book whose record is gone, and invocation is the observable — the
 * real `keepCover` needs a canvas jsdom does not have, and it catches its own
 * failures, so under jsdom it would decline to write for the wrong reason and
 * the guard under test would look correct whether or not it existed. */
vi.mock('./coverArt', () => ({ keepCover: vi.fn(async () => true) }))

/**
 * The one pure decision in `useLibrary` with a launch riding on it.
 *
 * `hasContent` is derived by the scan and is not a field of `BookRecord`, so
 * every row rebuilt from a record has lost it unless `asRow` is handed it
 * back. `loadShelf` refuses to trust an index in which any row lacks the flag
 * — so a single flagless row, which every `add` used to produce, turned the
 * cache off for the next launch and made opening a fresh library pay a full
 * folder-by-folder scan every single time.
 */
describe('asRow', () => {
  const record = { title: 'Moby-Dick', author: 'Melville' }

  it('carries the flag it is handed', () => {
    expect(asRow(record, 'book_a', true).hasContent).toBe(true)
    expect(asRow(record, 'book_a', false).hasContent).toBe(false)
  })

  /* Carries knowledge, does not invent any: a row that was never measured
   * stays unmeasured, rather than guessing a value the folder might contradict. */
  it('adds nothing when the flag was never derived', () => {
    expect(asRow(record, 'book_a', undefined)).not.toHaveProperty('hasContent')
  })

  it('stamps the id over whatever the record claims', () => {
    expect(asRow({ ...record, bookId: 'stale' }, 'book_a', true).bookId).toBe('book_a')
  })

  /* The flag is the ROW's, never the record's: were it spread in from a record
   * it would be one write away from landing inside `book.json`, which is the
   * stored-flag disagreement `bookIndex` exists to rule out. */
  it('takes the flag only from its own argument', () => {
    const smuggled = { ...record, hasContent: true } as typeof record
    expect(asRow(smuggled, 'book_a', false).hasContent).toBe(false)
  })
})

/**
 * The hook itself, mounted — the wiring the pure tests cannot see.
 *
 * These are LAUNCH-SHAPED tests: each one performs a session's writes through
 * the real hook and the real write queue, then asks the question the next
 * launch asks — does `loadShelf` believe the index this session left behind?
 * `rescanned: false` IS the feature. The bug these pin was invisible to every
 * unit test precisely because it lived in the wiring: `add` built rows that
 * dropped the flag, the index inherited them, and the launch after a fresh
 * import paid a full scan of the library before the window could draw.
 *
 * The index file appearing is the signal a session's writes have landed —
 * `commit` chains the index write behind the book's own, so its presence
 * means both are done. Waiting on `loadShelf` instead would be circular: a
 * rescan WRITES the very index the assertion then trusts.
 */
describe('useLibrary, mounted', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  function mount(
    files: Record<string, string>,
    initial: readonly IndexedBook[] = [],
    /** Wraps the fs the hook sees — for failure injection; the store stays shared. */
    wrap?: (fs: ReturnType<typeof fakeFs>) => typeof fs,
  ) {
    const fs = fakeFs(files)
    /* ONE queue, made outside the render callback — the callback runs on every
     * render, and a queue made inside it would be replaced under the hook each
     * time state moves, which is not the contract the app provides. */
    const queue = writeQueue()
    const hook = renderHook(() => useLibrary(wrap ? wrap(fs) : fs, queue, initial))
    return { fs, queue, hook }
  }

  const settled = (fs: ReturnType<typeof fakeFs>) =>
    vi.waitFor(() => expect(fs.store.has(INDEX_FILE)).toBe(true))

  it('writes an index the next launch can trust, for a book no scan has seen', async () => {
    // An import's shape: the bytes are copied first, then the sparse add.
    const { fs, hook } = mount({ [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE' })
    await act(async () => {
      hook.result.current.add(
        'book_a',
        { title: 'moby-dick', author: '', ext: 'epub', addedAt: 1 },
        true,
      )
      await settled(fs)
    })
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(false)
    // Measured off the folder by the write itself, not asserted by the caller.
    expect(books[0]?.hasContent).toBe(true)
  })

  /* The same measurement is what tells the truth the other way: a record whose
   * copy never landed is missing NOW, on the shelf that shows it, not on some
   * later launch that happens to rescan. */
  it('measures a copy that never landed as missing, and the cache holds', async () => {
    const { fs, hook } = mount({})
    await act(async () => {
      hook.result.current.add('book_a', { title: 'ghost', author: '', ext: 'epub' }, true)
      await settled(fs)
    })
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(false)
    expect(books[0]?.hasContent).toBe(false)
  })

  /* The enrichment pass and the reader's own open both fold a parse into an
   * existing row. The optimistic row is drawn before any disk answer comes
   * back, and it must not un-know what the scan established — this is the
   * exact line where every parse used to knock the flag off the shelf. */
  it('keeps the flag on the row a parse replaces, before the disk answers', async () => {
    const onDisk = {
      [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'moby-dick', author: '' }),
      [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
    }
    const shelf: IndexedBook[] = [
      { bookId: 'book_a', title: 'moby-dick', author: '', hasContent: true },
    ]
    const { fs, hook } = mount(onDisk, shelf)
    act(() => {
      hook.result.current.add('book_a', {
        title: 'Moby-Dick',
        author: 'Melville',
        parsedAt: 1,
      })
    })
    expect(hook.result.current.books[0]?.hasContent).toBe(true)
    await act(async () => {
      await settled(fs)
    })
  })

  /* A SECOND sparse add of a book whose first add has not settled — a folder
   * re-imported twice, back to back. The first add's disk answer is suppressed
   * (`reconcile` declines under a queued neighbour), so the row's flag would
   * stay unset forever unless the second add MEASURES rather than trusting
   * what the row says: the flagless row is the launch-rescan defect through
   * the one door that used to measure only rows already marked `false`. */
  it('a re-import measures the flag a suppressed first add left off', async () => {
    const { fs, hook } = mount({ [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE' })
    const sparse = { title: 'moby-dick', author: '', ext: 'epub' }
    await act(async () => {
      hook.result.current.add('book_a', sparse, true)
      hook.result.current.add('book_a', sparse, true)
      await vi.waitFor(() => {
        const raw = fs.store.get(INDEX_FILE)
        expect(raw).toBeDefined()
        expect(parseIndex(new TextDecoder().decode(raw!))?.[0]?.hasContent).toBe(true)
      })
    })
    expect((await loadShelf(fs)).rescanned).toBe(false)
  })

  /* `update`'s callback contract is record-to-record, and nothing in it says
   * "spread your input". A callback that BUILDS its result used to strip the
   * derived flag from the row on the way through — the same defect `add` had,
   * wearing the other mutator. */
  it('an update that builds a fresh record cannot lose the flag', async () => {
    const { fs, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'moby-dick', author: '' }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
      },
      [{ bookId: 'book_a', title: 'moby-dick', author: '', hasContent: true }],
    )
    act(() => {
      hook.result.current.update('book_a', (record) => ({
        title: record.title,
        author: record.author,
        finished: true,
      }))
    })
    expect(hook.result.current.books[0]?.hasContent).toBe(true)
    await act(async () => {
      await settled(fs)
    })
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(false)
    expect(books[0]?.finished).toBe(true)
    expect(books[0]?.hasContent).toBe(true)
  })

  /* Being in line BEHIND the removal was never enough: the cover writer makes
   * the folder it writes into, so a jacket landing after a removal recreated
   * the trashed folder as a directory holding nothing but a picture of a book
   * that is gone. The record's absence is what "removed" looks like from
   * inside the queue, and the jacket task has to ask. */
  it('a jacket queued behind a removal writes nothing back', async () => {
    const { fs, queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'moby-dick', author: '' }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
      },
      [{ bookId: 'book_a', title: 'moby-dick', author: '', hasContent: true }],
    )
    await act(async () => {
      hook.result.current.remove('book_a')
      hook.result.current.keepJacket('book_a', new Blob(['jacket']))
      await queue.idle()
      await settled(fs)
    })
    expect(vi.mocked(keepCover)).not.toHaveBeenCalled()
    // The book is in the trash, and nothing recreated its live folder.
    expect([...fs.store.keys()].filter((k) => k.startsWith(`${BOOKS_DIR}/book_a/`))).toEqual([])
  })

  /* And the guard must not eat the ordinary case: a book that is still on the
   * shelf gets its jacket. */
  it('a jacket for a living book still lands', async () => {
    const { fs, queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'moby-dick', author: '' }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'WHALE',
      },
      [{ bookId: 'book_a', title: 'moby-dick', author: '', hasContent: true }],
    )
    await act(async () => {
      hook.result.current.keepJacket('book_a', new Blob(['jacket']))
      await queue.idle()
    })
    expect(vi.mocked(keepCover)).toHaveBeenCalledWith(fs, 'book_a', expect.anything())
  })

  /* A rekey reroutes the destination's lane onto the source's, so every write
   * for the book — issued under either id, before or after the move — runs in
   * one lane in the order it was asked for. This pins the composite: no
   * deadlock (the stamp is inline in the same lane), no dropped edit, and the
   * later write wins. */
  it('writes issued across a rekey land in order, in one lane', async () => {
    const { fs, queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_old/book.json`]: JSON.stringify({ title: 't', author: '' }),
        [`${BOOKS_DIR}/book_old/content.epub`]: 'B',
      },
      [{ bookId: 'book_old', title: 't', author: '', hasContent: true }],
    )
    await act(async () => {
      hook.result.current.update('book_old', (r) => ({ ...r, position: 'old-edit' }))
      const carried = hook.result.current.rekeyBook('book_old', 'book:new')
      // Issued while the rename is still queued: it must fall in line behind
      // it, not race it from a lane of its own.
      hook.result.current.update('book_old', (r) => ({ ...r, position: 'newer-edit' }))
      await expect(carried).resolves.toBe('moved')
      // And a write under the NEW id joins the same lane.
      hook.result.current.tagBooks(['book:new'], ['Sea'])
      await queue.idle()
    })
    const raw = fs.store.get(`${BOOKS_DIR}/book_new/book.json`)
    expect(raw).toBeDefined()
    const record = JSON.parse(new TextDecoder().decode(raw!)) as {
      bookId?: string
      position?: string
      tags?: string[]
    }
    expect(record.bookId).toBe('book:new')
    expect(record.position).toBe('newer-edit')
    expect(record.tags).toEqual(['Sea'])
  })

  /* A write that FAILS must not leave its optimistic prediction in the row —
   * the index is serialised from the rows, the trust check never re-reads an
   * idle book's record, so a phantom edit in a trusted cache survives across
   * launches. The repair is immediate: the folder wins, now. */
  it('a write that fails puts the folder back in the row', async () => {
    const { queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({
          title: 't',
          author: '',
          tags: ['kept'],
        }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'B',
      },
      [{ bookId: 'book_a', title: 't', author: '', tags: ['kept'], hasContent: true }],
      (fs) => ({
        ...fs,
        writeFile: async (path, bytes) => {
          if (path.startsWith(`${BOOKS_DIR}/book_a/`)) throw new Error('disk full')
          return fs.writeFile(path, bytes)
        },
      }),
    )
    act(() => {
      hook.result.current.update('book_a', (r) => ({ ...r, tags: ['phantom'] }))
    })
    expect(hook.result.current.books[0]?.tags).toEqual(['phantom'])
    await act(async () => {
      await queue.idle()
    })
    /* The repair is queued from the commit promise chain one microtask after
     * the failing task settles, so `idle()` can resolve before it is even in
     * the queue — polled with an act flush per attempt, because a state update
     * queued while an `act` body is still open is not rendered until that body
     * exits, and a waitFor inside it would poll a picture that cannot change. */
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(hook.result.current.books[0]?.tags).toEqual(['kept'])
    })
  })

  /* And when even the repair cannot read the folder, the row comes OFF the
   * shelf and out of the cache — there is no state it can honestly show. The
   * index written without the book also omits its folder claim, so the next
   * healthy launch disagrees with the listing, rescans, and shelves the book
   * again from the folder — which is the truth. */
  it('a failed write nothing readable backs takes the row off the shelf', async () => {
    const { fs, queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 't', author: '' }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'B',
        [INDEX_FILE]: JSON.stringify({
          version: 1,
          books: [{ bookId: 'book_a', title: 't', author: '', hasContent: true }],
          folders: ['book_a'],
        }),
      },
      [{ bookId: 'book_a', title: 't', author: '', hasContent: true }],
      (fs) => ({
        ...fs,
        readFile: async (path) => {
          if (path === `${BOOKS_DIR}/book_a/book.json`) throw new Error('EIO')
          return fs.readFile(path)
        },
        writeFile: async (path, bytes) => {
          if (path.startsWith(`${BOOKS_DIR}/book_a/`)) throw new Error('disk full')
          return fs.writeFile(path, bytes)
        },
      }),
    )
    act(() => {
      hook.result.current.update('book_a', (r) => ({ ...r, tags: ['phantom'] }))
    })
    await act(async () => {
      await queue.idle()
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(hook.result.current.books).toHaveLength(0)
      const raw = fs.store.get(INDEX_FILE)
      expect(raw).toBeDefined()
      expect(parseIndex(new TextDecoder().decode(raw!))).toEqual([])
    })
    // The next healthy launch rescans and the book comes back from its folder.
    const shelf = await loadShelf(fs)
    expect(shelf.rescanned).toBe(true)
    expect(shelf.books).toHaveLength(1)
  })

  /* The cross-book shape the repair exists for: while book A's failing write
   * is in flight, book B's successful commit serialises A's phantom row into
   * the index — and folder membership is unchanged, so a launch would TRUST
   * it, and an idle book's record is never re-read while the cache is
   * trusted. The repair must reach the DISK, not just the rows. */
  it('a phantom another book serialised is scrubbed from the cache', async () => {
    const { fs, queue, hook } = mount(
      {
        [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({
          title: 'a',
          author: '',
          tags: ['kept'],
        }),
        [`${BOOKS_DIR}/book_a/content.epub`]: 'A',
        [`${BOOKS_DIR}/book_b/book.json`]: JSON.stringify({ title: 'b', author: '' }),
        [`${BOOKS_DIR}/book_b/content.epub`]: 'B',
      },
      [
        { bookId: 'book_a', title: 'a', author: '', tags: ['kept'], hasContent: true },
        { bookId: 'book_b', title: 'b', author: '', hasContent: true },
      ],
      (fs) => ({
        ...fs,
        writeFile: async (path, bytes) => {
          if (path.startsWith(`${BOOKS_DIR}/book_a/`)) throw new Error('disk full')
          return fs.writeFile(path, bytes)
        },
      }),
    )
    act(() => {
      hook.result.current.update('book_a', (r) => ({ ...r, tags: ['phantom'] }))
      hook.result.current.update('book_b', (r) => ({ ...r, finished: true }))
    })
    await act(async () => {
      await queue.idle()
    })
    await vi.waitFor(async () => {
      await act(async () => {})
      const raw = fs.store.get(INDEX_FILE)
      expect(raw).toBeDefined()
      const cached = parseIndex(new TextDecoder().decode(raw!))
      expect(cached?.find((one) => one.bookId === 'book_a')?.tags).toEqual(['kept'])
      expect(cached?.find((one) => one.bookId === 'book_b')?.finished).toBe(true)
    })
    // And a launch over this cache is entitled to trust it.
    const shelf = await loadShelf(fs)
    expect(shelf.rescanned).toBe(false)
    expect(shelf.books.find((one) => one.bookId === 'book_a')?.tags).toEqual(['kept'])
  })

  /* The other mutator: a tag goes through `update`, whose row is a spread of
   * the one it changes. One write, and the launch after it still trusts the
   * cache — the flag survived the whole round trip. */
  it('a tag write leaves the cache trusted too', async () => {
    const { fs, hook } = mount(
      { [`${BOOKS_DIR}/book_a/book.json`]: JSON.stringify({ title: 'moby-dick', author: '' }) },
      [{ bookId: 'book_a', title: 'moby-dick', author: '', hasContent: true }],
    )
    await act(async () => {
      hook.result.current.tagBooks(['book_a'], ['Sea'])
      await settled(fs)
    })
    const { books, rescanned } = await loadShelf(fs)
    expect(rescanned).toBe(false)
    expect(books[0]?.tags).toEqual(['Sea'])
    expect(books[0]?.hasContent).toBe(true)
  })
})
