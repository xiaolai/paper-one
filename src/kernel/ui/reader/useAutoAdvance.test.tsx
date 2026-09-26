// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useAutoAdvance, type AutoAdvance, type AutoAdvanceDeps } from './useAutoAdvance'

/**
 * The book turning itself.
 *
 * ⚠️ **THESE CASES DRIVE A REAL TIMER THROUGH FAKE TIME**, because every
 * interesting property of this hook is about WHEN — that a tick re-derives the
 * pace rather than keeping the first one, that the end of the book stops it, and
 * that nothing fires after unmount. A case that only called `start` and read
 * `advancing` would pass against a hook that never ticks at all.
 */

afterEach(cleanup)
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A section whose derived rest is a round ten seconds a step. */
const TEN_SECONDS = { bookWords: 250 * 10, sectionBytes: 100, spineBytes: 100, steps: 6 }

function mount(over: Partial<AutoAdvanceDeps> = {}) {
  const steps: number[] = []
  const deps: { current: AutoAdvanceDeps } = {
    current: {
      step: () => {
        steps.push(Date.now())
        return true
      },
      pace: () => TEN_SECONDS,
      speaking: false,
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
  it('is not advancing until it is asked', () => {
    const { seen, steps } = mount()
    expect(seen.current!.advancing).toBe(false)
    act(() => void vi.advanceTimersByTime(60_000))
    expect(steps).toHaveLength(0)
  })

  it('steps at the derived pace, and keeps going', () => {
    const { seen, steps } = mount()
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    expect(steps).toHaveLength(0)
    /* 250 words a minute over 2 500 words in 6 steps is ~100 s a step. */
    act(() => void vi.advanceTimersByTime(99_000))
    expect(steps).toHaveLength(0)
    act(() => void vi.advanceTimersByTime(2_000))
    expect(steps).toHaveLength(1)
    act(() => void vi.advanceTimersByTime(100_000))
    expect(steps).toHaveLength(2)
  })

  it('stops when told, and fires nothing afterwards', () => {
    const { seen, steps } = mount()
    /* EXACT advances, no slack: `advanceTimersByTime` fires anything scheduled
       at or before the target, so a spare second here shifts every later
       boundary and the case starts asserting the slack instead of the pace. */
    act(() => seen.current!.start())
    act(() => void vi.advanceTimersByTime(100_000))
    expect(steps).toHaveLength(1)
    act(() => seen.current!.stop())
    expect(seen.current!.advancing).toBe(false)
    act(() => void vi.advanceTimersByTime(600_000))
    expect(steps).toHaveLength(1)
  })

  it('toggles', () => {
    const { seen } = mount()
    act(() => seen.current!.toggle())
    expect(seen.current!.advancing).toBe(true)
    act(() => seen.current!.toggle())
    expect(seen.current!.advancing).toBe(false)
  })

  it('re-derives the pace on every tick, not once at the start', () => {
    /* ⚠️ A rest derived once would keep a long chapter's pace through a
       two-page preface — and `renderer.pages` settles after layout, so the
       value read at start-up can be the wrong one outright.

       ⚠️ **ASSERTED ON THE GAPS BETWEEN STEPS, NOT ON TIMER BOUNDARIES.** An
       earlier version fenced exact `advanceTimersByTime` totals and failed
       three times on off-by-one slack, which is the harness rather than the
       property: what this case is about is that consecutive rests DIFFER when
       the pace does.

       ONE stable `pace` whose ANSWER changes, which is how the host supplies
       it: a closure over live refs, not a new function per section. */
    let pace = { ...TEN_SECONDS }
    const { seen, steps } = mount({ pace: () => pace })
    act(() => seen.current!.start())

    /* 2 500 words over 6 steps at 250 a minute is 100 s a step. */
    act(() => void vi.advanceTimersByTime(250_000))
    expect(steps.length).toBeGreaterThanOrEqual(2)
    const slow = steps[1]! - steps[0]!
    expect(slow).toBe(100_000)

    /* The reader crosses into a section with four times the steps, so each one
       holds a quarter of the words. */
    pace = { ...TEN_SECONDS, steps: 24 }
    const before = steps.length
    act(() => void vi.advanceTimersByTime(250_000))
    expect(steps.length).toBeGreaterThan(before + 1)
    const fast = steps[steps.length - 1]! - steps[steps.length - 2]!
    expect(fast).toBe(25_000)
    expect(fast).toBeLessThan(slow)
  })

  it('stops at the end of the book, where a step moves nothing', () => {
    /* ⚠️ Without this the book sits on its last page with the control still
       lit, which reads as a stall rather than an ending. */
    const tried: number[] = []
    let moved = true
    const { seen } = mount({
      step: () => {
        tried.push(1)
        const answer = moved
        moved = false
        return answer
      },
    })
    act(() => seen.current!.start())
    act(() => void vi.advanceTimersByTime(101_000))
    expect(tried).toHaveLength(1)
    expect(seen.current!.advancing).toBe(true)

    /* The next step is the one that moves nothing. */
    act(() => void vi.advanceTimersByTime(101_000))
    expect(tried).toHaveLength(2)
    expect(seen.current!.advancing).toBe(false)

    act(() => void vi.advanceTimersByTime(600_000))
    expect(tried).toHaveLength(2)
  })

  it('refuses to start while a reading is speaking', () => {
    /* ⚠️ Read aloud already turns the page, so the two together would
       double-advance. Two paces on one book has no honest resolution. */
    const { seen, steps } = mount({ speaking: true })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(false)
    act(() => void vi.advanceTimersByTime(300_000))
    expect(steps).toHaveLength(0)
  })

  it('gives the book up when a reading starts under it', () => {
    const { seen, steps, deps, again } = mount()
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(true)
    deps.current = { ...deps.current, speaking: true }
    act(() => again())
    expect(seen.current!.advancing).toBe(false)
    act(() => void vi.advanceTimersByTime(300_000))
    expect(steps).toHaveLength(0)
  })

  it('is not offered where the pace cannot be derived', () => {
    /* Every PDF, and any book with a partial spine. The control is ABSENT
       rather than present and dead. */
    const { seen } = mount({ pace: () => ({ ...TEN_SECONDS, bookWords: null }) })
    expect(seen.current!.offered).toBe(false)
    expect(seen.current!.advancing).toBe(false)
  })

  it('refuses to start where the pace cannot be derived', () => {
    const { seen, steps } = mount({ pace: () => ({ ...TEN_SECONDS, bookWords: null }) })
    act(() => seen.current!.start())
    expect(seen.current!.advancing).toBe(false)
    act(() => void vi.advanceTimersByTime(600_000))
    expect(steps).toHaveLength(0)
  })

  it('is offered where it can be derived', () => {
    const { seen } = mount()
    expect(seen.current!.offered).toBe(true)
  })

  it('fires nothing after the component goes', () => {
    /* ⚠️ Without the teardown, closing a book leaves a chain of timeouts
       calling `step` on a view that is gone. */
    const { seen, steps, view } = mount()
    act(() => seen.current!.start())
    act(() => view.unmount())
    act(() => void vi.advanceTimersByTime(600_000))
    expect(steps).toHaveLength(0)
  })

  it('a second start does not leave two chains running', () => {
    const { seen, steps } = mount()
    act(() => seen.current!.start())
    act(() => seen.current!.start())
    act(() => void vi.advanceTimersByTime(101_000))
    expect(steps).toHaveLength(1)
  })
})
