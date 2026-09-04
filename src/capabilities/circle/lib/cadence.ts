/**
 * WHEN the circle fetches — WI-23.A2's clock, with no React and injectable
 * time so the trigger logic runs under fake timers.
 *
 * ## Time is the only input, and that is the design
 *
 * ⚠️ **NEVER ON OPENING A BOOK, and `wire.md` says why:** *"Pull-on-open
 * leaks your reading sequence to the peer."* A fetch that starts the moment a
 * book opens tells every friend which book that was; a cadence that runs over
 * every book on the shelf tells them nothing about which one is open. So this
 * subscribes to NOTHING — not the library, not the journal, not visibility.
 * `createSyncScheduler` fires five seconds after every local commit, and a
 * book being opened IS a local commit (`openedAt`), which is exactly why the
 * circle does not ride it: that would be pull-on-open wearing a timer.
 *
 * The falsifier is structural rather than measured: there is no input here a
 * book could reach.
 *
 * ## One run at a time
 *
 * The next run is armed only after the previous one has finished, so a round
 * that outlasts the period is followed rather than overlapped — two rounds
 * interleaving their writes to one person's file would race on the cursor.
 */

import { isThenable } from './listeners'

export interface CadenceTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: CadenceTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Half a minute after start, then every five minutes.
 *
 * The first delay is what keeps launch — and a book reopened at launch — off
 * the wire: the round is timed from `start`, never from an open. Five minutes
 * is the plan's "one cadence": a passage shared on A appears in B's book
 * within it, with B having opened nothing.
 */
export const CIRCLE_FIRST_FETCH_MS = 30_000
export const CIRCLE_FETCH_EVERY_MS = 5 * 60_000

export interface CadenceOptions {
  /** One round. Must not throw — a round reports its own failures. */
  readonly run: () => Promise<void>
  readonly firstAfterMs?: number
  readonly everyMs?: number
  readonly timers?: CadenceTimers
  /** Told the cause of a round that threw. The cadence goes on either way, and does not wait on it: a reporter that rejects is said, not left unhandled. */
  readonly failed?: (cause: unknown) => void | Promise<void>
}

export interface Cadence {
  start(): void
  stop(): void
}

export function createCadence({
  run,
  failed,
  firstAfterMs = CIRCLE_FIRST_FETCH_MS,
  everyMs = CIRCLE_FETCH_EVERY_MS,
  timers = REAL_TIMERS,
}: CadenceOptions): Cadence {
  let stopped = false
  /** Whether a round is in flight between one timer and the next. */
  let running = false
  let armed: unknown = null

  const arm = (ms: number): void => {
    if (stopped) return
    armed = timers.setTimeout(() => {
      armed = null
      running = true
      void (async () => {
        try {
          await run()
        } catch (cause) {
          /* A round that throws is a round that did not report itself; the
             cadence goes on, because one bad round must not end every round
             after it — and the cause is handed out, because a round that
             fails every time and says nothing is a circle that silently
             stopped fetching. The telling is guarded too: a reporter that
             throws must not be the thing that stops the clock. */
          try {
            const told: unknown = failed?.(cause)
            /* A thenable from anywhere, not `instanceof Promise` — see `isThenable`. */
            if (isThenable(told)) {
              told.then(undefined, (thrown: unknown) => {
                console.error('Paper: the circle could not report a failed round', thrown)
              })
            }
          } catch (thrown) {
            console.error('Paper: the circle could not report a failed round', thrown)
          }
        } finally {
          // Stryker disable next-line BooleanLiteral: the next round is armed on the line after whatever this says, and `start` is refused while a timer is armed; a flag left true changes no timing a test can see.
          running = false
          arm(everyMs)
        }
      })()
    }, ms)
  }

  return {
    start: () => {
      /* Idempotent through a whole round, not only while the timer is armed:
         a second start during a run would arm a second chain beside it. */
      if (stopped || armed !== null || running) return
      arm(firstAfterMs)
    },
    stop: () => {
      stopped = true
      if (armed !== null) {
        timers.clearTimeout(armed)
        armed = null
      }
    },
  }
}
