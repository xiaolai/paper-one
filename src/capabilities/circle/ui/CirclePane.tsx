import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { KnownPerson, PairOffer, PairingPending, PersonPort, PersonStatus } from '../../peer'

/**
 * The circle, as a panel — WI-22.D3's surface.
 *
 * ## What this page is for, and what it deliberately is not
 *
 * ⚠️ **A FRIEND'S PASSAGES ARE DRAWN IN THE BOOK, NOT LISTED HERE.** That is
 * `surfaces.md`'s decision and this panel does not relitigate it: a shared
 * passage belongs on the page it is about, underlined where the sentence is,
 * and a list of quotes in a side panel is a second place to read the same book
 * badly. What is here is everything a reader cannot see by turning a page —
 * **who** is in the circle, **which device** they are speaking from, and
 * whether their own identity is one dead laptop from being gone.
 *
 * ## The custody marker is the reason this panel exists at all
 *
 * ⚠️ **"ONE DEVICE, NO COPY" IS A STANDING STATE, NOT A DIALOG.**
 * `identity.md` §"The window closes silently" is the whole argument: a reader
 * can only be shown their phrase while a working device still holds it, and a
 * laptop dies without warning — *"That single line is the difference between
 * lazy custody and negligence."* So the marker sits here permanently while it
 * is true, and nothing modal ever interrupts to demand the reader write words
 * down. Ask louder; never block.
 *
 * ## Nothing here mints anything on its own
 *
 * ⚠️ **RENDERING THIS PANEL MUST NOT CREATE A PERSON IDENTITY.** `status` is
 * read-only in Rust for exactly this reason. A reader who never shares never
 * needs an identity, and a panel that minted one on open would quietly delete
 * the laziness the whole custody design rests on — *"a phrase shown before
 * there is any context is a phrase that gets clicked through."* The one path
 * that mints is a button a reader pressed.
 */

export interface CirclePaneProps {
  /**
   * `null` on a composition with no `peer` — the browser client.
   *
   * ⚠️ **NO PLUGIN IS NO CIRCLE, WHICH IS A STATE AND NOT AN ERROR.** A panel
   * that threw here would take the whole side pane down on the one platform
   * that legitimately cannot have this feature.
   */
  readonly port: PersonPort | null
  /** How many of this reader's own devices are paired — the roster's size. */
  readonly devices: number
}

/** A person id is a 64-hex public key; nobody reads one, so nobody sees one. */
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`

export function CirclePane({ port, devices }: CirclePaneProps) {
  const [status, setStatus] = useState<PersonStatus | null>(null)
  const [people, setPeople] = useState<readonly KnownPerson[]>([])
  const [phrase, setPhrase] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /* The add-somebody flow, as three states it can be in at once from two
     directions: I offered (`offer`), I joined theirs (`sas`), or somebody is
     asking to join mine (`pending`). */
  const [offer, setOffer] = useState<PairOffer | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [pending, setPending] = useState<PairingPending | null>(null)
  const [link, setLink] = useState('')
  /**
   * Why the last pairing attempt did not finish.
   *
   * ⚠️ **NOT `failure`, WHICH IS A DIFFERENT KIND OF TROUBLE.** `failure` means
   * "I could not read your circle" and replaces the whole panel; a refused
   * pairing is a thing that happened WITHIN a working panel. Putting the two in
   * one slot did not merely read oddly — the refresh that follows a result
   * succeeds and clears `failure`, so the message was wiped a moment after it
   * was set and the reader saw nothing at all.
   */
  const [trouble, setTrouble] = useState<string | null>(null)
  /**
   * Which read is the newest — the same revision `useOverlays` keeps.
   *
   * ⚠️ **AN OLDER ANSWER COULD OVERWRITE A NEWER ONE.** A refresh started by a
   * pairing result would publish the new person, and a slow initial refresh
   * then landed and put the empty roster back — along with a status computed
   * for a circle of zero. Every read commits only if it is still the latest.
   */
  const read = useRef(0)
  /** Cleared on unmount, so nothing sets state into a gone component. */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (port === null) return
    const mine = ++read.current
    try {
      /* BOTH read before either is published: the status carries the circle's
         SIZE, so publishing the list first left a status that disagreed with
         the list beside it for as long as the second call took. */
      const met = await port.people()
      const now = await port.status(devices, met.length)
      if (!live.current || read.current !== mine) return
      setPeople(met)
      setStatus(now)
      setFailure(null)
    } catch (cause) {
      if (!live.current || read.current !== mine) return
      /* ⚠️ SHOWN, NOT SWALLOWED. A panel that fails to read the identity and
         renders the empty state is telling the reader they have no circle,
         which is a different and much worse claim than "I could not look". */
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }, [port, devices])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* ⚠️ **THE INCOMING SIDE IS NOT OPTIONAL.** Adding somebody takes two
     people: one offers and one joins, and whichever of them is looking at this
     panel has to be able to answer. A flow that only offered would work in
     exactly half of every pairing. */
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
      setTrouble(
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

  /* ⚠️ CLEARED WHENEVER ANYTHING CHANGES. The words are on screen only for as
     long as the reader is looking at the thing they asked about; leaving them
     up across a refresh is how a phrase ends up in a screen recording of
     something else. */
  useEffect(() => {
    setPhrase(null)
    /* ⚠️ **AND THE PENDING READ IS INVALIDATED WITH IT.** Clearing the state
     * did nothing to a `port.phrase()` already in flight: press Show, change
     * identity through restore or forget, and the old promise resolved
     * afterwards and put the PREVIOUS person's twelve words on screen beneath
     * the new one's id. */
    asked.current += 1
  }, [status?.personId])

  /** Which phrase request is the newest — see the effect above. */
  const asked = useRef(0)

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await what()
      await refresh()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (port === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>
          A circle needs Paper's own app on this device.
        </p>
      </div>
    )
  }

  if (failure !== null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Paper could not read your circle. {failure}</p>
        <div className={CAPABILITY_UI.actions}>
          <button type="button" className={CAPABILITY_UI.button} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (status === null) return <div className={CAPABILITY_UI.section} />

  if (!status.hasIdentity) {
    return (
      <div className={CAPABILITY_UI.section}>
        {/* ⚠️ NOT A WARNING. A reader who has never shared is in the ordinary
            state, and telling them something is missing would be false. */}
        <p className={CAPABILITY_UI.hint}>
          A circle lets a few people you know see the passages you mark, and you
          theirs. Nothing is shared until you add somebody.
        </p>
        <div className={CAPABILITY_UI.actions}>
          <button
            type="button"
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
            disabled={busy}
            onClick={() => void act(() => port.ensure())}
          >
            Start a circle
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={CAPABILITY_UI.section}>
        <div className={CAPABILITY_UI.row}>
          <span className={CAPABILITY_UI.grow}>You</span>
          <span className={CAPABILITY_UI.code}>{short(status.personId ?? '')}</span>
        </div>
        <div className={CAPABILITY_UI.row}>
          <span className={CAPABILITY_UI.grow}>This device</span>
          <span className={CAPABILITY_UI.value}>
            {status.role === 'home' ? 'holds your keys' : 'a signed-in device'}
          </span>
        </div>

        {status.atRisk ? (
          <p className={CAPABILITY_UI.hint}>
            Your circle lives on this device alone. If it is lost, you would have
            to meet everyone again. Write down the twelve words below, or add a
            second device.
          </p>
        ) : null}

        {status.canShowPhrase ? (
          <>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => {
                  if (phrase !== null) {
                    setPhrase(null)
                    return
                  }
                  const mine = ++asked.current
                  void port
                    .phrase()
                    .then((words) => {
                      if (live.current && asked.current === mine) setPhrase(words)
                    })
                    .catch((cause: unknown) => {
                      /* ⚠️ **SAID, NOT SWALLOWED.** A failed keychain read
                       * rendered as "still hidden" tells the reader the button
                       * does nothing, which is the one thing that is not true. */
                      if (live.current && asked.current === mine) {
                        setFailure(cause instanceof Error ? cause.message : String(cause))
                      }
                    })
                }}
              >
                {phrase === null ? 'Show my twelve words' : 'Hide'}
              </button>
            </div>
            {phrase === null ? null : (
              <>
                <p className={CAPABILITY_UI.code}>{phrase}</p>
                <p className={CAPABILITY_UI.hint}>
                  These twelve words are your circle. Anyone who has them is you.
                  Write them on paper; a photograph is not a safe place.
                </p>
              </>
            )}
          </>
        ) : null}
      </div>

      {/* ── adding somebody ────────────────────────────────────────────
          ⚠️ **THE PANEL USED TO SAY "nothing is shared until you add
          somebody" AND OFFER NO WAY TO ADD ANYBODY.** Text that names an
          action the UI cannot perform is worse than no text: it tells the
          reader they have missed a control that does not exist.

          A person is added by PAIRING, not by typing an id. `circle::admit`
          refuses a person this reader has never met, so a hand-entered id
          would be a row that never admits anything. The six digits two humans
          compare are what make a person real — which is why this is the
          pairing flow. */}
      <div className={CAPABILITY_UI.section}>
        {pending !== null ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              “{pending.name}” would like to join your circle. Check that they
              are reading the same six digits, then let them in.
            </p>
            <p className={CAPABILITY_UI.code}>{pending.sas}</p>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
                disabled={busy}
                onClick={() => void act(() => port.confirm(true, pending.attemptId))}
              >
                The digits match
              </button>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => void act(() => port.confirm(false, pending.attemptId))}
              >
                Refuse
              </button>
            </div>
          </>
        ) : sas !== null ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              Read these six digits to your friend. They see the same ones, and
              let you in.
            </p>
            <p className={CAPABILITY_UI.code}>{sas}</p>
          </>
        ) : offer !== null && offer.expiresAt > Date.now() ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              Send this link to the person you want to add. It is good for a few
              minutes.
            </p>
            {/* ⚠️ **THE LINK CARRIES THE PAIRING SECRET.** It is shown because
                the reader has to send it, and it is never logged — the
                diagnostics port redacts `url` keys for exactly this value. */}
            <p className={CAPABILITY_UI.code}>{offer.url}</p>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => void act(async () => {
                  await port.cancel()
                  setOffer(null)
                })}
              >
                Stop offering
              </button>
            </div>
          </>
        ) : (
          <>
            {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setTrouble(null)
                    const made = await port.offer()
                    /* ⚠️ **THE WHOLE OFFER, NOT JUST THE LINK.** `expiresAt`
                     * was thrown away, so a dead link went on being presented
                     * as usable: sending it produced an `expired` refusal, and
                     * the reader could not make another without first stopping
                     * the one that had already lapsed. */
                    setOffer(made)
                  })
                }
              >
                Add somebody
              </button>
            </div>
            <div className={CAPABILITY_UI.row}>
              <input
                className={`${CAPABILITY_UI.field} ${CAPABILITY_UI.grow}`}
                placeholder="…or paste a friend's link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy || link.trim() === ''}
                onClick={() =>
                  void act(async () => {
                    const started = await port.join(link.trim())
                    setLink('')
                    setSas(started.sas)
                  })
                }
              >
                Join
              </button>
            </div>
          </>
        )}
      </div>

      <div className={CAPABILITY_UI.section}>
        {people.length === 0 ? (
          <p className={CAPABILITY_UI.hint}>Nobody yet.</p>
        ) : (
          people.map((one) => (
            <div className={CAPABILITY_UI.row} key={one.person}>
              <span className={CAPABILITY_UI.grow}>{one.displayName}</span>
              <span className={CAPABILITY_UI.code}>{short(one.person)}</span>
              <button
                type="button"
                className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonDanger}`}
                disabled={busy}
                onClick={() => void act(() => port.forgetPerson(one.person))}
              >
                Remove
              </button>
            </div>
          ))
        )}
        {/* ⚠️ SAID OUT LOUD, because the button above does NOT do it. Removing
            somebody stops their new passages; what they already sent is on this
            disk until a purge asks for it by name. A reader who assumed
            otherwise would think they had deleted something they had not. */}
        {people.length === 0 ? null : (
          <p className={CAPABILITY_UI.hint}>
            Removing somebody stops new passages arriving. What they already
            shared stays until you clear it.
          </p>
        )}
      </div>
    </>
  )
}
