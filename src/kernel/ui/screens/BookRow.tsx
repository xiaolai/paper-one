import { useMemo, useRef, type DragEvent, type MouseEvent } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookAction } from '../../core/capability'
import {
  CANNOT_OPEN,
  canOpen,
  displayAuthor,
  displayTitle,
  statusOf,
  type TagCount,
} from '../../core/library'
import { ICON } from '../../core/metrics'
import { relativeTime } from '../../core/relativeTime'
import { useRowMenu } from '../hooks/useRowMenu'
import { BookCover } from './BookCover'
import { BookMenu } from './BookMenu'
import { readSelectClick, type SelectMode } from './BookCell'
import { TagEditor } from './TagEditor'
import editorStyles from './TagEditor.module.css'
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
  readonly setMenuFor: React.Dispatch<React.SetStateAction<string | null>>
  readonly confirming: string | null
  readonly setConfirming: React.Dispatch<React.SetStateAction<string | null>>
  /** Which book has its tag editor open, by id. */
  readonly tagging: string | null
  readonly setTagging: React.Dispatch<React.SetStateAction<string | null>>
  readonly shelfTags: readonly TagCount[]
  readonly selected: boolean
  readonly selecting: boolean
  readonly onSelect: (book: IndexedBook, mode: SelectMode) => void
  readonly onDragStart: (book: IndexedBook, event: DragEvent) => void
  readonly onTagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  readonly onUntagBooks: (bookIds: readonly string[], tag: string) => void
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
  tagging,
  setTagging,
  shelfTags,
  selected,
  selecting,
  onSelect,
  onDragStart,
  onTagBooks,
  onUntagBooks,
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
  const editing = tagging === book.bookId
  const rowRef = useRef<HTMLDivElement | null>(null)

  const { moreRef, menuRef, menuStyle, close: closeMenu } = useRowMenu(
    menuOpen,
    rowRef,
    () => {
      /* Only this row's OWN state, functionally — another row's menu may have
       * opened since, and its armed remove with it. A blanket
       * `setConfirming(null)` here disarmed whichever row was confirming when
       * this one's close fired late. */
      setMenuFor((at) => (at === book.bookId ? null : at))
      setConfirming((at) => (at === book.bookId ? null : at))
    },
    // A real menu: focus and arrow keys — see `useRowMenu`.
    { side: 'bottom', align: 'end', menu: true },
  )

  /* THE SAME EDITOR THE CARD OPENS, under this row rather than under a
   * jacket. The menu's "Tags…" sets one piece of state for both views;
   * without an editor here that action would set it and nothing would
   * appear — the menu would offer something the view could not do. Placed
   * from the viewport, so nothing below shifts, which in a virtualised list
   * would move every row under the pointer. */
  const { menuRef: editorRef, menuStyle: editorStyle } = useRowMenu(
    editing,
    rowRef,
    () => setTagging((at) => (at === book.bookId ? null : at)),
    { side: 'bottom', align: 'start' },
  )

  /* The same reading of a click the card gives it — literally: see
   * `readSelectClick`, which both views call. */
  const onRowClick = (event: MouseEvent) => {
    const meant = readSelectClick(event, selecting)
    if (meant === 'open') {
      if (openable) onOpen(book)
    } else onSelect(book, meant)
  }

  const opened = relativeTime(book.openedAt, now)
  /* ONE derivation for the condition, the bar and the percent — see `BookCell`. */
  const progress = book.progress ?? 0
  const pct = Math.round(progress * 100)
  const editorBooks = useMemo(() => [book], [book])

  return (
    <div
      className={styles.row}
      ref={rowRef}
      data-open={menuOpen}
      data-selected={selected}
      draggable
      onDragStart={(event) => onDragStart(book, event)}
    >
      {/* THE WHOLE ROW OPENS THE BOOK, not just the title — a row that is only
          clickable along one word is a row a reader misses. The menu button
          sits outside this button for the same reason it does on the card: two
          controls, not one ambiguous target. */}
      <button
        type="button"
        className={styles.rowOpen}
        /* Dimmed, not `disabled` — a ⌘-click on a no-copy row is how
           selection STARTS, and disabled refused it. See the card. */
        data-nocopy={!openable}
        aria-pressed={selecting ? selected : undefined}
        title={
          selecting
            ? selected
              ? `Deselect ${title}`
              : `Select ${title}`
            : openable
              ? `Open ${title}`
              : CANNOT_OPEN
        }
        onClick={onRowClick}
      >
        {/* The selection mark takes the thumbnail's place: in a list the
            column is what the eye scans down, and a check there reads as
            "this row is in" without a second column of boxes. */}
        {selected ? (
          <span className={styles.rowSelected} aria-hidden="true">
            <Check size={ICON.control} strokeWidth={ICON.stroke} />
          </span>
        ) : (
          <BookCover
            book={book}
            title={title}
            className={styles.rowCover ?? ''}
            tintedClassName={styles.rowCoverTinted ?? ''}
            titleClassName={styles.rowCoverTitle ?? ''}
          />
        )}
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
          ) : progress > 0 ? (
            <>
              <span className={styles.rowBar} aria-hidden="true">
                <span
                  className={styles.rowBarFill}
                  style={{ inlineSize: `${pct}%` }}
                />
              </span>
              <span className={styles.rowPercent}>
                {pct}%
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

      {editing && (
        <div ref={editorRef} className={editorStyles.popover} style={editorStyle} role="dialog" aria-label={`Tags for ${title}`}>
          <TagEditor books={editorBooks} shelfTags={shelfTags} onAdd={onTagBooks} onRemove={onUntagBooks} />
        </div>
      )}

      <button
        ref={moreRef}
        type="button"
        className={styles.rowMore}
        aria-label={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-open={menuOpen}
        title="Finish, tag, select, or remove"
        onClick={() => {
          setConfirming((at) => (at === book.bookId ? null : at))
          // ANY editor, whichever row's — see the card's `⋯`: one surface at
          // a time is a shelf rule, and keyboard opens skip the
          // outside-pointerdown that enforces it for the pointer.
          setTagging(null)
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
            selected={selected}
            onToggleSelect={() => onSelect(book, 'toggle')}
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
