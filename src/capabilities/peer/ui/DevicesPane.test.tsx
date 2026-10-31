// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createP2pSwitch } from '../lib/p2pSwitch'
import { DevicesPane } from './DevicesPane'
import type { DevicesModel, DevicesSnapshot } from './devicesModel'

/**
 * The Devices section, mounted.
 *
 * The pane's own header said the tests live in `devicesModel.ts` "(the
 * no-jsdom rule)", and four other capability panes have had jsdom tests since
 * — so what the sentence actually described was this pane being the one with
 * none. The decision below is the pane's alone: WHERE THE INVITE APPEARS. The
 * copy button's failure told the reader to "select the code instead" while
 * the code was nowhere on screen as text, which sends them looking for an
 * affordance that was never drawn.
 */

afterEach(cleanup)

const OFFER = {
  url: 'paper://pair?v=1&id=shelf-endpoint-0000000000000000&s=sabcdef',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  expiresAt: Date.now() + 300_000,
}

const EMPTY: DevicesSnapshot = {
  available: true,
  role: 'shelf',
  peers: [],
  peersLoaded: true,
  offer: null,
  pending: null,
  sas: null,
  lastResult: null,
  roleNeedsRestart: false,
  error: null,
}

/** A model whose snapshot the test sets; the pane only draws and forwards. */
function fakeModel(over: Partial<DevicesSnapshot> = {}): DevicesModel {
  const snapshot: DevicesSnapshot = { ...EMPTY, ...over }
  const noop = async () => {}
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: noop,
    beginPairing: noop,
    cancelPairing: noop,
    confirmPairing: noop,
    pairWithCode: noop,
    forget: noop,
    setRole: noop,
    setPeerCanWrite: noop,
    dispose: () => {},
  }
}

describe('the P2P switch', () => {
  const toggle = () => screen.getByRole('switch', { name: 'Peer-to-peer' })

  it('draws no devices while off, only the switch', () => {
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(false, async () => {})} />)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('This device')).toBeNull()
  })

  it('draws the switch above the devices while on', () => {
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, async () => {})} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('This device')).toBeTruthy()
  })

  it('writes the choice and says a relaunch finishes it', async () => {
    const set = vi.fn(async () => {})
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(set).toHaveBeenCalledWith(false)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('still shows the choice after Settings closes and reopens', async () => {
    const p2p = createP2pSwitch(false, async () => {})
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this on.')
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Quit and reopen Paper to finish turning this on.')).toBeTruthy()
  })

  it('offers no Sync now once the switch has closed the transport', async () => {
    const p2p = createP2pSwitch(true, async () => {})
    render(<DevicesPane model={fakeModel()} syncNow={() => {}} p2p={p2p} />)
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })

  it('follows a write that lands after Settings closed and reopened', async () => {
    let land = () => {}
    const p2p = createP2pSwitch(true, () => new Promise<void>((resolve) => (land = resolve)))
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    land()
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('stays where it was and says why when the write is refused', async () => {
    const set = async () => {
      throw new Error('disk full')
    }
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Could not change this: disk full')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(/Quit and reopen/)).toBeNull()
  })
})

/** jsdom has no `navigator.clipboard` at all — this is the whole of it. */
function clipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

describe('the invite code, and where it is', () => {
  it('is not printed while the button can carry it', async () => {
    /* THE DELIBERATE DESIGN, and the reason the fallback below is a fallback:
       a 100-character `paper://pair?…` with a key in it is not read and
       cannot be retyped, so the button is the path and the QR is the phone's
       version of it. */
    clipboard(async () => {})
    render(<DevicesPane model={fakeModel({ offer: OFFER })} syncNow={null} />)
    expect(screen.queryByText(OFFER.url)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite code' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(screen.queryByText(OFFER.url), 'still nothing to select — it is on the clipboard').toBeNull()
  })

  it('appears when the copy fails, because that is what the failure says to select', async () => {
    /* The message named an affordance that did not exist. A reader whose
       clipboard is refused — a webview without permission, a locked-down
       policy — was told to select a code that had never been drawn. */
    clipboard(async () => {
      throw new Error('clipboard refused')
    })
    render(<DevicesPane model={fakeModel({ offer: OFFER })} syncNow={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy invite code' }))
    expect(await screen.findByRole('button', { name: /Couldn’t copy/ })).toBeTruthy()
    expect(screen.getByText(OFFER.url), 'the code the message points at').toBeTruthy()
  })
})
