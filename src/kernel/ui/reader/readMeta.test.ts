import { describe, expect, it } from 'vitest'
import { readMeta } from './readMeta'

/**
 * Every metadata field a book declared nothing for.
 *
 * Spread into the three cases below so each one states only what it is about.
 * Before this, each restated the entire `BookMeta` shape, so widening that type
 * failed three tests that had no opinion about the new fields — a shape assertion
 * pretending to be a behaviour assertion.
 */
const NO_META = {
  title: '',
  author: '',
  identifier: '',
  sortAs: '',
  series: '',
  seriesIndex: null,
  subjects: [],
  publisher: '',
  published: '',
  languages: [],
  description: '',
  subtitle: '',
  pageCount: 0,
}

describe('readMeta', () => {
  it('reads a page count, which only a PDF has', () => {
    /* `makePdf` is the only backend that sets it. Non-zero is what tells a
       citation the book can be cited by page at all — reflowable text has no
       page, because there the page is a property of the window. */
    expect(readMeta({ metadata: { pageCount: 412 } }).pageCount).toBe(412)
    expect(readMeta({ metadata: {} }).pageCount).toBe(0)
  })

  it('refuses a page count that is not a whole positive number', () => {
    // Storage and a book's own metadata are both untrusted; 0 means "no pages".
    for (const bad of [0, -3, 1.5, Number.NaN, Infinity, '12', null]) {
      expect(readMeta({ metadata: { pageCount: bad } }).pageCount).toBe(0)
    }
  })

  it('reads plain strings', () => {
    expect(readMeta({ metadata: { title: 'Moby-Dick', author: 'Melville' } })).toEqual({
      ...NO_META,
      title: 'Moby-Dick',
      author: 'Melville',
      identifier: '',
    })
  })

  it('reads a language map for the title', () => {
    expect(readMeta({ metadata: { title: { en: 'Whale' } } }).title).toBe('Whale')
  })

  it('reads an author object and a list of authors', () => {
    expect(readMeta({ metadata: { author: { name: 'Melville' } } }).author).toBe('Melville')
    expect(
      readMeta({ metadata: { author: [{ name: 'A' }, { name: 'B' }] } }).author,
    ).toBe('A, B')
  })

  it('returns empty strings rather than undefined when metadata is absent', () => {
    expect(readMeta({})).toEqual(NO_META)
  })

  /* The work's own identifier, which foliate parses out of the OPF and this
   * function used to throw away. It is what sharing between two READERS has to
   * be keyed on — `bookId` is the bytes, and two people never hold the same
   * bytes — so losing it here lost it everywhere. */
  it('keeps the work identifier the book declares', () => {
    expect(
      readMeta({ metadata: { title: 'T', identifier: 'urn:uuid:9f2a' } }).identifier,
    ).toBe('urn:uuid:9f2a')
  })

  /**
   * The fields foliate has been parsing all along while Paper discarded them.
   *
   * Every one of these comes out of an OPF a stranger wrote, so the cases below
   * are half "does it read the field" and half "what happens when the field is
   * hostile". The second half is the one that matters for a store which is read
   * whole and rewritten on every position save.
   */
  describe('the fields a library is built out of', () => {
    it('reads a series and its position', () => {
      const md = { belongsTo: { series: { name: 'Discworld', position: 5 } } }
      expect(readMeta({ metadata: md })).toMatchObject({ series: 'Discworld', seriesIndex: 5 })
    })

    /* EPUB allows a fractional position for a novella between two books, so
     * this is a float rather than an index into anything. */
    it('keeps a fractional series position', () => {
      const md = { belongsTo: { series: { name: 'S', position: 1.5 } } }
      expect(readMeta({ metadata: md }).seriesIndex).toBe(1.5)
    })

    it('takes the first when a book declares several series', () => {
      const md = { belongsTo: { series: [{ name: 'First' }, { name: 'Second' }] } }
      expect(readMeta({ metadata: md }).series).toBe('First')
    })

    /* A position that is not a number must not survive as NaN: it would
     * serialise to `null` through JSON and compare false against itself. */
    it('refuses a non-numeric series position', () => {
      const md = { belongsTo: { series: { name: 'S', position: 'later' } } }
      expect(readMeta({ metadata: md }).seriesIndex).toBeNull()
    })

    it('reads subjects, publisher, languages and the sort title', () => {
      const md = {
        subject: ['Philosophy', 'Ethics'],
        publisher: 'Penguin',
        language: ['en'],
        sortAs: 'Hobbit, The',
      }
      expect(readMeta({ metadata: md })).toMatchObject({
        subjects: ['Philosophy', 'Ethics'],
        publisher: 'Penguin',
        languages: ['en'],
        sortAs: 'Hobbit, The',
      })
    })

    /* An OPF may repeat a subject once per language. Shown twice on a row that
     * reads as a bug in the reader rather than in the book. */
    it('deduplicates repeated subjects', () => {
      expect(readMeta({ metadata: { subject: ['Ethics', 'Ethics'] } }).subjects).toEqual(['Ethics'])
    })

    it('accepts a single subject that is not in a list', () => {
      expect(readMeta({ metadata: { subject: 'Ethics' } }).subjects).toEqual(['Ethics'])
    })

    /* The date is kept as the string the book declared. EPUB dates are loosely
     * specified — `2011`, `2011-03`, and a full timestamp are all legal — and
     * parsing invents a January 1st in the reader's own timezone. */
    it('does not parse the published date into a date', () => {
      expect(readMeta({ metadata: { published: '2011' } }).published).toBe('2011')
    })

    it('caps a hostile field rather than storing it whole', () => {
      const huge = 'x'.repeat(50_000)
      const meta = readMeta({ metadata: { title: huge, description: huge } })
      expect(meta.title).toHaveLength(500)
      expect(meta.description).toHaveLength(4000)
    })

    it('caps a hostile list rather than storing every entry', () => {
      const many = Array.from({ length: 5_000 }, (_, i) => `tag-${i}`)
      expect(readMeta({ metadata: { subject: many } }).subjects).toHaveLength(32)
    })

    it('survives a book that declares none of them', () => {
      expect(readMeta({ metadata: { title: 'T' } })).toMatchObject({
        series: '',
        seriesIndex: null,
        subjects: [],
        languages: [],
      })
    })
  })

  it('treats a malformed identifier as no identifier', () => {
    // A package can put anything here; the rest of this function is defensive
    // about exactly that and this field is no different.
    for (const bad of [42, null, {}, ['a'], undefined]) {
      expect(readMeta({ metadata: { identifier: bad } }).identifier).toBe('')
    }
  })
})
