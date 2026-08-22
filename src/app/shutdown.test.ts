import { describe, expect, it, vi } from 'vitest'
import { SHUTDOWN_DONE_EVENT, SHUTDOWN_EVENT, armShutdown, armShutdownInBackground, type ShutdownDeps } from './shutdown'

/**
 * THE QUIT HANDSHAKE — the cross-language path nothing could reach.
 *
 * It lived inline in a three-hundred-line boot function that reads `document`,
 * mounts a React root and imports a native module, so none of its ordering,
 * bounding or failure paths had ever been executed by a test. Two of the
 * defects recorded in its own comments were found by quitting the app and
 * watching what happened, which is the most expensive way to find anything.
 *
 * Every case below is an ordering or a bound. What they have in common: when
 * one of them is wrong the app still starts, still reads books, and still
 * quits — it simply loses the last thing the reader did, or takes the shell's
 * whole grace period to close, and neither says anything.
 */

/** A shell whose `paper://shutdown` the test fires by hand. */
function shell(over: Partial<ShutdownDeps> = {}) {
  const order: string[] = []
  /** Resolved by `emit`, so a test can await the answer under fake timers. */
  let answered: (() => void) | null = null
  const emitted: string[] = []
  const listeners = new Map<string, () => void>()
  let unlistened = 0
  const lifetime = new AbortController()
  const deps: ShutdownDeps = {
    listen: async (event, handler) => {
      listeners.set(event, handler)
      return () => {
        unlistened += 1
        listeners.delete(event)
      }
    },
    emit: async (event) => {
      emitted.push(event)
      answered?.()
    },
    flush: () => void order.push('flush'),
    drain: async () => void order.push('drain'),
    abort: () => {
      order.push('abort')
      lifetime.abort()
    },
    journalClosed: async () => void order.push('journalClosed'),
    signal: lifetime.signal,
    graceMs: 2_000,
    diagnostics: { warn: () => {}, info: () => {}, error: () => {} } as unknown as ShutdownDeps['diagnostics'],
    ...over,
  }
  return {
    deps,
    order,
    emitted,
    unlistened: () => unlistened,
    listening: () => listeners.has(SHUTDOWN_EVENT),
    lifetime,
    /**
     * Fire the shell's request. Resolves when the app answers.
     *
     * The promise is armed BEFORE the handler runs, so a teardown that
     * answers synchronously cannot settle before anything is listening.
     */
    quit: () => {
      const done = new Promise<void>((resolve) => {
        answered = resolve
      })
      listeners.get(SHUTDOWN_EVENT)?.()
      return done
    },
  }
}

describe('the teardown order', () => {
  /**
   * FLUSH, DRAIN, ABORT, JOURNAL — and the order is the whole thing.
   *
   * A queue can only drain what it has been GIVEN, so the flush comes first:
   * the thing most likely to be lost is the thing not yet handed over, a note
   * being typed or a reading position still inside its throttle. And the abort
   * comes LAST of the three, because aborting unbinds the recorder and closes
   * the journal — anything drained after it would reach disk with no journal
   * entry, which is unreplicable.
   */
  it('flushes, drains, aborts and waits for the journal, in that order', async () => {
    const world = shell()
    await armShutdown(world.deps)
    await world.quit()
    expect(world.order).toEqual(['flush', 'drain', 'abort', 'journalClosed'])
  })

  it('answers the shell exactly once, and only when it is done', async () => {
    const world = shell()
    await armShutdown(world.deps)
    await world.quit()
    expect(world.emitted).toEqual([SHUTDOWN_DONE_EVENT])
    expect(world.order.at(-1)).toBe('journalClosed')
  })

  /**
   * A WEDGED QUEUE DELAYS A QUIT; IT MUST NOT PREVENT ONE.
   *
   * The shell has its own grace period and exits when it runs out — so an
   * unbounded wait here does not keep the app alive, it just guarantees the
   * journal is never closed cleanly.
   */
  it('gives up on a drain that never finishes and carries on', async () => {
    vi.useFakeTimers()
    try {
      /* A drain that never settles is the wedged queue this bound exists for. */
      const world = shell({ drain: () => new Promise<void>(() => {}) })
      await armShutdown(world.deps)
      const answered = world.quit()
      /* Nothing has happened past the flush while the grace period runs. */
      await vi.advanceTimersByTimeAsync(world.deps.graceMs - 1)
      expect(world.order).toEqual(['flush'])
      await vi.advanceTimersByTimeAsync(2)
      await answered
      expect(world.order).toEqual(['flush', 'abort', 'journalClosed'])
      expect(world.emitted).toEqual([SHUTDOWN_DONE_EVENT])
      expect(world.deps.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A TEARDOWN THAT THREW MUST STILL RELEASE THE QUIT.
   *
   * Otherwise one capability's bug makes the app take the shell's whole grace
   * period to close, every time, for everybody — and the reader is told
   * nothing at all.
   */
  it('answers the shell even when the teardown throws, and reports why', async () => {
    for (const broken of [
      { flush: () => { throw new Error('flush failed') } },
      { drain: async () => { throw new Error('drain failed') } },
      { abort: () => { throw new Error('abort failed') } },
      { journalClosed: async () => { throw new Error('journal failed') } },
    ] as Partial<ShutdownDeps>[]) {
      const said: string[] = []
      const world = shell({
        ...broken,
        diagnostics: { warn: (event: string) => said.push(event) } as unknown as ShutdownDeps['diagnostics'],
      })
      await armShutdown(world.deps)
      await world.quit()
      expect(world.emitted).toEqual([SHUTDOWN_DONE_EVENT])
      /* AND IT IS REPORTED. This ran as `void runTeardown(…)` from an event
       * listener, so a failure escaped as an UNHANDLED REJECTION on the way
       * out of the app — the `finally` still released the quit, so nothing
       * looked wrong, and the only report that a shutdown did not finish was
       * lost at the one moment it matters. */
      expect(said).toEqual(['shutdown.teardown-failed'])
    }
  })

  /* AND AN `emit` THAT FAILS IS NOT AN UNHANDLED REJECTION. The shell will
   * time out and quit anyway; a rejection escaping here would surface as a
   * crash on the way out. */
  it('does not throw when the answer itself cannot be sent', async () => {
    let attempted = 0
    const world = shell({
      emit: async () => {
        attempted += 1
        throw new Error('the shell has gone')
      },
    })
    await armShutdown(world.deps)
    /* The shell will time out and quit anyway; a rejection escaping here would
     * surface as a crash on the way out. */
    world.quit()
    await vi.waitFor(() => expect(attempted).toBe(1))
    expect(world.order).toEqual(['flush', 'drain', 'abort', 'journalClosed'])
  })
})

describe('the listener’s lifetime', () => {
  /**
   * THE UNLISTEN IS KEPT AND TIED TO THE LIFETIME.
   *
   * Discarding it left a native registration behind on every reload —
   * StrictMode alone mounts twice in development — so a quit reached several
   * handlers, each aborting a lifetime and answering `shutdown-done`, and the
   * FIRST answer released the quit while the others were still tearing down.
   */
  it('unsubscribes when the composition’s lifetime ends', async () => {
    const world = shell()
    await armShutdown(world.deps)
    expect(world.listening()).toBe(true)
    world.lifetime.abort()
    expect(world.unlistened()).toBe(1)
    expect(world.listening()).toBe(false)
  })

  it('unsubscribes once, not once per abort', async () => {
    const world = shell()
    await armShutdown(world.deps)
    world.lifetime.abort()
    world.lifetime.abort()
    expect(world.unlistened()).toBe(1)
  })

  /* A LIFETIME THAT ENDED WHILE THE LISTENER WAS BEING REGISTERED must not
   * leave it registered: `listen` is asynchronous, and a boot that failed
   * between the two would otherwise leak the handler for the process. */
  it('releases a listener that arrived after the lifetime had already ended', async () => {
    const world = shell()
    const armed = armShutdown({
      ...world.deps,
      listen: async (event, handler) => {
        world.lifetime.abort()
        return world.deps.listen(event, handler)
      },
    })
    await armed
    expect(world.unlistened()).toBe(1)
  })
})

describe('arming in the background', () => {
  /**
   * FAILING TO ARM IS SAID OUT LOUD.
   *
   * The boot path cannot await this — arming must not delay the first frame —
   * and a rejection would otherwise be silent. Every quit then leaves the
   * journal dirty and the next launch re-verifies the whole shelf, which is
   * invisible from the UI and exactly what went unnoticed before.
   */
  it('reports a listener that could not be registered rather than throwing', async () => {
    const said: { event: string; fields: Record<string, unknown> }[] = []
    const world = shell({
      listen: async () => {
        throw new Error('no event module here')
      },
      diagnostics: { warn: (event: string, fields: Record<string, unknown>) => said.push({ event, fields }) } as unknown as ShutdownDeps['diagnostics'],
    })
    expect(() => armShutdownInBackground(world.deps)).not.toThrow()
    await vi.waitFor(() => expect(said).toHaveLength(1))
    expect(said[0]?.event).toBe('shutdown.handshake-unavailable')
    expect(said[0]?.fields.message).toMatch(/no event module/)
  })
})

