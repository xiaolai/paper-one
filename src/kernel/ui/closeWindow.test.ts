import { describe, expect, it, vi } from 'vitest'
import {
  CLOSE_DRAIN_MS,
  CLOSE_HOLD_MS,
  QUIESCE_GRACE_MS,
  closePrepare,
  createCloseSequence,
  type CloseSteps,
} from './closeWindow'

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
      prepare: async () => void done.push('prepare'),
      destroy: async () => void done.push('destroy'),
      timeoutMs: 50,
      report: (message) => void reports.push(message),
      ...over,
    }
    return { base, done, reports }
  }

  it('prepares, then destroys, in that order', async () => {
    const { base, done, reports } = steps()
    await createCloseSequence(base)()
    expect(done).toEqual(['prepare', 'destroy'])
    expect(reports).toEqual([])
  })

  /* THE ONE THAT LEFT A WINDOW STUCK. `Promise.race` rejects when its first
     settled promise rejects, so a step that failed early took the destroy
     with it and the listener rejected after `preventDefault`. */
  it('still closes when the preparation rejects', async () => {
    const { base, done, reports } = steps({
      prepare: async () => {
        throw new Error('the queue is wedged')
      },
    })
    await createCloseSequence(base)()
    expect(done, 'a rejected teardown stopped the window closing').toContain('destroy')
    expect(reports.join(' ')).toMatch(/teardown before closing failed/)
    expect(reports.join(' ')).not.toMatch(/journal may be left dirty/)
  })

  it('still closes when the preparation throws rather than rejects', async () => {
    const { base, done, reports } = steps({
      prepare: () => {
        throw new Error('synchronous')
      },
    })
    await createCloseSequence(base)()
    expect(done).toContain('destroy')
    expect(reports.join(' ')).toMatch(/teardown before closing failed/)
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

  /* A TEARDOWN THAT NEVER FINISHES MUST NOT HOLD THE WINDOW. The bound is a
     liveness bound — the point past which waiting is worse than losing the
     tail — not an assertion about how long a teardown takes. And it is SAID:
     a cut-off teardown leaves the journal's flag up, which nothing else
     reports. */
  it('closes on the bound when the preparation never settles, and says the journal may be dirty', async () => {
    vi.useFakeTimers()
    try {
      const { base, done, reports } = steps({ prepare: () => new Promise<void>(() => {}), timeoutMs: 3000 })
      const closing = createCloseSequence(base)()
      await vi.advanceTimersByTimeAsync(3000)
      await closing
      expect(done).toContain('destroy')
      expect(reports.join(' ')).toMatch(/journal may be left dirty/)
    } finally {
      vi.useRealTimers()
    }
  })

  /* CLOSES ONCE. A second request while the first was draining used to start a
     second teardown, so two drains and two destroys raced. */
  /* THE REPORTER CANNOT BREAK THE SEQUENCE. A diagnostics sink that is
     itself failing is the likely companion of any other failure, and a
     reporter that threw escaped the very catch it was called from — past the
     destroy, leaving the window the file exists to close. Every failure path
     is exercised with a reporter that throws on every call. */
  it('still closes, and still resolves, when the reporter itself throws at every turn', async () => {
    const { base, done } = steps({
      prepare: async () => {
        throw new Error('the teardown failed')
      },
      report: () => {
        throw new Error('the diagnostics store is gone too')
      },
    })
    await expect(createCloseSequence(base)()).resolves.toBeUndefined()
    expect(done).toEqual(['destroy'])
    /* And the bound path, where the report used to sit outside any guard. */
    const stalled = steps({
      prepare: () => new Promise(() => {}),
      report: () => {
        throw new Error('still gone')
      },
    })
    await expect(createCloseSequence(stalled.base)()).resolves.toBeUndefined()
    expect(stalled.done).toEqual(['destroy'])
    /* And a destroy that fails under a throwing reporter does not reject. */
    const broken = steps({
      destroy: async () => {
        throw new Error('the window would not close')
      },
      report: () => {
        throw new Error('gone')
      },
    })
    await expect(createCloseSequence(broken.base)()).resolves.toBeUndefined()
  })

  /* STEPPED OVER, NOT SWALLOWED. A reporter that throws must not stop the
     close, and must not take the failure it was carrying with it either: both
     go to the console, with the reporter's own failure beside them. */
  it('hands the failure, and the failure of the reporter, to the console when the reporter throws', async () => {
    const failed = new Error('the teardown failed')
    const reporterFailed = new Error('the diagnostics store is gone too')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { base } = steps({
        prepare: async () => {
          throw failed
        },
        report: () => {
          throw reporterFailed
        },
      })
      await createCloseSequence(base)()
      expect(consoleError).toHaveBeenCalledWith('Paper: the teardown before closing failed', failed, reporterFailed)
    } finally {
      consoleError.mockRestore()
    }
  })

  /* A prepare that settles in milliseconds must not leave the bound's timer,
     and its closure, alive for the rest of the hold. */
  it('leaves no timer behind when the preparation settles inside the bound', async () => {
    vi.useFakeTimers()
    try {
      const { base, done } = steps({ timeoutMs: CLOSE_HOLD_MS })
      await createCloseSequence(base)()
      expect(done).toEqual(['prepare', 'destroy'])
      expect(vi.getTimerCount(), 'the bound was left armed after the teardown finished').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  /* The bound is armed by the platform's timer, and a timer that cannot be
     armed is one more failure to report and step over — never a window that
     stays open because the wait could not be set up. */
  it('still closes, and says it could not wait, when the bound cannot be armed', async () => {
    const { base, done, reports } = steps()
    vi.stubGlobal('setTimeout', () => {
      throw new Error('no timers here')
    })
    let closing: Promise<void>
    try {
      closing = createCloseSequence(base)()
    } finally {
      vi.unstubAllGlobals()
    }
    await expect(closing).resolves.toBeUndefined()
    expect(done).toContain('destroy')
    expect(reports).toContain('Paper: could not wait for the teardown before closing')
  })

  /* THE HOLD COVERS THE DRAIN'S WHOLE BOUND AND WHAT FOLLOWS IT. A drain that
     uses every millisecond it is allowed, then a journal close well inside the
     grace, is a teardown that finished — and a hold no longer than the drain
     would cut off exactly the part that closes the journal. */
  it('holds the window through a drain that uses its whole bound and the close after it', async () => {
    vi.useFakeTimers()
    try {
      const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
      const { base, done, reports } = steps({
        prepare: async () => {
          await wait(CLOSE_DRAIN_MS)
          done.push('drained')
          await wait(QUIESCE_GRACE_MS / 2)
          done.push('journal closed')
        },
        timeoutMs: CLOSE_HOLD_MS,
      })
      const closing = createCloseSequence(base)()
      await vi.advanceTimersByTimeAsync(CLOSE_HOLD_MS)
      await closing
      expect(done).toEqual(['drained', 'journal closed', 'destroy'])
      expect(reports).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs one teardown however many times it is asked', async () => {
    const { base, done } = steps()
    const close = createCloseSequence(base)
    await Promise.all([close(), close(), close()])
    expect(done.filter((one) => one === 'destroy')).toHaveLength(1)
    expect(done.filter((one) => one === 'prepare')).toHaveLength(1)
  })
})

/**
 * The kernel's own preparation — a host with nothing composed to tear down.
 * Each half fails on its own and the other still runs.
 */
describe('closePrepare', () => {
  it('flushes, then drains', async () => {
    const done: string[] = []
    await closePrepare(() => void done.push('flush'), async () => {}, async () => void done.push('drain'), () => {})()
    expect(done).toEqual(['flush', 'drain'])
  })

  /* ⚠️ **AND WAITS FOR WHAT IS STILL RUNNING BEFORE IT DRAINS** (2026-09-13
     audit, #96). An import mid-copy hands its shelf writes over a batch behind
     the copying; a drain that does not wait for it declares the queue empty
     first. `App` used to await its import's stop ahead of this function, which
     covered this path and not ⌘Q's — so the wait moved into the one list both
     paths ask, and this is where the window close asks it. */
  it('waits for what must settle between the flush and the drain', async () => {
    const done: string[] = []
    let letGo: () => void = () => {}
    const stopping = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const closing = closePrepare(
      () => void done.push('flush'),
      async () => {
        done.push('stop')
        await stopping
        done.push('let go')
      },
      async () => void done.push('drain'),
      () => {},
    )()
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect(done, 'the queue was drained under an import still copying').toEqual(['flush', 'stop'])
    letGo()
    await closing
    expect(done).toEqual(['flush', 'stop', 'let go', 'drain'])
  })

  it('still drains when the settle rejects, and reports it', async () => {
    const done: string[] = []
    const reports: string[] = []
    await closePrepare(
      () => {},
      async () => {
        throw new Error('the import would not stop')
      },
      async () => void done.push('drain'),
      (message) => void reports.push(message),
    )()
    expect(done).toEqual(['drain'])
    expect(reports.join(' ')).toMatch(/did not finish before the drain/)
  })

  it('still drains when the flush throws, and reports it', async () => {
    const done: string[] = []
    const reports: string[] = []
    await closePrepare(
      () => {
        throw new Error('a note would not serialise')
      },
      async () => {},
      async () => void done.push('drain'),
      (message) => void reports.push(message),
    )()
    expect(done).toEqual(['drain'])
    expect(reports.join(' ')).toMatch(/hand over unsaved work/)
  })

  it('still drains when the flush throws AND the reporter throws — the two halves stay independent', async () => {
    const done: string[] = []
    await closePrepare(
      () => {
        throw new Error('a note would not serialise')
      },
      async () => {},
      async () => void done.push('drain'),
      () => {
        throw new Error('and the reporter is broken')
      },
    )()
    expect(done).toEqual(['drain'])
  })

  it('resolves when the drain rejects, and reports it', async () => {
    const reports: string[] = []
    await expect(
      closePrepare(
        () => {},
        async () => {},
        async () => {
          throw new Error('the queue is wedged')
        },
        (message) => void reports.push(message),
      )(),
    ).resolves.toBeUndefined()
    expect(reports.join(' ')).toMatch(/did not drain/)
  })
})
