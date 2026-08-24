import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { coverTintFor } from '../../core/bookAccent'
import type { IndexedBook } from '../../core/bookIndex'
import { cannotOpenReason, canOpen, displayAuthor, displayTitle, matchesQuery } from '../../core/library'
import type { BookAction } from '../../core/capability'
import { ICON } from '../../core/metrics'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * The book switcher, behind the titlebar chip.
 *
 * It lists books this reader has actually opened, not a fixture shelf.
 *
 * ALMOST EVERY ROW OPENS. It used to be thin for a reason that no longer exists:
 * a book picked or dropped as a File could not be reopened, because a File is a
 * handle to bytes granted for one session — so those rows were shown but disabled,
 * with the reason stated. Paper keeps its own copy of every book in the book's own
 * folder now, so THAT reason is gone; what remains is a book whose bytes are not
 * on this device, which is disabled here and says why in its `title`.
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
  /* THE SAME ACTIONS THE SHELF HAS, for the same reason the disabled rule is
     the shelf's: a book with no bytes here explains itself in whichever
     surface the reader is looking at, and the remedy it names depends on
     whether anything can fetch the content. Without these the switcher would
     tell a satchel reader to re-import a file the shelf can simply send. */
  bookActions: readonly BookAction[]
}

export function BookSwitcher({
  books,
  currentBookId,
  onOpen,
  onDismiss,
  onAddBooks,
  bookActions,
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
                /* THE SAME RULE THE SHELF USES. The switcher offered a book
                 * Paper has no copy of, and clicking it dismissed the switcher
                 * and failed — with the explanation appearing on the Library
                 * screen, which is not the screen the reader is looking at. A
                 * row that cannot open should say so where it is. */
                /* `aria-disabled`, NOT `disabled`. A disabled button is
                   removed from the tab order, so the row's explanation — the
                   whole point of showing it rather than hiding it — was
                   unreachable by the readers most likely to need it: a
                   keyboard user could not land on the row, and a screen
                   reader announced nothing. Marked unavailable and left
                   focusable, with the click guarded instead. */
                aria-disabled={isCurrent || !canOpen(book)}
                data-disabled={isCurrent || !canOpen(book)}
                title={isCurrent ? 'Already open' : canOpen(book) ? undefined : cannotOpenReason(book, bookActions)}
                onClick={() => {
                  if (isCurrent || !canOpen(book)) return
                  onOpen(book)
                }}
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
