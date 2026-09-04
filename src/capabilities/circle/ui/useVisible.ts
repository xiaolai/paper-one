import { useEffect, useState, type RefObject } from 'react'

/**
 * Whether an element has been on screen — once, and then for good.
 *
 * ⚠️ **A ROW DRAWN IS NOT A ROW SEEN.** A friend's shelf renders every row at
 * once, and a request made in each row's mount is a dial per book — hundreds
 * for a large shelf, most of them for pictures below the fold that nobody
 * scrolls to. Observed instead: a row asks when it first intersects the
 * viewport, and not before.
 *
 * Where there is no `IntersectionObserver` — a test's DOM, an old webview —
 * everything counts as visible at once, which is the old behaviour and
 * costs nothing but the dials it always cost.
 */
export function useVisible(ref: RefObject<Element | null>): boolean {
  const observable = typeof IntersectionObserver !== 'undefined'
  const [visible, setVisible] = useState(!observable)
  useEffect(() => {
    if (!observable || visible) return undefined
    const node = ref.current
    if (node === null) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((one) => one.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, observable, visible])
  return visible
}
