/**
 * What to undo if the open now starting never lands.
 *
 * # The shape this exists to remove
 *
 * A cross-book jump COMMITS BEFORE IT ARRIVES. `goToJump` sets the place
 * override, raises the "← Back to …" line and answers `true` — all on the
 * assumption that the book it just asked for will open, which is a read off
 * disk that can fail seconds later. So the open carries a rollback: what to
 * take back off if it never lands.
 *
 * One slot, because one open at a time is the one the reader is waiting for.
 * The slot has had a defect at each of its three edges, and each is a
 * transition here rather than a rule a caller has to remember:
 *
 *  - **Fired by the wrong open.** The rollback was armed by the jump and
 *    cleared only by the jump's own landing, so a jump superseded by a direct
 *    open left it loaded and a LATER, unrelated failure fired it — clearing a
 *    hint and an override belonging to somebody else.
 *  - **Discarded rather than run.** The fix for that cleared the slot on every
 *    open, which is the same abandonment wearing the opposite sign: the
 *    superseded jump's override survived, armed, for the next time that book
 *    was opened.
 *  - **Released too early.** It was released the moment the BYTES arrived,
 *    which is before the book has parsed or the reader has rendered a line of
 *    it. A corrupt or unsupported book therefore kept the jump's committed
 *    state after the reader had been shown an error.
 *
 * # Carrying is not superseding
 *
 * `arm` fires whatever the last open left, EXCEPT the very rollback being
 * armed. That exception is load-bearing rather than defensive: a stored book
 * with no content falls back to its origin path, and that fallback re-enters
 * the open through the same door with the SAME rollback. It is one open
 * continuing by another route, not a new one replacing it — and firing there
 * would clear the jump's own override and land the book at its saved place
 * instead of at the mark the reader clicked.
 */

export interface OpenRollback {
  /**
   * Take the slot for the open that is starting.
   *
   * Fires whatever the previous open left armed, unless it is the same
   * rollback being carried forward — see the header.
   */
  arm(undo: (() => void) | null): void
  /** The open landed. There is nothing left to undo. */
  release(): void
  /** The open failed. Undo what it committed on the assumption it would not. */
  fire(): void
}

export function createOpenRollback(): OpenRollback {
  let armed: (() => void) | null = null

  const take = (next: (() => void) | null): (() => void) | null => {
    const stale = armed
    armed = next
    return stale
  }

  return {
    arm: (undo) => {
      const stale = take(undo)
      /* IDENTITY, not truthiness. See the header: the origin fallback re-arms
         the rollback it is already carrying. */
      if (stale !== null && stale !== undo) stale()
    },
    release: () => void take(null),
    fire: () => take(null)?.(),
  }
}
