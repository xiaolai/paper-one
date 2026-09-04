/**
 * Tell every listener, each on its own.
 *
 * ⚠️ **ONE LISTENER THAT THROWS MUST NOT SILENCE THE REST, NOR MAKE AN ACT
 * THAT ALREADY LANDED READ AS FAILED.** A port tells its subscribers after
 * the write, and a subscriber is a screen: a screen that throws is a screen
 * with a defect, and the other screens — and the caller waiting on the act —
 * are owed the news all the same. Iterated over a copy, because a listener
 * may unsubscribe while being told.
 *
 * ⚠️ **AND ONE THAT REJECTS IS HELD TO THE SAME PROMISE.** A `void` callback
 * can be an async function — TypeScript allows it — and its rejection
 * escaped the `try` as an unhandled rejection. It is caught the same way,
 * without waiting on it: the telling is fire-and-forget either way.
 */
export function tellEach(listeners: ReadonlySet<() => void>, what: string): void {
  for (const listener of [...listeners]) {
    settled(() => listener(), `a ${what} listener`)
  }
}

/**
 * Run a callback that may throw or reject, and say so either way — the one
 * rule for every callback a port fires and does not wait on.
 */
export function settled(call: () => unknown, who: string): void {
  try {
    const told = call()
    /* A THENABLE, not `instanceof Promise`: a promise from another realm —
       an iframe's, a worker's — or a library's own implementation is a
       promise in every way that matters and fails that test. */
    if (isThenable(told)) {
      told.then(undefined, (cause: unknown) => {
        console.warn(`Paper: ${who} failed`, cause)
      })
    }
  } catch (cause) {
    console.warn(`Paper: ${who} threw`, cause)
  }
}

/** Whether a value is something to wait on — the one test a promise from anywhere passes. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/**
 * One turn at a time per key — the read-check-write two quick acts on one
 * person could otherwise interleave — and the turn let go once it has
 * settled, so a port that outlives a thousand acts does not hold a thousand
 * promises. `pending` is how a test sees that it was let go.
 */
export interface Turns {
  inTurn<T>(key: string, task: () => Promise<T>): Promise<T>
  /** How many keys still hold a turn — zero once everything has settled. */
  pending(): number
}

export function createTurns(): Turns {
  const turns = new Map<string, Promise<unknown>>()
  return {
    inTurn: <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const turn = (turns.get(key) ?? Promise.resolve()).then(task, task)
      const settledTurn: Promise<void> = turn
        .catch(() => undefined)
        .then(() => {
          if (turns.get(key) === settledTurn) turns.delete(key)
        })
      turns.set(key, settledTurn)
      return turn
    },
    pending: () => turns.size,
  }
}

/**
 * A set of listeners and the three things every port does with one —
 * subscribe, tell, let go. Four ports each kept their own copy of these
 * lines, and a fix to one reached the others by luck.
 */
export interface Listeners {
  subscribe(listener: () => void): () => void
  tell(): void
  clear(): void
}

export function createListeners(what: string): Listeners {
  const held = new Set<() => void>()
  return {
    subscribe: (listener) => {
      held.add(listener)
      return () => {
        held.delete(listener)
      }
    },
    tell: () => tellEach(held, what),
    clear: () => held.clear(),
  }
}
