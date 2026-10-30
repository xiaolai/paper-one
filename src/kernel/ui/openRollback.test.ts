import { describe, expect, it, vi } from 'vitest'
import { createOpenRollback } from './openRollback'

/**
 * The three edges of the one rollback slot, each of which has been wrong.
 *
 * `App` cannot say any of this: the slot lives eight hundred lines from the
 * state it undoes, and the component has no suite to hold it. The rule is
 * here so the day it changes something goes red rather than a jump quietly
 * sending a later book to a place from a book the reader never reached.
 */
describe('the open rollback', () => {
  it('undoes nothing until something fails', () => {
    const undo = vi.fn()
    const slot = createOpenRollback()
    slot.arm(undo)
    expect(undo).not.toHaveBeenCalled()
  })

  it('runs the armed rollback when the open fails', () => {
    const undo = vi.fn()
    const slot = createOpenRollback()
    slot.arm(undo)
    slot.fire()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  /* A landing is what makes the commitment true, so the slot empties. */
  it('runs nothing after the open lands', () => {
    const undo = vi.fn()
    const slot = createOpenRollback()
    slot.arm(undo)
    slot.release()
    slot.fire()
    expect(undo).not.toHaveBeenCalled()
  })

  /* ONCE. `fire` empties the slot, so a second failure has nothing to undo —
     a rollback run twice would clear a hint the NEXT jump had raised. */
  it('runs the rollback once however many failures arrive', () => {
    const undo = vi.fn()
    const slot = createOpenRollback()
    slot.arm(undo)
    slot.fire()
    slot.fire()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ **THE SUPERSEDED OPEN'S ROLLBACK RUNS, RATHER THAN BEING DROPPED.**
   *
   * A jump abandoned for a direct open used to have its rollback cleared and
   * never run, so the place override it had committed survived — spent by the
   * next CFI to arrive for that book, which is the reader opening it later and
   * being sent to a mark they had already walked away from.
   */
  it('runs the rollback of an open that something else replaced', () => {
    const first = vi.fn()
    const second = vi.fn()
    const slot = createOpenRollback()
    slot.arm(first)
    slot.arm(second)
    expect(first, 'a superseded open left its state committed').toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('runs it for a superseding open that carries no rollback of its own', () => {
    const first = vi.fn()
    const slot = createOpenRollback()
    slot.arm(first)
    slot.arm(null)
    expect(first).toHaveBeenCalledTimes(1)
  })

  /**
   * ⚠️ **AND NOT WHEN THE SAME OPEN CARRIES IT ON.**
   *
   * A stored book with no content falls back to its origin path, and that
   * fallback re-enters the open with the SAME rollback. Firing there clears
   * the jump's own override and lands the book at its saved place rather than
   * at the mark that was clicked — the fix for the case above, doing the
   * damage the case above describes.
   */
  it('leaves the rollback alone when the same open re-arms it', () => {
    const undo = vi.fn()
    const slot = createOpenRollback()
    slot.arm(undo)
    slot.arm(undo)
    expect(undo, 'the open was rolled back while it was still going').not.toHaveBeenCalled()

    /* And it is still there to run: re-arming did not empty the slot either. */
    slot.fire()
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('is idle when nothing was ever armed', () => {
    const slot = createOpenRollback()
    expect(() => {
      slot.fire()
      slot.release()
      slot.arm(null)
    }).not.toThrow()
  })
})
