// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowsersPane } from './BrowsersPane'
import { fakeWire, type Browser } from '../lib/wire'

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

  /**
   * ⚠️ AND IT DOES NOT OFFER A COMMAND THAT CANNOT WORK.
   *
   * `tailscale serve` terminates TLS with a certificate Tailscale issues for
   * the `.ts.net` name, so it needs Tailscale's own certificate
   * infrastructure. A self-hosted control server has none, and the command
   * fails with *"your Tailscale account does not support getting TLS certs"* —
   * an error about an account, shown to a reader who does not have one.
   *
   * The pane printed that line to every tailnet, which is the same mistake as
   * printing a URL because Tailscale happened to be installed: confident,
   * specific, and wrong for a whole class of reader. Found by running it
   * against a real Headscale tailnet, 2026-08-26.
   */
  it('says what is true when the tailnet cannot issue certificates', async () => {
    const wire = fakeWire({
      address: async () => ({
        kind: 'not-served',
        host: 'studio.example.internal',
        command: null,
      }),
    })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/cannot issue certificates/i)).toBeTruthy()
    /* THE DEAD END IS NOT SHOWN AT ALL. Softening the wording around it would
       leave a reader with a line to copy that fails. */
    expect(screen.queryByText(/tailscale serve --bg/)).toBeNull()
    /* And it names routes that DO work rather than leaving them stuck. */
    expect(screen.getByText(/certificate authority you run yourself/i)).toBeTruthy()
  })

  it('prints no address at all when there is no HTTPS route', async () => {
    /* MEASURED 2026-08-25 against WebKit: the browser stores the `Secure`
       session cookie from http://127.0.0.1 and then refuses to SEND it. So a
       plain-HTTP URL is not a lesser answer to "where do I point my browser",
       it is a wrong one — six digits that appear to work and a reader back on
       the code screen. The pane offers none. */
    const wire = fakeWire({ address: async () => ({ kind: 'no-https', port: 27182 }) })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/will not hold a sign-in/)).toBeTruthy()
    expect(screen.queryByText(/http:\/\//)).toBeNull()
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

  /**
   * ⚠️ **THIS TEST USED TO UNMOUNT A PANE WITH NO CODE SHOWING**, and pass. It
   * never called `beginCode`, so what it measured was "the unmount effect
   * fires" — true of a pane that has nothing to cancel, which is not the case
   * anyone cares about. The condition it exists for is a LIVE offer: six digits
   * that authenticate a browser, still good, on a screen nobody is looking at.
   */
  it('cancels the live code when the pane goes away', async () => {
    const cancelCode = vi.fn(async () => {})
    const { unmount } = render(<BrowsersPane wire={fakeWire({ cancelCode })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))
    /* THE CODE IS ON SCREEN before anything is unmounted — this is the whole
       difference between this test and the one it replaced. */
    expect(await screen.findByText('100001')).toBeTruthy()
    expect(cancelCode, 'nothing should have been cancelled yet').not.toHaveBeenCalled()

    unmount()
    expect(cancelCode, 'a live code outlived the pane showing it').toHaveBeenCalled()
  })

  it('lists paired browsers and revokes one', async () => {
    let paired: Browser[] = [
      { id: 1, connected: true },
      { id: 2, connected: true },
    ]
    const revoke = vi.fn(async (id: number) => {
      paired = paired.filter((browser) => browser.id !== id)
    })
    render(<BrowsersPane wire={fakeWire({ browsers: async () => paired, revoke })} />)

    expect(await screen.findByText('Browser 1')).toBeTruthy()
    expect(await screen.findByText('Browser 2')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]!)
    expect(revoke).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryByText('Browser 1')).toBeNull())
    expect(screen.getByText('Browser 2')).toBeTruthy()
  })

  /**
   * A BROWSER THAT IS AWAY IS STILL A BROWSER, and this pane could not say so.
   *
   * It listed live SOCKETS. A phone that signed in and closed the tab holds a
   * credential for ninety days and no socket, so it vanished from the only list
   * there was — and the reader had no way to cut it off before it reconnected.
   * "Revoke this browser" was only possible while the browser happened to be
   * looking.
   */
  it('lists a browser that is not connected, and can revoke it', async () => {
    const revoke = vi.fn(async () => {})
    render(
      <BrowsersPane
        wire={fakeWire({ browsers: async () => [{ id: 7, connected: false }], revoke })}
      />,
    )

    expect(await screen.findByText(/Browser 7/)).toBeTruthy()
    expect(screen.getByText(/away/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(revoke).toHaveBeenCalledWith(7)
  })

  it('shows nothing about browsers when none are paired', async () => {
    /* An empty list with a heading over it is a pane describing a feature the
     * reader is not using. */
    render(<BrowsersPane wire={fakeWire()} />)
    await screen.findByRole('button', { name: 'Show code' })
    expect(screen.queryByText('Paired browsers')).toBeNull()
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

/**
 * THE TWO STATES THAT LOOK THE SAME AND ARE NOT: a listener that has not bound
 * yet, and a port that was taken.
 */
describe('while the listener is still binding', () => {
  /**
   * ⚠️ **"NOT BOUND YET" USED TO BE REPORTED AS "PORT ALREADY IN USE".**
   *
   * The listener binds on a spawned task, so every launch passes through the
   * pending state — and the pane asked for the address exactly once. A reader
   * who opened it during that window was told to quit whatever was holding port
   * 27182 and restart Paper, over a browser client that came up half a second
   * later. Nothing ever took it back, because there was nothing to take back
   * with: the pane had no second question to ask.
   */
  it('says it is starting, not that the port is taken', async () => {
    const wire = fakeWire({ address: async () => ({ kind: 'binding' }) })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/Starting the browser client/i)).toBeTruthy()
    expect(screen.queryByText(/already in use/i), 'a working client accused of being broken').toBeNull()
  })

  it('asks again, and draws the address once it settles', async () => {
    let bound = false
    const wire = fakeWire({
      address: async () =>
        bound
          ? { kind: 'https' as const, url: 'https://studio.tail1234.ts.net/' }
          : { kind: 'binding' as const },
    })
    render(<BrowsersPane wire={wire} />)
    expect(await screen.findByText(/Starting the browser client/i)).toBeTruthy()

    bound = true
    expect(await screen.findByText('https://studio.tail1234.ts.net/')).toBeTruthy()
  })

  /* AND IT STOPS ASKING once the answer is settled — including `unavailable`,
     which really is terminal: the plugin binds one pinned port and does not
     scan for another. An address resolution shells out to Tailscale twice, so
     a pane that kept asking would run two subprocesses every 400ms forever. */
  it('stops asking once the answer is settled', async () => {
    const address = vi.fn(async () => ({ kind: 'unavailable' as const }))
    render(<BrowsersPane wire={fakeWire({ address })} />)
    expect(await screen.findByText(/already in use/i)).toBeTruthy()

    const asked = address.mock.calls.length
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    expect(address.mock.calls.length, 'a settled address must not be re-resolved').toBe(asked)
  })
})

/**
 * HIDING A CODE IS A WITHDRAWAL, and it used to be a repaint.
 */
describe('hiding a live code', () => {
  /** Show a code and return the wire's `cancelCode` spy. */
  async function showing(cancelCode: () => Promise<void>) {
    render(<BrowsersPane wire={fakeWire({ cancelCode })} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show code' }))
    expect(await screen.findByText('100001')).toBeTruthy()
  }

  it('takes the code back from the shelf, then from the screen', async () => {
    const cancelCode = vi.fn(async () => {})
    await showing(cancelCode)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    await waitFor(() => expect(screen.queryByText('100001')).toBeNull())
    expect(cancelCode).toHaveBeenCalled()
  })

  /**
   * ⚠️ **THE CODE USED TO LEAVE THE SCREEN WHETHER OR NOT IT LEFT THE SHELF.**
   *
   * `setOffer(null); void wire.cancelCode()` — no await, no rejection handler.
   * An IPC failure therefore left six digits VALID, off screen, with the pane
   * back to "Show code" as though nothing were outstanding. The reader had done
   * the only thing available to withdraw the credential and been told it
   * worked.
   */
  it('keeps the code visible, and says so, when the shelf refuses', async () => {
    const cancelCode = vi.fn(async () => {
      throw new Error('the plugin is not answering')
    })
    await showing(cancelCode)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    expect(await screen.findByText(/still live/i)).toBeTruthy()
    expect(screen.getByText(/the plugin is not answering/i)).toBeTruthy()
    expect(
      screen.getByText('100001'),
      'a code still valid on the shelf must stay where the reader can see it',
    ).toBeTruthy()
  })

  /* AND ONE CANCELLATION AT A TIME. A second click while the first is in flight
     would cancel a code that is already being cancelled — harmless here, and
     the kind of double-fire that stops being harmless the moment `cancelCode`
     is not idempotent. */
  it('refuses a second click while the first is in flight', async () => {
    let release = () => {}
    const cancelCode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    await showing(cancelCode)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))

    const button = await screen.findByRole('button', { name: /Hiding/i })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(cancelCode).toHaveBeenCalledTimes(1)

    await act(async () => {
      release()
    })
  })
})
