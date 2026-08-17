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
 * On the cross axis the preferred alignment is tried, then the surface is
 * SLID — not flipped — until it is inside the bounds. Sliding keeps it as close
 * to where it was asked to be as the edge allows; the alignment it reports is
 * the one that would have produced that position, so an arrow can follow.
 * When it cannot fit at all it is pinned to the LEADING edge: the first items
 * stay reachable, which is better than centring it and losing both ends. The
 * selection popup worked this out first and its comment says why.
 */
export function place({
  anchor,
  surface,
  bounds,
  side = 'bottom',
  align = 'start',
  gap = 4,
  edge = 8,
}: PlacementInput): Placement {
  const boundsBottom = bounds.top + bounds.height
  const boundsRight = bounds.left + bounds.width
  const anchorBottom = anchor.top + anchor.height
  const anchorRight = anchor.left + anchor.width

  /* --- main axis: which side, and the top that goes with it -------------- */
  const roomBelow = boundsBottom - edge - (anchorBottom + gap)
  const roomAbove = anchor.top - gap - (bounds.top + edge)
  const fitsBelow = surface.height <= roomBelow
  const fitsAbove = surface.height <= roomAbove

  let usedSide: Side
  if (side === 'bottom') usedSide = fitsBelow ? 'bottom' : fitsAbove ? 'top' : roomBelow >= roomAbove ? 'bottom' : 'top'
  else usedSide = fitsAbove ? 'top' : fitsBelow ? 'bottom' : roomAbove >= roomBelow ? 'top' : 'bottom'

  let top = usedSide === 'bottom' ? anchorBottom + gap : anchor.top - gap - surface.height
  // Pinned inside the bounds when it does not fit on either side.
  top = Math.min(Math.max(top, bounds.top + edge), boundsBottom - edge - surface.height)
  top = Math.max(top, bounds.top + edge)

  /* --- cross axis: where along the edge, slid inward as needed ------------ */
  const wanted =
    align === 'start' ? anchor.left
    : align === 'end' ? anchorRight - surface.width
    : anchor.left + anchor.width / 2 - surface.width / 2

  const minLeft = bounds.left + edge
  const maxLeft = boundsRight - edge - surface.width
  let left: number
  let usedAlign: Align = align
  if (maxLeft < minLeft) {
    // Wider than the bounds allow: leading edge pinned, trailing end overflows.
    left = minLeft
    usedAlign = 'start'
  } else if (wanted < minLeft) {
    left = minLeft
    usedAlign = 'start'
  } else if (wanted > maxLeft) {
    left = maxLeft
    usedAlign = 'end'
  } else {
    left = wanted
  }

  return { top, left, side: usedSide, align: usedAlign }
}
