import type { Disposable } from './capability'

/**
 * What a capability's `render()` reads, when `render()` takes no arguments.
 *
 * # The shape this exists to fix
 *
 * A settings section contributes `render: () => …`, called by the kernel's
 * pane with nothing passed in. So the value it draws — a store built in
 * `start` — has to be reachable from module scope, and both capabilities that
 * contribute one wrote the same thing:
 *
 * ```ts
 * let model: Model | null = null
 * // in start:  model = mine
 * // in stop:   if (model === mine) model = null
 * ```
 *
 * The ownership check is right as far as it goes: an OLD lifetime's stop must
 * not clear a newer one's value. What neither copy handled is the other
 * direction. Two live compositions — two `start`s with no `stop` between them,
 * which the registry permits and a test does routinely — leave the second
 * overwriting the first, and then stopping the SECOND sets the slot to null
 * while the first is still running and still bound. Its pane draws nothing
 * from that point on, and nothing anywhere says why.
 *
 * A stack answers both: the newest holder is what renders, releasing any
 * holder restores the most recent one still live, and releasing twice is a
 * no-op. Same rule the kernel's binding slots follow, for the same reason.
 */
export interface RenderSlot<T> {
  /** What `render()` should draw, or null when nothing is held. */
  current(): T | null
  /** Hold `value` until the returned disposer runs. */
  hold(value: T): Disposable
}

export function createRenderSlot<T>(): RenderSlot<T> {
  /* Newest last. An array rather than a single value because "what is current"
     and "what was current before this one" are different questions, and only
     the first was answerable. */
  const held: T[] = []
  return {
    current: () => held[held.length - 1] ?? null,
    hold: (value) => {
      held.push(value)
      let released = false
      return {
        dispose: () => {
          /* Idempotent, and it removes THIS holder rather than the top: a
             stop that runs after a newer start must not evict the newer one,
             which is the half the `=== mine` check already got right. */
          if (released) return
          released = true
          const at = held.lastIndexOf(value)
          if (at >= 0) held.splice(at, 1)
        },
      }
    },
  }
}
