import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushBeforeClose, onBeforeClose, onBeforeDrain, settleBeforeDrain } from './beforeClose'

/**
 * The half of shutting down that a write queue cannot do.
 *
 * A queue drains what it has been GIVEN. The thing most likely to be lost is
 * the thing not yet handed over — a note being typed, which lives in its editor
 * until something commits it. This is the handover.
 */
describe('beforeClose', () => {
  const registered: (() => void)[] = []
  const track = (off: () => void) => {
    registered.push(off)
    return off
  }
  afterEach(() => {
    for (const off of registered.splice(0)) off()
  })

  it('runs what is registered', () => {
    const ran: string[] = []
    track(onBeforeClose(() => ran.push('a')))
    track(onBeforeClose(() => ran.push('b')))
    flushBeforeClose()
    expect(ran.sort()).toEqual(['a', 'b'])
  })

  it('stops running what has unregistered', () => {
    const ran: string[] = []
    const off = track(onBeforeClose(() => ran.push('gone')))
    off()
    flushBeforeClose()
    expect(ran).toEqual([])
  })

  /* One failing callback must not stop the others. The reader has one note in
   * one editor, but the registry carries whatever else holds state, and losing
   * all of it because one threw is the worst possible trade. */
  it('carries on after one throws', () => {
    /* AND SAYS SO. A handover that threw is a note that may not have been
       saved, and the console is the only place left to say it on the way out:
       swallowed, the loss would leave no trace at all. */
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ran: string[] = []
      const nope = new Error('nope')
      track(
        onBeforeClose(() => {
          throw nope
        }),
      )
      track(onBeforeClose(() => ran.push('after')))
      expect(() => flushBeforeClose()).not.toThrow()
      expect(ran).toEqual(['after'])
      expect(errors.mock.calls).toEqual([['Paper: something could not be saved before closing', nope]])
    } finally {
      errors.mockRestore()
    }
  })

  it('is quiet with nothing registered', () => {
    expect(() => flushBeforeClose()).not.toThrow()
  })
})

/**
 * The half a synchronous handover cannot be: work already running that the
 * drain has to OUTLAST — an import still copying, whose shelf writes are chained
 * a batch behind the copying and reach the queue only once it has let go.
 * `onBeforeClose` stays synchronous; this is the second, awaited, list.
 */
describe('beforeDrain', () => {
  const registered: (() => void)[] = []
  const track = (off: () => void) => {
    registered.push(off)
    return off
  }
  afterEach(() => {
    for (const off of registered.splice(0)) off()
  })

  it('waits for every registered settle, not only the first to finish', async () => {
    let openSlow: () => void = () => {}
    const slow = new Promise<void>((resolve) => {
      openSlow = resolve
    })
    const ran: string[] = []
    track(onBeforeDrain(async () => void ran.push('fast')))
    track(
      onBeforeDrain(async () => {
        await slow
        ran.push('slow')
      }),
    )
    let settled = false
    const waiting = settleBeforeDrain().then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(ran).toEqual(['fast'])
    expect(settled, 'the drain was let go while one settle was still running').toBe(false)
    openSlow()
    await waiting
    expect(ran).toEqual(['fast', 'slow'])
  })

  it('stops waiting for what has unregistered', async () => {
    const off = track(onBeforeDrain(() => new Promise<never>(() => {})))
    off()
    /* RACED AGAINST THE NEXT TURN, not left to the test's timeout. A settle
       that stayed registered never resolves, and awaiting it bare turned that
       failure into a five-second hang that reads as a slow test. */
    const outcome = await Promise.race([
      settleBeforeDrain().then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 0)),
    ])
    expect(outcome, 'the drain still waited for a settle that had unregistered').toBe('settled')
  })

  /* A SETTLE THAT FAILS IS STILL SETTLED. The drain it guards goes ahead either
     way — a stop that threw must not cost the queue its drain — and neither a
     rejection nor a synchronous throw reaches the caller. */
  it('carries on after one rejects or throws, and never rejects itself', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ran: string[] = []
      const rejected = new Error('the import would not stop')
      const threw = new Error('and this one threw')
      track(onBeforeDrain(async () => Promise.reject(rejected)))
      track(
        onBeforeDrain(() => {
          throw threw
        }),
      )
      track(onBeforeDrain(async () => void ran.push('after')))
      await expect(settleBeforeDrain()).resolves.toBeUndefined()
      expect(ran).toEqual(['after'])
      expect(errors).toHaveBeenCalledTimes(2)
      /* Each failure said in the drain's own words, with its cause — in either
         order, since a synchronous throw is caught before a rejection settles. */
      const said = 'Paper: something the write queue waits for did not finish before closing'
      expect(errors).toHaveBeenCalledWith(said, rejected)
      expect(errors).toHaveBeenCalledWith(said, threw)
    } finally {
      errors.mockRestore()
    }
  })

  it('is quiet with nothing registered', async () => {
    await expect(settleBeforeDrain()).resolves.toBeUndefined()
  })
})
