// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_UI } from '../../../kernel'
import { createP2pSwitch } from '../lib/p2pSwitch'
import type { P2pAnswer, PairingResult } from '../lib/wire'
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

const landed = async (on: boolean): Promise<P2pAnswer> => ({ closed: !on, recordError: null, fileSaysOn: on })

describe('the P2P switch', () => {
  const toggle = () => screen.getByRole('switch', { name: 'Peer-to-peer' })

  it('draws no devices while off, only the switch', () => {
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(false, landed)} />)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('This device')).toBeNull()
  })

  it('draws the switch above the devices while on', () => {
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, landed)} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('This device')).toBeTruthy()
  })

  it('says On or Off in words, not only in its state', () => {
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, landed)} />)
    expect(toggle().textContent).toBe('On')
    cleanup()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(false, landed)} />)
    expect(toggle().textContent).toBe('Off')
  })

  it('takes down the last failure as soon as it is asked again', async () => {
    const set = vi
      .fn<(on: boolean) => Promise<P2pAnswer>>()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockImplementationOnce(() => new Promise<P2pAnswer>(() => {}))
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Could not change this: ipc down')
    fireEvent.click(toggle())
    expect(screen.queryByText('Could not change this: ipc down')).toBeNull()
  })

  it('writes the choice and says a relaunch finishes it', async () => {
    const set = vi.fn(landed)
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(set).toHaveBeenCalledWith(false)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('still shows the choice after Settings closes and reopens', async () => {
    const p2p = createP2pSwitch(false, landed)
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this on.')
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('Quit and reopen Paper to finish turning this on.')).toBeTruthy()
  })

  it('offers no Sync now once the switch has closed the transport', async () => {
    const p2p = createP2pSwitch(true, landed)
    render(<DevicesPane model={fakeModel()} syncNow={() => {}} p2p={p2p} />)
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })

  /* Every one of these goes through `PeerState::node`, which refuses once the
     transport has closed, and that stays so if the switch goes back on. */
  it('draws no device controls once the switch has closed the transport, and none when it goes back on', async () => {
    const p2p = createP2pSwitch(true, landed)
    render(
      <DevicesPane
        model={fakeModel({
          role: 'shelf',
          peersLoaded: true,
          peers: [{ id: 'a', name: 'Phone', platform: 'ios', role: 'satchel', grants: [], pairedAt: 1, lastSeenAt: 1, lastAddrs: [] }],
          pending: { id: 'b', name: 'Tablet', platform: 'ios', sas: '1234', attemptId: 'attempt', kind: 'device' },
        })}
        syncNow={null}
        p2p={p2p}
      />,
    )
    const controls = ['Pair a new device…', 'Revoke', 'Refuse']
    for (const name of controls) expect(screen.getByRole('button', { name }), name).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()

    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    for (const name of controls) expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('This device')).toBeNull()

    fireEvent.click(toggle())
    await screen.findByText('Quit and reopen Paper to finish turning this on.')
    for (const name of controls) expect(screen.queryByRole('button', { name }), name).toBeNull()
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('follows a write that lands after Settings closed and reopened', async () => {
    let land = () => {}
    const p2p = createP2pSwitch(true, () => new Promise<P2pAnswer>((resolve) => (land = () => resolve({ closed: true, recordError: null, fileSaysOn: false }))))
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    land()
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('stays disabled through a write that outlives the pane that asked, until it lands', async () => {
    let land = () => {}
    const p2p = createP2pSwitch(true, () => new Promise<P2pAnswer>((resolve) => (land = () => resolve({ closed: true, recordError: null, fileSaysOn: false }))))
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
    land()
    await screen.findByText('Quit and reopen Paper to finish turning this off.')
    expect((toggle() as HTMLButtonElement).disabled).toBe(false)
  })

  it('comes back enabled when a write that outlived its pane is refused', async () => {
    let refuse = () => {}
    const p2p = createP2pSwitch(true, () => new Promise<P2pAnswer>((_resolve, reject) => (refuse = () => reject(new Error('disk full')))))
    const first = render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    fireEvent.click(toggle())
    first.unmount()
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={p2p} />)
    refuse()
    await waitFor(() => expect((toggle() as HTMLButtonElement).disabled).toBe(false))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
  })

  it('stays where it was and says why when turning on is not recorded', async () => {
    const set = async () => ({ closed: false, recordError: new Error('disk full'), fileSaysOn: null })
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(false, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Could not change this: disk full')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText(/Quit and reopen/)).toBeNull()
  })

  /* The sync after the rename failed: the file says the new word, and so does the row. */
  it('reads what the file reads when the write failed after landing, and says it may not last', async () => {
    const set = async () => ({ closed: true, recordError: new Error('could not persist'), fileSaysOn: false })
    render(<DevicesPane model={fakeModel()} syncNow={null} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('This changed, but it may not survive a power cut: could not persist')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText(/Could not change this/)).toBeNull()
    screen.getByText('Quit and reopen Paper to finish turning this off.')
  })

  /* The plugin closes on an Off whether or not the record landed, and says so,
     so the device controls would all be refused. */
  it('says why and asks for a launch when an Off closed the transport without being recorded', async () => {
    const set = async () => ({ closed: true, recordError: new Error('disk full'), fileSaysOn: null })
    render(<DevicesPane model={fakeModel()} syncNow={() => {}} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Could not change this: disk full')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await screen.findByText('Quit and reopen Paper to finish turning this on.')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull())
  })

  /* An IPC failure, say. The endpoints may be serving, so the controls stay and
     the row must not tell the reader the connections have gone. */
  it('says why and keeps the device controls when an Off is rejected, because that closed nothing', async () => {
    const set = async () => {
      throw new Error('ipc down')
    }
    render(<DevicesPane model={fakeModel()} syncNow={() => {}} p2p={createP2pSwitch(true, set)} />)
    fireEvent.click(toggle())
    await screen.findByText('Could not change this: ipc down')
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(/Quit and reopen/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy()
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

describe('what the pane draws from the snapshot', () => {
  const PEER = { id: 'a', name: 'Phone', platform: 'ios', role: 'satchel' as const, grants: [], pairedAt: 1, lastSeenAt: 1, lastAddrs: [] }
  const draw = (over: Partial<DevicesSnapshot> = {}) => render(<DevicesPane model={fakeModel(over)} syncNow={null} />)
  const ASKED = 'Where do your books live?'
  const PRIMARY = `${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`
  const result = (over: Partial<PairingResult>): PairingResult => ({ ok: false, kind: 'device', ...over }) as PairingResult

  it('asks where the books live only once the peers are read, and only while there are none', () => {
    draw({ peersLoaded: true, peers: [] })
    expect(screen.getByText(ASKED)).toBeTruthy()
    cleanup()
    draw({ peersLoaded: false, peers: [] })
    expect(screen.queryByText(ASKED)).toBeNull()
    cleanup()
    draw({ peersLoaded: true, peers: [PEER] })
    expect(screen.queryByText(ASKED)).toBeNull()
    cleanup()
    draw({ peersLoaded: false, peers: [PEER] })
    expect(screen.queryByText(ASKED)).toBeNull()
  })

  it('explains the side chosen, and asks for one when none is', () => {
    draw({ role: 'satchel' })
    expect(screen.getByText('This one reads from it and keeps the books you download.')).toBeTruthy()
    cleanup()
    draw({ role: null })
    expect(screen.getByText('Pick where the whole library is kept.')).toBeTruthy()
  })

  it('asks for a relaunch only when the side chosen is not yet in force', () => {
    draw({ roleNeedsRestart: true })
    expect(screen.getByText('Quit and reopen Paper to apply this, then pair.')).toBeTruthy()
    cleanup()
    draw({ roleNeedsRestart: false })
    expect(screen.queryByText('Quit and reopen Paper to apply this, then pair.')).toBeNull()
  })

  it('offers to pair a new device only on the shelf, and not while an invite is open', () => {
    const pair = () => screen.queryByRole('button', { name: 'Pair a new device…' })
    draw({ role: 'shelf' })
    expect(pair()).not.toBeNull()
    cleanup()
    draw({ role: 'shelf', offer: OFFER })
    expect(pair()).toBeNull()
    cleanup()
    draw({ role: 'satchel' })
    expect(pair()).toBeNull()
  })

  it('asks for an invite code only on the side that joins', () => {
    draw({ role: 'satchel' })
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pair' }).className).toBe(PRIMARY)
    cleanup()
    draw({ role: 'shelf' })
    expect(screen.queryByRole('textbox', { name: 'Pairing code' })).toBeNull()
  })

  it('marks the one action each surface is for, and the refusal as destructive', () => {
    clipboard(async () => {})
    draw({ offer: OFFER, pending: { id: 'b', name: 'Tablet', platform: 'ios', sas: '1234', attemptId: 'attempt', kind: 'device' } })
    expect(screen.getByRole('button', { name: 'Copy invite code' }).className).toBe(PRIMARY)
    expect(screen.getByRole('button', { name: 'Pair' }).className).toBe(PRIMARY)
    expect(screen.getByRole('button', { name: 'Refuse' }).className).toBe(`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonDanger}`)
  })

  it('shows the code to confirm only while there is one', () => {
    draw({ sas: '4321' })
    expect(screen.getByText('4321')).toBeTruthy()
    expect(screen.getByText(/Confirm on the other device\. Code:/u)).toBeTruthy()
    cleanup()
    draw({ sas: null })
    expect(screen.queryByText(/Confirm on the other device/u)).toBeNull()
  })

  it('says why a pairing did not finish, refused when it was not told why, and nothing when it did', () => {
    draw({ lastResult: result({ reason: 'expired' }) })
    expect(screen.getByText('Pairing did not finish: expired.')).toBeTruthy()
    cleanup()
    draw({ lastResult: result({}) })
    expect(screen.getByText('Pairing did not finish: refused.')).toBeTruthy()
    cleanup()
    draw({ lastResult: result({ ok: true }) })
    expect(screen.queryByText(/Pairing did not finish/u)).toBeNull()
    cleanup()
    draw({ lastResult: null })
    expect(screen.queryByText(/Pairing did not finish/u)).toBeNull()
  })

  it('says what failed only when something did', () => {
    draw({ error: 'the plugin is gone' })
    expect(screen.getByText('Something failed: the plugin is gone')).toBeTruthy()
    cleanup()
    draw({ error: null })
    expect(screen.queryByText(/Something failed/u)).toBeNull()
  })
})
