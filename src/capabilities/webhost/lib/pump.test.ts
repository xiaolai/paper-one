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
  /**
   * The plugin refuses to deliver frames before the webview says it is serving,
   * so announcing after the first poll drops whatever a browser sent between.
   *
   * ⚠️ **THIS PROVED ONLY THAT `ready` WAS CALLED.** Called is not called
   * FIRST, and the order is the whole property — `toHaveBeenCalled` is true of
   * a pump that announced itself after its third poll.
   *
   * What happens while readiness is outstanding, and when it rejects, are two
   * cases of their own further down (`polls nothing until ready resolves`,
   * `polls nothing at all when ready rejects`). This one is about the ORDER,
   * which neither of those states.
   */
  it('tells the plugin it is ready before serving anything', async () => {
    vi.useFakeTimers()
    let announce!: () => void
    const order: string[] = []
    const wire = fakeWire({
      ready: vi.fn(() => {
        order.push('ready')
        return new Promise<void>((resolve) => {
          announce = resolve
        })
      }),
      sessions: vi.fn(async () => {
        order.push('sessions')
        return []
      }),
    })
    const pump = servePipe({ wire, services: [], sessionsMs: 10 })

    /* NOTHING IS POLLED WHILE READINESS IS OUTSTANDING, however long it takes
       and however many intervals would have elapsed. */
    await tick()
    expect(order, 'the pump polled before the plugin said it would deliver').toEqual(['ready'])

    announce()
    await tick()
    expect(order[0]).toBe('ready')
    expect(order.filter((one) => one === 'sessions').length).toBeGreaterThan(0)
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

  /**
   * BACKPRESSURE IS A WAIT, NOT A FAILURE.
   *
   * ⚠️ The plugin used to answer `backpressure` the instant a browser's budget
   * was full, and this pump treated EVERY rejected send as a dead session —
   * `onError`, then `close`. `content.read` yields 512 KiB chunks as fast as
   * IPC accepts them, the session budget is 8 MiB, and every book larger than
   * twelve chunks aborted mid-stream on the phone, under a variant whose own
   * doc said "NOT an error… retry".
   *
   * The wait lives in Rust now (`Pipe::send_wait`): `webhost_send` holds the
   * call until room appears and answers only then. So what this pump has to
   * do is the thing it already did — AWAIT the send — and what it must not do
   * is treat a slow answer as a lost session. The wire below holds the first
   * frame for a while, the way a plugin waiting on a full browser does; the
   * frame must arrive once, late, with nothing reported and nothing closed.
   */
  it('awaits a send the plugin is holding for room, rather than closing the session', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const inbox: Uint8Array[] = []
    const client = createClient({ send: (bytes) => void inbox.push(bytes) })
    let release: (() => void) | undefined
    let sends = 0
    const wire = fakeWire({
      sessions: async () => [{ id: 1 }],
      sessionRecv: async () => inbox.splice(0, inbox.length),
      send: (_session, frame) => {
        sends += 1
        /* ROOM APPEARS LATER. The plugin is parked on its broadcast; the
           promise it handed the webview is still pending. */
        return new Promise<void>((resolve) => {
          release = () => {
            client.receive(frame)
            resolve()
          }
        })
      },
    })
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10, onError })

    const answer = client.call('example.ping', 'a slow phone')
    let settled = false
    void answer.then(() => (settled = true))
    await tick(20)

    /* Held, not failed: the session is still served, nothing was reported,
       and the frame was offered exactly once — the retry is Rust's. */
    expect(settled).toBe(false)
    expect(pump.serving, 'a slow send was taken for a dead session').toBe(1)
    expect(onError).not.toHaveBeenCalled()
    expect(sends).toBe(1)

    release?.()
    await tick()
    expect(await answer).toEqual({ echoed: 'a slow phone' })
    expect(sends).toBe(1)

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

/**
 * THE ONE WRITE, BOUND TO THE BOOK THIS SESSION OPENED (WI-20.30, D7).
 *
 * `book.position` is under `position:write`, which the pump admits — but only
 * for the book the session located, because a browser session's socket is
 * one a hostile book's script could open too. The kernel's OWN services over
 * a real shelf, so the binding is proved against `content.locate` and
 * `book.position` as shipped, and the record is read back through
 * `book.get`.
 */
import { buildServices, createKernelServices, recordPath, sizePortOver, type IndexedBook } from '../../../kernel'
import { fakeFs } from '../../../kernel/testkit'

function realShelf(ids: readonly string[]) {
  const books: IndexedBook[] = ids.map((bookId) => ({ bookId, title: `Title ${bookId}`, author: '', addedAt: 1 }))
  const files = Object.fromEntries(books.map((book) => [recordPath(book.bookId), JSON.stringify(book)]))
  const fs = fakeFs(files)
  const services = createKernelServices({ fs, storage: null, initialBooks: books })
  /* `content.locate` measures through the size port; a shelf with none bound
     is the phase-11 desktop, and not the shape a browser ever meets. */
  services.bindSizePort(
    sizePortOver({
      bytesAt: async (path) => fs.store.get(path)?.byteLength ?? null,
      readDir: async (path) => (await fs.readDir(path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory })),
    }),
  )
  return { services, contributions: buildServices({ services }) }
}

const CFI = 'epubcfi(/6/24!/4/2/1:0)'

describe('book.position through the pump', () => {
  it('lands the position of the book this session opened, and the record carries it', async () => {
    vi.useFakeTimers()
    const { wire, client } = browser()
    const { contributions } = realShelf(['a', 'b'])
    const pump = servePipe({ wire, services: contributions, pollMs: 5, sessionsMs: 10 })

    const located = client.call('content.locate', { book: 'a' })
    await tick()
    await located
    const set = client.call('book.position', { book: 'a', position: CFI, progress: 0.5 })
    await tick()
    expect(await set).toMatchObject({ bookId: 'a', position: CFI, progress: 0.5 })
    const detail = client.call('book.get', { book: 'a' })
    await tick()
    expect(await detail).toMatchObject({ position: CFI, progress: 0.5 })

    pump.stop()
    vi.useRealTimers()
  })

  it('refuses to move any other book, by grant, and the handler never runs', async () => {
    vi.useFakeTimers()
    const { wire, client } = browser()
    const { contributions, services } = realShelf(['a', 'b'])
    const pump = servePipe({ wire, services: contributions, pollMs: 5, sessionsMs: 10 })

    const located = client.call('content.locate', { book: 'a' })
    await tick()
    await located
    /* THE HOSTILE FIXTURE: a second book id in the call. */
    const refused = client.call('book.position', { book: 'b', position: CFI }).then(
      () => 'RESOLVED',
      (thrown: unknown) => String(thrown),
    )
    await tick()
    expect(await refused).toMatch(/forbidden/i)
    expect(services.library.getSnapshot().find((row) => row.bookId === 'b')?.position).toBeUndefined()

    pump.stop()
    vi.useRealTimers()
  })

  it('refuses a session that has opened nothing, and one whose book changed follows the newest locate', async () => {
    vi.useFakeTimers()
    const { wire, client } = browser()
    const { contributions } = realShelf(['a', 'b'])
    const pump = servePipe({ wire, services: contributions, pollMs: 5, sessionsMs: 10 })

    const cold = client.call('book.position', { book: 'a', position: CFI }).then(
      () => 'RESOLVED',
      (thrown: unknown) => String(thrown),
    )
    await tick()
    expect(await cold).toMatch(/forbidden/i)

    for (const book of ['a', 'b']) {
      const located = client.call('content.locate', { book })
      await tick()
      await located
    }
    /* Opened `b` last: `a` is no longer this session's book. */
    const stale = client.call('book.position', { book: 'a', position: CFI }).then(
      () => 'RESOLVED',
      (thrown: unknown) => String(thrown),
    )
    await tick()
    expect(await stale).toMatch(/forbidden/i)
    const current = client.call('book.position', { book: 'b', position: CFI })
    await tick()
    expect(await current).toMatchObject({ bookId: 'b' })

    pump.stop()
    vi.useRealTimers()
  })

  it('still refuses every other write', async () => {
    vi.useFakeTimers()
    const { wire, client } = browser()
    const { contributions } = realShelf(['a'])
    const pump = servePipe({ wire, services: contributions, pollMs: 5, sessionsMs: 10 })
    const located = client.call('content.locate', { book: 'a' })
    await tick()
    await located
    const refused = client.call('book.set', { book: 'a', position: CFI }).then(
      () => 'RESOLVED',
      (thrown: unknown) => String(thrown),
    )
    await tick()
    expect(await refused).toMatch(/forbidden/i)
    pump.stop()
    vi.useRealTimers()
  })
})

describe('audit-fix round 1 — the pump', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('binds the position write to the NEWEST locate by request order, not by which answered last', async () => {
    /* Two locates in flight: the older answers last. The binding used to
       follow completion order, re-pointing the write at a book the browser
       had already left. */
    const answers = new Map<string, () => void>()
    const locate: ServiceContribution = {
      name: 'content.locate',
      grant: 'book:read',
      handler: (req: unknown) =>
        new Promise((resolve) => {
          answers.set((req as { book: string }).book, () => resolve({ located: true }))
        }),
    }
    const moved: string[] = []
    const position: ServiceContribution = {
      name: 'book.position',
      grant: 'position:write',
      handler: async (req: unknown) => {
        moved.push((req as { book: string }).book)
        return {}
      },
    }
    const { wire, client } = browser()
    const pump = servePipe({ wire, services: [locate, position], pollMs: 5, sessionsMs: 10 })
    const older = client.call('content.locate', { book: 'book:old' })
    const newer = client.call('content.locate', { book: 'book:new' })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    answers.get('book:new')!()
    await newer
    answers.get('book:old')!()
    await older
    await client.call('book.position', { book: 'book:new', position: 'cfi', progress: 0.5 })
    await expect(client.call('book.position', { book: 'book:old', position: 'cfi', progress: 0.5 })).rejects.toMatchObject({
      error: { code: 'forbidden' },
    })
    expect(moved).toEqual(['book:new'])
    pump.stop()
  })

  it('refuses an interval that is not a positive finite number', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => servePipe({ wire: fakeWire(), services: [], pollMs: bad })).toThrow(/pollMs/)
      expect(() => servePipe({ wire: fakeWire(), services: [], sessionsMs: bad })).toThrow(/sessionsMs/)
    }
  })

  it('never has two reconciliations in flight, however slow the plugin answers', async () => {
    /* `setInterval` fired the next pass while the previous `sessions()` was
       still pending; two snapshots landing out of order could close a current
       session or reopen a departed one. The next pass is armed only after the
       last one settled. */
    let inFlight = 0
    let peak = 0
    const wire = fakeWire({
      sessions: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => setTimeout(resolve, 30))
        inFlight -= 1
        return []
      },
    })
    const pump = servePipe({ wire, services: [], sessionsMs: 5 })
    await new Promise<void>((resolve) => setTimeout(resolve, 120))
    pump.stop()
    expect(peak).toBe(1)
  })

  it('a reporter that throws does not strand the session, and the loop reports the plugin failure once', async () => {
    let asked = 0
    const wire = fakeWire({
      sessions: async () => [{ id: 7 }],
      sessionRecv: async () => {
        asked += 1
        throw new Error('ipc gone')
      },
    })
    const reported: unknown[] = []
    const pump = servePipe({
      wire,
      services: [],
      pollMs: 5,
      sessionsMs: 1000,
      onError: (thrown) => {
        reported.push(thrown)
        throw new Error('the reporter itself is broken')
      },
    })
    await tick()
    await tick()
    await tick()
    /* The session was opened, its drain failed, and the failure path CLOSED
       it before reporting — so a throwing reporter cannot leave the record
       in `live`, which is what used to make the failure permanent. */
    expect(reported.map((one) => (one as Error).message)).toContain('ipc gone')
    expect(pump.serving).toBe(0)
    expect(asked).toBe(1)
    pump.stop()
  })
})

describe('a router that hung up on its own', () => {
  it('lets go of the session, so the next reconciliation serves the browser afresh', async () => {
    /* A browser that stops reading: writes queue on the router's outbound
       chain until its budget overflows and the router disconnects — a decision
       taken inside the envelope, which the pump could not hear until
       `onDisconnect` existed (audit #61). Without it the dead connection kept
       its record, the plugin went on reporting the socket, and every later
       request drained into a router answered by nobody. A stalled `send`
       models the browser; the tiny budget makes the overflow cheap; the
       browser then starts reading again and asks once more. */
    vi.useFakeTimers()
    const { wire, client } = browser()
    const delivering = wire.send
    wire.send = async () => new Promise<void>(() => {})
    const pump = servePipe({ wire, services: [PING], pollMs: 5, sessionsMs: 10, maxOutboundBytes: 600 })
    await tick()
    expect(pump.serving).toBe(1)

    for (let i = 0; i < 40; i++) void client.call('example.ping', { i }).catch(() => {})
    await tick()

    /* The browser reads again. The old connection is gone either way; only a
       pump that heard the hang-up has let the record go, so that the next
       reconciliation opens a fresh one and this call is answered. */
    wire.send = delivering
    await tick()
    const again = client.call('example.ping', { again: true })
    await tick()
    expect(await again).toEqual({ echoed: { again: true } })

    pump.stop()
    vi.useRealTimers()
  })
})
