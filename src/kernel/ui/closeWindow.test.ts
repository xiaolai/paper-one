import { describe, expect, it, vi } from 'vitest'
import { createCloseSequence, type CloseSteps } from './closeWindow'

/**
 * THE WINDOW ALWAYS CLOSES.
 *
 * The close handler calls `preventDefault()` before it does anything else — it
 * has to, or the window goes while writes are in flight — so from that moment
 * the window closes only because this code closes it. The original four lines
 * had no failure path at all: a throw from the flush, a rejected drain, or a
 * failed destroy rejected the async listener and left the reader with a window
 * that would not close and no message saying why.
 *
 * These cases are the reason that cannot come back quietly.
 */
describe('the close sequence', () => {
  const steps = (over: Partial<CloseSteps> = {}) => {
    const done: string[] = []
    const reports: string[] = []
    const base: CloseSteps = {
      flush: () => void done.push('flush'),
      drain: async () => void done.push('drain'),
      destroy: async () => void done.push('destroy'),
      timeoutMs: 50,
      report: (message) => void reports.push(message),
      ...over,
    }
    return { base, done, reports }
  }

  it('flushes, drains, then destroys, in that order', async () => {
    const { base, done } = steps()
    await createCloseSequence(base)()
    expect(done).toEqual(['flush', 'drain', 'destroy'])
  })

  it('still closes when the flush throws', async () => {
    const { base, done, reports } = steps({
      flush: () => {
        throw new Error('a note would not serialise')
      },
    })
    await createCloseSequence(base)()
    expect(done).toContain('destroy')
    expect(reports.join(' ')).toMatch(/hand over unsaved work/)
  })

  /* THE ONE THAT LEFT A WINDOW STUCK. `Promise.race` rejects when its first
     settled promise rejects, so a drain that failed early took the destroy
     with it and the listener rejected after `preventDefault`. */
  it('still closes when the drain rejects', async () => {
    const { base, done, reports } = steps({
      drain: async () => {
        throw new Error('the queue is wedged')
      },
    })
    await createCloseSequence(base)()
    expect(done, 'a rejected drain stopped the window closing').toContain('destroy')
    expect(reports.join(' ')).toMatch(/did not drain/)
  })

  it('reports a failed destroy rather than rejecting into the listener', async () => {
    const { base, reports } = steps({
      destroy: async () => {
        throw new Error('the window is gone')
      },
    })
    await expect(createCloseSequence(base)()).resolves.toBeUndefined()
    expect(reports.join(' ')).toMatch(/could not close the window/)
  })

  /* A DRAIN THAT NEVER FINISHES MUST NOT HOLD THE WINDOW. The bound is a
     liveness bound — the point past which waiting is worse than losing the
     tail — not an assertion about how long a drain takes. */
  it('closes on the bound when the drain never settles', async () => {
    vi.useFakeTimers()
    try {
      const { base, done } = steps({ drain: () => new Promise<void>(() => {}), timeoutMs: 2000 })
      const closing = createCloseSequence(base)()
      await vi.advanceTimersByTimeAsync(2000)
      await closing
      expect(done).toContain('destroy')
    } finally {
      vi.useRealTimers()
    }
  })

  /* CLOSES ONCE. A second request while the first was draining used to start a
     second teardown, so two drains and two destroys raced. */
  it('runs one teardown however many times it is asked', async () => {
    const { base, done } = steps()
    const close = createCloseSequence(base)
    await Promise.all([close(), close(), close()])
    expect(done.filter((one) => one === 'destroy')).toHaveLength(1)
    expect(done.filter((one) => one === 'drain')).toHaveLength(1)
  })
})
