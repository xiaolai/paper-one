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
  const { pending, sas, offer, link, setLink, trouble, busy } = pairing
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
        </>
      ) : offer !== null ? (
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
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => void pairing.stopOffering()}>
              Stop offering
            </button>
          </div>
        </>
      ) : (
        <>
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
