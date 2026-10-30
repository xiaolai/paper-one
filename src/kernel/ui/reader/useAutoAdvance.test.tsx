// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { StepPace } from '../../core/autoAdvance'
import { useAutoAdvance, type AutoAdvance, type AutoAdvanceDeps } from './useAutoAdvance'

/**
 * The book turning itself.
 *
 * ⚠️ **THESE CASES DRIVE A REAL TIMER THROUGH FAKE TIME**, because every
 * interesting property of this hook is about WHEN — that a tick re-derives the
 * pace rather than keeping the first one, that the end of the book stops it, and
 * that nothing fires after unmount. A case that only called `start` and read
 * `advancing` would pass against a hook that never ticks at all.
 *
 * ⚠️ **AND `advanceTimersByTimeAsync`, NEVER `advanceTimersByTime`.** A step is
 * AWAITED now, so the next timeout is only scheduled once the turn's promise has
 * settled — a microtask the synchronous advance never reaches. With the
 * synchronous one every case here reports exactly one step however far time is
 * moved, which reads as a hook that stops after the first page.
 */

afterEach(cleanup)
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A section whose derived rest is a round hundred seconds a step. */
const TEN_SECONDS: StepPace = { bookWords: 250 * 10, sectionBytes: 100, spineBytes: 100, steps: 6 }

/** Move fake time, letting each awaited step settle and schedule the next. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function mount(over: Partial<AutoAdvanceDeps> = {}) {
  const steps: number[] = []
  const deps: { current: AutoAdvanceDeps } = {
    current: {
      step: () => {
        steps.push(Date.now())
        return Promise.resolve(true)
      },
      pace: () => TEN_SECONDS,
      speaking: false,
      onReader: true,
      generation: 1,
      ...over,
    },
  }
  const seen: { current: AutoAdvance | null } = { current: null }
  function Probe() {
    seen.current = useAutoAdvance(deps.current)
    return null
  }
  const view = render(<Probe />)
  /* Re-renders the SAME probe, so a change to `deps.current` is picked up. An
     earlier version rendered `<></>`, which unmounts it — and an unmounted hook
     stops for the wrong reason, so the case proved nothing. */
  const again = () => view.rerender(<Probe />)
  return { seen, steps, deps, view, again }
}

describe('useAutoAdvance', () => {
  it('is not advancing until it is asked', async () => {
    const { seen, steps } = mount()
    expect(seen.current!.advancing).toBe(false)
    await pass(60_000)
    expect(steps).toHaveLength(0)
  })

  it('steps at the derived pace, and keeps going', async () => {
    const { seen, steps } = mount()
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    expect(steps).toHaveLength(0)
    /* 250 words a minute over 2 500 words in 6 steps is ~100 s a step. */
    await pass(99_000)
    expect(steps).toHaveLength(0)
    await pass(2_000)
    expect(steps).toHaveLength(1)
    await pass(100_000)
    expect(steps).toHaveLength(2)
  })

  it('stops when told, and fires nothing afterwards', async () => {
    const { seen, steps } = mount()
    /* EXACT advances, no slack: the async advance fires anything scheduled at or
       before the target, so a spare second here shifts every later boundary and
       the case starts asserting the slack instead of the pace. */
    act(() => seen.current!.start())
    await pass(100_000)
    expect(steps).toHaveLength(1)
    act(() => seen.current!.stop())
    expect(seen.current!.advancing).toBe(false)
    await pass(600_000)
    expect(steps).toHaveLength(1)
  })

  it('toggles', () => {
    const { seen } = mount()
    act(() => seen.current!.toggle())
    expect(seen.current!.advancing).toBe(true)
    act(() => seen.current!.toggle())
    expect(seen.current!.advancing).toBe(false)
  })

  it('re-derives the pace on every tick, not once at the start', async () => {
    /* ⚠️ A rest derived once would keep a long chapter's pace through a
       two-page preface — and `renderer.pages` settles after layout, so the
       value read at start-up can be the wrong one outright.

       ⚠️ **ASSERTED ON THE GAPS BETWEEN STEPS, NOT ON TIMER BOUNDARIES.** An
       earlier version fenced exact advance totals and failed three times on
       off-by-one slack, which is the harness rather than the property: what this
       case is about is that consecutive rests DIFFER when the pace does.

       ONE stable `pace` whose ANSWER changes, which is how the host supplies
       it: a closure over live refs, not a new function per section. */
    let pace = { ...TEN_SECONDS }
    const { seen, steps } = mount({ pace: () => pace })
    act(() => seen.current!.start())

    /* 2 500 words over 6 steps at 250 a minute is 100 s a step. */
    await pass(250_000)
    expect(steps.length).toBeGreaterThanOrEqual(2)
    const slow = steps[1]! - steps[0]!
    expect(slow).toBe(100_000)

    /* The reader crosses into a section with four times the steps, so each one
       holds a quarter of the words. */
    pace = { ...TEN_SECONDS, steps: 24 }
    const before = steps.length
    await pass(250_000)
    expect(steps.length).toBeGreaterThan(before + 1)
    const fast = steps[steps.length - 1]! - steps[steps.length - 2]!
    expect(fast).toBe(25_000)
    expect(fast).toBeLessThan(slow)
  })

  it('stops when the pace stops being derivable under it', async () => {
    /* ⚠️ **THE ONE ROAD A CHECK IN `start` CANNOT COVER**, and the sweep reported
       it as reached by no test at all. A section whose geometry goes unreadable
       mid-book — `renderer.pages` between layouts — leaves the chain with no
       honest rest to wait, and inventing one is the thing this whole module
       refuses to do. The tick has to stop. */
    let pace: StepPace = { ...TEN_SECONDS }
    const { seen, steps } = mount({ pace: () => pace })
    act(() => seen.current!.start())
    await pass(100_000)
    expect(steps).toHaveLength(1)
    expect(seen.current!.advancing).toBe(true)

    pace = { ...TEN_SECONDS, bookWords: null }
    await pass(100_000)
    expect(seen.current!.advancing, 'it gave up rather than guessing a rest').toBe(false)
    await pass(600_000)
    expect(steps).toHaveLength(2)
  })

  it('stops at the end of the book, where a step moves nothing', async () => {
    /* ⚠️ Without this the book sits on its last page with the control still
       lit, which reads as a stall rather than an ending. */
    const tried: number[] = []
    let moved = true
    const { seen } = mount({
      step: () => {
        tried.push(1)
        const answer = moved
        moved = false
        return Promise.resolve(answer)
      },
    })
    act(() => seen.current!.start())
    await pass(101_000)
    expect(tried).toHaveLength(1)
    expect(seen.current!.advancing).toBe(true)

    /* The next step is the one that moves nothing. */
    await pass(101_000)
    expect(tried).toHaveLength(2)
    expect(seen.current!.advancing).toBe(false)

    await pass(600_000)
    expect(tried).toHaveLength(2)
  })

  it('does not advance while a reading is speaking, and leaves nothing armed', async () => {
    /* ⚠️ Read aloud already turns the page, so the two together would
       double-advance. Two paces on one book has no honest resolution. */
    /* ⚠️ **THE STOPPING IS THE EFFECT'S, NOT `start`'s.** `start` refused outright
       once; the sweep showed that mutant surviving, and `vi.getTimerCount()`
       cannot separate the two either, because the effect runs inside this same
       `act` and clears the timer before anything can look. So this measures the
       property that matters to a reader instead. */
    const { seen, steps } = mount({ speaking: true })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(false)
    expect(vi.getTimerCount(), 'nothing is left armed').toBe(0)
    await pass(300_000)
    expect(steps).toHaveLength(0)
  })

  it('gives the book up when a reading starts under it', async () => {
    const { seen, steps, deps, again } = mount()
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    deps.current = { ...deps.current, speaking: true }
    act(() => again())
    expect(seen.current!.advancing).toBe(false)
    await pass(300_000)
    expect(steps).toHaveLength(0)
  })

  it('is not offered where the pace cannot be derived', () => {
    /* Every PDF, and any book with a partial spine. The control is ABSENT
       rather than present and dead. */
    const { seen } = mount({ pace: () => ({ ...TEN_SECONDS, bookWords: null }) })
    expect(seen.current!.offered).toBe(false)
    expect(seen.current!.advancing).toBe(false)
  })

  it('does not advance where the pace cannot be derived', async () => {
    const { seen, steps } = mount({ pace: () => ({ ...TEN_SECONDS, bookWords: null }) })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(false)
    expect(vi.getTimerCount(), 'nothing is left armed').toBe(0)
    await pass(600_000)
    expect(steps).toHaveLength(0)
  })

  it('is offered where it can be derived', () => {
    const { seen } = mount()
    expect(seen.current!.offered).toBe(true)
    expect(seen.current!.reachable).toBe(true)
  })

  it('stays reachable while advancing, even once the pace goes unreadable', () => {
    /* ⚠️ **THE HALF THAT WAS MISSING, AND IT TOOK THE STOP CONTROL AWAY.** A
       section between layouts makes `offered` false; a host that read only that
       left a reader with a moving book and no row to press. `reachable` is what a
       host puts in front of them, and it lives in the hook because a rule spelled
       in `App` is a rule nothing measures. */
    let pace: StepPace = { ...TEN_SECONDS }
    const { seen, again } = mount({ pace: () => pace })
    act(() => seen.current!.start())
    pace = { ...TEN_SECONDS, bookWords: null }
    /* `offered` is computed during render, so it needs one — mutating the pace a
       closure reads changes nothing a host can see until React asks again. */
    act(() => again())
    expect(seen.current!.offered, 'no honest pace to offer').toBe(false)
    expect(seen.current!.advancing, 'but the book is still turning').toBe(true)
    expect(seen.current!.reachable, 'so Stop is still in front of the reader').toBe(true)
  })

  it('is not reachable when it is neither offered nor running', () => {
    const { seen } = mount({ onReader: false })
    expect(seen.current!.reachable).toBe(false)
  })

  it('is not offered while a reading is speaking', () => {
    /* ⚠️ THE ROW ITSELF, not only `start`. A visible control that declines
       teaches a reader the app cannot do this; the caller keeps `Stop` reachable
       from `advancing` instead. */
    const { seen } = mount({ speaking: true })
    expect(seen.current!.offered).toBe(false)
  })

  it('is not offered away from the book', () => {
    /* ⚠️ THE READER STAYS MOUNTED BEHIND EVERY OTHER SCREEN. Without this the
       palette started the book turning from the library — moving a book nobody
       could see and writing the reader's place in it. */
    const { seen } = mount({ onReader: false })
    expect(seen.current!.offered).toBe(false)
  })

  it('does not advance away from the book, and leaves nothing armed', async () => {
    const { seen, steps } = mount({ onReader: false })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(false)
    expect(vi.getTimerCount(), 'nothing is left armed').toBe(0)
    await pass(600_000)
    expect(steps).toHaveLength(0)
  })

  it('gives the book up when the reader leaves it', async () => {
    const { seen, steps, deps, again } = mount()
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    deps.current = { ...deps.current, onReader: false }
    act(() => again())
    expect(seen.current!.advancing).toBe(false)
    await pass(600_000)
    expect(steps).toHaveLength(0)
  })

  it('stops when another book is opened under it', async () => {
    /* ⚠️ **THE CASE THE UNMOUNT TEARDOWN COULD NOT REACH.** This hook lives in
       `App`, which never unmounts while the app is open, so a chain started on
       one book went on turning the pages of the next one — unasked, with the
       control still reading *Stop*. */
    const { seen, steps, deps, again } = mount()
    act(() => seen.current!.start())
    await pass(100_000)
    expect(steps).toHaveLength(1)
    deps.current = { ...deps.current, generation: 2 }
    act(() => again())
    expect(seen.current!.advancing).toBe(false)
    await pass(600_000)
    expect(steps).toHaveLength(1)
  })

  it('fires nothing after the component goes', async () => {
    /* ⚠️ Without the teardown, closing a book leaves a chain of timeouts
       calling `step` on a view that is gone. */
    const { seen, steps, view } = mount()
    act(() => seen.current!.start())
    act(() => view.unmount())
    await pass(600_000)
    expect(steps).toHaveLength(0)
  })

  it('a second start does not leave two chains running', async () => {
    const { seen, steps } = mount()
    act(() => seen.current!.start())
    act(() => seen.current!.start())
    await pass(101_000)
    expect(steps).toHaveLength(1)
  })

  it('does not schedule another step when it is stopped mid-turn', async () => {
    /* ⚠️ **THE AWAIT IS A WINDOW THE OLD SHAPE DID NOT HAVE.** A turn takes a
       few hundred milliseconds; a stop inside that window used to be followed by
       the resolution scheduling the next step, so the book kept turning after
       the reader said to stop. The chain identity is what closes it. */
    let settle: ((moved: boolean) => void) | null = null
    const tried: number[] = []
    const { seen } = mount({
      step: () => {
        tried.push(1)
        return new Promise<boolean>((resolve) => {
          settle = resolve
        })
      },
    })
    act(() => seen.current!.start())
    await pass(100_000)
    expect(tried).toHaveLength(1)
    expect(settle).not.toBeNull()

    act(() => seen.current!.stop())
    /* The turn lands AFTER the stop, reporting that it moved. */
    await act(async () => {
      settle!(true)
      await Promise.resolve()
    })
    await pass(600_000)
    expect(tried).toHaveLength(1)
    expect(seen.current!.advancing).toBe(false)
  })

  it('stops when a step rejects, rather than leaving a rejection at the window', async () => {
    /* ⚠️ This runs inside a timer callback, where nothing is listening. A
       `.then` with no rejection handler makes an unhandled rejection of a step
       that failed, and the chain would sit there having scheduled nothing. */
    const { seen } = mount({ step: () => Promise.reject(new Error('the view went')) })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    await pass(101_000)
    expect(seen.current!.advancing).toBe(false)
  })

  it('stops when a step throws where it stands', async () => {
    /* A host whose `step` is not itself `async` — the shape every navigator fake
       in these suites has had. A synchronous throw escapes the timer callback
       altogether unless it is caught there. */
    const { seen } = mount({
      step: () => {
        throw new TypeError('pace is not a function')
      },
    })
    act(() => seen.current!.start())
    await pass(101_000)
    expect(seen.current!.advancing).toBe(false)
  })

  it('stops when a step rejects, rather than leaving a rejection at the window', async () => {
    /* ⚠️ This runs inside a timer callback, where nothing is listening. A `.then`
       with no rejection handler makes an unhandled rejection of a step that
       failed, and the chain would sit there having scheduled nothing. */
    const { seen } = mount({ step: () => Promise.reject(new Error('the view went')) })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    await pass(101_000)
    expect(seen.current!.advancing).toBe(false)
  })

  it('stops when a step throws where it stands', async () => {
    /* A host whose `step` is not itself `async` — the shape every navigator fake in
       these suites has had. A synchronous throw escapes the timer callback
       altogether unless it is caught there. */
    const { seen } = mount({
      step: () => {
        throw new TypeError('pace is not a function')
      },
    })
    act(() => seen.current!.start())
    await pass(101_000)
    expect(seen.current!.advancing).toBe(false)
  })

  it('does not schedule another step when the book changes mid-turn', async () => {
    /* ⚠️ **THE SAME WINDOW, WITH A BOOK CHANGE RATHER THAN A STOP — AND THE
       FIRST VERSION OF THIS ASSERTED NOTHING.** It was the tail of the case
       above, where the chain had already stopped and its turn had already
       settled, so it passed with no generation handling at all. The verification
       pass named it. Here the generation moves while the turn is still in
       flight, which is the state that actually needs the identity check: the
       reader opens another book during a page turn, and the turn then reports
       that it moved — of a book nobody is looking at any more. */
    let settle: ((moved: boolean) => void) | null = null
    const tried: number[] = []
    const { seen, deps, again } = mount({
      step: () => {
        tried.push(1)
        return new Promise<boolean>((resolve) => {
          settle = resolve
        })
      },
    })
    act(() => seen.current!.start())
    await pass(100_000)
    expect(tried).toHaveLength(1)
    expect(seen.current!.advancing).toBe(true)

    /* Another book, while the turn is still unsettled. */
    deps.current = { ...deps.current, generation: 2 }
    act(() => again())
    expect(seen.current!.advancing).toBe(false)
    await act(async () => {
      settle!(true)
      await Promise.resolve()
    })
    await pass(600_000)
    expect(tried, 'the settled turn scheduled nothing for the new book').toHaveLength(1)
  })
})
