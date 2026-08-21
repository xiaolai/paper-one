// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isFigure, markFigures } from './markFigures'

/**
 * A figure, told apart from a glyph in a sentence.
 *
 * THE MEASUREMENT THAT SHAPES EVERY CASE HERE: over 699 books and 77,891 images
 * inside block containers, 53.8% are alone in their block and **45.0% sit
 * beside text**. The second group is drop caps shipped as images, gaiji,
 * ornaments, inline mathematics and symbols. Centring those at 95% of the
 * measure would put a full-width plate in the middle of a sentence, which is why
 * the boundary matters more than the treatment does.
 */

const doc = (html: string): Document => {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return parsed
}
const img = (d: Document, i = 0) => d.querySelectorAll('img')[i]!

describe('isFigure', () => {
  it('takes an image alone in its paragraph', () => {
    expect(isFigure(img(doc('<p><img src="a.png"/></p>')))).toBe(true)
  })

  it('refuses an image sitting in a sentence', () => {
    /* The 45%. A drop cap, a gaiji, an inline symbol. */
    expect(isFigure(img(doc('<p>Once upon <img src="a.png"/> a time</p>')))).toBe(false)
  })

  it('refuses an image with only a word beside it', () => {
    expect(isFigure(img(doc('<p>Fig. <img src="a.png"/></p>')))).toBe(false)
  })

  it('forgives a stray character, which is a caption that moved out', () => {
    /* A figure's block routinely keeps an &nbsp; or a leftover full stop, and
       losing the treatment over one character would look arbitrary. */
    expect(isFigure(img(doc('<p> <img src="a.png"/></p>')))).toBe(true)
    expect(isFigure(img(doc('<p><img src="a.png"/>.</p>')))).toBe(true)
  })

  it('refuses one of several images in a block', () => {
    /* A row of thumbnails is a composition the book built. Stacking them as
       three centred plates takes it apart. */
    const d = doc('<p><img src="a.png"/><img src="b.png"/><img src="c.png"/></p>')
    expect(isFigure(img(d, 0))).toBe(false)
    expect(isFigure(img(d, 2))).toBe(false)
  })

  it('takes an image alone in a div, a figure, a li or a blockquote', () => {
    for (const tag of ['div', 'figure', 'li', 'blockquote']) {
      expect(isFigure(img(doc(`<${tag}><img src="a.png"/></${tag}>`))), tag).toBe(true)
    }
  })

  it('takes an image alone in a table cell', () => {
    /* Old EPUBs lay figures out in tables. Written first as a bare <td>, which
       the HTML parser DROPS outside a table — the fixture was invalid and the
       failure looked like a defect in the walk. */
    const d = doc('<table><tr><td><img src="a.png"/></td></tr></table>')
    expect(isFigure(img(d))).toBe(true)
  })

  it('finds the NEAREST block, not the outermost', () => {
    /* `closest` on a block list would happily return the section several levels
       up and call a sentence's image a figure. */
    const d = doc('<section><p>Text around <span><img src="a.png"/></span> here</p></section>')
    expect(isFigure(img(d))).toBe(false)
  })

  it('counts an inline wrapper as transparent', () => {
    const d = doc('<p><a href="x"><img src="a.png"/></a></p>')
    expect(isFigure(img(d))).toBe(true)
  })

  it('refuses an image with no block ancestor at all', () => {
    const d = doc('<img src="a.png"/>')
    /* jsdom puts a bare img straight under body, which is not in the list. */
    expect(isFigure(img(d))).toBe(false)
  })
})

describe('markFigures', () => {
  it('marks the figures and leaves the inline images alone', () => {
    const d = doc('<p><img src="fig.png"/></p><p>text <img src="glyph.png"/> more</p>')
    markFigures(d)
    expect(d.querySelector('img[src="fig.png"]')?.hasAttribute('data-paper-figure')).toBe(true)
    expect(d.querySelector('img[src="glyph.png"]')?.hasAttribute('data-paper-figure')).toBe(false)
  })

  it('marks an inline svg alone in its block', () => {
    const d = doc('<p><svg viewBox="0 0 1 1"></svg></p>')
    markFigures(d)
    expect(d.querySelector('svg')?.hasAttribute('data-paper-figure')).toBe(true)
  })

  it('changes no node, which is what keeps every mark anchored', () => {
    /* A CFI counts element and text nodes and `markContext` stores 32
       characters either side. An attribute is neither, and this asserts that
       nothing else moved. */
    const html = '<p><img src="a.png"/></p><p>text <img src="b.png"/> more</p>'
    const d = doc(html)
    const before = d.body.innerHTML
    const nodes = d.body.querySelectorAll('*').length
    const text = d.body.textContent
    markFigures(d)
    expect(d.body.querySelectorAll('*').length).toBe(nodes)
    expect(d.body.textContent).toBe(text)
    expect(d.body.innerHTML).toBe(before.replace('<img src="a.png">', '<img src="a.png" data-paper-figure="">'))
  })

  it('survives a document with no body', () => {
    const empty = new DOMParser().parseFromString('<html></html>', 'text/xml')
    expect(() => markFigures(empty)).not.toThrow()
  })
})
