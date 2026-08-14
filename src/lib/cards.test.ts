import { describe, expect, it } from 'vitest'
import {
  addCard,
  byNewest,
  cardFromMark,
  parseCards,
  removeCard,
  type Card,
} from './cards'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    bookId: 'book-a',
    kind: 'Idea',
    body: 'The voyage stands in for suicide.',
    answer: '',
    source: 'Ch. 1',
    cfi: 'epubcfi(/6/4)',
    createdAt: 1000,
    ...over,
  }
}

describe('cardFromMark', () => {
  it('makes an Excerpt from a bare highlight, keeping the words', () => {
    // Nothing has been made yet, so the text is the card. Pre-filling any other
    // kind with the quotation would make it look worked when it is not.
    const made = cardFromMark({
      bookId: 'book-a',
      text: 'Call me Ishmael',
      note: '',
      chapter: 'Ch. 1',
      cfi: 'cfi/1',
    })
    expect(made.kind).toBe('Excerpt')
    expect(made.body).toBe('Call me Ishmael')
  })

  it('makes an Idea from a note, because the reader already did the work', () => {
    const made = cardFromMark({
      bookId: 'book-a',
      text: 'Call me Ishmael',
      note: 'The name is a handle, not an identity.',
      chapter: 'Ch. 1',
      cfi: 'cfi/1',
    })
    expect(made.kind).toBe('Idea')
    expect(made.body).toBe('The name is a handle, not an identity.')
  })

  it('keeps the anchor, so a card can be taken back to its passage', () => {
    const made = cardFromMark({
      bookId: 'book-a',
      text: 't',
      note: '',
      chapter: 'Ch. 1',
      cfi: 'cfi/7',
    })
    expect(made.cfi).toBe('cfi/7')
    expect(made.source).toBe('Ch. 1')
  })

  it('treats a whitespace-only note as no note', () => {
    const made = cardFromMark({
      bookId: 'b',
      text: 'quoted',
      note: '   ',
      chapter: '',
      cfi: 'x',
    })
    expect(made.kind).toBe('Excerpt')
    expect(made.body).toBe('quoted')
  })
})

describe('ordering and filtering', () => {
  it('puts the newest card first', () => {
    const sorted = byNewest([card({ id: 'old', createdAt: 1 }), card({ id: 'new', createdAt: 9 })])
    expect(sorted.map((c) => c.id)).toEqual(['new', 'old'])
  })

  it('does not mutate its input', () => {
    const input = [card({ id: 'a', createdAt: 1 }), card({ id: 'b', createdAt: 9 })]
    byNewest(input)
    expect(input.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('addCard and removeCard', () => {
  it('adds to the front and removes by id', () => {
    const after = addCard([card({ id: 'a' })], card({ id: 'b' }))
    expect(after.map((c) => c.id)).toEqual(['b', 'a'])
    expect(removeCard(after, 'b').map((c) => c.id)).toEqual(['a'])
  })

  it('keeps two cards made from the same passage', () => {
    // Unlike marks, a card is not identified by its anchor: one passage can
    // legitimately yield an Excerpt and an Idea.
    const excerpt = card({ id: 'a', kind: 'Excerpt' })
    const idea = card({ id: 'b', kind: 'Idea' })
    expect(addCard([excerpt], idea)).toHaveLength(2)
  })
})

describe('parseCards', () => {
  it('reads back what was written, including a null anchor', () => {
    const cards = [card(), card({ id: 'c2', cfi: null })]
    expect(parseCards(JSON.stringify(cards))).toEqual(cards)
  })

  it('returns nothing for absent, malformed or non-array payloads', () => {
    expect(parseCards(null)).toEqual([])
    expect(parseCards('nope')).toEqual([])
    expect(parseCards('{"cards":[]}')).toEqual([])
  })

  it('drops a row whose kind is not one of the five', () => {
    const payload = JSON.stringify([card({ id: 'good' }), { ...card(), kind: 'Invented' }])
    const parsed = parseCards(payload)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('good')
  })
})
