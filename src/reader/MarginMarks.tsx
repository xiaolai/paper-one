import { useCallback, useEffect, useState } from 'react'
import type { Mark } from '../lib/marks'
import { LINE } from '../lib/metrics'
import { rangeRectsInHost, watchGeometry } from './coordinates'
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
  onSelect: (mark: Mark) => void
}

interface Placed {
  readonly mark: Mark
  readonly top: number
}

/**
 * Push overlapping notes apart, keeping book order.
 *
 * Two marks on adjacent lines resolve to tops a few pixels apart, and drawn as
 * measured they would sit on top of each other and only the last would be
 * readable. Walking in order and never placing one above the previous line's
 * floor keeps them legible and keeps them in the order they appear in the text
 * — the alternative, hiding the collisions, silently loses notes.
 */
function stack(placed: Placed[], minGap: number): Placed[] {
  let floor = -Infinity
  return placed.map(({ mark, top }) => {
    const settled = Math.max(top, floor)
    floor = settled + minGap
    return { mark, top: settled }
  })
}

export function MarginMarks({ marks, ranges, stage, doc, onSelect }: MarginMarksProps) {
  const [placed, setPlaced] = useState<Placed[]>([])

  const measure = useCallback(() => {
    if (!stage) {
      setPlaced([])
      return
    }
    const found: Placed[] = []
    for (const mark of marks) {
      const range = ranges.get(mark.cfi)
      if (!range) continue
      /* The FIRST rect, not the bounding box: a note anchored to a passage
       * spanning three lines belongs beside its first line, where the reader's
       * eye is when they meet it. The bounding box would centre it against the
       * middle of the passage instead. */
      const rect = rangeRectsInHost(range, stage)[0]
      if (!rect) continue
      found.push({ mark, top: rect.top })
    }
    found.sort((a, b) => a.top - b.top)
    setPlaced(stack(found, LINE))
  }, [marks, ranges, stage])

  useEffect(() => {
    measure()
  }, [measure])

  /* Re-measure on anything that invalidates a translated rect. `relocate` is
   * deliberately not wired here — see `watchGeometry`; the reflow it causes
   * arrives as a resize on the book's body anyway. */
  useEffect(() => {
    if (!stage || !doc) return
    return watchGeometry(stage, doc, measure)
  }, [stage, doc, measure])

  return (
    <>
      {placed.map(({ mark, top }) => (
        <button
          key={mark.id}
          type="button"
          className={styles.mark}
          data-kind={mark.kind}
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
