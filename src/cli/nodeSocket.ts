import type { SocketLike } from '../kernel'

/**
 * A `SocketLike` for Node, carrying the shelf's credential (WI-11.7).
 *
 * ## Why this exists at all, when the browser needs nothing
 *
 * In a browser the cookie is attached to the WebSocket handshake by the
 * browser itself, because the page came from the same origin. `HttpOnly` is
 * what makes that safe, and it is also what makes it impossible to do by hand.
 *
 * A Node process is not a browser: it has no cookie jar, no origin, and no
 * automatic anything. So the credential goes on the handshake explicitly, and
 * this adapter is the only place in the CLI that knows a socket can carry a
 * header at all.
 *
 * ## The cast, and why it is not a lie
 *
 * `lib.dom` declares `new WebSocket(url, protocols?)`, so `{ headers }` does
 * not typecheck against it — but Node's implementation (undici) does accept
 * it, and the whole feature depends on that. Rather than `as unknown as
 * SocketLike`, which would erase every property at once and let a real
 * mismatch through, the cast is to a constructor type spelling EXACTLY the
 * one extra argument that is being claimed. Everything else stays checked.
 *
 * `nodeSocket.test.ts` drives it against a real `node:http` upgrade and reads
 * the header off the wire, because a cast is a claim about the runtime and
 * only the runtime can settle it.
 */

/** What Node's WebSocket accepts and `lib.dom`'s declaration does not admit. */
type NodeWebSocket = new (url: string, options: { headers: Record<string, string> }) => SocketLike

/**
 * Open sockets to the shelf, presenting `cookie` on every handshake.
 *
 * `cookie` is a whole `name=value` pair — the CLI never spells the name, so a
 * rename on the server side cannot strand it.
 */
export function nodeSocketOpener(cookie: string): (url: string) => SocketLike {
  const Ctor = WebSocket as unknown as NodeWebSocket
  return (url) => new Ctor(url, { headers: { Cookie: cookie } })
}
