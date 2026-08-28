import type { Diagnostics } from '../kernel'

/**
 * THE CROSS-LANGUAGE QUIT HANDSHAKE (phase 11).
 *
 * macOS does not fire a window close for ⌘Q, the Quit menu item or an
 * AppleScript quit — Tauri's `RunEvent::ExitRequested` is not raised for any of
 * them ([tauri#9198]) — so the shell asks first: it emits `paper://shutdown`,
 * waits for `paper://shutdown-done`, and exits when it arrives or when its own
 * grace period runs out. Without an answer the app quits anyway, with the
 * journal left dirty and the next launch re-verifying the whole shelf. That is
 * invisible from the UI, which is why it went unnoticed.
 *
 * EXTRACTED FROM `main.tsx` SO IT CAN BE TESTED. It lived inline in a
 * three-hundred-line boot function that reads `document`, mounts a React root
 * and imports a native module — so none of its ordering, none of its bounding
 * and none of its failure paths had ever been executed by a test, and two of
 * the defects the comments below record were found by running the app.
 *
 * Everything it touches arrives as an argument. The only thing the caller
 * supplies that this file could have imported itself is the Tauri event
 * module, and that is the point: importing it here would put a native
 * dependency in the one place that has to run without one.
 */

export interface ShutdownDeps {
  /** Subscribe to a shell event. Resolves with the unsubscribe. */
  readonly listen: (event: string, handler: () => void) => Promise<() => void>
  /** Tell the shell the teardown is done. */
  readonly emit: (event: string) => Promise<void>
  /** Hand the write queue everything still held in the UI (`flushBeforeClose`). */
  readonly flush: () => void
  /** Wait for the write queue. */
  readonly drain: () => Promise<void>
  /** End the capabilities' lifetime — unbinds the recorder, closes the journal. */
  readonly abort: () => void
  /** Resolve once every capability's async tail has finished — see
   *  `Capability.quiesce`. Named for the question, not for the one capability
   *  that currently answers it. */
  readonly quiesce: () => Promise<void>
  /** The composition's lifetime, so the listener is released with it. */
  readonly signal: AbortSignal
  /** How long to wait for the queue. Under the shell's own grace. */
  readonly graceMs: number
  readonly diagnostics: Diagnostics
}

export const SHUTDOWN_EVENT = 'paper://shutdown'
export const SHUTDOWN_DONE_EVENT = 'paper://shutdown-done'

/**
 * Arm the handshake. Resolves once the listener is registered.
 *
 * ARM THIS BEFORE THE SLOW PART OF BOOT, not after it. It used to sit below
 * `composeCapabilities`, so a quit arriving during storage loading, migration,
 * the shelf scan or composition reached no handler at all: the shell deferred
 * the exit, waited out its entire grace period, and quit anyway with the
 * journal dirty — the exact state this exists to prevent, during the window
 * most likely to be slow.
 */
export async function armShutdown(deps: ShutdownDeps, teardown: () => Promise<void> = createTeardown(deps)): Promise<void> {
  /* THE TEARDOWN'S REJECTION IS CAUGHT HERE, because the listener cannot await
   * it. The default teardown settles its own failures, but the parameter is
   * injectable and a custom one that rejects would otherwise leave the app
   * with an unhandled rejection as its very last act — and no report at the
   * one moment a report matters. */
  const stop = await deps.listen(SHUTDOWN_EVENT, () => {
    void teardown().catch((error: unknown) => {
      try {
        deps.diagnostics.warn('shutdown.teardown-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      } catch {
        /* The reporter of last resort must not be allowed to re-raise. */
      }
    })
  })
  /* THE UNLISTEN IS KEPT AND TIED TO THE LIFETIME. Discarding it left a native
   * registration behind on every reload — StrictMode alone mounts twice in
   * development — so a quit reached several handlers, each aborting a lifetime
   * and answering `shutdown-done`, and the FIRST answer released the quit
   * while the others were still tearing down. */
  if (deps.signal.aborted) {
    stop()
    return
  }
  deps.signal.addEventListener('abort', () => stop(), { once: true })
}

/**
 * `armShutdown`, with the failure reported rather than thrown.
 *
 * For the boot path, which cannot await this — arming it must not delay the
 * first frame — and must not let it become an unhandled rejection either.
 * Failing to arm means every quit leaves the journal dirty, so it is said out
 * loud.
 */
export function armShutdownInBackground(deps: ShutdownDeps): () => Promise<void> {
  const teardown = createTeardown(deps)
  void armShutdown(deps, teardown).catch((error: unknown) => {
    deps.diagnostics.warn('shutdown.handshake-unavailable', {
      message: error instanceof Error ? error.message : String(error),
    })
  })
  return teardown
}

/**
 * ONE TEARDOWN, HOWEVER MANY ASK.
 *
 * Two things end the app: the shell's `paper://shutdown` (⌘Q, the menu, an
 * AppleScript quit) and the window's own close button — which, on Windows and
 * Linux, where the quit menu is macOS-only, is the only quit there is. The
 * close used to run its own flush-and-drain and skip the two steps that close
 * the journal, so its flag stayed up on every close. Both paths now run THIS,
 * and a second caller — a quit arriving while the close is already tearing
 * down — gets the same promise rather than a second abort racing the first.
 */
export function createTeardown(deps: ShutdownDeps): () => Promise<void> {
  let running: Promise<void> | null = null
  return () => {
    running ??= runTeardown(deps)
    return running
  }
}

/**
 * What happens when the shell asks.
 *
 * THE ORDER IS THE WHOLE THING, and it is the same order the window-close path
 * uses:
 *
 *   1. `flush` — a queue can only drain what it has been GIVEN, and the thing
 *      most likely to be lost is the thing not yet handed over: a note being
 *      typed, a reading position still inside its throttle.
 *   2. `drain`, BOUNDED — a wedged queue must delay a quit, never prevent one.
 *   3. `abort` LAST of the three: aborting unbinds the recorder and closes the
 *      journal, so anything drained after it would reach disk with no journal
 *      entry — unreplicable, which is the defect this phase existed to remove.
 *   4. `quiesce` — the journal's flag must come down before the process exits, or
 *      the next launch reads a crash that did not happen.
 *
 * An earlier version ran only steps 3 and 4, which flushed the journal and
 * nothing else: `App` covers the window close, and a macOS quit does not fire
 * one, so the quit path silently skipped both halves of the UI's own flush.
 */
async function runTeardown(deps: ShutdownDeps): Promise<void> {
  /* EVERY STEP RUNS, whatever the one before it did.
   *
   * One shared `try` used to cover all four, so a `flush` that threw skipped
   * `drain`, `abort` AND `quiesce`: the queue kept what it had been given, the
   * journal stayed open, and the quit was released anyway — the app exited
   * with the journal flag up because of a failure in the one step that has
   * nothing to do with the journal. The steps are not a transaction; each is
   * worth attempting on its own, and the ORDER note above is about sequence,
   * not about atomicity.
   *
   * CAUGHT AND SAID, not left to escape — this runs as `void teardown()` from
   * an event listener, so anything thrown here would be an unhandled rejection
   * on the way out of the app, losing the only report that a shutdown did not
   * finish at the one moment it matters. Found by testing the four failure
   * paths, each of which raised one. */
  const failures: string[] = []
  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    await step('flush', () => deps.flush())
    await step('drain', () => Promise.race([deps.drain(), wait(deps.graceMs)]))
    await step('abort', () => deps.abort())
    await step('quiesce', () => deps.quiesce())
    if (failures.length > 0) {
      deps.diagnostics.warn('shutdown.teardown-failed', { message: failures.join('; ') })
    }
  } finally {
    /* ALWAYS ANSWERED. A teardown that threw must still release the quit —
     * otherwise a bug in one capability makes the app take the shell's whole
     * grace period to close, every time, for everybody. The failed answer is
     * still SAID: the shell discovers it through its timeout either way, but
     * without the line there is no evidence afterwards of which side failed. */
    await deps.emit(SHUTDOWN_DONE_EVENT).catch((error: unknown) => {
      try {
        deps.diagnostics.warn('shutdown.ack-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      } catch {
        /* The reporter of last resort must not be allowed to break the exit. */
      }
    })
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
