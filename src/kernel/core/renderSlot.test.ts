import { describe, expect, it } from 'vitest'
import { createRenderSlot } from './renderSlot'

/**
 * WHAT A CONTRIBUTED `render()` DRAWS, ACROSS OVERLAPPING LIFETIMES.
 *
 * Both capabilities that contribute a settings section held their model in a
 * bare module `let` with an `=== mine` check on teardown. That check is right
 * about one direction — an old lifetime's stop must not clear a newer one's
 * value — and silent about the other: with two live compositions, the second
 * overwrote the first, and then stopping the SECOND set the slot to null while
 * the first was still running and still bound. Its pane drew nothing from that
 * point on, with nothing anywhere to say why.
 *
 * Two capabilities, one shape, so one slot.
 */
describe('the render slot', () => {
  it('holds nothing until something does', () => {
    expect(createRenderSlot<string>().current()).toBeNull()
  })

  it('draws the newest holder', () => {
    const slot = createRenderSlot<string>()
    slot.hold('first')
    expect(slot.current()).toBe('first')
    slot.hold('second')
    expect(slot.current()).toBe('second')
  })

  /* ⚠️ THE HALF THE `=== mine` CHECK COULD NOT DO. */
  it('restores the earlier holder when a later one is released', () => {
    const slot = createRenderSlot<string>()
    slot.hold('first')
    const second = slot.hold('second')
    second.dispose()
    expect(slot.current(), 'a live earlier composition was left with a blank pane').toBe('first')
  })

  /* AND THE HALF IT DID. An older lifetime's teardown must not evict the
     newer one that replaced it. */
  it('does not evict a newer holder when an older one is released', () => {
    const slot = createRenderSlot<string>()
    const first = slot.hold('first')
    slot.hold('second')
    first.dispose()
    expect(slot.current()).toBe('second')
  })

  it('is empty once every holder has let go, whatever the order', () => {
    const slot = createRenderSlot<string>()
    const first = slot.hold('first')
    const second = slot.hold('second')
    first.dispose()
    second.dispose()
    expect(slot.current()).toBeNull()
  })

  /* Releasing twice changes nothing — the same contract every binding
     disposer in the kernel has, and for the same reason: teardown runs from
     both `onCleanup` and an abort listener. */
  it('ignores a second release', () => {
    const slot = createRenderSlot<string>()
    const first = slot.hold('first')
    const second = slot.hold('second')
    second.dispose()
    second.dispose()
    expect(slot.current(), 'a repeated release took the earlier holder down too').toBe('first')
    first.dispose()
    expect(slot.current()).toBeNull()
  })

  /* Two holders of the SAME value are two holders. A capability that restarts
     with an identical model must not have one release retire both. */
  it('counts identical values separately', () => {
    const slot = createRenderSlot<string>()
    const first = slot.hold('same')
    const second = slot.hold('same')
    first.dispose()
    expect(slot.current()).toBe('same')
    second.dispose()
    expect(slot.current()).toBeNull()
  })
})
