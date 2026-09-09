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
  /**
   * Run after everything already queued, and NEVER at the cost of the reader's
   * own writing.
   *
   * ⚠️ **THE CAP `append` GAINED TREATED PUBLIC ARRIVALS AND THE READER'S OWN
   * EDITS IDENTICALLY**, so filling a book's queue with public tasks made the
   * next private edit reject — the exact objective WI-26.7 states, inverted.
   * Found by audit. A task queued through here is refused earlier, at
   * {@link MAX_APPENDED_SHARED}, which leaves the rest of the line for `append`
   * and `push`.
   *
   * The lane is still SHARED, deliberately: a public write on an unrelated
   * queue races rekeying and deletion. What is not shared is the whole of it.
   */
  appendShared: (key: string, task: Task) => Promise<void>
  /**
   * Resolves when nothing is running or waiting, on any key.
   *
   * For the one moment that cannot be deferred: the window closing. Everything
   * here is deliberately asynchronous — a page turn must not wait on a disk —
   * and that is right until the process is about to go away, at which point an
   * unfinished write is a lost highlight. The close is held for this instead.
   *
   * Resolves rather than rejects when a task failed: the caller is asking "is
   * anything still in flight", and a write that failed is not. Its own promise
   * already carried the failure to whoever queued it.
   */
  idle: () => Promise<void>
}

interface Waiting {
  readonly task: Task
  readonly settle: (failure?: { error: unknown }) => void
  readonly mode: Mode
}

type Mode = 'replace' | 'append' | 'shared'

/**
 * The most appended tasks one key may have waiting — WI-26.7.
 *
 * ⚠️ **`append` HAD NO LENGTH LIMIT, AND `push` DOES NOT NEED ONE.** A
 * `replace` supersedes its predecessor, so a line of them is at most one deep
 * however fast they arrive; an `append` supersedes nothing, deliberately, so
 * the line is as long as the caller makes it. That was safe while every caller
 * was the reader — a tag, then finished, then a position — and stops being safe
 * the moment a caller is a STRANGER's arrival rate.
 *
 * Public annotations arrive on the book's lane (they must: a public write on an
 * unrelated queue races rekeying and deletion), so a flood of them is a flood
 * of appended tasks on the same key the reader's own note is waiting on. The
 * cap is what keeps the reader's write from being scheduled behind an
 * attacker's thousand.
 *
 * ⚠️ **AND THE REFUSAL IS THE POINT — A QUEUE THAT GROWS INSTEAD OF REFUSING IS
 * NOT A BOUND.** The task is not run and its promise REJECTS, so the caller
 * finds out. A version that dropped it silently would be the same defect
 * wearing an answer.
 *
 * Two hundred and fifty-six is far past any sequence of acts a reader performs
 * on one book and far under anything that costs memory.
 */
export const MAX_APPENDED = 256

/**
 * The most SHARED-LANE tasks one key may have waiting — the public layer's
 * share of `MAX_APPENDED`.
 *
 * ⚠️ **RESERVING THE REST FOR THE READER IS THE WHOLE POINT.** Half the line
 * is far more than a flood needs to make progress and leaves a hundred and
 * twenty-eight places no stranger can take, which is what "the reader's own
 * note is not scheduled behind an attacker's thousand" has to mean.
 */
export const MAX_APPENDED_SHARED = MAX_APPENDED / 2

/** What `append` rejects with when a key's line is full. */
export class WriteQueueFull extends Error {
  constructor(readonly key: string) {
    super(`writeQueue: ${key} already has ${MAX_APPENDED} writes waiting`)
    this.name = 'WriteQueueFull'
  }
}

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
      /* ⚠️ **CHECKED BEFORE THE TASK IS ENQUEUED, NOT AFTER.** A bound that
         ran later would have already taken the memory it exists to refuse —
         `importLimits.ts`'s rule, on a queue rather than on a read. A
         `replace` line cannot exceed one waiting task plus however many
         appends are ahead of it, so only the appended ones are counted.

         ⚠️ **AND A SHARED-LANE TASK IS REFUSED EARLIER THAN THE READER'S OWN.**
         One cap for both meant a book's queue filled with public arrivals made
         the reader's next edit reject — WI-26.7's objective inverted, found by
         audit. `appendShared` gets half the line; the other half is the
         reader's and no stranger can take it. */
      const waitingAppends = line.filter((one) => one.mode === 'append' || one.mode === 'shared').length
      const cap = mode === 'shared' ? MAX_APPENDED_SHARED : MAX_APPENDED
      if (mode !== 'replace' && waitingAppends >= cap) {
        reject(new WriteQueueFull(key))
        return
      }
      if (mode === 'replace') {
        /* ONLY OTHER WHOLE-STATE WRITES ARE SUPERSEDED. Clearing the line
         * outright also threw away appended tasks — and those READ the file and
         * change part of it, so dropping one loses the edit it was carrying. The
         * two modes share a key whenever a book is edited from Marginalia and then
         * opened, which is not an exotic sequence.
         *
         * The superseded task RESOLVES rather than rejecting. It was skipped
         * deliberately because a newer value made it pointless, and that is a
         * success from the caller's side — its data is about to be written by
         * the task that replaced it. */
        for (const waiting of line) {
          if (waiting.mode === 'replace') waiting.settle()
        }
        const kept = line.filter((waiting) => waiting.mode !== 'replace')
        line.length = 0
        line.push(...kept)
      }
      line.push({ task, settle, mode })
      pending.set(key, line)
      if (running.has(key)) return
      /* ⚠️ **THE KEY IS REGISTERED BEFORE THE FIRST TASK RUNS, AND IT WAS
         NOT.** This read `running.set(key, drain(key))`, which evaluates the
         CALL first — and an `async` body runs synchronously up to its first
         `await`. That await is `await next.task()`, so the task was already
         running while the key was still unregistered. A task that synchronously
         enqueued another write on the same key therefore saw
         `running.has(key)` as false and started a SECOND drain: two drains
         interleaving on one key, which is the single thing this queue exists to
         prevent. If the second finished first it also ran `running.delete(key)`,
         leaving the outer promise registered under a key nothing would ever
         clear — every later write for that book queued behind it and `idle()`
         never returned. Found by audit.

         ⚠️ **AND THE DRAIN IS NOT DELAYED TO ACHIEVE THAT.** Starting it a
         microtask later also registers the key in time, and changes which
         tasks are supersedable: the first task no longer begins synchronously,
         so a `push` arriving immediately after can replace work that had
         already started. Three of this file's own tests say so. The key is
         CLAIMED synchronously with a placeholder instead, and the real drain
         starts in the same tick it always did. */
      let ran: () => void = () => {}
      running.set(
        key,
        new Promise<void>((done) => {
          ran = done
        }),
      )
      void drain(key).finally(ran)
    })

  return {
    push: (key, task) => enqueue(key, task, 'replace'),
    append: (key, task) => enqueue(key, task, 'append'),
    appendShared: (key, task) => enqueue(key, task, 'shared'),
    async idle() {
      /* LOOPED, because draining one key can enqueue another — the library
       * writes a book's record and then the index, on a different key, from
       * inside the first task's continuation. Waiting once would return between
       * those two and call the queue empty while the cache was still unwritten.
       *
       * It terminates because every task is already queued by the time its
       * predecessor resolves: this waits for work in flight, not for work a
       * reader might still create. */
      while (running.size > 0 || pending.size > 0) {
        await Promise.allSettled([...running.values()])
      }
    },
  }
}
