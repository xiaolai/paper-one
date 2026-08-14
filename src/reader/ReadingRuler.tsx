import { useCallback, useEffect, useRef, useState } from 'react'
import { hasOpenLayer, type AppDispatch, type AppState } from '../lib/state'
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
/**
 * Find the line box at a vertical position, trying several x offsets.
 *
 * One probe is not enough. foliate centres the measure inside the book's
 * viewport, so a fixed x near the left edge — 8px, as this used to use — lands
 * in the page margin on every book wide enough to have one, where there is no
 * text and no line to find. Then the re-measure after a scroll or a resize
 * silently gives up and the band stays where it was. Fractions of the viewport
 * width rather than absolute offsets, because the measure moves with the
 * window; the centre first, since that is inside the text for any layout.
 */
const PROBE_X = [0.5, 0.35, 0.65, 0.2, 0.8]

/**
 * The x that last found text, per document.
 *
 * Tried before the fractions. A short line — a chapter opener, the last line of
 * a paragraph, a line of dialogue — occupies only the start of the measure, so
 * a centre probe misses it and the fixed fractions can all miss a line that IS
 * there. The x the pointer or the previous line succeeded at is the best
 * available guess about where this book puts its text.
 */
const lastGoodX = new WeakMap<Document, number>()

function probeLine(doc: Document, viewportY: number): DOMRect | null {
  const width = doc.defaultView?.innerWidth ?? 0
  const remembered = lastGoodX.get(doc)
  const candidates = remembered === undefined ? [] : [remembered]
  for (const fraction of PROBE_X) candidates.push(width * fraction)

  for (const x of candidates) {
    const rect = lineRectInBook(doc, x, viewportY)
    if (rect) {
      // The middle of what was found, which is inside the text by construction.
      lastGoodX.set(doc, rect.left + rect.width / 2)
      return rect
    }
  }
  return null
}

export function ReadingRuler({ state, dispatch, doc, stage }: ReadingRulerProps) {
  /** The line, in the book's own viewport coordinates. */
  const [line, setLine] = useState<{ top: number; height: number } | null>(null)
  /** The same line in host space, for the hint. */
  const [hintAt, setHintAt] = useState<HostRect | null>(null)
  /** The gutter lane, read back from the hint's own offset parent. */
  const hintRef = useRef<HTMLDivElement | null>(null)

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

      /* Translated into the stage's space, then rebased onto the hint's own
       * offset parent — the gutter lane, which starts below the stage's top
       * padding. Left in stage coordinates the hint carries that padding twice
       * and sits a line lower than the band it is labelling. Measured rather
       * than subtracted as a constant, so it cannot drift from the stylesheet. */
      const translated = hostFromBookRect(rect, target, host)
      const lane = hintRef.current?.offsetParent
      if (!translated || !(lane instanceof HTMLElement)) {
        setHintAt(translated)
        return
      }
      const dy = lane.getBoundingClientRect().top - host.getBoundingClientRect().top
      setHintAt({ ...translated, top: translated.top - dy, bottom: translated.bottom - dy })
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
      if (rect) {
        // Where the reader's pointer found text is the best hint for the
        // keyboard probes that follow — see `lastGoodX`.
        lastGoodX.set(doc, event.clientX)
        settle(rect, doc, stage)
      }
    }

    doc.addEventListener('mousemove', onMove, { passive: true })
    return () => doc.removeEventListener('mousemove', onMove)
  }, [active, doc, stage, state.rulerPinned, settle])

  /* Re-measure whenever the geometry that produced the rect changes. The band
   * itself needs no repositioning on scroll — it is in document coordinates —
   * but the hint is in the host and does. */
  const lineRef = useRef(line)
  lineRef.current = line

  /* §06's other half: Space pins the ruler and advances it a line.
   *
   * The hint says so on screen, and nothing implemented it — pinning merely
   * froze the band under the pointer until the ruler was switched off, so the
   * keyboard path through a chapter did not exist. It has to be a real probe of
   * the next line rather than `top + 34`, for the reason the header gives: a
   * block quote or a figure caption is not on the injected grid, and stepping
   * by a constant walks off the text within a page.
   *
   * A window listener rather than one on the book: `ReaderSession` forwards the
   * book's keydowns to the host precisely so a single binding covers both
   * documents. */
  useEffect(() => {
    if (!active || !doc || !stage) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' && event.code !== 'Space') return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      /* Not while typing, and not under an overlay — Space is the space bar in
       * a note and the activation key on a focused button, and swallowing it
       * for the ruler would break both. */
      const target = event.target as HTMLElement | null
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA'
      ) {
        return
      }
      /* Not while the reader is COVERED. It stays mounted under the library so
       * foliate is not torn down and the position survives — which means this
       * listener is still on the window, and Space browsing the shelf was
       * advancing a ruler nobody could see, in a book the reader had navigated
       * away from. The app's own keymap guards its reading keys the same way. */
      if (state.screen !== 'reader') return
      if (hasOpenLayer(state)) return

      // Space scrolls the page by default, which would move the text out from
      // under the band it is meant to be advancing along.
      event.preventDefault()
      if (!state.rulerPinned) dispatch({ type: 'pinRuler' })

      const current = lineRef.current
      const view = doc.defaultView
      if (!current || !view) return

      /* Probe DOWNWARD from the bottom of the current line until a different
       * line answers. A single probe one pixel below can land in the leading
       * between lines, where there is no text and `lineRectInBook` returns
       * null; stepping in small increments finds the next line whatever the
       * spacing is, and gives up rather than searching the whole document. */
      const viewportTop = current.top - view.scrollY
      let next: DOMRect | null = null
      for (let dy = 1; dy <= current.height * 3; dy += 2) {
        const probe = probeLine(doc, viewportTop + current.height + dy)
        if (probe && probe.top > viewportTop + 1) {
          next = probe
          break
        }
      }
      if (!next) return

      /* Keep the advancing line on screen. In scrolled flow the band walks to
       * the bottom of the viewport and then stops being visible, which looks
       * exactly like Space having no effect. */
      const margin = current.height * 2
      const overshoot = next.bottom - (view.innerHeight - margin)
      if (overshoot > 0) {
        view.scrollBy({ top: overshoot })
        // Re-probe rather than adjusting the rect by hand: the scroll may have
        // been clamped at the end of the document, and a rect assumed to have
        // moved by the full amount would put the band below its own line.
        const settled = probeLine(doc, next.top + next.height / 2 - overshoot)
        settle(settled ?? next, doc, stage)
        return
      }
      settle(next, doc, stage)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    active,
    doc,
    stage,
    dispatch,
    settle,
    state.rulerPinned,
    state.screen,
    state.paletteOpen,
    state.switcherOpen,
  ])

  useEffect(() => {
    if (!active || !doc || !stage) return
    return watchGeometry(stage, doc, () => {
      const current = lineRef.current
      if (!current) return
      const view = doc.defaultView
      const scrollY = view?.scrollY ?? 0
      const viewportY = current.top - scrollY + current.height / 2
      /* Off screen: the reader has scrolled past the line the band is on. The
       * band itself is in document coordinates and stays with its text, but the
       * hint is host chrome and would otherwise sit at the old position,
       * labelling a line that is no longer there. */
      if (view && (viewportY < 0 || viewportY > view.innerHeight)) {
        setHintAt(null)
        return
      }
      const rect = probeLine(doc, viewportY)
      // A miss means the probe found no text at that height — a figure has
      // reflowed into the position, say. Withhold the hint rather than leaving
      // it pointing at something that has moved.
      if (rect) settle(rect, doc, stage)
      else setHintAt(null)
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

  /* The same reset when the SPINE ITEM changes with the ruler still on. The
   * remembered line is a coordinate in the document that has just gone; carried
   * into the next chapter it places the band at an arbitrary height in text it
   * was never measured against. */
  useEffect(() => {
    setLine(null)
    setHintAt(null)
  }, [doc])

  useEffect(() => () => removeBand(doc), [doc])

  if (!active) return null

  const top = hintAt ? hintAt.bottom + 4 : RULER_PIN
  return (
    <div
      ref={hintRef}
      className={styles.hint}
      style={{ transform: `translateY(${top}px)` }}
      aria-hidden
      onClick={() => dispatch({ type: 'pinRuler' })}
    >
      Space advances a line
    </div>
  )
}
