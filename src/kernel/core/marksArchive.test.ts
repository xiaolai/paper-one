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
import { ARCHIVE_MAX_ROWS } from './importLimits'
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

/**
 * Every anchor a plan would put into the store, marks and cards together.
 *
 * ⚠️ **THE FALSIFIER FOR WI-21.2 IS "ANY PATH FROM A NAME-MATCHED ROW TO A
 * STORED CFI", and a grep over the final store would miss the one that
 * matters** — folding and duplicate-checking read anchors BEFORE anything is
 * stored, so a foreign CFI can decide which mark survives without ever being
 * written. This reads what the plan would actually hand `addMany` and
 * `makeMany`, which is the whole surface.
 */
const anchorsIn = (plan: { readonly additions: readonly { readonly marks: readonly { readonly localAnchor: { readonly cfi: string } }[]; readonly cards: readonly { readonly localAnchor: { readonly cfi: string } | null }[] }[] }): readonly string[] => [
  ...plan.additions.flatMap((one) => one.marks.map((mark) => mark.localAnchor.cfi)),
  ...plan.additions.flatMap((one) => one.cards.flatMap((card) => (card.localAnchor ? [card.localAnchor.cfi] : []))),
]

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

  it('finds the book by folded title and author, and keeps its marks WITHOUT a place', () => {
    /* THE BOOK IS STILL FOUND. Matching a WORK across two downloads of it is
       what the name key is for, and that half is unchanged.
     *
     * ⚠️ WHAT CHANGED IS WHAT HAPPENS NEXT (WI-21.1/21.2). The bytes there are
     * not the same bytes, so the archived anchor was written against a
     * different package — and a CFI carried across that gap is still a valid
     * path that points at DIFFERENT WORDS. It does not throw; it highlights the
     * wrong sentence. This test asserted only the bookId for as long as it has
     * existed, which is exactly why the anchor could travel unnoticed. */
    const doc = exportMarks([BOOK({ bookId: 'from-elsewhere' })], [MARK({ bookId: 'from-elsewhere' })], [])
    const plan = planImport(doc, [BOOK({ bookId: 'local-copy' })], [], [])
    expect(plan.unmatched, 'the book WAS found — this is not "not on your shelf"').toEqual([])
    /* PLACED: none. The anchor cannot cross and never does. */
    expect(plan.marksAdded).toBe(0)
    /* KEPT: all of them (WI-21.7). Stage 1 threw these away for want of a
       state to put them in; there is one now, so the reader keeps their quote,
       their context, their note and their colour — everything except the one
       field that is meaningless here. */
    expect(plan.unplacedAdded).toBe(1)
    expect(plan.additions[0]?.unplaced.map((one) => one.mark.text)).toEqual(['Call me Ishmael'])
    /* AND THE PROVENANCE, which is the archive row's own id and never a path
       into this library. */
    expect(plan.additions[0]?.unplaced[0]?.fromBook).toBe('from-elsewhere')
    expect(plan.unplacedBooks).toEqual([{ title: 'Moby-Dick', author: 'Herman Melville', marks: 1 }])
    /* ⚠️ THE ASSERTION THIS TEST HAS ALWAYS BEEN MISSING, and the one thing
       WI-21.7 must not weaken: not one anchor from the foreign build reaches
       the plan by any route. Keeping the marks is not keeping their CFIs. */
    expect(anchorsIn(plan)).toEqual([])
  })

  it('imports a name-matched card, with its anchor dropped rather than the card', () => {
    /* Cards are exempt from the refusal because `Card.cfi` is already nullable
       and the Cards pane gates navigation on it — so a passage card survives
       the crossing as a card that simply cannot be jumped to. A mark has no
       such state: `isMark` refuses an empty cfi. */
    const doc = exportMarks([BOOK({ bookId: 'from-elsewhere' })], [], [CARD({ bookId: 'from-elsewhere' })])
    const plan = planImport(doc, [BOOK({ bookId: 'local-copy' })], [], [])
    expect(plan.cardsAdded).toBe(1)
    expect(plan.additions[0]?.cards[0]?.body).toBe('Who narrates?')
    expect(plan.additions[0]?.cards[0]?.localAnchor).toBeNull()
    expect(anchorsIn(plan)).toEqual([])
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

  /* ⚠️ **AN ARCHIVE AT ITS OWN LIMIT USED TO THROW BEFORE IT WAS PLANNED.**
     The rows were gathered with `push(...row.marks)`, which passes every row
     as an ARGUMENT — and `ARCHIVE_MAX_ROWS` permits 200 000, well past what
     the engine accepts: `RangeError: Maximum call stack size exceeded`, from
     an import of a file the parser had just accepted. The marks here are all
     one passage so the fold is a constant-time match and this measures the
     gather, not the matcher. */
  it('plans an archive holding as many rows as the parser permits', () => {
    const shelf = [BOOK()]
    const one = {
      text: 'Call me Ishmael',
      prefix: '',
      suffix: '',
      note: '',
      kind: 'highlight' as const,
      tint: 'yellow' as const,
      style: 'fill' as const,
      chapter: '',
      createdAt: '2026-01-02T03:04:05.000Z',
      localAnchor: { cfi: '', sectionIndex: 0 },
    }
    const archive: MarksArchive = {
      version: 1,
      books: [
        {
          bookId: 'moby',
          title: 'Moby-Dick',
          author: 'Herman Melville',
          marks: Array.from({ length: ARCHIVE_MAX_ROWS }, () => one),
          cards: [],
        },
      ],
    }
    const plan = planImport(archive, shelf, [], [])
    expect(plan.marksAdded).toBe(1)
    expect(plan.folded).toBe(ARCHIVE_MAX_ROWS - 1)
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
    /* ⚠️ `folded` IS NOW 0, AND THAT IS THE POINT OF WI-21.1. The two rows used
       to fold against each other, which meant the fold READ a foreign anchor to
       decide which mark survived — and with the archive written the other way
       round the foreign one would have won. The name-matched mark never reaches
       the fold now; it is refused before any of the judging runs. */
    expect(plan.folded).toBe(0)
    expect(plan.marksAdded).toBe(1)
    /* Same card body across the two kinds → one added, the repeat counted as a
       duplicate rather than let through. */
    expect(plan.cardsAdded).toBe(1)
    expect(plan.duplicates).toBe(1)
    expect(plan.unplacedBooks).toEqual([{ title: 'Moby-Dick', author: 'Herman Melville', marks: 1 }])
  })
})

describe('the full content digest, where both sides have one', () => {
  /**
   * ⚠️ **`bookId` IS SAMPLED ABOVE 64 MiB, so an id match is evidence and not
   * proof.** `contentId` hashes a size prefix, the first and last 64 KiB and
   * sixteen interior probes; two equal-sized larger files differing only in a
   * gap get ONE id, which `marks.test.ts` proves on real blobs and which 20 of
   * the 1 959 books on the measured shelf are large enough to hit.
   *
   * `contentHash` is BLAKE3 of the WHOLE file. Where both the archive and the
   * shelf carry one, the question stops being a guess.
   */
  const HASH_A = 'a'.repeat(64)
  const HASH_B = 'b'.repeat(64)

  it('refuses the anchors when the digests prove the bytes differ', () => {
    /* Same id, different files — the sampled collision, arriving. The row
       matched by id and its anchors are still foreign, so it is treated
       exactly as a name match: reported, not imported. */
    const doc = exportMarks([BOOK({ contentHash: HASH_A })], [MARK()], [])
    expect(doc.books[0]?.contentHash).toBe(HASH_A)
    const plan = planImport(doc, [BOOK({ contentHash: HASH_B })], [], [])
    expect(plan.marksAdded).toBe(0)
    expect(anchorsIn(plan)).toEqual([])
    expect(plan.unplacedBooks).toEqual([{ title: 'Moby-Dick', author: 'Herman Melville', marks: 1 }])
  })

  it('keeps the anchors when the digests agree', () => {
    /* The ordinary re-import into the library that wrote the archive, now
       PROVED rather than assumed. */
    const doc = exportMarks([BOOK({ contentHash: HASH_A })], [MARK()], [])
    const plan = planImport(doc, [BOOK({ contentHash: HASH_A })], [], [])
    expect(plan.marksAdded).toBe(1)
    expect(anchorsIn(plan)).toEqual(['epubcfi(/6/4!/4/2,/1:0,/1:15)'])
  })

  it('falls back to the id match when either side has no digest', () => {
    /* ⚠️ ONLY A DISAGREEMENT DEMOTES. `contentHash` is stamped by sync's
       backfill, so a build composed without `sync` has none at all — refusing
       on absence would break every import on such a build to guard a case that
       absence says nothing about. */
    for (const [archived, shelved] of [
      [undefined, HASH_A],
      [HASH_A, undefined],
      [undefined, undefined],
    ] as const) {
      const doc = exportMarks([BOOK(archived ? { contentHash: archived } : {})], [MARK()], [])
      const plan = planImport(doc, [BOOK(shelved ? { contentHash: shelved } : {})], [], [])
      expect(plan.marksAdded, `${archived} / ${shelved}`).toBe(1)
    }
  })

  it('drops a malformed digest rather than refusing on it', () => {
    /* A digest is compared for equality only, so a malformed one cannot cause
       a wrong MATCH — but it could cause a wrong MISmatch, refusing anchors
       that were fine. Dropped at the parse, the row falls back to the id
       match, which is where it was before the field existed. */
    const doc = exportMarks([BOOK({ contentHash: HASH_A })], [MARK()], [])
    const mangled = JSON.parse(JSON.stringify(doc)) as { books: { contentHash?: unknown }[] }
    mangled.books[0]!.contentHash = 'NOT-A-HASH'
    const parsed = parseArchive(JSON.stringify(mangled))
    expect(parsed?.books[0]).not.toHaveProperty('contentHash')
    expect(planImport(parsed!, [BOOK({ contentHash: HASH_B })], [], []).marksAdded).toBe(1)
  })

  it('carries no digest at all when the exporting library has none', () => {
    /* Absent, never empty — the same rule every optional field here follows.
       An empty string would parse back as a hash that matches nothing. */
    const doc = exportMarks([BOOK()], [MARK()], [])
    expect(doc.books[0]).not.toHaveProperty('contentHash')
  })

  it('is readable by a build that predates the field, which is why there is no version bump', () => {
    /* The archive stays at version 1 deliberately. A bump would make every
       older build REFUSE a reader's backup outright, which is a worse failure
       than the one being guarded in a format whose whole value is being
       readable on the day it is needed. The field is additive and ignorable. */
    const doc = exportMarks([BOOK({ contentHash: HASH_A })], [MARK()], [])
    expect(doc.version).toBe(1)
    /* What an older parser does with it: reads the row, ignores the key. */
    const asOldBuildSees = JSON.parse(JSON.stringify(doc)) as { version: number; books: unknown[] }
    expect(asOldBuildSees.version).toBe(1)
    expect(parseArchive(JSON.stringify(asOldBuildSees))?.books[0]?.marks).toHaveLength(1)
  })
})

describe('provenance per row (WI-21.1)', () => {
  /**
   * A mixed group — one archive row matched by id, another by name — is the
   * case a scalar `matchedBy` on `BookImport` could not express, and the reason
   * the partition exists. Everything here is about a group that holds both.
   */
  const MIXED = (order: 'id-first' | 'name-first'): MarksArchive => {
    const rows = [
      { book: BOOK(), mark: MARK({ id: 'm-id', cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:9)', text: 'exact' }) },
      {
        book: BOOK({ bookId: 'elsewhere' }),
        mark: MARK({ id: 'm-name', bookId: 'elsewhere', cfi: 'epubcfi(/6/9!/9/9,/1:0,/1:9)', text: 'foreign' }),
      },
    ]
    const ordered = order === 'id-first' ? rows : [...rows].reverse()
    return exportMarks(
      ordered.map((one) => one.book),
      ordered.map((one) => one.mark),
      [],
    )
  }

  it('keeps every id-matched anchor and no name-matched anchor, whichever order the file is in', () => {
    /* ⚠️ **THE FALSIFIER**: reverse the archive's row order and get a different
       set of stored anchors. Before the partition, the answer genuinely
       depended on the order — the fold keeps the LATER-MADE of two overlapping
       marks and both rows here are the same passage, so which anchor survived
       was decided by the file rather than by whether it could be trusted. */
    for (const order of ['id-first', 'name-first'] as const) {
      const plan = planImport(MIXED(order), [BOOK()], [], [])
      expect(anchorsIn(plan), order).toEqual(['epubcfi(/6/4!/4/2,/1:0,/1:9)'])
      expect(plan.additions[0]?.marks.map((one) => one.text), order).toEqual(['exact'])
      expect(plan.unplacedBooks, order).toEqual([{ title: 'Moby-Dick', author: 'Herman Melville', marks: 1 }])
    }
  })

  it('gives the same plan either way round, not merely the same anchors', () => {
    /* The counts as well as the anchors: an order-dependent `folded` or
       `duplicates` would make the notice's sentence depend on the file too. */
    const first = planImport(MIXED('id-first'), [BOOK()], [], [])
    const second = planImport(MIXED('name-first'), [BOOK()], [], [])
    expect(first).toEqual(second)
  })

  it('never lets a name-matched card win body dedup from an id-matched one', () => {
    /* A name-matched card CAN import — its anchor is simply dropped — so it is
       also a candidate for body dedup, and first-wins would let it discard an
       exact card's usable anchor. Id-matched rows are processed first for
       exactly this. Asserted BOTH WAYS ROUND, because "first" must mean by
       match kind and not by position in the file. */
    for (const order of ['id-first', 'name-first'] as const) {
      const books = [BOOK(), BOOK({ bookId: 'elsewhere' })]
      const cards = [CARD({ id: 'c-id' }), CARD({ id: 'c-name', bookId: 'elsewhere', cfi: 'epubcfi(/6/9!/9/9)' })]
      const ordered = order === 'id-first' ? { books, cards } : { books: [...books].reverse(), cards: [...cards].reverse() }
      const plan = planImport(exportMarks(ordered.books, [], ordered.cards), [BOOK()], [], [])
      expect(plan.cardsAdded, order).toBe(1)
      expect(plan.duplicates, order).toBe(1)
      /* The EXACT card's anchor survived — the whole point. */
      expect(anchorsIn(plan), order).toEqual(['epubcfi(/6/4!/4/2)'])
    }
  })

  it('leaves an id-matched import byte for byte what it always was', () => {
    /* The other half of WI-21.1's acceptance. A shelf that holds the same bytes
       the archive was written from must see no change at all — the partition is
       for the mixed case and must cost the ordinary one nothing. */
    const doc = exportMarks([BOOK()], [MARK(), MARK({ id: 'm2', cfi: 'epubcfi(/6/6!/4/2,/1:0,/1:5)', text: 'two' })], [CARD()])
    const plan = planImport(doc, [BOOK()], [], [])
    expect(plan.marksAdded).toBe(2)
    expect(plan.cardsAdded).toBe(1)
    expect(plan.unplacedBooks).toEqual([])
    expect(anchorsIn(plan)).toEqual([
      'epubcfi(/6/4!/4/2,/1:0,/1:15)',
      'epubcfi(/6/6!/4/2,/1:0,/1:5)',
      'epubcfi(/6/4!/4/2)',
    ])
  })

  it('says "not on this shelf" and "cannot be placed" as two different lists', () => {
    /* One list for both would make the second sentence unsayable, which is the
       whole reason `unplacedBooks` is not folded into `unmatched`. */
    const doc = exportMarks(
      [BOOK({ bookId: 'elsewhere' }), BOOK({ bookId: 'gone', title: 'Ulysses', author: 'James Joyce' })],
      [MARK({ bookId: 'elsewhere' }), MARK({ id: 'm2', bookId: 'gone' })],
      [],
    )
    const plan = planImport(doc, [BOOK()], [], [])
    expect(plan.unmatched).toEqual([{ title: 'Ulysses', author: 'James Joyce', marks: 1, cards: 0 }])
    expect(plan.unplacedBooks).toEqual([{ title: 'Moby-Dick', author: 'Herman Melville', marks: 1 }])
  })
})
