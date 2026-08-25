import type { Align, ReadingStyle, Theme, Typeface } from './uiTypes'
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

/**
 * The platforms the interface draws for.
 *
 * `web` is the BROWSER CLIENT (phase 18) — the shelf's own client, served to a
 * phone. It is a platform here for one reason: `applyMetrics` publishes the
 * design system's geometry, and without it the client would have to mirror
 * those constants in a stylesheet of its own. It did, briefly, and that is the
 * duplicate this member exists to delete — a client IMITATING the design system
 * rather than using it.
 *
 * It has no window, so its titlebar and system zone are zero. Anything else
 * keyed by platform should ask whether a browser has one before answering.
 */
export type Platform = 'macos' | 'windows' | 'linux' | 'web'

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
  /* A browser tab has no titlebar to overlay, and the client draws none. Zero
   * rather than 44: a reserved band with nothing in it would push the reading
   * surface down the screen for a decoration that does not exist. */
  web: 0,
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
  /* No window controls to reserve for — the browser draws its own chrome
   * outside the page entirely. */
  web: 0,
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

/**
 * 15px TO 28px, EVERY PIXEL. It was seven steps at 17, 19, 21, 23, 26, 28, 30
 * — an uneven ramp, and coarse enough that the two sizes either side of a
 * reader's preference were 2px away in each direction.
 *
 * EVERY EXISTING STEP KEPT ITS OWN LINE BOX AND ITS OWN MEASURE. 17/28/540,
 * 19/30/600, 21/34/660, 23/38/700, 26/42/740 and 28/46/780 are the values they
 * have always had, so a reader already on one of them sees nothing move. The
 * new steps are interpolated between them; only 30px is gone, which is the one
 * the range now stops short of.
 *
 * THE LINE IS ROUGHLY 1.6 OF THE SIZE, which is the band the old table already
 * occupied — every ratio here falls between 1.579 and 1.652, the same floor and
 * ceiling the seven had. Two of the interpolated line boxes are ODD (29 at 18px,
 * 39 at 24px) and that is fine: the rule above forbids a FRACTIONAL line box,
 * because the ruler and the scroll snapping break on one, and 29 is not
 * fractional. Rounding those to even would have collided with a neighbour —
 * there are only twelve even numbers between 24 and 46 for fourteen sizes.
 *
 * THE MEASURE FALLS IN CHARACTERS AS THE TYPE GROWS, from about 69 at 15px to
 * about 60 at 28px, which is what the old table did and what makes large print
 * large print rather than merely wide. Monotonic, and `metrics.test.ts` holds
 * it — a step whose measure gave MORE characters than the one below it would be
 * a larger size on a longer line, which is the opposite of the intent.
 */
export const READING_STEPS: readonly ReadingStep[] = [
  { size: 15, line: 24, measure: 480, note: 'Minimum. 69 characters.' },
  { size: 16, line: 26, measure: 510, note: '' },
  { size: 17, line: 28, measure: 540, note: '' },
  { size: 18, line: 29, measure: 570, note: '' },
  { size: 19, line: 30, measure: 600, note: '' },
  { size: 20, line: 32, measure: 630, note: '' },
  { size: 21, line: LINE, measure: 660, note: 'Default. 68 characters.' },
  { size: 22, line: 36, measure: 680, note: '' },
  { size: 23, line: 38, measure: 700, note: '' },
  { size: 24, line: 39, measure: 713, note: '' },
  { size: 25, line: 40, measure: 727, note: '' },
  { size: 26, line: 42, measure: 740, note: '' },
  { size: 27, line: 44, measure: 760, note: '' },
  { size: 28, line: 46, measure: 780, note: 'Maximum. 60 characters; beyond this the page is a large-print edition.' },
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
  /**
   * How the value is written into the book's CSS.
   *
   * `x` is a bare multiplier and has no unit at all — it is spelled here so
   * `StepRow` can report "1.15×" rather than "1.15", which reads as a length.
   * The rest are CSS units and are appended verbatim.
   */
  readonly unit: 'em' | 'x' | '%' | 'vh' | 'px'
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
export const DEFAULT_STEP_IDX = 6

/**
 * The seven sizes the ramp offered before it ran 15 to 28 by ones.
 *
 * KEPT ONLY SO A STORED INDEX CAN BE READ ONCE — see `readTextSize`. A settings
 * file written before the change holds an index into THIS list, and without it
 * the number means whatever the current ramp happens to have at that position.
 * Nothing else may read it; it is a fact about a file format, not about type.
 */
/**
 * The step nearest a size in px, clamped to the ramp.
 *
 * THE SETTING IS STORED AS A SIZE, NOT AS AN INDEX, and this is the function
 * that makes that possible — see `KERNEL_SETTINGS.textSize`. An index means
 * nothing across a change to the ramp: when this table went from seven steps to
 * fourteen, a stored `2` meant 21px on the old scale and 17px on the new one,
 * so every reader's type would have shrunk on the launch after the change with
 * nothing to say why. A stored `21` means 21px on any ramp that offers it.
 *
 * NEAREST rather than exact, because a ramp may stop offering a size — 30px was
 * on the old one and is not on this — and the reader's intent is better served
 * by the closest thing this build can show than by dropping them to the default.
 * That is the argument the `index` validator already makes for clamping.
 */
export const LEGACY_READING_SIZES: readonly number[] = [17, 19, 21, 23, 26, 28, 30]

export function stepIndexForSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_STEP_IDX
  let best = 0
  for (let i = 1; i < READING_STEPS.length; i++) {
    if (Math.abs(READING_STEPS[i]!.size - px) < Math.abs(READING_STEPS[best]!.size - px)) best = i
  }
  return best
}

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
 * `tauri.conf.json` and measured, not guessed (see `dev-docs/traffic-lights.md`).
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
 * The pairing QR, drawn at the size a phone camera actually needs.
 *
 * 160, against the 192 the markup used to hard-code and the 240 floor the
 * `qrcode` crate renders at. A QR is read from about a hand's distance and a
 * modern camera resolves this version's modules well below 160; the old size
 * was chosen to look like the thing it was — a picture — rather than to be
 * scanned, and it dominated a settings pane that is otherwise rows of text.
 *
 * It is also the WRONG CONTROL for most pairings, which is why it is no
 * longer the first thing the section offers: two Macs cannot photograph each
 * other's screens, and the invite they need is a string. The QR is for a
 * phone, and it is sized as the secondary affordance it is.
 */
export const QR_SIZE = 160

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
 * number comes from. See `dev-docs/traffic-lights.md`.
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
    '--qr-size': px(QR_SIZE),
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

/**
 * THE THREE SCALES WI-14.4 ADDS, and the one constant beside them.
 *
 * `SpacingScale` is the shape every other reader control here uses — a list of
 * steps and an index into it — and these take it so `StepRow` can draw them
 * without a second kind of row. Values, not indices, reach the stylesheet;
 * `stepAt` clamps, because an index can arrive from state a newer build wrote.
 *
 * EVERY DEFAULT IS WHERE PAPER ALREADY WAS. The point is repeated here rather
 * than assumed: a reader who never opens these must get the book they had, and
 * a scale whose default is a new number is a silent change to the whole library
 * dressed as a new feature.
 */

/**
 * How wide a figure may be, as a share of the measure.
 *
 * 95 IS IN THE LIST BECAUSE IT IS WHERE PAPER ALREADY WAS. The plan named
 * 70/80/90/100, which has no step at the value the sheet has been shipping, so
 * adding the control would have moved every figure in the library by five
 * points on the day it landed. The four named steps are all here; 95 is a fifth
 * between two of them and it is the default.
 */
export const FIGURE_WIDTHS: SpacingScale = { steps: [70, 80, 90, 95, 100], def: 3, unit: '%' }

/**
 * How tall a figure may be, as a share of the page.
 *
 * A page-tall figure breaks pagination outright, which is why there is a cap at
 * all and why Readium carries the same safeguard at the same value. The lower
 * steps are for a reader who would rather see a figure and the text around it
 * than a figure alone.
 */
export const FIGURE_HEIGHTS: SpacingScale = { steps: [50, 70, 85, 95], def: 3, unit: 'vh' }

/**
 * A floor under the smallest text in the book — F5.
 *
 * THE MEASUREMENT BEHIND IT. The median book's smallest relative size is 0.70
 * of the base and the 5th percentile is 0.50, so at step 0 (17px) that is
 * 11.9px in the typical book and **8.5px in one book in twenty**. A reader who
 * chose the smallest step did not choose 8.5px; the book did, against a base
 * that has since moved under it.
 *
 * ZERO IS OFF, AND IT IS THE DEFAULT. A floor is a genuine override of the
 * author's proportions — it flattens a run of small caps into the size of the
 * prose around it — so it is offered rather than imposed. The steps are the
 * three sizes below which a paragraph stops being readable at arm's length,
 * not a scale anybody should read a curve into.
 */
export const MINIMUM_SIZES: SpacingScale = { steps: [0, 11, 12, 14], def: 0, unit: 'px' }

/**
 * The first-line indent, when the reader asks for one.
 *
 * In `em`, so it follows the type rather than the window, and NOT a scale: a
 * paragraph indent is a typographic constant of about one to two ems in every
 * printed book anybody has read, and offering five steps of it would be a
 * control over something no reader wants to tune. `SEPARATIONS` is the control;
 * this is the value it uses.
 */
export const PARAGRAPH_INDENT = 1.5

/**
 * THE HOUSE RATIOS — what is set smaller than the running prose, and by how
 * much.
 *
 * NAMED RATHER THAN WRITTEN INTO THE SHEET, because `code` needs its ratio
 * TWICE and the two uses must agree. Inside an element with
 * `font-size: 0.9em`, `1em` is 0.9 of the context for every other property —
 * so padding written as `0.05em` there is 0.045 of the context, and expressing
 * a context-relative value means dividing by the same 0.9. Two literals that
 * have to stay reciprocal is a drift waiting to happen; one constant and an
 * interpolation cannot drift.
 *
 * `block` AND `code` ARE EQUAL AND ARE NOT THE SAME DECISION. A quotation set
 * at nine tenths is a typographic convention about blocks that are not running
 * text; inline code at nine tenths is about a monospace face looking larger
 * than a serif at the same size. They agree today; nothing says they must.
 */
export const READING_RATIOS = {
  /** `blockquote`, `table`, `ul`, `ol`, `pre` — a block that is not prose. */
  block: 0.9,
  /** `code`, `kbd`, `samp` — a share of the line they sit in, not of the prose. */
  code: 0.9,
  /** The noteref marker, and the note's own text in the popover. */
  footnote: 0.8,
} as const

/**
 * How tall a font paints an inline box, as a multiple of its font size.
 *
 * MEASURED, NOT DERIVED, because CSS cannot expose it. A background on an
 * inline element paints the CONTENT AREA, whose height is the font's ascent
 * plus descent — a property of the face, not of the stylesheet. Read off the
 * running app with Literata at 21px: a plain span measures 31px, so 1.476.
 *
 * AND THE TARGET IS QUANTISED, which is why no single number can be exactly
 * right. Swept across all fourteen reading sizes in the running app, the plain
 * span's painted height comes back as a WHOLE number of pixels every time — 23,
 * 24, 25, 27, 28, 30, 31, 33 — while the code panel beside it is fractional. So
 * the thing being matched moves in 1px steps and the ratio it implies wanders
 * between 1.44 and 1.53 depending on where the rounding falls. There is no
 * value of this constant that lands on 100% at every step.
 *
 * IT IS AN ASSUMPTION IN A SECOND WAY TOO. A reader who sets the code face to
 * the bundled mono is comparing two faces with different metrics, and the
 * parity below is approximate again. The alternative was leaving the panel
 * visibly short at every size, so this is the better of two imperfect numbers
 * rather than a correct one.
 */
export const CONTENT_AREA = 1.476

/**
 * The padding that puts an inline panel back on the context's own line box.
 *
 * WHY IT IS NOT SIMPLY HALF THE SHORTFALL. The panel behind inline code paints
 * the content area, which scales with the font size — so code at nine tenths
 * paints a box nine tenths as tall as the text around it, and a background
 * visibly shorter than its line reads as a mistake rather than as emphasis.
 *
 * Half the shortfall is `(1 - 0.9) / 2` of the context's em, and that is the
 * right answer in FONT-SIZE terms and the wrong one in painted terms: what is
 * short is the content area, which is `CONTENT_AREA` times the font size. So
 * the compensation carries the same factor.
 *
 * MEASURED ACROSS THE WHOLE RAMP rather than at one size, because one size is
 * how the first version of this came to claim parity it did not have. With the
 * factor carried, the panel measures 96.5% to 102.0% of the surrounding text
 * across the fourteen reading steps, averaging 99.3%, and lands on 100.3% at
 * the default. Without it — a flat half-tenth — it was 94.5% at that same
 * default and short at every step rather than straddling.
 *
 * The per-size ideal wanders between 0.066 and 0.112 and averages 0.088; this
 * comes to 0.082. The gap between the two is a tenth of a pixel and the spread
 * around either is pixel snapping, not a better answer waiting to be found.
 */
export const CODE_PANEL_PAD = ((1 - READING_RATIOS.code) / 2) * CONTENT_AREA

/**
 * What Paper rendered before WI-14.4, spelled as the settings that describe it.
 *
 * THE PROPERTY THIS TABLE EXISTS TO HOLD: a reader who never opens any of these
 * gets the book they had. Every value here was read off the sheet as it stood,
 * not chosen — blockquote: indent because the sheet indented and did nothing
 * else, headingScale: publisher because Paper has never set a heading's size,
 * figureWidth at the step that IS 95%.
 *
 * TWO ARE NOT QUITE THAT, and they are the two the sheet said nothing about at
 * all. codeWrap and wideTables default to containing an overflow that today
 * spills out of the column — which is a defect rather than a design, and both
 * rules sit in the before tier, so a book that styles pre or table still
 * wins outright.
 */
export const DEFAULT_READING_STYLE: ReadingStyle = {
  separation: 'space',
  flourish: 'none',
  headingScale: 'publisher',
  blockquote: 'indent',
  codeFace: 'publisher',
  codeWrap: 'scroll',
  figureWidth: FIGURE_WIDTHS.def,
  figureFrame: 'none',
  figureScalesWithText: false,
  figureHeight: FIGURE_HEIGHTS.def,
  wideTables: 'scroll',
  noteSize: 'prose',
  cjkSpacing: false,
  minimumSize: MINIMUM_SIZES.def,
  fidelity: 'paper',
}

/**
 * How a book is set before any reader has said otherwise.
 *
 * These three were literals inside `initialState`, which was fine while the
 * desktop was the only thing that opened a book. The browser client cannot
 * reach `state.ts` — that is the app's whole reducer, and the web build reaches
 * a short named list of kernel modules — so it would have had to write `'paper'`
 * and `'literata'` and `'justified'` down a second time.
 *
 * Two sets of defaults that agree today is the shape every drift in this tree
 * has taken. They live here instead, beside `SPACING` and `BRIGHTNESS` and the
 * rest of the design system's numbers, and both builds read the same ones.
 */
export const DEFAULT_THEME: Theme = 'paper'
export const DEFAULT_TYPEFACE: Typeface = 'literata'
export const DEFAULT_ALIGN: Align = 'justified'

/** Every spacing at its own default — the book exactly as it was designed. */
export const DEFAULT_SPACING = {
  letter: SPACING.letter.def,
  word: SPACING.word.def,
  line: SPACING.line.def,
  paragraph: SPACING.paragraph.def,
} as const
