import {
  AudioLines,
  ChevronDown,
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
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { isTauri } from '../lib/platform'
import type { AppDispatch, AppState, AsidePanel } from '../lib/state'
import styles from './TitleBar.module.css'

/** Traffic-light fills, in AppKit's order. Preview only — see below. */
const LIGHTS = ['var(--tl-red)', 'var(--tl-amber)', 'var(--tl-green)'] as const

const ASIDE_TOGGLES: readonly {
  key: AsidePanel
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
  const chromeOpacity =
    state.screen === 'reader' && !state.chromeOn && !state.switcherOpen ? 0 : 1

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
          : [
              { key: 'minimise', Icon: Minus },
              { key: 'maximise', Icon: Square },
              { key: 'close', Icon: X },
            ].map(({ key, Icon }) => (
              <button key={key} type="button" className={styles.windowButton} title={key}>
                <Icon size={13} strokeWidth={ICON.stroke} />
              </button>
            ))}
      </div>

      <div
        className={styles.chipZone}
        style={{ opacity: chromeOpacity }}
        data-tauri-drag-region
      >
        <button
          type="button"
          className={styles.chip}
          title="Switch book"
          onClick={() => dispatch({ type: 'toggleLayer', layer: 'switcherOpen' })}
        >
          <span className={styles.chipCover} style={{ background: coverTint }} />
          <span className={styles.chipTitle}>{bookTitle}</span>
          <span className={styles.chipSub}>{bookSubtitle}</span>
          <ChevronDown
            size={ICON.inline}
            strokeWidth={ICON.stroke}
            style={{ color: 'var(--muted)' }}
          />
        </button>
      </div>

      <div className={styles.appZone} data-platform={platform} style={{ opacity: chromeOpacity }}>
        {isReader && (
          <>
            <div className={styles.toggleGroup}>
              {ASIDE_TOGGLES.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={styles.action}
                  title={label}
                  data-on={state.asidePanel === key}
                  onClick={() =>
                    dispatch({
                      type: 'setAside',
                      panel: state.asidePanel === key ? null : key,
                    })
                  }
                >
                  <Icon size={ICON.control} strokeWidth={ICON.stroke} />
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.action}
              title="Listen"
              data-on={state.ttsOn}
              onClick={() => dispatch({ type: 'toggleTts' })}
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
