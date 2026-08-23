/**
 * The close sequence: hand over what memory holds, let the queue drain, and
 * then close — whatever any of that did.
 *
 * # Why it is a unit and not four lines in an effect
 *
 * It was four lines in an effect, and every failure path was missing. The
 * handler calls `preventDefault()` first — it has to, or the window goes while
 * writes are in flight — and from that moment the window closes only because
 * this code closes it. So a throw from the flush, a rejected drain, or a
 * failed destroy did not merely lose the save: it left the reader with a
 * window that would not close, and no way to find out why.
 *
 * Two properties, and neither can be checked by reading the effect:
 *
 * 1. **It always closes.** Saving is best-effort; closing is not optional.
 *    Every failure is reported and then stepped over, because the alternative
 *    is a window the reader has to kill.
 * 2. **It closes once.** A second close request while the first is draining
 *    used to start a second teardown, so two drains and two destroys raced.
 *
 * The drain is bounded rather than awaited outright: a queue that cannot
 * finish must not hold the window forever, and two seconds is a liveness
 * bound — the point past which waiting is worse than losing the tail — not an
 * assertion about how long a drain takes.
 */

/**
 * How long the drain may hold the window open.
 *
 * A LIVENESS BOUND, not a performance assertion: the point past which waiting
 * is worse for the reader than losing the tail of the queue. A queue that
 * cannot finish must not leave them with a window that will not close.
 */
export const CLOSE_DRAIN_MS = 2000

export interface CloseSteps {
  /** Hand what is held in memory to the queue. May throw. */
  flush: () => void
  /** Resolve when the queue is idle. May reject. */
  drain: () => Promise<unknown>
  /** Close the window. */
  destroy: () => Promise<unknown>
  /** How long the drain may hold the window. */
  timeoutMs: number
  /** Where failures go. */
  report: (message: string, cause: unknown) => void
}

/**
 * Run it. Resolves when the window has been asked to close.
 *
 * Returns the same promise for every call after the first, so a reader
 * pressing close twice gets one teardown.
 */
export function createCloseSequence(steps: CloseSteps): () => Promise<void> {
  let running: Promise<void> | null = null

  const run = async (): Promise<void> => {
    /* WHAT IS HELD IN MEMORY FIRST, then what is on the queue. A queue can
     * only drain what it has been given, and the thing most likely to be lost
     * is the thing not yet handed over — a note being typed. */
    try {
      steps.flush()
    } catch (cause) {
      steps.report('Paper: could not hand over unsaved work before closing', cause)
    }

    try {
      await Promise.race([
        /* CAUGHT ON THE DRAIN ITSELF, not on the race. A rejection inside a
         * `Promise.race` rejects the race, so a drain that failed early
         * skipped the bound entirely and took the destroy with it. */
        steps.drain().catch((cause: unknown) => {
          steps.report('Paper: the write queue did not drain before closing', cause)
        }),
        new Promise((resolve) => setTimeout(resolve, steps.timeoutMs)),
      ])
    } catch (cause) {
      steps.report('Paper: could not wait for writes before closing', cause)
    }

    /* ALWAYS. `preventDefault` has already run, so this is the only thing that
     * closes the window; a failure here is reported and the window is left in
     * the reader's hands rather than the error escaping into a rejected
     * listener nobody is watching. */
    try {
      await steps.destroy()
    } catch (cause) {
      steps.report('Paper: could not close the window', cause)
    }
  }

  return () => {
    running ??= run()
    return running
  }
}
