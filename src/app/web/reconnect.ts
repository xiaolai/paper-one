import { ENVELOPE_ERRORS, ServiceCallError, serviceError, type CallOptions } from '../../kernel/core/envelope'
import type { ClosedReason, ShelfChannel } from './channel'

/**
 * The link to the shelf, which comes back (phase 20, WI-20.30).
 *
 * ## What this replaces
 *
 * `Shelf` called `connect()` once, in an effect with `[]` deps, and nothing
 * re-ran it. When the socket closed — the laptop slept, the phone changed
 * networks, a `revoke` landed — the next `content.read` failed and the phone
 * stopped for good, on a page it could not turn, with a note saying the
 * library had stopped answering and no way back but a reload.
 *
 * ## What it is
 *
 * A `ShelfChannel` whose socket has a LIFETIME rather than a life. It opens a
 * channel, hands calls to it while it is open, and when the channel closes
 * for any reason but this side asking, opens another after a wait — bounded,
 * doubling, jittered, capped at half a minute — and says at every step what
 * it is doing, so the screen can too.
 *
 * ## What it does NOT do: replay
 *
 * A call made while the link is waiting is refused at once, `disconnected`
 * and `retryable`, exactly as the channel refuses one made after its close.
 * Queueing it for the next channel would be a promise that settles at some
 * unknown later moment against a shelf whose state has moved — the shape
 * that made an auth failure look like a slow shelf in phase 18. The callers
 * that can retry know how: `content.ts` restarts a read whole after
 * `whenOpen`, and the stores re-read on `onOpened`. Nothing is retried on a
 * caller's behalf.
 *
 * ## Bounded delay, unbounded patience
 *
 * The attempts are not counted out. A shelf asleep for an hour is the normal
 * case this exists for, and a link that gave up at attempt ten would leave
 * the phone exactly where the one-shot `connect()` did. What is bounded is
 * the DELAY between attempts, so a shelf that is back is found within half a
 * minute, and the reader can always `retryNow`.
 */

/** The first wait after a failure. */
export const BASE_DELAY_MS = 1_000
/** The longest wait between attempts, however many have failed. */
export const MAX_DELAY_MS = 30_000

/**
 * How long to wait before attempt `attempt` (1-based).
 *
 * Doubling from the base, capped, then jittered by a quarter either way —
 * `random` is injected so a test can pin the arithmetic. The jitter is not
 * decoration: a shelf that comes back finds every phone in the house
 * knocking at the same millisecond otherwise.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
  return raw * (0.75 + 0.5 * random())
}

export type LinkState =
  /** Opening a channel; `attempt` counts failures in a row, from 1. */
  | { readonly kind: 'connecting'; readonly attempt: number }
  /** A channel is open. `generation` counts channels, so a store can tell a reopen from a re-render. */
  | { readonly kind: 'open'; readonly generation: number }
  /** Between attempts. `retryAt` is when the next one is due, on the injected clock. */
  | { readonly kind: 'waiting'; readonly attempt: number; readonly retryAt: number; readonly reason: ClosedReason | 'failed' }
  /** `close()` was called. Nothing will open again. */
  | { readonly kind: 'closed' }

export interface LinkOptions {
  readonly connect: () => Promise<ShelfChannel>
  /** Injected for tests; defaults to `Math.random` and `Date.now`. */
  readonly random?: () => number
  readonly now?: () => number
}

export interface ShelfLink extends ShelfChannel {
  /** The same object until something changes — `useSyncExternalStore`'s contract. */
  getSnapshot(): LinkState
  subscribe(listener: () => void): () => void
  /**
   * Every channel that opens, the first included. A store that read through
   * a channel that dropped is told here that it can read again.
   */
  onOpened(fn: (channel: ShelfChannel) => void): () => void
  /**
   * Resolves as soon as a channel is open — at once if one is — and rejects
   * with `disconnected`, NOT retryable, once `close()` has been called.
   */
  whenOpen(): Promise<void>
  /** Do not wait out the delay. A no-op unless the link is waiting. */
  retryNow(): void
}

/** The refusal a call gets when there is no channel to carry it. */
function noChannel(service: string, forGood: boolean): ServiceCallError {
  return new ServiceCallError(
    service,
    serviceError(
      ENVELOPE_ERRORS.disconnected,
      forGood ? 'the link to the shelf is closed' : 'the link to the shelf is reconnecting',
      !forGood,
    ),
  )
}

export function openLink(options: LinkOptions): ShelfLink {
  const random = options.random ?? Math.random
  const now = options.now ?? (() => Date.now())

  let state: LinkState = { kind: 'connecting', attempt: 1 }
  let channel: ShelfChannel | null = null
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  /* Which attempt is the live one: a channel that resolves after a newer
   * attempt began, or after `close()`, belongs to nobody and is closed. */
  let epoch = 0

  const listeners = new Set<() => void>()
  const openedListeners = new Set<(channel: ShelfChannel) => void>()
  const closedListeners = new Set<(reason: ClosedReason) => void>()
  const waiters: { resolve: () => void; reject: (cause: unknown) => void }[] = []

  const publish = (next: LinkState) => {
    state = next
    for (const fn of [...listeners]) fn()
  }
  /* Read through a call, because TypeScript keeps a `let`'s narrowing across
   * an `await`, and `close()` runs in the gap. */
  const closed = () => state.kind === 'closed'

  const settleWaiters = (failure: unknown | null) => {
    const held = waiters.splice(0, waiters.length)
    for (const w of held) (failure === null ? w.resolve() : w.reject(failure))
  }

  const schedule = (attempt: number, reason: ClosedReason | 'failed') => {
    const delay = retryDelay(attempt, random)
    publish({ kind: 'waiting', attempt, retryAt: now() + delay, reason })
    timer = setTimeout(() => {
      timer = undefined
      void attemptOpen(attempt + 1)
    }, delay)
  }

  const attemptOpen = async (attempt: number) => {
    if (closed()) return
    const mine = ++epoch
    publish({ kind: 'connecting', attempt })
    let opened: ShelfChannel
    try {
      opened = await options.connect()
    } catch {
      if (closed() || mine !== epoch) return
      schedule(attempt, 'failed')
      return
    }
    if (closed() || mine !== epoch) {
      /* Nobody's now — see `epoch`. Left open it would sit on the shelf's
       * session table for the life of the process, taking a seat. */
      opened.close()
      return
    }
    channel = opened
    generation += 1
    const current = generation
    opened.onClosed((reason) => {
      /* A close reported for a channel that is no longer the link's — the
       * link moved on, or was closed and closed it — is old news. */
      if (channel !== opened) return
      channel = null
      for (const fn of [...closedListeners]) fn(reason)
      if (closed()) return
      /* FROM ONE AGAIN. This channel was open, so the shelf was there a
       * moment ago; the first wait is the short one. */
      schedule(1, reason)
    })
    publish({ kind: 'open', generation: current })
    for (const fn of [...openedListeners]) fn(opened)
    settleWaiters(null)
  }

  void attemptOpen(1)

  return {
    call: (service: string, body: unknown, callOptions?: CallOptions) => {
      if (channel === null) return Promise.reject(noChannel(service, state.kind === 'closed'))
      return channel.call(service, body, callOptions)
    },
    stream: (service: string, body: unknown, callOptions?: CallOptions) => {
      const live = channel
      if (live !== null) return live.stream(service, body, callOptions)
      const forGood = state.kind === 'closed'
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(noChannel(service, forGood)),
          return: () => Promise.resolve({ done: true as const, value: undefined }),
        }),
      }
    },
    close: () => {
      if (state.kind === 'closed') return
      epoch += 1
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      publish({ kind: 'closed' })
      const held = channel
      channel = null
      held?.close()
      settleWaiters(noChannel('link', true))
      listeners.clear()
      openedListeners.clear()
      closedListeners.clear()
    },
    onClosed: (fn) => {
      if (state.kind === 'closed') {
        fn('closed')
        return () => {}
      }
      closedListeners.add(fn)
      return () => closedListeners.delete(fn)
    },
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onOpened: (fn) => {
      openedListeners.add(fn)
      return () => openedListeners.delete(fn)
    },
    whenOpen: () => {
      if (channel !== null) return Promise.resolve()
      if (state.kind === 'closed') return Promise.reject(noChannel('link', true))
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    },
    retryNow: () => {
      if (state.kind !== 'waiting') return
      const { attempt } = state
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      void attemptOpen(attempt + 1)
    },
  }
}
