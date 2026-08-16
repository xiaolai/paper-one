/**
 * Saving where the reader is, without saving it on every page turn.
 *
 * `relocate` fires on each turn, and each write serialises the WHOLE shelf into
 * local storage and re-renders everything that reads it. Writing straight
 * through would make turning a page cost a full store write; not writing until
 * the book closes would lose the position whenever the app did not close
 * politely, which is the case the feature exists for.
 *
 * So: at most one write per interval, and an immediate one at every point where
 * the position is about to become unrecoverable — the book changing, the window
 * hiding, the reader closing the book.
 *
 * A THROTTLE, not a debounce. Debouncing would hold the write back for as long
 * as the reader kept turning pages, so an hour of steady reading followed by a
 * crash would save nothing. This writes on the interval whether or not the
 * reader has paused.
 *
 * The timer functions are injected so the rules can be tested against a clock
 * that does not take real seconds to advance.
 */

export interface PositionRecorder {
  /** The reader moved. Null for either argument means there is nothing to save. */
  record: (bookId: string | null, cfi: string | null) => void
  /** Write anything outstanding now — before the position stops being reachable. */
  flush: () => void
  /** Drop the timer without writing. For teardown, after a flush. */
  stop: () => void
}

export interface PositionRecorderOptions {
  write: (bookId: string, cfi: string) => void
  /** How long a position may sit unwritten while the reader keeps moving. */
  delayMs?: number
  schedule?: (fn: () => void, ms: number) => number
  cancel?: (handle: number) => void
}

interface Pending {
  readonly bookId: string
  readonly cfi: string
}

export function positionRecorder({
  write,
  delayMs = 2000,
  schedule = (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancel = (handle) => {
    clearTimeout(handle)
  },
}: PositionRecorderOptions): PositionRecorder {
  let pending: Pending | null = null
  let timer: number | null = null

  const clear = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }

  const flush = () => {
    const due = pending
    pending = null
    clear()
    if (due) write(due.bookId, due.cfi)
  }

  const record = (bookId: string | null, cfi: string | null) => {
    /* Nothing to save — but possibly something to SAVE FIRST. This is the state
     * the book store enters the instant a book is closed or replaced: it clears
     * the id and the position synchronously, several frames before the next
     * book's id resolves. Without the flush, the last position of every book
     * you ever switch away from is lost, which is every book except the one
     * open when the app is finally shut. */
    if (!bookId || !cfi) {
      flush()
      return
    }

    // A position belongs to the book it was read in. Changing books without
    // passing through the null state above must not file one under the other.
    if (pending && pending.bookId !== bookId) flush()

    pending = { bookId, cfi }
    /* Started once and left to run, rather than restarted on every call. A
     * restart here would turn this into a debounce and hold the write back for
     * as long as the reader kept reading. */
    if (timer === null) timer = schedule(flush, delayMs)
  }

  return { record, flush, stop: clear }
}
