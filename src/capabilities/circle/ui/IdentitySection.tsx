import { useRef, useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { PersonPort, PersonStatus } from '../../peer'
import { short } from './personId'
import { useAction } from './useAction'

/**
 * The reader's own identity — the custody marker, the twelve words, and the
 * one button that mints — with action state of its own.
 *
 * ## The custody marker is the reason the screen exists at all
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
 * ⚠️ **RENDERING THIS MUST NOT CREATE A PERSON IDENTITY.** `status` is
 * read-only in Rust for exactly this reason. A reader who never shares never
 * needs an identity, and a screen that minted one on open would quietly
 * delete the laziness the whole custody design rests on — *"a phrase shown
 * before there is any context is a phrase that gets clicked through."* The one
 * path that mints is a button a reader pressed.
 *
 * ⚠️ **MOUNTED PER IDENTITY — the screen keys it by `personId`.** The words
 * are on screen only for as long as the reader is looking at the identity
 * they asked about; a `phrase()` still in flight when the identity changed
 * — restore, forget, a pairing that re-read — lands in an instance that has
 * gone, rather than putting the PREVIOUS person's twelve words on screen
 * beneath the new one's id.
 *
 * ⚠️ **AND GUARDED BY PORT, BECAUSE THE KEY DOES NOT CHANGE FOR ONE.** Two
 * ports with no identity share the empty key, so a peer restart while
 * "Start a circle" was out leaves this instance mounted under the new port.
 * The act's refresh is bound to the old one; run, it read the OLD peer's
 * freshly minted status and drew it as the new peer's. An act refreshes,
 * and a phrase read is shown, only through the port the screen still holds
 * — the guard the pairing and the roster rows already keep.
 */
export function IdentitySection({ port, status, refresh }: { readonly port: PersonPort; readonly status: PersonStatus; readonly refresh: () => Promise<void> }) {
  const [phrase, setPhrase] = useState<string | null>(null)
  const { busy, trouble, run, alive } = useAction('That did not go through.')
  /* Which port the screen holds NOW — see the note above. */
  const current = useRef(port)
  current.current = port
  /** Run one act, then read the status again — unless the port was replaced under it. */
  const act = (what: () => Promise<unknown>): Promise<boolean> => run(what, () => (current.current === port ? refresh() : undefined))
  const troubleLine = trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>

  if (!status.hasIdentity) {
    return (
      <div className={CAPABILITY_UI.section}>
        {/* ⚠️ NOT A WARNING. A reader who has never shared is in the ordinary
            state, and telling them something is missing would be false. */}
        <p className={CAPABILITY_UI.hint}>
          A circle lets a few people you know see the passages you mark, and you
          theirs. Nothing is shared until you add somebody.
        </p>
        {troubleLine}
        <div className={CAPABILITY_UI.actions}>
          <button
            type="button"
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
            disabled={busy}
            /* The capability hears the identity being made from the peer
               itself, and publishes what waited on one; this only re-reads
               the status the button changed. */
            onClick={() => void act(() => port.ensure())}
          >
            Start a circle
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={CAPABILITY_UI.section}>
      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>You</span>
        <span className={CAPABILITY_UI.code}>{short(status.personId ?? '')}</span>
      </div>
      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>This device</span>
        <span className={CAPABILITY_UI.value}>{status.role === 'home' ? 'holds your keys' : 'a signed-in device'}</span>
      </div>

      {status.atRisk ? (
        <p className={CAPABILITY_UI.hint}>
          Your circle lives on this device alone. If it is lost, you would have
          to meet everyone again. Write down the twelve words below, or add a
          second device.
        </p>
      ) : null}

      {troubleLine}

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
                /* ⚠️ **A FAILED READ IS SAID, NOT SWALLOWED.** A failed
                 * keychain read rendered as "still hidden" tells the reader
                 * the button does nothing, which is the one thing that is not
                 * true. Said here, beside the button — not as a circle that
                 * could not be read, over a roster that read perfectly well. */
                void run(async () => {
                  const words = await port.phrase()
                  /* Shown only under the port they were read from. */
                  if (alive() && current.current === port) setPhrase(words)
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
  )
}
