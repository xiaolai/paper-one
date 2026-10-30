import { describe, expect, it } from 'vitest'
import {
  addCard,
  byNewest,
  cardFromMark,
  cardStamp,
  liveCards,
  mergeCards,
  parseCards,
  removeCard,
  type Card,
} from './cards'
import { hlcOf } from './hlc'

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
  it('adds to the front, and a remove is a tombstone the read model hides', () => {
    const after = addCard([card({ id: 'a' })], card({ id: 'b' }))
    expect(after.map((c) => c.id)).toEqual(['b', 'a'])
    const removed = removeCard(after, 'b')
    // The row STAYS, stamped, so the deletion can travel — see `removeMark`.
    expect(removed.map((c) => c.id)).toEqual(['b', 'a'])
    expect(removed.find((c) => c.id === 'b')?.deletedAt).toBeDefined()
    expect(liveCards(removed).map((c) => c.id)).toEqual(['a'])
    // Already deleted, or not there: the input by identity.
    expect(removeCard(removed, 'b')).toBe(removed)
    expect(removeCard(removed, 'nobody')).toBe(removed)
  })

  it('keeps two cards made from the same passage', () => {
    // Unlike marks, a card is not identified by its anchor: one passage can
    // legitimately yield an Excerpt and an Idea.
    const excerpt = card({ id: 'a', kind: 'Excerpt' })
    const idea = card({ id: 'b', kind: 'Idea' })
    expect(addCard([excerpt], idea)).toHaveLength(2)
  })

  it('reads a list with nothing deleted back by identity', () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' })]
    expect(liveCards(cards)).toBe(cards)
  })

  it('stamps only the live row when a deleted one shares its id', () => {
    /* `addCard` does not deduplicate, so a held list can carry two rows for
       one id — and re-stamping the older tombstone would make that deletion
       newer than it was. */
    const removed = removeCard([card({ deletedAt: hlcOf(5) }), card({ body: 'kept' })], 'c1', hlcOf(9))
    expect(removed.map((c) => c.deletedAt)).toEqual([hlcOf(5), hlcOf(9)])
  })
})

describe('cardStamp', () => {
  it('reads a legacy card from its createdAt', () => {
    expect(cardStamp(card({ createdAt: 1000 }))).toBe(hlcOf(1000))
  })

  it('reads a stamped card from its latest action, tombstone included', () => {
    expect(cardStamp(card({ updatedAt: hlcOf(20) }))).toBe(hlcOf(20))
    expect(cardStamp(card({ updatedAt: hlcOf(20), deletedAt: hlcOf(30) }))).toBe(hlcOf(30))
    expect(cardStamp(card({ updatedAt: hlcOf(20), deletedAt: hlcOf(10) }))).toBe(hlcOf(20))
  })
})

describe('mergeCards', () => {
  /* The bodies are chosen so the tie rule would pick the OTHER row: 'z' sorts
     after 'a', so wherever a stamp decides, the serialisation disagrees. */
  const newer = card({ body: 'a newer', updatedAt: hlcOf(20) })
  const older = card({ body: 'z older', updatedAt: hlcOf(10) })

  it('takes a card only the other list has, and keeps its own', () => {
    expect(mergeCards([card({ id: 'a' })], [card({ id: 'b' })])).toEqual([card({ id: 'a' }), card({ id: 'b' })])
  })

  it('takes the newer row whole, whichever list holds it', () => {
    expect(mergeCards([older], [newer])).toEqual([newer])
    const mine = [newer]
    expect(mergeCards(mine, [older])).toBe(mine)
  })

  it('breaks a tie of stamps by the serialised row, whichever list holds it', () => {
    const low = card({ body: 'a' })
    const high = card({ body: 'z' })
    expect(mergeCards([low], [high])).toEqual([high])
    const mine = [high]
    expect(mergeCards(mine, [low])).toBe(mine)
  })

  it('takes a newer tombstone, and a newer edit back from one', () => {
    const deleted = card({ updatedAt: hlcOf(10), deletedAt: hlcOf(20) })
    const edited = card({ body: 'written again', updatedAt: hlcOf(30) })
    expect(mergeCards([older], [deleted])).toEqual([deleted])
    expect(mergeCards([deleted], [edited])).toEqual([edited])
  })

  it('answers its input by identity when nothing changed — a redelivered copy included', () => {
    const mine = [newer, card({ id: 'c2' })]
    expect(mergeCards(mine, [])).toBe(mine)
    expect(mergeCards(mine, mine.map((c) => ({ ...c })))).toBe(mine)
  })
})

describe('parseCards', () => {
  it('reads back what was written, including a null anchor', () => {
    const cards = [card(), card({ id: 'c2', cfi: null })]
    expect(parseCards(JSON.stringify(cards))).toEqual(cards)
  })

  it('reads nothing stored as no cards', () => {
    expect(parseCards(null)).toEqual([])
  })

  /* UNREADABLE IS NOT EMPTY — found by the 2026-09-13 audit, `parseLookups`'
     rule. Answering [] for bytes that would not parse told `createCards` the
     collection was healthy and empty, and the next card written replaced every
     card on disk. Thrown, the store goes session-only and leaves the bytes
     where they are. Each clause is asserted in its own words, because the two
     share a prefix. */
  it.each([
    ['rubbish', 'nope', /are not JSON/u],
    ['an empty string', '', /are not JSON/u],
    ['an object', '{"cards":[]}', /are not a list/u],
    ['JSON null', 'null', /are not a list/u],
  ])('refuses %s rather than reading it as no cards', (_name, raw, clause) => {
    const cause = (() => {
      try {
        parseCards(raw)
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(clause)
  })

  it('drops a row whose kind is not one of the five', () => {
    const payload = JSON.stringify([card({ id: 'good' }), { ...card(), kind: 'Invented' }])
    const parsed = parseCards(payload)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('good')
  })

  it("keeps the parser's own error as the cause", () => {
    const cause = (() => {
      try {
        parseCards('[{"id":')
        return null
      } catch (error: unknown) {
        return error
      }
    })()
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('the stored cards are not JSON')
    expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
  })

  /* One field wrong at a time, beside a good row — so each clause of the
     validator is the only thing that can drop its row. */
  const good = card({ id: 'good' })
  const bad = (over: Record<string, unknown>) => JSON.stringify({ ...card({ id: 'bad' }), ...over })
  it.each([
    ['a row that is null', 'null'],
    ['a row that is a number', '7'],
    ['a row that is a string', '"a card"'],
    ['a row that is a list', '[]'],
    ['a row whose id is not a string', bad({ id: 7 })],
    ['a row whose id is empty', bad({ id: '' })],
    ['a row whose book id is not a string', bad({ bookId: 7 })],
    ['a row whose body is not a string', bad({ body: 7 })],
    ['a row whose body is empty', bad({ body: '' })],
    ['a row whose kind is not a string', bad({ kind: 7 })],
    ['a row whose answer is not a string', bad({ answer: null })],
    ['a row with no source', bad({ source: undefined })],
    ['a row whose anchor is neither a string nor null', bad({ cfi: 7 })],
    ['a row with no anchor at all', bad({ cfi: undefined })],
    ['a row whose createdAt is not a number', bad({ createdAt: '1000' })],
    ['a row whose createdAt is past every finite number', bad({ createdAt: 0 }).replace('"createdAt":0', '"createdAt":1e999')],
    ['a row whose createdAt is before the epoch', bad({ createdAt: -1 })],
  ])('drops %s, and keeps the rest', (_name, row) => {
    expect(parseCards(`[${JSON.stringify(good)},${row}]`)).toEqual([good])
  })

  it('keeps a card made at the epoch', () => {
    const epoch = card({ createdAt: 0 })
    expect(parseCards(JSON.stringify([epoch]))).toEqual([epoch])
  })

  it('keeps a stamp only when it is one, and invents none', () => {
    // Strict: a stamp field present as `undefined` is a field invented.
    const legacy = card({ id: 'legacy' })
    const edited = card({ id: 'edited', updatedAt: hlcOf(20) })
    const removed = card({ id: 'removed', deletedAt: hlcOf(20) })
    const deleted = card({ id: 'deleted', updatedAt: hlcOf(10), deletedAt: hlcOf(20) })
    const garbled = { ...card({ id: 'garbled' }), updatedAt: 'yesterday', deletedAt: 42 }
    expect(parseCards(JSON.stringify([legacy, edited, removed, deleted, garbled]))).toStrictEqual([
      legacy,
      edited,
      removed,
      deleted,
      card({ id: 'garbled' }),
    ])
  })

  it('clears a tombstone older than the edit, and keeps one at or after it', () => {
    const revived = card({ id: 'revived', updatedAt: hlcOf(20), deletedAt: hlcOf(10) })
    const tied = card({ id: 'tied', updatedAt: hlcOf(20), deletedAt: hlcOf(20) })
    expect(parseCards(JSON.stringify([revived, tied]))).toStrictEqual([
      card({ id: 'revived', updatedAt: hlcOf(20) }),
      tied,
    ])
  })

  it('holds one row per id — the newer, wherever it sits in the file', () => {
    const older = card({ body: 'z older', updatedAt: hlcOf(10) })
    const newer = card({ body: 'a newer', updatedAt: hlcOf(20) })
    expect(parseCards(JSON.stringify([newer, older]))).toEqual([newer])
    expect(parseCards(JSON.stringify([older, newer]))).toEqual([newer])
  })

  it('breaks a tie of stamps between duplicates by the serialised row, wherever it sits', () => {
    const low = card({ body: 'a' })
    const high = card({ body: 'z' })
    expect(parseCards(JSON.stringify([high, low]))).toEqual([high])
    expect(parseCards(JSON.stringify([low, high]))).toEqual([high])
  })
})
