// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
