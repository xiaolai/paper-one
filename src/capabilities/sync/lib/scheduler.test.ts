import { describe, expect, it } from 'vitest'
import { COMMIT_DEBOUNCE_MS, createSyncScheduler, type SchedulerTimers } from './scheduler'

/**
 * WI-C.4 — the trigger logic, under a hand-driven clock: start runs once;
 * a burst of commits collapses to one run five seconds after the LAST;
 * visibility runs on visible only; overlapping triggers coalesce to one
 * follow-up; syncNow cancels the debounce; stop cancels everything.
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

function world() {
  const timers = fakeTimers()
  const runs: number[] = []
  let release: (() => void) | null = null
  const commitListeners = new Set<() => void>()
  let visible: 'visible' | 'hidden' = 'visible'
  const visibilityListeners = new Set<() => void>()
  const scheduler = createSyncScheduler({
    run: () => {
      runs.push(timers.now)
      return new Promise<void>((resolve) => {
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
    finish: async () => {
      release?.()
      release = null
      await Promise.resolve()
      await Promise.resolve()
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
})
