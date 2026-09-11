import { useCallback, useEffect, useState } from 'react'
import { CAPABILITY_UI, messageOf } from '../../../kernel'
import type { ShareService } from '../../peer'
import type { PublicBookState, PublicPort } from '../lib/publicPort'
import { VoiceDecisionsControl, type VoiceDecisionsProps } from './VoiceDecisions'

/**
 * What this book is published as — phase 25's surface.
 *
 * ⚠️ **THE CONTROL IS ABSENT AND THE REASON IS PRESENT, never a disabled
 * button.** `surfaces.md` decides this for the circle's Share and the reasoning
 * carries: a control a reader cannot use, with no sentence, is a bug report
 * they cannot write. WI-25.2's acceptance says *"un-offerable and says why"*,
 * and `offerAbsentBecause` is the sentence.
 *
 * ⚠️ **AND THE TWO SWITCHES ARE DRAWN APART.** Offering a book's bytes and
 * publishing opinions about it are different acts with different consequences,
 * and the common case is the second without the first. A single "Share this
 * book" control would make publishing an opinion an act of republication —
 * which is the conflation WI-25.9 exists to prevent, arriving through the UI
 * rather than through the protocol.
 */

export interface PublicPaneProps {
  readonly bookId: string | null
  /** `null` before the capability has started. */
  readonly port: PublicPort | null
  /**
   * The reader's decisions about other people's voices — WI-26.5's surface,
   * drawn under this book's own switches.
   *
   * ⚠️ **HERE RATHER THAN ON THE MARK, BECAUSE A PUBLIC NOTE IS NOT A MARK.**
   * `MarkControl` draws on the reader's OWN highlights; a stranger's annotation
   * arrives through the overlay, which has no control seam at all. Adding an
   * eleventh contribution type to hang a Silence button off somebody else's
   * paragraph would be a kernel change this phase does not need — the pane the
   * reader already opens for this book is a place they can reach it.
   */
  readonly voices?: VoiceDecisionsProps['port']
  /** The voices this book has actually carried. Asked when the pane opens. */
  readonly heardOn?: (bookId: string) => Promise<readonly string[]>
  /**
   * Ask whoever serves this book for other people's notes about it.
   *
   * ⚠️ **A CONTROL, NEVER AN AUTOMATIC ASK.** Asking tells whoever answers
   * that this device is interested in this book, so doing it on open would
   * make opening a book a broadcast. Answers how many records arrived, which
   * is what the sentence below reports — not how many were KEPT, because a
   * record can be refused for a dozen reasons and naming them here would be
   * an oracle for whoever sent them.
   */
  readonly lookForNotes?: (bookId: string, named?: readonly string[]) => Promise<number>
  /**
   * This device's share endpoint id — shown so the reader can hand it over.
   *
   * ⚠️ **WITHOUT THIS THE LAYER HAS TWO STATES AND ONE OF THEM IS PERMANENT
   * PUBLICATION.** The DHT is the only route from a book's hash to a provider,
   * so a reader who will not announce could not be found at all. An id given
   * out of band — the way a phone number is — is the other route, and it is
   * the one that works between two people who already know each other.
   */
  readonly shareId?: () => Promise<string>
}

export function PublicPane({ bookId, port, voices = null, heardOn, lookForNotes, shareId }: PublicPaneProps) {
  const [heard, setHeard] = useState<readonly string[]>([])
  const [state, setState] = useState<PublicBookState | null | undefined>(undefined)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** How many records the last ask brought back — `null` before any ask. */
  const [looked, setLooked] = useState<number | null>(null)
  /** A device id the reader was given out of band, or empty for "whoever advertised". */
  const [askWho, setAskWho] = useState('')
  /** This device's own share id, so the reader can hand it over. `null` until read. */
  const [mine, setMine] = useState<string | null>(null)

  /* ⚠️ **READ ONCE, AND ONLY WHEN THERE IS SOMETHING TO READ IT FOR.** The
     command reads a key file and binds nothing, but a pane that asked on every
     render would still be asking a plugin a question whose answer cannot
     change while the app runs. */
  useEffect(() => {
    if (shareId === undefined) return
    let live = true
    shareId().then(
      (id) => {
        if (live) setMine(id)
      },
      () => {
        /* A device that cannot say where it is still publishes and still
           fetches; the sentence simply does not appear. Nothing here is worth
           a visible failure. */
      },
    )
    return () => {
      live = false
    }
  }, [shareId])

  const refresh = useCallback(() => {
    if (port === null || bookId === null) return
    let live = true
    port
      .forBook(bookId)
      .then((answer) => {
        if (live) setState(answer)
      })
      .catch((cause: unknown) => {
        if (live) {
          setState(null)
          setTrouble(messageOf(cause))
        }
      })
    return () => {
      live = false
    }
  }, [port, bookId])

  /* ⚠️ **ASKED WHEN THE PANE OPENS, NEVER ON A PAINT.** Listing the voices
     means reading and verifying the book's whole public file with the block
     filter OFF — a silenced voice has to stay reachable to be un-silenced — so
     it is exactly the Ed25519 cost `annotationsFor` refuses to pay per frame.
     Once, on demand, is the price of a surface; per render would not be. */
  useEffect(() => {
    if (heardOn === undefined || bookId === null) {
      setHeard([])
      return
    }
    let live = true
    heardOn(bookId)
      .then((answer) => {
        if (live) setHeard(answer)
      })
      .catch(() => {
        /* The pane's own read already reports trouble; a voice list that could
           not be built is an empty list, not a second error message over the
           first. */
        if (live) setHeard([])
      })
    return () => {
      live = false
    }
  }, [heardOn, bookId])

  useEffect(() => {
    setState(undefined)
    setTrouble(null)
    /* A count belongs to the book it was asked for. Left standing, "3 arrived"
       follows the reader to the next book and describes it. */
    setLooked(null)
    const cancel = refresh()
    /* The port tells us when an offer landed; the read is re-run rather than
       the answer pushed, so there is one path for "what is published" instead
       of two that can disagree — `OverlayContribution.subscribe`'s rule. */
    const stop = port?.subscribe(() => {
      refresh()
    })
    return () => {
      cancel?.()
      stop?.()
    }
  }, [port, refresh])

  const act = (run: () => Promise<unknown>) => (): void => {
    setBusy(true)
    setTrouble(null)
    run()
      .catch((cause: unknown) => setTrouble(messageOf(cause)))
      .finally(() => setBusy(false))
  }

  if (port === null) return null
  if (bookId === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Open a book to publish it.</p>
      </div>
    )
  }
  if (state === undefined) return null
  if (state === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Paper could not read this book’s public state. {trouble ?? ''}</p>
      </div>
    )
  }

  const withdraw = (service: ShareService) => act(() => port.withdraw(bookId, service))

  return (
    <div className={CAPABILITY_UI.section}>
      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>The file itself</span>
        {state.bytes ? (
          <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={withdraw('bytes')}>
            Stop offering
          </button>
        ) : state.absentBecause === null ? (
          <button
            type="button"
            className={CAPABILITY_UI.button}
            disabled={busy}
            onClick={act(() => port.offerBytes(bookId))}
          >
            Offer to anyone
          </button>
        ) : null}
      </div>
      {/* ⚠️ **THE SENTENCE STANDS WHERE THE CONTROL WOULD HAVE BEEN.** A reader
          who cannot offer a book is owed the reason, and `offerAbsentBecause`
          is the only place that decides what it says. */}
      {state.bytes || state.absentBecause === null ? null : <p className={CAPABILITY_UI.hint}>{state.absentBecause}</p>}
      {state.bytes ? (
        <p className={CAPABILITY_UI.hint}>
          Anyone who has this book’s fingerprint can download it from this device. Withdrawing stops this device serving
          it; it cannot un-tell anyone who already looked.
        </p>
      ) : null}

      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>Notes about it</span>
        {state.notes ? (
          <button
            type="button"
            /* ⚠️ **A MODIFIER NEVER TRAVELS WITHOUT THE CLASS IT MODIFIES.**
               `capabilityStyle.contract.test.ts` walks every capability's JSX
               for exactly this: `buttonDanger` alone is a colour with no
               button under it, and the stylesheet says so — *"With `button`:
               destructive."* */
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonDanger}`}
            disabled={busy}
            onClick={withdraw('notes')}
          >
            Stop publishing
          </button>
        ) : state.mayAnnotate ? (
          <button
            type="button"
            className={CAPABILITY_UI.button}
            disabled={busy}
            onClick={act(() => port.offerNotes(bookId))}
          >
            Publish notes
          </button>
        ) : null}
      </div>
      {state.notes ? (
        <p className={CAPABILITY_UI.hint}>
          {/* ⚠️ **THREE ANSWERS, AND THERE USED TO BE TWO.** An annotation
              file that would not read reported zero, so this said "nothing
              published yet" — telling the reader nothing would be lost at
              exactly the moment the device could not tell. */}
          {state.noteCount === null
            ? 'Paper could not read what you have published here, so it cannot say what stopping would delete. This does not offer the book itself.'
            : state.noteCount === 0
              ? 'Nothing published yet. This does not offer the book itself.'
              : `${state.noteCount} published. Stopping deletes them from this device. This does not offer the book itself.`}
        </p>
      ) : state.mayAnnotate ? (
        <p className={CAPABILITY_UI.hint}>Publishing notes does not offer the book itself.</p>
      ) : (
        <p className={CAPABILITY_UI.hint}>Paper has not finished reading this file’s fingerprint yet.</p>
      )}

      {lookForNotes === undefined ? null : (
        <>
          <div className={CAPABILITY_UI.row}>
            <span className={CAPABILITY_UI.grow}>Other people’s notes</span>
            <button
              type="button"
              className={CAPABILITY_UI.button}
              disabled={busy}
              onClick={act(async () => {
                const arrived = await lookForNotes(bookId, askWho.trim() === '' ? [] : [askWho.trim()])
                setLooked(arrived)
              })}
            >
              Look for some
            </button>
          </div>
          {/* ⚠️ **THE ONLY ROUTE THAT DOES NOT REQUIRE PUBLISHING A HOME
              ADDRESS.** The provider index is the DHT and nothing else turns a
              hash into a provider, so a reader who has not announced can only
              be found by somebody they told. Optional, and empty means "ask
              whoever advertised" exactly as before. */}
          <input
            type="text"
            className={CAPABILITY_UI.field}
            value={askWho}
            placeholder="…or a device id somebody gave you"
            aria-label="A device id to ask"
            onChange={(event) => setAskWho(event.target.value)}
          />
          {mine === null ? null : (
            <p className={CAPABILITY_UI.hint}>
              Ask somebody to look for yours at <code>{mine}</code>. It says where to reach this device and nothing
              about which books it holds.
            </p>
          )}
        </>
      )}
      {looked === null ? null : (
        <p className={CAPABILITY_UI.hint}>
          {/* ⚠️ **WHAT ARRIVED, NOT WHAT WAS KEPT.** A record can be refused
              for a dozen reasons — a bad signature, an expiry, a voice this
              reader silenced — and naming which would tell whoever sent it
              exactly what to change. Nothing at all is the ordinary answer:
              almost nobody publishes about almost any book. */}
          {looked === 0
            ? 'Nobody who answered has published anything about this book.'
            : `${looked} arrived. Whatever checked out is on the page.`}
        </p>
      )}

      <VoiceDecisionsControl heard={heard} port={voices} />

      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
    </div>
  )
}
