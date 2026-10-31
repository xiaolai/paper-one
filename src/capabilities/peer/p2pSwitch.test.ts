import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi } from '../../kernel'
import type { P2pSwitch } from './lib/p2pSwitch'

/**
 * The switch at the capability's own door: off must be the no-plugin shape, so
 * nothing above `peerPort()` can reach the transport, and `sync` still composes.
 */

const wire = vi.hoisted(() => ({ on: vi.fn<() => Promise<boolean>>(), recordError: null as unknown }))

vi.mock('./lib/wire', async (original) => {
  const { fakeWire } = await import('./lib/fakeWire.testkit')
  return {
    ...(await original<typeof import('./lib/wire')>()),
    hasTauri: () => true,
    tauriWire: () => {
      const fake = fakeWire({ endpointId: 'this-device', role: 'shelf' })
      const answered = fake.setP2p.bind(fake)
      return Object.assign(fake, {
        p2pOn: wire.on,
        setP2p: async (on: boolean) => ({ ...(await answered(on)), recordError: wire.recordError }),
      })
    },
  }
})

const { peer, p2pAvailable, peerPort, personPort, watchP2p } = await import('./index')

const compose = () =>
  composeCapabilities([peer], kernelApi(createKernelServices({ fs: null, storage: null })), new AbortController().signal)

afterEach(() => {
  vi.clearAllMocks()
  wire.recordError = null
})

describe('the P2P switch at the peer capability', () => {
  it('holds no port while off, and is not a failure', async () => {
    wire.on.mockResolvedValue(false)
    const composition = await compose()
    expect(composition.failures).toEqual([])
    expect(peerPort()).toBeNull()
    expect(personPort()).toBeNull()
    composition.dispose()
  })

  it('holds a port while on', async () => {
    wire.on.mockResolvedValue(true)
    const composition = await compose()
    expect(peerPort()).not.toBeNull()
    composition.dispose()
  })

  it('counts a switch it cannot read as off, without failing the start', async () => {
    wire.on.mockRejectedValue(new Error('unreadable'))
    const composition = await compose()
    expect(composition.failures).toEqual([])
    expect(peerPort()).toBeNull()
    composition.dispose()
  })

  it('tells a watcher what the Devices switch landed on, until it stops watching', async () => {
    wire.on.mockResolvedValue(true)
    const composition = await compose()
    const seen: boolean[] = []
    const stop = watchP2p((on) => seen.push(on))
    const pane = peer.settings?.find((section) => section.title === 'Devices')?.render({ bookId: null }) as ReactElement<{
      p2p: P2pSwitch
    }>
    await pane.props.p2p.set(false)
    stop()
    await pane.props.p2p.set(true)
    expect(seen).toEqual([false])
    composition.dispose()
  })

  it('tells a watcher when Off closed the transport though the choice was not saved', async () => {
    wire.on.mockResolvedValue(true)
    const composition = await compose()
    const seen: boolean[] = []
    const stop = watchP2p((on) => seen.push(on))
    const pane = peer.settings?.find((section) => section.title === 'Devices')?.render({ bookId: null }) as ReactElement<{
      p2p: P2pSwitch
    }>
    wire.recordError = new Error('disk full')
    await expect(pane.props.p2p.set(false)).rejects.toThrow('disk full')
    stop()
    expect(seen, 'the switch still reads on, and the transport is gone').toEqual([true])
    composition.dispose()
  })

  it('answers the dependants from the same switch', async () => {
    wire.on.mockResolvedValue(false)
    await expect(p2pAvailable()).resolves.toBe(false)
    wire.on.mockResolvedValue(true)
    await expect(p2pAvailable()).resolves.toBe(true)
  })
})
