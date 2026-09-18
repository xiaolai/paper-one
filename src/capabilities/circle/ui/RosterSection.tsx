import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, COVER_ASPECT, LIST_COL, messageOf } from '../../../kernel'
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
  /* Both switches, `null` until a read has landed. ⚠️ **THEY WERE TWO STATES,
     AND THE SECOND HAD A DEFAULT NOTHING COULD SEE** (2026-09-15, two surviving
     mutants): `muted` began `false` and was reset to `false`, but it was drawn
     only beside `shows` and set in the same batch as it, so neither default
     ever reached the screen and flipping either default changed nothing. One
     read sets both, so they are one value. */
  const [switches, setSwitches] = useState<{ readonly shows: boolean; readonly muted: boolean } | null>(null)
  /* ⚠️ **NARROWED FROM `disable all`, WHICH COVERED MORE THAN ITS REASON.** The
     comment explained the `circle !== null` half and said nothing about the
     second, which is the LOADING guard and is very much observable: without it
     the row draws a switch in the wrong position while the first read is still
     in flight — "clears what the old port loaded when the circle is replaced"
     covers it. ⚠️ **AND WHAT REPLACED IT DISABLED NOTHING AT ALL** (found
     2026-09-14 by `pnpm directives:check`): the narrowed directive was written
     INSIDE this prose, and Stryker reads one only where the comment begins
     with it.
     ⚠️ **AND `circle !== null` IS NOT EQUIVALENT, WHICH THIS TREATED IT AS** —
     it said to disable it one day, on the reasoning that with no circle there
     is nothing to read, so the guard beside it is null anyway. Not in the
     commit that TAKES the circle away: the reset below is an effect, so that
     commit still holds the old circle's switches, and only this operand keeps
     them off a frame the webview can paint (2026-09-15, when this file became
     a changed subject). Nothing is disabled here; "draws no switch and no
     friend’s shelf without a circle, not even in the commit before its reset
     runs" holds it. */
  const switchReady = circle !== null && switches !== null
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
    /* ⚠️ **BOUND TO ITS SOURCE — AND THE CHECK THAT SAID SO COULD NOT FAIL.**
       A switch write held the `look` it was made with, so a write still in
       flight when the circle was replaced completed, called that old `look`,
       and committed the old circle's answers over the new one's. The guard
       against it was `circle === held` beside the counter, with `held` assigned
       from `circle` one line earlier in the same closure: a name compared with
       itself, true every time, and the defect it named was live (2026-09-15, a
       surviving mutant; "reads a switch back through the circle it holds NOW"
       measures it). It is closed where it began — a write reads back through
       `readBack`, the look the row holds when the write lands — so the counter
       is the whole check: the effect below retires every read in flight when
       the circle changes, and each later look supersedes an earlier one. The
       `port` half went too; nothing here reads through the person port. */
    const stillMine = (): boolean => read.current === mine

    /* ⚠️ **THE SWITCHES COMMIT ON THEIR OWN.** All three answers were awaited
       and then set together, so one unreadable shelf file threw before any of
       them landed — and a switch the reader had just moved went on showing its
       old position, because the failure was in something else entirely. */
    try {
      const [on, quiet] = await Promise.all([circle.showsShelf(person.person), circle.muted(person.person)])
      if (!stillMine()) return
      setSwitches({ shows: on, muted: quiet })
      setUnread(null)
    } catch (cause) {
      if (!stillMine()) return
      setUnread(messageOf(cause))
      return
    }

    /* No `stillMine()` here: nothing is awaited since the one above, so it
       could only answer as that one did. */
    if (!open) {
      setFriend(null)
      return
    }
    try {
      const view = await circle.friend(person.person)
      if (!stillMine()) return
      setFriend(view)
    } catch (cause) {
      if (!stillMine()) return
      setUnread(messageOf(cause))
    }
  }, [circle, person.person, open])
  /* What a write reads back through once it lands: the look the row holds
     THEN, so a circle replaced meanwhile is the one asked. */
  const lookNow = useRef(look)
  lookNow.current = look
  const readBack = (): Promise<void> => lookNow.current()

  /* ⚠️ **A NEW SOURCE INVALIDATES WHAT THE OLD ONE LOADED.** Cleanup only
     unsubscribed: anything in flight stayed eligible to commit, and the values
     already on screen — a switch position, a friend's shelf — kept being drawn
     as though they belonged to the new port. Bumping the counter retires every
     read in flight, and clearing the state means the row shows nothing rather
     than something from a port it no longer holds.
     ⚠️ **THE COUNTER WAS BUMPED TWICE, IN THE BODY AND IN THE CLEANUP**, so
     the cleanup could be emptied and nothing noticed (2026-09-15, a surviving
     mutant). The cleanup runs just before the body on every change, and at
     mount nothing is in flight: one bump is the whole retirement, kept in the
     cleanup, where it also runs when the row goes. */
  useEffect(() => {
    setSwitches(null)
    setFriend(null)
    setUnread(null)
    return () => {
      read.current += 1
    }
  }, [circle, person.person])

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
              checked={switches.shows}
              disabled={busy}
              aria-label={`Show my shelf to ${person.displayName}`}
              onChange={(e) => {
                /* Through the row's act, so the row is busy until the write
                   lands and two quick flips cannot resolve out of order — and
                   the switch is read back once it has. */
                const on = e.target.checked
                void run(() => circle.setShowsShelf(person.person, on), readBack)
              }}
            />
            <span className={CAPABILITY_UI.grow}>Show my shelf</span>
          </label>
          <p className={CAPABILITY_UI.hint}>
            {switches.shows
              ? `${person.displayName} can see every book in your library, including ones you have shared nothing from.`
              : `${person.displayName} will be able to see every book in your library, including ones you have shared nothing from.`}
          </p>
          {/* ⚠️ **THE REVERSIBLE ANSWER, WHICH DID NOT EXIST.** `'muted'` was
              modelled from the start — parsed, admitted by `acceptsTransport`,
              and given `retain: 'keep'` on the stated reasoning that *"a reader
              who mutes is saying not right now"* — and nothing ever wrote it.
              So a reader who wanted one person off the page had one control,
              Remove, which purges their passages and the pairing and needs a
              fresh SAS ceremony to undo. A quiet preference and a severance
              were the same button. */}
          <label className={CAPABILITY_UI.row}>
            <input
              type="checkbox"
              className={CAPABILITY_UI.toggle}
              checked={switches.muted}
              disabled={busy}
              aria-label={`Hold back ${person.displayName}'s passages`}
              onChange={(e) => {
                /* The shelf switch's reason: through the row's act, so two
                   quick flips cannot resolve out of order and the state is
                   read back once the write has landed. */
                const on = e.target.checked
                void run(() => circle.setMuted(person.person, on), readBack)
              }}
            />
            <span className={CAPABILITY_UI.grow}>Hold back their passages</span>
          </label>
          <p className={CAPABILITY_UI.hint}>
            {switches.muted
              ? `${person.displayName}'s passages are not drawn in your books. Nothing has been deleted — what they have shared is still here, and turning this off brings it back.`
              : `${person.displayName}'s passages appear in your books, where the sentence is.`}
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
 * A jacket beside a row, at the size the shelf's own list draws one.
 *
 * DERIVED, and it was `24×36` written onto the `<img>` with no CSS sizing it —
 * which IS 2:3, done by hand next to the two constants that say so. The list
 * view's thumb is `LIST_COL.thumb` at `COVER_ASPECT`, and a book's jacket in a
 * capability's row is the same object in the same kind of row: an anchor for the
 * eye, not the subject of the line. So it takes the same numbers rather than a
 * second pair that happen to have the same proportion.
 *
 * ⚠️ **THIS MAKES IT 22×33 WHERE IT WAS 24×36.** The proportion is unchanged;
 * the jacket is 2px narrower, which is the shelf's number rather than this
 * file's. `ROW_H`'s own doc describes the 33px jacket a 44px row carries, so 33
 * is the height the rest of the app already draws a row's cover at.
 *
 * ROUNDED, because `COVER_ASPECT` is `2 / 3` and `22 / (2 / 3)` is exactly 33 —
 * but only for a thumb divisible by 2; `cellHeightFor` rounds for the same
 * reason and an `<img>` attribute may not carry a fraction.
 */
const JACKET_W = LIST_COL.thumb
const JACKET_H = Math.round(LIST_COL.thumb / COVER_ASPECT)

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
  /* ⚠️ **THE IDENTITY OF A JACKET IS FOUR FIELDS, NOT THE OBJECT HOLDING
     THEM.** This depended on `book`, and `friend()` builds fresh objects on
     every refresh — so any unrelated circle update (a switch moving, a fetch
     round landing) gave every drawn row a new object reference, cleared the
     picture it had already fetched and verified, aborted whatever was in
     flight, and queued the same request again. Nothing about the jacket had
     changed. These four are what decide which bytes are wanted; while they
     hold, the image stays. */
  const { pub, title, author, language, own, device, cover } = book
  useEffect(() => {
    setUrl(null)
    if (!seen || cover === null || device === null) return
    /* Abandoned when the row goes — hidden shelf, unmounted screen — so a
       request still waiting its turn is not dialled for a picture nobody
       will see, and one on its way is let go. The port answers null for one,
       never a rejection: a failure is its to report, through the diagnostics. */
    const abandon = new AbortController()
    /* Rebuilt from the captured PRIMITIVES rather than closing over `book`, so
       the dependency list below is exhaustive as written and needs no
       suppression: nothing here can go stale that is not also listed. */
    void port.cover(person, { pub, title, author, language, own, device, cover }, abandon.signal).then(
      (found) => {
        if (!abandon.signal.aborted) setUrl(found)
      },
      () => {},
    )
    return () => {
      abandon.abort()
    }
  }, [port, person, pub, title, author, language, own, device, cover, seen])
  return (
    <span ref={slot} data-jacket-slot={book.pub}>
      {url === null ? null : (
        <img src={url} alt="" width={JACKET_W} height={JACKET_H} data-jacket={book.pub} />
      )}
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
