import type { Library } from '../../kernel'
import type { ReadingPositions } from '../web/positions'

/**
 * Where a book was left, ON THE RECORD — not in this device's browser storage.
 *
 * ## Why not `browserPositions`
 *
 * The browser client keeps positions in `localStorage` because it is a guest:
 * its session is granted reads plus `book.position`, and the shelf is the one
 * that owns the truth. A phone is not a guest. It holds the real services on
 * its own disk with the right to write, so a position belongs on the book's
 * record — where `positionAt` stamps it, the journal records it, and sync
 * replicates it to the reader's other devices.
 *
 * Kept in `localStorage` instead, a phone would read on the train, arrive home,
 * and find the laptop had never heard of it. That is not a smaller version of
 * the feature; it is the feature not working.
 *
 * ## `set` is fire-and-forget, deliberately
 *
 * `ReadingPositions.set` is synchronous and "safe to call on every page turn",
 * which is the contract the reader turns pages against — a promise awaited per
 * turn would put a filesystem round-trip in the gesture. `rememberPosition`
 * already goes through the write queue and the journal, so ordering is the
 * queue's problem and not this module's. A rejection is reported rather than
 * dropped: a position that silently stops saving is indistinguishable from one
 * that never moved.
 */

export interface LocalPositionsDeps {
  readonly library: Library
  /** Told when a position could not be written. */
  readonly failed?: (bookId: string, cause: unknown) => void
}

export function localPositions({ library, failed }: LocalPositionsDeps): ReadingPositions {
  /**
   * When THIS SESSION last wrote each book's position, epoch milliseconds.
   *
   * ⚠️ **NOT read back off the record, and that is a real limit rather than an
   * oversight.** The record's stamp is `positionAt`, an `Hlc` — a branded
   * string whose internal shape is the clock's business, not this module's,
   * and pulling a wall-clock out of it here would be a second parser for a
   * format with one owner.
   *
   * It costs nothing TODAY because `held` is only read when the reader is
   * given a `remote` — the shelf's copy, to decide which place is newer — and
   * the phone is given none: it writes through the journal, so there is no
   * second copy to race. `Reader` takes the `remote === undefined` branch and
   * decides the start from `get` alone.
   *
   * ⚠️ **SO: A PHONE THAT EVER GAINS A `remote` NEEDS A REAL STAMP HERE**, or
   * every position written in an earlier session answers 0 and loses to the
   * shelf's — silently, and only for readers who closed the app.
   */
  const wroteAt = new Map<string, number>()

  const remember = (bookId: string, cfi: string): void => {
    wroteAt.set(bookId, Date.now())
    void library.rememberPosition(bookId, cfi).catch((cause: unknown) => {
      failed?.(bookId, cause)
    })
  }

  return {
    get: (bookId) => library.positionOf(bookId),

    held: (bookId) => {
      const cfi = library.positionOf(bookId)
      if (cfi === null) return null
      /* 0 is the contract's own answer for "no stamp recorded", and it loses
         to any shelf stamp — the safe direction, since losing means adopting
         the shelf's place rather than overwriting it with an unstamped one. */
      return { cfi, at: wroteAt.get(bookId) ?? 0 }
    },

    set: (bookId, cfi) => {
      /* NULL IS NOT A WRITE. The browser store deletes its row; there is no
         verb for un-setting a position on a record, and inventing one by
         writing an empty CFI would make `positionOf` answer a string that no
         renderer can resolve. A book with nowhere to be is a book whose record
         is going away with it — see `forget`.
         ⚠️ AND NEITHER IS THE EMPTY STRING, which this paragraph argued
         against while the guard below tested only for null. An empty CFI is
         exactly the unresolvable string it names, and it does not merely fail
         to be read: it OVERWRITES the place the reader actually left. The
         browser adapter rejects it; this one accepted it. */
      if (cfi === null || cfi === '') return
      remember(bookId, cfi)
    },

    touch: () => {
      /* A NO-OP, and the reason is that the thing it protects does not exist
         here. `touch` refreshes a book's place in the BROWSER store's
         500-entry eviction order, so a favourite reopened at the same line is
         not evicted while it is being read. Records are not evicted: a book on
         this device is a folder, and it stays until the reader removes it. */
    },

    forget: () => {
      /* Likewise. `forget` drops the row for a book the SHELF no longer has —
         a guest tidying a cache. Removing a book here removes its folder, and
         the position goes with the record rather than needing to be chased. */
    },
  }
}
