import { WORDS_PER_MINUTE, type BookLength } from './readingTime'

/**
 * How long to leave a step on screen when the book turns itself.
 *
 * ## Why this is a STEP and not a smooth scroll
 *
 * ⚠️ **THE HOST CANNOT SCROLL THE BOOK, MEASURED 2026-09-26.** The paginator
 * owns the scroller inside a CLOSED shadow root, and the book's own document is
 * sized to its whole content rather than clipped — section 21 of a real textbook
 * reports `scrollHeight` 125 235 and `clientHeight` 125 235, and writing
 * `scrollTop` on either `documentElement` or `body` leaves it at 0. So there is
 * no scroller in reach to move by a pixel.
 *
 * What IS in reach is `renderer.pages` and `view.next()`: that same section
 * reports **159 steps** in scrolled flow, one viewport each. So the book can be
 * advanced hands-free at reading pace, a viewport at a time in scrolled flow and
 * a page at a time in paginated flow — which is the reader-facing value — and
 * cannot glide. The name says step for that reason.
 *
 * ⚠️ **AND SMOOTH SCROLLING IS THE SAME FORK CHANGE AS CONTINUOUS SCROLLING**,
 * not a separate problem: both need the paginator to give up sole ownership of
 * the scroller. `dev-docs/foliate-fork.md` is where that decision would be
 * recorded, and the ledger records the current shape as kept deliberately after
 * a review on 2026-08-16.
 *
 * ## Why the pace is derived and not a slider
 *
 * A reader who has to tune a speed is being asked to solve the app's problem.
 * The pace comes from the same place the time-left estimate does —
 * `WORDS_PER_MINUTE` over the book's own length — so a dense page rests longer
 * than a sparse one without anybody choosing a number.
 */

/**
 * The band a derived rest must fall in, and why refusing outside it is right.
 *
 * ⚠️ **A DERIVATION THAT ESCAPES THIS BAND IS A BROKEN INPUT, NOT A SLOW
 * READER.** Every term can be wrong in ways this module cannot see: a section
 * whose bytes are mostly markup, a `pages` count taken before layout settled, a
 * spine total that under-counts. Clamping would turn each of those into a
 * plausible-looking rest and hand the reader a book that advances at a rate
 * nothing chose. Two seconds is faster than anyone reads a viewport; ten minutes
 * is slower than anyone would call movement.
 */
export const FASTEST_REST_MS = 2_000
export const SLOWEST_REST_MS = 600_000

/** What a step's rest is computed from. Every field is available at run time. */
export interface StepPace {
  /** The whole book, in words — `wordsInSpine`, or null when unknown. */
  readonly bookWords: BookLength
  /** This section's share of the spine, in bytes. */
  readonly sectionBytes: number
  /** The spine's total bytes, the same number `wordsInSpine` was given. */
  readonly spineBytes: number
  /** How many steps this section has — `renderer.pages`. */
  readonly steps: number
}

/**
 * Milliseconds to rest on one step, or null when that cannot be derived.
 *
 * ⚠️ **NULL IS A REAL ANSWER AND MUST STAY ONE.** Auto-advance with no honest
 * pace would have to invent one, and a book that turns itself at an invented
 * rate is worse than a control that declines: the reader cannot tell a
 * deliberate pace from a broken one, and the page moves under them either way.
 * The caller offers nothing when this answers null.
 */
export function restPerStep(pace: StepPace): number | null {
  const { bookWords, sectionBytes, spineBytes, steps } = pace
  if (bookWords === null) return null
  if (!Number.isFinite(sectionBytes) || sectionBytes <= 0) return null
  if (!Number.isFinite(spineBytes) || spineBytes <= 0) return null
  if (!Number.isFinite(steps) || steps < 1) return null
  /* This section's words: the book's length, shared out by bytes. The same
     aggregate-not-sample rule `readingTime` records — a per-section text
     measurement is not available from the host, and the byte share is. */
  const sectionWords = bookWords * (sectionBytes / spineBytes)
  const perStep = sectionWords / steps
  if (perStep <= 0) return null
  const rest = (perStep / WORDS_PER_MINUTE) * 60_000
  if (!Number.isFinite(rest)) return null
  if (rest < FASTEST_REST_MS || rest > SLOWEST_REST_MS) return null
  return Math.round(rest)
}
