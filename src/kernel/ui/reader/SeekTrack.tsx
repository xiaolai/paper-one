import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './SeekTrack.module.css'

/**
 * How far through the book, and the one control that can change it.
 *
 * ⚠️ **IN THE KERNEL BECAUSE BOTH SHELLS DRAW IT, AND THE KERNEL IS THE ONLY
 * PLACE BOTH CAN REACH.** It began in `app/shell/ProgressFooter`, which the
 * desktop cannot import — `src/app/` depends on the kernel and never the other
 * way round. Copying it into `screens/Reader.tsx` would have been two answers
 * to one question, on the control whose failure mode is *losing the reader's
 * place*, so it moved here instead and the footer became a caller.
 *
 * ⚠️ **AND IT ANNOUNCES ITSELF AS A SLIDER ONLY WHEN IT CAN MOVE.** With no
 * `onSeek` it is a readout and says `progressbar`; announcing a slider a
 * reader cannot operate is worse than announcing a progress bar honestly.
 */
export interface SeekTrackProps {
  /** 0–1 through the book. */
  readonly fraction: number
  /**
   * Go to a place, 0–1 through the book. Absent makes this a readout.
   *
   * ⚠️ **THE CALLER MUST RECORD A DEPARTURE.** This is the only control in the
   * app that can move a reader a thousand pages by accident, and a slipped
   * thumb in a long book loses their place permanently unless the departure
   * was recorded. Both shells go through the jump stack — `jumps.record()`
   * followed by `goToFraction` — so ⌘[ brings the reader back.
   */
  readonly onSeek?: ((fraction: number) => void) | undefined
  /** A class from the caller's own stylesheet, for the lane it sits in. */
  readonly className?: string | undefined
  /**
   * Where the thumb is while it is being dragged, and null at rest.
   *
   * The readouts beside the track — the percentage, the time left — must
   * follow the THUMB rather than the book, or the reader drags to 80 % and
   * reads "37 %". They belong to the caller, so the preview is published
   * rather than drawn here, and both sides derive it with `shownFraction` so
   * they cannot disagree about what is being previewed.
   */
  readonly onPreview?: ((fraction: number | null) => void) | undefined
}

/** Where a pointer sits along a track, as a fraction, clamped. */
export function fractionAt(clientX: number, box: { left: number; width: number }): number {
  if (box.width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - box.left) / box.width))
}

/** How far one key press moves. An arrow is fine; a page key is coarser. */
const STEP = 0.01
const PAGE_STEP = 0.05

/** What the reader is looking at — the thumb while dragging, the book otherwise. */
export function shownFraction(fraction: number, dragging: number | null): number {
  const at = dragging ?? fraction
  return Number.isFinite(at) ? Math.min(1, Math.max(0, at)) : 0
}

export function SeekTrack({ fraction, onSeek, className, onPreview }: SeekTrackProps) {
  const track = useRef<HTMLSpanElement | null>(null)
  /* WHERE THE THUMB IS WHILE IT IS BEING DRAGGED, which is not where the book
     is. ⚠️ **A DRAG MUST NOT RELOCATE PER FRAME**: every relocation reaches
     `book.setPosition`, and a position write is a row in `sync/journal.jsonl`
     that REPLICATES TO THE PEER. Dragging across a book at 60 fps would push
     hundreds of positions to another machine for one gesture. So the preview
     is local and only the release seeks. */
  const [dragging, setDraggingState] = useState<number | null>(null)
  /* One setter, so no route can move the thumb without telling the caller. */
  const setDragging = useCallback(
    (at: number | null) => {
      setDraggingState(at)
      onPreview?.(at)
    },
    [onPreview],
  )
  /**
   * The gesture in flight: which pointer owns it, and the track's box as it
   * was when it started.
   *
   * ⚠️ **THE BOX IS CAPTURED, NOT REMEASURED.** The track is `flex: 1` in a row
   * whose readouts change width as the preview moves, so it narrows under the
   * reader's own thumb. Releasing then measured a different box from the one
   * the preview was computed against, and committed a different place from the
   * one the reader was shown.
   */
  const gesture = useRef<{ id: number; left: number; width: number } | null>(null)

  const seekTo = useCallback(
    (at: number) => {
      if (!onSeek) return
      onSeek(Math.min(1, Math.max(0, at)))
    },
    [onSeek],
  )

  const pct = Math.round(shownFraction(fraction, dragging) * 100)

  const at = (event: { clientX: number }): number => {
    const held = gesture.current
    if (held) return fractionAt(event.clientX, held)
    const el = track.current
    if (!el) return 0
    return fractionAt(event.clientX, el.getBoundingClientRect())
  }

  const letGo = (event: React.PointerEvent<HTMLSpanElement>) => {
    gesture.current = null
    setDragging(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (!onSeek || !event.isPrimary || event.button !== 0) return
    /* ONE GESTURE AT A TIME — a second finger landing mid-drag must not take
       the track over. */
    if (gesture.current) return
    const el = track.current
    if (!el) return
    const box = el.getBoundingClientRect()
    gesture.current = { id: event.pointerId, left: box.left, width: box.width }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(at(event))
  }

  const onPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    const held = gesture.current
    /* THE POINTER THAT STARTED IT. A second finger moving across the track
       used to drag the preview with it. */
    if (!held || event.pointerId !== held.id) return
    setDragging(at(event))
  }

  const onPointerUp = (event: React.PointerEvent<HTMLSpanElement>) => {
    const held = gesture.current
    if (!held || event.pointerId !== held.id) return
    const landing = at(event)
    letGo(event)
    seekTo(landing)
  }

  /**
   * ⚠️ **A CANCELLED GESTURE MUST NOT SEEK, AND THIS USED TO.** `pointercancel`
   * is the system taking the gesture away — a scroll claiming it, the window
   * losing the pointer, a palm rejected — and committing on it relocates the
   * book and REPLICATES a position the reader never chose. It was wired to the
   * same handler as release, and a test asserted the wrong behaviour.
   */
  const onPointerCancel = (event: React.PointerEvent<HTMLSpanElement>) => {
    const held = gesture.current
    if (!held || event.pointerId !== held.id) return
    letGo(event)
  }

  /**
   * ⚠️ **CAPTURE CAN BE LOST WITHOUT A `pointerup` OR A `pointercancel`.**
   * The browser releases it when the captured element is removed, hidden or
   * disabled, and the events that end a gesture never arrive — so the gesture
   * ref stayed set for ever. The preview froze at wherever the thumb had got
   * to, and the one-gesture-at-a-time guard then rejected EVERY later pointer:
   * the track was dead until the book was reopened.
   *
   * It clears WITHOUT committing, like a cancel — the reader did not release,
   * so nothing was chosen.
   */
  const onLostPointerCapture = (event: React.PointerEvent<HTMLSpanElement>) => {
    const held = gesture.current
    if (!held || event.pointerId !== held.id) return
    gesture.current = null
    setDragging(null)
  }

  /**
   * ⚠️ **AND SEEKING CAN BE TAKEN AWAY MID-DRAG.** With `onSeek` gone the
   * release and cancel handlers are not attached at all, so a gesture in
   * flight had nothing left to end it — same stranded state as above, reached
   * from the other side. The gesture is dropped when the control stops being
   * operable.
   */
  useEffect(() => {
    if (onSeek) return
    gesture.current = null
    setDragging(null)
  }, [onSeek, setDragging])

  const onKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!onSeek) return
    const moves: Record<string, number> = {
      ArrowRight: STEP,
      ArrowUp: STEP,
      ArrowLeft: -STEP,
      ArrowDown: -STEP,
      PageUp: PAGE_STEP,
      PageDown: -PAGE_STEP,
    }
    if (event.key === 'Home') {
      event.preventDefault()
      seekTo(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      seekTo(1)
      return
    }
    const move = moves[event.key]
    if (move === undefined) return
    event.preventDefault()
    seekTo(fraction + move)
  }

  return (
    <span
      className={className === undefined ? styles.track : `${styles.track} ${className}`}
      ref={track}
      role={onSeek ? 'slider' : 'progressbar'}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${pct}% through the book`}
      /* NAMED IN BOTH MODES. A read-only `progressbar` with a value and no name
         tells assistive technology a number and not what it counts. */
      aria-label="How far through the book"
      {...(onSeek
        ? {
            tabIndex: 0,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onLostPointerCapture,
            onKeyDown,
          }
        : {})}
    >
      <span className={styles.fill} style={{ inset: `0 ${100 - pct}% 0 0` }} />
      {dragging !== null && <span className={styles.thumb} style={{ insetInlineStart: `${pct}%` }} />}
    </span>
  )
}
