import { ServiceCallError, type Channel } from '../capabilities/peer'
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
 * real router over the fake wire; what does not exist is a Node-side
 * transport, and inventing one is precisely what this phase rules out.
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

export interface RemoteCallerOptions {
  readonly channel: Channel
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
