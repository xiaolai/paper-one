import { useCallback, useMemo, useRef, useState } from 'react'
import {
  CARDS_STORAGE_KEY,
  addCard,
  byNewest,
  cardsForBook,
  parseCards,
  removeCard,
  type Card,
  type NewCard,
} from './cards'
import { newMarkId, type MarkStorage } from './marks'

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
  /** The open book's cards, newest first. */
  readonly current: readonly Card[]
  make: (draft: NewCard) => Card
  discard: (id: string) => void
}

function defaultStorage(): MarkStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useCards(bookId: string | null, storage = defaultStorage()): CardStore {
  const [cards, setCards] = useState<readonly Card[]>(() => {
    if (!storage) return []
    try {
      return byNewest(parseCards(storage.getItem(CARDS_STORAGE_KEY)))
    } catch {
      return []
    }
  })

  const latest = useRef<readonly Card[]>(cards)
  const storageRef = useRef(storage)
  storageRef.current = storage

  const apply = useCallback((mutate: (prev: readonly Card[]) => Card[]) => {
    const next = mutate(latest.current)
    latest.current = next
    setCards(next)
    try {
      storageRef.current?.setItem(CARDS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Reported to the reader through the Notes panel's persistence notice,
      // which covers the whole of local storage rather than one store.
    }
  }, [])

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

  const current = useMemo(() => cardsForBook(cards, bookId), [cards, bookId])

  return useMemo<CardStore>(
    () => ({ all: cards, current, make, discard }),
    [cards, current, make, discard],
  )
}
