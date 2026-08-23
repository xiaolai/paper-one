/**
 * Which in-flight async result is still the one anybody is waiting for.
 *
 * # The shape this exists to remove
 *
 * Opening a book off the shelf is a read: the bytes are fetched, and when they
 * arrive the reader is moved into that book. If they ask for a different book
 * while the first read is in flight, the first read must not land — it would
 * take them out of the book they just chose and into the one they abandoned.
 *
 * A counter was doing this, and only ONE of the producers advanced it. The
 * stored-book route claimed a generation and checked it; the picker, the drop
 * handler, an in-book link and every direct open advanced nothing at all. So a
 * shelf open still in flight was always "fresh", and it overwrote whatever the
 * reader had asked for since.
 *
 * **The rule is that every open supersedes, not that every SLOW open
 * supersedes.** A token only one producer advances answers a narrower question
 * than the one being asked, which is exactly how the import batch token failed
 * in the same file.
 *
 * # Why it is in `core/` and not next to its first caller
 *
 * The SECOND instance was `routesModel.refresh()`: two probes overlapping
 * meant the one that RESOLVED last won rather than the one ISSUED last, so a
 * slow first probe could overwrite a fast second one with a stale route list.
 * Identical shape, different subsystem — so the primitive moved here and both
 * draw on it rather than each growing its own counter.
 */

export interface Generations {
  /**
   * Take the current generation and supersede everything before it.
   *
   * The returned predicate is false as soon as anything else claims — so an
   * async open checks it after every await and drops itself when it is no
   * longer the one being waited for.
   */
  claim(): () => boolean
}

export function createGenerations(): Generations {
  let latest = 0
  return {
    claim: () => {
      const mine = ++latest
      return () => latest === mine
    },
  }
}
