import { useState } from 'react'
import type { SettingsSection } from '../../core/capability'
import { BRIGHTNESS, CONTRAST, READING_STEPS, SPACING, readingStep } from '../../core/metrics'
import { THEMES, renderContribution } from '../panes'
import type { Face } from '../../core/typefaces'
import { FacePicker } from './FacePicker'
import type {
  Align,
  PageLayout,
  Side,
  SpacingIndices,
  SpacingKey,
  Theme,
  Typeface,
} from '../state'
import { SettingGroup } from './SettingGroup'
import { StepRow } from './StepRow'
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
  /**
   * The sections the composed capabilities contributed (WI-C.5) — Devices
   * from peer, Storage from sync — rendered after the kernel's own groups,
   * in composition order, each under its own title. The registry validated
   * ids and uniqueness; `renderContribution` narrows each opaque renderer.
   */
  sections: readonly SettingsSection[]
  onTheme: (theme: Theme) => void
  onFollowOs: (follows: boolean) => void
  onPageLayout: (layout: PageLayout) => void
  onToggleRuler: () => void
  onToggleScrollbar: () => void
  onToggleProgressLine: () => void
  onSide: (side: Side) => void
  onStepIdx: (idx: number) => void
  spacing: SpacingIndices
  onSpacing: (key: SpacingKey, idx: number) => void
  align: Align
  onAlign: (align: Align) => void
  brightness: number
  onBrightness: (idx: number) => void
  contrast: number
  onContrast: (idx: number) => void
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
  sections,
  onTheme,
  onFollowOs,
  onPageLayout,
  onToggleRuler,
  onToggleScrollbar,
  onToggleProgressLine,
  onSide,
  onStepIdx,
  spacing,
  onSpacing,
  align,
  onAlign,
  brightness,
  onBrightness,
  contrast,
  onContrast,
  onTypeface,
}: SettingsProps) {
  const step = readingStep(stepIdx)
  const [faceMenuOpen, setFaceMenuOpen] = useState(false)
  /* Closed to begin with — see `SettingGroup`. Local, like every other piece of
     this panel's own view state: which groups a reader had open is not
     something the app should remember on their behalf. */
  const [lightOpen, setLightOpen] = useState(false)
  const [spacingOpen, setSpacingOpen] = useState(false)
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

      {/* ONE ROW FOR HOW THE BOOK IS SET: which face, and how big. They are the
          same decision asked twice — a reader adjusting one is looking at the
          other — and they were a labelled row and an eight-row list a screen
          apart. There is no "Text size" label because there is nothing to
          label: two A's and a number beside a font's name can only be its size.

          §09's seven steps, as a stepper rather than a slider: each step carries
          its own measure and line box, so the sizes between them do not exist. A
          row, not a <button> — a button cannot contain buttons. */}
      <div className={`${styles.settingRow} ${styles.settingStatic} ${styles.readingRow}`}>
        <FacePicker
          value={typeface}
          offered={offered}
          onChange={onTypeface}
          open={faceMenuOpen}
          setOpen={setFaceMenuOpen}
        />
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

      {/* HOW OPEN THE TYPE IS SET. Four things, grouped, because a reader
          adjusting one is usually adjusting the next — and separated from the
          face and size above because those two decide what the page IS and
          these decide how much air it has.

          Nothing here touches the MEASURE. That is the size step's, and letting
          a second control move it would make the line length depend on which
          one was touched last. */}
      {/* ONE DECISION, NOT TWO. It was `justify` and `hyphenate`, both hardcoded
          on and neither reachable — and as a pair they allowed justified text
          with no hyphens, which is the one combination that is simply worse:
          the word spaces stretch to fill the line instead, and at this measure
          that opens rivers. Ragged text has nowhere for the slack to go, so
          hyphens there buy nothing and cost an interruption.

          Not "Left" and "Justified": the flush edge is on the left in English,
          the right in Arabic and the top in vertical Japanese, and the book
          says which. See `Align`. */}
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onAlign(align === 'justified' ? 'ragged' : 'justified')}
      >
        <span style={{ flex: 1 }}>Alignment</span>
        <span className={styles.settingValue}>
          {align === 'justified' ? 'Justified' : 'Ragged'}
        </span>
      </button>

      {/* HOW MUCH LIGHT THE APP GIVES OFF, and how hard the text sits on it.
          Its own group rather than a tail on Appearance: that one is which
          theme, and these two are how much of it reaches the reader.

          Independent of the system on purpose — dimming the display to read at
          night dims everything else with it, and turning it back up to answer a
          message undoes the reading setting. Both start at the theme untouched
          and only take away, and nothing either produces can go under 4.5:1;
          see `adjustPalette`. */}
      <SettingGroup title="Light" open={lightOpen} onToggle={() => setLightOpen(!lightOpen)}>
        <StepRow label="Brightness" scale={BRIGHTNESS} value={brightness} onChange={onBrightness} />
        <StepRow label="Contrast" scale={CONTRAST} value={contrast} onChange={onContrast} />
      </SettingGroup>

      <SettingGroup title="Spacing" open={spacingOpen} onToggle={() => setSpacingOpen(!spacingOpen)}>
      <StepRow label="Letter" scale={SPACING.letter} value={spacing.letter}
        onChange={(idx) => onSpacing('letter', idx)} />
      <StepRow label="Word" scale={SPACING.word} value={spacing.word}
        onChange={(idx) => onSpacing('word', idx)} />
      <StepRow label="Line" scale={SPACING.line} value={spacing.line}
        onChange={(idx) => onSpacing('line', idx)} />
      <StepRow label="Paragraph" scale={SPACING.paragraph} value={spacing.paragraph}
        onChange={(idx) => onSpacing('paragraph', idx)} />
      </SettingGroup>

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

      {/* NO HEADING OF ITS OWN. A section is a promise of more than one thing
          in it, and this one had a single row — so "Side pane" and "Position"
          together took two lines to say what one line says, and the heading
          read as the start of a group that never arrived. The row carries the
          whole name instead. */}
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onSide(side === 'left' ? 'right' : 'left')}
      >
        <span style={{ flex: 1 }}>Side pane position</span>
        <span className={styles.settingValue}>{side === 'left' ? 'Left' : 'Right'}</span>
      </button>

      {/* The contributed sections — a capability's own settings surface,
          under its own title, in composition order (WI-C.5). */}
      {sections.map((section) => (
        <div key={section.id}>
          <div className={styles.groupTitle}>{section.title}</div>
          {renderContribution(section.id, section.render)}
        </div>
      ))}
    </div>
  )
}
