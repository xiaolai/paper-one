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
  /**
   * Turn the page or step the scroll, resolving to whether it moved.
   *
   * ⚠️ **AWAITED, NOT FIRED AND FORGOTTEN.** The next rest is derived from the
   * section the step LANDS in, so a synchronous `true` scheduled a new chapter's
   * first page at the old chapter's pace and counted the load as reading time.
   */
  readonly step: () => Promise<boolean>
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
  /**
   * True while the reader is looking at the book.
   *
   * ⚠️ **A BOOK MUST NOT TURN ITSELF WHERE NOBODY IS LOOKING.** The reader
   * screen is one of several and the reader stays mounted behind the others, so
   * without this the palette would start an advance from the library — turning
   * an invisible book and writing its reading position, which is the reader's
   * place in it. Leaving the reader stops it for the same reason.
   */
  readonly onReader: boolean
  /**
   * The open book's generation — `useBook`'s, which advances on every open.
   *
   * ⚠️ **THE CHAIN IS BOUND TO THE BOOK, NOT TO THE COMPONENT.** This hook lives
   * in `App`, which never unmounts while the app is open, so an unmount-only
   * teardown left a running chain turning the pages of whatever book was opened
   * next — with `advancing` still true and the control still reading *Stop*.
   */
  readonly generation: number
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
  /**
   * Which chain is the live one.
   *
   * ⚠️ **AN IDENTITY RATHER THAN A COUNTER**, and it exists because a step is
   * now AWAITED: a turn takes a few hundred milliseconds, and a stop, a book
   * change or a reading starting in that window must not be followed by the
   * scheduling of another step. A fresh object cannot collide by construction,
   * where a number that goes up and down can.
   */
  const chain = useRef<object | null>(null)
  /* Read at TICK time, never captured — the section under the reader changes
     while this runs, and so does `pages`. See `AutoAdvanceDeps.pace`. */
  const live = useRef(deps)
  live.current = deps

  const clear = useCallback(() => {
    chain.current = null
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
  const tick = useCallback((mine: object) => {
    if (chain.current !== mine) return
    const { pace, speaking, onReader } = live.current
    if (speaking || !onReader) {
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
      /* ⚠️ **THE AWAIT IS A WINDOW, AND EVERYTHING CAN CHANGE IN IT.** Stopped,
         a different book opened, a reading started: the chain identity is what
         says this answer is still the live one's. Without the check a stop
         during a turn was followed by the next step being scheduled. */
      const settle = (moved: boolean) => {
        if (chain.current !== mine) return
        if (!moved) {
          stop()
          return
        }
        tick(mine)
      }
      /* ⚠️ **A STEP THAT FAILS IS A STEP THAT DID NOT MOVE, BOTH WAYS IT CAN
         FAIL.** This runs inside a timer callback, where nothing is listening:
         a rejection with no handler is an unhandled one at the window, and a
         SYNCHRONOUS throw — which any host whose `step` is not itself `async`
         can produce — would escape the callback entirely. `useBook.step`
         already answers false rather than throwing; this does not depend on it,
         for the same reason that layer does not depend on the session's. */
      try {
        void live.current.step().then(settle, () => settle(false))
      } catch {
        settle(false)
      }
    }, rest)
  }, [stop])

  const start = useCallback(() => {
    if (live.current.speaking || !live.current.onReader) return
    if (restPerStep(live.current.pace()) === null) return
    clear()
    const mine = {}
    chain.current = mine
    setAdvancing(true)
    tick(mine)
  }, [clear, tick])

  const toggle = useCallback(() => {
    if (advancing) stop()
    else start()
  }, [advancing, start, stop])

  /* A reading that starts takes the book over, and so does leaving the book —
     see the header and `AutoAdvanceDeps.onReader`. */
  useEffect(() => {
    if ((deps.speaking || !deps.onReader) && advancing) stop()
  }, [deps.speaking, deps.onReader, advancing, stop])

  /**
   * ⚠️ **AND A CHAIN MUST OUTLIVE NEITHER THE BOOK NOR THE COMPONENT.**
   *
   * One effect for both, because they are one rule: whatever this was advancing
   * is no longer what is on screen. React runs the cleanup when `generation`
   * changes and again on unmount, so a book replaced under a running chain stops
   * it — without which the next book turned its own pages unasked — and closing
   * the reader cannot leave timeouts calling `step` on a view that is gone.
   */
  useEffect(() => stop, [deps.generation, stop])

  return {
    advancing,
    /* Speaking and off-reader are part of OFFERED, not only of `start`: a row a
       reader can see and press is a promise, and one that declines teaches them
       the app cannot do this. The caller keeps `Stop` reachable while advancing
       — see `App`, where a pace that became underivable once hid it. */
    offered: !deps.speaking && deps.onReader && restPerStep(deps.pace()) !== null,
    start,
    stop,
    toggle,
  }
}
