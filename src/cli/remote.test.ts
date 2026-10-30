import { describe, expect, it } from 'vitest'
import type { Channel } from '../capabilities/peer'
import { remoteCaller } from './remote'

/**
 * THE `--shelf` ADAPTER, at its own boundary.
 *
 * Everything it does is delegate to a `Channel` and translate what comes back.
 * The one behaviour that is not obvious is cancellation: `yield*` is what sends
 * `cancel`, because a `for await` calls the delegated iterator's `return()` on
 * any abrupt exit — and that is the reason this is `yield*` rather than a
 * `while (true)` over `next()`, which would look identical and cancel nothing.
 *
 * The envelope suite proves the effect end to end (the shelf's handler stops).
 * What it cannot show is that THIS adapter is the reason, because there the
 * whole stack is real. Here the channel is a stand-in that records exactly
 * what the adapter asked of it.
 */

/** A channel whose stream records how its iterator was left. */
function channelOver(pages: readonly unknown[]) {
  const state = { returned: 0, pulled: 0, throwCalls: 0 }
  const channel = {
    call: async () => ({ ok: true }),
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (state.pulled >= pages.length) return { value: undefined, done: true as const }
          const value = pages[state.pulled]
          state.pulled += 1
          return { value, done: false as const }
        },
        /* The method a `for await` calls on `break`, `return` or a throw —
         * and the one the real client sends `cancel` from. */
        return: async () => {
          state.returned += 1
          return { value: undefined, done: true as const }
        },
        throw: async (cause: unknown) => {
          state.throwCalls += 1
          throw cause
        },
      }),
    }),
    close: async () => {},
  } as unknown as Channel
  return { channel, state }
}

describe('a stream the caller stops reading', () => {
  /**
   * `break` REACHES THE DELEGATE'S `return()`.
   *
   * This is the whole cancellation mechanism at this layer. A `while (true)`
   * over `next()` reads identically, passes every test that watches the outer
   * iterator, and never cancels anything.
   */
  it('calls return() on the channel’s own iterator when the consumer breaks', async () => {
    const world = channelOver([[1], [2], [3]])
    const caller = remoteCaller({ channel: world.channel, close: async () => {} })
    for await (const _page of caller.stream('book.list', {})) break
    expect(world.state.returned).toBe(1)
    /* And it stopped pulling: one page taken, not three. */
    expect(world.state.pulled).toBe(1)
  })

  it('calls return() when the consumer throws mid-stream', async () => {
    const world = channelOver([[1], [2], [3]])
    const caller = remoteCaller({ channel: world.channel, close: async () => {} })
    await expect(
      (async () => {
        for await (const _page of caller.stream('book.list', {})) throw new Error('stop')
      })(),
    ).rejects.toThrow('stop')
    expect(world.state.returned).toBe(1)
  })

  /* AND A STREAM READ TO THE END DOES NOT CANCEL. Otherwise the assertions
   * above would pass for an adapter that cancels everything — which tells a
   * shelf a completed read was abandoned. */
  it('does not call return() on a stream that ran out', async () => {
    const world = channelOver([[1], [2]])
    const caller = remoteCaller({ channel: world.channel, close: async () => {} })
    const got: unknown[] = []
    for await (const page of caller.stream('book.list', {})) got.push(page)
    expect(got).toHaveLength(2)
    expect(world.state.returned).toBe(0)
  })

  /* EXPLICIT `return()` ON THE OUTER ITERATOR reaches the inner one too — the
   * shape `paper`'s own `drain` uses when it hits its ceiling. */
  it('passes an explicit return() through to the channel', async () => {
    const world = channelOver([[1], [2], [3]])
    const caller = remoteCaller({ channel: world.channel, close: async () => {} })
    const iterator = caller.stream('book.list', {})[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    expect(world.state.returned).toBe(1)
    expect((await iterator.next()).done).toBe(true)
  })
})

describe('what the adapter translates', () => {
  /** A channel whose call and stream both reject with `cause`. */
  const failing = (cause: unknown) =>
    ({
      call: async () => {
        throw cause
      },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          throw cause
          yield []
        },
      }),
      close: async () => {},
    }) as unknown as Channel

  /**
   * A REFUSAL FROM THE SHELF CROSSES AS ITSELF; A DROPPED SESSION DOES NOT.
   *
   * A caller deciding whether to try again needs the difference between "the
   * shelf said no" and "the shelf did not answer" — the first is final, the
   * second may come back.
   */
  const refusalOf = async (channel: Channel, run: (caller: ReturnType<typeof remoteCaller>) => Promise<unknown>) => {
    const caller = remoteCaller({ channel, close: async () => {} })
    return (await run(caller).catch((error: unknown) => error)) as {
      code: string
      message: string
      retryable: boolean
    }
  }

  it('marks a dropped session retryable and names the service', async () => {
    const failure = await refusalOf(failing(new Error('the session was closed')), (caller) => caller.call('book.get', {}))
    expect(failure.code).toBe('disconnected')
    expect(failure.retryable).toBe(true)
    expect(failure.message).toContain('book.get')
  })

  /**
   * NOT EVERYTHING IS A DISCONNECTION.
   *
   * A `TypeError` from a bug in this adapter, or from a malformed channel, was
   * once labelled `disconnected` AND retryable — so a caller retried a
   * programming error forever and the real fault never surfaced. Only what
   * actually came off a session is treated as one.
   */
  it('reports a programming error as internal, and does not invite a retry', async () => {
    const failure = await refusalOf(failing(new TypeError('x is not a function')), (caller) =>
      caller.call('book.get', {}),
    )
    expect(failure.code).toBe('internal')
    expect(failure.retryable).toBe(false)
    expect(failure.message).toContain('not a function')
  })

  it('translates a stream failure exactly as a call’s is translated', async () => {
    const dropped = await refusalOf(failing(new Error('the session was closed')), async (caller) => {
      for await (const _page of caller.stream('book.list', {})) void _page
    })
    expect(dropped).toMatchObject({ code: 'disconnected', retryable: true })
    expect(dropped.message).toContain('book.list')

    const bug = await refusalOf(failing(new TypeError('x is not a function')), async (caller) => {
      for await (const _page of caller.stream('book.list', {})) void _page
    })
    expect(bug).toMatchObject({ code: 'internal', retryable: false })
  })
})
