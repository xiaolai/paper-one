import { useEffect, useRef, type RefObject } from 'react'
import { usePlacement } from './usePlacement'
import type { Placement } from './placement'

/**
 * The behaviour every row menu shares: open from a `⋯`, placed by
 * `usePlacement`, dismissed by a click anywhere else or by Escape, closed if
 * its row unmounts while open, and closed if its anchor scrolls off screen.
 *
 * EXTRACTED AT THE SECOND COPY. `BookCell` and `TagRow` each carried this —
 * refs, the dismissal listeners, the detached-close, the "one way to close" —
 * and when the branch audit found that two of `BookCell`'s four close paths
 * left the armed remove state behind, the same fix had to be made in both
 * files. Two files that need the same fix are one file that should exist.
 *
 * It owns the MECHANICS and nothing about the menu's contents or its
 * confirmation state; the caller decides those and passes `onClose` so the
 * hook can clear whatever the caller keeps (the armed remove, a rename draft).
 * A shared accessible menu with focus management would build on this; that is
 * a component, and this is the part both would need first.
 *
 * WHERE THE MENU MAY BE RENDERED IS NOT FREE. `menuStyle` is in VIEWPORT
 * coordinates and `.menu` is `position: fixed` — and a fixed element inside an
 * ancestor carrying a `transform`, a `filter` or a `perspective` resolves its
 * insets against THAT ANCESTOR instead of the viewport. Measured in the running
 * app: a fixed child asking for (0, 0) landed at (0, 0) normally and at
 * (300, 300) — its transformed parent's own origin — inside one.
 *
 * So a caller whose menu would sit inside such an ancestor must portal it out —
 * and then, having escaped the transform, it has also escaped the THEME:
 * `data-theme` lives on the window shell and `useAppPalette` writes brightness
 * and contrast as inline custom properties on that same element, so a menu
 * portalled to the body inherits neither and draws a Paper-white card in the
 * middle of Night. The shell is the target that satisfies both, since it
 * carries no transform of its own.
 *
 * A third thing, unrelated to either: ANCHOR-CLEARANCE IS NOT CONTAINER-
 * CLEARANCE. A menu hung from a button that sits inside a padded container
 * clears the BUTTON and laps over the container. Pass the container as `avoid`
 * — `place` widens the obstacle to cover both and keeps the alignment to the
 * button.
 *
 * `palette.ts` names the first trap for `filter`, which is where this app met
 * it originally. All three were found in one afternoon on the selection bar's
 * copy menu, and none of them applies to it any more: that menu is not a
 * surface now, it is a face the popup turns over to. Which is the shortest
 * statement of what this whole paragraph is for — a second floating surface
 * inside a first one costs four problems, and replacing the contents costs
 * none. Reach for a menu when the surface it opens over is not one you own.
 */
export interface RowMenu {
  /** Put on the `⋯` button. */
  readonly moreRef: RefObject<HTMLButtonElement | null>
  /** Put on the menu element. */
  readonly menuRef: RefObject<HTMLDivElement | null>
  /** Spread onto the menu's `style`; parks off screen until placed. */
  readonly menuStyle: { top: number; left: number }
  readonly placement: Placement | null
  /** The one way to close — every path the caller has should call this. */
  readonly close: () => void
}

export function useRowMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: Parameters<typeof usePlacement>[3] = {},
): RowMenu {
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { style, placement } = usePlacement(open, anchorRef, menuRef, options)

  /* Read through a ref so the effect below does not rebind on every render:
   * `onClose` is recreated per render by every caller, and listing it as a
   * dependency would tear the listeners down and put them back each time. */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const close = () => closeRef.current()
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || moreRef.current?.contains(target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      /* ALSO ON CLEANUP — which is unmount, or `open` flipping false. A
       * virtualised row that scrolls away while its menu is open takes the
       * listeners with it but not the caller's state; without this the menu
       * came back armed when the row scrolled back in. */
      close()
    }
  }, [open])

  /* A DETACHED menu closes rather than parking at -9999. Parked, its items
   * stayed focusable and exposed to assistive technology while the row was
   * mounted but its anchor was off screen. */
  useEffect(() => {
    if (open && placement?.fit === 'detached') closeRef.current()
  }, [open, placement?.fit])

  return {
    moreRef,
    menuRef,
    menuStyle: style && placement?.fit !== 'detached' ? style : { top: -9999, left: -9999 },
    placement,
    close: () => closeRef.current(),
  }
}
