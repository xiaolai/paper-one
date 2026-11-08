import { describe, expect, it, vi } from 'vitest'
import type { Capability } from './capability'
import { defineSetting } from './ports'
import {
  CapabilityError,
  composeCapabilities,
  isCapabilityId,
  kernelApi,
  registrationOrder,
  resolvePaneId,
  scopeSettings,
  scopeStorage,
} from './registry'
import { createKernelServices, type KernelServices } from './services'

/**
 * The registry's small answers, asked of the registry itself.
 *
 * `composition.contract.test.ts` asks most of these through the kernel's
 * index, which the mutation gate does not count as reaching this module: it
 * runs the tests that import `registry.ts`, so a rule held only there was a
 * rule no mutant of it could fail.
 */

describe('isCapabilityId', () => {
  it('holds the whole id to the rule, not some part of it', () => {
    expect(isCapabilityId('sync')).toBe(true)
    expect(isCapabilityId('peer-2')).toBe(true)
    for (const bad of ['Sync', 'sync.x', 'sync x', '2fast', '', null]) expect(isCapabilityId(bad)).toBe(false)
  })
})

describe('the reserved id', () => {
  it('refuses a capability that calls itself the kernel, and says so by name', async () => {
    const kernel: Capability = { id: 'kernel', start: () => ({ dispose: () => {} }) }
    const composing = composeCapabilities([kernel], kernelApi(createKernelServices({ fs: null, storage: null })), new AbortController().signal)
    await expect(composing).rejects.toMatchObject({ code: 'reserved-id', message: '"kernel" is not a capability id' })
  })
})

describe('resolvePaneId', () => {
  /* Only a contributed id, which is namespaced, is looked up in `known`: an
     unnamespaced name that is no kernel pane is not a pane, whatever a
     composition lists. */
  it('falls back for a name with no namespace, even one the composition lists', () => {
    expect(resolvePaneId('pane', ['pane'], 'library')).toBe('library')
    expect(resolvePaneId('example:pane', ['example:pane'], 'library')).toBe('example:pane')
  })

  /* The default is asserted by what it does, not by the name it holds: it is
     a kernel pane, so it resolves to itself against a composition that lists
     nothing, whatever fallback the caller names. */
  it('falls back by default to a kernel pane, which resolves to itself with nothing composed', () => {
    const fallback = resolvePaneId('gone:pane', [])
    expect(resolvePaneId(fallback, [], 'library')).toBe(fallback)
  })
})

describe('a disposed composition', () => {
  it('contributes no book status', async () => {
    const status: Capability = {
      id: 'shelf',
      bookStatuses: [{ id: 'shelf:status', subscribe: () => () => {}, of: () => null }],
      start: () => ({ dispose: () => {} }),
    }
    const services = createKernelServices({ fs: null, storage: null })
    const composition = await composeCapabilities([status], kernelApi(services), new AbortController().signal)
    expect(composition.bookStatuses).toHaveLength(1)
    composition.dispose()
    expect(composition.bookStatuses).toEqual([])
  })

  it('answers every contributed list with an empty one', async () => {
    const services = createKernelServices({ fs: null, storage: null })
    const composition = await composeCapabilities([], kernelApi(services), new AbortController().signal)
    composition.dispose()
    expect(composition.panes).toEqual([])
    expect(composition.screens).toEqual([])
    expect(composition.overlays).toEqual([])
    expect(composition.settings).toEqual([])
    expect(composition.bookActions).toEqual([])
    expect(composition.bookStatuses).toEqual([])
    expect(composition.markControls).toEqual([])
    expect(composition.clients).toEqual([])
    expect(composition.services.size).toBe(0)
  })
})

describe('a requires cycle', () => {
  const cap = (id: string, requires: readonly string[] = []): Capability => ({
    id,
    requires,
    start: () => ({ dispose: () => {} }),
  })
  const compose = (caps: readonly Capability[]) =>
    composeCapabilities(caps, kernelApi(createKernelServices({ fs: null, storage: null })), new AbortController().signal)

  it('is refused, naming every member and no bystander', async () => {
    await expect(compose([cap('a', ['b']), cap('b', ['a'])])).rejects.toMatchObject({
      code: 'cyclic-requires',
      message: 'requires cycle among: a, b',
    })
    await expect(compose([cap('a', ['c']), cap('b', ['a']), cap('c', ['b']), cap('d')])).rejects.toMatchObject({
      code: 'cyclic-requires',
      message: 'requires cycle among: a, b, c',
    })
    await expect(compose([cap('a', ['a'])])).rejects.toMatchObject({
      code: 'cyclic-requires',
      message: 'requires cycle among: a',
    })
  })

  it('is not seen where a chain or a diamond has none', async () => {
    const chain = await compose([cap('c', ['b']), cap('b', ['a']), cap('a')])
    expect(chain.standing.map((one) => one.id)).toEqual(['a', 'b', 'c'])
    const diamond = await compose([cap('d', ['b', 'c']), cap('c', ['a']), cap('b', ['a']), cap('a')])
    expect(diamond.standing.map((one) => one.id)).toEqual(['a', 'c', 'b', 'd'])
  })
})

/* ------------------------------------------------------------------------
 * The rules below are each held here, through the module itself, because
 * the mutation gate counts only the tests that import `registry.ts`: a rule
 * asked only through the kernel's index is a rule no mutant of it can fail.
 * ---------------------------------------------------------------------- */

const freshApi = () => kernelApi(createKernelServices({ fs: null, storage: null }))
const live = () => new AbortController().signal

/** An api whose diagnostics are written down, and whose serve can be replaced. */
function watched(serveServices?: KernelServices['serveServices']) {
  const base = freshApi()
  const said: [level: 'info' | 'error', event: string, fields: Record<string, unknown>][] = []
  const api = {
    ...base,
    services: serveServices ? { ...base.services, serveServices } : base.services,
    diagnostics: {
      ...base.diagnostics,
      info: (event: string, fields: Record<string, unknown>) => void said.push(['info', event, fields]),
      error: (event: string, fields: Record<string, unknown>) => void said.push(['error', event, fields]),
    },
  }
  return { api: api as typeof base, said }
}

const pane = (id: string, order?: number) =>
  ({ id, label: id, screens: ['library'], render: () => null, ...(order === undefined ? {} : { order }) }) as never

describe('CapabilityError', () => {
  /* A log line or an error boundary names the error by `name`; a composition
     refusal must read as one, not as a plain Error. */
  it('names itself', () => {
    const error = new CapabilityError('namespace', 'circle', 'refused')
    expect(error.name).toBe('CapabilityError')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('scopeSettings', () => {
  const mine = defineSetting('circle.size', 1, (raw) => (typeof raw === 'number' ? raw : undefined))
  const theirs = defineSetting('other.secret', 'x', (raw) => (typeof raw === 'string' ? raw : undefined))
  const setup = () => {
    const store = createKernelServices({ fs: null, storage: null }).settings
    return { store, scoped: scopeSettings(store, 'circle') }
  }

  /* A capability's own preference reads, answers and saves exactly as the
     kernel's store does: the scope is a fence, not a second store. */
  it('passes its own settings through to the store', () => {
    const { store, scoped } = setup()
    expect(scoped.has(mine)).toBe(false)
    expect(scoped.get(mine)).toBe(1)
    scoped.set(mine, 4)
    expect(store.get(mine)).toBe(4)
    expect(scoped.get(mine)).toBe(4)
    expect(scoped.has(mine)).toBe(true)
  })

  /* Reading, asking about or overwriting another capability's preference is
     refused BY NAME, so the build defect is found where it was made. */
  it('refuses a setting outside its namespace, on every door, naming the key', () => {
    const { store, scoped } = setup()
    const refusal = { code: 'namespace', message: 'capability "circle" may only touch settings under "circle.", not "other.secret"' }
    expect(() => scoped.get(theirs)).toThrow(expect.objectContaining(refusal))
    expect(() => scoped.has(theirs)).toThrow(expect.objectContaining(refusal))
    expect(() => scoped.set(theirs, 'stolen')).toThrow(expect.objectContaining(refusal))
    expect(store.get(theirs)).toBe('x')
  })

  /* A capability's view redraws when its preferences change, and stops
     listening when it lets go. */
  it('delivers changes to a subscriber until it unsubscribes', () => {
    const { scoped } = setup()
    const heard = vi.fn()
    const unsubscribe = scoped.subscribe(heard)
    scoped.set(mine, 2)
    expect(heard).toHaveBeenCalled()
    const calls = heard.mock.calls.length
    unsubscribe()
    scoped.set(mine, 3)
    expect(heard).toHaveBeenCalledTimes(calls)
  })

  /* "Not saved on this device" must be said by a capability exactly when the
     kernel's own pane says it. */
  it('reports the store’s persistence as its own', () => {
    const { store, scoped } = setup()
    expect(typeof store.persistent).toBe('boolean')
    expect(scoped.persistent).toBe(store.persistent)
  })

  /* The snapshot shows only this capability's keys, and is the SAME object
     until something changes: `useSyncExternalStore` loops on a fresh one. */
  it('snapshots only its own keys, stable until the store changes', () => {
    const { store, scoped } = setup()
    store.set(theirs, 'kept')
    store.set(mine, 5)
    const first = scoped.getSnapshot()
    expect(Object.keys(first)).toEqual(['circle.size'])
    expect(scoped.getSnapshot()).toBe(first)
    store.set(mine, 6)
    const second = scoped.getSnapshot()
    expect(second).not.toBe(first)
    expect(Object.keys(second)).toEqual(['circle.size'])
    expect(second['circle.size']).not.toEqual(first['circle.size'])
  })
})

describe('scopeStorage', () => {
  const raw = (withFlush: boolean) => ({
    getItem: vi.fn((key: string) => `value of ${key}`),
    setItem: vi.fn(),
    ...(withFlush ? { flush: vi.fn(async () => {}) } : {}),
  })

  /* No storage underneath means none handed out, not a wrapper over nothing. */
  it('is nothing over nothing', () => {
    expect(scopeStorage(null, 'circle')).toBeNull()
  })

  /* A capability's own keys read and write the flat store unchanged. */
  it('passes its own keys through', () => {
    const storage = raw(false)
    const scoped = scopeStorage(storage, 'circle')!
    expect(scoped.getItem('circle.k')).toBe('value of circle.k')
    scoped.setItem('circle.k', 'v')
    expect(storage.setItem).toHaveBeenCalledWith('circle.k', 'v')
  })

  /* Another capability's key, or one that is no key at all, is refused by
     name, and the store underneath is never touched. */
  it('refuses a foreign key or a key that is not a string, saying which side', () => {
    const storage = raw(false)
    const scoped = scopeStorage(storage, 'circle')!
    expect(() => scoped.getItem('other.k')).toThrow(expect.objectContaining({ code: 'namespace', message: 'capability "circle" may only read keys under "circle.", not "other.k"' }))
    expect(() => scoped.setItem('other.k', 'v')).toThrow(expect.objectContaining({ code: 'namespace', message: 'capability "circle" may only write keys under "circle.", not "other.k"' }))
    expect(() => scoped.getItem(42 as unknown as string)).toThrow(expect.objectContaining({ code: 'namespace', message: 'capability "circle" may only read keys under "circle.", not 42' }))
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  /* `flush` ("are the bytes down") exists on the wrapper exactly when it
     exists behind it, and reaches the real store. */
  it('offers flush only when the store has it, and flushes the store', async () => {
    const storage = raw(true)
    const scoped = scopeStorage(storage, 'circle')!
    await scoped.flush!()
    expect(storage.flush).toHaveBeenCalledOnce()
    expect('flush' in scopeStorage(raw(false), 'circle')!).toBe(false)
  })
})

describe('resolvePaneId, with what no pane can be', () => {
  /* A stored value that is not even a string (a corrupted preference) opens
     the fallback rather than throwing at launch. */
  it('falls back for an id that is not a string', () => {
    expect(resolvePaneId(42, ['42'], 'library')).toBe('library')
  })

  /* A namespaced id is a pane only when this composition contributes it: a
     capability removed since the reader last looked must not be reopened. */
  it('falls back for a contributed id this composition does not list', () => {
    expect(resolvePaneId('gone:pane', ['other:pane'], 'library')).toBe('library')
  })
})

describe('the composition list, checked before anything starts', () => {
  /* A typo in the manifest is refused by quoting it, before any start runs. */
  it('refuses an id that does not match the rule, quoting it', async () => {
    const start = vi.fn(() => ({ dispose: () => {} }))
    await expect(composeCapabilities([{ id: 'Bad', start } as never], freshApi(), live())).rejects.toMatchObject({
      code: 'invalid-id',
      capability: null,
      message: expect.stringMatching(/^capability id "Bad" does not match /u),
    })
    expect(start).not.toHaveBeenCalled()
  })

  /* Listing one capability twice would start it twice. */
  it('refuses an id listed twice', async () => {
    await expect(composeCapabilities([{ id: 'a' }, { id: 'a' }], freshApi(), live())).rejects.toMatchObject({
      code: 'duplicate-id',
      capability: 'a',
      message: 'capability "a" is listed twice',
    })
  })

  /* A requirement nobody composed would leave the dependant without what it
     stands on; the refusal names both. */
  it('refuses a requirement that is not composed, naming both', async () => {
    await expect(composeCapabilities([{ id: 'a', requires: ['ghost'] }], freshApi(), live())).rejects.toMatchObject({
      code: 'missing-requires',
      capability: 'a',
      message: 'capability "a" requires "ghost", which is not composed',
    })
  })

  /* A cycle is named by its members wherever it sits in the list, not only
     when it happens to start the list. */
  it('names a cycle that does not start the list', async () => {
    const caps: Capability[] = [{ id: 'x' }, { id: 'b', requires: ['a'] }, { id: 'a', requires: ['b'] }]
    await expect(composeCapabilities(caps, freshApi(), live())).rejects.toMatchObject({
      code: 'cyclic-requires',
      message: 'requires cycle among: a, b',
    })
  })

  /* A capability that requires nothing it lacks is no cycle. */
  it('composes a chain with no cycle in it', async () => {
    const caps: Capability[] = [{ id: 'x' }, { id: 'b', requires: ['a'] }, { id: 'a' }]
    const composition = await composeCapabilities(caps, freshApi(), live())
    expect(composition.order).toEqual(['x', 'a', 'b'])
    composition.dispose()
  })
})

describe('registrationOrder', () => {
  /* A dependency starts before its dependants, and otherwise the manifest's
     order stands, so a reader's panels never shuffle between builds. */
  it('puts a requirement first and keeps list order among the ready', () => {
    const caps: Capability[] = [{ id: 'b', requires: ['a'] }, { id: 'a' }, { id: 'c' }]
    expect(registrationOrder(caps)).toEqual(['a', 'b', 'c'])
  })

  /* Two dependants of one capability both wait for it, and both start. */
  it('releases every dependant of a capability', () => {
    const caps: Capability[] = [{ id: 'a' }, { id: 'c', requires: ['a'] }, { id: 'b', requires: ['a'] }]
    expect(registrationOrder(caps)).toEqual(['a', 'c', 'b'])
  })

  /* Called on its own, it refuses a cycle rather than return part of a list. */
  it('refuses a cycle', () => {
    expect(() => registrationOrder([{ id: 'a', requires: ['b'] }, { id: 'b', requires: ['a'] }])).toThrow(
      expect.objectContaining({ code: 'cyclic-requires', message: 'requires graph has a cycle' }),
    )
  })
})

describe('the namespace of every contribution', () => {
  const screen = (id: string) => ({ id, label: id, icon: 'people', render: () => null })
  const overlay = (id: string) => ({ id, forBook: () => null, subscribe: () => () => {} })
  const action = (id: string) => ({ id, label: id, run: () => {} })
  const status = (id: string) => ({ id, subscribe: () => () => {}, of: () => null })
  const section = (id: string) => ({ id, title: id, render: () => null })
  const service = (name: string, grant = 'circle:read') => ({ name, grant, handler: async () => null })

  /* A contribution under another capability's name could shadow it, so each
     kind is refused by its own name, saying what the name must be. */
  it.each([
    ['pane id', { panes: [pane('other:x')] }, '"other:x"', 'circle:'],
    ['settings section id', { settings: [section('other:x')] }, '"other:x"', 'circle:'],
    ['screen id', { screens: [screen('other:x')] }, '"other:x"', 'circle:'],
    ['overlay id', { overlays: [overlay('other:x')] }, '"other:x"', 'circle:'],
    ['book action id', { bookActions: [action('other:x')] }, '"other:x"', 'circle:'],
    ['book status id', { bookStatuses: [status('other:x')] }, '"other:x"', 'circle:'],
    ['service name', { services: [service('other.x')] }, '"other.x"', 'circle.'],
    ['grant', { services: [service('circle.x', 'other:read')] }, '"other:read"', 'circle:'],
    ['client name', { clients: [{ name: 'other.x' }] }, '"other.x"', 'circle.'],
  ])('refuses a foreign %s', async (kind, contributes, quoted, prefix) => {
    await expect(composeCapabilities([{ id: 'circle', ...contributes } as never], freshApi(), live())).rejects.toMatchObject({
      code: 'namespace',
      capability: 'circle',
      message: `${kind} ${quoted} of capability "circle" must be "${prefix}<name>"`,
    })
  })

  /* Two registrations under one name would leave one of them unreachable. */
  it.each([
    ['pane', 'circle:x', { panes: [pane('circle:x'), pane('circle:x')] }],
    ['settings section', 'circle:x', { settings: [section('circle:x'), section('circle:x')] }],
    ['screen', 'circle:x', { screens: [screen('circle:x'), screen('circle:x')] }],
    ['overlay', 'circle:x', { overlays: [overlay('circle:x'), overlay('circle:x')] }],
    ['book action', 'circle:x', { bookActions: [action('circle:x'), action('circle:x')] }],
    ['book status', 'circle:x', { bookStatuses: [status('circle:x'), status('circle:x')] }],
    ['service', 'circle.x', { services: [service('circle.x'), service('circle.x')] }],
    ['client', 'circle.x', { clients: [{ name: 'circle.x' }, { name: 'circle.x' }] }],
  ])('refuses a %s registered twice', async (kind, id, contributes) => {
    await expect(composeCapabilities([{ id: 'circle', ...contributes } as never], freshApi(), live())).rejects.toMatchObject({
      code: 'duplicate-contribution',
      capability: 'circle',
      message: `${kind} "${id}" is registered twice`,
    })
  })

  /* An id that is not a string is refused as a namespace error, not as a
     TypeError from deep in the check. */
  it('refuses an id that is not a string', async () => {
    await expect(composeCapabilities([{ id: 'circle', panes: [pane(42 as never)] }], freshApi(), live())).rejects.toMatchObject({
      code: 'namespace',
      message: 'pane id 42 of capability "circle" must be "circle:<name>"',
    })
  })

  /* A pane that fits no screen could never be shown. */
  it('refuses a pane that names no screen, whether the list is missing or empty', async () => {
    for (const screens of [undefined, []]) {
      const lost = { id: 'circle:p', label: 'P', screens, render: () => null } as never
      await expect(composeCapabilities([{ id: 'circle', panes: [lost] }], freshApi(), live())).rejects.toMatchObject({
        code: 'namespace',
        message: 'pane "circle:p" names no screen it fits',
      })
    }
  })

  /* A screen or an overlay with nothing to call would throw when the reader
     opens it; it is refused at composition instead, by name. */
  it('refuses a screen with no render and an overlay missing either method', async () => {
    const blank = { id: 'circle:s', label: 'S', icon: 'people' } as never
    await expect(composeCapabilities([{ id: 'circle', screens: [blank] }], freshApi(), live())).rejects.toMatchObject({
      code: 'namespace',
      message: 'screen "circle:s" has no render() to call',
    })
    for (const method of ['forBook', 'subscribe'] as const) {
      const { [method]: _gone, ...rest } = overlay('circle:o')
      await expect(composeCapabilities([{ id: 'circle', overlays: [rest as never] }], freshApi(), live())).rejects.toMatchObject({
        code: 'namespace',
        message: `overlay "circle:o" has no ${method}() to call`,
      })
    }
  })

  /* The kernel naming one service or client twice is its own defect, and is
     said to be the kernel's. */
  it('refuses a kernel service or client registered twice by the kernel', async () => {
    const row = service('book.ping', 'book:read') as never
    await expect(composeCapabilities([], freshApi(), live(), { services: [row, row] })).rejects.toMatchObject({
      code: 'duplicate-contribution',
      capability: null,
      message: 'service "book.ping" is registered twice by the kernel',
    })
    await expect(composeCapabilities([], freshApi(), live(), { clients: [{ name: 'book.c' }, { name: 'book.c' }] })).rejects.toMatchObject({
      code: 'duplicate-contribution',
      capability: null,
      message: 'client "book.c" is registered twice by the kernel',
    })
  })

  /* A capability cannot take a name the kernel already serves. */
  it('refuses a capability service or client that a kernel one already holds', async () => {
    const cap = { id: 'circle', services: [service('circle.x')] } as never
    await expect(composeCapabilities([cap], freshApi(), live(), { services: [service('circle.x') as never] })).rejects.toMatchObject({
      message: 'service "circle.x" is registered twice',
    })
    await expect(composeCapabilities([{ id: 'circle', clients: [{ name: 'circle.c' }] }], freshApi(), live(), { clients: [{ name: 'circle.c' }] })).rejects.toMatchObject({
      message: 'client "circle.c" is registered twice',
    })
  })

  /* The kernel's own services and clients are part of what the composition
     serves and hands out, ahead of any capability's. */
  it('composes the kernel’s own services and clients', async () => {
    const composition = await composeCapabilities([], freshApi(), live(), {
      services: [service('book.ping', 'book:read') as never],
      clients: [{ name: 'book.c' }],
    })
    expect([...composition.services.keys()]).toEqual(['book.ping'])
    expect(composition.clients.map((one) => one.name)).toEqual(['book.c'])
    composition.dispose()
  })
})

describe('a contributed list, arranged', () => {
  /* Declared positions first, lowest first; the undeclared after them, in
     the order they were registered, so declaring nothing means the same on
     every build. */
  it('sorts panes and sections by order, the unordered last in registration order', async () => {
    const section = (id: string, order?: number) => ({ id, title: id, render: () => null, ...(order === undefined ? {} : { order }) }) as never
    const cap: Capability = {
      id: 'circle',
      panes: [pane('circle:p0'), pane('circle:p1', 2), pane('circle:p2'), pane('circle:p3', 1)],
      settings: [section('circle:s0'), section('circle:s1', 2), section('circle:s2'), section('circle:s3', 1)],
    }
    const composition = await composeCapabilities([cap], freshApi(), live())
    expect(composition.panes.map((one) => one.id)).toEqual(['circle:p3', 'circle:p1', 'circle:p0', 'circle:p2'])
    expect(composition.settings.map((one) => one.id)).toEqual(['circle:s3', 'circle:s1', 'circle:s0', 'circle:s2'])
    composition.dispose()
  })
})

describe('an abort while composing', () => {
  /* A lifetime that is already over starts nothing. */
  it('starts nothing when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const start = vi.fn(() => ({ dispose: () => {} }))
    await expect(composeCapabilities([{ id: 'a', start }], freshApi(), controller.signal)).rejects.toMatchObject({
      code: 'aborted',
      capability: null,
      message: 'composition aborted before any capability started',
    })
    expect(start).not.toHaveBeenCalled()
  })

  /* An abort during a start unwinds everything, including the capability
     that just finished starting, and says nothing failed in the teardown. */
  it('rolls back a capability that finished starting after the abort', async () => {
    const controller = new AbortController()
    const dispose = vi.fn()
    const cap: Capability = { id: 'a', start: () => { controller.abort(); return { dispose } } }
    const error = await composeCapabilities([cap], freshApi(), controller.signal).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'start-failed', capability: 'a', message: 'capability "a" was aborted while starting; nothing stays registered' })
    expect((error as Error).cause).toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
  })

  /* A teardown that fails during that rollback is counted in the message and
     carried as the cause, because a leak is how it would otherwise surface. */
  it('reports a teardown that failed during the rollback', async () => {
    const controller = new AbortController()
    const broken = new Error('could not let go')
    const cap: Capability = { id: 'a', start: () => { controller.abort(); return { dispose: () => { throw broken } } } }
    const error = await composeCapabilities([cap], freshApi(), controller.signal).catch((e: unknown) => e)
    const message = 'capability "a" was aborted while starting; 1 teardown(s) failed during rollback'
    expect(error).toMatchObject({ code: 'start-failed', message })
    const cause = (error as Error).cause
    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).message).toBe(message)
    expect((cause as AggregateError).errors).toEqual([broken])
  })

  /* After an abort, the next capability is not even asked whether it is
     available: the lifetime is over before its turn. */
  it('starts nothing after the abort, not even the next one’s availability check', async () => {
    const controller = new AbortController()
    const available = vi.fn(() => true)
    const caps: Capability[] = [
      { id: 'a', start: () => { controller.abort(); throw new Error('stopped') } },
      { id: 'b', available, start: () => ({ dispose: () => {} }) },
    ]
    const error = await composeCapabilities(caps, freshApi(), controller.signal).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'start-failed', capability: 'b', message: 'capability "b" was not started: the composition was aborted; nothing stays registered' })
    expect(available).not.toHaveBeenCalled()
  })
})

describe('a capability whose start goes wrong', () => {
  const failureOf = async (cap: Capability) => {
    const composition = await composeCapabilities([cap], freshApi(), live())
    const [failure] = composition.failures
    composition.dispose()
    return failure!
  }

  /* A dependant of a failed capability is reported as such, by name. */
  it('names the requirement that did not compose', async () => {
    const composition = await composeCapabilities(
      [{ id: 'peer', start: () => { throw new Error('no wire') } }, { id: 'circle', requires: ['peer'] }],
      freshApi(),
      live(),
    )
    expect((composition.failures[1]!.error as Error).message).toBe('capability "circle" requires "peer", which did not compose')
    composition.dispose()
  })

  /* A start that throws leaves nothing behind: what it registered is undone,
     newest first, as a stack. */
  it('undoes its cleanups in reverse when start throws', async () => {
    const ran: string[] = []
    const failure = await failureOf({
      id: 'a',
      start: (ctx) => {
        ctx.onCleanup(() => void ran.push('first'))
        ctx.onCleanup(() => void ran.push('second'))
        throw new Error('half-way')
      },
    })
    expect(ran).toEqual(['second', 'first'])
    expect(failure).toMatchObject({ id: 'a', kind: 'start-failed' })
    expect((failure.error as Error).message).toBe('half-way')
  })

  /* A failed start that also failed to clean up is two facts, both kept. */
  it('keeps a cleanup failure beside the start failure', async () => {
    const thrown = new Error('half-way')
    const stuck = new Error('stuck')
    const failure = await failureOf({ id: 'a', start: (ctx) => { ctx.onCleanup(() => { throw stuck }); throw thrown } })
    expect(failure.error).toBeInstanceOf(AggregateError)
    expect((failure.error as AggregateError).errors).toEqual([thrown, stuck])
    expect((failure.error as AggregateError).message).toBe('capability "a" failed to start')
  })

  /* A start that hands back no Disposable has nothing the kernel could tear
     down: it is a failure, named, not a crash later at dispose. */
  it('refuses a start that returns no Disposable, or one with no dispose', async () => {
    for (const returned of [undefined, {}]) {
      const failure = await failureOf({ id: 'a', start: () => returned as never })
      expect(failure).toMatchObject({ id: 'a', kind: 'start-failed' })
      expect(failure.error).not.toBeInstanceOf(AggregateError)
      expect((failure.error as Error).message).toBe('capability "a" returned no Disposable from start')
    }
    const stuck = new Error('stuck')
    const failure = await failureOf({ id: 'a', start: (ctx) => { ctx.onCleanup(() => { throw stuck }); return undefined as never } })
    expect(failure.error).toBeInstanceOf(AggregateError)
    expect((failure.error as AggregateError).message).toBe('capability "a" returned no Disposable from start')
    expect((failure.error as AggregateError).errors).toEqual([expect.objectContaining({ message: 'capability "a" returned no Disposable from start' }), stuck])
  })

  /* A Disposable whose dispose cannot even be read is the same failure, and
     its own error is what is reported. */
  it('reports a dispose that cannot be read', async () => {
    const unreadable = new Error('unreadable')
    const disposable = { get dispose(): never { throw unreadable } }
    const failure = await failureOf({ id: 'a', start: () => disposable })
    expect(failure).toMatchObject({ id: 'a', kind: 'start-failed' })
    expect(failure.error).toBe(unreadable)
    const stuck = new Error('stuck')
    const both = await failureOf({ id: 'a', start: (ctx) => { ctx.onCleanup(() => { throw stuck }); return disposable } })
    expect((both.error as AggregateError).errors).toEqual([unreadable, stuck])
    expect((both.error as AggregateError).message).toBe('capability "a" has a Disposable whose dispose cannot be read')
  })
})

describe('a started capability’s teardown', () => {
  /* A resource acquired after start still registers its teardown, and it
     runs when the composition is disposed. */
  it('runs a cleanup registered after start', async () => {
    let later: ((dispose: () => void) => void) | null = null
    const cleanup = vi.fn()
    const composition = await composeCapabilities([{ id: 'a', start: (ctx) => { later = ctx.onCleanup; return { dispose: () => {} } } }], freshApi(), live())
    later!(cleanup)
    composition.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  /* One failing dispose is reported as itself, unwrapped, under the
     capability that failed. */
  it('reports a single dispose failure as itself', async () => {
    const broken = new Error('could not let go')
    const composition = await composeCapabilities([{ id: 'a', start: () => ({ dispose: () => { throw broken } }) }], freshApi(), live())
    const error = (() => { try { composition.dispose() } catch (e) { return e } })()
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe('1 capability dispose(s) failed: a')
    expect((error as AggregateError).errors).toEqual([broken])
    expect((error as AggregateError).errors[0]).toBe(broken)
  })

  /* A dispose and a cleanup that both fail are both reported: neither may
     eat the other. */
  it('reports both a failing dispose and a failing cleanup', async () => {
    const broken = new Error('dispose')
    const stuck = new Error('cleanup')
    const composition = await composeCapabilities(
      [{ id: 'a', start: (ctx) => { ctx.onCleanup(() => { throw stuck }); return { dispose: () => { throw broken } } } }],
      freshApi(),
      live(),
    )
    const error = (() => { try { composition.dispose() } catch (e) { return e } })() as AggregateError
    const [inner] = error.errors as [AggregateError]
    expect(inner).toBeInstanceOf(AggregateError)
    expect(inner.message).toBe('capability "a" teardown failed')
    expect(inner.errors).toEqual([broken, stuck])
  })

  /* Every capability is torn down even when some fail, newest first, and
     each failure is named. */
  it('names every capability whose dispose failed, newest first', async () => {
    const ea = new Error('a')
    const eb = new Error('b')
    const composition = await composeCapabilities(
      [{ id: 'a', start: () => ({ dispose: () => { throw ea } }) }, { id: 'b', start: () => ({ dispose: () => { throw eb } }) }],
      freshApi(),
      live(),
    )
    const error = (() => { try { composition.dispose() } catch (e) { return e } })() as AggregateError
    expect(error.message).toBe('2 capability dispose(s) failed: b, a')
    expect(error.errors).toEqual([eb, ea])
  })
})

describe('the composition’s commands', () => {
  const ctx = { screen: 'library', pane: null, hasBook: false, openPane: () => {} } as never
  const withCommands = (...ids: string[]): Capability => ({ id: 'circle', commands: () => ids.map((id) => ({ id, label: id, run: () => {} }) as never) })

  /* The palette lists a capability's own commands while it is composed, and
     none once it is disposed. */
  it('lists commands until disposed, then none', async () => {
    const composition = await composeCapabilities([withCommands('circle:x')], freshApi(), live())
    expect(composition.commands(ctx).map((one) => one.id)).toEqual(['circle:x'])
    composition.dispose()
    expect(composition.commands(ctx)).toEqual([])
  })

  /* A command under another name, or under the bare prefix, is refused as
     the palette is built. */
  it('refuses a foreign or bare command id', async () => {
    for (const id of ['other:xyz', 'circle:']) {
      const composition = await composeCapabilities([withCommands(id)], freshApi(), live())
      expect(() => composition.commands(ctx)).toThrow(
        expect.objectContaining({ code: 'namespace', message: `command id ${JSON.stringify(id)} of capability "circle" must be "circle:<name>"` }),
      )
      composition.dispose()
    }
  })

  /* Two commands with one id would make one unreachable from the palette. */
  it('refuses a command id given twice', async () => {
    const composition = await composeCapabilities([withCommands('circle:x', 'circle:x')], freshApi(), live())
    expect(() => composition.commands(ctx)).toThrow(
      expect.objectContaining({ code: 'duplicate-contribution', message: 'command id "circle:x" is registered twice' }),
    )
    composition.dispose()
  })
})

describe('serving and the composition’s lifetime', () => {
  const service = { name: 'circle.ping', grant: 'circle:read', handler: async () => null } as never

  /* Every composed service is served through the bound host; a serve that
     fails degrades visibly in the log rather than failing the boot. */
  it('serves the composed services, and logs a serve that fails', async () => {
    const serve = vi.fn(async () => ({ dispose: () => {} }))
    const { api } = watched(serve)
    const composition = await composeCapabilities([{ id: 'circle', services: [service] }], api, live())
    expect(serve).toHaveBeenCalledOnce()
    expect((serve.mock.calls[0] as unknown as [{ name: string }[]])[0].map((one) => one.name)).toEqual(['circle.ping'])
    composition.dispose()

    const failing = watched(async () => { throw new Error('no host') })
    const degraded = await composeCapabilities([{ id: 'circle', services: [service] }], failing.api, live())
    expect(failing.said).toContainEqual(['error', 'composition.serve-failed', { message: 'no host' }])
    degraded.dispose()
  })

  /* Logged once, with what started: the record a support report reads. */
  it('logs its start and its disposal once, with the started order', async () => {
    const { api, said } = watched()
    const composition = await composeCapabilities([{ id: 'a' }], api, live())
    expect(said).toContainEqual(['info', 'composition.started', { order: ['a'] }])
    composition.dispose()
    composition.dispose()
    expect(said.filter(([, event]) => event === 'composition.disposed')).toEqual([['info', 'composition.disposed', { order: ['a'] }]])
  })

  /* Services are unserved before the capabilities behind them tear down, so
     no request lands on a half-disposed handler; an unserve that fails is
     logged and the teardown continues. */
  it('unserves before tearing down, and logs an unserve that fails', async () => {
    const steps: string[] = []
    const { api, said } = watched(async () => ({ dispose: () => { steps.push('unserve'); throw new Error('stuck socket') } }))
    const composition = await composeCapabilities([{ id: 'a', start: () => ({ dispose: () => void steps.push('a') }) }], api, live())
    composition.dispose()
    expect(steps).toEqual(['unserve', 'a'])
    expect(said).toContainEqual(['error', 'composition.unserve-failed', { message: 'stuck socket' }])
  })

  /* A direct dispose retires the abort listener it added, so a long-lived
     signal does not keep the composition alive. */
  it('detaches the listener it attached', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const composition = await composeCapabilities([{ id: 'a' }], freshApi(), controller.signal)
    const [event, listener] = add.mock.calls[0]!
    expect(event).toBe('abort')
    composition.dispose()
    expect(remove).toHaveBeenCalledWith('abort', listener)
  })

  /* An abort after composition is the end of its lifetime: it disposes, and
     a dispose that fails there is logged, since nobody is left to throw to. */
  it('disposes itself on abort, logging a dispose that fails', async () => {
    const controller = new AbortController()
    const dispose = vi.fn(() => { throw new Error('could not let go') })
    const { api, said } = watched()
    const composition = await composeCapabilities([{ id: 'a', start: () => ({ dispose }), panes: [pane('a:p')] }], api, controller.signal)
    controller.abort()
    expect(dispose).toHaveBeenCalledOnce()
    expect(composition.panes).toEqual([])
    expect(said).toContainEqual(['error', 'composition.dispose-failed', { message: expect.stringContaining('1 capability dispose(s) failed: a') }])
  })

  /* An abort while the services were being served is refused, and what had
     started is torn down rather than handed back looking alive. */
  it('refuses and disposes when aborted while serving', async () => {
    const controller = new AbortController()
    const dispose = vi.fn()
    const { api } = watched(async () => { controller.abort(); return { dispose: () => {} } })
    await expect(composeCapabilities([{ id: 'a', start: () => ({ dispose }) }], api, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
      message: 'composition aborted while its services were being served',
    })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
