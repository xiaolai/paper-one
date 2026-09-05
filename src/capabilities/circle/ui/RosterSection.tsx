import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, messageOf } from '../../../kernel'
import type { KnownPerson, PersonPort } from '../../peer'
import type { CirclePort, FriendBook, FriendView } from '../lib/circlePort'
import { short } from './personId'
import { useAction } from './useAction'
import { useVisible } from './useVisible'

/**
 * The people in the circle — WI-22.D3's roster, WI-23.C2's switch, WI-23.C4's
 * Friends view, WI-23.C3's Remove. Each row has action state of its own:
 * removing one person does not hold another's switch, and a switch that
 * would not turn is said in its row.
 *
 * ⚠️ **A FRIEND'S PASSAGES ARE DRAWN IN THE BOOK, NOT LISTED HERE.** That is
 * `surfaces.md`'s decision and this screen does not relitigate it: a shared
 * passage belongs on the page it is about, underlined where the sentence
 * is, and a list of quotes in a side panel is a second place to read the
 * same book badly.
 */
export function RosterSection({
  port,
  circle,
  people,
  refresh,
  openBook,
}: {
  readonly port: PersonPort
  readonly circle: CirclePort | null
  readonly people: readonly KnownPerson[]
  /** Read the roster again once somebody was removed. */
  readonly refresh: () => Promise<void>
  readonly openBook?: (bookId: string) => void
}) {
  return (
    <div className={CAPABILITY_UI.section}>
      {people.length === 0 ? (
        <p className={CAPABILITY_UI.hint}>Nobody yet.</p>
      ) : (
        people.map((one) => <PersonRow key={one.person} person={one} port={port} circle={circle} refresh={refresh} {...(openBook ? { openBook } : {})} />)
      )}
      {/* ⚠️ SAID OUT LOUD, and it says WHICH of two things Remove does. With
          the circle's port, removing somebody clears what they shared from
          this device (WI-23.C3) — and cannot take back what you shared with
          them, which `relationships.md` requires the copy to admit. Without
          it, the button only stops new passages, and says so. */}
      {people.length === 0 ? null : (
        <p className={CAPABILITY_UI.hint}>
          {circle
            ? 'Removing somebody stops new passages arriving and clears what they shared from this device. It cannot take back what you shared with them.'
            : 'Removing somebody stops new passages arriving. What they already shared stays until you clear it.'}
        </p>
      )}
    </div>
  )
}

/**
 * One person: their name and id, the shelf switch, their shelf and recent
 * activity on request, and Remove.
 *
 * ⚠️ **THE SWITCH'S COPY SAYS WHAT IT ENDS.** `reading.md`: *"Publishing a
 * shelf ends the indistinguishability, for that person, and that is the
 * point"* — and the design must say so in the switch's own copy rather than
 * in a document. Off by default; per person; never per book.
 */
function PersonRow({
  person,
  port,
  circle,
  refresh,
  openBook,
}: {
  readonly person: KnownPerson
  readonly port: PersonPort
  readonly circle: CirclePort | null
  readonly refresh: () => Promise<void>
  readonly openBook?: (bookId: string) => void
}) {
  const [shows, setShows] = useState<boolean | null>(null)
  /* Stryker disable next-line all: the switch is read through the circle's port, so it is known only when there is one. */
  const switchReady = circle !== null && shows !== null
  const [friend, setFriend] = useState<FriendView | null>(null)
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState<string | null>(null)
  const read = useRef(0)
  /* The row's own act — the switch and Remove — busy and reported here. */
  const { busy, trouble, run } = useAction('That did not go through.')
  /* Which port the screen holds NOW: a removal begun through an old port
     must not refresh through it after the new port's read. */
  const current = useRef(port)
  current.current = port

  const look = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no circle the read fails into a trouble line under a switch nobody draws. */
    if (circle === null) return
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++read.current
    try {
      const on = await circle.showsShelf(person.person)
      const view = open ? await circle.friend(person.person) : null
      if (read.current !== mine) return
      setShows(on)
      setFriend(view)
      setUnread(null)
    } catch (cause) {
      if (read.current !== mine) return
      setUnread(messageOf(cause))
    }
  }, [circle, person.person, open])

  useEffect(() => {
    void look()
    return circle?.subscribe(() => void look())
  }, [circle, look])

  return (
    <div>
      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>{person.displayName}</span>
        <span className={CAPABILITY_UI.code}>{short(person.person)}</span>
        {circle === null ? null : (
          <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => setOpen((was) => !was)}>
            {open ? 'Hide their shelf' : 'Their shelf'}
          </button>
        )}
        <button
          type="button"
          className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonDanger}`}
          disabled={busy}
          onClick={() =>
            void run(
              () => (circle ? circle.forget(person.person) : port.forgetPerson(person.person)),
              /* A port replaced under the act: the new port's own read stands. */
              () => (current.current === port ? refresh() : undefined),
            )
          }
        >
          Remove
        </button>
      </div>
      {unread === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read what {person.displayName} shared. {unread}</p>}
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      {switchReady ? (
        <>
          <label className={CAPABILITY_UI.row}>
            <input
              type="checkbox"
              className={CAPABILITY_UI.toggle}
              checked={shows}
              disabled={busy}
              aria-label={`Show my shelf to ${person.displayName}`}
              onChange={(e) => {
                /* Through the row's act, so the row is busy until the write
                   lands and two quick flips cannot resolve out of order — and
                   the switch is read back once it has. */
                const on = e.target.checked
                void run(() => circle.setShowsShelf(person.person, on), look)
              }}
            />
            <span className={CAPABILITY_UI.grow}>Show my shelf</span>
          </label>
          <p className={CAPABILITY_UI.hint}>
            {shows
              ? `${person.displayName} can see every book in your library, including ones you have shared nothing from.`
              : `${person.displayName} will be able to see every book in your library, including ones you have shared nothing from.`}
          </p>
        </>
      ) : null}
      {open && friend !== null && circle !== null ? (
        <Friend view={friend} name={person.displayName} port={circle} person={person.person} {...(openBook ? { openBook } : {})} />
      ) : null}
    </div>
  )
}

/**
 * A friend's jacket beside their row — WI-23.C5. Asked for when the row is
 * SEEN, never in the round and not merely when it is drawn; nothing drawn
 * until it has been fetched and verified, and nothing said when it cannot
 * be.
 */
function Jacket({ port, person, book }: { readonly port: CirclePort; readonly person: string; readonly book: FriendBook }) {
  const [url, setUrl] = useState<string | null>(null)
  const slot = useRef<HTMLSpanElement | null>(null)
  const seen = useVisible(slot)
  useEffect(() => {
    setUrl(null)
    if (!seen || book.cover === null || book.device === null) return
    /* Abandoned when the row goes — hidden shelf, unmounted screen — so a
       request still waiting its turn is not dialled for a picture nobody
       will see, and one on its way is let go. The port answers null for one,
       never a rejection: a failure is its to report, through the diagnostics. */
    const abandon = new AbortController()
    void port.cover(person, book, abandon.signal).then(
      (found) => {
        if (!abandon.signal.aborted) setUrl(found)
      },
      () => {},
    )
    return () => {
      abandon.abort()
    }
  }, [port, person, book, seen])
  return (
    <span ref={slot} data-jacket-slot={book.pub}>
      {url === null ? null : <img src={url} alt="" width={24} height={36} data-jacket={book.pub} />}
    </span>
  )
}

/**
 * A friend's shelf and what they did lately — the Friends view, WI-23.C4.
 *
 * A book the reader also has LINKS to their own copy; one they do not have
 * links nowhere, and says nothing more than its title and author. Named
 * people, no numbers: this is the surface that feels like Douban, and it is
 * the whole reason the shelf exists.
 */
function Friend({
  view,
  name,
  port,
  person,
  openBook,
}: {
  readonly view: FriendView
  readonly name: string
  readonly port: CirclePort
  readonly person: string
  readonly openBook?: (bookId: string) => void
}) {
  return (
    <div className={CAPABILITY_UI.section} data-friend-view={name}>
      {view.shelf.length === 0 ? (
        <p className={CAPABILITY_UI.hint}>{name} has shown you no books.</p>
      ) : (
        view.shelf.map((book) => (
          <div className={CAPABILITY_UI.row} key={book.pub} data-own-book={book.own ?? undefined}>
            <Jacket port={port} person={person} book={book} />
            <span className={CAPABILITY_UI.grow}>
              {book.title}
              {book.author ? ` — ${book.author}` : ''}
            </span>
            {book.own !== null && openBook ? (
              <button type="button" className={CAPABILITY_UI.button} onClick={() => openBook(book.own!)} aria-label={`Open your copy of ${book.title}`}>
                On your shelf
              </button>
            ) : book.own !== null ? (
              <span className={CAPABILITY_UI.value}>On your shelf</span>
            ) : null}
          </div>
        ))
      )}
      {view.recent.length === 0 ? null : (
        <>
          <p className={CAPABILITY_UI.hint}>Lately</p>
          {view.recent.map((one, i) => (
            // Stryker disable next-line StringLiteral: a key is for React's reconciler, not the reader.
            <div className={CAPABILITY_UI.row} key={`${one.bookId}:${one.kind}:${i}`}>
              <span className={CAPABILITY_UI.grow}>
                {one.kind === 'review' ? `${name} on ${one.title}: “${one.value}”` : one.kind === 'rate' ? `${name} rated ${one.title} ${one.value}` : `${name} ${one.value} ${one.title}`}
              </span>
            </div>
          ))}
        </>
      )}
      {view.lists.length === 0 ? null : (
        <>
          <p className={CAPABILITY_UI.hint}>Lists</p>
          {view.lists.map((list) => (
            <div className={CAPABILITY_UI.section} key={list.id} data-friend-list={list.id}>
              <p className={CAPABILITY_UI.value}>{list.title}</p>
              {list.items.length === 0 ? <p className={CAPABILITY_UI.hint}>Nothing on it yet.</p> : null}
              {list.items.map((item) => (
                <div className={CAPABILITY_UI.row} key={item.pub}>
                  <span className={CAPABILITY_UI.grow}>
                    {item.title}
                    {item.author ? ` — ${item.author}` : ''}
                    {item.note ? ` · “${item.note}”` : ''}
                  </span>
                  {item.own !== null && openBook ? (
                    <button type="button" className={CAPABILITY_UI.button} onClick={() => openBook(item.own!)} aria-label={`Open your copy of ${item.title}`}>
                      On your shelf
                    </button>
                  ) : item.own !== null ? (
                    <span className={CAPABILITY_UI.value}>On your shelf</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
