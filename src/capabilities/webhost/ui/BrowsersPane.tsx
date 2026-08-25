import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { BrowserSession, CodeOffer, WebHostStatus, WebHostWire } from '../lib/wire'

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

function describePort(status: WebHostStatus | null): string {
  if (status === null) return 'Checking…'
  /* A NULL PORT IS A REAL STATE, not a missing value. The plugin binds one
   * pinned port and does not scan for another, so a port already taken means no
   * browser can reach this shelf — and saying "not running" is the only way a
   * reader learns that without reading a log. */
  if (status.port === null) return 'Not running — the port was already in use'
  return `Serving on port ${status.port}`
}

export interface BrowsersPaneProps {
  readonly wire: WebHostWire
  /** Injected so a test need not wait four seconds to see a refresh. */
  readonly pollMs?: number
}

export function BrowsersPane({ wire, pollMs = POLL_MS }: BrowsersPaneProps) {
  const [status, setStatus] = useState<WebHostStatus | null>(null)
  const [offer, setOffer] = useState<CodeOffer | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [sessions, setSessions] = useState<readonly BrowserSession[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, live] = await Promise.all([wire.status(), wire.sessions()])
      setStatus(next)
      setSessions(live)
    } catch (thrown) {
      setProblem(thrown instanceof Error ? thrown.message : String(thrown))
    }
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

  const unavailable = status !== null && status.port === null

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Browser client</span>
        <span className={ui.value}>{describePort(status)}</span>
      </div>

      <div className={ui.hint}>
        Read on a phone without installing anything: point its browser at this computer and type a
        code. The books stay here — a browser reads them over the network and keeps none.
      </div>

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
          <code className={ui.code}>{offer.code}</code>
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

      {sessions.length > 0 && (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Connected browsers</span>
            <span className={ui.value}>{sessions.length}</span>
          </div>
          {sessions.map((session) => (
            <div className={ui.row} key={session.id}>
              <span className={ui.grow}>Browser {session.id}</span>
              {/* Destructive and coloured rather than filled — `capability.css`
                  says a filled red block in a settings list reads as an alarm. */}
              <button
                type="button"
                className={`${ui.button} ${ui.buttonDanger}`}
                onClick={() => void revoke(session.id)}
              >
                Disconnect
              </button>
            </div>
          ))}
        </>
      )}

      {problem !== null && <div className={ui.hint}>{problem}</div>}
    </div>
  )
}
