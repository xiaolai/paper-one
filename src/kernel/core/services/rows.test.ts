import { describe, expect, it } from 'vitest'
import { CARD_KINDS } from '../cards'
import { FORMATS } from '../formats'
import { MARK_KINDS, MARK_STYLES, MARK_TINTS } from '../marks'
import { bookDetail, bookRow, cardRow, markRow, trashRow } from './rows'
import type { IndexedBook } from '../bookIndex'
import type { Card } from '../cards'
import type { Mark } from '../marks'
import type { TrashedBook } from '../bookTrash'

/**
 * THE PROJECTION BOUNDARY — the last thing between a stored record and a
 * caller who may be on another device.
 *
 * It had no direct tests. What covered it was integration: a handful of
 * services checked a handful of fields, which is enough to notice a field that
 * stopped appearing and nothing at all to notice one that STARTED. That is the
 * wrong way round for this file, because the failure it guards against is a
 * field crossing the wire that should not have — `origin` is a path on this
 * reader's disk, and `ext` is how this copy happens to be stored.
 *
 * ⚠️ This sentence used to end "and a mark's `prefix`/`suffix` are a repair
 * input nobody asked for", which the test below already contradicted: they
 * have crossed since phase 19, because the browser client is the first real
 * producer of marks over this wire and a mark born without them cannot be
 * re-found when its CFI stops resolving.
 *
 * Every projector is asserted on its KEYS, not only on its values, so a field
 * added to a stored shape is invisible here until somebody decides to publish
 * it.
 */

const BOOK: IndexedBook = {
  bookId: 'book:a',
  title: 'Moby-Dick',
  author: 'Herman Melville',
  series: 'none',
  seriesIndex: 1,
  publisher: 'Someone',
  published: '1851',
  languages: ['en'],
  subjects: ['whales'],
  tags: ['sea'],
  position: 'epubcfi(/6/4)',
  progress: 0.5,
  finished: false,
  addedAt: 1,
  openedAt: 2,
  format: 'epub',
  contentHash: 'a'.repeat(64),
  hasContent: true,
  /* DEVICE-LOCAL. Neither may appear on the wire. */
  ext: 'epub',
  origin: '/Users/somebody/Downloads/moby.epub',
} as IndexedBook

describe('bookRow', () => {
  it('publishes exactly the fields it declares', () => {
    expect(Object.keys(bookRow(BOOK)).sort()).toEqual([
      'addedAt',
      'author',
      'bookId',
      'contentHash',
      'finished',
      'format',
      'hasContent',
      'identifier',
      'languages',
      'openedAt',
      'position',
      'progress',
      'published',
      'publisher',
      'series',
      'seriesIndex',
      'subjects',
      'tags',
      'title',
    ])
  })

  /**
   * THE DEVICE-LOCAL FIELDS NEVER CROSS.
   *
   * `origin` is where this book was imported from on THIS machine — a path in
   * the reader's own filesystem, meaningless on a phone and nobody else's
   * business. `ext` is how this copy happens to be stored; `format` is the
   * field that carries the same meaning across devices.
   */
  it('strips origin and ext', () => {
    const row = bookRow(BOOK) as unknown as Record<string, unknown>
    expect(row.origin).toBeUndefined()
    expect(row.ext).toBeUndefined()
    expect(JSON.stringify(row)).not.toContain('/Users/')
  })

  /**
   * THE ARRAYS ARE COPIED, not handed out.
   *
   * These are the store's own arrays. A caller that sorted or pushed to what
   * it was given would be editing the shelf in place — past every write queue
   * and every journal bracket — and the change would be invisible until the
   * next write persisted it.
   */
  it('hands out copies of the arrays, not the store’s own', () => {
    const row = bookRow(BOOK)
    for (const key of ['languages', 'subjects', 'tags'] as const) {
      expect(row[key]).toEqual(BOOK[key])
      expect(row[key]).not.toBe(BOOK[key])
    }
    ;(row.tags as string[]).push('injected')
    expect(BOOK.tags).toEqual(['sea'])
  })

  /**
   * `hasContent` HAS THREE STATES, and the third is the one that was lost.
   *
   * `undefined` means the folder has not been looked at — the storage model's
   * documented "unknown". Collapsing it into `false` told a caller the bytes
   * are definitely absent when nothing had checked, and a satchel deciding
   * whether to offer Download reads exactly this.
   */
  it('keeps hasContent’s unknown state as null rather than false', () => {
    expect(bookRow({ ...BOOK, hasContent: true }).hasContent).toBe(true)
    expect(bookRow({ ...BOOK, hasContent: false }).hasContent).toBe(false)
    const { hasContent: _unknown, ...unmeasured } = BOOK
    expect(bookRow(unmeasured as IndexedBook).hasContent).toBeNull()
  })

  /* AN ABSENT REFERENCE IS `null`, NOT MISSING. A caller can tell "there is
   * none" from "this field was not sent" only if absence has a value. */
  it('answers null for every absent optional, rather than omitting it', () => {
    const bare = { bookId: 'b', title: 't', author: 'a' } as IndexedBook
    const row = bookRow(bare)
    expect(row).toMatchObject({
      series: null,
      seriesIndex: null,
      publisher: null,
      published: null,
      position: null,
      addedAt: null,
      openedAt: null,
      format: null,
      contentHash: null,
      hasContent: null,
    })
    /* The two that default to a VALUE rather than to null, because the
     * absence of a progress is a beginning and the absence of a finish is
     * "not finished". */
    expect(row.progress).toBe(0)
    expect(row.finished).toBe(false)
    expect(row.languages).toEqual([])
    expect(row.tags).toEqual([])
  })

  /* THE PUBLISHED VOCABULARY IS CLOSED, and it is the domain's. A format the
   * kernel stores and this file does not publish would be a compile error in
   * `bookRow`; this is the runtime half of the same statement. */
  it('publishes every format the kernel stores', () => {
    for (const format of FORMATS) {
      expect(bookRow({ ...BOOK, format }).format, format).toBe(format)
    }
  })
})

describe('bookDetail', () => {
  it('is a book row plus the registers, and nothing else', () => {
    const detail = Object.keys(bookDetail(BOOK)).sort()
    const row = Object.keys(bookRow(BOOK)).sort()
    expect(detail.filter((key) => !row.includes(key))).toEqual(['finishedAt', 'positionAt', 'tagClock'])
  })

  /* `null` RATHER THAN MISSING, so a caller can tell "never stamped" from
   * "not sent". A phase-4 record has no clocked writer behind it. */
  it('answers null for a record with no registers', () => {
    expect(bookDetail(BOOK)).toMatchObject({ positionAt: null, finishedAt: null, tagClock: null })
  })
})

describe('markRow', () => {
  const MARK: Mark = {
    id: 'm1',
    bookId: 'book:a',
    cfi: 'epubcfi(/6/4!/4/2/2)',
    sectionIndex: 0,
    text: 'the whale',
    note: 'a note',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
    createdAt: 1,
    prefix: 'before ',
    suffix: ' after',
    updatedAt: '018f00000000-0001-abcdefabcdefabcd',
    deletedAt: '018f00000000-0002-abcdefabcdefabcd',
  } as Mark

  /**
   * FOUR FIELDS ARE DROPPED, and the doc used to name only one.
   *
   * `deletedAt` and `updatedAt` are the ledger's stamps — a read model never
   * shows a tombstone, and a caller reconciling two devices asks sync.
   */
  /* THE RE-FIND CONTEXT IS ON THE WIRE NOW (phase 19). This test used to pin
     its ABSENCE, and that absence was a defect: a mark made over the wire was
     born without the words either side of it, so the day its CFI stopped
     resolving it could not be found again — while a desktop-made mark could.
     The browser client is the first real producer of marks over this wire,
     which is what made the gap matter. Only the stamps are dropped now. */
  it('carries the re-find context and drops only the stamps, and says so by its keys', () => {
    /* ⚠️ THE VALUES, NOT ONLY THE KEYS. This asserted that `prefix` and
       `suffix` were PRESENT and nothing about what was in them — so returning
       `''`, or the two swapped, or the text of a different mark would all have
       passed, while destroying exactly the re-anchoring the fields exist for.
       An empty string is the plausible wrong answer here: it is what a mark
       made before phase 19 legitimately has. */
    expect(markRow(MARK).prefix).toBe(MARK.prefix)
    expect(markRow(MARK).suffix).toBe(MARK.suffix)
    expect(markRow({ ...MARK, prefix: '', suffix: '' })).toMatchObject({ prefix: '', suffix: '' })

    expect(Object.keys(markRow(MARK)).sort()).toEqual([
      'bookId',
      'cfi',
      'chapter',
      'createdAt',
      'id',
      'kind',
      'note',
      'prefix',
      'sectionIndex',
      'style',
      'suffix',
      'text',
      'tint',
    ])
  })

  /**
   * ⚠️ **A ROW WITH `cfi: ''` AND NO REASON IS DROPPED ON ARRIVAL.**
   *
   * `MarkRow` carried no discriminator, so an unplaced mark projected as a
   * plain empty anchor — and every parser refuses that, deliberately, because
   * it is also what a mark that LOST its anchor looks like. The browser client
   * already reads `unplaced` and already does the three-way split; it was never
   * sent one. So an imported mark was stored, listed in the desktop panel,
   * exported and synced, and simply absent over the wire, with nothing
   * reporting a drop.
   */
  describe('an unplaced mark', () => {
    const STRANDED: Mark = {
      ...MARK,
      cfi: '',
      unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    }

    it('carries its reason across the wire', () => {
      expect(markRow(STRANDED).unplaced).toEqual({ reason: 'foreign-build', fromBook: 'book:elsewhere' })
      expect(markRow(STRANDED).cfi, 'the empty anchor is the truth and must not be invented').toBe('')
    })

    it('keeps everything the reader made', () => {
      /* The anchor is the ONE field that cannot cross. The quote, the note and
         the colour are the whole point of sending the row at all. */
      expect(markRow(STRANDED)).toMatchObject({
        text: MARK.text,
        prefix: MARK.prefix,
        suffix: MARK.suffix,
        note: MARK.note,
        tint: MARK.tint,
        chapter: MARK.chapter,
      })
    })

    it('is ABSENT from a placed row, not present-and-undefined', () => {
      /* `exactOptionalPropertyTypes` is on and the key-set assertion above is
         exact, so an unconditional `unplaced: mark.unplaced` would both fail
         that test and put a meaningless key on every mark on the shelf. */
      expect('unplaced' in markRow(MARK)).toBe(false)
    })
  })

  /**
   * ⚠️ **A NON-NULL `tagClock` USED TO BE THE STORE'S OWN OBJECT.**
   *
   * `bookDetail` was only ever tested with the clock absent, so nothing noticed
   * that the present case returned it by reference. The CLI and every local
   * handler reach these projectors with no envelope in between — a JSON round
   * trip would have copied it — so an in-process caller could mutate the live
   * clock outside the write queue. Every other field here is a primitive and
   * could not, which is exactly why this one was easy to miss.
   */
  it('copies a tagClock rather than handing over the store\'s own', () => {
    const clock = {
      history: { on: true, at: '1-a', spelling: 'History' },
      unread: { on: false, at: '2-b', spelling: 'Unread' },
    }
    const row = bookDetail({ ...BOOK, tagClock: clock } as never)

    expect(row.tagClock).toEqual(clock)
    expect(row.tagClock, 'the caller was handed the live map').not.toBe(clock)
    /* ⚠️ AND THE ENTRIES, which are records rather than strings — a shallow
       copy of the map hands over the same entry objects and the mutation just
       moves down a level. */
    expect(row.tagClock?.['history'], 'the caller was handed a live entry').not.toBe(clock.history)

    const taken = row.tagClock as Record<string, { on: boolean; at: string; spelling: string }>
    taken['history'] = { on: false, at: 'tampered', spelling: 'x' }
    if (taken['unread']) taken['unread'].at = 'tampered'
    expect(clock.history.at).toBe('1-a')
    expect(clock.unread.at).toBe('2-b')
  })

  it('publishes every mark kind, tint and style the domain has', () => {
    for (const kind of MARK_KINDS) expect(markRow({ ...MARK, kind }).kind, kind).toBe(kind)
    for (const tint of MARK_TINTS) expect(markRow({ ...MARK, tint }).tint, tint).toBe(tint)
    for (const style of MARK_STYLES) expect(markRow({ ...MARK, style }).style, style).toBe(style)
  })
})

describe('cardRow', () => {
  const CARD: Card = {
    id: 'c1',
    bookId: 'book:a',
    kind: 'Idea',
    body: 'a thought',
    answer: '',
    source: 'Ch. 1',
    cfi: null,
    createdAt: 1,
    updatedAt: '018f00000000-0001-abcdefabcdefabcd',
    deletedAt: '018f00000000-0002-abcdefabcdefabcd',
  } as Card

  it('drops the ledger’s stamps', () => {
    expect(Object.keys(cardRow(CARD)).sort()).toEqual([
      'answer',
      'body',
      'bookId',
      'cfi',
      'createdAt',
      'id',
      'kind',
      'source',
    ])
  })

  /**
   * A CARD THAT BELONGS TO NO BOOK ANSWERS `null`, NOT `''`.
   *
   * The STORE uses the empty string for "no book"; every other absent
   * reference on the wire is `null`. Publishing the sentinel made a caller
   * learn one field's private convention, and an empty string reads as "a book
   * whose id is empty" rather than "no book".
   */
  it('publishes an unassociated card as null rather than the storage sentinel', () => {
    expect(cardRow({ ...CARD, bookId: '' }).bookId).toBeNull()
    expect(cardRow(CARD).bookId).toBe('book:a')
  })

  it('publishes every card kind the domain has', () => {
    for (const kind of CARD_KINDS) expect(cardRow({ ...CARD, kind }).kind, kind).toBe(kind)
  })
})

describe('trashRow', () => {
  const TRASHED: TrashedBook = {
    folder: 'book_a',
    bookId: 'book:a',
    title: 'Moby-Dick',
    author: 'M',
    removedAt: 1,
    expiresAt: 2,
  }

  /* THE FOLDER STAYS BEHIND. It is a path on this device, and a caller names
   * a book by its id — the same reasoning that keeps `origin` off a book row. */
  it('publishes the entry without its folder', () => {
    expect(Object.keys(trashRow(TRASHED)).sort()).toEqual(['author', 'bookId', 'expiresAt', 'removedAt', 'title'])
  })

  /* AN ENTRY WITH NO STAMP EXPIRES AT NULL, not at some number: the sweep
   * LEAVES such an entry rather than deleting it, so saying it expires would
   * be a lie. */
  it('carries a missing stamp through as null', () => {
    const row = trashRow({ ...TRASHED, removedAt: null, expiresAt: null })
    expect(row).toMatchObject({ removedAt: null, expiresAt: null })
  })
})
