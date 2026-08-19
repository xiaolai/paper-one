import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { ICON } from '../../core/metrics'
import styles from './SidePane.module.css'

/**
 * A group in the side pane that can be put away.
 *
 * ONE ACCORDION, WHERE THERE WERE THREE. This was `SettingGroup` and served
 * the settings panel alone, so the Library panel grew its own: a plain caption
 * over Views and Tags that could not be closed at all, and — twenty lines
 * below — a hand-rolled toggle over Subjects that reproduced the button, the
 * chevron and the count by hand and dropped `aria-controls` on the way. Three
 * spellings of one idea in one pane, and a reader could not tell by looking
 * which of the three headings in front of them would do anything.
 *
 * The panel grew to five groups and eighteen rows, and some of those groups
 * are refined once and then left alone for months. Permanently open, they push
 * everything below them off a 400px pane, so the settings a reader actually
 * toggles are the ones they have to scroll for.
 *
 * CLOSED OR OPEN IS THE CALLER'S, for that reason: the cost of a closed group
 * is one click, and the cost of an open one is paid by every reader on every
 * visit — but which groups are worth that is a judgement about the panel, not
 * about the mechanism. The heading stays visible either way, so nothing
 * becomes unfindable — this hides rows, never the fact that they exist.
 *
 * The heading IS the control. A separate disclosure triangle beside a label
 * that does the same thing is two targets for one action, and the smaller one
 * is the one people miss.
 */
export interface PaneGroupProps {
  readonly title: string
  readonly open: boolean
  readonly onToggle: () => void
  /**
   * How much the group holds, on the heading — so a CLOSED group still says
   * whether it is worth opening. Absent draws nothing, which is right for a
   * group whose contents are named rather than counted.
   */
  readonly count?: number
  /**
   * One control belonging to the group rather than to a row in it — the tag
   * list's sort toggle is the only one so far.
   *
   * BESIDE THE HEADING, NOT INSIDE IT, and that is a fact about HTML rather
   * than a layout preference: the heading is a `<button>`, and a button may
   * not contain a button. Passed as a node so the caller keeps its own
   * labelling and state.
   */
  readonly tool?: ReactNode
  /** What the group is, when the title alone does not say — a `title` tooltip. */
  readonly hint?: string
  readonly children: ReactNode
}

export function PaneGroup({ title, open, onToggle, count, tool, hint, children }: PaneGroupProps) {
  const id = useId()
  return (
    <>
      <div className={styles.groupTitleRow}>
        <button
          type="button"
          className={styles.groupToggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          {...(hint === undefined ? {} : { title: hint })}
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
          {count === undefined ? null : <span className={styles.groupCount}>{count}</span>}
        </button>
        {tool}
      </div>
      {/* Unmounted rather than hidden. There is nothing in these rows that has
          to keep running while they are away — every value lives in app state,
          so a closed group costs nothing and reopens exactly as it was. It is
          also what keeps a contributed settings section from doing its work
          while nobody is looking at it. */}
      {open && (
        <div id={id} className={styles.groupBody}>
          {children}
        </div>
      )}
    </>
  )
}
