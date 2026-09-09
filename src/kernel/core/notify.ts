/**
 * Telling every subscriber, without letting one of them take the others down.
 *
 * ⚠️ **THE SAME DEFECT WAS FOUND AND FIXED FIVE TIMES IN FIVE FILES, AND MISSED
 * IN FOUR MORE.** A bare `for (const listener of listeners) listener()` has two
 * failure modes and both are worse than they look:
 *
 * 1. **A throwing subscriber stops every LATER subscriber.** The first one to
 *    fail silences the rest, and which ones those are depends on insertion
 *    order — so the symptom is "some panels do not refresh, sometimes".
 * 2. **The throw travels back into the operation that had already
 *    succeeded.** These notifications are made after a write has landed, so
 *    the caller's `await` rejects, the UI reports the change failed, and the
 *    change is on disk. `markStore` records the sharpest version: notified
 *    from the optimistic half of `applyTo`, a throwing listener *"stopped the
 *    disk write behind it"*, and notified after a successful write its throw
 *    *"was then classified as a persistence failure by the catch around it"*.
 *
 * `settings`, `markStore`, `cardStore` and the envelope's disconnect list each
 * grew their own copy of the fix, with their own decision about whether to log.
 * `libraryStore` and the whole public capability did not have one. Found by
 * audit, as four more instances of a class four earlier audits had each fixed
 * one instance of.
 *
 * ⚠️ **REPORTED, NOT SWALLOWED.** Two of the copies caught and said nothing,
 * which makes a subscriber that has been broken for a month look exactly like
 * one that is working. `what` names the store so the line is worth reading.
 *
 * PURE, apart from the console.
 */
export function notifyAll(listeners: Iterable<() => void>, what: string): void {
  /* A COPY, because a listener may subscribe or unsubscribe while being told —
     a panel that unmounts on the change it is hearing about does exactly
     that, and mutating a `Set` mid-iteration is how one subscriber comes to
     be skipped. */
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (cause) {
      console.error(`Paper: a ${what} subscriber threw while being notified`, cause)
    }
  }
}
