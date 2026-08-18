import { describe, expect, it } from 'vitest'
import { createKernelServices } from '../../../kernel'
import { fakeWire, linkWires } from '../lib/fakeWire.testkit'
import { createPeerPort } from '../lib/port'
import { LOCAL_ONLY_SETTING, OWN_DEVICE_GRANTS, createDevicesModel, qrDataUri } from './devicesModel'

/**
 * WI-C.5 — the Devices section's logic, with no React: pairing from both
 * ends over the fake wire, the pending confirmation, the persisted
 * local-only preference, and the honest unavailable state.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function settingsOnly() {
  const map = new Map<string, string>()
  return createKernelServices({
    fs: null,
    storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) },
  }).settings
}

describe('the devices model', () => {
  it('is honestly unavailable with no port', () => {
    const model = createDevicesModel({ port: null, settings: settingsOnly() })
    expect(model.getSnapshot().available).toBe(false)
  })

  it('pairs two devices end to end: QR offer, code, pending, confirm, peers listed', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire), settings: settingsOnly() })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire), settings: settingsOnly() })

    await shelf.beginPairing('My Mac')
    const offer = shelf.getSnapshot().offer
    expect(offer).not.toBeNull()
    expect(qrDataUri(offer!.svg)).toMatch(/^data:image\/svg\+xml,/)

    await satchel.pairWithCode(offer!.url)
    expect(satchel.getSnapshot().sas).not.toBeNull()
    await tick()
    const pending = shelf.getSnapshot().pending
    expect(pending?.id).toBe('satchel-dev')

    await shelf.confirmPairing(true)
    await tick()
    await tick()
    expect(shelf.getSnapshot().pending).toBeNull()
    expect(shelf.getSnapshot().peers.map((p) => p.id)).toEqual(['satchel-dev'])
    expect(shelf.getSnapshot().peers[0]?.grants).toEqual([...OWN_DEVICE_GRANTS])
    await satchel.refresh()
    expect(satchel.getSnapshot().peers.map((p) => p.id)).toEqual(['shelf-dev'])
    expect(satchel.getSnapshot().lastResult?.ok).toBe(true)
  })

  it('a refusal persists nothing and says so', async () => {
    const shelfWire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev2' })
    const satchelWire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev2' })
    linkWires(shelfWire, satchelWire)
    const shelf = createDevicesModel({ port: createPeerPort(shelfWire), settings: settingsOnly() })
    const satchel = createDevicesModel({ port: createPeerPort(satchelWire), settings: settingsOnly() })
    await shelf.beginPairing()
    await satchel.pairWithCode(shelf.getSnapshot().offer!.url)
    await tick()
    await shelf.confirmPairing(false)
    await tick()
    await tick()
    expect(shelf.getSnapshot().peers).toEqual([])
    await satchel.refresh()
    expect(satchel.getSnapshot().peers).toEqual([])
    expect(satchel.getSnapshot().lastResult?.ok).toBe(false)
  })

  it('a bad code surfaces as an error, not a throw', async () => {
    const wire = fakeWire({ role: 'satchel', endpointId: 'satchel-dev3' })
    const model = createDevicesModel({ port: createPeerPort(wire), settings: settingsOnly() })
    await model.pairWithCode('not-a-code')
    expect(model.getSnapshot().error).toMatch(/not a pairing URI/)
  })

  it('local-only is persisted under its settings key', () => {
    const settings = settingsOnly()
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-dev4' })
    const model = createDevicesModel({ port: createPeerPort(wire), settings })
    expect(model.getSnapshot().localOnly).toBe(false)
    model.setLocalOnly(true)
    expect(model.getSnapshot().localOnly).toBe(true)
    expect(settings.get(LOCAL_ONLY_SETTING)).toBe(true)
  })
})
