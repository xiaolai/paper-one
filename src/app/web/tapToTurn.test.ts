import { describe, expect, it } from 'vitest'
import { EDGE, TAP_SLOP, stagePoint, tapIntent, type Tap } from './tapToTurn'

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

/**
 * `stagePoint`: the tap is judged against the page the reader can SEE.
 *
 * THE BUG THIS EXISTS FOR, with its measurements. A book document is not one
 * page wide — foliate lays a section out in columns, makes the iframe as wide
 * as all of them, and slides it to show one page at a time. So the same tap,
 * at screen x=346 and `clientX` 318 every time, was judged against 337px in a
 * one-page section and 1011px in a three-page one:
 *
 *   337 → the right third begins at 225 → 318 is a forward turn
 *  1011 → the LEFT third runs to 337    → 318 is a backward turn
 *
 * So a reader tapping the same spot went forward, back, forward, back, and
 * could not get past the first long section of a book. `tapIntent` was correct
 * every time; it was being handed the wrong page.
 *
 * These numbers are the ones measured on 2026-08-26 against a real EPUB, kept
 * literal so the regression is recognisable rather than paraphrased.
 */
describe('stagePoint', () => {
  const STAGE_LEFT = 0
  const STAGE_WIDTH = 393

  it('puts the measured tap in the same place whatever the section', () => {
    /* Frame offset 28 both times: each turn crossed into a new section and
       landed on its first page, so only the document's width differed. */
    expect(stagePoint(318, 28, STAGE_LEFT)).toBe(346)
  })

  /**
   * ⚠️ **THIS RAN `at(318, 28)` TWICE, WHICH IS THE SAME CALL.** A pure function
   * asked the same question twice gives the same answer whatever it does, so
   * the test could not have failed — including against the defect it names. The
   * one-page and three-page sections never appeared in it at all.
   *
   * What differed between them was the DOCUMENT's width: 337px laid out as one
   * page, 1011px as three. `tapIntent` is handed the STAGE's width now, which
   * is the same 393 either way — so the two cases are the two widths, and the
   * assertion is that the stage answer does not depend on which one the
   * document happens to be.
   */
  it('gives the same verdict on a one-page and a three-page section', () => {
    const at = (clientX: number, frameLeft: number, width = STAGE_WIDTH) =>
      tapIntent({
        x: stagePoint(clientX, frameLeft, STAGE_LEFT),
        moved: 0,
        width,
        selected: false,
        onControl: false,
      })
    /** The document widths measured on 2026-08-26, kept literal. */
    const ONE_PAGE = 337
    const THREE_PAGES = 1011

    /* THE STAGE IS THE SAME EITHER WAY, so the verdict is. */
    expect(at(318, 28)).toBe('right')
    expect(at(318, 28)).toBe('right')

    /* AND THE OLD WAY WOULD HAVE DISAGREED — the oscillation itself, pinned so
       the regression is recognisable. It judged the DOCUMENT's own `clientX`
       against the DOCUMENT's width, which is 337 in a one-page section and
       1011 in a three-page one; the same tap is then past the right third of
       one and inside the left third of the other. A reader tapping one spot
       went forward, back, forward, back, and could not get past the first long
       section of a book. */
    const inDocument = (clientX: number, width: number) =>
      tapIntent({ x: clientX, moved: 0, width, selected: false, onControl: false })
    expect(inDocument(318, ONE_PAGE)).toBe('right')
    expect(inDocument(318, THREE_PAGES)).toBe('left')
    expect(
      inDocument(318, ONE_PAGE),
      'the two document widths must disagree, or this case proves nothing',
    ).not.toBe(inDocument(318, THREE_PAGES))
  })

  /* THE FRAME SLIDES NEGATIVE within a section. Page two of a three-page
     section sits at -309, and `clientX` grows by exactly as much, so the tap
     stays where the reader put it. This is the case the old code could not
     express at all. */
  it('follows the frame as it slides within a section', () => {
    expect(stagePoint(318, 28, STAGE_LEFT)).toBe(346)
    expect(stagePoint(655, -309, STAGE_LEFT)).toBe(346)
    expect(stagePoint(992, -646, STAGE_LEFT)).toBe(346)
  })

  it('subtracts a stage that does not start at the window edge', () => {
    expect(stagePoint(318, 28, 40)).toBe(306)
  })

  /* A tap on the stage itself is already in this basis: no frame, no offset. */
  it('is the identity when there is nothing to offset', () => {
    expect(stagePoint(200, 0, 0)).toBe(200)
  })
})
