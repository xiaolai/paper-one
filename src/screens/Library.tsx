import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Check, FolderPlus, Globe, Plus, Tag, X } from 'lucide-react'
import {
  NOT_REOPENABLE,
  displayAuthor,
  displayTitle,
  allTags,
  isReopenable,
  statusOf,
  rowSuffix,
  shelfView,
  tagCounts,
} from '../lib/library'
import type { LibraryEntry, LibraryOrder, Scope } from '../lib/library'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import type { Collection } from '../lib/collections'
import { scopeOf } from '../lib/collections'
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
  /** The reader's saved scopes — see `collections.ts`. */
  collections: readonly Collection[]
  onSaveCollection: (scope: Scope) => void
  onRemoveCollection: (id: string) => void
  /** Add or remove one of the reader's own tags. Publisher subjects are fixed. */
  onTag: (bookId: string, tag: string) => void
  onUntag: (bookId: string, tag: string) => void
  /** The reader's judgement that a book is done. */
  onSetFinished: (bookId: string, finished: boolean) => void
  /**
   * Ask Open Library about ONE book, because the reader asked.
   *
   * Decision 1. The only thing in this screen that leaves the machine, and it
   * takes a deliberate click on a specific book — never automatic, never on
   * import, never in bulk.
   */
  onLookUp: (entry: LibraryEntry) => void
  /** Add a whole folder — see `importFolder`. */
  onAddFolder: () => void
  /** Live import progress, or null when none is running. */
  importing: { done: number; total: number; current: string } | null
  /** What the last import did, in one line. */
  importNotice: string | null
  /** The folder Paper is watching, or null — see `watchedFolder.ts`. */
  watchedFolder: string | null
  onConnectFolder: () => void
  onDisconnectFolder: () => void
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
  collections,
  onSaveCollection,
  onRemoveCollection,
  onTag,
  onUntag,
  onSetFinished,
  onLookUp,
  onAddFolder,
  importing,
  importNotice,
  watchedFolder,
  onConnectFolder,
  onDisconnectFolder,
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
      const rowHeight = cell ? cell.offsetHeight + 24 : 0
      const columns = cell && cell.offsetWidth > 0
        ? Math.max(1, Math.round(node.clientWidth / (cell.offsetWidth + 24)))
        : 0
      const scroller = node.closest('[data-scroll]') ?? node.parentElement
      setViewport({
        scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : 0,
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
        {/* Connecting is not the same as adding: one copies a folder in once,
            the other keeps looking. Both are here because a reader who wants the
            second almost always tries the first. */}
        <button
          type="button"
          className={styles.add}
          onClick={watchedFolder ? onDisconnectFolder : onConnectFolder}
          title={watchedFolder ?? undefined}
        >
          {watchedFolder ? 'Stop watching' : 'Watch a folder'}
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
            placeholder="Search title, author, series, tag"
            aria-label="Search the library"
          />
          {/* Counts are DERIVED and counted within the scope, so they describe
              what the reader can actually reach. The chips these replace were a
              prototype constant reading `All 2,418`. */}
          {tags.length > 0 && (
            <div className={styles.chips}>
              {scope && (
                <>
                  <button
                    type="button"
                    className={styles.chip}
                    data-active="true"
                    onClick={() => setScope(null)}
                  >
                    {scope.label} ✕
                  </button>
                  {/* Only when it is not already saved — offering to save a
                      collection that exists is a control that appears to do
                      nothing, which is worse than an absent one. */}
                  {!collections.some((one) => one.tag === scope.tag && one.series === scope.series) && (
                    <button
                      type="button"
                      className={styles.chip}
                      onClick={() => onSaveCollection(scope)}
                    >
                      Save as collection
                    </button>
                  )}
                </>
              )}
              {!scope &&
                collections.map((one) => (
                  <button
                    key={one.id}
                    type="button"
                    className={styles.chip}
                    data-saved="true"
                    onClick={() => setScope(scopeOf(one))}
                    onAuxClick={() => onRemoveCollection(one.id)}
                    title={`${one.label} — middle-click to unsave`}
                  >
                    {one.label}
                  </button>
                ))}
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
        <div className={styles.shelf} ref={shelfRef} style={
          virtualising ? { paddingBlockStart: win.padTop, paddingBlockEnd: win.padBottom } : undefined
        }>
          {visible.map((book) => {
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
              <button
                type="button"
                className={styles.tagButton}
                aria-label={`Tag ${displayTitle(book)}`}
                onClick={() => {
                  setDraftTag('')
                  setTagging((at) => (at === book.bookId ? null : book.bookId))
                }}
              >
                <Tag size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
              <button
                type="button"
                className={styles.finishButton}
                aria-label={
                  statusOf(book) === 'finished'
                    ? `Mark ${displayTitle(book)} unread`
                    : `Mark ${displayTitle(book)} finished`
                }
                data-finished={statusOf(book) === 'finished'}
                onClick={() => onSetFinished(book.bookId, statusOf(book) !== 'finished')}
              >
                <Check size={ICON.control} strokeWidth={ICON.stroke} />
              </button>
              {/* Offered only where it HELPS: a book that already knows its own
                  author does not need a stranger's opinion, and a control that
                  appears on every row invites the bulk use Decision 1 rules out. */}
              {!book.author && (
                <button
                  type="button"
                  className={styles.lookupButton}
                  aria-label={`Look up ${displayTitle(book)} on Open Library`}
                  title="Look up on Open Library — this is the one thing here that uses the network"
                  onClick={() => onLookUp(book)}
                >
                  <Globe size={ICON.control} strokeWidth={ICON.stroke} />
                </button>
              )}
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
                        onClick={() => (mine ? onUntag(book.bookId, tag) : setScope({ label: tag, tag }))}
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
