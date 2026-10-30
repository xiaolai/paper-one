// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isEnlargeable, isFigure, markFigures } from './markFigures'

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

describe('isEnlargeable', () => {
  /* The measurement this whole predicate exists for: over every section of
     *Hands-On Machine Learning*, 443 images, 18 pass `isFigure`, and 344 are a
     lone image beside a caption reading "Figure 1-1. …". Opening 18 of 362 is
     the defect; these cases pin the difference rather than the count. */

  it('takes the captioned plate that isFigure refuses — the case it exists for', () => {
    const d = doc('<div><img src="a.png"/>Figure 1-1. The traditional approach</div>')
    expect(isEnlargeable(img(d))).toBe(true)
    expect(isFigure(img(d))).toBe(false)
  })

  it('still takes a bare plate, so it is a superset and not a swap', () => {
    const d = doc('<p><img src="a.png"/></p>')
    expect(isEnlargeable(img(d))).toBe(true)
    expect(isFigure(img(d))).toBe(true)
  })

  it('refuses a glyph in a sentence, which is the 45% both predicates must refuse', () => {
    expect(isEnlargeable(img(doc('<p>Once upon <img src="a.png"/> a time</p>')))).toBe(false)
  })

  it('refuses one of several images in a block, as isFigure does', () => {
    /* A row of thumbnails is a composition the book built. Neither predicate
       may take it apart, and this is the clause they share. */
    const d = doc('<p><img src="a.png"/><img src="b.png"/></p>')
    expect(isEnlargeable(img(d))).toBe(false)
    expect(isEnlargeable(img(d, 1))).toBe(false)
  })

  it('refuses an image with no block ancestor at all', () => {
    /* `blockOf` walks up and can find nothing. An image in a bare `<span>`
       chain under `<body>` has no block, and neither predicate may guess. */
    const d = doc('<span><em><img src="a.png"/></em></span>')
    expect(isEnlargeable(img(d))).toBe(false)
    expect(isFigure(img(d))).toBe(false)
  })

  it('refuses a glyph set INTO a short sentence, which a length cap cannot catch', () => {
    /* The defect the first version shipped: seventeen characters is under any
       caption-sized cap, so a cap alone opens every drop cap in the library. */
    const d = doc('<p>Once upon <img src="a.png"/> a time</p>')
    expect(isEnlargeable(img(d))).toBe(false)
  })

  it('takes a caption that sits BEFORE the image as readily as after', () => {
    expect(isEnlargeable(img(doc('<div>Figure 3. The rig<img src="a.png"/></div>')))).toBe(true)
  })

  it('ignores text inside an svg, which is the artwork and not a caption', () => {
    /* An `<svg>` carrying its own labels is not a surrounded glyph, and
       counting its `<text>` as "after" would refuse every labelled diagram. */
    const d = doc('<div>Figure 4. Flow<svg><text>inlet</text></svg></div>')
    expect(isEnlargeable(d.querySelector('svg')!)).toBe(true)
  })

  it('refuses a glyph alone in a block that holds the whole chapter', () => {
    /* The degenerate case the cap exists for. Without an upper bound this is
       "alone in its block" and every inline glyph in a single-div book opens. */
    const prose = 'x'.repeat(400)
    expect(isEnlargeable(img(doc(`<div><img src="a.png"/>${prose}</div>`)))).toBe(false)
  })

  it('is bounded exactly at 300 characters, not merely somewhere near it', () => {
    /* The boundary itself, both sides. A cap a test only brackets loosely is a
       cap any mutant can move. */
    const at = 'y'.repeat(300)
    const over = 'y'.repeat(301)
    expect(isEnlargeable(img(doc(`<div><img src="a.png"/>${at}</div>`)))).toBe(true)
    expect(isEnlargeable(img(doc(`<div><img src="a.png"/>${over}</div>`)))).toBe(false)
  })

  it('counts the TRIMMED length, so surrounding whitespace does not spend the cap', () => {
    const at = 'z'.repeat(300)
    expect(isEnlargeable(img(doc(`<div><img src="a.png"/>   ${at}   </div>`)))).toBe(true)
  })

  it('takes an svg the same way it takes an img', () => {
    const d = doc('<div><svg></svg>Figure 2. A diagram</div>')
    const svg = d.querySelector('svg')!
    expect(isEnlargeable(svg)).toBe(true)
  })
})

describe('what the audit found', () => {
  it('does not count a NESTED svg as a second image', () => {
    /* ⚠️ `querySelectorAll('img, svg')` counts an `<svg>` inside an `<svg>`,
       so a cover or a diagram carrying one looked like a row of thumbnails to
       BOTH predicates: no centring, no matte, no enlarging. Found by audit
       2026-09-25. */
    const d = doc('<div><svg viewBox="0 0 10 10"><svg><rect/></svg></svg></div>')
    const outer = d.querySelector('svg')!
    expect(isFigure(outer)).toBe(true)
    expect(isEnlargeable(outer)).toBe(true)
  })

  it('does not count an image nested inside an svg as a second image', () => {
    /* The EPUB cover-wrapper idiom, and every inline `<svg>` measured on this
       shelf is this shape. */
    const d = doc('<div><svg viewBox="0 0 10 10"><image href="c.jpg"/></svg></div>')
    expect(isEnlargeable(d.querySelector('svg')!)).toBe(true)
  })

  it('still refuses two images that really are siblings', () => {
    const d = doc('<p><img src="a.png"/><img src="b.png"/></p>')
    expect(isFigure(img(d))).toBe(false)
    expect(isEnlargeable(img(d))).toBe(false)
  })

  it('does not read an svg’s own labels as text beside it', () => {
    /* A standalone diagram was losing its centring because of words that are
       part of the drawing. */
    const d = doc('<div><svg><title>Flow</title><text>inlet</text></svg></div>')
    expect(isFigure(d.querySelector('svg')!)).toBe(true)
  })

  it('still refuses a real caption for isFigure, which is its whole job', () => {
    /* The fix must not widen `isFigure` into `isEnlargeable`. */
    const d = doc('<div><img src="a.png"/>Figure 1-1. The traditional approach</div>')
    expect(isFigure(img(d))).toBe(false)
    expect(isEnlargeable(img(d))).toBe(true)
  })
})
