import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isCapabilityId,
  CapabilityError,
  KERNEL_DEFAULT_PANE,
  composeCapabilities,
  createKernelServices,
  kernelApi,
  registrationOrder,
  resolvePaneId,
  type Capability,
  type CapabilityContext,
  type CommandContext,
  type Composition,
  type Diagnostics,
  type IndexFs,
  type KernelApi,
} from '../kernel'
import { capabilities as android } from './composition.android'
import { capabilities as desktop } from './composition.desktop'
import { capabilities as ios } from './composition.ios'

/**
 * THE COMPOSITION CONTRACT — what `composeCapabilities` promises every
 * composition root, and what the ADR's enforcement schedule assigns to K.6:
 * ids are unique and never `kernel`; `requires` resolves and has no cycle;
 * registration order is topological with list order breaking ties, and the
 * same for the same list every time; every contribution is namespaced under
 * its owner (decision 5); registration is atomic — a `start` that throws
 * leaves no entry, listener or timer, of any capability; a persisted pane id
 * nobody composed resolves to the kernel's default; and `dispose` takes
 * everything down, in reverse.
 *
 * Every case here would fail without its guard: each one is a real
 * `Capability` value handed to the real registry, with fake timers counting
 * what a `start` left behind.
 */

/* ---------------------------------------------------------------- fixtures */

/** A `Diagnostics` that remembers its scopes and lines. */
function recordingDiagnostics(scope = 'root', log: string[] = []): Diagnostics & { log: string[] } {
  const line = (level: string) => (event: string) => log.push(`${scope} ${level} ${event}`)
  return {
    log,
    child: (name) => recordingDiagnostics(name, log),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
  }
}

function api(diagnostics: Diagnostics = recordingDiagnostics()): KernelApi {
  return kernelApi(createKernelServices({ fs: null, storage: null, diagnostics }))
}

/** A capability that records its lifecycle and starts one interval timer. */
function cap(
  id: string,
  over: Partial<Capability> = {},
  events: string[] = [],
  behaviour: { throwOnStart?: unknown; throwOnDispose?: unknown; noDisposable?: boolean } = {},
): Capability {
  return {
    id,
    ...over,
    start: (_ctx, signal) => {
      events.push(`start ${id}`)
      if (behaviour.throwOnStart !== undefined) throw behaviour.throwOnStart
      const timer = setInterval(() => {}, 60_000)
      if (behaviour.noDisposable) return undefined as unknown as { dispose(): void }
      const stop = () => {
        clearInterval(timer)
        signal.removeEventListener('abort', stop)
      }
      signal.addEventListener('abort', stop, { once: true })
      return {
        dispose: () => {
          events.push(`dispose ${id}`)
          stop()
          if (behaviour.throwOnDispose !== undefined) throw behaviour.throwOnDispose
        },
      }
    },
  }
}

const ctx: CommandContext = { screen: 'reader', pane: null, hasBook: false, openPane: () => {} }

async function rejection(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError)
    return error as CapabilityError
  }
  throw new Error('expected the composition to be refused')
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

/* ------------------------------------------------------------- validation */

describe('ids', () => {
  it('refuses a duplicate id, before any capability starts', async () => {
    const events: string[] = []
    const error = await rejection(
      composeCapabilities([cap('one', {}, events), cap('two', {}, events), cap('one', {}, events)], api(), new AbortController().signal),
    )
    expect(error.code).toBe('duplicate-id')
    expect(error.capability).toBe('one')
    expect(events).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses the id "kernel": its namespaces would be the kernel\'s own', async () => {
    const error = await rejection(composeCapabilities([cap('kernel')], api(), new AbortController().signal))
    expect(error.code).toBe('reserved-id')
  })

  it.each(['Kernel', 'has space', '1st', '', 'under_score'])('refuses an id outside the manifest\'s rule: %j', async (id) => {
    const error = await rejection(composeCapabilities([cap(id)], api(), new AbortController().signal))
    expect(error.code).toBe('invalid-id')
  })
})

describe('requires', () => {
  it('refuses a requirement nobody composed, naming both ends', async () => {
    const error = await rejection(composeCapabilities([cap('sync', { requires: ['peer'] })], api(), new AbortController().signal))
    expect(error.code).toBe('missing-requires')
    expect(error.capability).toBe('sync')
    expect(error.message).toMatch(/"sync" requires "peer"/)
  })

  it('refuses a cycle of any length, naming its members', async () => {
    const two = await rejection(
      composeCapabilities([cap('a', { requires: ['b'] }), cap('b', { requires: ['a'] })], api(), new AbortController().signal),
    )
    expect(two.code).toBe('cyclic-requires')
    expect(two.message).toBe('requires cycle among: a, b')

    const three = await rejection(
      composeCapabilities(
        [cap('a', { requires: ['c'] }), cap('b', { requires: ['a'] }), cap('c', { requires: ['b'] }), cap('d')],
        api(),
        new AbortController().signal,
      ),
    )
    expect(three.message).toBe('requires cycle among: a, b, c')
  })

  it('treats a self-reference as a cycle', async () => {
    const error = await rejection(composeCapabilities([cap('a', { requires: ['a'] })], api(), new AbortController().signal))
    expect(error.code).toBe('cyclic-requires')
    expect(error.message).toBe('requires cycle among: a')
  })

  it('validates everything before starting anything: a bad requires further down starts nothing', async () => {
    const events: string[] = []
    await rejection(
      composeCapabilities([cap('first', {}, events), cap('second', { requires: ['ghost'] }, events)], api(), new AbortController().signal),
    )
    expect(events).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('registration order (ADR decision 4)', () => {
  it('is topological by requires, ties broken by list position', () => {
    // c needs b, b needs a; the list is deliberately in the wrong order.
    expect(registrationOrder([cap('c', { requires: ['b'] }), cap('a'), cap('b', { requires: ['a'] })])).toEqual(['a', 'b', 'c'])
    // No constraints at all: the list is the order.
    expect(registrationOrder([cap('x'), cap('y'), cap('z')])).toEqual(['x', 'y', 'z'])
    // Two ready at once: the earlier in the list goes first, then the one it unblocks.
    expect(registrationOrder([cap('z', { requires: ['a'] }), cap('y'), cap('a')])).toEqual(['y', 'a', 'z'])
    // A diamond: d needs b and c; b and c need a.
    expect(
      registrationOrder([cap('d', { requires: ['b', 'c'] }), cap('c', { requires: ['a'] }), cap('b', { requires: ['a'] }), cap('a')]),
    ).toEqual(['a', 'c', 'b', 'd'])
  })

  it('is the same for the same list every time, and reordering the list is a behaviour change', () => {
    const list = () => [cap('z', { requires: ['a'] }), cap('y'), cap('a'), cap('b', { requires: ['y'] })]
    expect(registrationOrder(list())).toEqual(registrationOrder(list()))
    expect(registrationOrder(list())).toEqual(['y', 'a', 'z', 'b'])
    const reordered = [cap('b', { requires: ['y'] }), cap('a'), cap('y'), cap('z', { requires: ['a'] })]
    expect(registrationOrder(reordered)).toEqual(['a', 'y', 'b', 'z'])
  })

  it('starts capabilities in that order and reports it', async () => {
    const events: string[] = []
    const composition = await composeCapabilities(
      [cap('c', { requires: ['b'] }, events), cap('a', {}, events), cap('b', { requires: ['a'] }, events)],
      api(),
      new AbortController().signal,
    )
    expect(events).toEqual(['start a', 'start b', 'start c'])
    expect(composition.order).toEqual(['a', 'b', 'c'])
    composition.dispose()
  })
})

describe('namespacing (ADR decision 5)', () => {
  const pane = (id: string) => ({ id: id as `${string}:${string}`, label: 'x', screens: ['reader'] as const, render: () => null })
  const service = (name: string, grant = 'sync:x') => ({ name: name as `${string}.${string}`, grant, handler: async () => null })

  it('serves the composed services through the bound host after every start, and unserves on dispose', async () => {
    const services = createKernelServices({ fs: null, storage: null })
    const servedNames: string[] = []
    let unserved = false
    const unbind = services.bindServiceHost((list) => {
      servedNames.push(...list.map((s) => s.name))
      return { dispose: () => (unserved = true) }
    })
    const composition = await composeCapabilities(
      [cap('a', { services: [service('a.ping', 'a:ping')] }), cap('sync', { services: [service('sync.push')] })],
      kernelApi(services),
      new AbortController().signal,
    )
    // Every declared service, whichever capability owns it — not just one's own subset.
    expect(servedNames).toEqual(['a.ping', 'sync.push'])
    composition.dispose()
    expect(unserved).toBe(true)
    unbind.dispose()
  })

  /* THE KERNEL'S OWN SERVICES, served beside the capabilities' (phase 11).
   *
   * A caller must not be able to tell which side of the kernel/capability
   * line a service came from: one map, one router registration, one grant
   * check. And they are handed in BEFORE anything starts, because a name
   * collision has to be refused before a capability has run — which is the
   * whole reason `checkNamespaces` sees them at all. */
  it('serves the kernel’s own services alongside the capabilities’', async () => {
    const services = createKernelServices({ fs: null, storage: null })
    const servedNames: string[] = []
    const unbind = services.bindServiceHost((list) => {
      servedNames.push(...list.map((one) => one.name))
      return { dispose: () => {} }
    })
    const composition = await composeCapabilities(
      [cap('sync', { services: [service('sync.push')] })],
      kernelApi(services),
      new AbortController().signal,
      { services: [service('book.list', 'book:read'), service('shelf.status', 'shelf:read')] },
    )
    /* The kernel's first, then the capabilities' — one map, in that order. */
    expect(servedNames).toEqual(['book.list', 'shelf.status', 'sync.push'])
    expect([...composition.services.keys()]).toEqual(['book.list', 'shelf.status', 'sync.push'])
    composition.dispose()
    unbind.dispose()
  })

  it('serves exactly the capabilities’ services when the kernel contributes none', async () => {
    const services = createKernelServices({ fs: null, storage: null })
    const servedNames: string[] = []
    const unbind = services.bindServiceHost((list) => {
      servedNames.push(...list.map((one) => one.name))
      return { dispose: () => {} }
    })
    const composition = await composeCapabilities(
      [cap('sync', { services: [service('sync.push')] })],
      kernelApi(services),
      new AbortController().signal,
    )
    expect(servedNames).toEqual(['sync.push'])
    composition.dispose()
    unbind.dispose()
  })

  it('refuses a kernel service the capabilities already claim, before anything starts', async () => {
    const events: string[] = []
    const error = await rejection(
      composeCapabilities(
        [cap('sync', { services: [service('sync.push')] }, events)],
        api(),
        new AbortController().signal,
        { services: [service('sync.push')] },
      ),
    )
    expect(error.code).toBe('duplicate-contribution')
    /* BEFORE ANYTHING STARTED. A collision found after the capabilities have
     * run is a collision found after their side effects. */
    expect(events).toEqual([])
  })

  it('refuses the kernel declaring one service twice', async () => {
    const error = await rejection(
      composeCapabilities([], api(), new AbortController().signal, {
        services: [service('book.list', 'book:read'), service('book.list', 'book:read')],
      }),
    )
    expect(error.code).toBe('duplicate-contribution')
    expect(error.capability).toBeNull()
  })

  /* The satchel side of the same table. `ClientContribution` called itself
   * "a stub shape until a consumer lands"; these are what `paper --shelf`
   * calls on a shelf, and they cannot be a capability's because a
   * capability's client name must carry its own prefix. */
  it('carries the kernel’s client stubs, and refuses a duplicate among them', async () => {
    const composition = await composeCapabilities([], api(), new AbortController().signal, {
      clients: [{ name: 'book.list' }, { name: 'shelf.status' }],
    })
    expect(composition.clients.map((one) => one.name)).toEqual(['book.list', 'shelf.status'])
    composition.dispose()

    const error = await rejection(
      composeCapabilities([], api(), new AbortController().signal, {
        clients: [{ name: 'book.list' }, { name: 'book.list' }],
      }),
    )
    expect(error.code).toBe('duplicate-contribution')
  })

  it('refuses a pane id outside the owner\'s prefix', async () => {
    for (const bad of ['pane', 'other:pane', 'sync:', 'sync']) {
      const error = await rejection(composeCapabilities([cap('sync', { panes: [pane(bad)] })], api(), new AbortController().signal))
      expect(error.code, bad).toBe('namespace')
      expect(error.capability).toBe('sync')
    }
  })

  it('refuses a pane that fits no screen', async () => {
    const error = await rejection(
      composeCapabilities([cap('sync', { panes: [{ ...pane('sync:pane'), screens: [] }] })], api(), new AbortController().signal),
    )
    expect(error.code).toBe('namespace')
  })

  it('refuses a service name or grant outside the owner\'s prefix', async () => {
    const name = await rejection(composeCapabilities([cap('sync', { services: [service('other.push')] })], api(), new AbortController().signal))
    expect(name.code).toBe('namespace')
    const grant = await rejection(
      composeCapabilities([cap('sync', { services: [service('sync.push', 'social:layers')] })], api(), new AbortController().signal),
    )
    expect(grant.code).toBe('namespace')
    expect(grant.message).toMatch(/grant "social:layers"/)
    const kernelGrant = await rejection(
      composeCapabilities([cap('sync', { services: [service('sync.push', 'kernel:x')] })], api(), new AbortController().signal),
    )
    expect(kernelGrant.code).toBe('namespace')
  })

  it('refuses a settings section, book action or client outside the prefix', async () => {
    const section = await rejection(
      composeCapabilities(
        [cap('sync', { settings: [{ id: 'kernel:theme', title: 'x', render: () => null }] })],
        api(),
        new AbortController().signal,
      ),
    )
    expect(section.code).toBe('namespace')
    const action = await rejection(
      composeCapabilities([cap('sync', { bookActions: [{ id: 'peer:download', label: 'x', run: () => {} }] })], api(), new AbortController().signal),
    )
    expect(action.code).toBe('namespace')
    const client = await rejection(composeCapabilities([cap('sync', { clients: [{ name: 'peer.pull' }] })], api(), new AbortController().signal))
    expect(client.code).toBe('namespace')
  })

  it('refuses the same pane or service registered twice', async () => {
    const twice = await rejection(
      composeCapabilities([cap('sync', { panes: [pane('sync:pane'), pane('sync:pane')] })], api(), new AbortController().signal),
    )
    expect(twice.code).toBe('duplicate-contribution')
    const svc = await rejection(
      composeCapabilities([cap('sync', { services: [service('sync.push'), service('sync.push')] })], api(), new AbortController().signal),
    )
    expect(svc.code).toBe('duplicate-contribution')
  })

  it('refuses a command outside the prefix when the palette asks for commands', async () => {
    const composition = await composeCapabilities(
      [cap('sync', { commands: () => [{ id: 'kernel:open', label: 'x', group: 'x', run: () => {} }] })],
      api(),
      new AbortController().signal,
    )
    expect(() => composition.commands(ctx)).toThrow(CapabilityError)
    composition.dispose()
  })

  it('accepts everything under the owner\'s prefix, and hands it back', async () => {
    const composition = await composeCapabilities(
      [
        cap('sync', {
          panes: [pane('sync:status')],
          services: [service('sync.push', 'sync:*')],
          settings: [{ id: 'sync:section', title: 'Sync', render: () => null }],
          bookActions: [{ id: 'sync:download', label: 'Download', run: () => {} }],
          clients: [{ name: 'sync.pull' }],
          commands: () => [{ id: 'sync:now', label: 'Sync now', group: 'Sync', run: () => {} }],
        }),
      ],
      api(),
      new AbortController().signal,
    )
    expect(composition.panes.map((p) => p.id)).toEqual(['sync:status'])
    expect([...composition.services.keys()]).toEqual(['sync.push'])
    expect(composition.settings.map((s) => s.id)).toEqual(['sync:section'])
    expect(composition.bookActions.map((a) => a.id)).toEqual(['sync:download'])
    expect(composition.clients.map((c) => c.name)).toEqual(['sync.pull'])
    expect(composition.commands(ctx).map((c) => c.id)).toEqual(['sync:now'])
    composition.dispose()
  })
})

/* ------------------------------------------------------------ atomicity */

/**
 * DECISION 9'S OTHER HALF, and the reason the first half is safe.
 *
 * A `start` that fails no longer kills the app — so a genuine start bug could
 * ship as a capability that quietly is not there. This is where it stays
 * fatal: every capability each platform composes must actually start, over the
 * real modules, with no filesystem and no storage. Fail here and `pnpm verify`
 * is red; fail at runtime on a reader's machine and they keep their library.
 *
 * That asymmetry is the whole design: loud where someone can fix it, survivable
 * where nobody can.
 */
describe('every composed capability actually starts', () => {
  for (const [platform, caps] of [
    ['desktop', desktop],
    ['ios', ios],
    ['android', android],
  ] as const) {
    it(`${platform} composes with no failures`, async () => {
      const composition = await composeCapabilities(caps, api(), new AbortController().signal)
      try {
        expect(
          composition.failures.map((one) => `${one.id}: ${String((one.error as Error)?.message)}`),
          `${platform} has a capability that did not start`,
        ).toEqual([])
        expect(composition.order).toEqual(caps.map((cap) => cap.id).sort((a, b) => composition.order.indexOf(a) - composition.order.indexOf(b)))
      } finally {
        composition.dispose()
      }
    })
  }
})

describe('a capability that fails to start', () => {
  /* ADR 0001 DECISION 9. This used to take the whole app down: `sync` opens the
   * journal in its `start`, a corrupt file threw, the composition rolled back,
   * and a reader whose library has nothing to do with sync got a fatal banner
   * instead of their books. Validation failures are still fatal — those are
   * build defects, deterministic, and caught by `pnpm verify`. A `start` does
   * I/O, and I/O fails for reasons a build cannot see. */
  it('leaves the others composed, and contributes nothing itself', async () => {
    const events: string[] = []
    const boom = new Error('no network')
    const composition = await composeCapabilities(
      [
        cap('a', { panes: [{ id: 'a:pane', label: 'A', screens: ['reader'], render: () => null }] }, events),
        cap('b', { services: [{ name: 'b.ping', grant: 'b:ping', handler: async () => null }] }, events),
        cap('c', { panes: [{ id: 'c:pane', label: 'C', screens: ['reader'], render: () => null }] }, events, { throwOnStart: boom }),
        cap('d', {}, events),
      ],
      api(),
      new AbortController().signal,
    )
    // Everything else started, INCLUDING the one after the failure.
    expect(events).toEqual(['start a', 'start b', 'start c', 'start d'])
    expect(composition.order).toEqual(['a', 'b', 'd'])
    expect(composition.failures).toHaveLength(1)
    expect(composition.failures[0]).toMatchObject({ id: 'c', kind: 'start-failed', error: boom })
    /* AND IT IS ABSENT FROM EVERY REGISTRY. A pane backed by a capability that
     * is not running would be a title over nothing. */
    expect(composition.panes.map((pane) => pane.id)).toEqual(['a:pane'])
    expect([...composition.services.keys()]).toEqual(['b.ping'])
    composition.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its dependants with it', async () => {
    /* `requires` is a declared need. Starting `sync` without the `peer` it
     * reaches the transport through would fail later, further from the cause. */
    const events: string[] = []
    const composition = await composeCapabilities(
      [cap('peer', {}, events, { throwOnStart: new Error('no plugin') }), cap('sync', { requires: ['peer'] }, events)],
      api(),
      new AbortController().signal,
    )
    expect(events).toEqual(['start peer'])
    expect(composition.order).toEqual([])
    expect(composition.failures.map((one) => [one.id, one.kind, one.because])).toEqual([
      ['peer', 'start-failed', undefined],
      ['sync', 'requires-failed', 'peer'],
    ])
    composition.dispose()
  })

  it('unwinds what it acquired before it threw', async () => {
    // C1: a start that registers cleanups (a listener, a timer, a bound port)
    // and then throws must leave NONE of them — the kernel runs the disposer
    // stack for the failing capability itself. That is unchanged by Decision 9;
    // what changed is that the OTHERS keep running.
    const events: string[] = []
    const partial: Capability = {
      id: 'partial',
      start: (ctx) => {
        events.push('start partial')
        ctx.onCleanup(() => events.push('undo first'))
        ctx.onCleanup(() => events.push('undo second'))
        throw new Error('half started')
      },
    }
    const composition = await composeCapabilities([cap('a', {}, events), partial], api(), new AbortController().signal)
    expect(events).toEqual(['start a', 'start partial', 'undo second', 'undo first'])
    expect(composition.order).toEqual(['a'])
    expect(composition.failures[0]?.id).toBe('partial')
    composition.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('folds a cleanup that also threw into the recorded failure', async () => {
    /* Two facts, not one: the start failed AND it could not clean up after
       itself. The second is how a leak gets noticed, so it must not be eaten
       by the first. */
    const messy: Capability = {
      id: 'messy',
      start: (ctx) => {
        ctx.onCleanup(() => {
          throw new Error('cleanup also failed')
        })
        throw new Error('start failed')
      },
    }
    const composition = await composeCapabilities([messy], api(), new AbortController().signal)
    const error = composition.failures[0]?.error
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((e) => (e as Error).message)).toEqual(['start failed', 'cleanup also failed'])
    composition.dispose()
  })

  it('is a failed start when no Disposable comes back', async () => {
    const events: string[] = []
    const composition = await composeCapabilities(
      [cap('a', {}, events), cap('b', {}, events, { noDisposable: true })],
      api(),
      new AbortController().signal,
    )
    expect(composition.order).toEqual(['a'])
    expect(composition.failures[0]).toMatchObject({ id: 'b', kind: 'start-failed' })
    composition.dispose()
    // b's own timer is what a start with no Disposable leaks — which is why
    // such a start is refused rather than registered.
    vi.clearAllTimers()
  })

  it('says so through diagnostics, so a silent absence is impossible', async () => {
    const diagnostics = recordingDiagnostics()
    const composition = await composeCapabilities(
      [cap('c', {}, [], { throwOnStart: new Error('nope') })],
      api(diagnostics),
      new AbortController().signal,
    )
    expect(diagnostics.log.join('\n')).toContain('composition.capability-failed')
    composition.dispose()
  })
})

describe('atomic registration', () => {
  it('a signal already aborted starts nothing', async () => {
    const events: string[] = []
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(composeCapabilities([cap('a', {}, events)], api(), controller.signal))
    expect(error.code).toBe('aborted')
    expect(events).toEqual([])
  })

  it('a signal that aborts while a start is awaited rolls back what started', async () => {
    const events: string[] = []
    const controller = new AbortController()
    let release!: () => void
    const slow: Capability = {
      id: 'slow',
      start: () =>
        new Promise((resolve) => {
          events.push('start slow')
          release = () => resolve({ dispose: () => events.push('dispose slow') })
        }),
    }
    const promise = composeCapabilities([cap('a', {}, events), slow, cap('c', {}, events)], api(), controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    release()
    const error = await rejection(promise)
    expect(error.code).toBe('start-failed')
    // Attributed to the capability whose awaited start overlapped the abort —
    // the recheck fires the moment it resolves, before `c` is ever reached.
    expect(error.capability).toBe('slow')
    expect(events).toEqual(['start a', 'start slow', 'dispose slow', 'dispose a'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts while the services are being served — disposed and refused, not returned alive', async () => {
    // The window this guards: every start returned, the loop's checks all
    // passed, and the abort fires DURING the awaited `serveServices`. The
    // abort listener does not exist yet, and a listener added to an
    // already-aborted signal never fires — so without the final check a
    // fully-live composition escaped its ended lifetime.
    const events: string[] = []
    const controller = new AbortController()
    const kernel = api()
    kernel.services.bindServiceHost(() => {
      controller.abort()
      return { dispose: () => events.push('unserve') }
    })
    const error = await rejection(composeCapabilities([cap('a', {}, events)], kernel, controller.signal))
    expect(error.code).toBe('aborted')
    // The capability was disposed and the served services were unserved.
    expect(events).toEqual(['start a', 'unserve', 'dispose a'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts while the LAST capability is awaited — no live composition is returned', async () => {
    // The bug this guards: with no capability after `slow`, the old top-of-loop
    // abort check never ran, so a composition from an already-aborted lifetime
    // was returned and never disposed. The post-await recheck rolls it back.
    const events: string[] = []
    const controller = new AbortController()
    let release!: () => void
    const slow: Capability = {
      id: 'slow',
      start: () =>
        new Promise((resolve) => {
          events.push('start slow')
          release = () => resolve({ dispose: () => events.push('dispose slow') })
        }),
    }
    const promise = composeCapabilities([cap('a', {}, events), slow], api(), controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    release()
    const error = await rejection(promise)
    expect(error.code).toBe('start-failed')
    expect(error.capability).toBe('slow')
    expect(events).toEqual(['start a', 'start slow', 'dispose slow', 'dispose a'])
    expect(vi.getTimerCount()).toBe(0)
  })


  it('scopes each capability to its own settings namespace', async () => {
    let leaked: unknown = 'unset'
    let threw: unknown = null
    const setting = <T>(key: string, fallback: T) => ({ key: key as `${string}.${string}`, fallback, parse: (r: unknown) => r as T })
    const nosy: Capability = {
      id: 'nosy',
      start: (ctx) => {
        // Its own namespace is fine.
        ctx.settings.set(setting('nosy.pref', 1), 7)
        // Another capability's is refused.
        try {
          ctx.settings.get(setting('other.secret', ''))
        } catch (error) {
          threw = error
        }
        // getSnapshot shows only its own namespace.
        ctx.settings.set(setting('nosy.two', 0), 9)
        leaked = Object.keys(ctx.settings.getSnapshot()).filter((k) => !k.startsWith('nosy.'))
        return { dispose: () => {} }
      },
    }
    const composition = await composeCapabilities([nosy], api(), new AbortController().signal)
    expect(threw).not.toBeNull()
    expect(leaked).toEqual([])
    composition.dispose()
  })

  it('runs onCleanup registrations at normal dispose too, after the returned Disposable', async () => {
    const events: string[] = []
    const withCleanup: Capability = {
      id: 'withcleanup',
      start: (ctx) => {
        events.push('start withcleanup')
        ctx.onCleanup(() => events.push('cleanup a'))
        ctx.onCleanup(() => events.push('cleanup b'))
        return { dispose: () => events.push('dispose returned') }
      },
    }
    const controller = new AbortController()
    const composition = await composeCapabilities([withCleanup], api(), controller.signal)
    composition.dispose()
    // Returned Disposable first, then the cleanups in reverse.
    expect(events).toEqual(['start withcleanup', 'dispose returned', 'cleanup b', 'cleanup a'])
  })
})

/* ------------------------------------------------------------- lifecycle */

/* ------------------------------------------------------------ confinement */

/** A map-backed filesystem over the kernel's own seam, for the confinement
 *  cases: what lands (or refuses to) is read straight off the map. */
function mapFs(): { store: Map<string, Uint8Array>; fs: IndexFs } {
  const store = new Map<string, Uint8Array>()
  const fs: IndexFs = {
    readFile: async (path) => {
      const bytes = store.get(path)
      if (!bytes) throw new Error('missing')
      return bytes
    },
    readDir: async () => [],
    exists: async (path) => store.has(path),
    writeFile: async (path, bytes) => void store.set(path, bytes),
    mkdir: async () => {},
    remove: async (path) => void store.delete(path),
    removeDir: async (path) => {
      for (const key of [...store.keys()]) if (key === path || key.startsWith(`${path}/`)) store.delete(key)
    },
    rename: async (from, to) => {
      const bytes = store.get(from)
      if (bytes === undefined) throw new Error('missing')
      store.delete(from)
      store.set(to, bytes)
    },
    appendFile: async (path, bytes) => {
      const held = store.get(path) ?? new Uint8Array(0)
      const joined = new Uint8Array(held.length + bytes.length)
      joined.set(held)
      joined.set(bytes, held.length)
      store.set(path, joined)
    },
  }
  return { store, fs }
}

/** Compose one capability over the given kernel and hand back its context. */
async function contextOf(kernel: KernelApi, id = 'nosy'): Promise<{ ctx: CapabilityContext; composition: Composition }> {
  let ctx: CapabilityContext | null = null
  const composition = await composeCapabilities(
    [{ id, start: (given) => ((ctx = given), { dispose: () => {} }) }],
    kernel,
    new AbortController().signal,
  )
  if (ctx === null) throw new Error('start never ran')
  return { ctx, composition }
}

describe('a capability filesystem confined to its own namespace (WI-10.3)', () => {
  const BYTES = new TextEncoder().encode('x')

  it('refuses every write shape outside <cap>/ — plain, ../, and absolute — touching nothing', async () => {
    const { store, fs } = mapFs()
    store.set('books/x/book.json', new TextEncoder().encode('{}'))
    const { ctx, composition } = await contextOf(kernelApi(createKernelServices({ fs, storage: null })))
    const scoped = ctx.services.fs
    if (scoped === null) throw new Error('no fs')
    const append = scoped.appendFile
    if (!append) throw new Error('no appendFile')
    const refused: readonly (() => Promise<unknown>)[] = [
      () => scoped.writeFile('books/x/book.json', BYTES),
      () => scoped.writeFile('nosy/../books/x/book.json', BYTES),
      () => scoped.writeFile('/etc/hosts', BYTES),
      () => scoped.writeFile('..', BYTES),
      () => scoped.writeFile('nosy\\..\\books\\x', BYTES),
      () => scoped.remove('books/x/book.json'),
      () => scoped.removeDir('books'),
      () => scoped.rename('books/x/book.json', 'nosy/stolen.json'),
      () => scoped.rename('nosy/own.json', 'books/x/book.json'),
      () => scoped.mkdir('books/y'),
      () => append('books/x/marks.json', BYTES),
    ]
    for (const attempt of refused) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      )
      expect(error, attempt.toString()).toBeInstanceOf(CapabilityError)
      expect((error as CapabilityError).code, attempt.toString()).toBe('namespace')
    }
    // Nothing was written, moved or deleted by any refused call.
    expect([...store.keys()]).toEqual(['books/x/book.json'])
    composition.dispose()
  })

  it('allows writes under <cap>/, and leaves reads open', async () => {
    const { store, fs } = mapFs()
    store.set('books/x/book.json', new TextEncoder().encode('{"title":"Moby-Dick"}'))
    const { ctx, composition } = await contextOf(kernelApi(createKernelServices({ fs, storage: null })))
    const scoped = ctx.services.fs
    if (scoped === null) throw new Error('no fs')
    await scoped.mkdir('nosy')
    await scoped.writeFile('nosy/state.json', BYTES)
    await scoped.appendFile?.('nosy/log.jsonl', BYTES)
    await scoped.rename('nosy/state.json', 'nosy/renamed.json')
    await scoped.remove('nosy/renamed.json')
    expect(store.has('nosy/log.jsonl')).toBe(true)
    expect(store.has('nosy/renamed.json')).toBe(false)
    // Reads stay open in v1 — the one real consumer digests books/**.
    expect(new TextDecoder().decode(await scoped.readFile('books/x/book.json'))).toContain('Moby-Dick')
    expect(await scoped.exists('books/x/book.json')).toBe(true)
    composition.dispose()
  })

  it('mirrors the platform: appendFile exists on the wrapper exactly when the real fs has it', async () => {
    const bare = mapFs()
    delete (bare.fs as { appendFile?: unknown }).appendFile
    const without = await contextOf(kernelApi(createKernelServices({ fs: bare.fs, storage: null })))
    expect(without.ctx.services.fs?.appendFile).toBeUndefined()
    without.composition.dispose()
    const withAppend = await contextOf(kernelApi(createKernelServices({ fs: mapFs().fs, storage: null })))
    expect(typeof withAppend.ctx.services.fs?.appendFile).toBe('function')
    withAppend.composition.dispose()
  })

  it('a composition with no filesystem hands the capability null, not a wrapper over nothing', async () => {
    const { ctx, composition } = await contextOf(api())
    expect(ctx.services.fs).toBeNull()
    expect(ctx.services.storage).toBeNull()
    composition.dispose()
  })
})

describe('a capability flat store confined to its own namespace (WI-10.4)', () => {
  function mapStorage() {
    const map = new Map<string, string>()
    return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
  }

  it('refuses a cross-namespace setItem AND getItem; its own keys work', async () => {
    const storage = mapStorage()
    storage.map.set('kernel.secret', 'x')
    const { ctx, composition } = await contextOf(kernelApi(createKernelServices({ fs: null, storage })))
    const scoped = ctx.services.storage
    if (scoped === null) throw new Error('no storage')
    for (const attempt of [() => scoped.setItem('kernel.theme', 'night'), () => scoped.getItem('kernel.secret'), () => scoped.setItem('other.k', 'v')]) {
      let thrown: unknown = null
      try {
        attempt()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CapabilityError)
      expect((thrown as CapabilityError).code).toBe('namespace')
    }
    scoped.setItem('nosy.state', 'kept')
    expect(scoped.getItem('nosy.state')).toBe('kept')
    // Nothing outside the namespace changed, nothing leaked.
    expect(storage.map.get('kernel.secret')).toBe('x')
    expect(storage.map.has('kernel.theme')).toBe(false)
    composition.dispose()
  })

  it('the cards read a capability legitimately needs rides the Cards API, tombstones included', async () => {
    const storage = mapStorage()
    const kernel = kernelApi(createKernelServices({ fs: null, storage }))
    const minted = { id: 'c1', bookId: 'book:a', kind: 'Excerpt' as const, body: 'x', answer: '', source: '', cfi: null, createdAt: 1 }
    await kernel.services.cards.add(minted)
    await kernel.services.cards.remove('c1')
    const { ctx, composition } = await contextOf(kernel)
    // The whole collection — the tombstoned row a replicator must see — with
    // no raw flat-store key involved.
    const rows = ctx.services.cards.stored()
    expect(rows.map((row) => row.id)).toEqual(['c1'])
    expect(rows[0]?.deletedAt).toBeTruthy()
    expect(ctx.services.cards.getSnapshot().all).toEqual([])
    composition.dispose()
  })
})

describe('the enforcement gate — an illegal capability is refused at every door (WI-10.6)', () => {
  it('a rogue start attempting kernel-owned writes is refused on each, and nothing changed', async () => {
    const { store, fs } = mapFs()
    const record = new TextEncoder().encode('{"title":"Moby-Dick"}')
    store.set('books/x/book.json', record)
    store.set('books/x/content.epub', new TextEncoder().encode('bytes'))
    const flat = new Map<string, string>([['kernel.theme', '"paper"']])
    const storage = { getItem: (k: string) => flat.get(k) ?? null, setItem: (k: string, v: string) => void flat.set(k, v) }
    const kernel = kernelApi(createKernelServices({ fs, storage }))

    const refused: string[] = []
    const rogue: Capability = {
      id: 'rogue',
      start: async (ctx) => {
        const attempt = async (label: string, run: () => Promise<unknown> | unknown): Promise<void> => {
          try {
            await run()
          } catch (thrown) {
            if (thrown instanceof CapabilityError && thrown.code === 'namespace') refused.push(label)
          }
        }
        const theme = { key: 'kernel.theme' as `${string}.${string}`, fallback: 'paper', parse: (raw: unknown) => raw as string }
        await attempt('fs.writeFile', () => ctx.services.fs?.writeFile('books/x/book.json', new TextEncoder().encode('{}')))
        await attempt('fs.remove', () => ctx.services.fs?.remove('books/x/content.epub'))
        await attempt('storage.setItem', () => ctx.services.storage?.setItem('kernel.theme', '"night"'))
        await attempt('settings.set', () => ctx.settings.set(theme, 'night'))
        await attempt('services.settings.set', () => ctx.services.settings.set(theme, 'night'))
        return { dispose: () => {} }
      },
    }
    const composition = await composeCapabilities([rogue], kernel, new AbortController().signal)
    // Every door said no — by refusal, not by accident of a missing handle.
    expect(refused).toEqual(['fs.writeFile', 'fs.remove', 'storage.setItem', 'settings.set', 'services.settings.set'])
    // And the kernel's data is exactly what it was.
    expect(store.get('books/x/book.json')).toBe(record)
    expect(store.has('books/x/content.epub')).toBe(true)
    expect(flat.get('kernel.theme')).toBe('"paper"')
    composition.dispose()
  })
})

describe('the KernelApi a start receives', () => {
  it('carries the services, a settings store scoped to the capability, and a scoped Diagnostics', async () => {
    const diagnostics = recordingDiagnostics()
    const kernel = api(diagnostics)
    const seen: KernelApi[] = []
    const composition = await composeCapabilities(
      [{ id: 'sync', start: (ctx) => (seen.push(ctx), ctx.diagnostics.info('hello'), { dispose: () => {} }) }],
      kernel,
      new AbortController().signal,
    )
    // The services carry the kernel's own stores — the same instances —
    // but the object is a per-capability view, because its tree-wide
    // handles (fs, storage, settings) are namespace-confined wrappers
    // (phase 10, WI-10.3/10.4).
    expect(seen[0]?.services.library).toBe(kernel.services.library)
    expect(seen[0]?.services.marks).toBe(kernel.services.marks)
    expect(seen[0]?.services.cards).toBe(kernel.services.cards)
    expect(seen[0]?.services.writes).toBe(kernel.services.writes)
    expect(seen[0]?.services.settings).not.toBe(kernel.services.settings)
    // Settings is scoped (a wrapper), not the raw kernel store — like diagnostics.
    expect(seen[0]?.settings).not.toBe(kernel.settings)
    expect(diagnostics.log).toContain('sync info hello')
    expect(diagnostics.log).toContain('root info composition.started')
    composition.dispose()
    expect(diagnostics.log).toContain('root info composition.disposed')
  })
})

describe('dispose', () => {
  let composition: Composition
  let events: string[]

  beforeEach(async () => {
    events = []
    composition = await composeCapabilities(
      [
        cap('a', { panes: [{ id: 'a:pane', label: 'A', screens: ['reader'], render: () => null }] }, events),
        cap(
          'b',
          {
            services: [{ name: 'b.ping', grant: 'b:ping', handler: async () => null }],
            commands: () => [{ id: 'b:go', label: 'Go', group: 'B', run: () => {} }],
            settings: [{ id: 'b:s', title: 'B', render: () => null }],
            bookActions: [{ id: 'b:act', label: 'Act', run: () => {} }],
            clients: [{ name: 'b.pull' }],
          },
          events,
        ),
      ],
      api(),
      new AbortController().signal,
    )
  })

  it('clears every registry and every timer, in reverse order, once', () => {
    expect(vi.getTimerCount()).toBe(2)
    expect(composition.panes).toHaveLength(1)
    composition.dispose()
    expect(events.slice(2)).toEqual(['dispose b', 'dispose a'])
    expect(vi.getTimerCount()).toBe(0)
    expect(composition.panes).toEqual([])
    expect(composition.services.size).toBe(0)
    expect(composition.commands(ctx)).toEqual([])
    expect(composition.settings).toEqual([])
    expect(composition.bookActions).toEqual([])
    expect(composition.clients).toEqual([])
    // Idempotent: a second call disposes nothing twice.
    composition.dispose()
    expect(events.filter((e) => e.startsWith('dispose'))).toHaveLength(2)
  })

  it('happens when the lifetime signal aborts', async () => {
    const controller = new AbortController()
    const local: string[] = []
    const c = await composeCapabilities([cap('a', {}, local), cap('b', {}, local)], api(), controller.signal)
    expect(vi.getTimerCount()).toBe(4) // two here, two in this describe's own composition
    controller.abort()
    expect(local.slice(2)).toEqual(['dispose b', 'dispose a'])
    expect(c.panes).toEqual([])
    expect(vi.getTimerCount()).toBe(2)
    composition.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a dispose that throws does not stop the others, and surfaces as an AggregateError', async () => {
    const local: string[] = []
    const c = await composeCapabilities(
      [cap('a', {}, local), cap('b', {}, local, { throwOnDispose: new Error('stuck') }), cap('c', {}, local)],
      api(),
      new AbortController().signal,
    )
    expect(() => c.dispose()).toThrow(AggregateError)
    expect(local.slice(3)).toEqual(['dispose c', 'dispose b', 'dispose a'])
    expect(vi.getTimerCount()).toBe(2) // this describe's own composition
    composition.dispose()
  })
})

describe('panes', () => {
  it('are sorted by order, unset last, ties by registration', async () => {
    const pane = (id: string, order?: number) => ({
      id: id as `${string}:${string}`,
      label: id,
      screens: ['reader'] as const,
      render: () => null,
      ...(order === undefined ? {} : { order }),
    })
    const composition = await composeCapabilities(
      [cap('a', { panes: [pane('a:late'), pane('a:second', 2)] }), cap('b', { panes: [pane('b:first', 1), pane('b:also-late')] })],
      api(),
      new AbortController().signal,
    )
    expect(composition.panes.map((p) => p.id)).toEqual(['b:first', 'a:second', 'a:late', 'b:also-late'])
    composition.dispose()
  })
})

/* ------------------------------------------------- settings section order */

/**
 * THE SETTINGS PANEL'S ORDER IS DECLARED, NOT INHERITED.
 *
 * Contributed sections went unsorted while panes beside them were sorted, so
 * the panel's running order was whatever `composeCapabilities` produced — and
 * that is TOPOLOGICAL BY `requires`. Devices sat above Storage because sync
 * depends on peer, and for no other reason. Nothing said so, and a capability
 * gaining a dependency would have rearranged a panel nobody had touched.
 */
describe('settings sections', () => {
  const section = (id: string, order?: number) => ({
    id: id as `${string}:${string}`,
    title: id,
    render: () => null,
    ...(order === undefined ? {} : { order }),
  })

  it('are sorted by order, unset last, ties by registration', async () => {
    const composition = await composeCapabilities(
      [
        cap('a', { settings: [section('a:late'), section('a:second', 2)] }),
        cap('b', { settings: [section('b:first', 1), section('b:also-late')] }),
      ],
      api(),
      new AbortController().signal,
    )
    expect(composition.settings.map((one) => one.id)).toEqual([
      'b:first',
      'a:second',
      'a:late',
      'b:also-late',
    ])
    composition.dispose()
  })

  /**
   * THE ONE THAT MATTERS. `b` requires `a`, so `a` always starts first — that
   * is the ADR's ordering and it is not negotiable. The panel's order is a
   * separate question, and `order` is what separates them: a section may sit
   * above one belonging to a capability it depends on.
   *
   * This is the real arrangement it was found in — sync requires peer, and
   * Storage belongs above Devices.
   */
  it('lets a section outrank one from a capability it depends on', async () => {
    const composition = await composeCapabilities(
      [
        cap('a', { settings: [section('a:second', 20)] }),
        cap('b', { requires: ['a'], settings: [section('b:first', 10)] }),
      ],
      api(),
      new AbortController().signal,
    )
    // Start order is still topological — the dependency decides that.
    expect(composition.order).toEqual(['a', 'b'])
    // The panel's order is the sections' own.
    expect(composition.settings.map((one) => one.id)).toEqual(['b:first', 'a:second'])
    composition.dispose()
  })
})

/* ------------------------------------------------------- stale pane ids */

describe('resolvePaneId — a persisted lastPane naming an absent pane', () => {
  const known = ['example:pane', 'sync:status']

  it('falls back to the kernel default for a contributed id nobody composed', () => {
    expect(resolvePaneId('companion-old:pane', known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('gone:pane', [])).toBe('companion')
  })

  it('keeps a contributed id the composition has, and every kernel id', () => {
    expect(resolvePaneId('sync:status', known)).toBe('sync:status')
    expect(resolvePaneId('marginalia', known)).toBe('marginalia')
    expect(resolvePaneId('library', [])).toBe('library')
  })

  it('treats anything that is not a string, or a string that is neither, as absent', () => {
    expect(resolvePaneId(undefined, known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId(42, known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('Marginalia', known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('kernel:marginalia', known)).toBe(KERNEL_DEFAULT_PANE)
  })

  it('takes the fallback the caller names — the screen\'s default, in the UI', () => {
    expect(resolvePaneId('gone:pane', known, 'library')).toBe('library')
  })
})

/* ---------------------------------------------------- the platform roots */

/**
 * The three static compositions agree with the manifest at runtime as well
 * as in the static check (`pnpm compositions:check`): composing each
 * platform's list registers exactly the manifest's ids for that platform, in
 * registration order, every pane it contributes is namespaced under one of
 * them, and disposing it leaves no timer behind. Data-driven from the
 * manifest rather than naming a capability, so `capability:remove <id>`
 * (WI-5.12) leaves this test true with the id gone — and true with an empty
 * list. The surfaces of any one capability are its own test's to assert
 * (`src/capabilities/<id>/*.test.ts`).
 */
describe('the platform compositions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../capabilities.manifest.json', import.meta.url), 'utf8')) as {
    capabilities: { id: string; platforms: string[] }[]
  }
  const roots = { desktop, ios, android } as const
  const expected = (platform: string) => manifest.capabilities.filter((c) => c.platforms.includes(platform)).map((c) => c.id)

  it.each(Object.keys(roots) as (keyof typeof roots)[])('%s composes exactly the manifest set for that platform', async (platform) => {
    const list = roots[platform]
    expect([...list.map((c) => c.id)].sort()).toEqual([...expected(platform)].sort())
    const composition = await composeCapabilities(list, api(), new AbortController().signal)
    expect(composition.order).toEqual(registrationOrder(list))
    for (const pane of composition.panes) expect(composition.order.some((id) => pane.id.startsWith(`${id}:`))).toBe(true)
    composition.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * EVERY SETTINGS SECTION SAYS WHERE IT SITS, and no two say the same thing.
   *
   * A rule rather than a running order, so this stays true — and stays
   * name-free — as capabilities come and go. What it catches is the state the
   * panel was actually in: sections with no `order` fall back to registration,
   * registration is topological by `requires`, and a section's position in
   * Settings then depends on which capability happens to depend on which.
   * Distinctness matters for the same reason — a tie falls through to exactly
   * that accident.
   */
  it.each(Object.keys(roots) as (keyof typeof roots)[])('%s declares a distinct order for every settings section', async (platform) => {
    const composition = await composeCapabilities(roots[platform], api(), new AbortController().signal)
    const orders = composition.settings.map((one) => one.order)
    const undeclared = composition.settings.filter((one) => one.order === undefined).map((one) => one.id)
    expect(undeclared, `settings sections with no declared order: ${undeclared.join(', ')}`).toEqual([])
    expect(new Set(orders).size, `two sections claim the same order: ${orders.join(', ')}`).toBe(orders.length)
    composition.dispose()
  })
})

/* A `RegExp` is mutable, so exporting the validator's own pattern let any
 * consumer widen what counts as a capability id — from outside the kernel,
 * with no trace at the call site. A function closing over a private pattern
 * cannot be redefined that way. */
describe('capability id validation is not reachable from outside', () => {
  it('accepts well-formed ids and refuses the shapes that matter', () => {
    expect(isCapabilityId('sync')).toBe(true)
    expect(isCapabilityId('peer-2')).toBe(true)
    for (const bad of ['', 'Sync', '2fast', 'a/b', 'a.b', 'a b', '-a', 'a_b', null, 42]) {
      expect(isCapabilityId(bad as unknown)).toBe(false)
    }
  })
})
