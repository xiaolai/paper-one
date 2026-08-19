import { afterEach, describe, expect, it, vi } from 'vitest'
import { breathe, restThenBreathe } from './breath'

/**
 * The pacing both long background passes share.
 *
 * The point of every case here is the SAME one: a wait that ends when the
 * thread is free, and a ceiling that stops it waiting for ever if the thread
 * never is. The old code was a flat sleep, and a flat sleep charges an idle
 * app the same as a busy one — four minutes of nothing across a shelf of two
 * thousand books for the parse pass, twenty-five for sync's backfill.
 */

type IdleGlobal = { requestIdleCallback?: unknown }

afterEach(() => {
  delete (globalThis as IdleGlobal).requestIdleCallback
  vi.useRealTimers()
})

/** Install a `requestIdleCallback` this test controls. */
function idleIs(behaviour: (run: () => void, timeout: number) => void) {
  const calls: number[] = []
  ;(globalThis as IdleGlobal).requestIdleCallback = (
    callback: () => void,
    options?: { timeout: number },
  ) => {
    calls.push(options?.timeout ?? -1)
    behaviour(callback, options?.timeout ?? -1)
    return 1
  }
  return calls
}

describe('breathe', () => {
  it('ends as soon as the thread is free, without waiting out the ceiling', async () => {
    // Fires at once, as an idle callback does on an app with nothing to do.
    idleIs((run) => run())
    const started = performance.now()
    await breathe(5_000)
    /* The whole fix in one assertion: the ceiling is 5s and this returns
     * immediately, where the flat sleep it replaces would have taken all of
     * it — once per book, across the entire library. */
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('hands the ceiling to the platform as the timeout', async () => {
    const timeouts = idleIs((run) => run())
    await breathe(120)
    expect(timeouts).toEqual([120])
  })

  /* A ceiling the platform honours is what stops a never-idle app starving
   * the pass — a library that never finishes filling in is worse than one
   * that fills in slowly. Modelled here by an idle callback that only ever
   * fires via its timeout. */
  it('still returns when the thread never goes idle', async () => {
    idleIs((run, timeout) => {
      setTimeout(run, timeout)
    })
    const started = performance.now()
    await breathe(30)
    expect(performance.now() - started).toBeGreaterThanOrEqual(20)
  })

  /**
   * THE FALLBACK IS THE OLD BEHAVIOUR, EXACTLY.
   *
   * A platform without `requestIdleCallback` — jsdom, an older WebView —
   * keeps the pacing its pass was tuned with rather than getting some new
   * approximation of idleness. It also means the tests for those passes
   * exercise a plain timer, so their timing stays as predictable as it was.
   */
  it('falls back to a plain sleep of the ceiling where there is no idle callback', async () => {
    expect((globalThis as IdleGlobal).requestIdleCallback).toBeUndefined()
    const started = performance.now()
    await breathe(40)
    expect(performance.now() - started).toBeGreaterThanOrEqual(30)
  })

  /* A caller cannot handle failing to wait, so there is nothing to handle. */
  it('never rejects', async () => {
    await expect(breathe(0)).resolves.toBeUndefined()
  })
})

describe('restThenBreathe', () => {
  /* The floor is the rate limit, and it applies even to a completely idle
   * app — which is the case the backfill needed, because its work is in Rust
   * and an idle-only wait would have read the whole library off disk as fast
   * as the disk could serve it. */
  it('waits out the floor even when the thread is free at once', async () => {
    idleIs((run) => run())
    const started = performance.now()
    await restThenBreathe(40, 5_000)
    expect(performance.now() - started).toBeGreaterThanOrEqual(30)
  })

  it('does not add the ceiling on top when the thread is free', async () => {
    idleIs((run) => run())
    const started = performance.now()
    await restThenBreathe(10, 5_000)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
