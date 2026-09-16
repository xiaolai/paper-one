import { describe, expect, it } from 'vitest'
import {
  BRIGHTNESS,
  CARD_W,
  CELL_FURNITURE,
  CONCENTRIC_INSET,
  CONTRAST,
  CONTROL_TITLEBAR,
  COVER_ASPECT,
  DEFAULT_READING_STYLE,
  DEFAULT_STEP_IDX,
  FIGURE_HEIGHTS,
  FIGURE_WIDTHS,
  GUTTER,
  LEADING_CARD_RADIUS,
  LINE,
  MINIMUM_SIZES,
  PANE_W,
  SPACING,
  TAG_LINE,
  cellHeightFor,
  stepAt,
  GUTTER_MIN,
  MARGIN_COL,
  MEASURE,
  MOTION,
  PANE_TRACK,
  PROSE_GAP,
  RADIUS,
  READING_STEPS,
  STAGE_PADDING_X,
  SYS_ZONE_W,
  TITLEBAR_H,
  TRAFFIC_LIGHT,
  WINDOW_RADIUS,
  Z,
  applyMetrics,
  type Platform,
  measureForStep,
  paneTakesTrack,
  proseBleed,
  proseColumn,
  proseGrid,
  readingStep,
  stepIndexForSize,
} from './metrics'

/** Where the measure track's centre falls inside the whole prose grid. */
function measureCentre(grid: ReturnType<typeof proseGrid>): number {
  return grid.gutter + grid.gap + grid.measure / 2
}

/** Where foliate will centre the book: the middle of its padded content box. */
function containerCentre(grid: ReturnType<typeof proseGrid>): number {
  const total = grid.gutter + grid.gap + grid.measure + grid.gap + grid.marginCol
  const bleed = proseBleed(grid)
  return bleed.start + (total - bleed.start - bleed.end) / 2
}

/**
 * THE SCALES A READER STEPS THROUGH, and the two numbers each one publishes
 * that nothing else derives: the value at its default step — what a reader who
 * never opens the pane gets — and the UNIT its readout is written in, which
 * `StepRow` puts straight in front of them (`1.15×`, `80%`, `12px`).
 */
describe('the stepped scales', () => {
  it.each([
    ['letter spacing', SPACING.letter, 'em', 0],
    ['word spacing', SPACING.word, 'em', 0],
    ['line spacing', SPACING.line, 'x', 1],
    ['paragraph spacing', SPACING.paragraph, 'x', 1],
    ['brightness', BRIGHTNESS, 'x', 1],
    ['contrast', CONTRAST, 'x', 0],
    ['figure width', FIGURE_WIDTHS, '%', 95],
    ['figure height', FIGURE_HEIGHTS, 'vh', 95],
    ['minimum size', MINIMUM_SIZES, 'px', 0],
  ])('%s runs in order, in its own unit, and starts where the app has always been', (_name, scale, unit, standing) => {
    expect(scale.unit).toBe(unit)
    expect(scale.steps.length).toBeGreaterThan(1)
    expect(scale.steps[scale.def]).toBe(standing)
    expect(stepAt(scale, scale.def)).toBe(standing)
    // Ordered, low to high: a step is a direction, and the pane draws them in this order.
    expect([...scale.steps].sort((a, b) => a - b)).toEqual([...scale.steps])
  })
})

/* WHAT A READER WHO NEVER OPENS THE PANE READS. Every field here is the book as
   it has always been drawn, so a changed default is a changed page for every
   reader at once — and none of these is derived from anything else. */
describe('the shipped reading style', () => {
  it('is the one the app has always drawn', () => {
    expect(DEFAULT_READING_STYLE).toEqual({
      separation: 'space',
      flourish: 'none',
      headingScale: 'publisher',
      blockquote: 'indent',
      codeFace: 'publisher',
      codeWrap: 'scroll',
      figureWidth: 3,
      figureFrame: 'none',
      figureScalesWithText: false,
      figureHeight: 3,
      wideTables: 'scroll',
      noteSize: 'prose',
      cjkSpacing: false,
      minimumSize: 0,
      fidelity: 'paper',
    })
  })
})

/* Three derived lengths whose derivation IS the design rule: the pane's track
   is the pane with a concentric margin on each side, a leading card's corner is
   the window's own corner drawn in by one inset, and a shelf cell's furniture
   is the text block, the tag line and the gap above it. */
describe('the derived lengths', () => {
  it('gives the pane a concentric margin on each side of its track', () => {
    expect((PANE_TRACK - PANE_W) / 2).toBe(CONCENTRIC_INSET)
  })

  it('draws a leading card inside the window by exactly the concentric inset', () => {
    /* PARENT MINUS INSET — §05's rule against the real frame, which is the
       relation rather than the 13 it comes to. The DIRECTION is the whole of
       it: Finder's sidebar is tighter than the window holding it (28 inside
       36), and a card whose corners bulge past its container cannot read as
       native whatever value it borrowed — which is what the earlier 26 inside
       our 21 did. */
    expect(WINDOW_RADIUS - LEADING_CARD_RADIUS).toBe(CONCENTRIC_INSET)
    expect(LEADING_CARD_RADIUS).toBeLessThan(WINDOW_RADIUS)
  })

  it('leaves a shelf cell room for its text, its tag line and the gap above it', () => {
    expect(CELL_FURNITURE - TAG_LINE).toBe(40)
    expect(CELL_FURNITURE).toBe(56)
  })
})

/* WHAT A STYLESHEET CAN READ. `tokens.test.ts` holds that every `var()` names a
   published token; this holds that publishing puts a value there — the one
   the constant says, in the unit CSS needs — on the root it was handed. A
   plain recorder stands in for the root: the only thing asked of it is
   `style.setProperty`. */
describe('applyMetrics', () => {
  const published = (platform: Platform): Map<string, string> => {
    const set = new Map<string, string>()
    const root = { style: { setProperty: (name: string, value: string) => void set.set(name, value) } }
    applyMetrics(root as unknown as HTMLElement, platform)
    return set
  }

  it('publishes every token as a custom property with a value', () => {
    const set = published('macos')
    expect(set.size).toBeGreaterThan(0)
    for (const [name, value] of set) {
      expect(name, name).toMatch(/^--[a-z]/u)
      expect(typeof value === 'string' && value.length > 0, `${name} was published empty`).toBe(true)
    }
  })

  it('publishes lengths in px, from their constants, for the platform it was given', () => {
    const mac = published('macos')
    expect(mac.get('--pane-track')).toBe(`${PANE_TRACK}px`)
    expect(mac.get('--titlebar-h')).toBe(`${TITLEBAR_H.macos}px`)
    expect(published('web').get('--titlebar-h')).toBe(`${TITLEBAR_H.web}px`)
    expect(published('windows').get('--sys-zone-w')).toBe(`${SYS_ZONE_W.windows}px`)
    for (const [name, key] of [
      ['--radius-pill', 'pill'],
      ['--radius-card', 'card'],
      ['--radius-control', 'control'],
      ['--radius-chip', 'chip'],
      ['--radius-mark', 'mark'],
      ['--radius-sheet', 'sheet'],
    ] as const) {
      expect(mac.get(name), name).toBe(`${RADIUS[key]}px`)
    }
    expect(mac.get('--card-w')).toBe(`${CARD_W}px`)
    expect(mac.get('--cell-height')).toBe(`${cellHeightFor(CARD_W)}px`)
  })

  /**
   * EVERY PLATFORM THE TYPE DECLARES, written out rather than read off the
   * tables' own keys. A table asked for its keys agrees with itself even when
   * it is empty, and an empty one publishes `undefinedpx` — which CSS drops as
   * an invalid declaration, leaving the bar with no height and the system zone
   * with no width while every test that compares a token against its own
   * constant still passes.
   */
  const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux', 'web', 'ios', 'android']

  /** The number a stylesheet is handed, refused unless it is a real px length. */
  const lengthOf = (set: Map<string, string>, name: string): number => {
    const value = set.get(name)
    expect(value, name).toMatch(/^\d+(?:\.\d+)?px$/u)
    return Number.parseFloat(String(value))
  }

  it('gives every platform it draws for a real band and a real system zone', () => {
    for (const platform of PLATFORMS) {
      const set = published(platform)
      expect(set.get('--titlebar-h'), platform).toMatch(/^\d+px$/u)
      expect(set.get('--sys-zone-w'), platform).toMatch(/^\d+px$/u)
    }
  })

  it('reserves neither where there is no window of its own — a browser tab, a phone', () => {
    /* A phone's chrome is an INSET, reached through `env(safe-area-inset-top)`,
       and a browser tab has no titlebar to overlay: a band reserved here holds
       nothing and pushes the reading surface down the screen for a decoration
       that does not exist. Both phones were reported as `macos` until the
       platform type learned about them, and the mobile build drew a 52px
       overlay titlebar with three traffic lights on an iPhone. */
    const mac = published('macos')
    for (const platform of ['web', 'ios', 'android'] as const) {
      const set = published(platform)
      expect(lengthOf(set, '--titlebar-h'), platform).toBe(0)
      expect(lengthOf(set, '--sys-zone-w'), platform).toBe(0)
      expect(set.get('--titlebar-h'), platform).not.toBe(mac.get('--titlebar-h'))
      expect(set.get('--sys-zone-w'), platform).not.toBe(mac.get('--sys-zone-w'))
    }
  })

  it('gives a windowed platform a band its own controls fit in, and a zone that covers the window controls', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const set = published(platform)
      /* `CONTROL_TITLEBAR` is what a control in this bar is drawn at, and a bar
         no taller than the control it holds has nothing left to hold it in. */
      expect(lengthOf(set, '--titlebar-h'), platform).toBeGreaterThan(CONTROL_TITLEBAR)
      expect(lengthOf(set, '--sys-zone-w'), platform).toBeGreaterThan(0)
    }
    const mac = published('macos')
    /* macOS OVERLAYS its bar over the leading cards, which pad themselves down
       by the band less the concentric inset — a band no deeper than that inset
       pads by nothing at all and leaves the card's first row under the traffic
       lights. */
    expect(lengthOf(mac, '--titlebar-h')).toBeGreaterThan(lengthOf(mac, '--concentric-inset'))
    /* And the zone has to cover the three lights AND the inset they sit at,
       which is the whole of what it is for: short of them, the centred book
       chip meets a traffic light as soon as the window is narrow. */
    expect(lengthOf(mac, '--sys-zone-w')).toBeGreaterThan(3 * TRAFFIC_LIGHT)
  })

  it('never publishes a token reading `undefined`, whichever table went missing', () => {
    /* THE WHOLE CLASS, not the two tables that were caught. A table emptied —
       by an edit, or by a mutant — still publishes: `${undefined}px` is a
       string, so a token check that asks only for a non-empty value passes,
       and a token compared against its own constant passes twice over. CSS
       drops `undefinedpx` as invalid and the reader gets a bar with no height,
       a column with no width or a handle with no size, with nothing said
       anywhere.

       ⚠️ AND THE MUTATION GATE CANNOT FIND THIS ONE FOR ITSELF. Stryker makes
       no `ObjectLiteral` mutant for a table written `{ … } as const`, which is
       most of the tables here — `PROSE_MAX`, `LIST_COL`, `SHEET_HANDLE`, `Z`,
       `RADIUS`, `MOTION`, `ICON` among them — so 100 % of this file's mutants
       says nothing whatever about them. Emptied by hand, all three of the
       first were invisible to every covering test until this ran (measured
       2026-09-16). */
    for (const platform of PLATFORMS) {
      for (const [name, value] of published(platform)) {
        expect(value, `${name} on ${platform}`).not.toMatch(/undefined|NaN/u)
      }
    }
  })

  /* A proportion, a layer and a duration are not lengths, and carry no unit. */
  it('publishes a proportion, a layer and a motion as they are', () => {
    const mac = published('macos')
    expect(mac.get('--cover-aspect')).toBe(String(COVER_ASPECT))
    expect(mac.get('--z-figure')).toBe(String(Z.figure))
    expect(mac.get('--motion-sheet')).toBe(MOTION.sheet)
  })
})

describe('proseGrid', () => {
  it('holds the full measure when there is room', () => {
    const grid = proseGrid(2000, false)
    expect(grid.measure).toBe(MEASURE)
    expect(grid.gutter).toBe(GUTTER)
  })

  it('mirrors the gutter when there are no marks, so the measure is centred', () => {
    const grid = proseGrid(2000, false)
    expect(grid.marginCol).toBe(GUTTER)
    expect(containerCentre(grid)).toBe(measureCentre(grid))
  })

  /* The mirror FLOORS like the gutter it mirrors. It used to drain to zero —
   * the text flush against the stage's right edge, the same broken window
   * GUTTER_MIN exists to prevent on the left. It does not shrink in lockstep
   * with the gutter, deliberately: `paneTakesTrack` counts one gutter and
   * declares the margin spendable, and the pane threshold is built on that —
   * so the measure sits slightly off centre while the two sides walk down to
   * the shared floor, and never loses its right margin entirely. */
  it('never lets the mirror fall below the floor, at any width', () => {
    for (let width = 0; width <= 2000; width += 7) {
      const grid = proseGrid(width, false)
      expect(grid.marginCol).toBeGreaterThanOrEqual(GUTTER_MIN)
      expect(grid.marginCol).toBeLessThanOrEqual(GUTTER)
    }
  })

  it('reserves the margin column once the book has marks', () => {
    expect(proseGrid(2000, true).marginCol).toBe(MARGIN_COL)
  })

  it('yields the margin before the gutter, and the measure last of all', () => {
    // Just under what the full grid needs, so exactly one track must give.
    const full = GUTTER + PROSE_GAP + MEASURE + PROSE_GAP + MARGIN_COL
    const tight = proseGrid(full - 40, true)
    expect(tight.measure).toBe(MEASURE)
    expect(tight.gutter).toBe(GUTTER)
    expect(tight.marginCol).toBe(MARGIN_COL - 40)
  })

  it('only sacrifices the measure when nothing else is left', () => {
    const grid = proseGrid(400, true)
    expect(grid.marginCol).toBe(0)
    /* The gutter FLOORS rather than vanishing — see `GUTTER_MIN`. This asserted
     * 0 for as long as the gutter was allowed to go there, which is the state
     * that let the text sit flush against its container. */
    expect(grid.gutter).toBe(GUTTER_MIN)
    expect(grid.measure).toBeLessThan(MEASURE)
    expect(grid.measure).toBeGreaterThan(0)
  })

  /* The text must never touch the edge of the thing holding it, whatever
   * squeezed it — a narrow window, an open pane, or a large reading step. */
  it('never lets the gutter fall below the floor, at any width', () => {
    for (let width = 0; width <= 2000; width += 7) {
      for (const marks of [false, true]) {
        const grid = proseGrid(width, marks)
        expect(grid.gutter).toBeGreaterThanOrEqual(GUTTER_MIN)
        expect(grid.gutter).toBeLessThanOrEqual(GUTTER)
      }
    }
  })

  it('never returns a negative track', () => {
    for (const width of [0, 1, 50, 200, 700, 1200]) {
      const grid = proseGrid(width, true)
      expect(grid.gutter).toBeGreaterThanOrEqual(0)
      expect(grid.measure).toBeGreaterThanOrEqual(0)
      expect(grid.marginCol).toBeGreaterThanOrEqual(0)
    }
  })

  /* TO THE PIXEL, stage by stage. The cases above hold the ORDER and the
     floors; these hold the amounts, which is what a take counted twice — or
     not subtracted from what was still over — gets wrong while every floor
     and every ordering still holds. Without marks the full grid is
     56 + 660 + 56 + 2 × 32 = 836. */
  it('spends exactly what is over: the mirror to its floor, then the gutter, then the measure', () => {
    // 36 over: the mirror gives its 32, the gutter the last 4.
    expect(proseGrid(800, false)).toEqual({ gutter: GUTTER - 4, measure: MEASURE, marginCol: GUTTER_MIN, gap: PROSE_GAP })
    // 136 over: the mirror 32, the gutter 32, the measure the remaining 72.
    expect(proseGrid(700, false)).toEqual({ gutter: GUTTER_MIN, measure: MEASURE - 72, marginCol: GUTTER_MIN, gap: PROSE_GAP })
    // Exactly full, and one pixel under: nothing moves, then the mirror gives one.
    expect(proseGrid(836, false)).toEqual({ gutter: GUTTER, measure: MEASURE, marginCol: GUTTER, gap: PROSE_GAP })
    expect(proseGrid(835, false)).toEqual({ gutter: GUTTER, measure: MEASURE, marginCol: GUTTER - 1, gap: PROSE_GAP })
  })
})

/* A shelf cell is a FIXED height because virtualisation derives one row height
 * from one cell. What was wrong was the number: `--cell-height` was referenced
 * with a 268px fallback and set by nothing, so a 173px column asked for a 259px
 * cover and got 9px left over for two lines of text and a progress rule —
 * which `overflow: hidden` ate without a word. */
describe('cellHeightFor', () => {
  it('leaves room for the cover at its own proportion, plus the text below it', () => {
    for (const width of [140, 150, 173, 200, 260]) {
      const height = cellHeightFor(width)
      const cover = width / COVER_ASPECT
      expect(height).toBeGreaterThanOrEqual(cover)
      // The remainder is the furniture, and it does not shrink with the column:
      // the title and author are one line each whatever the cover's width.
      expect(height - Math.round(cover)).toBe(CELL_FURNITURE)
    }
  })

  it('grows with the column, so a wider shelf does not clip', () => {
    expect(cellHeightFor(260)).toBeGreaterThan(cellHeightFor(140))
  })

  /* The number the old hardcoded fallback would have given, at the width that
   * exposed it. Kept as a regression marker: 268 was 51px short. */
  it('is taller than the 268px constant it replaced, at the width that broke', () => {
    expect(cellHeightFor(173)).toBeGreaterThan(268)
  })

  /* The card the shelf actually draws. Its height is 2:3 of the width plus
   * the furniture — the user's brief, exactly: "height should be divided by
   * 0.667". Pinned so a change to either constant is a change here too. */
  it('gives the shelf card its 2:3 cover plus the text beneath it', () => {
    expect(cellHeightFor(CARD_W)).toBe(Math.round(CARD_W / COVER_ASPECT) + CELL_FURNITURE)
    expect(Math.round(CARD_W / COVER_ASPECT)).toBe(189)
  })
})

/* The defect this pins is recorded in `dev-docs/pane-collapse-threshold.md`:
 * a flat 1024px threshold let the pane take a track the grid could not pay
 * for, and the gutters silently went to zero. The threshold has to move with
 * the reading step, because the measure does. */
describe('paneTakesTrack', () => {
  const stageInner = (windowWidth: number) =>
    windowWidth - PANE_TRACK - STAGE_PADDING_X * 2

  /* BOUNDED, and it says so when it finds nothing. Two cases below walk the
     width up to the first that takes the track, and a `while` loop over a
     predicate that never answers true does not fail — it hangs, and a hang
     reads as a slow test rather than as the answer it is. No window is
     4000px past the widest measure this ramp offers. */
  const firstWidthTaking = (stepIdx: number): number => {
    for (let width = 0; width <= 4000; width += 1) {
      if (paneTakesTrack(width, stepIdx)) return width
    }
    throw new Error(`paneTakesTrack never grants a track at step ${stepIdx}, up to 4000px`)
  }

  it('lets the pane take a track only when the full gutter survives it', () => {
    for (let stepIdx = 0; stepIdx < READING_STEPS.length; stepIdx++) {
      const measure = measureForStep(stepIdx)
      // Walk the width across the threshold and check the grid agrees.
      for (let width = measure + 400; width <= measure + 800; width++) {
        const grid = proseGrid(stageInner(width), false, measure)
        if (paneTakesTrack(width, stepIdx)) {
          expect(grid.gutter).toBe(GUTTER)
          expect(grid.measure).toBe(measure)
        }
      }
    }
  })

  it('moves with the reading step rather than sitting at one number', () => {
    const widths = READING_STEPS.map((_, stepIdx) => firstWidthTaking(stepIdx))
    // Strictly increasing: a larger measure needs a wider window.
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!)
    }
    // And every one of them is above the flat 1024 this replaced, which is
    // exactly why the old constant was wrong rather than merely imprecise.
    for (const width of widths) expect(width).toBeGreaterThan(1024)
  })

  /* NOT A PIXEL LATE EITHER. The case above holds that a granted track keeps
     the gutter; this holds the other half — the first width it grants is the
     first at which the gutter survives, so a pane is not kept a sheet over a
     window that had room for it. */
  it('grants the track at the very first width the full gutter survives', () => {
    for (let stepIdx = 0; stepIdx < READING_STEPS.length; stepIdx++) {
      const measure = measureForStep(stepIdx)
      const width = firstWidthTaking(stepIdx)
      expect(proseGrid(stageInner(width), false, measure).gutter).toBe(GUTTER)
      expect(proseGrid(stageInner(width - 1), false, measure).gutter, `step ${stepIdx}`).toBeLessThan(GUTTER)
    }
  })
})

describe('proseBleed', () => {
  /* This is the regression the audit caught: the compensation was applied to
   * the narrow side, which moved the centre the same way the imbalance already
   * did and doubled the error instead of cancelling it. */
  it('centres the measure when the margin is wider than the gutter', () => {
    const grid = proseGrid(2000, true)
    expect(grid.marginCol).toBeGreaterThan(grid.gutter)
    expect(containerCentre(grid)).toBe(measureCentre(grid))
  })

  it('pads the wider side, never the narrower one', () => {
    const grid = proseGrid(2000, true)
    const bleed = proseBleed(grid)
    expect(bleed.end).toBe(grid.marginCol - grid.gutter)
    expect(bleed.start).toBe(0)
  })

  it('needs no padding when the tracks already match', () => {
    expect(proseBleed(proseGrid(2000, false))).toEqual({ start: 0, end: 0 })
  })
})

describe('the reading ramp', () => {
  it('runs 15 to 28 by ones', () => {
    expect(READING_STEPS.map((s) => s.size)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28])
  })

  it('keeps 21/34/660 as the default, which the whole grid is specified around', () => {
    const step = READING_STEPS[DEFAULT_STEP_IDX]!
    expect([step.size, step.line, step.measure]).toEqual([21, LINE, MEASURE])
  })

  it('gives every step an integer line box', () => {
    /* The rule the table states: a FRACTIONAL line box breaks the ruler and the
       scroll snapping. Odd is fine and two of these are — 29 at 18px and 39 at
       24px — because there are only twelve even numbers between 24 and 46 for
       fourteen sizes, so rounding to even would collide with a neighbour. */
    for (const step of READING_STEPS) expect(Number.isInteger(step.line), `${step.size}px`).toBe(true)
  })

  it('leads every step at between 1.57 and 1.66 of its size', () => {
    /* The band the seven-step table already occupied, floor and ceiling both
       set by steps that are still on this ramp — 19/30 and 23/38. */
    for (const step of READING_STEPS) {
      const ratio = step.line / step.size
      expect(ratio, `${step.size}px leads at ${ratio}`).toBeGreaterThanOrEqual(30 / 19)
      expect(ratio, `${step.size}px leads at ${ratio}`).toBeLessThanOrEqual(38 / 23)
    }
  })

  it('keeps every size the seven-step ramp offered on its own line and measure', () => {
    /* A reader already on one of these sees nothing move. 30px is the one the
       old ramp had that this does not, which is what the range now stops short
       of — `stepIndexForSize` lands it on 28. */
    for (const [size, line, measure] of [[17, 28, 540], [19, 30, 600], [21, 34, 660], [23, 38, 700], [26, 42, 740], [28, 46, 780]]) {
      const step = READING_STEPS.find((s) => s.size === size)
      expect(step, `${size}px is gone`).toBeDefined()
      expect([step!.line, step!.measure], `${size}px moved`).toEqual([line, measure])
    }
  })

  it('widens the measure and narrows it in CHARACTERS as the type grows', () => {
    /* What makes large print large print rather than merely wide. A step whose
       measure gave MORE characters than the one below it would be a bigger size
       on a longer line, which is the opposite of the intent. */
    const chars = READING_STEPS.map((s) => s.measure / s.size)
    for (let i = 1; i < chars.length; i++) {
      expect(chars[i]!, `${READING_STEPS[i]!.size}px`).toBeLessThan(chars[i - 1]!)
      expect(READING_STEPS[i]!.measure).toBeGreaterThan(READING_STEPS[i - 1]!.measure)
    }
  })
})

describe('stepIndexForSize', () => {
  it('finds the step a size names', () => {
    READING_STEPS.forEach((step, i) => expect(stepIndexForSize(step.size)).toBe(i))
  })

  it('lands a size this ramp no longer offers on the nearest it does', () => {
    /* 30px was on the seven-step ramp. Dropping the reader to the DEFAULT would
       throw away a deliberate "as large as it goes"; the nearest step honours
       it, which is the argument `index` already makes for clamping. */
    expect(stepIndexForSize(30)).toBe(READING_STEPS.length - 1)
    expect(stepIndexForSize(2)).toBe(0)
    expect(stepIndexForSize(19.4)).toBe(stepIndexForSize(19))
  })

  it('falls back rather than returning nonsense for a size that is not one', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(stepIndexForSize(bad)).toBe(DEFAULT_STEP_IDX)
    }
  })

  /* HALFWAY LANDS ON THE SMALLER. A size exactly between two steps is as near
     one as the other, and the answer must not depend on which the loop met
     last: the first found — the smaller — is kept. */
  it('lands a size exactly between two steps on the smaller', () => {
    expect(stepIndexForSize(19.5)).toBe(stepIndexForSize(19))
    expect(stepIndexForSize(27.5)).toBe(stepIndexForSize(27))
  })
})

describe('measureForStep', () => {
  it('gives every reading step its own §09 measure', () => {
    READING_STEPS.forEach((step, i) => {
      expect(measureForStep(i)).toBe(step.measure)
    })
    // All seven differ from the default; a single constant would have hidden this.
    expect(new Set(READING_STEPS.map((s) => s.measure)).size).toBe(READING_STEPS.length)
  })

  it('falls back rather than returning undefined for an out-of-range step', () => {
    expect(measureForStep(-1)).toBe(MEASURE)
    expect(measureForStep(99)).toBe(MEASURE)
    expect(measureForStep(Number.NaN)).toBe(MEASURE)
  })
})

describe('readingStep', () => {
  it('returns the step at the index', () => {
    READING_STEPS.forEach((step, i) => {
      expect(readingStep(i)).toBe(step)
    })
  })

  /* The reason this function exists. Three call sites each wrote their own
   * `READING_STEPS[i] ?? fallback`, and two of them named DIFFERENT fallbacks —
   * `MEASURE` here, `READING_STEPS[2]` in bookCss. They agree today only
   * because the default step's measure happens to equal MEASURE, so moving
   * either number would have silently split the size the book is laid out to
   * from the width of the column it is laid out into. */
  it('falls back to the default step, not to undefined', () => {
    for (const bad of [-1, 99, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      expect(readingStep(bad)).toBe(READING_STEPS[DEFAULT_STEP_IDX])
    }
  })

  it('agrees with measureForStep everywhere, in range and out', () => {
    for (const idx of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 99, Number.NaN]) {
      expect(measureForStep(idx)).toBe(readingStep(idx).measure)
    }
  })
})

describe('proseColumn', () => {
  /* Measured in the running app on 2026-08-19: a 1009px stage (961 inner, 24px
     padding either side) laid its gutter at 87 and its measure at 175. The
     arithmetic here has to land on the same numbers, because the whole point of
     it is to tell a floating surface where the words are without asking the
     DOM a second time. */
  const GRID = { gutter: 56, measure: 660, marginCol: 56, gap: 32 }

  it('lands where the browser laid the measure track', () => {
    expect(proseColumn(961, GRID)).toEqual({ left: 174.5, width: 660 })
  })

  it('starts after the padding, the slack and the tracks before it', () => {
    // 24 padding + half of (961 - 836) slack + 56 gutter + 32 gap.
    const { left } = proseColumn(961, GRID)
    expect(left).toBe(24 + (961 - (56 + 660 + 56 + 64)) / 2 + 56 + 32)
  })

  it('follows a widened margin, which puts the measure left of the stage’s centre', () => {
    /* The margin opens once a book has notes in it, and the GRID stays centred
       — so the measure inside it does not. This is exactly why the offset
       cannot be "half the stage minus half the measure", which is the shortcut
       that looks right on every window with no notes in the margin.
       Built by `proseGrid` rather than by hand: a grid whose tracks do not fit
       the stage is not a grid this function is ever handed. */
    const withNotes = proseGrid(961, true)
    const { left, width } = proseColumn(961, withNotes)
    expect(withNotes.marginCol).toBeGreaterThan(withNotes.gutter)
    expect(left + width / 2).toBeLessThan(961 / 2 + 24)
  })

  it('keeps centring past the width where the tracks fit, overflowing both sides as the stage does', () => {
    /* ⚠️ **THIS CASE ASSERTED A CLAMP, ON THE CLAIM THAT GRID "STOPS CENTRING
       AND OVERFLOWS THE END".** That is `justify-content: safe center`; the
       stage says plain `center`, which overflows both sides equally — so the
       clamp put the column right of where CSS draws it. It also used a grid
       `proseGrid` never hands out. This is the smallest one it does: both
       gutters floored at 24, the measure spent, 112px of tracks in a 100px
       stage — 12 over, six each side. */
    const grid = proseGrid(100, false)
    expect(grid.gutter + grid.measure + grid.marginCol + 2 * grid.gap).toBe(112)
    expect(proseColumn(100, grid).left).toBe(24 - 6 + 24 + 32)
  })
})
