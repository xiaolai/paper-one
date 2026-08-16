import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEP_IDX,
  GUTTER,
  MARGIN_COL,
  MEASURE,
  PROSE_GAP,
  READING_STEPS,
  measureForStep,
  proseBleed,
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
    expect(grid.gutter).toBe(0)
    expect(grid.measure).toBeLessThan(MEASURE)
    expect(grid.measure).toBeGreaterThan(0)
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
