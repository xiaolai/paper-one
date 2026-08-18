import type { ReactNode } from 'react'
import { PANE_W, paneTakesTrack, type Platform } from '../../core/metrics'
import { useAvailableWidth } from '../hooks/useAvailableWidth'
import type { AppState } from '../state'
import { LeadingCard } from './LeadingCard'
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
    <div className={styles.root} data-theme={state.theme} data-platform={platform}>
      <div className={styles.main}>
        <div className={styles.window}>
          {titleBar}
          {overlays}
          <div className={styles.shell}>
            <div className={styles.content}>{children}</div>

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
