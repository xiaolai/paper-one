import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Annotation } from '../../core/marks'
import { LINE } from '../../core/metrics'
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
  marks: readonly Annotation[]
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
  onSelect: (mark: Annotation) => void
}

interface Placed {
  readonly mark: Annotation
  readonly top: number
}

/** Breathing room between two stacked notes. */
const GAP = 6

/**
 * Push overlapping notes apart, keeping book order, and keep them in the lane.
 *
 * Exported for its own tests. It is the one piece of this file that is pure
 * geometry — heights in, tops out — and the collisions it resolves are far
 * cheaper to state as numbers than to reproduce by rendering a page.
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
 *     they exist. The second pass pulls the overhanging CLUSTER back up, which
 *     trades exact alignment — already lost the moment two notes collide — for
 *     notes that can still be read and clicked. Only that cluster: a note that
 *     never collided is still on its own line, because nothing that happened
 *     further down the page has anything to do with where it belongs.
 */
export function stack(placed: Placed[], height: (mark: Annotation) => number, lane: number): Placed[] {
  /* THE TOP OF THE LANE IS THE FIRST FLOOR, and starting at `-Infinity` said it
     was not. A mark's own line can sit above the lane — the passage begins on
     the previous page of a spread, or the note is anchored to a partly scrolled
     rect — and its measured top comes back negative. Left there, the note is
     drawn above the lane, which is `overflow: hidden`, so it is invisible and
     unclickable while still counted as placed and still holding its turn in the
     order. Zero is the same rule every later note gets from the note above it. */
  let floor = 0
  /* `pushed` is what makes a cluster: this note only sits here because the one
     before it was in the way, so the two move as one body or not at all. */
  const down = placed.map(({ mark, top }) => {
    const pushed = floor > top
    const settled = Math.max(top, floor)
    floor = settled + height(mark) + GAP
    return { mark, top: settled, pushed }
  })

  if (lane <= 0) return down.map(({ mark, top }) => ({ mark, top }))

  /* THE CLUSTERS, and the whole reason for them: the pull used to move every
     note on the page by the overhang of the last one. Three notes near the top
     that never collided with anything were dragged away from their own lines
     because a pair at the bottom of the page ran off the lane — and if those
     three could not move far enough, the pull was abandoned and the bottom pair
     stayed off screen. Neither outcome had anything to do with the collision
     that caused it. A cluster moves; everything that was already where it
     belonged stays there. */
  const clusters: { mark: Annotation; top: number }[][] = []
  for (const note of down) {
    const run = clusters[clusters.length - 1]
    if (note.pushed && run) run.push({ mark: note.mark, top: note.top })
    else clusters.push([{ mark: note.mark, top: note.top }])
  }

  /* AND THE PULL IS PARTIAL NOW, where it used to be all or nothing.
     `ceiling` is the floor of the cluster above — the top of the lane for the
     first — so a cluster is lifted only as far as the space actually above it.
     That is what makes a short lift safe where a clamp was not: a clamp moved
     each note to `max(0, …)` INDEPENDENTLY, which packed the overflow into the
     top of the lane and made the notes overlap, reintroducing the exact thing
     this function exists to prevent. A cluster moves rigidly, so its notes keep
     their order and their gaps whatever distance it travels; stopping short
     just means the lane still clips a tail, with more of it on screen than
     before and nothing overlapping. What falls off is listed in full in the
     Marginalia pane either way. */
  let ceiling = 0
  return clusters.flatMap((cluster) => {
    const first = cluster[0]
    const last = cluster[cluster.length - 1]
    if (!first || !last) return cluster
    const overhang = last.top + height(last.mark) - lane
    const lift = overhang > 0 ? Math.min(overhang, first.top - ceiling) : 0
    const moved = lift > 0 ? cluster.map(({ mark, top }) => ({ mark, top: top - lift })) : cluster
    const settledLast = moved[moved.length - 1]
    ceiling = settledLast ? settledLast.top + height(settledLast.mark) + GAP : ceiling
    return moved
  })
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
   * else, which is exactly the signal this needs.
   *
   * A LAYOUT EFFECT, for the reason the height pass below already is: a passive
   * effect runs AFTER the browser has painted, so on every page turn the notes
   * from the previous page were drawn once at their old positions and were
   * clickable there for that frame — a note the reader could see and press
   * which belonged to text no longer on screen. */
  useLayoutEffect(() => {
    measure()
  }, [measure, position])

  /* And on anything else that invalidates a translated rect: the host
   * resizing, the book reflowing, the window changing scale factor. */
  useEffect(() => {
    if (!stage || !doc) return
    /* Passive, unlike the two above, and deliberately: this only SUBSCRIBES.
       Every measurement it leads to arrives from an observer callback, which is
       not in a paint the effect could be ahead of. */
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

  const heightOf = (mark: Annotation) => heights[mark.id] ?? LINE
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
