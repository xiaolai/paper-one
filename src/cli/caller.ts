import { messageOf } from '../kernel'
import {
  GRANT_FAMILIES,
  grantCovers,
  handlerFor,
  isRefusal,
  refuse,
  SERVICE_ERRORS,
  serviceDescriptor,
  type KernelServices,
  type ServiceContribution,
  type ServiceDescriptor,
} from '../kernel'

/**
 * HOW THE CLI REACHES A SERVICE — one interface, two implementations
 * (phase 11, WI-11.4 and WI-11.6).
 *
 * `paper book list` on your own machine hosts `KernelServices` in-process and
 * calls the handler directly: no daemon, no socket, no protocol, for a
 * question about files you already own. `paper --shelf <key> book list` puts
 * the envelope in the middle. NOTHING ELSE ABOUT THE COMMAND CHANGES — same
 * command table, same arguments, same output — and the only difference a
 * reader sees is latency and a grant refusal where one applies.
 *
 * That property is the whole reason this is an interface rather than an `if`
 * inside the runner. A CLI whose local path and remote path were two code
 * paths would be two CLIs, and the second one would be the one nobody tested.
 */

export interface ServiceCaller {
  /** One answer. Rejects with a refusal — `{code, message, retryable}`. */
  call(service: string, body: unknown): Promise<unknown>
  /** Many answers, page by page, exactly as the `stream` frames carry them. */
  stream(service: string, body: unknown): AsyncIterable<unknown>
  /** Let go of whatever it holds — the host's write queue, a session. */
  close(): Promise<void>
}

export interface LocalCallerOptions {
  readonly services: KernelServices
  /**
   * The grants this process holds.
   *
   * EVERY GRANT BY DEFAULT, and that is the honest default rather than a
   * loose one: a CLI running as you, against your own data directory, has
   * exactly the authority you have — there is no second party to withhold
   * anything from, and pretending otherwise would be theatre.
   *
   * It is a parameter because the check has to EXIST on this path. A local
   * caller that skipped it would make "the API surface and the permission
   * surface are one table" true only over the wire, and the first service
   * whose grant was wrong in the table would be caught by a peer rather than
   * by the machine it was written on.
   */
  readonly grants?: readonly string[]
  /** Everything the caller should do at the end — closing the host. */
  readonly close?: () => Promise<void>
  /**
   * The handlers to run, when they are not the kernel's own.
   *
   * Defaults to the table's, which is what `paper` uses. Named here because
   * the caller otherwise reaches into `handlerFor` and there is no seam at
   * all — so the properties this caller is responsible for, and the router is
   * not, could only be tested through whichever real handler happened to
   * expose them. The peer side has had the same seam since phase 11
   * (`serveTable`'s `services`), and for the same reason.
   */
  readonly contributions?: readonly ServiceContribution[]
}

/**
 * Every grant the table declares, spelled as families — DERIVED, not listed.
 *
 * This was a hand-written array beside `GRANT_FAMILIES`, which is the second
 * list `serviceTable.ts` exists to prevent: a family added to the table and
 * not here would have made every service in it refuse locally while working
 * over the envelope, and nothing would have failed until somebody used it.
 */
const ALL_GRANTS: readonly string[] = GRANT_FAMILIES.map((family) => `${family}:*`)

/** The descriptor, or an `unknown-service` refusal — the same code the router
 *  answers, so a caller matches one string whichever side refused. */
function describe(service: string): ServiceDescriptor {
  const found = serviceDescriptor(service)
  if (!found) throw { code: 'unknown-service', message: `no service ${service}`, retryable: false }
  return found
}

/**
 * A caller that runs the handlers here, in this process.
 *
 * The signal is a real `AbortController`, aborted when the iteration stops,
 * so a `stream` the caller stops reading stops being produced — the same
 * contract the router gives a handler on `cancel`, honoured on the path that
 * has no wire to carry one.
 */
export function localCaller({ services, grants = ALL_GRANTS, close, contributions }: LocalCallerOptions): ServiceCaller {
  const byName = contributions === undefined ? null : new Map(contributions.map((one) => [one.name, one.handler]))
  /** The handler for `descriptor` — the caller's own table, or the kernel's. */
  const handle = (descriptor: ServiceDescriptor): ServiceContribution['handler'] => {
    const supplied = byName?.get(descriptor.name)
    return supplied ?? handlerFor(descriptor, { services })
  }
  const check = (descriptor: ServiceDescriptor): void => {
    if (!grantCovers(grants, descriptor.grant)) {
      /* `forbidden`, the envelope's own code, and refused BEFORE the handler
       * is built — not after it has read a store. Same order as the router. */
      throw { code: 'forbidden', message: `${descriptor.name} needs ${descriptor.grant}`, retryable: false }
    }
  }
  const context = (signal: AbortSignal) => ({
    /* The local caller IS the peer, and naming it so keeps a handler that
     * logs `ctx.peer` honest rather than blank. */
    peer: 'local',
    signal,
    input: (async function* () {})(),
  })
  return {
    call: async (service, body) => {
      const descriptor = describe(service)
      check(descriptor)
      if (descriptor.kind !== 'req') {
        throw refuse(SERVICE_ERRORS.malformed, `${service} answers many; use stream`)
      }
      const controller = new AbortController()
      /* ABORT MEANS CANCELLED, and a call that ANSWERED was not cancelled.
       *
       * The `finally` here fired on success too, so the local caller aborted
       * a signal the router never aborts on the same request — a handler that
       * reacts to abort (releasing a reservation, logging a cancellation,
       * refusing a follow-up) behaved one way in-process and another over the
       * envelope, and it is the CLI's whole premise that a command does the
       * same thing either way.
       *
       * A failure IS a cancellation from the handler's point of view: nobody
       * is waiting for the rest of the work. */
      let answered = false
      try {
        const answer = handle(descriptor)(body, context(controller.signal))
        /* CHECKED, not cast. `ServiceHandler` legally returns either a promise
         * or an async iterable, and blindly casting meant a table row saying
         * `req` over a handler that answers many produced the ITERABLE as the
         * value — a caller received an object with a `Symbol.asyncIterator`
         * where it expected a row, and found out somewhere far away. This is
         * the mirror of the check the stream path already makes. */
        if (isAsyncIterable(answer)) {
          throw refuse(SERVICE_ERRORS.unsupported, `${service} is declared req but answered many values`)
        }
        const value = await answer
        answered = true
        return value
      } finally {
        if (!answered) controller.abort()
      }
    },
    stream: (service, body) => {
      const descriptor = describe(service)
      check(descriptor)
      if (descriptor.kind !== 'stream') {
        throw refuse(SERVICE_ERRORS.malformed, `${service} answers one; use call`)
      }
      return {
        async *[Symbol.asyncIterator]() {
          /* ONE CONTROLLER PER ITERATION, created here rather than beside the
           * `return`. A shared one was aborted by the `finally` of whichever
           * iteration finished first, so a second pass over the same iterable
           * — a retry, or two consumers — started with an already-aborted
           * signal and every handler refused at once as though cancelled. */
          const controller = new AbortController()
          /* ABORTED ON AN EARLY EXIT, NOT ON A FINISHED STREAM.
           *
           * `break`, a `return`, a throw in the consumer's body — those are
           * cancellations, and aborting is what makes stopping early actually
           * stop the work. Running out of pages is not one, and aborting there
           * told the handler its caller had gone when its caller had simply
           * read everything. The router does not, so the two callers of the
           * same table disagreed about what abort means. */
          let drained = false
          try {
            const answer = handle(descriptor)(body, context(controller.signal))
            /* A `stream` handler returns an async iterable. Anything else is
             * a table that says `stream` over a handler that answers one —
             * refused rather than silently yielded as a single page. */
            if (!isAsyncIterable(answer)) {
              throw refuse(SERVICE_ERRORS.unsupported, `${service} is declared stream but answered one value`)
            }
            yield* answer
            drained = true
          } finally {
            if (!drained) controller.abort()
          }
        },
      }
    },
    close: async () => {
      await close?.()
    },
  }
}

/**
 * A real async iterable — the symbol present AND callable.
 *
 * Checking only that the key exists let `{ [Symbol.asyncIterator]: 1 }` past,
 * and the failure then surfaced at the `for await` as a confusing TypeError
 * instead of the named refusal the check exists to produce.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  )
}

/** A refusal's code, for a caller deciding an exit status. Anything that is
 *  not one of ours is `internal` — the same name the envelope gives it. */
export function callerErrorCode(error: unknown): string {
  if (isRefusal(error)) return error.code
  return 'internal'
}

/** A refusal's message, or the best available account of anything else. */
export function callerErrorMessage(error: unknown): string {
  if (isRefusal(error)) return error.message
  /* THE SHARED READER for everything that is not a refusal. This spelled the
     `Error`-or-`String` idiom itself and so answered `[object Object]` for a
     plugin rejection — the one shape `messageOf` exists for, missed here
     because the refactor searched for the exact ternary and this is a
     three-line function that means the same thing. */
  return messageOf(error)
}
