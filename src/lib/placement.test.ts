import { describe, expect, it } from 'vitest'
import { place, type Rect } from './placement'

/* A 1440×900 window, and a 190×110 menu — the book cell's, at the sizes it
 * actually draws. Every case below is a place a reader can put the pointer. */
const bounds: Rect = { top: 0, left: 0, width: 1440, height: 900 }
const menu = { width: 190, height: 110 }

const anchorAt = (left: number, top: number, width = 24, height = 24): Rect => ({ top, left, width, height })

const inside = (p: { top: number; left: number }, edge = 8) =>
  p.left >= bounds.left + edge &&
  p.left + menu.width <= bounds.left + bounds.width - edge &&
  p.top >= bounds.top + edge &&
  p.top + menu.height <= bounds.top + bounds.height - edge

describe('place', () => {
  it('hangs below and starts at the anchor when there is room everywhere', () => {
    const p = place({ anchor: anchorAt(600, 300), surface: menu, bounds })
    expect(p.side).toBe('bottom')
    expect(p.align).toBe('start')
    expect(p.top).toBe(300 + 24 + 4)
    expect(p.left).toBe(600)
  })

  /* THE SCREENSHOT, TWICE. The first card's ellipsis sits 142px from the
   * window's left; a menu right-aligned to it would start at −24 and hang off
   * screen. The first fix SLID it to left=8 — on screen, but its right edge
   * then sat 32px past the button, under the next card, reading as that
   * card's menu. Being on screen is the lesser property; touching the thing
   * that opened it is the greater. So it FLIPS to `start` — the menu's left
   * edge on the button's left — which fits and stays attached. */
  it('flips to the mirror alignment rather than sliding off its anchor', () => {
    const anchor = anchorAt(142, 500)
    const p = place({ anchor, surface: menu, bounds, align: 'end' })
    expect(inside(p)).toBe(true)
    expect(p.align).toBe('start')
    expect(p.left).toBe(142)
    // Still touching: the menu's span covers the button's span.
    expect(p.left).toBeLessThanOrEqual(anchor.left)
    expect(p.left + menu.width).toBeGreaterThanOrEqual(anchor.left + anchor.width)
  })

  it('flips the other way at the right edge', () => {
    const anchor = anchorAt(1400, 500)
    const p = place({ anchor, surface: menu, bounds, align: 'start' })
    expect(inside(p)).toBe(true)
    expect(p.align).toBe('end')
    expect(p.left + menu.width).toBe(1400 + 24)
  })

  /* Only when NO anchored placement fits — the anchor is right at the edge —
   * does it slide, and then just far enough. */
  it('slides only as a last resort, when neither anchored alignment fits', () => {
    // 4px from the edge: `end` starts at −166, `start` at 4 — both under the
    // 8px edge clearance, so neither anchored placement fits.
    const p = place({ anchor: anchorAt(4, 500), surface: menu, bounds, align: 'end' })
    expect(inside(p)).toBe(true)
    expect(p.left).toBe(8)
  })

  /* The invariant that would have caught the slide-first bug: from ANY anchor
   * that has room for the menu on at least one side of it, the placed menu
   * overlaps the anchor horizontally. */
  it('stays in contact with its anchor whenever an anchored placement is possible', () => {
    for (let x = 30; x <= 1400; x += 17) {
      for (const align of ['start', 'center', 'end'] as const) {
        const anchor = anchorAt(x, 400)
        const p = place({ anchor, surface: menu, bounds, align })
        const overlaps = p.left < anchor.left + anchor.width && p.left + menu.width > anchor.left
        expect(overlaps).toBe(true)
      }
    }
  })

  it('keeps the requested alignment when sliding is not needed', () => {
    const p = place({ anchor: anchorAt(1000, 500), surface: menu, bounds, align: 'end' })
    expect(p.align).toBe('end')
    expect(p.left).toBe(1000 + 24 - 190)
  })

  it('flips above the anchor when there is no room below', () => {
    const p = place({ anchor: anchorAt(600, 860), surface: menu, bounds })
    expect(p.side).toBe('top')
    expect(inside(p)).toBe(true)
    expect(p.top).toBe(860 - 4 - 110)
  })

  it('flips below when asked for above and there is no room above', () => {
    const p = place({ anchor: anchorAt(600, 10), surface: menu, bounds, side: 'top' })
    expect(p.side).toBe('bottom')
    expect(inside(p)).toBe(true)
  })

  /* A window shorter than the menu on both sides — the case that used to be
   * "unreachable menu". Whichever side has more room, pinned inside. */
  it('pins inside the bounds when it fits on neither side', () => {
    const short: Rect = { top: 0, left: 0, width: 1440, height: 160 }
    const p = place({ anchor: anchorAt(600, 70), surface: menu, bounds: short })
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.top + menu.height).toBeLessThanOrEqual(160 - 8)
  })

  /* Wider than the window: the leading edge is pinned and the trailing end
   * overflows, so the first items stay reachable rather than losing both ends. */
  it('pins the leading edge when the surface is wider than the bounds', () => {
    const narrow: Rect = { top: 0, left: 0, width: 150, height: 900 }
    const p = place({ anchor: anchorAt(60, 300), surface: menu, bounds: narrow, align: 'center' })
    expect(p.left).toBe(8)
    expect(p.align).toBe('start')
  })

  it('centres when asked and there is room', () => {
    const p = place({ anchor: anchorAt(600, 300, 100, 24), surface: menu, bounds, align: 'center' })
    expect(p.left).toBe(600 + 50 - 95)
    expect(p.align).toBe('center')
  })

  /* Sweep every anchor position across the whole viewport: the surface must
   * end up on screen from every one of them, or the helper has a hole. */
  it('keeps the surface on screen from every anchor position', () => {
    for (let x = -10; x <= 1450; x += 37) {
      for (let y = -10; y <= 910; y += 41) {
        for (const align of ['start', 'center', 'end'] as const) {
          for (const side of ['top', 'bottom'] as const) {
            const p = place({ anchor: anchorAt(x, y), surface: menu, bounds, align, side })
            expect(inside(p)).toBe(true)
          }
        }
      }
    }
  })

  it('respects the bounds origin when the bounds are not at 0,0', () => {
    const offset: Rect = { top: 100, left: 200, width: 600, height: 400 }
    const p = place({ anchor: anchorAt(210, 110), surface: menu, bounds: offset, align: 'end' })
    expect(p.left).toBeGreaterThanOrEqual(200 + 8)
    expect(p.top).toBeGreaterThanOrEqual(100 + 8)
  })
})
