import { useRef, useState } from 'react'
import { CAPABILITY_UI, READING_STATES, STARS, type ReadingState, type Stars } from '../../../kernel'
import type { BookPort, OwnOpinion } from '../lib/opinionPort'
import { useAction } from './useAction'

const STATUS_WORDS: Readonly<Record<ReadingState, string>> = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
}

/**
 * The reader's own opinion — status, stars, review — and the one switch,
 * with action state of their own. WI-23.B4's first two things:
 *
 *  1. **The opinion** is written to the RECORD through the library and
 *     replicated by the ordinary sync (WI-23.B3). Nothing here reaches the
 *     circle.
 *  2. **The one control**: *"Share what I think of this book with my
 *     circle."* On, the opinion is published and re-published as it changes;
 *     off, nothing more is, and what was already published stays — the copy
 *     says so, because turning it off is not a withdrawal.
 *
 * ⚠️ **MOUNTED PER BOOK — the pane keys it by `bookId`.** A draft, a busy
 * flag and a trouble line belong to one book; an act begun on the previous
 * book lands in an instance that has gone, and reports to nobody.
 */
export function OpinionEditor({
  bookId,
  port,
  own,
  publishing,
  refresh,
}: {
  readonly bookId: string
  readonly port: BookPort
  readonly own: OwnOpinion
  readonly publishing: boolean
  /** Read the opinion again once an act lands. */
  readonly refresh: () => Promise<void>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  /* Bumped on every keystroke: a save that finishes after more typing must not clear the newer words. */
  const typed = useRef(0)
  /* Which PORT the editor holds NOW: an act begun through an old port — the
     capability restarted while it was out — must not refresh through it
     after the new port's read, and hand the new run the old one's state. */
  const current = useRef(port)
  current.current = port
  /* What failed while ACTING, said beside the controls that stay: the way
     to try again is the control the reader just used. */
  const { busy, trouble, run } = useAction('That did not save.')

  /** Run one act, then read again — unless the port was replaced under it. */
  const act = (what: () => Promise<void>): Promise<boolean> => run(what, () => (current.current === port ? refresh() : undefined))
  const review = draft ?? own.review

  return (
    <>
      <div className={CAPABILITY_UI.section}>
        {trouble !== null ? <p className={CAPABILITY_UI.hint}>{trouble}</p> : null}
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
                  /* The draft is the revision's: a save that finishes after
                     the reader typed on must not erase what they typed next. */
                  if (typed.current === rev) setDraft(null)
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
    </>
  )
}
