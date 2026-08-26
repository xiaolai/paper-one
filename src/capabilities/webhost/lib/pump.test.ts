import { describe, expect, it, vi } from 'vitest'
import { createClient, type ServiceContribution } from '../../../kernel'
import { servePipe } from './pump'
import { fakeWire, type BrowserSession, type WebHostWire } from './wire'

/**
 * A browser on one side, the pump on the other, speaking the real envelope.
 *
 * The client's frames go into `inbox` and come out through `sessionRecv`; the
 * pump's answers arrive through `send` and go straight into `client.receive`.
 * Nothing is stubbed between them, so a passing call here really did cross the
 * envelope and reach a handler.
 */
function browser(sessionId = 1) {
  const inbox: Uint8Array[] = []
  let sessions: BrowserSession[] = [{ id: sessionId }]
  const client = createClient({ send: (bytes) => void inbox.push(bytes) })

  const wire: WebHostWire = fakeWire({
    sessions: async () => sessions,
    sessionRecv: async (session) => {
      if (session !== sessionId) return []
      const taken = inbox.splice(0, inbox.length)
      return taken
    },
    send: async (session, frame) => {
      if (session === sessionId) client.receive(frame)
    },
  })

  return {
    wire,
    client,
    /** The browser goes away, as `webhost_sessions` would then report. */
    disconnect: () => {
      sessions = []
    },
  }
}

const PING: ServiceContribution = {
  name: 'example.ping',
  /* A READ grant, and it matters. The pump answers `hasGrant` with the
     kernel's `readingGrant` predicate, so this service is reachable from a
     browser and `DESTROY` below is not. */
  grant: 'book:read',
  handler: async (req: unknown) => ({ echoed: req }),
}

/**
 * A WRITE service, to prove the browser cannot reach one.
 *
 * `content.evict` is the real one this stands for: it deletes a book's bytes,
 * and it was reachable from any signed-in browser because the pump answered
 * `hasGrant: () => true`. The handler records being called, because "the
 * request was refused" and "the request ran and its answer was discarded" look
 * identical from the client and are opposite facts.
 */
const destroyed: unknown[] = []
const DESTROY: ServiceContribution = {
  name: 'example.destroy',
  grant: 'book:write',
  handler: async (req: unknown) => {
    destroyed.push(req)
    return { gone: true }
  },
}

/** Let the pump's timers run without waiting on real ones. */
const tick = async (times = 6) => {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(10)
  }
}

describe('servePipe', () => {
  it('tells the plugin it is ready before serving anything', async () => {
    /* The plugin refuses to deliver frames before the webview says it is
       serving. Announcing after the first poll would drop whatever a browser
       sent in between. */
    const ready = vi.fn(async () => {})
    const pump = servePipe({ wire: fakeWire({ ready }), services: [] })
    await Promise.resolve()
    expect(ready).toHaveBeenCalled()
    pump.stop()
  })

  it('carries a real call from a browser to a handler and back', async () => {
    /* THE WHOLE POINT. Before this existed a browser signed in, opened its
       channel, called a service and waited for ever — the frames landed in an
       inbox nobody drained. */
    vi.useFakeTimers()
    const { wire, client } = browser()
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10 })

    const answer = client.call('example.ping', { hello: true })
    await tick()
    expect(await answer).toEqual({ echoed: { hello: true } })

    pump.stop()
    vi.useRealTimers()
  })

  /**
   * THE GRANT IS READ, AND ONLY READ.
   *
   * The pump used to answer `hasGrant: () => true`, on the argument that a
   * browser holds one grant — "signed in" — and that browsers do not differ
   * from one another. Both true, and neither says what that single grant
   * PERMITS: the answer was every service the shelf composes, including
   * `content.evict`, `book.remove` and `trash.empty`.
   *
   * It matters most because of who shares the origin. foliate renders a book
   * in a same-origin iframe with `allow-same-origin allow-scripts`; a hostile
   * EPUB cannot read the `HttpOnly` credential, but it can open the socket
   * itself and the browser attaches the cookie for it.
   */
  it('refuses a write service, and the handler never runs', async () => {
    vi.useFakeTimers()
    destroyed.length = 0
    const { wire, client } = browser()
    const pump = servePipe({ wire, services: [PING, DESTROY], pollMs: 5, sessionsMs: 10 })

    const refused = client.call('example.destroy', { book: 'aaa' }).then(
      () => 'RESOLVED',
      (thrown: unknown) => String(thrown),
    )
    await tick()
    expect(await refused).toMatch(/forbidden/i)
    /* NEVER RAN. A refusal that arrives after the handler did its work is not
       a refusal — the bytes are already gone. */
    expect(destroyed).toEqual([])

    /* And a READ still works, so this is a grant check and not a dead pump. */
    const answer = client.call('example.ping', { hello: true })
    await tick()
    expect(await answer).toEqual({ echoed: { hello: true } })

    pump.stop()
    vi.useRealTimers()
  })

  it('serves a browser that arrives after it started', async () => {
    vi.useFakeTimers()
    const inbox: Uint8Array[] = []
    let sessions: BrowserSession[] = []
    const client = createClient({ send: (bytes) => void inbox.push(bytes) })
    const wire = fakeWire({
      sessions: async () => sessions,
      sessionRecv: async () => inbox.splice(0, inbox.length),
      send: async (_session, frame) => client.receive(frame),
    })
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10 })
    await tick(2)
    expect(pump.serving).toBe(0)

    sessions = [{ id: 7 }]
    const answer = client.call('example.ping', 'late')
    await tick()
    expect(await answer).toEqual({ echoed: 'late' })

    pump.stop()
    vi.useRealTimers()
  })

  it('tears down a session that went away', async () => {
    /* Without this a revoked browser's router connection stays live in the
       webview, holding whatever its in-flight handlers hold, for as long as the
       app runs. */
    vi.useFakeTimers()
    const { wire, disconnect } = browser()
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10 })
    await tick()
    expect(pump.serving).toBe(1)

    disconnect()
    await tick()
    expect(pump.serving).toBe(0)

    pump.stop()
    vi.useRealTimers()
  })

  it('stops reading a session whose recv keeps failing', async () => {
    /* A dead session must not spin. Reporting once and standing down is the
       difference between a warning and a busy loop nobody notices until the
       fan does. */
    vi.useFakeTimers()
    const onError = vi.fn()
    const wire = fakeWire({
      sessions: async () => [{ id: 1 }],
      sessionRecv: async () => {
        throw new Error('session is gone')
      },
    })
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 1000, onError })
    await tick()
    const after = onError.mock.calls.length
    await tick(10)
    expect(onError.mock.calls.length, 'the drain kept retrying a dead session').toBe(after)

    pump.stop()
    vi.useRealTimers()
  })

  /**
   * ⚠️ **A TRANSIENT FAILURE USED TO BE PERMANENT.**
   *
   * The drain aborted and reported, and the record stayed in `live` — so the
   * next reconciliation saw the id as already served and did nothing, for the
   * life of the app. One IPC hiccup stopped serving that browser for ever,
   * while the plugin went on reporting its socket and buffering its frames.
   *
   * The test above pins that a DEAD session stops spinning. This pins the other
   * half: a session that recovers is served again.
   */
  it('serves a session again after a transient recv failure', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    let fail = true
    let reads = 0
    const wire = fakeWire({
      sessions: async () => [{ id: 1 }],
      sessionRecv: async () => {
        if (fail) throw new Error('one hiccup')
        reads += 1
        return []
      },
    })
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10, onError })
    await tick()
    expect(onError, 'the failure was not reported').toHaveBeenCalled()

    /* THE RECOVERY IS THE ASSERTION. The plugin still reports the session, so
       once reads succeed again the pump must be reading it — which it cannot be
       if the failed record was left in `live`, because reconciliation would see
       an id it believed was already served and do nothing, for ever.

       Retrying happens at the RECONCILE cadence, not the poll cadence, so a
       permanently dead session costs one attempt per sweep rather than a spin —
       which is what `stops reading a session whose recv keeps failing` pins. */
    fail = false
    reads = 0
    await tick(10)
    expect(reads, 'a session that recovered was never read again').toBeGreaterThan(0)

    pump.stop()
    vi.useRealTimers()
  })

  /**
   * READINESS GATES THE POLL, and it only gated the FIRST one.
   *
   * `setInterval` was armed unconditionally on the line after `ready()`, so a
   * poll could land before the plugin had been told the webview was serving —
   * the exact ordering the comment there promises — and went on polling for
   * ever if `ready` REJECTED, which is the case where the plugin will never
   * deliver anything at all.
   */
  it('polls nothing until ready resolves', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const sessions = vi.fn(async () => [] as { id: number }[])
    const pump = servePipe({
      wire: fakeWire({ ready: () => held, sessions }),
      services: [],
      pollMs: 5,
      sessionsMs: 10,
    })

    await tick(10)
    expect(sessions, 'a poll landed before the plugin was told we were serving').not.toHaveBeenCalled()

    release?.()
    await tick(4)
    expect(sessions).toHaveBeenCalled()
    pump.stop()
    vi.useRealTimers()
  })

  it('polls nothing at all when ready rejects', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const sessions = vi.fn(async () => [] as { id: number }[])
    const pump = servePipe({
      wire: fakeWire({
        ready: async () => {
          throw new Error('the plugin is not there')
        },
        sessions,
      }),
      services: [],
      pollMs: 5,
      sessionsMs: 10,
      onError,
    })

    await tick(10)
    expect(onError).toHaveBeenCalled()
    expect(sessions, 'polling a plugin that will never deliver is a timer nobody stops').not.toHaveBeenCalled()
    pump.stop()
    vi.useRealTimers()
  })

  it('reports a failure to list sessions rather than throwing into a timer', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const wire = fakeWire({
      sessions: async () => {
        throw new Error('plugin unavailable')
      },
    })
    const pump = servePipe({ wire, services: [], pollMs: 5, sessionsMs: 10, onError })
    await tick()
    expect(onError).toHaveBeenCalled()
    pump.stop()
    vi.useRealTimers()
  })

  it('serves nothing more after stop', async () => {
    vi.useFakeTimers()
    const { wire, client } = browser()
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10 })
    await tick()
    pump.stop()
    expect(pump.serving).toBe(0)

    const answer = client.call('example.ping', 'after').catch((e: unknown) => e)
    await tick(4)
    /* Nothing answers, so the call is still pending rather than resolved — the
       pump is not quietly half-alive. */
    let settled = false
    void Promise.resolve(answer).then(() => (settled = true))
    await tick(2)
    expect(settled).toBe(false)

    vi.useRealTimers()
  })
})
