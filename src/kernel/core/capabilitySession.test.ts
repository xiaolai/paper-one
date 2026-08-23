import { describe, expect, it, vi } from 'vitest'
import { NOOP_DIAGNOSTICS } from './ports'
import { openSession } from './capabilitySession'
import type { CapabilityContext } from './capability'

/**
 * THE LIST OF THINGS A CAPABILITY ACQUIRED, OWNED BY SOMETHING.
 *
 * Both shipped capabilities wrote this by hand and both got it wrong in their
 * own way: one ran a `dispose()` bare after its one guarded step, so a throw
 * there escaped the abort listener with `stopped` already true — the
 * registry's later cleanup then returns immediately and can neither retry nor
 * report it — and the other simply forgot a resource for months. Same missing
 * thing: nothing owned the list.
 */
function world(): {
  api: CapabilityContext
  signal: AbortSignal
  abort: () => void
  cleanups: (() => void)[]
  warned: { event: string; fields: Record<string, unknown> }[]
} {
  const cleanups: (() => void)[] = []
  const warned: { event: string; fields: Record<string, unknown> }[] = []
  const controller = new AbortController()
  const api = {
    services: null,
    settings: null,
    diagnostics: {
      ...NOOP_DIAGNOSTICS,
      warn: (event: string, fields: Record<string, unknown>) => void warned.push({ event, fields }),
    },
    onCleanup: (dispose: () => void) => void cleanups.push(dispose),
  } as unknown as CapabilityContext
  return { api, signal: controller.signal, abort: () => controller.abort(), cleanups, warned }
}

describe('a capability session', () => {
  it('releases what it owns, last first', () => {
    const w = world()
    const order: string[] = []
    const session = openSession(w.api, w.signal, 'x.teardown-step-failed')
    session.own('first', () => order.push('first'))
    session.own('second', () => order.push('second'))

    session.stop()
    /* A resource taken later may depend on one taken earlier, never the
       other way round. */
    expect(order).toEqual(['second', 'first'])
  })

  it('releases once, however many times it is stopped', () => {
    const w = world()
    const release = vi.fn()
    const session = openSession(w.api, w.signal, 'x.teardown-step-failed')
    session.own('thing', release)

    session.stop()
    session.stop()
    w.abort()
    for (const cleanup of w.cleanups) cleanup()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('is stopped by the abort signal, and by the registry’s cleanup', () => {
    for (const how of ['abort', 'cleanup'] as const) {
      const w = world()
      const release = vi.fn()
      const session = openSession(w.api, w.signal, 'x.teardown-step-failed')
      session.own('thing', release)
      if (how === 'abort') w.abort()
      else for (const cleanup of w.cleanups) cleanup()
      expect(release, how).toHaveBeenCalledTimes(1)
    }
  })

  /**
   * ⚠️ EVERY STEP RUNS, AND A FAILURE IS NAMED.
   *
   * A teardown that stops at its first failure leaks every resource after it —
   * and because `stopped` is set before the steps run, the registry's later
   * cleanup returns immediately and cannot retry. The failure would surface as
   * an unhandled error during shutdown naming nothing at all.
   */
  it('reports a step that throws and still releases the rest', () => {
    const w = world()
    const after = vi.fn()
    const session = openSession(w.api, w.signal, 'companion.teardown-step-failed')
    session.own('earlier', after)
    session.own('broken', () => {
      throw new Error('the port was already gone')
    })

    expect(() => session.stop(), 'the failure escaped the session').not.toThrow()
    expect(after, 'a step after the failure was skipped').toHaveBeenCalledTimes(1)
    expect(w.warned).toEqual([
      {
        event: 'companion.teardown-step-failed',
        fields: { label: 'broken', message: 'the port was already gone' },
      },
    ])
  })

  /* A resource acquired after teardown belongs to nobody. `start` throwing
     part-way is the case: the kernel runs the stack, and anything taken
     afterwards would otherwise be recorded into a list nothing reads again. */
  it('releases at once anything owned after it has stopped', () => {
    const w = world()
    const release = vi.fn()
    const session = openSession(w.api, w.signal, 'x.teardown-step-failed')
    session.stop()
    session.own('late', release)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('says nothing when every step succeeds', () => {
    const w = world()
    const session = openSession(w.api, w.signal, 'x.teardown-step-failed')
    session.own('thing', () => {})
    session.stop()
    expect(w.warned).toEqual([])
  })
})
