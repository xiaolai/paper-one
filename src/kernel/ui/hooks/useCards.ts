import { useMemo, useSyncExternalStore } from 'react'
import { createCard, type Cards } from '../../core/cardStore'
import type { Card, NewCard } from '../../core/cards'

/**
 * The card store, bound to React — an ADAPTER over `core/cardStore`.
 *
 * No `bookId`. It used to take one and publish a `current` list filtered to
 * it, which nothing ever read: every card surface shows `all`, because cards
 * are explicitly cross-book — that is what distinguishes them from marks.
 */
export interface CardsView {
  readonly all: readonly Card[]
  /**
   * False once a write has failed, true again once one succeeds.
   *
   * Its own flag rather than the marks store's. Card writes failing used to be
   * swallowed on the reasoning that the Marginalia panel's notice covered them — but
   * that notice only changes when a MARK is written, so a reader could make a
   * dozen cards, watch them appear, and lose every one on reload with nothing
   * anywhere having said so.
   */
  readonly persistent: boolean
  /** Move every row from a superseded book id onto the current one — see the service. */
  rekey: (from: string, to: string) => void
  make: (draft: NewCard) => Card
  /**
   * Mint and write several cards in ONE store write, and resolve when it has
   * landed.
   *
   * `make` is right for the reader making a card — one card, one write, and
   * the promise let go because `persistent` is what reports a store that
   * cannot take writes. An import is the other case: it needs the whole batch
   * in one write, and it needs to know whether it worked before it tells the
   * reader it did.
   */
  makeMany: (drafts: readonly NewCard[]) => Promise<void>
  discard: (id: string) => void
}

/* A rejection here is a store that could not take the write; the pane shows
 * `persistent` for that, so the promise is let go without a report — as the
 * hook it replaces did. What must not happen is an unhandled rejection. */
function letGo(written: Promise<unknown>): void {
  void written.catch(() => {})
}

export function useCards(store: Cards): CardsView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const verbs = useMemo(
    () => ({
      make: (draft: NewCard): Card => {
        const card = createCard(draft)
        letGo(store.add(card))
        return card
      },
      makeMany: (drafts: readonly NewCard[]): Promise<void> =>
        store.addMany(drafts.map((draft) => createCard(draft))),
      discard: (id: string) => letGo(store.remove(id)),
      rekey: (from: string, to: string) => letGo(store.rekey(from, to)),
    }),
    [store],
  )
  return useMemo<CardsView>(
    () => ({ all: snapshot.all, persistent: snapshot.persistent, ...verbs }),
    [snapshot.all, snapshot.persistent, verbs],
  )
}
