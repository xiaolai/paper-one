import { describe, expect, it } from 'vitest'
import { marksPathIn, parseRecord, recordPath, trashOf } from './bookFolder'
import { loadShelf } from './bookIndex'
import { parseCards } from './cards'
import { fakeFs, jsonAt } from './fakeFs.testkit'
import { validMarks } from './marks'
import { createKernelServices } from './services'

/**
 * A PHASE-4 LIBRARY UNDER THE PHASE-6 PARSER — the backward-compatibility
 * claim of WI-A.2, as a fixture rather than a sentence.
 *
 * The fixture is what a real library looked like the day before the ledger:
 * `book.json` without any register or stamp, `marks.json` as plain arrays,
 * cards in the flat store, a trash entry with its `.removed` stamp — built
 * here byte for byte, so a change to any parser that would misread an
 * existing library fails THIS file rather than a reader.
 */

const REC_A = {
  bookId: 'book:aaaa',
  title: 'Moby-Dick',
  author: 'Herman Melville',
  tags: ['Sea', 'To reread'],
  position: 'epubcfi(/6/4!/4/2)',
  progress: 0.42,
  finished: false,
  addedAt: 1_690_000_000_000,
  openedAt: 1_695_000_000_000,
  parsedAt: 1_695_000_000_001,
  origin: '/Users/reader/Books/moby.epub',
  ext: 'epub',
}

const REC_B = {
  bookId: 'book:bbbb',
  title: 'Walden',
  author: 'Henry David Thoreau',
  addedAt: 1_691_000_000_000,
}

const MARK = {
  id: 'm-legacy-1',
  bookId: 'book:aaaa',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)',
  sectionIndex: 0,
  text: 'Call me Ishmael',
  prefix: '',
  suffix: '',
  note: 'the famous opening',
  kind: 'highlight' as const,
  chapter: 'Loomings',
  createdAt: 1_695_000_000_002,
}

/**
 * The same mark as the parser now hands it back.
 *
 * A phase-4 file predates the mark having an appearance, so the parser names
 * one — and the pair it names is the appearance that mark ALREADY HAD: every
 * highlight was a solid yellow fill before there was anything else to choose.
 * Nothing is invented here in the sense this suite cares about; no stamp, no
 * register and no tombstone appears, which is what the assertions below check
 * field by field.
 */
const MARK_READ = { ...MARK, tint: 'yellow' as const, style: 'fill' as const }

const CARD = {
  id: 'c-legacy-1',
  bookId: 'book:aaaa',
  kind: 'Excerpt' as const,
  body: 'Call me Ishmael',
  answer: '',
  source: 'Loomings',
  cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)',
  createdAt: 1_695_000_000_003,
}

const TRASHED = {
  bookId: 'book:cccc',
  title: 'Removed Book',
  author: '',
  addedAt: 1_680_000_000_000,
}

function phase4Library() {
  return fakeFs({
    [recordPath('book:aaaa')]: JSON.stringify(REC_A, null, 2),
    'books/book_aaaa/content.epub': 'the bytes',
    [marksPathIn('book:aaaa')]: JSON.stringify([MARK]),
    [recordPath('book:bbbb')]: JSON.stringify(REC_B, null, 2),
    'books/book_bbbb/content.epub': 'other bytes',
    [`${trashOf('book:cccc')}/book.json`]: JSON.stringify(TRASHED, null, 2),
    [`${trashOf('book:cccc')}/.removed`]: String(1_700_000_000_000),
  })
}

const flatStore = () => {
  const map = new Map<string, string>([['paper.cards.v1', JSON.stringify([CARD])]])
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

describe('a phase-4 library opens identical under the new parser', () => {
  it('every record comes back exactly as it was written', () => {
    expect(parseRecord(JSON.stringify(REC_A))).toEqual(REC_A)
    expect(parseRecord(JSON.stringify(REC_B))).toEqual(REC_B)
    expect(parseRecord(JSON.stringify(TRASHED))).toEqual(TRASHED)
  })

  it('the shelf, the marks and the cards read back whole, no stamps invented', async () => {
    const fs = phase4Library()
    const { books } = await loadShelf(fs)
    expect(books.map((one) => one.bookId).sort()).toEqual(['book:aaaa', 'book:bbbb'])
    const a = books.find((one) => one.bookId === 'book:aaaa')!
    expect(a).toEqual({ ...REC_A, hasContent: true })
    // No parser added a register, a stamp or a tombstone to anything.
    for (const book of books) {
      expect(book).not.toHaveProperty('positionAt')
      expect(book).not.toHaveProperty('finishedAt')
      expect(book).not.toHaveProperty('tagClock')
      expect(book).not.toHaveProperty('format')
    }
    expect(validMarks([MARK])).toEqual([MARK_READ])
    for (const one of validMarks([MARK])) {
      expect(one).not.toHaveProperty('updatedAt')
      expect(one).not.toHaveProperty('deletedAt')
    }
    expect(parseCards(JSON.stringify([CARD]))).toEqual([CARD])
  })

  it('the services over the fixture show what the phase-4 build showed', async () => {
    const fs = phase4Library()
    const { books } = await loadShelf(fs)
    const storage = flatStore()
    const kernel = createKernelServices({ fs, storage, initialBooks: books })
    await kernel.marks.open('book:aaaa')
    await kernel.writes.idle()
    expect(kernel.marks.getSnapshot().current).toEqual([MARK_READ])
    expect(kernel.cards.getSnapshot().all).toEqual([CARD])
    expect(kernel.library.positionOf('book:aaaa')).toBe(REC_A.position)
  })
})

describe('deleting a legacy mark under the new store', () => {
  it('leaves a tombstone row in the file and no row in the read model', async () => {
    const fs = phase4Library()
    const { books } = await loadShelf(fs)
    const kernel = createKernelServices({ fs, storage: flatStore(), initialBooks: books })
    await kernel.marks.open('book:aaaa')
    await kernel.marks.remove(MARK.id)
    await kernel.drain()

    const rows = jsonAt(fs, marksPathIn('book:aaaa')) as (typeof MARK & { deletedAt?: string })[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject(MARK)
    expect(rows[0]!.deletedAt).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{16}$/)
    expect(kernel.marks.getSnapshot().current).toEqual([])
    expect(await kernel.marks.forBook('book:aaaa')).toEqual([])
  })

  it('and a legacy card deletes the same way', async () => {
    const storage = flatStore()
    const kernel = createKernelServices({ fs: null, storage })
    await kernel.cards.remove(CARD.id)
    await kernel.drain()
    const rows = JSON.parse(storage.map.get('paper.cards.v1')!) as (typeof CARD & { deletedAt?: string })[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.deletedAt).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{16}$/)
    expect(kernel.cards.getSnapshot().all).toEqual([])
  })
})
