import { ServiceCallError, createClient, type CallOptions, type Client } from './envelope'

/**
 * A channel to a shelf's web surface: the envelope over a WebSocket
 * (phase 18, WI-18.5; moved here WI-11.7).
 *
 * ## Why this is in the kernel and not under the browser client
 *
 * It lived in `src/app/web/` because that is where its first caller was, and
 * nothing about it is a browser: it hands outgoing bytes to a socket and
 * incoming bytes to the envelope's client, and both the socket and the url are
 * arguments. WI-11.7 gave it a second caller — `paper --shelf`, a Node process
 * with no DOM at all — and the misplacement became load-bearing, because the
 * CLI may not import the browser client.
 *
 * So it lives here, beside the envelope it wraps, for exactly the reason the
 * envelope itself moved out of `capabilities/peer/lib/` one phase earlier.
 * `src/app/web/channel.ts` re-exports it, which is why nothing in that client
 * had to change.
 *
 * The envelope is the same code the peer transport runs — it moved into the
 * kernel precisely so both could reach it. So this file is small and does the
 * only two things a transport owes: hand outgoing bytes to a socket, and hand
 * incoming bytes to the client.
 *
 * ## The credential is not here, and cannot be
 *
 * There is no token in this module and no header set. The shelf's cookie is
 * `HttpOnly`, so page script cannot read it — which is the whole defence
 * against a hostile book, since foliate renders EPUB HTML in an iframe sharing
 * this origin. The browser attaches it to the WebSocket handshake by itself
 * because the shelf serves this page from the same origin.
 *
 * That is also why the socket URL is derived from `location` rather than
 * configured. A configurable origin would be a cross-origin socket, the cookie
 * would not travel, and the failure would look like an auth bug.
 *
 * ## What this is NOT
 *
 * Not `peer`'s `Channel`. That interface carries `peerId` and `sessionId` —
 * facts about an iroh session that have no meaning for a browser holding a
 * cookie. Inventing values for them would be two lies in a type. What both
 * share is the pair that matters, `call` and `stream`, because both speak the
 * same envelope to the same router.
 */

/** How long to wait for the socket to open before giving up. */
const OPEN_TIMEOUT_MS = 10_000

/** Why a channel closed. */
export type ClosedReason = 'closed' | 'lost' | 'refused'

export interface ShelfChannel {
  call(service: string, body: unknown, options?: CallOptions): Promise<unknown>
  stream(service: string, body: unknown, options?: CallOptions): AsyncIterable<unknown>
  close(): void
  onClosed(fn: (reason: ClosedReason) => void): () => void
}

/**
 * The socket URL for this page.
 *
 * `wss:` when the page is `https:`, `ws:` otherwise — derived, never written
 * down. A hardcoded scheme is how a client ends up asking for an insecure
 * socket from a secure page, which browsers refuse as mixed content.
 */
export function socketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}

/** Everything this module needs from a socket, so a test can supply one. */
export interface SocketLike {
  binaryType: string
  send(data: ArrayBufferView | ArrayBuffer): void
  close(): void
  onopen: ((this: unknown, ev: unknown) => unknown) | null
  onclose: ((this: unknown, ev: unknown) => unknown) | null
  onerror: ((this: unknown, ev: unknown) => unknown) | null
  onmessage: ((this: unknown, ev: { data: unknown }) => unknown) | null
}

export interface ConnectOptions {
  /**
   * Where to dial. REQUIRED, and it did not use to be: it defaulted to
   * `socketUrl(window.location)`, which is a DOM read in what is otherwise a
   * platform-neutral module. Deriving it in the browser's own root is both
   * more honest and the only way this compiles in Node.
   */
  readonly url: string
  readonly open?: (url: string) => SocketLike
  readonly timeoutMs?: number
}

/**
 * Open a channel, or reject.
 *
 * Resolves only once the socket is OPEN. A channel handed back before then
 * would accept calls that queue invisibly and fail much later as timeouts,
 * which is the shape that makes an auth failure look like a slow shelf: the
 * shelf refuses the upgrade with a 401, the socket closes, and every call the
 * page already made times out one by one saying nothing about a credential.
 */
export async function connect(options: ConnectOptions): Promise<ShelfChannel> {
  const url = options.url
  const openSocket = options.open ?? ((target: string) => new WebSocket(target) as unknown as SocketLike)
  const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS

  const socket = openSocket(url)
  /* Frames are BYTES. Without this the browser hands back `Blob`s, which are
   * async to read — so frame order would depend on how fast each one resolved,
   * and the envelope's ordering is its ground. */
  socket.binaryType = 'arraybuffer'

  const listeners = new Set<(reason: ClosedReason) => void>()
  let closed: ClosedReason | null = null
  let client: Client | null = null

  const shut = (reason: ClosedReason) => {
    if (closed !== null) return
    closed = reason
    /* The envelope FIRST, so every pending call rejects with `disconnected`
     * before a listener can act on the close and ask a question that would
     * hang forever. */
    client?.disconnect()
    for (const fn of listeners) fn(reason)
    listeners.clear()
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`the shelf did not answer at ${url} within ${timeoutMs}ms`))
    }, timeoutMs)

    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      /* `refused` rather than `lost`: nothing was ever established, so a caller
       * deciding whether to retry or to re-authenticate has the fact it needs.
       * The browser deliberately hides WHY — a 401 and a dead port look
       * identical here — so this says what it knows and no more. */
      shut('refused')
      reject(new Error(`could not open a channel to ${url}`))
    }
    socket.onclose = () => {
      clearTimeout(timer)
      shut(closed === null && client === null ? 'refused' : 'lost')
      reject(new Error(`the channel to ${url} closed before it opened`))
    }
  })

  client = createClient({
    send: (bytes) => {
      if (closed !== null) return
      socket.send(bytes)
    },
  })

  socket.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      /* TEXT IS NOT THE PROTOCOL, and the shelf closes a socket that sends it.
       *
       * ⚠️ THIS USED TO `return`, on the reasoning that the shelf had already
       * decided the connection was over. It has — but the CLOSE has not arrived
       * yet, and until it does every request already in flight goes on waiting.
       * They then fail one by one at the 30s envelope timeout, which the reader
       * sees as the shelf hanging rather than as a connection that ended. And
       * if the frame came from something that is not our shelf, no close is
       * coming at all.
       *
       * A peer that has broken the envelope's one rule is a peer this side
       * cannot reason about, so the channel is declared lost at once and the
       * socket closed from here. `shut` settles every pending call with a
       * transport error, which is what turns a silent wait into a message. */
      shut('lost')
      socket.close()
      return
    }
    try {
      client?.receive(new Uint8Array(event.data))
    } catch {
      /* Bytes that are not a frame. The envelope's own comment says a router
       * sending garbage is the transport's problem to raise, and the only
       * honest thing a transport can do with a peer that stopped speaking the
       * protocol is stop listening to it. */
      shut('lost')
      socket.close()
    }
  }
  socket.onclose = () => shut('lost')
  socket.onerror = () => shut('lost')

  return {
    call: (service, body, callOptions) => {
      if (closed !== null) {
        return Promise.reject(
          new ServiceCallError(service, {
            code: 'disconnected',
            message: `the channel to the shelf is ${closed}`,
            retryable: true,
          }),
        )
      }
      return client!.call(service, body, callOptions)
    },
    stream: (service, body, callOptions) => client!.stream(service, body, callOptions),
    close: () => {
      shut('closed')
      socket.close()
    },
    onClosed: (fn) => {
      /* A listener added AFTER the close still hears about it. Otherwise a
       * caller that awaits `connect` and subscribes on the next tick misses a
       * socket that died in between, and waits forever for an event that has
       * already happened. */
      if (closed !== null) {
        fn(closed)
        return () => {}
      }
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
