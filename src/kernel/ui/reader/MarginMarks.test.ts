import { describe, expect, it } from 'vitest'
import { createMark, type Annotation, type NewMark } from '../../core/marks'
import { stack } from './MarginMarks'

/**
 * The margin's collision geometry.
 *
 * `stack` decides where a note is drawn once its own line is taken. Two things
 * can go wrong and both are silent: notes that overlap are unreadable, and
 * notes pushed off the bottom of a clipped lane are gone with nothing on screen
 * to say they existed. What is asserted here is that neither happens, and that
 * a collision at the bottom of the page does not move a note at the top that
 * was never part of it.
 */

const note = (id: string): Annotation =>
  createMark({
    bookId: 'book:abc',
    cfi: `epubcfi(/6/4!/4/2,/1:${id},/1:9)`,
    sectionIndex: 0,
    text: id,
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Ch. 1',
  } satisfies NewMark) as Annotation

/** Every note the same height, so the arithmetic below reads as written. */
const H = 40
const height = () => H
const at = (...tops: number[]) => tops.map((top, i) => ({ mark: note(String(i)), top }))
const tops = (placed: { top: number }[]) => placed.map((p) => p.top)

describe('the margin’s note stacking', () => {
  it('leaves notes that do not collide exactly where their lines are', () => {
    expect(tops(stack(at(0, 100, 200), height, 1000))).toEqual([0, 100, 200])
  })

  it('pushes a colliding note down by its predecessor’s measured height', () => {
    // 40 tall plus the 6px gap: the second note cannot start before 46.
    expect(tops(stack(at(0, 10), height, 1000))).toEqual([0, 46])
  })

  /* THE CLUSTER RULE. A pair colliding at the bottom of a short lane used to
     drag every note on the page up with it, including notes that were on their
     own lines and had nothing to do with the collision. */
  it('moves only the cluster that overhangs, not the notes above it', () => {
    const lane = 200
    // 10 sits on its own line; 150 and 155 collide and run past the lane.
    const out = stack(at(10, 150, 155), height, lane)
    expect(out[0]?.top).toBe(10)
    expect(out[1]?.top).toBe(114)
    expect(out[2]?.top).toBe(160)
    expect(out[2]!.top + H).toBeLessThanOrEqual(lane)
  })

  /* AND IT LIFTS AS FAR AS IT CAN, where it used to give up entirely. The
     cluster moves rigidly, so a short lift cannot make two notes overlap — it
     just leaves the lane clipping a shorter tail than before. */
  it('lifts a cluster part of the way when the note above blocks the rest', () => {
    const lane = 120
    const out = stack(at(0, 60, 66), height, lane)
    // The pair needs to come up 26px; the note at 0 leaves it only 14.
    expect(out[0]?.top).toBe(0)
    expect(out[1]?.top).toBe(46)
    expect(out[2]?.top).toBe(92)
    // Still in order, still 46 apart — the gap the stacking guarantees.
    expect(out[2]!.top - out[1]!.top).toBe(H + 6)
  })

  /* A note whose own line is above the lane. The lane is `overflow: hidden`, so
     left at a negative top the note is invisible AND unclickable while still
     holding its place in the order — the reader sees a gap where a note is. */
  it('brings a note anchored above the lane down to the top of it', () => {
    expect(tops(stack(at(-30, 10), height, 1000))).toEqual([0, 46])
  })

  it('keeps its hands off when the lane has not been measured yet', () => {
    expect(tops(stack(at(0, 10), height, 0))).toEqual([0, 46])
  })
})
