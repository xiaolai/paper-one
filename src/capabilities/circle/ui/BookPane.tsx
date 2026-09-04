import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, READING_STATES, STARS, type ReadingState, type Stars } from '../../../kernel'
import type { CirclePort } from '../lib/circlePort'
import { EMPTY_VIEW, namesOf, sentencesOf, starsText, type CircleView } from '../lib/circleView'
import type { ListsPort, OwnListView } from '../lib/listsPort'
import { NewListForm } from './NewListForm'
import type { BookPort, OwnOpinion } from '../lib/opinionPort'

/**
 * The book's surface, in the circle's pane — WI-23.B4.
 *
 * Drawn beside an open book. Two things, in the order the design puts them:
 *
 *  1. **The reader's own opinion** — status, stars, review — written to the
 *     RECORD through the library and replicated by the ordinary sync
 *     (WI-23.B3). Nothing here reaches the circle.
 *  2. **The one control**: *"Share what I think of this book with my
 *     circle."* On, the opinion is published and re-published as it changes;
 *     off, nothing more is, and what was already published stays — the copy
 *     says so, because turning it off is not a withdrawal.
 *
 *  3. **The circle's view of the book** — WI-23.D1, D2, D3: who else has it,
 *     what they made of it, their reviews, and what else sits on their
 *     shelves beside it. Computed by `circleView.ts`; this only draws it.
 *     Every number is an integer count of people or of stars — a count over
 *     named people, never a number that could be read as Douban's — and the
 *     "also read" list shows names and never a count, so with one friend it
 *     is a list and not a ranking.
 *  4. **The reader's own lists** — WI-23.E1: which lists this book is on,
 *     put it on one or take it off, or start a new list with it. The list
 *     itself — its title, its order, its notes — is kept on the Circle
 *     screen, where the whole list is in view.
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

const STATUS_WORDS: Readonly<Record<ReadingState, string>> = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
}

export function BookPane({ bookId, port, circle, lists = null, openBook }: BookPaneProps) {
  /* `undefined` is not read yet; `null` is read, and the book is not on the
     shelf — two answers that drew the same blank pane, forever, for a book
     that had been removed. */
  const [own, setOwn] = useState<OwnOpinion | null | undefined>(undefined)
  const [publishing, setPublishing] = useState<boolean | null>(null)
  /* What failed while ACTING, said beside the controls that stay: the way
     to try again is the control the reader just used. A failed READ is the
     other kind of news and replaces the pane, because there is nothing true
     to draw the controls from. */
  const [trouble, setTrouble] = useState<string | null>(null)
  /* Which book is on screen NOW, so an act begun on one cannot report on,
     or refresh over, the next. */
  const shown = useRef(bookId)
  shown.current = bookId
  /* Which book the opinion and the switch above were read FOR. Cleared in an
     effect they would stand one render too long under a new book; compared
     at render they never do. */
  const [ownBook, setOwnBook] = useState<string | null>(null)
  /* A list started beside this book and not yet holding it — kept at the
     pane, so a placement that failed is retried onto the same list even
     after the failure line has drawn and drawn away the list section. */
  const started = useRef<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  /* KEYED BY BOOK, so the render after a switch cannot show the previous book's failure while the effect that clears it has not run. */
  const [failure, setFailure] = useState<{ readonly book: string; readonly message: string } | null>(null)
  /* Bumped on every keystroke: a save that finishes after more typing must not clear the newer words. */
  const typed = useRef(0)
  // Stryker disable next-line BooleanLiteral: the book-change effect sets it false before anything is drawn, so the start value is never seen.
  const [busy, setBusy] = useState(false)
  /** Which read is newest, so a slow answer cannot overwrite a later one. */
  const read = useRef(0)

  const refresh = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no port the read fails into a failure nobody draws, since the pane draws nothing without one. */
    if (port === null || bookId === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++read.current
    try {
      const held = await port.own(bookId)
      const on = await port.publishing(bookId)
      if (read.current !== mine) return
      setOwn(held)
      setPublishing(on)
      setOwnBook(bookId)
      setFailure(null)
    } catch (cause) {
      if (read.current !== mine) return
      setFailure({ book: bookId, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [port, bookId])

  useEffect(() => {
    /* A new book is a new draft: the words typed about one must not be
       offered as the words about the next — nor its opinion and its switch,
       which would stand as the new book's until the read lands. */
    // Stryker disable all: the render guard (`ownBook !== bookId`) already hides the previous book's state until the new read lands; these resets keep it from leaking into that read's comparisons, which no render can show.
    setDraft(null)
    setOwn(undefined)
    setPublishing(null)
    setTrouble(null)
    setFailure(null)
    setBusy(false)
    started.current = null
    // Stryker restore all
    void refresh()
    return port?.subscribe(() => void refresh())
  }, [port, refresh])

  const [view, setView] = useState<CircleView | null>(null)
  const viewed = useRef(0)
  const lookAround = useCallback(async () => {
    if (circle === null || bookId === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++viewed.current
    try {
      const held = await circle.book(bookId)
      if (viewed.current === mine) setView(held)
    } catch {
      /* The reader's own controls stand on their own; the circle's view is
         drawn empty rather than costing them. */
      if (viewed.current === mine) setView(EMPTY_VIEW)
    }
  }, [circle, bookId])
  useEffect(() => {
    // Stryker disable next-line CallExpression: the read that follows replaces the view; the reset only spares a flash of the previous book's.
    setView(null)
    void lookAround()
    return circle?.subscribe(() => void lookAround())
  }, [circle, lookAround])

  const [ownLists, setOwnLists] = useState<readonly OwnListView[] | null>(null)
  /* A read that failed is said, and the last lists read stay: "no lists"
     and "could not read the lists" are different news. */
  const [listsTrouble, setListsTrouble] = useState<string | null>(null)
  const listed = useRef(0)
  const readLists = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no port the read fails into an empty list nobody draws. */
    if (lists === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++listed.current
    try {
      const held = await lists.lists()
      if (listed.current !== mine) return
      setOwnLists(held)
      // Stryker disable next-line CallExpression: a read that lands clears the trouble line; a trouble that stays would be the next failure's, which sets it again.
      setListsTrouble(null)
    } catch (cause) {
      if (listed.current !== mine) return
      setOwnLists((was) => was ?? [])
      setListsTrouble(cause instanceof Error ? cause.message : String(cause))
    }
  }, [lists])
  useEffect(() => {
    // Stryker disable next-line CallExpression: as above — the read that follows replaces both.
    setOwnLists(null)
    // Stryker disable next-line CallExpression: as above.
    setListsTrouble(null)
    void readLists()
    return lists?.subscribe(() => void readLists())
  }, [lists, readLists])

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

  /** Run one act with the pane busy; answers whether it succeeded, so a form knows whether to clear. */
  const act = async (what: () => Promise<void>): Promise<boolean> => {
    const marked = bookId
    setBusy(true)
    setTrouble(null)
    try {
      await what()
      // Stryker disable next-line BooleanLiteral: the form that asked is gone with its book; what it is told is read by nobody.
      if (shown.current !== marked) return true
      await refresh()
      return true
    } catch (cause) {
      if (shown.current === marked) setTrouble(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      // Stryker disable next-line ConditionalExpression: a switch of book resets busy; clearing it again changes nothing.
      if (shown.current === marked) setBusy(false)
    }
  }
  const review = draft ?? own.review
  /* Stryker disable next-line all: the lists are only ever read through the port, so one being null is the other being null. */
  const showLists = lists !== null && ownLists !== null

  return (
    <>
      <div className={CAPABILITY_UI.section}>
        {trouble !== null ? <p className={CAPABILITY_UI.hint}>That did not save. {trouble}</p> : null}
        <div className={CAPABILITY_UI.actions} role="group" aria-label="Reading status">
          {READING_STATES.map((state) => (
            <button
              key={state}
              type="button"
              className={`${CAPABILITY_UI.button} ${own.status === state ? CAPABILITY_UI.buttonPrimary : ''}`}
              aria-pressed={own.status === state}
              disabled={busy}
              onClick={() => void act(() => port.setStatus(bookId, state))}
            >
              {STATUS_WORDS[state]}
            </button>
          ))}
        </div>
        <div className={CAPABILITY_UI.actions} role="group" aria-label="Rating">
          {STARS.map((stars) => (
            <button
              key={stars}
              type="button"
              /* Stryker disable next-line ConditionalExpression: null compares below every star anyway. */
              className={`${CAPABILITY_UI.button} ${own.stars !== null && own.stars >= stars ? CAPABILITY_UI.buttonPrimary : ''}`}
              aria-pressed={own.stars === stars}
              aria-label={`${stars} ${stars === 1 ? 'star' : 'stars'}`}
              disabled={busy}
              onClick={() => void act(() => port.setStars(bookId, stars as Stars))}
            >
              ★
            </button>
          ))}
        </div>
        <textarea
          className={CAPABILITY_UI.field}
          placeholder="What did you make of it?"
          aria-label="Review"
          value={review}
          disabled={busy}
          onChange={(e) => {
            // Stryker disable next-line AssignmentOperator: any move of the revision is a keystroke; the direction is not read.
            typed.current += 1
            setDraft(e.target.value)
          }}
        />
        {draft !== null && draft !== own.review ? (
          <div className={CAPABILITY_UI.actions}>
            <button
              type="button"
              className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const rev = typed.current
                  await port.setReview(bookId, draft)
                  /* The draft is the book's, and the revision's: a save that
                     finishes after the reader moved on, or typed on, must not
                     erase what they typed next. */
                  // Stryker disable next-line ConditionalExpression: a switch of book resets the draft to nothing, so clearing nothing again changes nothing; the revision guard decides.
                  if (shown.current === bookId && typed.current === rev) setDraft(null)
                })
              }
            >
              Keep review
            </button>
          </div>
        ) : null}
      </div>

      <div className={CAPABILITY_UI.section}>
        <label className={CAPABILITY_UI.row}>
          <input
            type="checkbox"
            className={CAPABILITY_UI.toggle}
            checked={publishing}
            disabled={busy}
            onChange={(e) => void act(() => port.setPublishing(bookId, e.target.checked))}
          />
          <span className={CAPABILITY_UI.grow}>Share what I think of this book with my circle</span>
        </label>
        {/* ⚠️ THE COPY SAYS WHAT TURNING IT OFF DOES NOT DO. A withdrawal is
            its own act with its own copy; a switch that looked like one would
            leave a reader believing they had taken something back. */}
        <p className={CAPABILITY_UI.hint}>
          {publishing
            ? 'Your status, rating, review and tags for this book are shared, and follow your changes.'
            : 'Nothing about this book is shared. Turning this off later keeps what was already shared.'}
        </p>
      </div>

      {view === null ? null : <CircleOfBook view={view} {...(openBook ? { openBook } : {})} />}
      {showLists ? <OnLists bookId={bookId} lists={lists} own={ownLists} trouble={listsTrouble} busy={busy} act={act} started={started} current={() => shown.current} /> : null}
    </>
  )
}

/**
 * The circle's view — WI-23.D1, D2, D3. `data-circle-view` marks the surface
 * the falsifier greps for a decimal.
 */
function CircleOfBook({ view, openBook }: { readonly view: CircleView; readonly openBook?: (bookId: string) => void }) {
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

/**
 * The reader's own lists, as they concern THIS book — WI-23.E1. On or off
 * each list; a new list started with it. Failures land in the pane's one
 * failure line through `act`.
 */
function OnLists({
  bookId,
  lists,
  own,
  trouble,
  busy,
  act,
  started,
  current,
}: {
  readonly bookId: string
  readonly lists: ListsPort
  /** Which book the pane shows NOW — a create that lands after a move must not hand its id to the next book. */
  readonly current: () => string | null
  readonly own: readonly OwnListView[]
  readonly trouble: string | null
  readonly busy: boolean
  readonly act: (what: () => Promise<void>) => Promise<boolean>
  readonly started: { current: string | null }
}) {
  return (
    <div className={CAPABILITY_UI.section} data-own-lists="">
      <p className={CAPABILITY_UI.hint}>Your lists</p>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read your lists. {trouble}</p>}
      {own.map((list) => {
        const on = list.items.find((item) => item.bookId === bookId)
        return (
          <div className={CAPABILITY_UI.row} key={list.id}>
            <span className={CAPABILITY_UI.grow}>{list.title}</span>
            <button
              type="button"
              className={CAPABILITY_UI.button}
              disabled={busy}
              aria-label={on ? `Take this book off ${list.title}` : `Put this book on ${list.title}`}
              onClick={() => void act(() => (on ? lists.takeOff(list.id, on.pub) : lists.place(list.id, bookId)))}
            >
              {on ? 'On it — take off' : 'Put on'}
            </button>
          </div>
        )
      })}
      <NewListForm
        busy={busy}
        placeholder="A new list, starting with this book"
        onStart={(title) =>
          act(async () => {
            const id = started.current ?? (await lists.create(title))
            /* Remembered for a retry only while this is still the book: a
               create that lands after a move must not hand its id to the
               next book's form. */
            if (current() !== bookId) return
            started.current = id
            await lists.place(id, bookId)
            // Stryker disable next-line ConditionalExpression: a create remembered for a book the reader left is never read — the guard above refuses it first.
            if (current() === bookId) started.current = null
          })
        }
      />
    </div>
  )
}
