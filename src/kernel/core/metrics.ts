/**
 * Paper — layout metrics.
 *
 * Single source of truth for every number in design system §03 (space, shape,
 * metrics), §08 (motion and icons) and §09 (reading typography). CSS reads
 * these through the custom properties installed by `applyMetrics`, and layout
 * logic imports them directly, so the two can never drift apart.
 *
 * Adding a magic number to a component instead of a name here is a bug: the
 * whole point of §03 is that these values are shared between the ruler, the
 * scroll snapping, the prose spacing and the chrome.
 */

export type Platform = 'macos' | 'windows' | 'linux'

/** §03 baseline grid. The reading line box, and the unit prose spacing, the
 *  ruler band and scroll snapping are all multiples of. */
export const LINE = 34

/** §03 side pane. Fixed width, left or right by user choice. */
export const PANE_W = 400

/**
 * The window's own corner radius, MEASURED — not chosen.
 *
 * From the alpha channel of a shadowless window capture, which is the only
 * reading that is not a guess: a colour threshold against a light backdrop gave
 * 19 and against a dark one 13, for a corner that is exactly 21.
 *
 *   36.0pt  Finder — native AppKit
 *   21.0pt  Paper — and every other Tauri window
 *
 * NOT SETTABLE from here, and that was checked rather than assumed. There is no
 * corner-radius API in `tauri` or in `tao` (which exposes only `set_has_shadow`),
 * the frame is drawn by the window server for a `Titled` window, the binary
 * already links the macOS 26.4 SDK so it is not an appearance opt-in, and tao
 * builds the same style-mask class Finder uses. Changing it would mean a
 * borderless transparent window drawing its own corners and shadow — giving up
 * the native shadow and resize behaviour — or an upstream change in tao.
 *
 * So it is a fact to design against, which is what the two constants below do.
 */
export const WINDOW_RADIUS = 21

/**
 * §03 concentric inset. Nested card radius = parent radius − inset.
 *
 * 8, matching Finder: its sidebar sits 8pt inside a 36pt window and carries 28,
 * which is exactly 36 − 8. The rule is Apple's own concentricity guidance and
 * Finder follows it precisely.
 */
export const CONCENTRIC_INSET = 8

/** What the pane costs in the row, including its concentric margins. */
export const PANE_TRACK = PANE_W + CONCENTRIC_INSET * 2

/* THERE IS NO `CARD_RADIUS`. It was 20, with `--card-radius-inner` derived from
 * it as 20 − 6 = 14, and both were injected as custom properties on every
 * render and referenced by NOTHING. Its comment claimed to be "the radius of
 * the window card and the pane card", which made it worse than merely dead: the
 * pane card is `LeadingCard` and takes `--leading-card-radius`, so anyone
 * reading the token to find out how a card is drawn was reading a token that
 * draws nothing and being told it drew that.
 *
 * The concentric RULE it encoded is real and is kept — see `CONCENTRIC_INSET`
 * and `LEADING_CARD_RADIUS`. What is gone is a second, unused expression of it
 * that could only ever disagree with the one in use. */

/**
 * Radius of a floating leading card (Contents, Companion, Collections).
 *
 * DERIVED, not chosen — the rule §05 states, applied to the real parent.
 *
 * It was 26, picked to match the ABSOLUTE radius of Finder's sidebar. That
 * reproduced native's number while inverting native's relationship: Finder's
 * sidebar is TIGHTER than the window holding it (28 inside 36), and a 26 inside
 * our 21 is rounder than the window it sits in. A card whose corners bulge past
 * its container cannot read as native, whatever value it borrowed.
 *
 * The earlier 14 was rejected as "reading square next to native surfaces", and
 * that diagnosis mistook the cause: it looked wrong because it was concentric
 * with a SIMULATED 20px window card rather than with the real 21pt frame — off
 * by the inset, not by the idea. Concentric with the real window is 13.
 *
 * Both Paper and Finder now follow one rule: parent minus inset.
 */
export const LEADING_CARD_RADIUS = WINDOW_RADIUS - CONCENTRIC_INSET

/** §03 titlebar: 52 on macOS, where it overlays and cards run full height. */
export const TITLEBAR_H: Record<Platform, number> = {
  macos: 52,
  windows: 44,
  linux: 44,
}

/**
 * §03 system zone — reserved for the window controls, per platform.
 *
 * MEASURED, not assumed, on macOS: the three buttons span 59.5pt and sit at the
 * inset `trafficLightPosition.x` puts them at, so the zone has to cover both.
 * At an inset of 18 that is 78.5pt of content — which the previous 78 did not
 * cover, and the overflow is invisible until a narrow window brings the centred
 * book chip far enough left to meet a traffic light.
 *
 * 82 keeps the same 3.5pt of clearance the 78 had at the old, tighter inset.
 * Changing `trafficLightPosition.x` without changing this is half a change.
 */
export const SYS_ZONE_W: Record<Platform, number> = {
  macos: 82,
  windows: 138,
  linux: 96,
}

/** §03 pane tab bar, matching the aside tabs. */
export const PANE_TAB_H = 44

/**
 * The row a pane's heading ("Notes", "Settings") sits in, and — because the
 * library's own "Library" heading is drawn as a row of the same height beside
 * it — the one number that keeps the two headings on one horizon. It was 12px
 * of padding plus a 13px line plus 6px, which measured 34 in the app; stated
 * as a row height the pane does not move by a pixel, and the two screens read
 * the same token instead of each arriving at roughly the same place by
 * different sums.
 */
export const PANE_TITLE_ROW = 34

/**
 * The shelf's status bar — the narrow strip along the foot of the library.
 *
 * A row of one 11px line with 6px either side. Narrow ON PURPOSE: it reports,
 * it is never operated, and anything tall enough to look like a toolbar invites
 * being clicked. It is a token because two things need the same number — the
 * bar draws it, and the scroll region above stops there — and because a bar
 * whose height is written twice is a bar that overlaps its own content the
 * first time one of them changes.
 */
export const STATUS_BAR_H = 24

/**
 * A row in the list view.
 *
 * 44px carries a 33px jacket with 5px of air either side — tall enough that a
 * cover is recognisable and a row is comfortably clickable, short enough that a
 * screen shows fifteen books rather than eight, which is the entire reason a
 * reader switches to a list.
 *
 * A CONSTANT, and it has to be: every row is the same height, which is what
 * lets the shelf's virtualiser drive this view unchanged — it measures the
 * first child and assumes the rest match. A row that grew for a long title
 * would put the window a row out further down the list every time.
 */
export const ROW_H = 44

/* THERE IS NO `PANE_COLLAPSE_W` ANY MORE. It was a flat 1024, and a flat number
 * cannot answer this question: whether the pane can afford a track of its own
 * depends on what the grid costs, and the grid costs `measure + …`, which §09
 * varies per reading step. Between 1024 and the width the grid actually needed,
 * the pane took a track the stage could not pay for and `proseGrid` silently
 * spent the whole gutter on it — 164px of window widths at the default type
 * size, 324px at the largest. See `paneTakesTrack`, and
 * `dev-docs/pane-collapse-threshold.md` for the measurement. */

/**
 * §09 reading steps. Sizes producing a fractional line box are not offered,
 * because the ruler and the scroll snapping both break on one.
 *
 * `measure` is the text column at that step.
 */
export interface ReadingStep {
  readonly size: number
  readonly line: number
  readonly measure: number
  readonly note: string
}

export const READING_STEPS: readonly ReadingStep[] = [
  { size: 17, line: 28, measure: 540, note: 'Minimum. Below this the measure falls under 60 characters.' },
  { size: 19, line: 30, measure: 600, note: '' },
  { size: 21, line: LINE, measure: 660, note: 'Default. 68 characters.' },
  { size: 23, line: 38, measure: 700, note: '' },
  { size: 26, line: 42, measure: 740, note: '' },
  { size: 28, line: 46, measure: 780, note: '' },
  { size: 30, line: 48, measure: 820, note: 'Maximum. Beyond this the page turns into a large-print edition.' },
] as const

/**
 * The four spacings a reader can open up, each as a closed set of steps.
 *
 * STEPS, NOT SLIDERS, for the same reason `READING_STEPS` is: a value between
 * two of these is not a decision anybody made, and a slider invites hunting for
 * one. Each of these also has a floor and a ceiling that are typographic facts
 * rather than preferences, and a stepper is where those live.
 *
 * The defaults are all the current behaviour, so a reader who never opens this
 * gets exactly the book they have now.
 *
 * WHY THESE FOUR. Letter and word spacing are the two that help a reader who
 * finds dense type hard to track — the evidence for both is about legibility,
 * not taste. Line and paragraph spacing are how much air the page has, which is
 * the oldest reading preference there is. Nothing here changes the MEASURE:
 * that is set by the size step, and letting two controls move it would make the
 * line length depend on which one the reader touched last.
 */
export interface SpacingScale {
  readonly steps: readonly number[]
  readonly def: number
  /** How the value is written into the book's CSS. */
  readonly unit: 'em' | 'x'
}

export const SPACING: Record<'letter' | 'word' | 'line' | 'paragraph', SpacingScale> = {
  /* Tracking, in em so it follows the size. Negative is offered because a face
   * set loose by its designer can be tightened, but only one step of it: past
   * that the letters touch. */
  letter: { steps: [-0.01, 0, 0.01, 0.02, 0.04], def: 1, unit: 'em' },
  /* Word spacing opens the gaps between words without touching the letters,
   * which is the pair a reader who loses their place usually wants. */
  /* Five steps with one that TIGHTENS, so this scale is shaped like `letter`
     above: a step below the default, then the default, then three that open up.
     It had four and started at its own floor, which made it the one row whose
     minus was dead before the reader touched anything. */
  word: { steps: [-0.02, 0, 0.04, 0.08, 0.16], def: 1, unit: 'em' },
  /* A MULTIPLE of the step's own line box, not a length: every reading step
   * carries a line height chosen for its size, and a fixed leading would be
   * loose at 17px and tight at 30. */
  line: { steps: [0.85, 1, 1.15, 1.3, 1.5], def: 1, unit: 'x' },
  /* Also a multiple of the line box, which is what keeps consecutive paragraphs
   * on the grid — see `bookCss`. */
  /* Re-based so one line — what the book has always had between paragraphs —
     is the second step rather than the third, without that value changing. A
     zero step was offered once, on the reasoning that an indenting book wants
     no space as well; it went, because nothing here indents a paragraph, so no
     space between them runs the prose together rather than setting it tightly. */
  paragraph: { steps: [0.5, 1, 1.5, 2, 2.5], def: 1, unit: 'x' },
}

/**
 * How much of the theme's own light to keep, and how hard the text sits on it.
 *
 * BOUNDED AT 0.75, and the bound is measured rather than chosen. Dimming a
 * light theme darkens the page, and past about half the page reaches mid grey —
 * where the most any text can manage is 5.3:1 against it, leaving the contrast
 * control no room and the page reading as grey rather than as dimmed paper. At
 * 0.75 the page is #bfbfbf with about 11:1 available, which is headroom.
 *
 * Contrast is ONE-SIDED — softest up to the theme, never past it (see
 * `CONTRAST` below) — and deliberately narrow. It moves the text only — see
 * `adjustPalette` — and everything it produces is clamped to 4.5:1, so the
 * soft end is a preference rather than a way to make the page unreadable.
 */
export const BRIGHTNESS: SpacingScale = {
  steps: [0.75, 0.8125, 0.875, 0.9375, 1],
  def: 4,
  unit: 'x',
}

/**
 * THE THEME IS THE CEILING. Contrast runs from softest up to the theme exactly
 * as designed, and stops there — it used to run past it, pushing the ink toward
 * pure black on a light theme and pure white on a dark one, which is a reader
 * overriding a decision that was measured. Softening is a preference; hardening
 * past the design is a second opinion about a contrast ratio that was already
 * checked.
 *
 * That also puts its default at the top of its scale, where `BRIGHTNESS`
 * already was: both controls now start at "the theme untouched" and only take
 * away, which is one idea rather than two.
 */
export const CONTRAST: SpacingScale = {
  steps: [-0.35, -0.2625, -0.175, -0.0875, 0],
  def: 4,
  unit: 'x',
}

/** A value from either scale, clamped for the reason `spacingAt` gives. */
export function stepAt(scale: SpacingScale, idx: number): number {
  const at = Math.min(scale.steps.length - 1, Math.max(0, Math.round(idx)))
  return scale.steps[at] ?? scale.steps[scale.def] ?? 0
}

/** A spacing value from an index, clamped — an index from anywhere may be stale. */
export function spacingAt(key: keyof typeof SPACING, idx: number): number {
  return stepAt(SPACING[key], idx)
}

/** Index into READING_STEPS for the 21/34/660 default. */
export const DEFAULT_STEP_IDX = 2

/** §03 reading measure — DERIVED from the default reading step, not restated.
 *  Written out as `660` it was a second copy of `READING_STEPS[2].measure`,
 *  and `readingStep`'s own comment records what two copies of that number
 *  nearly cost: the book laid out to one size inside a column sized for
 *  another, silently. */
export const MEASURE = READING_STEPS[DEFAULT_STEP_IDX]!.measure
/** §03 margin gutter. */
export const GUTTER = 56

/**
 * The narrowest the gutter is ever allowed to get.
 *
 * A FLOOR, not a preference. `proseGrid` sheds the gutter before the measure —
 * correctly, since the measure is the one number §03 defines in characters —
 * but it used to shed it all the way to zero, and a gutter of zero puts the
 * text flush against the edge of whatever is holding it. That is not a smaller
 * margin; it is the absence of one, and it reads as the reader being broken.
 *
 * Below this the MEASURE yields instead. Narrower text is a legible page; text
 * touching its container is not.
 */
export const GUTTER_MIN = 24

/**
 * The step at an index, or the default when there is no such step.
 *
 * One fallback, in one place, because there were three call sites doing this
 * lookup by hand and two of them named DIFFERENT fallbacks — `MEASURE` in
 * `measureForStep`, `READING_STEPS[2]` in `bookCss`. Those agree only because
 * the default step's measure happens to be 660: moving either number would
 * have laid the book out to one size inside a column sized for another, and
 * nothing would have reported it.
 *
 * The reducer already clamps what it stores, so an out-of-range index should
 * not reach here at all. It stays defensive anyway — `stepIdx` also arrives
 * from props, and an index that names no step must resolve to the default
 * rather than to `undefined` several frames later.
 */
export function readingStep(stepIdx: number): ReadingStep {
  const step = READING_STEPS[stepIdx] ?? READING_STEPS[DEFAULT_STEP_IDX]
  if (!step) throw new Error('READING_STEPS is empty')
  return step
}

/**
 * The measure for a reading step.
 *
 * §09 gives each of the seven sizes its own line width, from 540 at 17px to
 * 820 at 30px, so that the line stays near 68 characters as the type grows.
 * Both the host grid and foliate's renderer must read the SAME value or the
 * book is laid out to one width inside a column sized to another.
 */
export function measureForStep(stepIdx: number): number {
  return readingStep(stepIdx).measure
}

/** Third prose column — the margin where companion marks land. */
export const MARGIN_COL = 250
export const PROSE_GAP = 32

/** Horizontal padding on the prose grid. */
export const STAGE_PADDING_X = 24

export interface ProseGrid {
  readonly gutter: number
  readonly measure: number
  readonly marginCol: number
  readonly gap: number
}

/**
 * The prose grid's three tracks for a given stage width.
 *
 * Computed rather than left to `minmax(0, …)`, because CSS grid gives no way
 * to say WHICH track yields first. Left to itself it shrinks the measure —
 * the one number §03 defines in characters ("roughly 68 at the reading step")
 * — while preserving the margin column, which only holds companion marks. The
 * text silently stops being the designed measure and nothing reports it.
 *
 * Shrink order, most expendable first:
 *   1. the margin column, which is decoration for marks
 *   2. the gutter, which holds the ruler hint
 *   3. the measure, only when there is nothing else left to give
 */
export function proseGrid(
  stageInner: number,
  showMargin: boolean,
  measureMax: number = MEASURE,
): ProseGrid {
  const gap = PROSE_GAP
  let gutter = GUTTER
  let measure = measureMax

  /* The margin column reserves 250px for companion marks. Until there are
   * marks to put there it collapses — but to the GUTTER's width, not to zero.
   *
   * Zero would only move the imbalance: the grid is centred as a whole, so a
   * 56px gutter and its gap surviving on the left alone push the measure 44px
   * right of the window's centre, exactly as 250px on the right pushed it 97px
   * left. Mirroring the gutter puts the measure on the centre line and leaves
   * the ruler hint its lane. */
  let marginCol = showMargin ? MARGIN_COL : GUTTER

  // Two gaps are always in play: gutter|measure and measure|margin.
  let over = gutter + measure + marginCol + gap * 2 - stageInner

  if (over > 0) {
    /* The mark lane may be spent WHOLE — `paneTakesTrack` counts one gutter
     * and declares the margin spendable, and the pane threshold is built on
     * that. But the MIRROR is not a mark lane: it floors at `GUTTER_MIN`,
     * exactly as the gutter it mirrors does, because it drained to zero here
     * and the text sat flush against the stage's right edge — the same broken
     * window `GUTTER_MIN` was introduced to prevent on the left. The measure
     * still sits a little off centre while the two sides walk down to their
     * shared floor; what it can no longer do is lose its right margin
     * entirely. */
    const floor = showMargin ? 0 : GUTTER_MIN
    const take = Math.min(over, Math.max(0, marginCol - floor))
    marginCol -= take
    over -= take
  }
  /* DOWN TO THE FLOOR, and no further — see `GUTTER_MIN`. This took the gutter
   * to zero, which is what let an open pane leave the text flush against the
   * edge of the stage. The measure yields after this instead: narrower text is
   * still a page, whereas text with no margin reads as a broken window. */
  if (over > 0) {
    const take = Math.min(over, Math.max(0, gutter - GUTTER_MIN))
    gutter -= take
    over -= take
  }
  if (over > 0) {
    measure = Math.max(0, measure - over)
  }

  return { gutter, measure, marginCol, gap }
}

/**
 * Whether the side pane can take a track of its own at this window width.
 *
 * THE PREDICATE, not a threshold constant, and shared by the two places that
 * must agree — `WindowShell`, which draws the pane as a track or as a sheet,
 * and `Reader`, which reserves `PANE_TRACK` out of the stage before it has a
 * box to measure. `Reader`'s own comment already warned that these two
 * answering differently is how the measure and the pane come to disagree; a
 * function they both call is what makes that impossible rather than merely
 * discouraged.
 *
 * The width has to fit the pane, the stage's padding, the measure, both gaps
 * and ONE WHOLE GUTTER. The margin column is deliberately not counted: it is
 * decoration for companion marks and `proseGrid` is entitled to spend it. The
 * gutter is not — it holds the ruler hint, and at zero the text touches the
 * stage.
 *
 * Written from the tokens rather than as a number, so it follows them. The
 * constant this replaces was 1024 for every reading step, which is below every
 * width this returns.
 */
/**
 * Where the MEASURE track sits, relative to the stage's own box.
 *
 * For anything that has to stay over the words rather than merely inside the
 * reading area — the selection tools, which were bounded by the stage and so
 * were free to hang across the whole margin column, over the very notes that
 * live there.
 *
 * The stage centres the grid (`justify-content: center`), so the measure's
 * offset is the stage's padding, plus half the slack, plus the tracks before
 * it. `stageInner` is the CONTENT width — what `useElementWidth` reports and
 * what `proseGrid` is given — while the offset is returned against the stage's
 * BORDER box, because that is the origin `rangeRectsInHost` translates into and
 * the origin an absolutely positioned child resolves against. The stage has no
 * border, so the two coincide; the padding is what has to be added back.
 *
 * Pure, and checked against the running app: at a 1009px stage with tracks
 * 56/660/56 and a 32px gap it returns 174.5, and the measure was measured in
 * the window at 175.
 */
export function proseColumn(stageInner: number, grid: ProseGrid): { left: number; width: number } {
  const tracks = grid.gutter + grid.measure + grid.marginCol + 2 * grid.gap
  /* Never negative: below the width where the tracks fit, grid stops centring
     and overflows the end, so the column starts at the padding. */
  const slack = Math.max(0, stageInner - tracks) / 2
  return { left: STAGE_PADDING_X + slack + grid.gutter + grid.gap, width: grid.measure }
}

export function paneTakesTrack(windowWidth: number, stepIdx: number): boolean {
  /* `+ GUTTER_MIN`: the mirror's floor. The margin column is spendable down
   * to that floor and no further — drained whole, the text sat flush against
   * the stage's right edge, which is the broken window `GUTTER_MIN` exists to
   * prevent. A threshold that did not budget the floor granted the pane its
   * track 24px early, and the grid paid for it out of the one gutter this
   * predicate promises to keep whole. */
  const needed =
    measureForStep(stepIdx) +
    PANE_TRACK +
    STAGE_PADDING_X * 2 +
    GUTTER +
    GUTTER_MIN +
    PROSE_GAP * 2
  return windowWidth >= needed
}

/**
 * Padding that keeps the measure centred when the outer tracks are unequal.
 *
 * foliate centres the book inside its own container, and that container spans
 * the whole prose grid. While the gutter and the margin match, the container's
 * centre IS the measure's centre and nothing is needed. Once marks widen the
 * margin, the container's centre drifts toward the wider side — so the padding
 * goes on that same wider side, shrinking the content box from that edge and
 * pulling its centre back onto the measure.
 *
 * Padding the narrow side instead moves the centre the way the imbalance
 * already did, doubling the error rather than correcting it.
 */
export function proseBleed(grid: ProseGrid): { start: number; end: number } {
  return {
    start: Math.max(0, grid.gutter - grid.marginCol),
    end: Math.max(0, grid.marginCol - grid.gutter),
  }
}

/**
 * The white a PAGE carries, outside its own text — both sides together.
 *
 * §03 puts the reading margins in the HOST grid, as the gutter and margin
 * tracks, because the ruler hint and the companion marks live in them. That is
 * right for everything that stands still, and wrong for the one thing that
 * moves: foliate's page was then the bare measure, so a turn slid a column of
 * text against a column of text with nothing in between and the two abutted
 * mid-word for the whole 300ms. A page turn is only legible if the thing that
 * turns has edges.
 *
 * So the page gets margins of its own, taken out of the lane it is already
 * sitting inside: half of this on each side. It is the widest a page can be
 * before foliate's own shadow grid overflows, so it reaches that ceiling rather
 * than picking a number — `pageTurn.test.ts` derives the ceiling from
 * `paginator.js` and holds this against it at every stage width.
 *
 * ONE NUMBER, TWO READINGS. Halved, it is the white either side of the text at
 * rest; whole, it is the white between one page and the next while the turn is
 * running, since each page contributes one of its sides.
 *
 * THE NARROWER LANE, not the gutter. The book element spans the whole prose
 * grid and `proseBleed` trims it back to symmetry about the measure, so what it
 * is actually given is `measure + 2 × min(gutter, marginCol) + 2 × gap` — and
 * those two are NOT interchangeable. `proseGrid` spends the mark lane first and
 * down to zero, so a narrow window with marks leaves a 56px gutter beside a
 * margin column of nothing; taking the gutter there would ask for a page some
 * 60px wider than the element holding it. foliate would not report that. Its
 * centre track is `minmax(0, …)`, so it absorbs the overflow silently and the
 * column comes out narrower than the grid reserved — the same edge-to-edge
 * failure `applyLayout` already records, arriving through the one lane nobody
 * measures.
 *
 * FLOORED HERE, and that is load-bearing rather than tidiness. The renderer is
 * given `measure + this`, and foliate needs `measure + 2 × this` to fit inside
 * the element's width. Flooring the SUM keeps that true for every fractional
 * grid; flooring the page and the measure separately does not, and the pixel it
 * costs the column is one `Math.trunc` then makes permanent.
 */
export function pageMargins(grid: ProseGrid): number {
  return Math.floor(Math.min(grid.gutter, grid.marginCol) + grid.gap)
}

/**
 * §03 control and row heights — the RAMP, not a list.
 *
 * A control's height was written wherever a control was drawn, and the app
 * accumulated twelve of them: 24, 26, 27, 28, 30, 32, 34, 36, 38, 44, 46, 52.
 * Twelve heights inside a 28px span is not a design decision repeated, it is
 * twelve separate decisions nobody can now reconstruct — a chip 27 high beside
 * a chip 28 high, a scope row 36 beside a chapter row 38.
 *
 * Four steps, each with a job:
 */
export const CONTROL = {
  /** An icon and nothing else: a `⋯`, a delete, a close. */
  xs: 24,
  /** A chip, a stepper, an inline field — a control inside a row. */
  sm: 28,
  /** THE DEFAULT. A button, a search field, a rail tab. */
  md: 34,
  /** A control that contains controls: a composer, a shelf row. */
  lg: 44,
} as const

/**
 * `CONTROL.md` under its older name, kept because the pill's SHAPE depends on
 * it: `--control-pill` is read as a width as well as a height to make a circle,
 * and renaming it would only move the coupling somewhere less obvious.
 */
export const CONTROL_PILL = CONTROL.md

/**
 * Rows in a list, as opposed to controls in a row.
 *
 * `compact` is deliberately tighter than `book`: a scope list is SCANNED and a
 * settings list is read one row at a time. That difference is the only reason
 * two row heights exist, and it is why 38 (a chapter row) folds into 36 rather
 * than becoming a third.
 */
export const ROW = {
  /** A scope, a chapter, a search result — a row that is scanned. */
  compact: 36,
  /** A setting, a theme, a book in the reader's bar — a row that is read. */
  book: 46,
} as const

/** `ROW.book` under its older name — see `CONTROL_PILL`. */
export const ROW_BOOK = ROW.book

/**
 * A control in the TITLE BAR, which is not on the control ramp and cannot be.
 *
 * The bar is `TITLEBAR_H` tall — 52 on macOS, 44 elsewhere — and on macOS its
 * contents have to clear the traffic lights, whose position is set from
 * `tauri.conf.json` and measured, not guessed (see `docs/traffic-lights.md`).
 * 30 is what fits: `CONTROL.md` at 34 leaves 9px of margin in a 52px bar and
 * crowds the lights; `CONTROL.sm` at 28 reads as small beside them. It is a
 * token rather than a ramp step because the constraint is the window's, not the
 * design's, and folding it into the ramp would let a change to the ramp move
 * something the operating system decides.
 */
export const CONTROL_TITLEBAR = 30

/**
 * The command palette's own field, which is the largest control in the app.
 *
 * A palette is one field the reader types into with nothing else on screen, so
 * it is deliberately a step above `CONTROL.lg` — the ramp describes controls
 * that sit among other controls, and this one does not.
 */
export const CONTROL_FIELD = 52

/**
 * The widths a paragraph of interface prose is allowed to reach.
 *
 * Not `MEASURE`, which is the BOOK's line length and a reading decision. These
 * are empty states and error messages — a sentence or two that must not run the
 * width of a window. Two values because they sit in boxes of different sizes,
 * and they were 380, 420 and 420 chosen separately.
 */
export const PROSE_MAX = { narrow: 380, wide: 420 } as const

/**
 * The list view's own columns.
 *
 * `thumb` is a jacket small enough to be an anchor for the eye rather than the
 * subject of the row; its height falls out of `COVER_ASPECT`, so the one
 * proportion the shelf draws covers at is the one the list draws them at.
 *
 * The two data columns are sized to their WIDEST CONTENT rather than to taste:
 * progress has to hold a bar and "100%", and the date has to hold the longest
 * thing `relativeTime` produces — "Yesterday", or a full "12 Mar 2024".
 */
export const LIST_COL = { thumb: 22, progress: 104, when: 82, percent: 30 } as const

/**
 * The command palette's sheet: how wide it may get, and how much window it must
 * leave either side of itself when it cannot.
 *
 * `inset` is what stops a sheet touching the window edge on a small screen —
 * the palette is a floating surface and a floating surface with no margin reads
 * as a panel that failed to fit.
 */
export const SHEET = { max: 640, inset: 48, top: 96, maxHeight: 560 } as const

/**
 * The footnote popover's bounds.
 *
 * NARROWER THAN THE SHEET, on purpose. The palette is a surface the reader is
 * working IN; a note is something they glance at and dismiss, and it sits over
 * the text it came from. A note as wide as the palette would cover the page it
 * is annotating, which defeats showing it in place at all.
 *
 * `maxHeight` is where it starts scrolling rather than growing. An endnote can
 * be a paragraph or it can be half a page of citations, and the second must not
 * push the popover off the window.
 */
export const FOOTNOTE = { maxWidth: 420, maxHeight: 320 } as const

/**
 * A menu's narrowest. Wide enough that "Remove from library" — the longest
 * thing any menu in the app says — does not wrap, which is what actually
 * decides it.
 */
export const MENU_MIN_W = 190

/**
 * The tallest a SCROLLING region inside a menu may be.
 *
 * The shelf's narrow menu lists every tag, and a shelf can carry hundreds — a
 * menu that grows with them runs off the bottom of the window. `usePlacement`
 * would then flip it, which only moves the same problem to the top.
 *
 * Roughly nine rows at `--row-compact`, which is enough that the list reads as
 * a list rather than a peephole, and short enough to leave the statuses and the
 * filter field above it on screen at the window heights this app is used at.
 */
export const MENU_SCROLL_H = 320

/* A `PANE_MENU_W = 220` lived here — a menu sized for the face picker inside
 * the pane — published as `--pane-menu-w` and consumed by nothing: the picker
 * sizes itself. A constant with no consumer is a claim the code does not
 * make; whoever builds the pane menu next should reintroduce the number WITH
 * its first consumer. */

/**
 * The tag editor: the popover a card, a row or a selection opens to edit its
 * tags. Wider than a menu (`MENU_MIN_W`) because it holds chips that wrap and
 * a field with a suggestion list under it, each suggestion carrying a name
 * and a count; narrower than the pane (`PANE_W`), so over a card it still
 * reads as a popover about that card rather than as a panel that happened to
 * land near it.
 */
export const TAG_EDITOR_W = 300

/**
 * How far a nested chapter steps in per level of the table of contents.
 *
 * The indent was written out per level — 26 and 42 — which is a base plus one
 * step and a base plus two, with both sums done by hand and neither stated. A
 * third level would have needed a third number guessed to match.
 */
export const TOC_INDENT = 16

/**
 * An Appearance swatch: a tile that previews a theme by being drawn in it.
 *
 * Not on the control ramp, for the same reason a book's cover is not: it is a
 * picture of something, sized to what it has to show. What it has to show is a
 * 15px specimen, 6px of air and a 10px name — 31px — so this leaves about 10
 * either side. Enough that the two lines sit IN the tile rather than fill it,
 * and no more: five of these are a row of choices, not five panels.
 */
/**
 * The colour disc inside a tint button in §10's selection bar.
 *
 * ITS BUTTON IS `CONTROL.sm`, off the ordinary scale — the bar is a row of
 * small icon controls and there is no reason for it to invent a size. Only the
 * disc needs a number of its own, exactly as the theme swatch below does: it is
 * a mark of a size, not a control.
 *
 * ONE UNDER THE ICON RAMP'S 15. A solid disc carries more ink than an outlined
 * glyph of the same diameter, so it wants to be the smaller of the two — but
 * only just. Taken down to ten to match the glyphs by WEIGHT, it stopped
 * reading as a colour worth choosing and started reading as a status dot: the
 * three tints are the reason this face exists, and a face's subject should not
 * be its faintest element. Fourteen is a colour first and a control second,
 * which is the right order here.
 */
export const MARK_SWATCH = 14

export const THEME_SWATCH_H = 52

/**
 * THE WINDOW WIDTHS THE LAYOUT CHANGES AT.
 *
 * Two, and only two, because each one is a decision about what to give up and
 * there are only two things this app can give up.
 *
 * `compact` — the shelf's list drops its author column, and the screen's gutter
 * narrows. Below this the row cannot hold five columns without the title, which
 * is the one nobody scans past, being squeezed to nothing.
 *
 * `min` — the window's own minimum, from `tauri.conf.json`. Nothing is allowed
 * to break above it, which is what makes it a number worth stating: it is the
 * width every layout in this app is TESTED at, not a width anything reacts to.
 *
 * A CSS `@media` query cannot read a custom property — the cascade resolves
 * variables long after the media query has already matched — so these numbers
 * are necessarily written out in the stylesheets as well. `tokens.test.ts`
 * asserts that every breakpoint in every stylesheet is one of these, which is
 * the only way the two copies can be kept honest.
 */
export const BREAKPOINT = { compact: 860, min: 720 } as const

/**
 * A progress track: the thin rule under a book's title, and the reader's own.
 *
 * 3px because 1px is a hairline — a boundary, which a reader reads as the edge
 * of something — and this is a QUANTITY, which has to read as a bar however
 * little of it is filled.
 */
export const TRACK_W = 3

/**
 * macOS's own traffic lights: 12px each, which is Apple's, not ours.
 *
 * Here so that nothing else in the app can be 12px "to match the lights"
 * without saying so — and so the one place that draws them names where the
 * number comes from. See `docs/traffic-lights.md`.
 */
export const TRAFFIC_LIGHT = 12

/**
 * The scrollbar, where the app draws its own.
 *
 * A platform value in spirit: wide enough to grab with a pointer, which is what
 * decides it. The thumb is inset from this by a transparent border so the track
 * reads narrower than the target actually is.
 */
export const SCROLLBAR_W = 15

/**
 * §03 a shelf card's width, and the box its cover is drawn in.
 *
 * FIXED, not fluid. The grid was `minmax(150px, 1fr)`, so a card was never one
 * size: it stretched to fill the row and snapped back whenever another column
 * fit, and the cover — sized from the card — grew and shrank with the window.
 * A shelf of books that change size as the window does reads as a layout
 * responding to itself, not as a shelf. Fixed at 126, cards are the same
 * object at every width and only their COUNT per row changes, which is what a
 * shelf does.
 *
 * The cover BOX is a 2:3 well of that width; the artwork inside it is not
 * forced to 2:3 — see `.cover img` — because jackets are not all one shape,
 * and stretching or cropping them to a proportion they do not have is what
 * made every cover look like every other. The box holds the row's rhythm; the
 * artwork sits at its natural shape on the box's floor.
 */
export const CARD_W = 126

/** §03 the proportion the cover BOX is drawn at, width over height. */
export const COVER_ASPECT = 2 / 3

/**
 * What a shelf cell spends BELOW its cover: the cover's own bottom margin and
 * the meta row — the progress rule beside the row's menu button.
 *
 * MEASURED off the rendered cell rather than added up from the stylesheet,
 * because it is font metrics as much as CSS, and it has moved with the row's
 * contents: 60 with a title, an author and a bare 3px rule; 75 once the rule
 * shared a 24px row with the menu button; 36 now that the title and author
 * are gone — a shelf is scanned by its jackets, and the words under each one
 * restated the artwork at a size nobody could read. The meta row is drawn on
 * every book — an unread one gets a spacer where the rule would be — so read
 * and unread cells measure the same and there is no tallest case to pick.
 */
export const TAG_LINE = 16
export const CELL_FURNITURE = 36 + TAG_LINE + 4

/* The `+ 20` is the tag row: one 16px line of chips and the 4px above it. It
 * is drawn only on a tagged book, so an untagged card carries 20px of air at
 * its foot — the price of every row being one height, which virtualisation
 * needs. Cheaper than the alternative, which was a tagged card silently
 * clipping its chips. `.noCopy` costs nothing here: it is laid over the
 * jacket, out of flow. */

/**
 * How tall a shelf cell must be to hold a cover of this column's width.
 *
 * The cell is a FIXED height and has to be — virtualisation derives one row
 * height from one cell, so a row that grows with a progress bar or a second
 * line of tags makes that arithmetic a lie a few hundred books down. What was
 * wrong was the number, not the fixing of it: `--cell-height` was referenced
 * with a `268px` fallback and never set by anything, so the fallback did all
 * the work and could not follow a fluid column. At a 173px column the cover
 * alone wants 259, and 268 left 9px for two lines of text and a rule — so
 * `overflow: hidden` quietly ate the title, and the author landed on the row
 * below.
 */
export function cellHeightFor(columnWidth: number): number {
  return Math.round(columnWidth / COVER_ASPECT) + CELL_FURNITURE
}

/** §03 radii, by role. */
export const RADIUS = {
  mark: 3,
  chip: 6,
  control: 10,
  card: 14,
  pill: 999,
} as const

/** §12 layer order. Anything not on this list does not get a z-index. */
export const Z = {
  rulerBand: 0,
  prose: 1,
  chrome: 4,
  stickyBar: 7,
  rulerHint: 8,
  popover: 20,
  /* The pane when it is a sheet, and the scrim under it. Below `scrim`, which
   * belongs to the palette and the switcher: those take the whole window and
   * must cover a sheet, not appear behind one. */
  paneSheetScrim: 22,
  paneSheet: 23,
  menu: 24,
  scrim: 30,
  figure: 40,
} as const

/**
 * §08 motion.
 *
 * `pageTurn` read `0ms` for as long as nothing turned foliate's `animated`
 * attribute on — it described the absence of an implementation rather than a
 * decision. The renderer eases over 300ms, and that duration is foliate's own
 * and not settable from here, so this records it rather than declaring it.
 * There is no instant option: one behaviour, and the system's reduced-motion
 * preference is the only thing that suppresses it.
 */
export const MOTION = {
  chromeFade: '180ms ease',
  rulerTrack: '90ms ease',
  paneOpen: '220ms ease-out',
  popover: '120ms ease-out',
  /**
   * A CONTINUOUS VALUE being reported, not a transition between two states.
   *
   * Linear, and that is the whole point of it having its own name: everything
   * else in this table eases, because it is a thing arriving or leaving. A
   * progress bar is neither — it is a quantity, and easing one makes a 1% move
   * look like a glitch rather than like progress. Tokenizing the stylesheet
   * folded this into `popover` on the strength of the two sharing a duration,
   * which is exactly the mistake a name prevents.
   */
  readout: '120ms linear',
  pageTurn: '300ms',
} as const

/** §08 icon ramp. One stroke weight everywhere, never filled, never two-tone. */
export const ICON = {
  inline: 12,
  /** The drawn window controls on Windows and Linux — smaller than a control,
   *  because they sit in a 44px system row rather than in the app's chrome. */
  window: 13,
  control: 15,
  tab: 17,
  prominent: 19,
  /**
   * A control STANDING ALONE, with nothing beside it to be sized against.
   *
   * The rest of the ramp is for icons inside chrome — in a row, in a bar, in a
   * button with a fill behind it — where the neighbours give the eye its scale
   * and 19 is already emphatic. The page-turn chevrons have none of that: they
   * sit in open white margin, revealed on the pointer, with the nearest thing
   * to them 44px of nothing. At `prominent` they read as a hint that something
   * might be there rather than as a control, which is the one thing a control
   * revealed by hovering cannot afford.
   *
   * 2em, at the app's 16px root — twice the interface's own type, which is the
   * proportion this was specified in. Written as a number rather than as `2em`
   * in the stylesheet for two reasons: `tokens.test.ts` refuses a raw value
   * where a token belongs, and a `<button>` does not inherit font-size, so an
   * `em` there would have resolved against the UA's own 11px and come out at 22
   * — SMALLER than the 19 it was meant to enlarge.
   */
  standalone: 32,
  stroke: 1.75,
} as const

/** Ruler band offset from the top of the scroller when pinned. */
export const RULER_PIN = 216

/**
 * Install the metrics that CSS needs as custom properties on the document root.
 * Called once at boot, and again whenever the platform is resolved, so that
 * stylesheets can use `var(--titlebar-h)` without re-deriving anything.
 */
export function applyMetrics(root: HTMLElement, platform: Platform): void {
  const px = (n: number) => `${n}px`
  /* ONLY TOKENS SOMETHING READS. A published property with no `var()` behind
   * it is a promise nobody collects — nine of them had accumulated here, and a
   * dead token is worse than none because renaming or removing its constant
   * looks safe in every automated check while a real consumer would have said
   * otherwise. Anything added here should arrive together with its first
   * consumer. */
  const vars: Record<string, string> = {
    '--pane-track': px(PANE_TRACK),
    '--leading-card-radius': px(LEADING_CARD_RADIUS),
    '--concentric-inset': px(CONCENTRIC_INSET),
    '--titlebar-h': px(TITLEBAR_H[platform]),
    '--sys-zone-w': px(SYS_ZONE_W[platform]),
    '--pane-tab-h': px(PANE_TAB_H),
    '--pane-title-row': px(PANE_TITLE_ROW),
    '--status-bar-h': px(STATUS_BAR_H),
    '--row-h': px(ROW_H),
    '--control-xs': px(CONTROL.xs),
    '--control-sm': px(CONTROL.sm),
    /* Through the ALIAS, which exists exactly for this token — the pill's
     * circle reads the token as width and height both, and publishing from
     * `CONTROL.md` directly left the alias with no consumer at all: a name
     * that claimed to guard a coupling it was not part of. */
    '--control-pill': px(CONTROL_PILL),
    '--control-lg': px(CONTROL.lg),
    '--row-compact': px(ROW.compact),
    '--control-titlebar': px(CONTROL_TITLEBAR),
    '--control-field': px(CONTROL_FIELD),
    '--prose-narrow': px(PROSE_MAX.narrow),
    '--prose-wide': px(PROSE_MAX.wide),
    '--row-thumb': px(LIST_COL.thumb),
    '--col-progress': px(LIST_COL.progress),
    '--col-when': px(LIST_COL.when),
    '--col-percent': px(LIST_COL.percent),
    '--tag-line': px(TAG_LINE),
    '--sheet-max': px(SHEET.max),
    '--sheet-inset': px(SHEET.inset),
    '--sheet-top': px(SHEET.top),
    '--sheet-max-h': px(SHEET.maxHeight),
    '--footnote-max-w': px(FOOTNOTE.maxWidth),
    '--footnote-max-h': px(FOOTNOTE.maxHeight),
    '--menu-min-w': px(MENU_MIN_W),
    '--menu-scroll-h': px(MENU_SCROLL_H),
    '--tag-editor-w': px(TAG_EDITOR_W),
    '--toc-indent': px(TOC_INDENT),
    '--mark-swatch': px(MARK_SWATCH),
    '--theme-swatch-h': px(THEME_SWATCH_H),
    '--track-w': px(TRACK_W),
    '--traffic-light': px(TRAFFIC_LIGHT),
    '--scrollbar-w': px(SCROLLBAR_W),
    '--row-book': px(ROW_BOOK),
    '--radius-pill': `${RADIUS.pill}px`,
    '--radius-card': `${RADIUS.card}px`,
    '--radius-control': `${RADIUS.control}px`,
    // Published because a stylesheet was already using `--radius-chip` with a
    // hardcoded fallback, and the fallback was doing all the work: the token
    // did not exist, so the value here could have changed without anything on
    // screen following it.
    '--radius-chip': `${RADIUS.chip}px`,
    '--radius-mark': `${RADIUS.mark}px`,
    // The one rung of the §08 ramp a stylesheet needs: the app mark in the book
    // chip is drawn by CSS (a mask over `currentColor`) rather than by a lucide
    // component, so it cannot take `size={ICON.control}` the way every other
    // control in that bar does. Published so it sits at the same size as its
    // neighbours BY DERIVATION rather than by a 15 written down twice. Only
    // this rung, because publishing the other four would put four tokens that
    // nothing reads next to the one that does.
    '--icon-control': px(ICON.control),
    // The page-turn chevrons, which are drawn by CSS in a lane the stylesheet
    // sizes — so unlike the other rungs this one has to cross into CSS.
    '--icon-standalone': px(ICON.standalone),
    // The shelf's card: its width for the grid's `repeat()`, its cover's
    // proportion for `aspect-ratio`, and its height — which, with a fixed
    // width, is a CONSTANT, not something to measure at runtime. All three from
    // one place, so the stylesheet cannot disagree with `cellHeightFor`.
    '--card-w': px(CARD_W),
    '--cover-aspect': `${COVER_ASPECT}`,
    '--cell-height': px(cellHeightFor(CARD_W)),
    // §12 layer order, published so stylesheets stop restating the numbers.
    '--z-chrome': String(Z.chrome),
    '--z-sticky': String(Z.stickyBar),
    '--z-ruler-hint': String(Z.rulerHint),
    '--z-popover': String(Z.popover),
    '--z-pane-sheet-scrim': String(Z.paneSheetScrim),
    '--z-pane-sheet': String(Z.paneSheet),
    '--z-menu': String(Z.menu),
    '--z-scrim': String(Z.scrim),
    '--motion-chrome': MOTION.chromeFade,
    '--motion-pane': MOTION.paneOpen,
    '--motion-popover': MOTION.popover,
    '--motion-readout': MOTION.readout,
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
