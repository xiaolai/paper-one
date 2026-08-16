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
  /** Run after anything in flight, replacing any other write still waiting. */
  push: (key: string, task: Task) => Promise<void>
}

interface Waiting {
  readonly task: Task
  readonly settle: (error?: unknown) => void
}

export function writeQueue(): WriteQueue {
  /** What is running, per key. */
  const running = new Map<string, Promise<void>>()
  /** The one task waiting behind it — replaced, never queued behind. */
  const pending = new Map<string, Waiting>()

  const drain = async (key: string): Promise<void> => {
    for (;;) {
      const next = pending.get(key)
      if (!next) break
      pending.delete(key)
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
        next.settle(error)
      }
    }
    running.delete(key)
  }

  return {
    push(key, task) {
      return new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => (error ? reject(error) : resolve())
        /* The superseded task RESOLVES rather than rejecting. It was skipped
         * deliberately because a newer value made it pointless, and that is a
         * success from the caller's side — its data is about to be written by
         * the task that replaced it. */
        pending.get(key)?.settle()
        pending.set(key, { task, settle })
        if (running.has(key)) return
        running.set(key, drain(key))
      })
    },
  }
}
