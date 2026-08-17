import { afterEach, describe, expect, it } from 'vitest'
import { flushBeforeClose, onBeforeClose } from './beforeClose'

/**
 * The half of shutting down that a write queue cannot do.
 *
 * A queue drains what it has been GIVEN. The thing most likely to be lost is
 * the thing not yet handed over — a note being typed, which lives in its editor
 * until something commits it. This is the handover.
 */
describe('beforeClose', () => {
  const registered: (() => void)[] = []
  const track = (off: () => void) => {
    registered.push(off)
    return off
  }
  afterEach(() => {
    for (const off of registered.splice(0)) off()
  })

  it('runs what is registered', () => {
    const ran: string[] = []
    track(onBeforeClose(() => ran.push('a')))
    track(onBeforeClose(() => ran.push('b')))
    flushBeforeClose()
    expect(ran.sort()).toEqual(['a', 'b'])
  })

  it('stops running what has unregistered', () => {
    const ran: string[] = []
    const off = track(onBeforeClose(() => ran.push('gone')))
    off()
    flushBeforeClose()
    expect(ran).toEqual([])
  })

  /* One failing callback must not stop the others. The reader has one note in
   * one editor, but the registry carries whatever else holds state, and losing
   * all of it because one threw is the worst possible trade. */
  it('carries on after one throws', () => {
    const ran: string[] = []
    track(
      onBeforeClose(() => {
        throw new Error('nope')
      }),
    )
    track(onBeforeClose(() => ran.push('after')))
    expect(() => flushBeforeClose()).not.toThrow()
    expect(ran).toEqual(['after'])
  })

  it('is quiet with nothing registered', () => {
    expect(() => flushBeforeClose()).not.toThrow()
  })
})
