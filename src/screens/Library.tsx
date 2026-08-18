import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaseSensitive,
  Clock,
  FolderPlus,
  Gauge,
  LayoutGrid,
  List,
  Plus,
  Sparkles,
  User,
} from 'lucide-react'
import { shelfFor, tagKey } from '../lib/library'
import type { LibraryOrder } from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { withStatus, withoutTag } from '../lib/searchQuery'
import { ICON } from '../lib/metrics'
import type { Platform } from '../lib/metrics'
import { VIRTUALISE_ABOVE, gridWindow } from '../lib/virtualGrid'
import { BookCell } from './BookCell'
import { BookRow } from './BookRow'
import { ToolbarMenu, type ToolbarOption } from './ToolbarMenu'
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
  /**
   * Books still waiting on a background parse — reported in the status bar.
   *
   * Zero means the shelf is complete and nothing is drawn. Passed in rather
   * than read here because the pass is driven at the top of the app, where the
   * filesystem and the parser live.
   */
  enriching: number
  /** What the last import did, in one line. */
  importNotice: string | null
  /** The search field's contents — held in app state, see `AppState.libraryQuery`. */
  libraryQuery: string
  /** Accepts a functional update, resolved by the reducer against current state. */
  onQueryChange: (query: string | ((prev: string) => string)) => void
}

/* The three sorts, as marks. The words were dropped from the toolbar; the
 * icons were chosen so each is the one thing it could be, since a sort glyph
 * that reads as something else is worse than the word:
 *   Clock          — recency, unambiguously. Not `History`, which says "go
 *                    back", and not `Calendar`, which says "a date".
 *   CaseSensitive  — letterforms, so alphabetical by name.
 *   User           — the person.
 * Each carries its label as `title` and `aria-label`, so a hover and a screen
 * reader both get the word the sighted reader gave up. */
/* The labels are the MENU's, so they name the ordering rather than the act of
   ordering: the button already says "Sort:", and "Sort: Sort by recent" is what
   the old labels produced once they moved inside a menu. */
const ORDERS: readonly ToolbarOption<LibraryOrder>[] = [
  { id: 'recent', label: 'Recently opened', Icon: Clock },
  { id: 'title', label: 'Title', Icon: CaseSensitive },
  { id: 'author', label: 'Author', Icon: User },
  { id: 'progress', label: 'Progress', Icon: Gauge },
]

/**
 * Two ways to look at the same shelf, and they answer different questions.
 *
 * The GRID is for recognition: a wall of jackets, found by eye. The LIST is for
 * scanning and comparing — who wrote it, how far in, when it was last open —
 * which is what a reader wants once a library is bigger than they can picture.
 * Neither is a fallback for the other, so both are offered rather than one
 * being a density setting on the other.
 */
type LibraryLayout = 'grid' | 'list'

/* THERE IS NO LAYOUTS TABLE. A registry earns its place when a list has to be
 * rendered from it; with two mutually exclusive values the toggle names both in
 * the one line that switches them, and a table would be a second place to keep
 * them in step. `ORDERS` below has four and stays. */

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
  enriching,
  libraryQuery,
  onQueryChange,
}: LibraryProps) {
  const [order, setOrder] = useState<LibraryOrder>('recent')
  /* Alongside `order` rather than in app state: both are how this screen is
     being looked at right now, neither survives a launch, and splitting the
     two across two homes would be one of them for no reason. */
  const [layout, setLayout] = useState<LibraryLayout>('grid')
  /* One menu left on this toolbar, so this is a boolean rather than a union of
     which one is open — the view became a toggle and has nothing to open. */
  const [sortOpen, setSortOpen] = useState(false)
  /* Read ONCE per render, not per row. `relativeTime` needs a now to measure
     from, and a hundred rows each calling `Date.now()` would be a hundred
     slightly different nows — so two books opened in the same second could
     disagree about which was more recent. */
  const now = Date.now()
  /* Which row is asking to be confirmed, by id.
   *
   * A second click rather than a dialog. Removal here is not destructive — the
   * file survives and so do the marks — so a modal would be a ceremony out of
   * all proportion to what happens. But it is also one pixel from Open, and a
   * misclick that silently empties a row is worse than one extra click. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /* Which row has its menu open, by id. Held here rather than in the cell for
   * the same reason `confirming` and `tagging` are: exactly one may be open on
   * the whole shelf, and per-cell state cannot enforce that across cells. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  /** Which row has its tag input open, by id. */
  const [tagging, setTagging] = useState<string | null>(null)
  const [draftTag, setDraftTag] = useState('')
  /* ONE piece of state, and that is the point of the `tag:` syntax.
   *
   * There was a `scope` beside this field, which meant two sources of truth
   * that could disagree — a chip could say Philosophy while the field said
   * something else. The query now carries both: `tag:Philosophy whales` is the
   * scope AND the text, visible, editable, and copyable out of the box. */
  /* LIFTED into app state — see `AppState.libraryQuery`. The Library panel in
   * the side pane writes `tag:` and `is:` terms into the same string these
   * chips do, and a sibling cannot write local state; a copy in the pane would
   * be the second source of truth this comment says was removed.
   *
   * `setQuery` PASSES A FUNCTIONAL UPDATE THROUGH rather than resolving it: the
   * reducer applies it to the state it actually holds. Resolved here against
   * this render's `libraryQuery`, two updates in one batch read the same stale
   * value and the second clobbered the first. */
  const query = libraryQuery
  const setQuery = onQueryChange

  /* Deferred, not debounced. `useDeferredValue` lets the keystroke paint
   * immediately and re-filters at React's leisure, which is the behaviour a
   * debounce is usually approximating — and unlike a debounce it has no timer to
   * tune and cannot drop the final keystroke. */
  const deferredQuery = useDeferredValue(query)
  const view = useMemo(() => shelfFor(books, deferredQuery, order), [books, deferredQuery, order])
  const shelf = view.books
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

  /* THERE IS NO CELL-HEIGHT MEASUREMENT ANY MORE. It measured the first
   * card's width on every resize, computed the height, wrote `--cell-height`,
   * and needed a `requestAnimationFrame` and a same-width guard to keep from
   * looping through the ResizeObserver it triggered — all to derive a number
   * from a column that was fluid. The card is a fixed `CARD_W` now, so the
   * height is a constant and `applyMetrics` publishes it beside `--card-w`. */

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
      const rowHeight = cell ? cell.offsetHeight + rowGap : 0
      /* THE BROWSER'S OWN ANSWER, not arithmetic that has to agree with it.
       * This divided `clientWidth` by the card width, and `clientWidth`
       * includes the shelf's 80px of horizontal padding — so with the fixed
       * 126px card it counted six columns where CSS laid out five, and every
       * slice and spacer past `VIRTUALISE_ABOVE` was off by a column per row.
       * Fluid columns had hidden it: they stretched to fill whatever the
       * arithmetic said, so the two agreed by construction. The resolved
       * `grid-template-columns` is one track per column, in pixels, and it is
       * what was actually laid out. */
      const columns = cell && cell.offsetWidth > 0
        ? Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length)
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
      {/* THE WORD "LIBRARY" IS GONE. It sat in a 38px serif over the library
          screen, reached from a rail whose Library tab is lit and beside a pane
          already headed "Library" — a caption on a photograph of itself. What
          it cost was a whole row of chrome above the only two controls anyone
          uses here. The heading survives for a screen reader, which has no rail
          and no pane to read the context off. */}
      <h1 className={styles.srOnly}>Library</h1>

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
            placeholder="Search — or tag:Name, is:reading to narrow"
            aria-label="Search the library"
          />
          {/* ONE ROW, and the whole of it. Searching, choosing a view, choosing
              an order and adding a book are the four things this screen does;
              they belong on one line rather than spread over a header and a
              filter row with a title between them.

              THE VIEW IS A TOGGLE AND THE ORDER IS A MENU, because two options
              and four are different problems. A menu of two costs a click to
              show the reader the one thing they did not choose — they already
              know what the other one is — and then a second click to take it. A
              toggle is the whole decision in one press. */}
          <button
            type="button"
            className={styles.tool}
            /* The icon is what pressing it GIVES you, not what you have: a
               toggle's mark is a destination. The label says so in words, since
               an icon alone cannot distinguish the two readings. */
            aria-label={layout === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
            title={layout === 'grid' ? 'List view' : 'Grid view'}
            onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')}
          >
            {layout === 'grid' ? (
              <List size={ICON.control} strokeWidth={ICON.stroke} />
            ) : (
              <LayoutGrid size={ICON.control} strokeWidth={ICON.stroke} />
            )}
          </button>
          <ToolbarMenu
            name="Sort"
            value={order}
            options={ORDERS}
            onChange={setOrder}
            open={sortOpen}
            setOpen={setSortOpen}
          />
          {/* ONE ACTION, because there was only ever one intent. "Add books"
              and "Add folder" sat at equal weight and made the reader classify
              files-or-folder before a picker had opened; the folder route moved
              to where its moment is, the empty state below and ⌘K. */}
          <button
            type="button"
            className={styles.add}
            onClick={onAddBooks}
            title="Add books…"
            aria-label="Add books"
          >
            <Plus size={ICON.control} strokeWidth={ICON.stroke} />
          </button>
          {/* ONLY WHAT IS ACTIVE. This strip used to also offer the eight most
              used tags to click into — discovery — and it was the weak version
              of that: capped at eight, and it vanished the moment a filter
              left no tags behind. Discovery is the Library panel's job now,
              where every tag has a row and a count. What stays here is the
              read-back: the scopes currently applied, each one a click from
              being lifted, so a reader can always see and undo what is
              narrowing the shelf without hunting for it in the field. */}
        </div>
      )}

      {books.length > 0 && (view.tags.length > 0 || view.status) && (
        <>
          {(view.tags.length > 0 || view.status) && (
            <div className={styles.chips}>
              {view.status && (
                <button
                  type="button"
                  className={styles.chip}
                  data-active="true"
                  title="Clear this filter"
                  onClick={() => setQuery((q) => withStatus(q, null))}
                >
                  {view.status} ✕
                </button>
              )}
              {view.tags.map((tag) => (
                <button
                  key={tagKey(tag)}
                  type="button"
                  className={styles.chip}
                  data-active="true"
                  title="Clear this filter"
                  onClick={() => setQuery((q) => withoutTag(q, tag, tagKey))}
                >
                  {tag} ✕
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className={styles.body} data-scroll>
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
        <>
        {/* THERE IS NO COLUMN HEADER ROW. It labelled the columns and sorted
            three of them — and once sorting moved into the toolbar's own menu,
            what was left was a row of grey words repeating what the columns
            plainly are: a jacket, a title, a name, a bar, a date. Nothing in it
            was load-bearing, and it cost a line of chrome at the top of every
            list. The `Sort` menu is where ordering is chosen now, from one
            place, in both views. */}
        <div
          className={layout === 'list' ? styles.list : styles.shelf}
          ref={shelfRef}
          style={
            virtualising ? { paddingBlockStart: win.padTop, paddingBlockEnd: win.padBottom } : undefined
          }
        >
          {layout === 'list'
            ? visible.map((book) => (
                <BookRow
                  key={book.bookId}
                  book={book}
                  now={now}
                  menuFor={menuFor}
                  setMenuFor={setMenuFor}
                  confirming={confirming}
                  setConfirming={setConfirming}
                  setTagging={setTagging}
                  tagging={tagging}
                  draftTag={draftTag}
                  setDraftTag={setDraftTag}
                  onTag={onTag}
                  onOpen={onOpen}
                  onRemove={onRemove}
                  onSetFinished={onSetFinished}
                />
              ))
            : visible.map((book) => (
            <BookCell
              key={book.bookId}
              book={book}
              menuFor={menuFor}
              setMenuFor={setMenuFor}
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
        </>
      )}
      </div>

      {/* THE FOOT: what is on the shelf, and what is being done to it.
          Never a control — a status bar that can be clicked is a toolbar, and
          this one reports two things a reader would otherwise have to work out.

          The count says how much of the library is showing, and says it as a
          fraction the moment anything is narrowing the shelf: "24 of 1,965" is
          the answer to a question "24 books" leaves open. Filtering to nothing
          is the state this matters most in, so it is drawn even at zero. */}
      <div className={styles.status}>
        <span>
          {books.length === 0
            ? shelfUnread
              ? 'Library could not be read'
              : 'No books yet'
            : shelf.length === books.length
              ? `${books.length.toLocaleString()} ${books.length === 1 ? 'book' : 'books'}`
              : `${shelf.length.toLocaleString()} of ${books.length.toLocaleString()} books`}
        </span>
        {/* Background work, while there is any — moved here from the Library
            panel, where it was only visible if that panel happened to be open.
            A pass that quietly spends CPU for minutes belongs where a reader
            looks to find out what the app is doing. */}
        {enriching > 0 && (
          <span className={styles.statusWork}>
            <Sparkles size={ICON.control} strokeWidth={ICON.stroke} />
            Reading books for their titles and covers — {enriching.toLocaleString()} to go
          </span>
        )}
      </div>
    </div>
  )
}
