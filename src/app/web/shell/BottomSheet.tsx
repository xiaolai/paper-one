import type { ReactNode } from 'react'
import { OverlaySheet } from '../../../kernel/ui/browser'
import styles from './BottomSheet.module.css'

/**
 * A sheet from the bottom of the screen — the mobile shape of every secondary
 * surface (design mockup: "the side pane becomes a sheet, the companion column
 * becomes a sheet").
 *
 * ## Built ON `OverlaySheet`, not beside it
 *
 * The kernel's `OverlaySheet` is a centred desktop dialog, and its GEOMETRY is
 * wrong here — `top: var(--sheet-top)`, `translateX(-50%)`. But its two hard
 * behaviours are exactly right and exactly the ones a hand-rolled sheet gets
 * wrong: focus moves in on open and back out on close (in the right order, so
 * the restore does not address an inert tree), and the siblings are made
 * `inert` so a screen reader cannot browse the page behind the scrim. That
 * logic is 120 lines with two recorded incidents behind it. It is reused, and
 * only the geometry is overridden — see `BottomSheet.module.css`, which
 * targets the same nodes by attribute rather than by copying them.
 *
 * ## Height is a prop, because the two sheets differ on purpose
 *
 * Tools is `82%` and Companion `74%` in the mockup, and Search is half because
 * a jump you cannot see is not a jump. The number is the caller's decision.
 *
 * ## The handle is drawn, not wired
 *
 * §08 says the sheet is "interruptible, follows the finger". Drag-to-dismiss
 * is not here: it needs a gesture recogniser that does not fight the sheet's
 * own scrolling, and a half-built one is worse than none — a sheet that
 * closes when you meant to scroll loses the reader's place. The scrim tap
 * and the close control dismiss; the handle says what the surface is.
 */
export interface BottomSheetProps {
  readonly label: string
  /** Fraction of the viewport the sheet takes — `0.82` for tools, `0.5` for search. */
  readonly height: number
  readonly onDismiss: () => void
  readonly children: ReactNode
  /**
   * Pinned at the foot, OUTSIDE the scrolling body — the tools rail. The
   * first draft rendered the rail as the last child of the body, and 34
   * chapters of contents scrolled it under the fold: a rail at `bottom:
   * 1490` on an 852px screen, and no way to reach Search. A slot after the
   * body is the only place a foot can stay put.
   */
  readonly foot?: ReactNode
}

export function BottomSheet({ label, height, onDismiss, children, foot }: BottomSheetProps) {
  return (
    <div className={styles.host} style={{ '--sheet-h': `${Math.round(height * 100)}%` } as React.CSSProperties}>
      <OverlaySheet label={label} onDismiss={onDismiss}>
        <div className={styles.handle} aria-hidden />
        <div className={styles.body}>{children}</div>
        {foot}
      </OverlaySheet>
    </div>
  )
}
