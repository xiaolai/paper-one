import { describe, expect, it } from 'vitest'
import { hlcOf, matchWork, newRelationship, readmit, type Hlc, type Relationship } from '../../../kernel'
import { namesOf, sentencesOf, starsText, viewOf, type PersonHeld } from './circleView'
import { NOTHING_SHARED, type ForeignFile } from './store'

/**
 * WI-23.D1, D2, D3 — the three falsifiers, as assertions.
 *
 *  - D1: grep the sentences for a decimal. Any hit is a mean.
 *  - D2: with one friend, every co-occurring title appears with that one
 *    name and no ranking.
 *  - D3: block, readmit; a review from the older epoch is not drawn.
 */

const BOOKS = [
  { id: 'book:moby', title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247', languages: ['en'] },
  { id: 'book:dune', title: 'Dune', author: 'Frank Herbert', languages: ['en'] },
]
const MOBY = BOOKS[0]!
const at = (n: number): Hlc => hlcOf(n)

const shelfOf = (...works: { title: string; author: string; identifier?: string }[]): ForeignFile => ({
  ...NOTHING_SHARED,
  works: works.map((work, i) => ({ pub: `p${i}`, work: { ...work, language: 'en' }, at: at(i + 1) })),
})
const held = (over: Partial<ForeignFile>): ForeignFile => ({ ...NOTHING_SHARED, ...over })
const person = (name: string, over: Partial<PersonHeld> = {}): PersonHeld => ({
  person: name.toLowerCase(),
  name,
  relationship: newRelationship(name.toLowerCase(), at(1)),
  shelf: NOTHING_SHARED,
  held: NOTHING_SHARED,
  ...over,
})
const MOBY_ROW = { title: 'Moby-Dick', author: 'Herman Melville', identifier: 'isbn:9780142437247' }

describe('the circle’s view of a book — WI-23.D1', () => {
  it('names who has it, who is where in it, and counts the ratings — never a mean', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Alice', {
        shelf: shelfOf(MOBY_ROW),
        held: held({ opinion: { status: { value: 'finished', at: at(2), device: 'd', seq: 1 }, stars: { value: 5, at: at(3), device: 'd', seq: 2 } } }),
      }),
      person('Bob', { shelf: shelfOf(MOBY_ROW), held: held({ opinion: { stars: { value: 4, at: at(3), device: 'd', seq: 2 } } }) }),
      person('Carol', { held: held({ opinion: { status: { value: 'reading', at: at(2), device: 'd', seq: 1 }, stars: { value: 3, at: at(3), device: 'd', seq: 2 } } }) }),
      person('Dan', { held: held({ opinion: { status: { value: 'want', at: at(2), device: 'd', seq: 1 } } }) }),
      /* Nothing at all: not a person on this surface. */
      person('Eve'),
    ])
    expect(view.people.map((one) => [one.name, one.has, one.status, one.stars])).toEqual([
      ['Alice', true, 'finished', 5],
      ['Bob', true, null, 4],
      ['Carol', false, 'reading', 3],
      ['Dan', false, 'want', null],
    ])
    const sentences = sentencesOf(view)
    expect(sentences).toEqual([
      'Alice and Bob have this.',
      'Dan wants to read it.',
      'Carol is reading it.',
      'Alice finished it.',
      'Alice, Bob and Carol rated it: 2 of 3 gave it four stars or more.',
    ])
    /* THE FALSIFIER. The mean here would be 4.0. */
    expect(sentences.join(' ')).not.toMatch(/\d\.\d/u)
    expect(starsText(4)).toBe('4 of 5 stars')
  })

  it('conjugates for one and for many', () => {
    const one = (status: 'want' | 'reading' | 'finished', names: string[]) =>
      sentencesOf({
        people: names.map((name) => ({ person: name, name, has: true, status, stars: null, reviews: [] })),
        alsoRead: [],
      })
    expect(one('want', ['Al'])).toEqual(['Al has this.', 'Al wants to read it.'])
    expect(one('want', ['Al', 'Bo'])).toEqual(['Al and Bo have this.', 'Al and Bo want to read it.'])
    expect(one('reading', ['Al', 'Bo'])).toEqual(['Al and Bo have this.', 'Al and Bo are reading it.'])
    expect(one('finished', ['Al', 'Bo', 'Cy'])).toEqual(['Al, Bo and Cy have this.', 'Al, Bo and Cy finished it.'])
    expect(namesOf([])).toBe('')
    expect(sentencesOf({ people: [], alsoRead: [] })).toEqual([])
  })

  it('counts four stars as "four or more", and three as not', () => {
    const rated = (stars: (1 | 2 | 3 | 4 | 5)[]) =>
      sentencesOf({
        people: stars.map((value, i) => ({ person: `p${i}`, name: `P${i}`, has: false, status: null, stars: value, reviews: [] })),
        alsoRead: [],
      })
    expect(rated([4])).toEqual(['P0 rated it: 1 of 1 gave it four stars or more.'])
    expect(rated([3])).toEqual(['P0 rated it: 0 of 1 gave it four stars or more.'])
    expect(rated([5, 3, 4, 1])).toEqual(['P0, P1, P2 and P3 rated it: 2 of 4 gave it four stars or more.'])
  })

  it('is empty for a person whose relationship does not draw, whatever they said', () => {
    const muted: Relationship = { ...newRelationship('bob', at(1)), state: 'muted' }
    const view = viewOf(MOBY, BOOKS, [
      person('Bob', { relationship: muted, shelf: shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' }), held: held({ opinion: { stars: { value: 5, at: at(3), device: 'd', seq: 2 } } }) }),
    ])
    expect(view).toEqual({ people: [], alsoRead: [] })
  })
})

describe('friends who have this also have — WI-23.D2', () => {
  it('names each friend on each co-occurring work, ranks by how many, and links the reader’s own copy', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Alice', { shelf: shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' }, { title: 'Emma', author: 'Jane Austen' }) }),
      person('Bob', { shelf: shelfOf(MOBY_ROW, { title: 'Emma', author: 'Jane Austen' }) }),
      /* Carol does not have Moby-Dick: her shelf says nothing about it. */
      person('Carol', { shelf: shelfOf({ title: 'Dune', author: 'Frank Herbert' }, { title: 'Zorba', author: 'Kazantzakis' }) }),
    ])
    expect(view.alsoRead).toMatchObject([
      { title: 'Emma', author: 'Jane Austen', names: ['Alice', 'Bob'], own: null },
      { title: 'Dune', author: 'Frank Herbert', names: ['Alice'], own: 'book:dune' },
    ])
  })

  it('with one friend, every title carries that one name and the order is by title — no ranking', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Alice', { shelf: shelfOf(MOBY_ROW, { title: 'Zorba', author: 'Kazantzakis' }, { title: 'Dune', author: 'Frank Herbert' }, { title: 'Emma', author: 'Jane Austen' }) }),
    ])
    expect(view.alsoRead.map((one) => [one.title, one.names])).toEqual([
      ['Dune', ['Alice']],
      ['Emma', ['Alice']],
      ['Zorba', ['Alice']],
    ])
  })

  it('folds two spellings of one work into one row, and never lists the book itself', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Alice', { shelf: shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' }) }),
      person('Bob', { shelf: shelfOf({ title: 'Moby-Dick; or, The Whale', author: 'Herman Melville' }, { title: 'Dune: the novel', author: 'Frank Herbert' }) }),
    ])
    expect(view.people.map((one) => one.name)).toEqual(['Alice', 'Bob'])
    expect(view.alsoRead).toMatchObject([{ title: 'Dune', author: 'Frank Herbert', names: ['Alice', 'Bob'], own: 'book:dune' }])
  })
})

describe('reviews, drawn subject to the relationship — WI-23.D3', () => {
  const reviews = [
    { pub: 'r1', text: 'before the block', at: at(2), epoch: 1 },
    { pub: 'r2', text: 'after the readmission', at: at(9), epoch: 2 },
  ]
  it('draws a review from the current epoch and not one from before a block — the falsifier', () => {
    const blockedThenReadmitted = readmit({ ...newRelationship('bob', at(1)), state: 'blocked' }, at(5))
    expect(blockedThenReadmitted.epoch).toBe(2)
    const view = viewOf(MOBY, BOOKS, [person('Bob', { relationship: blockedThenReadmitted, held: held({ reviews }) })])
    expect(view.people[0]!.reviews).toEqual([{ text: 'after the readmission', at: at(9) }])
  })

  it('finds the reader’s own copy through a later candidate, and keeps it once found', () => {
    /* Two rows in one group through a shared identifier; only the one naming
       the author as the shelf does resolves to the reader's copy. People sort
       by id, so the names decide which row the group meets first. */
    const resolving = { title: 'Dune', author: 'Frank Herbert', identifier: 'idX' }
    const bridged = { title: 'Dune', author: 'F. Herbert', identifier: 'idX' }
    const later = viewOf(MOBY, BOOKS, [person('Aaron', { shelf: shelfOf(MOBY_ROW, bridged) }), person('Zed', { shelf: shelfOf(MOBY_ROW, resolving) })])
    expect(later.alsoRead.map((one) => [one.names, one.own])).toEqual([[['Aaron', 'Zed'], 'book:dune']])
    const kept = viewOf(MOBY, BOOKS, [person('Aaron', { shelf: shelfOf(MOBY_ROW, resolving) }), person('Zed', { shelf: shelfOf(MOBY_ROW, bridged) })])
    expect(kept.alsoRead.map((one) => [one.names, one.own])).toEqual([[['Aaron', 'Zed'], 'book:dune']])
  })

  it('lists nobody whose relationship draws nothing — muted, blocked or exited', () => {
    for (const state of ['muted', 'blocked', 'exited'] as const) {
      const one = { ...newRelationship('bob', at(1)), state }
      expect(viewOf(MOBY, BOOKS, [person('Bob', { relationship: one, shelf: shelfOf(MOBY_ROW) })]).people).toEqual([])
    }
  })

  it('reads a shelf row kept before epochs were stamped as the first epoch’s, so a re-admission does not revive it', () => {
    /* `shelfOf` stamps no epoch on its rows — the shape a row had before the epoch was kept. */
    const readmitted = readmit({ ...newRelationship('bob', at(1)), state: 'blocked' }, at(5))
    expect(viewOf(MOBY, BOOKS, [person('Bob', { relationship: readmitted, shelf: shelfOf(MOBY_ROW) })]).people).toEqual([])
    const first = viewOf(MOBY, BOOKS, [person('Bob', { relationship: newRelationship('bob', at(1)), shelf: shelfOf(MOBY_ROW) })])
    expect(first.people.map((one) => [one.name, one.has])).toEqual([['Bob', true]])
  })

  it('draws every review of the current epoch, newest first, and a person with only old ones says nothing', () => {
    const first = newRelationship('bob', at(1))
    const view = viewOf(MOBY, BOOKS, [
      person('Bob', { relationship: first, held: held({ reviews: [{ pub: 'a', text: 'older', at: at(2), epoch: 1 }, { pub: 'b', text: 'newer', at: at(3), epoch: 1 }] }) }),
      person('Cy', { relationship: readmit(first, at(5)), held: held({ reviews: [{ pub: 'c', text: 'gone', at: at(2), epoch: 1 }] }) }),
    ])
    expect(view.people.map((one) => [one.name, one.reviews.map((review) => review.text)])).toEqual([['Bob', ['newer', 'older']]])
  })
})

describe('every clause of the view — one row each', () => {
  const held = (over: Partial<ForeignFile>): ForeignFile => ({ ...NOTHING_SHARED, ...over })
  const person = (name: string, over: Partial<PersonHeld> = {}): PersonHeld => ({
    person: name.toLowerCase(),
    name,
    relationship: newRelationship(name.toLowerCase(), at(1)),
    shelf: NOTHING_SHARED,
    held: NOTHING_SHARED,
    ...over,
  })
  const shelfOf = (...works: { title: string; author: string; identifier?: string }[]): ForeignFile => ({
    ...NOTHING_SHARED,
    works: works.map((work, i) => ({ pub: `p${i}`, work: { ...work, language: 'en' }, at: at(i + 1) })),
  })

  it('orders reviews newest first whatever order they were held in, and keeps the held order at an equal stamp', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Bob', { held: held({ reviews: [{ pub: 'a', text: 'older', at: at(2), epoch: 1 }, { pub: 'b', text: 'newer', at: at(3), epoch: 1 }, { pub: 'c', text: 'same-first', at: at(3), epoch: 1 }] }) }),
    ])
    expect(view.people[0]!.reviews.map((one) => one.text)).toEqual(['newer', 'same-first', 'older'])
  })

  it('counts a person who only rated it', () => {
    const view = viewOf(MOBY, BOOKS, [person('Bob', { held: held({ opinion: { stars: { value: 2, at: at(3), device: 'd', seq: 2 } } }) })])
    expect(view.people.map((one) => [one.name, one.has, one.status, one.stars])).toEqual([['Bob', false, null, 2]])
  })

  it('names a friend once on a work they shelved under two spellings', () => {
    const view = viewOf(MOBY, BOOKS, [
      person('Alice', { shelf: shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' }, { title: 'Dune: the novel', author: 'Frank Herbert' }) }),
    ])
    expect(view.alsoRead).toMatchObject([{ title: 'Dune', author: 'Frank Herbert', names: ['Alice'], own: 'book:dune' }])
  })
})

describe('two people, one name', () => {
  it('counts both on a work they both have, by person and not by name', () => {
    const shelfOf = (...works: { title: string; author: string; identifier?: string }[]): ForeignFile => ({
      ...NOTHING_SHARED,
      works: works.map((work, i) => ({ pub: `p${i}`, work: { ...work, language: 'en' }, at: at(i + 1) })),
    })
    const person = (id: string, name: string, shelf: ForeignFile): PersonHeld => ({ person: id, name, relationship: newRelationship(id, at(1)), shelf, held: NOTHING_SHARED })
    const view = viewOf(MOBY, BOOKS, [
      person('alice-1', 'Alice', shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' })),
      person('alice-2', 'Alice', shelfOf(MOBY_ROW, { title: 'Dune', author: 'Frank Herbert' })),
    ])
    expect(view.alsoRead).toMatchObject([{ title: 'Dune', author: 'Frank Herbert', names: ['Alice', 'Alice'], own: 'book:dune' }])
  })
})

describe('the also-read groups, as a closure over every pair', () => {
  const claimed = (over: Partial<{ id: string; identifier: string; title: string; author: string }>) => ({
    pub: over.id ?? 'p',
    work: { title: over.title ?? 'Dune', author: over.author ?? 'Herbert', language: 'en', ...(over.identifier ? { identifier: over.identifier } : {}) },
  })
  it('joins three claims where only the middle one meets both, names each person once, and finds the copy from any member', () => {
    /* A: identifier and title; B: the identifier only, under another title; C: the title only. A meets B (strong) and A meets C (weak); B and C never meet. */
    /* Everybody has the viewed book (isbn:0); what they ALSO read is what is grouped. */
    const a = { person: 'p-a', name: 'Ann', relationship: newRelationship('p-a', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'a', identifier: 'isbn:1', title: 'Dune' })] }, held: NOTHING_SHARED }
    const b = { person: 'p-b', name: 'Bob', relationship: newRelationship('p-b', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'b', identifier: 'isbn:1', title: 'Dune Messiah' })] }, held: NOTHING_SHARED }
    const c = { person: 'p-c', name: 'Cy', relationship: newRelationship('p-c', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'c', title: 'Dune' }), claimed({ id: 'c2', title: 'Dune' })] }, held: NOTHING_SHARED }
    const book = { id: 'book:x', identifier: 'isbn:0', title: 'Other', author: 'Herbert', languages: ['en'] }
    const shelf = [book, { id: 'book:dune', title: 'Dune', author: 'Herbert', languages: ['en'] }]
    const forward = viewOf(book as never, shelf as never, [a, b, c] as never)
    const backward = viewOf(book as never, shelf as never, [c, b, a] as never)
    expect(forward.alsoRead).toEqual(backward.alsoRead)
    expect(forward.alsoRead).toHaveLength(1)
    expect(forward.alsoRead[0]!.names).toEqual(['Ann', 'Bob', 'Cy'])
    /* The reader's own copy is found from whichever member has one. */
    expect(forward.alsoRead[0]!.own).toBe('book:dune')
  })
})

describe('what also-read leaves out, and how its rows are told apart', () => {
  const claimed = (over: Partial<{ id: string; identifier: string; title: string; author: string }>) => ({
    pub: over.id ?? 'p',
    work: { title: over.title ?? 'Dune', author: over.author ?? 'Herbert', language: 'en', ...(over.identifier ? { identifier: over.identifier } : {}) },
  })
  it('drops a row that meets the viewed book only through another row, and keys two same-titled groups apart', () => {
    /* The book has isbn:0 and the title Dune. A friend's row with isbn:0 under another title meets the book strongly; a row with that same other title and no id meets the first row weakly — and so belongs to the book's own component, not to "also read". */
    const book = { id: 'book:x', identifier: 'isbn:0', title: 'Dune', author: 'Herbert', languages: ['en'] }
    const ann = { person: 'p-a', name: 'Ann', relationship: newRelationship('p-a', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Dune Deluxe' }), claimed({ id: 'y', title: 'Dune Deluxe' }), claimed({ id: 'z', title: 'Emma', author: 'Austen' })] }, held: NOTHING_SHARED }
    const view = viewOf(book as never, [book] as never, [ann] as never)
    expect(view.alsoRead.map((one) => one.title)).toEqual(['Emma'])
    expect(view.alsoRead[0]!.key).toBe('p-a:z')
    /* Two groups that share a title and an author — different languages' works — are two rows with two keys. */
    const bob = { person: 'p-b', name: 'Bob', relationship: newRelationship('p-b', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Dune' }), { pub: 'fr', work: { title: 'Emma', author: 'Austen', language: 'fr' } }, claimed({ id: 'en', title: 'Emma', author: 'Austen' })] }, held: NOTHING_SHARED }
    const two = viewOf(book as never, [book] as never, [bob] as never)
    expect(two.alsoRead).toHaveLength(2)
    expect(new Set(two.alsoRead.map((one) => one.key)).size).toBe(2)
  })

  it('draws a shelf row or a register only under the epoch it arrived in', () => {
    const book = { id: 'book:x', identifier: 'isbn:0', title: 'Dune', author: 'Herbert', languages: ['en'] }
    const again = { ...newRelationship('p-a', hlcOf(1)), epoch: 2 }
    const held: ForeignFile = { ...NOTHING_SHARED, opinion: { status: { value: 'reading', at: hlcOf(3), device: 'd', seq: 1, epoch: 1 }, stars: { value: 5, at: hlcOf(3), device: 'd', seq: 2, epoch: 2 } } }
    const ann = { person: 'p-a', name: 'Ann', relationship: again, shelf: { ...NOTHING_SHARED, works: [{ ...claimed({ id: 'x', identifier: 'isbn:0' }), epoch: 1 }, { ...claimed({ id: 'e', title: 'Emma', author: 'Austen' }), epoch: 2 }] }, held }
    const view = viewOf(book as never, [book] as never, [ann] as never)
    /* The shelf row that says she has the book is from the old epoch: she does not "have" it now; the register from the new one is drawn, the old one is not. */
    expect(view.people[0]).toMatchObject({ has: false, status: null, stars: 5 })
  })
})

describe('the view, held to the letter', () => {
  const claimed = (over: Partial<{ id: string; identifier: string; title: string; author: string }>) => ({
    pub: over.id ?? 'p',
    work: { title: over.title ?? 'Dune', author: over.author ?? 'Herbert', language: 'en', ...(over.identifier ? { identifier: over.identifier } : {}) },
  })
  const book = { id: 'book:x', identifier: 'isbn:0', title: 'Other', author: 'Herbert', languages: ['en'] }

  it('draws nothing of a person whose relationship draws no overlays', () => {
    const blocked = { person: 'p-b', name: 'Bo', relationship: { ...newRelationship('p-b', hlcOf(1)), state: 'blocked' as const }, shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'd', title: 'Dune' })] }, held: { ...NOTHING_SHARED, opinion: { status: { value: 'reading' as const, at: hlcOf(2), device: 'd', seq: 1 } } } }
    const view = viewOf(book as never, [book] as never, [blocked] as never)
    expect(view.people).toEqual([])
    expect(view.alsoRead).toEqual([])
  })

  it('keeps the reader’s own copy found through the first member when a later member has none', () => {
    const shelf = [book, { id: 'book:dune', identifier: 'isbn:1', title: 'Dune', author: 'Herbert', languages: ['en'] }]
    const ann = { person: 'p-a', name: 'Ann', relationship: newRelationship('p-a', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'a', identifier: 'isbn:1', title: 'Dune' })] }, held: NOTHING_SHARED }
    const bob = { person: 'p-b', name: 'Bob', relationship: newRelationship('p-b', hlcOf(1)), shelf: { ...NOTHING_SHARED, works: [claimed({ id: 'x', identifier: 'isbn:0', title: 'Other' }), claimed({ id: 'b', title: 'Dune Messiah', identifier: 'isbn:1' })] }, held: NOTHING_SHARED }
    const view = viewOf(book as never, shelf as never, [ann, bob] as never)
    expect(view.alsoRead).toHaveLength(1)
    expect(view.alsoRead[0]!.own).toBe('book:dune')
  })
})

describe('the also-read grouping, bounded', () => {
  it('compares only candidates that can meet — a shelf of a thousand unrelated books costs no comparison at all', () => {
    /* Every pair across every friend's whole shelf was quadratic in the
       circle's books. Bucketed by index key, two claims that share neither an
       identifier nor a title-author-language are never compared. */
    const books = [MOBY, ...Array.from({ length: 200 }, (_, i) => ({ id: `book:${i}`, title: `Title ${i}`, author: `Author ${i}`, languages: ['en'] }))]
    const friends = Array.from({ length: 5 }, (_, f) =>
      person(`F${f}`, {
        shelf: shelfOf(MOBY_ROW, ...Array.from({ length: 200 }, (_, i) => ({ title: `Title ${i}`, author: `Author ${i}` }))),
      }),
    )
    let compared = 0
    const counting: Parameters<typeof viewOf>[3] = (a, b) => {
      compared += 1
      return matchWork(a, b)
    }
    const view = viewOf(MOBY, books, friends, counting)
    /* Five friends hold each of the two hundred titles: only the copies of
       one title meet — ten pairs per title, judged once per key they share
       — where every pair of the thousand-odd candidates was half a million. */
    expect(view.alsoRead).toHaveLength(200)
    expect(view.alsoRead.every((one) => one.names.length === 5)).toBe(true)
    const naive = (1_005 * 1_004) / 2
    expect(compared).toBeLessThan(naive / 100)
    expect(compared).toBeLessThanOrEqual(200 * 10 * 2 + 30)
    /* Against the grain: two hundred distinct titles from one friend meet
       nothing but the book itself, and cost nothing beyond it. */
    compared = 0
    viewOf(MOBY, books, [friends[0]!], counting)
    expect(compared).toBeLessThanOrEqual(2)
  })
})
