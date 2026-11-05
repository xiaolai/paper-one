import { describe, expect, it } from 'vitest'
import { cardFromMark } from './cardFromMark'

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

  it('leaves the answer empty, because only a Recall has one', () => {
    const made = cardFromMark({ bookId: 'book-a', text: 'Call me Ishmael', note: '', chapter: 'Ch. 1', cfi: 'cfi/1' })
    expect(made).toEqual({
      bookId: 'book-a',
      kind: 'Excerpt',
      body: 'Call me Ishmael',
      answer: '',
      source: 'Ch. 1',
      cfi: 'cfi/1',
    })
  })
})
