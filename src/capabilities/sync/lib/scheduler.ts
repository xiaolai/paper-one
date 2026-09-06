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
 *   the clock      → a BACKSTOP run, armed after every run finishes
 *
 * ONE run at a time. A trigger during a run marks it wanted-again and the
 * run is followed by exactly one more — triggers coalesce rather than queue.
 * Failures land in the run itself (the caller's `run` sets the status
 * store); the scheduler only sequences.
 *
 * ## ⚠️ THE CLOCK, AND WHY IT WAS MISSING
 *
 * Until 2026-09-06 the four triggers above were the whole set, and every one
 * of them is an EVENT ON THIS DEVICE. A shelf has no scheduler at all — it
 * answers satchels, it does not dial them — so on a satchel nobody is
 * touching, nothing whatever fires after the run at launch. A book added on
 * the shelf an hour later has no event on the satchel to notice it, and waits
 * for the reader to come back and do something.
 *
 * That was measured rather than reasoned: phase 24's Stage B ran the two-Mac
 * harness, every mutation succeeded and every convergence failed, and the
 * transcript recorded it as *"the satchel is wedged"*. It was not wedged. It
 * had synced once, correctly, and had no reason to sync again.
 *
 * **And it made `retryable: true` a lie.** `groupRefusal` in `ledger.ts` ends
 * the session on a retryable refusal deliberately and argues it well — the
 * reader sees a failure rather than a finished sync with a book quietly left
 * behind. That is right, AND IT IS ONLY RIGHT IF SOMETHING RETRIES. Nothing
 * did. Stage B's satchel lost a startup race by 1.2 s, was told `not-ready`
 * (*"the journal is still building its baseline"*, flagged retryable), and
 * stayed that way until a human intervened.
 *
 * So a run now reports its OUTCOME and the next tick is armed from it: soon
 * after a failure, with a bounded backoff, and at the ordinary period after a
 * success.
 *
 * ## Why this is not `createCadence`
 *
 * `capabilities/circle/lib/cadence.ts` is the same SHAPE — re-arm after the
 * run rather than `setInterval`, so a session outlasting its period is
 * followed rather than overlapped — and it is deliberately not reused. A
 * capability may not import from another capability, which is the rule that
 * had `messageOf` reinvented wrong twice before it moved into the kernel; and
 * the two POLICIES differ in the way that matters. The circle's cadence
 * subscribes to nothing on purpose, because pull-on-open would leak the
 * reader's sequence to a peer. Sync's clock is a backstop UNDER four event
 * triggers, and it defers to them: any trigger cancels a pending tick rather
 * than running beside it. Extracting the fifteen lines they share would couple
 * two policies whose difference is the point.
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

/**
 * The backstop period, after a session that WORKED.
 *
 * Five minutes, the same number `capabilities/circle/lib/cadence.ts` chose and
 * for a compatible reason — but it carries less weight here, because this is
 * not the responsive path. A reader doing anything on this device produces a
 * local commit, and a window coming back produces a visibility trigger; both
 * beat the clock and both cancel it. This is what closes the gap for a satchel
 * with nobody in front of it, where the alternative was never.
 */
export const SYNC_EVERY_MS = 5 * 60_000

/**
 * The first delay after a session that FAILED, doubling to `SYNC_EVERY_MS`.
 *
 * Twenty seconds because the failure this exists for resolves in about one:
 * a satchel that dialled before the shelf's journal finished its baseline is
 * told `not-ready`, and the shelf is ready moments later. Retrying at the
 * five-minute period would leave a reader looking at a stale library for five
 * minutes after a race that lasted a second.
 *
 * ⚠️ **AND IT BACKS OFF, because the other shape of failure is a shelf that is
 * simply off.** A fixed twenty seconds would dial a machine in a closet three
 * times a minute for as long as it stayed down. Each failure doubles the wait
 * to a ceiling of `SYNC_EVERY_MS`, and one success resets it — so the common
 * case is fast and the absent-shelf case costs no more than the ordinary
 * period.
 */
export const SYNC_RETRY_MS = 20_000

/** What one session did. The scheduler needs to be told, because it decides
 *  when the next one is — see `SYNC_RETRY_MS`. */
export type SyncOutcome = 'ok' | 'failed'

export interface SchedulerOptions {
  /** One sync session. Must not throw — surface failures itself — and must
   *  say whether it worked, which is what arms the next tick. */
  readonly run: () => Promise<SyncOutcome>
  /** The journal's local-commit feed (`journal.subscribe`). */
  readonly onLocalCommit: (listener: () => void) => () => void
  /** Visibility, injectable: `subscribe` fires on every change. Absent means
   *  no visibility trigger (a test, a headless run). */
  readonly visibility?: {
    state(): 'visible' | 'hidden'
    subscribe(listener: () => void): () => void
  }
  readonly debounceMs?: number
  /**
   * `run` threw, which its own type forbids.
   *
   * Optional because the scheduler must work without one — a test, a headless
   * run — and because it reports a CONTRACT VIOLATION rather than a failed
   * sync: a failure is `run`'s own to describe, and it already does. This
   * fires only when `run` broke the promise not to throw, so a caller that
   * binds it is told about a defect it would otherwise never see.
   */
  readonly onBroken?: (cause: unknown) => void
  /** The backstop period after a successful session. */
  readonly everyMs?: number
  /** The first backstop delay after a failed one, doubling to `everyMs`. */
  readonly retryMs?: number
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
  onBroken,
  everyMs = SYNC_EVERY_MS,
  retryMs = SYNC_RETRY_MS,
  timers = REAL_TIMERS,
}: SchedulerOptions): SyncScheduler {
  let running = false
  let again = false
  let stopped = false
  let debounce: unknown = null
  let backstop: unknown = null
  /** The NEXT delay to use after a failure; reset by any success. */
  let backoff = retryMs
  const offs: (() => void)[] = []

  const cancelBackstop = (): void => {
    if (backstop === null) return
    timers.clearTimeout(backstop)
    backstop = null
  }

  const armBackstop = (ms: number): void => {
    if (stopped) return
    cancelBackstop()
    backstop = timers.setTimeout(() => {
      backstop = null
      kick()
    }, ms)
  }

  const cancelDebounce = (): void => {
    if (debounce === null) return
    timers.clearTimeout(debounce)
    debounce = null
  }

  const kick = (): void => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    /* A REAL TRIGGER SUPERSEDES A PENDING TICK rather than racing it. The
       clock is a backstop under the events, so a commit at 4m59s must not be
       followed by a second session one second later for nothing. */
    cancelBackstop()
    /* AND THE SAME RACE RUNS THE OTHER WAY, which the sentence above describes
       and the first version did not handle: a commit at 4m59s arms a debounce
       for 5m04s, the BACKSTOP fires first at 5m00s, and the debounce then runs
       a second session four seconds later for a write the first one already
       carried. Whatever starts a session subsumes every trigger already
       waiting, so the pending debounce is cancelled here rather than only in
       `syncNow`. A commit that lands DURING the run re-arms it, and is picked
       up by that next session. */
    cancelDebounce()
    void (async () => {
      let last: SyncOutcome = 'failed'
      /* WHAT TO ARM IF THIS ENDS ON A FAILURE — the delay that failure earned,
         captured when it happens rather than read off `backoff` at the end.
         See `noteOutcome`. */
      let nextIn = backoff
      /* EVERY SESSION MOVES THE BACKOFF, NOT JUST THE LAST ONE. Triggers
         coalesce into one follow-up, so a run can be several sessions, and
         reading only the final outcome silently dropped every earlier one: a
         success at 80s followed by a failure re-armed 80s, because the success
         that should have reset the ladder to 20s was never seen. */
      const noteOutcome = (outcome: SyncOutcome): void => {
        if (outcome === 'ok') {
          backoff = retryMs
          return
        }
        nextIn = backoff
        backoff = Math.min(backoff * 2, everyMs)
      }
      try {
        do {
          again = false
          last = await run()
          noteOutcome(last)
        } while (again && !stopped)
      } catch (cause) {
        /* `run` is contracted not to throw, and this is not trust in that
           contract. A scheduler that stops scheduling because its callback
           broke it would turn one bad session into a device that never syncs
           again — which is the exact failure the backstop exists to prevent,
           reintroduced inside the fix for it. Treated as a failed session, so
           it is retried rather than swallowed.
           ⚠️ BUT RETRYING IS NOT THE SAME AS SAYING NOTHING. Reaching here at
           all means `run` broke its own contract, which is a defect in `run`
           and not a failed sync; swallowing it left the scheduler correct and
           the bug invisible. `onBroken` is how it gets said, and it is guarded
           because a reporter that throws must not take the scheduler with it. */
        last = 'failed'
        noteOutcome(last)
        try {
          onBroken?.(cause)
        } catch {
          /* Nothing left to report it to. */
        }
      } finally {
        running = false
        armBackstop(last === 'ok' ? everyMs : nextIn)
      }
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
      /* `kick` cancels it too; doing it here as well keeps "sync now clears
         the pending debounce" true even when a run is already in flight and
         `kick` only sets `again`. */
      cancelDebounce()
      kick()
    },
    stop: () => {
      stopped = true
      cancelDebounce()
      cancelBackstop()
      for (const off of offs.splice(0)) off()
    },
  }
}
