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
