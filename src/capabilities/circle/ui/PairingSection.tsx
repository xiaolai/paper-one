import { CAPABILITY_UI } from '../../../kernel'
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
        <>
          <p className={CAPABILITY_UI.hint}>
            Send this link to the person you want to add.{' '}
            {/* ⚠️ **"IT IS GOOD FOR A FEW MINUTES" WAS THE WHOLE ACCOUNT.** The
                link then vanished without a word when it ran out, so a reader
                who had already sent one could not tell a dead link from a
                friend who had not got round to it. */}
            {secondsLeft === null
              ? 'It is good for a few minutes.'
              : `It stops working in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`}
          </p>
          {/* ⚠️ **THE LINK CARRIES THE PAIRING SECRET.** It is shown because
              the reader has to send it, and it is never logged — the
              diagnostics port redacts `url` keys for exactly this value. */}
          <p className={CAPABILITY_UI.code}>{offer.url}</p>
          {/* ⚠️ **THE SCREEN SAID NOTHING WHILE IT WAITED**, which is the state
              a reader spends the whole pairing in. With no line here, an offer
              that nobody had used yet looked exactly like one that had failed —
              and the roster's own "Nobody yet." sits directly below, which
              reads as a verdict on the pairing rather than on the circle. */}
          <p className={CAPABILITY_UI.hint}>
            Nobody has used this link yet. When they do, you will be asked to
            compare six digits with them.
          </p>
          <div className={CAPABILITY_UI.actions}>
            {/* THE ONLY WAY TO MOVE THIS WAS TO SELECT THE TEXT, which is how a
                pairing secret ends up somewhere it should not be. A button
                cannot stop that, and it removes the reason to reach for a
                screenshot or a chat window. */}
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void navigator.clipboard?.writeText(offer.url)}>
              Copy link
            </button>
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void pairing.stopOffering()}>
              Stop offering
            </button>
          </div>
        </>
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
