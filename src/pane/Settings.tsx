import { READING_STEPS, readingStep } from '../lib/metrics'
import { THEMES, TYPEFACES } from '../lib/panes'
import type { PageLayout, Side, Theme, Typeface } from '../lib/state'
import styles from './SidePane.module.css'

/**
 * What each face should be PREVIEWED in, as a CSS stack.
 *
 * Deliberately not imported from `bookCss`: that stack is the book's, with
 * script fallbacks and a generic tail that exist so an unusual document
 * degrades gracefully. A preview wants the bundled face or nothing — falling
 * back to Georgia here would show the reader a sample of a typeface they cannot
 * choose, labelled with the name of one they can.
 */
const PREVIEW_STACKS: Record<Typeface, string> = {
  literata: "'Literata Variable', serif",
  crimson: "'Crimson Pro Variable', serif",
  instrument: "'Instrument Sans Variable', sans-serif",
  plex: "'IBM Plex Mono', monospace",
}

/**
 * §05 theme chips — the page colour of each theme, as a literal, because a
 * swatch has to show the theme it offers rather than the one in use.
 *
 * The fills are this panel's own business and stay here. The ids and labels do
 * not: they came from a second copy of the theme table that the command palette
 * also carried, so renaming a theme meant editing two files and noticing. They
 * now come from `lib/panes`, and the fill map is typed as a total Record so a
 * new theme without a swatch fails to compile.
 */
const THEME_FILLS: Record<Theme, string> = {
  paper: '#FFFFFF',
  slate: '#DFE1DE',
  sepia: '#F8F0E1',
  sage: '#DDE6D8',
  night: '#16191C',
}

const THEME_CHIPS = THEMES.map(({ id, label }) => ({ id, label, fill: THEME_FILLS[id] }))

/**
 * Only what this panel reads and changes.
 *
 * Taking the whole AppState and dispatch would leave it coupled to every
 * unrelated field — extracting it into its own file without narrowing the
 * surface just relocates the coupling.
 */
export interface SettingsProps {
  theme: Theme
  themeFollowsOs: boolean
  pageLayout: PageLayout
  rulerOn: boolean
  scrollbarOn: boolean
  progressLineOn: boolean
  side: Side
  /** Index into §09's seven reading steps — see `lib/metrics`. */
  stepIdx: number
  typeface: Typeface
  onTheme: (theme: Theme) => void
  onFollowOs: (follows: boolean) => void
  onPageLayout: (layout: PageLayout) => void
  onToggleRuler: () => void
  onToggleScrollbar: () => void
  onToggleProgressLine: () => void
  onSide: (side: Side) => void
  onStepIdx: (idx: number) => void
  onTypeface: (typeface: Typeface) => void
}

export function Settings({
  theme,
  themeFollowsOs,
  pageLayout,
  rulerOn,
  scrollbarOn,
  progressLineOn,
  side,
  stepIdx,
  typeface,
  onTheme,
  onFollowOs,
  onPageLayout,
  onToggleRuler,
  onToggleScrollbar,
  onToggleProgressLine,
  onSide,
  onStepIdx,
  onTypeface,
}: SettingsProps) {
  const step = readingStep(stepIdx)
  return (
    <div className={styles.panel}>
      <div className={styles.groupTitle}>Appearance</div>
      <div className={styles.themeGrid}>
        {THEME_CHIPS.map(({ id, label, fill }) => (
          <button
            key={id}
            type="button"
            className={styles.themeSwatch}
            data-on={theme === id}
            onClick={() => onTheme(id)}
          >
            <span className={styles.themeChip} style={{ background: fill }} />
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onFollowOs(!themeFollowsOs)}
      >
        <span style={{ flex: 1 }}>Follow system appearance</span>
        <span className={styles.settingValue}>{themeFollowsOs ? 'On' : 'Off'}</span>
      </button>

      <div className={styles.groupTitle}>Reading</div>

      {/* §09's seven steps, as a stepper rather than a slider: each step carries
          its own measure and line box, so the sizes between them do not exist.
          A row, not a <button> — a button cannot contain buttons, and the two
          ends must be separately disablable. */}
      <div className={`${styles.settingRow} ${styles.settingStatic}`}>
        <span style={{ flex: 1 }}>Type size</span>
        <div className={styles.stepper}>
          <button
            type="button"
            className={styles.stepperButton}
            disabled={stepIdx <= 0}
            aria-label="Smaller type"
            onClick={() => onStepIdx(stepIdx - 1)}
          >
            −
          </button>
          {/* Shown at its own size, capped at the row: the point of the control
              is the type, and a number in interface type says nothing about
              how the page will read. §09 keeps interface type off this ramp. */}
          <span className={styles.stepperValue} style={{ fontSize: Math.min(step.size, 22) }}>
            {step.size}
          </span>
          <button
            type="button"
            className={styles.stepperButton}
            disabled={stepIdx >= READING_STEPS.length - 1}
            aria-label="Larger type"
            onClick={() => onStepIdx(stepIdx + 1)}
          >
            +
          </button>
        </div>
      </div>

      {/* Each row is SET IN the face it offers, which is the only honest way to
          show a typeface — a list of four proper nouns in the interface font
          tells a reader nothing about what their book will look like. §09 keeps
          interface type off this ramp, so the label below each sample stays in
          the interface face at its own size. */}
      <div className={styles.typefaceList}>
        {TYPEFACES.map(({ id, label, note }) => (
          <button
            key={id}
            type="button"
            className={styles.typefaceRow}
            data-on={typeface === id}
            aria-pressed={typeface === id}
            onClick={() => onTypeface(id)}
          >
            <span
              className={styles.typefaceSample}
              style={{ fontFamily: PREVIEW_STACKS[id] }}
            >
              {label}
            </span>
            <span className={styles.typefaceNote}>{note}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onPageLayout(pageLayout === 'scrolled' ? 'paginated' : 'scrolled')}
      >
        <span style={{ flex: 1 }}>Flow</span>
        <span className={styles.settingValue}>
          {pageLayout === 'scrolled' ? 'Scrolled' : 'Paged'}
        </span>
      </button>

      {/* §06: the ruler row appears only in scrolled flow — hidden, not
          disabled, because paged has no lines to advance. */}
      {pageLayout === 'scrolled' && (
        <button
          type="button"
          className={styles.settingRow}
          onClick={onToggleRuler}
        >
          <span style={{ flex: 1 }}>Reading ruler</span>
          <span className={styles.settingValue}>{rulerOn ? 'On' : 'Off'}</span>
        </button>
      )}

      {/* Same rule as the ruler: shown only where it means something. A paged
          book has no scroll port, so the row would name a bar that does not
          exist in that flow whichever way it was set. */}
      {pageLayout === 'scrolled' && (
        <button
          type="button"
          className={styles.settingRow}
          onClick={onToggleScrollbar}
        >
          <span style={{ flex: 1 }}>Scrollbar</span>
          <span className={styles.settingValue}>{scrollbarOn ? 'Shown' : 'Hidden'}</span>
        </button>
      )}

      {/* NOT flow-guarded, unlike the two above. Progress through the book is
          the same quantity whether the book is scrolled or paged — `fraction`
          arrives on relocate either way — so a row that vanished in paged flow
          would be hiding a working feature. */}
      <button
        type="button"
        className={styles.settingRow}
        onClick={onToggleProgressLine}
      >
        <span style={{ flex: 1 }}>Progress rule</span>
        <span className={styles.settingValue}>
          {progressLineOn ? 'Shown' : 'Hidden'}
        </span>
      </button>

      <div className={styles.groupTitle}>Side pane</div>
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onSide(side === 'left' ? 'right' : 'left')}
      >
        <span style={{ flex: 1 }}>Position</span>
        <span className={styles.settingValue}>{side === 'left' ? 'Left' : 'Right'}</span>
      </button>
    </div>
  )
}
