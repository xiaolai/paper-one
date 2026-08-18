/**
 * Cards — the made things.
 *
 * §15 draws the line this file exists to keep: a **note** is what you wrote on
 * a passage, a **card** is a made thing, above notes. A note is raw and belongs
 * to the passage it sits on; a card is worked, stands on its own, and is worth
 * meeting again later. That is why they are separate records rather than a flag
 * on a mark — and why a card keeps the anchor it came from without being
 * deleted when the mark is.
 *
 * The design's five kinds each answer a different question, which is what makes
 * the kind worth storing rather than inferring:
 *
 *   Idea       — a reading of the text, in the reader's own words
 *   Claim      — something asserted, with a source
 *   Recall     — a question with an answer, to be met again
 *   Synthesis  — drawn across several passages
 *   Excerpt    — the text itself, kept verbatim
 */

import { hlcOf, isHlc, laterHlc, type Hlc } from './hlc'

export const CARD_KINDS = ['Idea', 'Claim', 'Recall', 'Synthesis', 'Excerpt'] as const
export type CardKind = (typeof CARD_KINDS)[number]

export interface Card {
  readonly id: string
  readonly bookId: string
  readonly kind: CardKind
  /** The card's face. For Recall, the question. */
  readonly body: string
  /** Recall's answer. Empty for every other kind. */
  readonly answer: string
  /** Where it came from — a chapter label, for the line under the card. */
  readonly source: string
  /** The anchor it was made from, when it was made from one. */
  readonly cfi: string | null
  readonly createdAt: number
  /* ---- The ledger's stamps (phase 6) — same shape and same reasons as a
   * mark's. Optional; a legacy card has neither and `cardStamp` reads its
   * `createdAt`. ---- */
  readonly updatedAt?: Hlc
  /** The tombstone: a removed card keeps its row so the removal can travel.
   *  Every read model filters to `liveCards`. */
  readonly deletedAt?: Hlc
}

export type NewCard = Omit<Card, 'id' | 'createdAt'>

export const CARDS_STORAGE_KEY = 'paper.cards.v1'

/** Newest first: a card just made is the one the reader is looking for. */
export function byNewest(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.createdAt - a.createdAt)
}

/* `cardsForBook` was here. Nothing filtered cards by book: every surface shows
 * all of them, because a card is explicitly cross-book — that is the line §15
 * draws between a card and a mark. It existed to mirror `marksForBook`, which
 * is used. */

export function addCard(cards: readonly Card[], card: Card): Card[] {
  return [card, ...cards]
}

/**
 * Remove a card — which SETS ITS TOMBSTONE and keeps the row, exactly as
 * `removeMark` does and for the same reason: a deletion that leaves no row
 * cannot travel, and a replica still holding the card would put it back.
 * A card already deleted, or not there, is the input by identity.
 */
export function removeCard(cards: readonly Card[], id: string, at: Hlc = hlcOf(Date.now())): readonly Card[] {
  return cards.some((card) => card.id === id && card.deletedAt === undefined)
    ? cards.map((card) => (card.id === id && card.deletedAt === undefined ? { ...card, deletedAt: at } : card))
    : cards
}

/**
 * The cards that are THERE — the filter every read model applies. Input by
 * identity when nothing is deleted.
 */
export function liveCards(cards: readonly Card[]): readonly Card[] {
  return cards.some((card) => card.deletedAt !== undefined)
    ? cards.filter((card) => card.deletedAt === undefined)
    : cards
}

/** When a card was last acted on — see `markStamp`, whose rule this is. */
export function cardStamp(card: Card): Hlc {
  return laterHlc(card.updatedAt, card.deletedAt) ?? hlcOf(card.createdAt)
}

/**
 * Fold two card lists — LATEST ACTION WINS, per id; the same semilattice as
 * `mergeMarks`, including the tie rule and the identity convention. Deletes
 * are included: the newest row wins whole, tombstone or not.
 */
export function mergeCards(a: readonly Card[], b: readonly Card[]): readonly Card[] {
  const byId = new Map(a.map((card) => [card.id, card] as const))
  let changed = false
  for (const incoming of b) {
    const held = byId.get(incoming.id)
    if (!held) {
      byId.set(incoming.id, incoming)
      changed = true
      continue
    }
    const mine = cardStamp(held)
    const theirs = cardStamp(incoming)
    const winner =
      mine < theirs
        ? incoming
        : mine > theirs
          ? held
          : JSON.stringify(held) < JSON.stringify(incoming)
            ? incoming
            : held
    if (winner !== held && JSON.stringify(winner) !== JSON.stringify(held)) {
      byId.set(incoming.id, winner)
      changed = true
    }
  }
  return changed ? [...byId.values()] : a
}

/**
 * Turn a marked passage into a card.
 *
 * Excerpt by default, because that is the one kind that needs no work from the
 * reader — the text is already the card. Every other kind is a rewrite, and
 * pre-filling one with the quotation would make the card look finished when
 * nothing has been made yet.
 */
export function cardFromMark(mark: {
  bookId: string
  text: string
  note: string
  chapter: string
  cfi: string
}): NewCard {
  const worked = mark.note.trim()
  return {
    bookId: mark.bookId,
    kind: worked ? 'Idea' : 'Excerpt',
    body: worked || mark.text,
    answer: '',
    source: mark.chapter,
    cfi: mark.cfi,
  }
}

function isCard(value: unknown): value is Card {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  /* Same rule as `isMark`, and for the same reasons: an empty id collides as a
   * React key and makes `discard(id)` remove two cards, an empty body is a
   * card with no face, and a non-finite timestamp scrambles the newest-first
   * order for every other card in the list. */
  return (
    typeof c['id'] === 'string' &&
    c['id'] !== '' &&
    typeof c['bookId'] === 'string' &&
    typeof c['body'] === 'string' &&
    c['body'] !== '' &&
    typeof c['kind'] === 'string' &&
    (CARD_KINDS as readonly string[]).includes(c['kind'] as string) &&
    typeof c['answer'] === 'string' &&
    typeof c['source'] === 'string' &&
    (typeof c['cfi'] === 'string' || c['cfi'] === null) &&
    typeof c['createdAt'] === 'number' &&
    Number.isFinite(c['createdAt']) &&
    c['createdAt'] >= 0
  )
}

/** Same trust-boundary rule as marks: drop a bad row, keep the rest — and a
 *  malformed STAMP is dropped alone, leaving a legacy row, rather than
 *  costing the card. */
export function parseCards(raw: string | null): Card[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isCard).map((card) => {
    const { updatedAt, deletedAt, ...rest } = card as Card & { updatedAt?: unknown; deletedAt?: unknown }
    return {
      ...rest,
      ...(isHlc(updatedAt) ? { updatedAt } : {}),
      ...(isHlc(deletedAt) ? { deletedAt } : {}),
    }
  })
}
