import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { coverTint } from '../data/fixtures'
import type { LibraryEntry } from '../lib/library'
import { ICON } from '../lib/metrics'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * The book switcher, behind the titlebar chip.
 *
 * It lists books this reader has actually opened, not a fixture shelf. That
 * makes it honest and also makes it thin: a book picked or dropped as a File
 * cannot be reopened, because a File is a handle to bytes granted for that
 * session and there is no path to keep. Those rows are shown — the reader knows
 * they read the book, and its marks are still in Notes — but disabled, with the
 * reason stated, per §07. Anything else would be a row that does nothing when
 * clicked.
 */

export interface BookSwitcherProps {
  books: readonly LibraryEntry[]
  /** The open book, so it can be marked rather than offered. */
  currentBookId: string | null
  onOpen: (url: string) => void
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return books
    return books.filter(
      (book) =>
        book.title.toLowerCase().includes(q) || book.author.toLowerCase().includes(q),
    )
  }, [books, query])

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
          shown.map((book, index) => {
            const isCurrent = book.bookId === currentBookId
            const reopenable = book.url !== null
            return (
              <button
                key={book.bookId}
                type="button"
                className={styles.row}
                disabled={isCurrent || !reopenable}
                data-disabled={isCurrent || !reopenable}
                title={
                  isCurrent
                    ? 'Already open'
                    : reopenable
                      ? undefined
                      : 'Opened from a file — add it again to reopen'
                }
                onClick={() => book.url && onOpen(book.url)}
              >
                <span
                  className={styles.cover}
                  style={{ background: coverTint(index) }}
                  aria-hidden
                />
                <span className={styles.rowLabel}>
                  {book.title || 'Untitled'}
                  <span className={styles.rowSub}>
                    {book.author || 'Unknown author'}
                    {isCurrent
                      ? ' · open'
                      : reopenable
                        ? ''
                        : ' · add the file again to reopen'}
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
