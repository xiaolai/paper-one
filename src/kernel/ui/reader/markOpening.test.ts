// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { booksOwnInitial, markProse, openingParagraph, type StyleReader } from './markProse'

/**
 * WHICH PARAGRAPH A CHAPTER OPENS WITH, and when Paper's flourish stays off it.
 *
 * `p:first-of-type` matches the first paragraph of every blockquote, note,
 * caption and list item in a chapter as readily as the one the chapter opens
 * with — so the opening is an attribute, and this is the decision behind it.
 *
 * IT WAS NEVER SET. `bookCss` has named `markProse` as this mark's owner since
 * WI-14.4 and nothing wrote it, which made the drop cap and the small caps two
 * settings that moved a pip and left the page alone. Every case below fails on
 * an empty implementation, which is what the tree shipped.
 *
 * A real DOM rather than the fake the sibling suite uses, because every
 * question here is one the fake would have to answer by restating the
 * implementation: what `closest` reaches, what counts as empty, what document
 * order means across nesting. The one thing jsdom cannot answer is the cascade,
 * so the "does the book compose this" decision is injected through a seam and
 * its arithmetic is tested separately.
 */

const html = (body: string): HTMLElement => {
  document.body.innerHTML = body
  return document.body
}

describe('the paragraph a chapter opens with', () => {
  it('is the first one in the flow', () => {
    const body = html('<h1>One</h1><p id="first">Elizabeth knew.</p><p id="second">Later.</p>')
    expect(openingParagraph(body)?.id).toBe('first')
  })

  it('is found under whatever the converter wrapped the chapter in', () => {
    /* The ancestors are nobody's to predict — div, section, article, or none —
       which is why the test is for the containers that mean "aside" and not for
       a whitelist of the ones that mean "flow". */
    const body = html('<div class="chapter"><section><p id="deep">Elizabeth knew.</p></section></div>')
    expect(openingParagraph(body)?.id).toBe('deep')
  })

  it('is not the first line of a pull quote, a caption or a list', () => {
    const body = html(`
      <blockquote><p id="quote">A quotation opens the chapter.</p></blockquote>
      <figure><figcaption><p id="caption">Plate one.</p></figcaption></figure>
      <ul><li><p id="item">A list item.</p></li></ul>
      <p id="real">Elizabeth knew.</p>`)
    expect(openingParagraph(body)?.id).toBe('real')
  })

  it('skips the empty paragraphs converters emit for spacing', () => {
    /* An initial three lines deep drawn on nothing is the worst outcome this
       can produce, and it is the likeliest: a paragraph holding one space is
       how a converter writes a blank line. */
    const body = html('<p id="pad">   </p><p id="nbsp"> </p><p id="real">Elizabeth knew.</p>')
    expect(openingParagraph(body)?.id).toBe('real')
  })

  it('answers null for a section with no prose at all', () => {
    /* A plate, a title page, a section that failed to parse. Nothing to mark is
       an answer, not a failure — and the caller must not write onto null. */
    expect(openingParagraph(html('<h1>One</h1><img src="plate.png" alt="">'))).toBeNull()
    expect(openingParagraph(html(''))).toBeNull()
  })

  it('is one per SECTION, not one per chapter division', () => {
    /* Sections are spine items and a book may put two chapters in one file. The
       mark is the section's opening, which is what the flourish is drawn on;
       finding every heading and marking after each is a different feature. */
    const body = html('<h1>One</h1><p id="a">First.</p><h1>Two</h1><p id="b">Second.</p>')
    expect(openingParagraph(body)?.id).toBe('a')
  })
})

/**
 * WHEN THE BOOK HAS ALREADY COMPOSED THE OPENING.
 *
 * WI-14.4 puts the flourish in the tier where a book that states its own view
 * wins, and the cascade cannot deliver that, because it resolves PER PROPERTY.
 * A book drawing its own drop cap says font-size, line-height, float and
 * margin; Paper says initial-letter. Neither rule wins — they merge, and the
 * reader gets the book's float model wearing Paper's sinkage. Measured on Bad
 * Blood, whose p.dropcaps3line::first-letter is a 4.5em float: the merged
 * result reserved no space and the opening two lines ran through the letter.
 *
 * Winning the cascade instead is closed off, by three guards that are each
 * right: the flourish stays in the before tier (`bookSettings`), only seven
 * properties may be important (`spacing`), and a font-size is forced on the
 * base and nowhere else (`bookSize`). So the answer is given here instead.
 */
describe('a book that draws its own initial', () => {
  const size = (fontSize: string, float = 'none') => ({ fontSize, float })

  it('is recognised by a float, which is the drop-cap model', () => {
    expect(booksOwnInitial('21px', size('21px', 'left'))).toBe(true)
  })

  it('is recognised by a size the paragraph does not have', () => {
    expect(booksOwnInitial('21px', size('94.5px'))).toBe(true)
  })

  it('is recognised by `initial-letter`, which is the property built for it', () => {
    /* THE ONE A MODERN BOOK USES. It sinks a capital without floating it and
       without changing `font-size`, so a book composing a perfectly good drop
       cap read as composing nothing — and got Paper's merged on top. */
    expect(booksOwnInitial('21px', { ...size('21px'), initialLetter: '3' })).toBe(true)
    expect(booksOwnInitial('21px', { ...size('21px'), initialLetter: '2 3' })).toBe(true)
  })

  it('is not claimed by an `initial-letter` that says nothing', () => {
    /* `normal` and the empty string are what a browser answers for a book
       that never set it — treating either as a composed initial would
       withhold the flourish from every book. */
    expect(booksOwnInitial('21px', { ...size('21px'), initialLetter: 'normal' })).toBe(false)
    expect(booksOwnInitial('21px', { ...size('21px'), initialLetter: '' })).toBe(false)
    expect(booksOwnInitial('21px', { ...size('21px'), initialLetter: '  ' })).toBe(false)
  })

  it('is NOT claimed when the pseudo-element merely inherits', () => {
    /* A pseudo-element with no rule of its own computes to the element's own
       values, so a book that never mentions ::first-letter answers false on
       both counts without anything having to parse its stylesheet. */
    expect(booksOwnInitial('21px', size('21px'))).toBe(false)
  })

  it('is not claimed for a colour-only rule, which does not compose a layout', () => {
    /* Books tint the first letter without raising it. That is not an opening
       flourish and Paper's may still be drawn over it. */
    expect(booksOwnInitial('21px', size('21px'))).toBe(false)
  })
})

describe('the mark the walk writes', () => {
  const prose: StyleReader = () => ({ textAlign: 'justify', direction: 'ltr' })

  it('lands on the opening when the book composes nothing', () => {
    html('<h1>One</h1><p id="first">Elizabeth knew.</p><p>Later.</p>')
    markProse(document, prose, () => false)
    expect(document.getElementById('first')?.hasAttribute('data-paper-opening')).toBe(true)
  })

  it('is withheld entirely when the book composes its own opening', () => {
    /* Withheld, not narrowed: the small caps go with it. A book that has drawn
       its own opening has composed that paragraph, and Paper's flourish belongs
       in none of it. */
    html('<h1>One</h1><p id="first">Elizabeth knew.</p><p>Later.</p>')
    markProse(document, prose, () => true)
    expect(document.getElementById('first')?.hasAttribute('data-paper-opening')).toBe(false)
  })

  it('skips a first paragraph the walk did not call prose', () => {
    /* A CENTRED DEDICATION IS NOT AN OPENING. `openingParagraph` answers a
       structural question — the first non-empty `<p>` outside the furniture —
       which is not the typographic one the walk settles. The dedication was
       rejected as prose and was still first, so it got a sunk capital on a
       centred line: the one place a drop cap can never belong. */
    const centred: StyleReader = (el) =>
      el.id === 'dedication'
        ? { textAlign: 'center', direction: 'ltr' }
        : { textAlign: 'justify', direction: 'ltr' }
    html('<p id="dedication">For my mother.</p><p id="real">Elizabeth knew.</p>')
    markProse(document, centred, () => false)
    expect(document.getElementById('dedication')?.hasAttribute('data-paper-opening')).toBe(false)
    expect(document.getElementById('real')?.hasAttribute('data-paper-opening')).toBe(true)
  })

  it('marks exactly one paragraph, whatever the chapter contains', () => {
    html('<blockquote><p>Quoted.</p></blockquote><p id="real">Elizabeth knew.</p><p>Later.</p>')
    markProse(document, prose, () => false)
    expect(document.querySelectorAll('[data-paper-opening]')).toHaveLength(1)
    expect(document.getElementById('real')?.hasAttribute('data-paper-opening')).toBe(true)
  })
})
