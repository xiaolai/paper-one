import { describe, expect, it } from 'vitest'
import { isPdf, titleFromSource } from '../lib/formats'

/**
 * The routing decision, which lives in `lib/formats.ts` rather than in
 * `reader/pdf.ts` — importing the latter pulls in pdf.js, which touches browser
 * globals (DOMMatrix) the moment it loads and cannot be imported in this
 * environment at all. The rest of `pdf.ts` needs a real PDF and a worker, so it
 * is verified against the running app instead, per the project's e2e note.
 *
 * This much is worth pinning because getting it wrong is silent in the worst
 * way: a PDF sent to foliate is rejected as an unsupported type, and an EPUB
 * sent to pdf.js fails to parse. Neither says which reader made the mistake.
 */

describe('isPdf', () => {
  it('routes a .pdf file by name', () => {
    expect(isPdf(new File([], 'paper.pdf'))).toBe(true)
  })

  it('routes by MIME type even when the name does not say so', () => {
    // Downloads and drag-and-drop both produce these.
    expect(isPdf(new File([], 'download', { type: 'application/pdf' }))).toBe(true)
  })

  it('leaves every other format to foliate', () => {
    expect(isPdf(new File([], 'moby.epub'))).toBe(false)
    expect(isPdf(new File([], 'book.mobi'))).toBe(false)
    expect(isPdf('/books/moby.epub')).toBe(false)
  })

  it('is not fooled by a name that merely contains pdf', () => {
    expect(isPdf(new File([], 'pdf-notes.epub'))).toBe(false)
    expect(isPdf('/library/pdfs/moby.epub')).toBe(false)
  })

  it('routes a URL, including one carrying a query or fragment', () => {
    expect(isPdf('/papers/attention.pdf')).toBe(true)
    expect(isPdf('https://example.com/a.pdf?download=1')).toBe(true)
    expect(isPdf('https://example.com/a.pdf#page=4')).toBe(true)
  })

  it('is case-insensitive, as file systems are not', () => {
    expect(isPdf(new File([], 'SCAN.PDF'))).toBe(true)
    expect(isPdf('/x/SCAN.Pdf')).toBe(true)
  })
})

describe('titleFromSource', () => {
  it('falls back to the file name without its extension', () => {
    expect(titleFromSource(new File([], 'attention-is-all-you-need.pdf'))).toBe(
      'attention-is-all-you-need',
    )
  })

  it('takes the last path segment of a URL', () => {
    expect(titleFromSource('/papers/1706.03762.pdf')).toBe('1706.03762')
  })
})
