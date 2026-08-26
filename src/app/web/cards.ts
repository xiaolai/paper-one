import type { Card, CardRow } from '../../kernel'
import type { ShelfChannel } from './channel'

/**
 * The shelf's cards, as a store a React view can read (phase 19).
 *
 * The same shape as `marks.ts`, for the same reason: `useCards` owns a
 * `CardStorage` this client does not have, and what `pane/Cards.tsx` reads is
 * three members — `all`, `persistent`, `discard`. `card.list` with no book is
 * every card on the shelf, so the cross-book deck is one call.
 *
 * ## The row is the card, except for one sentinel
 *
 * `CardRow` sends `bookId: null` for a card from no book; the store keeps
 * `''`. The wire is right — `null` means "none" and `''` reads as "a book whose
 * id is empty" — and `asCard` folds it back to what the model expects.
 *
 * ## No `make`, AND NO `discard`
 *
 * A card is made from a mark, in Notes, and `make` is synchronous: it hands a
 * `Card` straight back. There is no `card.add` shape a browser can answer
 * synchronously, and `Marginalia` already draws no "Make a card" control on
 * this host for exactly that reason.
 *
 * ⚠️ `discard` used to be here, and it could never have worked. It calls
 * `card.remove`, which the table gates on `card:write`; a browser session holds
 * one grant and it is `readingGrant` (`capabilities/webhost/lib/pump.ts` spells
 * out why, at length). So every discard was refused — after the card had
 * already been removed optimistically, which meant the reader watched it vanish
 * and come back.
 *
 * The store no longer offers what the session cannot do, and `pane/Cards.tsx`
 * takes `discard` as optional and draws no control without it. **The day the
 * browser may write** is the day that predicate is widened deliberately, and
 * this member comes back with it — as a decision, not as a line someone
 * restores to make a button appear.
 *
 * The deck is browsable here. It is not prunable.
 */
export interface RemoteCards {
  readonly all: readonly Card[]
  readonly persistent: boolean
}

export function asCard(row: CardRow): Card {
  return {
    id: row.id,
    bookId: row.bookId ?? '',
    kind: row.kind,
    body: row.body,
    answer: row.answer,
    source: row.source,
    cfi: row.cfi,
    createdAt: row.createdAt,
  }
}

export function parseCards(answer: unknown): readonly Card[] {
  if (!Array.isArray(answer)) return []
  const out: Card[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    if (typeof row['id'] !== 'string' || row['id'] === '') continue
    out.push(asCard(row as unknown as CardRow))
  }
  return out
}

export interface CardsStore extends RemoteCards {
  subscribe: (listener: () => void) => () => void
  refresh: () => void
  dispose: () => void
}

export function createRemoteCards(channel: ShelfChannel): CardsStore {
  let cards: readonly Card[] = []
  let persistent = true
  let live = true
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const l of listeners) l()
  }

  const refresh = (): void => {
    void (async () => {
      try {
        const seen: Card[] = []
        for await (const page of channel.stream('card.list', {})) seen.push(...parseCards(page))
        if (!live) return
        /* NEWEST FIRST — the card just made is the one the reader is looking
         * for, which is the order `byNewest` gives the desktop's deck. */
        cards = [...seen].sort((a, b) => b.createdAt - a.createdAt)
        changed()
      } catch (cause) {
        console.error('Paper: could not read your cards', cause)
      }
    })()
  }

  refresh()

  return {
    get all() {
      return cards
    },
    get persistent() {
      return persistent
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    dispose: () => {
      live = false
      listeners.clear()
    },
  }
}
