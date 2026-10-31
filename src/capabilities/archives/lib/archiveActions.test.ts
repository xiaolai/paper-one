import { describe, expect, it, vi } from 'vitest'
import {
  MarksScanFailed,
  createMarkStore,
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
describe('marginalia after a failed scan', () => {
  function mount() {
    const loadAllNow = vi.fn(() => Promise.reject(new MarksScanFailed()))
    const addMany = vi.fn(async () => {})
    const makeMany = vi.fn(async () => {})
    const marks = { loadAllNow, addMany } as unknown as MarkStore
    const cards = { getSnapshot: () => ({ all: [] }), addMany: makeMany } as unknown as Cards
    const library = { getSnapshot: () => [] } as unknown as Library
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
