// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexedBook } from '../../core/bookIndex'
import { importTagsFromFile } from '../tagFiles'
import { useArchives } from './useArchives'
import type { CardsView } from './useCards'
import type { LibraryView } from './useLibrary'
import type { MarksView } from './useMarks'

/* The file layer is the dialog and the disk; neither exists under jsdom, and
   what is under test is what the hook does with the archive it is handed. */
vi.mock('../tagFiles', () => ({
  canArchiveTags: () => true,
  exportTagsToFile: vi.fn(),
  importTagsFromFile: vi.fn(),
}))
vi.mock('../marksFiles', () => ({
  canArchiveMarks: () => false,
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
