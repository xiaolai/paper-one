import type { ReactNode } from 'react'
import { PANE_W, type Platform } from '../lib/metrics'
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
  const paneOpen = state.pane !== null

  return (
    <div className={styles.root} data-theme={state.theme} data-platform={platform}>
      <div className={styles.main}>
        <div className={styles.window}>
          {titleBar}
          {overlays}
          <div className={styles.shell}>
            <div className={styles.content}>{children}</div>

            {paneOpen && (
              <div className={styles.paneSlot} data-side={state.side}>
                <LeadingCard platform={platform} width={PANE_W} side={state.side}>
                  {pane}
                </LeadingCard>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
