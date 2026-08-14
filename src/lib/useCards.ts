import { useCallback, useMemo } from 'react'
import {
  CARDS_STORAGE_KEY,
  addCard,
  byNewest,
  parseCards,
  removeCard,
  type Card,
  type NewCard,
} from './cards'
import { newMarkId } from './marks'
import { localStore, useStoredCollection, writeJson } from './useStoredCollection'

/**
 * The card store, bound to React.
 *
 * The third store with this shape, and deliberately identical to the other
 * two: mutations compose from a ref so two in one tick both survive, and the
 * write happens outside the state updater because React may run an updater
 * twice in StrictMode. One idiom, applied three times, beats three near-misses.
 */

export interface CardStore {
  readonly all: readonly Card[]
  /**
   * False once a write has failed, true again once one succeeds.
   *
   * Its own flag rather than the marks store's. Card writes failing used to be
   * swallowed on the reasoning that the Notes panel's notice covered them — but
   * that notice only changes when a MARK is written, so a reader could make a
   * dozen cards, watch them appear, and lose every one on reload with nothing
   * anywhere having said so.
   */
  readonly persistent: boolean
  make: (draft: NewCard) => Card
  discard: (id: string) => void
}

/**
 * The card store.
 *
 * No `bookId`. It used to take one and publish a `current` list filtered to it,
 * which nothing ever read: every card surface shows `all`, because cards are
 * explicitly cross-book — that is what distinguishes them from marks. The
 * parameter and the filtering it drove are gone rather than kept "for
 * symmetry" with `useMarks`, where the same idea IS used.
 */
export function useCards(storage = localStore()): CardStore {
  const {
    items: cards,
    persistent,
    apply,
  } = useStoredCollection<Card>({
    storage,
    load: (target) => {
      try {
        return byNewest(parseCards(target.getItem(CARDS_STORAGE_KEY)))
      } catch {
        // A storage that throws on READ — disabled mid-session, or a hostile
        // stub — must not stop the pane from rendering.
        return []
      }
    },
    save: (target, next) => writeJson(target, CARDS_STORAGE_KEY, next),
  })

  const make = useCallback(
    (draft: NewCard) => {
      const card: Card = { ...draft, id: newMarkId(), createdAt: Date.now() }
      apply((prev) => addCard(prev, card))
      return card
    },
    [apply],
  )

  const discard = useCallback(
    (id: string) => apply((prev) => removeCard(prev, id)),
    [apply],
  )


  return useMemo<CardStore>(
    () => ({ all: cards, persistent, make, discard }),
    [cards, persistent, make, discard],
  )
}
