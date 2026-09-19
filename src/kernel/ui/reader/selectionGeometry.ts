import { useCallback, useEffect, useState } from 'react'
import { frameBoxInHost, overlaps, rangeRectsInHost, watchGeometry, type HostRect } from './coordinates'
import type { SelectionSnapshot } from './session'

/**
 * Where a live selection is, and how big the stage around it is — as ONE
 * measurement.
 *
 * Lifted out of `SelectionTools` on 2026-09-19, for a defect rather than for
 * size. That component's own comment said the rects are measured in an effect
 * "rather than during render: the rect depends on laid out DOM in another
 * document, and reading it while rendering would both tear and force a
 * synchronous layout on every keystroke elsewhere in the app" — and then, a
 * hundred lines below, it called `stage.getBoundingClientRect()` during render
 * and handed the result to `place` as the BOUNDS for rects measured in a past
 * commit's effect.
 *
 * ⚠️ **TWO LAYOUT SNAPSHOTS FROM DIFFERENT MOMENTS, COMBINED BY ARITHMETIC
 * THAT CANNOT TELL.** `place` clamps the anchor against the bounds; with the
 * anchor a frame old and the bounds current, a reflow between them clamps a
 * popup against a stage it was never measured in. It is invisible in a test
 * that lays nothing out twice, and the only symptom is a popup a few pixels
 * wrong for one frame — which reads as a rounding problem, not as a torn read.
 *
 * So the stage's box is measured HERE, in the same call as the lines, and both
 * are published as one value. A snapshot that cannot be half-old is worth more
 * than a fresher half: the two are only ever used together.
 *
 * What is NOT here: the popup's own width. That is measured in a layout effect
 * against the popup's own node, in the host document, and it feeds back into
 * the placement in the same commit — a different question with a different
 * answer, and `SelectionTools` keeps it.
 */
export interface SelectionGeometry {
  /**
   * EVERY VISIBLE LINE of the selection, in the range's own order: the first is
   * the line the popup hangs from, and all of them, unioned, are what it stays
   * clear of. Empty when there is nothing to draw against.
   *
   * ONE VALUE WITH THE BOUNDS, AND THE ANCHOR AND THE EXTENT BOTH READ OFF IT.
   * They were two states set side by side once, so either could be written
   * without the other — and an extent with no anchor beside it, which nothing
   * can read because without an anchor nothing is drawn, was a value the code
   * took care to clear.
   */
  readonly lines: readonly HostRect[]
  /** The stage's own box, measured in the same pass. Null when there is no stage. */
  readonly stageBox: { readonly width: number; readonly height: number } | null
}

/** Nothing measured. ONE VALUE, so a measurement that finds nothing again is
 *  not a change — `useState` bails on an identical reference and the popup does
 *  not re-render on every scroll tick that lands on an empty selection. */
export const NO_GEOMETRY: SelectionGeometry = Object.freeze({ lines: Object.freeze([]), stageBox: null })

/**
 * Measure `selection` against `stage`, and keep measuring.
 *
 * `position` is not read — it is a CHANGE SIGNAL. The popup follows the text,
 * and the text moves when the page does, so a new position is a reason to
 * measure again even though nothing about it is geometry.
 */
export function useSelectionGeometry(
  selection: SelectionSnapshot | null,
  stage: HTMLElement | null,
  position: unknown,
): SelectionGeometry {
  const [geometry, setGeometry] = useState<SelectionGeometry>(NO_GEOMETRY)

  const measure = useCallback(() => {
    if (!selection || !stage) {
      setGeometry(NO_GEOMETRY)
      return
    }
    const doc = selection.range.startContainer.ownerDocument
    const page = doc ? frameBoxInHost(doc, stage) : null
    /* The VISIBLE line rects, and the popup hangs from the first of them — not
     * from the range's bounding box.
     *
     * A bounding box over a selection that crosses a column break spans both
     * columns, and its centre — which is what the popup is placed on — lands in
     * the gutter between them, or on a page that is not being shown. One line's
     * rect is always somewhere real. The same clip keeps a selection that has
     * scrolled off the page from putting the popup over whatever text now
     * occupies that spot, offering to mark a passage nowhere on screen.
     *
     * EVERY LINE IS CLIPPED THE SAME WAY, not only the anchor: a line on a page
     * that is not being shown must not push the popup around either. */
    const lines = rangeRectsInHost(selection.range, stage).filter(
      (candidate) => (candidate.width > 0 || candidate.height > 0) && (!page || overlaps(candidate, page)),
    )
    /* MEASURED HERE, WHICH IS THE POINT OF THE MODULE. One `getBoundingClientRect`
       on the stage costs a layout that the line rects above have already forced,
       so this is free where the render-time read it replaces was not. */
    const box = stage.getBoundingClientRect()
    setGeometry({ lines, stageBox: { width: box.width, height: box.height } })
  }, [selection, stage])

  useEffect(() => {
    measure()
  }, [measure, position])

  /* A selection outlives the gesture that made it, so the popup has to follow
   * the text through every later reflow: the pane opening, a font-size step, a
   * window resize. Measuring once at selection time pins it where the text used
   * to be. */
  useEffect(() => {
    const doc = selection?.range.startContainer.ownerDocument
    if (!stage || !doc) return
    return watchGeometry(stage, doc, measure)
  }, [selection, stage, measure])

  return geometry
}
