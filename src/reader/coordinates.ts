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
 * The line box under a host-space y coordinate, measured from real text.
 *
 * The ruler cannot assume a constant 34px step: the handoff warns that
 * headings, images, block quotes and footnotes sit off-grid regardless of what
 * is injected, so the band has to snap to a rect that actually exists. Returns
 * null when the point is not over text, which is the caller's cue to leave the
 * band where it was rather than jump it to the top of the document.
 */
export function lineRectAt(
  doc: Document,
  host: HTMLElement,
  hostY: number,
  hostX: number,
): HostRect | null {
  const offset = frameOffset(doc, host)
  if (!offset || offset.scaleY === 0 || offset.scaleX === 0) return null

  // Back into the book document's own viewport coordinates.
  const bookX = (hostX - offset.dx) / offset.scaleX
  const bookY = (hostY - offset.dy) / offset.scaleY

  const caret = caretRangeAt(doc, bookX, bookY)
  if (!caret) return null

  // Expand the caret to the whole line by walking to the text node's rects and
  // picking the one containing the point.
  const node = caret.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const lineRange = doc.createRange()
  lineRange.selectNodeContents(node)

  let best: DOMRect | null = null
  for (const rect of Array.from(lineRange.getClientRects())) {
    if (bookY >= rect.top && bookY <= rect.bottom) {
      best = rect
      break
    }
  }
  if (!best) return null
  return translate(best, offset)
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
    if (!position) return null
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
