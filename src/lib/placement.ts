/**
 * Where a floating surface goes, so it stays on screen and stays honest.
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
 * ONE COORDINATE SPACE, and the type says so. `anchor` and `bounds` must be
 * measured against the same origin — both viewport, or both the same
 * container. Passing a viewport anchor with a container's bounds produced a
 * result that was numerically valid and visually wrong by exactly the
 * container's offset, and nothing could tell. `Space` is a brand: a caller
 * has to say which space its rects are in, and the compiler refuses to mix
 * them.
 *
 * The result is HONEST ABOUT WHAT IT DID. `side` and `align` report what was
 * actually used, so a caller drawing an arrow points it the right way; and
 * `fit` reports whether the anchor relationship survived at all — 'placed'
 * when it did, 'pinned' when the surface had to be pushed off its anchor to
 * stay on screen, 'detached' when the anchor itself is off screen and the
 * surface has nothing to hang from. The first version returned a nominal
 * success for all three, and a toolbar that had been pushed to cover the very
 * text it acted on reported `side: 'top'` as if it were floating politely
 * above it.
 */

/** Which origin a rect is measured from. A brand so the two cannot be mixed. */
export type Space = 'viewport' | 'container'

export interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/** A rect that knows which space it is in. */
export interface SpacedRect<S extends Space = Space> extends Rect {
  readonly space: S
}

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

/**
 * How well the anchor relationship survived.
 *
 * - `placed`   the surface hangs from its anchor on the side and alignment
 *              reported, or a slid or mirrored equivalent that still touches
 *              it.
 * - `pinned`   nothing touching the anchor fit; the surface was pushed to
 *              the bounds' edge and may cover the anchor.
 * - `detached` the anchor is wholly outside the bounds; the surface was put
 *              inside them but has nothing to hang from. Usually hide it.
 */
export type Fit = 'placed' | 'pinned' | 'detached'

export interface PlacementInput<S extends Space = Space> {
  /** The thing the surface hangs from. */
  readonly anchor: SpacedRect<S>
  /** The surface's own size — measured, since it is content-sized. */
  readonly surface: { readonly width: number; readonly height: number }
  /** The space it must stay inside. Same space as the anchor, by type. */
  readonly bounds: SpacedRect<S>
  /**
   * Geometry the surface must also stay clear of, in the same space. A
   * selection toolbar's anchor is one line, but the selection is many; a
   * toolbar hung from the first line and covering the third is covering what
   * the reader is trying to see. Optional; most surfaces have only their
   * anchor to avoid.
   */
  readonly avoid?: SpacedRect<S>
  /** Which edge of the anchor to hang from. Flipped when there is no room. */
  readonly side?: Side
  /** Where along that edge to line up. */
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
   * same near edge, keeps it unmistakably its own. A selection toolbar's
   * anchor is the text it acts on: it must NOT cover that. Default false.
   */
  readonly overlayOnFlip?: boolean
}

export interface Placement {
  readonly top: number
  readonly left: number
  /** The side actually used — differs from the request when it flipped. */
  readonly side: Side
  /**
   * The alignment actually used: the mirror when mirrored, the request when
   * merely slid — a slid surface is still that alignment, nudged, and calling
   * it `start` when it sits 4px right of `start` was a lie an arrow followed.
   */
  readonly align: Align
  readonly fit: Fit
}

const isVertical = (side: Side): boolean => side === 'top' || side === 'bottom'

/**
 * Reject what cannot be placed. A negative size or a negative gap manufactures
 * overlap that no rule below intends, and doing so quietly is how a caller
 * ends up debugging geometry that was never geometry. Fail at the boundary.
 */
function check(input: PlacementInput): void {
  const { anchor, surface, bounds, gap = 4, edge = 8, avoid } = input
  const bad = (what: string): never => {
    throw new RangeError(`place: ${what}`)
  }
  for (const [name, r] of [['anchor', anchor], ['bounds', bounds], ['avoid', avoid]] as const) {
    if (!r) continue
    if (![r.top, r.left, r.width, r.height].every(Number.isFinite)) bad(`${name} is not finite`)
    if (r.width < 0 || r.height < 0) bad(`${name} has a negative size (${r.width}×${r.height})`)
  }
  if (![surface.width, surface.height].every(Number.isFinite)) bad('surface is not finite')
  if (surface.width < 0 || surface.height < 0) bad('surface has a negative size')
  if (!Number.isFinite(gap) || gap < 0) bad(`gap must be a finite non-negative number (${gap})`)
  if (!Number.isFinite(edge) || edge < 0) bad(`edge must be a finite non-negative number (${edge})`)
  /* THE BRAND IS CHECKED AT RUNTIME TOO. `S` is a type parameter, and a caller
   * with a rect typed as the union `Space` — or an `as any` — infers it as the
   * union and passes both spaces through the compiler. The compile-time brand
   * catches the honest mistake; this catches the rest, and it is one line. */
  if (bounds.space !== anchor.space) bad('bounds is in a different space from the anchor')
  if (avoid && avoid.space !== anchor.space) bad('avoid is in a different space from the anchor')
}

/**
 * Pick a place.
 *
 * MAIN AXIS FIRST, then cross. The preferred side is kept if the surface fits
 * there clear of the anchor (and of `avoid`); otherwise the other side, if it
 * fits THERE; otherwise whichever side has more room, with the surface pinned
 * to the bounds' edge — and `fit: 'pinned'`, because it may now cover what it
 * was meant to hang beside. A menu that opens off the bottom of the window is
 * unreachable, and that is worse than a menu that opens upward against
 * expectation; but a toolbar pushed onto the text it acts on must at least
 * SAY so, and the first version did not.
 *
 * On the cross axis every placement that keeps the surface touching its
 * anchor is a candidate — the alignment asked for, its mirror, and the
 * requested one slid just far enough inside — and they are ranked first by
 * HOW WELL THEY STAY ATTACHED and only then by how little they moved. A
 * candidate that keeps one of the surface's edges on one of the anchor's
 * edges is fully attached; a slid one that has drifted past the anchor is
 * only partly so. That is what makes both of these right at once: a menu at
 * the shelf's left edge whose `end` alignment overflows by 170px mirrors to
 * `start` — its left edge on the button's left, fully attached — rather than
 * sliding to a spot 32px past the button where it merely brushes it; a
 * titlebar dropdown 18px shy of the right edge slides 18px, and is STILL
 * fully attached because its left edge is still on the button's left, rather
 * than mirroring 166px to the far side. Ranking by distance alone got the
 * first wrong; a fixed order got the second wrong. `center` has no mirror:
 * snapping a selection toolbar to the selection's edge as it nears the
 * stage's edge is a visible jump on a control that should feel glued to the
 * words, so its only candidate is itself, slid.
 *
 * When nothing touching the anchor fits, the leading edge is pinned so the
 * first items stay reachable, and `fit` says so.
 */
export function place<S extends Space>(input: PlacementInput<S>): Placement {
  check(input)
  const {
    anchor, surface, bounds, avoid,
    side = 'bottom', align = 'start', gap = 4, edge = 8, overlayOnFlip = false,
  } = input

  const vertical = isVertical(side)

  /* Work in "main"/"cross" so one routine serves all four sides. For a top or
   * bottom side the main axis is y and the cross axis is x; for left or right
   * it is the reverse. `m*` are main-axis numbers, `c*` cross-axis. */
  const A = vertical
    ? { mStart: anchor.top, mSize: anchor.height, cStart: anchor.left, cSize: anchor.width }
    : { mStart: anchor.left, mSize: anchor.width, cStart: anchor.top, cSize: anchor.height }
  const V = avoid
    ? vertical
      ? { mStart: avoid.top, mEnd: avoid.top + avoid.height }
      : { mStart: avoid.left, mEnd: avoid.left + avoid.width }
    : null
  const B = vertical
    ? { mStart: bounds.top, mSize: bounds.height, cStart: bounds.left, cSize: bounds.width }
    : { mStart: bounds.left, mSize: bounds.width, cStart: bounds.top, cSize: bounds.height }
  const S = vertical ? { m: surface.height, c: surface.width } : { m: surface.width, c: surface.height }

  const aEnd = A.mStart + A.mSize
  const bMin = B.mStart + edge
  const bMax = B.mStart + B.mSize - edge

  /* The obstacle on the main axis is the anchor together with `avoid` — but
   * `avoid` counts ONLY if it lies in the surface's path. It was folded into a
   * one-dimensional band, so an obstacle 600px to the side of the anchor still
   * pushed the surface past it, as if it spanned the whole width: a menu that
   * belonged at 124 landed at 524. The surface hangs from the anchor's cross
   * extent, so `avoid` is in the way only when its cross extent overlaps the
   * anchor's (widened by the surface, since the surface may extend past the
   * anchor either way). Disjoint, it is not an obstacle at all. */
  const Vc = avoid
    ? vertical
      ? { cStart: avoid.left, cEnd: avoid.left + avoid.width }
      : { cStart: avoid.top, cEnd: avoid.top + avoid.height }
    : null
  const surfaceReach = { start: A.cStart - S.c, end: A.cStart + A.cSize + S.c }
  const avoidInPath = V !== null && Vc !== null && Vc.cEnd > surfaceReach.start && Vc.cStart < surfaceReach.end
  const obstacleStart = avoidInPath && V ? Math.min(A.mStart, V.mStart) : A.mStart
  const obstacleEnd = avoidInPath && V ? Math.max(aEnd, V.mEnd) : aEnd

  /* Detached: the anchor is wholly outside the bounds. Placed inside anyway,
   * so a caller that insists on drawing gets something sane, but told. */
  const detached =
    aEnd <= B.mStart || A.mStart >= B.mStart + B.mSize ||
    A.cStart + A.cSize <= B.cStart || A.cStart >= B.cStart + B.cSize

  /* --- main axis ------------------------------------------------------- */
  // "after" = below / right; "before" = above / left.
  const preferAfter = side === 'bottom' || side === 'right'
  const afterFrom = obstacleEnd + gap
  const beforeTo = obstacleStart - gap
  // With overlay, a FLIPPED surface hangs from the near edge of the ANCHOR
  // instead of clearing it: flipped "before", its end sits on the anchor's
  // end. It may lie over the anchor — that is the option's meaning — but never
  // over `avoid`, so if `avoid` extends past the anchor on that side the
  // overlay edge is `avoid`'s edge, not the anchor's.
  const overlayBeforeTo = avoidInPath && V && V.mStart < aEnd ? V.mStart - gap : aEnd
  const overlayAfterFrom = avoidInPath && V && V.mEnd > A.mStart ? V.mEnd + gap : A.mStart
  const flipBeforeTo = overlayOnFlip ? overlayBeforeTo : beforeTo
  const flipAfterFrom = overlayOnFlip ? overlayAfterFrom : afterFrom
  const roomAfter = bMax - afterFrom
  const roomBefore = beforeTo - bMin
  const roomFlipBefore = flipBeforeTo - bMin
  const roomFlipAfter = bMax - flipAfterFrom

  let usedAfter: boolean
  let mainStart: number
  let fit: Fit = detached ? 'detached' : 'placed'

  if (preferAfter) {
    if (S.m <= roomAfter) { usedAfter = true; mainStart = afterFrom }
    else if (S.m <= roomFlipBefore) { usedAfter = false; mainStart = flipBeforeTo - S.m }
    else {
      // Fits on neither side: pin to whichever has more room. This may cover
      // the anchor, and `fit` says so.
      usedAfter = roomAfter >= roomFlipBefore
      mainStart = usedAfter ? afterFrom : flipBeforeTo - S.m
      if (!detached) fit = 'pinned'
    }
  } else {
    if (S.m <= roomBefore) { usedAfter = false; mainStart = beforeTo - S.m }
    else if (S.m <= roomFlipAfter) { usedAfter = true; mainStart = flipAfterFrom }
    else {
      usedAfter = roomBefore < roomFlipAfter
      mainStart = usedAfter ? flipAfterFrom : beforeTo - S.m
      if (!detached) fit = 'pinned'
    }
  }
  // Inside the bounds regardless — pinned means pinned, not off screen. When
  // the surface is taller than the bounds the leading edge wins.
  mainStart = Math.max(bMin, Math.min(mainStart, bMax - S.m))

  const usedSide: Side = vertical
    ? (usedAfter ? 'bottom' : 'top')
    : (usedAfter ? 'right' : 'left')

  /* --- cross axis ------------------------------------------------------ */
  const cMin = B.cStart + edge
  const cMax = B.cStart + B.cSize - edge - S.c
  const at = (a: Align): number =>
    a === 'start' ? A.cStart
    : a === 'end' ? A.cStart + A.cSize - S.c
    : A.cStart + A.cSize / 2 - S.c / 2
  const inside = (c: number): boolean => c >= cMin && c <= cMax
  const touches = (c: number): boolean => c < A.cStart + A.cSize && c + S.c > A.cStart

  const wanted = at(align)
  let crossStart: number
  let usedAlign: Align = align

  if (cMax < cMin) {
    // Wider than the bounds allow: leading edge pinned, trailing end
    // overflows, so the first items stay reachable.
    crossStart = cMin
    usedAlign = 'start'
    if (fit === 'placed') fit = 'pinned'
  } else if (inside(wanted)) {
    crossStart = wanted
  } else {
    /* Every candidate that stays inside AND touches the anchor. Ranked by
     * attachment first — does one of the surface's edges still sit on one of
     * the anchor's edges? — and by distance from the request second. A slid
     * candidate that has drifted past the anchor merely brushes it, and loses
     * to a mirror that is squarely on it, however far the mirror is from what
     * was asked. */
    const aStart = A.cStart
    const aEnd = A.cStart + A.cSize
    const attached = (c: number): boolean => Math.abs(c - aStart) < 0.5 || Math.abs(c + S.c - aEnd) < 0.5
    const candidates: { c: number; a: Align; attached: boolean }[] = []
    const slid = Math.min(Math.max(wanted, cMin), cMax)
    if (touches(slid)) candidates.push({ c: slid, a: align, attached: attached(slid) })
    if (align !== 'center') {
      const mirror: Align = align === 'start' ? 'end' : 'start'
      const m = at(mirror)
      if (inside(m) && touches(m)) candidates.push({ c: m, a: mirror, attached: attached(m) })
    }
    if (candidates.length > 0) {
      candidates.sort((x, y) =>
        (Number(y.attached) - Number(x.attached)) || (Math.abs(x.c - wanted) - Math.abs(y.c - wanted)),
      )
      crossStart = candidates[0]!.c
      usedAlign = candidates[0]!.a
    } else {
      // Nothing touching fits: slide the request inside and say it was pushed.
      crossStart = slid
      if (fit === 'placed') fit = 'pinned'
    }
  }

  return vertical
    ? { top: mainStart, left: crossStart, side: usedSide, align: usedAlign, fit }
    : { top: crossStart, left: mainStart, side: usedSide, align: usedAlign, fit }
}

/**
 * One step of keeping a surface placed: from what was measured this frame,
 * what the placement should now be — and `null` when there is nothing to
 * hang from.
 *
 * Split out of `usePlacement` so the hook's DECISIONS are testable without a
 * DOM, which this project deliberately does not have in its test suite (see
 * `speech.test.ts` for why). The hook does the reading — `getBoundingClientRect`,
 * `innerWidth` — and hands the numbers here; everything that could be wrong
 * about what to do with them lives in a function that takes numbers.
 *
 * `null` for a missing anchor, deliberately, rather than the previous
 * placement: an anchor that has unmounted or scrolled out of a virtualised
 * list is not somewhere to keep drawing a menu.
 */
export function nextPlacement(
  measured: {
    readonly anchor: SpacedRect<'viewport'> | null
    readonly surface: { readonly width: number; readonly height: number } | null
    readonly bounds: SpacedRect<'viewport'>
    readonly avoid?: SpacedRect<'viewport'> | null
  },
  options: Omit<PlacementInput<'viewport'>, 'anchor' | 'surface' | 'bounds' | 'avoid'>,
): Placement | null {
  if (!measured.anchor) return null
  return place({
    /* Options FIRST, measurements after — so a structurally-assignable
     * options object cannot smuggle an `anchor` in over the one that was
     * measured. The `Omit` on the type says it should not; the spread order
     * is what makes it unable to. */
    ...options,
    anchor: measured.anchor,
    // Before the surface has rendered its size is unknown; place as if it were
    // a point and let the next measurement correct it.
    surface: measured.surface ?? { width: 0, height: 0 },
    bounds: measured.bounds,
    ...(measured.avoid ? { avoid: measured.avoid } : {}),
  })
}

/** Whether two placements are the same, so a hook can skip a re-render. */
export function samePlacement(a: Placement | null, b: Placement | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.left === b.left && a.side === b.side && a.align === b.align && a.fit === b.fit
}
