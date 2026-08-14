import type { ReactNode } from 'react'
import type { Platform } from '../lib/metrics'
import type { AppState } from '../lib/state'
import styles from './WindowShell.module.css'

export interface WindowShellProps {
  state: AppState
  platform: Platform
  /** The titlebar, which overlays the window card on macOS. */
  titleBar: ReactNode
  /** Layers anchored to the window card: switcher, palette, figure viewer. */
  overlays?: ReactNode
  /** The active screen. */
  children: ReactNode
  /** The 400px side pane, rendered as a sibling card on the wash. */
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
          </div>
        </div>
      </div>

      <div className={styles.pane} data-side={state.side} data-open={paneOpen}>
        {paneOpen && <div className={styles.paneBody}>{pane}</div>}
      </div>
    </div>
  )
}
