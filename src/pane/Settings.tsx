import { READING_STEPS, readingStep } from '../lib/metrics'
import { THEMES } from '../lib/panes'
import { GROUP_LABEL, type Face } from '../lib/typefaces'
import type { PageLayout, Side, Theme, Typeface } from '../lib/state'
import styles from './SidePane.module.css'

/* THERE IS NO PREVIEW TABLE HERE ANY MORE. A face's stack was written once for
 * the book and again for its sample, so a face could be previewed in something
 * other than what the reader would get. One registry — `typefaces.ts` — and the
 * sample is set in the same stack the book is.
 */

/**
 * §05 theme chips — the page colour of each theme, as a literal, because a
 * swatch has to show the theme it offers rather than the one in use.
 *
 * THE SWATCHES CARRY `data-theme` AND ARE DRAWN IN IT. There was a table of
 * one hex per theme here, which is a copy of a value `tokens.css` already
 * owns — and a copy of ONE of them: a theme is an ink, a surface, a muted and
 * an accent, and a swatch showing only the surface could not show the thing a
 * reader is actually choosing between, which is how the text will look on it.
 * Every theme selector in `tokens.css` is an attribute selector, so a tile that
 * carries the attribute resolves the whole set and previews the real pairing.
 * Retune a theme and its swatch follows with no second edit.
 */
const THEME_CHIPS = THEMES

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
  /** The faces this machine can offer — see `offeredFaces`. */
  offered: readonly Face[]
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
  offered,
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
  /* Handed in, not probed here: `App` probes once and gives the same list to
     this panel and to the command palette, so the two cannot come to offer
     different faces. */
  return (
    <div className={styles.panel}>
      <div className={styles.groupTitle}>Appearance</div>
      <div className={styles.themeGrid}>
        {THEME_CHIPS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={styles.themeSwatch}
            /* Drawn IN the theme it offers — see the note above the table. */
            data-theme={id}
            data-on={theme === id}
            aria-pressed={theme === id}
            onClick={() => onTheme(id)}
          >
            {/* A SPECIMEN, not a colour. What a reader picks a theme for is how
                text sits on it, and a plain fill could not show that: Sepia and
                Sage differ far more in their ink than in their paper. The
                interface's own face, not a book's — the typeface below is a
                separate choice and this must not look like it previews one. */}
            <span className={styles.themeAa} aria-hidden="true">
              Aa
            </span>
            <span className={styles.themeName}>{label}</span>
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
        {/* "Text size", not "Font size" — the control directly below chooses the
            FONT, and two rows both beginning "Font" read as one setting split
            in two rather than as the two different decisions they are. */}
        <span style={{ flex: 1 }}>Text size</span>
        <div className={styles.stepper}>
          {/* A SMALL A AND A LARGE ONE, which say what grows. `−` and `+` beside
              a number say only "more", and next to a numeral they read as a
              numeric field — the reader has to work out what the number is of.
              An A is the answer and the demonstration at once. */}
          <button
            type="button"
            className={styles.stepperButton}
            disabled={stepIdx <= 0}
            aria-label="Smaller text"
            onClick={() => onStepIdx(stepIdx - 1)}
          >
            <span className={styles.stepperSmall} aria-hidden="true">
              A
            </span>
          </button>
          {/* AT A STEADY SIZE. It used to be drawn at the size it names, which
              made the number a demonstration — but the two A's demonstrate it
              now, and a value that changes size makes the row change height
              every time it is pressed. It reports; they show. */}
          <span className={styles.stepperValue}>{step.size}</span>
          <button
            type="button"
            className={styles.stepperButton}
            disabled={stepIdx >= READING_STEPS.length - 1}
            aria-label="Larger text"
            onClick={() => onStepIdx(stepIdx + 1)}
          >
            <span className={styles.stepperLarge} aria-hidden="true">
              A
            </span>
          </button>
        </div>
      </div>

      {/* GROUPED BY WHAT IS BEING CHOSEN — a serif to read in, a sans, a
          monospace — and nothing else. No row says where its font came from:
          a reader cannot act on "bundled" or "system", and a list that named a
          font this machine does not have would be a list that lies, so absent
          faces are simply not in it.

          Each row is SET IN the face it offers, which is the only honest way to
          show a typeface — four proper nouns in the interface font tell a
          reader nothing about what their book will look like. The sample IS the
          description, so there is no note beside it any more. */}
      {(['serif', 'sans', 'mono'] as const).map((group) => {
        const faces = offered.filter((face) => face.group === group)
        if (faces.length === 0) return null
        return (
          <div key={group}>
            <div className={styles.groupTitle}>{GROUP_LABEL[group]}</div>
            <div className={styles.typefaceList}>
              {faces.map((face) => (
                <button
                  key={face.id}
                  type="button"
                  className={styles.typefaceRow}
                  data-on={typeface === face.id}
                  aria-pressed={typeface === face.id}
                  onClick={() => onTypeface(face.id)}
                >
                  <span className={styles.typefaceSample} style={{ fontFamily: face.stack }}>
                    {face.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )
      })}

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
