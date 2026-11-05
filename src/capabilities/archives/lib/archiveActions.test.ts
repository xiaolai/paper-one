import { describe, expect, it, vi } from 'vitest'
import {
  MarksScanFailed,
  createMarkStore,
  folderOf,
  recordPath,
  writeQueue,
  type FilePicker,
  type IndexedBook,
  type KernelServices,
  type Library,
  type MarkStore,
  type NewMark,
} from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'
import { addDrafts, createArchives, type ArchiveServices, type Archives } from './archiveActions'
import { ArchiveOverLimit } from './marksArchive'
import { exportMarksToFile, importMarksFromFile } from './marksFiles'
import { exportTagsToFile, importTagsFromFile } from './tagFiles'

/* The file layer is the dialog and the disk; neither exists under jsdom, and
   what is under test is what this does with the archive it is handed. */
vi.mock('./tagFiles', () => ({
  exportTagsToFile: vi.fn(),
  importTagsFromFile: vi.fn(),
}))
vi.mock('./marksFiles', () => ({
  exportMarksToFile: vi.fn(),
  importMarksFromFile: vi.fn(),
}))

type Cards = KernelServices['cards']

/** The file layer is mocked above, so nothing here ever asks for the picker. */
const wired = ({
  library,
  marks,
  cards,
  notice,
}: Pick<ArchiveServices, 'library' | 'marks' | 'cards'> & { notice: ArchiveServices['notify'] }): Archives =>
  createArchives({ library, marks, cards, notify: notice, files: {} as FilePicker })

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
  const shelf = (count: number): IndexedBook[] =>
    Array.from({ length: count }, (_, i) => ({ bookId: `book_${i}`, title: `Title ${i}`, author: '' }))

  function mount(books: readonly IndexedBook[], outcome: { changed: number; failed: number }) {
    const tagMany = vi.fn(async (_entries: readonly { bookId: string; tags: readonly string[] }[]) => outcome)
    const tagBooks = vi.fn()
    const library = { getSnapshot: () => books, tagMany, tagBooks } as unknown as Library
    const notice = vi.fn()
    const archives = wired({ library, marks: {} as MarkStore, cards: {} as Cards, notice })
    return { tagMany, tagBooks, notice, archives }
  }

  it('hands two thousand rows to the store in one batched call and reports its count', async () => {
    const books = shelf(2000)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { tagMany, tagBooks, notice, archives } = mount(books, { changed: 1999, failed: 1 })

    archives.importTags()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())

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
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { notice, archives } = mount(books, { changed: 3, failed: 0 })
    archives.importTags()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
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
      archive: { version: 1, books: books.map((one) => ({ ...one, tags: ['Sea'] })) },
    })
    const { notice, archives } = mount(books, { changed: 0, failed: 2 })
    archives.importTags()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    expect(notice).toHaveBeenCalledWith('Nothing was added. 2 books could not be saved.')
  })

  it('says when nothing on the shelf changed', async () => {
    const books = shelf(2)
    vi.mocked(importTagsFromFile).mockResolvedValue({
      archive: { version: 1, books: [{ ...books[0]!, tags: ['Sea'] }] },
    })
    const { notice, archives } = mount(books, { changed: 0, failed: 0 })
    archives.importTags()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
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
    const marks = { loadAllNow: vi.fn(async () => []), addMany } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
    const library = { getSnapshot: () => books } as unknown as Library
    const notice = vi.fn()
    vi.mocked(importMarksFromFile).mockResolvedValue({
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
    const archives = wired({ library, marks, cards, notice })
    return { notice, archives }
  }

  const run = async (archives: Archives, notice: ReturnType<typeof vi.fn>) => {
    archives.importMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
  }

  it('counts what the plan held when every write landed', async () => {
    const { notice, archives } = mount()
    await run(archives, notice)
    expect(notice).toHaveBeenCalledWith('Added 3 marks and 0 cards across 2 books.')
  })

  it('says nothing was saved when every write was refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { notice, archives } = mount({ books: true })
    await run(archives, notice)
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
describe('an archive past what one file may hold', () => {
  it('imports nothing, and does not call a good file unreadable', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(importMarksFromFile).mockRejectedValue(new ArchiveOverLimit('past the budget'))
    const addMany = vi.fn(async () => {})
    const marks = { loadAllNow: vi.fn(async () => []), addMany } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: vi.fn(async () => {}) } as unknown as Cards
    const library = { getSnapshot: () => [] } as unknown as Library
    const notice = vi.fn()

    wired({ library, marks, cards, notice }).importMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())

    expect(addMany).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('That file holds more marks and cards than Paper can read from one file — nothing was imported.')
    logged.mockRestore()
  })
})

describe('marginalia after a failed scan', () => {
  function mount(failure = new MarksScanFailed(), shelf: readonly { bookId: string; title: string }[] = []) {
    const loadAllNow = vi.fn(() => Promise.reject(failure))
    const addMany = vi.fn(async () => {})
    const makeMany = vi.fn(async () => {})
    const marks = { loadAllNow, addMany } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
    const library = { getSnapshot: () => shelf } as unknown as Library
    const notice = vi.fn()
    const archives = wired({ library, marks, cards, notice })
    return { addMany, makeMany, notice, archives }
  }

  it('exports nothing, and does not blame the file it was about to write', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { notice, archives } = mount()

    archives.exportMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())

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
      archive: { version: 1, books: [] },
    } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
    const { addMany, makeMany, notice, archives } = mount()

    archives.importMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())

    /* Importing against an unknown baseline re-adds every mark in the archive:
       the plan's duplicate check is against what the scan found. */
    expect(addMany, 'marks were merged against a baseline that was never read').not.toHaveBeenCalled()
    expect(makeMany).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('Your marks could not be read — nothing was imported.')
    logged.mockRestore()
  })

  /* A REFUSAL THAT NAMES NO BOOK LEAVES THE READER NOTHING TO DO. One damaged file
     blocks both directions, for a whole library, so which one it is is the fact the
     sentence exists to carry. */
  describe('names the book that stopped it', () => {
    const shelf = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((title) => ({ bookId: `book:${title}`, title }))
    const folders = (count: number) => shelf.slice(0, count).map((book) => folderOf(book.bookId))
    const exported = async (failure: MarksScanFailed, books: readonly { bookId: string; title: string }[] = shelf) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { notice, archives } = mount(failure, books)
      archives.exportMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      logged.mockRestore()
      expect(vi.mocked(exportMarksToFile), 'an archive was written anyway').not.toHaveBeenCalled()
      return notice.mock.calls[0]?.[0]
    }

    it.each([
      [
        'one damaged file',
        { damaged: folders(1) },
        'The marks for Alpha could not be read — nothing was exported. Restore that marks file or remove the book, then try again.',
      ],
      [
        'two damaged files',
        { damaged: folders(2) },
        'The marks for Alpha, Beta could not be read — nothing was exported. Restore those marks files or remove the books, then try again.',
      ],
      [
        'more damaged files than a sentence holds',
        { damaged: folders(5) },
        'The marks for Alpha, Beta, Gamma and 2 more could not be read — nothing was exported. Restore those marks files or remove the books, then try again.',
      ],
      [
        'one unsaved book, which is not told to remove it',
        { unsaved: folders(1) },
        'A change to the marks for Alpha was not saved — nothing was exported. Open the book with the unsaved change again, then try again.',
      ],
      [
        'two unsaved books',
        { unsaved: folders(2) },
        'Changes to the marks for Alpha, Beta were not saved — nothing was exported. Open the books with unsaved changes again, then try again.',
      ],
      [
        'one of each',
        { damaged: folders(1), unsaved: folders(2).slice(1) },
        'The marks for Alpha could not be read and a change to the marks for Beta was not saved — nothing was exported. Restore that marks file or remove the book, and open the book with the unsaved change again, then try again.',
      ],
    ])('for %s', async (_name, books, sentence) => {
      expect(await exported(new MarksScanFailed(books))).toBe(sentence)
    })

    it('by its folder when the shelf has no row for it, which is still somewhere to look', async () => {
      expect(await exported(new MarksScanFailed({ damaged: ['books/book_gone'] }))).toBe(
        'The marks for the folder book_gone could not be read — nothing was exported. Restore that marks file or remove the book, then try again.',
      )
    })

    it('as an untitled book when its row has no title', async () => {
      const untitled = [{ bookId: 'book:x', title: '' }]
      expect(await exported(new MarksScanFailed({ damaged: [folderOf('book:x')] }), untitled)).toContain('The marks for an untitled book could not')
    })

    it('when importing as well', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(importMarksFromFile).mockResolvedValue({
        archive: { version: 1, books: [] },
      } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
      const { addMany, notice, archives } = mount(new MarksScanFailed({ damaged: folders(1) }), shelf)

      archives.importMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())

      expect(addMany).not.toHaveBeenCalled()
      expect(notice).toHaveBeenCalledWith(
        'The marks for Alpha could not be read — nothing was imported. Restore that marks file or remove the book, then try again.',
      )
      logged.mockRestore()
    })
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
    const marks = { loadAllNow: vi.fn(async () => []), addMany } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
    const library = { getSnapshot: () => books } as unknown as Library
    const notice = vi.fn()
    vi.mocked(importMarksFromFile).mockResolvedValue({
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
    const archives = wired({ library, marks, cards, notice })
    return { notice, archives, addMany, makeMany }
  }

  const run = async (archives: Archives, notice: ReturnType<typeof vi.fn>) => {
    archives.importMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
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
    const { notice, archives, addMany } = mount()
    await run(archives, notice)
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
    const { notice, archives, addMany } = mount()
    await run(archives, notice)
    const row = (addMany.mock.calls.flatMap((call) => call[1] as Record<string, unknown>[]))[0]!
    expect(row['text']).toBe('Call me Ishmael')
    expect(row['chapter']).toBe('Loomings')
    expect(row['tint']).toBe('yellow')
    expect(row['sectionIndex'], 'a placeholder, and it must not be negative').toBe(0)
  })

  it('names the book, and does not call it missing', async () => {
    /* "Not on this shelf" would send the reader looking for a book that is
       right there. The two lists exist so the two sentences can differ. */
    const { notice, archives } = mount()
    await run(archives, notice)
    const said = notice.mock.calls.at(-1)?.[0] as string
    /* THE SENTENCE CHANGED WITH THE BEHAVIOUR. It said "Not placed", which was
       the honest word for throwing the marks away; they are kept now, so it
       says what is true — the reader has them and cannot yet be taken to them. */
    expect(said).toContain('1 mark kept without a place — another edition here: Moby-Dick.')
    expect(said).not.toContain('Not on this shelf')
  })

  /**
   * ⚠️ **THE WHOLE SENTENCE, NOT A SUBSTRING OF IT.**
   *
   * The assertion above is `toContain`, and it passed for a notice that read
   * *"Nothing was saved. 1 mark kept without a place…"* — a sentence that
   * denies its own second half. MEASURED on the reader's screen against a real
   * import: three marks stored on disk, and the reader told nothing was.
   *
   * `marksAdded` counts PLACED rows, so a name-matched import scored zero on
   * every term of the "was anything saved" test while saving three marks. An
   * unplaced mark is saved — stored, listed, exported and synced — and the
   * count that decides this sentence has to include it.
   */
  it('does not open by denying the marks it just kept', async () => {
    const { notice, archives } = mount()
    await run(archives, notice)
    const said = notice.mock.calls.at(-1)?.[0] as string
    expect(said).not.toContain('Nothing was saved')
    expect(said).not.toContain('Nothing to add')
    expect(said, 'a count of placed rows is not the whole of what was saved').not.toContain('Added 0 marks')
    expect(said).toBe('1 mark kept without a place — another edition here: Moby-Dick.')
  })

  it('reports what LANDED, not what was planned, when the unplaced write fails', async () => {
    /* The rule `marksAdded` already follows, applied to the third class: a
       refused write must not promise the reader their marks were kept. */
    const { notice, archives, addMany } = mount()
    addMany.mockRejectedValue(new Error('disk full'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await run(archives, notice)
    const said = notice.mock.calls.at(-1)?.[0] as string
    expect(said).toContain('Nothing was saved.')
    expect(said, 'a refused write still claimed the marks were kept').not.toContain('kept without a place')
    expect(said).toContain('1 book could not be saved.')
    logged.mockRestore()
  })

  it('reads the CARDS outcome for the cards, not the unplaced write beside it', async () => {
    /* ⚠️ The unplaced writes are queued BETWEEN the per-book writes and the
       cards write, so `settled[plan.additions.length]` — which is what this
       read — is the first UNPLACED write, not the cards. With the unplaced
       write fulfilled and the cards write refused, the old arithmetic reported
       the cards as fine and never looked at their result at all. */
    const { notice, archives, makeMany } = mount()
    makeMany.mockRejectedValue(new Error('cards refused'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await run(archives, notice)
    const said = notice.mock.calls.at(-1)?.[0] as string
    expect(said, 'a failed card write was reported as a success').toContain('the cards could not be saved.')
    logged.mockRestore()
  })
})

describe('archives — importing cards with no book on this shelf', () => {
  it('writes each under the book id it left with, anchor kept, and counts it in the sentence', async () => {
    const makeMany = vi.fn(async () => {})
    const marks = { loadAllNow: vi.fn(async () => []), addMany: vi.fn(async () => {}) } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
    const library = { getSnapshot: () => [] } as unknown as Library
    const notice = vi.fn()
    vi.mocked(importMarksFromFile).mockResolvedValue({
      archive: {
        version: 1,
        books: [],
        looseCards: [
          {
            bookId: 'returned',
            kind: 'Idea',
            body: 'Still worth keeping',
            answer: '',
            source: 'Loomings',
            createdAt: '2026-01-03T00:00:00.000Z',
            localAnchor: { cfi: 'epubcfi(/6/2!/4/2)' },
          },
        ],
      },
    })
    const archives = wired({ library, marks, cards, notice })
    archives.importMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    expect(makeMany).toHaveBeenCalledWith([
      expect.objectContaining({ bookId: 'returned', kind: 'Idea', body: 'Still worth keeping', answer: '', source: 'Loomings', cfi: 'epubcfi(/6/2!/4/2)' }),
    ])
    expect(notice).toHaveBeenCalledWith('Added 0 marks and 1 card across 0 books.')
  })
})

describe('archives — an export too big to read back', () => {
  it('says so for tags, and does not blame the disk', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(exportTagsToFile).mockRejectedValue(new ArchiveOverLimit('67108865 bytes, past 67108864'))
    const library = { getSnapshot: () => [] } as unknown as Library
    const notice = vi.fn()
    const archives = wired({ library, marks: {} as MarkStore, cards: {} as Cards, notice })
    archives.exportTags()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    expect(notice.mock.calls).toEqual([['You have more tags than one file can hold and be read back — nothing was exported.']])
    logged.mockRestore()
  })

  it('says so, and does not blame the disk', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(exportMarksToFile).mockRejectedValue(new ArchiveOverLimit('200001 rows, past 200000'))
    const marks = { loadAllNow: vi.fn(async () => []) } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }) } as unknown as Cards
    const library = { getSnapshot: () => [] } as unknown as Library
    const notice = vi.fn()
    const archives = wired({ library, marks, cards, notice })
    archives.exportMarks()
    await vi.waitFor(() => expect(notice).toHaveBeenCalled())
    expect(notice.mock.calls).toEqual([['You have more marks and cards than one file can hold and be read back — nothing was exported.']])
    logged.mockRestore()
  })
})

describe('a batch of marks for one book', () => {
  const BOOK = 'book:abc'
  const shelf = () => fakeFs({ [recordPath(BOOK)]: JSON.stringify({ bookId: BOOK, title: 'Moby-Dick', author: 'Melville' }) })
  const draft = (over: Partial<NewMark>): NewMark =>
    ({
      bookId: BOOK,
      cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:12)',
      sectionIndex: 0,
      text: 'Ishmael',
      prefix: '',
      suffix: '',
      note: '',
      kind: 'highlight',
      tint: 'yellow',
      style: 'fill',
      chapter: 'Ch. 1',
      ...over,
    }) as NewMark

  it('is written whole, each draft minted into a mark', async () => {
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })
    await addDrafts(store, BOOK, [
      draft({}),
      draft({ cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:5)', text: 'Queequeg' }),
    ])

    const written = await store.forBook(BOOK)
    expect(written.map((mark) => mark.text).sort()).toEqual(['Ishmael', 'Queequeg'])
    expect(written.every((mark) => typeof mark.id === 'string' && mark.id !== '')).toBe(true)
  })

  it('is refused whole when it holds a draft of another book', async () => {
    /* The store writes the batch under the book it is NAMED for, so a draft
       carrying another id would land in this book's file owned by that one. */
    const store = createMarkStore({ fs: shelf(), queue: writeQueue() })

    await expect(addDrafts(store, BOOK, [draft({}), draft({ bookId: 'book:elsewhere' })])).rejects.toThrow(
      'addMany for book:abc was handed a draft belonging to book:elsewhere',
    )
    expect(await store.forBook(BOOK), 'part of a refused batch was written').toEqual([])
  })
})

/**
 * WHAT EACH ERRAND SAYS, sentence by sentence. The notice is the only thing a
 * reader learns from an archive errand, and the console line is the only thing
 * a report from them carries, so both are the behaviour under test here.
 */
describe('archives — what each errand says', () => {
  /* Every mocked layer answers at once, so one macrotask is past all of it. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})
  const book = (bookId: string, title: string, tags?: readonly string[]) =>
    ({ bookId, title, author: '', ...(tags === undefined ? {} : { tags }) }) as unknown as IndexedBook

  describe('exporting tags', () => {
    function mount(books: readonly IndexedBook[]) {
      const library = { getSnapshot: () => books } as unknown as Library
      const notice = vi.fn()
      return { notice, archives: wired({ library, marks: {} as MarkStore, cards: {} as Cards, notice }) }
    }

    it('says nothing when the reader closed the dialog', async () => {
      vi.mocked(exportTagsToFile).mockResolvedValue(false)
      const { notice, archives } = mount([book('a', 'A', ['Sea'])])
      archives.exportTags()
      await settle()
      expect(exportTagsToFile).toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
    })

    it('counts only the books that carry a tag', async () => {
      vi.mocked(exportTagsToFile).mockResolvedValue(true)
      const { notice, archives } = mount([book('a', 'A', ['Sea']), book('b', 'B', []), book('c', 'C')])
      archives.exportTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['Exported the tags on 1 book.']])
    })

    it('counts books in the plural', async () => {
      vi.mocked(exportTagsToFile).mockResolvedValue(true)
      const { notice, archives } = mount([book('a', 'A', ['Sea']), book('b', 'B', ['Sky', 'Sea'])])
      archives.exportTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['Exported the tags on 2 books.']])
    })

    it('says when nothing on the shelf is filed', async () => {
      vi.mocked(exportTagsToFile).mockResolvedValue(true)
      const { notice, archives } = mount([book('b', 'B', []), book('c', 'C')])
      archives.exportTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['No tags to export yet — nothing on the shelf is filed.']])
    })

    it('names a failed write as a write, and logs it', async () => {
      const logged = quiet()
      const cause = new Error('disk full')
      vi.mocked(exportTagsToFile).mockRejectedValue(cause)
      const { notice, archives } = mount([book('a', 'A', ['Sea'])])
      archives.exportTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['Those tags could not be written.']])
      expect(logged).toHaveBeenCalledWith('Paper: could not export your tags', cause)
      logged.mockRestore()
    })

    it('logs an archive past the limit as that', async () => {
      const logged = quiet()
      const cause = new ArchiveOverLimit('67108865 bytes, past 67108864')
      vi.mocked(exportTagsToFile).mockRejectedValue(cause)
      const { notice, archives } = mount([])
      archives.exportTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(logged).toHaveBeenCalledWith('Paper: your filing is past what one archive can hold', cause)
      logged.mockRestore()
    })
  })

  describe('importing tags', () => {
    function mount(books: readonly IndexedBook[], tagMany = vi.fn(async () => ({ changed: 1, failed: 0 }))) {
      const library = { getSnapshot: () => books, tagMany } as unknown as Library
      const notice = vi.fn()
      return { notice, tagMany, archives: wired({ library, marks: {} as MarkStore, cards: {} as Cards, notice }) }
    }

    it('says nothing when the reader closed the dialog', async () => {
      vi.mocked(importTagsFromFile).mockResolvedValue(null)
      const { notice, tagMany, archives } = mount([book('a', 'A')])
      archives.importTags()
      await settle()
      expect(importTagsFromFile).toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
      expect(tagMany).not.toHaveBeenCalled()
    })

    it('refuses a file that is not a tag export, and writes nothing', async () => {
      vi.mocked(importTagsFromFile).mockResolvedValue({ archive: null })
      const { notice, tagMany, archives } = mount([book('a', 'A')])
      archives.importTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['That file is not a Paper tag export.']])
      expect(tagMany).not.toHaveBeenCalled()
    })

    it('writes nothing when nothing is new, and counts what is not on this shelf', async () => {
      vi.mocked(importTagsFromFile).mockResolvedValue({
        archive: { version: 1, books: [{ bookId: 'elsewhere', title: 'Gone', author: '', tags: ['Sea'] }] },
      })
      const { notice, tagMany, archives } = mount([book('a', 'A')])
      archives.importTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(tagMany).not.toHaveBeenCalled()
      expect(notice.mock.calls).toEqual([['Nothing to add — those tags are already here. 1 not on this shelf.']])
    })

    it('counts one tag on one book in the singular', async () => {
      vi.mocked(importTagsFromFile).mockResolvedValue({
        archive: { version: 1, books: [{ bookId: 'a', title: 'A', author: '', tags: ['Sea'] }] },
      })
      const { notice, archives } = mount([book('a', 'A')])
      archives.importTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['Added 1 tag across 1 book.']])
    })

    it('blames the file when it could not be read', async () => {
      const logged = quiet()
      const cause = new Error('unreadable')
      vi.mocked(importTagsFromFile).mockRejectedValue(cause)
      const { notice, archives } = mount([book('a', 'A')])
      archives.importTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['That file could not be read.']])
      expect(logged).toHaveBeenCalledWith('Paper: could not import those tags', cause)
      logged.mockRestore()
    })

    it('does not blame a file it read when the write was refused', async () => {
      const logged = quiet()
      vi.mocked(importTagsFromFile).mockResolvedValue({
        archive: { version: 1, books: [{ bookId: 'a', title: 'A', author: '', tags: ['Sea'] }] },
      })
      const { notice, archives } = mount([book('a', 'A')], vi.fn(() => Promise.reject(new Error('disk full'))))
      archives.importTags()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['The file was read, but those tags could not be saved.']])
      logged.mockRestore()
    })
  })

  describe('exporting marginalia', () => {
    function mount() {
      const marks = { loadAllNow: vi.fn(async () => []) } as unknown as MarkStore
      const cards = { getSnapshot: () => ({ all: [] }) } as unknown as Cards
      const library = { getSnapshot: () => [] } as unknown as Library
      const notice = vi.fn()
      return { notice, archives: wired({ library, marks, cards, notice }) }
    }

    it('says nothing when the reader closed the dialog', async () => {
      vi.mocked(exportMarksToFile).mockResolvedValue(null)
      const { notice, archives } = mount()
      archives.exportMarks()
      await settle()
      expect(exportMarksToFile).toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
    })

    it.each([
      [{ format: 'json', books: 1, marks: 0, cards: 2 }, 'Exported 0 marks and 2 cards from 1 book.'],
      [{ format: 'md', books: 2, marks: 1, cards: 1 }, 'Exported 1 mark and 1 card from 2 books as Markdown, which cannot be imported back.'],
      [{ format: 'json', books: 3, marks: 2, cards: 0 }, 'Exported 2 marks and 0 cards from 3 books.'],
    ] as const)('says what it wrote: %o', async (written, sentence) => {
      vi.mocked(exportMarksToFile).mockResolvedValue(written)
      const { notice, archives } = mount()
      archives.exportMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([[sentence]])
    })

    it('names a failed write as a write, and logs it', async () => {
      const logged = quiet()
      const cause = new Error('disk full')
      vi.mocked(exportMarksToFile).mockRejectedValue(cause)
      const { notice, archives } = mount()
      archives.exportMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice.mock.calls).toEqual([['Those marks could not be written.']])
      expect(logged).toHaveBeenCalledWith('Paper: could not export your marginalia', cause)
      logged.mockRestore()
    })

    it('logs an archive past the limit as that', async () => {
      const logged = quiet()
      const cause = new ArchiveOverLimit('200001 rows, past 200000')
      vi.mocked(exportMarksToFile).mockRejectedValue(cause)
      const { notice, archives } = mount()
      archives.exportMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(logged).toHaveBeenCalledWith('Paper: your marginalia is past what one archive can hold', cause)
      logged.mockRestore()
    })

    it('logs a scan that failed as the shelf, not the file', async () => {
      const logged = quiet()
      const cause = new MarksScanFailed()
      const marks = { loadAllNow: vi.fn(() => Promise.reject(cause)) } as unknown as MarkStore
      const notice = vi.fn()
      wired({ library: { getSnapshot: () => [] } as unknown as Library, marks, cards: {} as Cards, notice }).exportMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(logged).toHaveBeenCalledWith('Paper: could not read your marginalia to export it', cause)
      logged.mockRestore()
    })
  })

  describe('importing marginalia', () => {
    const mark = (text: string, at = text.length, createdAt = '2026-01-01T00:00:00.000Z') => ({
      text,
      prefix: '',
      suffix: '',
      note: '',
      kind: 'highlight',
      tint: 'yellow',
      style: 'fill',
      chapter: 'One',
      createdAt,
      localAnchor: { cfi: `epubcfi(/6/2!/4/${at})`, sectionIndex: 1 },
    })
    const card = (body: string) => ({ kind: 'Idea', body, answer: '', source: '', createdAt: '2026-01-02T00:00:00.000Z', localAnchor: null })
    const row = (bookId: string, title: string, marks: unknown[], cards: unknown[] = []) => ({ bookId, title, author: '', marks, cards })

    interface Setup {
      readonly shelf?: readonly IndexedBook[]
      readonly have?: readonly unknown[]
      /** Which `addMany` calls throw, by book and by the rows handed over. */
      readonly refuse?: (bookId: string, rows: { unplaced?: unknown }[]) => boolean
      readonly refuseCards?: boolean
    }

    function mount(
      archiveBooks: unknown[],
      { shelf = [book('book_a', 'A'), book('book_b', 'B')], have = [], refuse = () => false, refuseCards = false }: Setup = {},
    ) {
      const addMany = vi.fn(async (bookId: string, rows: { unplaced?: unknown }[]) => {
        if (refuse(bookId, rows)) throw new Error(`refused ${bookId}`)
      })
      const makeMany = vi.fn(async (_cards: readonly unknown[]) => {
        if (refuseCards) throw new Error('cards refused')
      })
      const marks = { loadAllNow: vi.fn(async () => have), addMany } as unknown as MarkStore
      const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
      const library = { getSnapshot: () => shelf } as unknown as Library
      const notice = vi.fn()
      vi.mocked(importMarksFromFile).mockResolvedValue({
        archive: { version: 1, books: archiveBooks },
      } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
      return { notice, addMany, makeMany, loadAllNow: marks.loadAllNow, archives: wired({ library, marks, cards, notice }) }
    }

    const said = async (archives: Archives, notice: ReturnType<typeof vi.fn>) => {
      archives.importMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(notice).toHaveBeenCalledTimes(1)
      return notice.mock.calls[0]?.[0] as string
    }

    it('says nothing when the reader closed the dialog', async () => {
      const { notice, loadAllNow, archives } = mount([])
      vi.mocked(importMarksFromFile).mockResolvedValue(null)
      archives.importMarks()
      await settle()
      expect(importMarksFromFile).toHaveBeenCalled()
      expect(loadAllNow).not.toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
    })

    it('refuses a file that is not a marginalia export, and reads nothing against it', async () => {
      const { notice, loadAllNow, archives } = mount([])
      vi.mocked(importMarksFromFile).mockResolvedValue({ archive: null })
      expect(await said(archives, notice)).toBe('That file is not a Paper marginalia export.')
      expect(loadAllNow).not.toHaveBeenCalled()
    })

    it('writes each book once when every mark has its place, and counts one in the singular', async () => {
      const { notice, addMany, archives } = mount([row('book_a', 'A', [mark('one')])])
      expect(await said(archives, notice)).toBe('Added 1 mark and 0 cards across 1 book.')
      expect(addMany).toHaveBeenCalledTimes(1)
    })

    it('files a book’s cards under that book', async () => {
      const { notice, makeMany, archives } = mount([row('book_a', 'A', [], [card('Worth keeping')])])
      expect(await said(archives, notice)).toBe('Added 0 marks and 1 card across 1 book.')
      expect(makeMany).toHaveBeenCalledWith([expect.objectContaining({ bookId: 'book_a', body: 'Worth keeping', cfi: null })])
    })

    it('counts only the books whose write landed, and logs the one that did not', async () => {
      const logged = quiet()
      const { notice, archives } = mount([row('book_a', 'A', [mark('one'), mark('three')]), row('book_b', 'B', [mark('two')])], {
        refuse: (bookId) => bookId === 'book_b',
      })
      expect(await said(archives, notice)).toBe('Added 2 marks and 0 cards across 1 book. 1 book could not be saved.')
      expect(logged.mock.calls).toEqual([['Paper: an import write failed', new Error('refused book_b')]])
      logged.mockRestore()
    })

    it('logs nothing when every write landed', async () => {
      const logged = quiet()
      const { notice, archives } = mount([row('book_a', 'A', [mark('one')])])
      await said(archives, notice)
      expect(logged).not.toHaveBeenCalled()
      logged.mockRestore()
    })

    it('says the cards alone could not be saved, without a count of books', async () => {
      const logged = quiet()
      const { notice, archives } = mount([row('book_a', 'A', [mark('one')], [card('Worth keeping')])], { refuseCards: true })
      expect(await said(archives, notice)).toBe('Added 1 mark and 0 cards across 1 book. the cards could not be saved.')
      logged.mockRestore()
    })

    it('says a book and the cards could not be saved, in one breath', async () => {
      const logged = quiet()
      const { notice, archives } = mount(
        [row('book_a', 'A', [mark('one')]), row('book_b', 'B', [mark('two')], [card('Worth keeping')])],
        { refuse: (bookId) => bookId === 'book_b', refuseCards: true },
      )
      expect(await said(archives, notice)).toBe('Added 1 mark and 0 cards across 1 book. 1 book and the cards could not be saved.')
      logged.mockRestore()
    })

    it('names up to three books that are not on this shelf, and counts no more', async () => {
      const { notice, archives } = mount([
        row('book_a', 'A', [mark('one')]),
        row('x1', 'Gone One', [mark('one')]),
        row('x2', 'Gone Two', [mark('one')]),
        row('x3', 'Gone Three', [mark('one')]),
      ])
      expect(await said(archives, notice)).toBe('Added 1 mark and 0 cards across 1 book. Not on this shelf: Gone One, Gone Two, Gone Three.')
    })

    it('says what was already here, and that there was nothing to add', async () => {
      const have = [{ id: 'm1', bookId: 'book_a', kind: 'highlight', cfi: '', sectionIndex: 0, text: 'one', createdAt: 1 }]
      const { notice, addMany, archives } = mount([row('book_a', 'A', [mark('one')])], { have })
      expect(await said(archives, notice)).toBe('Nothing to add. 1 already here.')
      expect(addMany).not.toHaveBeenCalled()
    })

    it.each([
      [2, ' 1 overlapping mark kept as one.'],
      [3, ' 2 overlapping marks kept as one.'],
    ])('says when %i marks of the file overlapped and were kept as one', async (copies, sentence) => {
      const { notice, archives } = mount([row('book_a', 'A', Array.from({ length: copies }, () => mark('one')))])
      expect(await said(archives, notice)).toBe(`Added 1 mark and 0 cards across 1 book.${sentence}`)
    })

    describe('beside a book found only by its name', () => {
      const shelf = [book('book_a', 'A'), { bookId: 'local-copy', title: 'Moby-Dick', author: 'Herman Melville' } as unknown as IndexedBook]
      const moby = (marks: unknown[]) => ({ bookId: 'from-elsewhere', title: 'Moby-Dick', author: 'Herman Melville', marks, cards: [] })
      const unplacedRows = (rows: { unplaced?: unknown }[]) => rows.length > 0 && rows.every((one) => one.unplaced !== undefined)

      it('counts marks kept without a place in the plural', async () => {
        const { notice, archives } = mount([moby([mark('one'), mark('three', 9)])], { shelf })
        expect(await said(archives, notice)).toBe('2 marks kept without a place — another edition here: Moby-Dick.')
      })

      it('gives a stranded write only to the book that has stranded marks', async () => {
        /* Two placed writes (book_a, and the name-matched copy's empty one)
           and ONE stranded write, the copy's: book_a has nothing stranded. */
        const { notice, addMany, archives } = mount([row('book_a', 'A', [mark('one')]), moby([mark('two')])], { shelf })
        await said(archives, notice)
        const stranded = addMany.mock.calls.filter((call) => call[1].some((one) => one.unplaced !== undefined))
        expect(stranded.map((call) => call[0])).toEqual(['local-copy'])
        expect(addMany).toHaveBeenCalledTimes(3)
      })

      it('reads each unplaced write’s own outcome, not a placed one beside it', async () => {
        const logged = quiet()
        const { notice, archives } = mount([row('book_a', 'A', [mark('one')]), moby([mark('two')])], {
          shelf,
          refuse: (bookId, rows) => bookId === 'book_a' && !unplacedRows(rows),
        })
        expect(await said(archives, notice)).toBe(
          '1 mark kept without a place — another edition here: Moby-Dick. 1 book could not be saved.',
        )
        logged.mockRestore()
      })

      it('counts a book whose unplaced write alone was refused', async () => {
        const logged = quiet()
        const { notice, archives } = mount([moby([mark('two')])], { shelf, refuse: (_bookId, rows) => unplacedRows(rows) })
        expect(await said(archives, notice)).toBe('Nothing was saved. 1 book could not be saved.')
        logged.mockRestore()
      })
    })

    it('blames the file when it could not be read, and logs it', async () => {
      const logged = quiet()
      const cause = new Error('unreadable')
      const { notice, archives } = mount([])
      vi.mocked(importMarksFromFile).mockRejectedValue(cause)
      expect(await said(archives, notice)).toBe('That file could not be read.')
      expect(logged).toHaveBeenCalledWith('Paper: could not import that marginalia', cause)
      logged.mockRestore()
    })

    it('logs an archive past the limit as that', async () => {
      const logged = quiet()
      const cause = new ArchiveOverLimit('past the budget')
      const { notice, archives } = mount([])
      vi.mocked(importMarksFromFile).mockRejectedValue(cause)
      await said(archives, notice)
      expect(logged).toHaveBeenCalledWith('Paper: that marginalia is past what one archive can hold', cause)
      logged.mockRestore()
    })

    it('logs a scan that failed as the shelf, not the file', async () => {
      const logged = quiet()
      const cause = new MarksScanFailed()
      const notice = vi.fn()
      const marks = { loadAllNow: vi.fn(() => Promise.reject(cause)) } as unknown as MarkStore
      vi.mocked(importMarksFromFile).mockResolvedValue({ archive: { version: 1, books: [] } } as unknown as Awaited<ReturnType<typeof importMarksFromFile>>)
      wired({ library: { getSnapshot: () => [] } as unknown as Library, marks, cards: {} as Cards, notice }).importMarks()
      await vi.waitFor(() => expect(notice).toHaveBeenCalled())
      expect(logged).toHaveBeenCalledWith('Paper: could not read your marginalia to import against it', cause)
      logged.mockRestore()
    })
  })
})
