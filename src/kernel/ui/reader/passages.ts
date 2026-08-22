import type { AskPassage } from '../../core/companion'

/**
 * The book text on screen, as numbered-able passages with their locations.
 *
 * This is where the companion's grounding comes from (WI-15.5). The provider
 * numbers what it is given, sends the text under `[1]`, `[2]`, and maps the
 * model's `[n]` back through the table — **so the model never sees a CFI and
 * is never asked to produce one.** A model handed the word "CFI" emits a
 * syntactically plausible one that points at nothing, which is exactly the
 * register §13's citation rule exists to prevent.
 *
 * # By BLOCK, not by sentence and not by fixed length
 *
 * A citation should land somewhere a reader recognises, and a paragraph is
 * that unit — "¶2" is a place; "characters 400–900" is not. It is also the
 * unit an EPUB actually marks up, so the boundaries come from the author
 * rather than from a heuristic that will split a sentence in the wrong place.
 *
 * # Hidden text is not on the page
 *
 * The same rule `speech.ts` applies and for the same reason: an EPUB's
 * endnotes are routinely present in the spine item and hidden with CSS, and a
 * companion citing a note the reader cannot see is citing something that is
 * not there. `display: none` is walked up the ancestors because it does not
 * inherit; `visibility` is read off the element because it does.
 */

/** The elements a citation may point at. */
const BLOCKS = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption'

/**
 * The shortest block worth offering.
 *
 * A stray heading or a one-word line is not something a claim can cite, and
 * offering it wastes a number the model may then use for the paragraph it
 * meant. The provider applies its own floor as well; this one keeps the
 * cheaper work cheap.
 */
const MIN_CHARS = 40

/**
 * The most blocks to walk in one document.
 *
 * A bound, not a budget: the provider decides what fits in the context, and
 * this only stops a pathological single-file EPUB — the whole of Moby-Dick in
 * one spine item — from being walked end to end on every question.
 */
const MAX_BLOCKS = 400

/** Whether an element is actually visible, rather than merely present. */
function isVisible(element: Element, view: Window | null): boolean {
  if (element.closest('[hidden], [aria-hidden="true"]')) return false
  if (!view) return true
  /* `visibility` INHERITS, so the element's own computed value has already
   * resolved it — and a descendant may set `visible` to come back into view
   * inside a hidden container, a device EPUBs use for pop-up footnotes.
   * Walking it up would reject text that is on screen. */
  if (view.getComputedStyle(element).visibility === 'hidden') return false
  /* `display` does NOT inherit: `display: none` on a container hides
   * everything inside it while each descendant's own computed display stays
   * whatever it was declared as. So it has to be walked up. */
  for (let el: Element | null = element; el; el = el.parentElement) {
    if (view.getComputedStyle(el).display === 'none') return false
  }
  return true
}

/** What a citation chip shows for the nth block of a section. */
export function passageLabel(ordinal: number): string {
  return `¶${ordinal}`
}

/**
 * The passages in one rendered document.
 *
 * `cfiOf` is the renderer's own `getCFI` bound to this document's section
 * index — passed in rather than reached for, so this function is pure enough
 * to test with a parsed document and a stub.
 */
export function documentPassages(
  doc: Document,
  cfiOf: (range: Range) => string,
  view: Window | null = doc.defaultView,
): readonly AskPassage[] {
  const passages: AskPassage[] = []
  const blocks = doc.body?.querySelectorAll(BLOCKS)
  if (!blocks) return passages

  let ordinal = 0
  for (const block of blocks) {
    if (passages.length >= MAX_BLOCKS) break
    /* A `<p>` inside a `<li>` would otherwise be offered twice — once as
     * itself and once inside its parent's text — and a model given the same
     * words under two numbers cites the wrong one. */
    if (block.parentElement?.closest(BLOCKS)) continue
    const text = (block.textContent ?? '').trim().replace(/\s+/g, ' ')
    if (text.length < MIN_CHARS) continue
    if (!isVisible(block, view)) continue

    ordinal += 1
    let cfi: string
    try {
      const range = doc.createRange()
      range.selectNodeContents(block)
      cfi = cfiOf(range)
    } catch {
      /* A block the renderer cannot locate is a block a citation could not
       * navigate to. Dropped rather than offered with a broken anchor —
       * a citation that goes nowhere is the failure this whole path avoids. */
      continue
    }
    if (cfi === '') continue
    passages.push({ text, cfi, label: passageLabel(ordinal) })
  }
  return passages
}

/**
 * Every passage on screen, in reading order.
 *
 * `contents` is `renderer.getContents()` — the sections currently rendered
 * with their live documents, which is the only way in: both renderers call
 * `attachShadow({ mode: 'closed' })`, so there is no DOM route to the iframe.
 */
export function screenPassages(
  contents: readonly { index: number; doc: Document }[],
  getCFI: (index: number, range: Range) => string,
): readonly AskPassage[] {
  return [...contents]
    /* Reading order, not render order: a scrolled flow can hold two sections
     * at once and a spread loads its right page after its left, so the array
     * is not reliably sorted. */
    .sort((a, b) => a.index - b.index)
    .flatMap((entry) =>
      documentPassages(entry.doc, (range) => getCFI(entry.index, range)),
    )
}
