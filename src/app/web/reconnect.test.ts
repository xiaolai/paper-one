import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShelfChannel, ClosedReason } from './channel'
import { ServiceCallError } from '../../kernel/core/envelope'
import { MAX_DELAY_MS, BASE_DELAY_MS, openLink, retryDelay } from './reconnect'

/**
 * THE LINK THAT COMES BACK (WI-20.30).
 *
 * `Shelf` called `connect()` once, with `[]` deps, and nothing re-ran it when
 * the socket closed: the next `content.read` failed and the phone stopped for
 * good, showing a page it could not turn. The link owns the socket's
 * lifetime instead — it reconnects with a bounded, jittered backoff, says
 * what it is doing so the UI can, and tells the stores when a channel is back
 * so they can ask again.
 */

/** A channel the test can drop, with the calls it was handed. */
function fakeChannel(name: string) {
  const closed = new Set<(reason: ClosedReason) => void>()
  const calls: string[] = []
  let shut: ClosedReason | null = null
  const channel: ShelfChannel & { readonly name: string; drop(reason?: ClosedReason): void; readonly calls: string[] } = {
    name,
    calls,
    call: async (service) => {
      calls.push(service)
      return { from: name }
    },
    stream: (service) => ({
      [Symbol.asyncIterator]: async function* () {
        calls.push(service)
        yield [{ from: name }]
      },
    }),
    close: () => {
      shut = 'closed'
    },
    onClosed: (fn) => {
      if (shut !== null) {
        fn(shut)
        return () => {}
      }
      closed.add(fn)
      return () => closed.delete(fn)
    },
    drop: (reason: ClosedReason = 'lost') => {
      shut = reason
      for (const fn of [...closed]) fn(reason)
      closed.clear()
    },
  }
  return channel
}

/** A `connect` that answers from a script: a channel, or a rejection. */
function connector(script: readonly (string | Error)[]) {
  const opened: ReturnType<typeof fakeChannel>[] = []
  let at = 0
  const connect = async (): Promise<ShelfChannel> => {
    const step = script[Math.min(at, script.length - 1)]!
    at += 1
    if (step instanceof Error) throw step
    const channel = fakeChannel(step)
    opened.push(channel)
    return channel
  }
  return { connect, opened, attempts: () => at }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('retryDelay', () => {
  it('doubles from the base and stops at the cap', () => {
    const even = () => 0.5
    expect(retryDelay(1, even)).toBe(BASE_DELAY_MS)
    expect(retryDelay(2, even)).toBe(BASE_DELAY_MS * 2)
    expect(retryDelay(3, even)).toBe(BASE_DELAY_MS * 4)
    expect(retryDelay(20, even)).toBe(MAX_DELAY_MS)
  })

  it('is jittered by a quarter either way, so a fleet of phones does not knock at once', () => {
    expect(retryDelay(1, () => 0)).toBe(BASE_DELAY_MS * 0.75)
    expect(retryDelay(1, () => 1)).toBe(BASE_DELAY_MS * 1.25)
  })
})

describe('openLink', () => {
  it('opens on creation and carries calls to the channel it opened', async () => {
    const { connect, opened } = connector(['first'])
    const link = openLink({ connect, random: () => 0.5 })
    expect(link.getSnapshot()).toEqual({ kind: 'connecting', attempt: 1 })
    await flush()
    expect(link.getSnapshot()).toEqual({ kind: 'open', generation: 1 })
    expect(await link.call('book.list', {})).toEqual({ from: 'first' })
    expect(opened[0]!.calls).toEqual(['book.list'])
    link.close()
  })

  it('retries a connection that could not be made, waiting longer each time and never past the cap', async () => {
    const { connect, attempts } = connector([new Error('no'), new Error('no'), new Error('no'), 'third'])
    const seen: unknown[] = []
    const link = openLink({ connect, random: () => 0.5, now: () => 100 })
    link.subscribe(() => seen.push(link.getSnapshot()))
    await flush()
    /* `retryAt` is on the injected clock, so a screen can count down to it. */
    expect(link.getSnapshot()).toMatchObject({ kind: 'waiting', attempt: 1, retryAt: 100 + BASE_DELAY_MS })
    /* NOT YET. A retry before its time is a phone hammering a shelf that is
       asleep; the wait is the point. */
    await vi.advanceTimersByTimeAsync(BASE_DELAY_MS - 1)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts()).toBe(2)
    await flush()
    expect(link.getSnapshot()).toMatchObject({ kind: 'waiting', attempt: 2 })
    await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 2)
    expect(attempts()).toBe(3)
    await flush()
    await vi.advanceTimersByTimeAsync(BASE_DELAY_MS * 4)
    await flush()
    expect(link.getSnapshot()).toEqual({ kind: 'open', generation: 1 })
    /* Every step was published, so a screen can say "trying again in …". */
    expect(seen.map((s) => (s as { kind: string }).kind)).toEqual([
      'waiting',
      'connecting',
      'waiting',
      'connecting',
      'waiting',
      'connecting',
      'open',
    ])
    link.close()
  })

  it('reconnects after the socket drops, tells the stores, and resolves whoever was waiting', async () => {
    const { connect, opened } = connector(['first', 'second'])
    const link = openLink({ connect, random: () => 0.5 })
    const openings: string[] = []
    const closings: ClosedReason[] = []
    link.onOpened((channel) => openings.push((channel as unknown as { name: string }).name))
    link.onClosed((reason) => closings.push(reason))
    await flush()
    expect(openings).toEqual(['first'])

    opened[0]!.drop('lost')
    expect(closings).toEqual(['lost'])
    expect(link.getSnapshot()).toMatchObject({ kind: 'waiting', attempt: 1, reason: 'lost' })
    const waited = link.whenOpen().then(() => 'back')

    await vi.advanceTimersByTimeAsync(BASE_DELAY_MS)
    await flush()
    expect(link.getSnapshot()).toEqual({ kind: 'open', generation: 2 })
    expect(await waited).toBe('back')
    expect(openings).toEqual(['first', 'second'])
    /* And the calls go to the NEW channel. */
    expect(await link.call('book.list', {})).toEqual({ from: 'second' })
    link.close()
  })

  it('refuses a call made while it is waiting, at once and as retryable, rather than queueing it into the dark', async () => {
    const { connect, opened } = connector(['first', 'second'])
    const link = openLink({ connect, random: () => 0.5 })
    await flush()
    opened[0]!.drop()
    const failure = (await link.call('book.list', {}).catch((e: unknown) => e)) as ServiceCallError
    expect(failure).toBeInstanceOf(ServiceCallError)
    expect(failure.error.code).toBe('disconnected')
    expect(failure.error.retryable).toBe(true)

    const stream = link.stream('book.list', {})[Symbol.asyncIterator]()
    const streamed = (await stream.next().catch((e: unknown) => e)) as ServiceCallError
    expect(streamed.error.retryable).toBe(true)
    link.close()
  })

  it('whenOpen resolves at once while it is open', async () => {
    const { connect } = connector(['first'])
    const link = openLink({ connect, random: () => 0.5 })
    await flush()
    let resolved = false
    void link.whenOpen().then(() => (resolved = true))
    await flush()
    expect(resolved).toBe(true)
    link.close()
  })

  it('tries now when asked, instead of waiting out the delay', async () => {
    const { connect, attempts } = connector([new Error('no'), 'second'])
    const link = openLink({ connect, random: () => 0.5 })
    await flush()
    expect(attempts()).toBe(1)
    link.retryNow()
    await flush()
    expect(attempts()).toBe(2)
    expect(link.getSnapshot()).toEqual({ kind: 'open', generation: 1 })
    /* Only one attempt — the scheduled one was cancelled by the manual one. */
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS)
    expect(attempts()).toBe(2)
    link.close()
  })

  it('closing ends it for good: no more attempts, waiters refused, the channel closed', async () => {
    const { connect, attempts, opened } = connector(['first', 'second'])
    const link = openLink({ connect, random: () => 0.5 })
    await flush()
    opened[0]!.drop()
    const waited = link.whenOpen().catch((e: unknown) => e)
    link.close()
    expect(link.getSnapshot()).toEqual({ kind: 'closed' })
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS * 2)
    expect(attempts()).toBe(1)
    const refused = (await waited) as ServiceCallError
    expect(refused).toBeInstanceOf(ServiceCallError)
    /* NOT retryable now: there will never be a channel again. */
    expect(refused.error.retryable).toBe(false)
    const late = (await link.call('book.list', {}).catch((e: unknown) => e)) as ServiceCallError
    expect(late.error.retryable).toBe(false)
  })

  it('closes a channel that opened after close was asked for, rather than leaking it', async () => {
    let resolveConnect: ((channel: ShelfChannel) => void) | null = null
    const channel = fakeChannel('late')
    const closedByLink = vi.spyOn(channel, 'close')
    const link = openLink({
      connect: () => new Promise<ShelfChannel>((resolve) => (resolveConnect = resolve)),
      random: () => 0.5,
    })
    link.close()
    resolveConnect!(channel)
    await flush()
    expect(closedByLink).toHaveBeenCalledOnce()
    expect(link.getSnapshot()).toEqual({ kind: 'closed' })
  })

  it('counts attempts from one again after a channel that had opened drops', async () => {
    const { connect, opened } = connector(['first', new Error('no'), 'third'])
    const link = openLink({ connect, random: () => 0.5 })
    await flush()
    opened[0]!.drop()
    expect(link.getSnapshot()).toMatchObject({ kind: 'waiting', attempt: 1 })
    await vi.advanceTimersByTimeAsync(BASE_DELAY_MS)
    await flush()
    expect(link.getSnapshot()).toMatchObject({ kind: 'waiting', attempt: 2 })
    link.close()
  })
})

describe('what the audit-fix round found', () => {
  it('never waits past the cap, jitter included', () => {
    /* The clamp used to run BEFORE the jitter, so the "longest wait" reached
     * 37.5 s — a quarter past the constant's own promise. */
    expect(retryDelay(20, () => 1)).toBe(MAX_DELAY_MS)
    expect(retryDelay(20, () => 0)).toBe(MAX_DELAY_MS * 0.75)
  })

  it('does not announce a channel that died before the link could subscribe', async () => {
    /* `channel.onClosed` answers SYNCHRONOUSLY for a socket that died between
     * `connect` resolving and the subscription — its own contract. The link
     * used to publish `open` on top of that answer: state said open, the
     * channel was null, the stores were handed a dead channel, and a waiter
     * resolved into a call that could only fail. */
    const dead = fakeChannel('dead')
    dead.drop('lost')
    const live = fakeChannel('live')
    let at = 0
    const seen: string[] = []
    const handed: string[] = []
    const link = openLink({
      connect: async () => (at++ === 0 ? dead : live),
      random: () => 0.5,
    })
    link.subscribe(() => void seen.push(link.getSnapshot().kind))
    link.onOpened((channel) => void handed.push((channel as unknown as { name: string }).name))
    await flush()
    expect(seen).not.toContain('open')
    expect(handed).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(link.getSnapshot().kind).toBe('open')
    expect(handed).toEqual(['live'])
  })

  it('a listener that retries the moment the wait is announced does not double the attempts', async () => {
    /* The wait used to be published BEFORE its timer existed, so a subscriber
     * calling `retryNow()` synchronously could not cancel it: two attempts
     * raced, and the timer's epoch bump cancelled the retry mid-connect. */
    const script = connector([new Error('down'), 'back'])
    const link = openLink({ connect: script.connect, random: () => 0.5, now: () => 0 })
    link.subscribe(() => {
      if (link.getSnapshot().kind === 'waiting') link.retryNow()
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(link.getSnapshot().kind).toBe('open')
    expect(script.attempts()).toBe(2)
  })

  it('tells the subscribers it already had when it is closed', async () => {
    /* `onClosed` answered a listener added AFTER the close; the ones present
     * AT the close heard nothing — the underlying channel's callback is
     * rightly ignored once the link has moved on, and the set was cleared. */
    const link = openLink({ connect: connector(['a']).connect, random: () => 0.5 })
    await flush()
    const reasons: string[] = []
    link.onClosed((reason) => void reasons.push(reason))
    link.close()
    expect(reasons).toEqual(['closed'])
  })

  /**
   * ⚠️ **`closed` WAS ANNOUNCED WHILE THE CHANNEL WAS STILL LIVE.**
   *
   * `publish` runs its subscribers synchronously, and `close()` published the
   * terminal state before it nulled the channel — so a screen reacting to
   * "closed" by making one last call had its frame carried out on the socket
   * this very line was about to close. The same shape as the timer in
   * `schedule`: the invariant has to hold before anybody is told about it.
   */
  it('carries no call made by a subscriber hearing about the close', async () => {
    const script = connector(['a'])
    const link = openLink({ connect: script.connect, random: () => 0.5 })
    await flush()
    let refusal: unknown = null
    link.subscribe(() => {
      if (link.getSnapshot().kind !== 'closed') return
      void link.call('book.list', {}).catch((thrown: unknown) => void (refusal = thrown))
    })
    link.close()
    await flush()
    expect(script.opened[0]!.calls).toEqual([])
    expect(refusal).toBeInstanceOf(ServiceCallError)
    /* AND IT IS FINAL, not "reconnecting" — there is no channel coming. */
    expect((refusal as ServiceCallError).error.retryable).toBe(false)
  })

  it('a subscriber that throws does not end reconnection', async () => {
    /* Listeners run inside the link's own state machine; unguarded, one throw
     * unwound `schedule` before its timer armed and no attempt was ever timed
     * again. */
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const script = connector(['a', 'b'])
      const link = openLink({ connect: script.connect, random: () => 0.5 })
      link.subscribe(() => {
        throw new Error('a broken screen')
      })
      await flush()
      script.opened[0]!.drop('lost')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(link.getSnapshot().kind).toBe('open')
      expect(script.attempts()).toBe(2)
    } finally {
      quiet.mockRestore()
    }
  })
})
