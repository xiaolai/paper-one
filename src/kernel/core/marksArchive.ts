import type { IndexedBook } from './bookIndex'
import type { Card, CardKind } from './cards'
import { CARD_KINDS, MAX_CARD_TEXT, liveCards } from './cards'
import { fold } from './library'
import { cfiOverlaps } from './markMatch'
import { ARCHIVE_MAX_ROWS } from './importLimits'
import {
  MARK_KINDS,
  MARK_STYLES,
  MARK_TINTS,
  MAX_MARK_NOTE,
  MAX_MARK_TEXT,
  liveMarks,
  type Mark,
  type MarkKind,
  type MarkStyle,
  type MarkTint,
  isBookmarkKind,
} from './marks'

/**
 * The reader's marginalia, as a file they can keep.
 *
 * Paper's whole thesis is what a reader leaves in a book, and until this
 * existed there was no way to get any of it out. Tags gained an archive last
 * cycle; marks and cards had none. **The argument is trust, not parity** —
 * nobody commits two thousand books of annotation to a system with no exit,
 * and every comparator in the ledger has one.
 *
 * `tagArchive.ts` IS THE TEMPLATE and this copies all three of its properties:
 * a versioned document, a pure module with the I/O left to the caller, and a
 * stated rule about what is deliberately NOT exported because it regenerates
 * itself.
 *
 * PURE. Reading and writing the file belongs to `ui/marksFiles.ts`; everything
 * about what the document contains, and how a book in it is matched to a book
 * on the shelf, is decided here where it can be tested without a filesystem.
 */

/** The document. Versioned so a later shape can be told from this one. */
export interface MarksArchive {
  readonly version: 1
  readonly books: readonly ArchivedMarkBook[]
}

/**
 * One book's marginalia.
 *
 * THREE WAYS TO NAME THE SAME BOOK, exactly as the tag archive does, because
 * the archive has two jobs that want different keys. Restoring into the same
 * library wants `bookId`, which is derived from the file's own bytes and is
 * exact. Carrying the work to another machine — a different download of the
 * same book — wants the title and author, because the bytes there are not the
 * same bytes.
 */
export interface ArchivedMarkBook {
  readonly bookId: string
  readonly title: string
  readonly author: string
  readonly marks: readonly ArchivedMark[]
  readonly cards: readonly ArchivedCard[]
}

/**
 * One mark, as a document a reader can open in a text editor.
 *
 * WHAT IS HERE IS WHAT THE READER MADE, and what is absent is absent on
 * purpose:
 *
 *  - `id` is store-assigned. A re-import assigns its own, exactly as a tag
 *    import does not carry tag identity.
 *  - `updatedAt` and `deletedAt` — the ledger's HLC stamps — regenerate. This
 *    is the tag archive's publisher-subject rule wearing different clothes:
 *    exporting something that regenerates itself backs up a copy of nothing,
 *    and importing it would forge a causal history the exporting device never
 *    witnessed.
 *  - Tombstoned marks do not appear at all. An archive is a record of what the
 *    reader HAS, not of what they deleted.
 */
export interface ArchivedMark {
  /** The quote. The one field that survives everything. */
  readonly text: string
  /**
   * The 32 characters either side of the quote — `markContext`'s work.
   *
   * THE POINT OF THE WHOLE ITEM. A CFI locates a passage inside ONE package
   * and resolves to the wrong words in a different build of the same book
   * WITHOUT ERRORING. The quote alone is not enough to re-find it either:
   * "the whale" occurs hundreds of times. These are what make a mark
   * re-anchorable, and they cannot be recovered later — recovering them means
   * re-opening the book and resolving the CFI, which is the operation that has
   * already failed by the time anyone needs them.
   */
  readonly prefix: string
  readonly suffix: string
  /** What the reader wrote on it. Empty for a bare highlight. */
  readonly note: string
  readonly kind: MarkKind
  /**
   * How it is drawn.
   *
   * THE COLOUR IS PART OF THE ANNOTATION, not a rendering preference — a
   * reader who puts agreements in green and questions in purple has said
   * something about each passage. See `Mark.tint`.
   */
  readonly tint: MarkTint
  readonly style: MarkStyle
  /** The TOC label at the time of marking — where it was, in the book's words. */
  readonly chapter: string
  /** ISO 8601. This is a document a reader reads; an epoch integer is not. */
  readonly createdAt: string
  /**
   * The anchor, under a key that says what it is worth.
   *
   * NOT PRESENTED AS PORTABLE, because it is not: it is exact in the library
   * that wrote it and meaningless in any other. Kept rather than omitted, so a
   * re-import into the SAME library lands on the exact passage — and named
   * `localAnchor` so nobody carries it somewhere it cannot mean anything.
   */
  readonly localAnchor: { readonly cfi: string; readonly sectionIndex: number }
}

/** One card. Same rules: what the reader made, none of the ledger's stamps. */
export interface ArchivedCard {
  readonly kind: CardKind
  readonly body: string
  readonly answer: string
  readonly source: string
  readonly createdAt: string
  /** Null for a card made from no passage. Same status as a mark's. */
  readonly localAnchor: { readonly cfi: string } | null
}

/** What an import would do, before it does it — for saying so in a sentence. */
export interface MarksImportPlan {
  readonly additions: readonly BookImport[]
  /**
   * Books in the file that match nothing on this shelf, BY NAME.
   *
   * A COUNT IS NOT SOMETHING A READER CAN ACT ON. "12 not on this shelf" tells
   * them a number; the titles tell them whether the missing book is one they
   * care about. This is the difference between a backup and a placebo, and it
   * is the one place this module deliberately carries more than the tag
   * archive's equivalent.
   */
  readonly unmatched: readonly UnmatchedBook[]
  readonly booksTouched: number
  readonly marksAdded: number
  /**
   * Archived marks that overlapped ANOTHER MARK IN THE FILE of their own
   * class and were kept as one — the later-made one. Counted so the notice
   * can say so; `upsertOverlapping` would otherwise tombstone the earlier of
   * the pair on the way into the store, silently.
   */
  readonly folded: number
  readonly cardsAdded: number
  /** Rows already present, by overlap — see `planImport`. */
  readonly duplicates: number
}

export interface BookImport {
  readonly bookId: string
  readonly marks: readonly ArchivedMark[]
  readonly cards: readonly ArchivedCard[]
}

export interface UnmatchedBook {
  readonly title: string
  readonly author: string
  readonly marks: number
  readonly cards: number
}

/**
 * How a book is looked up by name when its id is not on this shelf.
 *
 * THE SEPARATOR IS WRITTEN AS AN ESCAPE, not as a literal byte, and
 * `tagArchive` writes it the same way — that is the form to copy. It has to be
 * a character that cannot occur in a title or an author, or `nameKey('a b',
 * 'c')` and `nameKey('a', 'b c')` collide and one reader's marginalia lands on
 * another book.
 *
 * WRITTEN RAW, IT MADE THIS FILE UNREADABLE to anything that stops at a NUL.
 * Two separate code-audit passes truncated at this exact line and reported the
 * file as ending in an unterminated template literal — and both times the
 * truncation was dismissed as an artifact of their input rather than believed.
 * `no-binary-source.test.mjs` says the same thing without the ambiguity, and it
 * scans only TRACKED files, so it stayed silent for as long as this file was
 * untracked. Green before the first commit meant less than it looked.
 */
/* A structured tuple, not a joined string: NUL is a valid character in a
 * JavaScript string and in escaped JSON, so a separator could be forged by a
 * crafted title. `JSON.stringify` of the pair cannot be. */
const nameKey = (title: string, author: string): string => JSON.stringify([fold(title), fold(author)])

const iso = (at: number): string => new Date(at).toISOString()

const MARK_KIND_SET: ReadonlySet<string> = new Set(MARK_KINDS)
/* From the canonical registries, not a second spelling of them. */
const TINTS: ReadonlySet<string> = new Set(MARK_TINTS)
const STYLES: ReadonlySet<string> = new Set(MARK_STYLES)
const CARD_KIND_SET: ReadonlySet<string> = new Set(CARD_KINDS)

/**
 * Everything the reader has written, as a document.
 *
 * Books with no marks and no cards are left out entirely, for the reason the
 * tag archive gives: an archive is a record of work done, and a thousand empty
 * entries make it harder to read and no more complete.
 *
 * `liveMarks` and `liveCards` FIRST, so a tombstone never reaches the file.
 */
export function exportMarks(
  books: readonly IndexedBook[],
  marks: readonly Mark[],
  cards: readonly Card[],
): MarksArchive {
  const marksByBook = new Map<string, ArchivedMark[]>()
  for (const mark of liveMarks(marks)) {
    const row: ArchivedMark = {
      text: mark.text,
      prefix: mark.prefix,
      suffix: mark.suffix,
      note: mark.note,
      kind: mark.kind,
      tint: mark.tint,
      style: mark.style,
      chapter: mark.chapter,
      createdAt: iso(mark.createdAt),
      localAnchor: { cfi: mark.cfi, sectionIndex: mark.sectionIndex },
    }
    const list = marksByBook.get(mark.bookId)
    if (list) list.push(row)
    else marksByBook.set(mark.bookId, [row])
  }

  const cardsByBook = new Map<string, ArchivedCard[]>()
  for (const card of liveCards(cards)) {
    const row: ArchivedCard = {
      kind: card.kind,
      body: card.body,
      answer: card.answer,
      source: card.source,
      createdAt: iso(card.createdAt),
      localAnchor: card.cfi ? { cfi: card.cfi } : null,
    }
    const list = cardsByBook.get(card.bookId)
    if (list) list.push(row)
    else cardsByBook.set(card.bookId, [row])
  }

  const rows: ArchivedMarkBook[] = []
  for (const book of books) {
    const bookMarks = marksByBook.get(book.bookId) ?? []
    const bookCards = cardsByBook.get(book.bookId) ?? []
    if (bookMarks.length === 0 && bookCards.length === 0) continue
    rows.push({
      bookId: book.bookId,
      title: book.title,
      author: book.author,
      marks: bookMarks,
      cards: bookCards,
    })
  }
  return { version: 1, books: rows }
}

const str = (value: unknown, max = 100_000): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const oneOf = <T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T): T =>
  typeof value === 'string' && allowed.has(value) ? (value as T) : fallback

function parseMark(raw: unknown): ArchivedMark | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  /* THE CANONICAL BOUNDS, not a generic hundred thousand: the service table
     refuses a mark past `MAX_MARK_TEXT`/`MAX_MARK_NOTE`, and an archive is
     the one door that used to walk past that — a row too large for the
     transport, persisted by an import. */
  const text = str(row['text'], MAX_MARK_TEXT)
  const note = str(row['note'], MAX_MARK_NOTE)
  const kind = oneOf<MarkKind>(row['kind'], MARK_KIND_SET, 'highlight')
  const anchor = row['localAnchor']
  const anchorRow = typeof anchor === 'object' && anchor !== null ? (anchor as Record<string, unknown>) : {}
  const cfi = str(anchorRow['cfi'], 4000)
  /* A ROW THAT SAYS NOTHING IS NOISE, not a mark — with neither a quote nor
     a note there is no passage to re-find and nothing the reader wrote.
     EXCEPT A BOOKMARK: a bookmark is a place, not a quote, and `exportMarks`
     writes one with blank text when the page had none. Read before `kind`
     was consulted, this dropped every such bookmark from its own export. A
     bookmark needs an anchor to be a place; without one it is noise too. */
  if (!text && !note && !(isBookmarkKind(kind) && cfi)) return null
  const sectionIndex = anchorRow['sectionIndex']
  return {
    text,
    prefix: str(row['prefix'], MAX_MARK_TEXT),
    suffix: str(row['suffix'], MAX_MARK_TEXT),
    note,
    kind,
    tint: oneOf<MarkTint>(row['tint'], TINTS, 'yellow'),
    style: oneOf<MarkStyle>(row['style'], STYLES, 'fill'),
    chapter: str(row['chapter'], 1000),
    createdAt: str(row['createdAt'], 40),
    localAnchor: {
      cfi,
      /* A stored mark's section is a non-negative integer; anything else is
         the documented fallback rather than a mark stranded on section -1.5. */
      sectionIndex:
        typeof sectionIndex === 'number' && Number.isInteger(sectionIndex) && sectionIndex >= 0 ? sectionIndex : 0,
    },
  }
}

function parseCard(raw: unknown): ArchivedCard | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const body = str(row['body'], MAX_CARD_TEXT)
  if (!body) return null
  /* VALIDATED, not cast. An unknown kind was stored as written and then
     refused by `parseCards` on the next load — the import reported the card
     added and the card was gone by morning. */
  if (!CARD_KIND_SET.has(str(row['kind'], 40))) return null
  const anchor = row['localAnchor']
  const cfi =
    typeof anchor === 'object' && anchor !== null
      ? str((anchor as Record<string, unknown>)['cfi'], 4000)
      : ''
  return {
    kind: str(row['kind'], 40) as CardKind,
    body,
    answer: str(row['answer'], MAX_CARD_TEXT),
    source: str(row['source'], 1000),
    createdAt: str(row['createdAt'], 40),
    localAnchor: cfi ? { cfi } : null,
  }
}

/**
 * Read an archive, keeping what survives and dropping what does not.
 *
 * Null ONLY when the document is not an archive at all — unparseable, or the
 * wrong shape. A file that IS an archive with three broken rows imports the
 * rest: this is a recovery path, and refusing the whole file over one bad row
 * is the behaviour that makes a backup worthless at the moment it is needed.
 * Same rule, same words, as `tagArchive.parseArchive`.
 */
export function parseArchive(raw: string): MarksArchive | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (doc['version'] !== 1 || !Array.isArray(doc['books'])) return null
  const books: ArchivedMarkBook[] = []
  /* ⚠️ **A SMALL FILE CAN DESCRIBE A MILLION ROWS**, and only the BYTES were
   * bounded — one caller up, and only recently. JSON is compact: a few
   * megabytes of `{"id":"…"}` is hundreds of thousands of objects, and what
   * costs is BUILDING them, not reading them. Counted across the whole archive
   * rather than per book, because a hundred thousand books of one mark each is
   * the same amount of work as one book of a hundred thousand. */
  /* EVERY CANDIDATE COUNTS — each book object examined and each mark or
   * card row handed to a parser, parsed or not. Counting only what PARSED
   * let a compact archive of a million invalid rows, or a million empty book
   * objects, cost a million iterations against a budget it never touched. */
  let rows = 0
  for (const one of doc['books']) {
    if (rows >= ARCHIVE_MAX_ROWS) break
    rows += 1
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const markRows = Array.isArray(row['marks']) ? row['marks'].slice(0, Math.max(0, ARCHIVE_MAX_ROWS - rows)) : []
    rows += markRows.length
    const marks = markRows.map(parseMark).filter((mark): mark is ArchivedMark => mark !== null)
    const cardRows = Array.isArray(row['cards']) ? row['cards'].slice(0, Math.max(0, ARCHIVE_MAX_ROWS - rows)) : []
    rows += cardRows.length
    const cards = cardRows.map(parseCard).filter((card): card is ArchivedCard => card !== null)
    if (marks.length === 0 && cards.length === 0) continue
    const bookId = str(row['bookId'], 200)
    const title = str(row['title'], 1000)
    // Unnameable by either route is not a row, it is noise.
    if (!bookId && !title) continue
    books.push({ bookId, title, author: str(row['author'], 1000), marks, cards })
  }
  return { version: 1, books }
}

/**
 * What importing this archive would add, without adding it.
 *
 * ADDITIVE, ALWAYS. An import never removes a mark: the file on disk is one
 * reader's marginalia at one moment, and treating it as the whole truth would
 * make restoring a month-old backup silently delete a month of reading.
 *
 * MATCHED BY ID FIRST, then by title and author folded. A name that matches
 * more than one book on the shelf is SKIPPED rather than guessed at — two
 * editions of one title are exactly where a wrong guess would put someone's
 * work on the wrong book.
 *
 * DUPLICATES ARE FOUND BY OVERLAP, NOT BY EQUAL CFIs. `markMatch` exists
 * because a mark and a passage are the same thing when their CFIs OVERLAP; a
 * strict comparison would let a re-import of the archive this library just
 * wrote double every highlight in it. Marks with no usable anchor fall back to
 * the quote, which is the only other thing that identifies a passage.
 */
export function planImport(
  archive: MarksArchive,
  books: readonly IndexedBook[],
  existing: readonly Mark[],
  existingCards: readonly Card[] = [],
): MarksImportPlan {
  const byId = new Map<string, IndexedBook>()
  const byName = new Map<string, IndexedBook | null>()
  for (const book of books) {
    byId.set(book.bookId, book)
    const key = nameKey(book.title, book.author)
    // Null marks a name that more than one book answers to — see above.
    byName.set(key, byName.has(key) ? null : book)
  }

  const haveMarks = new Map<string, Mark[]>()
  for (const mark of liveMarks(existing)) {
    const list = haveMarks.get(mark.bookId)
    if (list) list.push(mark)
    else haveMarks.set(mark.bookId, [mark])
  }
  const haveCards = new Map<string, Set<string>>()
  for (const card of liveCards(existingCards)) {
    const set = haveCards.get(card.bookId) ?? new Set<string>()
    set.add(card.body)
    haveCards.set(card.bookId, set)
  }

  const additions: BookImport[] = []
  const unmatched: UnmatchedBook[] = []
  let marksAdded = 0
  let cardsAdded = 0
  let duplicates = 0
  let folded = 0

  /* ROWS ARE GATHERED BY THE SHELF BOOK THEY RESOLVE TO before anything is
   * judged. Two archive rows for one book — an export merged from two
   * devices, a title matched and an id matched — used to be planned
   * independently: duplicates across the pair survived, and the book took
   * two concurrent `addMany` calls. */
  const grouped = new Map<string, { marks: ArchivedMark[]; cards: ArchivedCard[] }>()
  for (const row of archive.books) {
    const match =
      (row.bookId ? byId.get(row.bookId) : undefined) ??
      (row.title ? (byName.get(nameKey(row.title, row.author)) ?? undefined) : undefined)
    if (!match) {
      unmatched.push({
        title: row.title,
        author: row.author,
        marks: row.marks.length,
        cards: row.cards.length,
      })
      continue
    }
    const into = grouped.get(match.bookId) ?? { marks: [], cards: [] }
    into.marks.push(...row.marks)
    into.cards.push(...row.cards)
    grouped.set(match.bookId, into)
  }

  for (const [bookId, row] of grouped) {
    const mine = haveMarks.get(bookId) ?? []
    /* SAME CLASS, then overlap — the rule `upsertOverlapping` applies, and
     * this filter did not. A bookmark anchors to the visible PAGE, so its CFI
     * overlaps every highlight on that page; without the class test one live
     * bookmark made every archived highlight on its page a "duplicate", note
     * and all, and an archived bookmark was dropped when a highlight stood
     * on its page. Measured 2026-08-27: one bookmark, one archived highlight,
     * `marksAdded: 0, duplicates: 1`. */
    const freshMarks = row.marks.filter((incoming) => {
      const already = mine.some((have) =>
        samePassage(incoming, { kind: have.kind, cfi: have.cfi, sectionIndex: have.sectionIndex, text: have.text }),
      )
      if (already) duplicates += 1
      return !already
    })
    /* AND WITHIN THE FILE. Two archived marks of one class that overlap each
     * other — a legacy export, or one merged from two devices — would reach
     * `addMany`, whose `upsertOverlapping` keeps the later and tombstones the
     * earlier without a word. Fold them here, keep the later-made one, and
     * COUNT it, so the notice says "kept as one" rather than nothing. */
    const kept: ArchivedMark[] = []
    for (const incoming of freshMarks) {
      const at = kept.findIndex((have) =>
        samePassage(incoming, {
          kind: have.kind,
          cfi: have.localAnchor.cfi,
          sectionIndex: have.localAnchor.sectionIndex,
          text: have.text,
        }),
      )
      if (at === -1) {
        kept.push(incoming)
        continue
      }
      folded += 1
      if (instantOf(incoming.createdAt) > instantOf(kept[at]!.createdAt)) kept[at] = incoming
    }
    /* A working set, GROWN as cards are accepted: read-only, it let every
     * repeat of one body inside the archive through as a fresh card. */
    const cardBodies = new Set(haveCards.get(bookId) ?? [])
    const freshCards = row.cards.filter((incoming) => {
      const already = cardBodies.has(incoming.body)
      if (already) duplicates += 1
      else cardBodies.add(incoming.body)
      return !already
    })
    if (kept.length === 0 && freshCards.length === 0) continue
    additions.push({ bookId, marks: kept, cards: freshCards })
    marksAdded += kept.length
    cardsAdded += freshCards.length
  }

  return {
    additions,
    unmatched,
    booksTouched: additions.length,
    marksAdded,
    cardsAdded,
    duplicates,
    folded,
  }
}

/**
 * One passage rule for both places that ask — is this archived mark the same
 * passage as that one? — because the two copies had already drifted: neither
 * compared `sectionIndex`, which `findMark` requires, so identical-looking
 * CFIs from different spine sections folded into one and an annotation was
 * lost. Same class first (a bookmark spans its page); then, when both sides
 * carry an anchor, the same section AND an overlap; else the quote itself.
 */
const samePassage = (
  a: ArchivedMark,
  b: { readonly kind: MarkKind; readonly cfi: string; readonly sectionIndex: number; readonly text: string },
): boolean =>
  isBookmarkKind(a.kind) === isBookmarkKind(b.kind) &&
  (a.localAnchor.cfi && b.cfi
    ? a.localAnchor.sectionIndex === b.sectionIndex && cfiOverlaps(a.localAnchor.cfi, b.cfi)
    : a.text !== '' && a.text === b.text)

/* Parsed, not compared as text: ISO 8601 strings from ONE clock order
 * lexically, but an archive from elsewhere may carry offsets, and "later"
 * has to mean the later instant. Unparseable stamps sort first, so a dated
 * mark always wins over an undated one. */
const instantOf = (stamp: string): number => {
  const at = Date.parse(stamp)
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
}

/* Inline syntax, raw HTML, and the block syntax a line may open with — a
 * reader's note is prose, and prose beginning with `#` or `>` must not
 * become a heading or a quote of the reading copy around it. Applied per
 * line, because a multi-line value is several line starts. */
const mdEscape = (text: string): string =>
  text
    .split('\n')
    .map((line) =>
      line
        .replace(/([\\`*_[\]<>])/gu, '\\$1')
        .replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/u, '$1\\$2'),
    )
    .join('\n')

/**
 * The reading copy, rendered FROM THE SAME DOCUMENT the JSON is written from.
 *
 * Not assembled separately. That is the failure mode of every "export to
 * Markdown and JSON" that has ever drifted — two writers walking the same data
 * and disagreeing about what was included — and it costs one function to make
 * unspellable.
 *
 * The local anchor is deliberately ABSENT here. Markdown is what a reader
 * reads and what they paste into their own notes; a CFI in it is noise that
 * means nothing outside the library that wrote it. The JSON is the half that
 * carries it.
 */
export function toMarkdown(archive: MarksArchive): string {
  const out: string[] = ['# Marginalia', '']
  for (const book of archive.books) {
    out.push(`## ${mdEscape(book.title || 'Untitled')}`)
    if (book.author) out.push(`*${mdEscape(book.author)}*`)
    out.push('')
    for (const mark of book.marks) {
      const where = mark.chapter ? ` — ${mdEscape(mark.chapter)}` : ''
      out.push(`> ${mdEscape(mark.text) || '*(a place, with no quote)*'}`)
      if (mark.note) out.push('', mdEscape(mark.note))
      out.push('', `<sub>${mark.kind}${where}</sub>`, '')
    }
    if (book.cards.length > 0) {
      out.push('### Cards', '')
      for (const card of book.cards) {
        out.push(`- **${mdEscape(card.body)}**`)
        if (card.answer) out.push(`  - ${mdEscape(card.answer)}`)
      }
      out.push('')
    }
  }
  return `${out.join('\n').trimEnd()}\n`
}

/**
 * The file name an export is offered under. Dated, because a reader will keep
 * more than one and the useful question about a backup is when it was taken.
 */
export function archiveName(now: Date, extension: 'json' | 'md' = 'json'): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `paper-marginalia-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${extension}`
}
