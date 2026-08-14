import type { TocItem } from 'foliate-js/view.js'
import styles from './SidePane.module.css'

export interface ContentsProps {
  toc: readonly TocItem[]
  /** Href of the current entry. Labels repeat across a book — "Chapter 1",
   *  "Epígrafe" — and matching on them marks every duplicate as current. */
  currentHref: string
  onGoTo?: (href: string) => void
}

interface FlatTocEntry {
  readonly label: string
  readonly href: string
  readonly depth: number
}

/** The TOC is a tree; the pane renders it as an indented list. */
function flattenToc(items: readonly TocItem[], depth = 0): FlatTocEntry[] {
  return items.flatMap((item) => [
    { label: item.label, href: item.href, depth: Math.min(depth, 2) },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ])
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
          key={`${entry.href}-${index}`}
          type="button"
          className={styles.tocRow}
          data-depth={entry.depth}
          data-current={entry.href === currentHref}
          onClick={() => onGoTo?.(entry.href)}
        >
          <span className={styles.tocLabel}>{entry.label}</span>
        </button>
      ))}
    </div>
  )
}
