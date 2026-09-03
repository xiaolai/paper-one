import { describe, expect, it } from 'vitest'
import { hlcOf } from '../hlc'
import { NOTHING_SPENT, charge } from './bound'
import {
  admits,
  budgetFor,
  changeState,
  defaultRetain,
  drawsEntry,
  drawsOverlays,
  acceptsTransport,
  mergeRelationship,
  readmit,
  type Relationship,
} from './relationships'

/** WI-22.E1, E2 and E3 — the review's ninth condition. */

const rel = (over: Partial<Relationship> = {}): Relationship => ({
  person: 'A',
  state: 'admitted',
  epoch: 1,
  admittedAt: hlcOf(100),
  changedAt: hlcOf(100),
  retain: 'keep',
  ...over,
})

describe('WI-22.E1 — the record is person-level and convergent', () => {
  it('refuses every leaf of a blocked person, including ones not yet made', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"block A, then let A add a NEW device and
       dial in. If the new leaf is admitted, the record is device-level in
       effect whatever its shape says."* The record names the PERSON, so a leaf
       that did not exist when the block was made is refused by the same rule as
       one that did — there is no device list to fall out of date. */
    const blocked = rel({ state: 'blocked' })
    expect(admits(blocked)).toBe('refuse')
    expect(acceptsTransport(blocked.state)).toBe(false)
    /* And there is nowhere in the record for a device id to appear. */
    expect(Object.keys(blocked)).not.toContain('devices')
    expect(Object.keys(blocked)).not.toContain('device')
  })

  it('reaches a sleeping laptop, by the clock rather than by luck', () => {
    /* ⚠️ Block on the phone while the laptop is asleep; the laptop adopts it
       when it wakes. `tagClock` is the precedent — a clock is what lets two of
       your own devices disagree and then agree. */
    const onLaptop = rel()
    const onPhone = changeState(onLaptop, 'blocked', hlcOf(200))
    expect(mergeRelationship(onLaptop, onPhone).state).toBe('blocked')
    expect(mergeRelationship(onPhone, onLaptop).state).toBe('blocked')
  })

  it('keeps the more restrictive state on a true tie', () => {
    /* Two orderings must converge, and of the two answers only one is safe to
       be wrong about. */
    const a = rel({ state: 'admitted', changedAt: hlcOf(300) })
    const b = rel({ state: 'blocked', changedAt: hlcOf(300) })
    expect(mergeRelationship(a, b).state).toBe('blocked')
    expect(mergeRelationship(b, a).state).toBe('blocked')
  })

  it('does not let an older change undo a newer one', () => {
    const blocked = rel({ state: 'blocked', changedAt: hlcOf(500) })
    const stale = rel({ state: 'admitted', changedAt: hlcOf(100) })
    expect(mergeRelationship(blocked, stale).state).toBe('blocked')
  })
})

describe('the four states', () => {
  it('mutes without unpairing, which the eight conditions had no word for', () => {
    /* ⚠️ The common case is not hostility. A reader who marks every second
       sentence is noise, and the only remedies in the eight conditions were
       "tolerate" and "unpair" — so a reader would unpair somebody they like. */
    expect(acceptsTransport('muted')).toBe(true)
    expect(drawsOverlays('muted')).toBe(false)
  })

  it('draws only for an admitted person', () => {
    expect(drawsOverlays('admitted')).toBe(true)
    for (const state of ['muted', 'blocked', 'exited'] as const) {
      expect(drawsOverlays(state)).toBe(false)
    }
  })

  it('refuses transport only for blocked and exited', () => {
    expect(acceptsTransport('admitted')).toBe(true)
    expect(acceptsTransport('blocked')).toBe(false)
    expect(acceptsTransport('exited')).toBe(false)
  })

  it('defaults purge for a block and keep for a mute', () => {
    /* A reader who blocks is usually saying they do not want those words on the
       page; a reader who mutes is saying not right now. */
    expect(defaultRetain('blocked')).toBe('purge')
    expect(defaultRetain('exited')).toBe('purge')
    expect(defaultRetain('muted')).toBe('keep')
  })
})

describe('WI-22.E2 — a budget that reconnection does not replenish', () => {
  it('gives a blocked person nothing, however often they return', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"block A, then have A reconnect fifty
       times. If A's quota is replenished by reconnecting, the budget is per
       session and `sessions × budget` is back."* */
    const blocked = budgetFor('blocked')
    let spend = NOTHING_SPENT
    for (let i = 0; i < 50; i += 1) {
      const result = charge(spend, 'w1', 1, 1000 + i, blocked)
      expect(result.allowed).toBe(false)
      if (result.allowed) spend = result.spend
    }
  })

  it('gives an admitted person the ordinary budget', () => {
    expect(charge(NOTHING_SPENT, 'w1', 1024, 1000, budgetFor('admitted')).allowed).toBe(true)
  })

  it('is a BUDGET rather than a branch, so a later call site cannot forget it', () => {
    /* Every path that charges is covered by construction. A branch has to be
       remembered at each new call site; a budget does not. */
    expect(budgetFor('blocked')).toEqual(budgetFor('exited'))
    expect(budgetFor('muted')).toEqual(budgetFor('admitted'))
  })

  it('says the same thing to a blocked stranger and an unknown one', () => {
    /* ⚠️ Distinguishing them turns the introduction path into a way to ask
       whether somebody blocked you. */
    expect(admits(rel({ state: 'blocked' }))).toBe('refuse')
    expect(admits(null)).toBe('refuse')
  })
})

describe('WI-22.E3 — the re-admission epoch', () => {
  it('does not revive a single passage from before the block', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"block A with purge, re-admit A, and watch
       the page. If a single passage from before the block is drawn, the epoch
       is decoration."* */
    const before = rel({ epoch: 1 })
    expect(drawsEntry(before, 1)).toBe(true)

    const blocked = changeState(before, 'blocked', hlcOf(200))
    const again = readmit(blocked, hlcOf(300))

    expect(again.epoch).toBe(2)
    expect(again.state).toBe('admitted')
    /* Entries from epoch 1 are not drawn under epoch 2. */
    expect(drawsEntry(again, 1)).toBe(false)
    expect(drawsEntry(again, 2)).toBe(true)
  })

  it('bumps once per re-admission, so a second cycle does not reuse an epoch', () => {
    const first = readmit(rel({ epoch: 1 }), hlcOf(200))
    const second = readmit(changeState(first, 'blocked', hlcOf(300)), hlcOf(400))
    expect([first.epoch, second.epoch]).toEqual([2, 3])
  })

  it('draws nothing at all while blocked, whatever the epoch says', () => {
    expect(drawsEntry(rel({ state: 'blocked', epoch: 1 }), 1)).toBe(false)
    expect(drawsEntry(rel({ state: 'muted', epoch: 1 }), 1)).toBe(false)
  })

  it('starts a re-admitted relationship with nothing retained', () => {
    /* The purge happened at the block. Re-admission starts clean rather than
       inheriting a `retain` decision made about a relationship that ended. */
    const again = readmit(rel({ state: 'blocked', retain: 'purge' }), hlcOf(300))
    expect(again.retain).toBe('keep')
    expect(again.admittedAt).toBe(hlcOf(300))
  })
})
