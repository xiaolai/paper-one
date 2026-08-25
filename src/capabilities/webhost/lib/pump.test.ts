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
  /* The router checks grants through `hasGrant`, which the pump answers true
     for — a browser holds one grant, "signed in", and the credential is the
     gate. The field is still required by the type, so it is stated. */
  grant: 'book:read',
  handler: async (req: unknown) => ({ echoed: req }),
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
