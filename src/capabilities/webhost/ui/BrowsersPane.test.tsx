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
  it('gives an address a phone can actually open, not a port number', async () => {
    /* A port is true and useless: a reader has to guess a hostname, and every
     * guess they can make fails silently. */
    render(<BrowsersPane wire={fakeWire()} />)
    expect(await screen.findByText('https://studio.tail1234.ts.net/')).toBeTruthy()
    expect(screen.queryByText(/port 27182/)).toBeNull()
  })

  it('refuses to print a tailnet URL that nothing is serving', async () => {
    /* THE STATE MOST LIKELY TO BE MET. Tailscale is running and nothing proxies
     * to this port, so `https://<host>/` would resolve and refuse the
     * connection. Printing it because Tailscale is installed would be a guess
     * dressed as an answer — so the command appears instead of the URL. */
    const wire = fakeWire({
      address: async () => ({
        kind: 'not-served',
        host: 'studio.tail1234.ts.net',
        command: 'tailscale serve --bg http://127.0.0.1:27182',
      }),
    })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText('tailscale serve --bg http://127.0.0.1:27182')).toBeTruthy()
    expect(screen.queryByText('https://studio.tail1234.ts.net/')).toBeNull()
  })

  it('warns that a plain-HTTP address will not hold a sign-in', async () => {
    /* MEASURED 2026-08-25 against WebKit: the browser stores the `Secure`
       session cookie from http://127.0.0.1 and then refuses to SEND it, so the
       six digits appear to work and the reader lands back on the code screen.
       The pane says so rather than letting them find out. */
    const wire = fakeWire({
      address: async () => ({ kind: 'local-only', url: 'http://localhost:27182/' }),
    })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText('http://localhost:27182/')).toBeTruthy()
    expect(await screen.findByText(/will not stick/)).toBeTruthy()
  })

  it('reports a failed bind as not running rather than as a missing value', async () => {
    /* The plugin binds ONE pinned port and does not scan for another, so this
     * will not resolve itself. A blank would leave a reader nothing to act on. */
    const wire = fakeWire({ address: async () => ({ kind: 'unavailable' }) })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/Not running/)).toBeTruthy()
  })

  it('refuses to offer a code when the server never bound', async () => {
    /* §07: a control that cannot act is the app describing a feature it does
     * not have. Six digits nothing can receive is exactly that. */
    const wire = fakeWire({ address: async () => ({ kind: 'unavailable' }) })
    render(<BrowsersPane wire={wire} />)
    const button = await screen.findByRole('button', { name: 'Show code' })
    await waitFor(() => expect(button.getAttribute('data-disabled')).toBe('true'))
  })

  it('offers to copy the address, the command and the code — each named', async () => {
    /* Three copy buttons can be on this pane at once. A screen reader hearing
     * "Copy" three times has been told nothing, so each says what it carries. */
    const writeText = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<BrowsersPane wire={fakeWire()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the address' }))
    expect(writeText).toHaveBeenCalledWith('https://studio.tail1234.ts.net/')

    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the code' }))
    expect(writeText).toHaveBeenCalledWith('100001')
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
