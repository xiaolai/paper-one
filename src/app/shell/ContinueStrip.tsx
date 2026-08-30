import { useMemo } from 'react'
import type { IndexedBook } from '../../kernel'
/* THE LEAVES, NOT A DOOR — see `BottomSheet.tsx` for why a shared component
   may not name one platform's UI entry. */
import { BookCover } from '../../kernel/ui/screens/BookCover'
import type { CoverSource } from '../../kernel/core/coverArt'
import styles from './ContinueStrip.module.css'

/**
 * "Continue" — the three books most recently opened, as covers with a
 * progress rule, above the full list. From the mobile mockup's Library.
 *
 * On the desktop the shelf's `recent` sort is the whole answer to "what was I
 * reading"; on a phone the first thing a reader wants is the book they put
 * down, one tap and thumb-reachable, and a 1 961-row list sorted by recency
 * still puts it under a search field and a heading. Three covers do not.
 *
 * ## Only books that have been opened
 *
 * `openedAt` is the signal. A book added and never opened is not something to
 * continue, and a strip that showed the three newest additions would say
 * "continue" about books the reader has not started — the empty state is
 * nothing at all, not three arbitrary jackets.
 */
export interface ContinueStripProps {
  readonly books: readonly IndexedBook[]
  readonly onOpen: (book: IndexedBook) => void
  readonly coverFor?: CoverSource | undefined
}

export function recentlyOpened(books: readonly IndexedBook[], take = 3): readonly IndexedBook[] {
  return books
    .filter((b) => typeof b.openedAt === 'number' && b.openedAt > 0)
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    .slice(0, take)
}

export function ContinueStrip({ books, onOpen, coverFor }: ContinueStripProps) {
  const recent = useMemo(() => recentlyOpened(books), [books])
  if (recent.length === 0) return null
  return (
    <section className={styles.strip} aria-label="Continue reading">
      <h2 className={styles.heading}>Continue</h2>
      <div className={styles.row}>
        {recent.map((book) => {
          const pct = Math.round(Math.max(0, Math.min(1, book.progress ?? 0)) * 100)
          return (
            <button key={book.bookId} type="button" className={styles.item} onClick={() => onOpen(book)}>
              <span className={styles.jacket}>
                <BookCover
                  book={book}
                  title={book.title}
                  coverFor={coverFor}
                  className={styles.cover}
                  /* The tinted fallback draws the TITLE inside the jacket. At
                     the row's size that is a chip; at a 110px-wide cover it
                     was body text spilling over the edge. */
                  titleClassName={styles.coverTitle}
                />
                <span className={styles.rule} style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }} />
              </span>
              <span className={styles.title}>{book.title === '' ? 'Untitled' : book.title}</span>
              <span className={styles.pct}>{pct}%</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
