import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { CirclePort } from '../lib/circlePort'
import { EMPTY_VIEW, namesOf, sentencesOf, starsText, type CircleView } from '../lib/circleView'

/**
 * The circle's view of one book, as the pane reads it — WI-23.D1, D2, D3.
 * Its own subscription, its own generation: the reader's own controls stand
 * on their own, and a view that cannot be read is drawn empty rather than
 * costing them.
 */
function useCircleBook(circle: CirclePort, bookId: string): CircleView | null {
  const [view, setView] = useState<CircleView | null>(null)
  /** Which read is newest, so a slow answer cannot overwrite a later one. */
  const viewed = useRef(0)
  const lookAround = useCallback(async () => {
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++viewed.current
    try {
      const held = await circle.book(bookId)
      if (viewed.current === mine) setView(held)
    } catch {
      if (viewed.current === mine) setView(EMPTY_VIEW)
    }
  }, [circle, bookId])
  useEffect(() => {
    // Stryker disable next-line CallExpression: the read that follows replaces the view; the reset only spares a flash of the previous book's.
    setView(null)
    void lookAround()
    return circle.subscribe(() => void lookAround())
  }, [circle, lookAround])
  return view
}

/**
 * The circle's view — who else has it, what they made of it, their reviews,
 * and what else sits on their shelves beside it. Computed by
 * `circleView.ts`; this only draws it. Every number is an integer count of
 * people or of stars — a count over named people, never a number that could
 * be read as Douban's — and the "also read" list shows names and never a
 * count, so with one friend it is a list and not a ranking.
 * `data-circle-view` marks the surface the falsifier greps for a decimal.
 */
export function CircleOfBook({ circle, bookId, openBook }: { readonly circle: CirclePort; readonly bookId: string; readonly openBook?: (bookId: string) => void }) {
  const view = useCircleBook(circle, bookId)
  if (view === null) return null
  const sentences = sentencesOf(view)
  const reviews = view.people.flatMap((one) => one.reviews.map((review) => ({ name: one.name, ...review })))
  return (
    <div className={CAPABILITY_UI.section} data-circle-view="">
      <p className={CAPABILITY_UI.hint}>In your circle</p>
      {view.people.length === 0 ? (
        <p className={CAPABILITY_UI.hint}>Nobody in your circle has said anything about this book.</p>
      ) : (
        <>
          {sentences.map((sentence) => (
            <p className={CAPABILITY_UI.value} key={sentence}>
              {sentence}
            </p>
          ))}
          {view.people
            .filter((one) => one.stars !== null)
            .map((one) => (
              <div className={CAPABILITY_UI.row} key={one.person}>
                <span className={CAPABILITY_UI.grow}>{one.name}</span>
                <span className={CAPABILITY_UI.value}>{starsText(one.stars!)}</span>
              </div>
            ))}
          {reviews.map((review) => (
            // Stryker disable next-line StringLiteral: a key is for React's reconciler, not the reader.
            <p className={CAPABILITY_UI.value} key={`${review.name}:${review.at}`}>
              {review.name}: “{review.text}”
            </p>
          ))}
        </>
      )}
      {view.alsoRead.length === 0 ? null : (
        <>
          <p className={CAPABILITY_UI.hint}>Friends who have this also have</p>
          {view.alsoRead.map((one) => (
            // Stryker disable next-line StringLiteral: a key is for React's reconciler, not the reader.
            <div className={CAPABILITY_UI.row} key={one.key}>
              <span className={CAPABILITY_UI.grow}>
                {namesOf(one.names)} also {one.names.length === 1 ? 'has' : 'have'} {one.title}
                {one.author ? ` — ${one.author}` : ''}
              </span>
              {one.own !== null && openBook ? (
                <button type="button" className={CAPABILITY_UI.button} onClick={() => openBook(one.own!)} aria-label={`Open your copy of ${one.title}`}>
                  On your shelf
                </button>
              ) : one.own !== null ? (
                <span className={CAPABILITY_UI.value}>On your shelf</span>
              ) : null}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
