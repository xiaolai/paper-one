import { Plus } from 'lucide-react'
import { coverTintFor } from '../data/fixtures'
import {
  NOT_REOPENABLE,
  displayAuthor,
  displayTitle,
  isReopenable,
  rowSuffix,
} from '../lib/library'
import type { LibraryEntry } from '../lib/library'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import styles from './Library.module.css'

/**
 * The library — the books this reader has opened.
 *
 * It shows the same store the switcher does, for the same reason: a shelf of
 * books nobody owns is a claim about someone's reading that is not true. So it
 * starts empty and fills as books are opened, rather than opening onto a wall
 * of fixtures.
 *
 * The design's four views — shelf, wall, index, map — are not here. Three of
 * them are arrangements of a collection large enough to need arranging, and
 * the fourth is a graph over relationships nothing computes yet. One honest
 * grid is what the data supports; the rest arrive with what they display.
 */

export interface LibraryProps {
  books: readonly LibraryEntry[]
  platform: Platform
  /**
   * Open a book by URL.
   *
   * It is never called for a book without one — see `isReopenable`, which
   * disables those rows. The note here used to say the argument could be null,
   * describing `LibraryEntry.url` rather than this callback, which takes a
   * string and always has.
   */
  onOpen: (url: string) => void
  onAddBooks: () => void
}

export function Library({ books, platform, onOpen, onAddBooks }: LibraryProps) {
  return (
    <div className={styles.library} data-platform={platform}>
      <div className={styles.head}>
        <h1 className={styles.title}>Library</h1>
        <button type="button" className={styles.add} onClick={onAddBooks}>
          <Plus size={ICON.control} strokeWidth={ICON.stroke} />
          Add books
        </button>
      </div>

      {books.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Your library is empty</div>
          <div className={styles.emptyBody}>
            Books you open appear here, with everything you have marked in them.
          </div>
        </div>
      ) : (
        <div className={styles.shelf}>
          {books.map((book) => {
            const reopenable = isReopenable(book)
            return (
              <button
                key={book.bookId}
                type="button"
                className={styles.book}
                disabled={!reopenable}
                data-disabled={!reopenable}
                title={reopenable ? `Open ${displayTitle(book)}` : NOT_REOPENABLE}
                onClick={() => book.url && onOpen(book.url)}
              >
                <span className={styles.cover} style={{ background: coverTintFor(book.bookId) }}>
                  <span className={styles.coverTitle}>{displayTitle(book)}</span>
                </span>
                <span className={styles.bookTitle}>{displayTitle(book)}</span>
                <span className={styles.bookAuthor}>
                  {displayAuthor(book)}
                  {rowSuffix(book)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
