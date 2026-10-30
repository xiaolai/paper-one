import { useCallback, useEffect, useRef, useState } from 'react'
import { OverlaySheet } from '../overlays/OverlaySheet'
import type { PlateDetail } from './plate'
import styles from './PlateViewer.module.css'

/**
 * A plate, shown as large as the window allows.
 *
 * WHY THIS EXISTS. Measured over the real shelf: 63 % of 1 959 books carry ten
 * or more images and 37 % carry fifty or more, and until now touching one did
 * nothing at all. A circuit diagram or a map at body-text column width is not
 * readable, and enlarging it is the one gesture every reader on every platform
 * has.
 *
 * ⚠️ **THE MODAL CONTRACT IS `OverlaySheet`'s, NOT THIS FILE'S.** The focus
 * trap, `aria-modal`, Esc, the primary-button-only scrim and making the page
 * behind genuinely inert are all solved there and are the same for a plate as
 * for a list. Reimplementing them here would be a second answer to one
 * question — the shape this repository keeps having to delete — so this adds
 * only what a plate needs that a card does not: the `plate` variant, and the
 * zoom.
 */
export interface PlateViewerProps {
  /** The plate to show, or null to show nothing. */
  readonly plate: PlateDetail | null
  readonly onClose: () => void
}

/** How far in a double-click or a wheel gesture may go. */
const MAX_ZOOM = 6

/**
 * Keep the plate reachable.
 *
 * ⚠️ **AN UNBOUNDED PAN LOSES THE PLATE AND THE ONLY CONTROLS THAT COULD
 * BRING IT BACK.** The drag and zoom handlers are on the image itself, so once
 * it has been dragged off the stage there is nothing left to grab: the reader
 * has to close the viewer and open it again. The offset is therefore clamped
 * to the overhang — how far the scaled plate sticks out past the stage — which
 * is 0 while it fits, so a fitted plate cannot move at all.
 */
export function clampPan(
  pan: { readonly x: number; readonly y: number },
  zoom: number,
  stage: { readonly width: number; readonly height: number },
  plate: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  const overhangX = Math.max(0, (plate.width * zoom - stage.width) / 2)
  const overhangY = Math.max(0, (plate.height * zoom - stage.height) / 2)
  /* `Math.max(-0, -90)` is `-0`, and a clamp that answers negative zero for
     "no movement" is a value two comparisons disagree about: `-0 === 0` but
     `Object.is(-0, 0)` is false, and a test asserting `{x: 0, y: 0}` fails
     against it. Normalised here rather than at every reader. */
  const zeroed = (n: number): number => (n === 0 ? 0 : n)
  return {
    x: zeroed(Math.min(overhangX, Math.max(-overhangX, pan.x))),
    y: zeroed(Math.min(overhangY, Math.max(-overhangY, pan.y))),
  }
}
/** Below this the plate is "fitted" and panning is meaningless. */
const FIT = 1

export function PlateViewer({ plate, onClose }: PlateViewerProps) {
  const [zoom, setZoom] = useState(FIT)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  /* The wheel listener is native and bound once per plate, so it cannot close
     over `zoom` — it would read the value from the render that bound it. */
  const zoomRef = useRef(FIT)
  zoomRef.current = zoom
  const from = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null)

  /* A NEW PLATE IS A NEW VIEW. Without this, opening a second figure inherits
     the first one's zoom and offset, so it opens scrolled to a corner of an
     image the reader has not seen yet. Keyed on `src`, which is the identity
     of the thing being shown. */
  useEffect(() => {
    setZoom(FIT)
    setPan({ x: 0, y: 0 })
    setDragging(false)
    from.current = null
  }, [plate?.src])

  /* The live geometry the clamp needs. Read from the DOM rather than held in
     state: the stage resizes with the window and the plate's fitted size is
     whatever `max-width/max-height` resolved to. */
  const boxes = () => {
    const img = stage.current
    const host = img?.parentElement
    if (!img || !host) return null
    return {
      stage: { width: host.clientWidth, height: host.clientHeight },
      plate: { width: img.clientWidth, height: img.clientHeight },
    }
  }

  const settle = (next: { x: number; y: number }, at: number) => {
    const box = boxes()
    return box ? clampPan(next, at, box.stage, box.plate) : next
  }

  const zoomed = zoom > FIT

  /* ONE PLACE THAT CHANGES THE ZOOM, so the pan can never be left stranded by
     one route and settled by another. Reaching FIT recentres outright: at
     fitted size the whole plate is on screen and any offset is a plate pushed
     half out of a window it fits in. */
  /**
   * ⚠️ **ANYTHING THAT MOVES THE PAN OTHER THAN THE DRAG ITSELF ENDS THE
   * DRAG.** A drag holds a snapshot — the pointer's origin and the pan as it
   * was when the finger went down — and every later move is computed from it.
   * So any other writer of `pan` leaves that snapshot describing a position
   * the plate is no longer in: the next move jumps, or an interval of the
   * drag does nothing at all.
   *
   * THREE WRITERS TURNED UP ONE AT A TIME — zoom, then keyboard panning, then
   * the resize reclamp — which is why this is one named rule rather than
   * three fixes. A fourth writer must call this too.
   */
  const stopDrag = useCallback(() => {
    from.current = null
    setDragging(false)
  }, [])

  const zoomTo = useCallback((next: number) => {
    const at = Math.min(MAX_ZOOM, Math.max(FIT, next))
    stopDrag()
    setZoom(at)
    setPan((was) => (at <= FIT ? { x: 0, y: 0 } : settle(was, at)))
  }, [])

  const toggleZoom = useCallback(() => {
    setZoom((at) => {
      const next = at > FIT ? FIT : 2
      setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  /**
   * Keep the plate on the stage when the stage changes size.
   *
   * ⚠️ **THE CLAMP ONLY EVER RAN DURING A GESTURE.** Pan to the edge, then
   * make the window smaller: the overhang shrinks, the stored offset does not,
   * and the plate ends up entirely outside the stage — taking its own drag and
   * zoom handlers with it, so there is nothing left to grab. Found by the
   * second audit round, 2026-09-25.
   */
  useEffect(() => {
    const img = stage.current
    const host = img?.parentElement
    if (!img || !host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      stopDrag()
      setPan((was) => settle(was, zoomRef.current))
    })
    observer.observe(host)
    observer.observe(img)
    return () => observer.disconnect()
  }, [plate?.src])

  /**
   * ⚠️ **A NATIVE LISTENER, BECAUSE REACT'S `onWheel` IS PASSIVE.** React
   * attaches `wheel` at the root with `{ passive: true }`, so
   * `event.preventDefault()` inside an `onWheel` prop does NOTHING — the
   * viewer would zoom and the page behind it would scroll at the same time.
   * Caught by the case that asserts `defaultPrevented`, which failed against
   * the prop and passes against this. `session.ts` binds the book's own wheel
   * the same way and for the same reason.
   */
  const stage = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      /* A HORIZONTAL SCROLL IS NOT A ZOOM OUT. `deltaY === 0` is what a
         sideways trackpad swipe reports, and treating it as "not negative"
         shrank the plate for a gesture that meant nothing. */
      if (event.deltaY === 0) return
      event.preventDefault()
      zoomTo(zoomRef.current * (event.deltaY < 0 ? 1.1 : 1 / 1.1))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [plate?.src])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      /* PANNING ONLY MEANS ANYTHING WHEN THERE IS SOMETHING OFF-SCREEN. A
         fitted plate that moves under the pointer reads as a broken drag. */
      if (!zoomed || !event.isPrimary || event.button !== 0) return
      /* ONE DRAG AT A TIME. Without this a second finger landing mid-drag
         replaced the origin, so the plate jumped. */
      if (from.current) return
      event.currentTarget.setPointerCapture(event.pointerId)
      from.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
      setDragging(true)
    },
    [zoomed, pan.x, pan.y],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const start = from.current
    /* ⚠️ **THE POINTER THAT STARTED IT, AND NO OTHER.** A second finger moving
       across a plate mid-drag jumped it to that finger's offset; a second
       finger LIFTING ended the first finger's drag. */
    if (!start || event.pointerId !== start.id) return
    setPan(
      settle({ x: start.panX + (event.clientX - start.x), y: start.panY + (event.clientY - start.y) }, zoomRef.current),
    )
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const start = from.current
    if (!start || event.pointerId !== start.id) return
    from.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  /**
   * Zooming and panning from the keyboard.
   *
   * ⚠️ **WITHOUT THIS A KEYBOARD USER CANNOT ENLARGE A FIGURE AT ALL.** Every
   * other route in — wheel, double-click, drag — is a pointer gesture, so the
   * whole feature was unreachable without a mouse or a trackpad. The image
   * takes focus for it, which also gives `OverlaySheet`'s trap something
   * inside the dialog to land on.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLImageElement>) => {
      const nudge = 40
      const keys: Record<string, () => void> = {
        '+': () => zoomTo(zoomRef.current * 1.25),
        '=': () => zoomTo(zoomRef.current * 1.25),
        '-': () => zoomTo(zoomRef.current / 1.25),
        '0': () => zoomTo(FIT),
        ArrowRight: () => setPan((was) => settle({ x: was.x - nudge, y: was.y }, zoomRef.current)),
        ArrowLeft: () => setPan((was) => settle({ x: was.x + nudge, y: was.y }, zoomRef.current)),
        ArrowDown: () => setPan((was) => settle({ x: was.x, y: was.y - nudge }, zoomRef.current)),
        ArrowUp: () => setPan((was) => settle({ x: was.x, y: was.y + nudge }, zoomRef.current)),
      }
      const act = keys[event.key]
      if (!act) return
      event.preventDefault()
      /* Every branch here writes the pan or the zoom — see `stopDrag`. */
      stopDrag()
      act()
    },
    [zoomTo, stopDrag],
  )

  if (!plate) return null

  /* THE BOOK'S OWN WORDS ARE THE NAME. An image the book did not describe gets
     a generic one rather than an empty label, because `aria-label=""` on a
     dialog announces nothing at all and the reader is told there is a dialog
     without being told what is in it. */
  const label = plate.alt || 'Figure'

  return (
    <OverlaySheet label={label} onDismiss={onClose} variant="plate">
      <div className={styles.stage}>
        <img
          className={styles.image}
          ref={stage}
          src={plate.src}
          alt={plate.alt}
          data-zoomed={zoomed}
          data-dragging={dragging}
          /* ⚠️ **THE ONE INLINE STYLE THIS FILE MAY WRITE, AND WHY.**
             `tokens.test.ts` reads CSS, so a design value in a `style={{…}}`
             is invisible to it, and the mutation gate cannot kill either the
             object or its strings — which is why four of `SearchPanel`'s
             became classes. This is neither a design value nor a constant: it
             is computed geometry that changes on every frame of a drag, and it
             cannot live in a stylesheet. Every colour, radius, space and
             duration is in `PlateViewer.module.css`. */
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDoubleClick={toggleZoom}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close this figure">
          ✕
        </button>
        {plate.alt !== '' && <p className={styles.caption}>{plate.alt}</p>}
      </div>
    </OverlaySheet>
  )
}
