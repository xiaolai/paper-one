import { BookCheck, Tag, Trash2 } from 'lucide-react'
import type { ReadingStatus } from '../../core/library'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookAction } from '../../core/capability'
import { ICON } from '../../core/metrics'

/**
 * The three things that can be done to a book, wherever it is shown.
 *
 * EXTRACTED AT THE SECOND SURFACE. The shelf's card had these items written
 * into it; the list's row needs exactly the same three, with the same words,
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
  readonly setTagging: (bookId: string | null) => void
  readonly setDraftTag: (tag: string) => void
  readonly onRemove: (book: IndexedBook) => void
  readonly onSetFinished: (bookId: string, finished: boolean) => void
  /** The caller's one way to close — see `useRowMenu`. */
  readonly closeMenu: () => void
  /** The caller's item class, so each surface keeps its own menu styling. */
  readonly itemClass: string
  /**
   * Actions the composed capabilities contributed (WI-C.3) — Download,
   * Remove download… Filtered HERE by each action's `when` against this
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
  setDraftTag,
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
            as any of those. */}
        {status === 'finished' ? 'Mark as unread' : 'Mark as finished'}
      </button>
      <button
        type="button"
        role="menuitem"
        className={itemClass}
        onClick={() => {
          setDraftTag('')
          setTagging(book.bookId)
          closeMenu()
        }}
      >
        <Tag size={ICON.control} strokeWidth={ICON.stroke} />
        Add a tag…
      </button>
      {/* A capability's actions on this book. No icon: a contribution
          carries a label, not artwork, and a wrong icon says more than none. */}
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
            ? `Remove ${title} — the file you imported is kept, and this is recoverable for two weeks`
            : `Remove ${title}`
        }
        title={
          armed
            ? 'The file you imported is untouched. Your tags, place and notes are recoverable for two weeks.'
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
