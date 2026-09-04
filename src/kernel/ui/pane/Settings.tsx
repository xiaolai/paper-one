import { useState } from 'react'
import type { SettingsSection } from '../../core/capability'
import {
  BRIGHTNESS,
  CONTRAST,
  FIGURE_HEIGHTS,
  FIGURE_WIDTHS,
  MINIMUM_SIZES,
  READING_STEPS,
  SPACING,
  readingStep,
} from '../../core/metrics'
import { PANE_TITLES, THEMES } from '../panes'

/* A settings section is about no book. Stryker disable next-line ObjectLiteral: no section reads the context, so what it holds cannot be seen. */
const NO_BOOK = { bookId: null } as const
import type { Face } from '../../core/typefaces'
import { FacePicker } from './FacePicker'
import type {
  Align,
  PageLayout,
  ReadingStyle,
  ReadingStyleKey,
  Side,
  SpacingIndices,
  SpacingKey,
  Theme,
  Typeface,
} from '../state'
import {
  ALIGNS,
  CODE_FACES,
  CODE_WRAPS,
  FIDELITIES,
  FIGURE_FRAMES,
  FLOURISHES,
  HEADING_SCALES,
  NOTE_SIZES,
  PAGE_LAYOUTS,
  QUOTE_STYLES,
  SEPARATIONS,
  SIDES,
  TABLE_FITS,
  UNFINISHED_PANE_IDS,
} from '../../core/uiTypes'
import { PaneBand } from './PaneBand'
import { PaneGroup } from './PaneGroup'
import { StepRow } from './StepRow'
import styles from './SidePane.module.css'
import { ContributionBoundary, ContributionBody } from '../ContributionBoundary'

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
  paragraphs: 'paragraphs',
  blocks: 'blocks',
  figures: 'figures',
  page: 'page',
  /* ⚠️ **NO COLON, AND THESE WERE `developer:unfinished`.** A colon is the
     CONTRIBUTED-pane and contributed-section convention — `<capability>:<name>`
     — and these ids share one open/closed list with the sections a capability
     contributes, so a capability named `developer` would have collided with
     them and toggled the wrong group. They were also bare literals written
     twice each at the call site, where a half-finished rename silently breaks
     toggling rather than failing to compile. */
  developerPanels: 'developerPanels',
  developerDiagnostics: 'developerDiagnostics',
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
/* THE THREE WI-14.4 ADDS ARE NOT HERE, and the rule this list already states
   is why: a group is open at rest only if a reader returns to it. Paragraphs,
   Blocks and Figures are set once against a shelf and then left, exactly like
   Spacing — and open, the three of them would push Flow, the ruler and the
   side pane off the bottom of a 400px pane. */
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
  pageLayout?: PageLayout | undefined
  rulerOn?: boolean | undefined
  scrollbarOn?: boolean | undefined
  progressLineOn?: boolean | undefined
  side?: Side | undefined
  /** Index into §09's seven reading steps — see `core/metrics`. */
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
   * Developer options, and the unfinished panels they govern.
   *
   * ABSENT IS OFF. The whole band disappears with it — there is no greyed-out
   * heading and no "turn this on" row, because the only way in is ⌘⌃⌥D and a
   * row advertising a chord is the discoverability this feature exists not to
   * have. See `KERNEL_SETTINGS.developer`.
   */
  developer?:
    | {
        readonly hidden: readonly string[]
        readonly onSetHidden: (pane: string, hidden: boolean) => void
        /** Whether the app is recording diagnostics at all — see `DevPane`. */
        readonly recording: boolean
      }
    | undefined
  /**
   * Capabilities that did not compose — `Composition.failures`.
   *
   * Stated here because this is where their sections would have been. A
   * failure is survivable now (ADR 0001 Decision 9), which is only honest if
   * the reader can see that something is missing rather than wondering where
   * Devices went.
   */
  missing?: readonly { readonly id: string }[] | undefined
  /**
   * Whether anything chosen here will still be chosen next launch.
   *
   * `false` for a browser with storage switched off, and for a store whose
   * write has been REFUSED — a full quota, a full disk. Drawn as a sentence
   * for the same reason the Notes and Cards panels draw theirs: a preference
   * that is not being saved looks exactly like one that is, right up until the
   * next launch throws it away.
   *
   * Defaults to `true`, so a host that has no answer says nothing rather than
   * accusing a working store.
   */
  persistent?: boolean | undefined
  onTheme: (theme: Theme) => void
  onFollowOs: (follows: boolean) => void
  /**
   * ⚠️ THE SEVEN OPTIONAL SETTERS BELOW, and why absence is the right signal.
   *
   * A host that cannot do the thing does not pass its setter, and the row is
   * not drawn — the same convention as `onAddBooks` on the shelf, `cards` in
   * Marginalia and `onInstallGloss` in the reader. The browser client mounts
   * this pane and has no reading ruler, no scroll port it owns, no side pane
   * (a 393px screen has no side), and no brightness or contrast filter; drawing
   * those rows would name features that host will never have.
   *
   * GATED ON THE SETTER, never on the value. A composition root passes all
   * seven, so nothing about the desktop's pane changes — the only caller that
   * loses a row is one that never had the feature.
   */
  onPageLayout?: ((layout: PageLayout) => void) | undefined
  onToggleRuler?: (() => void) | undefined
  onToggleScrollbar?: (() => void) | undefined
  onToggleProgressLine?: (() => void) | undefined
  onSide?: ((side: Side) => void) | undefined
  onStepIdx: (idx: number) => void
  spacing: SpacingIndices
  onSpacing: (key: SpacingKey, idx: number) => void
  align: Align
  onAlign: (align: Align) => void
  /** WI-14.4's fifteen — see `ReadingStyle`. */
  style: ReadingStyle
  onStyle: <K extends ReadingStyleKey>(key: K, value: ReadingStyle[K]) => void
  brightness?: number | undefined
  onBrightness?: ((idx: number) => void) | undefined
  contrast?: number | undefined
  onContrast?: ((idx: number) => void) | undefined
  onTypeface: (typeface: Typeface) => void
}

/**
 * What each of the three states is called in the row.
 *
 * A RECORD RATHER THAN A TERNARY, so the compiler fails the day a fourth state
 * is added and nobody comes back here — a cycle whose label falls through to
 * "Justified" for an unnamed state is a control that lies about where it is.
 *
 * "No hyphens" rather than "Unhyphenated": the row is 400px wide with a value
 * right-aligned in it, and the reader is choosing between three things they can
 * see on the page, not reading a typographic term.
 */
const ALIGN_LABELS: Record<Align, string> = {
  justified: 'Justified',
  'justified-no-hyphens': 'Justified, no hyphens',
  ragged: 'Ragged',
}

/**
 * What each of WI-14.4's fifteen states is called in its row.
 *
 * RECORDS RATHER THAN TERNARIES, for the reason `ALIGN_LABELS` gives: the
 * compiler fails the day a state is added and nobody comes back here, and a
 * row whose label falls through is a control that lies about where it is.
 *
 * NAMED FOR WHAT THE READER SEES, not for the CSS. "Ruled" rather than
 * "border-inline-start", "Scrolls" rather than "overflow-x: auto" — a reader
 * choosing how a quotation looks is looking at the page.
 */
const STYLE_LABELS = {
  separation: { space: 'Space', indent: 'Indent', both: 'Both' },
  flourish: { none: 'None', 'drop-cap': 'Drop cap', 'small-caps': 'Small caps' },
  headingScale: { publisher: "Publisher's", paper: "Paper's" },
  blockquote: { indent: 'Indented', rule: 'Ruled', tint: 'Ruled and tinted' },
  codeFace: { publisher: "Publisher's", paper: 'Monospace' },
  codeWrap: { scroll: 'Scroll', wrap: 'Wrap' },
  figureFrame: { none: 'None', hairline: 'Hairline', shadow: 'Shadow' },
  wideTables: { scroll: 'Scroll', shrink: 'Shrink to fit' },
  noteSize: { prose: "Paper's", publisher: "Publisher's" },
  fidelity: { paper: "Paper's", publisher: "Publisher's" },
} as const

/**
 * Labels for the rows that predate WI-14.4 and now share its components.
 *
 * SEVEN ROWS WERE HANDWRITTEN BESIDE THE TWO COMPONENTS. WI-14.4 introduced
 * `CycleRow` and `ToggleRow` for its own fifteen and left the older rows as
 * they were — which is the shape of duplication that drifts: one of them gains
 * an `aria` attribute or a disabled end and the others silently do not. They
 * take the shared components now, and what remains here is the only thing that
 * genuinely differed between them, which is what each state is CALLED.
 */
const FLOW_LABELS = { scrolled: 'Scrolled', paginated: 'Paged' } as const
const SIDE_LABELS = { left: 'Left', right: 'Right' } as const
const SHOWN_HIDDEN = { on: 'Shown', off: 'Hidden' } as const

/** The next state in a closed cycle, wrapping — the ALIGNS row's own idiom. */
function next<T extends string>(states: readonly T[], current: T): T {
  return states[(states.indexOf(current) + 1) % states.length] ?? (states[0] as T)
}

/**
 * A row that cycles a closed set of states, reporting which one it is on.
 *
 * ELEVEN OF WI-14.4'S FIFTEEN ARE THIS ROW, and the Alignment row above was the
 * first of them — written out longhand, as the only one of its kind. Copied
 * eleven times it would have drifted on the label, the wrap, or the aria within
 * a week. The three that are SCALES take `StepRow` instead, and the one that is
 * a boolean is the same row with two states.
 */
function CycleRow<T extends string>({
  label,
  states,
  value,
  labels,
  onChange,
}: {
  readonly label: string
  readonly states: readonly T[]
  readonly value: T
  readonly labels: Readonly<Record<T, string>>
  readonly onChange: (value: T) => void
}) {
  return (
    <button
      type="button"
      className={styles.settingRow}
      onClick={() => onChange(next(states, value))}
    >
      <span style={{ flex: 1 }}>{label}</span>
      <span className={styles.settingValue}>{labels[value]}</span>
    </button>
  )
}

/** The same row for a setting that is simply on or off. */
function ToggleRow({
  label,
  on,
  onChange,
  labels = { on: 'On', off: 'Off' },
}: {
  readonly label: string
  readonly on: boolean
  readonly onChange: (on: boolean) => void
  readonly labels?: { readonly on: string; readonly off: string }
}) {
  return (
    <button type="button" className={styles.settingRow} onClick={() => onChange(!on)}>
      <span style={{ flex: 1 }}>{label}</span>
      <span className={styles.settingValue}>{on ? labels.on : labels.off}</span>
    </button>
  )
}

export function Settings({
  theme,
  themeFollowsOs,
  /* DEFAULTS FOR THE SEVEN, so a host that passes neither setter nor value
     still renders. `pageLayout` needs one even when its own row is hidden: the
     ruler and scrollbar rows read it to decide whether they apply at all. */
  pageLayout = 'paginated',
  rulerOn = false,
  scrollbarOn = false,
  progressLineOn = true,
  side = 'right',
  stepIdx,
  typeface,
  offered,
  sections,
  missing,
  persistent = true,
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
  style,
  onStyle,
  brightness = 0,
  onBrightness,
  contrast = 0,
  onContrast,
  onTypeface,
  developer,
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
      {/* §11: say what happened and what it costs. Above the groups rather than
          inside one, because it is true of every control below it. */}
      {!persistent && (
        <div className={styles.panelMeta}>
          <span>
            These settings are not being saved — this device&apos;s storage is unavailable. They
            will apply until you close Paper.
          </span>
        </div>
      )}
      {/* TWO BANDS, NOT THIRTEEN HEADINGS. `PaneBand` carries the argument;
          the short version is that `Figures` and `Local models` are not the
          same kind of question and were siblings. Unruled here — the panel's
          own title is already the edge above it. */}
      <PaneBand title="Reading" ruled={false}>
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

      <ToggleRow label="Follow system appearance" on={themeFollowsOs} onChange={onFollowOs} />

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
      {onBrightness !== undefined && (
        <StepRow label="Brightness" scale={BRIGHTNESS} value={brightness} onChange={onBrightness} />
      )}
      {onContrast !== undefined && (
        <StepRow label="Contrast" scale={CONTRAST} value={contrast} onChange={onContrast} />
      )}
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
      {/* ONE DECISION, NOT TWO — but three states rather than two. It was
          `justify` and `hyphenate`, two booleans and four combinations, of
          which one is simply worse and shipping it by accident was the reason
          they were collapsed. `ALIGNS` keeps the collapse and lists the three
          worth having, so the reader cycles through decisions rather than
          assembling one from parts.

          THE ROW CYCLES, and it says which of the three it is on rather than
          naming an alignment and hiding the hyphenation inside it — "Justified"
          twice over, differing only in something invisible in the label, is a
          control that looks broken the first time you press it.

          Not "Left" and "Justified": the flush edge is on the left in English,
          the right in Arabic and the top in vertical Japanese, and the book
          says which. See `Align`. */}
      <CycleRow label="Alignment" states={ALIGNS} value={align} labels={ALIGN_LABELS} onChange={onAlign} />

      {/* A FLOOR UNDER THE SMALLEST TEXT — F5. The median book's smallest
          relative size is 0.70 of the base and the 5th percentile is 0.50, so
          at the smallest step that is 8.5px in one book in twenty. Off by
          default, because a floor IS an override of the author's proportions;
          in Text rather than under an "Accessibility" heading of its own,
          because it is a size and this is where a reader looks for one. */}
      <StepRow
        label="Minimum size"
        scale={MINIMUM_SIZES}
        value={style.minimumSize}
        onChange={(idx) => onStyle('minimumSize', idx)}
      />

      {/* THE MASTER CONTROL, and it belongs beside the face and the size
          because it decides the same question they do: whose typography this
          is. Paper injects its house sheet into the slot foliate appends AFTER
          the book's own, so it has always overridden a book's links, headings
          and quotations on source order alone — measured at 649 books of 1,957
          for `a { text-decoration }`. Nobody chose that and until now a reader
          could not decline it. Apple and Kindle both answer this the same way:
          the reader wins by default, and stepping back is a named control. */}
      <CycleRow
        label="Typography"
        states={FIDELITIES}
        value={style.fidelity}
        labels={STYLE_LABELS.fidelity}
        onChange={(value) => onStyle('fidelity', value)}
      />
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
      {/* HIDDEN WHERE IT CANNOT DO ANYTHING, which is the rule the ruler and
          scrollbar rows below already follow. Choosing `Indent` for paragraph
          separation zeroes the space between paragraphs — see `bookVars` — so
          this row would move the pips and nothing else. The reader's POSITION
          on the scale is kept while it is hidden, so it is still there when
          they choose Space again. */}
      {style.separation !== 'indent' && (
        <StepRow label="Paragraph" scale={SPACING.paragraph} value={spacing.paragraph}
          onChange={(idx) => onSpacing('paragraph', idx)} />
      )}

      {/* A SPACE BETWEEN CJK AND LATIN, which is a spacing and belongs here.
          `text-autospace`, never a script that inserts a character: every mark
          in this app is CFI-anchored with 32 characters of context either side,
          and inserting so much as a space invalidates them. 7 books of 1,957
          carry substantial CJK, which is why this is one row and not a group. */}
      <ToggleRow
        label="Space CJK and Latin"
        on={style.cjkSpacing}
        onChange={(on) => onStyle('cjkSpacing', on)}
      />
      </PaneGroup>

      {/* HOW ONE PARAGRAPH IS TOLD FROM THE ONE BEFORE IT, and how a section
          opens. Print answers the first with a blank line or a first-line
          indent; `Both` is offered because real books set an indent and a small
          space together and a reader may want to match one. */}
      <PaneGroup
        title="Paragraphs"
        open={groupOpen(GROUP.paragraphs)}
        onToggle={() => toggleGroup(GROUP.paragraphs)}
      >
      <CycleRow
        label="Separation"
        states={SEPARATIONS}
        value={style.separation}
        labels={STYLE_LABELS.separation}
        onChange={(value) => onStyle('separation', value)}
      />
      {/* Both states are pseudo-elements, which draw nothing into the document
          — see `markSmallText`'s neighbours for why that matters. */}
      <CycleRow
        label="Opening"
        states={FLOURISHES}
        value={style.flourish}
        labels={STYLE_LABELS.flourish}
        onChange={(value) => onStyle('flourish', value)}
      />
      {/* Publisher's by default, and deliberately: Paper sets a heading's
          weight, leading and space and has never touched its SIZE, so
          `h1 { font-size: 2.25em }` resolves against the reader's base and the
          author's proportions survive whole. Paper's imposes one scale, which
          is what makes a shelf of converted books read alike. */}
      <CycleRow
        label="Heading sizes"
        states={HEADING_SCALES}
        value={style.headingScale}
        labels={STYLE_LABELS.headingScale}
        onChange={(value) => onStyle('headingScale', value)}
      />
      </PaneGroup>

      {/* THE THINGS IN A BOOK THAT ARE NOT RUNNING PROSE: a quotation, a block
          of code, a wide table, a note in its popover. Grouped because a reader
          who cares how one of them looks usually cares about the rest. */}
      <PaneGroup
        title="Blocks"
        open={groupOpen(GROUP.blocks)}
        onToggle={() => toggleGroup(GROUP.blocks)}
      >
      <CycleRow
        label="Quotations"
        states={QUOTE_STYLES}
        value={style.blockquote}
        labels={STYLE_LABELS.blockquote}
        onChange={(value) => onStyle('blockquote', value)}
      />
      <CycleRow
        label="Code face"
        states={CODE_FACES}
        value={style.codeFace}
        labels={STYLE_LABELS.codeFace}
        onChange={(value) => onStyle('codeFace', value)}
      />
      {/* What a line too long for the measure does. Scroll is the default
          because it alters nothing — the lines stay where the author broke
          them — and what Paper does today is neither: an unstyled `pre` spills
          out of the column and is cut off. */}
      <CycleRow
        label="Long code lines"
        states={CODE_WRAPS}
        value={style.codeWrap}
        labels={STYLE_LABELS.codeWrap}
        onChange={(value) => onStyle('codeWrap', value)}
      />
      <CycleRow
        label="Wide tables"
        states={TABLE_FITS}
        value={style.wideTables}
        labels={STYLE_LABELS.wideTables}
        onChange={(value) => onStyle('wideTables', value)}
      />
      {/* A note at the foot of a page is subordinate to the prose it annotates
          and print says so by shrinking it. In a popover there is no prose
          beside it, the reason for the reduction is absent, and all it costs is
          legibility — so matching the prose is the default. */}
      <CycleRow
        label="Note size"
        states={NOTE_SIZES}
        value={style.noteSize}
        labels={STYLE_LABELS.noteSize}
        onChange={(value) => onStyle('noteSize', value)}
      />
      </PaneGroup>

      {/* A FIGURE IS NOT EVERY IMAGE — see `markFigures`. 45% of the images in
          a real library sit beside text, and treating those as figures turns a
          drop cap or a gaiji into a full-width plate mid-sentence. Everything
          here reaches only the images that stand alone in their block. */}
      <PaneGroup
        title="Figures"
        open={groupOpen(GROUP.figures)}
        onToggle={() => toggleGroup(GROUP.figures)}
      >
      <StepRow
        label="Width"
        scale={FIGURE_WIDTHS}
        value={style.figureWidth}
        onChange={(idx) => onStyle('figureWidth', idx)}
      />
      <StepRow
        label="Height"
        scale={FIGURE_HEIGHTS}
        value={style.figureHeight}
        onChange={(idx) => onStyle('figureHeight', idx)}
      />
      <CycleRow
        label="Frame"
        states={FIGURE_FRAMES}
        value={style.figureFrame}
        labels={STYLE_LABELS.figureFrame}
        onChange={(value) => onStyle('figureFrame', value)}
      />
      {/* A share of the MEASURE, or a share of the TYPE. They are different
          questions and a reader who enlarges the text for their eyes rather
          than for the layout is asking the second one. */}
      <ToggleRow
        label="Scale with text"
        on={style.figureScalesWithText}
        onChange={(on) => onStyle('figureScalesWithText', on)}
      />
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

      {onPageLayout !== undefined && (
        <CycleRow
          label="Flow"
          states={PAGE_LAYOUTS}
          value={pageLayout}
          labels={FLOW_LABELS}
          onChange={onPageLayout}
        />
      )}

      {/* §06: the ruler row appears only in scrolled flow — hidden, not
          disabled, because paged has no lines to advance. */}
      {pageLayout === 'scrolled' && onToggleRuler !== undefined && (
        <ToggleRow label="Reading ruler" on={rulerOn} onChange={onToggleRuler} />
      )}

      {/* Same rule as the ruler: shown only where it means something. A paged
          book has no scroll port, so the row would name a bar that does not
          exist in that flow whichever way it was set. */}
      {pageLayout === 'scrolled' && onToggleScrollbar !== undefined && (
        <ToggleRow
          label="Scrollbar"
          on={scrollbarOn}
          onChange={onToggleScrollbar}
          labels={SHOWN_HIDDEN}
        />
      )}

      {/* NOT flow-guarded, unlike the two above. Progress through the book is
          the same quantity whether the book is scrolled or paged — `fraction`
          arrives on relocate either way — so a row that vanished in paged flow
          would be hiding a working feature. */}
      {onToggleProgressLine !== undefined && (
        <ToggleRow
          label="Progress rule"
          on={progressLineOn}
          onChange={onToggleProgressLine}
          labels={SHOWN_HIDDEN}
        />
      )}

      {/* STILL NO HEADING OF ITS OWN, for the reason it never had one: a
          section is a promise of more than one thing in it, and "Side pane"
          over a single "Position" takes two lines to say what one says. What
          it lacked was a group to belong to, not a heading — it is in Page's
          now, and the row still carries its whole name. */}
      {onSide !== undefined && (
        <CycleRow label="Side pane position" states={SIDES} value={side} labels={SIDE_LABELS} onChange={onSide} />
      )}
      </PaneGroup>

      </PaneBand>

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
      <PaneBand title="The app">
      {sections.map((section) => (
        <PaneGroup
          key={section.id}
          title={section.title}
          open={groupOpen(section.id)}
          onToggle={() => toggleGroup(section.id)}
        >
          {/* The group mounts its body only while open — one gate, the group's — and a throw stops at the section. */}
          <ContributionBoundary label={section.title} resetKey={section.id}>
            <ContributionBody id={section.id} render={section.render} context={NO_BOOK} />
          </ContributionBoundary>
        </PaneGroup>
      ))}

      {/* INSIDE THE BAND, not after it. These name a capability that failed to
          start, so they belong with the capabilities' own sections — floating
          below the last band they read as a footnote to whatever happened to be
          printed above them, which is how the five unheaded rows that became
          the Page group went unnoticed. */}
      {(missing ?? []).map((one) => (
        <div key={one.id} className={styles.capabilityMissing}>
          <span>{one.id} is not running — its settings are unavailable until the app is restarted.</span>
        </div>
      ))}
      </PaneBand>

      {/* ⚠️ **THE BAND EXISTS ONLY WHILE DEVELOPER OPTIONS ARE ON**, and there
          is deliberately no control here that turns them on. ⌘⌃⌥D is the way
          in; a row offering it would put the chord — and the panels behind it —
          in front of every reader who ever opens Settings, which is exactly
          what a switch nobody can find is for.

          LAST, below The app, because it is a band about the app's own
          construction rather than about reading or about a capability. */}
      {developer && (
        <PaneBand title="Developer">
          <PaneGroup
            title="Unfinished panels"
            open={groupOpen(GROUP.developerPanels)}
            onToggle={() => toggleGroup(GROUP.developerPanels)}
          >
            <p className={styles.groupHint}>
              These panels are drawn but do not yet answer what they promise. They are hidden from
              every reader who has not turned developer options on.
            </p>
            {/* `ToggleRow` WITH THE SHELF'S OWN WORDS — `SHOWN_HIDDEN`, the
                labels the scrollbar row uses. The question here is the same
                one ("is this drawn?") and answering it with On/Off would give
                the reader two vocabularies for one idea. */}
            {UNFINISHED_PANE_IDS.map((id) => (
              <ToggleRow
                key={id}
                label={PANE_TITLES[id]}
                on={!developer.hidden.includes(id)}
                onChange={(on) => developer.onSetHidden(id, !on)}
                labels={SHOWN_HIDDEN}
              />
            ))}
          </PaneGroup>

          <PaneGroup
            title="Diagnostics"
            open={groupOpen(GROUP.developerDiagnostics)}
            onToggle={() => toggleGroup(GROUP.developerDiagnostics)}
          >
            {/* ⚠️ **RECORDING IS DECIDED BEFORE THIS PANEL EXISTS.** It is a
                FILE (`diagnostics.on`) rather than a setting, because the
                decision is made at boot before the services that hold settings
                are built — see `diagnosticsLog.ts`. So this reports rather than
                offers: a switch here would appear to work and change nothing
                until the next launch, which is worse than saying so. */}
            <p className={styles.groupHint}>
              {developer.recording
                ? 'Diagnostics are being recorded. The Developer panel shows the window.'
                : 'Diagnostics are not being recorded on this build. Create a file named ' +
                  'diagnostics.on in the data directory and relaunch to turn them on.'}
            </p>
          </PaneGroup>
        </PaneBand>
      )}
    </div>
  )
}
