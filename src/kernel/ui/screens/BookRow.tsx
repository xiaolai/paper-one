import { useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookAction } from '../../core/capability'
import { CANNOT_OPEN, canOpen, displayAuthor, displayTitle, statusOf } from '../../core/library'
import { ICON } from '../../core/metrics'
import { relativeTime } from '../../core/relativeTime'
import { useRowMenu } from '../hooks/useRowMenu'
import { BookCover } from './BookCover'
import { BookMenu } from './BookMenu'
import styles from './Library.module.css'

/**
 * One book as a row.
 *
 * WHAT A LIST IS FOR, and it is not a denser grid. A grid of jackets is for
 * RECOGNITION — a reader finds the book by its cover, and the cover is the
 * whole of what a cell says. A list is for SCANNING and COMPARING, which means
 * it has to carry the facts a jacket cannot: who wrote it, how far in the
 * reader is, when they last had it open. Every column here earns its place by
 * answering a question the grid leaves open.
 *
 * A THUMBNAIL, not no picture at all. Recognition is still the fastest way a
 * reader finds a book they know, so the jacket stays — small enough to be an
 * anchor for the eye rather than the subject of the row.
 *
 * ONE LINE, NEVER TWO. Every row is the same height, which is what lets the
 * same virtualiser drive this view as drives the grid, and what makes a column
 * of two thousand titles scannable at all. Everything truncates; nothing wraps.
 *
 * Deliberately NOT here: tags, and the file format. Tags are variable-length
 * and would either wrap the row or be cut to a misleading one or two — the
 * Library panel shows every tag with a count, which is the honest place for
 * them. The format matters when a book behaves differently (a PDF does not
 * reflow), but that is a fact about reading it, learned on opening it, not a
 * thing anyone scans a library by.
 */
export interface BookRowProps {
  readonly book: IndexedBook
  readonly now: number
  readonly menuFor: string | null
  readonly setMenuFor: (bookId: string | null) => void
  readonly confirming: string | null
  readonly setConfirming: (bookId: string | null) => void
  readonly setTagging: (bookId: string | null) => void
  /** Which book has its tag field open, and what has been typed into it. */
  readonly tagging: string | null
  readonly draftTag: string
  readonly setDraftTag: (tag: string) => void
  readonly onTag: (bookId: string, tag: string) => void
  readonly onOpen: (book: IndexedBook) => void
  readonly onRemove: (book: IndexedBook) => void
  readonly onSetFinished: (bookId: string, finished: boolean) => void
  /** Contributed actions, passed through to the menu — see `BookMenu`. */
  readonly actions: readonly BookAction[]
}

export function BookRow({
  book,
  now,
  menuFor,
  setMenuFor,
  confirming,
  setConfirming,
  setTagging,
  tagging,
  draftTag,
  setDraftTag,
  onTag,
  onOpen,
  onRemove,
  onSetFinished,
  actions,
}: BookRowProps) {
  const title = displayTitle(book)
  const author = displayAuthor(book)
  const status = statusOf(book)
  const openable = canOpen(book)
  const menuOpen = menuFor === book.bookId
  const rowRef = useRef<HTMLDivElement | null>(null)

  const { moreRef, menuRef, menuStyle, close: closeMenu } = useRowMenu(
    menuOpen,
    rowRef,
    () => {
      // Only this row's own menu: another row's may have opened since.
      if (menuFor === book.bookId) setMenuFor(null)
      setConfirming(null)
    },
    { side: 'bottom', align: 'end' },
  )

  const opened = relativeTime(book.openedAt, now)

  return (
    <div className={styles.row} ref={rowRef} data-open={menuOpen}>
      {/* THE WHOLE ROW OPENS THE BOOK, not just the title — a row that is only
          clickable along one word is a row a reader misses. The menu button
          sits outside this button for the same reason it does on the card: two
          controls, not one ambiguous target. */}
      <button
        type="button"
        className={styles.rowOpen}
        data-disabled={!openable}
        disabled={!openable}
        title={openable ? `Open ${title}` : CANNOT_OPEN}
        onClick={() => onOpen(book)}
      >
        <BookCover
          book={book}
          title={title}
          className={styles.rowCover ?? ''}
          tintedClassName={styles.rowCoverTinted ?? ''}
          titleClassName={styles.rowCoverTitle ?? ''}
        />
        <span className={styles.rowTitle}>
          <span className={styles.rowTitleText}>{title}</span>
          {/* The series, where the book belongs to one — a fact the jacket
              rarely shows and the reason a reader is looking for book three. */}
          {book.series && (
            <span className={styles.rowSeries}>
              {book.series}
              {book.seriesIndex === null || book.seriesIndex === undefined
                ? ''
                : ` ${book.seriesIndex}`}
            </span>
          )}
        </span>
        <span className={styles.rowAuthor}>{author}</span>
        {/* HOW FAR IN, which is the question a shelf of part-read books exists
            to answer and the one thing a jacket can never say. Three states,
            each said differently: finished is a word, because a bar at 100%
            and a bar at 97% are the same picture; untouched is a dash, because
            "0%" implies a reader started and got nowhere. */}
        <span className={styles.rowProgress}>
          {status === 'finished' ? (
            <span className={styles.rowFinished}>Finished</span>
          ) : (book.progress ?? 0) > 0 ? (
            <>
              <span className={styles.rowBar} aria-hidden="true">
                <span
                  className={styles.rowBarFill}
                  style={{ inlineSize: `${Math.round((book.progress ?? 0) * 100)}%` }}
                />
              </span>
              <span className={styles.rowPercent}>
                {Math.round((book.progress ?? 0) * 100)}%
              </span>
            </>
          ) : (
            <span className={styles.rowNone} aria-label="Not started">
              —
            </span>
          )}
        </span>
        {/* LAST OPENED, not "added". A folder import stamps two thousand books
            with the same minute, so `addedAt` would be one repeated value down
            the whole column — informative about nothing. When the reader last
            had a book open is what distinguishes one row from the next. */}
        <span className={styles.rowWhen}>{opened ?? <span className={styles.rowNone}>—</span>}</span>
      </button>

      {/* THE SAME FIELD THE CARD OPENS, over this row rather than under a
          cover. The menu's "Add a tag…" sets one piece of state for both views;
          without a field here that action would set it and nothing would
          appear — the menu would offer something the view could not do. Laid
          over the row so nothing below shifts, which in a virtualised list
          would move every row under the pointer. */}
      {tagging === book.bookId && (
        <form
          className={styles.rowTagForm}
          onSubmit={(event) => {
            event.preventDefault()
            onTag(book.bookId, draftTag)
            setDraftTag('')
          }}
        >
          <input
            className={styles.rowTagInput}
            value={draftTag}
            onChange={(event) => setDraftTag(event.target.value)}
            placeholder="Add a tag"
            aria-label={`Add a tag to ${title}`}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') setTagging(null)
            }}
            onBlur={() => setTagging(null)}
          />
        </form>
      )}

      <button
        ref={moreRef}
        type="button"
        className={styles.rowMore}
        aria-label={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-open={menuOpen}
        title="Finish, tag, or remove"
        onClick={() => {
          setConfirming(null)
          setMenuFor(menuOpen ? null : book.bookId)
        }}
      >
        <MoreHorizontal size={ICON.control} strokeWidth={ICON.stroke} />
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className={styles.menu}
          role="menu"
          aria-label={`Actions for ${title}`}
          style={menuStyle}
        >
          <BookMenu
            book={book}
            title={title}
            status={status}
            confirming={confirming}
            setConfirming={setConfirming}
            setTagging={setTagging}
            setDraftTag={setDraftTag}
            onRemove={onRemove}
            onSetFinished={onSetFinished}
            closeMenu={closeMenu}
            itemClass={styles.menuItem ?? ''}
            actions={actions}
          />
        </div>
      )}
    </div>
  )
}
