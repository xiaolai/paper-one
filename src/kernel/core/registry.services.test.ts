import { describe, expect, it, vi } from 'vitest'
import type { Capability, ServiceContribution } from './capability'
import { composeCapabilities, kernelApi } from './registry'
import { createKernelServices } from './services'

/**
 * A service row, through the composition.
 *
 * The namespace check runs over the capability's own objects; what the router
 * is built over must be what that check saw. A row the capability still holds
 * a reference to is a row it can change after the check — so the composition
 * keeps its own frozen copy of each.
 */

const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
const signal = () => new AbortController().signal

const withServices = (services: readonly ServiceContribution[], id = 'circle'): Capability => ({ id, services })

describe('a service, through the composition', () => {
  it('is called through the handler that was checked, not one swapped in afterwards', async () => {
    const service = { name: 'circle.ping', grant: 'circle:read', handler: async () => 'original' } as ServiceContribution
    const composition = await composeCapabilities([withServices([service])], api(), signal())
    ;(service as { handler: unknown }).handler = async () => 'swapped'
    const held = composition.services.get('circle.ping')
    expect(held).toBeDefined()
    await expect(held!.handler({} as never, {} as never)).resolves.toBe('original')
    /* And the copy itself does not take a new handler either. */
    expect(() => {
      ;(held as { handler: unknown }).handler = async () => 'swapped'
    }).toThrow()
    composition.dispose()
  })

  it('refuses a row with nothing to call, at composition', async () => {
    const service = { name: 'circle.ping', grant: 'circle:read', handler: 'later' } as unknown as ServiceContribution
    await expect(composeCapabilities([withServices([service])], api(), signal())).rejects.toThrow(/has no handler to call/u)
  })

  it('refuses one of the kernel’s own rows with nothing to call BY NAME, not with a TypeError from the bind', async () => {
    /* The kernel's services were bound before the namespace check ran, so a
       row with no handler failed as `.bind` of a non-function — a raw error
       naming nothing — rather than as the composition refusal every other
       row gets. */
    const service = { name: 'book.ping', grant: 'book:read', handler: 'later' } as unknown as ServiceContribution
    const refused = composeCapabilities([], api(), signal(), { services: [service] })
    await expect(refused).rejects.toThrow(/service "book.ping" has no handler to call/u)
    await expect(refused).rejects.not.toThrow(/bind/u)
  })

  it('reads an accessor-backed handler exactly once — what was checked is what is called', async () => {
    /* Checked in one place and bound in another, the row was read twice, and
       an accessor could answer the check with one function and the bind with
       another. One read: the function it answered is the one bound. */
    let reads = 0
    const row = {
      name: 'circle.ping',
      grant: 'circle:read',
      get handler() {
        reads += 1
        const nth = reads
        return async () => `read ${nth}`
      },
    } as unknown as ServiceContribution
    const composition = await composeCapabilities([withServices([row])], api(), signal())
    expect(reads).toBe(1)
    await expect(composition.services.get('circle.ping')!.handler({} as never, {} as never)).resolves.toBe('read 1')
    composition.dispose()
  })

  /* READ ONCE AND BOUND, like every other checked method. A spread copies own
     enumerable keys only: a handler inherited from a prototype passed the
     check and vanished from the copy, and one reading `this` ran with the
     copy for a receiver. */
  it('keeps an inherited handler, and calls it with its own receiver', async () => {
    class Row {
      readonly name = 'circle.ping'
      readonly grant = 'circle:read'
      readonly word = 'from the receiver'
      async handler(): Promise<string> {
        return this.word
      }
    }
    const composition = await composeCapabilities([withServices([new Row() as unknown as ServiceContribution])], api(), signal())
    const held = composition.services.get('circle.ping')
    expect(typeof held?.handler).toBe('function')
    await expect(held!.handler({} as never, {} as never)).resolves.toBe('from the receiver')
    composition.dispose()
  })
})

/* A SNAPSHOT HAS NO LIVE PARTS. The pane record was a frozen copy while its
   `screens` array stayed the capability's own, so the list the fitting rule
   reads could be emptied or extended after the namespace check. */
describe('a pane’s screens, snapshotted', () => {
  it('are a frozen copy the capability cannot change afterwards', async () => {
    const screens = ['library']
    const pane = { id: 'circle:pane', label: 'Circle', screens, render: () => 'drawn' } as unknown as NonNullable<Capability['panes']>[number]
    const composition = await composeCapabilities([{ id: 'circle', panes: [pane] }], api(), signal())
    screens.length = 0
    screens.push('reader')
    expect(composition.panes[0]!.screens).toEqual(['library'])
    expect(Object.isFrozen(composition.panes[0]!.screens)).toBe(true)
    composition.dispose()
  })
})

describe('a contribution with nothing to call', () => {
  it('is refused at composition: a pane, a settings section, a status', async () => {
    const pane = { id: 'circle:pane', label: 'Circle', screens: ['library'], render: undefined } as unknown as NonNullable<Capability['panes']>[number]
    await expect(composeCapabilities([{ id: 'circle', panes: [pane] }], api(), signal())).rejects.toThrow(/pane "circle:pane" has no render\(\) to call/u)
    const section = { id: 'circle:section', title: 'Circle' } as unknown as NonNullable<Capability['settings']>[number]
    await expect(composeCapabilities([{ id: 'circle', settings: [section] }], api(), signal())).rejects.toThrow(/settings section "circle:section" has no render\(\) to call/u)
  })

  it('is called through the method that was checked, not one swapped in afterwards', async () => {
    const status = {
      id: 'circle:reading' as const,
      subscribe: () => () => {},
      of: () => ({ label: 'original' }),
    }
    const composition = await composeCapabilities([{ id: 'circle', bookStatuses: [status] }], api(), signal())
    ;(status as { of: unknown }).of = () => ({ label: 'swapped' })
    expect(composition.bookStatuses[0]!.of({} as never)).toEqual({ label: 'original' })
    composition.dispose()
  })
})

describe('every contribution, checked and then bound', () => {
  const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
  const signal = () => new AbortController().signal

  it('composes a pane, a settings section, an action and a status that are whole, and calls each through its own copy', async () => {
    const seen: string[] = []
    const cap: Capability = {
      id: 'circle',
      panes: [{ id: 'circle:pane', label: 'Circle', screens: ['library'], render: () => 'pane drawn' } as never],
      settings: [{ id: 'circle:section', title: 'Circle', render: () => 'section drawn' } as never],
      bookActions: [{ id: 'circle:act', label: 'Act', when: () => true, run: (bookId: string) => void seen.push(bookId) } as never],
      bookStatuses: [{ id: 'circle:status', subscribe: () => () => {}, of: () => ({ label: 'reading' }) }],
      clients: [{ name: 'circle.client' }],
    }
    const composition = await composeCapabilities([cap], api(), signal())
    expect(composition.panes[0]!.render({} as never)).toBe('pane drawn')
    expect(composition.settings[0]!.render({} as never)).toBe('section drawn')
    expect(composition.bookActions[0]!.when!({} as never)).toBe(true)
    /* BOUND, not merely copied: a `when` that reads its own record answers through the composition's copy. */
    const selfish: Capability = {
      id: 'selfish',
      bookActions: [{ id: 'selfish:act', label: 'Act', when(this: { label: string }) { return this.label === 'Act' }, run: () => {} } as never],
    }
    const bound = await composeCapabilities([selfish], api(), signal())
    const when = bound.bookActions[0]!.when!
    expect(when({} as never)).toBe(true)
    composition.bookActions[0]!.run('bk1')
    expect(seen).toEqual(['bk1'])
    expect(composition.bookStatuses[0]!.of({} as never)).toEqual({ label: 'reading' })
    /* Copies, not the contributed objects — and nothing where nothing was contributed. */
    expect(composition.clients[0]).not.toBe(cap.clients![0])
    expect(composition.clients[0]).toEqual(cap.clients![0])
    expect(composition.services.size).toBe(0)
    composition.dispose()
  })

  it('refuses each callable that is missing, under the namespace code', async () => {
    const cases: [string, Capability, RegExp][] = [
      ['a pane', { id: 'circle', panes: [{ id: 'circle:pane', label: 'Circle', screens: ['library'] } as never] }, /pane "circle:pane" has no render\(\) to call/u],
      ['a settings section', { id: 'circle', settings: [{ id: 'circle:section', title: 'Circle' } as never] }, /settings section "circle:section" has no render\(\) to call/u],
      ['a book action', { id: 'circle', bookActions: [{ id: 'circle:act', label: 'Act' } as never] }, /book action "circle:act" has no run\(\) to call/u],
      ['a service', { id: 'circle', services: [{ name: 'circle.ping', grant: 'circle:read' } as never] }, /service "circle.ping" has no handler to call/u],
    ]
    for (const [what, cap, message] of cases) {
      await expect(composeCapabilities([cap], api(), signal()), what).rejects.toMatchObject({ code: 'namespace', message: expect.stringMatching(message) })
    }
  })

  it('still composes when the diagnostics port throws while a failure is being reported', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = api()
    const loud = { ...base, diagnostics: { ...base.diagnostics, error: () => { throw new Error('the log is full') } } }
    const cap: Capability = { id: 'circle', start: () => { throw new Error('cannot start') } }
    const composition = await composeCapabilities([cap], loud as never, signal())
    expect(composition.failures.some((one) => one.id === 'circle')).toBe(true)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('could not report'), expect.anything())
    spy.mockRestore()
    composition.dispose()
  })
})

describe('what a capability is handed, and what is said when one fails', () => {
  const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
  const signal = () => new AbortController().signal

  it('starts a capability with the kernel’s services, its settings and its diagnostics in hand', async () => {
    let handed: Record<string, unknown> | null = null
    const cap: Capability = {
      id: 'circle',
      start: (ctx) => {
        handed = ctx as unknown as Record<string, unknown>
        return { dispose: () => {} }
      },
    }
    const composition = await composeCapabilities([cap], api(), signal())
    expect(handed).not.toBeNull()
    expect(typeof (handed as unknown as { services: { library: unknown } }).services.library).toBe('object')
    expect(typeof (handed as unknown as { diagnostics: { warn: unknown } }).diagnostics.warn).toBe('function')
    composition.dispose()
  })

  it('reports a failure under its event, naming the capability it depended on when that is why', async () => {
    const said: { event: string; fields: Record<string, unknown> }[] = []
    const base = api()
    const loud = { ...base, diagnostics: { ...base.diagnostics, error: (event: string, fields: Record<string, unknown>) => void said.push({ event, fields }) } }
    const broken: Capability = { id: 'peer', start: () => { throw new Error('no wire') } }
    const dependent: Capability = { id: 'circle', requires: ['peer'], start: () => ({ dispose: () => {} }) }
    const composition = await composeCapabilities([broken, dependent], loud as never, signal())
    expect(said.map((one) => one.event)).toEqual(['composition.capability-failed', 'composition.capability-failed'])
    expect(said[0]!.fields).toMatchObject({ capability: 'peer', kind: 'start-failed', message: 'no wire' })
    expect('because' in said[0]!.fields).toBe(false)
    expect(said[1]!.fields).toMatchObject({ capability: 'circle', kind: 'requires-failed', because: 'peer' })
    composition.dispose()
  })
})

describe('a status with a method missing', () => {
  it('is refused at composition by name', async () => {
    const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
    const signal = () => new AbortController().signal
    const noOf = { id: 'circle:status', subscribe: () => () => {} } as never
    await expect(composeCapabilities([{ id: 'circle', bookStatuses: [noOf] }], api(), signal())).rejects.toMatchObject({ code: 'namespace', message: expect.stringMatching(/book status "circle:status" has no of\(\) to call/u) })
    const noSubscribe = { id: 'circle:status', of: () => null } as never
    await expect(composeCapabilities([{ id: 'circle', bookStatuses: [noSubscribe] }], api(), signal())).rejects.toMatchObject({ message: expect.stringMatching(/has no subscribe\(\) to call/u) })
  })
})

describe('a capability that contributes no clients', () => {
  it('contributes none', async () => {
    const api = () => kernelApi(createKernelServices({ fs: null, storage: null }))
    const composition = await composeCapabilities([{ id: 'circle' }], api(), new AbortController().signal)
    expect(composition.clients).toEqual([])
    composition.dispose()
  })
})
