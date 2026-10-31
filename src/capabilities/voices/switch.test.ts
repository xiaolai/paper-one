import { describe, expect, it } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi, type Capability } from '../../kernel'
import { voices } from './index'

/**
 * Switched off, at the capability's own door: the engine is absent and nothing went
 * wrong. What the reading does with an empty slot is `kernel/ui/reader/voicesOff.test.ts`.
 */

async function launch(caps: readonly Capability[], switchedOff: ReadonlySet<string>) {
  const services = createKernelServices({ fs: null, storage: null })
  const composition = await composeCapabilities(caps, kernelApi(services), new AbortController().signal, { switchedOff })
  return { services, composition }
}

describe('the downloadable voices, switched off', () => {
  it('offers a switch in words a reader knows', () => {
    expect(voices.toggle?.title).toBe('Downloadable voices')
    expect(`${voices.toggle?.title} ${voices.toggle?.summary}`).not.toMatch(/plugin|capability/i)
  })

  it('leaves the engine absent and its settings undrawn, and is not a failure', async () => {
    const { services, composition } = await launch([voices], new Set(['voices']))
    expect(services.speechEngines()).toBeNull()
    expect(composition.settings).toEqual([])
    expect(composition.failures).toEqual([])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'voices', state: 'off' })])
    composition.dispose()
  })

  it('comes back whole when it is turned on again', async () => {
    const { services, composition } = await launch([voices], new Set())
    expect(services.speechEngines()).not.toBeNull()
    expect(composition.settings.map((one) => one.id)).toEqual(['voices:voices'])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'voices', state: 'on' })])
    composition.dispose()
  })
})
