import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'
import type { KnownPerson, PairOffer, PairingPending, PersonPort, PersonStatus } from '../../peer'
import type { CirclePort, FriendBook, FriendView } from '../lib/circlePort'
import type { ListsPort, OwnListView } from '../lib/listsPort'
import { NewListForm } from './NewListForm'

/**
 * The circle, as a panel — WI-22.D3's surface.
 *
 * ## What this page is for, and what it deliberately is not
 *
 * ⚠️ **A FRIEND'S PASSAGES ARE DRAWN IN THE BOOK, NOT LISTED HERE.** That is
 * `surfaces.md`'s decision and this panel does not relitigate it: a shared
 * passage belongs on the page it is about, underlined where the sentence is,
 * and a list of quotes in a side panel is a second place to read the same book
 * badly. What is here is everything a reader cannot see by turning a page —
 * **who** is in the circle, **which device** they are speaking from, and
 * whether their own identity is one dead laptop from being gone.
 *
 * ## The custody marker is the reason this panel exists at all
 *
 * ⚠️ **"ONE DEVICE, NO COPY" IS A STANDING STATE, NOT A DIALOG.**
 * `identity.md` §"The window closes silently" is the whole argument: a reader
 * can only be shown their phrase while a working device still holds it, and a
 * laptop dies without warning — *"That single line is the difference between
 * lazy custody and negligence."* So the marker sits here permanently while it
 * is true, and nothing modal ever interrupts to demand the reader write words
 * down. Ask louder; never block.
 *
 * ## Nothing here mints anything on its own
 *
 * ⚠️ **RENDERING THIS PANEL MUST NOT CREATE A PERSON IDENTITY.** `status` is
 * read-only in Rust for exactly this reason. A reader who never shares never
 * needs an identity, and a panel that minted one on open would quietly delete
 * the laziness the whole custody design rests on — *"a phrase shown before
 * there is any context is a phrase that gets clicked through."* The one path
 * that mints is a button a reader pressed.
 */

export interface CirclePaneProps {
  /**
   * `null` on a composition with no `peer` — the browser client.
   *
   * ⚠️ **NO PLUGIN IS NO CIRCLE, WHICH IS A STATE AND NOT AN ERROR.** A panel
   * that threw here would take the whole side pane down on the one platform
   * that legitimately cannot have this feature.
   */
  readonly port: PersonPort | null
  /**
   * The circle's own port — the per-person shelf switch (WI-23.C2), the
   * Friends view (WI-23.C4) and the purge (WI-23.C3). Absent or `null`
   * before the capability has started, which draws the people and none of
   * the three.
   */
  readonly circle?: CirclePort | null
  /** The reader's own lists — WI-23.E1. Absent or `null` before start, which draws none. */
  readonly lists?: ListsPort | null
  /** How this screen opens one of the reader's own books — see `PaneContext.openBook`. */
  readonly openBook?: (bookId: string) => void
}

/** A person id is a 64-hex public key; nobody reads one, so nobody sees one. */
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`

export function CirclePane({ port, circle = null, lists = null, openBook }: CirclePaneProps) {
  const [status, setStatus] = useState<PersonStatus | null>(null)
  const [people, setPeople] = useState<readonly KnownPerson[]>([])
  const [phrase, setPhrase] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /* The add-somebody flow, as three states it can be in at once from two
     directions: I offered (`offer`), I joined theirs (`sas`), or somebody is
     asking to join mine (`pending`). */
  const [offer, setOffer] = useState<PairOffer | null>(null)
  /* The moment the offer is judged against — advanced by a timer at the
     offer's expiry, so a link that has run out stops being shown without the
     reader having to touch anything. `Date.now()` in the render would only
     be read again on some other change. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (offer === null) return
    const left = offer.expiresAt - Date.now()
    // Stryker disable all: the render compares `expiresAt` with `now` itself, so an offer already run out is never drawn whatever this arms; the branch and the cleanup only spare a timer.
    if (left <= 0) {
      setNow(Date.now())
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), left + 1)
    return () => clearTimeout(timer)
    // Stryker restore all
  }, [offer])
  const [sas, setSas] = useState<string | null>(null)
  const [pending, setPending] = useState<PairingPending | null>(null)
  const [link, setLink] = useState('')
  /**
   * Why the last pairing attempt did not finish.
   *
   * ⚠️ **NOT `failure`, WHICH IS A DIFFERENT KIND OF TROUBLE.** `failure` means
   * "I could not read your circle" and replaces the whole panel; a refused
   * pairing is a thing that happened WITHIN a working panel. Putting the two in
   * one slot did not merely read oddly — the refresh that follows a result
   * succeeds and clears `failure`, so the message was wiped a moment after it
   * was set and the reader saw nothing at all.
   */
  const [trouble, setTrouble] = useState<string | null>(null)
  /**
   * Which read is the newest — the same revision `useOverlays` keeps.
   *
   * ⚠️ **AN OLDER ANSWER COULD OVERWRITE A NEWER ONE.** A refresh started by a
   * pairing result would publish the new person, and a slow initial refresh
   * then landed and put the empty roster back — along with a status computed
   * for a circle of zero. Every read commits only if it is still the latest.
   */
  const read = useRef(0)
  /** Cleared on unmount, so nothing sets state into a gone component. */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (port === null) return
    const mine = ++read.current
    try {
      /* BOTH read before either is published: the status carries the circle's
         SIZE, so publishing the list first left a status that disagreed with
         the list beside it for as long as the second call took. */
      const met = await port.people()
      /* ⚠️ **THE ROSTER'S SIZE, FROM THE ROSTER — WI-23.A3.** This was a prop
         the capability filled with a hardcoded 1, so the at-risk marker stood
         on every device a reader owned however many they had paired. Read
         here, beside the people, so the three facts the status is computed
         from are read together. */
      const devices = await port.devices()
      const now = await port.status(devices, met.length)
      if (!live.current || read.current !== mine) return
      setPeople(met)
      setStatus(now)
      setFailure(null)
    } catch (cause) {
      if (!live.current || read.current !== mine) return
      /* ⚠️ SHOWN, NOT SWALLOWED. A panel that fails to read the identity and
         renders the empty state is telling the reader they have no circle,
         which is a different and much worse claim than "I could not look". */
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
  }, [port])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /* ⚠️ **THE INCOMING SIDE IS NOT OPTIONAL.** Adding somebody takes two
     people: one offers and one joins, and whichever of them is looking at this
     panel has to be able to answer. A flow that only offered would work in
     exactly half of every pairing. */
  useEffect(() => {
    if (port === null) return undefined
    const offPending = port.onPending(setPending)
    const offResult = port.onResult((result) => {
      /* ⚠️ **THE VERDICT WAS IGNORED.** This cleared every flow state and
       * refreshed whatever `ok` said, so a refusal, a bad MAC or a timeout
       * looked exactly like success: the six digits vanished and "Nobody yet"
       * came back. The reader was told a pairing had finished when it had
       * failed, and the only way to find out was that nobody appeared. */
      setPending(null)
      setSas(null)
      setOffer(null)
      setTrouble(
        result.ok
          ? null
          : result.reason === undefined
            ? 'That pairing did not complete.'
            : `That pairing did not complete (${result.reason}).`,
      )
      void refresh()
    })
    return () => {
      offPending()
      offResult()
    }
  }, [port, refresh])

  /* ⚠️ CLEARED WHENEVER ANYTHING CHANGES. The words are on screen only for as
     long as the reader is looking at the thing they asked about; leaving them
     up across a refresh is how a phrase ends up in a screen recording of
     something else. */
  useEffect(() => {
    setPhrase(null)
    /* ⚠️ **AND THE PENDING READ IS INVALIDATED WITH IT.** Clearing the state
     * did nothing to a `port.phrase()` already in flight: press Show, change
     * identity through restore or forget, and the old promise resolved
     * afterwards and put the PREVIOUS person's twelve words on screen beneath
     * the new one's id. */
    asked.current += 1
  }, [status?.personId])

  /** Which phrase request is the newest — see the effect above. */
  const asked = useRef(0)

  /**
   * Run one action with the pane busy, then refresh.
   *
   * A failure goes to `onError` when the caller has somewhere of its own to
   * put it — a row's trouble line — and otherwise replaces the pane. A row's
   * `.catch` after this never ran, because everything was caught here first,
   * so a shelf switch that would not write took the whole roster down.
   */
  const act = async (what: () => Promise<unknown>, onError?: (message: string) => void): Promise<boolean> => {
    setBusy(true)
    try {
      await what()
      await refresh()
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (onError) onError(message)
      else setFailure(message)
      return false
    } finally {
      setBusy(false)
    }
  }

  if (port === null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>
          A circle needs Paper's own app on this device.
        </p>
      </div>
    )
  }

  if (failure !== null) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Paper could not read your circle. {failure}</p>
        <div className={CAPABILITY_UI.actions}>
          <button type="button" className={CAPABILITY_UI.button} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (status === null) return <div className={CAPABILITY_UI.section} />

  if (!status.hasIdentity) {
    return (
      <div className={CAPABILITY_UI.section}>
        {/* ⚠️ NOT A WARNING. A reader who has never shared is in the ordinary
            state, and telling them something is missing would be false. */}
        <p className={CAPABILITY_UI.hint}>
          A circle lets a few people you know see the passages you mark, and you
          theirs. Nothing is shared until you add somebody.
        </p>
        <div className={CAPABILITY_UI.actions}>
          <button
            type="button"
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
            disabled={busy}
            onClick={() => void act(() => port.ensure())}
          >
            Start a circle
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={CAPABILITY_UI.section}>
        <div className={CAPABILITY_UI.row}>
          <span className={CAPABILITY_UI.grow}>You</span>
          <span className={CAPABILITY_UI.code}>{short(status.personId ?? '')}</span>
        </div>
        <div className={CAPABILITY_UI.row}>
          <span className={CAPABILITY_UI.grow}>This device</span>
          <span className={CAPABILITY_UI.value}>
            {status.role === 'home' ? 'holds your keys' : 'a signed-in device'}
          </span>
        </div>

        {status.atRisk ? (
          <p className={CAPABILITY_UI.hint}>
            Your circle lives on this device alone. If it is lost, you would have
            to meet everyone again. Write down the twelve words below, or add a
            second device.
          </p>
        ) : null}

        {status.canShowPhrase ? (
          <>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => {
                  if (phrase !== null) {
                    setPhrase(null)
                    return
                  }
                  const mine = ++asked.current
                  void port
                    .phrase()
                    .then((words) => {
                      if (live.current && asked.current === mine) setPhrase(words)
                    })
                    .catch((cause: unknown) => {
                      /* ⚠️ **SAID, NOT SWALLOWED.** A failed keychain read
                       * rendered as "still hidden" tells the reader the button
                       * does nothing, which is the one thing that is not true. */
                      if (live.current && asked.current === mine) {
                        setFailure(cause instanceof Error ? cause.message : String(cause))
                      }
                    })
                }}
              >
                {phrase === null ? 'Show my twelve words' : 'Hide'}
              </button>
            </div>
            {phrase === null ? null : (
              <>
                <p className={CAPABILITY_UI.code}>{phrase}</p>
                <p className={CAPABILITY_UI.hint}>
                  These twelve words are your circle. Anyone who has them is you.
                  Write them on paper; a photograph is not a safe place.
                </p>
              </>
            )}
          </>
        ) : null}
      </div>

      {/* ── adding somebody ────────────────────────────────────────────
          ⚠️ **THE PANEL USED TO SAY "nothing is shared until you add
          somebody" AND OFFER NO WAY TO ADD ANYBODY.** Text that names an
          action the UI cannot perform is worse than no text: it tells the
          reader they have missed a control that does not exist.

          A person is added by PAIRING, not by typing an id. `circle::admit`
          refuses a person this reader has never met, so a hand-entered id
          would be a row that never admits anything. The six digits two humans
          compare are what make a person real — which is why this is the
          pairing flow. */}
      <div className={CAPABILITY_UI.section}>
        {pending !== null ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              “{pending.name}” would like to join your circle. Check that they
              are reading the same six digits, then let them in.
            </p>
            <p className={CAPABILITY_UI.code}>{pending.sas}</p>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
                disabled={busy}
                onClick={() => void act(() => port.confirm(true, pending.attemptId))}
              >
                The digits match
              </button>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => void act(() => port.confirm(false, pending.attemptId))}
              >
                Refuse
              </button>
            </div>
          </>
        ) : sas !== null ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              Read these six digits to your friend. They see the same ones, and
              let you in.
            </p>
            <p className={CAPABILITY_UI.code}>{sas}</p>
          </>
        ) : offer !== null && offer.expiresAt > now ? (
          <>
            <p className={CAPABILITY_UI.hint}>
              Send this link to the person you want to add. It is good for a few
              minutes.
            </p>
            {/* ⚠️ **THE LINK CARRIES THE PAIRING SECRET.** It is shown because
                the reader has to send it, and it is never logged — the
                diagnostics port redacts `url` keys for exactly this value. */}
            <p className={CAPABILITY_UI.code}>{offer.url}</p>
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                onClick={() => void act(async () => {
                  await port.cancel()
                  setOffer(null)
                })}
              >
                Stop offering
              </button>
            </div>
          </>
        ) : (
          <>
            {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
            <div className={CAPABILITY_UI.actions}>
              <button
                type="button"
                className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setTrouble(null)
                    const made = await port.offer()
                    /* ⚠️ **THE WHOLE OFFER, NOT JUST THE LINK.** `expiresAt`
                     * was thrown away, so a dead link went on being presented
                     * as usable: sending it produced an `expired` refusal, and
                     * the reader could not make another without first stopping
                     * the one that had already lapsed. */
                    setOffer(made)
                  })
                }
              >
                Add somebody
              </button>
            </div>
            <div className={CAPABILITY_UI.row}>
              <input
                className={`${CAPABILITY_UI.field} ${CAPABILITY_UI.grow}`}
                placeholder="…or paste a friend's link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy || link.trim() === ''}
                onClick={() =>
                  void act(async () => {
                    const started = await port.join(link.trim())
                    setLink('')
                    setSas(started.sas)
                  })
                }
              >
                Join
              </button>
            </div>
          </>
        )}
      </div>

      <div className={CAPABILITY_UI.section}>
        {people.length === 0 ? (
          <p className={CAPABILITY_UI.hint}>Nobody yet.</p>
        ) : (
          people.map((one) => (
            <PersonRow
              key={one.person}
              person={one}
              circle={circle}
              busy={busy}
              act={act}
              onRemove={() => void act(() => (circle ? circle.forget(one.person) : port.forgetPerson(one.person)))}
              {...(openBook ? { openBook } : {})}
            />
          ))
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

      {lists === null ? null : <OwnLists lists={lists} busy={busy} act={act} {...(openBook ? { openBook } : {})} />}
    </>
  )
}

/**
 * The reader's own lists — WI-23.E1: title, order, notes, and the end of a
 * list. Which books are on one is decided beside the book (`BookPane`).
 *
 * ⚠️ **DELETING IS FOR GOOD, AND THE COPY SAYS SO.** A `delete` is a tombstone
 * on the log; a list that comes back is a new list under a new id, and a
 * friend who held the old one keeps nothing of it.
 */
function OwnLists({
  lists,
  busy,
  act,
  openBook,
}: {
  readonly lists: ListsPort
  readonly busy: boolean
  readonly act: (what: () => Promise<void>, onError?: (message: string) => void) => Promise<boolean>
  readonly openBook?: (bookId: string) => void
}) {
  const [own, setOwn] = useState<readonly OwnListView[] | null>(null)
  /* A read that failed is said, and the last lists read stay. */
  const [trouble, setTrouble] = useState<string | null>(null)
  const read = useRef(0)
  const refresh = useCallback(async () => {
    /* Stryker disable next-line UpdateOperator: counting down tells reads apart as well as counting up. */
    const mine = ++read.current
    try {
      const held = await lists.lists()
      if (read.current !== mine) return
      setOwn(held)
      setTrouble(null)
    } catch (cause) {
      if (read.current !== mine) return
      setOwn((was) => was ?? [])
      setTrouble(cause instanceof Error ? cause.message : String(cause))
    }
  }, [lists])
  useEffect(() => {
    void refresh()
    return lists.subscribe(() => void refresh())
  }, [lists, refresh])
  if (own === null) return null
  return (
    <div className={CAPABILITY_UI.section} data-own-lists="">
      <p className={CAPABILITY_UI.hint}>Your lists</p>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read your lists. {trouble}</p>}
      {own.length === 0 && trouble === null ? <p className={CAPABILITY_UI.hint}>No lists yet. Start one beside a book, or here.</p> : null}
      {own.map((list) => (
        <OwnListRow key={list.id} list={list} lists={lists} busy={busy} act={act} {...(openBook ? { openBook } : {})} />
      ))}
      <NewListForm
        busy={busy}
        placeholder="A new list"
        onStart={(title) =>
          act(async () => {
            await lists.create(title)
          })
        }
      />
      <p className={CAPABILITY_UI.hint}>A list is shown to the people you show your shelf to. Deleting one is for good.</p>
    </div>
  )
}

function OwnListRow({
  list,
  lists,
  busy,
  act,
  openBook,
}: {
  readonly list: OwnListView
  readonly lists: ListsPort
  readonly busy: boolean
  readonly act: (what: () => Promise<void>, onError?: (message: string) => void) => Promise<boolean>
  readonly openBook?: (bookId: string) => void
}) {
  const [title, setTitle] = useState<string | null>(null)
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({})
  const shown = title ?? list.title
  return (
    <div className={CAPABILITY_UI.section} data-own-list={list.id}>
      <div className={CAPABILITY_UI.row}>
        <input
          type="text"
          className={CAPABILITY_UI.field}
          aria-label={`Title of ${list.title}`}
          value={shown}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
        />
        {title !== null && title.trim() !== '' && title.trim() !== list.title ? (
          <button
            type="button"
            className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await lists.retitle(list.id, title.trim())
                setTitle(null)
              })
            }
          >
            Rename
          </button>
        ) : null}
        <button type="button" className={CAPABILITY_UI.button} disabled={busy} aria-label={`Delete ${list.title}`} onClick={() => void act(() => lists.delete(list.id))}>
          Delete
        </button>
      </div>
      {list.items.length === 0 ? <p className={CAPABILITY_UI.hint}>Nothing on it yet.</p> : null}
      {list.items.map((item) => {
        const note = notes[item.pub] ?? item.note
        /* A book no longer on the shelf cannot be re-placed, so its note is
           read-only — and a note that cannot change cannot differ. */
        const editable = item.bookId !== null
        // Stryker disable next-line ConditionalExpression,LogicalOperator: the field is disabled when not editable, so a changed note is always an editable one.
        const canKeep = editable && notes[item.pub] !== undefined && notes[item.pub] !== item.note
        return (
          <div className={CAPABILITY_UI.row} key={item.pub} data-list-item={item.pub}>
            <span className={CAPABILITY_UI.grow}>
              {item.title}
              {item.author ? ` — ${item.author}` : ''}
            </span>
            <input
              type="text"
              className={CAPABILITY_UI.field}
              aria-label={`Note on ${item.title}`}
              placeholder="A note"
              value={note}
              disabled={busy || !editable}
              onChange={(e) => setNotes({ ...notes, [item.pub]: e.target.value })}
            />
            {canKeep ? (
              <button
                type="button"
                className={CAPABILITY_UI.button}
                disabled={busy}
                aria-label={`Keep note on ${item.title}`}
                onClick={() =>
                  void act(async () => {
                    await lists.place(list.id, item.bookId!, notes[item.pub])
                    setNotes(({ [item.pub]: _kept, ...rest }) => rest)
                  })
                }
              >
                Keep note
              </button>
            ) : null}
            {editable && openBook ? (
              <button type="button" className={CAPABILITY_UI.button} onClick={() => openBook(item.bookId!)} aria-label={`Open your copy of ${item.title}`}>
                Open
              </button>
            ) : null}
            <button type="button" className={CAPABILITY_UI.button} disabled={busy} aria-label={`Take ${item.title} off ${list.title}`} onClick={() => void act(() => lists.takeOff(list.id, item.pub))}>
              Take off
            </button>
          </div>
        )
      })}
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
  circle,
  busy,
  act,
  onRemove,
  openBook,
}: {
  readonly person: KnownPerson
  readonly circle: CirclePort | null
  readonly busy: boolean
  /** The screen's one act at a time — the switch goes through it too. */
  readonly act: (what: () => Promise<unknown>, onError?: (message: string) => void) => Promise<boolean>
  readonly onRemove: () => void
  readonly openBook?: (bookId: string) => void
}) {
  const [shows, setShows] = useState<boolean | null>(null)
  /* Stryker disable next-line all: the switch is read through the circle's port, so it is known only when there is one. */
  const switchReady = circle !== null && shows !== null
  const [friend, setFriend] = useState<FriendView | null>(null)
  const [open, setOpen] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const read = useRef(0)

  const refresh = useCallback(async () => {
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
      setTrouble(null)
    } catch (cause) {
      if (read.current !== mine) return
      setTrouble(cause instanceof Error ? cause.message : String(cause))
    }
  }, [circle, person.person, open])

  useEffect(() => {
    void refresh()
    return circle?.subscribe(() => void refresh())
  }, [circle, refresh])

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
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>Paper could not read what {person.displayName} shared. {trouble}</p>}
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
                /* Through `act`, so the row is busy until the write lands and
                   two quick flips cannot resolve out of order. */
                const on = e.target.checked
                void act(() => circle.setShowsShelf(person.person, on), setTrouble)
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
 * A friend's shelf and what they did lately — the Friends view, WI-23.C4.
 *
 * A book the reader also has LINKS to their own copy; one they do not have
 * links nowhere, and says nothing more than its title and author. Named
 * people, no numbers: this is the surface that feels like Douban, and it is
 * the whole reason the shelf exists.
 */
/**
 * A friend's jacket beside their row — WI-23.C5. Asked for when the row is
 * drawn, never in the round; nothing drawn until it has been fetched and
 * verified, and nothing said when it cannot be.
 */
function Jacket({ port, person, book }: { readonly port: CirclePort; readonly person: string; readonly book: FriendBook }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setUrl(null)
    if (book.cover === null || book.device === null) return
    void port.cover(person, book).then(
      (found) => {
        if (live) setUrl(found)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [port, person, book])
  return url === null ? null : <img src={url} alt="" width={24} height={36} data-jacket={book.pub} />
}

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
