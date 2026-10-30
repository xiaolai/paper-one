import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

/* A fixed instant, so a test never depends on when it runs. */
const NOW = new Date('2026-08-18T12:00:00Z').getTime()
const ago = (ms: number) => NOW - ms
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('relativeTime', () => {
  it('says nothing for a moment that never happened', () => {
    expect(relativeTime(null, NOW)).toBeNull()
    expect(relativeTime(undefined, NOW)).toBeNull()
  })

  /* A stored number a reader could have edited, or a date arithmetic produced
   * from a missing field. `NaN` formatted as "Invalid Date" in a column. */
  it('says nothing for a value that is not a moment', () => {
    expect(relativeTime(NaN, NOW)).toBeNull()
    expect(relativeTime(Infinity, NOW)).toBeNull()
  })

  it('counts the last hour in minutes', () => {
    expect(relativeTime(ago(30_000), NOW)).toBe('Just now')
    expect(relativeTime(ago(3 * MIN), NOW)).toBe('3 min')
    expect(relativeTime(ago(59 * MIN), NOW)).toBe('59 min')
  })

  it('counts the last day in hours', () => {
    expect(relativeTime(ago(HOUR), NOW)).toBe('1 hr')
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23 hr')
  })

  it('counts the last week in days, and names yesterday', () => {
    expect(relativeTime(ago(DAY), NOW)).toBe('Yesterday')
    expect(relativeTime(ago(3 * DAY), NOW)).toBe('3 days')
    expect(relativeTime(ago(6 * DAY), NOW)).toBe('6 days')
  })

  /* THE CHANGEOVER. Past a week a reader stops counting and starts wanting the
   * date; past a year the date needs its year. */
  it('gives a date once counting stops being useful', () => {
    const older = relativeTime(ago(40 * DAY), NOW)
    expect(older).toMatch(/\d/)
    expect(older).not.toMatch(/days|hr|min/)
    expect(older).not.toMatch(/2026/)
  })

  it('carries the year for anything older than one', () => {
    expect(relativeTime(ago(500 * DAY), NOW)).toMatch(/202[45]/)
  })

  /* Clocks move and files carry dates from other machines. "in -3 days" is
   * never the useful thing to say about a book. */
  it('treats a moment in the future as now rather than as a negative age', () => {
    expect(relativeTime(NOW + 5 * DAY, NOW)).toBe('Just now')
  })
})
