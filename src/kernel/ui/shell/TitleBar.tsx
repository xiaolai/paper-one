import {
  AudioLines,
  BookOpen,
  Library as LibraryIcon,
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
import { ICON } from '../../core/metrics'
import type { Platform } from '../../core/metrics'
import { isTauri } from '../platform'
import { PANE_TITLES, comboFor } from '../panes'
import type { AppDispatch, AppState, KernelPaneId } from '../state'
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
 * means §11's ⌘1…5 map in `ui/panes`, and two different things under one name
 * in one codebase is a trap for whoever greps for it next.
 */
const TITLEBAR_PANES: readonly { key: KernelPaneId; Icon: typeof ListTree }[] = [
  { key: 'toc', Icon: ListTree },
  { key: 'companion', Icon: Sparkles },
]

export interface TitleBarProps {
  state: AppState
  dispatch: AppDispatch
  platform: Platform
  bookTitle: string
  bookSubtitle: string
  /** Reading aloud — the Listen control drives this directly. */
  speech: Speech
  /** False with no book open: there is nothing to read aloud. */
  hasBook: boolean
}

/**
 * KNOWN DEBT: this component is about 200 lines and holds more than one job —
 * window IPC, the platform's own controls, the chrome fade, the reading
 * shortcuts, speech and the palette. An audit flagged it and it was left
 * deliberately.
 *
 * The reason is that nothing here is WRONG, and the split is not obvious: the
 * window controls are genuinely separable, but the rest share `state`,
 * `dispatch` and the chrome-fade styling, so extracting them mostly moves
 * props around. Splitting it is worth doing when a second surface needs one of
 * these groups — at that point the seam is decided by a real caller instead of
 * by guesswork.
 */
export function TitleBar({
  state,
  dispatch,
  platform,
  bookTitle,
  bookSubtitle,
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
          {/* ONLY WHEN THE CHIP IS NAMING THE APP. With nothing open the title
              is the literal "Paper" — see `App.tsx` — and a bare word centred
              in the titlebar reads as a caption rather than as the thing it
              is. The mark makes it a lockup.

              It is deliberately NOT the swatch that used to sit here. That was
              a colour derived from the open book's id, and with no book open it
              hashed the empty string and drew a spine for a book that did not
              exist. The distinction is the whole point: this slot belongs to
              whatever the chip is currently naming, and when there is no book,
              what it is naming is the application. */}
          {!hasBook && <span className={styles.chipMark} aria-hidden="true" />}
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
              /* Says what the panel actually holds, and no more. It once
                 promised "theme, typeface, size" while offering only the
                 theme — a tooltip naming features a reader could go looking
                 for and never find. All three are real now, so all three are
                 named; nothing here may be added ahead of its control. */
              title="Appearance · theme, typeface, size, flow, ruler"
              onClick={() => dispatch({ type: 'openPane', pane: 'settings' })}
            >
              <Type size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
          </>
        )}
        {/* HOME, and it is a gap rather than a flourish.
            The only route to the shelf from an open book was the command
            palette: `onOpenLibrary` exists but is rendered inside the reader's
            EMPTY state, so it disappears the moment there is a book to read.
            Meanwhile this bar has carried "Switch book" all along — you could
            move between books but not reach the place they live. Paper opens on
            the library now, which makes it home, and home had no door.

            A TOGGLE, because the return trip has the same hole: going to the
            shelf with a book open and wanting it back was the palette too. It
            names the DESTINATION both ways — a shelf of books, or the book
            itself. A chevron would say "back", which is a direction rather than
            a place, and this control has two of them.

            ALWAYS DRAWN, including on the shelf with nothing open. It was gated
            on `hasBook` on the reasoning that a control which cannot act should
            not be shown — and that reasoning is wrong twice over. It CAN act:
            the reader's empty state is where a book gets dropped or picked, so
            going there is a real destination rather than a dead end. And the
            gate made the pair of controls read as one control that sometimes
            exists, on the screen Paper now OPENS on. The same instinct hid the
            Open Library lookup behind an invisible predicate and produced the
            same question — "why is it missing?" — which is the answer to
            whether the predicate was a good idea. */}
        <button
          type="button"
          className={styles.action}
          /* THREE STATES, not two. "Back to the book" is a lie when there is
             no book — the destination is the reader's empty state, which is
             where a book gets dropped or picked. The control is always drawn;
             what it is NAMED still has to be true. */
          title={
            isReader
              ? `Library · ${comboFor('⌘L', platform)}`
              : hasBook
                ? `Back to the book · ${comboFor('⌘L', platform)}`
                : `Open a book · ${comboFor('⌘L', platform)}`
          }
          aria-label={isReader ? 'Library' : hasBook ? 'Back to the book' : 'Open a book'}
          onClick={() =>
            dispatch({ type: 'goScreen', screen: isReader ? 'library' : 'reader' })
          }
        >
          {isReader ? (
            <LibraryIcon size={ICON.control} strokeWidth={ICON.stroke} />
          ) : (
            <BookOpen size={ICON.control} strokeWidth={ICON.stroke} />
          )}
        </button>
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
