/**
 * A moment, as a reader would say it, in a column two words wide.
 *
 * RECENT IS RELATIVE, OLD IS ABSOLUTE — the rule every list of dates worth
 * reading follows. "3 days" answers the question a reader is actually asking
 * about something they touched this week; "14 months" does not, because past a
 * point nobody counts in months and the useful fact becomes WHEN, not how long
 * ago. So the changeover happens at a year, where relative stops being the more
 * informative of the two.
 *
 * Written out rather than reached for from `Intl.RelativeTimeFormat`, which
 * produces "3 days ago" — correct English and the wrong length for a column
 * that has to sit beside a hundred others without any of them wrapping. The
 * heading says what the number means; the cell only has to say how much.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

/** Day and month, for a date inside the last year: `12 Mar`. */
const thisYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
/** With the year, for anything older: `12 Mar 2024`. */
const anyYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * How long ago `at` was, from `now`.
 *
 * Null for a moment that never happened — a book nobody has opened — so the
 * caller decides what nothing looks like rather than being handed a zero that
 * would sort and read as a real date.
 *
 * A moment in the FUTURE is treated as now rather than rendered as a negative
 * age: clocks move, files carry dates from other machines, and "in -3 days" is
 * never the useful thing to say about a book.
 */
export function relativeTime(at: number | null | undefined, now: number): string | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null
  const age = Math.max(0, now - at)
  if (age < MINUTE) return 'Just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min`
  if (age < DAY) return `${Math.floor(age / HOUR)} hr`
  if (age < WEEK) {
    const days = Math.floor(age / DAY)
    return days === 1 ? 'Yesterday' : `${days} days`
  }
  if (age < YEAR) return thisYear.format(at)
  return anyYear.format(at)
}
