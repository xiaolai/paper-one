import { useLayoutEffect, useState, type RefObject } from 'react'
import { place, type Align, type Placement, type Side } from './placement'

/**
 * Keep a floating surface placed against its anchor, on screen.
 *
 * The DOM half of `place`: it reads the anchor's and the surface's rects,
 * asks the pure routine where the surface goes, and does it again whenever
 * anything under it moves — a scroll in any ancestor, a window resize, the
 * surface's own size changing as its content does. The caller renders the
 * surface `position: fixed` and spreads `style` onto it.
 *
 * TWO PASSES ON OPEN, and that is by design rather than by accident. The
 * surface's size is not known until it has rendered, and its position depends
 * on its size — so the first placement uses whatever the ref holds (nothing,
 * on the very first frame) and the layout effect re-runs once the surface has
 * a box. Both happen before paint; the reader sees one position.
 *
 * `null` while there is nothing to place. Render the surface only when this
 * is non-null, or it flashes at 0,0 for a frame.
 */
export function usePlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  options: { side?: Side; align?: Align; gap?: number; edge?: number } = {},
): { style: { top: number; left: number } | null; placement: Placement | null } {
  const [placement, setPlacement] = useState<Placement | null>(null)
  const { side, align, gap, edge } = options

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const compute = () => {
      const a = anchorRef.current?.getBoundingClientRect()
      if (!a) return
      const s = surfaceRef.current?.getBoundingClientRect()
      const next = place({
        anchor: { top: a.top, left: a.left, width: a.width, height: a.height },
        // Before the surface has rendered its size is unknown; place as if it
        // were a point and let the second pass correct it.
        surface: { width: s?.width ?? 0, height: s?.height ?? 0 },
        bounds: { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight },
        ...(side !== undefined ? { side } : {}),
        ...(align !== undefined ? { align } : {}),
        ...(gap !== undefined ? { gap } : {}),
        ...(edge !== undefined ? { edge } : {}),
      })
      // Only re-render when it actually moved, or a ResizeObserver on the
      // surface would loop through this forever.
      setPlacement((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.side === next.side && prev.align === next.align
          ? prev
          : next,
      )
    }
    compute()
    /* Capture-phase scroll, so a scroll in ANY ancestor is seen — the shelf
     * scrolls inside the window and a bubbling listener on `window` never
     * hears it. */
    document.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    const observer = new ResizeObserver(compute)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    return () => {
      document.removeEventListener('scroll', compute, true)
      window.removeEventListener('resize', compute)
      observer.disconnect()
    }
    // The refs are stable objects; what changes is `open` and the options.
  }, [open, anchorRef, surfaceRef, side, align, gap, edge])

  return { style: placement ? { top: placement.top, left: placement.left } : null, placement }
}
