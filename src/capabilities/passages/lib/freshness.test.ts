import { describe, expect, it } from 'vitest'
import type { IndexedBook } from '../../../kernel'
import { generationOf, indexable, unwanted, wantedFrom } from './freshness'

/**
 * Freshness, over the lifecycle that actually exists.
 *
 * ⚠️ **"ADDED AND REMOVED" IS NOT THE LIFECYCLE.** Metadata can exist before
 * bytes arrive, and eviction removes bytes and keeps the book — so a book can
 * be on the shelf, in the index, and have no file. Every case here is one of
 * those transitions.
 */

/**
 * A shelf row.
 *
 * ⚠️ **THE OVERRIDES ARE `| undefined` DELIBERATELY.** Under
 * `exactOptionalPropertyTypes`, `Partial<IndexedBook>` refuses an explicit
 * `undefined` — and every case here that matters is about a field the record
 * does NOT have: a book with no `ext`, no `hasContent`, no timestamps. Being
 * unable to spell absence would have left the whole of `indexable`'s fallback
 * untested.
 */
type Row = { readonly [K in keyof IndexedBook]?: IndexedBook[K] | undefined }

function book(over: Row = {}): IndexedBook {
  return {
    bookId: 'book:a',
    title: 'A Book',
    addedAt: 1_000,
    hasContent: true,
    ext: 'epub',
    ...over,
  } as IndexedBook
}

describe('what identifies the bytes an index was built from', () => {
  it('is the content hash when the shelf knows one', () => {
    expect(generationOf(book({ contentHash: 'abc123' }))).toBe('b3:abc123')
  })

  it('falls back to what this device can see about the file', () => {
    /* ⚠️ **DELIBERATELY WEAK, AND SAID SO.** `contentHash` is computed by the
     * peer plugin and is absent on a book nothing has hashed yet, which on a
     * fresh shelf is most of them. Waiting for one would mean a library that
     * becomes searchable only after sync has walked it. */
    expect(generationOf(book({ ext: 'epub', format: 'epub' }))).toBe('file:epub/epub')
    expect(generationOf(book({ ext: undefined, format: undefined }))).toBe('file:/')
  })

  it('cannot be confused with a hash, because it says which question it answered', () => {
    /* A bare hash and a bare description could in principle collide. */
    const hashed = generationOf(book({ contentHash: 'epub' }))
    const described = generationOf(book({ ext: 'epub', format: 'epub' }))
    expect(hashed).not.toBe(described)
    expect(hashed.startsWith('b3:')).toBe(true)
    expect(described.startsWith('file:')).toBe(true)
  })

  it('moves when the bytes do, which is what makes a re-import re-index', () => {
    expect(generationOf(book({ contentHash: 'one' }))).not.toBe(
      generationOf(book({ contentHash: 'two' })),
    )
  })
})

describe('which books have text worth indexing', () => {
  it('takes an EPUB whose bytes are on this device', () => {
    expect(indexable(book())).toBe(true)
  })

  it('leaves out a book whose bytes are not here', () => {
    /* Metadata can exist before bytes arrive; eviction removes bytes and keeps
     * the book. Both arrive here as `hasContent`. */
    expect(indexable(book({ hasContent: false }))).toBe(false)
    expect(indexable(book({ hasContent: undefined }))).toBe(false)
  })

  it('leaves out every format but EPUB, which is the owner’s choice', () => {
    /* Measured the hour the phase was written: 1 959 of 1 962 books are EPUB.
     * The rest are not excluded for a technical reason — a format nothing on
     * the shelf exercises is a format that breaks silently. */
    for (const ext of ['pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'bin']) {
      expect(indexable(book({ ext })), ext).toBe(false)
    }
  })

  it('reads the stored extension first and then what travelled', () => {
    /* ⚠️ `ext` is DEVICE-LOCAL and `format` is what sync carries. Reading only
     * the first is what made every replicated non-EPUB unopenable once. */
    expect(indexable(book({ ext: undefined, format: 'epub' }))).toBe(true)
    expect(indexable(book({ ext: 'epub', format: 'pdf' }))).toBe(true)
    expect(indexable(book({ ext: undefined, format: 'pdf' }))).toBe(false)
  })

  it('does not care about case', () => {
    expect(indexable(book({ ext: 'EPUB' }))).toBe(true)
  })
})

describe('what the shelf wants indexed', () => {
  it('pairs each book with its generation', () => {
    expect(wantedFrom([book({ bookId: 'book:a', contentHash: 'h1' })])).toEqual([
      ['book:a', 'b3:h1'],
    ])
  })

  it('puts the most recently read books first', () => {
    /* ⚠️ **THE PHASE'S "time to first searchable book" BAR IS ABOUT THE FIRST
     * BOOK, AND THIS LINE DECIDES WHICH BOOK THAT IS.** A backfill of 1 959
     * books that began alphabetically would make the shelf searchable in an
     * order nobody cares about. */
    const order = wantedFrom([
      book({ bookId: 'old', addedAt: 1 }),
      book({ bookId: 'read-recently', addedAt: 1, openedAt: 9_000 }),
      book({ bookId: 'added-recently', addedAt: 5_000 }),
    ])
    expect(order.map(([id]) => id)).toEqual(['read-recently', 'added-recently', 'old'])
  })

  it('takes whichever of opened and added is later', () => {
    const order = wantedFrom([
      book({ bookId: 'opened-later', addedAt: 1, openedAt: 100 }),
      book({ bookId: 'added-later', addedAt: 50, openedAt: 2 }),
    ])
    expect(order.map(([id]) => id)).toEqual(['opened-later', 'added-later'])
  })

  it('survives a book with no timestamps at all', () => {
    const order = wantedFrom([
      book({ bookId: 'undated', addedAt: undefined, openedAt: undefined }),
      book({ bookId: 'dated', addedAt: 5 }),
    ])
    expect(order.map(([id]) => id)).toEqual(['dated', 'undated'])
  })

  it('leaves the books it cannot index out entirely', () => {
    expect(wantedFrom([book({ bookId: 'a', hasContent: false }), book({ bookId: 'b' })])).toEqual([
      ['b', 'file:epub/'],
    ])
  })

  it('does not mutate the snapshot it was given', () => {
    /* `sort` is in place, and the library's snapshot is shared with every other
     * reader of it. */
    const shelf = [book({ bookId: 'b', addedAt: 1 }), book({ bookId: 'a', addedAt: 9 })]
    wantedFrom(shelf)
    expect(shelf.map((one) => one.bookId)).toEqual(['b', 'a'])
  })
})

describe('what the index should not be holding', () => {
  it('names what is indexed and no longer wanted', () => {
    /* ⚠️ **THIS IS WHAT MAKES AN EVICTION AND A REMOVAL REACH THE INDEX AT
     * ALL.** Neither emits an event a capability could listen for. */
    expect(unwanted(['a', 'b', 'c'], [['a', 'g'], ['c', 'g']])).toEqual(['b'])
  })

  it('names everything when the shelf wants nothing', () => {
    expect(unwanted(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('names nothing when the index holds nothing', () => {
    expect(unwanted([], [['a', 'g']])).toEqual([])
  })

  it('ignores the generation, because a stale book is not an unwanted one', () => {
    /* A book whose bytes changed is RE-INDEXED, not forgotten. Forgetting it
     * would take it out of search until the backfill reached it again. */
    expect(unwanted(['a'], [['a', 'a-different-generation']])).toEqual([])
  })
})

describe('the generation moves exactly when the bytes can have', () => {
  /* ⚠️ **THE CLAIM THIS REPLACED WAS A COMMENT, AND IT WAS FALSE.**
   * `generationOf`'s header used to say the driver re-extracts on
   * `refreshContent` regardless of the generation. Nothing did — that call
   * publishes only when `hasContent` CHANGES, so a replacement under a book
   * that already had content published nothing and forced nothing. What holds
   * the line is a property of the kernel's paths rather than of this function,
   * and a property nothing asserts is a property that leaves. Found by an
   * independent audit. */
  it('re-extracts when a replacement carries a new hash, which sync always does', () => {
    const before = generationOf(book({ bookId: 'b', contentHash: 'aaa' }))
    const after = generationOf(book({ bookId: 'b', contentHash: 'bbb' }))
    expect(before).not.toBe(after)
  })

  it('sees an eviction as a removal, so what arrives after it is extracted afresh', () => {
    /* The other road bytes take. `evictContent` and `removeDownload` flip
     * `hasContent` true→false, which publishes; the book leaves `wanted`, the
     * sweep's diff forgets it, and the arrival that follows is an ordinary
     * first indexing. Neither half needs a generation to have moved. */
    const live = book({ bookId: 'b', hasContent: true })
    const evicted = book({ bookId: 'b', hasContent: false })
    expect(wantedFrom([live]).map(([id]) => id)).toEqual(['b'])
    expect(wantedFrom([evicted])).toEqual([])
    expect(unwanted(['b'], wantedFrom([evicted]))).toEqual(['b'])
  })

  it('cannot see a file swapped under it by something that is not the kernel', () => {
    /* ⚠️ **STATED AS A LIMIT RATHER THAN LEFT AS A SURPRISE**, and it is the
     * same second-writer limit `sync/lib/secondWriter.test.ts` records for the
     * journal. A book with no hash whose bytes are replaced in place moves
     * nothing this function can read, so the index answers from the old text
     * until a rebuild or a hash arrives. Asserting it is what stops the next
     * reader assuming otherwise — which is how the comment above came to be
     * wrong. */
    const before = generationOf(book({ bookId: 'b', ext: 'epub', format: 'epub' }))
    const after = generationOf(book({ bookId: 'b', ext: 'epub', format: 'epub' }))
    expect(after).toBe(before)
  })
})
