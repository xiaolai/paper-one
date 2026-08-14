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
