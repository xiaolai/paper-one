import { ChevronLeft } from 'lucide-react'
import { ICON } from '../../core/metrics'
import type { GlossState } from '../hooks/useGloss'
import { lookUpSays } from '../lookUpWords'
import styles from './LookUpFace.module.css'

/**
 * The lookup, as a face of the selection popup (phase 17, L1).
 *
 * ## Why it is not a strip any more
 *
 * It was `GlossStrip`: a row at the foot of the reader's column, a flex sibling
 * of `.stage`. Its own appearance therefore shrank the stage, and foliate
 * re-paginated the book around it. Measured in the running app on 2026-09-13 —
 * Look up on `wharves`, on the last line of a page: the stage went from 802px to
 * 744px, the word moved from (200, 817) to the next page at (968, 95), and the
 * selection popup vanished with it. Closing the strip put it all back. The
 * answer made the question disappear, on exactly the words a strip's height can
 * push off a page.
 *
 * Phase 17 had already named the principle when it refused to open the pane on
 * a lookup — *"opening the pane re-lays-out the book, so auto-opening would move
 * the word the reader is looking at, at the exact moment they are looking at
 * it"* — and then shipped a surface that did the same thing at a smaller scale.
 *
 * The popup floats. It is placed by `place()` clear of every selected line, it
 * resizes nothing, and it is already the one surface beside the passage — which
 * is where §10's prototype draws Look up: *"the prototype's popup replaces its
 * own contents for Look up and Translate, with a back control"*.
 *
 * ## The doctrine this still keeps
 *
 * `core/gloss.ts`: a provider *"must never resolve with an apology, because an
 * apology rendered in amber reads as a definition."* So a failure is never
 * amber, never in the definition's element, and says "couldn't" rather than a
 * bare clause that scans as a gloss. `unavailable` and `tooLong` are not
 * failures and do not wear its words either, and neither is amber — Paper
 * speaking about itself is not a definition of anything.
 *
 * `asking` stays in the definition's element: "Looking…" is not mistakable for
 * a definition, and moving it would make every lookup jump between two shapes
 * on its way to an answer.
 *
 * ## What the reason gets that the strip could not give it
 *
 * The strip was one line, so a failure's reason was ellipsised — and it is the
 * only account the reader gets of why there is no definition. Here it wraps.
 */
export interface LookUpFaceProps {
  /** Never idle — an idle lookup is the bar, not this face. */
  readonly state: Exclude<GlossState, { readonly kind: 'idle' }>
  /** Back to the bar — which puts the lookup away. */
  readonly onBack: () => void
  /**
   * Take the reader to the settings section that installs a model, or absent
   * when this screen has nowhere to send them. The section is the provider's
   * answer, carried on the state — see `GlossProvider.installAt`.
   */
  readonly onInstall?: ((section: string) => void) | undefined
}

/**
 * The way back to the bar, on every face that has one — the marks, the ways to
 * copy, and the lookup.
 *
 * ONE DEFINITION BECAUSE IT IS ONE CONTROL (2026-09-13). `SelectionTools` and
 * this face each wrote it out, and the accessible name is the part that must not
 * differ: a screen-reader user who hears "Back to the selection tools" on one
 * face and anything else on another has been told there are two controls. Here
 * rather than there because the popup already imports this module and not the
 * other way round. The class stays the caller's — see `.back` in the stylesheet
 * for why the two rules are repeated rather than shared.
 */
export function BackToBar({
  onBack,
  className,
}: {
  readonly onBack: () => void
  /** The caller's own class — a CSS module's value, which may be undefined. */
  readonly className: string | undefined
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onBack}
      title="Back"
      aria-label="Back to the selection tools"
    >
      <ChevronLeft size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )
}

export function LookUpFace({ state, onBack, onInstall }: LookUpFaceProps) {
  return (
    <div className={styles.lookUp}>
      <BackToBar className={styles.back} onBack={onBack} />
      <div className={styles.content}>
        <Said state={state} onInstall={onInstall} />
      </div>
    </div>
  )
}

function Said({ state, onInstall }: Pick<LookUpFaceProps, 'state' | 'onInstall'>) {
  /* THE WORDS ARE `lookUpWords`', THE LAYOUT IS THIS FILE'S (#124). Marginalia
     draws the same lookup as a row and had its own copy of all four sentences,
     which is two places to edit and one to forget. */
  const { said, because } = lookUpSays(state)

  /* NOT A TERM, so nothing here names one — see `GlossState.tooLong`. */
  if (state.kind === 'tooLong') {
    return (
      <p className={styles.refused} role="status">
        {said}
      </p>
    )
  }

  if (state.kind === 'unavailable') {
    /* ⚠️ BOTH HALVES, AND IT USED TO BE ONE — see `GlossState.unavailable`.
       `onInstall` says whether this SCREEN was given somewhere to send the
       reader; `installAt` says whether the build has anywhere worth sending
       them, read at the press. Offering a download into a runtime that is not
       there is the WI-20.21 failure. */
    const section = state.installAt
    return (
      <div className={styles.absent} role="status">
        <span>{said}</span>
        {section !== null && onInstall && (
          <button type="button" className={styles.install} onClick={() => onInstall(section)}>
            Install one
          </button>
        )}
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className={styles.failed} role="status">
        <span>{said}</span>
        {/* THE CAUSE ON ITS OWN LINE, which is what this face has room for and
            the row in Marginalia does not — see `LookUpWords.because`. */}
        <span className={styles.failedReason}>{because}</span>
      </div>
    )
  }

  return (
    /* AMBER, ALWAYS — machine-written text in the reader's own page, and
       `marks.ts` reserves the companion kind and its amber for exactly it. */
    <div className={styles.definition} data-kind="companion" role="status">
      <span className={styles.term}>{state.term}</span>
      <span className={styles.body}>{said}</span>
    </div>
  )
}
