/**
 * The reading ruler's band, drawn INSIDE the book document.
 *
 * §12 puts the band at layer 0 — behind the text. That is unreachable from the
 * host at any z-index: the book is an iframe whose document paints an opaque
 * background, so anything the host draws behind it is simply not visible, and
 * the band's own parent is a stacking context besides. The band used to be
 * drawn ABOVE the text and tinted it with `mix-blend-mode: multiply`, which
 * reads acceptably but is not what the design asks for and veils the glyphs it
 * passes over.
 *
 * Injected into the book, `z-index: -1` puts it genuinely underneath: negative
 * descendants paint after the stacking context's background but before in-flow
 * content, which is exactly layer 0. It also stops fighting the scroller — the
 * band is positioned in document coordinates, so it stays on its line while the
 * text scrolls instead of needing to be re-translated on every frame.
 */

/** The element's id in the book document, and the class `bookCss` styles. */
const BAND_ID = 'paper-ruler-band'
export const BAND_CLASS = 'paper-ruler-band'

/**
 * Offset of a viewport rect within body, which is what an absolutely
 * positioned child of body is placed by.
 *
 * Both rects are viewport-relative, so the difference is invariant under
 * scrolling — no scroll term is needed, and adding one is how this goes wrong.
 * Body must be offset on BOTH axes: foliate centres the measure by giving body
 * side margins, which makes the horizontal offset obvious, while the vertical
 * one is zero often enough to look unnecessary and then is not. Measured at
 * 51px into a chapter, which put every spoken word a line and a half low.
 */
function offsetInBody(body: HTMLElement, rect: { top: number; left: number }) {
  const box = body.getBoundingClientRect()
  return { top: rect.top - box.top, left: rect.left - box.left }
}

/**
 * Put the band on a line, creating it if the document does not have one yet.
 *
 * `rectTop` is a viewport coordinate straight from `getClientRects` — the
 * conversion into body's space happens here, in one place, rather than at each
 * call site where it can be got subtly wrong.
 */
export function placeBand(doc: Document, rectTop: number, height: number): void {
  const body = doc.body
  if (!body) return

  let band = doc.getElementById(BAND_ID)
  if (!band) {
    band = doc.createElement('div')
    band.id = BAND_ID
    band.className = BAND_CLASS
    // Decorative: it must never be announced, and it must never be a target.
    band.setAttribute('aria-hidden', 'true')
    body.append(band)
  }

  band.style.top = `${offsetInBody(body, { top: rectTop, left: 0 }).top}px`
  band.style.height = `${height}px`
}

/**
 * Take the band down.
 *
 * Called when the ruler is switched off or the layout goes paginated. Removing
 * rather than hiding keeps the book's DOM as we found it — an EPUB is the
 * user's file, and leaving our furniture in it would show up in a text
 * selection that spans the end of the document.
 */
export function removeBand(doc: Document | null): void {
  doc?.getElementById(BAND_ID)?.remove()
}

/** The word being read aloud, drawn the same way and for the same reason. */
const SPOKEN_ID = 'paper-spoken-word'

export interface SpokenBox {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/**
 * Put the follow-along highlight on the word being spoken.
 *
 * Unlike the ruler's band this needs a left and a width too: the ruler tracks a
 * line and spans the measure, where this tracks one word. `box` is a viewport
 * rect exactly as `getBoundingClientRect` returns it.
 */
export function placeSpokenWord(doc: Document, box: SpokenBox): void {
  const body = doc.body
  if (!body) return

  let word = doc.getElementById(SPOKEN_ID)
  if (!word) {
    word = doc.createElement('div')
    word.id = SPOKEN_ID
    word.className = SPOKEN_ID
    word.setAttribute('aria-hidden', 'true')
    body.append(word)
  }

  const offset = offsetInBody(body, box)
  word.style.top = `${offset.top}px`
  word.style.left = `${offset.left}px`
  word.style.width = `${box.width}px`
  word.style.height = `${box.height}px`
}

export function removeSpokenWord(doc: Document | null): void {
  doc?.getElementById(SPOKEN_ID)?.remove()
}
