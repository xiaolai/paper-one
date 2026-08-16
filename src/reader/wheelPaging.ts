/**
 * Turning a page with a wheel — a trackpad swipe, or a mouse notch.
 *
 * A two-finger swipe in a webview is NOT a touch gesture. foliate handles
 * `touchstart`/`move`/`end` and that covers a touchscreen; a trackpad emits
 * `wheel` with `deltaX`, which nothing handled. The same is true of a Windows
 * precision touchpad, libinput, and a mouse with a horizontal wheel — so one
 * handler here plus foliate's existing touch code is the whole matrix.
 *
 * THE TWO AXES MEAN DIFFERENT THINGS, and collapsing them would be wrong.
 *
 * A HORIZONTAL gesture is spatial: the reader asked for the page on the left or
 * on the right. Which of those is "next" depends on the book — in a
 * right-to-left book the next page is the one on the LEFT — and foliate already
 * publishes `goLeft`/`goRight` to resolve it from the book's own `dir`. So this
 * reports a side and hands the question over rather than answering it twice.
 *
 * A VERTICAL gesture is logical: scrolling down means "further into the book",
 * in every writing direction there is. Nothing about it is spatial, so it maps
 * straight onto next/prev and must NOT be routed through the left/right pair —
 * doing so would silently reverse the mouse wheel in Arabic and Hebrew books.
 *
 * NATURAL SCROLLING NEEDS NO HANDLING, which is worth saying because it looks
 * like it should. macOS inverts `deltaX` when it is on and offers no way to
 * read the setting — but mapping "content pushed left" to "show what is on the
 * right" follows whatever the reader has configured, and matches every other
 * scroll on their machine. Detecting it would break it.
 */

/**
 * The page the reader asked for, in the terms the gesture actually expressed.
 *
 * `'left'`/`'right'` come from a horizontal gesture and are SPATIAL —
 * `'right'` means "show me the page to the right", which is what a positive
 * `deltaX` asks for, because scrolling right moves the viewport rightwards over
 * the content. It is not the direction the fingers moved; with natural
 * scrolling on, those are opposites.
 *
 * `'next'`/`'prev'` come from a vertical gesture and are LOGICAL. Scrolling
 * down is "further into the book" whatever direction it is written in.
 *
 * Four values rather than two because the caller maps each to a different
 * foliate method, and flattening them would need this module to know the book's
 * reading direction — which is the thing it is deliberately staying out of.
 */
export type PageIntent = 'left' | 'right' | 'next' | 'prev'

/** The parts of a `WheelEvent` this reads. */
export interface WheelSample {
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaMode: number
  /** A trackpad PINCH arrives as a wheel event with this set — see below. */
  readonly ctrlKey: boolean
}

export interface WheelPagerOptions {
  /** Normalised pixels of horizontal travel before a page turns. */
  readonly threshold?: number
  /** Silence that ends a gesture. Must outlast macOS's momentum tail. */
  readonly quietMs?: number
}

export interface WheelPager {
  /**
   * Feed one wheel event, with the time it arrived.
   *
   * Returns a direction at the moment a gesture crosses the threshold, and null
   * every other time — including for every event of the momentum tail that
   * follows it.
   */
  feed: (sample: WheelSample, at: number) => PageIntent | null
}

/**
 * Travel needed to turn a page.
 *
 * 40 rather than something larger because ONE MOUSE NOTCH must turn one page,
 * which is what Apple Books does and what a reader with a mouse expects. A
 * notch is about 40px in pixel-mode browsers and three lines — 48px here — in
 * line-mode ones, so a higher threshold would silently require two notches per
 * page on some machines and one on others.
 *
 * A trackpad flick accumulates hundreds of pixels, so this is nowhere near the
 * boundary there; what it does cost is sensitivity to a small stray movement,
 * which the dominant-axis rule and one-turn-per-gesture both bound.
 *
 * Still a guess that needs a hand on real hardware — macOS and a Windows
 * precision touchpad report very different magnitudes for the same motion, and
 * no unit test can settle which number feels right. It is one constant, and an
 * option, so that tuning it is one edit.
 */
export const DEFAULT_THRESHOLD = 40

/**
 * How long silence must last for the next event to be a NEW gesture.
 *
 * The load-bearing constant. macOS keeps emitting decaying `deltaX` for roughly
 * a second after the fingers leave, so this cannot simply be "any gap" — but it
 * also must not be so long that a deliberate second flick is swallowed. 120ms is
 * far shorter than a momentum tail and far longer than the ~8ms between events
 * inside one.
 */
export const DEFAULT_QUIET_MS = 120

/** A line, in pixels, for `deltaMode: 1`. Matches the browsers' own default. */
const LINE_PX = 16
/** A page, for `deltaMode: 2`. Deliberately coarse — this is a rare mode. */
const PAGE_PX = 400

/**
 * A flick during a momentum tail must still register.
 *
 * Momentum only ever DECAYS, so a magnitude that jumps clear of the previous
 * one is a new push rather than a continuation. Requiring both a large ratio
 * and an absolute floor keeps jitter at the end of a tail — where magnitudes
 * are tiny and noisy — from reading as a new gesture.
 */
const REARM_RATIO = 2
/**
 * Absolute floor for a magnitude re-arm.
 *
 * Capped by the caller's own threshold, because a fixed 12 outranked it: with
 * `threshold: 10` an 11-pixel flick was enough to turn a page but not enough to
 * re-arm, so the second one in a row was silently dropped. A floor above the
 * bar it is guarding cannot be right at any value.
 */
const REARM_MIN = 12

/**
 * A gap that means the reader did something new, rather than physics continuing.
 *
 * Momentum is emitted per frame — 8 to 16ms apart — and so is a finger still on
 * the trackpad. A mouse notch is neither: rolling the wheel quickly puts 30 to
 * 60ms between notches, which is far longer than a frame and far shorter than
 * the quiet period.
 *
 * Without this, a second identical notch 50ms after the first was swallowed: not
 * quiet enough to be a new gesture, and not twice the magnitude of the one
 * before it, so a reader spinning the wheel got exactly one page.
 */
const NOTCH_GAP_MS = 32

/** Normalise a delta to pixels, whatever unit the platform reports it in. */
function pixels(delta: number, mode: number): number {
  if (mode === 1) return delta * LINE_PX
  if (mode === 2) return delta * PAGE_PX
  // Mode 0, and anything unrecognised. Treating an unknown mode as pixels
  // under-reads rather than over-reads, which fails towards doing nothing.
  return delta
}

export function wheelPager({
  threshold = DEFAULT_THRESHOLD,
  quietMs = DEFAULT_QUIET_MS,
}: WheelPagerOptions = {}): WheelPager {
  /** See `REARM_MIN` — never above the bar a page turn itself has to clear. */
  const rearmMin = Math.min(REARM_MIN, threshold)
  /** Signed horizontal travel accumulated in the current gesture. */
  let travel = 0
  /** When the last counted event arrived. */
  let lastAt = Number.NEGATIVE_INFINITY
  /** Magnitude of the last counted event, for the momentum test above. */
  let lastMagnitude = 0
  /** This gesture has already turned a page. */
  let turned = false
  /** A sample since the turn was SMALLER than the one before it — see below. */
  let decayed = false
  /** Which axis the current gesture is on, or null between gestures. */
  let axis: 'x' | 'y' | null = null

  const begin = () => {
    travel = 0
    turned = false
    decayed = false
    lastMagnitude = 0
    axis = null
  }

  return {
    feed: (sample, at) => {
      /* A trackpad PINCH is delivered as a wheel event with ctrlKey set. Without
       * this, pinching to zoom a PDF page would flip through the book. */
      if (sample.ctrlKey) return null

      const dx = pixels(sample.deltaX, sample.deltaMode)
      const dy = pixels(sample.deltaY, sample.deltaMode)

      /* The DOMINANT axis drives the gesture, and an exact tie does nothing —
       * a diagonal resolved on the sign of a rounding error would turn pages
       * unpredictably. Both axes page in paged flow, so this is choosing which
       * KIND of intent the gesture expresses, not whether it counts. */
      const horizontal = Math.abs(dx) > Math.abs(dy)
      const vertical = Math.abs(dy) > Math.abs(dx)
      if (!horizontal && !vertical) {
        /* A tie resolves to no direction — but it is still the reader moving,
         * and returning without recording that made a continuous diagonal look
         * like SILENCE. A steady stream of equal deltas would then satisfy the
         * quiet period, and the next small horizontal pair would turn a page
         * with no real gap before it. */
        if (dx !== 0 || dy !== 0) lastAt = at
        return null
      }

      const delta = horizontal ? dx : dy
      const magnitude = Math.abs(delta)
      const onAxis: 'x' | 'y' = horizontal ? 'x' : 'y'

      /* EVERY reason to start a new gesture is decided before the axis is
       * committed, because `begin` clears it — an earlier arrangement set the
       * axis first and then reset it, so a gesture that began after a quiet
       * period reached the return below with no axis at all.
       *
       * An axis change is one of those reasons: accumulating a vertical push
       * into a horizontal gesture's travel would let a small movement in each
       * direction add up to a page turn nobody asked for. */
      /* Backwards counts as a new gesture. A caller feeding a per-document
       * `event.timeStamp` would jump the clock back at every section boundary,
       * and a negative gap satisfies no upper bound — so the gesture would
       * never end. The session feeds a host-realm clock precisely so this
       * cannot happen; this is the belt to that pair of braces, and it costs a
       * comparison. */
      const quiet = at - lastAt > quietMs || at < lastAt
      /* A rise clear of the decay means the reader flicked again before the
       * previous gesture's tail ran out. Only checked once a page has already
       * turned — before that the gesture is still accumulating and a larger
       * event is simply a faster finger. */
      const gap = at - lastAt
      /* Momentum both DECAYS and arrives every frame. Two separate shapes of
       * "the reader pushed again" fall out of that, and each catches a case the
       * other misses:
       *
       *   a magnitude clear of the decay — a hard flick landing mid-tail;
       *   a gap longer than a frame with no decay — a discrete wheel notch.
       *
       * The second requires BOTH conditions. A gap alone would re-arm on a
       * momentum tail delivered late by a busy main thread; a non-decaying
       * magnitude alone would re-arm on the ordinary jitter of a finger still
       * moving. */
      /* The magnitude re-arm waits for DECAY to have been seen first.
       *
       * Without that it fired on an accelerating swipe: 10, 10, 20, 45 pixels
       * eight milliseconds apart is one finger speeding up, and the jump from 20
       * to 45 read as a fresh flick — so a single gesture turned two pages. What
       * distinguishes a real second flick is that the first one's momentum was
       * already dying when it arrived, so that is what is now required. A
       * gesture still accelerating has never decayed and cannot re-arm. */
      const flickedAgain =
        turned && decayed && magnitude > lastMagnitude * REARM_RATIO && magnitude >= rearmMin
      /* A DISCRETE mode needs no magnitude test at all. Momentum is a pixel-mode
       * phenomenon — a platform reporting lines or pages emits one event per
       * physical notch and never a tail — so there is nothing there to mistake a
       * notch for, and a gap is proof enough on its own. Requiring a
       * non-decreasing magnitude swallowed a perfectly ordinary decelerating
       * roll: 4, 3, 2.5 lines at 50ms turned one page instead of three. */
      const discrete = sample.deltaMode !== 0
      const notched = turned && gap >= NOTCH_GAP_MS && (discrete || magnitude >= lastMagnitude)

      /* An axis change restarts the TRAVEL but must not clear `turned`. Clearing
       * it let one diagonal flick fire twice — 40px of x and then 40px of y,
       * eight milliseconds apart, turned two pages. */
      const changedAxis = axis !== null && axis !== onAxis
      if (quiet || flickedAgain || notched) begin()
      else if (changedAxis) travel = 0

      /* Recorded BEFORE `lastMagnitude` is overwritten, and only once a page has
       * turned — before that the gesture is still accumulating and a smaller
       * sample is just an uneven finger, not a tail. */
      if (turned && magnitude < lastMagnitude) decayed = true

      axis = onAxis
      lastAt = at
      lastMagnitude = magnitude
      travel += delta

      if (turned || Math.abs(travel) < threshold) return null

      /* One turn per gesture. A sustained drag does not page repeatedly — that
       * reads as the book running away from the reader, and "swipe" means one
       * discrete movement. The next turn needs either silence or a new flick. */
      turned = true
      /* Horizontal is spatial and vertical is logical — see the header. A
       * vertical gesture routed through left/right would reverse the mouse
       * wheel in a right-to-left book. */
      if (axis === 'x') return travel > 0 ? 'right' : 'left'
      return travel > 0 ? 'next' : 'prev'
    },
  }
}
