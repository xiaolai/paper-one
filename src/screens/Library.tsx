import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { shelfFor, tagCounts, tagKey } from '../lib/library'
import type { LibraryOrder } from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { withTag, withoutTag } from '../lib/searchQuery'
import { ICON, cellHeightFor } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { VIRTUALISE_ABOVE, gridWindow } from '../lib/virtualGrid'
import { BookCell } from './BookCell'
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

  /* The cell's height, from the column it actually got.
   *
   * ALWAYS, not only while virtualising. `--cell-height` was referenced by the
   * stylesheet with a `268px` fallback and set by nothing, so the fallback did
   * every bit of the work and could not follow a fluid column: at a 173px
   * column the cover alone wants 259, leaving 9px for two lines of text and a
   * progress rule, which `overflow: hidden` then ate in silence.
   *
   * Set on the grid rather than per cell, so every row is the one height
   * virtualisation assumes — the reason the height is fixed at all. */
  useEffect(() => {
    const node = shelfRef.current
    if (!node) return
    /* ONLY WHEN THE COLUMN ACTUALLY CHANGED WIDTH, and that guard is what keeps
     * this from spinning. Writing `--cell-height` changes every row's height,
     * which resizes the grid, which calls this observer again — a loop the
     * browser reports as "ResizeObserver loop completed with undelivered
     * notifications" and then abandons, leaving the layout wherever it stopped.
     * The height this derives depends on the WIDTH alone, so a height-only
     * change has nothing to recompute and the loop closes after one pass. */
    let lastWidth = 0
    const size = () => {
      const cell = node.firstElementChild as HTMLElement | null
      const width = Math.round(cell?.getBoundingClientRect().width ?? 0)
      if (width <= 0 || width === lastWidth) return
      lastWidth = width
      node.style.setProperty('--cell-height', `${cellHeightFor(width)}px`)
    }
    size()
    const observer = new ResizeObserver(size)
    observer.observe(node)
    return () => observer.disconnect()
  }, [shelf.length])

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
        {/* ONE ACTION, because there was only ever one intent. "Add books" and
            "Add folder" sat here at equal weight and made the reader classify
            files-or-folder before a picker had opened — `pickBooks()` against
            `pickFolder()` showing through — and they are not equally frequent
            either: seeding a shelf from a folder happens once in a library's
            life. The folder route moved to where its moment is, the empty state
            below and ⌘K, and the label moved to `title`/`aria-label` where a
            label belongs on an icon control. */}
        <button
          type="button"
          className={styles.add}
          onClick={onAddBooks}
          title="Add books…"
          aria-label="Add books"
        >
          <Plus size={ICON.control} strokeWidth={ICON.stroke} />
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
                : /* POINTS AT THE BUTTONS ABOVE, which are right there. "Books
                     you open appear here" was written when Paper opened onto the
                     reader and this screen was somewhere you arrived later — it
                     described a consequence rather than telling a first-time
                     reader what to do, and it is now the first thing they see. */
                  'Add a book, or a folder of them — everything you highlight and tag stays with it.'
              : 'Try a different search, or clear the filter.'}
          </div>
          {/* THE FOLDER ROUTE, at the moment it is actually wanted — and only
              when the library is genuinely EMPTY. This same empty state also
              covers "nothing matches your search", where an import offer is a
              non sequitur, and `shelfUnread`, where the shelf could not be READ
              and adding to it is the last thing to suggest. */}
          {books.length === 0 && !shelfUnread && (
            <button
              type="button"
              className={styles.emptyImport}
              onClick={onAddFolder}
              disabled={importing !== null}
              /* BOTH, because they do different jobs and the app's convention
                 is the attribute. `disabled` stops the click; `data-disabled`
                 is what `global.css` styles on — so with only the first, the
                 button refused at full opacity with a pointer cursor, looking
                 exactly as available as it does when it works. `TitleBar` sets
                 both on its own controls; this set one. */
              data-disabled={importing !== null}
            >
              <FolderPlus size={ICON.control} strokeWidth={ICON.stroke} />
              Import a folder…
            </button>
          )}
        </div>
      ) : (
        <div className={styles.shelf} ref={shelfRef} style={
          virtualising ? { paddingBlockStart: win.padTop, paddingBlockEnd: win.padBottom } : undefined
        }>
          {visible.map((book) => (
            <BookCell
              key={book.bookId}
              book={book}
              confirming={confirming}
              setConfirming={setConfirming}
              tagging={tagging}
              setTagging={setTagging}
              draftTag={draftTag}
              setDraftTag={setDraftTag}
              setQuery={setQuery}
              onOpen={onOpen}
              onRemove={onRemove}
              onTag={onTag}
              onUntag={onUntag}
              onSetFinished={onSetFinished}
            />
          ))}
        </div>
      )}
    </div>
  )
}
