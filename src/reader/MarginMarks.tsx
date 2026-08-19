import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mark } from '../lib/marks'
import { LINE } from '../lib/metrics'
import { frameBoxInHost, overlaps, rangeRectsInHost, watchGeometry } from './coordinates'
import styles from './MarginMarks.module.css'

/**
 * §03's margin column — notes beside the line they belong to.
 *
 * These are host chrome, not marks on the text, so they go through the rect
 * translation in `coordinates.ts` rather than the Overlayer. The distinction is
 * the one that module opens with, and it is load-bearing here: a note has to
 * sit OUTSIDE the measure, in a column the book's iframe does not cover.
 *
 * Position comes from the live Range foliate resolved when it drew the mark,
 * re-measured whenever the geometry changes. A Range tracks the DOM it points
 * into, so a reflow moves the note with its line without re-resolving the CFI.
 */

export interface MarginMarksProps {
  /** The marks worth showing here — see `marginMarks`. */
  marks: readonly Mark[]
  /** Live ranges by CFI, for the marks foliate has actually drawn. */
  ranges: ReadonlyMap<string, Range>
  /** The positioned ancestor these are placed within. */
  stage: HTMLElement | null
  /** The current spine document, watched for reflow. */
  doc: Document | null
  /**
   * The reader's position, as a re-measure trigger.
   *
   * A page turn moves every rect in the book and changes which of them are on
   * screen, but it resizes nothing and scrolls no window the host can observe —
   * so none of the signals `watchGeometry` listens for fire, and the notes stay
   * where the previous page left them. Any value that changes per relocation
   * does; the position is the one already flowing through the reader.
   */
  position: unknown
  onSelect: (mark: Mark) => void
}

interface Placed {
  readonly mark: Mark
  readonly top: number
}

/** Breathing room between two stacked notes. */
const GAP = 6

/**
 * Push overlapping notes apart, keeping book order, and keep them in the lane.
 *
 * Two marks on adjacent lines resolve to tops a few pixels apart, and drawn as
 * measured they would sit on top of each other and only the last would be
 * readable. Walking in order and never placing one above the previous note's
 * floor keeps them legible and keeps them in the order they appear in the text
 * — the alternative, hiding the collisions, silently loses notes.
 *
 * Two passes, not one, and by MEASURED height rather than by the line box:
 *
 *   - A note is not a line tall. It is two lines of 12px text plus padding —
 *     about 43px — and a companion note carries a label above that, about 59px.
 *     Advancing the floor by the reading grid's 34px therefore permitted
 *     precisely the overlap the stacking exists to prevent, which is why the
 *     heights come from the rendered elements instead of a constant.
 *
 *   - Pushing down alone walks a cluster off the bottom of the lane, and the
 *     lane is `overflow: hidden`, so those notes disappear with nothing to say
 *     they exist. The second pass pulls the run back up against the floor of
 *     the lane, which trades exact alignment — already lost the moment two
 *     notes collide — for notes that can still be read and clicked.
 */
function stack(placed: Placed[], height: (mark: Mark) => number, lane: number): Placed[] {
  let floor = -Infinity
  const down = placed.map(({ mark, top }) => {
    const settled = Math.max(top, floor)
    floor = settled + height(mark) + GAP
    return { mark, top: settled }
  })

  if (lane <= 0) return down
  const last = down[down.length - 1]
  if (!last || last.top + height(last.mark) <= lane) return down

  /* The run overhangs the bottom. Pull it back up — but only as far as the top
   * of the lane, and only if the whole run fits once it is there.
   *
   * If it does not fit, the pull is abandoned rather than clamped at zero. A
   * clamp packs the overflow into the top of the lane, where the notes overlap
   * and become unreadable — the exact outcome this function exists to prevent,
   * reintroduced by the fix for the opposite problem. Left alone, the run stays
   * in order and legible and the lane clips its tail; the notes that fall off
   * are still listed, in full, in the Notes panel. */
  const needed = last.top + height(last.mark) - lane
  const first = down[0]
  if (!first || first.top - needed < 0) return down

  return down.map(({ mark, top }) => ({ mark, top: top - needed }))
}

export function MarginMarks({ marks, ranges, stage, doc, position, onSelect }: MarginMarksProps) {
  /** Where each note's own line is, before collisions are resolved. */
  const [placed, setPlaced] = useState<Placed[]>([])
  /**
   * Rendered heights, by mark id.
   *
   * Measured rather than assumed, and safe to feed back into the layout: these
   * notes are absolutely positioned in a fixed-width lane and clamped to two
   * lines, so a note's height does not depend on its top. Moving one cannot
   * change what was measured, and the loop settles in one pass.
   */
  const [heights, setHeights] = useState<Record<string, number>>({})
  const nodes = useRef(new Map<string, HTMLButtonElement>())
  const [lane, setLane] = useState(0)

  const measure = useCallback(() => {
    if (!stage || !doc) {
      setPlaced([])
      return
    }
    /* The page actually on screen. Rects outside it belong to text the reader
     * cannot see — see `frameBoxInHost` for why they exist at all. */
    const page = frameBoxInHost(doc, stage)
    const found: Placed[] = []
    for (const mark of marks) {
      const range = ranges.get(mark.cfi)
      if (!range) continue
      /* The FIRST VISIBLE rect, not the bounding box: a note anchored to a
       * passage spanning three lines belongs beside its first line, where the
       * reader's eye is when they meet it. The bounding box would centre it
       * against the middle of the passage instead — and for a passage broken
       * across a page turn it would span both pages and land off-screen. */
      const rect = rangeRectsInHost(range, stage).find((r) => !page || overlaps(r, page))
      if (!rect) continue
      found.push({ mark, top: rect.top })
    }
    found.sort((a, b) => a.top - b.top)
    setPlaced(found)
  }, [marks, ranges, stage, doc])

  /* Measure on mount and whenever the inputs change. `position` is in the
   * dependency list without being read: a page turn changes it and nothing
   * else, which is exactly the signal this needs. */
  useEffect(() => {
    measure()
  }, [measure, position])

  /* And on anything else that invalidates a translated rect: the host
   * resizing, the book reflowing, the window changing scale factor. */
  useEffect(() => {
    if (!stage || !doc) return
    return watchGeometry(stage, doc, measure)
  }, [stage, doc, measure])

  /* Measure what was just drawn, then lay out against it. A layout effect, so
   * the correction happens before the browser paints — in an ordinary effect
   * the reader would see the notes jump on every re-measure. */
  useLayoutEffect(() => {
    const next: Record<string, number> = {}
    let changed = false
    for (const { mark } of placed) {
      const node = nodes.current.get(mark.id)
      if (!node) continue
      const measured = node.getBoundingClientRect().height
      next[mark.id] = measured
      if (Math.abs((heights[mark.id] ?? 0) - measured) > 0.5) changed = true
    }
    if (changed || Object.keys(next).length !== Object.keys(heights).length) setHeights(next)

    const parent = placed.length > 0 ? nodes.current.get(placed[0]!.mark.id)?.offsetParent : null
    const laneHeight = parent instanceof HTMLElement ? parent.getBoundingClientRect().height : 0
    if (Math.abs(laneHeight - lane) > 0.5) setLane(laneHeight)
  }, [placed, heights, lane])

  const heightOf = (mark: Mark) => heights[mark.id] ?? LINE
  const settled = stack(placed, heightOf, lane)

  return (
    <>
      {settled.map(({ mark, top }) => (
        <button
          key={mark.id}
          ref={(node) => {
            if (node) nodes.current.set(mark.id, node)
            else nodes.current.delete(mark.id)
          }}
          type="button"
          className={styles.mark}
          data-kind={mark.kind}
          data-tint={mark.tint}
          style={{ top }}
          onClick={() => onSelect(mark)}
        >
          {/* §10: colour never carries meaning alone, so the companion's marks
              are labelled as well as amber. */}
          {mark.kind === 'companion' && <span className={styles.kind}>Companion</span>}
          <span className={styles.body}>{mark.note || mark.text}</span>
        </button>
      ))}
    </>
  )
}
