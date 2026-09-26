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
   * spine — so the control is ABSENT rather than present and dead. A button that
   * declines teaches a reader the app cannot do this. False while a reading
   * speaks, and away from the reader screen, for the reasons in the deps above.
   */
  readonly offered: boolean
  /**
   * Whether a host should put the control in front of the reader at all.
   *
   * ⚠️ **`offered` IS NOT ENOUGH, AND THE GAP TOOK THE STOP BUTTON AWAY.** A
   * pace that stops being derivable while the book is turning itself — a section
   * between layouts — makes `offered` false, and a host that showed the row on
   * `offered` alone then left a reader with a moving book and no control to stop
   * it. A thing that can be started must stay reachable to be ended.
   *
   * ⚠️ **AND IT LIVES HERE RATHER THAN IN THE HOST BECAUSE A RULE IN `App` IS A
   * RULE NOTHING MEASURES.** Spelled `offered || advancing` at the call site it
   * was three mutants no test could reach, because nothing renders `App` and
   * reads the palette back. Here it is one line with cases on it.
   */
  readonly reachable: boolean
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

  /* ⚠️ **NO `!== null` TEST, BECAUSE `clearTimeout` ALREADY TOLERATES NOTHING.**
     The sweep answered this one: `if (true)` survived, because clearing a handle
     that was never set is a no-op either way. `?? undefined` is what the DOM
     signature needs, and the `??` itself is decisive — `&&` would pass
     `undefined` for a LIVE handle and leave the timer running. */
  const clear = useCallback(
    () => {
      chain.current = null
      clearTimeout(timer.current ?? undefined)
      timer.current = null
    },
    // Stryker disable next-line ArrayDeclaration: everything this reads is a ref, so the list is constant either way and the callback is built once.
    [],
  )

  const stop = useCallback(
    () => {
      clear()
      setAdvancing(false)
    },
    // Stryker disable next-line ArrayDeclaration: `clear` never moves, so this list and an empty one rebuild this equally often — never.
    [clear],
  )

  /**
   * One rest, then one step, then arrange the next.
   *
   * ⚠️ **A CHAIN OF TIMEOUTS, NOT AN INTERVAL.** The rest is re-derived every
   * tick because the section changes, so the gap between steps is not constant —
   * an interval would keep the first section's pace for the whole book. It also
   * means a tick that cannot derive a pace stops cleanly instead of firing at a
   * stale rate.
   *
   * ⚠️ **AND NO CHAIN CHECK OR READING-OR-SCREEN CHECK AT THE TOP OF IT — BOTH
   * WERE THIRD GUARDS ON ROADS ALREADY GUARDED**, which the sweep on mbp16
   * showed by surviving every mutation of them; the second pair came back
   * `NoCoverage`, so no test could reach them at all. The chain identity belongs
   * where the WINDOW is, in `settle` below — checking it here as well made THAT
   * one unkillable, because a stale continuation was stopped twice and the first
   * stop was invisible. Speaking and off-reader belong to the effect at the
   * bottom of this hook: a reading or a screen change is state, so it renders, so
   * the effect runs and stops the chain before any timer it armed can fire.
   */
  const tick = useCallback(
    (mine: object) => {
      const rest = restPerStep(live.current.pace())
      if (rest === null) {
        stop()
        return
      }
      timer.current = setTimeout(() => {
        timer.current = null
        /* ⚠️ **THE AWAIT IS A WINDOW, AND EVERYTHING CAN CHANGE IN IT.** Stopped,
           a different book opened, a reading started: the chain identity is what
           says this answer is still the live one's. Without the check, a stop
           during a turn was followed by the next step being scheduled.

           ⚠️ **AND THE END OF THE BOOK STOPS IT.** `step` answers whether it
           moved, and a `next()` at the last page moves nothing — without that the
           book would sit on its final page with a control still lit, which reads
           as a stall rather than an ending. */
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
    },
    // Stryker disable next-line ArrayDeclaration: `stop` never moves, so this list and an empty one rebuild this equally often — never.
    [stop],
  )

  /**
   * ⚠️ **NOTHING IS REFUSED HERE, AND TRYING TO WAS TWO MUTANTS NOTHING COULD
   * KILL.** This began with the two conditions `offered` is made of — a reading
   * speaking, and the reader being away from the book — and a pace check as well.
   * All three are answered a step further on, and answered indistinguishably:
   *
   * - a pace that cannot be derived stops at `tick`'s own `rest === null`, which
   *   has to be there anyway for a section that goes unreadable mid-book;
   * - speaking and off-reader stop at the effect below, which fires on the render
   *   that `setAdvancing(true)` itself causes.
   *
   * An attempt was made to measure the difference as a timer that never got
   * armed — `vi.getTimerCount()` after `start`. It cannot: the effect runs inside
   * the same `act`, so the timer is armed and cleared before anything can look,
   * and the count is 0 either way. Measured, not assumed.
   *
   * So `start` takes a fresh chain and ticks. `offered` is still the whole rule
   * for whether a reader is shown the control; the two stopping rules live in one
   * place each.
   */
  const start = useCallback(
    () => {
      clear()
      const mine = {}
      chain.current = mine
      setAdvancing(true)
      tick(mine)
    },
    // Stryker disable next-line ArrayDeclaration: neither ever moves, so this list and an empty one rebuild this equally often — never.
    [clear, tick],
  )

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

  /* Speaking and off-reader are part of OFFERED, not only of the stopping rules:
     a row a reader can see and press is a promise, and one that declines teaches
     them the app cannot do this. */
  const offered = !deps.speaking && deps.onReader && restPerStep(deps.pace()) !== null

  return {
    advancing,
    offered,
    reachable: offered || advancing,
    start,
    stop,
    toggle,
  }
}
