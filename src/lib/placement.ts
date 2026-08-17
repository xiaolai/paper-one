/**
 * Where a floating surface goes, so it stays on screen.
 *
 * ONE PLACE FOR A DECISION THAT WAS BEING MADE TWICE, differently. The book
 * cell's menu set `{top, right}` from the button's rect and called that a
 * position — so on the first column, where the button already sits at the
 * shelf's left edge, the menu was right-aligned to a point that had nothing to
 * its left, and it hung off the window. The selection popup, meanwhile, had
 * the correct algorithm — flip when there is no room, clamp to the edge, pin
 * the leading edge when it cannot fit at all — but hand-rolled, in stage
 * coordinates, coupled to one container. Every popover the app grows next
 * would have picked one of those two to copy.
 *
 * PURE GEOMETRY. Numbers in, numbers out, no DOM: it can be tested against
 * every edge of a viewport without a browser, which is what a placement
 * routine needs, because its bugs are exactly the cases nobody happens to
 * open a menu in. `usePlacement` is the thin hook that reads the rects and
 * hands them here.
 *
 * The vocabulary is the platform's. `side` is which edge of the anchor the
 * surface hangs from — 'bottom' for a menu, 'top' for a selection toolbar —
 * and `align` is where along that edge it lines up. Both are PREFERENCES:
 * the result says which were honoured, so a caller that draws an arrow can
 * point it the right way.
 */

export interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

export type Side = 'top' | 'bottom'
export type Align = 'start' | 'center' | 'end'

export interface PlacementInput {
  /** The thing the surface hangs from, in viewport coordinates. */
  readonly anchor: Rect
  /** The surface's own size — measured, since it is content-sized. */
  readonly surface: { readonly width: number; readonly height: number }
  /** The space it must stay inside. Usually the viewport. */
  readonly bounds: Rect
  /** Which edge of the anchor to hang from. Flipped when there is no room. */
  readonly side?: Side
  /** Where along that edge to line up. Slid inward when there is no room. */
  readonly align?: Align
  /** Clearance between anchor and surface. */
  readonly gap?: number
  /** Clearance kept from the bounds' edges. */
  readonly edge?: number
  /**
   * When the surface flips to the OTHER side, may it lie over the anchor?
   *
   * Two kinds of anchor want two answers. A menu's anchor is the card or row
   * it acts on: flipped above a tall card, "clear of the anchor" means leaping
   * the whole card to land on the neighbour above it, which reads as the
   * neighbour's menu — while draping up over its own card, hanging from the
   * same bottom edge, keeps it unmistakably its own. A selection toolbar's
   * anchor is the text it acts on: it must NOT cover that, since the reader
   * has to see what they selected. Default false, which is the toolbar's
   * answer and the conservative one; menus over cards say true.
   */
  readonly overlayOnFlip?: boolean
}

export interface Placement {
  readonly top: number
  readonly left: number
  /** The side actually used — differs from the request when it flipped. */
  readonly side: Side
  /** The alignment actually used — differs when it had to slide. */
  readonly align: Align
}

/**
 * Pick a place.
 *
 * MAIN AXIS FIRST, then cross. The preferred side is kept if the surface fits
 * there; otherwise the other side, if it fits THERE; otherwise whichever side
 * has more room, with the surface pinned to the bounds' edge — never past it.
 * A menu that opens downward off the bottom of the window is unreachable, and
 * that is worse than a menu that opens upward against expectation.
 *
 * On the cross axis the alignments that keep the surface TOUCHING its anchor
 * are tried first — the one asked for, then its mirror — and only when none
 * fits is it slid inward. A menu that clears the window's edge by sliding past
 * the button that opened it has kept the lesser property and lost the greater:
 * it is on screen and belongs to nothing. When it cannot fit at all it is
 * pinned to the LEADING edge, so the first items stay reachable rather than
 * centring and losing both ends. The selection popup worked that last part out
 * first and its comment says why.
 */
export function place({
  anchor,
  surface,
  bounds,
  side = 'bottom',
  align = 'start',
  gap = 4,
  edge = 8,
  overlayOnFlip = false,
}: PlacementInput): Placement {
  const boundsBottom = bounds.top + bounds.height
  const boundsRight = bounds.left + bounds.width
  const anchorBottom = anchor.top + anchor.height
  const anchorRight = anchor.left + anchor.width

  /* --- main axis: which side, and the top that goes with it -------------- */
  /* Where a flipped surface hangs FROM. Clear of the anchor it hangs from the
   * far edge — above the anchor's top, below its bottom. Overlaid, it hangs
   * from the NEAR edge instead: flipped up it sits with its bottom on the
   * anchor's bottom, draping over the anchor rather than leaping it. The room
   * available is measured from the same edge, so a tall card counts as room
   * to lie over rather than an obstacle to clear. */
  const flipUpBottom = overlayOnFlip ? anchorBottom : anchor.top - gap
  const flipDownTop = overlayOnFlip ? anchor.top : anchorBottom + gap
  const roomBelow = boundsBottom - edge - (side === 'bottom' ? anchorBottom + gap : flipDownTop)
  const roomAbove = (side === 'top' ? anchor.top - gap : flipUpBottom) - (bounds.top + edge)
  const fitsBelow = surface.height <= roomBelow
  const fitsAbove = surface.height <= roomAbove

  let usedSide: Side
  if (side === 'bottom') usedSide = fitsBelow ? 'bottom' : fitsAbove ? 'top' : roomBelow >= roomAbove ? 'bottom' : 'top'
  else usedSide = fitsAbove ? 'top' : fitsBelow ? 'bottom' : roomAbove >= roomBelow ? 'top' : 'bottom'

  const flipped = usedSide !== side
  let top: number
  if (usedSide === 'bottom') top = flipped ? flipDownTop : anchorBottom + gap
  else top = (flipped ? flipUpBottom : anchor.top - gap) - surface.height
  // Pinned inside the bounds when it does not fit on either side.
  top = Math.min(Math.max(top, bounds.top + edge), boundsBottom - edge - surface.height)
  top = Math.max(top, bounds.top + edge)

  /* --- cross axis: where along the edge ----------------------------------- */
  const minLeft = bounds.left + edge
  const maxLeft = boundsRight - edge - surface.width
  const leftFor = (a: Align): number =>
    a === 'start' ? anchor.left
    : a === 'end' ? anchorRight - surface.width
    : anchor.left + anchor.width / 2 - surface.width / 2
  const fits = (l: number): boolean => l >= minLeft && l <= maxLeft

  /* ANCHORED FIRST, SLID LAST — and the order is the whole point.
   *
   * The first version tried the requested alignment and, when it overflowed,
   * slid the surface inward until it fit. That keeps it on screen and loses
   * the one thing a menu must not lose: contact with the thing that opened
   * it. On the first card of the shelf, a menu asked to hang from the
   * button's right edge slid 32px PAST that edge to clear the window's left,
   * ending under the next card, and read as that card's menu.
   *
   * So an edge alignment tries its MIRROR before it slides — `end` for
   * `start`, and back — and only when neither anchored placement fits is the
   * surface slid, which is now the case where the anchor itself is nearly off
   * screen. Sliding as a last resort is right; sliding as the first response
   * was the bug.
   *
   * `center` HAS NO MIRROR, and is deliberately not given one. It is what a
   * selection toolbar asks for — centred on a run of text — and snapping it
   * to the selection's left or right edge when it nears the stage's edge is a
   * visible jump on a control that should feel glued to the words. Its
   * fallback IS sliding: it stays as centred as the edge allows, which is
   * exactly what the selection popup did before it was moved here, and was
   * checked against that code to the pixel. */
  const candidates: Align[] =
    align === 'start' ? ['start', 'end']
    : align === 'end' ? ['end', 'start']
    : ['center']

  let left: number | null = null
  let usedAlign: Align = align
  for (const candidate of candidates) {
    const l = leftFor(candidate)
    if (fits(l)) {
      left = l
      usedAlign = candidate
      break
    }
  }
  if (left === null) {
    if (maxLeft < minLeft) {
      // Wider than the bounds allow: leading edge pinned, trailing end
      // overflows, so the first items stay reachable.
      left = minLeft
      usedAlign = 'start'
    } else {
      // No anchored placement fits — the anchor is at or past an edge — so
      // slide the requested one just far enough to be inside.
      const wanted = leftFor(align)
      left = Math.min(Math.max(wanted, minLeft), maxLeft)
      usedAlign = wanted < minLeft ? 'start' : 'end'
    }
  }

  return { top, left, side: usedSide, align: usedAlign }
}
