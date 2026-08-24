import type { GlossState } from '../hooks/useGloss'
import styles from './GlossStrip.module.css'

/**
 * The gloss, under the selection popup — and the lookup that did not arrive,
 * drawn apart from it.
 *
 * ## Why this is a component and not thirty lines of JSX in `Reader`
 *
 * Because the difference between the two states is the whole point, and inside
 * `Reader` it could only be asserted by reading the source back. That is not a
 * hypothetical weakness: an audit pointed out that adding `hidden` to the
 * failed element, or `display: none` to its rule, would leave every one of
 * those assertions green while the failure disappeared from the screen
 * entirely. `Reader` cannot be mounted cheaply — it takes sixteen props and
 * renders foliate — so the states could not be *rendered* in a test until they
 * lived somewhere smaller. Here they can.
 *
 * ## The doctrine this exists to keep
 *
 * `core/gloss.ts` is explicit: a provider *"must never resolve with an apology,
 * because an apology rendered in amber reads as a definition."* The port
 * honours it — `glossProvider` throws rather than resolving, and refuses an
 * empty answer — and **the view used to undo it.** All three states went
 * through one element: amber box, amber headword, and whichever of `text` and
 * `reason` applied dropped into the same body span. So a failed lookup put the
 * word in amber beside prose, in the definition's position, inside the
 * definition's box. The rule was enforced at the port and lost at the view,
 * which is why no port-side test could have caught it.
 *
 * Three things make the failure not a definition, and all three are
 * load-bearing: it is **not amber**, the reason is **not in the body slot**
 * beside an amber headword, and the line says **"couldn't"** rather than a bare
 * clause that scans as a gloss.
 *
 * `asking` stays in the definition box. "Looking…" is not mistakable for a
 * definition, and moving it would make every lookup jump between two places on
 * its way to an answer.
 *
 * ## And it is dismissed, not consumed
 *
 * The reader's next act after understanding a word is usually to mark it, so
 * taking the selection down with the gloss would make them select it again.
 */
export interface GlossStripProps {
  readonly state: GlossState
  readonly onDismiss: () => void
}

export function GlossStrip({ state, onDismiss }: GlossStripProps) {
  if (state.kind === 'idle') return null

  if (state.kind === 'failed') {
    return (
      <div className={styles.glossFailed} role="status">
        <span className={styles.glossFailedSaid}>Paper couldn’t define “{state.term}”.</span>
        <span className={styles.glossFailedReason}>{state.reason}</span>
        <Dismiss onDismiss={onDismiss} />
      </div>
    )
  }

  return (
    /* AMBER, ALWAYS — and that is the point rather than decoration. This is
       machine-written text appearing in the reader's own page, and `marks.ts`
       reserves the companion kind, its amber tint and the wave style for
       exactly it: a definition from Apple's dictionary is authoritative and a
       gloss from a 4B model is not, and the reader must be able to tell
       without being told. */
    <div className={styles.gloss} data-kind="companion" role="status">
      <span className={styles.glossTerm}>{state.term}</span>
      <span className={styles.glossBody}>
        {state.kind === 'asking' ? 'Looking…' : state.text}
      </span>
      <Dismiss onDismiss={onDismiss} />
    </div>
  )
}

/** SHARED between the two states, because a dismiss control is a dismiss
 *  control — written twice, its label, glyph or size would drift apart for no
 *  reason anyone could name later. */
function Dismiss({ onDismiss }: { readonly onDismiss: () => void }) {
  return (
    <button
      type="button"
      className={styles.glossClose}
      onClick={onDismiss}
      aria-label="Dismiss"
      title="Dismiss"
    >
      ×
    </button>
  )
}
