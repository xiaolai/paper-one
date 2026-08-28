import { SERVICE_ERRORS, createRouter, readingGrant, refuse, type ServiceContribution } from '../../../kernel'
import type { WebHostWire } from './wire'

/**
 * The webview's half of the frame pipe (phase 18).
 *
 * A browser's frames land in a session inbox in Rust. **Something has to take
 * them out**, and until this existed nothing did: a browser signed in, opened
 * its channel, called `book.list`, and waited for ever. The client showed
 * "Loading…" and was right to. Over plain HTTP the client never got past the
 * gate, so the open loop was invisible for three commits.
 *
 * This is the other end: drain each session, hand the bytes to a router built
 * over the kernel's own services, and send the answers back.
 *
 * ## One drain per session at a time, and why that is not optional
 *
 * `createPeerPort`'s note says it plainly, and it applies here unchanged: "two
 * overlapping drains would interleave their delivery order across awaits, and
 * frame order is the envelope's ground." So each session has one loop, a rerun
 * flag rather than a second loop, and an abort that stops it at once.
 *
 * ## Polling, and what it costs
 *
 * `webhost_session_recv` WAITS — up to a second — for a frame and answers the
 * instant one lands; empty means "nothing in that second". So this polls, but
 * at one round trip per idle second, and a request's first frame is answered
 * as soon as it arrives rather than after a timer (the `drain` note below
 * records the measured cost of the 40 ms timer this replaced).
 *
 * **The improvement is named rather than left to be discovered:** the peer
 * plugin wakes its drain from a Tauri event, and this should too. That is a
 * change in the Rust plugin (a notify on the inbox, and an emit), and it was
 * left out of the first working version deliberately — a pipe that works
 * slowly is a thing to measure, and a pipe that does not work is not.
 */

/** How often a live session's inbox is checked. */
const POLL_MS = 40
/** How often the session list is re-read, to notice a browser arriving. */
const SESSIONS_MS = 500

export interface PumpOptions {
  readonly wire: WebHostWire
  readonly services: Iterable<ServiceContribution>
  /** Injected by tests; both default to the constants above. */
  readonly pollMs?: number
  readonly sessionsMs?: number
  readonly onError?: (thrown: unknown) => void
  /**
   * The router's per-connection outbound budget, for tests: the router hangs
   * up on its own when a browser stops reading, and the pump must hear it
   * (`onDisconnect`). The default is the router's.
   */
  readonly maxOutboundBytes?: number
}

export interface Pump {
  /** How many browser sessions are being served right now. */
  readonly serving: number
  stop(): void
}

/**
 * Serve the router to every browser that connects, until stopped.
 *
 * ## A browser gets ONE grant, and that grant is READ
 *
 * Unlike `peer`, whose peers carry per-peer grants from `peers.json`, every
 * browser here is the same: the six digits and the cookie are the gate, and
 * `Sessions::admit` is where a revocation lands. Pretending browsers differ
 * from one another would be a permission surface with one value in it.
 *
 * ⚠️ **THAT ARGUMENT USED TO END IN `hasGrant: () => true`, WHICH IS A
 * DIFFERENT CLAIM.** "Browsers do not differ from each other" says nothing
 * about what the single grant permits, and the answer was *everything the
 * shelf composes* — `content.evict`, `book.remove`, `trash.empty`,
 * `device.forget`, every write in the table. A phone that signed in once could
 * empty the library.
 *
 * It is worse than it sounds, because of who else is in the origin. foliate
 * renders a book in a same-origin iframe with `allow-same-origin
 * allow-scripts`, so a hostile EPUB's script shares this page's origin. It
 * cannot READ the credential — the cookie is `HttpOnly`, and
 * `rendererIsolation.test.ts` holds that — but it never needed to: it can open
 * `wss://…/ws` itself and the browser attaches the cookie for it. Withholding
 * the credential from a book and then handing its socket the whole write
 * surface defeats the point of withholding it.
 *
 * So the grant is `readingGrant` — the kernel's own read/write split, the same
 * predicate `readServices()` uses, rather than a second list that drifts. The
 * client asks for `book.list`, `content.locate` and `content.read`, all reads;
 * the plan's §1 says this is a thin client that streams, and "importing a book
 * from the phone" is named under what is deliberately not built.
 *
 * **The day the browser needs to write** — a reading position, a mark — that is
 * a decision to take deliberately, by widening this predicate and saying which
 * verbs and why. It is not a line to delete.
 *
 * ## That day came for ONE verb, and here is the widening (WI-20.30, D7)
 *
 * `book.position`, under `position:write` — a grant family that covers
 * nothing else, so `book:*` does not include it and it does not include
 * `book.set`. Admitted only after the CSP was measured to stop a book's
 * script on both engines (`csp-effect.mjs`) and the loader was taught to
 * refuse one (`bookScripts.ts`); and bound further, HERE, to the book this
 * session opened: `content.locate` is how the thin client opens a book, so
 * the last book a session located is the one — and the only one — it may
 * move. A call naming any other is refused `forbidden` before the handler
 * runs. That bounds what a script with its own socket could do to the one
 * book it is running inside of, which it already knows about.
 */
/** The one write's grant, by its spelling — `serviceTable.ts` declares it. */
const POSITION_GRANT = 'position:write'
const OPENS_A_BOOK = 'content.locate'
const MOVES_A_BOOK = 'book.position'

/** The book id a request names, or null when it names none. */
function bookOf(req: unknown): string | null {
  if (typeof req !== 'object' || req === null) return null
  const book = (req as Record<string, unknown>)['book']
  return typeof book === 'string' && book !== '' ? book : null
}

/**
 * The contributions, with the binding: `content.locate` RECORDS the book a
 * session opened (once it has answered — a book the shelf does not hold
 * binds nothing), and `book.position` is REFUSED for any other book, before
 * its handler runs. Every other service passes through untouched.
 */
function boundToOpenedBook(services: readonly ServiceContribution[], openedBy: Map<string, string>): ServiceContribution[] {
  /* The NEWEST locate owns the binding, by the order the requests were MADE:
   * two locates in flight used to bind in completion order, so a slow older
   * one could land last and re-point the write at the book the browser had
   * already left. */
  const latest = new Map<string, number>()
  return services.map((service) => {
    if (service.name === OPENS_A_BOOK) {
      return {
        ...service,
        handler: async (req, ctx) => {
          const mine = (latest.get(ctx.peer) ?? 0) + 1
          latest.set(ctx.peer, mine)
          const answer = await service.handler(req, ctx)
          const book = bookOf(req)
          if (book !== null && latest.get(ctx.peer) === mine) openedBy.set(ctx.peer, book)
          return answer
        },
      }
    }
    if (service.name === MOVES_A_BOOK) {
      return {
        ...service,
        handler: (req, ctx) => {
          const book = bookOf(req)
          const opened = openedBy.get(ctx.peer)
          if (book === null || opened === undefined || opened !== book) {
            throw refuse(
              SERVICE_ERRORS.forbidden,
              opened === undefined
                ? 'this session has opened no book'
                : `this session opened ${opened} and may not move ${book ?? 'nothing'}`,
            )
          }
          return service.handler(req, ctx)
        },
      }
    }
    return service
  })
}

export function servePipe(options: PumpOptions): Pump {
  const { wire, services } = options
  const pollMs = options.pollMs ?? POLL_MS
  const sessionsMs = options.sessionsMs ?? SESSIONS_MS
  for (const [name, value] of [['pollMs', pollMs], ['sessionsMs', sessionsMs]] as const) {
    /* A zero, negative, NaN or infinite interval is a tight loop or a
     * never-firing timer, and either looks like a pump that works. */
    if (!Number.isFinite(value) || value <= 0) throw new Error(`servePipe: ${name} must be a positive finite number, got ${String(value)}`)
  }
  const onError = options.onError ?? (() => {})
  /* A REPORTER THAT CANNOT TAKE THE PUMP DOWN WITH IT. Every failure path
   * here reported and then cleaned up; a reporter that threw skipped the
   * cleanup — a failed session stayed in `live` for the life of the app —
   * or became an unhandled rejection out of a `.catch(onError)`. */
  const report = (thrown: unknown): void => {
    try {
      onError(thrown)
    } catch (again) {
      console.error('webhost pump: the error reporter itself threw', again, 'while reporting', thrown)
    }
  }
  /** Session → the book it opened last. Dropped with the session. */
  const openedBy = new Map<string, string>()

  /* THE KERNEL'S OWN SPLIT, not a list kept here. `readServices()` filters the
   * table with this exact predicate, so a service added to the table lands on
   * the correct side for the browser without anybody remembering to update a
   * second register. Plus the one write, by its exact spelling. */
  const router = createRouter({
    services: boundToOpenedBook([...services], openedBy),
    hasGrant: (_session, grant) => readingGrant(grant) || grant === POSITION_GRANT,
    ...(options.maxOutboundBytes === undefined ? {} : { maxOutboundBytes: options.maxOutboundBytes }),
  })
  const live = new Map<number, { connection: ReturnType<typeof router.connect>; stop: () => void }>()
  let stopped = false

  const drain = (session: number) => {
    let aborted = false

    /* ONE CALLER, `again_` below, which AWAITS this before scheduling the
     * next pass — so the loop can never be entered while it runs. It carried
     * a `running` guard and an `again` rerun flag against an overlap that
     * had no way to happen; the peer port's note that the flag was borrowed
     * from describes a port with two entry points. This has one. */
    const loop = async () => {
      for (;;) {
        if (aborted) return
        let frames: readonly Uint8Array[]
        try {
          frames = await wire.sessionRecv(session)
        } catch (thrown) {
              /* ⚠️ **ABORTING LEFT THE SESSION IN `live`, WHICH MADE IT
               * PERMANENT.** This loop stopped and reported, and the record
               * stayed — so the next `reconcile` saw the id as already open and
               * did nothing, for the life of the app. A transient IPC failure
               * therefore stopped serving that browser for ever, while the
               * plugin went on reporting its socket and buffering its frames.
               *
               * Dropping the record is what makes recovery possible: the next
               * reconciliation finds an id the webview is not serving and opens
               * it again. `close` is safe to call from in here — it stops this
               * loop, which is already aborting. */
          aborted = true
          close(session)
          report(thrown)
          return
        }
        if (frames.length === 0) return
        for (const frame of frames) {
          if (aborted) return
          live.get(session)?.connection.receive(frame)
        }
      }
    }

    /**
     * THE LOOP IS DRIVEN BY THE ANSWER, NOT BY A TIMER.
     *
     * ⚠️ `setInterval(loop, 40)` asked the plugin twenty-five times a second,
     * per session, to be told "nothing" — 1,600 IPC round trips a second at the
     * host's own `MAX_SESSIONS`, before a byte of real traffic.
     *
     * Lengthening the interval was the obvious answer and is the wrong one: it
     * bounds how long a reader waits for the first frame of a request they have
     * just made by tapping the page, so it trades idle CPU for exactly the
     * latency that is felt. `webhost_session_recv` WAITS now — up to a second —
     * so the call returns the instant a frame lands and costs one round trip
     * per second while nothing is happening.
     *
     * `pollMs` survives as the gap between one pass and the next, which is
     * about not spinning if the plugin ever answers instantly; the waiting is
     * done on the other side.
     */
    let timer: ReturnType<typeof setTimeout> | undefined
    const again_ = async () => {
      if (aborted) return
      await loop()
      if (aborted) return
      timer = setTimeout(() => void again_(), pollMs)
    }
    void again_()
    return {
      stop: () => {
        aborted = true
        if (timer !== undefined) clearTimeout(timer)
      },
    }
  }

  const open = (session: number) => {
    /* ⚠️ **A REJECTED SEND USED TO STRAND THE SESSION.** `createRouter`
     * disconnects its own connection when the transport errors, and nothing
     * else happened: the record stayed in `live`, the plugin went on reporting
     * the socket, and reconciliation saw an id it believed was already served.
     * Every later request drained into a router connection that had hung up —
     * answered by nobody, no error, no retry.
     *
     * Removing the record here is the same recovery the drain path takes: the
     * next reconciliation finds an unserved id and opens it again. */
    const connection = router.connect(String(session), (bytes) =>
      wire.send(session, bytes).catch((thrown: unknown) => {
        close(session)
        report(thrown)
        throw thrown
      }),
    )
    const { stop } = drain(session)
    live.set(session, { connection, stop })
    /* THE ROUTER HANGS UP ON ITS OWN — on a rejected write (handled above) and
     * on its outbound budget overflowing, which a browser that stopped reading
     * causes and nothing here could see: the record stayed in `live`, the
     * plugin went on reporting the socket, and every later request drained
     * into a connection answered by nobody (the 2026-08-28 audit, #61). The
     * listener takes the same road the drain path takes; `close` guards on
     * the record still being this connection, so a session id the plugin has
     * since reused is left alone. */
    connection.onDisconnect(() => {
      if (live.get(session)?.connection === connection) close(session)
    })
  }

  const close = (session: number) => {
    const held = live.get(session)
    if (held === undefined) return
    held.stop()
    held.connection.disconnect()
    live.delete(session)
    /* And the book it had opened. A session id the plugin reuses must not
       inherit a binding from the browser that held it before. */
    openedBy.delete(String(session))
  }

  const reconcile = async () => {
    if (stopped) return
    let sessions: readonly { id: number }[]
    try {
      sessions = await wire.sessions()
    } catch (thrown) {
      report(thrown)
      return
    }
    if (stopped) return
    const now = new Set(sessions.map((s) => s.id))
    for (const id of now) if (!live.has(id)) open(id)
    /* A SESSION THAT WENT AWAY IS TORN DOWN HERE. Without it a revoked
     * browser's router connection stays live in this webview, holding whatever
     * its in-flight handlers hold, for as long as the app runs. */
    for (const id of [...live.keys()]) if (!now.has(id)) close(id)
  }

  /* READY FIRST — AND THE TIMER TOO.
   *
   * The plugin refuses to deliver frames before the webview says it is serving;
   * announcing after the first poll would drop whatever a browser sent in
   * between. That was the stated order, and only the FIRST reconcile obeyed it:
   * `setInterval` was armed on the line below, unconditionally, so a poll could
   * land before `ready` resolved — and went on polling for ever if `ready`
   * REJECTED, which is the case where the plugin will never deliver anything at
   * all. The interval is armed by the readiness, so the ordering is structural
   * rather than a race that usually goes the right way. */
  /* COMPLETION-DRIVEN, ONE IN FLIGHT: `setInterval` could start a second
   * reconciliation while the previous `wire.sessions()` was still pending,
   * and two snapshots landing out of order could close a current session or
   * reopen one that had just gone. The next pass is armed only after the
   * last one settled. */
  let sessionsTimer: ReturnType<typeof setTimeout> | undefined
  const reconcileThenRearm = async () => {
    await reconcile()
    if (stopped) return
    sessionsTimer = setTimeout(() => void reconcileThenRearm(), sessionsMs)
  }
  void wire
    .ready()
    .then(() => {
      if (stopped) return
      return reconcileThenRearm()
    })
    .catch(report)

  return {
    get serving() {
      return live.size
    },
    stop: () => {
      stopped = true
      if (sessionsTimer !== undefined) clearTimeout(sessionsTimer)
      for (const id of [...live.keys()]) close(id)
    },
  }
}
