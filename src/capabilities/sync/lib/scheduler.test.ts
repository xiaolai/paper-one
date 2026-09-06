import { describe, expect, it } from 'vitest'
import {
  COMMIT_DEBOUNCE_MS,
  SYNC_EVERY_MS,
  SYNC_RETRY_MS,
  createSyncScheduler,
  type SchedulerTimers,
  type SyncOutcome,
} from './scheduler'

/**
 * WI-C.4 — the trigger logic, under a hand-driven clock: start runs once;
 * a burst of commits collapses to one run five seconds after the LAST;
 * visibility runs on visible only; overlapping triggers coalesce to one
 * follow-up; syncNow cancels the debounce; stop cancels everything.
 *
 * And since 2026-09-06, THE BACKSTOP: the cases below "the clock" are the ones
 * that had no test because there was no clock — a satchel nobody touches never
 * syncing again, and a retryable refusal never being retried. Both were
 * measured on two real Macs before they were written down; see the module
 * header.
 */

/** Hand-driven timers: `advance` runs what is due. */
function fakeTimers(): SchedulerTimers & { advance(ms: number): void; now: number } {
  let now = 0
  let nextId = 1
  const due = new Map<number, { at: number; fn: () => void }>()
  return {
    get now() {
      return now
    },
    setTimeout: (fn, ms) => {
      const id = nextId++
      due.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (handle) => void due.delete(handle as number),
    advance: (ms) => {
      now += ms
      for (const [id, entry] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue
        due.delete(id)
        entry.fn()
      }
    },
  }
}

function world(bounds: { everyMs?: number; retryMs?: number } = {}) {
  const timers = fakeTimers()
  const runs: number[] = []
  let release: ((outcome: SyncOutcome) => void) | null = null
  const commitListeners = new Set<() => void>()
  let visible: 'visible' | 'hidden' = 'visible'
  const visibilityListeners = new Set<() => void>()
  const scheduler = createSyncScheduler({
    ...bounds,
    run: () => {
      runs.push(timers.now)
      return new Promise<SyncOutcome>((resolve) => {
        release = resolve
      })
    },
    onLocalCommit: (fn) => {
      commitListeners.add(fn)
      return () => void commitListeners.delete(fn)
    },
    visibility: {
      state: () => visible,
      subscribe: (fn) => {
        visibilityListeners.add(fn)
        return () => void visibilityListeners.delete(fn)
      },
    },
    timers,
  })
  return {
    timers,
    runs,
    scheduler,
    commit: () => {
      for (const fn of commitListeners) fn()
    },
    setVisible: (state: 'visible' | 'hidden') => {
      visible = state
      for (const fn of visibilityListeners) fn()
    },
    /** Resolve the run in flight. The OUTCOME is what arms the next tick, so
     *  a test that cares about the clock has to say which one it means. */
    finish: async (outcome: SyncOutcome = 'ok') => {
      release?.(outcome)
      release = null
      /* Enough turns for the await, the loop condition and the `finally` that
         arms the backstop — the arming is the thing under test below, and a
         flush that stopped one turn short would report every clock case as a
         timer that never fired. */
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
    },
  }
}

describe('the sync scheduler', () => {
  it('runs once on start', async () => {
    const w = world()
    w.scheduler.start()
    expect(w.runs).toEqual([0])
    await w.finish()
    expect(w.runs).toEqual([0])
  })

  it('debounces a burst of commits to one run, five seconds after the last', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.commit()
    w.timers.advance(2_000)
    w.commit() // the burst continues — the clock restarts
    w.timers.advance(4_999)
    expect(w.runs).toHaveLength(1) // not yet
    w.timers.advance(1)
    expect(w.runs).toHaveLength(2) // 5 s after the LAST commit
    expect(w.runs[1]).toBe(2_000 + COMMIT_DEBOUNCE_MS)
    await w.finish()
  })

  it('runs when the app becomes visible, not when it hides', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.setVisible('hidden')
    expect(w.runs).toHaveLength(1)
    w.setVisible('visible')
    expect(w.runs).toHaveLength(2)
    await w.finish()
  })

  it('coalesces triggers during a run into exactly one follow-up', async () => {
    const w = world()
    w.scheduler.start() // run 1 begins and BLOCKS
    w.scheduler.syncNow()
    w.scheduler.syncNow()
    w.setVisible('visible')
    expect(w.runs).toHaveLength(1)
    await w.finish() // run 1 ends → ONE follow-up begins
    expect(w.runs).toHaveLength(2)
    await w.finish()
    expect(w.runs).toHaveLength(2)
  })

  it('syncNow cancels the pending debounce and runs at once', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.commit()
    w.timers.advance(1_000)
    w.scheduler.syncNow()
    expect(w.runs).toHaveLength(2)
    await w.finish()
    w.timers.advance(COMMIT_DEBOUNCE_MS * 2) // the cancelled debounce never fires
    expect(w.runs).toHaveLength(2)
  })

  it('stop cancels the debounce and unhooks every trigger', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.commit()
    w.scheduler.stop()
    w.timers.advance(COMMIT_DEBOUNCE_MS * 2)
    w.setVisible('visible')
    w.scheduler.syncNow()
    expect(w.runs).toHaveLength(1)
  })
  /* ── the clock ─────────────────────────────────────────────────────────
     A satchel is the side that dials, and every other trigger in this file is
     an event on THIS device. With nobody touching it there are none. */

  it('runs again on the backstop period with no event of any kind', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    expect(w.runs).toHaveLength(1)
    w.timers.advance(SYNC_EVERY_MS - 1)
    expect(w.runs).toHaveLength(1) // not a second early
    w.timers.advance(1)
    expect(w.runs).toHaveLength(2)
    expect(w.runs[1]).toBe(SYNC_EVERY_MS)
  })

  it('retries a FAILED session far sooner than the ordinary period', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish('failed')
    w.timers.advance(SYNC_RETRY_MS - 1)
    expect(w.runs).toHaveLength(1)
    w.timers.advance(1)
    /* The measured case: a satchel that dialled 1.2 s before the shelf's
       journal was ready is told `not-ready`, retryable, and used to stay that
       way for good. */
    expect(w.runs).toHaveLength(2)
    expect(w.runs[1]).toBe(SYNC_RETRY_MS)
  })

  it('doubles the retry after each failure and RESETS it on a success', async () => {
    const w = world()
    w.scheduler.start()

    await w.finish('failed') // next tick: 20 s
    w.timers.advance(SYNC_RETRY_MS)
    expect(w.runs).toHaveLength(2)

    await w.finish('failed') // next tick: 40 s — a shelf that is simply off
    w.timers.advance(SYNC_RETRY_MS)
    expect(w.runs).toHaveLength(2) // 20 s is no longer enough
    w.timers.advance(SYNC_RETRY_MS)
    expect(w.runs).toHaveLength(3)

    await w.finish('ok') // the period, and the backoff is forgotten
    w.timers.advance(SYNC_EVERY_MS)
    expect(w.runs).toHaveLength(4)

    await w.finish('failed')
    w.timers.advance(SYNC_RETRY_MS)
    /* THE RESET IS THE POINT. Without it a device that had a bad hour would
       stay on a five-minute retry through the good one that followed. */
    expect(w.runs).toHaveLength(5)
  })

  it('never backs off past the ordinary period', async () => {
    const w = world({ everyMs: 80, retryMs: 20 })
    w.scheduler.start()
    for (const wait of [20, 40, 80, 80, 80]) {
      await w.finish('failed')
      w.timers.advance(wait - 1)
      const before = w.runs.length
      w.timers.advance(1)
      expect(w.runs).toHaveLength(before + 1)
    }
  })

  it('a real trigger supersedes a pending tick rather than racing it', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.timers.advance(SYNC_EVERY_MS - 1_000)
    w.scheduler.syncNow() // an event, one second before the tick was due
    expect(w.runs).toHaveLength(2)
    await w.finish()
    w.timers.advance(1_000)
    /* The cancelled tick does not fire behind the run it was superseded by:
       the clock is a backstop UNDER the events, not a second schedule. */
    expect(w.runs).toHaveLength(2)
  })

  it('stop cancels the backstop as well as the debounce', async () => {
    const w = world()
    w.scheduler.start()
    await w.finish()
    w.scheduler.stop()
    w.timers.advance(SYNC_EVERY_MS * 3)
    expect(w.runs).toHaveLength(1)
  })

  it('a run that BREAKS its no-throw contract is retried, not swallowed', async () => {
    const timers = fakeTimers()
    const runs: number[] = []
    let explode = true
    const scheduler = createSyncScheduler({
      run: () => {
        runs.push(timers.now)
        if (explode) return Promise.reject(new Error('run broke its contract'))
        return Promise.resolve<SyncOutcome>('ok')
      },
      onLocalCommit: () => () => {},
      timers,
    })
    scheduler.start()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(runs).toHaveLength(1)
    explode = false
    timers.advance(SYNC_RETRY_MS)
    /* A scheduler that stopped scheduling because its callback threw would
       turn one bad session into a device that never syncs again — the exact
       failure the backstop exists to prevent, reintroduced inside it. */
    expect(runs).toHaveLength(2)
  })

  it('reports a broken contract through onBroken rather than only retrying it', async () => {
    /* RETRYING IS NOT THE SAME AS SAYING NOTHING. Reaching the catch at all
       means `run` broke its own type, which is a defect in `run` — not a
       failed sync. The scheduler stayed correct and the bug stayed invisible. */
    const timers = fakeTimers()
    const broken: unknown[] = []
    const boom = new Error('run broke its contract')
    const scheduler = createSyncScheduler({
      run: () => Promise.reject(boom),
      onLocalCommit: () => () => {},
      onBroken: (cause) => void broken.push(cause),
      timers,
    })
    scheduler.start()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(broken).toEqual([boom])
  })

  it('survives an onBroken that throws, because a reporter is not the scheduler', async () => {
    const timers = fakeTimers()
    const runs: number[] = []
    const scheduler = createSyncScheduler({
      run: () => {
        runs.push(timers.now)
        return Promise.reject(new Error('run broke its contract'))
      },
      onLocalCommit: () => () => {},
      onBroken: () => {
        throw new Error('the reporter is broken too')
      },
      timers,
    })
    scheduler.start()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(runs).toHaveLength(1)
    timers.advance(SYNC_RETRY_MS)
    /* The backstop still armed. A reporter taking the scheduler down with it
       would be the swallowed-failure defect wearing the fix's clothes. */
    expect(runs).toHaveLength(2)
  })

  it('a backstop that fires first does not leave a debounce to run a second session', async () => {
    /* THE RACE THE MODULE'S OWN COMMENT DESCRIBES, in the direction it did not
       handle. "A commit at 4m59s must not be followed by a second session one
       second later for nothing" — but the cancel only ran when a real trigger
       beat the clock. With the clock first, the commit's debounce survived and
       fired four seconds after the session that had already carried it. */
    const w = world()
    w.scheduler.start()
    await w.finish('ok') // arms the backstop at SYNC_EVERY_MS
    w.timers.advance(SYNC_EVERY_MS - 1_000) // 4m59s
    w.commit() // debounce due at 5m04s
    expect(w.runs).toHaveLength(1)
    w.timers.advance(1_000) // 5m00s — the BACKSTOP fires
    expect(w.runs).toHaveLength(2)
    await w.finish('ok')
    w.timers.advance(COMMIT_DEBOUNCE_MS)
    /* Two sessions, not three: the one the clock started subsumed the commit
       that was still waiting. */
    expect(w.runs).toHaveLength(2)
  })

  it('a success inside a coalesced run resets the backoff the next failure uses', async () => {
    /* EVERY SESSION MOVES THE LADDER, NOT JUST THE LAST. Triggers coalesce, so
       one run can be several sessions; reading only the final outcome dropped
       the successes in between. Here: fail, fail (ladder 20 -> 40 -> 80), then
       a coalesced run whose first session SUCCEEDS and whose second fails. The
       success resets to 20, so the failure must arm 20 — not the 80 the old
       code carried through untouched. */
    const w = world()
    w.scheduler.start()
    await w.finish('failed') // arms 20s, ladder -> 40
    w.timers.advance(SYNC_RETRY_MS)
    await w.finish('failed') // arms 40s, ladder -> 80
    w.timers.advance(SYNC_RETRY_MS * 2)
    expect(w.runs).toHaveLength(3)
    /* A commit lands DURING this session, so it coalesces into a second one. */
    w.commit()
    w.timers.advance(COMMIT_DEBOUNCE_MS)
    await w.finish('ok') // first session of the run succeeds -> ladder back to 20
    expect(w.runs).toHaveLength(4) // the coalesced follow-up started
    await w.finish('failed') // and it fails
    w.timers.advance(SYNC_RETRY_MS)
    expect(w.runs).toHaveLength(5)
  })
})
