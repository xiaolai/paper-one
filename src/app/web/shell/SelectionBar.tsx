import { Copy, Highlighter, MessageSquareText } from 'lucide-react'
import { ICON } from '../../../kernel/core/metrics'
import type { MarkTint } from '../../../kernel'
import styles from './SelectionBar.module.css'

/**
 * The bottom action bar that appears when text is selected — the mobile
 * mockup's "Selection" screen: "Handles plus a bottom action bar."
 *
 * ## Why not the desktop's `SelectionTools`
 *
 * That is a popover anchored beside the selection, and §06 says the mobile
 * shape is different on purpose: "Hover toolbar" on desktop, "Handles plus a
 * bottom action bar" on mobile. A popover next to a selection on a phone sits
 * under the thumb that made it. This is a fixed bar at the foot of the screen,
 * so the selection stays visible above it.
 *
 * ## Three tints, not the mockup's four swatches
 *
 * The mockup draws four circles; the mark model has three tints — yellow,
 * green, purple — and a fourth would be a colour with no meaning behind it.
 * Three are drawn, from the same tokens the desktop's marks use.
 *
 * ## No "Explain"
 *
 * The mockup's fourth action is the companion. This client has no companion
 * provider (`composition.web.ts` is empty), so the control is absent — the
 * same rule as every other capability this host lacks. A button that answered
 * "not configured" would be a control that cannot act.
 */
export interface SelectionBarProps {
  /** The selected text, for the word count. */
  readonly text: string
  readonly tint: MarkTint
  readonly onTint: (tint: MarkTint) => void
  /**
   * ABSENT WHEN THIS SESSION CANNOT WRITE. A browser's grant is READ, and
   * `webhost/lib/pump.ts` says why at length: a hostile EPUB shares this
   * page's origin, can open the socket itself, and the cookie rides along —
   * so `mark:write` from a browser is `mark:write` for any book you open.
   * Widening that is a deliberate decision, not this client's to make. Until
   * it is made, Highlight and Note are not drawn, the same rule as
   * `onAddBooks` on the shelf: an absent capability is an absent control,
   * never a control that logs a refusal and does nothing you can see.
   */
  readonly onHighlight?: (() => void) | undefined
  readonly onNote?: (() => void) | undefined
  readonly onCopy: () => void
}

const TINTS: readonly MarkTint[] = ['yellow', 'green', 'purple']

export function SelectionBar({ text, tint, onTint, onHighlight, onNote, onCopy }: SelectionBarProps) {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return (
    <div className={styles.bar} role="toolbar" aria-label="Selection">
      <div className={styles.tints}>
        {onHighlight !== undefined && TINTS.map((one) => (
          <button
            key={one}
            type="button"
            className={styles.swatch}
            data-tint={one}
            aria-label={`${one} highlight`}
            aria-pressed={one === tint}
            onClick={() => onTint(one)}
          />
        ))}
        <span className={styles.count}>
          {words} {words === 1 ? 'word' : 'words'}
        </span>
      </div>
      <div className={styles.actions} data-count={(onHighlight ? 1 : 0) + (onNote ? 1 : 0) + 1}>
        {onHighlight !== undefined && (
          <button type="button" className={styles.action} onClick={onHighlight}>
            <Highlighter size={ICON.tab} strokeWidth={ICON.stroke} />
            Highlight
          </button>
        )}
        {onNote !== undefined && (
          <button type="button" className={styles.action} onClick={onNote}>
            <MessageSquareText size={ICON.tab} strokeWidth={ICON.stroke} />
            Note
          </button>
        )}
        <button type="button" className={styles.action} onClick={onCopy}>
          <Copy size={ICON.tab} strokeWidth={ICON.stroke} />
          Copy
        </button>
      </div>
    </div>
  )
}
