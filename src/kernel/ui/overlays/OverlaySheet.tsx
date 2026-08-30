import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
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
  /**
   * The element whose SIBLINGS are the page behind this dialog.
   *
   * ⚠️ **DEFAULTS TO THE SHEET'S OWN PARENT, WHICH IS NOT ALWAYS THE PAGE.**
   * Inerting "the sheet's siblings" is right when the sheet is rendered
   * directly into the layer that holds the page — which is how the desktop
   * mounts it. `app/shell/BottomSheet` wraps this in a full-viewport
   * positioned host, because the sheet positions against its parent and needs
   * one; so the sheet's only siblings became the scrim, which is excluded, and
   * NOTHING behind the `aria-modal` dialog was ever made inert. The dialog
   * announced itself as modal and the shelf underneath stayed tabbable.
   *
   * A wrapper that exists for layout should not silently change what a modal
   * means, and it cannot be removed — it is the positioned ancestor. So the
   * boundary is stated instead of inferred.
   */
  boundary?: RefObject<HTMLElement | null> | undefined
}

/**
 * The one definition of "focusable" the sheet uses — for the first focus AND
 * the Tab trap. There were two, and they had already drifted: the trap knew
 * about anchors, selects and the `disabled` attribute; the first-focus query
 * did not, so it could land on a disabled input and silently focus nothing.
 */
const FOCUSABLE =
  'a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focusable AND VISIBLE — `.focus()` on a `display: none` node is a no-op,
 *  so a hidden candidate must not stop the search. */
function visibleFocusable(root: HTMLElement, selector: string): HTMLElement | null {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
    if (node.offsetParent !== null) return node
  }
  return null
}

export function OverlaySheet({ label, onDismiss, children, boundary }: OverlaySheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)

  /**
   * ONE effect for focus and inertness, because their cleanups are ORDERED.
   *
   * As two effects, focus restored first and the siblings un-inerted second —
   * so `previous.focus()` addressed an element whose ancestor was still
   * inert, the call silently did nothing, and the reader's focus fell to the
   * document after all: the exact loss the restore exists to prevent. React
   * runs cleanups in declaration order; one effect makes the order explicit
   * instead of load-bearing-by-accident.
   *
   * Focus moves in on open — THE FIELD FIRST, then whatever comes first. A
   * sheet with a field in it is a sheet the reader is about to type into,
   * wherever the field sits: the tag editor draws its chips — each with a ✕
   * button — above its field, and taking the first focusable in document
   * order landed focus on "remove the first tag", one keypress from doing it.
   * A sheet with NOTHING focusable takes focus itself (`tabIndex={-1}` below):
   * the trap keeps Tab inside either way, and a modal that never receives
   * focus strands the keyboard outside its own scrim.
   *
   * Inertness: `aria-modal` is a promise, and the focus trap keeps the Tab
   * key honest — but neither stops a screen reader from browsing the reader
   * behind the scrim, or a click reaching it. `inert` is the mechanism for
   * all three at once, applied to the SIBLINGS of the sheet rather than its
   * ancestors: marking an ancestor would take the sheet with it. Restored
   * exactly as found, so a sheet opened over an already-inert reader — which
   * is how the library layers over it — does not un-inert it on the way out.
   */
  useEffect(() => {
    const sheet = sheetRef.current
    /* THE BOUNDARY DECIDES WHAT "BEHIND" MEANS — see the prop. Without one the
     * sheet's own parent is the layer, which is true wherever nothing wraps
     * it. */
    const inside = boundary?.current ?? sheet
    const parent = inside?.parentElement
    if (!sheet || !inside || !parent) return

    const previousFocus = document.activeElement as HTMLElement | null

    /* The SCRIM is excluded, and it is a sibling: it is rendered beside the
     * sheet, not around it. Marking it inert takes its `pointerdown` with it,
     * and click-outside-to-dismiss stops working — a modal that can only be
     * left with the keyboard. `child.contains(sheet)` cannot be true for a
     * sibling; the guard that tested it was unreachable and went. */
    const siblings = Array.from(parent.children).filter(
      (child) => child !== inside && !child.hasAttribute('data-overlay-scrim'),
    )
    const previousInert = siblings.map((child) => (child as HTMLElement).inert)
    for (const child of siblings) (child as HTMLElement).inert = true

    const field =
      visibleFocusable(sheet, 'input:not([disabled]), textarea:not([disabled])') ??
      visibleFocusable(sheet, FOCUSABLE)
    ;(field ?? sheet).focus()

    return () => {
      // Un-inert FIRST, or the focus restore below addresses an inert tree.
      siblings.forEach((child, i) => {
        ;(child as HTMLElement).inert = previousInert[i] ?? false
      })
      previousFocus?.focus?.()
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

      const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      )

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
        /* THE PRIMARY BUTTON ONLY. `pointerdown` fires for every button, and a
         * right-click on the scrim — the gesture for "context menu", or for
         * nothing — tore the sheet down mid-thought. `isPrimary` also keeps a
         * second finger on a trackpad from dismissing. */
        onPointerDown={(event) => {
          if (event.isPrimary && event.button === 0) onDismiss()
        }}
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
        /* Focusable ITSELF, for the sheet with no focusable content — focus
         * has to land inside the modal or the Tab trap is trapping a key the
         * reader cannot even get to. See the focus effect. */
        tabIndex={-1}
      >
        {children}
      </div>
    </>
  )
}
