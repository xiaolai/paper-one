import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CapabilityError,
  KERNEL_DEFAULT_PANE,
  composeCapabilities,
  createKernelServices,
  kernelApi,
  registrationOrder,
  resolvePaneId,
  type Capability,
  type CommandContext,
  type Composition,
  type Diagnostics,
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

describe('atomic registration', () => {
  it('a start that throws disposes the started ones in reverse and registers nothing', async () => {
    const events: string[] = []
    const boom = new Error('no network')
    const promise = composeCapabilities(
      [
        cap('a', { panes: [{ id: 'a:pane', label: 'A', screens: ['reader'], render: () => null }] }, events),
        cap('b', { services: [{ name: 'b.ping', grant: 'b:ping', handler: async () => null }] }, events),
        cap('c', {}, events, { throwOnStart: boom }),
        cap('d', {}, events),
      ],
      api(),
      new AbortController().signal,
    )
    const error = await rejection(promise)
    expect(error.code).toBe('start-failed')
    expect(error.capability).toBe('c')
    expect(error.cause).toBe(boom)
    // b then a — reverse. d never started.
    expect(events).toEqual(['start a', 'start b', 'start c', 'dispose b', 'dispose a'])
    // No timer of any of them is left: nothing stays registered.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a start that returns no Disposable is a failed start', async () => {
    const events: string[] = []
    const error = await rejection(
      composeCapabilities([cap('a', {}, events), cap('b', {}, events, { noDisposable: true })], api(), new AbortController().signal),
    )
    expect(error.code).toBe('start-failed')
    expect(error.capability).toBe('b')
    expect(events).toEqual(['start a', 'start b', 'dispose a'])
    // a's timer was cleared by its dispose; b's own timer is what a start with
    // no Disposable leaks — which is exactly why such a start is refused.
    vi.clearAllTimers()
  })

  it('a dispose that throws during rollback does not stop the rest, and is reported with the cause', async () => {
    const events: string[] = []
    const error = await rejection(
      composeCapabilities(
        [
          cap('a', {}, events),
          cap('b', {}, events, { throwOnDispose: new Error('b will not go') }),
          cap('c', {}, events, { throwOnStart: new Error('c fails') }),
        ],
        api(),
        new AbortController().signal,
      ),
    )
    expect(events).toEqual(['start a', 'start b', 'start c', 'dispose b', 'dispose a'])
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors.map((e) => (e as Error).message)).toEqual(['c fails', 'b will not go'])
    expect(vi.getTimerCount()).toBe(0)
  })

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
    expect(error.capability).toBe('c')
    expect(events).toEqual(['start a', 'start slow', 'dispose slow', 'dispose a'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

/* ------------------------------------------------------------- lifecycle */

describe('the KernelApi a start receives', () => {
  it('carries the services, the settings store and a Diagnostics scoped to the capability', async () => {
    const diagnostics = recordingDiagnostics()
    const kernel = api(diagnostics)
    const seen: KernelApi[] = []
    const composition = await composeCapabilities(
      [{ id: 'sync', start: (ctx) => (seen.push(ctx), ctx.diagnostics.info('hello'), { dispose: () => {} }) }],
      kernel,
      new AbortController().signal,
    )
    expect(seen[0]?.services).toBe(kernel.services)
    expect(seen[0]?.settings).toBe(kernel.settings)
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

/* ------------------------------------------------------- stale pane ids */

describe('resolvePaneId — a persisted lastPane naming an absent pane', () => {
  const known = ['example:pane', 'sync:status']

  it('falls back to the kernel default for a contributed id nobody composed', () => {
    expect(resolvePaneId('companion-old:pane', known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('gone:pane', [])).toBe('companion')
  })

  it('keeps a contributed id the composition has, and every kernel id', () => {
    expect(resolvePaneId('sync:status', known)).toBe('sync:status')
    expect(resolvePaneId('notes', known)).toBe('notes')
    expect(resolvePaneId('library', [])).toBe('library')
  })

  it('treats anything that is not a string, or a string that is neither, as absent', () => {
    expect(resolvePaneId(undefined, known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId(42, known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('Notes', known)).toBe(KERNEL_DEFAULT_PANE)
    expect(resolvePaneId('kernel:notes', known)).toBe(KERNEL_DEFAULT_PANE)
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
})
