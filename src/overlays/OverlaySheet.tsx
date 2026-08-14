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

  /**
   * Make everything behind the sheet inert while it is up.
   *
   * `aria-modal` is a promise, and the focus trap below keeps the Tab key
   * honest — but neither stops a screen reader from browsing the reader behind
   * the scrim, or a click reaching it. `inert` is the mechanism for all three
   * at once, and it has to be applied to the SIBLINGS of the sheet rather than
   * to the sheet's own ancestors: marking an ancestor would take the sheet
   * with it. Restored exactly as found, so a sheet opened over an already-inert
   * reader — which is how the library layers over it — does not un-inert it on
   * the way out.
   */
  useEffect(() => {
    const sheet = sheetRef.current
    const parent = sheet?.parentElement
    if (!sheet || !parent) return

    /* The SCRIM is excluded, and it is a sibling: it is rendered beside the
     * sheet, not around it. Marking it inert takes its `pointerdown` with it,
     * and click-outside-to-dismiss stops working — a modal that can only be
     * left with the keyboard. */
    const siblings = Array.from(parent.children).filter(
      (child) =>
        child !== sheet && !child.contains(sheet) && !child.hasAttribute('data-overlay-scrim'),
    )
    const previous = siblings.map((child) => (child as HTMLElement).inert)
    for (const child of siblings) (child as HTMLElement).inert = true

    return () => {
      siblings.forEach((child, i) => {
        ;(child as HTMLElement).inert = previous[i] ?? false
      })
    }
  }, [])

  /**
   * Keep Tab inside the sheet.
   *
   * `aria-modal` is a promise to assistive technology, not a mechanism: it
   * tells a screen reader the rest of the page is inert and changes nothing
   * about where the Tab key goes. So the sheet declared itself modal while Tab
   * walked straight out of it into the titlebar and the reader behind — focus
   * landing on controls the reader could not see, under a scrim that made them
   * look disabled. This is the mechanism the attribute was describing.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const sheet = sheetRef.current
      if (!sheet) return

      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null || node === document.activeElement)

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        // Nothing to tab to; the sheet keeps the key rather than handing focus
        // to content it is covering.
        event.preventDefault()
        return
      }

      const active = document.activeElement
      if (!sheet.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <>
      <div
        className={styles.scrim}
        data-overlay-scrim
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
