import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import {
  BookCheck,
  CaseSensitive,
  Clock,
  FolderPlus,
  Gauge,
  LayoutGrid,
  List,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { displayTitle, shelfFor, tagCounts, tagKey } from '../../core/library'
import type { LibraryOrder } from '../../core/library'
import { writeBookDrag } from '../../core/bookDrag'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookAction } from '../../core/capability'
import { TRASH_KEPT_FOR } from '../../core/bookTrash'
import { withStatus, withUntagged, withoutTag } from '../../core/searchQuery'
import { moment, onFirstPaint } from '../devTiming'
import { ICON } from '../../core/metrics'
import type { Platform } from '../../core/metrics'
import { useRowMenu } from '../hooks/useRowMenu'
import { VIRTUALISE_ABOVE, gridWindow } from '../../core/virtualGrid'
import { OverlaySheet } from '../overlays/OverlaySheet'
import { BookCell, type SelectMode } from './BookCell'
import { BookRow } from './BookRow'
import { TagEditor } from './TagEditor'
import editorStyles from './TagEditor.module.css'
import { ToolbarMenu, type ToolbarOption } from './ToolbarMenu'
import styles from './Library.module.css'

/**
 * How many books the removal sheet NAMES before it starts counting.
 *
 * Enough that a small mistake is visible — a reader who meant three and
 * gathered four sees the fourth — and few enough that the list cannot push the
 * buttons off the sheet. Past this the count is the honest summary; a scrolling
 * list of two hundred titles answers no question the number does not.
 */
const REMOVE_NAMED = 5

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
  /**
   * Add tags to books, and take one off them — the editor's two verbs, over one
   * book or a selection. Publisher subjects are fixed; only the reader's own
   * tags move.
   */
  onTagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  onUntagBooks: (bookIds: readonly string[], tag: string) => void
  /** The last tag removal and the way back — for the SELECTION editor, which is
   *  the one on this screen that can take a tag off many books at once. */
  lastRemoval: { readonly tag: string; readonly bookIds: readonly string[] } | null
  onUndoRemoveTag: () => void
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
  /**
   * Actions the composed capabilities contributed for one book — Download,
   * Remove download… (WI-C.3/C.5). Rendered by the book's menu, filtered
   * per row by each action's `when`.
   */
  bookActions: readonly BookAction[]
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

/**
 * One active filter, one click from being lifted.
 *
 * Extracted at the FOURTH copy: status, untagged, each tag, each exclusion
 * all drew the same button, and the dismissal affordance — the ✕, the title,
 * the active state — is exactly what must not differ among them, or one kind
 * of filter reads as less clearable than another.
 */
function FilterChip({
  excluded = false,
  onClear,
  children,
}: {
  readonly excluded?: boolean
  readonly onClear: () => void
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={styles.chip}
      data-active="true"
      data-excluded={excluded || undefined}
      title="Clear this filter"
      onClick={onClear}
    >
      {children} ✕
    </button>
  )
}

export function Library({
  books,
  platform,
  onOpen,
  onAddBooks,
  onRemove,
  onTagBooks,
  onUntagBooks,
  lastRemoval,
  onUndoRemoveTag,
  onSetFinished,
  onAddFolder,
  importing,
  importNotice,
  shelfUnread = false,
  enriching,
  libraryQuery,
  onQueryChange,
  bookActions,
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
     disagree about which was more recent.
     AND AT LEAST ONCE A MINUTE while the list is showing: "5 minutes ago" is
     a claim about now, and a window left open over lunch kept whatever now
     its last unrelated render happened to read. The tick's only job is to
     force that render; a minute matches the finest unit `relativeTime`
     prints, so ticking faster would repaint for no visible change. */
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (layout !== 'list') return
    const timer = window.setInterval(() => setNowTick((t) => t + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [layout])
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
  /** Which row has its tag editor open, by id. */
  const [tagging, setTagging] = useState<string | null>(null)
  /* Whether the editor is open over the SELECTION rather than one book. Its
   * own flag rather than a sentinel in `tagging`, so a book id can never be
   * mistaken for it. */
  const [taggingSelection, setTaggingSelection] = useState(false)
  /* THE SELECTION: which books, by id, and the last one clicked — the anchor a
   * ⇧-click extends from. Held here, like the menu and the confirm, because a
   * selection is a fact about the shelf and not about a cell. It is pruned
   * to what the shelf is SHOWING (below): a reader who selects three books
   * and then narrows the shelf until one is left has one selected, or the bar
   * says "3 selected" over a shelf that shows one and a bulk action reaches
   * two books nobody can see. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
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
  /* Every tag on the shelf, once per render of the shelf, for the editors'
   * suggestions. Computed HERE and passed down rather than in each cell:
   * a cell computing it would walk two thousand books per open, and there
   * can be a hundred cells. */
  const shelfTags = useMemo(() => tagCounts(books), [books])

  /* WHAT THE READER CAN SEE IS WHAT IS SELECTED — derived, not merely pruned
   * later. The pruning effect below still tidies the stored set, but it runs
   * a render late, and in that render the bar counted hidden books while the
   * bulk actions reached only visible ones: "3 selected" over a shelf showing
   * one, and a Tag… that would touch one. Everything user-facing reads from
   * this intersection, so the count and the action can never disagree. */
  const selectedBooks = useMemo(
    () => shelf.filter((book) => selected.has(book.bookId)),
    [shelf, selected],
  )
  const selecting = selectedBooks.length > 0

  /* Pruned to the shelf as shown. Ids are compared, so a shelf that re-sorts
   * changes nothing here. When the pruning empties the selection, everything
   * hanging off it goes too — the bulk editor cannot stay open over zero
   * books, and a ⇧-run from an anchor nothing shows would select a run the
   * reader cannot see the start of. */
  useEffect(() => {
    if (selected.size === 0) return
    const shown = new Set(shelf.map((book) => book.bookId))
    const kept = new Set([...selected].filter((id) => shown.has(id)))
    if (kept.size === selected.size) return
    setSelected(kept)
    if (kept.size === 0) {
      setAnchorId(null)
      setTaggingSelection(false)
      setRemovingSelection(false)
    }
  }, [shelf, selected])

  /* One click on a card, read three ways — see `BookCell.onJacketClick`. A
   * range runs between the anchor and this book in SHELF ORDER, which is the
   * order the reader can see, whatever the sort. With no anchor a ⇧-click is
   * a toggle, since there is nothing to run from. */
  const select = useCallback(
    (book: IndexedBook, mode: SelectMode) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (mode === 'range' && anchorId) {
          const from = shelf.findIndex((one) => one.bookId === anchorId)
          const to = shelf.findIndex((one) => one.bookId === book.bookId)
          if (from >= 0 && to >= 0) {
            for (const one of shelf.slice(Math.min(from, to), Math.max(from, to) + 1)) {
              next.add(one.bookId)
            }
            return next
          }
        }
        if (next.has(book.bookId)) next.delete(book.bookId)
        else next.add(book.bookId)
        return next
      })
      setAnchorId(book.bookId)
    },
    [shelf, anchorId],
  )

  /**
   * Whether the removal ceremony is open.
   *
   * NOT a layer in `state.ts`. The selection is a fact about this shelf and
   * lives here; a confirmation ABOUT that selection cannot outlive it, and a
   * boolean in the reducer would have to be swept whenever the selection was
   * pruned — a second place to forget. It is closed by `clearSelection` for
   * exactly that reason, and by the effect that prunes to what is shown.
   */
  const [removingSelection, setRemovingSelection] = useState(false)

  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setAnchorId(null)
    setTaggingSelection(false)
    setRemovingSelection(false)
  }, [])

  /* ⌘A takes the shelf as shown; Escape lets it go. Both only on this screen
   * and only when the reader is not typing — the search field's own ⌘A is
   * select-all-text, and must stay so. Escape is left to the menus and the
   * editor while one of them is open, since those close on it first; the
   * selection goes on the NEXT Escape, which is the order a reader expects
   * things to peel back in. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.isContentEditable || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (typing) return
      const accel = platform === 'macos' ? event.metaKey : event.ctrlKey
      if (accel && event.key === 'a' && shelf.length > 0) {
        event.preventDefault()
        setSelected(new Set(shelf.map((book) => book.bookId)))
        return
      }
      if (event.key !== 'Escape') return
      /* ONE LAYER PER PRESS, topmost first — the same rule §11 states for the
       * reader's own overlays. The removal sheet is modal and is on top, so it
       * goes first and the selection it was asking about survives; a single
       * Escape that dismissed the question AND the selection would make
       * backing out of the ceremony cost the reader the gathering. */
      if (removingSelection) {
        event.preventDefault()
        setRemovingSelection(false)
        return
      }
      if (selecting && !menuFor && !tagging && !taggingSelection) {
        clearSelection()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [platform, shelf, selecting, menuFor, tagging, taggingSelection, removingSelection, clearSelection])

  /* What leaves the shelf when a card is dragged: the selection if the card is
   * in it, the card alone if not — Finder's rule. See `bookDrag`. */
  const startDrag = useCallback(
    (book: IndexedBook, event: DragEvent) => {
      /* The VISIBLE selection — the same set every other bulk surface reads —
       * so a drag never quietly carries books the shelf is not showing. */
      const ids = selected.has(book.bookId)
        ? selectedBooks.map((one) => one.bookId)
        : [book.bookId]
      writeBookDrag(event.dataTransfer, ids)
    },
    [selected, selectedBooks],
  )

  /* The bulk editor hangs off the bar's own Tag… button. */
  const bulkAnchor = useRef<HTMLButtonElement | null>(null)
  const { menuRef: bulkRef, menuStyle: bulkStyle } = useRowMenu(
    taggingSelection,
    bulkAnchor,
    () => setTaggingSelection(false),
    { side: 'bottom', align: 'start' },
  )
  const finishedAll = selectedBooks.length > 0 && selectedBooks.every((book) => book.finished)
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
    /* THE SCROLLER TOO. The viewport height in the window arithmetic is the
     * scroller's, and the scroller resizes without the shelf noticing — the
     * selection bar appears, the chips wrap onto a second line, the window
     * itself grows. Observed only through the shelf, those left `height`
     * stale and the bottom rows of the newly exposed viewport unrendered. */
    if (scroller instanceof HTMLElement) observer.observe(scroller)
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

  /* WHAT THE SHELF ACTUALLY COST, once. `books` is the whole library, `shelf`
   * is what the current scope leaves, and `cells` is what this render hands to
   * React — three numbers that are usually assumed equal and are the first
   * thing to check when the screen is slow. A `cells` equal to `shelf` on a
   * large library means the virtualiser did not engage, which is a different
   * problem from a scan that took too long. Dev only, and gone from a build. */
  const measured = useRef(false)
  useEffect(() => {
    if (measured.current) return
    measured.current = true
    moment('the shelf rendered', {
      library: books.length,
      shelf: shelf.length,
      cells: visible.length,
      virtualising,
    })
    onFirstPaint('the shelf drew its first frame')
  }, [books.length, shelf.length, visible.length, virtualising])

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

      {books.length > 0 &&
        (view.tags.length > 0 || view.excluded.length > 0 || view.status || view.untagged) && (
          <div className={styles.chips}>
            {view.status && (
              <FilterChip onClear={() => setQuery((q) => withStatus(q, null))}>
                {view.status}
              </FilterChip>
            )}
            {view.untagged && (
              <FilterChip onClear={() => setQuery((q) => withUntagged(q, false))}>
                untagged
              </FilterChip>
            )}
            {view.tags.map((tag) => (
              <FilterChip
                key={tagKey(tag)}
                onClear={() => setQuery((q) => withoutTag(q, tag, tagKey))}
              >
                {tag}
              </FilterChip>
            ))}
            {/* An exclusion reads as one — "not Sea" — so a reader glancing at
                the row knows which way each chip is narrowing. Same ✕, same
                clear: `withoutTag` lifts either form. */}
            {view.excluded.map((tag) => (
              <FilterChip
                key={`not:${tagKey(tag)}`}
                excluded
                onClear={() => setQuery((q) => withoutTag(q, tag, tagKey))}
              >
                not {tag}
              </FilterChip>
            ))}
          </div>
        )}

      {/* THE SELECTION BAR: what is selected, and the two things worth doing
          to many books at once. Between the toolbar and the shelf, where the
          chips are, because it is the same kind of thing — a fact about what
          the shelf is showing, with a way to act on it. Remove is NOT here:
          it is the one thing that takes something away, and "Remove 214
          books" is a ceremony a bar this small should not hold. It says how
          to add more, once, for the reader who arrived by the menu's Select
          and does not know about ⌘. */}
      {selecting && (
        <div className={styles.selectionBar} role="toolbar" aria-label="Selection">
          <span className={styles.selectionCount}>
            {selectedBooks.length.toLocaleString()} selected
          </span>
          {/* The platform's own modifier — `readSelectClick` takes Ctrl where
              there is no ⌘, and a hint naming a key the keyboard does not
              have teaches the reader the feature is not for them. */}
          <span className={styles.selectionHint}>
            {platform === 'macos' ? '⌘' : 'Ctrl'}-click to add · ⇧-click for a run
          </span>
          <button
            ref={bulkAnchor}
            type="button"
            className={styles.selectionAction}
            data-open={taggingSelection}
            aria-haspopup="dialog"
            aria-expanded={taggingSelection}
            onClick={() => setTaggingSelection((on) => !on)}
          >
            <Tag size={ICON.control} strokeWidth={ICON.stroke} />
            Tags…
          </button>
          <button
            type="button"
            className={styles.selectionAction}
            onClick={() => {
              for (const book of selectedBooks) onSetFinished(book.bookId, !finishedAll)
            }}
          >
            <BookCheck size={ICON.control} strokeWidth={ICON.stroke} />
            {/* "Unfinished", not "unread": clearing `finished` keeps each
                book's position, so part-read books land on Reading — across a
                mixed selection this is the only label that is true of all. */}
            {finishedAll ? 'Mark as unfinished' : 'Mark as finished'}
          </button>
          {/* THE DOOR TO THE CEREMONY, NOT THE ACT — which is what the
              trailing ellipsis has always meant, and why this can sit on a bar
              the plan said was too small to hold a removal. Nothing goes
              anywhere until the sheet is answered. */}
          <button
            type="button"
            className={styles.selectionRemove}
            aria-haspopup="dialog"
            aria-expanded={removingSelection}
            onClick={() => setRemovingSelection(true)}
          >
            <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
            Remove…
          </button>
          <button
            type="button"
            className={styles.selectionDone}
            aria-label="Clear the selection"
            title="Done (Esc)"
            onClick={clearSelection}
          >
            <X size={ICON.control} strokeWidth={ICON.stroke} />
          </button>
          {taggingSelection && selectedBooks.length > 0 && (
            <div
              ref={bulkRef}
              className={editorStyles.popover}
              style={bulkStyle}
              /* The role the Tag… button's `aria-haspopup="dialog"` promised —
                 unnamed, this was a popup that announced as nothing at all. */
              role="dialog"
              aria-label={`Tags for ${selectedBooks.length} selected books`}
            >
              <TagEditor
                books={selectedBooks}
                shelfTags={shelfTags}
                onAdd={onTagBooks}
                onRemove={onUntagBooks}
                lastRemoval={lastRemoval}
                onUndoRemove={onUndoRemoveTag}
              />
            </div>
          )}
        </div>
      )}

      {/* THE SENTENCE THE NUMBER DESERVES.
          Everything a reader needs to answer without leaving: how many, which
          ones (up to a handful, then a count), that their imported file is
          untouched, and how long this is recoverable for. CANCEL IS FIRST IN
          DOCUMENT ORDER, deliberately — `OverlaySheet` moves focus to the
          first focusable it finds, and a confirmation whose destructive
          button is focused on open turns Return into the act itself. */}
      {removingSelection && selectedBooks.length > 0 && (
        <OverlaySheet
          label={`Remove ${selectedBooks.length} books from the library`}
          onDismiss={() => setRemovingSelection(false)}
        >
          <div className={styles.removeSheet}>
            <div className={styles.removeHeading}>
              Remove {selectedBooks.length.toLocaleString()}{' '}
              {selectedBooks.length === 1 ? 'book' : 'books'} from the library?
            </div>
            <ul className={styles.removeList}>
              {selectedBooks.slice(0, REMOVE_NAMED).map((book) => (
                <li key={book.bookId}>{displayTitle(book)}</li>
              ))}
              {selectedBooks.length > REMOVE_NAMED && (
                <li className={styles.removeMore}>
                  and {(selectedBooks.length - REMOVE_NAMED).toLocaleString()} more
                </li>
              )}
            </ul>
            <p className={styles.removeNote}>
              The files you imported are kept where they are. This is recoverable for{' '}
              {TRASH_KEPT_FOR}.
            </p>
            <div className={styles.removeActions}>
              <button
                type="button"
                className={styles.removeCancel}
                onClick={() => setRemovingSelection(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.removeConfirm}
                onClick={() => {
                  /* Captured before anything is removed. `selectedBooks` is
                     derived from the shelf, and the shelf changes under the
                     first removal — iterating it directly would drop every
                     book after the first. */
                  const going = [...selectedBooks]
                  setRemovingSelection(false)
                  clearSelection()
                  for (const book of going) onRemove(book)
                }}
              >
                <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
                Remove {selectedBooks.length.toLocaleString()}{' '}
                {selectedBooks.length === 1 ? 'book' : 'books'}
              </button>
            </div>
          </div>
        </OverlaySheet>
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
            <div className={styles.emptyActions}>
              {/* BOTH ROUTES IN. The copy above says "Add a book, or a folder
                  of them" — and with an empty library the toolbar that holds
                  the everyday `+` is not rendered, so "add a book" was an
                  instruction with no control anywhere on screen to follow it
                  with. The empty state is the one moment both belong at equal
                  weight: a first-time reader has not chosen files-or-folder
                  yet, and this is where they choose. */}
              <button
                type="button"
                className={styles.emptyImport}
                onClick={onAddBooks}
                disabled={importing !== null}
                data-disabled={importing !== null}
              >
                <Plus size={ICON.control} strokeWidth={ICON.stroke} />
                Add books…
              </button>
              <button
                type="button"
                className={styles.emptyImport}
                onClick={onAddFolder}
                disabled={importing !== null}
                /* BOTH, because they do different jobs and the app's convention
                   is the attribute. `disabled` stops the click; `data-disabled`
                   is what `global.css` styles on — so with only the first, the
                   button refused at full opacity with a pointer cursor, looking
                   exactly as available as it does when it works. `TitleBar`
                   sets both on its own controls; this set one. */
                data-disabled={importing !== null}
              >
                <FolderPlus size={ICON.control} strokeWidth={ICON.stroke} />
                Import a folder…
              </button>
            </div>
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
          {visible.map((book) => {
            /* ONE BUNDLE for both views. The grid and the list took the same
             * fifteen props in two hand-written lists, and a behaviour wired
             * into one map was silently absent from the other — which view a
             * defect appeared in depended on which list last got the edit. The
             * per-view extras (`now` for the list's timestamps, `setQuery` for
             * the grid's chips) stay per view, because they are genuinely per
             * view. */
            const shared = {
              book,
              menuFor,
              setMenuFor,
              confirming,
              setConfirming,
              tagging,
              setTagging,
              shelfTags,
              selected: selected.has(book.bookId),
              selecting,
              onSelect: select,
              onDragStart: startDrag,
              onTagBooks,
              onUntagBooks,
              onOpen,
              onRemove,
              onSetFinished,
              actions: bookActions,
            }
            return layout === 'list' ? (
              <BookRow key={book.bookId} {...shared} now={now} />
            ) : (
              <BookCell key={book.bookId} {...shared} setQuery={setQuery} />
            )
          })}
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
