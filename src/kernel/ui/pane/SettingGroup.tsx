import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { ICON } from '../../core/metrics'
import styles from './SidePane.module.css'

/**
 * A group of settings that can be put away.
 *
 * The panel grew to five groups and eighteen rows, and two of those groups —
 * how much light the app gives off, and how open the type is set — are refined
 * once and then left alone for months. Permanently open, they push Flow, the
 * ruler and the side pane's own position off the bottom of a 400px pane, so the
 * settings a reader actually toggles are the ones they have to scroll for.
 *
 * CLOSED TO BEGIN WITH, for that reason: the cost of a closed group is one
 * click, and the cost of an open one is paid by every reader on every visit.
 * The heading stays visible either way, so nothing becomes unfindable — this
 * hides rows, never the fact that they exist.
 *
 * The heading IS the control. A separate disclosure triangle beside a label
 * that does the same thing is two targets for one action, and the smaller one
 * is the one people miss.
 */
export interface SettingGroupProps {
  readonly title: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}

export function SettingGroup({ title, open, onToggle, children }: SettingGroupProps) {
  const id = useId()
  return (
    <>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        {/* Rotates rather than swapping glyph: one mark that turns is read as
            the same thing in two states, where two marks are read as two
            things. */}
        <ChevronRight
          className={styles.groupChevron}
          size={ICON.control}
          strokeWidth={ICON.stroke}
          data-open={open}
          aria-hidden="true"
        />
        {title}
      </button>
      {/* Unmounted rather than hidden. There is nothing in these rows that has
          to keep running while they are away — every value lives in app state,
          so a closed group costs nothing and reopens exactly as it was. */}
      {open && <div id={id}>{children}</div>}
    </>
  )
}
