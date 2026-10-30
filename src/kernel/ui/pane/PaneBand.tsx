import { useId, type ReactNode } from 'react'
import styles from './SidePane.module.css'

/**
 * A band of groups in the side pane, under one caption.
 *
 * ## Why the Settings panel needed a second level and did not get one
 *
 * The panel had THIRTEEN headings in one column: seven the kernel writes —
 * Appearance, Text, Spacing, Paragraphs, Blocks, Figures, Page — and up to six
 * more contributed by capabilities: Companion, Devices, Browsers, Storage,
 * Local models. Every one of them a `PaneGroup`, every one at the same level.
 *
 * So `Figures` sat beside `Local models`. Those are not the same kind of
 * question: one is how a picture is set on a page, the other is which model
 * runs on this machine, and a reader scanning for the second had to read past
 * five groups about typography to reach it.
 *
 * THE GROUPS THEMSELVES ARE FINE, and that is why this is a band rather than a
 * merge. Each answers a distinct question a reader actually has — how big is
 * the text, how tightly is it set, how do quotations look — and folding them
 * together to shorten the list would trade a real distinction for a shorter
 * one. What was wrong was the flatness, not the groups.
 *
 * ## A caption, not another accordion
 *
 * Nesting accordions would put a click in front of settings that already take
 * one, on a 400px rail, to save scrolling that a caption saves for free. This
 * costs no interaction: it splits the scan, so a reader looking for Devices
 * skips the reading half by looking at two words instead of seven headings.
 *
 * NO CHEVRON, DELIBERATELY. Every group heading in this pane carries one and
 * every group heading is a button; a caption that looked the same but did
 * nothing would be the exact defect `PaneGroup` was built to end — headings
 * that look alike where only some of them do something. The absent chevron is
 * what says this one is a label.
 *
 * A real `<section>` with a real heading, so the split is structure rather
 * than a drawn line: the two bands are navigable by anything that reads
 * headings, which a styled `<div>` would not be.
 */
export interface PaneBandProps {
  /** The caption. Two words at most — it is read, not studied. */
  readonly title: string
  /**
   * Whether a rule is drawn above. False for the first band in a panel, where
   * the pane's own title is already the edge and a second line would read as
   * an empty group between them.
   */
  readonly ruled?: boolean
  readonly children: ReactNode
}

export function PaneBand({ title, ruled = true, children }: PaneBandProps) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={styles.band} data-ruled={ruled}>
      <h3 id={id} className={styles.bandTitle}>
        {title}
      </h3>
      {children}
    </section>
  )
}
