import { describe, expect, it } from 'vitest'
import { alignsAsProse, markProse } from './markProse'

/**
 * The line between a book stating a default and a book composing.
 *
 * Measured over 400 EPUBs in a real library: 32% set paragraph alignment only
 * from a class, so the reader's Alignment control reached none of them; 45%
 * centre paragraphs from a class, so winning the cascade indiscriminately would
 * flatten dedications, epigraphs and verse into running prose. Both numbers
 * have to be respected at once, and this predicate is where that happens.
 *
 * ONLY THE PREDICATE IS TESTED HERE, and the module says why: the traversal
 * around it asks what the book's own stylesheet computed to, and jsdom does not
 * implement that part of the cascade — a class rule setting `text-align` comes
 * back as the empty string there. Asserting it would be asserting the fake.
 */

/** Every value CSS can compute `text-align` to, plus the empty string. */
const VALUES = ['', 'start', 'end', 'left', 'right', 'center', 'justify']

describe('alignment that is an ordinary-prose default', () => {
  it('counts justify and start as prose in either direction', () => {
    for (const dir of ['ltr', 'rtl']) {
      expect(alignsAsProse('justify', dir), dir).toBe(true)
      expect(alignsAsProse('start', dir), dir).toBe(true)
    }
  })

  /* An engine reporting nothing has said the element carries no alignment of
   * its own, which is exactly the case the reader's setting exists for. */
  it('counts an unreported alignment as prose', () => {
    expect(alignsAsProse('', 'ltr')).toBe(true)
    expect(alignsAsProse('', 'rtl')).toBe(true)
  })
})

describe('alignment that is composition', () => {
  /* The 45%. A dedication, an epigraph, a chapter number, a line of verse —
   * every one a centred paragraph, and every one ruined by an alignment that
   * wins the cascade without asking what it is winning against. */
  it('never counts centred text as prose, in either direction', () => {
    expect(alignsAsProse('center', 'ltr')).toBe(false)
    expect(alignsAsProse('center', 'rtl')).toBe(false)
  })

  /* The far edge is composition too — the attribution under a quotation, the
   * date on a letter. Not prose that happens to be aligned oddly. */
  it('never counts the logical far edge as prose', () => {
    expect(alignsAsProse('end', 'ltr')).toBe(false)
    expect(alignsAsProse('end', 'rtl')).toBe(false)
  })
})

/**
 * WHICH SIDE IS THE READING EDGE IS THE DOCUMENT'S TO SAY.
 *
 * This is the pair that makes the `direction` argument load-bearing rather than
 * decorative: the same string has to come out true in one book and false in the
 * other. A predicate that read the physical side would flatten every placed
 * line in an RTL book and leave that book's prose unreachable at the same time.
 */
describe('the reading edge follows the book, not the platform', () => {
  it('reads left as prose in a left-to-right book and as composition in a right-to-left one', () => {
    expect(alignsAsProse('left', 'ltr')).toBe(true)
    expect(alignsAsProse('left', 'rtl')).toBe(false)
  })

  it('reads right the opposite way round', () => {
    expect(alignsAsProse('right', 'rtl')).toBe(true)
    expect(alignsAsProse('right', 'ltr')).toBe(false)
  })

  /* Exhaustive, so a value added to the table cannot be quietly forgotten:
   * exactly one of the two physical sides is prose in a given direction. */
  it('treats exactly one physical side as prose in each direction', () => {
    for (const dir of ['ltr', 'rtl']) {
      const sides = ['left', 'right'].filter((v) => alignsAsProse(v, dir))
      expect(sides, dir).toHaveLength(1)
    }
  })

  /* An unknown direction must not silently become "everything is composition",
   * which would switch the whole control off rather than fail visibly. LTR is
   * the fallback because it is what an unset `direction` computes to. */
  it('falls back to left-to-right for a direction it does not know', () => {
    expect(alignsAsProse('left', '')).toBe(true)
    expect(alignsAsProse('right', '')).toBe(false)
  })
})

describe('the whole table, so nothing is decided by accident', () => {
  it('splits every computed value into prose or composition', () => {
    const ltr = VALUES.filter((v) => alignsAsProse(v, 'ltr'))
    const rtl = VALUES.filter((v) => alignsAsProse(v, 'rtl'))
    expect(ltr).toEqual(['', 'start', 'left', 'justify'])
    expect(rtl).toEqual(['', 'start', 'right', 'justify'])
  })
})

describe('documents that are not books', () => {
  /* This runs on every section that loads, and a section that failed to parse
   * hands back a document with no body and no view — the same case `ensureLang`
   * guards. A throw here would take section loading down with it. */
  it('does nothing to a document with no body rather than throwing', () => {
    const doc = { defaultView: null, body: null } as unknown as Document
    expect(() => markProse(doc)).not.toThrow()
  })

  it('does nothing to a detached document, which has no view', () => {
    const doc = { defaultView: null, body: {} } as unknown as Document
    expect(() => markProse(doc)).not.toThrow()
  })
})
