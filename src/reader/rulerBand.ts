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
 * Put the band on a line, creating it if the document does not have one yet.
 *
 * `top` and `height` are in the book's DOCUMENT coordinates — viewport
 * coordinates would slide the band up the page as the reader scrolls, because
 * the band scrolls with the text it is positioned against.
 */
export function placeBand(doc: Document, top: number, height: number): void {
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

  band.style.top = `${top}px`
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
