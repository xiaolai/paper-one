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
}

export type NewCard = Omit<Card, 'id' | 'createdAt'>

export const CARDS_STORAGE_KEY = 'paper.cards.v1'

/** Newest first: a card just made is the one the reader is looking for. */
export function byNewest(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => b.createdAt - a.createdAt)
}

export function cardsForBook(cards: readonly Card[], bookId: string | null): Card[] {
  if (!bookId) return []
  return byNewest(cards.filter((card) => card.bookId === bookId))
}

export function addCard(cards: readonly Card[], card: Card): Card[] {
  return [card, ...cards]
}

export function removeCard(cards: readonly Card[], id: string): Card[] {
  return cards.filter((card) => card.id !== id)
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
  return (
    typeof c['id'] === 'string' &&
    typeof c['bookId'] === 'string' &&
    typeof c['kind'] === 'string' &&
    (CARD_KINDS as readonly string[]).includes(c['kind'] as string) &&
    typeof c['body'] === 'string' &&
    typeof c['answer'] === 'string' &&
    typeof c['source'] === 'string' &&
    (typeof c['cfi'] === 'string' || c['cfi'] === null) &&
    typeof c['createdAt'] === 'number'
  )
}

/** Same trust-boundary rule as marks: drop a bad row, keep the rest. */
export function parseCards(raw: string | null): Card[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isCard)
}
