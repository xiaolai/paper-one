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

/** Index into READING_STEPS for the 21/34/660 default. */
export const DEFAULT_STEP_IDX = 2

/** §03 reading measure and margin gutter. */
export const MEASURE = 660
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
    const take = Math.min(over, marginCol)
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
export function paneTakesTrack(windowWidth: number, stepIdx: number): boolean {
  const needed =
    measureForStep(stepIdx) + PANE_TRACK + STAGE_PADDING_X * 2 + GUTTER + PROSE_GAP * 2
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
 * A menu's narrowest. Wide enough that "Remove from library" — the longest
 * thing any menu in the app says — does not wrap, which is what actually
 * decides it.
 */
export const MENU_MIN_W = 190

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
    '--pane-title-row': px(PANE_TITLE_ROW),
    '--status-bar-h': px(STATUS_BAR_H),
    '--row-h': px(ROW_H),
    '--control-xs': px(CONTROL.xs),
    '--control-sm': px(CONTROL.sm),
    '--control-pill': px(CONTROL.md),
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
    '--menu-min-w': px(MENU_MIN_W),
    '--toc-indent': px(TOC_INDENT),
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
    // The shelf's card: its width for the grid's `repeat()`, its cover's
    // proportion for `aspect-ratio`, and its height — which, with a fixed
    // width, is a CONSTANT, not something to measure at runtime. All three from
    // one place, so the stylesheet cannot disagree with `cellHeightFor`.
    '--card-w': px(CARD_W),
    '--cover-aspect': `${COVER_ASPECT}`,
    '--cell-height': px(cellHeightFor(CARD_W)),
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
    '--motion-readout': MOTION.readout,
  }
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}
