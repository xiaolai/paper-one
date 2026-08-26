import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { CAPABILITY_UI as ui, ICON } from '../../../kernel'
import type { Browser, CodeOffer, WebHostAddress, WebHostWire } from '../lib/wire'

/**
 * Settings → **Browsers**: the six digits a phone types, and the browsers that
 * have typed them.
 *
 * ## Why this is not the Devices pane
 *
 * `peer` already contributes one called Devices, and two panes about devices
 * would be the duplication this project is strict about. They are kept apart
 * because the things in them are genuinely different, and the split is what the
 * names have to carry:
 *
 *   - A **device** is trusted BY KEY. It pairs once, holds a replica, syncs,
 *     and works with the shelf asleep.
 *   - A **browser** is signed in BY CODE. It holds a cookie, streams
 *     everything, and has nothing at all when the shelf is away.
 *
 * Folding them together would need one word to mean both, and the first person
 * to revoke the wrong thing would find out which.
 */

/** How often the browser list is re-read while the pane is open. */
const POLL_MS = 4000
/** How long a copy button says it worked. */
const COPIED_MS = 1600

/**
 * A button that puts one string on the clipboard and says so.
 *
 * An ADDRESS AND A CODE ARE BOTH THINGS TO CARRY SOMEWHERE ELSE — to a phone,
 * to a message, to a terminal — and retyping either is where the mistakes are.
 * `.paper-cap-code` already makes them select-all; this is the one-tap version.
 */
function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={ui.button}
      /* The label says WHAT is copied. Three copy buttons can be on this pane
       * at once — an address, a command, a code — and a screen reader hearing
       * "Copy" three times has been told nothing. */
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }}
    >
      {copied ? (
        <Check size={ICON.control} strokeWidth={ICON.stroke} />
      ) : (
        <Copy size={ICON.control} strokeWidth={ICON.stroke} />
      )}
    </button>
  )
}

/**
 * The address, in whichever of its four states this shelf is in.
 *
 * EACH STATE GETS ITS OWN ANSWER because each has a different fix, and a URL
 * that cannot work is worse than no URL — the session cookie is `Secure`, so a
 * browser reaching a plain-HTTP address takes the six digits, refuses to store
 * the credential, and returns to the code screen with nothing to say.
 */
function AddressBlock({ address }: { readonly address: WebHostAddress | null }) {
  if (address === null) return <div className={ui.hint}>Looking for an address…</div>

  switch (address.kind) {
    case 'https':
      return (
        <CopyableCode value={address.url} label="Copy the address" />
      )

    case 'not-served':
      /* THE HONEST STATE, and the one most likely to be met. Tailscale is
       * running and nothing is proxying to this port, so `https://<host>/`
       * would resolve and refuse the connection. Printing it because Tailscale
       * happened to be installed would be a guess dressed as an answer, so the
       * pane gives the command instead of the URL. */
      /* ⚠️ AND THE COMMAND IS NOT ALWAYS AVAILABLE. `tailscale serve` needs
       * Tailscale's own certificate infrastructure for the `.ts.net` name; a
       * self-hosted control server has none, and the command fails with "your
       * Tailscale account does not support getting TLS certs" — an error about
       * an account, for a reader who does not have one.
       *
       * The pane printed that line to every tailnet regardless, which is the
       * same shape of mistake as printing a URL because Tailscale happened to
       * be installed: confident, specific, and wrong for a whole class of
       * reader. When there is no command, it says what is true and names the
       * routes that do work rather than inventing one. */
      return (
        <>
          <div className={ui.hint}>
            A phone cannot reach this yet. {address.host} is on your tailnet, but nothing is serving
            the client over HTTPS — and HTTPS is not optional here, because the browser refuses to
            keep a sign-in from a plain address.
          </div>
          {address.command === null ? (
            <div className={ui.hint}>
              Your tailnet cannot issue certificates, so <code>tailscale serve</code> will not work
              here — that is a property of the control server, not of this machine. Two routes do:
              give the phone a certificate from a certificate authority you run yourself, or put a
              tunnel in front that brings its own. Paper does not pick one for you.
            </div>
          ) : (
            <>
              <div className={ui.hint}>Run this once:</div>
              <CopyableCode value={address.command} label="Copy the command" />
            </>
          )}
        </>
      )

    case 'no-https':
      /* NO ADDRESS PRINTED, and that is the whole decision. The server is
       * listening on {port} and a plain-HTTP page would load — and then the
       * sign-in would not stick, because a browser stores the `Secure` session
       * cookie and refuses to send it over `http://`, localhost included.
       * Offering that URL would have a reader type six digits, watch them
       * appear to work, and land back on the code screen. */
      return (
        <div className={ui.hint}>
          A browser cannot sign in to this shelf yet. It is listening on port {address.port}, and a
          plain address will not hold a sign-in — the browser keeps the session cookie and then
          refuses to send it without HTTPS. Put something in front of this port that terminates TLS
          on a name your browser trusts. Tailscale, Caddy and Cloudflare Tunnel all do it; which
          one is yours to pick.
        </div>
      )

    case 'unavailable':
      /* The plugin binds ONE pinned port and does not scan for another, so this
       * is not a transient state that will resolve itself. */
      return (
        <div className={ui.hint}>
          Not running — port 27182 was already in use when Paper started. Quit whatever holds it and
          reopen Paper.
        </div>
      )
  }
}

/**
 * A copyable string: the value and the button that carries it, on ONE line.
 *
 * The button was in a `.paper-cap-actions` row underneath, which put a
 * free-floating control below a block and left a reader to infer which one it
 * acted on. There are three of these on this pane — an address, a command, a
 * code — so "the copy button" was already ambiguous by the time the second
 * appeared. Attached to its own value, it cannot be.
 *
 * `.paper-cap-grow` truncates with an ellipsis, and that is the right trade for
 * a URL or a command: the whole point of the button is that nobody reads them,
 * they carry them. The six-digit code is far too short to reach it.
 */
function CopyableCode({ value, label }: { readonly value: string; readonly label: string }) {
  return (
    <div className={ui.row}>
      <code className={`${ui.code} ${ui.grow}`}>{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  )
}

export interface BrowsersPaneProps {
  readonly wire: WebHostWire
  /** Injected so a test need not wait four seconds to see a refresh. */
  readonly pollMs?: number
}

export function BrowsersPane({ wire, pollMs = POLL_MS }: BrowsersPaneProps) {
  const [address, setAddress] = useState<WebHostAddress | null>(null)
  const [offer, setOffer] = useState<CodeOffer | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [browsers, setBrowsers] = useState<readonly Browser[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  /* THE BROWSERS, NOT THE SOCKETS.
   *
   * This polled `wire.sessions()`, which is the live-socket list the webview's
   * pump serves. A browser that signed in and then closed its tab holds a
   * credential for ninety days and no socket — so it was absent from this pane
   * entirely, and the reader could not revoke it. It simply reconnected. The
   * one list that mattered for a security decision was the one that could not
   * express "this phone is still paired". */
  const refresh = useCallback(async () => {
    try {
      setBrowsers(await wire.browsers())
    } catch (thrown) {
      setProblem(thrown instanceof Error ? thrown.message : String(thrown))
    }
  }, [wire])

  /* THE ADDRESS IS ASKED ONCE, not on the poll. Resolving it shells out to
   * Tailscale twice, and a reader's tailnet does not change every four
   * seconds. */
  useEffect(() => {
    void wire
      .address()
      .then(setAddress)
      .catch((thrown: unknown) => setProblem(thrown instanceof Error ? thrown.message : String(thrown)))
  }, [wire])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [refresh, pollMs])

  /* THE COUNTDOWN IS THE CODE'S ONLY HONEST LABEL. Ninety seconds is short
   * enough that a reader who looks away has to know whether the digits in front
   * of them are still worth typing. When it reaches zero the code is gone from
   * the shelf's memory too, so the pane stops showing it rather than leaving a
   * number that no longer works. */
  const deadline = useRef(0)
  useEffect(() => {
    if (offer === null) return
    deadline.current = Date.now() + offer.expiresInMs
    setRemaining(Math.ceil(offer.expiresInMs / 1000))
    const timer = setInterval(() => {
      const left = Math.ceil((deadline.current - Date.now()) / 1000)
      if (left <= 0) {
        setOffer(null)
        setRemaining(0)
        return
      }
      setRemaining(left)
    }, 500)
    return () => clearInterval(timer)
  }, [offer])

  /* THE CODE DIES WITH THE PANE. Leaving one live after the reader navigates
   * away means six digits nobody is watching are still good — the shelf cannot
   * know the screen is gone unless this says so. */
  useEffect(() => {
    return () => void wire.cancelCode().catch(() => {})
  }, [wire])

  const show = useCallback(async () => {
    setProblem(null)
    try {
      setOffer(await wire.beginCode())
    } catch (thrown) {
      setProblem(thrown instanceof Error ? thrown.message : String(thrown))
    }
  }, [wire])

  const revoke = useCallback(
    async (id: number) => {
      setProblem(null)
      try {
        await wire.revoke(id)
      } catch (thrown) {
        setProblem(thrown instanceof Error ? thrown.message : String(thrown))
      }
      await refresh()
    },
    [refresh, wire],
  )

  const unavailable = address !== null && address.kind === 'unavailable'

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Browser client</span>
      </div>

      <div className={ui.hint}>
        Read on a phone without installing anything: open this address in its browser and type a
        code. The books stay here — a browser reads them over the network and keeps none.
      </div>

      <AddressBlock address={address} />

      {offer === null ? (
        <div className={ui.actions}>
          <button
            type="button"
            className={`${ui.button} ${ui.buttonPrimary}`}
            onClick={() => void show()}
            disabled={unavailable}
            data-disabled={unavailable ? 'true' : undefined}
          >
            Show code
          </button>
        </div>
      ) : (
        <>
          {/* `paper-cap-code` is the block this design system already uses for
              something meant to be read off the screen and copied by hand. */}
          {/* Copyable as well as readable: the browser is often on this same
              machine while the code is on this same screen, and retyping six
              digits to move them two inches is the kind of small friction that
              reads as the app not having thought about it. */}
          <CopyableCode value={offer.code} label="Copy the code" />
          <div className={ui.hint}>
            Type it into the browser within {remaining}s. It works once, and five wrong tries retire
            it.
          </div>
          <div className={ui.actions}>
            <button
              type="button"
              className={ui.button}
              onClick={() => {
                setOffer(null)
                void wire.cancelCode()
              }}
            >
              Hide
            </button>
          </div>
        </>
      )}

      {browsers.length > 0 && (
        <>
          <div className={ui.row}>
            {/* "Paired", not "Connected" — the list is what may come back, and
                calling it Connected was the label that made a browser away from
                its socket look like one that had been forgotten. */}
            <span className={ui.grow}>Paired browsers</span>
            <span className={ui.value}>{browsers.length}</span>
          </div>
          {browsers.map((browser) => (
            <div className={ui.row} key={browser.id}>
              <span className={ui.grow}>
                Browser {browser.id}
                {browser.connected ? '' : ' — away'}
              </span>
              {/* Destructive and coloured rather than filled — `capability.css`
                  says a filled red block in a settings list reads as an alarm.

                  "Revoke", not "Disconnect": it takes the credential away, so a
                  browser that is away right now does not come back either. The
                  old word described the visible half of what it did. */}
              <button
                type="button"
                className={`${ui.button} ${ui.buttonDanger}`}
                onClick={() => void revoke(browser.id)}
              >
                Revoke
              </button>
            </div>
          ))}
        </>
      )}

      {problem !== null && <div className={ui.hint}>{problem}</div>}
    </div>
  )
}
