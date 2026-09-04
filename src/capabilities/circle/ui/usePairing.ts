import { useEffect, useRef, useState } from 'react'
import type { PairOffer, PairingPending, PersonPort } from '../../peer'
import { useAction } from './useAction'

/**
 * Adding somebody — WI-22.B3 — as a controller of its own: the flow's three
 * states, the acts that move it, the trouble it reports, and the busy flag
 * that only its own buttons read.
 *
 * ⚠️ **A PERSON IS ADDED BY PAIRING, NOT BY TYPING AN ID.** `circle::admit`
 * refuses a person this reader has never met, so a hand-entered id would be
 * a row that never admits anything. The six digits two humans compare are
 * what make a person real — which is why this is the pairing flow and not a
 * text field.
 *
 * ⚠️ **THE INCOMING SIDE IS NOT OPTIONAL.** Adding somebody takes two people:
 * one offers and one joins, and whichever of them is looking at this screen
 * has to be able to answer. A flow that only offered would work in exactly
 * half of every pairing.
 *
 * ⚠️ **SUBSCRIBED BY THE SCREEN, IN EVERY STATE.** A result that arrives
 * while the screen is still reading — or has no identity yet — must still
 * re-read the roster, so this is a hook the screen calls unconditionally,
 * not a section mounted once there is an identity to draw.
 */
export interface Pairing {
  /** Somebody is asking to join mine. */
  readonly pending: PairingPending | null
  /** I joined theirs: the digits to read out. */
  readonly sas: string | null
  /** I offered, and the link has not run out. */
  readonly offer: PairOffer | null
  readonly link: string
  readonly setLink: (link: string) => void
  /** Why the last attempt did not finish — a result's verdict, or an act that failed. */
  readonly trouble: string | null
  readonly busy: boolean
  readonly makeOffer: () => Promise<boolean>
  readonly stopOffering: () => Promise<boolean>
  readonly join: () => Promise<boolean>
  readonly confirm: (accept: boolean) => Promise<boolean>
}

export function usePairing(port: PersonPort | null, refresh: () => Promise<void>): Pairing {
  /* The add-somebody flow, as three states it can be in at once from two
     directions: I offered (`offer`), I joined theirs (`sas`), or somebody is
     asking to join mine (`pending`). */
  const [offer, setOffer] = useState<PairOffer | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [pending, setPending] = useState<PairingPending | null>(null)
  const [link, setLink] = useState('')
  /**
   * Why the last pairing attempt did not finish, by the result's own verdict.
   *
   * ⚠️ **NOT THE SCREEN'S READ FAILURE.** That means "I could not read your
   * circle" and replaces the whole screen; a refused pairing is a thing that
   * happened WITHIN a working screen. Putting the two in one slot did not
   * merely read oddly — the refresh that follows a result succeeds and
   * clears the failure, so the message was wiped a moment after it was set
   * and the reader saw nothing at all.
   */
  const [verdict, setVerdict] = useState<string | null>(null)
  const { busy, trouble, run } = useAction('That did not go through.')
  /* The moment the offer is judged against — advanced by a timer at the
     offer's expiry, so a link that has run out stops being shown without the
     reader having to touch anything. `Date.now()` in the render would only
     be read again on some other change. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (offer === null) return
    const left = offer.expiresAt - Date.now()
    // Stryker disable all: the render compares `expiresAt` with `now` itself, so an offer already run out is never drawn whatever this arms; the branch and the cleanup only spare a timer.
    if (left <= 0) {
      setNow(Date.now())
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), left + 1)
    return () => clearTimeout(timer)
    // Stryker restore all
  }, [offer])
  /* Which port the screen holds NOW: an act begun through an old port — the
     peer restarted while it was out — must not refresh through it after the
     new port's read, and put the old run's status and roster back. */
  const current = useRef(port)
  current.current = port

  useEffect(() => {
    if (port === null) return undefined
    const offPending = port.onPending(setPending)
    const offResult = port.onResult((result) => {
      /* ⚠️ **THE VERDICT WAS IGNORED.** This cleared every flow state and
       * refreshed whatever `ok` said, so a refusal, a bad MAC or a timeout
       * looked exactly like success: the six digits vanished and "Nobody yet"
       * came back. The reader was told a pairing had finished when it had
       * failed, and the only way to find out was that nobody appeared. */
      setPending(null)
      setSas(null)
      setOffer(null)
      setVerdict(
        result.ok
          ? null
          : result.reason === undefined
            ? 'That pairing did not complete.'
            : `That pairing did not complete (${result.reason}).`,
      )
      void refresh()
    })
    return () => {
      offPending()
      offResult()
    }
  }, [port, refresh])

  /** Run one act, then read the roster again — unless the port was replaced under it. */
  const act = (what: () => Promise<unknown>): Promise<boolean> => {
    setVerdict(null)
    return run(what, () => (current.current === port ? refresh() : undefined))
  }
  const none = () => Promise.resolve(false)

  return {
    pending,
    sas,
    offer: offer !== null && offer.expiresAt > now ? offer : null,
    link,
    setLink,
    trouble: trouble ?? verdict,
    busy,
    makeOffer: port === null ? none : () =>
      act(async () => {
        const made = await port.offer()
        /* ⚠️ **THE WHOLE OFFER, NOT JUST THE LINK.** `expiresAt` was thrown
         * away, so a dead link went on being presented as usable: sending it
         * produced an `expired` refusal, and the reader could not make another
         * without first stopping the one that had already lapsed. */
        setOffer(made)
      }),
    stopOffering: port === null ? none : () =>
      act(async () => {
        await port.cancel()
        setOffer(null)
      }),
    join: port === null ? none : () =>
      act(async () => {
        const started = await port.join(link.trim())
        setLink('')
        setSas(started.sas)
      }),
    confirm: port === null || pending === null ? none : (accept) => act(() => port.confirm(accept, pending.attemptId)),
  }
}
