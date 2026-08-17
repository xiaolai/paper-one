import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BookCheck, MoreHorizontal, Tag, Trash2 } from 'lucide-react'
import { CANNOT_OPEN, allTags, canOpen, displayAuthor, displayTitle, statusOf, tagKey } from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { ICON } from '../lib/metrics'
import { withTag } from '../lib/searchQuery'
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
}: BookCellProps) {
  const openable = canOpen(book)
  const tags = allTags(book)
  const title = displayTitle(book)
  const status = statusOf(book)
  const menuOpen = menuFor === book.bookId
  const menuRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  /* Where the menu goes, in viewport coordinates.
   *
   * FIXED, NOT ABSOLUTE, and not by preference. The cell is `overflow: hidden`
   * because virtualisation needs every row to be one height, and a menu that
   * is a child of the cell is clipped by it — the first version opened 190px
   * wide inside a 170px cell and lost its left edge. Positioning from the
   * viewport takes it out of the cell's clip without giving up the clip, which
   * is the constraint that matters more. Measured in a layout effect so it is
   * placed before it is painted. */
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    if (!menuOpen) {
      setAt(null)
      return
    }
    const place = () => {
      const r = moreRef.current?.getBoundingClientRect()
      if (r) setAt({ top: r.bottom + 4, right: window.innerWidth - r.right })
    }
    place()
    // The shelf scrolls under it and the window can resize under it; either
    // moves the button and the menu has to follow or it floats free.
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [menuOpen])

  /* Closes on a click anywhere else, and on Escape — the two ways every other
   * transient surface in this app is dismissed. Bound only while THIS menu is
   * open, so a shelf of three hundred cells is not three hundred listeners. */
  useEffect(() => {
    if (!menuOpen) return
    const close = () => {
      setMenuFor(null)
      setConfirming(null)
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      const inMenu = menuRef.current?.contains(target) ?? false
      const onButton = moreRef.current?.contains(target) ?? false
      if (!inMenu && !onButton) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen, setMenuFor, setConfirming])

  return (
    <div key={book.bookId} className={styles.cell}>
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
          titleClassName={styles.coverTitle}
        />
        <span className={styles.bookTitle}>{title}</span>
        <span className={styles.bookAuthor}>
          {displayAuthor(book)}
          {/* SAYS SO ON THE ROW. A shelf that shows a book it cannot
              open, with nothing explaining why, is worse than one that
              does not show it — the reader clicks and nothing happens. */}
          {!openable && ' · no copy'}
        </span>
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

          {menuOpen && at && (
            <div
              ref={menuRef}
              className={styles.menu}
              role="menu"
              aria-label={`Actions for ${title}`}
              style={{ top: at.top, right: at.right }}
            >
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  onSetFinished(book.bookId, status !== 'finished')
                  setMenuFor(null)
                }}
              >
                <BookCheck size={ICON.control} strokeWidth={ICON.stroke} />
                {/* Names the STATE it will produce, because the tick alone
                    could not — a bare ✓ on a card that can be selected,
                    confirmed or dismissed read as any of those. */}
                {status === 'finished' ? 'Mark as unread' : 'Mark as finished'}
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setDraftTag('')
                  setTagging(book.bookId)
                  setMenuFor(null)
                }}
              >
                <Tag size={ICON.control} strokeWidth={ICON.stroke} />
                Add a tag…
              </button>
              {/* TWO CLICKS TO REMOVE, still — one to ask, one to mean it —
                  because this is the one thing here that takes something
                  away. The confirm used to be a red pill grown over the
                  neighbouring control; inside a menu it is a row that
                  changes its words, and it collides with nothing. */}
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                data-danger="true"
                data-confirming={confirming === book.bookId}
                aria-label={
                  confirming === book.bookId
                    ? `Remove ${title} — the file you imported is kept, and this is recoverable for two weeks`
                    : `Remove ${title}`
                }
                title={
                  confirming === book.bookId
                    ? 'The file you imported is untouched. Your tags, place and notes are recoverable for two weeks.'
                    : 'Remove from the library'
                }
                onClick={() => {
                  if (confirming === book.bookId) {
                    setConfirming(null)
                    setMenuFor(null)
                    onRemove(book)
                  } else {
                    setConfirming(book.bookId)
                  }
                }}
              >
                <Trash2 size={ICON.control} strokeWidth={ICON.stroke} />
                {confirming === book.bookId ? 'Remove? — click again' : 'Remove from library'}
              </button>
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
