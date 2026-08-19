// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOKS_DIR } from './bookFolder'
import { INDEX_FILE, loadShelf, type IndexedBook } from './bookIndex'
import { fakeFs } from './indexFsFake.testkit'
import { writeQueue } from './writeQueue'
import { asRow, useLibrary } from './useLibrary'

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
  afterEach(cleanup)

  function mount(files: Record<string, string>, initial: readonly IndexedBook[] = []) {
    const fs = fakeFs(files)
    /* ONE queue, made outside the render callback — the callback runs on every
     * render, and a queue made inside it would be replaced under the hook each
     * time state moves, which is not the contract the app provides. */
    const queue = writeQueue()
    const hook = renderHook(() => useLibrary(fs, queue, initial))
    return { fs, hook }
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
