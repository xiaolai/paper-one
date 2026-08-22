// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { documentPassages, passageLabel, screenPassages } from './passages'

const LONG = 'This is a paragraph long enough to be worth citing in an answer about the book.'

function docOf(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html')
}

/** A stub standing in for the renderer's `getCFI`, keyed on the text. */
const cfiOf = (range: Range): string => `cfi(${range.toString().slice(0, 12)})`

describe('documentPassages', () => {
  it('offers each block with its text, location and label', () => {
    const passages = documentPassages(docOf(`<p>${LONG}</p><p>${LONG} Two.</p>`), cfiOf, null)
    expect(passages).toHaveLength(2)
    expect(passages[0]?.label).toBe('¶1')
    expect(passages[1]?.label).toBe('¶2')
    expect(passages[0]?.text).toBe(LONG)
    expect(passages[0]?.cfi).toMatch(/^cfi\(/)
  })

  it('collapses whitespace, so a wrapped paragraph is one line of text', () => {
    const passages = documentPassages(docOf(`<p>${LONG.replace(/ /g, '\n  ')}</p>`), cfiOf, null)
    expect(passages[0]?.text).toBe(LONG)
  })

  /* A stray heading or a one-word line is not something a claim can cite, and
   * offering it wastes a number the model may then use for what it meant. */
  it('skips a block too short to cite', () => {
    const passages = documentPassages(docOf(`<h2>Chapter One</h2><p>${LONG}</p>`), cfiOf, null)
    expect(passages).toHaveLength(1)
    expect(passages[0]?.text).toBe(LONG)
  })

  it('numbers only the blocks it offered, contiguously', () => {
    const passages = documentPassages(docOf(`<p>short</p><p>${LONG}</p><p>${LONG} b</p>`), cfiOf, null)
    expect(passages.map((p) => p.label)).toEqual(['¶1', '¶2'])
  })

  /* A `<p>` inside a `<li>` would otherwise be offered twice — once as itself
   * and once inside its parent — and a model given the same words under two
   * numbers cites the wrong one. */
  it('does not offer a block nested inside another block', () => {
    const passages = documentPassages(docOf(`<li><p>${LONG}</p></li>`), cfiOf, null)
    expect(passages).toHaveLength(1)
  })

  it('reads several kinds of block, not only paragraphs', () => {
    const html = `<blockquote>${LONG}</blockquote><figcaption>${LONG} cap.</figcaption>`
    expect(documentPassages(docOf(html), cfiOf, null)).toHaveLength(2)
  })

  /* An EPUB's endnotes are routinely present in the spine item and hidden with
   * CSS. A companion citing a note the reader cannot see is citing something
   * that is not there. */
  it('skips text hidden by the `hidden` attribute', () => {
    const passages = documentPassages(docOf(`<div hidden><p>${LONG}</p></div><p>${LONG} b</p>`), cfiOf, null)
    expect(passages).toHaveLength(1)
    expect(passages[0]?.text).toBe(`${LONG} b`)
  })

  it('skips text hidden from assistive technology', () => {
    const html = `<div aria-hidden="true"><p>${LONG}</p></div><p>${LONG} b</p>`
    expect(documentPassages(docOf(html), cfiOf, null)).toHaveLength(1)
  })

  /* A block the renderer cannot locate is a block a citation could not
   * navigate to — dropped rather than offered with a broken anchor. */
  it('drops a block whose location cannot be resolved', () => {
    const throwing = (): string => {
      throw new Error('no cfi for that')
    }
    expect(documentPassages(docOf(`<p>${LONG}</p>`), throwing, null)).toEqual([])
  })

  it('drops a block whose location comes back empty', () => {
    expect(documentPassages(docOf(`<p>${LONG}</p>`), () => '', null)).toEqual([])
  })

  it('is empty for a document with no prose', () => {
    expect(documentPassages(docOf('<div></div>'), cfiOf, null)).toEqual([])
  })
})

describe('screenPassages', () => {
  it('reads every rendered section', () => {
    const contents = [
      { index: 0, doc: docOf(`<p>${LONG} one</p>`) },
      { index: 1, doc: docOf(`<p>${LONG} two</p>`) },
    ]
    const passages = screenPassages(contents, (index, range) => `cfi(${index}:${range.toString().slice(0, 8)})`)
    expect(passages).toHaveLength(2)
    expect(passages[0]?.cfi).toContain('cfi(0:')
    expect(passages[1]?.cfi).toContain('cfi(1:')
  })

  /* A scrolled flow can hold two sections at once and a spread loads its
   * right page after its left, so `getContents()` is not reliably sorted —
   * and passages out of reading order would number the book backwards. */
  it('puts the sections in reading order, whatever order they were rendered in', () => {
    const contents = [
      { index: 3, doc: docOf(`<p>${LONG} later</p>`) },
      { index: 1, doc: docOf(`<p>${LONG} earlier</p>`) },
    ]
    const passages = screenPassages(contents, (index) => `cfi(${index})`)
    expect(passages.map((p) => p.cfi)).toEqual(['cfi(1)', 'cfi(3)'])
  })

  it('is empty when nothing is rendered', () => {
    expect(screenPassages([], () => 'cfi')).toEqual([])
  })
})

describe('passageLabel', () => {
  it('is the paragraph mark and the ordinal — a place a reader recognises', () => {
    expect(passageLabel(1)).toBe('¶1')
    expect(passageLabel(12)).toBe('¶12')
  })
})
