/**
 * Turning a page by tapping, for a device with no wheel (phase 18).
 *
 * ## Why this exists
 *
 * `FoliateView` raises a page intent from ONE gesture: the wheel. Its own prop
 * says so — "a wheel gesture asked for another page". On the desktop that is
 * the whole story, because a trackpad swipe arrives as a wheel event.
 *
 * **A phone has no wheel.** Playwright says it outright — "Mouse wheel is not
 * supported in mobile WebKit" — and that is not a limitation of the harness, it
 * is the device. So the browser client shipped a reader that opened a book and
 * could not advance it, on the one kind of device it was built for. Measured by
 * trying to turn a page, which no test in this tree could have done.
 *
 * ## The rules, and why each one is here
 *
 * A tap is not always a page turn, and getting that wrong is worse than having
 * no taps at all — a reader who cannot select a quote without losing their
 * place will stop trying.
 *
 * - **A tap with a selection is not a turn.** Releasing at the end of a
 *   drag-select lands somewhere, and that somewhere is usually the outer third.
 * - **A tap on a link is not a turn.** The link wins; foliate is already
 *   handling it.
 * - **A tap that moved is a drag, not a tap.** Scrolling, selecting and
 *   swiping all end in a release.
 * - **The MIDDLE THIRD DOES NOTHING**, deliberately. It is where a reader rests
 *   a thumb, and it is the only part of the page that is safe to touch.
 *
 * ## Sides, not directions
 *
 * The intent is `left`/`right` and never `next`/`prev`. foliate resolves which
 * page a side means from the book's own direction, so in a right-to-left book
 * the left edge is forward — and naming the direction here would reverse it.
 * The desktop's reader draws the same distinction for the same reason.
 */

/** Which side was tapped, or null for a tap that must not turn a page. */
export type TapIntent = 'left' | 'right'

/** What `tapIntent` needs to know about a release. */
export interface Tap {
  /** Where the release landed, in the document's own coordinates. */
  readonly x: number
  /** How far the pointer travelled between press and release, in pixels. */
  readonly moved: number
  /** The width of the page the tap landed on. */
  readonly width: number
  /** Whether the reader has text selected. */
  readonly selected: boolean
  /** Whether the release landed on a link or another interactive element. */
  readonly onControl: boolean
}

/**
 * How far a pointer may travel and still be a tap.
 *
 * Generous rather than tight: a thumb on glass moves, and the cost of calling a
 * small drag a tap is a page turn the reader did not ask for. The cost of
 * calling a tap a drag is nothing — they tap again.
 */
export const TAP_SLOP = 10

/**
 * How much of the page's width each edge zone takes.
 *
 * A third either side, a third in the middle. Wide enough to hit without
 * looking, which is the whole point of a reading gesture.
 */
export const EDGE = 1 / 3

/**
 * Where a tap landed, in the STAGE's coordinates rather than the book
 * document's.
 *
 * ## Why this is not just `event.clientX`
 *
 * A book document is not one page wide. foliate lays a section out in columns
 * and makes the iframe as wide as ALL of them, then clips it and slides it
 * sideways to show one page at a time. So a section that paginates into three
 * pages has `documentElement.clientWidth === 1011` while the reader is looking
 * at 337 of it.
 *
 * Judge a tap against that number and the thirds are drawn across a strip two
 * thirds of which is off-screen. Measured 2026-08-26, one tap at screen x=346,
 * `clientX` 318 in every case:
 *
 * | Section | `clientWidth` | Right edge begins | Verdict |
 * |---|---|---|---|
 * | one page  | 337  | 225 | `right` ✓ |
 * | three pages | 1011 | 674 | `left` ✗ |
 *
 * The reader tapped the same spot twice and went forward, then back, forever —
 * every second tap undid the one before it, so a book could not be read past
 * its first long section. `tapIntent` was right each time; it was being told
 * the wrong page.
 *
 * ## The mapping
 *
 * `clientX` is relative to the frame's own viewport, and the frame's offset
 * within the stage is negative once it has slid — page 2 of that section sits
 * at −309. Adding them gives the position on screen, which is the only basis
 * both listeners can agree on. The stage's width is then the page's width,
 * because the stage IS what the reader can see.
 */
export function stagePoint(clientX: number, frameLeft: number, stageLeft: number): number {
  return clientX + frameLeft - stageLeft
}

/** The page turn a release asks for, or null. */
export function tapIntent(tap: Tap): TapIntent | null {
  if (tap.selected || tap.onControl) return null
  if (tap.moved > TAP_SLOP) return null
  /* A ZERO-WIDTH PAGE IS NOT A PAGE. It happens for a frame while a document
   * is being laid out, and every tap would otherwise read as the right edge —
   * `x < 0` is false and `x >= 0` is true for any x. */
  if (tap.width <= 0) return null
  if (tap.x < tap.width * EDGE) return 'left'
  if (tap.x > tap.width * (1 - EDGE)) return 'right'
  return null
}
