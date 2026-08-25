// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowsersPane } from './BrowsersPane'
import { fakeWire, type BrowserSession } from '../lib/wire'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BrowsersPane', () => {
  it('says where the client is served, so a reader can find it', async () => {
    render(<BrowsersPane wire={fakeWire()} />)
    expect(await screen.findByText(/Serving on port 27182/)).toBeTruthy()
  })

  it('reports a failed bind as not running rather than as a missing value', async () => {
    /* The plugin binds ONE pinned port and does not scan for another, so a port
     * already in use means no browser can reach this shelf at all. A blank or a
     * dash would leave a reader with nothing to act on. */
    const wire = fakeWire({
      status: async () => ({ pluginVersion: '0', port: null, ready: false }),
    })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/Not running/)).toBeTruthy()
  })

  it('refuses to offer a code when the server never bound', async () => {
    /* §07: a control that cannot act is the app describing a feature it does
     * not have. Six digits nothing can receive is exactly that. */
    const wire = fakeWire({
      status: async () => ({ pluginVersion: '0', port: null, ready: false }),
    })
    render(<BrowsersPane wire={wire} />)
    const button = await screen.findByRole('button', { name: 'Show code' })
    await waitFor(() => expect(button.getAttribute('data-disabled')).toBe('true'))
  })

  it('shows six digits and how long they last', async () => {
    render(<BrowsersPane wire={fakeWire()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))

    expect(await screen.findByText('100001')).toBeTruthy()
    /* The countdown is the code's only honest label: ninety seconds is short
     * enough that a reader who looked away needs to know whether the digits in
     * front of them are still worth typing. */
    expect(await screen.findByText(/within 90s/)).toBeTruthy()
  })

  it('stops showing a code once it has expired', async () => {
    render(<BrowsersPane wire={fakeWire()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))
    expect(await screen.findByText('100001')).toBeTruthy()

    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(91_000)
    })

    /* NOT LEFT ON SCREEN. The shelf has forgotten it, so a reader still typing
     * it is being lied to by the pane. */
    await waitFor(() => expect(screen.queryByText('100001')).toBeNull())
  })

  it('cancels the live code when the pane goes away', async () => {
    /* The shelf cannot know the screen is gone unless the pane says so, and six
     * digits nobody is watching are still good until it does. */
    const cancelCode = vi.fn(async () => {})
    const { unmount } = render(<BrowsersPane wire={fakeWire({ cancelCode })} />)
    await screen.findByRole('button', { name: 'Show code' })
    unmount()
    expect(cancelCode).toHaveBeenCalled()
  })

  it('lists connected browsers and disconnects one', async () => {
    let live: BrowserSession[] = [{ id: 1 }, { id: 2 }]
    const revoke = vi.fn(async (id: number) => {
      live = live.filter((session) => session.id !== id)
    })
    render(<BrowsersPane wire={fakeWire({ sessions: async () => live, revoke })} />)

    expect(await screen.findByText('Browser 1')).toBeTruthy()
    expect(await screen.findByText('Browser 2')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]!)
    expect(revoke).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryByText('Browser 1')).toBeNull())
    expect(screen.getByText('Browser 2')).toBeTruthy()
  })

  it('shows nothing about browsers when none are connected', async () => {
    /* An empty list with a heading over it is a pane describing a feature the
     * reader is not using. */
    render(<BrowsersPane wire={fakeWire()} />)
    await screen.findByRole('button', { name: 'Show code' })
    expect(screen.queryByText('Connected browsers')).toBeNull()
  })

  it('surfaces a refusal from the plugin rather than swallowing it', async () => {
    const wire = fakeWire({
      beginCode: async () => {
        throw new Error('webhost is not running')
      },
    })
    render(<BrowsersPane wire={wire} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))
    expect(await screen.findByText('webhost is not running')).toBeTruthy()
  })
})
