import { describe, expect, it, vi } from 'vitest'
import { makeProgress } from './progress'

/**
 * How far the backfill has got — the half of WI-31.7 the plugin cannot answer.
 *
 * ⚠️ **"300 BOOKS INDEXED" IS NOT "HOW FAR".** The plugin knows what it holds
 * and has no idea what the shelf HAS, so a count alone reads as a finished
 * index that found three hundred books.
 */

describe('the progress holder', () => {
  it('starts knowing nothing, which is what a fresh process knows', () => {
    expect(makeProgress().get()).toEqual({ wanted: 0, sweeping: false, swept: false })
  })

  it('publishes a change to every listener', () => {
    const held = makeProgress()
    const a = vi.fn()
    const b = vi.fn()
    held.subscribe(a)
    held.subscribe(b)
    held.set({ wanted: 10, sweeping: true, swept: false })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(held.get()).toEqual({ wanted: 10, sweeping: true, swept: false })
  })

  it('publishes nothing when nothing changed', () => {
    /* ⚠️ **`useSyncExternalStore` RE-RENDERS PER NOTIFICATION.** A sweep over
     * 1 959 books would otherwise redraw the Settings panel once per book for a
     * number that moved on one of them. */
    const held = makeProgress()
    const listener = vi.fn()
    held.subscribe(listener)
    held.set({ wanted: 10, sweeping: true, swept: false })
    held.set({ wanted: 10, sweeping: true, swept: false })
    held.set({ wanted: 10, sweeping: true, swept: false })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notices each field on its own', () => {
    const held = makeProgress()
    const listener = vi.fn()
    held.subscribe(listener)
    held.set({ wanted: 1, sweeping: false, swept: false })
    held.set({ wanted: 1, sweeping: true, swept: false })
    held.set({ wanted: 1, sweeping: true, swept: true })
    held.set({ wanted: 2, sweeping: true, swept: true })
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('stops telling a listener that unsubscribed', () => {
    const held = makeProgress()
    const listener = vi.fn()
    const off = held.subscribe(listener)
    off()
    held.set({ wanted: 10, sweeping: true, swept: false })
    expect(listener).not.toHaveBeenCalled()
  })

  it('gives each holder its own state, so two cases cannot leak into each other', () => {
    const one = makeProgress()
    const two = makeProgress()
    one.set({ wanted: 10, sweeping: true, swept: false })
    expect(two.get().wanted).toBe(0)
  })
})

describe('what a book is called', () => {
  it('answers nothing until the capability has bound a lookup', () => {
    /* A pane drawn before `start` — which happens, because a settings section
       outlives the composition — must fall back rather than throw. */
    expect(makeProgress().titleOf('book:a')).toBeUndefined()
  })

  it('answers the shelf once it has', () => {
    const held = makeProgress()
    held.bindTitles((id) => (id === 'book:a' ? 'Moby-Dick' : undefined))
    expect(held.titleOf('book:a')).toBe('Moby-Dick')
    expect(held.titleOf('book:gone')).toBeUndefined()
  })

  it('reads the lookup THROUGH, so a later binding is the one that answers', () => {
    /* ⚠️ Captured at construction, the holder would answer `undefined` for ever:
       it is made at module load and bound during `start`. */
    const held = makeProgress()
    held.bindTitles(() => 'first')
    held.bindTitles(() => 'second')
    expect(held.titleOf('book:a')).toBe('second')
  })

  it('is not part of the snapshot, so it cannot make every comparison unequal', () => {
    /* A function in a `useSyncExternalStore` value has a new identity every
       render. The snapshot is three scalars and stays comparable. */
    const held = makeProgress()
    expect(Object.keys(held.get()).sort()).toEqual(['sweeping', 'swept', 'wanted'])
  })
})

describe('asking for a sweep', () => {
  it('does nothing until the capability has bound one', () => {
    /* A pane drawn after a teardown asks nobody rather than throwing. */
    expect(() => makeProgress().sweepNow()).not.toThrow()
  })

  it('runs the bound sweep', () => {
    /* ⚠️ **"TRY THESE AGAIN" CLEARED THE WARNING AND DID NOTHING ELSE.** A sweep
     * is scheduled by a library CHANGE, and clearing a note changes no library —
     * so on an idle shelf the books vanished from the panel and were never
     * re-extracted, which is worse than the warning it removed. */
    const held = makeProgress()
    const run = vi.fn()
    held.bindSweep(run)
    held.sweepNow()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reads the binding THROUGH, so a later one is the one that runs', () => {
    const held = makeProgress()
    const first = vi.fn()
    const second = vi.fn()
    held.bindSweep(first)
    held.bindSweep(second)
    held.sweepNow()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
