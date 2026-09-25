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
 * How much text beside a lone image still reads as its CAPTION.
 *
 * The longest caption in the measured sample was 87 characters
 * (`Figure 1-5. A labeled training set for supervised learning`). 300 leaves
 * room for a two-sentence caption and still refuses a paragraph of prose — and,
 * more importantly, refuses the degenerate case: a book whose whole chapter is
 * one `<div>`, where every glyph in it would otherwise be "alone in its block".
 */
const CAPTION = 300

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
 * How many INDEPENDENT images a block holds.
 *
 * ⚠️ **A NESTED `<svg>` IS NOT A SECOND IMAGE, AND COUNTING IT AS ONE HID
 * EVERY ILLUSTRATION THAT HAS ONE.** `querySelectorAll('img, svg')` counts an
 * `<svg>` inside an `<svg>`, and an `<image>`-wrapping cover or a diagram with
 * a nested symbol therefore looked like a row of thumbnails to both
 * predicates: no centring, no matte, no enlarging. Found by audit 2026-09-25.
 *
 * A descendant of another candidate is part of it, not a sibling of it.
 */
function imageCount(block: Element): number {
  const all = [...block.querySelectorAll('img, svg')]
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el))).length
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
  if (imageCount(block) !== 1) return false
  /* ⚠️ **AN SVG'S OWN `<title>` AND `<text>` ARE THE ARTWORK, NOT A CAPTION.**
     Counting them made `<div><svg><text>inlet</text></svg></div>` fail — a
     standalone diagram losing its centring because of words that are part of
     the drawing. `textAround` has always excluded them for `isEnlargeable`;
     this is the same rule, applied where it was missing. */
  const { before, after } = textAround(block, img)
  return before + after <= STRAY
}

/**
 * How much of the block's text sits before this image, and how much after.
 *
 * ⚠️ **LENGTH ALONE CANNOT TELL A CAPTION FROM A GLYPH, AND THE FIRST VERSION
 * OF `isEnlargeable` TRIED TO.** `<p>Once upon <img/> a time</p>` is seventeen
 * characters — comfortably under any caption-sized cap — so a cap on its own
 * opens every drop cap and inline equation in a short sentence. What separates
 * them is not how much text there is but WHERE it is: measured over 80 books
 * and 422 lone images with text beside them, **61.4 % have their text on one
 * side only** and 38.6 % are surrounded. A caption sits wholly before or wholly
 * after; a glyph is set into the sentence.
 *
 * Text INSIDE the element is neither — an `<svg>` may carry its own `<text>`
 * labels, and those belong to the artwork rather than to the page.
 */
function textAround(block: Element, img: Element): { before: number; after: number } {
  let before = 0
  let after = 0
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node.textContent ?? '').trim().length
    if (length === 0) continue
    const where = img.compareDocumentPosition(node)
    if (where & Node.DOCUMENT_POSITION_CONTAINED_BY) continue
    if (where & Node.DOCUMENT_POSITION_FOLLOWING) after += length
    else before += length
  }
  return { before, after }
}

/**
 * Is this image one a reader would want to see BIGGER?
 *
 * ⚠️ **A DIFFERENT QUESTION FROM `isFigure`, AND THE DIFFERENCE IS THE WHOLE
 * REASON THIS EXISTS.** Measured 2026-09-25 over every section of *Hands-On
 * Machine Learning*: 443 images, **18** pass `isFigure`, and **344** are a lone
 * image in a block whose text reads `Figure 1-1. The traditional approach`.
 * The most figure-like objects in the book are the ones `isFigure` refuses, and
 * it is right to refuse them — blowing a plate to 95 % of the measure while its
 * caption stays inline is how a figure and its caption come apart. So `STRAY`
 * is not widened and the attribute is not reused; the two answers sit here
 * together instead, where neither can be mistaken for the other:
 *
 * | asks | a captioned plate? |
 * |---|---|
 * | `isFigure` — may this be re-laid-out, centred, capped and matted? | **refused** — the caption would be orphaned |
 * | `isEnlargeable` — would a reader want this bigger? | **accepted** — a caption is the strongest evidence it IS a figure |
 *
 * They share `blockOf` and the one-image rule and differ only on the text test,
 * which is why widening one to serve the other looked reasonable and would have
 * broken centring across the whole library.
 *
 * ⚠️ **AND THE CAP IS NOT COSMETIC.** With no upper bound the rule accepts an
 * image sitting alone in a `<section>` that contains the entire chapter, which
 * is every inline glyph in a single-block book. `CAPTION` is long enough for a
 * real caption — the longest in that sample was 87 characters — and far short
 * of a paragraph of prose.
 */
export function isEnlargeable(img: Element): boolean {
  const block = blockOf(img)
  if (!block) return false
  if (imageCount(block) !== 1) return false
  const { before, after } = textAround(block, img)
  /* SURROUNDED IS A GLYPH. Text on both sides means the image is set INTO a
     sentence, which is the 38.6 % and is exactly what a caption never is. */
  if (before > 0 && after > 0) return false
  return before + after <= CAPTION
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
