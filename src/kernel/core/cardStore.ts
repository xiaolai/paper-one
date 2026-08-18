import { CARDS_STORAGE_KEY, addCard, byNewest, liveCards, parseCards, removeCard, type Card, type NewCard } from './cards'
import { hlcOf, type Hlc } from './hlc'
import { rekeyBook } from './idMigration'
import { newMarkId, type MarkStorage } from './marks'
import { NOOP_RECORDER, recorded, type MutationRecorder } from './ports'

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
}

/** Mint a card: the draft, plus an id and a time. Same identity scheme as marks. */
export function createCard(draft: NewCard): Card {
  return { ...draft, id: newMarkId(), createdAt: Date.now() }
}

export function createCards({
  storage,
  recorder = NOOP_RECORDER,
  clock = () => hlcOf(Date.now()),
}: CardsOptions): Cards {
  /* Loaded once. A storage that throws on READ — disabled mid-session, or a
   * hostile stub — must not stop the pane from rendering. */
  let all: readonly Card[] = []
  try {
    all = storage ? byNewest(parseCards(storage.getItem(CARDS_STORAGE_KEY))) : []
  } catch {
    all = []
  }
  let persistent = true

  const listeners = new Set<() => void>()
  // Filtered to live at the one door a subscriber reads through — the held
  // list keeps its tombstones for the merge and the write.
  let snapshot: CardSnapshot = { all: liveCards(all), persistent }
  const publish = () => {
    snapshot = { all: liveCards(all), persistent }
    for (const listener of [...listeners]) listener()
  }

  /**
   * Persist the held list, reporting through `persistent` AND the promise.
   *
   * `setItem` signals a failed store by throwing (quota, private browsing, a
   * disk write that failed last time). The flag is what the pane shows; the
   * rejection is what a caller that awaited durability needs. Both, because
   * they are answers to different questions.
   */
  const persist = async (book: string): Promise<void> => {
    if (!storage) {
      if (persistent) {
        persistent = false
        publish()
      }
      return
    }
    const target = storage
    try {
      await recorded(recorder, book, 'cards', async () => {
        target.setItem(CARDS_STORAGE_KEY, JSON.stringify(all))
        await target.flush?.()
      })
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

  const applyFor = (book: string, mutate: (prev: readonly Card[]) => readonly Card[]): Promise<void> => {
    const next = mutate(all)
    /* NOTHING MOVED, so nothing is written. The mutation is applied to the
     * held list, which is authoritative and updated synchronously — so a
     * mutation returning its input BY IDENTITY is a reliable "no change". */
    if (next === all) return Promise.resolve()
    all = next
    publish()
    return persist(book)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add: (card) => applyFor(card.bookId, (prev) => addCard(prev, card)),
    remove: (id) => {
      const owner = all.find((card) => card.id === id)?.bookId ?? ''
      // A tombstone, not a vanished row — see `removeCard`.
      return applyFor(owner, (prev) => removeCard(prev, id, clock()))
    },
    apply: (mutate) => applyFor('', mutate),
    /* `apply` persists whatever the mutation returns even when nothing changed,
     * and this runs on every open — so the guard is here, reading the identity
     * `rekeyBook` returns when it found nothing to move. */
    rekey: (from, to) =>
      applyFor(to, (prev) => {
        const next = rekeyBook(prev, from, to)
        return next === prev ? prev : [...next]
      }),
  }
}
