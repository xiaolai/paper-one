import type { ReactElement } from 'react'
import { BookCheck, CheckSquare, CircleMinus, Download, Square, Tag, Trash2 } from 'lucide-react'
import type { ReadingStatus } from '../../core/library'
import type { IndexedBook } from '../../core/bookIndex'
import type { ActionIcon, BookAction } from '../../core/capability'
import { TRASH_KEPT_FOR } from '../../core/bookTrash'
import { ICON } from '../../core/metrics'

/** Every `ActionIcon`, drawn once. `Record` over the union, so a name added
 *  to `ACTION_ICONS` without artwork here does not compile. */
const ACTION_ICON: Record<ActionIcon, ReactElement> = {
  download: <Download size={ICON.control} strokeWidth={ICON.stroke} />,
  'circle-minus': <CircleMinus size={ICON.control} strokeWidth={ICON.stroke} />,
}

/**
 * The things that can be done to a book, wherever it is shown.
 *
 * EXTRACTED AT THE SECOND SURFACE. The shelf's card had these items written
 * into it; the list's row needs exactly the same ones, with the same words,
 * the same two-click remove and the same state names. Written twice they drift,
 * and they drift silently — the two would simply disagree about what "Mark as
 * finished" does to a book already finished, or one would lose the confirm.
 *
 * Only the ITEMS. Each caller keeps its own `role="menu"` box, because the box
 * is positioned against the thing the menu belongs to — a card in one case, a
 * row in the other — and that is genuinely different. What must not differ is
 * what is inside it.
 */
export interface BookMenuProps {
  readonly book: IndexedBook
  /** The book's title as displayed, for the labels a screen reader reads. */
  readonly title: string
  readonly status: ReadingStatus
  /** Which book has its remove ARMED, so only one is armed at a time. */
  readonly confirming: string | null
  readonly setConfirming: (bookId: string | null) => void
  /** Open the tag editor over this book. */
  readonly setTagging: (bookId: string | null) => void
  /** Whether this book is in the shelf's selection, and the way to change that. */
  readonly selected: boolean
  readonly onToggleSelect: (bookId: string) => void
  readonly onRemove: (book: IndexedBook) => void
  readonly onSetFinished: (bookId: string, finished: boolean) => void
  /** The caller's one way to close — see `useRowMenu`. */
  readonly closeMenu: () => void
  /** The caller's item class, so each surface keeps its own menu styling. */
  readonly itemClass: string
  /**
   * Actions the composed capabilities contributed (WI-C.3) — Download,
   * Evict… Filtered HERE by each action's `when` against this
   * book, so both surfaces (cell and row) apply one rule. Rendered between
   * the kernel's ordinary items and the remove, which stays last: the one
   * destructive thing keeps its distance.
   */
  readonly actions: readonly BookAction[]
}

export function BookMenu({
  book,
  title,
  status,
  confirming,
  setConfirming,
  setTagging,
  selected,
  onToggleSelect,
  onRemove,
  onSetFinished,
  closeMenu,
  itemClass,
  actions,
}: BookMenuProps) {
  const armed = confirming === book.bookId
  const offered = actions.filter((action) => action.when?.(book) ?? true)
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          onSetFinished(book.bookId, status !== 'finished')
          closeMenu()
        }}
      >
        <BookCheck size={ICON.control} strokeWidth={ICON.stroke} />
        {/* Names the STATE it will produce, because the tick alone could not —
            a bare ✓ on a card that can be selected, confirmed or dismissed read
            as any of those. And the state it names is the TRUE one: clearing
            `finished` on a book with a saved position makes it Reading, not
            Unread — the position survives, deliberately — and a menu that said
            "unread" produced a book the panel then counted as reading. */}
        {status === 'finished'
          ? book.position
            ? 'Mark as unfinished'
            : 'Mark as unread'
          : 'Mark as finished'}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          setTagging(book.bookId)
          closeMenu()
        }}
      >
        <Tag size={ICON.control} strokeWidth={ICON.stroke} />
        {/* "Tags…", not "Add a tag…": what opens is the book's tags, all of
            them, to add to or take from. The old label described one of the
            two things the editor does and hid the other. */}
        Tags…
      </button>
      {/* SELECT, in words. ⌘-click selects a card, and a reader who has never
          ⌘-clicked a shelf has no way to find that out; this row is how they
          do. Once one is selected the bar above the shelf says the rest. */}
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          onToggleSelect(book.bookId)
          closeMenu()
        }}
      >
        {selected ? (
          <CheckSquare size={ICON.control} strokeWidth={ICON.stroke} />
        ) : (
          <Square size={ICON.control} strokeWidth={ICON.stroke} />
        )}
        {selected ? 'Deselect' : 'Select'}
      </button>
      {/* A capability's actions on this book, drawn like every other row.
          They used to carry no icon at all, on the reasoning that a
          contribution supplies a label and not artwork — but the result was a
          menu whose last rows had no icon and whose labels did not line up
          with the ones above. The capability supplies the icon now, because
          it is the only side that knows what its action means; a contribution
          that supplies none gets an icon-sized gap so the column still
          reads straight. */}
      {offered.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => {
            closeMenu()
            void action.run(book.bookId)
          }}
        >
          {action.icon ? (
            ACTION_ICON[action.icon]
          ) : (
            <span aria-hidden="true" style={{ display: 'inline-block', width: ICON.control }} />
          )}
          {action.label}
        </button>
      ))}
      {/* TWO CLICKS TO REMOVE — one to ask, one to mean it — because this is
          the one thing here that takes something away. The confirm used to be a
          red pill grown over the neighbouring control; inside a menu it is a
          row that changes its words, and it collides with nothing. */}
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        data-danger="true"
        data-confirming={armed}
        aria-label={
          armed
            ? `Remove ${title} — the file you imported is kept, and this is recoverable for ${TRASH_KEPT_FOR}`
            : `Remove ${title}`
        }
        title={
          armed
            ? `The file you imported is untouched. Your tags, place and notes are recoverable for ${TRASH_KEPT_FOR}.`
            : 'Remove from the library'
        }
        onClick={() => {
          if (armed) {
            closeMenu()
            onRemove(book)
          } else {
            setConfirming(book.bookId)
          }
        }}
      >
        <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
        {armed ? 'Remove? — click again' : 'Remove from library'}
      </button>
    </>
  )
}
