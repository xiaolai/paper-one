import { useLayoutEffect, useState, type RefObject } from 'react'
import { nextPlacement, samePlacement, type Align, type Placement, type Side, type SpacedRect } from './placement'

export interface PlacementOptions {
  side?: Side
  align?: Align
  gap?: number
  edge?: number
  overlayOnFlip?: boolean
  /**
   * What the surface must stay inside. Defaults to the viewport. Pass an
   * element to constrain to it — a popover inside a scrolling pane should not
   * be allowed to hang out of the pane just because the window is taller.
   */
  within?: RefObject<HTMLElement | null>
  /** Something else to stay clear of, measured live — see `PlacementInput.avoid`. */
  avoid?: RefObject<HTMLElement | null>
}

export interface PlacementResult {
  /** `top`/`left` for a `position: fixed` surface, or null while nothing is placed. */
  style: { top: number; left: number } | null
  placement: Placement | null
}

/**
 * Keep a floating surface placed against its anchor, on screen.
 *
 * The DOM half of `place`: it reads the anchor's and the surface's rects,
 * asks the pure routine where the surface goes, and does it again whenever
 * anything under it moves — a scroll in any ancestor, a window resize, the
 * ANCHOR's own size changing (a card growing a tag row), the surface's own
 * size changing as its content does. The first version observed only the
 * surface, so a menu on a card that grew stayed where the card used to end.
 *
 * `position: fixed`, and the caller must render the surface where `fixed`
 * means the viewport — that is, NOT under a transformed ancestor, where a
 * fixed element's containing block is the transform and every number here is
 * off by that transform's offset. Portal it to `document.body` if in doubt.
 * The hook cannot detect this for you; it is stated here because it is the
 * one way to get a wrong answer out of correct arithmetic.
 *
 * TWO PASSES ON OPEN, and that is by design. The surface's size is not known
 * until it has rendered, and its position depends on its size — so the first
 * placement uses a zero-size surface, and the layout effect re-runs once the
 * surface has a box. Both happen before paint; the reader sees one position.
 * For that to work the surface MUST be in the DOM from the first frame: render
 * it while `open` and park it off screen (`top: -9999`) until `style` is
 * non-null. Rendering it only once placed means it is never measured and the
 * second pass never comes — the previous version of this comment advised
 * exactly that, and it was wrong.
 */
export function usePlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  options: PlacementOptions = {},
): PlacementResult {
  const [placement, setPlacement] = useState<Placement | null>(null)
  const { side, align, gap, edge, overlayOnFlip, within, avoid } = options

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const rectOf = (el: Element): SpacedRect<'viewport'> => {
      const r = el.getBoundingClientRect()
      return { top: r.top, left: r.left, width: r.width, height: r.height, space: 'viewport' }
    }
    const compute = () => {
      const anchorEl = anchorRef.current
      const surfaceEl = surfaceRef.current
      const boundsEl = within?.current
      const avoidEl = avoid?.current
      /* Read the DOM here and only here; the decision is `nextPlacement`, which
       * takes numbers and is tested without a document. */
      const next = nextPlacement(
        {
          anchor: anchorEl ? rectOf(anchorEl) : null,
          surface: surfaceEl ? rectOf(surfaceEl) : null,
          bounds: boundsEl
            ? rectOf(boundsEl)
            : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight, space: 'viewport' },
          avoid: avoidEl ? rectOf(avoidEl) : null,
        },
        {
          ...(side !== undefined ? { side } : {}),
          ...(align !== undefined ? { align } : {}),
          ...(gap !== undefined ? { gap } : {}),
          ...(edge !== undefined ? { edge } : {}),
          ...(overlayOnFlip !== undefined ? { overlayOnFlip } : {}),
        },
      )
      // Only re-render when it actually moved, or the observers below would
      // loop through this forever.
      setPlacement((prev) => (samePlacement(prev, next) ? prev : next))
    }
    compute()
    /* Capture-phase scroll, so a scroll in ANY ancestor is seen — the shelf
     * scrolls inside the window and a bubbling listener on `window` never
     * hears it. */
    document.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    const observer = new ResizeObserver(compute)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    if (anchorRef.current) observer.observe(anchorRef.current)
    if (within?.current) observer.observe(within.current)
    if (avoid?.current) observer.observe(avoid.current)
    return () => {
      document.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
      observer.disconnect()
    }
    // The refs are stable objects; what changes is `open` and the options.
  }, [open, anchorRef, surfaceRef, side, align, gap, edge, overlayOnFlip, within, avoid])

  return { style: placement ? { top: placement.top, left: placement.left } : null, placement }
}
