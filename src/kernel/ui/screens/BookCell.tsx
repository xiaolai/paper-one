import { useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { CANNOT_OPEN, allTags, canOpen, displayTitle, statusOf, tagKey } from '../../core/library'
import type { IndexedBook } from '../../core/bookIndex'
import type { BookAction } from '../../core/capability'
import { ICON } from '../../core/metrics'
import { withTag } from '../../core/searchQuery'
import { useRowMenu } from '../hooks/useRowMenu'
import { BookMenu } from './BookMenu'
import { BookCover } from './BookCover'
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
export interface BookCellProps {
  readonly book: IndexedBook
  /** Which book has its menu open, by id, or null. */
  readonly menuFor: string | null
  readonly setMenuFor: React.Dispatch<React.SetStateAction<string | null>>
  /** Which book is asking to be confirmed for removal, by id, or null. */
  readonly confirming: string | null
  readonly setConfirming: React.Dispatch<React.SetStateAction<string | null>>
  /** Which book has its tag field open, by id, or null. */
  readonly tagging: string | null
  readonly setTagging: React.Dispatch<React.SetStateAction<string | null>>
  readonly draftTag: string
  readonly setDraftTag: React.Dispatch<React.SetStateAction<string>>
  readonly setQuery: React.Dispatch<React.SetStateAction<string>>
  readonly onOpen: (book: IndexedBook) => void
  readonly onRemove: (book: IndexedBook) => void
  readonly onTag: (bookId: string, tag: string) => void
  readonly onUntag: (bookId: string, tag: string) => void
  readonly onSetFinished: (bookId: string, finished: boolean) => void
  /** Contributed actions, passed through to the menu — see `BookMenu`. */
  readonly actions: readonly BookAction[]
}

export function BookCell({
  book,
  menuFor,
  setMenuFor,
  confirming,
  setConfirming,
  tagging,
  setTagging,
  draftTag,
  setDraftTag,
  setQuery,
  onOpen,
  onRemove,
  onTag,
  onUntag,
  onSetFinished,
  actions,
}: BookCellProps) {
  const openable = canOpen(book)
  const tags = allTags(book)
  const title = displayTitle(book)
  const status = statusOf(book)
  const menuOpen = menuFor === book.bookId
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
      /* On the last row there is no room below, so it flips — and flipped CLEAR
         of a 225px card it leapt the whole card and landed over the neighbour
         above, reading as that book's menu. Overlaid, it drapes up over its own
         jacket from the same bottom edge, which is fine: it is unmistakably this
         book's menu, and a jacket is not something the reader needs to keep
         seeing while they choose. */
      overlayOnFlip: true,
    },
  )

  return (
    <div key={book.bookId} className={styles.cell} ref={cellRef}>
      <button
        type="button"
        className={styles.book}
        disabled={!openable}
        data-disabled={!openable}
        title={openable ? `Open ${title}` : CANNOT_OPEN}
        onClick={() => openable && onOpen(book)}
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
            aria-label={
              status === 'finished'
                ? 'Finished'
                : `${Math.round((book.progress ?? 0) * 100)}% read`
            }
          >
            <span
              className={styles.progressFill}
              style={{ inlineSize: `${Math.round((book.finished ? 1 : book.progress ?? 0) * 100)}%` }}
            />
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
            title="Finish, tag, or remove"
            onClick={() => {
              setConfirming(null)
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
      </div>

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
            aria-label={`Add a tag to ${title}`}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') setTagging(null)
            }}
            onBlur={() => setTagging(null)}
          />
        </form>
      )}
      {/* The reader's OWN tags carry a remove control; a publisher's
          subject does not, because it is a fact about the book rather
          than a choice, and it comes back on the next open anyway. */}
      {tags.length > 0 && (
        <div className={styles.tagRow}>
          {tags.slice(0, 4).map((tag) => {
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
}
