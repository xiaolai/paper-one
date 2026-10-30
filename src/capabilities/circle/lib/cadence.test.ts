import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CIRCLE_FETCH_EVERY_MS, CIRCLE_FIRST_FETCH_MS, createCadence } from './cadence'

/**
 * WI-23.A2's clock.
 *
 * ⚠️ **THE ITEM'S FIRST FALSIFIER**: *"open a book on B. The number of
 * `circle.pages` calls made in the ten seconds after `open` must be 0."*
 * There is no `open` to hand this module — it takes time and nothing else —
 * so the test below is the structural form: a round is a function of the
 * clock alone, and nothing that happens between ticks can move one.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the fetch cadence', () => {
  it('runs nothing at start, once after the first delay, then every period', async () => {
    const run = vi.fn(() => Promise.resolve())
    const cadence = createCadence({ run, firstAfterMs: 30, everyMs: 100 })
    cadence.start()
    expect(run).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(29)
    expect(run).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(99)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledTimes(5)
    cadence.stop()
  })

  it('is a function of the clock and of nothing else — the pull-on-open falsifier', async () => {
    /* Whatever a caller does between ticks — open a book, close it, open
       another — the count within ten seconds of that moment is 0, because
       the module has no input to tell it anything happened. */
    const run = vi.fn(() => Promise.resolve())
    const cadence = createCadence({ run, firstAfterMs: CIRCLE_FIRST_FETCH_MS, everyMs: CIRCLE_FETCH_EVERY_MS })
    cadence.start()
    await vi.advanceTimersByTimeAsync(CIRCLE_FIRST_FETCH_MS)
    expect(run).toHaveBeenCalledTimes(1)

    const opened = run.mock.calls.length
    /* "open a book" — an event this module cannot see. */
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.mock.calls.length - opened).toBe(0)
    cadence.stop()
  })

  it('never overlaps two rounds: the next is armed after the previous finishes', async () => {
    let finish: (() => void) | null = null
    let inFlight = 0
    let peak = 0
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          finish = () => {
            inFlight -= 1
            resolve()
          }
        }),
    )
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    /* Three periods pass while the first round is still running. */
    await vi.advanceTimersByTimeAsync(30)
    expect(run).toHaveBeenCalledTimes(1)
    expect(peak).toBe(1)
    finish!()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    finish!()
    cadence.stop()
  })

  it('goes on after a round that threw, because one bad round must not end the rest', async () => {
    let calls = 0
    const run = vi.fn(() => (++calls === 1 ? Promise.reject(new Error('peer gone')) : Promise.resolve()))
    const failed = vi.fn()
    const cadence = createCadence({ run, failed, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    /* And said: a round that fails every time and is swallowed is a circle that silently stopped fetching. */
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0]![0]).toMatchObject({ message: 'peer gone' })
    cadence.stop()
  })

  it('stops: a pending tick is cancelled and a finishing round arms nothing', async () => {
    let finish: (() => void) | null = null
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    cadence.stop()
    finish!()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)

    /* And a stop before the first tick cancels it outright. */
    const early = vi.fn(() => Promise.resolve())
    const never = createCadence({ run: early, firstAfterMs: 10, everyMs: 10 })
    never.start()
    never.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(early).toHaveBeenCalledTimes(0)
  })

  it('clears exactly the tick it armed, and nothing when a round is running', async () => {
    /* Through the timers port, so the clearing is seen rather than assumed:
       a stop mid-round has no tick to cancel, and clearing a handle that was
       never armed is a call with nothing behind it. */
    const handles: number[] = []
    const cleared: unknown[] = []
    let next = 0
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        const handle = ++next
        handles.push(handle)
        setTimeout(fn, ms)
        return handle
      },
      clearTimeout: (handle: unknown) => {
        cleared.push(handle)
      },
    }
    let finish: (() => void) | null = null
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const running = createCadence({ run, firstAfterMs: 10, everyMs: 10, timers })
    running.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    running.stop()
    expect(cleared).toEqual([])
    finish!()
    await vi.advanceTimersByTimeAsync(50)
    expect(handles).toHaveLength(1)

    const pending = createCadence({ run: () => Promise.resolve(), firstAfterMs: 10, everyMs: 10, timers })
    pending.start()
    pending.stop()
    expect(cleared).toEqual([handles[1]])
  })

  it('is idempotent to start: a second start does not arm a second chain', async () => {
    const run = vi.fn(() => Promise.resolve())
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    /* Nor does a start after stop revive it. */
    cadence.stop()
    cadence.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('defaults to half a minute, then five minutes', () => {
    expect(CIRCLE_FIRST_FETCH_MS).toBe(30_000)
    expect(CIRCLE_FETCH_EVERY_MS).toBe(300_000)
  })
})

describe('starting twice', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('arms no second chain while a round is still running', async () => {
    let finish: (() => void) | null = null
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const cadence = createCadence({ run, firstAfterMs: 30, everyMs: 100 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(30)
    expect(run).toHaveBeenCalledTimes(1)
    /* The round is in flight: a second start must not arm another timer. */
    cadence.start()
    await vi.advanceTimersByTimeAsync(200)
    expect(run).toHaveBeenCalledTimes(1)
    finish!()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)
    cadence.stop()
  })
})

describe('the cadence, held to the letter', () => {
  it('goes on after a round that threw when nobody asked to be told, without an unhandled error', async () => {
    let calls = 0
    const run = vi.fn(() => (++calls === 1 ? Promise.reject(new Error('peer gone')) : Promise.resolve()))
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    cadence.stop()
  })

  it('can be started again after a stop that landed between rounds', async () => {
    const run = vi.fn(() => Promise.resolve())
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(1)
    cadence.stop()
    await vi.advanceTimersByTimeAsync(50)
    expect(run).toHaveBeenCalledTimes(1)
    const again = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    again.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    again.stop()
  })
})

describe('a reporter that throws', () => {
  it('does not stop the clock: the cause is said on the console and the next round is armed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const run = vi.fn(() => (++calls === 1 ? Promise.reject(new Error('peer gone')) : Promise.resolve()))
    const cadence = createCadence({ run, failed: () => { throw new Error('the log is full') }, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not report'), expect.objectContaining({ message: 'the log is full' }))
    cadence.stop()
    spy.mockRestore()
  })
})

describe('a failed round with nobody to tell', () => {
  it('goes on to the next round without a reporter, without an unhandled rejection, and without logging', async () => {
    let rounds = 0
    const run = vi.fn(() => {
      rounds += 1
      return rounds === 1 ? Promise.reject(new Error('peer gone')) : Promise.resolve()
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cadence = createCadence({ run, firstAfterMs: 10, everyMs: 10 })
    cadence.start()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(run).toHaveBeenCalledTimes(2)
    /* Nobody to tell is not an error to log: the optional call is what makes it optional. */
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    cadence.stop()
  })
})

describe('a reporter that rejects', () => {
  it('is said on the console rather than left as an unhandled rejection, and the next round is armed', async () => {
    /* `failed` is typed `void`, and an async reporter is assignable to it. */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      vi.useFakeTimers()
      let runs = 0
      const run = vi.fn(() => {
        runs += 1
        return runs === 1 ? Promise.reject(new Error('peer gone')) : Promise.resolve()
      })
      const cadence = createCadence({ run, failed: async () => { throw new Error('the log is full') }, firstAfterMs: 10, everyMs: 10 })
      cadence.start()
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(0)
      expect(error).toHaveBeenCalledWith('Paper: the circle could not report a failed round', expect.objectContaining({ message: 'the log is full' }))
      await vi.advanceTimersByTimeAsync(10)
      expect(run).toHaveBeenCalledTimes(2)
      expect(unhandled).not.toHaveBeenCalled()
      cadence.stop()
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', unhandled)
      error.mockRestore()
    }
  })
})
