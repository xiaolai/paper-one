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
 * §06: below this width the pane stops taking a track of its own.
 *
 * Enforced in `WindowShell`, not merely declared. Left unconsumed it was a
 * false invariant — the pane stayed open on narrow windows and squeezed the
 * measure down to whatever was left.
 *
 * What it does BELOW the threshold changed, because collapsing was the wrong
 * answer: the pane simply did not appear, and the tab buttons and ⌘\ went on
 * looking exactly as available as they do at any other width. A control that
 * silently does nothing is indistinguishable from a broken one. The design's
 * own answer for a narrow window is that "the pane becomes a sheet" — it
 * overlays the reader instead of displacing it, which costs the measure
 * nothing and is why the threshold exists in the first place.
 */
export const PANE_COLLAPSE_W = 1024

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

/** Index into READING_STEPS for the 21/34/660 default. */
export const DEFAULT_STEP_IDX = 2

/** §03 reading measure and margin gutter. */
export const MEASURE = 660
export const GUTTER = 56

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
    const take = Math.min(over, marginCol)
    marginCol -= take
    over -= take
  }
  if (over > 0) {
    const take = Math.min(over, gutter)
    gutter -= take
    over -= take
  }
  if (over > 0) {
    measure = Math.max(0, measure - over)
  }

  return { gutter, measure, marginCol, gap }
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

/** §03 control and row heights. Published as CSS custom properties below so
 *  stylesheets consume these values rather than repeating them. */
export const CONTROL_PILL = 34
export const ROW_BOOK = 46

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
  const vars: Record<string, string> = {
    '--line-box': px(LINE),
    '--pane-w': px(PANE_W),
    '--pane-track': px(PANE_TRACK),
    '--leading-card-radius': px(LEADING_CARD_RADIUS),
    '--concentric-inset': px(CONCENTRIC_INSET),
    '--titlebar-h': px(TITLEBAR_H[platform]),
    '--sys-zone-w': px(SYS_ZONE_W[platform]),
    '--pane-tab-h': px(PANE_TAB_H),
    '--control-pill': px(CONTROL_PILL),
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
    // §12 layer order, published so stylesheets stop restating the numbers.
    '--z-ruler-band': String(Z.rulerBand),
    '--z-prose': String(Z.prose),
    '--z-chrome': String(Z.chrome),
    '--z-sticky': String(Z.stickyBar),
    '--z-ruler-hint': String(Z.rulerHint),
    '--z-popover': String(Z.popover),
    '--z-pane-sheet-scrim': String(Z.paneSheetScrim),
    '--z-pane-sheet': String(Z.paneSheet),
    '--z-menu': String(Z.menu),
    '--z-scrim': String(Z.scrim),
    '--z-figure': String(Z.figure),
    '--measure': px(MEASURE),
    '--gutter': px(GUTTER),
    '--motion-chrome': MOTION.chromeFade,
    '--motion-ruler': MOTION.rulerTrack,
    '--motion-pane': MOTION.paneOpen,
    '--motion-popover': MOTION.popover,
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
