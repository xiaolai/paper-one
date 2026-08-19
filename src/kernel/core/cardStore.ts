import { CARDS_STORAGE_KEY, addCard, byNewest, liveCards, parseCards, removeCard, type Card, type NewCard } from './cards'
import { hlcOf, type Hlc } from './hlc'
import { rekeyBook } from './idMigration'
import { newMarkId, type MarkStorage } from './marks'
import { NOOP_RECORDER, recorded, type MutationRecorder } from './ports'
import type { WriteQueue } from './writeQueue'

/**
 * The book the cards surface is recorded — and queued — under. Cards are
 * ONE cross-book collection, so the recorder's `(book, what)` key must be
 * one key whatever card was touched: recording each write under the card's
 * own `bookId` split the surface into per-book journal streams, and a
 * card's push rev could name a stream its payload never travelled on.
 */
const CARDS_BOOK = ''

/**
 * The card store — cards, as a service with no React in it.
 *
 * Cards are cross-book by design (§15: a card is a made thing, above notes),
 * so unlike marks they are one list, and it lives in the flat store rather
 * than in any book's folder. Every write persists the WHOLE list under one
 * key; the store's own coalescing (`fileStore`) turns a burst into one disk
 * write.
 *
 * `useCards` used to hold this in `useState` through `useStoredCollection`;
 * it is an adapter over `getSnapshot`/`subscribe` now. The two decisions that
 * hook stated once still hold and are stated here instead: the held list is
 * the authority between notifications, so two mutations in one tick both
 * survive; and the write happens in the mutation, so nothing about it depends
 * on when a renderer chooses to run an updater.
 */

export interface CardSnapshot {
  /** Every LIVE card. Tombstoned rows stay in the stored list — a merge
   *  needs them — and no snapshot ever shows one. */
  readonly all: readonly Card[]
  /**
   * False once a write has failed, true again once one succeeds.
   *
   * Not latched. Each write persists the WHOLE collection, so a success after a
   * failure is a complete repair — there is nothing partial left behind, and a
   * reader told their work is not being saved while it is has no way to find
   * out otherwise.
   */
  readonly persistent: boolean
}

export interface Cards {
  getSnapshot(): CardSnapshot
  subscribe(listener: () => void): () => void
  /** Add a card the caller minted (`createCard`). Newest first. */
  add(card: Card): Promise<void>
  remove(id: string): Promise<void>
  /**
   * Change the list: publish and persist, in that order. A mutation returning
   * its input BY IDENTITY is a reliable "no change" and writes nothing.
   *
   * THE MUTATION SEES THE WHOLE LIST, tombstones included — that is what
   * lets the sync capability hand `mergeCards` in here and have a stale or
   * deleted row judged against the tombstone rather than past it. A caller
   * that wants only the living filters with `liveCards` itself.
   */
  apply(mutate: (prev: readonly Card[]) => readonly Card[]): Promise<void>
  /**
   * Every held row, TOMBSTONES INCLUDED — the canonical collection a
   * replicator digests, serves and merges (phase 10, WI-10.4). This is the
   * read that lets the sync capability drop its raw flat-store handle: the
   * journal's cards baseline and the ledger's serve both need the whole
   * list, and `getSnapshot().all` filters to live for the UI and must stay
   * that way. The held list is the authority between writes — a coalesced
   * write still in flight is HERE before it is on disk — so this is never
   * staler than the stored bytes.
   */
  stored(): readonly Card[]
  /**
   * Move every row from a superseded book id onto the current one.
   *
   * A no-op unless the reader has rows written under the previous identity
   * scheme — see `idMigration`. Called on open rather than at load, because the
   * old id can only be recomputed from the file itself.
   */
  rekey(from: string, to: string): Promise<void>
}

/**
 * The flat store, plus the one thing the async contract needs from it: a way
 * to know the bytes have landed. `fileStore` has `flush`; `localStorage` and
 * a test double are durable the moment `setItem` returns.
 */
export type CardStorage = MarkStorage & { readonly flush?: () => Promise<void> }

export interface CardsOptions {
  /** `null` — no storage — makes a store that lives for the session and says so. */
  readonly storage: CardStorage | null
  readonly recorder?: MutationRecorder
  /** The stamp for tombstones — see `MarkStoreOptions.clock`, whose rule this is. */
  readonly clock?: () => Hlc
  /**
   * The SHARED write queue, when the composition has one. Card writes then
   * run on it under `CARDS_BOOK` — the same key the sync ledger fences its
   * remote card applies on — so a local edit and a remote apply are ordered
   * by the queue, not by the tick they happened to start in. Unqueued (the
   * default), a started local write could consume the ledger's one-shot
   * remote expectation and be journaled `remote`: an edit that never
   * pushes. Absent, writes run inline, exactly as before.
   */
  readonly queue?: WriteQueue
}

/** Mint a card: the draft, plus an id and a time. Same identity scheme as marks. */
export function createCard(draft: NewCard): Card {
  return { ...draft, id: newMarkId(), createdAt: Date.now() }
}

export function createCards({
  storage,
  recorder = NOOP_RECORDER,
  clock = () => hlcOf(Date.now()),
  queue,
}: CardsOptions): Cards {
  /* Loaded once. A storage that throws on READ — disabled mid-session, or a
   * hostile stub — must not stop the pane from rendering. But a failed load
   * is NOT an empty collection: writing "empty plus this edit" over bytes
   * that were merely unreadable this launch would be data loss, so a load
   * failure makes the store SESSION-ONLY — it never writes, and `persistent`
   * says so from the first snapshot (as it does with no storage at all). */
  let all: readonly Card[] = []
  let unloadable = false
  try {
    all = storage ? byNewest(parseCards(storage.getItem(CARDS_STORAGE_KEY))) : []
  } catch {
    all = []
    unloadable = true
  }
  let persistent = storage !== null && !unloadable

  const listeners = new Set<() => void>()
  // Filtered to live at the one door a subscriber reads through — the held
  // list keeps its tombstones for the merge and the write.
  let snapshot: CardSnapshot = { all: liveCards(all), persistent }
  const publish = () => {
    snapshot = { all: liveCards(all), persistent }
    for (const listener of [...listeners]) {
      /* Isolated: a throwing subscriber must not stop later listeners, nor —
       * mid-mutation — abort the persist that follows this notification. */
      try {
        listener()
      } catch {
        /* A listener's failure is its own; the store's write still happens. */
      }
    }
  }

  /**
   * Persist the held list, reporting through `persistent` AND the promise.
   *
   * `setItem` signals a failed store by throwing (quota, private browsing, a
   * disk write that failed last time). The flag is what the pane shows; the
   * rejection is what a caller that awaited durability needs. Both, because
   * they are answers to different questions.
   */
  let dirty = false
  const persist = async (): Promise<void> => {
    if (!storage || unloadable) {
      /* Session-only: `persistent` began false on this path and nothing
       * flips it back, so there is no transition to publish — just no
       * write. */
      return
    }
    const target = storage
    try {
      /* Recorded under `CARDS_BOOK`, whichever card was touched — one
       * surface, one journal stream. The write serialises the WHOLE held
       * list, which the queued task has already updated in place (below), so
       * the bytes are this bracket's own state and never a later edit's. */
      await recorded(recorder, CARDS_BOOK, 'cards', async () => {
        target.setItem(CARDS_STORAGE_KEY, JSON.stringify(all))
        await target.flush?.()
      })
      dirty = false
      if (!persistent) {
        persistent = true
        publish()
      }
    } catch (cause) {
      dirty = true
      if (persistent) {
        persistent = false
        publish()
      }
      throw cause
    }
  }

  const applyCards = (mutate: (prev: readonly Card[]) => readonly Card[]): Promise<void> => {
    /* THE MUTATION, THE IDENTITY GUARD AND THE PUBLISH ALL RUN INSIDE THE
     * QUEUED TASK — not before it. `all` was updated synchronously here once,
     * which let a later local edit's state be serialised INSIDE an earlier
     * remote apply's begin/commit bracket (the remote persist task was still
     * waiting on its journal begin): a crash then left the local edit durable
     * but recorded `remote`, so it never pushed. Applied in queue order, each
     * write's bytes — and its bracket — are its own edit's, and a mutation
     * returning its input BY IDENTITY still writes and brackets nothing. */
    const run = async (): Promise<void> => {
      const next = mutate(all)
      /* Identity means "no change" ONLY while the store is clean: after a
       * failed persist the memory is ahead of the disk, and a retried merge
       * that returns its input by identity must still write — or the retry
       * resolves, gets acked, and the rows it acked never reach storage. */
      if (next === all && !dirty) return
      all = next
      publish()
      await persist()
    }
    return queue ? queue.append(CARDS_BOOK, run) : run()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add: (card) => applyCards((prev) => addCard(prev, card)),
    // A tombstone, not a vanished row — see `removeCard`.
    remove: (id) => applyCards((prev) => removeCard(prev, id, clock())),
    apply: (mutate) => applyCards(mutate),
    stored: () => all,
    /* `rekeyBook` answers by IDENTITY when nothing moved, and `applyCards`'s
     * own identity guard is what turns that into "write nothing" — this runs
     * on every open, so a no-op must cost no disk write. */
    rekey: (from, to) => applyCards((prev) => rekeyBook(prev, from, to)),
  }
}
