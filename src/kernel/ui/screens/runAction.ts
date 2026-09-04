import type { BookAction } from '../../core/capability'

/**
 * Run a capability's book action and SAY how it failed — whichever way it
 * fails.
 *
 * `run` is typed `void | Promise<void>`, so an action can throw before it
 * returns anything or reject after it has: two failure shapes, one failure
 * to the reader, and both are reported under the action's id. The card's
 * fetch button and the book menu each carried a copy of this, and the copies
 * had already drifted — the card reported a rejection and swallowed a throw,
 * so one of the two documented failure modes left no diagnostic at all.
 *
 * STARTED SYNCHRONOUSLY: a download begins when the reader clicks, not a
 * microtask later. `settle` runs once the action is over however it ended,
 * which is how the fetch button releases itself — a synchronous throw never
 * reaches a `.finally`, and used to leave the control disabled for the life
 * of the card.
 *
 * Reporting is otherwise the ACTION'S job — sync's download catches its own
 * failure and sets `degraded`. What is said here is what a capability that
 * broke that contract would otherwise leave unsaid.
 */
export function runBookAction(action: Pick<BookAction, 'id' | 'run'>, bookId: string, settle?: () => void): void {
  const report = (cause: unknown): void => {
    console.error(`Paper: the action "${action.id}" failed`, cause)
  }
  try {
    void Promise.resolve(action.run(bookId))
      .catch(report)
      .finally(() => settle?.())
  } catch (cause) {
    report(cause)
    settle?.()
  }
}
