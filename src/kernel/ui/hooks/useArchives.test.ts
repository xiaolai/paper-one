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
       the plan's, and what could not be saved is said in the same breath.
       ⚠️ AND THE TAG FIGURE IS DROPPED HERE, because this import was partial.
       It read "Added 2,000 tags across 1,999 books. 1 book could not be
       saved" — the 2,000 is the PLAN's, and it counted the tag on the book
       that failed. `tagMany` answers in books, so books is what a partial
       import can say. */
    expect(notice).toHaveBeenCalledWith('Added tags to 1,999 books. 1 book could not be saved.')
  })

  /* A whole import keeps the number, because then the plan and the disk agree. */
  it('counts the tags when every write landed', async () => {
    const books = shelf(3)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      path: 'tags.json',
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { notice, hook } = mount(books, { changed: 3, failed: 0 })
    await act(async () => {
      hook.result.current.importTags?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })
    expect(notice).toHaveBeenCalledWith('Added 3 tags across 3 books.')
  })

  /**
   * ⚠️ **EVERY WRITE REFUSED STILL READ "ADDED".** With `changed: 0` the
   * sentence was "Added 2,000 tags across 0 books. 2,000 books could not be
   * saved" — the reader is told the thing happened and then told it did not,
   * which is the cheerful-notice-over-an-empty-disk shape this whole handler
   * was rewritten to remove.
   */
  it('says nothing was added when every write was refused', async () => {
    const books = shelf(2)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      path: 'tags.json',
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { notice, hook } = mount(books, { changed: 0, failed: 2 })
    await act(async () => {
      hook.result.current.importTags?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })
    expect(notice).toHaveBeenCalledWith('Nothing was added. 2 books could not be saved.')
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
 * ⚠️ **THE MARKS IMPORT REPORTED THE PLAN, NOT THE DISK.**
 *
 * Each book is its own write and each settles on its own — that much was
 * already right — but the sentence took its three numbers from the plan and
 * appended the failures as a qualifier. So an import whose every write was
 * refused read "Added 4 marks and 1 card across 2 books. 2 books and the
 * cards could not be saved": the reader is told it happened and then told it
 * did not. Same defect the tag import had, one file down.
 */
describe('importing marginalia, and what actually landed', () => {
  afterEach(cleanup)

  const archivedMark = (text: string) => ({
    text,
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'One',
    createdAt: '2026-01-01T00:00:00.000Z',
    localAnchor: { cfi: `epubcfi(/6/2!/4/${text.length})`, sectionIndex: 1 },
  })

  function mount(refuse: { books?: boolean; cards?: boolean } = {}) {
    const books = [
      { bookId: 'book_a', title: 'A', author: '' },
      { bookId: 'book_b', title: 'B', author: '' },
    ] as unknown as IndexedBook[]
    const addMany = vi.fn(async () => {
      if (refuse.books) throw new Error('disk full')
    })
    const makeMany = vi.fn(async () => {
      if (refuse.cards) throw new Error('disk full')
    })
    const marks = { loadAllNow: vi.fn(async () => []), addMany } as unknown as MarksView
    const cards = { all: [], makeMany } as unknown as CardsView
    const library = { books } as unknown as LibraryView
    const notice = vi.fn()
    vi.mocked(importMarksFromFile).mockResolvedValue({
      path: 'marks.json',
      archive: {
        version: 1,
        books: [
          {
            bookId: 'book_a',
            title: 'A',
            author: '',
            marks: [archivedMark('one'), archivedMark('twoo')],
            cards: [],
          },
          {
            bookId: 'book_b',
            title: 'B',
            author: '',
            marks: [archivedMark('three')],
            cards: [],
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
    const hook = renderHook(() => useArchives({ library, marks, cards, notice }))
    return { notice, hook }
  }

  const run = async (hook: ReturnType<typeof renderHook>, notice: ReturnType<typeof vi.fn>) => {
    await act(async () => {
      ;(hook.result.current as { importMarks?: () => void }).importMarks?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })
  }

  it('counts what the plan held when every write landed', async () => {
    const { notice, hook } = mount()
    await run(hook, notice)
    expect(notice).toHaveBeenCalledWith('Added 3 marks and 0 cards across 2 books.')
  })

  it('says nothing was saved when every write was refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { notice, hook } = mount({ books: true })
    await run(hook, notice)
    expect(notice).toHaveBeenCalledWith('Nothing was saved. 2 books could not be saved.')
    logged.mockRestore()
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

/**
 * A book found by name, whose marks cannot be placed in the edition on this
 * shelf (WI-21.2).
 *
 * ⚠️ **THE SHIPPED BEHAVIOUR WROTE A FOREIGN BUILD'S CFI INTO THE READER'S OWN
 * MARK STORE.** A CFI is a path through ONE package's spine and DOM; in another
 * build of the same work that path is still valid and addresses different
 * words. It does not throw — it highlights the wrong sentence, which is worse
 * than failing, and the reader has no way to tell.
 *
 * Stage 1 refuses those marks. That is a real regression for a reader importing
 * across two builds, so the ONE thing that must not fail is saying so.
 */
describe('a book found by name, and marks that cannot be placed', () => {
  afterEach(cleanup)

  const archivedMark = () => ({
    text: 'Call me Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Loomings',
    createdAt: '2026-01-01T00:00:00.000Z',
    localAnchor: { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:15)', sectionIndex: 1 },
  })

  function mount() {
    /* The shelf holds a DIFFERENT DOWNLOAD of the book the archive was written
       from: same title, same author, different bytes, so a different id. */
    const books = [{ bookId: 'local-copy', title: 'Moby-Dick', author: 'Herman Melville' }] as unknown as IndexedBook[]
    const addMany = vi.fn(async (_bookId: string, _rows: unknown[]) => {})
    const makeMany = vi.fn(async () => {})
    const marks = { loadAllNow: vi.fn(async () => []), addMany } as unknown as MarksView
    const cards = { all: [], makeMany } as unknown as CardsView
    const library = { books } as unknown as LibraryView
    const notice = vi.fn()
    vi.mocked(importMarksFromFile).mockResolvedValue({
      path: 'marks.json',
      archive: {
        version: 1,
        books: [
          {
            bookId: 'from-elsewhere',
            title: 'Moby-Dick',
            author: 'Herman Melville',
            marks: [archivedMark()],
            cards: [],
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
    const hook = renderHook(() => useArchives({ library, marks, cards, notice }))
    return { notice, hook, addMany, makeMany }
  }

  const run = async (hook: ReturnType<typeof renderHook>, notice: ReturnType<typeof vi.fn>) => {
    await act(async () => {
      ;(hook.result.current as { importMarks?: () => void }).importMarks?.()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    })
  }

  it('never hands a foreign anchor to the store', async () => {
    /* ⚠️ THE ACCEPTANCE CRITERION, at the only place it can be checked end to
       end: what `addMany` was actually called with.
     *
     * `addMany` IS called now (WI-21.7) — Stage 1 refused these marks and this
     * assertion was `not.toHaveBeenCalled()`. What must stay true, and is the
     * whole of Stage 1, is that no CFI from the other build goes with them. So
     * the check moved from "was it called" to "what did it carry", which is the
     * stronger question and the one that survives the capability coming back. */
    const { notice, hook, addMany } = mount()
    await run(hook, notice)
    expect(addMany).toHaveBeenCalled()
    const written = addMany.mock.calls.flatMap((call) => call[1] as { cfi: string; unplaced?: unknown }[])
    expect(written).toHaveLength(1)
    for (const row of written) {
      expect(row.cfi, 'a foreign anchor reached the store').toBe('')
      expect(row.unplaced).toEqual({ reason: 'foreign-build', fromBook: 'from-elsewhere' })
    }
  })

  it('keeps the quote, the note and the colour, which is what the reader made', async () => {
    /* The point of keeping the mark at all. The anchor is the ONE field that
       cannot cross; everything the reader actually wrote does. */
    const { notice, hook, addMany } = mount()
    await run(hook, notice)
    const row = (addMany.mock.calls.flatMap((call) => call[1] as Record<string, unknown>[]))[0]!
    expect(row['text']).toBe('Call me Ishmael')
    expect(row['chapter']).toBe('Loomings')
    expect(row['tint']).toBe('yellow')
    expect(row['sectionIndex'], 'a placeholder, and it must not be negative').toBe(0)
  })

  it('names the book, and does not call it missing', async () => {
    /* "Not on this shelf" would send the reader looking for a book that is
       right there. The two lists exist so the two sentences can differ. */
    const { notice, hook } = mount()
    await run(hook, notice)
    const said = notice.mock.calls.at(-1)?.[0] as string
    /* THE SENTENCE CHANGED WITH THE BEHAVIOUR. It said "Not placed", which was
       the honest word for throwing the marks away; they are kept now, so it
       says what is true — the reader has them and cannot yet be taken to them. */
    expect(said).toContain('1 mark kept without a place — another edition here: Moby-Dick.')
    expect(said).not.toContain('Not on this shelf')
  })
})
