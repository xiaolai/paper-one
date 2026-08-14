import {
  AudioLines,
  ListTree,
  Minus,
  PanelLeft,
  PanelRight,
  Search,
  Sparkles,
  Square,
  Type,
  X,
} from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { isTauri } from '../lib/platform'
import type { AppDispatch, AppState, PaneId } from '../lib/state'
import styles from './TitleBar.module.css'

/** Traffic-light fills, in AppKit's order. Preview only — see below. */
const LIGHTS = ['var(--tl-red)', 'var(--tl-amber)', 'var(--tl-green)'] as const

/* Shortcuts into the pane. They used to toggle a separate 340px card; now
 * they open the pane on that panel, and clicking the active one closes it. */
const PANE_SHORTCUTS: readonly {
  key: PaneId
  label: string
  Icon: typeof ListTree
}[] = [
  { key: 'toc', label: 'Contents', Icon: ListTree },
  { key: 'companion', label: 'Companion', Icon: Sparkles },
]

export interface TitleBarProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  bookTitle: string
  bookSubtitle: string
  coverTint: string
}

export function TitleBar({
  state,
  dispatch,
  platform,
  bookTitle,
  bookSubtitle,
  coverTint,
}: TitleBarProps) {
  const isMac = platform === 'macos'
  const isReader = state.screen === 'reader' || state.screen === 'pdf'

  /* §06: chrome fades to 0 and returns on pointer-near — but only in the
   * reader, and never while the switcher is up, since the chip it is anchored
   * to would vanish underneath it. */
  const chromeHidden =
    state.screen === 'reader' && !state.chromeOn && !state.switcherOpen

  /* Hiding with opacity alone left every control invisible but still
   * focusable and clickable — tabbing through the reader landed on buttons
   * nobody could see. `inert` takes the whole subtree out of the focus order
   * and the hit-testing at once; `visibility` is what actually removes it from
   * the accessibility tree. Opacity stays because §08 wants a 180ms fade, and
   * `visibility` is transitionable in a way `display` is not. */
  const chromeStyle = {
    opacity: chromeHidden ? 0 : 1,
    visibility: chromeHidden ? ('hidden' as const) : ('visible' as const),
  }

  /* Windows and Linux draw their own window controls, so they need real
   * handlers — without them the buttons were decoration that swallowed the
   * click. macOS never reaches this: AppKit draws the traffic lights. */
  const appWindow = isTauri() ? getCurrentWindow() : null
  const WINDOW_BUTTONS = [
    { key: 'minimise', title: 'Minimise', Icon: Minus, run: () => appWindow?.minimize() },
    { key: 'maximise', title: 'Maximise', Icon: Square, run: () => appWindow?.toggleMaximize() },
    { key: 'close', title: 'Close', Icon: X, run: () => appWindow?.close() },
  ]

  return (
    <div
      className={styles.bar}
      data-platform={platform}
      data-tauri-drag-region
      onMouseEnter={() => dispatch({ type: 'setChrome', on: true })}
      onMouseLeave={() => dispatch({ type: 'setChrome', on: false })}
    >
      <div className={styles.sysZone} data-platform={platform} data-tauri-drag-region>
        {isMac
          ? /* Inside Tauri, AppKit paints the real traffic lights over this
             * zone, so drawing our own would double them. They are rendered
             * only in a plain browser, where the design still needs checking. */
            !isTauri() &&
            LIGHTS.map((fill) => (
              <span key={fill} className={styles.light} style={{ background: fill }} />
            ))
          : WINDOW_BUTTONS.map(({ key, title, Icon, run }) => (
              <button
                key={key}
                type="button"
                className={styles.windowButton}
                title={title}
                aria-label={title}
                onClick={() => void run()}
              >
                <Icon size={13} strokeWidth={ICON.stroke} />
              </button>
            ))}
      </div>

      <div
        className={styles.chipZone}
        style={chromeStyle}
        inert={chromeHidden}
        data-tauri-drag-region
      >
        {/* Live again: the switcher overlay exists now, so the chip opens it
            rather than being a label that swallowed every click. */}
        <button
          type="button"
          className={styles.chip}
          title="Switch book"
          aria-haspopup="dialog"
          aria-expanded={state.switcherOpen}
          onClick={() => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' })}
        >
          <span className={styles.chipCover} style={{ background: coverTint }} />
          <span className={styles.chipTitle}>{bookTitle}</span>
          <span className={styles.chipSub}>{bookSubtitle}</span>
        </button>
      </div>

      <div
        className={styles.appZone}
        data-platform={platform}
        style={chromeStyle}
        inert={chromeHidden}
      >
        {isReader && (
          <>
            <div className={styles.toggleGroup}>
              {PANE_SHORTCUTS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={styles.action}
                  title={label}
                  data-on={state.pane === key}
                  onClick={() =>
                    state.pane === key
                      ? dispatch({ type: 'closePane' })
                      : dispatch({ type: 'openPane', pane: key })
                  }
                >
                  <Icon size={ICON.control} strokeWidth={ICON.stroke} />
                </button>
              ))}
            </div>
            {/* §07 disabled: no pointer events and the reason stated, rather
                than a control that toggles state nothing consumes. TTS is a
                sidecar the handoff describes but nothing implements yet. */}
            <button
              type="button"
              className={styles.action}
              title="Listen — not available yet"
              aria-label="Listen — not available yet"
              disabled
              data-disabled="true"
            >
              <AudioLines size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
            <button
              type="button"
              className={styles.action}
              title="Typography · theme, typeface, size"
              onClick={() => dispatch({ type: 'openPane', pane: 'settings' })}
            >
              <Type size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
          </>
        )}
        <button
          type="button"
          className={styles.action}
          title="Search or ask · ⌘K"
          aria-label="Search or ask"
          aria-haspopup="dialog"
          aria-expanded={state.paletteOpen}
          data-on={state.paletteOpen}
          onClick={() => dispatch({ type: 'toggleLayer', layer: 'paletteOpen' })}
        >
          <Search size={ICON.control} strokeWidth={ICON.stroke} />
        </button>
        <button
          type="button"
          className={`${styles.action} ${styles.paneToggle}`}
          title={state.pane ? 'Close pane' : 'Open pane'}
          data-on={state.pane !== null}
          onClick={() => dispatch({ type: 'togglePane' })}
        >
          {state.side === 'left' ? (
            <PanelLeft size={ICON.control} strokeWidth={ICON.stroke} />
          ) : (
            <PanelRight size={ICON.control} strokeWidth={ICON.stroke} />
          )}
        </button>
      </div>
    </div>
  )
}
