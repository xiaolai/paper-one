import { describe, expect, it } from 'vitest'
import { nextPlacement, place, samePlacement, type SpacedRect } from './placement'

/* A 1440×900 window, and a 190×110 menu — the book cell's, at the sizes it
 * actually draws. Every case below is a place a reader can put the pointer. */
const V = 'viewport' as const
const bounds: SpacedRect<'viewport'> = { top: 0, left: 0, width: 1440, height: 900, space: V }
const menu = { width: 190, height: 110 }

const anchorAt = (left: number, top: number, width = 24, height = 24): SpacedRect<'viewport'> =>
  ({ top, left, width, height, space: V })

const inside = (p: { top: number; left: number }, b = bounds, s = menu, edge = 8) =>
  p.left >= b.left + edge &&
  p.left + s.width <= b.left + b.width - edge &&
  p.top >= b.top + edge &&
  p.top + s.height <= b.top + b.height - edge

/** Full 2-D overlap — for "did it cover the thing it must not cover". */
const overlaps = (p: { top: number; left: number }, s: { width: number; height: number }, r: SpacedRect) =>
  p.left < r.left + r.width && p.left + s.width > r.left && p.top < r.top + r.height && p.top + s.height > r.top

/** Cross-axis contact only — a surface hanging BELOW its anchor still touches
 *  it along x. This is what "attached" means for a menu. */
const touchesX = (p: { left: number }, s: { width: number }, r: SpacedRect) =>
  p.left < r.left + r.width && p.left + s.width > r.left

describe('place — the ordinary cases', () => {
  it('hangs below and starts at the anchor when there is room everywhere', () => {
    const p = place({ anchor: anchorAt(600, 300), surface: menu, bounds })
    expect(p).toMatchObject({ side: 'bottom', align: 'start', fit: 'placed', top: 300 + 24 + 4, left: 600 })
  })

  it('keeps the requested alignment when nothing is in the way', () => {
    const p = place({ anchor: anchorAt(1000, 500), surface: menu, bounds, align: 'end' })
    expect(p.align).toBe('end')
    expect(p.left).toBe(1000 + 24 - 190)
  })

  it('centres when asked and there is room', () => {
    const p = place({ anchor: anchorAt(600, 300, 100, 24), surface: menu, bounds, align: 'center' })
    expect(p.left).toBe(600 + 50 - 95)
    expect(p.align).toBe('center')
  })

  it('flips above the anchor when there is no room below', () => {
    const p = place({ anchor: anchorAt(600, 860), surface: menu, bounds })
    expect(p.side).toBe('top')
    expect(p.fit).toBe('placed')
    expect(inside(p)).toBe(true)
    expect(p.top).toBe(860 - 4 - 110)
  })

  it('flips below when asked for above and there is no room above', () => {
    const p = place({ anchor: anchorAt(600, 10), surface: menu, bounds, side: 'top' })
    expect(p.side).toBe('bottom')
    expect(inside(p)).toBe(true)
  })
})

describe('place — the cross axis keeps contact', () => {
  /* THE SCREENSHOT. The first card's ellipsis sits 142px from the window's
   * left; a menu right-aligned to it would start at −24. Sliding it to left=8
   * put its right edge 32px past the button, under the next card. Mirroring
   * to `start` moves it 0px from the anchor's own edge and stays attached. */
  it('mirrors rather than slides when the mirror moves less', () => {
    const anchor = anchorAt(142, 500)
    const p = place({ anchor, surface: menu, bounds, align: 'end' })
    expect(inside(p)).toBe(true)
    expect(p.align).toBe('start')
    expect(p.left).toBe(142)
    expect(p.fit).toBe('placed')
  })

  /* CODEX #6, and the objection was WRONG — recorded because it is the kind
   * of wrong that sounds right. A titlebar dropdown 18px shy of the right
   * edge: the objection said slide 18px rather than "mirror 166px". But that
   * 166 measures distance from the REQUEST, and the reader never sees the
   * request; they see the result. Slid, the menu spans 162..352 against a
   * button at 180..204 — it juts 18px left of the button and 148px right of
   * it, centred on nothing. Mirrored, it spans 14..204: its right edge on the
   * button's right, which is exactly the right-aligned dropdown every menu
   * near a right edge becomes. Attachment outranks distance. */
  it('mirrors to stay on the anchor\'s edge rather than sliding past it', () => {
    const narrow: SpacedRect<'viewport'> = { top: 0, left: 0, width: 360, height: 600, space: V }
    const anchor = anchorAt(180, 100)
    const p = place({ anchor, surface: { width: 190, height: 50 }, bounds: narrow, align: 'start' })
    expect(p.align).toBe('end')
    expect(p.left + 190).toBe(180 + 24) // right edge on the button's right
    expect(p.fit).toBe('placed')
  })

  /* And a slide DOES win when the mirror is no better attached. An anchor
   * so wide that neither its `start` nor its `end` position fits: both
   * candidates are slid-or-partial, neither has an edge on an anchor edge, and
   * distance from the request decides — the slid `start`, which moved least. */
  it('slides when the mirror is no better attached', () => {
    const narrow: SpacedRect<'viewport'> = { top: 0, left: 0, width: 360, height: 600, space: V }
    // Anchor 20..340 (320 wide) in 360: `start` at 20 puts a 190 surface at
    // 20..210, which fits — so widen the surface instead: 300 wide. `start`
    // 20..320 fits (max left 52)? 20 <= 52 yes. Make it 340 wide: max left is
    // 12; `start` wants 20 -> overflow, slid to 12; `end` wants 340-340=0 ->
    // overflow, not inside. Only the slid start survives.
    const anchor = anchorAt(20, 100, 320, 24)
    const p = place({ anchor, surface: { width: 340, height: 50 }, bounds: narrow, align: 'start' })
    expect(p.left).toBe(12)
    expect(p.align).toBe('start')
    expect(p.fit).toBe('placed')
    expect(touchesX(p, { width: 340 }, anchor)).toBe(true)
  })

  it('slides `center` rather than snapping it to an edge', () => {
    const p = place({ anchor: anchorAt(20, 300, 60, 22), surface: { width: 200, height: 40 }, bounds, align: 'center' })
    expect(p.align).toBe('center')
    expect(p.left).toBe(8)
  })

  /* CODEX #2. A slid surface used to report `align: 'start'` when it was not
   * at start. It reports the request; the position says how far it slid. */
  it('reports the requested alignment when it merely slid', () => {
    const p = place({ anchor: anchorAt(4, 100), surface: menu, bounds, align: 'end' })
    expect(p.left).toBe(8)
    expect(p.align).toBe('end')
  })

  it('stays in contact with its anchor from every position where that is possible', () => {
    for (let x = 30; x <= 1400; x += 17) {
      for (const align of ['start', 'center', 'end'] as const) {
        const anchor = anchorAt(x, 400)
        const p = place({ anchor, surface: menu, bounds, align })
        expect(touchesX(p, menu, anchor)).toBe(true)
        expect(p.fit).toBe('placed')
      }
    }
  })
})

describe('place — overlayOnFlip', () => {
  /* THE SCREENSHOT, again. Moby-Dick on the last row: no room below, so the
   * menu flips up — and clear of a 225px card it leapt the whole card and
   * covered the neighbour above. Overlaid, it drapes over its own jacket. */
  it('drapes over its own tall anchor when flipping, rather than leaping it', () => {
    const win: SpacedRect<'viewport'> = { top: 0, left: 0, width: 879, height: 657, space: V }
    const card = { top: 404, left: 40, width: 126, height: 225, space: V }
    const m = { width: 190, height: 98 }
    const clear = place({ anchor: card, surface: m, bounds: win, side: 'bottom', align: 'end' })
    const draped = place({ anchor: card, surface: m, bounds: win, side: 'bottom', align: 'end', overlayOnFlip: true })
    expect(clear.side).toBe('top')
    expect(clear.top).toBeLessThan(376) // over the row above
    expect(draped.side).toBe('top')
    expect(draped.top + m.height).toBe(404 + 225)
    expect(draped.top).toBeGreaterThanOrEqual(404)
    expect(draped.fit).toBe('placed')
  })

  it('does not overlay when not asked to', () => {
    const win: SpacedRect<'viewport'> = { top: 0, left: 0, width: 879, height: 657, space: V }
    const line = { top: 600, left: 40, width: 300, height: 22, space: V }
    const p = place({ anchor: line, surface: { width: 200, height: 40 }, bounds: win, side: 'top', align: 'center' })
    expect(p.top + 40).toBeLessThanOrEqual(600)
  })
})

describe('place — honesty when it cannot do what was asked', () => {
  /* CODEX #1 / #18. Neither side fits and overlay is off: it pins, and it
   * used to report `side: 'top'` while sitting ON the anchor. Now `fit` says
   * pinned, and the test checks the overlap the old test never did. */
  it('says `pinned` when it had to cover the anchor to stay on screen', () => {
    const short: SpacedRect<'viewport'> = { top: 0, left: 0, width: 1440, height: 160, space: V }
    const anchor = anchorAt(600, 70)
    const p = place({ anchor, surface: menu, bounds: short })
    expect(inside(p, short)).toBe(true)
    expect(p.fit).toBe('pinned')
    expect(overlaps(p, menu, anchor)).toBe(true) // and it admits it
  })

  /* CODEX #5. An anchor wholly off screen: the surface is placed inside the
   * bounds so a caller that insists gets something sane, but told it has
   * nothing to hang from. */
  it('says `detached` when the anchor is off screen', () => {
    const p = place({ anchor: anchorAt(50, 900, 20, 20), surface: { width: 100, height: 50 }, bounds })
    expect(p.fit).toBe('detached')
    expect(inside(p, bounds, { width: 100, height: 50 })).toBe(true)
  })

  /* CODEX #3. Wider and taller than the bounds: leading edges pinned so the
   * first items stay reachable, and `pinned` rather than a nominal success. */
  it('pins the leading edges of an oversized surface and says so', () => {
    const tiny: SpacedRect<'viewport'> = { top: 0, left: 0, width: 100, height: 100, space: V }
    const p = place({ anchor: anchorAt(40, 40, 20, 20), surface: { width: 120, height: 120 }, bounds: tiny })
    expect(p.top).toBe(8)
    expect(p.left).toBe(8)
    expect(p.fit).toBe('pinned')
  })

  it('pins the leading edge when the surface is wider than the bounds', () => {
    const narrow: SpacedRect<'viewport'> = { top: 0, left: 0, width: 150, height: 900, space: V }
    const p = place({ anchor: anchorAt(60, 300), surface: menu, bounds: narrow, align: 'center' })
    expect(p.left).toBe(8)
    expect(p.fit).toBe('pinned')
  })

  /* CODEX #4. Bad geometry is refused at the boundary, not turned into a
   * placement that overlaps its anchor and looks intentional. */
  it('throws on a negative size or a negative gap', () => {
    expect(() => place({ anchor: { ...anchorAt(100, 100), height: -20 }, surface: { width: 50, height: 30 }, bounds })).toThrow(RangeError)
    expect(() => place({ anchor: anchorAt(100, 100), surface: { width: 50, height: 30 }, bounds, gap: -10 })).toThrow(RangeError)
    expect(() => place({ anchor: anchorAt(100, 100), surface: { width: -1, height: 30 }, bounds })).toThrow(RangeError)
    expect(() => place({ anchor: { ...anchorAt(100, 100), top: NaN }, surface: { width: 50, height: 30 }, bounds })).toThrow(RangeError)
  })
})

describe('place — avoid', () => {
  /* CODEX #7. A toolbar hung from the first line of a three-line selection
   * covered lines two and three — the words the reader had just chosen. With
   * the whole selection as `avoid`, it stays clear of all of it. */
  it('stays clear of `avoid` as well as the anchor', () => {
    const b: SpacedRect<'viewport'> = { top: 0, left: 0, width: 400, height: 400, space: V }
    const firstLine = { top: 50, left: 100, width: 100, height: 20, space: V }
    const selection = { top: 50, left: 100, width: 100, height: 80, space: V }
    const toolbar = { width: 200, height: 40 }
    const without = place({ anchor: firstLine, surface: toolbar, bounds: b, side: 'top', align: 'center' })
    const withAvoid = place({ anchor: firstLine, surface: toolbar, bounds: b, side: 'top', align: 'center', avoid: selection })
    expect(overlaps(without, toolbar, selection)).toBe(true) // the old defect
    expect(overlaps(withAvoid, toolbar, selection)).toBe(false)
    expect(withAvoid.top).toBeGreaterThanOrEqual(50 + 80 + 4)
  })
})

describe('place — four sides', () => {
  /* CODEX #8. A tooltip to the right of a button, and to the left when there
   * is no room. */
  it('places to the right, and flips left at the edge', () => {
    const tip = { width: 120, height: 30 }
    const r = place({ anchor: anchorAt(100, 300), surface: tip, bounds, side: 'right' })
    expect(r.side).toBe('right')
    expect(r.left).toBe(100 + 24 + 4)
    const l = place({ anchor: anchorAt(1400, 300), surface: tip, bounds, side: 'right' })
    expect(l.side).toBe('left')
    expect(l.left + tip.width).toBe(1400 - 4)
    expect(inside(l, bounds, tip)).toBe(true)
  })

  it('aligns along the cross axis for a horizontal side too', () => {
    const tip = { width: 120, height: 30 }
    const p = place({ anchor: anchorAt(100, 300, 24, 24), surface: tip, bounds, side: 'right', align: 'center' })
    expect(p.top).toBe(300 + 12 - 15)
  })
})

describe('place — every anchor, every option, always on screen', () => {
  it('keeps the surface inside the bounds from every anchor position', () => {
    for (let x = -10; x <= 1450; x += 37) {
      for (let y = -10; y <= 910; y += 41) {
        for (const align of ['start', 'center', 'end'] as const) {
          for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            for (const overlayOnFlip of [false, true]) {
              const p = place({ anchor: anchorAt(x, y), surface: menu, bounds, align, side, overlayOnFlip })
              expect(inside(p)).toBe(true)
            }
          }
        }
      }
    }
  })

  it('respects the bounds origin when the bounds are not at 0,0', () => {
    const offset: SpacedRect<'viewport'> = { top: 100, left: 200, width: 600, height: 400, space: V }
    const p = place({ anchor: anchorAt(210, 110), surface: menu, bounds: offset, align: 'end' })
    expect(p.left).toBeGreaterThanOrEqual(200 + 8)
    expect(p.top).toBeGreaterThanOrEqual(100 + 8)
  })
})

/* The hook's DECISIONS, without a DOM. `usePlacement` reads rects and hands
 * them to `nextPlacement`; this is where what it does with them is pinned. */
describe('nextPlacement — what the hook decides from what it measured', () => {
  const win: SpacedRect<'viewport'> = { top: 0, left: 0, width: 1440, height: 900, space: V }

  /* CODEX #14. The anchor unmounted while the surface was open. The old hook
   * returned early and KEPT the last placement, so a menu floated where a card
   * used to be. */
  it('returns null when the anchor is gone, rather than the last placement', () => {
    expect(nextPlacement({ anchor: null, surface: menu, bounds: win }, {})).toBeNull()
  })

  /* CODEX #12. First frame: the surface has no box yet. It is placed as a
   * point, and the second measurement — with a real size — moves it. Both
   * happen before paint. */
  it('places a point on the first pass and corrects it once the surface has a size', () => {
    const anchor = anchorAt(600, 820)
    const first = nextPlacement({ anchor, surface: null, bounds: win }, { side: 'bottom' })
    const second = nextPlacement({ anchor, surface: menu, bounds: win }, { side: 'bottom' })
    expect(first?.side).toBe('bottom') // a zero-height surface always fits below
    expect(second?.side).toBe('top') // a 110px one does not, at y=820
    expect(samePlacement(first, second)).toBe(false) // so the hook re-renders
  })

  /* CODEX #11. The ANCHOR grew — a card gained a tag row — and the surface did
   * not. The hook now observes the anchor too; here is that this matters. */
  it('moves when only the anchor changed size', () => {
    const before = nextPlacement({ anchor: anchorAt(600, 100, 24, 20), surface: menu, bounds: win }, {})
    const after = nextPlacement({ anchor: anchorAt(600, 100, 24, 80), surface: menu, bounds: win }, {})
    expect(before?.top).toBe(100 + 20 + 4)
    expect(after?.top).toBe(100 + 80 + 4)
    expect(samePlacement(before, after)).toBe(false)
  })

  /* CODEX #17. Bounds are whatever the caller passes — a pane's box, not the
   * viewport — so a popover inside a scrolling pane can be kept inside it. */
  it('respects caller-supplied bounds smaller than the viewport', () => {
    const pane: SpacedRect<'viewport'> = { top: 200, left: 1000, width: 400, height: 300, space: V }
    const p = nextPlacement({ anchor: anchorAt(1010, 450), surface: menu, bounds: pane }, { side: 'bottom' })
    expect(p?.side).toBe('top') // 450+24+4+110 > 500: no room below in the pane
    expect(p!.top + menu.height).toBeLessThanOrEqual(200 + 300 - 8)
  })

  it('samePlacement is what lets the hook skip a re-render on a no-op measurement', () => {
    const a = nextPlacement({ anchor: anchorAt(600, 300), surface: menu, bounds: win }, {})
    const b = nextPlacement({ anchor: anchorAt(600, 300), surface: menu, bounds: win }, {})
    expect(samePlacement(a, b)).toBe(true)
    expect(samePlacement(a, null)).toBe(false)
    expect(samePlacement(null, null)).toBe(true)
  })
})
