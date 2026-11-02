import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createDiagnostics, createKernelServices, kernelApi } from '../../kernel'
import type { DiagnosticEntry } from '../../kernel'
import type { P2pSwitch } from './lib/p2pSwitch'

/**
 * The switch at the capability's own door: off must be the no-plugin shape, so
 * nothing above `peerPort()` can reach the transport, and `sync` still composes.
 */

const wire = vi.hoisted(() => ({ tauri: true, on: vi.fn<() => Promise<boolean>>(), recordError: null as unknown }))

vi.mock('./lib/wire', async (original) => {
  const { fakeWire } = await import('./lib/fakeWire.testkit')
  return {
    ...(await original<typeof import('./lib/wire')>()),
    hasTauri: () => wire.tauri,
    tauriWire: () => {
      const fake = fakeWire({ endpointId: 'this-device', role: 'shelf' })
      const answered = fake.setP2p.bind(fake)
      return Object.assign(fake, {
        p2pOn: wire.on,
        setP2p: async (on: boolean) => {
          const answer = await answered(on)
          return wire.recordError === null ? answer : { ...answer, recordError: wire.recordError, fileSaysOn: !on }
        },
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
  wire.tauri = true
})

const silent = { info: () => {}, warn: () => {}, error: () => {} }

/** A composition whose diagnostics are kept, so a test can read what `peer` said. */
async function composeTold() {
  const told: DiagnosticEntry[] = []
  const diagnostics = createDiagnostics({ sink: silent, record: (entry) => told.push(entry) })
  const composition = await composeCapabilities(
    [peer],
    kernelApi(createKernelServices({ fs: null, storage: null, diagnostics })),
    new AbortController().signal,
  )
  const peerSaid = (event: string) => told.filter((entry) => entry.scope === 'kernel.peer' && entry.event === event).map((entry) => entry.fields)
  return { composition, peerSaid }
}

const devicesPane = () =>
  peer.settings?.find((section) => section.title === 'Devices')?.render({ bookId: null }) as ReactElement<{ p2p: P2pSwitch | null }> | null

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

  it('says why it could not read the switch, and that it started with the transport closed', async () => {
    wire.on.mockRejectedValue(new Error('unreadable'))
    const { composition, peerSaid } = await composeTold()
    expect(peerSaid('peer.switch-unreadable')).toEqual([{ message: 'unreadable' }])
    expect(peerSaid('peer.started')).toEqual([{ available: false, p2pOn: false }])
    composition.dispose()
  })

  it('says it started with the transport open while the switch is on', async () => {
    wire.on.mockResolvedValue(true)
    const { composition, peerSaid } = await composeTold()
    expect(peerSaid('peer.switch-unreadable')).toEqual([])
    expect(peerSaid('peer.started')).toEqual([{ available: true, p2pOn: true }])
    composition.dispose()
  })

  it('says it started with the transport closed while the switch is off', async () => {
    wire.on.mockResolvedValue(false)
    const { composition, peerSaid } = await composeTold()
    expect(peerSaid('peer.started')).toEqual([{ available: false, p2pOn: false }])
    composition.dispose()
  })

  it('reads no switch and draws none where there is no plugin', async () => {
    wire.tauri = false
    const { composition, peerSaid } = await composeTold()
    expect(wire.on).not.toHaveBeenCalled()
    expect(peerSaid('peer.switch-unreadable'), 'a missing plugin is not an unreadable switch').toEqual([])
    expect(peerSaid('peer.started')).toEqual([{ available: false, p2pOn: false }])
    expect(devicesPane()?.props.p2p).toBeNull()
    composition.dispose()
  })

  it('lets go of its port and its switch when it stops', async () => {
    wire.on.mockResolvedValue(true)
    const composition = await compose()
    const p2p = devicesPane()?.props.p2p
    if (!p2p) throw new Error('no switch was drawn')
    composition.dispose()
    expect(peerPort()).toBeNull()
    const seen: boolean[] = []
    const stop = watchP2p((on) => seen.push(on))
    await p2p.set(false)
    stop()
    expect(seen, 'a watcher after the stop heard a switch the stop had released').toEqual([])
  })

  it('leaves a newer start its switch when an older one stops', async () => {
    wire.on.mockResolvedValue(true)
    const older = await compose()
    const newer = await compose()
    const p2p = devicesPane()?.props.p2p
    if (!p2p) throw new Error('no switch was drawn')
    older.dispose()
    const seen: boolean[] = []
    const stop = watchP2p((on) => seen.push(on))
    await p2p.set(false)
    stop()
    expect(seen, 'the older stop took the newer start\'s switch').toEqual([false])
    newer.dispose()
  })

  it('acquires nothing when it is stopped while it reads the switch', async () => {
    let answer: (on: boolean) => void = () => {}
    wire.on.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)))
    const stopping = new AbortController()
    const services = createKernelServices({ fs: null, storage: null })
    const starting = peer.start?.({ ...kernelApi(services), onCleanup: () => {} }, stopping.signal)
    stopping.abort()
    answer(true)
    const started = await starting
    expect(started).toEqual({ dispose: expect.any(Function) })
    expect(peerPort(), 'a start stopped mid-way opened the transport anyway').toBeNull()
    expect(devicesPane()).toBeNull()
    started?.dispose()
  })
})
