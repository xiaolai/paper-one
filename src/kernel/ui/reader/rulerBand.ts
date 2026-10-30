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
 * The marker that makes body the containing block for what we inject.
 *
 * A class rather than a blanket rule, because `position: relative` on body is
 * not free: it changes the containing block for any absolutely positioned
 * content the BOOK'S OWN stylesheet placed against the initial one, which is
 * how a fixed-layout cover or a pop-up footnote ends up somewhere its author
 * never put it. Applied only while one of our overlays is actually in the
 * document, and removed with the last of them, so a reader who never turns the
 * ruler on gets the book laid out exactly as its author wrote it.
 */
export const ANCHOR_CLASS = 'paper-anchored'

/** Add the marker; the overlay about to be appended needs body positioned. */
function anchor(body: HTMLElement): void {
  body.classList.add(ANCHOR_CLASS)
}

/** Drop the marker once nothing of ours is left in the document. */
function unanchor(doc: Document): void {
  const held = overlays.get(doc)
  if (held?.band?.isConnected || held?.spoken?.isConnected) return
  doc.body?.classList.remove(ANCHOR_CLASS)
}

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
 * Our overlays in one document, keyed by role.
 *
 * A WeakMap rather than `getElementById`. The ids are ours, but the document is
 * the READER'S FILE: an EPUB is free to contain an element with any id it
 * likes, including these. Looked up by id, the band would then take over that
 * element — restyling it, moving it, and finally REMOVING it when the ruler
 * went off, silently deleting a piece of the book. Holding the elements we
 * created means we can only ever touch our own, and the map dies with the
 * document.
 */
type OverlayRole = 'band' | 'spoken'
const overlays = new WeakMap<Document, Partial<Record<OverlayRole, HTMLElement>>>()

/**
 * The overlay for one role, created on first use.
 *
 * Both overlays are the same object with a different box: an absolutely
 * positioned, aria-hidden div behind the text, anchored to body. They were two
 * near-identical copies of this, and the copies had already begun to differ —
 * only one of them cleaned up after itself.
 */
function overlayIn(doc: Document, role: OverlayRole, id: string, className: string): HTMLElement | null {
  const body = doc.body
  if (!body) return null

  const held = overlays.get(doc) ?? {}
  const existing = held[role]
  // `isConnected` because foliate can replace a section's body under us; a
  // detached element would be styled forever and never seen.
  if (existing?.isConnected) return existing

  const element = doc.createElement('div')
  element.id = id
  element.className = className
  // Decorative: it must never be announced, and it must never be a target.
  element.setAttribute('aria-hidden', 'true')
  anchor(body)
  body.append(element)
  overlays.set(doc, { ...held, [role]: element })
  return element
}

function removeOverlay(doc: Document | null, role: OverlayRole): void {
  if (!doc) return
  const held = overlays.get(doc)
  held?.[role]?.remove()
  if (held) overlays.set(doc, { ...held, [role]: undefined })
  unanchor(doc)
}

/**
 * Put the band on a line, creating it if the document does not have one yet.
 *
 * `rectTop` is a viewport coordinate straight from `getClientRects` — the
 * conversion into body's space happens here, in one place, rather than at each
 * call site where it can be got subtly wrong.
 */
export function placeBand(doc: Document, rectTop: number, height: number): void {
  /* No `left` or `width`: the band spans the measure, which its stylesheet
   * gives it, and writing an inline width here would fight that. `place` skips
   * the axes it is not given for exactly this reason. */
  place(doc, 'band', BAND_ID, BAND_CLASS, { top: rectTop, height })
}

/**
 * Put one of our overlays where a viewport rect is.
 *
 * Both overlays are the same operation with a different box, and they were two
 * copies of it: create-or-find, convert into body's space, write the styles.
 * The conversion is the part worth having in one place — it is the step that
 * goes subtly wrong, and a second copy is a second chance to get it wrong.
 */
interface Placement {
  readonly top: number
  readonly height: number
  readonly left?: number
  readonly width?: number
}

function place(
  doc: Document,
  role: OverlayRole,
  id: string,
  className: string,
  box: Placement,
): void {
  const element = overlayIn(doc, role, id, className)
  const body = doc.body
  if (!element || !body) return

  const offset = offsetInBody(body, { top: box.top, left: box.left ?? 0 })
  element.style.top = `${offset.top}px`
  element.style.height = `${box.height}px`
  if (box.left !== undefined) element.style.left = `${offset.left}px`
  if (box.width !== undefined) element.style.width = `${box.width}px`
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
  removeOverlay(doc, 'band')
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
  // All four axes, unlike the band: the ruler tracks a line and spans the
  // measure, where this tracks one word.
  place(doc, 'spoken', SPOKEN_ID, SPOKEN_ID, box)
}

export function removeSpokenWord(doc: Document | null): void {
  removeOverlay(doc, 'spoken')
}
