import { isHlc, parseHlc } from '../../kernel'
import { isRetryable } from './content'
import type { ShelfChannel } from './channel'
import type { ShelfLink } from './reconnect'

/**
 * The reader's place, on the shelf (phase 20, WI-20.30, D7).
 *
 * ## What this closes
 *
 * `positions.ts` kept the browser's reading position in `localStorage` and
 * said plainly that it did not sync: the pump granted the browser reads and
 * nothing else. This is the other half — the position read from the shelf's
 * record when a book opens, and written back through `book.position`, the
 * one write a browser session is granted, under a grant that covers nothing
 * else and bound to the book the session opened.
 *
 * ## Newer wins, whichever device wrote it
 *
 * The shelf stamps every position write with an HLC (`positionAt`); the
 * device stamps its local copy with its own clock. `startingPlace` compares
 * the two wall-clock halves and starts from the newer. Two clocks on two
 * machines are not one clock, and the comparison is honest about that: a
 * tie goes to the device, whose copy is at least the one this reader saw.
 *
 * ## A write is a DEBOUNCE, not a call per page
 *
 * The desktop's recorder writes a position two seconds after the last turn,
 * not on every relocate, and this does the same: the latest position per
 * book, sent when the reader has settled, flushed when the book closes. A
 * write that fails because the link is down is kept and sent when the link
 * is back — `retryable` is the envelope's word for that — and one that fails
 * for a reason a retry cannot change is reported and dropped, so a refused
 * book does not queue for ever.
 *
 * PER BOOK, ALL OF IT. There is one of these per LINK, not per book — see
 * `main.web.tsx` — so the same instance serves whatever the reader opens
 * next, and every mechanism here is keyed on the book because of it. That was
 * true of `pending` from the start and not of the timer or of `flush`, which
 * is what the two findings below record.
 */

/** How long after the last turn a position is sent — the desktop's own tick. */
export const WRITE_DEBOUNCE_MS = 2_000

/** A position as the shelf holds it. `at` is the stamp's wall clock, ms. */
export interface ShelfPosition {
  readonly cfi: string
  readonly progress: number
  readonly at: number
}

/** A position as this device holds it. */
export interface LocalPosition {
  readonly cfi: string
  readonly at: number
}

export interface RemotePositions {
  /** The shelf's position for this book, or null when it has none. Throws when the shelf cannot be asked. */
  read(bookId: string): Promise<ShelfPosition | null>
  /** Remember this as the latest; sent after that BOOK's debounce, or on `flush`. */
  write(bookId: string, cfi: string, progress: number | undefined): void
  /**
   * Send whatever is pending now. Resolves once every book's latest place has
   * been tried — including one whose earlier write is still out, which is
   * waited for rather than counted as already handled.
   */
  flush(): Promise<void>
  /** Stop timers and drop what is pending. */
  dispose(): void
}

/**
 * Where to start reading: the shelf's place when it is newer than this
 * device's, else this device's, else nothing.
 */
export function startingPlace(
  local: LocalPosition | null,
  shelf: ShelfPosition | null,
): { readonly cfi: string | null; readonly from: 'shelf' | 'device' | 'none' } {
  if (shelf !== null && (local === null || shelf.at > local.at)) return { cfi: shelf.cfi, from: 'shelf' }
  if (local !== null) return { cfi: local.cfi, from: 'device' }
  return { cfi: null, from: 'none' }
}

/** `book.get`'s answer, read for the three fields this cares about. */
function shelfPositionOf(answer: unknown): ShelfPosition | null {
  if (typeof answer !== 'object' || answer === null) return null
  const row = answer as Record<string, unknown>
  const cfi = row['position']
  if (typeof cfi !== 'string' || cfi === '') return null
  const stamp = row['positionAt']
  /* A position with no stamp is one an old record carried before the
     register existed: real, and older than anything this device wrote. */
  const at = isHlc(stamp) ? parseHlc(stamp).ms : 0
  const progress = typeof row['progress'] === 'number' ? row['progress'] : 0
  return { cfi, progress, at }
}

export interface RemotePositionOptions {
  readonly debounceMs?: number
  /** A write refused for good. Defaults to a console warning — the reader has a page to read. */
  readonly onRefused?: (bookId: string, cause: unknown) => void
}

export function remotePositions(
  channel: ShelfChannel & Partial<Pick<ShelfLink, 'onOpened'>>,
  options: RemotePositionOptions = {},
): RemotePositions {
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS
  const onRefused =
    options.onRefused ?? ((bookId: string, cause: unknown) => console.warn(`Paper: the position of ${bookId} was not saved`, cause))

  /** The latest position per book, not yet on the shelf. */
  const pending = new Map<string, { cfi: string; progress: number | undefined }>()
  /**
   * The delivery in flight per book, held as its PROMISE.
   *
   * A set of names was enough to stop two deliveries of one book overlapping,
   * and not enough for `flush`, which skipped a book whose write was already
   * out and then RESOLVED — over a newer place it had never attempted. The
   * Reader awaits `flush` from its unmount cleanup, so a reader who turned one
   * last page and closed the book was told the write had been tried when it
   * had not; if the tab went away before the delivery's own tail got to it,
   * that page turn was simply lost. Holding the promise lets `flush` wait for
   * a delivery it did not start, and that delivery's tail is what carries the
   * newer place.
   */
  const inFlight = new Map<string, Promise<void>>()
  /**
   * The debounce, PER BOOK.
   *
   * One shared timer made the wait "two seconds after the last turn of ANY
   * book". With one instance serving every book the reader opens, a reader
   * who put book A down and kept turning pages in B pushed A's settled
   * position back on every turn of B — it went nowhere until B was closed and
   * flushed. A book's own quiet is what should send it.
   */
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const deliver = async (bookId: string): Promise<void> => {
    const latest = pending.get(bookId)
    if (latest === undefined) return
    pending.delete(bookId)
    let keep = false
    try {
      await channel.call('book.position', {
        book: bookId,
        position: latest.cfi,
        ...(latest.progress === undefined ? {} : { progress: latest.progress }),
      })
    } catch (cause) {
      if (disposed) return
      if (isRetryable(cause)) keep = true
      else onRefused(bookId, cause)
    }
    if (disposed) return
    /* A NEWER PLACE LANDED while this one was out: it goes now, and the one
       that just went — or failed — is history either way. Otherwise a failed
       write is KEPT for the next flush. Two different questions, and the
       first draft asked one of them with the other's answer: it re-added the
       failed write and then read its own re-add as "newer", for ever. */
    if (pending.has(bookId)) {
      await deliver(bookId)
      return
    }
    if (keep) pending.set(bookId, latest)
  }

  /**
   * One delivery per book at a time, and a second caller WAITS for the first
   * rather than being told there is nothing to do. The promise covers the
   * whole chain — the delivery and any newer place its tail picks up — so
   * awaiting it is awaiting everything known about that book.
   */
  const send = (bookId: string): Promise<void> => {
    const running = inFlight.get(bookId)
    if (running !== undefined) return running
    const run = deliver(bookId).finally(() => inFlight.delete(bookId))
    inFlight.set(bookId, run)
    return run
  }

  const flush = async () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    /* Books already out as well as books merely pending — waiting for a
       delivery this call did not start is the point; see `inFlight`. */
    const books = new Set([...pending.keys(), ...inFlight.keys()])
    await Promise.all([...books].map((bookId) => send(bookId)))
  }

  /* WHEN THE LINK IS BACK, so a position written on a dead socket is not
     waiting for the next page turn to be tried again. A bare channel has no
     `onOpened`; then the next flush is the retry. */
  const stopListening = channel.onOpened?.(() => void flush()) ?? (() => {})

  return {
    read: async (bookId) => shelfPositionOf(await channel.call('book.get', { book: bookId })),

    write: (bookId, cfi, progress) => {
      if (disposed || cfi === '') return
      pending.set(bookId, { cfi, progress })
      const waiting = timers.get(bookId)
      if (waiting !== undefined) clearTimeout(waiting)
      /* This book's timer, and this book's send — not a flush, which would
         drag every other book's settled position along with it. */
      timers.set(
        bookId,
        setTimeout(() => {
          timers.delete(bookId)
          void send(bookId)
        }, debounceMs),
      )
    },

    flush,

    dispose: () => {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
      stopListening()
    },
  }
}
