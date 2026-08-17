import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { BookCheck, FolderPlus, Plus, Tag, X } from 'lucide-react'
import {
  CANNOT_OPEN,
  allTags,
  canOpen,
  displayAuthor,
  displayTitle,
  shelfFor,
  statusOf,
  tagCounts,
  tagKey,
} from '../lib/library'
import type { LibraryOrder } from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { withTag, withoutTag } from '../lib/searchQuery'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { VIRTUALISE_ABOVE, gridWindow } from '../lib/virtualGrid'
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
  books: readonly IndexedBook[]
  platform: Platform
  /** Open a row. Takes the ENTRY, not a url: a book can be reopened from a
   *  stored path as well, and only the caller knows how to read one. */
  onOpen: (entry: IndexedBook) => void
  onAddBooks: () => void
  /**
   * Take a book off the shelf.
   *
   * Named `onRemove` rather than `onDelete` because of what it does NOT do: the
   * reader's own file stays exactly where it is. Paper gives up its own copy,
   * and the marks and the reading position survive — they are keyed by content,
   * so adding the book again finds them waiting.
   */
  onRemove: (entry: IndexedBook) => void
  /** Add or remove one of the reader's own tags. Publisher subjects are fixed. */
  onTag: (bookId: string, tag: string) => void
  onUntag: (bookId: string, tag: string) => void
  /** The reader's judgement that a book is done. */
  onSetFinished: (bookId: string, finished: boolean) => void
  /** Add a whole folder — see `importFolder`. */
  onAddFolder: () => void
  /** Live import progress, or null when none is running. */
  importing: { done: number; total: number; current: string } | null
  /** The shelf could not be read — see `Reader`'s prop of the same name. */
  shelfUnread?: boolean
  /** What the last import did, in one line. */
  importNotice: string | null
}

const ORDERS: readonly { id: LibraryOrder; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'title', label: 'Title' },
  { id: 'author', label: 'Author' },
]

export function Library({
  books,
  platform,
  onOpen,
  onAddBooks,
  onRemove,
  onTag,
  onUntag,
  onSetFinished,
  onAddFolder,
  importing,
  importNotice,
  shelfUnread = false,
}: LibraryProps) {
  const [order, setOrder] = useState<LibraryOrder>('recent')
  /* Which row is asking to be confirmed, by id.
   *
   * A second click rather than a dialog. Removal here is not destructive — the
   * file survives and so do the marks — so a modal would be a ceremony out of
   * all proportion to what happens. But it is also one pixel from Open, and a
   * misclick that silently empties a row is worse than one extra click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Which row has its tag input open, by id. */
  const [tagging, setTagging] = useState<string | null>(null)
  const [draftTag, setDraftTag] = useState('')
  /* ONE piece of state, and that is the point of the `tag:` syntax.
   *
   * There was a `scope` beside this field, which meant two sources of truth
   * that could disagree — a chip could say Philosophy while the field said
   * something else. The query now carries both: `tag:Philosophy whales` is the
   * scope AND the text, visible, editable, and copyable out of the box. */
  const [query, setQuery] = useState('')

  /* Deferred, not debounced. `useDeferredValue` lets the keystroke paint
   * immediately and re-filters at React's leisure, which is the behaviour a
   * debounce is usually approximating — and unlike a debounce it has no timer to
   * tune and cannot drop the final keystroke. */
  const deferredQuery = useDeferredValue(query)
  const view = useMemo(() => shelfFor(books, deferredQuery, order), [books, deferredQuery, order])
  const shelf = view.books
  /* Counted WITHIN the active tags, so the numbers describe what is reachable
   * from here — adding a second tag shows what is left, not what exists. */
  const tags = useMemo(
    () => tagCounts(books, { tags: view.tags }),
    [books, view.tags],
  )

  /* Virtualisation, but only past the point where it pays.
   *
   * Below `VIRTUALISE_ABOVE` the window arithmetic, the spacers and the scroll
   * listener cost more than they save, and they add a class of bug — a shelf
   * showing the wrong slice — to a screen that had none. Most readers never
   * cross it, and those who do have a shelf that would otherwise decode two
   * thousand covers at once. */
  const shelfRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, columns: 0, rowHeight: 0 })
  const virtualising = shelf.length > VIRTUALISE_ABOVE

  useEffect(() => {
    const node = shelfRef.current
    if (!node || !virtualising) return
    /* Measured from the FIRST CELL rather than assumed from the CSS. The grid is
     * responsive, so the column count and the row height are both facts about
     * the rendered layout — reading them from a constant would put the window a
     * row out at every breakpoint, which looks like a scroll glitch. */
    const measure = () => {
      const cell = node.firstElementChild as HTMLElement | null
      /* READ the gaps rather than assuming them. Both were hardcoded to 24px
       * while the stylesheet uses a different row and column gap, so the row
       * height was wrong by a few pixels per row — which is invisible near the
       * top and selects the wrong rows entirely once a reader has scrolled a
       * few hundred books down. */
      const style = getComputedStyle(node)
      const rowGap = parseFloat(style.rowGap) || 0
      const columnGap = parseFloat(style.columnGap) || 0
      const rowHeight = cell ? cell.offsetHeight + rowGap : 0
      const columns = cell && cell.offsetWidth > 0
        ? Math.max(1, Math.round((node.clientWidth + columnGap) / (cell.offsetWidth + columnGap)))
        : 0
      const scroller = node.closest('[data-scroll]') ?? node.parentElement
      /* SHELF-RELATIVE. The scroller's `scrollTop` counts from its own top,
       * which is above the heading, the sort controls and the filter row — so
       * feeding it straight to the grid told the arithmetic the reader was
       * further down the shelf than they were, by the height of everything
       * above it. `offsetTop` is that distance. */
      const above = node.offsetTop - (scroller instanceof HTMLElement ? scroller.offsetTop : 0)
      setViewport({
        scrollTop: scroller instanceof HTMLElement ? Math.max(0, scroller.scrollTop - above) : 0,
        height: scroller instanceof HTMLElement ? scroller.clientHeight : 0,
        columns,
        rowHeight,
      })
    }
    measure()
    const scroller = node.closest('[data-scroll]') ?? node.parentElement
    scroller?.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      scroller?.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [virtualising, shelf.length])

  const win = useMemo(
    () =>
      gridWindow({
        total: shelf.length,
        columns: viewport.columns,
        rowHeight: viewport.rowHeight,
        scrollTop: viewport.scrollTop,
        viewportHeight: viewport.height,
      }),
    [shelf.length, viewport],
  )
  const visible = virtualising ? shelf.slice(win.firstIndex, win.endIndex) : shelf

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
        <button
          type="button"
          className={styles.add}
          onClick={onAddFolder}
          disabled={importing !== null}
        >
          <FolderPlus size={ICON.control} strokeWidth={ICON.stroke} />
          Add folder
        </button>
      </div>

      {/* Per BOOK, not a spinner. An import of three hundred books that says
          only "working…" is indistinguishable from one that has hung. */}
      {importing && (
        <div className={styles.importing} role="status">
          {importing.total > 0
            ? `Importing ${importing.done} of ${importing.total} — ${importing.current}`
            : 'Reading the folder…'}
        </div>
      )}
      {!importing && importNotice && (
        <div className={styles.importing} role="status">
          {importNotice}
        </div>
      )}

      {books.length > 0 && (
        <div className={styles.filters}>
          <input
            type="search"
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search, or tag:Name to narrow"
            aria-label="Search the library"
          />
          {/* Counts are DERIVED and counted within the scope, so they describe
              what the reader can actually reach. The chips these replace were a
              prototype constant reading `All 2,418`. */}
          {/* NOT conditional on `tags.length` alone: the control that clears an
              active scope lives here, so gating on tag counts could strand a
              reader inside a scope whose last matching tag had just been
              removed, with no way back out. */}
          {(tags.length > 0 || view.tags.length > 0) && (
            <div className={styles.chips}>
              {/* The ACTIVE tags, read back out of the query. Clicking one
                  removes its term from the field rather than setting hidden
                  state, so the field and the chips cannot disagree. */}
              {view.tags.map((tag) => (
                <button
                  key={tagKey(tag)}
                  type="button"
                  className={styles.chip}
                  data-active="true"
                  onClick={() => setQuery((q) => withoutTag(q, tag, tagKey))}
                >
                  {tag} ✕
                </button>
              ))}
              {tags
                .filter(({ tag }) => !view.tags.some((one) => tagKey(one) === tagKey(tag)))
                .slice(0, 8)
                .map(({ tag, count }) => (
                  <button
                    key={tagKey(tag)}
                    type="button"
                    className={styles.chip}
                    onClick={() => setQuery((q) => withTag(q, tag, tagKey))}
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
            {/* NAMES ITS SCOPE. "No books" while a tag is narrowing a full
                library is the most confusing state this design can produce, so
                the message says which tags are in the way. */}
            {books.length === 0
              ? shelfUnread
                ? 'Your library could not be read'
                : 'Your library is empty'
              : view.tags.length > 0
                ? `Nothing tagged ${view.tags.join(' and ')} matches`
                : 'Nothing matches'}
          </div>
          <div className={styles.emptyBody}>
            {books.length === 0
              ? shelfUnread
                ? 'Nothing has been changed. Your books are still on disk — try reopening Paper.'
                : 'Books you open appear here, with everything you have marked in them.'
              : 'Try a different search, or clear the filter.'}
          </div>
        </div>
      ) : (
        <div className={styles.shelf} ref={shelfRef} style={
          virtualising ? { paddingBlockStart: win.padTop, paddingBlockEnd: win.padBottom } : undefined
        }>
          {visible.map((book) => {
            const openable = canOpen(book)
            return (
              <div
                key={book.bookId}
                className={styles.cell}
                /* WHILE A REMOVAL IS PENDING the other controls go away — see the
                   CSS. The confirm replaces a 26px circle with the word
                   "Remove?", which grows leftward from the same right edge and
                   lands exactly on top of the tag button. A reader reaching for
                   "cancel" by clicking the neighbouring control was hitting the
                   destructive one instead. */
                data-confirming={confirming === book.bookId}
                /* And it clears when the pointer leaves. `onBlur` is focus, not
                   hover, so moving the mouse away left a red pill on a card
                   nobody was touching — the one piece of state on this screen
                   that outlived the gesture that made it. */
                onMouseLeave={() => setConfirming((at) => (at === book.bookId ? null : at))}
              >
              <button
                type="button"
                className={styles.book}
                disabled={!openable}
                data-disabled={!openable}
                title={openable ? `Open ${displayTitle(book)}` : CANNOT_OPEN}
                onClick={() => openable && onOpen(book)}
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
                  {/* SAYS SO ON THE ROW. A shelf that shows a book it cannot
                      open, with nothing explaining why, is worse than one that
                      does not show it — the reader clicks and nothing happens. */}
                  {!openable && ' · no copy'}
                </span>
                {/* A bar only where there is something true to draw. A book
                    never opened has no fraction, and a zero-width bar under
                    every unread book is a row of noise that says nothing. */}
                {statusOf(book) !== 'unread' && (
                  <span
                    className={styles.progress}
                    data-finished={statusOf(book) === 'finished'}
                    /* The number is on the label rather than in the text: a bar
                       is legible at a glance and a percentage under every cover
                       is forty numbers nobody reads. */
                    aria-label={
                      statusOf(book) === 'finished'
                        ? 'Finished'
                        : `${Math.round((book.progress ?? 0) * 100)}% read`
                    }
                  >
                    <span
                      className={styles.progressFill}
                      style={{ inlineSize: `${Math.round((book.finished ? 1 : book.progress ?? 0) * 100)}%` }}
                    />
                  </span>
                )}
              </button>
              {/* IN READING ORDER, which is not what this was.
                  These are positioned from the right edge, so the DOM order used
                  to run backwards: tabbing off the cover reached the DESTRUCTIVE
                  control first and then walked leftwards. Laid out here the way
                  they appear, so focus goes left to right and Remove is last.

                  OUTSIDE the open button, not inside it. A button nested in a
                  button is invalid, and browsers resolve it by dropping the
                  inner one — so the control would render and simply never fire,
                  which looks like a broken feature rather than bad markup.

                  EVERY ONE CARRIES A `title`. They had only an `aria-label`,
                  which a screen reader announces and a pointer cannot see — so a
                  bare tick sat on every cover with nothing anywhere to say what
                  it did. */}
              <button
                type="button"
                className={styles.finishButton}
                aria-label={
                  statusOf(book) === 'finished'
                    ? `Mark ${displayTitle(book)} unread`
                    : `Mark ${displayTitle(book)} finished`
                }
                /* A BOOK with a tick, not a bare tick. On a card that can be
                   selected, confirmed or dismissed, ✓ reads as any of those —
                   and it was the one control here nobody could name. The book
                   in the glyph is what says the tick is about READING it. */
                title={
                  statusOf(book) === 'finished'
                    ? 'Finished — click to mark unread'
                    : 'Mark as finished'
                }
                data-finished={statusOf(book) === 'finished'}
                onClick={() => onSetFinished(book.bookId, statusOf(book) !== 'finished')}
              >
                <BookCheck size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
              <button
                type="button"
                className={styles.tagButton}
                aria-label={`Tag ${displayTitle(book)}`}
                title="Add a tag"
                onClick={() => {
                  setDraftTag('')
                  setTagging((at) => (at === book.bookId ? null : book.bookId))
                }}
              >
                <Tag size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
              <button
                type="button"
                className={styles.remove}
                aria-label={
                  confirming === book.bookId
                    ? `Remove ${displayTitle(book)} — the file you imported is kept, and this is recoverable for two weeks`
                    : `Remove ${displayTitle(book)}`
                }
                title={
                  confirming === book.bookId
                    ? 'The file you imported is untouched. Your tags, place and notes are recoverable for two weeks. Escape to cancel.'
                    : 'Remove from the library'
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
                /* ESCAPE CANCELS, like every other transient state in this app —
                   the tag field a few lines down already did, and the one control
                   here that destroys something did not. Blur alone was not a way
                   out: it fires on focus, so a reader who clicked the X and then
                   moved the mouse away was left with a red "Remove?" sitting on a
                   card they were no longer touching, and no key would dismiss it. */
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && confirming === book.bookId) {
                    event.stopPropagation()
                    setConfirming(null)
                  }
                }}
                onBlur={() => setConfirming((at) => (at === book.bookId ? null : at))}
              >
                {confirming === book.bookId ? 'Remove?' : <X size={ICON.control} strokeWidth={ICON.stroke} />}
              </button>
              {tagging === book.bookId && (
                <form
                  className={styles.tagForm}
                  onSubmit={(event) => {
                    event.preventDefault()
                    onTag(book.bookId, draftTag)
                    setDraftTag('')
                  }}
                >
                  <input
                    className={styles.tagInput}
                    value={draftTag}
                    onChange={(event) => setDraftTag(event.target.value)}
                    placeholder="Add a tag"
                    aria-label={`Add a tag to ${displayTitle(book)}`}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setTagging(null)
                    }}
                  />
                </form>
              )}
              {/* The reader's OWN tags carry a remove control; a publisher's
                  subject does not, because it is a fact about the book rather
                  than a choice, and it comes back on the next open anyway. */}
              {allTags(book).length > 0 && (
                <div className={styles.tagRow}>
                  {allTags(book).slice(0, 4).map((tag) => {
                    const mine = (book.tags ?? []).includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={styles.bookTag}
                        data-mine={mine}
                        title={mine ? `Remove the tag ${tag}` : `Show everything tagged ${tag}`}
                        /* A reader's own tag REMOVES; a publisher's subject
                           scopes. Two actions on one control, split by whose tag
                           it is — which is also why only one of them is styled
                           as removable. */
                        onClick={() =>
                          mine ? onUntag(book.bookId, tag) : setQuery((q) => withTag(q, tag, tagKey))
                        }
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
