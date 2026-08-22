import { listTrash, type TrashFs, type TrashedBook } from '../bookTrash'
import type { ServiceContext } from '../capability'
import type { ServiceEnvironment } from './environment'
import { descriptorOf, list, num, readInput, reqNum } from './input'
import { pages } from './paging'
import { SERVICE_ERRORS, refuse } from './refusals'
import { trashRow, type EmptiedRow, type TrashRow } from './rows'

/**
 * `trash.*` — removed books, recoverable (phase 11, WI-11.3/11.5).
 *
 * A removed book is a directory under `trash/`, not a tombstone in a store:
 * everything a book owns lives in its folder, so removing it takes the
 * reader's tags, their place in it and their marks — and that is not a file
 * the reader owns, it is what they WROTE. A misclick must not be able to
 * destroy it.
 *
 * `trash.empty` IS THE ONE IRREVERSIBLE VERB IN THE TABLE, and it takes the
 * count it expects to destroy. That is not ceremony: the CLI's read commands
 * and its write commands look the same on a terminal, a shell history repeats
 * perfectly, and there is no undo behind this one. A count is a precondition
 * the caller can only satisfy by having looked — and the refusal names both
 * numbers, so the caller learns what changed rather than that they were
 * wrong.
 */

/** The trash lives in the filesystem, not in a store. Without one there is
 *  no trash to describe, which is a different answer from "it is empty".
 *
 *  EXPORTED because the folder a trashed book occupies is not only the trash's
 *  business: `book.add` and `book.restore` both have to know whether a folder
 *  is already spoken for by something in here, and asking through this one
 *  helper is what stops a second reading of "where the trash is". */
export function trashFs(env: ServiceEnvironment): TrashFs {
  const fs = env.services.fs
  if (!fs) throw refuse(SERVICE_ERRORS.unsupported, 'this host has no filesystem, so it has no trash')
  return fs
}

/**
 * Oldest removal first; an entry with no stamp last; ties broken by folder.
 *
 * `a.removedAt ?? Number.MAX_SAFE_INTEGER` LOOKED like "sorts last" and was
 * not: `removedAt` is a number read off a file, and this file's own parser
 * accepts any finite one — so a stamp above `MAX_SAFE_INTEGER` (a hand-edited
 * `.removed`, a clock in milliseconds someone wrote in microseconds) sorted
 * AFTER the unstamped entries the sentinel was supposed to put at the end. It
 * also made every unstamped entry compare EQUAL to every other, leaving their
 * order to whatever the directory listing happened to give — so two calls a
 * second apart could page the same trash differently and a caller reading with
 * a limit saw a different set each time. The folder name is stable and unique,
 * which is what makes the order reproducible.
 */
function byRemoval(a: TrashedBook, b: TrashedBook): number {
  if (a.removedAt !== b.removedAt) {
    if (a.removedAt === null) return 1
    if (b.removedAt === null) return -1
    return a.removedAt - b.removedAt
  }
  return a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0
}

export function trashList(env: ServiceEnvironment) {
  return (req: unknown, ctx: ServiceContext): AsyncIterable<readonly TrashRow[]> => {
    const input = readInput(descriptorOf('trash.list'), req)
    const limit = num(input, 'limit')
    async function* run(): AsyncGenerator<readonly TrashRow[]> {
      if (ctx.signal.aborted) return
      /* ASKING FOR NOTHING COSTS NOTHING. `pages` yields no page for a limit
       * of zero, but the scan had already happened by then — two file reads
       * per trashed book to build rows nobody would receive. The trash is
       * where a large library's least-wanted work sits, so this is exactly
       * the listing worth not doing. */
      if (limit === 0) return
      const rows = (await listTrash(trashFs(env), ctx.signal))
        /* Oldest removal first, so the entries closest to ageing out are the
         * ones a caller reading the head of the list sees. An entry with no
         * stamp sorts last: the sweep will never delete it, so it is the
         * least urgent thing in the list. */
        .sort(byRemoval)
        .map(trashRow)
      yield* pages(rows, ctx.signal, limit)
    }
    return run()
  }
}

export function trashEmpty(env: ServiceEnvironment) {
  return async (req: unknown): Promise<EmptiedRow> => {
    const input = readInput(descriptorOf('trash.empty'), req)
    const expected = reqNum(input, 'count')
    const fs = trashFs(env)
    const held = await listTrash(fs)
    if (expected !== held.length) {
      throw refuse(
        SERVICE_ERRORS.conflict,
        `the trash holds ${held.length} ${held.length === 1 ? 'book' : 'books'}, not ${expected}; nothing was deleted`,
      )
    }
    /* AND THE MEMBERSHIP, when the caller named it.
     *
     * The count alone cannot see a swap: one book restored and another trashed
     * leaves it unchanged, and the new one — which nobody reviewed — is then
     * destroyed. Comparing the ids turns "as many as you saw" into "exactly
     * what you saw". Both directions are named in the refusal, because
     * "changed" is not actionable and "these arrived, these left" is. */
    const reviewed = list(input, 'books')
    if (reviewed !== undefined) {
      const now = new Set(held.map((one) => one.bookId))
      const then = new Set(reviewed)
      const arrived = [...now].filter((id) => !then.has(id))
      const left = [...then].filter((id) => !now.has(id))
      if (arrived.length > 0 || left.length > 0) {
        throw refuse(
          SERVICE_ERRORS.conflict,
          `the trash has changed since you looked${arrived.length ? `; now also holding ${arrived.join(', ')}` : ''}` +
            `${left.length ? `; no longer holding ${left.join(', ')}` : ''}; nothing was deleted`,
        )
      }
    }
    /* Exactly the books that were counted, so nothing trashed since the count
     * is destroyed without having been confirmed — and each one purged ON ITS
     * OWN LANE, so the exists-and-delete pair cannot interleave with a restore
     * or a re-removal of the same book. Deleting the paths directly, outside
     * that queue, is how a restore could lose its files to a delete still
     * holding the old path. */
    const gone = new Set<string>()
    const stayed: string[] = []
    for (const one of held) {
      /* A FAILURE ON ONE BOOK MUST NOT DECIDE THE ANSWER FOR THE REST.
       *
       * `purgeTrashed` throws when the directory will not delete, and this
       * loop let it out — so one unwritable folder aborted the whole verb as
       * an `internal` error, the partial-destroy refusal below was UNREACHABLE
       * dead code, and the caller was told nothing about the books that HAD
       * already been destroyed. Their trash had changed and the answer did not
       * say so.
       *
       * Caught here rather than inside the primitive, which stays loud: this
       * is the policy — the caller confirmed every one of these, so a fault on
       * one is a reason to report, not a reason to stop. */
      const went = await env.services.library.purgeTrashed(one.bookId).then(
        (destroyed) => destroyed,
        () => false,
      )
      if (went) gone.add(one.folder)
      else stayed.push(one.bookId)
    }
    if (gone.size !== held.length) {
      /* A PARTIAL DESTROY IS NOT A SUCCESS. Naming what did go, and what did
       * not, is what lets a caller re-run against the new count rather than
       * believe the trash is empty. */
      throw refuse(
        SERVICE_ERRORS.unwritable,
        `deleted ${gone.size} of ${held.length}; still in the trash: ${stayed.join(', ')}`,
        /* NOT RETRYABLE, and that is the honest answer. The confirmation is a
         * COUNT, and any successful deletion has already changed it — so an
         * automatic retry of the identical request cannot succeed, it can only
         * fail the count check and look like a second, different fault. The
         * caller must look again and confirm what is actually there. */
        false,
      )
    }
    return { emptied: gone.size, bookIds: held.map((one) => one.bookId) }
  }
}
