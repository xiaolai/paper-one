import type { NewCard } from '../../../kernel'

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
