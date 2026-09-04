import { acceptsTransport, changeState, FIRST_EPOCH, drawsEntry, showShelf, type Hlc, type ReadingState, type Relationship } from '../../../kernel'
import { claimOfShelved, viewOf, EMPTY_VIEW, type CircleView } from './circleView'
import { bookVia, indexOf, type BookLike } from './exchange'
import type { ForeignFile } from './store'
import { base64Of } from './base64'
import { imageTypeOf } from './covers'
import { createListeners, createTurns } from './listeners'

/**
 * What the Circle screen asks of this capability beyond the peer — WI-23.C2
 * (the per-person shelf switch), WI-23.C3 (the purge), WI-23.C4 (the Friends
 * view).
 *
 * PURE over its deps, like `sharing.ts` and `opinionPort.ts`: the screen is
 * the hardest thing to reach from a test, so the deciding is here.
 *
 * ## Which books link, and which do not
 *
 * ⚠️ **A LINK IS `bookVia` OVER THE CLAIM, AND NOTHING ELSE.** A friend's
 * shelf names works in clear; the reader's own copy of one is found the way
 * the transport finds the book a page is about — the claim's digests,
 * intersected — so the books that link are exactly the books the two shelves
 * hold in common, by the same rule that would merge their passages. The
 * falsifier counts them: equal to the intersection, exactly. A title that
 * merely looks alike does not link, and a book the reader does not have links
 * nowhere.
 */

/** A book on a friend's shelf, and the reader's own copy of it if any. */
export interface FriendBook {
  readonly pub: string
  readonly title: string
  readonly author: string
  readonly language: string
  /** The reader's own copy, by id — or null: they do not have it. */
  readonly own: string | null
  /** The device that published the entry — the one to ask for its jacket (WI-23.C5) — or null on a row kept before devices were stamped. */
  readonly device: string | null
  /** The jacket's digest, when the entry carries one. */
  readonly cover: string | null
}

/** One thing a friend did lately, on a book the reader has. */
export interface FriendActivity {
  readonly kind: 'status' | 'rate' | 'review'
  readonly bookId: string
  readonly title: string
  /** The status word, the star count as text, or the review's opening words. */
  readonly value: string
  readonly at: Hlc
}

/** One item on a friend's list, and the reader's own copy of it if any. */
export interface FriendListItem {
  readonly pub: string
  readonly title: string
  readonly author: string
  readonly note: string
  readonly own: string | null
}

/** A friend's list — WI-23.E1 — as held, folded, by title. */
export interface FriendList {
  readonly id: string
  readonly title: string
  readonly items: readonly FriendListItem[]
}

export interface FriendView {
  readonly shelf: readonly FriendBook[]
  /** Newest first. Only for books the reader also has: that is where a per-book file can be. */
  readonly recent: readonly FriendActivity[]
  /** The lists they publish, by title — created and not deleted. */
  readonly lists: readonly FriendList[]
}

export interface CirclePort {
  /** Whether this person is shown the reader's shelf. */
  showsShelf(person: string): Promise<boolean>
  setShowsShelf(person: string, on: boolean): Promise<void>
  friend(person: string): Promise<FriendView>
  /**
   * A friend's jacket as a data URL — fetched lazily from the device that
   * published the row, verified, and kept — or null (WI-23.C5). A few at a
   * time, in the order asked; a request whose `signal` is aborted before its
   * turn is answered null without a dial.
   */
  cover(person: string, book: FriendBook, signal?: AbortSignal): Promise<string | null>
  /** The circle's view of a book the reader has — WI-23.D1, D2, D3. Empty for a book they do not. */
  book(bookId: string): Promise<CircleView>
  /** Remove a person: their files purged here, then the peer told to forget them. */
  forget(person: string): Promise<void>
  /** Told after a switch moves, and whenever the store changes under a fetch. */
  subscribe(listener: () => void): () => void
}

export interface CirclePortDeps {
  readonly clock: () => Hlc
  readonly books: () => readonly (BookLike & { readonly title?: string })[]
  /** Everyone the peer still names, with the roster's signed display name. */
  readonly people: () => Promise<readonly { readonly person: string; readonly displayName: string }[]>
  readonly relationship: (person: string) => Promise<Relationship>
  readonly writeRelationship: (record: Relationship) => Promise<Relationship>
  readonly heldShelf: (person: string) => Promise<ForeignFile>
  readonly heldOf: (bookId: string, person: string) => Promise<ForeignFile>
  /** The person's lists as held, by id — WI-23.E1. */
  readonly heldLists: (person: string) => Promise<ReadonlyMap<string, ForeignFile>>
  /** The jacket a shelf entry named, by the device that published it — `covers.ts`. */
  /** The jacket's bytes, or null — the signal reaches the transfer; see `CoverFetcher.ensure`. */
  readonly coverOf: (person: string, device: string, pub: string, digest: string, signal?: AbortSignal) => Promise<Uint8Array | null>
  /** Purge everything held about a person, across the given books. */
  readonly purge: (person: string, books: readonly string[]) => Promise<void>
  readonly forgetPeer: (person: string) => Promise<void>
  /** The store's own change signal — `circleChanged`. */
  readonly onChanged: (listener: () => void) => () => void
  /** The run's diagnostics, for a failure the surface is right not to show. */
  readonly warn: (event: string, detail: Record<string, unknown>) => void
}

/** How many jackets are fetched at once — a shelf of a thousand books must not open a thousand dials together. */
export const COVER_WIDTH = 4

/** How many recent things a friend did are shown. */
export const RECENT_LIMIT = 30

/** What a switch says for a person the peer no longer names. */
export const NOT_IN_CIRCLE = 'That person is not in your circle.'

const STATUS_WORDS: Readonly<Record<ReadingState, string>> = {
  want: 'wants to read',
  reading: 'is reading',
  finished: 'finished',
}

/** Whether an epoch-stamped row is drawn under the relationship — `drawsEntry`, with the unstamped read as the first epoch. */
type Admits = (epoch: number | undefined) => boolean

/** A friend's shelf, as the Friends view lists it: the rows the relationship draws, each linked to the reader's own copy if any. */
function shelfOf(held: ForeignFile, index: ReturnType<typeof indexOf>, admits: Admits): readonly FriendBook[] {
  return held.works
    .filter((one) => admits(one.epoch))
    .map((one) => ({
      pub: one.pub,
      title: one.work.title,
      author: one.work.author,
      language: one.work.language,
      own: bookVia(index, claimOfShelved(one.work))?.id ?? null,
      device: one.device ?? null,
      cover: one.work.cover ?? null,
    }))
}

/** What a friend did lately across the reader's books, newest first, at most `RECENT_LIMIT`. */
function recentOf(books: readonly (BookLike & { readonly title?: string })[], helds: readonly ForeignFile[], admits: Admits): readonly FriendActivity[] {
  const recent: FriendActivity[] = []
  for (const [i, book] of books.entries()) {
    const held = helds[i]!
    const title = book.title ?? ''
    if (held.opinion.status && admits(held.opinion.status.epoch)) {
      recent.push({ kind: 'status', bookId: book.id, title, value: STATUS_WORDS[held.opinion.status.value], at: held.opinion.status.at })
    }
    if (held.opinion.stars && admits(held.opinion.stars.epoch)) {
      recent.push({ kind: 'rate', bookId: book.id, title, value: `${held.opinion.stars.value} of 5`, at: held.opinion.stars.at })
    }
    for (const review of held.reviews) {
      if (!admits(review.epoch)) continue
      recent.push({ kind: 'review', bookId: book.id, title, value: review.text, at: review.at })
    }
  }
  /* Newest first: a stamp is fixed-width hex, so the strings order as the stamps do. */
  recent.sort((a, b) => b.at.localeCompare(a.at))
  return recent.slice(0, RECENT_LIMIT)
}

/**
 * A friend's lists, by title — created, not deleted, AND under the
 * relationship, PART BY PART: a list whose creation arrived under an earlier
 * epoch is not drawn on re-admission, nor a title that did, nor an item
 * placed under one — whatever arrived later. The shelf's rule, applied to
 * the one kind of content that had escaped it, and to each of its parts:
 * one epoch for the whole list let a `place` under the new relationship
 * re-expose everything the old one had retained. A deletion counts whatever
 * its epoch — a withdrawal is never revived by a re-admission.
 */
function listsOf(files: ReadonlyMap<string, ForeignFile>, index: ReturnType<typeof indexOf>, admits: Admits): readonly FriendList[] {
  const lists: FriendList[] = []
  for (const [id, file] of files) {
    if (!file.list.created || file.list.deleted || !admits(file.list.createdEpoch)) continue
    lists.push({
      id,
      title: file.list.title !== undefined && admits(file.list.title.epoch) ? file.list.title.value : '',
      items: file.list.items
        .filter((item) => admits(item.epoch))
        .map((item) => ({
          pub: item.pub,
          title: item.work.title,
          author: item.work.author,
          note: item.note,
          own: bookVia(index, claimOfShelved(item.work))?.id ?? null,
        })),
    })
  }
  return lists.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
}

export function circlePortOver(deps: CirclePortDeps): CirclePort & { dispose(): void; pendingTurns(): number } {
  const listeners = createListeners('circle')
  const changed = (): void => listeners.tell()
  const off = deps.onChanged(changed)

  /* The jackets, a few at a time: every row of a large shelf asked at once
     was hundreds of dials together, and a shelf hidden again left them all
     running. The rest wait their turn, and one abandoned before its turn is
     not dialled at all. */
  let fetching = 0
  const waiting: (() => void)[] = []
  const inSlot = async <T>(task: () => Promise<T>): Promise<T> => {
    if (fetching >= COVER_WIDTH) await new Promise<void>((go) => waiting.push(go))
    fetching += 1
    try {
      return await task()
    } finally {
      fetching -= 1
      waiting.shift()?.()
    }
  }

  /* One queue per person for the switch: a read-check-write that two quick
     flips could interleave, so the later flip returned early against the
     earlier one's stale read and the earlier value stood. `createTurns` lets
     each turn go once it has settled. */
  const turns = createTurns()
  const inTurn = turns.inTurn
  /** The most reads of a person's files in flight at once — a library of a thousand books must not open a thousand files together. */
  const READ_WIDTH = 8
  const pooled = async <T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> => {
    // Stryker disable next-line ArrayDeclaration: an array grows to any index written; the length is a hint.
    const out: R[] = new Array<R>(items.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const i = next++
        out[i] = await read(items[i]!)
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_WIDTH, items.length) }, worker))
    return out
  }

  return {
    /* The grant as it STANDS: a switch left on under a relationship that no
       longer carries anything discloses nothing, and must not read as on. */
    showsShelf: async (person) => {
      const held = await deps.relationship(person)
      return acceptsTransport(held.state) && held.shelf
    },
    setShowsShelf: (person, on) =>
      inTurn(person, async () => {
        /* Only for somebody the peer still names: a switch written after a
           forget — queued behind it on this same turn — would be a record
           written for a person who is gone, with a grant on it. */
        if (!(await deps.people()).some((one) => one.person === person)) throw new Error(NOT_IN_CIRCLE)
        const held = await deps.relationship(person)
        /* Told only when the switch MOVED, as the contract says. */
        if (held.shelf === on) return
        await deps.writeRelationship(showShelf(held, on, deps.clock()))
        changed()
      }),
    friend: async (person) => {
      const books = deps.books()
      const index = indexOf(books)
      /* Under the relationship record: a review retained from an earlier
         admission belongs to a relationship that ended, and `drawsEntry`
         is the one rule for that — the Friends view had skipped it. */
      const relationship = await deps.relationship(person)
      /* A row kept before epochs were stamped belongs to the FIRST epoch, not
         the current one: under a re-admission it stays hidden until the next
         round keeps it again, stamped — the answer that is safe to be wrong about. */
      const admits = (epoch: number | undefined): boolean => drawsEntry(relationship, epoch ?? FIRST_EPOCH)
      /* Three projections, each its own function, so an omission in one —
         the lists once went out under no relationship at all — reads as one. */
      const shelf = shelfOf(await deps.heldShelf(person), index, admits)
      /* Independent files, read together: one round trip per book, serially,
         was a Friends view that took longer for every book on the shelf. */
      const helds = await pooled(books, (book) => deps.heldOf(book.id, person))
      const recent = recentOf(books, helds, admits)
      const lists = listsOf(await deps.heldLists(person), index, admits)
      return { shelf, recent, lists }
    },
    cover: async (person, book, signal) => {
      if (book.cover === null || book.device === null) return null
      const { device, pub, cover } = book
      return inSlot(async () => {
        if (signal?.aborted) return null
        try {
          /* Nothing fetched, nor answered from disk, for a person the record no
             longer admits: a row drawn before a forget must not bring their
             jacket — and their folder — back behind the purge. */
          if (!acceptsTransport((await deps.relationship(person)).state)) return null
          const bytes = await deps.coverOf(person, device, pub, cover, signal)
          /* The type the BYTES say — a legacy jacket can be a PNG under any
             name — rather than a declared JPEG the browser would have to sniff
             past. */
          return bytes === null ? null : `data:${imageTypeOf(bytes)};base64,${base64Of(bytes)}`
        } catch (cause) {
          /* THE WHOLE OF IT, the record read included: the surface is right
             to draw nothing and say nothing, and a rejection from any step
             here was one the row's empty handler swallowed with no record
             anywhere. The diagnostics are where a failure that is not "not
             served" goes. */
          deps.warn('circle.cover-failed', { person, pub, message: cause instanceof Error ? cause.message : String(cause) })
          return null
        }
      })
    },
    book: async (bookId) => {
      const books = deps.books()
      const book = books.find((one) => one.id === bookId)
      if (book === undefined) return EMPTY_VIEW
      /* Three independent reads per person, and the people independent of
         each other: read together, not one round trip after another. */
      const people = await Promise.all(
        (await deps.people()).map(async (known) => {
          const [relationship, shelf, held] = await Promise.all([
            deps.relationship(known.person),
            deps.heldShelf(known.person),
            deps.heldOf(bookId, known.person),
          ])
          return { person: known.person, name: known.displayName, relationship, shelf, held }
        }),
      )
      return viewOf(book, books, people)
    },
    forget: (person) =>
      /* On the person's turn, so a switch flip queued behind it runs after
         the peer has forgotten them, and is refused as such. */
      inTurn(person, async () => {
        /* ⚠️ **THE RELATIONSHIP ENDS FIRST — written as exited, purge and all —
           so a fetch round already under way for this person stops writing:
           it re-reads the record before every keep, and a record that admits
           nobody ends its round with nothing written. Purging first removed
           the record, and its absence read as admitted. Then the files, so a
           person the peer has already forgotten cannot be left with their
           shelf on this disk if the last half fails; then the peer.

           ⚠️ **AND THE RECORD STAYS** — `purgePerson` leaves it — so a peer
           that would not forget them, or a keep queued behind the purge,
           finds a person who is exited and not the admitted default. Meeting
           them again is a pairing, and that is what re-admits them. */
        await deps.writeRelationship(changeState(await deps.relationship(person), 'exited', deps.clock()))
        /* The purge is what says so — `purgePerson` tells `onChanged` as its
           files go — so nothing is said twice here. */
        await deps.purge(person, deps.books().map((book) => book.id))
        await deps.forgetPeer(person)
      }),
    subscribe: listeners.subscribe,
    dispose: () => {
      off()
      listeners.clear()
    },
    /* For a test: how many people still hold a turn. */
    pendingTurns: () => turns.pending(),
  }
}
