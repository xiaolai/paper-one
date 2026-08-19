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
import { PaneGroup } from './PaneGroup'
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
 * The panel's own groups, by id.
 *
 * NO COLON, deliberately: a contributed section's id is `<capability>:<name>`
 * — `sync:storage`, `peer:devices` — and both kinds share one open/closed
 * list, so the convention is what keeps a capability from colliding with a
 * group the kernel owns.
 */
const GROUP = {
  appearance: 'appearance',
  text: 'text',
  spacing: 'spacing',
  page: 'page',
} as const

/**
 * Which groups are open when the panel is opened.
 *
 * BY HOW OFTEN A READER RETURNS TO THEM, which is the only thing a default
 * can honestly be chosen on. Appearance, Text and Page hold every setting
 * somebody changes more than once — the theme, the face, the size, whether
 * the book scrolls. Spacing, Devices and Storage are set once and then left
 * for months, and the cost of a closed group is one click against a cost the
 * open one charges every reader on every visit.
 *
 * EVERY HEADING IS THE SAME KIND OF THING NOW, and that is the point of
 * having this list at all. The panel used to draw two: a plain caption over
 * Appearance and Reading, a disclosure over Light and Spacing. They looked
 * alike, sat in one column, and only one of them did anything — so the only
 * way to learn which was to click both. What varies is a default, not an
 * affordance.
 */
const OPEN_AT_REST: readonly string[] = [GROUP.appearance, GROUP.text, GROUP.page]

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
  /**
   * Capabilities that did not compose — `Composition.failures`.
   *
   * Stated here because this is where their sections would have been. A
   * failure is survivable now (ADR 0001 Decision 9), which is only honest if
   * the reader can see that something is missing rather than wondering where
   * Devices went.
   */
  missing?: readonly { readonly id: string }[] | undefined
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
  missing,
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
  /* ONE MECHANISM FOR EVERY GROUP, the kernel's own and the contributed ones
     alike. There were three — a boolean for Light, a boolean for Spacing, and
     a list for the capability sections — which is what let the panel grow two
     kinds of heading that look alike and behave differently.

     Local, like every other piece of this panel's own view state: which groups
     a reader had open is not something the app should remember on their
     behalf, and a panel that opens the same way every time is one they can
     learn. */
  const [openGroups, setOpenGroups] = useState<readonly string[]>(OPEN_AT_REST)
  const groupOpen = (id: string) => openGroups.includes(id)
  const toggleGroup = (id: string) =>
    setOpenGroups((open) => (open.includes(id) ? open.filter((one) => one !== id) : [...open, id]))
  /* Handed in, not probed here: `App` probes once and gives the same list to
     this panel and to the command palette, so the two cannot come to offer
     different faces. */
  return (
    <div className={styles.panel}>
      <PaneGroup
        title="Appearance"
        open={groupOpen(GROUP.appearance)}
        onToggle={() => toggleGroup(GROUP.appearance)}
      >
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

      {/* HOW MUCH LIGHT THE APP GIVES OFF, and how hard the text sits on it.
          IN Appearance, where they were a group of their own called "Light".
          The distinction that group was drawn on is real — a theme is WHICH
          palette and these two are how much of it reaches the reader — but it
          bought a heading and a click to reveal two rows, and it put
          "Brightness" somewhere a reader hunting for it would not look first.
          The word Appearance covers both without straining. It was collapsed
          for room, and the room came from elsewhere: Devices and Storage were
          eleven always-open rows and are now two headings.

          Independent of the system on purpose — dimming the display to read at
          night dims everything else with it, and turning it back up to answer a
          message undoes the reading setting. Both start at the theme untouched
          and only take away, and nothing either produces can go under 4.5:1;
          see `adjustPalette`. */}
      <StepRow label="Brightness" scale={BRIGHTNESS} value={brightness} onChange={onBrightness} />
      <StepRow label="Contrast" scale={CONTRAST} value={contrast} onChange={onContrast} />
      </PaneGroup>

      {/* TEXT, not "Reading" — everything in this panel is about reading, so
          the word named nothing. This group is how the type is SET: which
          face, how big, and how the lines end. */}
      <PaneGroup
        title="Text"
        open={groupOpen(GROUP.text)}
        onToggle={() => toggleGroup(GROUP.text)}
      >

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
      </PaneGroup>

      {/* THE FINE TUNING OF THE SAME TYPE, kept behind a click and kept next
          to what it tunes. Four rows a reader sets once and then leaves for
          months; open, they push everything below them off a 400px pane, and
          that is the whole argument `PaneGroup` was built on. It sits
          directly under Text rather than at the bottom of the panel so the
          heading it refines is the one above it.

          Nothing here touches the MEASURE. That is the size step's, and letting
          a second control move it would make the line length depend on which
          one was touched last. */}
      <PaneGroup
        title="Spacing"
        open={groupOpen(GROUP.spacing)}
        onToggle={() => toggleGroup(GROUP.spacing)}
      >
      <StepRow label="Letter" scale={SPACING.letter} value={spacing.letter}
        onChange={(idx) => onSpacing('letter', idx)} />
      <StepRow label="Word" scale={SPACING.word} value={spacing.word}
        onChange={(idx) => onSpacing('word', idx)} />
      <StepRow label="Line" scale={SPACING.line} value={spacing.line}
        onChange={(idx) => onSpacing('line', idx)} />
      <StepRow label="Paragraph" scale={SPACING.paragraph} value={spacing.paragraph}
        onChange={(idx) => onSpacing('paragraph', idx)} />
      </PaneGroup>

      {/* THE PAGE: how it moves, and what sits around it while it does.
          These five rows had no heading at all. They were left over after
          Appearance and Reading had taken theirs, and they landed BELOW two
          collapsed groups — so with Spacing shut they read as Spacing's
          contents, and with it open they read as nothing's. Five settings
          floating under the last heading that happened to be printed.

          They do belong together, and the run of them says why: Flow decides
          whether the words scroll or turn, the ruler and the scrollbar exist
          only where they scroll, the progress rule marks how far through
          either way, and the side pane is the furniture the page is set
          beside. One question — what does the reading surface look like and
          how does it advance — asked five ways. */}
      <PaneGroup
        title="Page"
        open={groupOpen(GROUP.page)}
        onToggle={() => toggleGroup(GROUP.page)}
      >

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

      {/* STILL NO HEADING OF ITS OWN, for the reason it never had one: a
          section is a promise of more than one thing in it, and "Side pane"
          over a single "Position" takes two lines to say what one says. What
          it lacked was a group to belong to, not a heading — it is in Page's
          now, and the row still carries its whole name. */}
      <button
        type="button"
        className={styles.settingRow}
        onClick={() => onSide(side === 'left' ? 'right' : 'left')}
      >
        <span style={{ flex: 1 }}>Side pane position</span>
        <span className={styles.settingValue}>{side === 'left' ? 'Left' : 'Right'}</span>
      </button>
      </PaneGroup>

      {/* The contributed sections — a capability's own settings surface,
          under its own title, in composition order (WI-C.5).

          GROUPS, LIKE EVERY OTHER GROUP HERE. These were a bare heading over
          an always-open list, so Devices and Storage — eleven rows between
          them, set up once and then left alone for months — pushed Flow, the
          ruler and the side pane's position off the bottom of a 400px pane.
          That is the exact complaint `PaneGroup` was built to answer, and
          the kernel's own long groups already answer it; a contributed
          section had no way to.

          It also costs nothing while closed: the children are an ELEMENT, not
          a render, so a closed group never mounts the pane — which is what
          stops the Storage section reading the disk on every shelf write for
          a surface nobody has opened. */}
      {sections.map((section) => (
        <PaneGroup
          key={section.id}
          title={section.title}
          open={groupOpen(section.id)}
          onToggle={() => toggleGroup(section.id)}
        >
          {renderContribution(section.id, section.render)}
        </PaneGroup>
      ))}

      {(missing ?? []).map((one) => (
        <div key={one.id} className={styles.capabilityMissing}>
          <span>{one.id} is not running — its settings are unavailable until the app is restarted.</span>
        </div>
      ))}
    </div>
  )
}
