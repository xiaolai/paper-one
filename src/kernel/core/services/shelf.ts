import type { ServiceContext } from '../capability'
import type { ServiceEnvironment, ShelfPort } from './environment'
import { descriptorOf, readInput } from './input'
import { SERVICE_ERRORS, refuse } from './refusals'
import type { ShelfStatus } from './rows'

/**
 * `shelf.*` — THE ROLE: this device, its identity and its health (phase 11,
 * WI-11.3/11.5).
 *
 * `shelf` is not `library`, and the two must never blur. `library` is the
 * collection in prose and the store's class name; `shelf` is the
 * authoritative-device ROLE, and the words are already used that way
 * consistently across the Rust, the TypeScript and the docs. `book.list`
 * lists books. `shelf.status` reports the role.
 *
 * `shelf.status` answers WHAT IT CAN. Role, endpoint id, journal seq and
 * epoch come from the peer and sync capabilities through a port; bytes on
 * disk from the host, because no filesystem seam the kernel owns can measure
 * a directory. With none of them bound — a CLI beside the app, a browser tab
 * — every one of those fields is `null` and the book count is still true. A
 * refusal there would be worse than a partial answer: the count is the reason
 * most callers ask.
 *
 * `null` IS A REAL ANSWER HERE, not merely an unbound port. A shelf whose
 * index would not read reports `books: null` rather than `0`, because those
 * two mean opposite things to whoever asked.
 *
 * `shelf.sync` and `shelf.verify` DO refuse without the port, because there
 * is nothing partial to give: a sync that did not happen must not answer
 * "started", and a verify pass that ran over nothing must not answer "ok".
 */

function port(env: ServiceEnvironment, name: string): ShelfPort {
  const bound = env.services.shelf()
  if (!bound) {
    throw refuse(SERVICE_ERRORS.unsupported, `${name} needs the sync capability, which is not composed on this host`)
  }
  return bound
}

export function shelfStatus(env: ServiceEnvironment) {
  return async (req: unknown): Promise<ShelfStatus> => {
    readInput(descriptorOf('shelf.status'), req)
    const facts = await env.services.shelf()?.facts()
    return {
      role: facts?.role ?? null,
      endpointId: facts?.endpointId ?? null,
      /* NULL WHEN NOBODY COULD LOOK. The snapshot is empty both when the
       * library is empty and when its index would not load — the app opens the
       * window on an empty snapshot rather than not opening at all — and
       * reporting `0` for the second made a health check answer that the
       * reader's shelf had been emptied. `shelfRead` is what the composition
       * root knows and the kernel could not infer. */
      books: env.services.shelfRead() ? env.services.library.getSnapshot().length : null,
      journalSeq: facts?.journalSeq ?? null,
      epoch: facts?.epoch ?? null,
      bytes: (await env.services.sizes()?.libraryBytes()) ?? null,
    }
  }
}

export function shelfSync(env: ServiceEnvironment) {
  return async (req: unknown) => {
    readInput(descriptorOf('shelf.sync'), req)
    return port(env, 'shelf.sync').sync()
  }
}

export function shelfVerify(env: ServiceEnvironment) {
  return async (req: unknown, ctx: ServiceContext) => {
    readInput(descriptorOf('shelf.verify'), req)
    /* THE SIGNAL IS PASSED ON. Verification scans the whole library, so a
     * timeout, a cancel frame, a disconnect or a grant revoked mid-call all
     * left the pass running to completion over thousands of books with
     * nobody waiting for the answer — the caller had gone and the work had
     * not. The port decides how far it can honour it; discarding it here
     * meant it never got the chance. */
    return port(env, 'shelf.verify').verify(ctx.signal)
  }
}
