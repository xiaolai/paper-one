/**
 * WHEN to sync (WI-C.4), with no React and injectable time, so the trigger
 * logic runs under fake timers:
 *
 *   start          → one run
 *   visibility     → a run each time the app becomes visible again
 *   local commits  → a run 5 s after the LAST commit of a burst (debounce —
 *                    a page turn writes a position per turn, and a run per
 *                    write would sync mid-gesture)
 *   syncNow()      → a run now, debounce cancelled
 *
 * ONE run at a time. A trigger during a run marks it wanted-again and the
 * run is followed by exactly one more — triggers coalesce rather than queue.
 * Failures land in the run itself (the caller's `run` sets the status
 * store); the scheduler only sequences.
 */

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMERS: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const COMMIT_DEBOUNCE_MS = 5_000

export interface SchedulerOptions {
  /** One sync session. Must not throw — surface failures itself. */
  readonly run: () => Promise<void>
  /** The journal's local-commit feed (`journal.subscribe`). */
  readonly onLocalCommit: (listener: () => void) => () => void
  /** Visibility, injectable: `subscribe` fires on every change. Absent means
   *  no visibility trigger (a test, a headless run). */
  readonly visibility?: {
    state(): 'visible' | 'hidden'
    subscribe(listener: () => void): () => void
  }
  readonly debounceMs?: number
  readonly timers?: SchedulerTimers
}

export interface SyncScheduler {
  start(): void
  /** Run now: pending debounce cancelled, run coalesced with any in flight. */
  syncNow(): void
  stop(): void
}

export function createSyncScheduler({
  run,
  onLocalCommit,
  visibility,
  debounceMs = COMMIT_DEBOUNCE_MS,
  timers = REAL_TIMERS,
}: SchedulerOptions): SyncScheduler {
  let running = false
  let again = false
  let stopped = false
  let debounce: unknown = null
  const offs: (() => void)[] = []

  const kick = (): void => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    void (async () => {
      do {
        again = false
        await run()
      } while (again && !stopped)
      running = false
    })()
  }

  const armDebounce = (): void => {
    if (stopped) return
    if (debounce !== null) timers.clearTimeout(debounce)
    debounce = timers.setTimeout(() => {
      debounce = null
      kick()
    }, debounceMs)
  }

  return {
    start: () => {
      if (stopped) return
      offs.push(onLocalCommit(armDebounce))
      if (visibility) {
        offs.push(
          visibility.subscribe(() => {
            if (visibility.state() === 'visible') kick()
          }),
        )
      }
      kick()
    },
    syncNow: () => {
      if (debounce !== null) {
        timers.clearTimeout(debounce)
        debounce = null
      }
      kick()
    },
    stop: () => {
      stopped = true
      if (debounce !== null) {
        timers.clearTimeout(debounce)
        debounce = null
      }
      for (const off of offs.splice(0)) off()
    },
  }
}
