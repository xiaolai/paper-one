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
 * reader's disk, `ext` is how this copy happens to be stored, and a mark's
 * `prefix`/`suffix` are a repair input nobody asked for.
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
   * `prefix` and `suffix` are the text either side of the mark, captured so a
   * CFI that no longer resolves can be re-found: a repair input, not a display
   * field, and publishing them would roughly triple a mark row on every
   * listing to serve nobody currently asking.
   */
  it('drops the stamps and the re-find context, and says so by its keys', () => {
    expect(Object.keys(markRow(MARK)).sort()).toEqual([
      'bookId',
      'cfi',
      'chapter',
      'createdAt',
      'id',
      'kind',
      'note',
      'sectionIndex',
      'style',
      'text',
      'tint',
    ])
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
