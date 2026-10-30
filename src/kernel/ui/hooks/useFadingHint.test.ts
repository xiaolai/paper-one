// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFadingHint } from './useFadingHint'

/**
 * THE TWO WAYS A SELF-CLEARING LINE GOES WRONG, both of which shipped.
 *
 * The reader's "← Back to Loomings" is the line in question: a jump is the
 * only movement in the app that can be invisible, so it says so and then gets
 * out of the way. Every defect it has had was in the timing, and neither is
 * visible by reading the effect — one needs a re-render, the other needs a
 * repeat. Mounting the whole reader to find out is not an option, which is
 * why the timer is its own unit.
 */
describe('a hint that clears itself', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const AFTER = 6000

  it('clears itself once, when its time is up', () => {
    const done = vi.fn()
    renderHook(() => useFadingHint({ nonce: 1, after: AFTER, done }))

    act(() => void vi.advanceTimersByTime(AFTER - 1))
    expect(done).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(1))
    expect(done).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ A REPEAT RESTARTS IT, EVEN WHEN THE LINE READS THE SAME.
   *
   * The hint's text is a chapter name, so two jumps out of one chapter carry
   * the same string — two footnote links in one chapter is all it takes.
   * Keyed on the message, React bails out of the identical `setState`, the
   * effect never re-runs, and the second hint inherits the first one's
   * deadline: it can vanish the instant it appears. The nonce is what makes
   * a repeat a new showing.
   */
  it('restarts for a second showing of the very same line', () => {
    const done = vi.fn()
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) => useFadingHint({ nonce, after: AFTER, done }),
      { initialProps: { nonce: 1 } },
    )

    act(() => void vi.advanceTimersByTime(AFTER - 1000))
    /* The host raises the hint again from the same chapter. Only the count
       differs, which is the whole point. */
    rerender({ nonce: 2 })

    act(() => void vi.advanceTimersByTime(1000))
    expect(done, 'the second hint ran out on the first one’s clock').not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(AFTER - 1000))
    expect(done).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ AND A RE-RENDER DOES NOT.
   *
   * The host passes an inline callback, which is a new function every render,
   * and a reader turning pages re-renders constantly — so an effect keyed on
   * the callback restarted its timer on every page turn and the line never
   * went away at all. Hence the ref.
   */
  it('ignores a fresh callback arriving on every render', () => {
    const done = vi.fn()
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        /* A NEW FUNCTION EACH TIME, as an inline prop from a host is. */
        useFadingHint({ nonce, after: AFTER, done: () => done() }),
      { initialProps: { nonce: 1 } },
    )

    for (let turn = 0; turn < 5; turn += 1) {
      act(() => void vi.advanceTimersByTime(AFTER / 5))
      rerender({ nonce: 1 })
    }
    expect(done, 'a page turn kept the line on screen forever').toHaveBeenCalledTimes(1)
  })

  /* THE LATEST CALLBACK IS THE ONE THAT FIRES — a ref that is never updated
     would hold the first render's closure, which is the other half of the
     same pattern and just as silent. */
  it('calls whichever callback is current when it fires', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ done }: { done: () => void }) => useFadingHint({ nonce: 1, after: AFTER, done }),
      { initialProps: { done: first } },
    )
    rerender({ done: second })
    act(() => void vi.advanceTimersByTime(AFTER))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does nothing while no hint is up', () => {
    const done = vi.fn()
    renderHook(() => useFadingHint({ nonce: null, after: AFTER, done }))
    act(() => void vi.advanceTimersByTime(AFTER * 2))
    expect(done).not.toHaveBeenCalled()
  })

  /* A HINT THE READER TOOK IS SPENT, and its timer must go with it — firing
     afterwards would clear whatever the host had put there since. */
  it('drops the timer when the hint is taken', () => {
    const done = vi.fn()
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number | null }) => useFadingHint({ nonce, after: AFTER, done }),
      { initialProps: { nonce: 1 as number | null } },
    )
    act(() => void vi.advanceTimersByTime(AFTER / 2))
    rerender({ nonce: null })
    act(() => void vi.advanceTimersByTime(AFTER * 2))
    expect(done, 'a hint the reader had already taken cleared something else').not.toHaveBeenCalled()
  })
})
