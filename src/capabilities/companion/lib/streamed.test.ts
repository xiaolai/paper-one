import { describe, expect, it } from 'vitest'
import { streamed } from './streamed'

/** A promise the test opens when it wants the operation to proceed. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

const drain = async <T,>(stream: AsyncGenerator<T, void>): Promise<T[]> => {
  const got: T[] = []
  for await (const chunk of stream) got.push(chunk)
  return got
}

/**
 * THE BRIDGE BETWEEN A PUSHING TRANSPORT AND A PULLING CONSUMER.
 *
 * This was thirty lines inside `ask`, between route dispatch and citation
 * resolution, and every case below was uncovered there — including the one
 * that mattered, where a rejection carrying `null` resolved the whole turn as
 * a success.
 */
describe('streamed', () => {
  it('yields nothing for an operation that pushes nothing', async () => {
    expect(await drain(streamed<string>(async () => {}))).toEqual([])
  })

  it('yields every chunk, in order', async () => {
    const got = await drain(
      streamed<string>(async (push) => {
        push('a')
        push('b')
        push('c')
      }),
    )
    expect(got).toEqual(['a', 'b', 'c'])
  })

  /* ⚠️ CHUNKS PUSHED IN THE SAME TICK AS COMPLETION ARE STILL DELIVERED. The
     loop's condition is `!finished || pending.length > 0`; on `!finished`
     alone the tail of an answer disappears whenever the transport resolves
     without yielding to the scheduler first — which is exactly what a fast
     local model does. */
  it('delivers chunks queued at the moment it finishes', async () => {
    const got = await drain(
      streamed<string>(async (push) => {
        push('the whole')
        push(' answer at once')
      }),
    )
    expect(got.join('')).toBe('the whole answer at once')
  })

  /* Nothing is dropped between two `next()` calls: the consumer is parked
     while the transport pushes, and both chunks survive the wait. */
  it('holds what arrives while nobody is asking', async () => {
    const gate = deferred()
    const stream = streamed<string>(async (push) => {
      await gate.promise
      push('first')
      push('second')
    })
    /* Started, then parked: the first `next()` finds nothing queued and waits,
       which is the state under test. The gate opens from outside it. */
    const draining = drain(stream)
    await Promise.resolve()
    gate.open()
    expect(await draining).toEqual(['first', 'second'])
  })

  it('raises what the operation raised', async () => {
    const stream = streamed<string>(async () => {
      throw new Error('the daemon went away')
    })
    await expect(drain(stream)).rejects.toThrow(/went away/)
  })

  /**
   * ⚠️ WHAT ARRIVED BEFORE THE FAILURE IS STILL DELIVERED, AND THEN IT FAILS.
   *
   * The consumer has already shown those words. An answer that fails halfway
   * must fail after them rather than instead of them.
   */
  it('yields what it buffered before it raises', async () => {
    const stream = streamed<string>(async (push) => {
      push('It begins')
      push(' and then')
      throw new Error('the daemon went away')
    })
    const before: string[] = []
    let raised: unknown = null
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done === true) break
        before.push(step.value)
      }
    } catch (error) {
      raised = error
    }
    expect(before.join(''), 'the partial answer was dropped on the way to the failure').toBe(
      'It begins and then',
    )
    expect((raised as Error | null)?.message).toMatch(/went away/)
  })

  /**
   * ⚠️ A REJECTION IS A REJECTION WHATEVER IT CARRIES.
   *
   * `null` was the "nothing failed" sentinel, and `null` is a value a
   * rejection can carry. Each of these was caught, left the sentinel
   * unchanged, and resolved as a success carrying half an answer — the
   * quietest possible way to lose one.
   */
  it.each([[null], [undefined], [0], [''], [false], [Number.NaN]])(
    'raises a rejection that carries %p',
    async (thrown) => {
      const stream = streamed<string>(async (push) => {
        push('half')
        return Promise.reject(thrown)
      })
      /* THAT it rejected, not what WITH — `undefined` is one of the values
         under test, so asserting on the value would pass for the wrong
         reason. */
      let rejected = false
      try {
        await drain(stream)
      } catch {
        rejected = true
      }
      expect(rejected, 'a failed operation was delivered as a finished one').toBe(true)
    },
  )

  /* The operation's own resolved value is not the result — the chunks are.
     A transport that returned the whole text as well would give one answer
     two sources of truth. */
  it('ignores what the operation resolves to', async () => {
    const got = await drain(
      streamed<string>(async (push) => {
        push('streamed')
        return 'a different, whole answer'
      }),
    )
    expect(got).toEqual(['streamed'])
  })
})
