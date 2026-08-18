import { describe, expect, it, vi } from 'vitest'
import type { IndexedBook } from './bookIndex'
import { enrichOne, needsEnrichment, nextStep, pendingFor, type EnrichDeps } from './enrich'

/**
 * The enrichment pass, without a parser.
 *
 * Every test here injects `parse`, which is the point of the module's shape:
 * the decisions — what still needs doing, what one book's parse produces, what
 * happens when it fails — are answerable without pdf.js, foliate or a DOM.
 */

const shelved = (over: Partial<IndexedBook> = {}): IndexedBook => ({
  bookId: 'book:abc',
  title: 'moby-dick-1851',
  author: '',
  ...over,
})

const meta = {
  title: 'Moby-Dick; or, The Whale',
  author: 'Herman Melville',
  subjects: ['Whaling', 'Sea stories'],
  publisher: 'Harper & Brothers',
}

const deps = (over: Partial<EnrichDeps> = {}): EnrichDeps => ({
  readBook: async () => new File([new Uint8Array([1, 2, 3])], 'moby.epub'),
  parse: async () => ({ meta, cover: new Blob(['jacket']) }),
  now: () => 1_000,
  ...over,
})

describe('needsEnrichment', () => {
  it('wants a book that has never been parsed', () => {
    expect(needsEnrichment(shelved())).toBe(true)
  })

  /* The whole condition, and the reason the pass converges: `parsedAt` records
   * that the parser RAN, so a book it could not read is not retried forever. */
  it('leaves a book the parser has already been to', () => {
    expect(needsEnrichment(shelved({ parsedAt: 1 }))).toBe(false)
  })

  it('skips a row whose bytes are missing — there is nothing to parse', () => {
    expect(needsEnrichment(shelved({ hasContent: false }))).toBe(false)
  })

  /* `hasContent` is DERIVED on scan and absent on a record written before it
   * existed. Read as falsy rather than as an explicit `false`, this would skip
   * every book in an older library — which is exactly the library most in need
   * of the pass. */
  it('does not mistake an unknown content flag for a missing file', () => {
    // The key ABSENT, which is how an older record actually comes off the scan.
    expect(needsEnrichment(shelved())).toBe(true)
    expect(needsEnrichment(shelved({ hasContent: true }))).toBe(true)
  })
})

describe('pendingFor', () => {
  it('takes only the books that still need it', () => {
    const books = [
      shelved({ bookId: 'a' }),
      shelved({ bookId: 'b', parsedAt: 5 }),
      shelved({ bookId: 'c', hasContent: false }),
      shelved({ bookId: 'd' }),
    ]
    expect(pendingFor(books).map((one) => one.bookId)).toEqual(['a', 'd'])
  })

  /* The reader who just imported a folder is looking at the shelf they imported
   * it onto. Oldest-first would spend the first minutes below the fold. */
  it('does the most recently added first', () => {
    const books = [
      shelved({ bookId: 'old', addedAt: 100 }),
      shelved({ bookId: 'newest', addedAt: 300 }),
      shelved({ bookId: 'middle', addedAt: 200 }),
    ]
    expect(pendingFor(books).map((one) => one.bookId)).toEqual(['newest', 'middle', 'old'])
  })

  it('puts books too old to have an added date last', () => {
    const books = [shelved({ bookId: 'ancient' }), shelved({ bookId: 'dated', addedAt: 1 })]
    expect(pendingFor(books).map((one) => one.bookId)).toEqual(['dated', 'ancient'])
  })

  it('does not reorder the caller’s array', () => {
    const books = [shelved({ bookId: 'a', addedAt: 1 }), shelved({ bookId: 'b', addedAt: 2 })]
    pendingFor(books)
    expect(books.map((one) => one.bookId)).toEqual(['a', 'b'])
  })
})

describe('enrichOne', () => {
  it('gives back the book’s own account of itself, and its jacket', async () => {
    const out = await enrichOne(deps(), shelved())
    expect(out.parsed).toBe(true)
    expect(out.record.title).toBe('Moby-Dick; or, The Whale')
    expect(out.record.author).toBe('Herman Melville')
    expect(out.record.subjects).toEqual(['Whaling', 'Sea stories'])
    expect(out.record.parsedAt).toBe(1_000)
    expect(out.cover).toBeInstanceOf(Blob)
  })

  /* A parse knows about the BOOK, not about this copy of it. Carrying these
   * would be a background pass overwriting where the file came from and which
   * file to open — and `ext` in particular, since `openStored` defaults a
   * record without one to `.epub` and every enriched PDF would open nothing. */
  it('carries nothing that belongs to the reader or to this copy', async () => {
    const out = await enrichOne(deps(), shelved({ ext: 'pdf', origin: '/books/moby.pdf', openedAt: 9 }))
    for (const field of ['ext', 'origin', 'openedAt', 'bookId', 'tags', 'position', 'progress']) {
      expect(out.record, field).not.toHaveProperty(field)
    }
  })

  it('parses the file the vault hands back, not the record', async () => {
    const readBook = vi.fn(async () => new File([new Uint8Array([1])], 'moby.pdf'))
    const seen: File[] = []
    const parse = vi.fn(async (file: File) => {
      seen.push(file)
      return { meta, cover: null }
    })
    await enrichOne(deps({ readBook, parse }), shelved())
    expect(readBook).toHaveBeenCalledOnce()
    expect(seen[0]).toBeInstanceOf(File)
    expect(seen[0]?.name).toBe('moby.pdf')
  })

  it('is content with a book that simply has no jacket', async () => {
    const out = await enrichOne(deps({ parse: async () => ({ meta, cover: null }) }), shelved())
    expect(out.parsed).toBe(true)
    expect(out.cover).toBeNull()
    expect(out.record.title).toBe('Moby-Dick; or, The Whale')
  })

  /* A shelf is full of files Paper did not write. A pass that throws on the
   * first truncated download enriches nothing after it. */
  describe('when the file will not parse', () => {
    const broken = deps({
      parse: async () => {
        throw new Error('not a zip')
      },
    })

    it('does not throw', async () => {
      await expect(enrichOne(broken, shelved())).resolves.toBeDefined()
    })

    it('says it did not parse, and marks the attempt so it is not repeated', async () => {
      const out = await enrichOne(broken, shelved())
      expect(out.parsed).toBe(false)
      expect(out.record.parsedAt).toBe(1_000)
      expect(needsEnrichment(shelved({ ...out.record }))).toBe(false)
    })

    /* `mergeParsed` treats a parse as the book's own account of itself, so
     * empty strings here would ERASE the filename the import wrote and leave
     * the reader an untitled row — a failed parse making the shelf worse than
     * not running at all. */
    it('keeps the row’s existing title rather than erasing it', async () => {
      const out = await enrichOne(broken, shelved({ title: 'moby-dick-1851', author: 'Unknown' }))
      expect(out.record.title).toBe('moby-dick-1851')
      expect(out.record.author).toBe('Unknown')
      expect(out.cover).toBeNull()
    })

    it('also survives the bytes being unreadable', async () => {
      const gone = deps({
        readBook: async () => {
          throw new Error('ENOENT')
        },
      })
      const out = await enrichOne(gone, shelved())
      expect(out.parsed).toBe(false)
      expect(out.record.parsedAt).toBe(1_000)
    })
  })
})

/* The scheduling rules, without a DOM.
 *
 * These are the promises the pass makes about WHEN it runs, and they were the
 * part that needed a filesystem, a parser and a rendered React tree to reach.
 * Pulled out as `nextStep`, they are four assertions. */
describe('nextStep', () => {
  const shelf = [shelved({ bookId: 'a', addedAt: 1 }), shelved({ bookId: 'b', addedAt: 2 })]

  it('parses the next book when there is one and nothing is in the way', () => {
    const step = nextStep({ books: shelf, hasFilesystem: true, reading: false })
    expect(step).toEqual({ kind: 'parse', book: shelf[1] })
  })

  /* THE RULE THAT MATTERS MOST. A reader in a book is spending the main thread
   * on page turns, and a background parse lands as a stutter in the one place
   * this app has to feel smooth. Pending work does not override it. */
  it('stands down while the reader is in a book, however much is left', () => {
    expect(nextStep({ books: shelf, hasFilesystem: true, reading: true })).toEqual({
      kind: 'idle',
      why: 'reading',
    })
  })

  it('does nothing without a library on disk', () => {
    expect(nextStep({ books: shelf, hasFilesystem: false, reading: false })).toEqual({
      kind: 'idle',
      why: 'no-filesystem',
    })
  })

  /* Complete is a DIFFERENT idle from standing aside, and the distinction is
   * the whole answer when somebody asks why their covers stopped appearing. */
  it('reports completion when every book has been parsed', () => {
    const done = [shelved({ bookId: 'a', parsedAt: 1 })]
    expect(nextStep({ books: done, hasFilesystem: true, reading: false })).toEqual({
      kind: 'idle',
      why: 'complete',
    })
  })

  it('has nothing to do on an empty shelf', () => {
    expect(nextStep({ books: [], hasFilesystem: true, reading: false }).kind).toBe('idle')
  })

  /* Reading is checked BEFORE the work list is built, so a reader in a book
   * does not pay even for the filter — on a two-thousand-book shelf that filter
   * runs on every turn of a loop that is not going to do anything. */
  it('does not look at the shelf at all while reading', () => {
    const exploding = new Proxy([] as never[], {
      get(target, key) {
        if (key === 'filter') throw new Error('the shelf was read while reading')
        return Reflect.get(target, key)
      },
    })
    expect(() =>
      nextStep({ books: exploding, hasFilesystem: true, reading: true }),
    ).not.toThrow()
  })

  /* The pass converges: a book it could not read is marked and not retried, so
   * a shelf of broken files reaches `complete` rather than looping forever. */
  it('reaches completion even when every parse failed', async () => {
    const broken = deps({
      parse: async () => {
        throw new Error('not a zip')
      },
    })
    let books = [shelved({ bookId: 'a' }), shelved({ bookId: 'b' })]
    for (let turn = 0; turn < 10; turn += 1) {
      const step = nextStep({ books, hasFilesystem: true, reading: false })
      if (step.kind === 'idle') {
        expect(step.why).toBe('complete')
        expect(turn).toBe(2)
        return
      }
      const out = await enrichOne(broken, step.book)
      books = books.map((one) =>
        one.bookId === out.bookId ? { ...one, ...out.record } : one,
      )
    }
    throw new Error('the pass never converged')
  })
})
