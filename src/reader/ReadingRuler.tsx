import { useEffect, useState } from 'react'
import type { AppDispatch, AppState } from '../lib/state'
import { RULER_PIN } from '../lib/metrics'
import { lineRectAt, watchGeometry, type HostRect } from './coordinates'
import styles from './ReadingRuler.module.css'

export interface ReadingRulerProps {
  state: AppState
  dispatch: AppDispatch
  /** The current spine item's document, or null while none is loaded. */
  doc: Document | null
  /** The prose grid, which is the coordinate space the band is drawn in. */
  stage: HTMLElement | null
}

/**
 * The reading ruler.
 *
 * §06: it follows the pointer, and Space pins it and advances a line. It is
 * scrolled-flow only — in paginated mode there are no lines to advance, so the
 * control is hidden rather than disabled, which the reducer enforces by
 * clearing `rulerOn` when the layout changes.
 *
 * The band's position comes from a REAL line rect measured through the iframe
 * boundary, never from `n × 34`: the handoff warns that headings, images,
 * block quotes and footnotes sit off-grid no matter what CSS is injected, so
 * an assumed constant step drifts as soon as the reader passes one.
 */
export function ReadingRuler({ state, dispatch, doc, stage }: ReadingRulerProps) {
  const [line, setLine] = useState<HostRect | null>(null)

  const active = state.rulerOn && state.pageLayout === 'scrolled'

  /* Track the pointer over the book. The listener goes on the book document,
   * because the pointer is over an iframe and the host never sees the move. */
  useEffect(() => {
    if (!active || !doc || !stage) return

    const onMove = (event: MouseEvent) => {
      if (state.rulerPinned) return
      const frame = doc.defaultView?.frameElement as HTMLElement | null
      if (!frame) return
      const frameBox = frame.getBoundingClientRect()
      const stageBox = stage.getBoundingClientRect()
      // The event's coordinates are in the book's viewport; convert to host
      // space so `lineRectAt` can convert back with the same offset.
      const hostX = frameBox.left - stageBox.left + event.clientX
      const hostY = frameBox.top - stageBox.top + event.clientY
      const rect = lineRectAt(doc, stage, hostY, hostX)
      // A miss leaves the band where it was rather than snapping it to the top
      // of the document, which reads as a glitch.
      if (rect) setLine(rect)
    }

    doc.addEventListener('mousemove', onMove, { passive: true })
    return () => doc.removeEventListener('mousemove', onMove)
  }, [active, doc, stage, state.rulerPinned])

  /* Re-measure whenever the geometry that produced the rect changes. */
  useEffect(() => {
    if (!active || !doc || !stage || !line) return
    return watchGeometry(stage, doc, () => {
      const rect = lineRectAt(doc, stage, line.top + line.height / 2, line.left + 1)
      if (rect) setLine(rect)
    })
  }, [active, doc, stage, line])

  if (!active) return null

  const top = line ? line.top : RULER_PIN
  const height = line ? line.height : 34

  return (
    <>
      <div
        className={styles.band}
        style={{
          top: 0,
          height,
          transform: `translateY(${top}px)`,
          // The band spans the text column, not just the gutter it is
          // rendered into, so it is widened back out over the grid gap.
          width: 'calc(100% + var(--measure) + 32px)',
        }}
        aria-hidden
      />
      <div
        className={styles.hint}
        style={{ transform: `translateY(${top + height + 4}px)` }}
        aria-hidden
        onClick={() => dispatch({ type: 'pinRuler' })}
      >
        Space advances a line
      </div>
    </>
  )
}
