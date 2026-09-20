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
      {entries.map((entry, index) => (
        <button
          key={`${entry.href ?? 'heading'}-${index}`}
          type="button"
          className={styles.tocRow}
          data-depth={entry.depth}
          /* A heading with no href is not current and not clickable. It is a
             label over the rows beneath it — "Part One" — and offering it as a
             destination gives the reader a row that does nothing. */
          data-current={entry.href !== null && entry.href === currentHref}
          disabled={entry.href === null || !onGoTo}
          onClick={() => entry.href && onGoTo?.(entry.href)}
        >
          <span className={styles.tocLabel}>{entry.label}</span>
        </button>
      ))}
    </div>
  )
}
