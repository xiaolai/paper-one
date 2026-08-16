import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { coverTintFor } from '../lib/bookAccent'
import type { IndexedBook } from '../lib/bookIndex'
import { displayAuthor, displayTitle, matchesQuery } from '../lib/library'
import { ICON } from '../lib/metrics'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * The book switcher, behind the titlebar chip.
 *
 * It lists books this reader has actually opened, not a fixture shelf.
 *
 * EVERY ROW OPENS. It used to be thin for a reason that no longer exists: a book
 * picked or dropped as a File could not be reopened, because a File is a handle
 * to bytes granted for one session — so those rows were shown but disabled, with
 * the reason stated. Paper now keeps its own copy of every book in the book's own
 * folder, so there is no such thing as a row that cannot be opened, and the
 * disabled state, its explanation and the concept behind them are all gone.
 *
 * It stays GLOBAL, and deliberately: this is navigation, not browsing. A reader
 * reaching for it wants any book, not any book within whatever tag the shelf
 * happens to be scoped to.
 */

export interface BookSwitcherProps {
  books: readonly IndexedBook[]
  /** The open book, so it can be marked rather than offered. */
  currentBookId: string | null
  /** Open a row. Takes the ENTRY, not a url: a book can be reopened from a
   *  stored path as well, and only the caller knows how to read one. */
  onOpen: (entry: IndexedBook) => void
  onDismiss: () => void
  onAddBooks: () => void
}

export function BookSwitcher({
  books,
  currentBookId,
  onOpen,
  onDismiss,
  onAddBooks,
}: BookSwitcherProps) {
  const [query, setQuery] = useState('')

  /* Matched on what the row DISPLAYS — see `matchesQuery`. Filtering the raw
   * fields meant a row reading "Untitled · Unknown author" could not be found
   * by typing either of those words. */
  const shown = useMemo(
    () => books.filter((book) => matchesQuery(book, query)),
    [books, query],
  )

  return (
    <OverlaySheet label="Switch book" onDismiss={onDismiss}>
      <div className={styles.field}>
        <Search size={ICON.control} strokeWidth={ICON.stroke} />
        <input
          className={styles.input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a book"
          aria-label="Find a book"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className={styles.list}>
        {books.length === 0 ? (
          <div className={styles.empty}>
            No books yet.
            <br />
            Books you open appear here.
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.empty}>No book matches “{query.trim()}”.</div>
        ) : (
          shown.map((book) => {
            const isCurrent = book.bookId === currentBookId
            return (
              <button
                key={book.bookId}
                type="button"
                className={styles.row}
                disabled={isCurrent}
                data-disabled={isCurrent}
                title={isCurrent ? 'Already open' : undefined}
                onClick={() => onOpen(book)}
              >
                <span
                  className={styles.cover}
                  style={{ background: coverTintFor(book.bookId) }}
                  aria-hidden
                />
                <span className={styles.rowLabel}>
                  {displayTitle(book)}
                  <span className={styles.rowSub}>
                    {displayAuthor(book)}
                  </span>
                </span>
              </button>
            )
          })
        )}

        <button
          type="button"
          className={styles.row}
          onClick={() => {
            onDismiss()
            onAddBooks()
          }}
        >
          <span className={styles.rowLabel}>Add books…</span>
        </button>
      </div>
    </OverlaySheet>
  )
}
