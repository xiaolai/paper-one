import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { PAINT_HINT_KEY } from '../../core/paintHint'
import { PANE_W, paneTakesTrack, type Platform } from '../../core/metrics'
import { useAvailableWidth } from '../hooks/useAvailableWidth'
import type { AppState } from '../state'
import { LeadingCard } from './LeadingCard'
import { useAppPalette } from '../hooks/useAppPalette'
import styles from './WindowShell.module.css'

export interface WindowShellProps {
  state: AppState
  platform: Platform
  /**
   * The titlebar. It lives inside the window, which now holds the side pane
   * too, so it spans the whole window rather than stopping at the reader.
   */
  titleBar: ReactNode
  /** Layers anchored to the window: switcher, palette, figure viewer. */
  overlays?: ReactNode
  /** The active screen. */
  children: ReactNode
  /** The single side pane — every tool lives in here. */
  pane: ReactNode
  /**
   * Close the pane, for the scrim behind it as a sheet.
   *
   * A callback rather than `dispatch`, so this component stays unable to do
   * anything to the app but the one thing its layout requires.
   */
  onDismissPane: () => void
}

export function WindowShell({
  state,
  platform,
  titleBar,
  overlays,
  children,
  pane,
  onDismissPane,
}: WindowShellProps) {
  /* The element that carries `data-theme` is also where the reader's brightness
     and contrast are written, as inline custom properties — an inline
     declaration beats the attribute rule on the same element, so the override
     lands without disturbing the cascade anywhere else. */
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  useAppPalette(root, state.theme, state.brightness, state.contrast)

  /* KEEP THE FIRST FRAME'S COLOUR CURRENT — see the script in `index.html`,
   * which reads this before any module is fetched so the window opens in the
   * reader's own theme instead of white.
   *
   * READ OFF THE ELEMENT rather than mapped from `state.theme` in code. The
   * themes are defined in `tokens.css` and nowhere else on purpose, and a
   * lookup table here would be a second copy of five colours that goes stale
   * the first time one is adjusted — silently, because being one shade out is
   * invisible in every check. Asking the browser what `--bg` resolved to is
   * the same question the next frame will ask. */
  useEffect(() => {
    if (!root) return
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
    if (!bg) return
    try {
      localStorage.setItem(PAINT_HINT_KEY, bg)
    } catch {
      // Storage disabled. The window opens white, and nothing else changes.
    }
  }, [root, state.theme])

  /* §06: below 1024px the pane stops taking a track and becomes a sheet over
   * the reader — the design's own word for it.
   *
   * It used to be refused outright at this width, and that was the bug: the
   * pane did not appear, while ⌘\, the titlebar button and all eight rail tabs
   * went on looking exactly as available as they do at 1440px. Nothing said
   * why, because nothing had anywhere to say it. A sheet keeps the reason the
   * threshold exists — the measure is not squeezed, since an overlay displaces
   * nothing — while letting the control do what it says it does. */
  const width = useAvailableWidth()
  /* Asked of `paneTakesTrack` rather than compared against a constant, and the
   * reading step is now part of the question: the grid this has to leave room
   * for is `measure + …`, and §09 gives every step a different measure. A flat
   * 1024 let the pane in at widths where the gutters then went to zero. */
  const asSheet = !paneTakesTrack(width, state.stepIdx)
  const paneOpen = state.pane !== null

  return (
    <div className={styles.root} ref={setRoot} data-theme={state.theme} data-platform={platform}>
      <div className={styles.main}>
        <div className={styles.window}>
          {titleBar}
          {overlays}
          <div className={styles.shell}>
            {/* INERT UNDER THE SHEET, not merely covered by it.
                The scrim below takes the pointer, and took only the pointer:
                everything behind it stayed in the focus order, so Tab walked
                into a screen the reader could not see and Enter acted on it.
                That cost nothing while the surfaces underneath were readouts
                and covers; the reader's footer now carries a bookmark toggle,
                which is the first control ever placed there — and it is lit
                whenever a pane is open, so it was both reachable and reporting
                state from behind a scrim.
                Here rather than on the screens, because `asSheet` is this
                component's own predicate and a second copy of it elsewhere is
                two answers to when the sheet is up. */}
            <div className={styles.content} inert={asSheet && paneOpen}>
              {children}
            </div>

            {/* The sheet's dismissal target, and the only one it has: at this
                width the pane covers the rail it would otherwise be closed
                from. Rendered only as a sheet, so at full width the reader can
                still touch the book beside an open pane — which is the whole
                difference between a pane and a sheet. */}
            {asSheet && paneOpen && (
              <button
                type="button"
                className={styles.paneScrim}
                aria-label="Close the side pane"
                onClick={onDismissPane}
              />
            )}

            {/* Always mounted. Conditionally mounting it meant there was no
                before/after width for §08's 220ms transition to interpolate,
                so the pane snapped, and every close destroyed the pane's own
                scroll position and panel state. */}
            <div
              className={styles.paneSlot}
              data-side={state.side}
              data-open={paneOpen}
              data-sheet={asSheet}
              inert={!paneOpen}
              aria-hidden={!paneOpen}
            >
              <LeadingCard platform={platform} width={PANE_W} side={state.side}>
                {pane}
              </LeadingCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
