import type { TocItem } from 'foliate-js/view.js'
import { flattenToc } from '../tocOrder'
import styles from './SidePane.module.css'

export interface ContentsProps {
  toc: readonly TocItem[]
  /** Href of the current entry. Labels repeat across a book — "Chapter 1",
   *  "Epígrafe" — and matching on them marks every duplicate as current. */
  currentHref: string
  onGoTo?: (href: string) => void
}

export function Contents({ toc, currentHref, onGoTo }: ContentsProps) {
  const entries = flattenToc(toc)

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No contents</div>
        <div className={styles.emptyBody}>
          This book does not declare a table of contents.
        </div>
      </div>
    )
  }

  return (
    <div className={styles.tocList}>
      {entries.map((entry, index) => {
        /**
         * ⚠️ **THE ENABLED TEST AND THE CLICK TEST DISAGREED ABOUT ONE VALUE.**
         * `disabled={entry.href === null}` left a row with `href=""` ENABLED,
         * while `entry.href && …` is falsy for the empty string — so that row
         * looked like a destination, took a click, and did nothing. `string |
         * null` does not exclude `''`, which is why the two spellings could
         * drift. One predicate now, asked once.
         */
        const goesTo = entry.href !== null && entry.href !== '' ? entry.href : null
        const isCurrent = goesTo !== null && goesTo === currentHref

        /**
         * ⚠️ **A HEADING IS NOT A DISABLED CONTROL, AND IT WAS RENDERED AS ONE.**
         * `PART ONE` with no destination is a LABEL over the rows beneath it. A
         * `<button disabled>` announces itself to a screen reader as a control
         * that cannot be used right now — which is a different and false claim,
         * and it also put every row in the tab order when `onGoTo` was absent.
         */
        if (goesTo === null) {
          return (
            <div
              key={`heading-${index}`}
              className={styles.tocRow}
              data-depth={entry.depth}
              data-heading
            >
              <span className={styles.tocLabel}>{entry.label}</span>
            </div>
          )
        }

        return (
          <button
            key={`${goesTo}-${index}`}
            type="button"
            className={styles.tocRow}
            data-depth={entry.depth}
            data-current={isCurrent}
            /* ⚠️ **AND `aria-current` IS THE SEMANTIC HALF OF `data-current`.**
               The attribute above is for the stylesheet; nothing carried the
               same fact to a screen reader, so the row a listener is IN was
               indistinguishable from every other row. `location` is the value
               for "the current place in a set of pages". */
            aria-current={isCurrent ? 'location' : undefined}
            disabled={!onGoTo}
            onClick={() => onGoTo?.(goesTo)}
          >
            <span className={styles.tocLabel}>{entry.label}</span>
          </button>
        )
      })}
    </div>
  )
}
