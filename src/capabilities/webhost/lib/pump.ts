import { createRouter, readingGrant, type ServiceContribution } from '../../../kernel'
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
 * `webhost_session_recv` answers immediately — empty means "nothing right
 * now" — so this polls. Every service call therefore carries up to one poll
 * interval of latency, which is real and is the price of not having an event.
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
 */
export function servePipe(options: PumpOptions): Pump {
  const { wire, services } = options
  const pollMs = options.pollMs ?? POLL_MS
  const sessionsMs = options.sessionsMs ?? SESSIONS_MS
  const onError = options.onError ?? (() => {})

  /* THE KERNEL'S OWN SPLIT, not a list kept here. `readServices()` filters the
   * table with this exact predicate, so a service added to the table lands on
   * the correct side for the browser without anybody remembering to update a
   * second register. */
  const router = createRouter({ services: [...services], hasGrant: (_session, grant) => readingGrant(grant) })
  const live = new Map<number, { connection: ReturnType<typeof router.connect>; stop: () => void }>()
  let stopped = false

  const drain = (session: number) => {
    let running = false
    let again = false
    let aborted = false

    const loop = async () => {
      if (aborted || running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          for (;;) {
            if (aborted) return
            let frames: readonly Uint8Array[]
            try {
              frames = await wire.sessionRecv(session)
            } catch (thrown) {
              /* The session is gone, or the plugin refused. Either way this
               * loop has nothing left to read; reporting instead of retrying
               * keeps a dead session from spinning. */
              aborted = true
              onError(thrown)
              return
            }
            if (frames.length === 0) break
            for (const frame of frames) {
              if (aborted) return
              live.get(session)?.connection.receive(frame)
            }
          }
        } while (again)
      } finally {
        running = false
      }
    }

    const timer = setInterval(() => void loop(), pollMs)
    return {
      stop: () => {
        aborted = true
        clearInterval(timer)
      },
    }
  }

  const open = (session: number) => {
    const connection = router.connect(String(session), (bytes) => wire.send(session, bytes))
    const { stop } = drain(session)
    live.set(session, { connection, stop })
  }

  const close = (session: number) => {
    const held = live.get(session)
    if (held === undefined) return
    held.stop()
    held.connection.disconnect()
    live.delete(session)
  }

  const reconcile = async () => {
    if (stopped) return
    let sessions: readonly { id: number }[]
    try {
      sessions = await wire.sessions()
    } catch (thrown) {
      onError(thrown)
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

  /* READY FIRST. The plugin refuses to deliver frames before the webview says
   * it is serving; announcing after the first poll would drop whatever a
   * browser sent in between. */
  void wire
    .ready()
    .then(() => reconcile())
    .catch(onError)

  const sessionsTimer = setInterval(() => void reconcile(), sessionsMs)

  return {
    get serving() {
      return live.size
    },
    stop: () => {
      stopped = true
      clearInterval(sessionsTimer)
      for (const id of [...live.keys()]) close(id)
    },
  }
}
