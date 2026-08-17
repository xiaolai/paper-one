import { BookCheck, Tag, X } from 'lucide-react'
import { CANNOT_OPEN, allTags, canOpen, displayAuthor, displayTitle, statusOf, tagKey } from '../lib/library'
import type { IndexedBook } from '../lib/bookIndex'
import { ICON } from '../lib/metrics'
import { withTag } from '../lib/searchQuery'
import { BookCover } from './BookCover'
import styles from './Library.module.css'

/**
 * One book on the shelf: its jacket, its progress, and the four things a reader
 * can do to it.
 *
 * Lifted out of `Library` because two hundred lines of card in the middle of a
 * screen is where a card's own rules go to hide. Every defect this cell has had
 * — a confirm that grew over its neighbour, a tab order that ran right to left,
 * a tick nobody could name — was found by reading this block, and none of them
 * was visible while it was a `return` inside a `map`.
 *
 * The derived values are computed ONCE. In the map they were recomputed per
 * render: `allTags` folds two lists through a Set and allocates every time, and
 * this card called it three times.
 */
export interface BookCellProps {
  readonly book: IndexedBook
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
      {/* A bar only where there is something true to draw. A book
          never opened has no fraction, and a zero-width bar under
          every unread book is a row of noise that says nothing. */}
      {status !== 'unread' && (
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
        status === 'finished'
          ? `Mark ${title} unread`
          : `Mark ${title} finished`
      }
      /* A BOOK with a tick, not a bare tick. On a card that can be
         selected, confirmed or dismissed, ✓ reads as any of those —
         and it was the one control here nobody could name. The book
         in the glyph is what says the tick is about READING it. */
      title={
        status === 'finished'
          ? 'Finished — click to mark unread'
          : 'Mark as finished'
      }
      data-finished={status === 'finished'}
      onClick={() => onSetFinished(book.bookId, status !== 'finished')}
    >
      <BookCheck size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
    <button
      type="button"
      className={styles.tagButton}
      aria-label={`Tag ${title}`}
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
          ? `Remove ${title} — the file you imported is kept, and this is recoverable for two weeks`
          : `Remove ${title}`
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
          aria-label={`Add a tag to ${title}`}
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
