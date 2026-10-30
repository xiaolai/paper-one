import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUIET_MS,
  DEFAULT_THRESHOLD,
  wheelPager,
  type PageIntent,
  type WheelSample,
} from './wheelPaging'

/**
 * The gesture, against the matrix written before any of it existed.
 *
 * Time is a parameter rather than a clock, so a momentum tail that takes a real
 * second to play out takes none here. What CANNOT be tested at this level is
 * whether the threshold feels right on actual hardware — macOS and a Windows
 * precision touchpad report very different magnitudes for the same movement —
 * and that is recorded as needing a person rather than left looking covered.
 */

const wheel = (over: Partial<WheelSample> = {}): WheelSample => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  ...over,
})

/** A flick: one hard push, then macOS's decaying tail at ~8ms intervals. */
function flick(dx: number, from = 0): { sample: WheelSample; at: number }[] {
  const events = [{ sample: wheel({ deltaX: dx }), at: from }]
  let magnitude = Math.abs(dx) * 0.8
  let at = from
  const sign = Math.sign(dx)
  // Momentum only ever decays — the property the detector leans on.
  while (magnitude > 0.4) {
    at += 8
    events.push({ sample: wheel({ deltaX: sign * magnitude }), at })
    magnitude *= 0.85
  }
  return events
}

/** Every direction a run of events produced. */
function run(
  detector: ReturnType<typeof wheelPager>,
  events: { sample: WheelSample; at: number }[],
): PageIntent[] {
  const out: PageIntent[] = []
  for (const { sample, at } of events) {
    const d = detector.feed(sample, at)
    if (d) out.push(d)
  }
  return out
}

describe('1 · gesture segmentation', () => {
  it('1.1 — one flick turns exactly one page, tail included', () => {
    const d = wheelPager()
    const events = flick(120)
    expect(events.length).toBeGreaterThan(10) // a real tail, not two events
    expect(run(d, events)).toEqual(['right'])
  })

  it('1.2 — two deliberate flicks turn two pages', () => {
    const d = wheelPager()
    const first = flick(120, 0)
    const gap = (first.at(-1)?.at ?? 0) + DEFAULT_QUIET_MS + 50
    expect(run(d, [...first, ...flick(120, gap)])).toEqual(['right', 'right'])
  })

  /* CHANGED FROM THE MATRIX, which said three turns for a drag past 3× the
   * threshold. Implementing it made the row look wrong: a sustained drag paging
   * repeatedly reads as the book running away from the reader, and "swipe"
   * describes one discrete movement. One turn per gesture; the next needs
   * silence or a new flick. */
  it('1.3 — a sustained drag turns one page, not three', () => {
    const d = wheelPager()
    const events = Array.from({ length: 60 }, (_, i) => ({
      sample: wheel({ deltaX: 5 }), // 300px total, over seven times the threshold
      at: i * 8,
    }))
    expect(run(d, events)).toEqual(['right'])
  })

  it('1.4 — out and back turns nothing: travel is net, not total', () => {
    const d = wheelPager()
    // Each leg stays under the threshold; together they travel well over it,
    // so summing distance rather than displacement would turn a page here.
    const leg = Math.floor(DEFAULT_THRESHOLD * 0.75)
    const step = leg / 8
    const out = Array.from({ length: 8 }, (_, i) => ({ sample: wheel({ deltaX: step }), at: i * 8 }))
    const back = Array.from({ length: 8 }, (_, i) => ({
      sample: wheel({ deltaX: -step }),
      at: 64 + i * 8,
    }))
    expect(leg * 2).toBeGreaterThan(DEFAULT_THRESHOLD)
    expect(run(d, [...out, ...back])).toEqual([])
  })

  it('1.5 — travel below the threshold turns nothing', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: DEFAULT_THRESHOLD - 1 }), 0)).toBeNull()
  })

  /* The reason a quiet period alone is not enough. Flicking again while the
   * previous tail is still arriving keeps `lastAt` fresh, so nothing is ever
   * quiet — and fast page-turning would stop after the first page. */
  it('1.6 — a flick during the previous tail still registers', () => {
    const d = wheelPager()
    const first = flick(120, 0)
    const tail = first.slice(0, 5)
    expect(run(d, tail)).toEqual(['right'])

    /* Now flick again while that tail is still arriving. The gap is far inside
     * the quiet period, so the ONLY thing that can let this through is the
     * rise-above-the-decay test — which is the point of the case. */
    const last = tail.at(-1)
    const at = (last?.at ?? 0) + 8
    expect(at - (last?.at ?? 0)).toBeLessThan(DEFAULT_QUIET_MS)
    expect(Math.abs(last?.sample.deltaX ?? 0)).toBeLessThan(120 / 2) // decayed

    expect(d.feed(wheel({ deltaX: 120 }), at)).toBe('right')
  })
})

describe('found by audit', () => {
  /* A reader spinning a mouse wheel got exactly ONE page. The second notch was
   * neither quiet (50ms < 120ms) nor twice the magnitude of the first, so it
   * looked like momentum and was swallowed. A notch is neither: momentum both
   * decays and arrives every frame, and this arrives later and undiminished. */
  it('turns a page per notch when the wheel is spun quickly', () => {
    const d = wheelPager()
    const notch = wheel({ deltaY: 3, deltaMode: 1 })
    expect(d.feed(notch, 0)).toBe('next')
    expect(d.feed(notch, 50)).toBe('next')
    expect(d.feed(notch, 100)).toBe('next')
  })

  /* And a momentum tail delivered LATE by a busy main thread must still not
   * re-arm — which is why the notch test needs a non-decaying magnitude as well
   * as a gap, rather than a gap alone. */
  it('still refuses a late momentum sample', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 100 }), 0)).toBe('right')
    // 40ms late, but decayed — physics, not a finger.
    expect(d.feed(wheel({ deltaX: 30 }), 40)).toBeNull()
  })

  /* One diagonal flick fired TWICE: 40px of x, then 40px of y eight
   * milliseconds later, because an axis change cleared the turn lock. */
  it('does not fire twice for one diagonal flick', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 40 }), 0)).toBe('right')
    expect(d.feed(wheel({ deltaY: 40 }), 8)).toBeNull()
  })

  /* A continuous diagonal has no dominant axis, so every sample was discarded
   * WITHOUT recording that anything happened — and a steady stream of them
   * therefore satisfied the quiet period. Two small horizontal samples could
   * then turn a page with no real gap before them. */
  it('counts a tied sample as activity, not as silence', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 100 }), 0)).toBe('right')
    for (let at = 8; at <= 200; at += 8) d.feed(wheel({ deltaX: 5, deltaY: 5 }), at)
    // The gesture never went quiet, so this must not start a new one.
    expect(d.feed(wheel({ deltaX: 20 }), 208)).toBeNull()
  })
})

describe('the clock', () => {
  /* The bug this guards, found while auditing rather than by use: the session
   * originally fed `event.timeStamp`, which is relative to the event's OWN
   * global's time origin — and every spine item is a separate iframe with a
   * separate origin. The pager is per-session on purpose, so a gesture spanning
   * a section boundary mixed two scales.
   *
   * Turning a page at a boundary loads a new document; the momentum tail lands
   * in THAT document, whose timestamps start near zero while the previous
   * document's were large. The gap goes hugely negative, satisfies no upper
   * bound, and the gesture never ends — so the `turned` lock is held forever
   * and the next deliberate swipe does nothing.
   *
   * The session feeds a host-realm clock now, which cannot go backwards. This
   * is the detector refusing to be broken by a caller that gets it wrong. */
  it('treats a clock that jumps backwards as a new gesture', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 100 }), 30_000)).toBe('right')
    // A new document's clock, starting near its own origin.
    expect(d.feed(wheel({ deltaX: 100 }), 12)).toBe('right')
  })

  /* REPLACED a vacuous one. Its middle event rewrote `lastAt` to 5, so the
   * final event at 200 was quiet by an ordinary forward gap and the test passed
   * with or without the guard it claimed to exercise.
   *
   * This asserts the property that actually matters: after a backwards jump the
   * detector is usable again IMMEDIATELY, rather than holding the `turned` lock
   * against a clock it can never catch up with. */
  it('is usable again immediately after a backwards jump', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 100 }), 30_000)).toBe('right')
    // A new document's clock. Every subsequent event is still behind 30000.
    expect(d.feed(wheel({ deltaX: 100 }), 10)).toBe('right')
    expect(d.feed(wheel({ deltaX: 100 }), 400)).toBe('right')
  })
})

describe('2 · axis and units', () => {
  /* CHANGED: this row said a vertical gesture turns nothing. It now pages, the
   * way Apple Books does — in paged flow there is no vertical scroll for it to
   * compete with. The DOMINANT axis decides, so a mostly-vertical gesture is a
   * vertical one. */
  it('2.1 — a vertical gesture pages, and does so logically', () => {
    const d = wheelPager()
    // Down is further into the book, whichever direction it is written in.
    expect(d.feed(wheel({ deltaX: 2, deltaY: 60 }), 0)).toBe('next')
    expect(wheelPager().feed(wheel({ deltaX: 2, deltaY: -60 }), 0)).toBe('prev')
  })

  /* The distinction the four-valued intent exists for. A horizontal gesture is
   * SPATIAL and must be resolved against the book's direction by foliate; a
   * vertical one is LOGICAL and must not be, or the mouse wheel would run
   * backwards in a right-to-left book. */
  it('2.1b — the two axes produce different KINDS of intent', () => {
    expect(wheelPager().feed(wheel({ deltaX: 60 }), 0)).toBe('right')
    expect(wheelPager().feed(wheel({ deltaY: 60 }), 0)).toBe('next')
  })

  /* One notch of a mouse wheel is one page — Apple Books' behaviour, and what
   * the threshold is set at 40 to allow. Both spellings of a notch. */
  it('2.1c — one mouse notch turns one page, in either delta mode', () => {
    expect(wheelPager().feed(wheel({ deltaY: 40 }), 0)).toBe('next')
    expect(wheelPager().feed(wheel({ deltaY: 3, deltaMode: 1 }), 0)).toBe('next')
  })

  /* Mixing axes must not accumulate into a turn nobody asked for. */
  it('2.1d — an axis change restarts the gesture rather than adding to it', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 30 }), 0)).toBeNull() // under the threshold
    expect(d.feed(wheel({ deltaY: 30 }), 8)).toBeNull() // a different axis
    // 30 + 30 would clear 40 if they had been summed. They are not.
  })

  it('2.2 — an exact diagonal turns nothing rather than guessing', () => {
    const d = wheelPager()
    const events = Array.from({ length: 40 }, (_, i) => ({
      sample: wheel({ deltaX: 10, deltaY: 10 }),
      at: i * 8,
    }))
    // Neither axis dominates; resolving it on a rounding error would page
    // unpredictably, so it does nothing at all.
    expect(run(d, events)).toEqual([])
  })

  it('2.3 — a zero delta is inert and produces no NaN', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 0, deltaY: 0 }), 0)).toBeNull()
    expect(d.feed(wheel({ deltaX: DEFAULT_THRESHOLD + 1 }), 8)).toBe('right')
  })

  /* A tilt-wheel mouse reports LINES and a trackpad reports pixels. Without
   * normalising, one threshold means wildly different physical movements. */
  it('2.4 — lines and pages normalise to comparable travel', () => {
    // 5 lines at 16px = 80px, well over the threshold.
    expect(wheelPager().feed(wheel({ deltaX: 5, deltaMode: 1 }), 0)).toBe('right')
    // But 2 lines = 32px is not.
    expect(wheelPager().feed(wheel({ deltaX: 2, deltaMode: 1 }), 0)).toBeNull()
    // One page is unambiguous.
    expect(wheelPager().feed(wheel({ deltaX: 1, deltaMode: 2 }), 0)).toBe('right')
  })

  it('2.5 — an unrecognised deltaMode is treated as pixels, never throws', () => {
    const d = wheelPager()
    expect(() => d.feed(wheel({ deltaX: 5, deltaMode: 99 }), 0)).not.toThrow()
    expect(d.feed(wheel({ deltaX: DEFAULT_THRESHOLD, deltaMode: 99 }), 8)).toBe('right')
  })

  /* The one most easily missed. A trackpad PINCH is delivered as a wheel event
   * with ctrlKey set — without this, pinching to zoom a PDF flips the book. */
  it('2.6 — a pinch never turns a page', () => {
    const d = wheelPager()
    const events = Array.from({ length: 40 }, (_, i) => ({
      sample: wheel({ deltaX: 30, ctrlKey: true }),
      at: i * 8,
    }))
    expect(run(d, events)).toEqual([])
  })
})

describe('direction', () => {
  /* Named for the page asked for, not the fingers. A positive deltaX is a
   * request to move the viewport rightwards over the content. */
  it('maps a positive delta to the page on the right, and back', () => {
    expect(wheelPager().feed(wheel({ deltaX: 100 }), 0)).toBe('right')
    expect(wheelPager().feed(wheel({ deltaX: -100 }), 0)).toBe('left')
  })

  /* 3.5 — RTL is NOT resolved here. foliate publishes `goLeft`/`goRight`, which
   * map a visual direction onto next/prev through the book's own `dir`, so
   * deciding it here would be a second opinion about something the renderer
   * already knows. This asserts the detector stays out of it: the same delta
   * gives the same answer whatever the book. */
  it('does not know or care about reading direction', () => {
    expect(wheelPager().feed(wheel({ deltaX: 100 }), 0)).toBe('right')
    expect(wheelPager().feed(wheel({ deltaX: 100 }), 0)).toBe('right')
  })
})

/**
 * 4 · lifecycle — a detector is DISCARDED, never reset.
 *
 * There used to be a `reset()` here, and two tests for it, and no caller. The
 * session builds one pager per session and a session is never reused for a
 * second book, so the state a reset would have cleared goes out of scope with
 * the book that produced it. An untested-in-anger method kept alive by its own
 * tests is worse than no method: it reads as a supported way to reuse a
 * detector, which nothing does and nothing has ever exercised.
 *
 * The lifetime is asserted at the session instead — `session.test.ts` proves a
 * disposed session stops feeding the pager at all.
 */
describe('4 · lifecycle', () => {
  it('is per-book by construction: a fresh detector carries nothing over', () => {
    const first = wheelPager()
    run(first, flick(120))

    const second = wheelPager()
    const half = DEFAULT_THRESHOLD * 0.6 // under the threshold on its own
    expect(second.feed(wheel({ deltaX: half }), 0)).toBeNull()
  })
})

describe('the thresholds are configurable, because they need tuning', () => {
  it('honours a caller that wants a different threshold', () => {
    const d = wheelPager({ threshold: 10 })
    expect(d.feed(wheel({ deltaX: 11 }), 0)).toBe('right')
  })

  it('honours a caller that wants a different quiet period', () => {
    const d = wheelPager({ quietMs: 1 })
    expect(d.feed(wheel({ deltaX: 100 }), 0)).toBe('right')
    // 2ms of silence is a new gesture at this setting.
    expect(d.feed(wheel({ deltaX: 100 }), 3)).toBe('right')
  })
})

/**
 * What the audit found: two shapes of input the momentum heuristics misread.
 *
 * Both are cases where "did the reader push again?" was answered from magnitude
 * alone. Magnitude is evidence about a TAIL, and neither of these is one.
 */
describe('a gesture that speeds up is still one gesture', () => {
  /* An accelerating swipe: 10, 10, 20, 45 pixels, eight milliseconds apart. The
   * jump from 20 to 45 clears the re-arm ratio, so before the decay
   * requirement this turned two pages from one flick of the fingers. */
  it('does not re-arm on acceleration', () => {
    const d = wheelPager()
    const turns = [10, 10, 20, 45]
      .map((deltaX, i) => d.feed(wheel({ deltaX }), i * 8))
      .filter(Boolean)
    expect(turns).toEqual(['right'])
  })

  /* The case the re-arm exists for, which must keep working: a real second
   * flick lands after the first one's momentum has begun to fall away. */
  it('still re-arms for a genuine flick during a decaying tail', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 60 }), 0)).toBe('right')
    d.feed(wheel({ deltaX: 30 }), 8) // decaying — momentum
    d.feed(wheel({ deltaX: 14 }), 16)
    expect(d.feed(wheel({ deltaX: 90 }), 24)).toBe('right')
  })
})

describe('a discrete wheel is not a trackpad', () => {
  /* Line-mode deltas 4, 3, 2.5 at 50ms — an ordinary decelerating roll of a
   * mouse wheel. Requiring a non-decreasing magnitude read the second and third
   * notches as momentum and turned one page instead of three. Momentum is a
   * pixel-mode phenomenon; a line-mode platform emits one event per notch. */
  it('turns a page per notch even as the roll slows', () => {
    const d = wheelPager()
    const turns = [4, 3, 2.5]
      .map((deltaX, i) => d.feed(wheel({ deltaX, deltaMode: 1 }), i * 50))
      .filter(Boolean)
    expect(turns).toEqual(['right', 'right', 'right'])
  })

  /* The pixel-mode contract is unchanged: there, a shrinking magnitude at a
   * notch-sized gap really can be a momentum sample delivered late. */
  it('leaves the pixel-mode rule alone', () => {
    const d = wheelPager()
    expect(d.feed(wheel({ deltaX: 64 }), 0)).toBe('right')
    expect(d.feed(wheel({ deltaX: 40 }), 50)).toBeNull()
  })
})

describe('the re-arm floor never outranks the caller', () => {
  /* `REARM_MIN` is 12 and this caller turns a page at 10, so a fixed floor made
   * the second flick of a pair unable to re-arm — a bar above the one it guards. */
  it('honours a threshold below the built-in floor', () => {
    const d = wheelPager({ threshold: 10 })
    expect(d.feed(wheel({ deltaX: 11 }), 0)).toBe('right')
    d.feed(wheel({ deltaX: 5 }), 8) // decay, so a re-arm is credible
    expect(d.feed(wheel({ deltaX: 11 }), 16)).toBe('right')
  })
})
