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
import { place } from '../lib/placement'
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

  /* WHERE IT GOES IS `place`'S DECISION, and the reasoning that used to live
   * here as thirty lines of arithmetic lives there now, once, for every
   * popover in the app: above the selection by preference and below when there
   * is no room, centred on the line and slid back inside the stage when a
   * selection at the very edge would push half the controls off it, and — when
   * the stage is narrower than the popup — the leading edge pinned so the first
   * controls stay reachable rather than centring it and losing both ends.
   *
   * The stage is the BOUNDS, not the viewport: this popup is positioned inside
   * the stage, in the stage's own coordinates, which is exactly what `bounds`
   * is for. `place` returns a left EDGE; the stylesheet centres the popup with
   * `translateX(-50%)` for its enter animation, so the edge is turned back
   * into a centre at this one seam. */
  const stageBox = stage?.getBoundingClientRect()
  const placed = place({
    anchor: { top: box.top, left: box.left, width: box.width, height: box.height },
    surface: { width, height: POPUP_H },
    /* The stage's own box, at origin — this popup's coordinates are stage-
       relative. Before the stage has a box there is nothing to clamp against,
       and a very large bound is the honest "no constraint" rather than a guess. */
    bounds: { top: 0, left: 0, width: stageBox?.width ?? 1e6, height: stageBox?.height ?? 1e6 },
    side: 'top',
    align: 'center',
    gap: GAP,
    edge: EDGE,
  })
  const top = placed.top
  const left = width > 0 ? placed.left + width / 2 : box.left + box.width / 2

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
