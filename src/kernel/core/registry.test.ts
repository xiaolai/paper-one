import { describe, expect, it } from 'vitest'
import type { Capability } from './capability'
import { composeCapabilities, isCapabilityId, kernelApi, resolvePaneId } from './registry'
import { createKernelServices } from './services'

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
