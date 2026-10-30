import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Reading a book's own account of itself without rendering it — the enrichment
 * pass's parse.
 *
 * ⚠️ **NOTHING CALLED IT UNDER TEST.** The tests that reach this module replace
 * it, so what it hands back and what it releases were measured by nothing — and
 * the release is the part that matters: a pass over two thousand books that
 * leaks one parser's resources per book takes the app down long before the end
 * of a real library.
 *
 * The two parsers are replaced, and only them: they are foliate's and pdf.js's,
 * with suites of their own. `readMeta` and `coverFrom` are the real ones, since
 * "the same fields the reader would have read" is this module's whole claim.
 */

const parsers = vi.hoisted(() => ({
  foliate: null as unknown,
  pdf: null as unknown,
  used: [] as string[],
}))

vi.mock('foliate-js/view.js', () => ({
  makeBook: async (file: File) => {
    parsers.used.push(`foliate ${file.name}`)
    return parsers.foliate
  },
}))

vi.mock('./makePdf', () => ({
  makePdf: async (file: File) => {
    parsers.used.push(`pdf ${file.name}`)
    return parsers.pdf
  },
}))

import { parseBook } from './parseBook'

const JACKET = new Blob(['jacket'], { type: 'image/jpeg' })

beforeEach(() => {
  parsers.foliate = null
  parsers.pdf = null
  parsers.used = []
})

describe('a book that is not a PDF', () => {
  it('is read through foliate, for the fields the reader would read, and released', async () => {
    const destroy = vi.fn()
    parsers.foliate = {
      metadata: { title: 'A Measured Book', author: { name: 'A. Writer' } },
      getCover: async () => JACKET,
      destroy,
    }
    const parsed = await parseBook(new File(['PK'], 'measured.epub'))
    expect(parsers.used).toEqual(['foliate measured.epub'])
    expect(parsed.meta).toMatchObject({ title: 'A Measured Book', author: 'A. Writer' })
    expect(parsed.cover).toBe(JACKET)
    expect(destroy, 'the parser was never released — one leak per book in a pass').toHaveBeenCalledTimes(1)
  })

  it('is released even when reading it fails', async () => {
    const destroy = vi.fn()
    parsers.foliate = {
      get metadata(): unknown {
        throw new Error('the package document is unreadable')
      },
      destroy,
    }
    const cause = await parseBook(new File(['PK'], 'broken.epub')).then(
      () => null,
      (error: unknown) => error,
    )
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('the package document is unreadable')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('still parses when its parser gives it nothing to release', async () => {
    /* `destroy` is the fork's, and not every format's parser defines it — so
       asking for it is optional, and a book without one is not an error. */
    parsers.foliate = { metadata: { title: 'No Teardown' }, getCover: () => null }
    const parsed = await parseBook(new File(['PK'], 'plain.mobi'))
    expect(parsed).toEqual({ meta: expect.objectContaining({ title: 'No Teardown' }), cover: null })
  })
})

describe('a PDF', () => {
  it('is read through the reader’s own PDF parser, and answers only once it is released', async () => {
    /* ⚠️ AWAITED, NOT FIRED AND FORGOTTEN. A `PdfBook` owns a pdf.js worker;
       answering before it is released lets the next book's parse overlap this
       one's teardown, and the pass is one-at-a-time only in the cheap part. */
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let destroyed = false
    parsers.pdf = {
      metadata: { title: 'A Scanned Book', author: 'A. Scanner' },
      getCover: async () => JACKET,
      destroy: async () => {
        await released
        destroyed = true
      },
    }
    let answered = false
    const parsing = parseBook(new File(['%PDF-1.7'], 'scanned.pdf', { type: 'application/pdf' })).then((parsed) => {
      answered = true
      return parsed
    })
    await vi.waitFor(() => expect(parsers.used).toEqual(['pdf scanned.pdf']))
    await Promise.resolve()
    expect(answered, 'it answered before the PDF was released').toBe(false)

    release()
    const parsed = await parsing
    expect(destroyed).toBe(true)
    expect(parsed.meta).toMatchObject({ title: 'A Scanned Book', author: 'A. Scanner' })
    expect(parsed.cover).toBe(JACKET)
  })
})
