import { describe, expect, it } from 'vitest'
import { positionRecorder } from './positionRecorder'

/**
 * A clock that only moves when told to, so the rules can be stated in
 * milliseconds without any test taking milliseconds.
 */
function harness(delayMs = 2000) {
  const writes: [string, string][] = []
  const timers = new Map<number, () => void>()
  let next = 1

  const recorder = positionRecorder({
    write: (bookId, cfi) => writes.push([bookId, cfi]),
    delayMs,
    schedule: (fn) => {
      const handle = next++
      timers.set(handle, fn)
      return handle
    },
    cancel: (handle) => {
      timers.delete(handle)
    },
  })

  return {
    recorder,
    writes,
    /** Fire every timer currently outstanding. */
    tick: () => {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
    },
    pendingTimers: () => timers.size,
  }
}

describe('positionRecorder', () => {
  it('writes nothing until the interval comes round', () => {
    const { recorder, writes, tick } = harness()
    recorder.record('a', 'cfi-1')
    expect(writes).toEqual([])
    tick()
    expect(writes).toEqual([['a', 'cfi-1']])
  })

  it('writes once for a run of page turns, and writes the last one', () => {
    const { recorder, writes, tick } = harness()
    for (const cfi of ['1', '2', '3', '4']) recorder.record('a', cfi)
    tick()
    expect(writes).toEqual([['a', '4']])
  })

  /* The property that separates this from a debounce, and the reason it is not
   * one: a reader who keeps turning pages must still have their position saved
   * on the interval. Debounced, an hour of steady reading writes nothing. */
  it('keeps writing while the reader keeps moving', () => {
    const { recorder, writes, tick } = harness()
    recorder.record('a', '1')
    tick()
    recorder.record('a', '2')
    tick()
    expect(writes).toEqual([
      ['a', '1'],
      ['a', '2'],
    ])
  })

  it('writes immediately when asked to flush', () => {
    const { recorder, writes, pendingTimers } = harness()
    recorder.record('a', 'cfi-1')
    recorder.flush()
    expect(writes).toEqual([['a', 'cfi-1']])
    // And leaves no timer behind that would write the same thing again.
    expect(pendingTimers()).toBe(0)
  })

  it('has nothing to flush twice', () => {
    const { recorder, writes } = harness()
    recorder.record('a', 'cfi-1')
    recorder.flush()
    recorder.flush()
    expect(writes).toHaveLength(1)
  })

  /* The case this exists for. The book store clears its id and its position
   * SYNCHRONOUSLY when a book is closed or replaced, so a recorder that simply
   * ignored the empty state would lose the last position of every book the
   * reader ever switched away from. */
  it('saves the outstanding position when the book goes away', () => {
    const { recorder, writes } = harness()
    recorder.record('a', 'cfi-1')
    recorder.record(null, null)
    expect(writes).toEqual([['a', 'cfi-1']])
  })

  it('saves the old book before starting on the new one', () => {
    const { recorder, writes, tick } = harness()
    recorder.record('a', 'cfi-a')
    recorder.record('b', 'cfi-b')
    expect(writes).toEqual([['a', 'cfi-a']])
    tick()
    expect(writes).toEqual([
      ['a', 'cfi-a'],
      ['b', 'cfi-b'],
    ])
  })

  it('never files a position under the wrong book', () => {
    const { recorder, writes, tick } = harness()
    recorder.record('a', 'cfi-a')
    recorder.record('b', 'cfi-b')
    recorder.record('c', 'cfi-c')
    tick()
    for (const [bookId, cfi] of writes) expect(cfi).toBe(`cfi-${bookId}`)
  })

  it('ignores a book with nowhere to save, and a position with no book', () => {
    const { recorder, writes, tick, pendingTimers } = harness()
    recorder.record('a', null)
    recorder.record(null, 'cfi-1')
    recorder.record('', '')
    tick()
    expect(writes).toEqual([])
    expect(pendingTimers()).toBe(0)
  })

  it('drops the timer on stop without writing', () => {
    const { recorder, writes, tick, pendingTimers } = harness()
    recorder.record('a', 'cfi-1')
    recorder.stop()
    expect(pendingTimers()).toBe(0)
    tick()
    expect(writes).toEqual([])
  })
})
