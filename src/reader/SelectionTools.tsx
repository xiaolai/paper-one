import { useEffect, useState } from 'react'
import { Highlighter, MessageSquareQuote, Copy, Trash2 } from 'lucide-react'
import { ICON } from '../lib/metrics'
import { rangeBoxInHost, type HostRect } from './coordinates'
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
  onHighlight: () => void
  onNote: () => void
  onCopy: () => void
  onRemove: () => void
}

/** Popup geometry. Kept here rather than in metrics: §03 defines the reading
 *  grid, and these are this component's own affordances. */
const POPUP_H = 40
const GAP = 8

export function SelectionTools({
  selection,
  stage,
  marked,
  onHighlight,
  onNote,
  onCopy,
  onRemove,
}: SelectionToolsProps) {
  const [box, setBox] = useState<HostRect | null>(null)

  /* Measured in an effect rather than during render: the rect depends on laid
   * out DOM in another document, and reading it while rendering would both tear
   * and force a synchronous layout on every keystroke elsewhere in the app. */
  useEffect(() => {
    if (!selection || !stage) {
      setBox(null)
      return
    }
    setBox(rangeBoxInHost(selection.range, stage))
  }, [selection, stage])

  if (!selection || !box) return null

  /* Above the selection by default, below it when there is no room — a popup
   * clipped by the top of the stage would be unreachable, and the selection is
   * often the first line of a chapter. */
  const above = box.top - GAP - POPUP_H >= 0
  const top = above ? box.top - GAP - POPUP_H : box.bottom + GAP

  return (
    <div
      className={styles.popup}
      style={{ top, left: box.left + box.width / 2 }}
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
