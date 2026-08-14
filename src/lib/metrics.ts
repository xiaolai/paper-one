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

/** §03 concentric inset. Nested card radius = parent radius − inset. */
export const CONCENTRIC_INSET = 6

/** What the pane costs in the row, including its concentric margins. */
export const PANE_TRACK = PANE_W + CONCENTRIC_INSET * 2

/** Radius of the window card and the pane card. */
export const CARD_RADIUS = 20

/**
 * Radius of a floating leading card (Contents, Companion, Collections).
 *
 * Measured on macOS 26.6.1 rather than taken from the prototype. Capturing
 * windows with `screencapture -o` (no shadow) and reading the alpha corner
 * gives, in points:
 *
 *   36  Finder, Books, Dictionary, ChatGPT — native AppKit
 *   27  Chrome, Ghostty
 *   21  Paper and VMark — both Tauri
 *   15  older Electron apps
 *
 * Finder's floating sidebar sits 8pt inside its 36pt window and carries a
 * radius of roughly 28 — i.e. concentric, parent minus inset, which is what
 * §05 and Apple's own concentricity guidance both describe.
 *
 * The prototype's 14 came from that same rule applied to its SIMULATED 20px
 * window card. Against a real window the parent radius is the OS's, so 14 is
 * far tighter than any native surface and reads as square next to them. 26
 * matches the native sidebar's proportions.
 *
 * Worth knowing: our window is 21pt where every native app is 36pt. That gap
 * is set by the window's own configuration, not by anything here, and it is
 * the reason a strictly concentric card would still look tight.
 */
export const LEADING_CARD_RADIUS = 26

/** §03 titlebar: 52 on macOS, where it overlays and cards run full height. */
export const TITLEBAR_H: Record<Platform, number> = {
  macos: 52,
  windows: 44,
  linux: 44,
}

/** §03 system zone — reserved for the window controls, per platform. */
export const SYS_ZONE_W: Record<Platform, number> = {
  macos: 78,
  windows: 138,
  linux: 96,
}

/** §03 pane tab bar, matching the aside tabs. */
export const PANE_TAB_H = 44

/** §06: the pane collapses below this width. */
export const PANE_COLLAPSE_W = 1024

/** PDF thumbnails need this much available width before they are shown. */
export const THUMBS_MIN_AVAIL = 900

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
export function proseGrid(stageInner: number): ProseGrid {
  const gap = PROSE_GAP
  let marginCol = MARGIN_COL
  let gutter = GUTTER
  let measure = MEASURE

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

/** §03 control and row heights. */
export const CONTROL_ICON = 30
export const CONTROL_PILL = 34
export const ROW_COMPACT = 38
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
  menu: 24,
  scrim: 30,
  figure: 40,
} as const

/** §08 motion. Page turn is instant by default; the slide is opt-in. */
export const MOTION = {
  chromeFade: '180ms ease',
  rulerTrack: '90ms ease',
  paneOpen: '220ms ease-out',
  popover: '120ms ease-out',
  pageTurn: '0ms',
} as const

/** §08 icon ramp. One stroke weight everywhere, never filled, never two-tone. */
export const ICON = {
  inline: 12,
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
    '--card-radius': px(CARD_RADIUS),
    '--card-radius-inner': px(CARD_RADIUS - CONCENTRIC_INSET),
    '--leading-card-radius': px(LEADING_CARD_RADIUS),
    '--concentric-inset': px(CONCENTRIC_INSET),
    '--titlebar-h': px(TITLEBAR_H[platform]),
    '--sys-zone-w': px(SYS_ZONE_W[platform]),
    '--pane-tab-h': px(PANE_TAB_H),
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
