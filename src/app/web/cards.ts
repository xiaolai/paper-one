import { CARD_KINDS, type Card, type CardRow } from '../../kernel'
import { byFirstId, id, num, oneOf, str } from './wireRow'
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

/**
 * Rows out of a `card.list` answer.
 *
 * ⚠️ **EVERY FIELD IS READ, AND ONE USED TO BE.** This checked `id` and cast
 * the rest, so an object-valued `body` reached JSX — which renders an object
 * child by throwing — a string `createdAt` sorted lexically against numbers,
 * and a `kind` outside the five the deck knows fell through every filter to
 * nothing. The row looked valid because `id` was.
 *
 * `bookId` is the one field allowed to be absent: `null` on the wire means "a
 * card from no book", which the store keeps as `''`. Anything else is dropped
 * rather than defaulted — see `wireRow.ts` on why a coerced value is worse
 * than a missing one.
 */
export function parseCards(answer: unknown): readonly Card[] {
  if (!Array.isArray(answer)) return []
  const out: Card[] = []
  for (const item of answer) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const rowId = id(row['id'])
    if (rowId === null) continue

    const kind = oneOf(CARD_KINDS, row['kind'])
    const body = str(row['body'])
    const answerText = str(row['answer'])
    const source = str(row['source'])
    const createdAt = num(row['createdAt'])
    if (kind === null || body === null || answerText === null || source === null || createdAt === null) {
      continue
    }

    /* `bookId` IS NULLABLE ON THE WIRE and `cfi` is optional in practice — a
       card made from no passage has neither. Both are the sentinel the store
       uses, not a repaired value. */
    const bookId = row['bookId'] === null || row['bookId'] === undefined ? '' : str(row['bookId'])
    if (bookId === null) continue

    out.push({
      id: rowId,
      bookId,
      kind,
      body,
      answer: answerText,
      source,
      cfi: str(row['cfi']) ?? '',
      createdAt,
    } as Card)
  }
  /* A REPEATED ID LOSES A ROW IN THE RECONCILER, not here — see `byFirstId`. */
  return byFirstId(out, (card) => card.id)
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

  /* WHICH REFRESH IS THE CURRENT ONE — the same guard `marks.ts` and `books.ts`
   * carry, for the same reason: a detached walk that starts first can finish
   * last, and an older deck lands on top of a newer one. */
  let generation = 0

  const refresh = (): void => {
    const mine = ++generation
    void (async () => {
      try {
        const seen: Card[] = []
        for await (const page of channel.stream('card.list', {})) seen.push(...parseCards(page))
        if (!live || mine !== generation) return
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
