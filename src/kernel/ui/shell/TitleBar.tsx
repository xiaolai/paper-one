import { SCREEN_JUMP_COMBO, paneAvailable, paneFits, screenJump } from '../state'
import {
  AudioLines,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Library as LibraryIcon,
  ListTree,
  Minus,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Square,
  Type,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ICON, READING_RATE } from '../../core/metrics'
import type { Platform } from '../../core/metrics'
import { inTauri } from '../inTauri'
import { PANE_TITLES, comboFor } from '../panes'
import type { ScreenContribution } from '../../core/capability'
import { CONTRIBUTION_ICONS } from '../contributionIcon'
import type { AppDispatch, AppState, KernelPaneId } from '../state'
import type { Speech } from '../reader/useSpeech'
import styles from './TitleBar.module.css'

/** Traffic-light fills, in AppKit's order. Preview only — see below. */
const LIGHTS = ['var(--tl-red)', 'var(--tl-amber)', 'var(--tl-green)'] as const

/**
 * Shortcuts into the pane. They used to toggle a separate 340px card; now they
 * open the pane on that panel, and clicking the active one closes it.
 *
 * A few panels of the rail, chosen here — but their LABELS come from the shared
 * registry, not from a third copy of them. The name is `TITLEBAR_PANES` rather
 * than `PANE_SHORTCUTS`, which is what this was called: that name already
 * means §11's ⌘1…5 map in `ui/panes`, and two different things under one name
 * in one codebase is a trap for whoever greps for it next.
 *
 * ⚠️ **FILTERED THROUGH `paneFits`, WHICH THIS WAS THE ONE SURFACE NOT TO DO.**
 * It drew the deleted companion's button for every reader, although the rail,
 * the palette and the digit accelerators all refused the panel — so the click
 * was redirected to Contents by `paneFor`. It could never light, so a second
 * press re-opened Contents rather than closing it, and the control named one
 * destination while performing another.
 *
 * That also falsifies what `UNFINISHED_PANE_IDS` says about itself — "the only
 * edit required" to ship a panel — for as long as a surface reads the list
 * without reading the rule. Everything here asks the rule.
 */
const TITLEBAR_PANES: readonly { key: KernelPaneId; Icon: typeof ListTree }[] = [
  { key: 'toc', Icon: ListTree },
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
  /**
   * The screens capabilities contributed — see `ScreenContribution`.
   *
   * ⚠️ **NAVIGATION IS THE KERNEL'S, WHICH IS WHY THIS IS HERE AND NOT IN THE
   * SCREEN ITSELF.** A contributed screen takes the whole window, so if it drew
   * its own way back, every capability would have to draw one and one of them
   * would forget — leaving a reader in a room with no door. The kernel offers
   * the switch, so a screen cannot be entered without a way out of it.
   */
  /**
   * ⚠️ **REQUIRED, AND IT WAS OPTIONAL TO SUIT A TEST.** The production caller
   * always supplies `composition.screens`; the `?` meant a forgotten prop removed
   * capability navigation SILENTLY instead of failing to compile. A caller with no
   * contributed screens passes `[]`, which says so.
   */
  /* ⚠️ **A `Pick` OF THE CONTRACT, NOT A COPY OF ITS FIELDS.** This spelled out
     `id`, `label` and `icon` by hand beside `ScreenContribution`, so a field
     renamed or retyped there would have left this prop describing a screen the
     composition no longer produces — and the caller passes the composition's
     screens straight in, so the mismatch would have surfaced as a type error at
     the one place least likely to be read as the cause. */
  screens: readonly Pick<ScreenContribution, 'id' | 'label' | 'icon'>[]
}

/**
 * KNOWN DEBT: this component holds more than one job — window IPC, the
 * platform's own controls, the chrome fade, the reading shortcuts, speech and the
 * palette. An audit flagged it and it was left deliberately.
 *
 * ⚠️ **THIS SAID "about 200 lines" AND THE FILE IS 534**, with the component
 * itself over 300 — so the one number offered to judge whether the debt had grown
 * was wrong, and wrong in the direction that made it look smaller. No size is
 * written here now: a count in a comment is a fact with a half-life, and `wc -l`
 * is always current.
 *
 * AND THE BUTTONS ARE NOT ONE COMPONENT, THOUGH THEY SHARE A CLASS. A later audit
 * asked for the icon-button skeleton to be extracted. The sites differ in their
 * ARIA contract rather than in their markup: three are toggles (`aria-pressed`),
 * the palette is a dialog trigger (`aria-haspopup` + `aria-expanded`), Listen is
 * an action that can be disabled with its reason in the title, and the screen jump
 * has three names. One component would take every one of those as a prop and
 * render them back — the attribute surface moved, not reduced.
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
  screens,
}: TitleBarProps) {
  const isMac = platform === 'macos'
  const isReader = state.screen === 'reader'
  const jump = screenJump(state.screen, hasBook)

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
  const appWindow = inTauri() ? getCurrentWindow() : null
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
            !inTauri() &&
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
        {/* ⚠️ **NOT IN THE READER.** A book is a place you are IN; a switch
            between the shelf and a capability's screen belongs where the reader
            is choosing what to look at, not on top of the page they are
            reading. `Open the library` in the reader's own chrome is the way
            out of a book, and adding a second one here would be two controls
            for one intent. */}
        {!isReader && (screens?.length ?? 0) > 0 && (
          <div className={styles.toggleGroup}>
            <button
              type="button"
              className={styles.action}
              title="Library"
              aria-label="Library"
              aria-pressed={state.screen === 'library'}
              data-on={state.screen === 'library'}
              onClick={() => dispatch({ type: 'goScreen', screen: 'library' })}
            >
              <LibraryIcon size={ICON.control} strokeWidth={ICON.stroke} />
            </button>
            {screens.map((one) => (
              <button
                key={one.id}
                type="button"
                className={styles.action}
                title={one.label}
                aria-label={one.label}
                aria-pressed={state.screen === one.id}
                data-on={state.screen === one.id}
                onClick={() => dispatch({ type: 'goScreen', screen: one.id })}
              >
                {/* THE SCREEN'S OWN GLYPH. Every contributed screen drew a
                    puzzle piece — see `CONTRIBUTION_ICONS` for what that
                    cost the rail, which had the same defect. */}
                {(() => {
                  const Icon = CONTRIBUTION_ICONS[one.icon]
                  return <Icon size={ICON.control} strokeWidth={ICON.stroke} />
                })()}
              </button>
            ))}
          </div>
        )}

        {isReader && (
          <>
            <div className={styles.toggleGroup}>
              {TITLEBAR_PANES.filter(({ key }) =>
                paneFits(state.screen, key, { developer: state.developer, hiddenPanes: state.hiddenPanes }),
              ).map(({ key, Icon }) => (
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
            {speech.speaking ? (
              <ReadingTransport
                speech={speech}
                rate={state.readingRate}
                onRate={(rate) => dispatch({ type: 'setReadingRate', rate })}
              />
            ) : (
              <button
                type="button"
                className={styles.action}
                title={
                  !speech.available
                    ? 'Listen — this build has no speech engine'
                    : 'Read this chapter aloud'
                }
                aria-label="Read aloud"
                aria-pressed={false}
                disabled={!speech.available || !hasBook}
                data-disabled={!speech.available || !hasBook}
                onClick={() => speech.start()}
              >
                <AudioLines size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
            )}
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
          /* ⚠️ **THE NAME AND THE DESTINATION COME FROM ONE PLACE.** This
             computed its own and disagreed with the shortcut printed in its
             own tooltip on every screen that is neither of the kernel's. */
          title={`${jump.label} · ${comboFor(SCREEN_JUMP_COMBO, platform)}`}
          aria-label={jump.label}
          onClick={() => dispatch({ type: 'goScreen', screen: jump.to })}
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
        {/* ⚠️ **NOT DRAWN WHERE THERE IS NO PANE.** A contributed screen owns
            the window, so `WindowShell` gives the slot no width and `SidePane`
            draws nothing — and this button went on looking active and toggling
            a state nothing reflected. A lit control that does nothing is worse
            than an absent one. */}
        {paneAvailable(state.screen) && (
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
        )}
      </div>
    </div>
  )
}

interface ReadingTransportProps {
  speech: Speech
  rate: number
  onRate: (rate: number) => void
}

/**
 * The reading's controls, drawn where the Listen toggle was.
 *
 * ⚠️ **IT REPLACES THE TOGGLE RATHER THAN FLOATING OVER THE PAGE**, which is the
 * choice that keeps the book at full height and puts nothing over the text. The
 * cost is width, and it is paid by the title chip, which shrinks — so every
 * control here is `--control-xs`, the design system's "an icon and nothing
 * else", rather than the titlebar size `.action` uses.
 *
 * ⚠️ **THE CHAPTER BUTTONS ARE ABSENT, NOT DISABLED, WHERE THE BOOK CANNOT STEP
 * CHAPTERS.** `SpeechPaging.chapter` is optional because a reader can be in a
 * spine item no contents entry points at, and there is genuinely no next chapter
 * to go to. A disabled control says "not now"; an absent one says "not here",
 * and the second is the true statement.
 */
function ReadingTransport({ speech, rate, onRate }: ReadingTransportProps) {
  const step = (label: string, Icon: LucideIcon, run: () => void) => (
    <button
      type="button"
      className={`${styles.action} ${styles.transportButton}`}
      title={label}
      aria-label={label}
      onClick={run}
    >
      <Icon size={ICON.window} strokeWidth={ICON.stroke} />
    </button>
  )

  return (
    <div className={styles.transport} role="group" aria-label="Reading aloud">
      {speech.chapters.back ? step('Previous chapter', ChevronsLeft, () => speech.stepChapter(-1)) : null}
      {step('Previous paragraph', SkipBack, () => speech.stepParagraph(-1))}
      {step('Previous sentence', ChevronLeft, () => speech.stepSentence(-1))}
      <button
        type="button"
        className={`${styles.action} ${styles.transportButton}`}
        title={speech.paused ? 'Go on reading' : 'Pause'}
        aria-label={speech.paused ? 'Go on reading' : 'Pause'}
        aria-pressed={speech.paused}
        onClick={() => (speech.paused ? speech.resume() : speech.pause())}
      >
        {speech.paused ? (
          <Play size={ICON.window} strokeWidth={ICON.stroke} />
        ) : (
          <Pause size={ICON.window} strokeWidth={ICON.stroke} />
        )}
      </button>
      {step('Next sentence', ChevronRight, () => speech.stepSentence(1))}
      {step('Next paragraph', SkipForward, () => speech.stepParagraph(1))}
      {speech.chapters.forward ? step('Next chapter', ChevronsRight, () => speech.stepChapter(1)) : null}
      <button
        type="button"
        className={`${styles.action} ${styles.transportButton} ${styles.rate}`}
        /* ⚠️ **THE STEPS ARE `READING_RATE`'s, NOT A SECOND LIST.** Settings
           offers the same ramp from the same constant, so the speed a reader
           sets in one place is a speed the other can show. A literal here would
           be a second answer to which speeds exist, and the two would drift the
           first time the ramp changed. */
        title={`Reading speed — ${formatRate(rate)}, tap for the next`}
        aria-label={`Reading speed ${formatRate(rate)}`}
        onClick={() => onRate(nextRate(rate))}
      >
        {formatRate(rate)}
      </button>
      {step('Stop reading aloud', Square, () => speech.stop())}
    </div>
  )
}

/**
 * The next speed up the ramp, wrapping to the slowest at the top.
 *
 * WRAPS rather than stopping, because this is one button doing a stepper's job:
 * stopping at 2.5× would leave a reader who overshot with no way back except the
 * settings pane. The ramp is short enough that going round is quicker.
 *
 * ⚠️ **THE FIRST STEP ABOVE THE CURRENT RATE, NOT ONE PAST THE NEAREST.** This
 * found the nearest step and advanced from it, which is right on the ramp and
 * wrong off it — and off it is exactly the case the nearest-match existed for: a
 * rate stored by a build with a different ramp. Measured: `1.4` advanced to
 * `1.75`, skipping `1.5`, because its nearest step is `1.5` and the one after
 * that is `1.75`; and `2.4` WRAPPED to `0.5`, skipping `2.5` entirely, because
 * its nearest step is the top one. "Faster" should never skip a speed the ramp
 * offers, and it should never go slower while a faster one exists.
 *
 * So: the smallest step strictly greater than the rate, and the slowest only
 * when nothing is. On the ramp the two rules give the same answer; off it, only
 * this one is right.
 */
function nextRate(rate: number): number {
  const steps = READING_RATE.steps
  const faster = steps.find((step) => step > rate)
  return faster ?? steps[0] ?? 1
}

/** `1×`, `1.25×` — no trailing zero, because `1.00×` reads as a measurement. */
function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}
