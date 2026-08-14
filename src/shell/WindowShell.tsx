import type { ReactNode } from 'react'
import { PANE_COLLAPSE_W, PANE_W, type Platform } from '../lib/metrics'
import { useAvailableWidth } from '../lib/useAvailableWidth'
import type { AppState } from '../lib/state'
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
}

export function WindowShell({
  state,
  platform,
  titleBar,
  overlays,
  children,
  pane,
}: WindowShellProps) {
  /* §06: below 1024px the pane collapses regardless of what the user last
   * chose. The preference is kept in state so it returns when the window is
   * widened again — this only overrides what is rendered. */
  const width = useAvailableWidth()
  const paneOpen = state.pane !== null && width >= PANE_COLLAPSE_W

  return (
    <div className={styles.root} data-theme={state.theme} data-platform={platform}>
      <div className={styles.main}>
        <div className={styles.window}>
          {titleBar}
          {overlays}
          <div className={styles.shell}>
            <div className={styles.content}>{children}</div>

            {/* Always mounted. Conditionally mounting it meant there was no
                before/after width for §08's 220ms transition to interpolate,
                so the pane snapped, and every close destroyed the pane's own
                scroll position and panel state. */}
            <div
              className={styles.paneSlot}
              data-side={state.side}
              data-open={paneOpen}
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
