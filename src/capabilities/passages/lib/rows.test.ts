import { describe, expect, it } from 'vitest'
import { hitOf, hitsOf, pendingOf, statusOf } from './rows'

/**
 * What crosses from Rust, checked rather than cast.
 *
 * Every case here is about a value the type system cannot see: the plugin
 * answers `unknown`, and a cast would make a malformed row RENDER. A hit with
 * no quote draws an empty result the reader can click and that goes nowhere; a
 * `section` that is not a number lands them in no chapter at all.
 */

const HIT = {
  bookId: 'book:a',
  section: 3,
  offset: 17,
  quote: 'the whale',
  prefix: 'and then we saw ',
  suffix: ' rise beside the boat',
  score: 1.5,
}

const STATUS = {
  books: 2,
  sections: 40,
  chars: 100_000,
  indexBytes: 4096,
  textBytes: 8192,
  analysis: 'paper/1',
  unreadable: [{ bookId: 'book:b', why: 'no text', at: 7 }],
}

describe('reading one passage', () => {
  it('renames the plugin’s section field to the kernel’s vocabulary', () => {
    /* One rename in one place. The plugin calls it `section` because that is
     * what it is inside an index; `reanchorPass` and `cfiFor` call the same
     * number `sectionIndex`. Two names travelling together is how they come to
     * disagree. */
    expect(hitOf(HIT)).toEqual({
      bookId: 'book:a',
      sectionIndex: 3,
      offset: 17,
      quote: 'the whale',
      prefix: 'and then we saw ',
      suffix: ' rise beside the boat',
      score: 1.5,
    })
  })

  it('refuses a hit with no quote, which is nothing to draw and nothing to find', () => {
    expect(hitOf({ ...HIT, quote: '' })).toBeNull()
    expect(hitOf({ ...HIT, quote: 7 })).toBeNull()
  })

  it('allows an empty prefix or suffix, which the first sentence of a book has', () => {
    /* ⚠️ Refusing these would drop the opening passage of every book — the most
     * findable sentence in a library. */
    expect(hitOf({ ...HIT, prefix: '' })).not.toBeNull()
    expect(hitOf({ ...HIT, suffix: '' })).not.toBeNull()
  })

  it('refuses a section or an offset that is not a whole count', () => {
    for (const bad of [-1, 1.5, '3', null, undefined, Number.NaN]) {
      expect(hitOf({ ...HIT, section: bad }), `section ${String(bad)}`).toBeNull()
      expect(hitOf({ ...HIT, offset: bad }), `offset ${String(bad)}`).toBeNull()
    }
  })

  it('allows an offset of zero, because a passage can start a chapter', () => {
    expect(hitOf({ ...HIT, offset: 0 })?.offset).toBe(0)
  })

  it('allows a score of zero and a negative one, because a score is not a count', () => {
    expect(hitOf({ ...HIT, score: 0 })?.score).toBe(0)
    expect(hitOf({ ...HIT, score: -2 })?.score).toBe(-2)
    expect(hitOf({ ...HIT, score: Number.POSITIVE_INFINITY })).toBeNull()
    expect(hitOf({ ...HIT, score: 'high' })).toBeNull()
  })

  it('refuses a hit with no book, and anything that is not an object', () => {
    expect(hitOf({ ...HIT, bookId: '' })).toBeNull()
    expect(hitOf({ ...HIT, bookId: 7 })).toBeNull()
    for (const bad of [null, undefined, 'a string', 7, []]) {
      expect(hitOf(bad), String(bad)).toBeNull()
    }
  })
})

describe('reading a list of passages', () => {
  it('refuses a reply that is not a list rather than reading it as empty', () => {
    /* ⚠️ **THE DEFECT THIS REPOSITORY HAS FIXED IN EIGHTEEN STORES.** Read as
     * empty, a malformed reply looks exactly like a library with no matches. */
    for (const bad of [null, undefined, {}, 'no']) {
      expect(() => hitsOf(bad), String(bad)).toThrow(/not a list of passages/u)
    }
  })

  it('drops one bad row alone and keeps the rest', () => {
    const found = hitsOf([HIT, { ...HIT, quote: '' }, { ...HIT, section: 4 }])
    expect(found.map((one) => one.sectionIndex)).toEqual([3, 4])
  })

  it('answers an empty list for an empty one, which is a real answer', () => {
    expect(hitsOf([])).toEqual([])
  })
})

describe('reading the status', () => {
  it('reads every count and the analysis', () => {
    expect(statusOf(STATUS)).toEqual({
      books: 2,
      sections: 40,
      chars: 100_000,
      indexBytes: 4096,
      textBytes: 8192,
      analysis: 'paper/1',
      unreadable: [{ bookId: 'book:b', why: 'no text', at: 7 }],
    })
  })

  it('allows every count to be zero, because a fresh index is a real state', () => {
    const fresh = statusOf({ ...STATUS, books: 0, sections: 0, chars: 0, indexBytes: 0, textBytes: 0 })
    expect(fresh.books).toBe(0)
  })

  it('refuses a status that will not read rather than answering zeroes', () => {
    /* ⚠️ Answered as zeroes it says *"nothing is indexed"* — which is what a
     * reader is told while the shelf is fully searchable, and what a backfill
     * reads as *"start again"*. */
    for (const bad of [null, undefined, 'no', 7]) {
      expect(() => statusOf(bad), String(bad)).toThrow(/not a status/u)
    }
    for (const field of ['books', 'sections', 'chars', 'indexBytes', 'textBytes'] as const) {
      expect(() => statusOf({ ...STATUS, [field]: -1 }), field).toThrow(/cannot read/u)
    }
    expect(() => statusOf({ ...STATUS, analysis: 7 })).toThrow(/cannot read/u)
  })

  it('refuses a malformed unreadable list rather than reading it as “none missing”', () => {
    /* ⚠️ **THE FIELD THE WHOLE SHAPE EXISTS FOR.** *A search that quietly omits
     * a fifth of the library is worse than one that says it is still working* —
     * so reading a malformed list as "no books are missing" is the exact lie it
     * exists to prevent. */
    expect(() => statusOf({ ...STATUS, unreadable: null })).toThrow(/not a list/u)
    expect(() => statusOf({ ...STATUS, unreadable: 'none' })).toThrow(/not a list/u)
  })

  it('drops one malformed unreadable entry alone', () => {
    const read = statusOf({
      ...STATUS,
      unreadable: [
        { bookId: 'book:b', why: 'no text', at: 7 },
        { bookId: '', why: 'no text', at: 7 },
        { bookId: 'book:c', why: '', at: 7 },
        { bookId: 'book:d', why: 'no text', at: -1 },
        'not an object',
        { bookId: 'book:e', why: 'no text', at: 0 },
      ],
    })
    expect(read.unreadable.map((one) => one.bookId)).toEqual(['book:b', 'book:e'])
  })
})

describe('reading the pending list', () => {
  it('keeps the ids and drops anything that is not one', () => {
    expect(pendingOf(['book:a', '', 7, null, 'book:b'])).toEqual(['book:a', 'book:b'])
  })

  it('refuses a reply that is not a list rather than reporting a finished backfill', () => {
    for (const bad of [null, undefined, {}, 'book:a']) {
      expect(() => pendingOf(bad), String(bad)).toThrow(/not a list of book ids/u)
    }
  })

  it('answers an empty list for an empty one', () => {
    expect(pendingOf([])).toEqual([])
  })
})
