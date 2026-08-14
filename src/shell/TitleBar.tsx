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
import { PANE_TITLES, comboFor } from '../lib/panes'
import type { AppDispatch, AppState, PaneId } from '../lib/state'
import type { Speech } from '../reader/useSpeech'
import styles from './TitleBar.module.css'

/** Traffic-light fills, in AppKit's order. Preview only — see below. */
const LIGHTS = ['var(--tl-red)', 'var(--tl-amber)', 'var(--tl-green)'] as const

/**
 * Shortcuts into the pane. They used to toggle a separate 340px card; now they
 * open the pane on that panel, and clicking the active one closes it.
 *
 * Two panels of the eight, chosen here — but their LABELS come from the shared
 * registry, not from a third copy of them. The name is `TITLEBAR_PANES` rather
 * than `PANE_SHORTCUTS`, which is what this was called: that name already
 * means §11's ⌘1…5 map in `lib/panes`, and two different things under one name
 * in one codebase is a trap for whoever greps for it next.
 */
const TITLEBAR_PANES: readonly { key: PaneId; Icon: typeof ListTree }[] = [
  { key: 'toc', Icon: ListTree },
  { key: 'companion', Icon: Sparkles },
]

export interface TitleBarProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  bookTitle: string
  bookSubtitle: string
  coverTint: string
  /** Reading aloud — the Listen control drives this directly. */
  speech: Speech
  /** False with no book open: there is nothing to read aloud. */
  hasBook: boolean
}

export function TitleBar({
  state,
  dispatch,
  platform,
  bookTitle,
  bookSubtitle,
  coverTint,
  speech,
  hasBook,
}: TitleBarProps) {
  const isMac = platform === 'macos'
  const isReader = state.screen === 'reader'

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
  /* Each reports its own failure. These are async IPC calls into the window
   * manager and their promises were discarded, so a rejected minimise or close
   * — the window already gone, the IPC refused — surfaced as an unhandled
   * rejection at the window rather than as a line naming the button. */
  const runWindow = (what: string, action: () => Promise<void> | undefined) => () => {
    void action()?.catch((cause: unknown) => {
      console.error(`Paper: window ${what} failed`, cause)
    })
  }
  const WINDOW_BUTTONS = [
    { key: 'minimise', title: 'Minimise', Icon: Minus, run: runWindow('minimise', () => appWindow?.minimize()) },
    {
      key: 'maximise',
      title: 'Maximise',
      Icon: Square,
      run: runWindow('maximise', () => appWindow?.toggleMaximize()),
    },
    { key: 'close', title: 'Close', Icon: X, run: runWindow('close', () => appWindow?.close()) },
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
                onClick={run}
              >
                <Icon size={ICON.window} strokeWidth={ICON.stroke} />
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
              {TITLEBAR_PANES.map(({ key, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={styles.action}
                  title={PANE_TITLES[key]}
                  aria-label={PANE_TITLES[key]}
                  /* §10: selected state has to be announced, not only drawn.
                     `data-on` styles it; without the ARIA it is invisible to a
                     screen reader, which then cannot tell an open panel from a
                     closed one. */
                  aria-pressed={state.pane === key}
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
            {/* Live where the engine can do it. §07 keeps the disabled state
                for the case that remains real — a WebView built without Web
                Speech — rather than for a feature that is simply unwritten. */}
            <button
              type="button"
              className={styles.action}
              title={
                !speech.available
                  ? 'Listen — this build has no speech engine'
                  : speech.speaking
                    ? 'Stop reading aloud'
                    : 'Read this chapter aloud'
              }
              aria-label="Read aloud"
              aria-pressed={speech.speaking}
              data-on={speech.speaking}
              disabled={!speech.available || !hasBook}
              data-disabled={!speech.available || !hasBook}
              onClick={() => (speech.speaking ? speech.stop() : speech.start())}
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
          title={`Search or ask · ${comboFor('⌘K', platform)}`}
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
          aria-label={state.pane ? 'Close pane' : 'Open pane'}
          aria-pressed={state.pane !== null}
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
