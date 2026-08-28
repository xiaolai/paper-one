import { describe, expect, it } from 'vitest'
import {
  archiveName,
  exportMarks,
  parseArchive,
  planImport,
  toMarkdown,
  type MarksArchive,
} from './marksArchive'
import type { IndexedBook } from './bookIndex'
import type { Card } from './cards'
import type { Mark } from './marks'
import { hlcOf } from './hlc'

/**
 * The door: everything the reader wrote, out to a file and back.
 *
 * The rules under test are the tag archive's three, plus one this module owes
 * that the tag archive does not: a book in the file that is not on the shelf is
 * REPORTED BY NAME rather than dropped, because a count is not something a
 * reader can act on.
 */

const BOOK = (over: Partial<IndexedBook> = {}): IndexedBook =>
  ({
    bookId: 'moby',
    title: 'Moby-Dick',
    author: 'Herman Melville',
    addedAt: 1,
    ...over,
  }) as IndexedBook

const MARK = (over: Partial<Mark> = {}): Mark =>
  ({
    id: 'm1',
    bookId: 'moby',
    cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:15)',
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: 'before ',
    suffix: ' after',
    note: 'the first line',
    kind: 'highlight',
    tint: 'green',
    style: 'underline',
    chapter: 'Loomings',
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    ...over,
  }) as Mark

const CARD = (over: Partial<Card> = {}): Card =>
  ({
    id: 'c1',
    bookId: 'moby',
    kind: 'Recall',
    body: 'Who narrates?',
    answer: 'Ishmael',
    source: 'Loomings',
    cfi: 'epubcfi(/6/4!/4/2)',
    createdAt: Date.UTC(2026, 0, 3),
    ...over,
  }) as Card

describe('exportMarks', () => {
  it('carries the quote, its context, the note, the colour and the chapter', () => {
    const doc = exportMarks([BOOK()], [MARK()], [])
    expect(doc.books).toHaveLength(1)
    expect(doc.books[0]?.marks[0]).toEqual({
      text: 'Call me Ishmael',
      prefix: 'before ',
      suffix: ' after',
      note: 'the first line',
      kind: 'highlight',
      tint: 'green',
      style: 'underline',
      chapter: 'Loomings',
      createdAt: '2026-01-02T03:04:05.000Z',
      localAnchor: { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:15)', sectionIndex: 0 },
    })
  })

  it('writes createdAt as ISO 8601, not an epoch integer', () => {
    /* This is a document a reader opens in a text editor. `1767322 ...` is a
       number nobody can read; the date is the useful question about a backup. */
    const doc = exportMarks([BOOK()], [MARK()], [])
    expect(doc.books[0]?.marks[0]?.createdAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('omits the ledger stamps, which regenerate', () => {
    /* The tag archive's publisher-subject rule wearing different clothes:
       exporting something that regenerates itself backs up a copy of nothing,
       and importing it would forge a causal history. */
    const stamped = MARK({ updatedAt: hlcOf(5) })
    const doc = exportMarks([BOOK()], [stamped], [])
    const row = doc.books[0]?.marks[0] as unknown as Record<string, unknown>
    expect(row['updatedAt']).toBeUndefined()
    expect(row['deletedAt']).toBeUndefined()
    expect(row['id']).toBeUndefined()
    expect(row['bookId']).toBeUndefined()
  })

  it('does not export a tombstoned mark', () => {
    const doc = exportMarks([BOOK()], [MARK({ deletedAt: hlcOf(9) })], [])
    expect(doc.books).toEqual([])
  })

  it('leaves out a book with nothing on it', () => {
    const doc = exportMarks([BOOK(), BOOK({ bookId: 'blank', title: 'Blank' })], [MARK()], [])
    expect(doc.books.map((book) => book.bookId)).toEqual(['moby'])
  })

  it('names the book three ways, for the archive\'s two jobs', () => {
    const doc = exportMarks([BOOK()], [MARK()], [])
    expect(doc.books[0]).toMatchObject({
      bookId: 'moby',
      title: 'Moby-Dick',
      author: 'Herman Melville',
    })
  })

  it('carries cards, and drops a tombstoned one', () => {
    const doc = exportMarks([BOOK()], [], [CARD(), CARD({ id: 'c2', deletedAt: hlcOf(3) })])
    expect(doc.books[0]?.cards).toHaveLength(1)
    expect(doc.books[0]?.cards[0]).toMatchObject({ body: 'Who narrates?', answer: 'Ishmael' })
  })
})

describe('parseArchive', () => {
  const roundTrip = (doc: MarksArchive) => parseArchive(JSON.stringify(doc))

  it('round-trips a fixture library', () => {
    const doc = exportMarks([BOOK()], [MARK()], [CARD()])
    expect(roundTrip(doc)).toEqual(doc)
  })

  it('is null for a file that is not an archive at all', () => {
    expect(parseArchive('not json')).toBeNull()
    expect(parseArchive('[]')).toBeNull()
    expect(parseArchive('{"version":2,"books":[]}')).toBeNull()
  })

  it('keeps the good rows from a file with broken ones', () => {
    /* THE RECOVERY-PATH RULE, stated in `tagArchive` and copied here: refusing
       a whole file over one bad row is the behaviour that makes a backup
       worthless at the moment it is needed. */
    const doc = exportMarks([BOOK()], [MARK(), MARK({ id: 'm2', text: 'a second' })], [])
    const mangled = JSON.parse(JSON.stringify(doc)) as {
      books: { marks: unknown[]; bookId: string }[]
    }
    mangled.books[0]!.marks.push(null, 42, { text: '' })
    const parsed = parseArchive(JSON.stringify(mangled))
    expect(parsed?.books[0]?.marks.map((m) => m.text)).toEqual(['Call me Ishmael', 'a second'])
  })

  it('refuses a row that names no book by either route', () => {
    const parsed = parseArchive(
      JSON.stringify({ version: 1, books: [{ bookId: '', title: '', marks: [{ text: 'x' }] }] }),
    )
    expect(parsed?.books).toEqual([])
  })

  it('falls back rather than trusting a tint or style from a file nobody vouches for', () => {
    const parsed = parseArchive(
      JSON.stringify({
        version: 1,
        books: [{ bookId: 'moby', title: 'M', marks: [{ text: 'x', tint: 'chartreuse', style: 'sparkle' }] }],
      }),
    )
    expect(parsed?.books[0]?.marks[0]).toMatchObject({ tint: 'yellow', style: 'fill' })
  })
})

describe('planImport', () => {
  it('matches by id, and adds what the shelf does not have', () => {
    const doc = exportMarks([BOOK()], [MARK()], [])
    const plan = planImport(doc, [BOOK()], [], [])
    expect(plan.marksAdded).toBe(1)
    expect(plan.booksTouched).toBe(1)
    expect(plan.additions[0]?.bookId).toBe('moby')
    expect(plan.unmatched).toEqual([])
  })

  it('matches by folded title and author when the id is not on this shelf', () => {
    /* How marginalia follows a WORK to a different download of it — the bytes
       there are not the same bytes, so the id cannot match. */
    const doc = exportMarks([BOOK({ bookId: 'from-elsewhere' })], [MARK({ bookId: 'from-elsewhere' })], [])
    const plan = planImport(doc, [BOOK({ bookId: 'local-copy' })], [], [])
    expect(plan.additions[0]?.bookId).toBe('local-copy')
  })

  it('skips a name that two books on the shelf answer to, rather than guessing', () => {
    /* Two editions of one title are exactly where a wrong guess would put
       someone's work on the wrong book. */
    const doc = exportMarks([BOOK({ bookId: 'elsewhere' })], [MARK({ bookId: 'elsewhere' })], [])
    const plan = planImport(
      doc,
      [BOOK({ bookId: 'a' }), BOOK({ bookId: 'b' })],
      [],
      [],
    )
    expect(plan.additions).toEqual([])
    expect(plan.unmatched).toEqual([
      { title: 'Moby-Dick', author: 'Herman Melville', marks: 1, cards: 0 },
    ])
  })

  it('reports a missing book BY NAME rather than dropping it', () => {
    /* The difference between a backup and a placebo. A count tells the reader
       a number; the titles tell them whether the missing book matters. */
    const doc = exportMarks(
      [BOOK({ bookId: 'gone', title: 'Ulysses', author: 'James Joyce' })],
      [MARK({ bookId: 'gone' }), MARK({ id: 'm2', bookId: 'gone', text: 'two' })],
      [CARD({ bookId: 'gone' })],
    )
    const plan = planImport(doc, [], [], [])
    expect(plan.unmatched).toEqual([
      { title: 'Ulysses', author: 'James Joyce', marks: 2, cards: 1 },
    ])
    expect(plan.marksAdded).toBe(0)
  })

  it('adds nothing when re-imported into the library it came from', () => {
    /* BY OVERLAP, NOT BY EQUAL CFIs. `markMatch` exists because a mark and a
       passage are the same thing when their CFIs overlap; a strict comparison
       would double every highlight on a re-import. */
    const shelf = [BOOK()]
    const mine = [MARK()]
    const doc = exportMarks(shelf, mine, [])
    const plan = planImport(doc, shelf, mine, [])
    expect(plan.marksAdded).toBe(0)
    expect(plan.booksTouched).toBe(0)
    expect(plan.duplicates).toBe(1)
  })

  it('counts an overlapping-but-not-identical mark as already there', () => {
    const shelf = [BOOK()]
    const doc = exportMarks(shelf, [MARK({ cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:15)' })], [])
    const mine = [MARK({ id: 'existing', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:20)' })]
    const plan = planImport(doc, shelf, mine, [])
    expect(plan.marksAdded).toBe(0)
    expect(plan.duplicates).toBe(1)
  })

  it('adds a mark that overlaps nothing on the shelf', () => {
    const shelf = [BOOK()]
    const doc = exportMarks(shelf, [MARK({ cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)' })], [])
    const mine = [MARK({ id: 'existing', cfi: 'epubcfi(/6/4!/4/2,/1:40,/1:60)' })]
    expect(planImport(doc, shelf, mine, []).marksAdded).toBe(1)
  })

  /**
   * ⚠️ **ONE BOOKMARK USED TO EAT EVERY ARCHIVED HIGHLIGHT ON ITS PAGE.** A
   * bookmark's CFI is the visible page, so it overlaps each highlight there;
   * the duplicate test compared CFIs and never asked what class the two were.
   * `upsertOverlapping` was fixed for this with `sameClass`; the import was
   * not. Measured 2026-08-27: `marksAdded: 0, duplicates: 1`.
   */
  it('does not count a bookmark as a duplicate of a highlight on its page, nor the reverse', () => {
    const shelf = [BOOK()]
    const highlight = MARK({ id: 'h', cfi: 'epubcfi(/6/4!/4/2,/1:10,/1:30)' })
    const bookmark = MARK({ id: 'b', kind: 'bookmark', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:400)', text: '', note: '' })
    const highlightIn = planImport(exportMarks(shelf, [highlight], []), shelf, [bookmark], [])
    expect(highlightIn.marksAdded).toBe(1)
    expect(highlightIn.duplicates).toBe(0)
    const bookmarkIn = planImport(exportMarks(shelf, [bookmark], []), shelf, [highlight], [])
    expect(bookmarkIn.marksAdded).toBe(1)
    expect(bookmarkIn.duplicates).toBe(0)
    /* A bookmark on the shelf still makes an archived bookmark of the same
       page a duplicate — the class rule narrows the test, it does not drop it. */
    expect(planImport(exportMarks(shelf, [bookmark], []), shelf, [bookmark], []).duplicates).toBe(1)
  })

  it('folds two archived marks of one class that overlap each other into the later one, and counts it', () => {
    const shelf = [BOOK()]
    const early = MARK({ id: 'e', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:15)', note: 'lost', createdAt: Date.UTC(2026, 0, 1) })
    const late = MARK({ id: 'l', cfi: 'epubcfi(/6/4!/4/2,/1:5,/1:20)', note: 'kept', createdAt: Date.UTC(2026, 0, 2) })
    const plan = planImport(exportMarks(shelf, [early, late], []), shelf, [], [])
    expect(plan.marksAdded).toBe(1)
    expect(plan.folded).toBe(1)
    expect(plan.duplicates).toBe(0)
    expect(plan.additions[0]?.marks.map((m) => m.note)).toEqual(['kept'])
    /* Order in the file does not decide it; the stamp does. */
    const reversed = planImport(exportMarks(shelf, [late, early], []), shelf, [], [])
    expect(reversed.additions[0]?.marks.map((m) => m.note)).toEqual(['kept'])
  })

  it('never removes: a shelf mark absent from the file survives', () => {
    /* Restoring a month-old backup cannot silently delete a month of reading.
       The plan is a list of ADDITIONS and has no other verb. */
    const shelf = [BOOK()]
    const doc = exportMarks(shelf, [], [])
    const plan = planImport(doc, shelf, [MARK()], [])
    expect(plan.additions).toEqual([])
    expect(Object.keys(plan)).not.toContain('removals')
  })
})

describe('toMarkdown', () => {
  it('describes the same set the JSON does', () => {
    /* ONE DOCUMENT, TWO RENDERINGS. Assembling the Markdown separately is how
       every "export to Markdown and JSON" that has ever drifted, drifted. */
    const doc = exportMarks([BOOK()], [MARK(), MARK({ id: 'm2', text: 'a second passage' })], [CARD()])
    const md = toMarkdown(doc)
    for (const mark of doc.books[0]?.marks ?? []) expect(md).toContain(mark.text)
    for (const card of doc.books[0]?.cards ?? []) expect(md).toContain(card.body)
    expect(md).toContain('Moby-Dick')
    expect(md).toContain('Herman Melville')
  })

  it('leaves the local anchor out, because it means nothing outside this library', () => {
    const doc = exportMarks([BOOK()], [MARK()], [])
    expect(toMarkdown(doc)).not.toContain('epubcfi')
  })

  it('is empty-but-valid for an empty archive', () => {
    expect(toMarkdown({ version: 1, books: [] })).toBe('# Marginalia\n')
  })
})

describe('archiveName', () => {
  it('is dated, and says which format it is', () => {
    const day = new Date(2026, 7, 21)
    expect(archiveName(day)).toBe('paper-marginalia-2026-08-21.json')
    expect(archiveName(day, 'md')).toBe('paper-marginalia-2026-08-21.md')
  })
})

describe('what the audit found in the archive (round 1)', () => {
  it('keeps a bookmark whose page had no text — a place, not a quote', () => {
    /* `parseMark` refused any row with neither text nor note before it had
       looked at `kind`, and `exportMarks` writes exactly that row for a
       bookmark on a page with nothing to quote — so a reader's own export
       silently dropped every such bookmark on the way back in. */
    const bookmark = MARK({ id: 'b', kind: 'bookmark', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:400)', text: '', note: '' })
    const doc = exportMarks([BOOK()], [bookmark], [])
    const parsed = parseArchive(JSON.stringify(doc))!
    expect(parsed.books[0]?.marks.map((one) => one.kind)).toEqual(['bookmark'])
    expect(planImport(doc, [BOOK()], [], []).marksAdded).toBe(1)
  })

  it('refuses a card whose kind the card store would refuse on the next load', () => {
    /* Cast, not checked: the import reported the card added, stored it, and
       `parseCards` threw it away the next time the file was read. */
    const doc = exportMarks([BOOK()], [], [CARD()])
    const text = JSON.stringify(doc).replace('"kind":"Recall"', '"kind":"question"')
    expect(parseArchive(text)?.books[0]?.cards ?? []).toEqual([])
  })

  it('does not call two marks the same passage when they sit in different sections', () => {
    /* `findMark` requires the section to match; neither duplicate detection
       nor in-archive folding did, so a CFI that happens to overlap another
       section's was discarded as its duplicate. */
    const cfi = 'epubcfi(/6/4!/4/2,/1:0,/1:9)'
    const inSectionOne = MARK({ id: 'm-s1', cfi, sectionIndex: 1, text: 'later' })
    const doc = exportMarks([BOOK()], [inSectionOne], [])
    const shelfHasSectionZero = MARK({ id: 'm-s0', cfi, sectionIndex: 0, text: 'earlier' })
    const plan = planImport(doc, [BOOK()], [shelfHasSectionZero], [])
    expect(plan.duplicates).toBe(0)
    expect(plan.marksAdded).toBe(1)

    /* And within one file: two sections, one CFI, two marks kept. */
    const both = exportMarks([BOOK()], [inSectionOne, MARK({ id: 'm-s0b', cfi, sectionIndex: 0, text: 'earlier' })], [])
    expect(planImport(both, [BOOK()], [], []).folded).toBe(0)
    expect(planImport(both, [BOOK()], [], []).marksAdded).toBe(2)
  })

  it('plans two archive rows for one shelf book as one addition, and counts a body repeated across them once', () => {
    /* One row matched by id, another by name — two devices' exports merged
       into one file. Planned independently, the pair kept its cross-row
       duplicates and the book took two concurrent `addMany` calls. */
    const byId = BOOK()
    const byName = BOOK({ bookId: 'elsewhere' })
    const doc = exportMarks(
      [byId, byName],
      [MARK({ id: 'm1', bookId: 'moby' }), MARK({ id: 'm2', bookId: 'elsewhere' })],
      [CARD({ id: 'c1', bookId: 'moby' }), CARD({ id: 'c2', bookId: 'elsewhere' })],
    )
    const plan = planImport(doc, [BOOK()], [], [])
    expect(plan.additions).toHaveLength(1)
    expect(plan.additions[0]?.bookId).toBe('moby')
    /* Same passage on both rows → folded to one; same card body → one added,
       the repeat counted as a duplicate rather than let through. */
    expect(plan.folded).toBe(1)
    expect(plan.marksAdded).toBe(1)
    expect(plan.cardsAdded).toBe(1)
    expect(plan.duplicates).toBe(1)
  })
})
