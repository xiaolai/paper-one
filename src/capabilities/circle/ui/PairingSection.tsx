import { useState } from 'react'
import { CAPABILITY_UI, inlineQrSvg } from '../../../kernel'
import type { Pairing } from './usePairing'

/**
 * Adding somebody, drawn — the view over `usePairing`'s controller.
 *
 * ⚠️ **THE SCREEN USED TO SAY "nothing is shared until you add somebody"
 * AND OFFER NO WAY TO ADD ANYBODY.** Text that names an action the UI
 * cannot perform is worse than no text: it tells the reader they have
 * missed a control that does not exist.
 */
export function PairingSection({ pairing }: { readonly pairing: Pairing }) {
  const { pending, sas, offer, secondsLeft, lapsed, link, setLink, trouble, busy } = pairing
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  return (
    <div className={CAPABILITY_UI.section}>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      {pending !== null ? (
        <>
          <p className={CAPABILITY_UI.hint}>
            “{pending.name}” would like to join your circle. Check that they
            are reading the same six digits, then let them in.
          </p>
          <p className={CAPABILITY_UI.code}>{pending.sas}</p>
          <div className={CAPABILITY_UI.actions}>
            <button type="button" className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`} disabled={busy} onClick={() => void pairing.confirm(true)}>
              The digits match
            </button>
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void pairing.confirm(false)}>
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
          {/* ⚠️ **THIS STATE USED TO HAVE NO CONTROL OF ANY KIND.** Six digits
              and nothing else: a reader whose friend had walked away from the
              other machine was stuck here until they quit the app. Pairing has
              a human at each end and either can stop; only one of them could
              say so. */}
          <p className={CAPABILITY_UI.hint}>
            Waiting for them to let you in. Nothing has been shared yet.
          </p>
          <div className={CAPABILITY_UI.actions}>
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void pairing.stopJoining()}>
              Never mind
            </button>
          </div>
        </>
      ) : offer !== null ? (
        <div className={CAPABILITY_UI.figure}>
          {/* ⚠️ **THIS SCREEN PRINTED THE URL AND THREW THE QR AWAY.** The offer
              has carried `svg` since it was written — "it is what the other
              device scans" — and this pane rendered a hundred percent-encoded
              characters instead: a key, and a list of the reader's LAN
              addresses, laid out as if it were something to read. Somebody did
              read it, and moved it by selecting the text.

              The Devices pane had already learned this and written it down:
              "a 100-character `paper://pair?…` with a key in it, which nobody
              reads and nobody can retype." Same product, same problem, the
              lesson one directory over. This is that block's shape. */}
          <p className={CAPABILITY_UI.hint}>
            Send this to the person you want to add.{' '}
            {secondsLeft === null
              ? 'It is good for a few minutes.'
              : `It stops working in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`}
          </p>
          <div className={CAPABILITY_UI.actions}>
            <button
              type="button"
              className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
              disabled={busy}
              onClick={() => {
                /* SAID, NOT SWALLOWED: the reader was about to paste an empty
                   clipboard into the other machine. */
                void navigator.clipboard?.writeText(offer.url).then(
                  () => setCopied('yes'),
                  () => setCopied('failed'),
                )
              }}
            >
              {copied === 'failed' ? 'Couldn’t copy — select the link below' : copied === 'yes' ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void pairing.stopOffering()}>
              Stop offering
            </button>
          </div>
          {/* ONLY WHEN THE BUTTON COULD NOT CARRY IT. A failure that says
              "select the link" while no link is drawn sends the reader looking
              for something that is not there. `paper-cap-code` is
              `user-select: all`, so one click takes the whole thing. */}
          {copied === 'failed' ? <code className={CAPABILITY_UI.code}>{offer.url}</code> : null}
          <div
            className={CAPABILITY_UI.qr}
            aria-label="Pairing QR code"
            role="img"
            dangerouslySetInnerHTML={{ __html: inlineQrSvg(offer.svg) }}
          />
          <p className={CAPABILITY_UI.hint}>Or scan it with their phone.</p>
          {/* ⚠️ **THE SCREEN SAID NOTHING WHILE IT WAITED**, which is the state a
              reader spends the whole pairing in — and the roster's own "Nobody
              yet." sits directly below, reading as a verdict on the pairing
              rather than on the circle. */}
          <p className={CAPABILITY_UI.hint}>
            Nobody has used this yet. When they do, you will be asked to compare
            six digits with them.
          </p>
        </div>
      ) : (
        <>
          {lapsed ? (
            <p className={CAPABILITY_UI.hint}>
              That link ran out before anybody used it. Make another if you
              still want to add them.
            </p>
          ) : null}
          <div className={CAPABILITY_UI.actions}>
            <button type="button" className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`} disabled={busy} onClick={() => void pairing.makeOffer()}>
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
            <button type="button" className={CAPABILITY_UI.button} disabled={busy || link.trim() === ''} onClick={() => void pairing.join()}>
              Join
            </button>
          </div>
        </>
      )}
    </div>
  )
}
