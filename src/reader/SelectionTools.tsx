import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Highlighter, MessageSquareQuote, Copy, Trash2 } from 'lucide-react'
import { ICON } from '../lib/metrics'
import {
  frameBoxInHost,
  overlaps,
  rangeRectsInHost,
  watchGeometry,
  type HostRect,
} from './coordinates'
import type { SelectionSnapshot } from './session'
import styles from './SelectionTools.module.css'

/**
 * §10's selection tools — the popup over a live selection.
 *
 * It lives in the HOST document, not the book's, which is the whole reason
 * `coordinates.ts` exists: the selection is inside an iframe, so its rect has
 * to be translated before anything can be positioned against it. Drawing it
 * inside the book instead would put it under the book's own stacking context
 * and inside the scroller, where it would scroll away from the text it belongs
 * to and could not overlap the margin.
 */

export interface SelectionToolsProps {
  selection: SelectionSnapshot | null
  /** The positioned ancestor the popup is placed within. */
  stage: HTMLElement | null
  /** True when the selected passage is already marked. */
  marked: boolean
  /**
   * The reader's position, as a re-measure trigger — see `MarginMarks`. A page
   * turn with a selection still live moves the text out from under the popup
   * without firing anything the host can observe.
   */
  position: unknown
  onHighlight: () => void
  onNote: () => void
  onCopy: () => void
  onRemove: () => void
}

/** Popup geometry. Kept here rather than in metrics: §03 defines the reading
 *  grid, and these are this component's own affordances.
 *
 *  The height is published to CSS as `--popup-h` rather than written out in
 *  both places: this module positions the popup ABOVE the selection by
 *  subtracting it, so a stylesheet that disagreed would put the popup its own
 *  height away from the line it belongs to. */
const POPUP_H = 40
const GAP = 8
/** How close the popup may come to the edge of the stage before it is pushed
 *  back in. Enough that it reads as inset rather than as clipped. */
const EDGE = 8

export function SelectionTools({
  selection,
  stage,
  marked,
  position,
  onHighlight,
  onNote,
  onCopy,
  onRemove,
}: SelectionToolsProps) {
  const [box, setBox] = useState<HostRect | null>(null)
  /** The popup's own width, for the edge clamp below. */
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  /* Measured in an effect rather than during render: the rect depends on laid
   * out DOM in another document, and reading it while rendering would both tear
   * and force a synchronous layout on every keystroke elsewhere in the app. */
  const measure = useCallback(() => {
    if (!selection || !stage) {
      setBox(null)
      return
    }
    const doc = selection.range.startContainer.ownerDocument
    const page = doc ? frameBoxInHost(doc, stage) : null
    /* The first VISIBLE line rect, not the range's bounding box.
     *
     * A bounding box over a selection that crosses a column break spans both
     * columns, and its centre — which is what the popup is placed on — lands in
     * the gutter between them, or on a page that is not being shown. One line's
     * rect is always somewhere real. The same clip keeps a selection that has
     * scrolled off the page from putting the popup over whatever text now
     * occupies that spot, offering to mark a passage nowhere on screen. */
    const rect = rangeRectsInHost(selection.range, stage).find(
      (candidate) =>
        (candidate.width > 0 || candidate.height > 0) &&
        (!page || overlaps(candidate, page)),
    )
    setBox(rect ?? null)
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

  /* Measured before paint, because the value feeds back into the position. An
   * ordinary effect would let the reader see the popup appear off-centre and
   * then jump. Its width does not depend on where it is put, so this settles in
   * one pass. */
  useLayoutEffect(() => {
    const measured = popupRef.current?.getBoundingClientRect().width ?? 0
    if (Math.abs(measured - width) > 0.5) setWidth(measured)
  })

  if (!selection || !box) return null

  /* Above the selection by default, below it when there is no room — a popup
   * clipped by the top of the stage would be unreachable, and the selection is
   * often the first line of a chapter. */
  const above = box.top - GAP - POPUP_H >= 0
  const top = above ? box.top - GAP - POPUP_H : box.bottom + GAP

  /* Centred on the selection, then pushed back inside the stage.
   *
   * The popup is a fixed-width row that does not wrap, and it is centred with
   * `translateX(-50%)`: a selection in the first or last words of a line puts
   * half of it past the edge of the window, where the controls are simply not
   * there to be clicked. Clamping keeps every control reachable; the popup
   * stops pointing exactly at the middle of the selection, which is the lesser
   * loss, and only for selections at the very edge. */
  const half = width / 2
  const centre = box.left + box.width / 2
  const stageWidth = stage?.getBoundingClientRect().width ?? 0
  /* Clamped whatever the stage is. The guard used to fall back to the raw
   * centre when the stage was no wider than the popup — which is exactly the
   * narrow window where the clipping happens, so the one case that needed
   * clamping was the one case that skipped it. When the popup genuinely cannot
   * fit, its leading edge is pinned inside the stage and the trailing end is
   * allowed to overflow: the first controls stay reachable, which is better
   * than centring it and losing both ends. */
  const left =
    width > 0 && stageWidth > 0
      ? stageWidth >= width + EDGE * 2
        ? Math.min(Math.max(centre, half + EDGE), stageWidth - half - EDGE)
        : half + EDGE
      : centre

  return (
    <div
      ref={popupRef}
      className={styles.popup}
      style={{ top, left, '--popup-h': `${POPUP_H}px` } as CSSProperties}
      /* The selection lives in the book document, and clicking the host clears
       * it in some engines before the click handler runs. Suppressing the
       * default on pointerdown is what keeps the range alive long enough to
       * act on. */
      onPointerDown={(event) => event.preventDefault()}
      role="toolbar"
      aria-label="Selection tools"
    >
      <button type="button" className={styles.tool} onClick={onHighlight}>
        <Highlighter size={ICON.control} strokeWidth={ICON.stroke} />
        {marked ? 'Re-mark' : 'Mark'}
      </button>
      <button type="button" className={styles.tool} onClick={onNote}>
        <MessageSquareQuote size={ICON.control} strokeWidth={ICON.stroke} />
        Note
      </button>
      <button type="button" className={styles.tool} onClick={onCopy}>
        <Copy size={ICON.control} strokeWidth={ICON.stroke} />
        Copy
      </button>
      {marked && (
        <button type="button" className={styles.tool} onClick={onRemove}>
          <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
          Remove
        </button>
      )}
    </div>
  )
}
