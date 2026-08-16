/**
 * One write at a time, per key, always ending on the newest value.
 *
 * Every store in this app writes to a fixed `<path>.writing` neighbour and then
 * renames it into place, which is atomic for ONE write and a collision for two:
 * a second write starting before the first renames uses the same temporary file,
 * so the two interleave and the rename can move somebody else's bytes.
 *
 * Rapid highlighting is exactly that shape — a reader marking three passages in
 * a second — and so is a position save landing while a tag is being written.
 *
 * COALESCING rather than queueing every call: when three writes arrive during
 * one in flight, only the last one's value matters, because each write persists
 * the WHOLE collection. Running all three would be two writes of stale data and
 * a third of the same bytes.
 */

type Task = () => Promise<void>

export interface WriteQueue {
  /**
   * Run after anything in flight, REPLACING any other write still waiting.
   *
   * Correct only when a task writes the WHOLE state — marks, or the index. Each
   * such write makes its predecessor redundant, so running a superseded one is
   * two writes of stale bytes.
   */
  push: (key: string, task: Task) => Promise<void>
  /**
   * Run after everything already queued, replacing nothing.
   *
   * For a task that applies a CHANGE rather than writing a state: two edits to
   * one book — a tag, then finished — are different changes, and coalescing
   * them drops the first. That is silent data loss, which is exactly what the
   * queue was added to prevent, so the two shapes cannot share one method.
   */
  append: (key: string, task: Task) => Promise<void>
}

interface Waiting {
  readonly task: Task
  readonly settle: (failure?: { error: unknown }) => void
  readonly mode: Mode
}

type Mode = 'replace' | 'append'

export function writeQueue(): WriteQueue {
  /** What is running, per key. */
  const running = new Map<string, Promise<void>>()
  /** What is waiting, per key. At most one under `replace`; a line under `append`. */
  const pending = new Map<string, Waiting[]>()

  const drain = async (key: string): Promise<void> => {
    for (;;) {
      const queued = pending.get(key)
      const next = queued?.shift()
      if (!next) {
        pending.delete(key)
        break
      }
      try {
        await next.task()
        next.settle()
      } catch (error) {
        /* CAUGHT HERE, and handed to the caller who pushed it.
         *
         * Letting it out of the loop wedged the key forever: the throw left
         * `running` populated, so every later write for that book queued behind
         * a promise that had already rejected and never ran. A disk that is
         * momentarily full would have silently stopped saving that book's marks
         * for the rest of the session. */
        next.settle({ error })
      }
    }
    running.delete(key)
  }

  const enqueue = (key: string, task: Task, mode: Mode): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      /* WRAPPED, because the truthiness of the error is not the question being
       * asked. `throw undefined` and `throw 0` are legal, and testing the value
       * resolved them as successes — a write that failed reporting that it had
       * saved. The presence of the wrapper is the signal. */
      const settle = (failure?: { error: unknown }) =>
        failure ? reject(failure.error as Error) : resolve()
      const line = pending.get(key) ?? []
      if (mode === 'replace') {
        /* ONLY OTHER WHOLE-STATE WRITES ARE SUPERSEDED. Clearing the line
         * outright also threw away appended tasks — and those READ the file and
         * change part of it, so dropping one loses the edit it was carrying. The
         * two modes share a key whenever a book is edited from Notes and then
         * opened, which is not an exotic sequence.
         *
         * The superseded task RESOLVES rather than rejecting. It was skipped
         * deliberately because a newer value made it pointless, and that is a
         * success from the caller's side — its data is about to be written by
         * the task that replaced it. */
        for (const waiting of line) {
          if (waiting.mode === 'replace') waiting.settle()
        }
        const kept = line.filter((waiting) => waiting.mode === 'append')
        line.length = 0
        line.push(...kept)
      }
      line.push({ task, settle, mode })
      pending.set(key, line)
      if (running.has(key)) return
      running.set(key, drain(key))
    })

  return {
    push: (key, task) => enqueue(key, task, 'replace'),
    append: (key, task) => enqueue(key, task, 'append'),
  }
}
