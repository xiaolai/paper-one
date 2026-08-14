import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppDispatch, AppState } from '../lib/state'
import { RULER_PIN } from '../lib/metrics'
import { hostFromBookRect, lineRectInBook, watchGeometry, type HostRect } from './coordinates'
import { placeBand, removeBand } from './rulerBand'
import styles from './ReadingRuler.module.css'

export interface ReadingRulerProps {
  state: AppState
  dispatch: AppDispatch
  /** The current spine item's document, or null while none is loaded. */
  doc: Document | null
  /** The prose grid, which is the coordinate space the HINT is drawn in. */
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
 * The band's position comes from a REAL line rect measured from the text, never
 * from `n × 34`: the handoff warns that headings, images, block quotes and
 * footnotes sit off-grid no matter what CSS is injected, so an assumed constant
 * step drifts as soon as the reader passes one.
 *
 * Two surfaces, two documents. The BAND is injected into the book so it can sit
 * at §12's layer 0, behind the text — see `rulerBand.ts`. The HINT stays in the
 * host's gutter at layer 8, because it is chrome beside the text rather than a
 * mark on it, and it has to be clickable where the book's iframe is not.
 */
export function ReadingRuler({ state, dispatch, doc, stage }: ReadingRulerProps) {
  /** The line, in the book's own viewport coordinates. */
  const [line, setLine] = useState<{ top: number; height: number } | null>(null)
  /** The same line in host space, for the hint. */
  const [hintAt, setHintAt] = useState<HostRect | null>(null)

  const active = state.rulerOn && state.pageLayout === 'scrolled'

  /* One measurement feeds both surfaces: the band is placed in the book's
   * document coordinates, and the hint gets the host translation of the very
   * same rect. Measuring twice would let the two drift apart by a frame. */
  const settle = useCallback(
    (rect: DOMRect, target: Document, host: HTMLElement) => {
      // Viewport coordinates throughout: `placeBand` converts into body's own
      // space, which is what stays put while the text scrolls under it.
      placeBand(target, rect.top, rect.height)
      const scrollY = target.defaultView?.scrollY ?? 0
      // The remembered line is in document space, so a re-measure after a
      // scroll can convert it back to a viewport point to probe with.
      setLine({ top: rect.top + scrollY, height: rect.height })
      setHintAt(hostFromBookRect(rect, target, host))
    },
    [],
  )

  /* Track the pointer over the book. The listener goes on the book document,
   * because the pointer is over an iframe and the host never sees the move. */
  useEffect(() => {
    if (!active || !doc || !stage) return

    const onMove = (event: MouseEvent) => {
      if (state.rulerPinned) return
      // The event is already in the book's viewport space, which is what
      // `lineRectInBook` wants — no round trip through the host needed.
      const rect = lineRectInBook(doc, event.clientX, event.clientY)
      // A miss leaves the band where it was rather than snapping it to the top
      // of the document, which reads as a glitch.
      if (rect) settle(rect, doc, stage)
    }

    doc.addEventListener('mousemove', onMove, { passive: true })
    return () => doc.removeEventListener('mousemove', onMove)
  }, [active, doc, stage, state.rulerPinned, settle])

  /* Re-measure whenever the geometry that produced the rect changes. The band
   * itself needs no repositioning on scroll — it is in document coordinates —
   * but the hint is in the host and does. */
  const lineRef = useRef(line)
  lineRef.current = line
  useEffect(() => {
    if (!active || !doc || !stage) return
    return watchGeometry(stage, doc, () => {
      const current = lineRef.current
      if (!current) return
      const scrollY = doc.defaultView?.scrollY ?? 0
      const rect = lineRectInBook(doc, 8, current.top - scrollY + current.height / 2)
      if (rect) settle(rect, doc, stage)
    })
  }, [active, doc, stage, settle])

  /* Take the band down when the ruler goes off, the layout goes paginated, or
   * the spine item changes. Leaving our furniture in the reader's own file
   * would show up in any selection that runs to the end of the document. */
  useEffect(() => {
    if (active) return
    removeBand(doc)
    setLine(null)
    setHintAt(null)
  }, [active, doc])

  useEffect(() => () => removeBand(doc), [doc])

  if (!active) return null

  const top = hintAt ? hintAt.bottom + 4 : RULER_PIN
  return (
    <div
      className={styles.hint}
      style={{ transform: `translateY(${top}px)` }}
      aria-hidden
      onClick={() => dispatch({ type: 'pinRuler' })}
    >
      Space advances a line
    </div>
  )
}
