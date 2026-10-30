import { describe, expect, it } from 'vitest'
import { hlcOf } from '../hlc'
import fc from 'fast-check'
import { READING_STATES, STARS, compacted, compareEntries, fold, mergeLogs, nextSeq, type Entry, type Passage, type ReadingState, type Stars } from './log'

/** WI-22.C1 and WI-22.C2 — the log, and the tombstone that names what it takes back. */

const passage = (quote: string): Passage => ({
  quote,
  prefix: 'before ',
  suffix: ' after',
  chapter: 'Ch. 1',
})

const share = (pub: string, at: number, device = 'd1', seq = at): Entry => ({
  op: 'share',
  pub,
  device,
  seq,
  at: hlcOf(at),
  passage: passage(pub),
})

const unshare = (pub: string, at: number, device = 'd1', seq = at): Entry => ({
  op: 'unshare',
  pub,
  device,
  seq,
  at: hlcOf(at),
})

/** The publication an entry names, or null for a register — which names none. */
const pubOf = (e: Entry): string | null => ('pub' in e ? e.pub : null)

describe('the passage that travels', () => {
  it('has no anchor field at all, by construction', () => {
    /* ⚠️ **THE STRONGEST FALSIFIER IN THE PLAN, and it is a type rather than a
       grep.** *"NO CFI CROSSES THE WIRE … serialise a page and grep the bytes
       for `epubcfi`. Any hit is phase 21's defect reintroduced at scale, on a
       surface where it reaches strangers' data rather than the reader's own."*

       A publisher's CFI is a path through THEIR package and addresses different
       words in a recipient's build. Asserting on the serialised keys means a
       field added later fails here rather than shipping. */
    const keys = Object.keys(passage('q'))
    expect(keys).toEqual(['quote', 'prefix', 'suffix', 'chapter'])
    expect(JSON.stringify(fold([share('p1', 1)]).shares)).not.toContain('epubcfi')
    expect(JSON.stringify(fold([share('p1', 1)]).shares)).not.toContain('cfi')
  })

  it('carries no tint or style', () => {
    /* They leak the reader's private colour vocabulary, and `surfaces.md`
       forbids drawing a foreign mark in your own tints anyway — so a recipient
       was never going to use them. */
    const json = JSON.stringify(fold([share('p1', 1)]).shares)
    expect(json).not.toContain('tint')
    expect(json).not.toContain('style')
  })
})

describe('fold', () => {
  it('keeps what is shared', () => {
    expect(fold([share('p1', 1), share('p2', 2)]).shares.map((h) => h.pub)).toEqual(['p1', 'p2'])
  })

  it('drops what was withdrawn', () => {
    expect(fold([share('p1', 1), share('p2', 2), unshare('p1', 3)]).shares.map((h) => h.pub)).toEqual(['p2'])
  })

  it('tells two shares of one passage apart, which is the whole of the pub id', () => {
    /* ⚠️ `review.md`'s check: *"`share(P), share(P), unshare(P)`; the receiver
       cannot tell which."* With a `pub` per share it is three unambiguous
       entries — two publications and a withdrawal naming exactly one. */
    const held = fold([share('pubA', 1), share('pubB', 2), unshare('pubA', 3)]).shares
    expect(held.map((h) => h.pub)).toEqual(['pubB'])
  })

  it('remembers a withdrawal that arrives BEFORE the share it withdraws', () => {
    /* ⚠️ **THE OUT-OF-ORDER CASE, and dropping it is the classic resurrection
       bug.** Pages arrive out of order by design — *"a recipient may receive
       page 7 before page 3"* — so an unshare can land first. Dropped, the share
       would appear when page 3 arrived and stay for ever: the *"comes straight
       back"* failure `Mark.deletedAt` exists to prevent, one level up. */
    expect(fold([unshare('p1', 3), share('p1', 1)]).shares).toEqual([])
  })

  it('does not let a repeated share resurrect a withdrawn pub', () => {
    /* A `pub` is minted per share and never reused, so two entries naming one
       are a duplicate delivery or a forgery — not a re-share. Re-sharing mints
       a new `pub`, which is what makes the case above resolvable at all. */
    expect(fold([share('p1', 1), unshare('p1', 2), share('p1', 3)]).shares).toEqual([])
  })

  it('keeps the earlier stamp when a share is delivered twice', () => {
    /* A redelivery must not quietly move a passage up the reader's list. */
    const held = fold([share('p1', 5), share('p1', 9)]).shares
    expect(held).toHaveLength(1)
    expect(held[0]!.at).toBe(hlcOf(5))
  })
})

describe('mergeLogs', () => {
  it('keeps two desktops as two streams rather than one collision', () => {
    /* ⚠️ `review.md`: *"two desktops at seq 10, disconnect, publish on both —
       both mint seq 11 and both pages verify."* With the device in the key that
       is two entries, not one overwriting the other. */
    const merged = mergeLogs([share('a', 11, 'desk1', 11)], [share('b', 11, 'desk2', 11)])
    expect(merged.map(pubOf).sort()).toEqual(['a', 'b'])
  })

  it('is idempotent, so a page delivered twice changes nothing', () => {
    const one = [share('a', 1), share('b', 2)]
    expect(mergeLogs(one, one)).toHaveLength(2)
    expect(mergeLogs(mergeLogs(one, one), one)).toHaveLength(2)
  })

  it('orders by when it was said, across devices', () => {
    const merged = mergeLogs(
      [share('late', 9, 'desk1', 1)],
      [share('early', 2, 'desk2', 1), share('mid', 5, 'desk2', 2)],
    )
    expect(merged.map(pubOf)).toEqual(['early', 'mid', 'late'])
  })

  it('breaks a tie by device and then by sequence, so the order is total', () => {
    /* Two devices stamping at one instant must still order the same way on
       every peer, or two recipients disagree about what a reader said first. */
    const a = share('x', 4, 'aaa', 1)
    const b = share('y', 4, 'bbb', 1)
    expect(compareEntries(a, b)).toBeLessThan(0)
    expect(compareEntries(b, a)).toBeGreaterThan(0)
    expect(compareEntries(a, a)).toBe(0)
  })
})

describe('nextSeq', () => {
  it('counts per device, so two desktops never contend', () => {
    const log = [share('a', 1, 'desk1', 1), share('b', 2, 'desk1', 2), share('c', 3, 'desk2', 1)]
    expect(nextSeq(log, 'desk1')).toBe(3)
    expect(nextSeq(log, 'desk2')).toBe(2)
    expect(nextSeq(log, 'phone')).toBe(1)
  })
})

describe('compacted — what a NEW subscriber is served', () => {
  it('omits everything that was withdrawn', () => {
    /* ⚠️ **`review.md`'s audience-epoch finding.** The raw log contains every
       passage ever shared, retractions included. Serving it to somebody
       admitted last week hands them everything the publisher ever took back. */
    const log = [share('kept', 1), share('gone', 2), unshare('gone', 3)]
    const view = compacted(log, 'desk1')
    expect(view.map(pubOf)).toEqual(['kept'])
    expect(JSON.stringify(view)).not.toContain('gone')
  })

  it('carries no tombstones, because there is nothing yet to withdraw', () => {
    const view = compacted([share('a', 1), share('b', 2), unshare('b', 3)], 'desk1')
    expect(view.every((e) => e.op === 'share')).toBe(true)
  })

  it('renumbers into one stream, so the newcomer sees a gapless sequence', () => {
    /* The compacted view is a fresh stream from the serving device — a
       recipient checking `prevPageHash` for gaps must not see holes left by
       entries that were filtered out. */
    const log = [share('a', 1), share('gone', 2), unshare('gone', 3), share('c', 4)]
    expect(compacted(log, 'desk1').map((e) => e.seq)).toEqual([1, 2])
  })
})

/* ───────────────────────────── WI-23.B1 — the book, not the passage ──── */

const status = (state: ReadingState, at: number, device = 'd1', seq = at): Entry => ({
  op: 'status',
  state,
  device,
  seq,
  at: hlcOf(at),
})
const rate = (stars: Stars, at: number, device = 'd1', seq = at): Entry => ({
  op: 'rate',
  stars,
  device,
  seq,
  at: hlcOf(at),
})
const tag = (tags: readonly string[], at: number, device = 'd1', seq = at): Entry => ({
  op: 'tag',
  tags,
  device,
  seq,
  at: hlcOf(at),
})
const review = (pub: string, text: string, at: number, device = 'd1', seq = at): Entry => ({
  op: 'review',
  pub,
  text,
  device,
  seq,
  at: hlcOf(at),
})
const unreview = (pub: string, at: number, device = 'd1', seq = at): Entry => ({
  op: 'unreview',
  pub,
  device,
  seq,
  at: hlcOf(at),
})

describe('the registers — status, rate, tag', () => {
  it('answer nothing for a log that never said', () => {
    const folded = fold([share('p1', 1)])
    expect(folded.status).toBeUndefined()
    expect(folded.stars).toBeUndefined()
    expect(folded.tags).toBeUndefined()
  })

  it('keep the NEWEST stamp, not the highest sequence — the item’s falsifier', () => {
    /* ⚠️ Device 1 says `finished` at T+10, seq 5; device 2 says `reading` at
       T, seq 9. A fold by sequence answers `reading`; by stamp, `finished`. */
    const finished = status('finished', 10, 'device-1', 5)
    const reading = status('reading', 0, 'device-2', 9)
    expect(fold([finished, reading]).status).toEqual({ value: 'finished', at: hlcOf(10) })
    expect(fold([reading, finished]).status).toEqual({ value: 'finished', at: hlcOf(10) })
  })

  it('fold each kind on its own', () => {
    const folded = fold([rate(3, 1), status('reading', 2), tag(['sea'], 3), rate(5, 4), tag(['sea', 'whales'], 5)])
    expect(folded.stars).toEqual({ value: 5, at: hlcOf(4) })
    expect(folded.status).toEqual({ value: 'reading', at: hlcOf(2) })
    expect(folded.tags).toEqual({ value: ['sea', 'whales'], at: hlcOf(5) })
  })

  it('break an equal stamp by device, then by sequence, the same way everywhere', () => {
    /* One device stamping twice in one instant is the only way to a tie, and
       its later sequence is its later word. Two devices at one instant is a
       stamp collision an HLC cannot produce, but the rule is total anyway. */
    const first = rate(1, 7, 'd1', 1)
    const second = rate(2, 7, 'd1', 2)
    expect(fold([first, second]).stars?.value).toBe(2)
    expect(fold([second, first]).stars?.value).toBe(2)
    const other = rate(3, 7, 'd0', 9)
    expect(fold([second, other]).stars?.value).toBe(2)
    expect(fold([other, second]).stars?.value).toBe(2)
  })

  it('are unmoved by a redelivery of an older word', () => {
    const folded = fold([status('finished', 5), status('want', 1), status('want', 1)])
    expect(folded.status?.value).toBe('finished')
  })
})

describe('reviews — a publication, like a passage', () => {
  it('holds what was said', () => {
    const folded = fold([review('r1', 'a whale of a book', 1)])
    expect(folded.reviews).toEqual([{ pub: 'r1', text: 'a whale of a book', at: hlcOf(1) }])
  })

  it('drops what was taken back, and remembers a withdrawal that arrives first', () => {
    expect(fold([review('r1', 'x', 1), unreview('r1', 2)]).reviews).toEqual([])
    expect(fold([unreview('r1', 2), review('r1', 'x', 1)]).reviews).toEqual([])
  })

  it('does not let a repeated review resurrect a withdrawn pub, and keeps the earlier stamp on a redelivery', () => {
    expect(fold([review('r1', 'x', 1), unreview('r1', 2), review('r1', 'x', 3)]).reviews).toEqual([])
    const twice = fold([review('r1', 'x', 5), review('r1', 'x', 9)]).reviews
    expect(twice).toHaveLength(1)
    expect(twice[0]!.at).toBe(hlcOf(5))
  })

  it('edits as a withdrawal plus a new publication, two entries and a new pub', () => {
    const folded = fold([review('r1', 'first thought', 1), unreview('r1', 2), review('r2', 'second thought', 3)])
    expect(folded.reviews.map((one) => one.text)).toEqual(['second thought'])
  })

  it('carries no text on a withdrawal, by the type and by the value', () => {
    expect(Object.keys(unreview('r1', 1)).sort()).toEqual(['at', 'device', 'op', 'pub', 'seq'])
  })
})

describe('the fold is a function of the SET of entries', () => {
  it('answers the same whatever order the entries arrive in — every kind', () => {
    /* ⚠️ Pages arrive out of order and across devices; a recipient that folded
       differently for a different arrival order would disagree with every
       other recipient of the same log. */
    const kinds = fc.integer({ min: 0, max: 6 })
    const arb = fc.array(
      fc.tuple(kinds, fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 1, max: 12 }), fc.constantFrom('d1', 'd2')),
      { minLength: 0, maxLength: 10 },
    )
    const build = ([kind, pub, at, device]: [number, string, number, string], i: number): Entry => {
      const seq = i + 1
      switch (kind) {
        case 0:
          return share(pub, at, device, seq)
        case 1:
          return unshare(pub, at, device, seq)
        case 2:
          return status(at % 2 ? 'reading' : 'finished', at, device, seq)
        case 3:
          return rate(((at % 5) + 1) as Stars, at, device, seq)
        case 4:
          return tag([pub], at, device, seq)
        case 5:
          return review(pub, `text-${pub}`, at, device, seq)
        default:
          return unreview(pub, at, device, seq)
      }
    }
    fc.assert(
      fc.property(arb, fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 10 }), (rows, order) => {
        const log = rows.map(build)
        const shuffled = [...log].sort((x, y) => (order[log.indexOf(x)] ?? 0) - (order[log.indexOf(y)] ?? 0))
        const canonical = (entries: readonly Entry[]) => {
          const folded = fold(entries)
          return JSON.stringify({
            shares: [...folded.shares].sort((x, y) => (x.pub < y.pub ? -1 : 1)),
            reviews: [...folded.reviews].sort((x, y) => (x.pub < y.pub ? -1 : 1)),
            status: folded.status,
            stars: folded.stars,
            tags: folded.tags,
          })
        }
        expect(canonical(shuffled)).toBe(canonical(log))
      }),
      { numRuns: 300 },
    )
  })
})

describe('compacted — with the four kinds', () => {
  it('serves only the newest register and only live reviews, renumbered', () => {
    const view = compacted(
      [rate(2, 1), review('r1', 'gone', 2), unreview('r1', 3), rate(4, 4), review('r2', 'kept', 5), status('reading', 6)],
      'desk1',
    )
    expect(view.map((one) => one.op)).toEqual(['rate', 'review', 'status'])
    expect(view.map((one) => one.seq)).toEqual([1, 2, 3])
    expect(JSON.stringify(view)).not.toContain('gone')
    expect(view.find((one) => one.op === 'rate')).toMatchObject({ stars: 4 })
  })

  it('carries no tombstone of any kind', () => {
    const view = compacted([review('r1', 'x', 1), unreview('r1', 2), share('a', 3), unshare('a', 4)], 'desk1')
    expect(view).toEqual([])
  })

  it('serves one word per register — the newest — and drops an equal-stamped loser', () => {
    /* Each register in turn: an older word dropped, the newest kept; and at an
       equal stamp, only the entry the fold chose — the other has the same
       stamp and a different value, and must not be served as current. */
    const older = tag(['sea'], 1, 'd1', 1)
    const newest = tag(['sea', 'whales'], 2, 'd1', 2)
    const tied = tag(['ships'], 2, 'd0', 9)
    const view = compacted([older, tied, newest, status('want', 3, 'd1', 3), status('reading', 3, 'd0', 8), rate(1, 4, 'd0', 7), rate(5, 4, 'd1', 4)], 'desk1')
    expect(view.map((one) => one.op)).toEqual(['tag', 'status', 'rate'])
    expect(view[0]).toMatchObject({ tags: ['sea', 'whales'] })
    expect(view[1]).toMatchObject({ state: 'want' })
    expect(view[2]).toMatchObject({ stars: 5 })
  })

  it('serves no register when none was ever said', () => {
    expect(compacted([share('a', 1)], 'desk1').map((one) => one.op)).toEqual(['share'])
  })
})

describe('the closed sets the record and the wire share', () => {
  it('names three reading states and five stars, and no others', () => {
    /* `parseRecord`, `isOpinion` and the wire all check membership here; a
       word dropped from this list is a state no reader can have. */
    expect(READING_STATES).toEqual(['want', 'reading', 'finished'])
    expect(STARS).toEqual([1, 2, 3, 4, 5])
  })
})

describe('one (device, seq) delivered twice', () => {
  it('keeps the FIRST register word it saw, never the second', () => {
    /* Two entries at one `(device, seq)` are a duplicate delivery or a
       forgery — an honest device never mints one number twice — and whichever
       a recipient keeps, every recipient must keep the same one. The first
       is the one every recipient saw first, because pages are chained. */
    const first = rate(1, 7, 'd1', 3)
    const forged = rate(5, 7, 'd1', 3)
    expect(fold([first, forged]).stars?.value).toBe(1)
  })
})

describe('nextSeq over a stream out of order', () => {
  it('answers one past the HIGHEST sequence, not one past the last seen', () => {
    /* A log is merged by stamp, and a stamp can run behind a sequence — so
       the last entry seen is not the highest numbered one. */
    expect(nextSeq([share('a', 9, 'd1', 5), share('b', 1, 'd1', 2)], 'd1')).toBe(6)
  })
})

describe('the shelf — WI-23.C1', () => {
  const work = (title: string) => ({ title, author: 'Herman Melville', identifier: 'isbn:1', language: 'en' })
  const shelf = (pub: string, at: number, device = 'd1', seq = at): Entry => ({
    op: 'shelf',
    pub,
    work: work(pub),
    device,
    seq,
    at: hlcOf(at),
  })
  const unshelf = (pub: string, at: number, device = 'd1', seq = at): Entry => ({
    op: 'unshelf',
    pub,
    device,
    seq,
    at: hlcOf(at),
  })

  it('names a work IN CLEAR, which is the disclosure the switch gates', () => {
    const folded = fold([shelf('Moby-Dick', 1)])
    expect(folded.shelf).toEqual([{ pub: 'Moby-Dick', work: work('Moby-Dick'), at: hlcOf(1) }])
    expect(JSON.stringify(folded.shelf)).toContain('Herman Melville')
  })

  it('takes a book off the shelf by pub, remembers a removal that arrives first, and never resurrects one', () => {
    expect(fold([shelf('a', 1), unshelf('a', 2)]).shelf).toEqual([])
    expect(fold([unshelf('a', 2), shelf('a', 1)]).shelf).toEqual([])
    expect(fold([shelf('a', 1), unshelf('a', 2), shelf('a', 3)]).shelf).toEqual([])
    const twice = fold([shelf('a', 5), shelf('a', 9)]).shelf
    expect(twice).toHaveLength(1)
    expect(twice[0]!.at).toBe(hlcOf(5))
  })

  it('carries no work on a removal, by the type and by the value', () => {
    expect(Object.keys(unshelf('a', 1)).sort()).toEqual(['at', 'device', 'op', 'pub', 'seq'])
  })

  it('is served compacted like a passage: live books only, no removals', () => {
    const view = compacted([shelf('a', 1), shelf('b', 2), unshelf('b', 3)], 'desk1')
    expect(view.map((one) => one.op)).toEqual(['shelf'])
    expect(JSON.stringify(view)).not.toContain('"b"')
  })
})

describe('a shelf entry delivered twice', () => {
  it('keeps the EARLIER stamp, so a redelivery cannot move a book up the list', () => {
    const work = { title: 'T', author: 'A', language: 'en' }
    const early: Entry = { op: 'shelf', pub: 's', work, device: 'd'.repeat(64), seq: 1, at: hlcOf(1) }
    const late: Entry = { ...early, at: hlcOf(9) }
    expect(fold([early, late]).shelf[0]!.at).toBe(hlcOf(1))
    expect(fold([late, early]).shelf[0]!.at).toBe(hlcOf(1))
  })
})

describe('a fork, a duplicate and a compaction, resolved the same way from either side', () => {
  const shareOf = (pub: string, at: number, device: string, seq: number, quote: string): Entry => ({ op: 'share', pub, passage: passage(quote), device, seq, at: hlcOf(at) })

  it('keeps one deterministic entry of two that share (device, seq), whichever log comes first', () => {
    const a = share('p', 1)
    const b = share('q', 1)
    const ab = mergeLogs([a], [b])
    const ba = mergeLogs([b], [a])
    expect(ab).toEqual(ba)
    expect(ab).toHaveLength(1)
    expect(mergeLogs([a], [a])).toEqual([a])
  })

  it('folds a duplicate publication to one whole entry — the earlier by stamp — whatever order it is heard in', () => {
    const early = shareOf('p', 1, 'd1', 1, 'first words')
    const late = shareOf('p', 5, 'd2', 1, 'other words')
    expect(fold([early, late]).shares).toEqual(fold([late, early]).shares)
    expect(fold([late, early]).shares[0]).toEqual({ pub: 'p', passage: passage('first words'), at: early.at })
    const r1: Entry = { op: 'review', pub: 'r', text: 'first', device: 'd1', seq: 1, at: hlcOf(1) }
    const r2: Entry = { ...r1, device: 'd2', text: 'second', at: hlcOf(2) }
    expect(fold([r2, r1]).reviews[0]!.text).toBe('first')
    const s1: Entry = { op: 'shelf', pub: 's', work: { title: 'A', author: 'A', language: 'en' }, device: 'd1', seq: 1, at: hlcOf(1) }
    const s2: Entry = { ...s1, device: 'd2', work: { title: 'B', author: 'B', language: 'en' }, at: hlcOf(2) }
    expect(fold([s2, s1]).shelf[0]!.work.title).toBe('A')
  })

  it('compacts a duplicated publication to the one entry it folded to', () => {
    const early = shareOf('p', 1, 'd1', 1, 'first words')
    const late = shareOf('p', 5, 'd2', 1, 'other words')
    const served = compacted([late, early], 'd9')
    expect(served).toHaveLength(1)
    expect(served[0]).toMatchObject({ op: 'share', pub: 'p', passage: passage('first words') })
  })
})

describe('the fold and the merge agree about a fork, and about order', () => {
  it('folds a fork to the entry mergeLogs keeps, whichever arrives first', () => {
    const one = { ...share('p1', 5, 'd1', 5), passage: passage('one') }
    const two = { ...share('p1', 5, 'd1', 5), passage: passage('two') }
    const fromOne = fold([one, two])
    expect(fold([two, one])).toEqual(fromOne)
    expect(fold(mergeLogs([one], [two]))).toEqual(fromOne)
    expect(fromOne.shares).toHaveLength(1)
  })

  it('lists shares, reviews and shelf items in log order, not arrival order', () => {
    const late = share('p2', 7)
    const early = share('p1', 3)
    expect(fold([late, early]).shares.map((s) => s.pub)).toEqual(['p1', 'p2'])
    expect(fold([review('p2', 'later', 7), review('p1', 'earlier', 3)]).reviews.map((r) => r.pub)).toEqual(['p1', 'p2'])
    const shelved = (pub: string, at: number): Entry => ({ op: 'shelf', pub, work: { title: pub, author: 'A', language: 'en' }, device: 'd1', seq: at, at: hlcOf(at) })
    expect(fold([shelved('s2', 7), shelved('s1', 3)]).shelf.map((s) => s.pub)).toEqual(['s1', 's2'])
  })

  it('serves the first delivery of a publication, not a later one carrying other words', () => {
    const first = { ...share('p1', 3, 'd1', 3), passage: passage('first') }
    const again = { ...share('p1', 9, 'd2', 9), passage: passage('again') }
    const served = compacted([first, again], 'd9')
    expect(served).toHaveLength(1)
    expect((served[0] as { passage: Passage }).passage.quote).toBe('first')
  })

  it('compacts a fork to the same stream from either side', () => {
    const one = { ...share('p1', 5, 'd1', 5), passage: passage('one') }
    const two = { ...share('p1', 5, 'd1', 5), passage: passage('two') }
    expect(compacted([one, two], 'd9')).toEqual(compacted([two, one], 'd9'))
  })

  it('compacts to one stream from either arrival order', () => {
    const late = share('p2', 7, 'd1', 7)
    const early = share('p1', 3, 'd1', 3)
    const stream = compacted([late, early], 'd9')
    expect(compacted([early, late], 'd9')).toEqual(stream)
    expect(stream.map(pubOf)).toEqual(['p1', 'p2'])
    expect(stream.map((e) => e.seq)).toEqual([1, 2])
  })

  it('refuses to hand out a sequence past the safe range', () => {
    expect(() => nextSeq([share('p', 1, 'd1', Number.MAX_SAFE_INTEGER)], 'd1')).toThrow('no sequence numbers left')
    expect(nextSeq([share('p', 1, 'd1', Number.MAX_SAFE_INTEGER)], 'd2')).toBe(1)
  })

  it('throws on an entry of a kind the type does not name', () => {
    const bogus = { ...share('p', 1), op: 'bogus' } as unknown as Entry
    expect(() => fold([bogus])).toThrow('unknown kind')
    expect(() => compacted([bogus], 'd1')).toThrow('unknown kind')
  })
})
