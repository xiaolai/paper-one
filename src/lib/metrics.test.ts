import { describe, expect, it } from 'vitest'
import {
  CARD_W,
  CELL_FURNITURE,
  COVER_ASPECT,
  DEFAULT_STEP_IDX,
  GUTTER,
  cellHeightFor,
  GUTTER_MIN,
  MARGIN_COL,
  MEASURE,
  PANE_TRACK,
  PROSE_GAP,
  READING_STEPS,
  STAGE_PADDING_X,
  measureForStep,
  paneTakesTrack,
  proseBleed,
  proseColumn,
  proseGrid,
  readingStep,
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
    const widths = READING_STEPS.map((_, stepIdx) => {
      let width = 0
      while (!paneTakesTrack(width, stepIdx)) width += 1
      return width
    })
    // Strictly increasing: a larger measure needs a wider window.
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeGreaterThan(widths[i - 1]!)
    }
    // And every one of them is above the flat 1024 this replaced, which is
    // exactly why the old constant was wrong rather than merely imprecise.
    for (const width of widths) expect(width).toBeGreaterThan(1024)
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

  it('gives no negative offset when the tracks cannot fit', () => {
    /* `proseGrid` sizes the tracks to the stage, so this is a defensive case
       rather than a reachable one — but a negative offset would put the bar
       off the reading area entirely, which is worse than a bar pressed against
       its leading edge. Grid itself does the same: it stops centring and
       overflows the end. */
    const { left } = proseColumn(200, GRID)
    expect(left).toBe(24 + 56 + 32)
  })
})
