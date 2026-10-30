import type { BookPatch, BookRecord, Hlc, ReadingState, Stars } from '../../../kernel'
import { opinionOf, republish, type Opinion } from './opinion'
import type { SharedFile } from './publish'
import { tellEach } from './listeners'

/**
 * The book pane's port — WI-23.B4: the reader's own opinion, and the switch
 * that publishes it.
 *
 * Two things live here and they are deliberately two:
 *
 *  1. **The reader's own copy**, on the record, written through the library
 *     (`patch`) and replicated by the ordinary sync — WI-23.B3.
 *  2. **The publish switch**, per book, on the publisher's store — and the
 *     driver that, while it is on, republishes the opinion as it changes.
 *
 * `reading.md` §"The one principle": a reader's opinion is their own data
 * first, and publishing it is a separate act. Nothing in (1) reaches the
 * circle; nothing in (2) touches the record.
 *
 * ## Which books are watched
 *
 * The switch is on the store, one file per book, and reading every file on
 * every library change would be a read per book per page turn. So the switch
 * is CACHED per book once read, `warm` reads them all once at start, and the
 * driver diffs only the books whose cached switch is on — against the opinion
 * it last published, so an unchanged opinion costs no read at all.
 *
 * PURE over its deps. The pane and the capability's `start` are the callers.
 */

/** A book's own opinion, as the pane draws it. */
export interface OwnOpinion {
  readonly title: string
  readonly status: ReadingState | null
  readonly stars: Stars | null
  /** `''` when there is none. */
  readonly review: string
  readonly tags: readonly string[]
}

export interface BookPort {
  /** The book's own opinion, or `null` for a book not on the shelf. */
  own(bookId: string): Promise<OwnOpinion | null>
  setStatus(bookId: string, state: ReadingState): Promise<void>
  setStars(bookId: string, stars: Stars): Promise<void>
  setReview(bookId: string, text: string): Promise<void>
  /** Whether the book's opinion is published as it changes. */
  publishing(bookId: string): Promise<boolean>
  /**
   * Turn the switch. On publishes the current opinion at once and every
   * change after; off publishes nothing more and withdraws nothing.
   */
  setPublishing(bookId: string, on: boolean): Promise<void>
  /** Told after a switch moves or an opinion is published. */
  subscribe(listener: () => void): () => void
}

/** The record as the port needs it — the library's row, narrowed. */
export type BookRow = Pick<BookRecord, 'status' | 'rating' | 'tags' | 'review' | 'title'> & {
  readonly bookId: string
}

export interface OpinionDeps {
  readonly books: () => readonly BookRow[]
  /** The library's own change feed — `Library.subscribe`. */
  readonly changes: (listener: () => void) => () => void
  readonly patch: (bookId: string, fields: BookPatch) => Promise<void>
  readonly shared: (bookId: string) => Promise<SharedFile>
  /** Change the store as one step on the book's lane — `updateShared`; see `SharingDeps.update`. */
  readonly update: (bookId: string, transform: (held: SharedFile) => SharedFile) => Promise<SharedFile>
  /** Told when a pass the library set off could not finish; optional. */
  readonly failed?: (cause: unknown) => void
  /** This device's id when it has a person identity, else null — nothing publishes without one. */
  readonly device: () => Promise<string | null>
  readonly clock: () => Hlc
  readonly mintPub: () => string
}

export interface OpinionDriver extends BookPort {
  /** Read every book's switch once, so a relaunch watches what it watched. */
  warm(): Promise<void>
  /** Publish what changed for every watched book. Idempotent. */
  republishAll(): Promise<void>
  dispose(): void
}

export function opinionPortOver(deps: OpinionDeps): OpinionDriver {
  /** The switch per book, once read. Absent means not yet read. */
  const switches = new Map<string, boolean>()
  /** What was last published per watched book, so an unchanged opinion costs nothing. */
  const published = new Map<string, Opinion>()
  const listeners = new Set<() => void>()
  const changed = (): void => tellEach(listeners, 'opinion')
  /* ONE republish at a time: the library fires on every page turn, and two
     overlapping passes would race on one book's file. A change during a
     pass is answered by running once more. */
  /**
   * ONE QUEUE FOR EVERY WRITE THE PORT MAKES — a pass, a switch, a warm.
   *
   * A boolean coalescer let a caller's promise resolve when a pass somebody
   * else had started merely NOTICED its change, and let a switch turned off
   * race the publication in flight. On one queue a caller's promise is its
   * own work finished, and a switch waits its turn behind the pass before it.
   */
  let chain: Promise<unknown> = Promise.resolve()
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const turn = chain.then(task, task)
    chain = turn.catch(() => {})
    return turn
  }
  /* Told to stop: nothing queued after this runs, and a pass under way
     publishes no further book. */
  let disposed = false

  const rowOf = (bookId: string, rows: ReadonlyMap<string, BookRow>): BookRow | undefined => rows.get(bookId)

  /* One read in flight per book: two concurrent asks used to read the store
     twice, and the later answer could overwrite a switch `setPublishing` had
     moved meanwhile. The read remembers its answer only if nothing has. */
  const reading = new Map<string, Promise<boolean>>()
  const switchOf = (bookId: string): Promise<boolean> => {
    const known = switches.get(bookId)
    if (known !== undefined) return Promise.resolve(known)
    const inFlight = reading.get(bookId)
    if (inFlight !== undefined) return inFlight
    /* Stryker disable ArrowFunction: bookkeeping — a finished read is never consulted again, `switches` answers first. */
    const read = deps
      .shared(bookId)
      .then((held) => {
        const decided = switches.get(bookId)
        if (decided !== undefined) return decided
        switches.set(bookId, held.publishOpinion)
        return held.publishOpinion
      })
      .finally(() => reading.delete(bookId))
    /* Stryker restore ArrowFunction */
    reading.set(bookId, read)
    return read
  }

  /** Publish one book's current opinion, if anything changed. */
  const publishOne = async (bookId: string, device: string, rows: ReadonlyMap<string, BookRow>): Promise<void> => {
    if (disposed) return
    const row = rowOf(bookId, rows)
    if (row === undefined) return
    const now = opinionOf(row)
    const last = published.get(bookId)
    if (last !== undefined && sameOpinion(last, now)) return
    const at = deps.clock()
    await deps.update(bookId, (held) => republish(held, now, device, at, deps.mintPub))
    published.set(bookId, now)
  }

  /* A pass asked for while one is still waiting its turn joins it: the
     waiting pass reads the store when it runs, so it carries the change.
     A pass asked for while one is RUNNING is queued behind it. */
  let waiting: Promise<void> | null = null
  const pass = async (): Promise<void> => {
    waiting = null
    if (disposed) return
    const device = await deps.device()
    /* No identity is nothing to publish AS — the switch stays as it was
       and the opinion is published the moment there is one. */
    if (device === null) return
    /* One shelf snapshot for the pass, and EVERY watched book gets its turn:
       a book whose file will not write used to end the pass, and every book
       after it went unpublished for as long as the first stayed broken. */
    const rows = new Map(deps.books().map((one) => [one.bookId, one]))
    const failures: unknown[] = []
    for (const [bookId, on] of switches) {
      if (!on) continue
      try {
        await publishOne(bookId, device, rows)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} book(s) could not be published`)
  }
  const republishAll = (): Promise<void> => {
    if (waiting !== null) return waiting
    const turn = serially(pass)
    waiting = turn
    return turn
  }

  const off = deps.changes(() => {
    /* A pass that cannot finish is reported, never dropped on the floor as
       an unhandled rejection — and the listeners are still told, because the
       store may have moved before the failure. */
    void republishAll()
      .catch((cause: unknown) => {
        try {
          deps.failed?.(cause)
        } catch (thrown) {
          console.error('Paper: the opinion driver could not report a failed pass', thrown)
        }
      })
      .then(changed)
  })

  return {
    own: async (bookId) => {
      const row = deps.books().find((one) => one.bookId === bookId)
      if (row === undefined) return null
      return {
        title: row.title,
        status: row.status?.state ?? null,
        stars: row.rating ?? null,
        review: row.review?.text ?? '',
        tags: [...(row.tags ?? [])],
      }
    },
    setStatus: (bookId, state) => deps.patch(bookId, { status: state }),
    setStars: (bookId, stars) => deps.patch(bookId, { rating: stars }),
    setReview: (bookId, text) => deps.patch(bookId, { review: text }),
    publishing: switchOf,
    setPublishing: async (bookId, on) => {
      /* On the queue, so a switch turned off waits for the pass in flight
         rather than racing the entry it is about to write — and a switch
         asked for after dispose writes nothing at all. */
      await serially(async () => {
        if (disposed) return
        await deps.update(bookId, (held) => (held.publishOpinion === on ? held : { ...held, publishOpinion: on }))
        switches.set(bookId, on)
        /* Forgotten, so the next pass publishes the whole current opinion
           rather than trusting what an earlier switch-on had recorded. */
        // Stryker disable next-line ConditionalExpression: forgetting on the way OFF changes nothing a reader can see — a switched-off book is never compared against what it last published, and turning it on forgets again.
        if (on) published.delete(bookId)
      })
      /* Told NOW: the switch has moved whatever the publication that follows
         does, and a subscriber left with the old switch while a pass failed
         drew a control that lied. */
      changed()
      if (on) await republishAll()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    warm: async () => {
      /* `switchOf` reads the store once per book and remembers — EVERY book,
         a file that will not read costing only its own switch, which is
         reported once the rest are warm. */
      const failures = await serially(async () => {
        const failed: unknown[] = []
        for (const book of deps.books()) {
          try {
            await switchOf(book.bookId)
          } catch (cause) {
            failed.push(cause)
          }
        }
        return failed
      })
      /* The switches that DID warm are followed first: a file that will not
         read costs its own book its publication, not every other book theirs. */
      await republishAll()
      if (failures.length > 0) throw new AggregateError(failures, `${failures.length} book(s) could not be warmed`)
    },
    republishAll,
    dispose: () => {
      disposed = true
      off()
      listeners.clear()
    },
  }
}

const sameOpinion = (a: Opinion, b: Opinion): boolean =>
  a.status === b.status &&
  a.stars === b.stars &&
  a.review === b.review &&
  a.tags.length === b.tags.length &&
  a.tags.every((one, i) => one === b.tags[i])
