import { hlcOf, type Hlc } from './hlc'
import {
  LOOKUPS_STORAGE_KEY,
  byRecent,
  liveLookups,
  parseLookups,
  recordLookup,
  refusesLookup,
  removeLookup,
  type Lookup,
  type LookupEntry,
} from './lookups'
import type { MarkStorage } from './marks'
import { notifyAll } from './notify'

/**
 * The lookup store — the reader's lookup history, as a service with no React
 * in it. Shaped after `cardStore.ts`, and the two decisions that file states
 * hold here for the same reasons: the held list is the authority between
 * notifications, and the write happens in the mutation.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE, beside the card store:
 *
 * - NO RECORDER. A card write is journaled because cards sync; lookups do not
 *   yet (see `lookups.ts`), and journaling a surface nothing replicates would
 *   put rows in the sync journal that no peer can ever acknowledge.
 * - NO SHARED WRITE QUEUE. The card store queues on the kernel's to be ordered
 *   against a REMOTE apply of the same surface. There is no remote apply of
 *   lookups to be ordered against — but this store's own writes do need
 *   ordering, and it orders them itself: see `persist`. `drain` flushes the flat
 *   store on close.
 *
 *   ⚠️ **THIS SAID A WRITE RAN INLINE AND THE FLAT STORE'S COALESCING MADE A
 *   BURST OF LOOKUPS ONE DISK WRITE, AND IT DID NOT.** Every lookup flushed as
 *   it landed, and a flush writes at once, so three lookups in one tick wrote
 *   the whole file three times — measured through `openFileStore` by the
 *   2026-09-13 audit. A burst is one write now because `persist` makes it one.
 * - NO REKEY. `rekey` moves rows written under a superseded book-id scheme, and
 *   this store did not exist under that scheme — there is nothing to move.
 */

export interface LookupSnapshot {
  /** Every LIVE term, most recently met first. */
  readonly all: readonly Lookup[]
  /** `CardSnapshot.persistent`'s meaning exactly — false once a write failed,
   *  true again once one succeeds. */
  readonly persistent: boolean
}

export interface Lookups {
  getSnapshot(): LookupSnapshot
  subscribe(listener: () => void): () => void
  /** File an answered lookup. Resolves when it has landed, rejects when it did not. */
  record(entry: LookupEntry): Promise<void>
  /** Remove a term from the history — a tombstone, see `removeLookup`. */
  remove(term: string): Promise<void>
  /** Every held row, TOMBSTONES INCLUDED — what a merge would read. */
  stored(): readonly Lookup[]
}

export type LookupStorage = MarkStorage & { readonly flush?: () => Promise<void> }

export interface LookupsOptions {
  /** `null` — no storage — makes a history that lives for the session and says so. */
  readonly storage: LookupStorage | null
  /** The stamp for records and tombstones — see `MarkStoreOptions.clock`. */
  readonly clock?: () => Hlc
}

export function createLookups({ storage, clock = () => hlcOf(Date.now()) }: LookupsOptions): Lookups {
  /* A LOAD FAILURE IS NOT AN EMPTY HISTORY — `createCards`' rule. Writing
     "nothing plus this lookup" over bytes that were merely unreadable this
     launch would erase the reader's history; the store goes session-only and
     says so instead. Bytes that are there and will not parse are a load failure
     too: `parseLookups` throws for them rather than reading them as empty. */
  /* NO INITIALIZER: both branches below assign, and an initial value neither
     path can observe was a mutant no test could kill. */
  let all: readonly Lookup[]
  let unloadable = false
  try {
    all = storage ? parseLookups(storage.getItem(LOOKUPS_STORAGE_KEY)) : []
  } catch {
    all = []
    unloadable = true
  }
  /** Where writes go — null for a session-only history, whichever way it became one. */
  const target = unloadable ? null : storage
  let persistent = target !== null
  /** Bumped by every change to the held list. */
  let revision = 0
  /** The newest revision known to be on disk. Memory is ahead exactly while this is behind `revision`. */
  let landed = 0
  /** The last write chained, settled either way — what the next one waits behind. */
  let writes: Promise<void> = Promise.resolve()

  const listeners = new Set<() => void>()
  const view = (): LookupSnapshot => ({ all: byRecent(liveLookups(all)), persistent })
  let snapshot = view()
  const publish = (): void => {
    snapshot = view()
    notifyAll(listeners, 'lookups')
  }

  /**
   * Write the held list — ONE WRITE AT A TIME, and none that is already done.
   *
   * ⚠️ **IT WAS A `dirty` FLAG AND A WRITE PER MUTATION, AND THREE THINGS WENT
   * WRONG WITH THAT**, each reproduced by the 2026-09-13 audit:
   *
   * - an earlier write that finished after a later one was refused set `dirty`
   *   false and `persistent` true, over a lookup that never reached the disk;
   * - a mutation that changed nothing resolved at once while the write before it
   *   was still flushing — so a repeated removal reported saved, and then the
   *   removal it repeated was refused;
   * - every mutation flushed, so a burst was as many whole-file writes.
   *
   * So writes are CHAINED, each after the last whatever its outcome, and each
   * writes what is held when it RUNS, not when it was asked for. A write that
   * finds its revision already carried by an earlier one has nothing left to do
   * and resolves — which is what makes a burst one write, and why every promise
   * here resolves only once its own change has landed.
   */
  const persist = (): Promise<void> => {
    if (target === null) return Promise.resolve()
    const mine = revision
    const write = async (): Promise<void> => {
      if (landed >= mine) return
      const writing = revision
      try {
        target.setItem(LOOKUPS_STORAGE_KEY, JSON.stringify(all))
        await target.flush?.()
        landed = writing
        if (!persistent) {
          persistent = true
          publish()
        }
      } catch (cause) {
        if (persistent) {
          persistent = false
          publish()
        }
        throw cause
      }
    }
    const done = writes.then(write)
    writes = done.catch(() => {})
    return done
  }

  const apply = async (mutate: (prev: readonly Lookup[]) => readonly Lookup[]): Promise<void> => {
    const next = mutate(all)
    if (next !== all) {
      all = next
      revision += 1
      publish()
    }
    /* A MUTATION THAT CHANGES NOTHING STILL WAITS FOR THE DISK — `createCards`'
       rule, and more of it. After a refused write, or while one is still
       flushing, memory is ahead of the disk, and a call that changes nothing
       must not report saved until the write carrying what it acknowledges has
       landed. When everything has, `persist` finds nothing to do. */
    await persist()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /* A LOOKUP THE HISTORY WOULD REFUSE IS REFUSED OUT LOUD. `recordLookup`
       returns its input for one, which `apply` reads as "no change" — so this
       resolved, wrote nothing, and kept `persistent` up over a word the reader
       would not find next launch (2026-09-13 verify). An entry that is merely
       nothing to file still resolves quietly. */
    record: async (entry) => {
      if (refusesLookup(entry)) {
        throw new Error('lookups: the stored history would not read this lookup back, so it was not recorded')
      }
      return apply((prev) => recordLookup(prev, entry, clock()))
    },
    remove: (term) => apply((prev) => removeLookup(prev, term, clock())),
    stored: () => all,
  }
}
