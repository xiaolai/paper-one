import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { parseRecord, type BookRecord, type Card, type Mark } from '../../../kernel'
import { hlcOf, makeHlc } from './clock'
import {
  canonicalJson,
  cardsDigest,
  fromWire,
  marksDigest,
  mergeCards,
  mergeMarks,
  mergeRecord,
  recordDigest,
  toWire,
} from './merge'

/* ------------------------------------------------------------ generators */

const DEVICES = ['a1b2c3d4e5f60718', 'ffeeddccbbaa9988', '0000000000000001'] as const

const arbHlc = fc
  .record({
    ms: fc.integer({ min: 0, max: 1_000_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom(...DEVICES),
  })
  .map(({ ms, counter, device }) => makeHlc(ms, counter, device))

const arbTagClock = fc.dictionary(
  fc.constantFrom('sea', 'whaling', 'to reread', 'melville'),
  fc.record({ at: arbHlc, on: fc.boolean() }),
  { maxKeys: 4 },
)

/**
 * An arbitrary record IN `parseRecord` SHAPE — the merge's stated input
 * domain — produced by building a plausible raw object and running it
 * through the real parser, so coherence (tags derived from the clock when
 * one exists) is by construction, not by hand.
 */
const arbRecord: fc.Arbitrary<BookRecord> = fc
  .record(
    {
      title: fc.constantFrom('Moby-Dick', 'Walden', ''),
      author: fc.constantFrom('Melville', ''),
      publisher: fc.option(fc.constantFrom('Harper', 'Ticknor'), { nil: undefined }),
      subjects: fc.option(fc.subarray(['Whaling', 'Nature']), { nil: undefined }),
      tags: fc.option(fc.subarray(['Sea', 'To reread', 'Melville']), { nil: undefined }),
      tagClock: fc.option(
        arbTagClock.map((clock) =>
          Object.fromEntries(
            Object.entries(clock).map(([key, entry]) => [
              key,
              { ...entry, spelling: key === 'to reread' ? 'To reread' : key[0]!.toUpperCase() + key.slice(1) },
            ]),
          ),
        ),
        { nil: undefined },
      ),
      position: fc.option(fc.constantFrom('epubcfi(/6/4)', 'epubcfi(/6/8)'), { nil: undefined }),
      progress: fc.option(fc.float({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
      positionAt: fc.option(arbHlc, { nil: undefined }),
      finished: fc.option(fc.boolean(), { nil: undefined }),
      finishedAt: fc.option(arbHlc, { nil: undefined }),
      addedAt: fc.option(fc.integer({ min: 0, max: 2_000_000 }), { nil: undefined }),
      openedAt: fc.option(fc.integer({ min: 0, max: 2_000_000 }), { nil: undefined }),
      parsedAt: fc.option(fc.integer({ min: 0, max: 2_000_000 }), { nil: undefined }),
      origin: fc.option(fc.constantFrom('/here/a.epub', '/there/b.epub'), { nil: undefined }),
      ext: fc.option(fc.constantFrom('epub', 'pdf'), { nil: undefined }),
      contentHash: fc.option(fc.constantFrom('ab'.repeat(32), 'cd'.repeat(32)), { nil: undefined }),
      format: fc.option(fc.constantFrom('epub', 'pdf'), { nil: undefined }),
    },
    { requiredKeys: ['title', 'author'] },
  )
  .map((raw) => {
    const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))
    return parseRecord(JSON.stringify(clean))!
  })

const arbStampPair = fc.record(
  { updatedAt: fc.option(arbHlc, { nil: undefined }), deletedAt: fc.option(arbHlc, { nil: undefined }) },
  { requiredKeys: [] },
)

const markOf = (id: string, note: string, stamps: { updatedAt?: string | undefined; deletedAt?: string | undefined }): Mark =>
  ({
    id,
    bookId: 'book:a',
    cfi: `epubcfi(/6/4!/4/2,/1:0,/1:${1 + (id.charCodeAt(0) % 9)})`,
    sectionIndex: 0,
    text: `passage ${id}`,
    prefix: '',
    suffix: '',
    note,
    kind: 'highlight',
    chapter: 'One',
    createdAt: 1000 + id.charCodeAt(0),
    ...(stamps.updatedAt ? { updatedAt: stamps.updatedAt } : {}),
    ...(stamps.deletedAt ? { deletedAt: stamps.deletedAt } : {}),
  }) as Mark

/** A replica's view: some subset of a small id space, with divergent notes and stamps. */
const arbMarks: fc.Arbitrary<readonly Mark[]> = fc.array(
  fc
    .record({ id: fc.constantFrom('m1', 'm2', 'm3', 'm4'), note: fc.constantFrom('', 'a', 'b'), stamps: arbStampPair })
    .map(({ id, note, stamps }) => markOf(id, note, stamps)),
  { maxLength: 4 },
).map((marks) => {
  const seen = new Set<string>()
  return marks.filter((mark) => (seen.has(mark.id) ? false : (seen.add(mark.id), true)))
})

const cardOf = (id: string, body: string, stamps: { updatedAt?: string | undefined; deletedAt?: string | undefined }): Card =>
  ({
    id,
    bookId: 'book:a',
    kind: 'Excerpt',
    body,
    answer: '',
    source: 'One',
    cfi: null,
    createdAt: 1000 + id.charCodeAt(0),
    ...(stamps.updatedAt ? { updatedAt: stamps.updatedAt } : {}),
    ...(stamps.deletedAt ? { deletedAt: stamps.deletedAt } : {}),
  }) as Card

const arbCards: fc.Arbitrary<readonly Card[]> = fc.array(
  fc
    .record({ id: fc.constantFrom('c1', 'c2', 'c3'), body: fc.constantFrom('x', 'y'), stamps: arbStampPair })
    .map(({ id, body, stamps }) => cardOf(id, body, stamps)),
  { maxLength: 3 },
).map((cards) => {
  const seen = new Set<string>()
  return cards.filter((card) => (seen.has(card.id) ? false : (seen.add(card.id), true)))
})

/** Order-insensitive view of a mark or card list, for convergence claims. */
const byId = <T extends { id: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : 1))

const RUNS = { numRuns: 500 }

/* -------------------------------------------------------------- records */

describe('mergeRecord is a semilattice', () => {
  it('commutes', () => {
    fc.assert(
      fc.property(arbRecord, arbRecord, (a, b) => {
        expect(mergeRecord(a, b)).toEqual(mergeRecord(b, a))
      }),
      RUNS,
    )
  })

  it('associates', () => {
    fc.assert(
      fc.property(arbRecord, arbRecord, arbRecord, (a, b, c) => {
        expect(mergeRecord(mergeRecord(a, b), c)).toEqual(mergeRecord(a, mergeRecord(b, c)))
      }),
      RUNS,
    )
  })

  it('absorbs redelivery — merging anything already merged changes nothing', () => {
    fc.assert(
      fc.property(arbRecord, arbRecord, (a, b) => {
        const m = mergeRecord(a, b)
        expect(mergeRecord(m, a)).toEqual(m)
        expect(mergeRecord(m, b)).toEqual(m)
        expect(mergeRecord(m, m)).toEqual(m)
      }),
      RUNS,
    )
  })

  it('three replicas converge under every delivery order', () => {
    fc.assert(
      fc.property(arbRecord, arbRecord, arbRecord, (a, b, c) => {
        const orders = [
          [a, b, c],
          [a, c, b],
          [b, a, c],
          [b, c, a],
          [c, a, b],
          [c, b, a],
        ]
        const states = orders.map((order) => order.reduce(mergeRecord))
        for (const state of states) expect(state).toEqual(states[0])
      }),
      { numRuns: 200 },
    )
  })
})

describe('mergeRecord — the registers, one by one', () => {
  const base: BookRecord = { title: 'Moby-Dick', author: 'Melville' }
  const t = (ms: number) => makeHlc(ms, 0, DEVICES[0])

  it('the position group travels whole, by its stamp', () => {
    const behind: BookRecord = { ...base, position: 'epubcfi(/6/4)', progress: 0.1, positionAt: t(10) }
    const ahead: BookRecord = { ...base, position: 'epubcfi(/6/8)', progress: 0.9, positionAt: t(20) }
    for (const merged of [mergeRecord(behind, ahead), mergeRecord(ahead, behind)]) {
      expect(merged.position).toBe('epubcfi(/6/8)')
      expect(merged.progress).toBe(0.9)
      expect(merged.positionAt).toBe(t(20))
    }
  })

  it('a stamped position beats any legacy one, and a legacy one beats absence', () => {
    const legacy: BookRecord = { ...base, position: 'epubcfi(/6/8)', progress: 0.9 }
    const stamped: BookRecord = { ...base, position: 'epubcfi(/6/4)', progress: 0.1, positionAt: t(1) }
    expect(mergeRecord(legacy, stamped).position).toBe('epubcfi(/6/4)')
    expect(mergeRecord(base, legacy).position).toBe('epubcfi(/6/8)')
  })

  it('finished flips by its stamp — a newer "not finished" undoes an older "finished"', () => {
    const done: BookRecord = { ...base, finished: true, finishedAt: t(10) }
    const undone: BookRecord = { ...base, finished: false, finishedAt: t(20) }
    expect(mergeRecord(done, undone).finished).toBe(false)
    expect(mergeRecord(undone, done).finished).toBe(false)
  })

  it('each tag is its own register: a newer off removes, a newer on restores, spelling follows the stamp', () => {
    const tagged: BookRecord = parseRecord(
      JSON.stringify({
        ...base,
        tagClock: { sea: { at: t(10), on: true, spelling: 'Sea' }, whaling: { at: t(10), on: true, spelling: 'Whaling' } },
      }),
    )!
    const retagged: BookRecord = parseRecord(
      JSON.stringify({
        ...base,
        tagClock: { sea: { at: t(20), on: false, spelling: 'Sea' }, whaling: { at: t(20), on: true, spelling: 'WHALING' } },
      }),
    )!
    const merged = mergeRecord(tagged, retagged)
    expect(merged.tags).toEqual(['WHALING'])
    expect(merged.tagClock?.['sea']).toEqual({ at: t(20), on: false, spelling: 'Sea' })
  })

  it('legacy tags become registers stamped from addedAt, so a stamped removal beats them', () => {
    const legacy: BookRecord = { ...base, tags: ['Sea'], addedAt: 5 }
    const removed: BookRecord = parseRecord(
      JSON.stringify({ ...base, addedAt: 5, tagClock: { sea: { at: t(50), on: false, spelling: 'Sea' } } }),
    )!
    for (const merged of [mergeRecord(legacy, removed), mergeRecord(removed, legacy)]) {
      expect(merged.tags).toBeUndefined()
      expect(merged.tagClock?.['sea']?.on).toBe(false)
    }
    // And two legacy replicas simply union — every register is on.
    const other: BookRecord = { ...base, tags: ['Whaling'], addedAt: 9 }
    expect(mergeRecord(legacy, other).tags).toEqual(['Sea', 'Whaling'])
  })

  it('metadata travels whole by max parsedAt; addedAt min; openedAt max', () => {
    const early: BookRecord = { ...base, publisher: 'Harper', parsedAt: 10, addedAt: 5, openedAt: 100 }
    const late: BookRecord = { ...base, title: 'Moby-Dick; or, The Whale', parsedAt: 20, addedAt: 8, openedAt: 50 }
    for (const merged of [mergeRecord(early, late), mergeRecord(late, early)]) {
      expect(merged.title).toBe('Moby-Dick; or, The Whale')
      // The GROUP travels whole: the older parse's publisher does not leak under the newer parse.
      expect(merged.publisher).toBeUndefined()
      expect(merged.parsedAt).toBe(20)
      expect(merged.addedAt).toBe(5)
      expect(merged.openedAt).toBe(100)
    }
  })
})

/* ------------------------------------------------------- marks and cards */

describe('mergeMarks / mergeCards are semilattices with latest-action-wins', () => {
  it('marks: commute, associate, absorb — up to order, which is not state', () => {
    fc.assert(
      fc.property(arbMarks, arbMarks, arbMarks, (a, b, c) => {
        expect(byId(mergeMarks(a, b))).toEqual(byId(mergeMarks(b, a)))
        expect(byId(mergeMarks(mergeMarks(a, b), c))).toEqual(byId(mergeMarks(a, mergeMarks(b, c))))
        const m = mergeMarks(a, b)
        expect(mergeMarks(m, a)).toBe(m) // identity: redelivery is a no-write
        expect(mergeMarks(m, m)).toBe(m)
      }),
      RUNS,
    )
  })

  it('cards: the same, delete included', () => {
    fc.assert(
      fc.property(arbCards, arbCards, arbCards, (a, b, c) => {
        expect(byId(mergeCards(a, b))).toEqual(byId(mergeCards(b, a)))
        expect(byId(mergeCards(mergeCards(a, b), c))).toEqual(byId(mergeCards(a, mergeCards(b, c))))
        const m = mergeCards(a, b)
        expect(mergeCards(m, a)).toBe(m)
      }),
      RUNS,
    )
  })

  it('a tombstone beats an older edit; a newer edit beats an older tombstone — latest action wins', () => {
    const t = (ms: number) => makeHlc(ms, 0, DEVICES[0])
    const edited = markOf('m1', 'kept thought', { updatedAt: t(10) })
    const deleted = markOf('m1', '', { updatedAt: t(5), deletedAt: t(20) })
    // Tombstone newer: the mark dies, both orders.
    expect(mergeMarks([edited], [deleted])).toEqual([deleted])
    expect(mergeMarks([deleted], [edited])).toEqual([deleted])
    // Edit newer than the tombstone: the mark comes back — stated plainly,
    // resurrection is the rule's OTHER half, not a bug.
    const revived = markOf('m1', 'written again', { updatedAt: t(30) })
    expect(mergeMarks([deleted], [revived])).toEqual([revived])
    expect(mergeMarks([revived], [deleted])).toEqual([revived])
  })

  it('legacy rows stamp from createdAt, so any stamped action beats them', () => {
    const legacy = markOf('m1', 'old note', {})
    const acted = markOf('m1', '', { deletedAt: hlcOf(legacy.createdAt + 1) })
    expect(mergeMarks([legacy], [acted])).toEqual([acted])
    expect(mergeMarks([acted], [legacy])).toEqual([acted])
  })
})

/* --------------------------------------------------------------- wire */

describe('the wire', () => {
  it('never carries a device-local field, either direction', () => {
    fc.assert(
      fc.property(arbRecord, (record) => {
        const wire = toWire(record)
        expect(wire).not.toHaveProperty('origin')
        expect(wire).not.toHaveProperty('ext')
        expect(wire).not.toHaveProperty('keepContent')
        expect(wire).not.toHaveProperty('hasContent')
        // format travels; ext does not.
        if (record.format) expect(wire.format).toBe(record.format)
        // And a peer ASSERTING one inbound is stripped on arrival.
        const landed = fromWire({ ...wire, origin: '/their/mac/path', ext: 'exe', hasContent: true })
        expect(landed).not.toBeNull()
        expect(landed).not.toHaveProperty('origin')
        expect(landed).not.toHaveProperty('ext')
        expect(landed).not.toHaveProperty('hasContent')
      }),
      RUNS,
    )
  })

  it('round-trips a record through the wire and the parser unchanged (device-local aside)', () => {
    fc.assert(
      fc.property(arbRecord, (record) => {
        expect(fromWire(toWire(record))).toEqual(toWire(record))
      }),
      RUNS,
    )
  })

  it('refuses what is not a record', () => {
    expect(fromWire(null)).toBeNull()
    expect(fromWire([])).toBeNull()
    expect(fromWire('a record')).toBeNull()
  })
})

/* ------------------------------------------------------------- digests */

describe('digests', () => {
  const t = (ms: number) => makeHlc(ms, 0, DEVICES[0])

  it('marks digest is equal under reordering and unequal under a changed stamp', async () => {
    const a = markOf('m1', 'x', { updatedAt: t(10) })
    const b = markOf('m2', 'y', { deletedAt: t(20) })
    expect(await marksDigest([a, b])).toBe(await marksDigest([b, a]))
    expect(await marksDigest([a, b])).not.toBe(await marksDigest([{ ...a, updatedAt: t(11) }, b]))
    // A tombstone is IN the digest — deletions must be comparable too.
    expect(await marksDigest([a])).not.toBe(await marksDigest([{ ...a, deletedAt: t(30) }]))
  })

  it('cards digest likewise', async () => {
    const a = cardOf('c1', 'x', { updatedAt: t(10) })
    const b = cardOf('c2', 'y', {})
    expect(await cardsDigest([a, b])).toBe(await cardsDigest([b, a]))
    expect(await cardsDigest([a, b])).not.toBe(await cardsDigest([{ ...a, updatedAt: t(11) }, b]))
  })

  it('record digest ignores map order and device-local fields, and sees a stamp change', async () => {
    const record = parseRecord(
      JSON.stringify({
        title: 'T',
        author: 'A',
        positionAt: t(10),
        tagClock: { sea: { at: t(5), on: true, spelling: 'Sea' }, whaling: { at: t(5), on: true, spelling: 'Whaling' } },
      }),
    )!
    const reordered = parseRecord(
      JSON.stringify({
        tagClock: { whaling: { at: t(5), on: true, spelling: 'Whaling' }, sea: { at: t(5), on: true, spelling: 'Sea' } },
        author: 'A',
        positionAt: t(10),
        title: 'T',
      }),
    )!
    expect(await recordDigest(record)).toBe(await recordDigest(reordered))
    expect(await recordDigest({ ...record, ext: 'epub', origin: '/here' })).toBe(await recordDigest(record))
    expect(await recordDigest({ ...record, positionAt: t(11) })).not.toBe(await recordDigest(record))
  })

  it('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })
})
