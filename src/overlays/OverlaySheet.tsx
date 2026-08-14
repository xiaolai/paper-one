import { useEffect, useRef, type ReactNode } from 'react'
import styles from './Overlay.module.css'

/**
 * The scrim and sheet every overlay shares.
 *
 * Dismissal is the caller's — `dismissTop` peels one layer, and §11 is explicit
 * that Esc takes the topmost only — so this does not bind Esc itself. It owns
 * the two behaviours a sheet must not get wrong: focus goes into it when it
 * opens and returns where it came from when it closes, and a click on the scrim
 * dismisses while a click inside does not.
 */

export interface OverlaySheetProps {
  label: string
  onDismiss: () => void
  children: ReactNode
}

export function OverlaySheet({ label, onDismiss, children }: OverlaySheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)

  /* Focus moves in on open and back on close. Without the restore, dismissing
   * the palette leaves focus on a detached node and the next Tab starts from
   * the top of the document — which for a reader means tabbing back through the
   * whole titlebar to get anywhere. */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focusable = sheetRef.current?.querySelector<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])',
    )
    focusable?.focus()
    return () => previous?.focus?.()
  }, [])

  return (
    <>
      <div
        className={styles.scrim}
        onPointerDown={onDismiss}
        /* Decorative: the dismissable thing is the sheet, and the scrim is
         * already reachable by Esc. Announcing it as a button would put a
         * nameless control in the reader's way. */
        aria-hidden
      />
      <div
        className={styles.sheet}
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </>
  )
}
