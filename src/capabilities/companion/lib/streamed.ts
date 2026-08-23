/**
 * A callback-pushing operation, read as an async generator.
 *
 * # Why this is its own file
 *
 * The plugin delivers an answer through a `Channel` callback — it pushes a
 * delta whenever one arrives — and a generator can only produce when its
 * consumer asks. The two cadences do not meet, so something has to hold what
 * arrived between two `next()` calls, and that something was thirty lines in
 * the middle of `ask`, mixed in with route dispatch, prompt construction and
 * citation resolution.
 *
 * It is also the subtlest code in that file, and its one defect was invisible
 * there: `null` served as the "nothing failed" sentinel while being a value a
 * rejection can legitimately carry, so `Promise.reject(null)` resolved the
 * whole turn as a SUCCESS carrying half an answer. Out here it is a function
 * with three moving parts and a test per part.
 *
 * # The three properties
 *
 * - **Nothing is dropped.** A chunk pushed while nobody is awaiting is queued;
 *   a chunk pushed after the consumer has resumed wakes it.
 * - **What arrived before a failure is still delivered.** The reader has seen
 *   those words; an answer that fails halfway must fail AFTER them, not
 *   instead of them, because the caller keeps the partial text and reports the
 *   failure beside it.
 * - **A rejection is a rejection whatever it carries.** `null`, `undefined`,
 *   `0`, `''` — see the sentinel below.
 */

/**
 * "Nothing failed", as a value nothing else can be.
 *
 * ⚠️ `null` WAS DOING THIS JOB, and `null` is a value a rejection can carry.
 * `Promise.reject(null)` — or a thrown `undefined` — was caught, left the
 * sentinel unchanged, and the turn then resolved as a SUCCESS: the caller was
 * handed whatever had arrived before the failure, presented as a finished
 * answer, with no way to tell it from a complete one. A sentinel has to be a
 * value the domain cannot produce, and a symbol is the only such value here.
 */
const NOTHING_FAILED = Symbol('companion.noFailure')

/**
 * Run `start`, yielding every chunk it pushes, and raise whatever it raised.
 *
 * `start` is handed the `push` callback and returns a promise that settles
 * when the operation is over. Its resolved value is ignored: the chunks ARE
 * the result, and a transport that also returns the whole text would otherwise
 * offer two sources of truth for one answer.
 */
export async function* streamed<T>(
  start: (push: (chunk: T) => void) => Promise<unknown>,
): AsyncGenerator<T, void> {
  const pending: T[] = []
  /* Set only while the loop below is parked, and cleared the moment it
     resumes — so `push` wakes a waiter exactly when there is one. */
  let notify: (() => void) | null = null
  let finished = false
  let failure: unknown = NOTHING_FAILED

  const running = start((chunk) => {
    pending.push(chunk)
    notify?.()
  })
    .then(() => {})
    .catch((error: unknown) => {
      failure = error
    })
    .finally(() => {
      finished = true
      notify?.()
    })

  /* `!finished || pending.length > 0` and not `!finished` alone: the operation
     can settle with chunks still queued, and stopping there would swallow the
     tail of an answer that arrived in the same tick as its completion. */
  while (!finished || pending.length > 0) {
    if (pending.length === 0) {
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      notify = null
      continue
    }
    yield pending.shift() as T
  }

  /* AWAITED, not merely observed. `finished` is set in `finally`, which runs
     before the promise itself settles for a caller — and a rejection that is
     never awaited is an unhandled one. */
  await running
  if (failure !== NOTHING_FAILED) throw failure
}
