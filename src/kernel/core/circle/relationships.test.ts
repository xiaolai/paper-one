import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
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
  newRelationship,
  showShelf,
} from './relationships'

/** WI-22.E1, E2 and E3 — the review's ninth condition. */

const rel = (over: Partial<Relationship> = {}): Relationship => ({
  person: 'A',
  state: 'admitted',
  epoch: 1,
  admittedAt: hlcOf(100),
  changedAt: hlcOf(100),
  retain: 'keep',
  shelf: false,
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

describe('the shelf switch — WI-23.C2', () => {
  it('starts OFF for a new relationship, and off again after a re-admission', () => {
    /* ⚠️ A DISCLOSURE SWITCH DEFAULTS OFF, and a new epoch cannot revive a
       grant — showing a shelf is one. */
    expect(newRelationship('A', hlcOf(1))).toEqual({
      person: 'A',
      state: 'admitted',
      epoch: 1,
      admittedAt: hlcOf(1),
      changedAt: hlcOf(1),
      retain: 'keep',
      shelf: false,
      shelfAt: hlcOf(1),
    })
    expect(readmit(rel({ shelf: true, state: 'blocked' }), hlcOf(300)).shelf).toBe(false)
    expect(readmit(rel({ shelf: true, state: 'blocked' }), hlcOf(300)).shelfAt).toBe(hlcOf(300))
  })

  it('turns under its OWN stamp, so the phone’s decision reaches the laptop without moving the state', () => {
    const on = showShelf(rel(), true, hlcOf(200))
    expect(on.shelf).toBe(true)
    expect(on.shelfAt).toBe(hlcOf(200))
    expect(on.changedAt).toBe(rel().changedAt)
    expect(mergeRelationship(rel(), on)).toEqual(on)
    expect(mergeRelationship(on, rel())).toEqual(on)
    const off = showShelf(on, false, hlcOf(300))
    expect(mergeRelationship(on, off).shelf).toBe(false)
  })

  it('leaves everything else of the record alone', () => {
    const on = showShelf(rel({ state: 'muted', epoch: 3, retain: 'purge' }), true, hlcOf(200))
    expect(on).toMatchObject({ state: 'muted', epoch: 3, retain: 'purge', admittedAt: hlcOf(100) })
  })
})

describe('the last two clauses — one row each', () => {
  it('resolves a true tie of stamp and state the same way from either side — the more restrictive copy', () => {
    const a = { ...newRelationship('p', hlcOf(5)), retain: 'keep' as const }
    const b = { ...a, retain: 'purge' as const }
    expect(mergeRelationship(a, b)).toEqual(b)
    expect(mergeRelationship(b, a)).toEqual(b)
    const later = { ...a, epoch: 2 }
    expect(mergeRelationship(a, later)).toEqual(later)
    expect(mergeRelationship(later, a)).toEqual(later)
    expect(mergeRelationship(a, { ...a })).toEqual(a)
  })

  it('does not let a stale shelf toggle re-admit a person blocked meanwhile — the split stamps', () => {
    /* The laptop blocks at 10; the phone, still holding the admitted copy,
       turns the shelf on at 20. Merged either way: blocked, AND shown the
       shelf — two registers, two answers, neither overwriting the other. */
    const admitted = newRelationship('p', hlcOf(1))
    const blocked = changeState(admitted, 'blocked', hlcOf(10))
    const shown = showShelf(admitted, true, hlcOf(20))
    for (const merged of [mergeRelationship(blocked, shown), mergeRelationship(shown, blocked)]) {
      expect(merged.state).toBe('blocked')
      expect(merged.changedAt).toBe(hlcOf(10))
      expect(merged.shelf).toBe(true)
      expect(merged.shelfAt).toBe(hlcOf(20))
    }
    /* A record written before the switch had a stamp reads its state's. */
    const old = { ...admitted, shelf: true, changedAt: hlcOf(3) }
    delete (old as { shelfAt?: unknown }).shelfAt
    expect(mergeRelationship(old, showShelf(admitted, false, hlcOf(2))).shelf).toBe(true)
    expect(mergeRelationship(showShelf(admitted, false, hlcOf(2)), old).shelf).toBe(true)
    /* At a tie of the switch's stamp, off. */
    const on = showShelf(admitted, true, hlcOf(7))
    const off = showShelf(admitted, false, hlcOf(7))
    expect(mergeRelationship(on, off).shelf).toBe(false)
    expect(mergeRelationship(off, on).shelf).toBe(false)
  })

  it('admits an admitted or muted person and refuses the rest, and a stranger', () => {
    const at = hlcOf(1)
    expect(admits(newRelationship('p', at))).toBe('admit')
    expect(admits({ ...newRelationship('p', at), state: 'muted' })).toBe('admit')
    expect(admits({ ...newRelationship('p', at), state: 'blocked' })).toBe('refuse')
    expect(admits({ ...newRelationship('p', at), state: 'exited' })).toBe('refuse')
    expect(admits(null)).toBe('refuse')
  })
})

describe('the shelf grant and the epoch', () => {
  it('does not carry a stale replica’s later shelf-on across a re-admission', () => {
    const blocked = rel({ state: 'blocked', epoch: 1, changedAt: hlcOf(100), shelf: false, shelfAt: hlcOf(100) })
    const again = readmit(blocked, hlcOf(300))
    /* A replica that never heard of the block or the re-admission turned the
       shelf on under epoch 1, with a clock that runs ahead. */
    const stale = rel({ state: 'admitted', epoch: 1, changedAt: hlcOf(50), shelf: true, shelfAt: hlcOf(400) })
    for (const merged of [mergeRelationship(again, stale), mergeRelationship(stale, again)]) {
      expect(merged.epoch).toBe(2)
      expect(merged.shelf).toBe(false)
    }
  })

  it('still lets the later switch win within one epoch', () => {
    const off = rel({ epoch: 1, shelf: false, shelfAt: hlcOf(10) })
    const on = rel({ epoch: 1, shelf: true, shelfAt: hlcOf(20) })
    expect(mergeRelationship(off, on).shelf).toBe(true)
    expect(mergeRelationship(on, off).shelf).toBe(true)
  })
})

describe('the state half, held to the letter', () => {
  it('lets the later stamp win even when it is the less restrictive state', () => {
    const blocked = rel({ state: 'blocked', changedAt: hlcOf(10) })
    const admitted = rel({ state: 'admitted', changedAt: hlcOf(20) })
    expect(mergeRelationship(blocked, admitted).state).toBe('admitted')
    expect(mergeRelationship(admitted, blocked).state).toBe('admitted')
  })

  it('breaks a full tie by the earlier admission, so both orders agree', () => {
    const early = rel({ changedAt: hlcOf(10), admittedAt: hlcOf(1) })
    const late = rel({ changedAt: hlcOf(10), admittedAt: hlcOf(2) })
    expect(mergeRelationship(early, late).admittedAt).toBe(hlcOf(1))
    expect(mergeRelationship(late, early).admittedAt).toBe(hlcOf(1))
    /* Retain still decides before that: purge over keep at a tie. */
    const keep = rel({ changedAt: hlcOf(10), retain: 'keep', admittedAt: hlcOf(1) })
    const purge = rel({ changedAt: hlcOf(10), retain: 'purge', admittedAt: hlcOf(2) })
    expect(mergeRelationship(keep, purge).retain).toBe('purge')
    expect(mergeRelationship(purge, keep).retain).toBe('purge')
  })
})

describe('how an ended relationship comes back', () => {
  it('is through readmit alone: blocked and exited refuse a plain state change to admitted, muted allows it', () => {
    expect(() => changeState(rel({ state: 'blocked' }), 'admitted', hlcOf(9))).toThrow(/re-admitted through readmit/u)
    expect(() => changeState(rel({ state: 'exited' }), 'admitted', hlcOf(9))).toThrow(/re-admitted through readmit/u)
    /* Muted accepts transport, so it is the same door by another name. */
    expect(() => changeState(rel({ state: 'blocked' }), 'muted', hlcOf(9))).toThrow(/re-admitted through readmit/u)
    expect(() => changeState(rel({ state: 'exited' }), 'muted', hlcOf(9))).toThrow(/re-admitted through readmit/u)
    expect(changeState(rel({ state: 'blocked' }), 'exited', hlcOf(9)).state).toBe('exited')
    expect(changeState(rel({ state: 'muted' }), 'admitted', hlcOf(9)).state).toBe('admitted')
    expect(changeState(rel({ state: 'admitted' }), 'blocked', hlcOf(9)).state).toBe('blocked')
  })
})

describe('the merge, as a property', () => {
  const record = fc.record({
    state: fc.constantFrom('admitted', 'muted', 'blocked', 'exited'),
    epoch: fc.integer({ min: 1, max: 3 }),
    changedAt: fc.integer({ min: 1, max: 6 }).map((n) => hlcOf(n)),
    admittedAt: fc.integer({ min: 1, max: 6 }).map((n) => hlcOf(n)),
    retain: fc.constantFrom('keep', 'purge'),
    shelf: fc.boolean(),
    shelfAt: fc.integer({ min: 1, max: 6 }).map((n) => hlcOf(n)),
  }).map((over) => rel(over as Partial<Relationship>))
  it('is commutative and associative over every record three replicas could hold', () => {
    fc.assert(
      fc.property(record, record, record, (a, b, c) => {
        expect(mergeRelationship(a, b)).toEqual(mergeRelationship(b, a))
        expect(mergeRelationship(mergeRelationship(a, b), c)).toEqual(mergeRelationship(a, mergeRelationship(b, c)))
      }),
      { numRuns: 400 },
    )
  })
})

describe('what a state change may do to an ended relationship', () => {
  it('may move it between blocked and exited — every way back to transport is refused', () => {
    expect(changeState(rel({ state: 'blocked' }), 'exited', hlcOf(9)).state).toBe('exited')
    expect(changeState(rel({ state: 'exited' }), 'blocked', hlcOf(9)).state).toBe('blocked')
    /* Muted accepts transport: blocked to muted to admitted would have been a re-admission with no ceremony and no new epoch. */
    expect(() => changeState(rel({ state: 'blocked' }), 'muted', hlcOf(9))).toThrow(/re-admitted through readmit/u)
    expect(changeState(rel({ state: 'muted' }), 'admitted', hlcOf(9)).state).toBe('admitted')
  })
})
