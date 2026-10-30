import { CAPABILITY_UI } from '../../../kernel'
import type { CirclePort } from '../lib/circlePort'
import type { ListsPort } from '../lib/listsPort'
import type { BookPort } from '../lib/opinionPort'
import { CircleOfBook } from './CircleOfBook'
import { ListMembership } from './ListMembership'
import { OpinionEditor } from './OpinionEditor'
import { useOpinion } from './useOpinion'

/**
 * The book's surface, in the circle's pane — WI-23.B4.
 *
 * Drawn beside an open book. Three things, in the order the design puts
 * them, each its own component with its own subscription and its own
 * action state:
 *
 *  1. **The reader's own opinion and the one switch** — `OpinionEditor`.
 *  2. **The circle's view of the book** — `CircleOfBook`, WI-23.D1–D3.
 *  3. **The reader's own lists**, as they concern this book —
 *     `ListMembership`, WI-23.E1.
 *
 * ⚠️ **THE OPINION READ IS THE GATE.** It is the one read that says whether
 * the book is on the shelf at all — a book that is not draws one sentence
 * and no controls, since there is nothing to place or to publish. The other
 * two read on their own once the gate is passed, and neither can take the
 * controls down: a view that will not read draws empty, lists that will not
 * read say so beside the lists.
 *
 * ⚠️ **THE EDITOR AND THE LISTS ARE KEYED BY BOOK.** A draft, a busy flag, a
 * trouble line and a list started-but-not-filled belong to one book; an act
 * begun on the previous book finishes in an instance that has gone, and
 * reports to nobody — which is what "the pane's state belongs to one book"
 * used to take a reference and four resets to say.
 */

export interface BookPaneProps {
  /** The open book, or `null` on a screen with none — which draws a sentence. */
  readonly bookId: string | null
  /** `null` before the capability has started. */
  readonly port: BookPort | null
  /** The circle's side — `null` before start, or on a composition without one. */
  readonly circle: CirclePort | null
  /** The reader's own lists — `null` before start. */
  readonly lists?: ListsPort | null
  /** Open the reader's own copy of a book a friend also has. */
  readonly openBook?: (bookId: string) => void
}

export function BookPane({ bookId, port, circle, lists = null, openBook }: BookPaneProps) {
  const { own, publishing, ownBook, failure, refresh } = useOpinion(port, bookId)

  /* Stryker disable next-line ConditionalExpression: with no port nothing is ever read, so falling through draws nothing too. */
  if (port === null) return null
  if (bookId === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Open a book to say what you think of it.</p>
      </div>
    )
  }
  // Stryker disable next-line ConditionalExpression: the effect clears a failure on the next tick; the key closes the one render between.
  if (failure !== null && failure.book === bookId) {
    return <p className={CAPABILITY_UI.hint}>Paper could not read this book’s circle. {failure.message}</p>
  }
  /* Stryker disable next-line all: the two are set together by one read, so either alone decides. */
  if (own === undefined || publishing === null || ownBook !== bookId) return null
  if (own === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>This book is not on your shelf.</p>
      </div>
    )
  }

  return (
    <>
      <OpinionEditor key={bookId} bookId={bookId} port={port} own={own} publishing={publishing} refresh={refresh} />
      {circle === null ? null : <CircleOfBook key={bookId} circle={circle} bookId={bookId} {...(openBook ? { openBook } : {})} />}
      {lists === null ? null : <ListMembership key={bookId} bookId={bookId} lists={lists} />}
    </>
  )
}
