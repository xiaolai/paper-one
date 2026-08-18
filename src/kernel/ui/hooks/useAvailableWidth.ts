import { useEffect, useState } from 'react'

/**
 * Window width, tracked across resizes.
 *
 * §06 makes several layout decisions on available width — the pane collapses
 * under 1024px, the aside card goes under 880, PDF thumbnails under 900 — so
 * this is read by whichever screen needs it rather than each one attaching its
 * own listener.
 */
export function useAvailableWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    // The window can be resized between first render and this effect running.
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return width
}

/**
 * An element's own width, tracked as it changes.
 *
 * For layout that has to be right DURING an animation, not just after it. The
 * reader's track widths were computed from the window minus a constant for the
 * pane, chosen by whether the pane was open — but the pane's width is animated
 * over 220ms, so for the whole of that transition the arithmetic described a
 * layout that did not exist yet: closing the pane widened the tracks
 * immediately while the pane was still occupying its space, and the measure
 * was clipped until the animation caught up with the numbers.
 *
 * Measuring the element that actually holds the tracks cannot disagree with
 * the layout, because it IS the layout. Null until the element is attached, so
 * the caller can fall back for its first render.
 */
export function useElementWidth(element: Element | null): number | null {
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!element) {
      setWidth(null)
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      // `contentRect` is the content box — padding already excluded, which is
      // what the track arithmetic wants.
      const measured = entry?.contentRect.width
      if (typeof measured === 'number') setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return width
}
