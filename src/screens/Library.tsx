import { useDeferredValue, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  NOT_REOPENABLE,
  displayAuthor,
  displayTitle,
  isReopenable,
  rowSuffix,
  shelfView,
  tagCounts,
} from '../lib/library'
import type { LibraryEntry, LibraryOrder, Scope } from '../lib/library'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { BookCover } from './BookCover'
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
  /** Open a row. Takes the ENTRY, not a url: a book can be reopened from a
   *  stored path as well, and only the caller knows how to read one. */
  onOpen: (entry: LibraryEntry) => void
  onAddBooks: () => void
  /**
   * Take a book off the shelf.
   *
   * Named `onRemove` rather than `onDelete` because of what it does NOT do: the
   * reader's own file stays exactly where it is. Paper gives up its own copy,
   * and the marks and the reading position survive — they are keyed by content,
   * so adding the book again finds them waiting.
   */
  onRemove: (entry: LibraryEntry) => void
}

const ORDERS: readonly { id: LibraryOrder; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
]

export function Library({ books, platform, onOpen, onAddBooks, onRemove }: LibraryProps) {
  const [order, setOrder] = useState<LibraryOrder>('recent')
  /* Which row is asking to be confirmed, by id.
   *
   * A second click rather than a dialog. Removal here is not destructive — the
   * file survives and so do the marks — so a modal would be a ceremony out of
   * all proportion to what happens. But it is also one pixel from Open, and a
   * misclick that silently empties a row is worse than one extra click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /* The SCOPE — Decision 2. A collection restricts what is in play, and the
   * search then runs inside it rather than beside it. Held here for now; the
   * collections that produce one arrive in WI-3.6, and every consumer below is
   * already written against it so none of them has to change then. */
  const [scope, setScope] = useState<Scope | null>(null)

  /* Deferred, not debounced. `useDeferredValue` lets the keystroke paint
   * immediately and re-filters at React's leisure, which is the behaviour a
   * debounce is usually approximating — and unlike a debounce it has no timer to
   * tune and cannot drop the final keystroke. */
  const deferredQuery = useDeferredValue(query)
  const shelf = useMemo(
    () => shelfView(books, { scope, query: deferredQuery, order }),
    [books, scope, deferredQuery, order],
  )
  const tags = useMemo(() => tagCounts(books, scope), [books, scope])

  return (
    <div className={styles.library} data-platform={platform}>
      <div className={styles.head}>
        <h1 className={styles.title}>Library</h1>
        {/* Says what is on the shelf. A count is the one thing a grid cannot
            show at a glance once it scrolls. */}
        {books.length > 0 && (
          <span className={styles.count}>
            {books.length} {books.length === 1 ? 'book' : 'books'}
          </span>
        )}
        {books.length > 1 && (
          <div className={styles.orders}>
            {ORDERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                className={styles.order}
                data-on={order === id}
                aria-pressed={order === id}
                onClick={() => setOrder(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button type="button" className={styles.add} onClick={onAddBooks}>
          <Plus size={ICON.control} strokeWidth={ICON.stroke} />
          Add books
        </button>
      </div>

      {books.length > 0 && (
        <div className={styles.filters}>
          <input
            type="search"
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, author, series, tag"
            aria-label="Search the library"
          />
          {/* Counts are DERIVED and counted within the scope, so they describe
              what the reader can actually reach. The chips these replace were a
              prototype constant reading `All 2,418`. */}
          {tags.length > 0 && (
            <div className={styles.chips}>
              {scope && (
                <button
                  type="button"
                  className={styles.chip}
                  data-active="true"
                  onClick={() => setScope(null)}
                >
                  {scope.label} ✕
                </button>
              )}
              {!scope &&
                tags.slice(0, 8).map(({ tag, count }) => (
                  <button
                    key={tag}
                    type="button"
                    className={styles.chip}
                    onClick={() => setScope({ label: tag, tag })}
                  >
                    {tag} <span className={styles.chipCount}>{count}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {shelf.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>
            {/* NAMES ITS SCOPE. "No books" inside a collection with a full
                library behind it is the most confusing state this design can
                produce — Decision 2 calls it out for exactly this reason. */}
            {books.length === 0
              ? 'Your library is empty'
              : scope
                ? `Nothing in ${scope.label} matches`
                : 'Nothing matches'}
          </div>
          <div className={styles.emptyBody}>
            {books.length === 0
              ? 'Books you open appear here, with everything you have marked in them.'
              : 'Try a different search, or clear the filter.'}
          </div>
        </div>
      ) : (
        <div className={styles.shelf}>
          {shelf.map((book) => {
            const reopenable = isReopenable(book)
            return (
              <div key={book.bookId} className={styles.cell}>
              <button
                type="button"
                className={styles.book}
                disabled={!reopenable}
                data-disabled={!reopenable}
                title={reopenable ? `Open ${displayTitle(book)}` : NOT_REOPENABLE}
                onClick={() => isReopenable(book) && onOpen(book)}
              >
                <BookCover
                  book={book}
                  title={displayTitle(book)}
                  className={styles.cover}
                  titleClassName={styles.coverTitle}
                />
                <span className={styles.bookTitle}>{displayTitle(book)}</span>
                <span className={styles.bookAuthor}>
                  {displayAuthor(book)}
                  {rowSuffix(book)}
                </span>
              </button>
              {/* OUTSIDE the open button, not inside it. A button nested in a
                  button is invalid, and browsers resolve it by dropping the
                  inner one — so the remove control would render and simply never
                  fire, which looks like a broken feature rather than bad markup. */}
              <button
                type="button"
                className={styles.remove}
                aria-label={
                  confirming === book.bookId
                    ? `Remove ${displayTitle(book)} from the library — your file is kept`
                    : `Remove ${displayTitle(book)}`
                }
                data-confirming={confirming === book.bookId}
                onClick={() => {
                  if (confirming === book.bookId) {
                    setConfirming(null)
                    onRemove(book)
                  } else {
                    setConfirming(book.bookId)
                  }
                }}
                onBlur={() => setConfirming((at) => (at === book.bookId ? null : at))}
              >
                {confirming === book.bookId ? 'Remove?' : <X size={ICON.control} strokeWidth={ICON.stroke} />}
              </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
