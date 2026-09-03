import { describe, expect, it } from 'vitest'
import { hlcOf } from '../hlc'
import { compacted, compareEntries, fold, mergeLogs, nextSeq, type Entry, type Passage } from './log'

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
    expect(JSON.stringify(fold([share('p1', 1)]))).not.toContain('epubcfi')
    expect(JSON.stringify(fold([share('p1', 1)]))).not.toContain('cfi')
  })

  it('carries no tint or style', () => {
    /* They leak the reader's private colour vocabulary, and `surfaces.md`
       forbids drawing a foreign mark in your own tints anyway — so a recipient
       was never going to use them. */
    const json = JSON.stringify(fold([share('p1', 1)]))
    expect(json).not.toContain('tint')
    expect(json).not.toContain('style')
  })
})

describe('fold', () => {
  it('keeps what is shared', () => {
    expect(fold([share('p1', 1), share('p2', 2)]).map((h) => h.pub)).toEqual(['p1', 'p2'])
  })

  it('drops what was withdrawn', () => {
    expect(fold([share('p1', 1), share('p2', 2), unshare('p1', 3)]).map((h) => h.pub)).toEqual(['p2'])
  })

  it('tells two shares of one passage apart, which is the whole of the pub id', () => {
    /* ⚠️ `review.md`'s check: *"`share(P), share(P), unshare(P)`; the receiver
       cannot tell which."* With a `pub` per share it is three unambiguous
       entries — two publications and a withdrawal naming exactly one. */
    const held = fold([share('pubA', 1), share('pubB', 2), unshare('pubA', 3)])
    expect(held.map((h) => h.pub)).toEqual(['pubB'])
  })

  it('remembers a withdrawal that arrives BEFORE the share it withdraws', () => {
    /* ⚠️ **THE OUT-OF-ORDER CASE, and dropping it is the classic resurrection
       bug.** Pages arrive out of order by design — *"a recipient may receive
       page 7 before page 3"* — so an unshare can land first. Dropped, the share
       would appear when page 3 arrived and stay for ever: the *"comes straight
       back"* failure `Mark.deletedAt` exists to prevent, one level up. */
    expect(fold([unshare('p1', 3), share('p1', 1)])).toEqual([])
  })

  it('does not let a repeated share resurrect a withdrawn pub', () => {
    /* A `pub` is minted per share and never reused, so two entries naming one
       are a duplicate delivery or a forgery — not a re-share. Re-sharing mints
       a new `pub`, which is what makes the case above resolvable at all. */
    expect(fold([share('p1', 1), unshare('p1', 2), share('p1', 3)])).toEqual([])
  })

  it('keeps the earlier stamp when a share is delivered twice', () => {
    /* A redelivery must not quietly move a passage up the reader's list. */
    const held = fold([share('p1', 5), share('p1', 9)])
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
    expect(merged.map((e) => e.pub).sort()).toEqual(['a', 'b'])
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
    expect(merged.map((e) => e.pub)).toEqual(['early', 'mid', 'late'])
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
    expect(view.map((e) => e.pub)).toEqual(['kept'])
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
