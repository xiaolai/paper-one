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
 *
 * ⚠️ **ONE NUMBER, TWO SHUTDOWNS.** The window close and the app quit
 * (`app/shutdown.ts`) drain the same queue under the same rule, and each had
 * written `2000` out separately — so the two could have drifted into
 * disagreeing about how long a reader's last highlight is worth waiting for,
 * with nothing to notice. The quit path imports this rather than declaring its
 * own.
 */
export const CLOSE_DRAIN_MS = 2000

/**
 * How much longer than the drain the WHOLE teardown may hold the window.
 *
 * The window close used to run flush → drain → destroy and nothing else; the
 * quit handshake (`app/shutdown.ts`) runs flush → drain → abort → quiesce,
 * and the last two are what close the sync journal. So the red button never
 * brought the journal's flag down — on Windows and Linux, where the quit menu
 * is macOS-only, EVERY quit left it up and the next launch re-verified the
 * shelf. Now the close runs the composition's teardown, and the bound covers
 * all of it: the drain's own bound, plus this for what follows. A journal
 * close is three small writes; a second is an order of magnitude.
 */
export const QUIESCE_GRACE_MS = 1000
export const CLOSE_HOLD_MS = CLOSE_DRAIN_MS + QUIESCE_GRACE_MS

export interface CloseSteps {
  /**
   * Everything that must happen before the window goes. For a composed app
   * that is the same teardown ⌘Q runs — hand over, drain, end the
   * capabilities, close the journal, tell the shell; for a bare kernel it is
   * `closePrepare` below. May reject or throw; either is reported and the
   * window still closes. Bounded by `timeoutMs`.
   */
  prepare: () => Promise<unknown>
  /** Close the window. */
  destroy: () => Promise<unknown>
  /** How long `prepare` may hold the window. */
  timeoutMs: number
  /** Where failures go. */
  report: (message: string, cause: unknown) => void
}

/**
 * A reporter that cannot break the sequence it reports on.
 *
 * Every failure path here ends in `report`, and a REPORTER that throws — a
 * diagnostics store that is itself failing is the likely case, since one
 * failure rarely travels alone — escaped the very catch blocks it was called
 * from: out of `closePrepare` before the drain, and out of the close sequence
 * BEFORE `steps.destroy()`, leaving the reader the un-closable window this
 * whole file exists to prevent. The guarantee is "always closes", so the
 * reporter is wrapped once, here, rather than defended against at every call
 * site — a site added later is safe by construction.
 */
function quiet(report: CloseSteps['report']): CloseSteps['report'] {
  return (message, cause) => {
    try {
      report(message, cause)
    } catch (reportFailure) {
      console.error(message, cause, reportFailure)
    }
  }
}

/**
 * The kernel's own preparation, for a host with no composition to tear down:
 * hand what memory holds to the queue, then let the queue drain. Each half
 * reports its own failure and the other still runs — a note that will not
 * serialise must not stop the position being written.
 */
export function closePrepare(
  flush: () => void,
  drain: () => Promise<unknown>,
  report: CloseSteps['report'],
): () => Promise<void> {
  const say = quiet(report)
  return async () => {
    /* WHAT IS HELD IN MEMORY FIRST, then what is on the queue. A queue can
     * only drain what it has been given, and the thing most likely to be lost
     * is the thing not yet handed over — a note being typed. */
    try {
      flush()
    } catch (cause) {
      say('Paper: could not hand over unsaved work before closing', cause)
    }
    try {
      await drain()
    } catch (cause) {
      say('Paper: the write queue did not drain before closing', cause)
    }
  }
}

/**
 * Run it. Resolves when the window has been asked to close.
 *
 * Returns the same promise for every call after the first, so a reader
 * pressing close twice gets one teardown.
 */
export function createCloseSequence(steps: CloseSteps): () => Promise<void> {
  let running: Promise<void> | null = null

  const say = quiet(steps.report)
  const run = async (): Promise<void> => {
    let finished = false
    /* The timer handle is kept and cleared: a prepare that settles in ten
     * milliseconds must not leave a multi-second timer and its closure alive
     * for the rest of the bound. */
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        /* CAUGHT ON THE STEP ITSELF, not on the race. A rejection inside a
         * `Promise.race` rejects the race, so a teardown that failed early
         * skipped the bound entirely and took the destroy with it. And
         * `Promise.resolve().then(…)`, so a `prepare` that THROWS rather
         * than rejects lands in the same catch. */
        Promise.resolve()
          .then(() => steps.prepare())
          .then(
            () => {
              finished = true
            },
            (cause: unknown) => {
              finished = true
              say('Paper: the teardown before closing failed', cause)
            },
          ),
        new Promise((resolve) => {
          timer = setTimeout(resolve, steps.timeoutMs)
        }),
      ])
    } catch (cause) {
      say('Paper: could not wait for the teardown before closing', cause)
    } finally {
      clearTimeout(timer)
    }
    /* SAID, because it is invisible otherwise: a teardown cut off by the bound
     * leaves the journal's flag up and the next launch re-verifying the shelf
     * — exactly the state the shell's own log line warns about on a quit. */
    if (!finished) {
      say('Paper: the teardown did not finish before the window closed; the sync journal may be left dirty', null)
    }

    /* ALWAYS. `preventDefault` has already run, so this is the only thing that
     * closes the window; a failure here is reported and the window is left in
     * the reader's hands rather than the error escaping into a rejected
     * listener nobody is watching. */
    try {
      await steps.destroy()
    } catch (cause) {
      say('Paper: could not close the window', cause)
    }
  }

  return () => {
    running ??= run()
    return running
  }
}
