/**
 * Work that must happen before the window goes away.
 *
 * The problem this solves is narrow and real. Everything in this app is written
 * asynchronously on purpose — a page turn must not wait on a disk — and the
 * window close is intercepted so the write queue can drain before the process
 * ends. But a queue can only drain what it has been GIVEN, and the thing most
 * likely to be lost is the thing not yet handed over: a note being typed, which
 * lives in the editor until something commits it.
 *
 * `pagehide` cannot do it. It fires as the webview is torn down, so it starts
 * work that nothing will finish — and Tauri's close-request arrives BEFORE it,
 * so by the time it runs the queue has already been declared empty.
 *
 * So the order is: flush what is held in memory, THEN drain what is on the
 * queue. This is the first half.
 *
 * Callbacks must be SYNCHRONOUS. They are not the write; they are the handover
 * — put the value into the store, and let the store's own queue carry it. A
 * callback that returns a promise is a second thing to wait for, and the whole
 * point is that there is exactly one.
 */

type Flush = () => void

const pending = new Set<Flush>()

/**
 * Register work to run before the window closes. Returns its own removal.
 *
 * A Set rather than a list, and removal by identity, because these are
 * registered from components that mount and unmount as panes open and close.
 */
export function onBeforeClose(flush: Flush): () => void {
  pending.add(flush)
  return () => {
    pending.delete(flush)
  }
}

/**
 * Run every registered flush.
 *
 * One failing callback must not stop the others — the reader has one note in
 * one editor, but the same registry carries whatever else is holding state, and
 * losing all of it because one threw would be the worst possible trade.
 */
export function flushBeforeClose(): void {
  for (const flush of [...pending]) {
    try {
      flush()
    } catch (cause) {
      console.error('Paper: something could not be saved before closing', cause)
    }
  }
}

/**
 * Work the drain has to WAIT FOR — registered here, awaited between the
 * handover above and the drain.
 *
 * ⚠️ **A SECOND LIST, BECAUSE THE FIRST ONE'S CONTRACT IS RIGHT** (2026-09-13
 * audit, #96). Some state is not held in memory waiting to be handed over; it
 * is work already RUNNING, and it hands itself over later. An import still
 * copying chains its shelf writes one batch behind the copying, so a book
 * already on disk reaches the queue only once the copy has let go — after a
 * drain that did not wait for it had already declared the queue empty. Bytes
 * with no record: a book the library cannot see and removal cannot reach.
 *
 * The window close had been taught to stop the import first, inside `App`; ⌘Q
 * on a Mac never passes through there (`app/shutdown.ts` runs its teardown
 * directly), so that path drained under a live copy. Registering here is what
 * puts the wait on BOTH paths. `onBeforeClose` stays synchronous — its
 * callbacks are handovers, and "exactly one thing to wait for" is still true
 * of them; this list is the one thing, and it is awaited once.
 *
 * NOT BOUNDED HERE: each shutdown path bounds its own wait, and one budget
 * over the settle and the drain together is what keeps a stuck stop from
 * holding the window or the quit open.
 */
type Settle = () => Promise<unknown>

const settling = new Set<Settle>()

/** Register work the drain must wait for. Returns its own removal. */
export function onBeforeDrain(settle: Settle): () => void {
  settling.add(settle)
  return () => {
    settling.delete(settle)
  }
}

/**
 * Run every registered settle and wait for ALL of them.
 *
 * Never rejects, and one failing does not stop the others being waited for —
 * the drain goes ahead either way, and a stop that threw must not cost the
 * queue its drain. A settle that throws synchronously is caught the same way.
 */
export async function settleBeforeDrain(): Promise<void> {
  await Promise.all(
    [...settling].map(async (settle) => {
      try {
        await settle()
      } catch (cause) {
        console.error('Paper: something the write queue waits for did not finish before closing', cause)
      }
    }),
  )
}
