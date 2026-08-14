/**
 * Cross-document coordinate translation.
 *
 * The handoff names this the single largest gap between the prototype and a
 * working reader: "foliate-js renders each spine item in an iframe; pdf.js
 * paints a canvas. Everything in these mockups that touches the text — the
 * reading ruler, margin companion marks, the selection popup, the baseline
 * grid — is drawn as ordinary markup here and is cross-document in the real
 * app."
 *
 * There are two distinct jobs, and conflating them is the mistake to avoid:
 *
 *   1. Marks ON the text — highlights, the companion's amber underline. These
 *      belong to foliate-js's Overlayer, which keeps an SVG sized and
 *      positioned to the book's viewport and draws into it from
 *      `range.getClientRects()`, so it shares the text's coordinate space for
 *      free. Do not reimplement them here.
 *
 *      Worth knowing, because it is easy to assume otherwise and be wrong in a
 *      way nothing reports: that SVG is NOT inside the book document. It lives
 *      in the view's shadow tree in the HOST document, beside the iframe. So
 *      CSS injected into the book cannot style it — a custom property meant for
 *      it has to be declared on the host root, from where it inherits through
 *      the shadow boundary. Setting one in `bookCss` resolves to nothing and
 *      falls back to the Overlayer's own default, silently.
 *
 *   2. Chrome BESIDE the text — the selection popup, margin companion marks,
 *      the ruler's alignment to a real line. These live in the host document
 *      and need a rect translated across the iframe boundary. That is what
 *      this module does.
 */

export interface Offset {
  readonly dx: number
  readonly dy: number
  readonly scaleX: number
  readonly scaleY: number
}

/**
 * Where the book's iframe sits inside `host`, and how it is scaled.
 *
 * Fixed-layout books and PDF pages are rendered with a CSS transform, so the
 * ratio between the frame's visual box and its layout box is not always 1.
 * Ignoring it puts every translated rect in the wrong place at any zoom level
 * other than 100%.
 */
export function frameOffset(doc: Document, host: HTMLElement): Offset | null {
  const frame = doc.defaultView?.frameElement as HTMLElement | null
  if (!frame) return null

  const frameBox = frame.getBoundingClientRect()
  const hostBox = host.getBoundingClientRect()

  // offsetWidth is the untransformed layout width; the bounding rect is the
  // visual one. Guard against a zero layout box, which happens for one frame
  // while a spine item is still being attached.
  const scaleX = frame.offsetWidth > 0 ? frameBox.width / frame.offsetWidth : 1
  const scaleY = frame.offsetHeight > 0 ? frameBox.height / frame.offsetHeight : 1

  return {
    dx: frameBox.left - hostBox.left,
    dy: frameBox.top - hostBox.top,
    scaleX,
    scaleY,
  }
}

/** A plain rect in host coordinates. DOMRect is not structurally cloneable. */
export interface HostRect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly bottom: number
  readonly right: number
}

function translate(rect: DOMRect, offset: Offset): HostRect {
  const left = offset.dx + rect.left * offset.scaleX
  const top = offset.dy + rect.top * offset.scaleY
  const width = rect.width * offset.scaleX
  const height = rect.height * offset.scaleY
  return { top, left, width, height, bottom: top + height, right: left + width }
}

/**
 * Every client rect of `range`, expressed relative to `host`.
 *
 * A Range spanning several lines yields one rect per line, which is what the
 * margin marks and the ruler both want — a single bounding box would collapse
 * a three-line quotation into one tall block and misplace the mark.
 */
export function rangeRectsInHost(range: Range, host: HTMLElement): HostRect[] {
  const doc = range.startContainer.ownerDocument
  if (!doc) return []
  const offset = frameOffset(doc, host)
  if (!offset) return []
  return Array.from(range.getClientRects()).map((rect) => translate(rect, offset))
}

/** The bounding box of `range` in host coordinates, or null if it has none. */
export function rangeBoxInHost(range: Range, host: HTMLElement): HostRect | null {
  const doc = range.startContainer.ownerDocument
  if (!doc) return null
  const offset = frameOffset(doc, host)
  if (!offset) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return translate(rect, offset)
}

/**
 * The line box under a point, in the BOOK's own viewport coordinates.
 *
 * The ruler cannot assume a constant 34px step: the handoff warns that
 * headings, images, block quotes and footnotes sit off-grid regardless of what
 * is injected, so the band has to snap to a rect that actually exists. Returns
 * null when the point is not over text, which is the caller's cue to leave the
 * band where it was rather than jump it to the top of the document.
 *
 * Book space rather than host space because the band itself now lives inside
 * the book document — see `rulerBand.ts`. The host-space rect the gutter hint
 * needs is this rect put through `hostFromBookRect`, so both come from one
 * measurement instead of the document being probed twice per pointer move.
 */
export function lineRectInBook(doc: Document, bookX: number, bookY: number): DOMRect | null {
  const caret = caretRangeAt(doc, bookX, bookY)
  if (!caret) return null

  const node = caret.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null

  /* Measure the whole line, not the caret's own text node.
   *
   * A line is rarely one text node. `Hello <em>world</em> again` is three, and
   * a footnote marker or an inline <span> splits one more; `getClientRects` on
   * a single node returns only ITS fragment. The band then covers a few words
   * of the line instead of the line, and its height comes from whichever
   * fragment the pointer happened to be over — a superscript marker gives a
   * band a third of the height of the text it is meant to be under.
   *
   * So the scope is the containing block, and the rects that share the pointer's
   * line are merged back into one. */
  const view = doc.defaultView
  const scope = doc.createRange()
  scope.selectNodeContents(blockAncestor(node, view) ?? node)

  const rects = Array.from(scope.getClientRects()).filter((rect) => rect.height > 0)
  /* Seeded by the fragment under the pointer, then widened to every fragment
   * that OVERLAPS it vertically. Taking only the fragments containing the
   * pointer's own y excludes the ones that sit off the baseline — a superscript
   * footnote marker, a smaller inline caption — so the band stopped short of
   * text that is plainly on the same line. */
  const seed = rects.find((rect) => bookY >= rect.top && bookY <= rect.bottom)
  if (!seed) return null
  const online = rects.filter((rect) => rect.bottom > seed.top && rect.top < seed.bottom)

  let { top, bottom, left, right } = seed
  for (const rect of online) {
    top = Math.min(top, rect.top)
    bottom = Math.max(bottom, rect.bottom)
    left = Math.min(left, rect.left)
    right = Math.max(right, rect.right)
  }
  return new DOMRect(left, top, right - left, bottom - top)
}

/**
 * The nearest ancestor that lays out its children as lines.
 *
 * Stops at the first non-inline box: that is the element whose client rects are
 * one-per-line, which is what a line measurement needs. Falls back to the
 * parent element when computed styles are unavailable, which is better than
 * walking to the body and measuring the whole chapter as one rect.
 */
export function blockAncestor(node: Node, view: Window | null): Element | null {
  let element = node.parentElement
  if (!view) return element
  while (element) {
    const display = view.getComputedStyle(element).display
    if (!display.startsWith('inline') && display !== 'ruby' && display !== 'contents') {
      return element
    }
    element = element.parentElement
  }
  return null
}

/**
 * What of the book is actually on screen, in host coordinates.
 *
 * Needed because a Range's client rects are NOT clipped to the viewport. In a
 * paginated book the whole spine item is laid out in columns, so a passage four
 * pages ahead still resolves to a rect — one with the same vertical position as
 * the line under the reader's eye and a horizontal offset several viewport
 * widths away. Translated and used blind, every note in the chapter stacks into
 * the margin at once, and nothing about the rect says it came from a page that
 * is not being shown.
 *
 * The frame's own box is NOT that answer, which is the trap here. Measured in a
 * paginated book: the iframe is 1320px wide inside a 1028px stage, with the
 * overflow clipped by an ancestor. So a rect can sit inside the frame and still
 * be somewhere the reader cannot see, and clipping to the frame alone lets the
 * next page's marks through. The visible region is the frame INTERSECTED with
 * the host — and in host coordinates the host is simply its own box at the
 * origin, so the intersection is a clamp.
 */
export function frameBoxInHost(doc: Document, host: HTMLElement): HostRect | null {
  const frame = doc.defaultView?.frameElement as HTMLElement | null
  if (!frame) return null
  const frameBox = frame.getBoundingClientRect()
  const hostBox = host.getBoundingClientRect()

  const top = Math.max(frameBox.top - hostBox.top, 0)
  const left = Math.max(frameBox.left - hostBox.left, 0)
  const bottom = Math.min(frameBox.bottom - hostBox.top, hostBox.height)
  const right = Math.min(frameBox.right - hostBox.left, hostBox.width)

  /* Disjoint: the frame is entirely outside the host. An EMPTY rect, not null —
   * null is this function's "there is no frame to measure", which callers read
   * as "do not clip". Returning it here would invert the answer and show every
   * mark in the chapter at the exact moment none of them are visible. Nothing
   * overlaps a zero-area rect, which is the correct answer. */
  if (bottom <= top || right <= left) {
    return { top, left, width: 0, height: 0, bottom: top, right: left }
  }

  return { top, left, width: right - left, height: bottom - top, bottom, right }
}

/** Whether two host-space rects overlap at all. */
export function overlaps(rect: HostRect, box: HostRect): boolean {
  return (
    rect.right > box.left &&
    rect.left < box.right &&
    rect.bottom > box.top &&
    rect.top < box.bottom
  )
}

/** Put a rect measured in the book's viewport into host coordinates. */
export function hostFromBookRect(
  rect: DOMRect,
  doc: Document,
  host: HTMLElement,
): HostRect | null {
  const offset = frameOffset(doc, host)
  if (!offset) return null
  return translate(rect, offset)
}


/**
 * `caretRangeFromPoint` is the WebKit spelling and `caretPositionFromPoint`
 * the standard one. Paper ships on WebKit everywhere except Windows, so both
 * paths are live rather than one being a legacy fallback.
 */
function caretRangeAt(doc: Document, x: number, y: number): Range | null {
  const webkit = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof webkit.caretRangeFromPoint === 'function') {
    return webkit.caretRangeFromPoint(x, y)
  }

  const standard = doc as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null
  }
  if (typeof standard.caretPositionFromPoint === 'function') {
    const position = standard.caretPositionFromPoint(x, y)
    /* The NODE is checked, not just the position. A caret position at the very
     * edge of a document can come back with a null `offsetNode`, and passing
     * that to `setStart` throws "Argument 1 ('node') to Range.setStart must be
     * an instance of Node" — from inside a pointer handler, where it becomes an
     * uncaught error rather than a missed measurement. */
    if (!position?.offsetNode) return null
    const range = doc.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
    return range
  }
  return null
}

/**
 * Re-run `onChange` whenever anything that invalidates a translated rect
 * happens: the host resizing, the book document reflowing, or the window
 * changing scale factor between monitors.
 *
 * `relocate` is deliberately NOT wired here — the view owns that event, and
 * the caller subscribes to it directly so a single relocate does not fan out
 * into one recompute per observer.
 */
export function watchGeometry(
  host: HTMLElement,
  doc: Document,
  onChange: () => void,
): () => void {
  const hostObserver = new ResizeObserver(onChange)
  hostObserver.observe(host)

  const bodyObserver = new ResizeObserver(onChange)
  if (doc.body) bodyObserver.observe(doc.body)

  const view = doc.defaultView
  view?.addEventListener('scroll', onChange, { passive: true })
  window.addEventListener('resize', onChange)

  return () => {
    hostObserver.disconnect()
    bodyObserver.disconnect()
    view?.removeEventListener('scroll', onChange)
    window.removeEventListener('resize', onChange)
  }
}
