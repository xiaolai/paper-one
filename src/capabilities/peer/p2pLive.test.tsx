// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi } from '../../kernel'
import type { P2pSwitch } from './lib/p2pSwitch'

/** A control on a mark row, which the launch composed and the switch then closes. */

vi.mock('./lib/wire', async (original) => {
  const { fakeWire } = await import('./lib/fakeWire.testkit')
  return {
    ...(await original<typeof import('./lib/wire')>()),
    hasTauri: () => true,
    tauriWire: () => Object.assign(fakeWire({ endpointId: 'this-device', role: 'shelf' }), { p2pOn: async () => true }),
  }
})

const { peer, useP2pLive } = await import('./index')

afterEach(cleanup)

function Probe() {
  return useP2pLive() ? <button type="button">Reach a peer</button> : null
}

describe('a control that reaches a peer', () => {
  it('stays drawn while the switch is on, goes when it goes off, and stays gone when it goes back on', async () => {
    const composition = await composeCapabilities([peer], kernelApi(createKernelServices({ fs: null, storage: null })), new AbortController().signal)
    const pane = peer.settings?.find((section) => section.title === 'Devices')?.render({ bookId: null }) as ReactElement<{
      p2p: P2pSwitch
    }>
    render(<Probe />)
    expect(screen.queryByRole('button', { name: 'Reach a peer' })).not.toBeNull()

    await act(() => pane.props.p2p.set(false))
    expect(screen.queryByRole('button', { name: 'Reach a peer' }), 'the control outlived the transport').toBeNull()

    await act(() => pane.props.p2p.set(true))
    expect(screen.queryByRole('button', { name: 'Reach a peer' }), 'the endpoints stay closed until a relaunch').toBeNull()
    composition.dispose()
  })
})
