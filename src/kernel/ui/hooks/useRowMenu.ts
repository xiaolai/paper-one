import { useEffect, useRef, type RefObject } from 'react'
import { usePlacement } from './usePlacement'
import type { Placement } from '../../core/placement'

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
  options: Parameters<typeof usePlacement>[3] & {
    /**
     * ARIA-menu keyboard behaviour: focus moves into the first item on open,
     * ↑/↓ walk the items with wraparound, Home/End jump, and focus returns to
     * the `⋯` on close. OPT-IN, because this hook also positions the tag
     * editor — a popover whose first focusable is a remove button and whose
     * field autofocuses itself; stealing focus there would put "delete the
     * first tag" one keypress away. Declaring `role="menu"` without this was
     * the worse state: semantics promising keyboard behaviour that did not
     * exist, so a screen-reader user was told "menu" and given nothing.
     */
    menu?: boolean
  } = {},
): RowMenu {
  const { menu = false, ...placementOptions } = options
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const { style, placement } = usePlacement(open, anchorRef, menuRef, placementOptions)

  /* Read through a ref so the effect below does not rebind on every render:
   * `onClose` is recreated per render by every caller, and listing it as a
   * dependency would tear the listeners down and put them back each time. */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const close = () => closeRef.current()
    const items = () =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || moreRef.current?.contains(target)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        return
      }
      if (!menu) return
      /* Tab CLOSES a menu — the ARIA pattern, and the behaviour every native
       * menu has: a menu is a modal little world, and Tab is the reader
       * leaving it. Left unhandled, Tab walked the menuitems like ordinary
       * buttons with the menu still up. Not prevented, so focus moves on as
       * Tab means it to; the restore-to-trigger in cleanup only fires when
       * focus is still inside, which by then it is not. */
      if (event.key === 'Tab') {
        close()
        return
      }
      const list = items()
      if (list.length === 0) return
      const at = list.findIndex((item) => item === document.activeElement)
      const to =
        event.key === 'ArrowDown'
          ? (at + 1) % list.length
          : event.key === 'ArrowUp'
            ? (at - 1 + list.length) % list.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? list.length - 1
                : null
      if (to === null) return
      event.preventDefault()
      list[to]?.focus()
    }
    /* Focus moves INTO the menu on open — after this task, so the placement
     * pass has run and the box is where it will stay. `preventScroll` because
     * the first frame can still be parked off screen.
     *
     * ONLY FOR A KEYBOARD OPEN, and the reason is §07: focus is drawn on
     * `:focus-visible` alone so that a pointer user never sees a ring. Moving
     * focus programmatically defeats that on the FIRST menu of a session —
     * before the engine has classified any interaction, WebKit's heuristic
     * treats a programmatic focus as focus-visible, so `global.css`'s
     * `outline: 3px solid var(--accent)` painted a box around the first item.
     * It went away for every later menu, once a real click had put the engine
     * on record as pointer-driven, which is exactly the shape of the bug: a box
     * on first load and never again.
     *
     * The trigger's own ring is the test. If the `⋯` is wearing one, the reader
     * arrived by keyboard and wants focus carried in; if it is not, they
     * clicked, and moving focus buys them nothing but the box. Nothing is lost
     * when the guess goes the wrong way: with focus left on the trigger,
     * `at` resolves to -1 and ↓ still opens onto the first item. */
    let focusTimer: number | undefined
    const byKeyboard = (() => {
      try {
        return moreRef.current?.matches(':focus-visible') ?? false
      } catch {
        /* `:focus-visible` is unsupported in some engines this could run in;
         * carrying focus in is the safer failure, since a keyboard user
         * stranded outside an open menu is worse than a stray ring. */
        return true
      }
    })()
    if (menu && byKeyboard) {
      focusTimer = window.setTimeout(() => {
        items()[0]?.focus({ preventScroll: true })
      }, 0)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      /* Focus goes back where it came from — the control that opened the
       * menu — rather than falling to the document, which for a keyboard
       * user means starting over from the top of the window. Only if focus
       * is still INSIDE the menu: a pointer user who clicked elsewhere has
       * already put it where they meant it. */
      if (menu && menuRef.current?.contains(document.activeElement)) {
        moreRef.current?.focus({ preventScroll: true })
      }
      /* ALSO ON CLEANUP — which is unmount, or `open` flipping false. A
       * virtualised row that scrolls away while its menu is open takes the
       * listeners with it but not the caller's state; without this the menu
       * came back armed when the row scrolled back in. */
      close()
    }
  }, [open, menu])

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
