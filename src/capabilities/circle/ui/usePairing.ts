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
  /** Whole seconds an offer has left, or null when there is none live. */
  readonly secondsLeft: number | null
  /**
   * An offer of mine ran out without anybody using it.
   *
   * ⚠️ **THE LINK USED TO JUST VANISH.** `offer` is nulled by the expiry
   * comparison below, so the screen silently fell back to "Add somebody" with
   * no account of where the link went — and a reader who had already sent it
   * had no way to learn it was dead. It was sent, refused as `expired`, and
   * looked like the other person's fault.
   */
  readonly lapsed: boolean
  readonly link: string
  readonly setLink: (link: string) => void
  /** Why the last attempt did not finish — a result's verdict, or an act that failed. */
  readonly trouble: string | null
  readonly busy: boolean
  readonly makeOffer: () => Promise<boolean>
  readonly stopOffering: () => Promise<boolean>
  /**
   * Back out of a join I started.
   *
   * ⚠️ **THE JOINER HAD NO WAY OUT AT ALL.** Once `sas` was set the screen
   * showed six digits and nothing else — no button of any kind — so a reader
   * whose friend had walked away from the other machine was stuck until they
   * quit the app. Pairing has a human on each end and either of them can stop;
   * only one of them could say so.
   */
  readonly stopJoining: () => Promise<boolean>
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
  /* ⚠️ **A TICK, NOT A SINGLE TIMER AT THE EXPIRY.** One `setTimeout` for the
     whole life of the offer is enough to STOP drawing it, and that is all this
     used to do — the reader got "It is good for a few minutes" and then, with
     no warning, the link was gone. A second's resolution costs one timer and
     lets the screen say how long is actually left, which is the difference
     between sending a link confidently and sending a dead one. */
  useEffect(() => {
    if (offer === null) return
    // Stryker disable all: the render compares `expiresAt` with `now` itself, so an offer already run out is never drawn whatever this arms; the interval and its cleanup only spare a timer.
    const tick = setInterval(() => setNow(Date.now()), 1000)
    setNow(Date.now())
    return () => clearInterval(tick)
    // Stryker restore all
  }, [offer])
  /* Whether the LAST offer ran out rather than being used or withdrawn. Set by
     the render's own comparison, cleared by anything that starts a new flow. */
  const [lapsed, setLapsed] = useState(false)
  const live = offer !== null && offer.expiresAt > now
  useEffect(() => {
    if (offer !== null && !live) setLapsed(true)
  }, [offer, live])
  /* Which port the screen holds NOW: an act begun through an old port — the
     peer restarted while it was out — must not refresh through it after the
     new port's read, and put the old run's status and roster back. */
  const current = useRef(port)
  current.current = port
  /* ⚠️ **IN REFS, BECAUSE THE RESULT HANDLER OUTLIVES THE RENDER THAT MADE
     IT.** The effect below is bound to `[port, refresh]`, so anything it reads
     from its closure is whatever that value was when the port was set —
     `null`, almost always. Read through a ref, these are what the screen is
     showing at the moment the result actually arrives. */
  const showing = useRef<PairingPending | null>(null)
  showing.current = pending
  const joining = useRef(false)
  joining.current = sas !== null

  useEffect(() => {
    if (port === null) return undefined
    const offPending = port.onPending(setPending)
    const offResult = port.onResult((result) => {
      /* ⚠️ **A RESULT THAT IS NOT ABOUT THE ATTEMPT ON SCREEN MUST NOT TOUCH
       * IT — and since the joiner started probing, every pairing produces
       * one.** A joiner cannot tell "you never heard me" from "your human is
       * still deciding", because this side sends nothing at all between the
       * two; so it opens a second connection beside its first, and this side
       * refuses that one `no-pending`. Acted on, that refusal cleared the six
       * digits mid-comparison and told the reader their pairing had failed
       * while it was in fact about to succeed. */
      if (!joining.current) {
        /* Routine, and generated by our own protocol rather than by anything
           the reader did. `no-pending` is the only reason that means it. */
        if (result.reason === 'no-pending') return
        const mine = showing.current
        if (mine !== null && result.attemptId !== mine.attemptId) return
      }
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
          : /* ⚠️ **`== null`, BECAUSE THE WIRE SENDS `null` AND THIS TESTED FOR
               `undefined`.** Rust's `Option<String>` serialises as `null`, so
               the branch that says "did not complete" without a reason was
               unreachable and a reasonless refusal would have read "(null)" to
               the reader. See `PairingResult.reason`. */
            (result.reason ?? null) === null
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
    offer: live ? offer : null,
    secondsLeft: live && offer !== null ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : null,
    lapsed,
    link,
    setLink,
    trouble: trouble ?? verdict,
    busy,
    makeOffer: port === null ? none : () =>
      act(async () => {
        setLapsed(false)
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
        setLapsed(false)
      }),
    stopJoining: port === null ? none : () =>
      act(async () => {
        await port.cancel()
        setSas(null)
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
