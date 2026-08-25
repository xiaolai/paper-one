import { describe, expect, it } from 'vitest'
import { EDGE, TAP_SLOP, tapIntent, type Tap } from './tapToTurn'

/**
 * When a tap is a page turn, and — more importantly — when it is not.
 *
 * A gesture that turns the page when the reader meant to select a quote is
 * worse than no gesture at all: it loses their place while they are trying to
 * keep it. So most of these are refusals.
 */

const tap = (over: Partial<Tap> = {}): Tap => ({
  x: 200,
  moved: 0,
  width: 400,
  selected: false,
  onControl: false,
  ...over,
})

describe('tapIntent', () => {
  it('turns back from the left edge and forward from the right', () => {
    expect(tapIntent(tap({ x: 10 }))).toBe('left')
    expect(tapIntent(tap({ x: 390 }))).toBe('right')
  })

  /* THE MIDDLE THIRD DOES NOTHING, deliberately: it is where a reader rests a
     thumb, and the only part of a page that is safe to touch. */
  it('does nothing in the middle', () => {
    for (const x of [140, 200, 260]) expect(tapIntent(tap({ x }))).toBeNull()
  })

  it('puts the boundary exactly a third in from each side', () => {
    const width = 300
    expect(tapIntent(tap({ width, x: width * EDGE - 1 }))).toBe('left')
    expect(tapIntent(tap({ width, x: width * EDGE }))).toBeNull()
    expect(tapIntent(tap({ width, x: width * (1 - EDGE) }))).toBeNull()
    expect(tapIntent(tap({ width, x: width * (1 - EDGE) + 1 }))).toBe('right')
  })

  /* A DRAG IS NOT A TAP. Scrolling, selecting and swiping all end in a
     release, and every one of them ends somewhere. */
  it('ignores a release that travelled', () => {
    expect(tapIntent(tap({ x: 10, moved: TAP_SLOP + 1 }))).toBeNull()
    expect(tapIntent(tap({ x: 10, moved: TAP_SLOP }))).toBe('left')
  })

  /**
   * A TAP WITH A SELECTION IS NOT A TURN.
   *
   * This is the one that matters most. Releasing at the end of a drag-select
   * lands somewhere, and on a phone that somewhere is usually an outer third —
   * so without this, selecting a quote turns the page out from under it.
   */
  it('never turns while the reader has text selected', () => {
    expect(tapIntent(tap({ x: 10, selected: true }))).toBeNull()
    expect(tapIntent(tap({ x: 390, selected: true }))).toBeNull()
  })

  it('never turns on a link or another control', () => {
    expect(tapIntent(tap({ x: 10, onControl: true }))).toBeNull()
    expect(tapIntent(tap({ x: 390, onControl: true }))).toBeNull()
  })

  /* A ZERO-WIDTH PAGE IS NOT A PAGE — it happens for a frame while a document
     is laid out, and every tap would otherwise read as the right edge, because
     `x > 0 * (1 - EDGE)` is true for any positive x. */
  it('does nothing on a page that has no width yet', () => {
    expect(tapIntent(tap({ width: 0, x: 0 }))).toBeNull()
    expect(tapIntent(tap({ width: 0, x: 200 }))).toBeNull()
    expect(tapIntent(tap({ width: -1, x: 5 }))).toBeNull()
  })

  /* SIDES, NOT DIRECTIONS. foliate resolves which page a side means from the
     book's own direction, so a right-to-left book turns forward from the LEFT.
     Naming the direction here would reverse it. */
  it('names a side and never a direction', () => {
    const answers = [10, 390].map((x) => tapIntent(tap({ x })))
    expect(answers).toEqual(['left', 'right'])
    expect(answers).not.toContain('next')
    expect(answers).not.toContain('prev')
  })
})
