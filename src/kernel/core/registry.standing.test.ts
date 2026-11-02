import { describe, expect, it, vi } from 'vitest'
import type { Capability } from './capability'
import { composeCapabilities, kernelApi, withoutSwitchedOff, type CompositionOptions } from './registry'
import { createKernelServices } from './services'

/**
 * Where a capability stands, one case per state.
 *
 * WHAT MATTERS IN EACH IS THE DIAGNOSTICS AS WELL AS THE ROW. `available` answering
 * `false` used to make its dependants `requires-failed`, logged as errors and drawn
 * as "not running", for something a reader or a device had simply chosen.
 */

const TOGGLE = { title: 'A feature', summary: 'What it does.' }

function compose(caps: readonly Capability[], options: CompositionOptions = {}) {
  const services = createKernelServices({ fs: null, storage: null })
  const error = vi.spyOn(services.diagnostics, 'error')
  return composeCapabilities(caps, kernelApi(services), new AbortController().signal, options).then((composition) => ({
    composition,
    error,
  }))
}

const started = (id: string, over: Partial<Capability> = {}) => {
  const start = vi.fn(() => ({ dispose: () => {} }))
  return { id, start, ...over } satisfies Capability
}

describe('Composition.standing', () => {
  it('says on for what started, in registration order', async () => {
    const { composition, error } = await compose([started('b', { requires: ['a'] }), started('a')])
    expect(composition.standing).toEqual([
      { id: 'a', state: 'on' },
      { id: 'b', state: 'on' },
    ])
    expect(error).not.toHaveBeenCalled()
  })

  it('says off for what the reader switched off: never asked, never started, contributes nothing', async () => {
    const available = vi.fn(() => true)
    const feature = started('feature', {
      toggle: TOGGLE,
      available,
      settings: [{ id: 'feature:one', title: 'One', render: () => null }],
    })
    const { composition, error } = await compose([feature], { switchedOff: new Set(['feature']) })
    expect(composition.standing).toEqual([{ id: 'feature', toggle: TOGGLE, state: 'off' }])
    expect(available).not.toHaveBeenCalled()
    expect(feature.start).not.toHaveBeenCalled()
    expect(composition.settings).toEqual([])
    expect(composition.order).toEqual([])
    expect(composition.failures).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('starts it again once it is no longer listed', async () => {
    const feature = started('feature', { toggle: TOGGLE })
    await compose([feature], { switchedOff: new Set(['feature']) })
    const { composition } = await compose([feature], { switchedOff: new Set() })
    expect(feature.start).toHaveBeenCalledTimes(1)
    expect(composition.standing).toEqual([{ id: 'feature', toggle: TOGGLE, state: 'on' }])
  })

  /* ⚠️ THE LIST IS A VALUE IN A FILE A PERSON CAN EDIT, and it outlives a capability
     losing its switch: one stale string must not stop something the rules keep on. */
  it('ignores a listed id with no toggle', async () => {
    const needed = started('needed')
    const { composition } = await compose([needed], { switchedOff: new Set(['needed']) })
    expect(needed.start).toHaveBeenCalledOnce()
    expect(composition.standing).toEqual([{ id: 'needed', state: 'on' }])
  })

  it('says unavailable when `available` answers false, without a failure', async () => {
    const { composition, error } = await compose([started('device', { available: () => false })])
    expect(composition.standing).toEqual([{ id: 'device', state: 'unavailable' }])
    expect(composition.failures).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it.each([
    ['off', { toggle: TOGGLE }, { switchedOff: new Set(['dep']) }],
    ['unavailable', { available: () => false }, {}],
  ] as const)('says needs for a dependant of something %s, and it is not a failure', async (_name, over, options) => {
    const dependant = started('dependant', { requires: ['dep'] })
    const { composition, error } = await compose([started('dep', over), dependant], options)
    expect(composition.standing.at(1)).toEqual({ id: 'dependant', state: 'needs', on: 'dep' })
    expect(dependant.start).not.toHaveBeenCalled()
    expect(composition.failures).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('carries needs down a chain, naming the direct requirement', async () => {
    const { composition, error } = await compose(
      [started('a', { toggle: TOGGLE }), started('b', { requires: ['a'] }), started('c', { requires: ['b'] })],
      { switchedOff: new Set(['a']) },
    )
    expect(composition.standing.at(2)).toEqual({ id: 'c', state: 'needs', on: 'b' })
    expect(composition.failures).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })

  it('says failed for a start that threw, in step with `failures`', async () => {
    const { composition, error } = await compose([
      started('bad', {
        start: () => {
          throw new Error('no')
        },
      }),
      started('dependant', { requires: ['bad'] }),
    ])
    expect(composition.standing).toEqual([
      { id: 'bad', state: 'failed' },
      { id: 'dependant', state: 'failed', because: 'bad' },
    ])
    expect(composition.failures.map((one) => one.id)).toEqual(['bad', 'dependant'])
    /* A failure with no dependency at fault says none, rather than carrying an
       empty `because` a reader would have to tell from a named one. */
    expect('because' in composition.failures[0]!).toBe(false)
    expect(composition.failures[1]!.because).toBe('bad')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('says failed for an `available` that threw', async () => {
    const { composition } = await compose([
      started('bad', {
        available: () => {
          throw new Error('no')
        },
      }),
    ])
    expect(composition.standing).toEqual([{ id: 'bad', state: 'failed' }])
    expect(composition.failures.map((one) => one.kind)).toEqual(['start-failed'])
  })

  it('reads a requirement that failed ahead of one left out, since that is what is wrong', async () => {
    const { composition } = await compose([
      started('gone', { available: () => false }),
      started('bad', {
        start: () => {
          throw new Error('no')
        },
      }),
      started('both', { requires: ['gone', 'bad'] }),
    ])
    expect(composition.standing.at(2)).toEqual({ id: 'both', state: 'failed', because: 'bad' })
  })

  it('reads off ahead of a requirement that failed: the reader did not lose it to that', async () => {
    const { composition } = await compose(
      [
        started('bad', {
          start: () => {
            throw new Error('no')
          },
        }),
        started('feature', { requires: ['bad'], toggle: TOGGLE }),
      ],
      { switchedOff: new Set(['feature']) },
    )
    expect(composition.standing.at(1)).toEqual({ id: 'feature', toggle: TOGGLE, state: 'off' })
    expect(composition.failures.map((one) => one.id)).toEqual(['bad'])
  })

  it('carries the words a row is drawn with, whatever the state', async () => {
    const follows = { title: 'Follower', switch: 'Some switch' }
    const { composition } = await compose([started('follower', { follows, available: () => false })])
    expect(composition.standing).toEqual([{ id: 'follower', follows, state: 'unavailable' }])
  })

  it('keeps answering once disposed, as a record of the run', async () => {
    const { composition } = await compose([started('a')])
    composition.dispose()
    expect(composition.standing).toEqual([{ id: 'a', state: 'on' }])
  })

  it('freezes the list and its rows', async () => {
    const { composition } = await compose([started('a')])
    expect(Object.isFrozen(composition.standing)).toBe(true)
    expect(Object.isFrozen(composition.standing[0])).toBe(true)
  })
})

/* `sync` is the only tail today and cannot be off, so nothing in the app would
   notice this rule breaking until a second capability owed a tail. */
describe('a composition aborted while `available` was being asked', () => {
  /* The check above the question ran before it, and it can take as long as it
     likes, so a cancelled launch went on to start the capability it asked about. */
  it('starts nothing more, and takes back what it had started', async () => {
    const control = new AbortController()
    const dispose = vi.fn()
    const first = started('first', { start: vi.fn(() => ({ dispose })) })
    const second = started('second', {
      available: () => {
        control.abort()
        return true
      },
    })
    const services = createKernelServices({ fs: null, storage: null })

    await expect(composeCapabilities([first, second], kernelApi(services), control.signal)).rejects.toThrow(
      'capability "second" was not started: the composition was aborted',
    )

    expect(second.start).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('the quit handshake and a switched-off capability', () => {
  const quiesce = async () => {}

  it('leaves out what the reader switched off, so its quiesce is not run', () => {
    const off = { id: 'off', toggle: TOGGLE, quiesce }
    const on = { id: 'on', toggle: TOGGLE, quiesce }
    const fixed = { id: 'fixed', quiesce }
    expect(withoutSwitchedOff([off, on, fixed], new Set(['off']))).toEqual([on, fixed])
  })

  it('keeps a listed id with no toggle, by the rule composition uses', () => {
    const fixed = { id: 'fixed', quiesce }
    expect(withoutSwitchedOff([fixed], new Set(['fixed']))).toEqual([fixed])
  })
})
