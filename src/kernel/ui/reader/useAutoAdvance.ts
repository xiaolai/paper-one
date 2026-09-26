import { useCallback, useEffect, useRef, useState } from 'react'
import { restPerStep, type StepPace } from '../../core/autoAdvance'

/**
 * Turning the book by itself, at the reader's own pace.
 *
 * ⚠️ **IT STEPS AND DOES NOT GLIDE, AND THAT IS ARCHITECTURE RATHER THAN A
 * CHOICE.** The paginator owns the scroller inside a closed shadow root, and the
 * book's own document is sized to its whole content — measured 2026-09-26, a
 * real section reports `scrollHeight` and `clientHeight` both 125 235 and
 * `scrollTop` will not move from the host. `view.next()` and `renderer.pages`
 * are what is in reach. See `core/autoAdvance.ts`.
 *
 * ⚠️ **AND IT IS NOT READ ALOUD'S SECOND HALF.** Read aloud already turns the
 * page — `useSpeech` calls the same `next()` when a reading crosses a page — so
 * the two together would double-advance. `speaking` refuses this outright rather
 * than pausing it: a reader who starts a reading has chosen the voice's pace,
 * and two paces on one book is a defect with no honest resolution.
 */
export interface AutoAdvanceDeps {
  /** Turn the page or step the scroll. Answers whether it moved. */
  readonly step: () => boolean
  /**
   * What the pace is derived from, re-read on every tick rather than captured.
   *
   * ⚠️ **PER TICK, BECAUSE THE SECTION CHANGES UNDER IT.** A rest derived once
   * at the start would keep a long chapter's pace through a two-page preface.
   * `renderer.pages` also settles after layout, so a value read at start-up can
   * be the wrong one — the same reason `useSpeech` reads its preferences at
   * speak time and never captures them.
   */
  readonly pace: () => StepPace
  /** True while a reading is speaking — see the header. */
  readonly speaking: boolean
}

export interface AutoAdvance {
  /** Whether the book is currently turning itself. */
  readonly advancing: boolean
  /**
   * Whether it can be offered at all.
   *
   * False where the pace cannot be derived — a PDF, a book with a partial
   * spine — so the control is ABSENT rather than present and dead. A button
   * that declines teaches a reader the app cannot do this.
   */
  readonly offered: boolean
  readonly start: () => void
  readonly stop: () => void
  readonly toggle: () => void
}

/** A timer handle, whichever environment supplies it. */
type Timer = ReturnType<typeof setTimeout>

export function useAutoAdvance(deps: AutoAdvanceDeps): AutoAdvance {
  const [advancing, setAdvancing] = useState(false)
  const timer = useRef<Timer | null>(null)
  /* Read at TICK time, never captured — the section under the reader changes
     while this runs, and so does `pages`. See `AutoAdvanceDeps.pace`. */
  const live = useRef(deps)
  live.current = deps

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const stop = useCallback(() => {
    clear()
    setAdvancing(false)
  }, [clear])

  /**
   * One rest, then one step, then arrange the next.
   *
   * ⚠️ **A CHAIN OF TIMEOUTS, NOT AN INTERVAL.** The rest is re-derived every tick
   * because the section changes, so the gap between steps is not constant — an
   * interval would keep the first section's pace for the whole book. It also
   * means a tick that cannot derive a pace stops cleanly instead of firing at a
   * stale rate.
   */
  const tick = useCallback(() => {
    const { pace, speaking } = live.current
    if (speaking) {
      stop()
      return
    }
    const rest = restPerStep(pace())
    if (rest === null) {
      stop()
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      /* ⚠️ **THE END OF THE BOOK STOPS IT.** `step` answers whether it moved, and
         a `next()` at the last page moves nothing — without this the book would
         sit on its final page with a control still lit, which reads as a stall
         rather than an ending. */
      if (!live.current.step()) {
        stop()
        return
      }
      tick()
    }, rest)
  }, [stop])

  const start = useCallback(() => {
    if (live.current.speaking) return
    if (restPerStep(live.current.pace()) === null) return
    clear()
    setAdvancing(true)
    tick()
  }, [clear, tick])

  const toggle = useCallback(() => {
    if (advancing) stop()
    else start()
  }, [advancing, start, stop])

  /* A reading that starts takes the book over — see the header. */
  useEffect(() => {
    if (deps.speaking && advancing) stop()
  }, [deps.speaking, advancing, stop])

  /* ⚠️ **AND A TIMER MUST NOT OUTLIVE THE COMPONENT.** Without this, closing a
     book leaves a chain of timeouts calling `step` on a view that is gone. */
  useEffect(() => clear, [clear])

  return {
    advancing,
    offered: restPerStep(deps.pace()) !== null,
    start,
    stop,
    toggle,
  }
}
