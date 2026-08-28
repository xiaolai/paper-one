// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexedBook } from '../../core/bookIndex'
import { importTagsFromFile } from '../tagFiles'
import { exportMarksToFile, importMarksFromFile } from '../marksFiles'
import { useArchives } from './useArchives'
import type { CardsView } from './useCards'
import type { LibraryView } from './useLibrary'
import { MarksScanFailed, type MarksView } from './useMarks'

/* The file layer is the dialog and the disk; neither exists under jsdom, and
   what is under test is what the hook does with the archive it is handed. */
vi.mock('../tagFiles', () => ({
  canArchiveTags: () => true,
  exportTagsToFile: vi.fn(),
  importTagsFromFile: vi.fn(),
}))
vi.mock('../marksFiles', () => ({
  canArchiveMarks: () => true,
  exportMarksToFile: vi.fn(),
  importMarksFromFile: vi.fn(),
}))

/**
 * A tag import is AWAITED, and reports what the store answered (WI-20.36).
 *
 * It called `library.tagBooks` once per archived book in one synchronous pass
 * — two thousand write chains in one tick, the flood `addMany` was written to
 * stop — and said "Added N" before a single write had landed, so a full disk
 * produced a cheerful notice and no tags. The marks import had already been
 * rewritten to await one write per book; this is the same repair.
 */
describe('importing tags', () => {
  afterEach(cleanup)

  const shelf = (count: number): IndexedBook[] =>
    Array.from({ length: count }, (_, i) => ({ bookId: `book_${i}`, title: `Title ${i}`, author: '' }))

  function mount(books: readonly IndexedBook[], outcome: { changed: number; failed: number }) {
    const tagMany = vi.fn(async (_entries: readonly { bookId: string; tags: readonly string[] }[]) => outcome)
    const tagBooks = vi.fn()
    const library = { books, tagMany, tagBooks } as unknown as LibraryView
    const notice = vi.fn()
    const hook = renderHook(() =>
      useArchives({ library, marks: {} as MarksView, cards: {} as CardsView, notice }),
    )
    return { tagMany, tagBooks, notice, hook }
  }

  it('hands two thousand rows to the store in one batched call and reports its count', async () => {
    const books = shelf(2000)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      path: 'tags.json',
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { tagMany, tagBooks, notice, hook } = mount(books, { changed: 1999, failed: 1 })

    await act(async () => {
      hook.result.current.importTags?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })

    expect(tagBooks).not.toHaveBeenCalled()
    expect(tagMany).toHaveBeenCalledTimes(1)
    expect(tagMany.mock.calls[0]?.[0]).toHaveLength(2000)
    /* The books figure is the STORE's — what actually changed on disk — not
       the plan's, and what could not be saved is said in the same breath. */
    expect(notice).toHaveBeenCalledWith('Added 2,000 tags across 1,999 books. 1 book could not be saved.')
  })

  it('says when nothing on the shelf changed', async () => {
    const books = shelf(2)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      path: 'tags.json',
      archive: { version: 1, books: [{ ...books[0]!, tags: ['Sea'] }] },
    })
    const { notice, hook } = mount(books, { changed: 0, failed: 0 })
    await act(async () => {
      hook.result.current.importTags?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })
    expect(notice).toHaveBeenCalledWith('Nothing to add — those tags are already here.')
  })
})

/**
 * ⚠️ A SCAN THAT FAILED IS NOT A LIBRARY WITH NOTHING IN IT.
 *
 * The empty-archive trap had a second cause left in it after the first was
 * fixed. `MarkStore.loadAll` catches a failed scan, installs `[]` and
 * resolves — deliberately, for the panel that has to draw something — so a
 * shelf that would not read produced exactly the same empty list as a shelf
 * with no marks on it. Exporting therefore wrote `{"version":1,"books":[]}`
 * over the reader's only backup and reported a success, for a disk that never
 * answered. `loadAllNow` rejects with `MarksScanFailed` for that case now, and
 * these are the two callers that would otherwise have written the file (the
 * 2026-08-28 audit, #101).
 *
 * THE ASSERTION IS THAT NOTHING WAS WRITTEN, not that a sentence was said. A
 * notice beside a written archive is the same lost backup with an apology.
 */
describe('marginalia after a failed scan', () => {
  afterEach(cleanup)

  function mount() {
    const loadAllNow = vi.fn(() => Promise.reject(new MarksScanFailed()))
    const addMany = vi.fn(async () => {})
    const makeMany = vi.fn(async () => {})
    const marks = { loadAllNow, addMany } as unknown as MarksView
    const cards = { all: [], makeMany } as unknown as CardsView
    const library = { books: [] } as unknown as LibraryView
    const notice = vi.fn()
    const hook = renderHook(() => useArchives({ library, marks, cards, notice }))
    return { addMany, makeMany, notice, hook }
  }

  it('exports nothing, and does not blame the file it was about to write', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { notice, hook } = mount()

    await act(async () => {
      hook.result.current.exportMarks?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })

    expect(vi.mocked(exportMarksToFile), 'an empty archive was written anyway').not.toHaveBeenCalled()
    /* WHICH END FAILED decides the sentence: "could not be written" would send
       the reader to look at the disk they were about to write to, when the one
       that would not answer is the one their books are on. */
    expect(notice).toHaveBeenCalledWith('Your marks could not be read — nothing was exported.')
    logged.mockRestore()
  })

  it('imports nothing, rather than merging against a baseline it does not have', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(importMarksFromFile).mockResolvedValue({
      path: 'marks.json',
      archive: { version: 1, books: [] },
    } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
    const { addMany, makeMany, notice, hook } = mount()

    await act(async () => {
      hook.result.current.importMarks?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })

    /* Importing against an unknown baseline re-adds every mark in the archive:
       the plan's duplicate check is against what the scan found. */
    expect(addMany, 'marks were merged against a baseline that was never read').not.toHaveBeenCalled()
    expect(makeMany).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('Your marks could not be read — nothing was imported.')
    logged.mockRestore()
  })
})
