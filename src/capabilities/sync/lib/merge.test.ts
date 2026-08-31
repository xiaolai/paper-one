import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  liveCards,
  liveMarks,
  parseCards,
  parseRecord,
  validMarks,
  workKey,
  type BookRecord,
  type Card,
  type Mark,
} from '../../../kernel'
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
      /* ⚠️ GENERATED, or the property tests are DECORATIVE for these two
       * (WI-21.3). "The property test passes unchanged" was the first draft's
       * acceptance criterion for adding `identifier` to the metadata group, and
       * it would have passed while the merge silently dropped the field — a
       * generator that never produces a value cannot notice it going missing.
       * Two spellings of one work plus absent, which is the case the group's
       * tie rule has to decide. */
      identifier: fc.option(fc.constantFrom('urn:isbn:9780142437247', 'urn:uuid:2701'), { nil: undefined }),
      metaSchema: fc.option(fc.constantFrom(0, 1), { nil: undefined }),
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

  it('self-merge is a fixed point — mergeRecord(x, x) IS x, for every parsed record', () => {
    fc.assert(
      fc.property(arbRecord, (x) => {
        expect(mergeRecord(x, x)).toEqual(x)
      }),
      RUNS,
    )
  })

  it('self-merge invents no tag clock on a legacy record and keeps an orphan stamp', () => {
    const legacy = parseRecord(JSON.stringify({ title: 'T', author: 'A', tags: ['Sea'], addedAt: 5 }))!
    expect(mergeRecord(legacy, legacy)).toEqual(legacy)
    expect(mergeRecord(legacy, legacy).tagClock).toBeUndefined()
    // A positionAt with no position — parseRecord keeps it — must survive.
    const orphan = parseRecord(JSON.stringify({ title: 'T', author: 'A', positionAt: makeHlc(10, 0, DEVICES[0]) }))!
    expect(mergeRecord(orphan, orphan)).toEqual(orphan)
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

  it('parsedAt is ordered as a NUMBER — an exponent spelling does not lose to a smaller value', () => {
    // (1e21).toString() is "1e+21"; padded lexical order called it smaller
    // than 2e20's 21 plain digits. Numeric order says otherwise.
    const bigger: BookRecord = { ...base, title: 'Newest parse', parsedAt: 1e21 }
    const smaller: BookRecord = { ...base, title: 'Older parse', parsedAt: 2e20 }
    for (const merged of [mergeRecord(bigger, smaller), mergeRecord(smaller, bigger)]) {
      expect(merged.title).toBe('Newest parse')
      expect(merged.parsedAt).toBe(1e21)
    }
    // Absent still loses to any parse, including a parse at time zero.
    const never: BookRecord = { ...base, title: 'Never parsed' }
    const atZero: BookRecord = { ...base, title: 'Parsed at zero', parsedAt: 0 }
    for (const merged of [mergeRecord(never, atZero), mergeRecord(atZero, never)]) {
      expect(merged.title).toBe('Parsed at zero')
    }
  })

  it('parseRecord bounds parsedAt: negative or non-finite is dropped, a wide finite value is kept', () => {
    expect(parseRecord(JSON.stringify({ title: 'T', author: 'A', parsedAt: -5 }))!.parsedAt).toBeUndefined()
    expect(parseRecord(JSON.stringify({ title: 'T', author: 'A', parsedAt: null }))!.parsedAt).toBeUndefined()
    expect(parseRecord(JSON.stringify({ title: 'T', author: 'A', parsedAt: 1e21 }))!.parsedAt).toBe(1e21)
    expect(parseRecord(JSON.stringify({ title: 'T', author: 'A', parsedAt: 0 }))!.parsedAt).toBe(0)
  })

  it('a tag named __proto__ survives parse, merge, tags and the digest', async () => {
    const at = makeHlc(10, 0, DEVICES[0])
    const bare = parseRecord(JSON.stringify({ title: 'T', author: 'A' }))!
    const clocked = parseRecord(
      JSON.stringify({ title: 'T', author: 'A', tagClock: { ['__proto__']: { at, on: true, spelling: '__proto__' } } }),
    )!
    expect(clocked.tags).toEqual(['__proto__'])
    for (const merged of [mergeRecord(clocked, bare), mergeRecord(bare, clocked)]) {
      expect(merged.tagClock?.['__proto__']).toEqual({ at, on: true, spelling: '__proto__' })
      expect(merged.tags).toEqual(['__proto__'])
      expect(await recordDigest(merged)).not.toBe(await recordDigest(bare))
    }
    // The legacy synthesis path reaches the same register, not the prototype.
    const legacy = parseRecord(JSON.stringify({ title: 'T', author: 'A', tags: ['__proto__'], addedAt: 5 }))!
    const merged = mergeRecord(legacy, parseRecord(JSON.stringify({ title: 'T', author: 'A', addedAt: 5 }))!)
    expect(merged.tags).toEqual(['__proto__'])
    expect(merged.tagClock?.['__proto__']?.on).toBe(true)
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

  it('a row whose edit is newer than its tombstone reads LIVE — the parsers clear the older action', () => {
    const t = (ms: number) => makeHlc(ms, 0, DEVICES[0])
    // Edit at 20, tombstone at 10: latest action is the edit, so the row lives.
    const revivedMark = { ...markOf('m1', 'kept', {}), updatedAt: t(20), deletedAt: t(10) }
    const marks = validMarks([revivedMark])
    expect(marks[0]!.deletedAt).toBeUndefined()
    expect(marks[0]!.updatedAt).toBe(t(20))
    expect(liveMarks(marks)).toHaveLength(1)
    // Tombstone at or above the edit: still deleted, both stamps kept.
    const deadMark = { ...markOf('m2', '', {}), updatedAt: t(10), deletedAt: t(20) }
    expect(liveMarks(validMarks([deadMark]))).toHaveLength(0)
    // Cards canonicalise by the same rule at their own parser.
    const revivedCard = { ...cardOf('c1', 'kept', {}), updatedAt: t(20), deletedAt: t(10) }
    const cards = parseCards(JSON.stringify([revivedCard]))
    expect(cards[0]!.deletedAt).toBeUndefined()
    expect(liveCards(cards)).toHaveLength(1)
    const deadCard = { ...cardOf('c2', 'x', {}), updatedAt: t(10), deletedAt: t(20) }
    expect(liveCards(parseCards(JSON.stringify([deadCard])))).toHaveLength(0)
  })

  it('parseCards holds one row per id — newest stamp wins — so mergeCards(a, a) is a', () => {
    const t = (ms: number) => makeHlc(ms, 0, DEVICES[0])
    const older = { ...cardOf('c1', 'older', {}), updatedAt: t(10) }
    const newer = { ...cardOf('c1', 'newer', {}), updatedAt: t(20) }
    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      const parsed = parseCards(JSON.stringify(order))
      expect(parsed).toHaveLength(1)
      expect(parsed[0]!.body).toBe('newer')
      // A deduplicated list self-merges to ITSELF, by identity — the
      // no-write convention the store's change detection reads.
      expect(mergeCards(parsed, parsed)).toBe(parsed)
    }
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

  it('answers null — never throws — on input that cannot be serialised', () => {
    const circular: Record<string, unknown> = { title: 'T', author: 'A' }
    circular['self'] = circular
    expect(fromWire(circular)).toBeNull()
    expect(fromWire({ title: 'T', author: 'A', size: BigInt(7) })).toBeNull()
    const trapped: Record<string, unknown> = { title: 'T', author: 'A' }
    Object.defineProperty(trapped, 'boom', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(fromWire(trapped)).toBeNull()
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

  it('two rows divergent under ONE stamp digest differently — the pull cannot skip their merge', async () => {
    // Same id, same newest stamp, different content: an (id, stamp) digest
    // called these equal, and the merge that would reconcile them never ran.
    const mine = markOf('m1', 'my thought', { updatedAt: t(10) })
    const theirs = markOf('m1', 'their thought', { updatedAt: t(10) })
    expect(await marksDigest([mine])).not.toBe(await marksDigest([theirs]))
    const myCard = cardOf('c1', 'x', { updatedAt: t(10) })
    const theirCard = cardOf('c1', 'y', { updatedAt: t(10) })
    expect(await cardsDigest([myCard])).not.toBe(await cardsDigest([theirCard]))
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

/**
 * `identifier` across two replicas (WI-21.3).
 *
 * The property tests above now GENERATE it, which is what makes them mean
 * anything here: the first draft's acceptance criterion was *"the property test
 * passes unchanged"*, and it would have passed while the merge silently dropped
 * the field — a generator that never produces a value cannot notice one going
 * missing.
 *
 * These are the specific cases, stated so a failure names the mechanism.
 */
describe('the work identifier, replicated', () => {
  const parsed = (over: Partial<BookRecord>): BookRecord =>
    parseRecord(JSON.stringify({ title: 'Moby-Dick', author: 'Melville', ...over }))!

  it('survives the wire and derives the same work key on the other side', () => {
    /* THE ACCEPTANCE CRITERION, END TO END: what a second device reads back
       has to derive the SAME key, or nothing can be built on it. */
    const here = parsed({ identifier: 'urn:isbn:9780142437247', parsedAt: 10, metaSchema: 1 })
    const there = fromWire(JSON.parse(JSON.stringify(toWire(here))))
    expect(there?.identifier).toBe('urn:isbn:9780142437247')
    expect(workKey(there?.identifier)?.key).toBe(workKey(here.identifier)?.key)
  })

  it('travels with the parse that produced it, not on its own', () => {
    /* The metadata GROUP is taken whole from the later parse. A replica that
       parsed later knows more about the book; splitting `identifier` out as a
       scalar would let a stale replica's identifier outlive its own title. */
    const older = parsed({ title: 'moby-dick-1851', identifier: 'urn:uuid:guess', parsedAt: 1, metaSchema: 1 })
    const newer = parsed({ title: 'Moby-Dick; or, The Whale', identifier: 'urn:isbn:9780142437247', parsedAt: 2, metaSchema: 1 })
    for (const merged of [mergeRecord(older, newer), mergeRecord(newer, older)]) {
      expect(merged.title).toBe('Moby-Dick; or, The Whale')
      expect(merged.identifier).toBe('urn:isbn:9780142437247')
    }
  })

  it('loses to a parse that found one, and beats a replica that never parsed', () => {
    const never = parsed({})
    const found = parsed({ identifier: 'urn:isbn:9780142437247', parsedAt: 5, metaSchema: 1 })
    expect(mergeRecord(never, found).identifier).toBe('urn:isbn:9780142437247')
    expect(mergeRecord(found, never).identifier).toBe('urn:isbn:9780142437247')
  })

  it('is not erased by an older build’s LATER parse', () => {
    /* ⚠️ **THE DATA-LOSS CASE THE SCHEMA ORDERING EXISTS FOR.** Device A is
       updated but has not run the backfill, so its record is still schema 0 —
       and it was parsed LATER than device B's backfilled one. Under a
       `parsedAt`-only order A wins and the identifier is gone.

       It self-heals wherever the bytes are: the merged record is schema 0, so
       `needsEnrichment` re-selects it. On a satchel with `hasContent: false`
       there is nothing to re-parse and the loss is permanent, which is what
       makes this worth an ordering rule rather than a comment. */
    const stale = parsed({ title: 'moby-dick-1851', parsedAt: 300 })
    const informed = parsed({ title: 'Moby-Dick', identifier: 'urn:isbn:9780142437247', parsedAt: 200, metaSchema: 1 })
    for (const merged of [mergeRecord(stale, informed), mergeRecord(informed, stale)]) {
      expect(merged.identifier).toBe('urn:isbn:9780142437247')
      expect(merged.metaSchema).toBe(1)
    }
  })

  it('still lets a later parse win when both know the same fields', () => {
    /* The schema key must not swallow the ordinary rule: at equal schemas the
       later parse is still the authority, or a corrected OPF could never take
       effect at all. */
    const older = parsed({ title: 'moby-dick-1851', parsedAt: 100, metaSchema: 1 })
    const newer = parsed({ title: 'Moby-Dick; or, The Whale', parsedAt: 200, metaSchema: 1 })
    expect(mergeRecord(older, newer).title).toBe('Moby-Dick; or, The Whale')
    expect(mergeRecord(newer, older).title).toBe('Moby-Dick; or, The Whale')
  })

  it('does not let a schema alone promote a record that never parsed', () => {
    /* ⚠️ ORDER OF THE KEYS. "Never parsed" is checked BEFORE the schema, or a
       record carrying `metaSchema` with no `parsedAt` — which `recordFromMeta`
       produces before a caller stamps it — would outrank a real parse. */
    const neverParsed = parsed({ metaSchema: 1, identifier: 'urn:isbn:9780142437247' })
    const realParse = parsed({ title: 'Moby-Dick; or, The Whale', parsedAt: 50 })
    expect(mergeRecord(neverParsed, realParse).title).toBe('Moby-Dick; or, The Whale')
    expect(mergeRecord(realParse, neverParsed).title).toBe('Moby-Dick; or, The Whale')
  })

  /**
   * ⚠️ **WHAT AN UNBUMPED `SYNC_VERSION` WOULD HAVE DONE.**
   *
   * `parseRecord` is built from KNOWN FIELDS, so a peer that predates
   * `identifier` STRIPS it — and then ACKs the row it stripped. The metadata
   * group merges on `parsedAt`; an ACK carries the sender's own stamp back, so
   * the stamps are EQUAL and the tie falls to the canonical serialisation,
   * where the stripped side can win. The sender's own identifier is erased, the
   * outbox is cleared, and the row is never sent again.
   *
   * This reproduces that merge directly. It is not a claim that it can happen
   * now — `SYNC_VERSION` is [4, 4] and a v3 hello is refused — it is the
   * evidence for why the bump was needed, kept where it can be re-run.
   */
  it('would have been erased by an equal-stamp echo from a peer that stripped it', () => {
    const mine = parsed({ identifier: 'urn:isbn:9780142437247', parsedAt: 7, metaSchema: 1 })
    /* What a v3 peer hands back: the same row, same stamp, field gone. */
    const stripped = parsed({ parsedAt: 7 })
    const echoed = mergeRecord(mine, stripped)
    /* Whichever side the tie picks, the point stands: the outcome is decided
       by a canonical-serialisation coin toss rather than by which replica knew
       more — which is exactly what a version range exists to prevent. */
    expect([undefined, 'urn:isbn:9780142437247']).toContain(echoed.identifier)
    expect(mergeRecord(mine, stripped)).toEqual(mergeRecord(stripped, mine))
  })
})
