import { useMemo, useRef, type DragEvent, type MouseEvent } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import {
  CANNOT_OPEN,
  allTags,
  canOpen,
  displayTitle,
  statusOf,
  tagKey,
  type TagCount,
} from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { ICON } from '../lib/metrics'
import { withTag } from '../lib/searchQuery'
import { useRowMenu } from '../lib/useRowMenu'
import { BookMenu } from './BookMenu'
import { BookCover } from './BookCover'
import { TagEditor } from './TagEditor'
import editorStyles from './TagEditor.module.css'
import styles from './Library.module.css'

/**
 * One book on the shelf: its jacket, its progress, and the things a reader can
 * do to it — behind one control, not three.
 *
 * Lifted out of `Library` because two hundred lines of card in the middle of a
 * screen is where a card's own rules go to hide. Every defect this cell has had
 * — a confirm that grew over its neighbour, a tab order that ran right to left,
 * a tick nobody could name — was found by reading this block, and none of them
 * was visible while it was a `return` inside a `map`.
 *
 * THREE BUTTONS ON THE JACKET BECAME ONE MENU BESIDE THE PROGRESS RULE. Finish,
 * tag and remove sat as three dark circles across the top of every cover on
 * hover — which is a management screen, not a shelf, and every one of them was
 * drawn over the artwork it was supposed to sit beside. Two of the three had
 * already collided once (the confirm grew leftward over the tag button). Rare
 * actions belong in a menu; the ellipsis is the platform's word for "more,
 * here", and it sits in the row's own metadata line, on the surface, where a
 * control belongs.
 *
 * The derived values are computed ONCE. In the map they were recomputed per
 * render: `allTags` folds two lists through a Set and allocates every time, and
 * this card called it three times.
 */

/** How the shelf wants a click on a card read — see `Library`. */
export type SelectMode = 'toggle' | 'range'

/**
 * What one click on a book means: select, extend, or open.
 *
 * ONE READING FOR BOTH VIEWS. The card and the row each carried this chain,
 * and two copies of what ⌘, ⇧ and a plain click mean is how the grid and the
 * list come to disagree about the shelf's one selection model. ⌘ toggles, ⇧
 * extends, and while ANYTHING is selected a plain click toggles too — Photos'
 * model, so a trackpad reader can gather ten books without holding a key.
 */
export function readSelectClick(
  event: MouseEvent,
  selecting: boolean,
): SelectMode | 'open' {
  if (event.metaKey || event.ctrlKey) return 'toggle'
  if (event.shiftKey) return 'range'
  return selecting ? 'toggle' : 'open'
}

export interface BookCellProps {
  readonly book: IndexedBook
  /** Which book has its menu open, by id, or null. */
  readonly menuFor: string | null
  readonly setMenuFor: React.Dispatch<React.SetStateAction<string | null>>
  /** Which book is asking to be confirmed for removal, by id, or null. */
  readonly confirming: string | null
  readonly setConfirming: React.Dispatch<React.SetStateAction<string | null>>
  /** Which book has its tag editor open, by id, or null. */
  readonly tagging: string | null
  readonly setTagging: React.Dispatch<React.SetStateAction<string | null>>
  /** Every tag on the shelf with its count — what the editor's field offers. */
  readonly shelfTags: readonly TagCount[]
  /** Whether this book is selected, and whether anything on the shelf is. */
  readonly selected: boolean
  readonly selecting: boolean
  readonly onSelect: (book: IndexedBook, mode: SelectMode) => void
  /** Called as a drag leaves the card; the shelf writes what is being dragged. */
  readonly onDragStart: (book: IndexedBook, event: DragEvent) => void
  readonly setQuery: React.Dispatch<React.SetStateAction<string>>
  readonly onOpen: (book: IndexedBook) => void
  readonly onRemove: (book: IndexedBook) => void
  readonly onTagBooks: (bookIds: readonly string[], tags: readonly string[]) => void
  readonly onUntagBooks: (bookIds: readonly string[], tag: string) => void
  readonly onSetFinished: (bookId: string, finished: boolean) => void
}

/** How many chips fit on the card's one line before the rest become a count. */
const CHIPS = 4

export function BookCell({
  book,
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
  setQuery,
  onOpen,
  onRemove,
  onTagBooks,
  onUntagBooks,
  onSetFinished,
}: BookCellProps) {
  const openable = canOpen(book)
  const tags = allTags(book)
  const title = displayTitle(book)
  const status = statusOf(book)
  const menuOpen = menuFor === book.bookId
  const editing = tagging === book.bookId
  /* ANCHORED TO THE CARD, NOT TO THE BUTTON. The ellipsis is a 24px mark at
   * the card's far right; anchored to it, a menu that has to flip to `start`
   * on the first column lands with its left edge on the button's left — 100px
   * in from the cover, hanging in the middle of nothing, and the reader asked
   * why it did not line up with the leftmost book. The card is the thing the
   * menu is ABOUT, and its edges are the lines the shelf is drawn on. The
   * button shares the card's right edge and bottom, so when `end` fits nothing
   * moves; when it flips, the menu's left sits on the cover's left, which is
   * exactly the border the eye expects.
   *
   * FIXED positioning is the constraint it always was: the cell clips its
   * overflow for virtualisation's sake, and a menu that is a child of the cell
   * is clipped by it. `useRowMenu` owns the rest — placement, dismissal, the
   * close-on-unmount and close-on-detached — for the same reasons `TagRow`
   * needs the same things. */
  const cellRef = useRef<HTMLDivElement | null>(null)
  const { moreRef, menuRef, menuStyle, close: closeMenu } = useRowMenu(
    menuOpen,
    cellRef,
    /* THE ONE WAY THE MENU CLOSES. There were four — outside click, Escape,
     * choosing an item, and the remove's second click — and two of them cleared
     * `menuFor` without clearing `confirming`, so choosing "Mark as finished"
     * after arming the remove left the row armed for the next time it opened.
     * Every path calls this. */
    () => {
      setMenuFor((at) => (at === book.bookId ? null : at))
      setConfirming((at) => (at === book.bookId ? null : at))
    },
    {
      side: 'bottom',
      align: 'end',
      // A real menu: focus and arrow keys — see `useRowMenu`.
      menu: true,
      /* On the last row there is no room below, so it flips — and flipped CLEAR
         of a 225px card it leapt the whole card and landed over the neighbour
         above, reading as that book's menu. Overlaid, it drapes up over its own
         jacket from the same bottom edge, which is fine: it is unmistakably this
         book's menu, and a jacket is not something the reader needs to keep
         seeing while they choose. */
      overlayOnFlip: true,
    },
  )

  /* THE TAG EDITOR, over the card, on the same mechanics as the menu — placed
   * from the viewport, closed by a click elsewhere or Escape, closed if the
   * card scrolls away. It used to be a one-line field laid over the jacket:
   * one tag per visit, no memory of what the shelf already had, and the
   * reader's own tags removed by clicking a chip that looked like a filter.
   * The editor is where all of that lives now — see `TagEditor`. */
  const {
    moreRef: editorAnchorRef,
    menuRef: editorRef,
    menuStyle: editorStyle,
  } = useRowMenu(
    editing,
    cellRef,
    () => setTagging((at) => (at === book.bookId ? null : at)),
    { side: 'bottom', align: 'start', overlayOnFlip: true },
  )

  /* WHAT A CLICK ON THE JACKET MEANS — `readSelectClick`, shared with the
   * row. The menu's "Select" is how a reader who has never ⌘-clicked a shelf
   * finds out it can be selected from. */
  const onJacketClick = (event: MouseEvent) => {
    const meant = readSelectClick(event, selecting)
    if (meant === 'open') {
      if (openable) onOpen(book)
    } else onSelect(book, meant)
  }

  /* The card's one line of chips: up to `CHIPS`, or one fewer and a count.
   * The count is a button that opens the editor, where every tag is seen in
   * full — a chip row that silently cut a book's fifth tag off was telling
   * the reader the book had four. */
  const shown = tags.length > CHIPS ? tags.slice(0, CHIPS - 1) : tags
  const more = tags.length - shown.length
  /* The reader's own tags BY KEY, once — each chip asked the whole list with
   * a fold per comparison, which multiplied across a hundred cells. */
  const ownKeys = new Set((book.tags ?? []).map(tagKey))
  /* ONE number for the bar and its label — rounded twice, the two could
   * disagree by a percent. */
  const pct = Math.round((book.finished ? 1 : book.progress ?? 0) * 100)
  /* The editor is a single-book prop conceptually, but `TagEditor` takes a
   * list; MEMOIZED, or a fresh `[book]` on every shelf render invalidates
   * every books-keyed memo inside it. */
  const editorBooks = useMemo(() => [book], [book])

  return (
    <div
      className={styles.cell}
      ref={cellRef}
      data-selected={selected}
      /* DRAGGABLE, onto a tag row in the Library panel. The whole cell rather
         than the jacket button, because a button's own drag behaviour varies
         by engine and the cell is what the reader has hold of. Dragging a
         selected card drags the whole selection; dragging one that is not
         drags it alone — Finder's rule, and the one that surprises nobody. */
      draggable
      onDragStart={(event) => onDragStart(book, event)}
    >
      <button
        type="button"
        className={styles.book}
        /* NOT `disabled`, dimmed. A no-copy book cannot OPEN — the handler
           refuses that one verb — but it can be selected, and a ⌘-click is
           how selection STARTS: disabled (and the global `data-disabled`
           pointer-events rule with it) refused the very click that would have
           begun. `data-nocopy` carries the dimming without taking the
           events; the title says why a plain click does nothing. */
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
        onClick={onJacketClick}
      >
        <BookCover
          book={book}
          title={title}
          className={styles.cover}
          tintedClassName={styles.coverTinted}
          titleClassName={styles.coverTitle}
        />
        {/* NO TITLE, NO AUTHOR UNDER THE JACKET. A shelf is scanned by its
            covers — that is what a jacket is for — and a title and an author
            printed under every one restated what the artwork already says, at
            a size that could not be read without leaning in and a width that
            truncated most of them to a fragment. Both live on the button's
            `title`, so a hover names the book, and the tint carries the title
            for a book that has no artwork to name it. The switcher lists
            title and author because a LIST is read by its words; a shelf is
            not.

            One thing that used to ride on the author line stays, because it
            is a signal and not a caption: a book Paper has no copy of. */}
        {!openable && (
          <span className={styles.noCopy} title={CANNOT_OPEN}>
            no copy
          </span>
        )}
        {/* The selection mark, on the jacket's corner: a check in a filled
            circle, the platform's own vocabulary for "this one is in". Drawn
            only when selected — a hollow circle on every card while selecting
            would turn the shelf into a form. */}
        {selected && (
          <span className={styles.selectedMark} aria-hidden="true">
            <Check size={ICON.control} strokeWidth={ICON.stroke} />
          </span>
        )}
      </button>

      {/* THE META LINE: the progress rule, and the one control that reaches
          everything else. Outside the open button, because a button nested
          in a button is invalid and browsers resolve it by dropping the inner
          one — it would render and never fire.

          The rule and the ellipsis share a row so the control has a place
          that is not the artwork. On a book never opened there is no rule —
          a zero-width bar under every unread book is a row of noise — and
          the ellipsis then holds the row's end alone. */}
      <div className={styles.metaRow}>
        {status !== 'unread' ? (
          <span
            className={styles.progress}
            data-finished={status === 'finished'}
            /* The number is on the label rather than in the text: a bar
               is legible at a glance and a percentage under every cover
               is forty numbers nobody reads. */
            aria-label={status === 'finished' ? 'Finished' : `${pct}% read`}
          >
            <span className={styles.progressFill} style={{ inlineSize: `${pct}%` }} />
          </span>
        ) : (
          <span className={styles.progressSpacer} aria-hidden="true" />
        )}

        <div className={styles.menuAnchor}>
          <button
            ref={moreRef}
            type="button"
            className={styles.more}
            aria-label={`More for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-open={menuOpen}
            title="Finish, tag, select, or remove"
            onClick={() => {
              setConfirming(null)
              /* AND ANY EDITOR, whoever's — the editor closes on outside
                 POINTER events only, so this button reached by keyboard
                 opened a menu beside a still-open editor, on this card or on
                 another one across the shelf. One surface at a time is a
                 rule about the SHELF, not about the card. */
              setTagging(null)
              setMenuFor((at) => (at === book.bookId ? null : book.bookId))
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
              /* Rendered even before the first placement lands, so the hook
                 has a box to measure; `useRowMenu` parks it off screen until
                 then, and CLOSES it if the card scrolls out of a virtualised
                 shelf — a menu with no card under it belongs to nothing. */
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
              />
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div ref={editorRef} className={editorStyles.popover} style={editorStyle} role="dialog" aria-label={`Tags for ${title}`}>
          <TagEditor books={editorBooks} shelfTags={shelfTags} onAdd={onTagBooks} onRemove={onUntagBooks} />
        </div>
      )}

      {/* EVERY CHIP SCOPES. A reader's own tag used to REMOVE on click while a
          publisher's subject scoped — two actions on one control, told apart
          by a property the reader could not see before clicking, and one of
          them destructive. Phase 4's own note said a click never removes;
          this is where that becomes true. Removal is in the editor. */}
      {/* ALWAYS DRAWN, empty when the book has no tags — the same trick the
          progress rule uses two rows up, and for the same reason. The cell
          reserves 20px for this row because virtualisation needs every row to
          be one height; rendered only when there are tags, that 20px became
          slack, and slack has to sit somewhere. At the foot it left every
          untagged card floating at the top of its cell with a gap beneath;
          inside the book box it pushed the progress rule and the `⋯` a further
          16px from the jacket they belong to. Occupied by the same element in
          both cases there is no slack to place: the card fills its cell, and
          the meta row sits under the cover at the 12px its margins ask for. */}
      <div className={styles.tagRow}>
        {shown.map((tag) => {
          const mine = ownKeys.has(tagKey(tag))
          return (
            <button
              key={tagKey(tag)}
              type="button"
              className={styles.bookTag}
              data-mine={mine}
              title={`Show everything tagged ${tag}`}
              onClick={() => setQuery((q) => withTag(q, tag, tagKey))}
            >
              {tag}
            </button>
          )
        })}
        {more > 0 && (
          <button
            ref={editorAnchorRef}
            type="button"
            className={styles.bookTag}
            data-more="true"
            title={`${more} more — edit tags`}
            aria-label={`${more} more tags — edit`}
            /* THE EDITOR'S OWN TRIGGER — `editorAnchorRef` is what exempts
               this button from the editor's outside-pointerdown close. Not
               exempted, clicking +N with its own editor open closed it on
               pointerdown and reopened it on click: a toggle that could not
               toggle off. Also retires any menu and confirm, on whichever
               card: one surface at a time is a shelf rule. */
            onClick={() => {
              setConfirming(null)
              setMenuFor(null)
              setTagging((at) => (at === book.bookId ? null : book.bookId))
            }}
          >
            +{more}
          </button>
        )}
      </div>
    </div>
  )
}
