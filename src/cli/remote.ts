/* THE KERNEL, NOT THE PEER BARREL. `ServiceCallError` is the envelope's, and
 * the envelope lives in the kernel — but this imported it from
 * `capabilities/peer`, whose index evaluates React and the Tauri wire to hand
 * back a class that has nothing to do with either. A CLI that must not gain a
 * path to React was importing one for an error type. */
import { ServiceCallError, type CallOptions } from '../kernel'
import type { ServiceCaller } from './caller'

/**
 * THE SAME COMMANDS, OVER THE ENVELOPE (phase 11, WI-11.6).
 *
 * `ClientContribution` finally has a consumer. This is the whole of the
 * remote half: a `ServiceCaller` over a peer `Channel`, which is the envelope
 * client on an open session. No new transport, no new protocol, and — the
 * property the plan asks for — no second command table: `run.ts` cannot tell
 * this caller from the in-process one, so every command works both ways or
 * neither does.
 *
 * WHAT CROSSES THE SEAM, and what does not:
 *
 *   - a `ServiceCallError` from the router carries a typed `ServiceError`,
 *     and it is UNWRAPPED here into the refusal shape the CLI already prints.
 *     A caller must see `forbidden` spelled the same whether the local
 *     caller's own grant check raised it or a shelf across a session did.
 *   - anything else — a transport failure, a session that closed — is
 *     `disconnected`, because that is what it is. Reporting it as `internal`
 *     would tell a reader their shelf is broken when their network is.
 *
 * WHY THE CHANNEL IS INJECTED rather than dialled here: opening one needs the
 * peer plugin, which lives in the Tauri app. A Node process has no plugin, so
 * the shipped `paper` says "this build cannot reach a remote shelf" by name
 * rather than pretending. The adapter is complete and exercised against a
 * real router over the fake wire; what phase 11 did not have was a Node-side
 * transport, and inventing one was precisely what it ruled out.
 *
 * ⚠️ THAT IS NO LONGER THE WHOLE PICTURE, and reading it as "no transport
 * is possible" is why the open item sat. Phase 18 built a SECOND transport
 * — `src/app/web/channel.ts`, the same envelope to the same router, over a
 * WebSocket — and nothing about it is browser-only: `connect()` takes its url
 * and its socket as options, `window` is one `??` fallback, and Node's global
 * `WebSocket` does carry the `Cookie` header a handshake needs (measured,
 * Node 24 / undici 7.28). THIS ADAPTER WOULD TAKE IT UNCHANGED — it only ever
 * touches `call`, `stream` and `close`, never `peerId` or `sessionId`, so the
 * two lies `channel.ts` refuses to tell are not asked for.
 *
 * Both of those are now built, in `shelfLink.ts`: the credential comes from
 * the environment (`PAPER_CLIENT_COOKIE`, or `PAPER_CLIENT_CODE` to mint one)
 * and `--shelf` takes an exact origin. What this adapter still cannot change
 * is the GRANT: the shelf's web session is read-only plus `book.position`, so
 * a write arrives here as the envelope's `forbidden` and is unwrapped like any
 * other refusal. That is the shelf's answer, not a hole in this file.
 */

/** How the CLI's refusals are spelled when the transport, not a service,
 *  failed. The envelope's own code, so a caller matches one set of strings. */
const DISCONNECTED = 'disconnected'

/**
 * Turn a `ServiceCallError` — or anything else that came off a session — into
 * the `{code, message, retryable}` shape `run.ts` prints and exits on.
 */
function asRefusal(error: unknown, service: string): { code: string; message: string; retryable: boolean } {
  if (error instanceof ServiceCallError) {
    return { code: error.error.code, message: error.error.message, retryable: error.error.retryable }
  }
  /* NOT EVERYTHING IS A DISCONNECTION. A `TypeError` from a bug in this
   * adapter, or a malformed channel implementation, was labelled
   * `disconnected` AND retryable — so a caller retried a programming error
   * forever and the real fault never surfaced. Only what actually came off a
   * session is treated as one; anything else is reported as internal and not
   * retried. */
  const looksLikeSession =
    error instanceof Error && /session|channel|closed|disconnect|timed out|timeout/i.test(error.message)
  if (!looksLikeSession) {
    return {
      code: 'internal',
      message: `${service}: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    }
  }
  return {
    code: DISCONNECTED,
    message: `${service}: ${error instanceof Error ? error.message : String(error)}`,
    /* Retryable: a session that dropped may come back, and a caller deciding
     * whether to try again should be told the difference between "the shelf
     * said no" and "the shelf did not answer". */
    retryable: true,
  }
}

/**
 * WHAT THIS ADAPTER ACTUALLY NEEDS from a channel — and nothing more.
 *
 * It was typed as peer's `Channel`, which additionally carries `peerId` and
 * `sessionId`. Those are facts about an iroh session, and requiring them shut
 * out the other transport that speaks this exact envelope: the WebSocket
 * channel a shelf's webhost serves. `channel.ts`'s header refuses to invent
 * values for them — "two lies in a type" — and it is right, so the fix is to
 * stop asking rather than to start lying.
 *
 * `close` is `void | Promise<void>` because the two transports differ there
 * and neither is wrong: a peer session is torn down across IPC, a socket is
 * closed locally. `await` covers both.
 */
export interface CallChannel {
  call(service: string, body: unknown, options?: CallOptions): Promise<unknown>
  stream(service: string, body: unknown, options?: CallOptions): AsyncIterable<unknown>
  close(): void | Promise<void>
}

export interface RemoteCallerOptions {
  readonly channel: CallChannel
  /** Close the session when the command is done. Default: the channel's own. */
  readonly close?: () => Promise<void>
}

export function remoteCaller({ channel, close }: RemoteCallerOptions): ServiceCaller {
  return {
    call: async (service, body) => {
      try {
        return await channel.call(service, body)
      } catch (error) {
        throw asRefusal(error, service)
      }
    },
    stream: (service, body) => ({
      async *[Symbol.asyncIterator]() {
        /* The client's own iterable, re-thrown through the same translation.
         * `for await` is what sends `cancel` on a `break` — the client does
         * it in the iterator's `return()` — so stopping early here stops the
         * handler on the other side, which is the property WI-11.6 asks for
         * and the reason this is not a `while (true)` over `next()`. */
        try {
          yield* channel.stream(service, body)
        } catch (error) {
          throw asRefusal(error, service)
        }
      },
    }),
    close: async () => {
      /* CLOSING A SESSION THAT IS ALREADY GONE IS SUCCESS.
       *
       * The native lifecycle removes a session when the peer disconnects, so
       * `close()` after a disconnection rejects with "no such session" — and
       * this ran in the CLI's `finally`, where a throw replaced the exit code
       * the command had already earned with an unhandled rejection about
       * cleanup. Closed is closed, however it got that way; anything else is
       * still raised. */
      try {
        await (close ? close() : channel.close())
      } catch (cause) {
        const kind = (cause as { kind?: unknown })?.kind
        const text = cause instanceof Error ? cause.message : String(cause)
        if (kind === 'noSession' || /no such session|not connected|already closed/i.test(text)) return
        throw cause
      }
    },
  }
}
