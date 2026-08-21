/**
 * Which images are FIGURES, and which are glyphs in a sentence.
 *
 * The difference decides whether an image may be centred, capped and matted, and
 * getting it wrong is not a matter of degree: measured over 699 books and 77,891
 * images inside block containers, **45.0% sit beside text**. Drop caps shipped
 * as images, gaiji, ornaments, inline mathematics, symbols. Centring those at
 * 95% of the measure turns every one of them into a full-width plate in the
 * middle of a sentence.
 *
 * 53.8% are alone in their block, and those are the figures.
 *
 * `<figure>` IS NOT THE ANSWER: 5.2% of images are inside one. The semantic
 * element exists and the library does not use it.
 *
 * NEITHER IS CSS. `:only-child` counts ELEMENT children, so
 * `<p>Some text <img/></p>` matches it — the text node is not a child for that
 * purpose. There is no selector for "my parent carries no words", which is the
 * actual question, so it is answered here and recorded as an attribute.
 *
 * SAFE FOR MARKS. Every mark is anchored by a CFI, which is a path counting
 * element and text nodes, plus `markContext` — 32 characters either side. An
 * attribute is neither a node nor a character. Nothing here inserts, removes or
 * reorders anything; `markProse` has marked prose the same way since it existed.
 */

/** Blocks an image can be alone inside. */
const BLOCK = 'p, div, figure, td, li, blockquote, section, h1, h2, h3, h4, h5, h6'

/**
 * How much text beside an image still counts as "alone".
 *
 * NOT ZERO. A figure's block routinely carries a stray non-breaking space, a
 * numeral, or the punctuation left behind when a caption was lifted into its own
 * paragraph — and a figure that lost its treatment over one `&nbsp;` would be an
 * arbitrary-looking failure in a handful of books per library. Three characters
 * is short enough that nothing anyone would call a sentence fits.
 */
const STRAY = 3

/**
 * The nearest ancestor that is a block, or null.
 *
 * BY WALKING, not by `closest`, because the answer needed is the FIRST block up
 * from the image and `closest` would happily return a `<section>` several levels
 * above a `<span>` that is the real container.
 */
function blockOf(img: Element): Element | null {
  for (let el = img.parentElement; el; el = el.parentElement) {
    if (el.matches(BLOCK)) return el
  }
  return null
}

/**
 * Is this image the whole of its block?
 *
 * ONE IMAGE, NOT SEVERAL. A row of three thumbnails in one paragraph is a
 * composition the book built, and stacking them as three centred plates takes
 * it apart. They keep the inline treatment, which is what they were written as.
 */
export function isFigure(img: Element): boolean {
  const block = blockOf(img)
  if (!block) return false
  if (block.querySelectorAll('img, svg').length !== 1) return false
  return (block.textContent ?? '').trim().length <= STRAY
}

/**
 * Mark the figures, so the stylesheet can reach them.
 *
 * READ EVERYTHING BEFORE WRITING ANYTHING, as `markProse` does and for the same
 * reason: `textContent` is cheap but `setAttribute` invalidates style, and
 * interleaving the two across a chapter of several hundred images is a full
 * recalculation per image.
 */
export function markFigures(doc: Document): void {
  /* A section that failed to parse hands back a document with no body, and this
     runs on every section that loads — the case `ensureLang` guards too. */
  const body = doc.body as HTMLElement | null
  if (!body) return
  const figures: Element[] = []
  for (const img of body.querySelectorAll('img, svg')) {
    if (isFigure(img)) figures.push(img)
  }
  for (const img of figures) img.setAttribute('data-paper-figure', '')
}
