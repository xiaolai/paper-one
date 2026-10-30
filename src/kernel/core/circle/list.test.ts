import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { hlcOf, type Hlc } from '../hlc'
import { compactedList, compareItems, foldList, NO_LIST, type ListItem } from './list'
import { type Entry, type ShelvedWork } from './log'

/**
 * WI-23.E1's fold, and its falsifier: two devices placing at position 3 —
 * the test names which wins and why.
 */

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const WORK: ShelvedWork = { title: 'Moby-Dick', author: 'Herman Melville', language: 'en' }
const OTHER: ShelvedWork = { title: 'Dune', author: 'Frank Herbert', language: 'en' }
const at = (n: number): Hlc => hlcOf(n)
const stamp = (device: string, seq: number, n: number) => ({ device, seq, at: at(n) })
const place = (device: string, seq: number, n: number, pub: string, position: number, note = '', work = WORK): Entry => ({
  ...stamp(device, seq, n),
  op: 'place',
  pub,
  work,
  position,
  note,
})

describe('a list, folded', () => {
  it('is nothing until created, then carries its title, and the newest retitle wins by stamp', () => {
    expect(foldList([])).toEqual(NO_LIST)
    expect(foldList([place(A, 1, 1, 'x', 1)]).created).toBe(false)
    const created = foldList([{ ...stamp(A, 1, 1), op: 'create', title: 'Sea books' }])
    expect(created).toEqual({ created: true, title: 'Sea books', deleted: false, items: [] })
    /* A retitle stamped later wins whichever page lands first. */
    const log: Entry[] = [
      { ...stamp(A, 1, 1), op: 'create', title: 'Sea books' },
      { ...stamp(B, 1, 5), op: 'retitle', title: 'Whales' },
      { ...stamp(A, 2, 3), op: 'retitle', title: 'Ships' },
    ]
    expect(foldList(log).title).toBe('Whales')
    expect(foldList([...log].reverse()).title).toBe('Whales')
    /* A create stamped after a retitle is the newer word, as a register. */
    expect(foldList([{ ...stamp(A, 2, 9), op: 'create', title: 'Late' }, { ...stamp(B, 1, 5), op: 'retitle', title: 'Whales' }]).title).toBe('Late')
  })

  it('places, moves, removes for ever, and deletes for ever', () => {
    const create: Entry = { ...stamp(A, 1, 1), op: 'create', title: 'L' }
    const placed = foldList([create, place(A, 2, 2, 'x', 1, 'a note')])
    expect(placed.items).toEqual([{ pub: 'x', work: WORK, position: 1, note: 'a note', at: at(2), device: A, seq: 2 }])
    /* Re-placing the same pub moves it and rewrites the note. */
    const moved = foldList([create, place(A, 2, 2, 'x', 1, 'a note'), place(A, 3, 3, 'x', 7, 'moved')])
    expect(moved.items.map((one) => [one.position, one.note])).toEqual([[7, 'moved']])
    /* An OLDER placement arriving later does not move it back. */
    expect(foldList([create, place(A, 3, 3, 'x', 7, 'moved'), place(A, 2, 2, 'x', 1, 'a note')]).items[0]!.position).toBe(7)
    /* Removed, then placed again under the same pub, in either order: gone. */
    const remove: Entry = { ...stamp(A, 4, 4), op: 'remove', pub: 'x' }
    expect(foldList([create, place(A, 2, 2, 'x', 1), remove]).items).toEqual([])
    expect(foldList([create, remove, place(A, 5, 9, 'x', 1)]).items).toEqual([])
    /* Deleted, whatever comes after. */
    const gone = foldList([create, { ...stamp(B, 1, 2), op: 'delete' }, { ...stamp(A, 2, 9), op: 'create', title: 'Again' }])
    expect(gone.deleted).toBe(true)
    expect(gone.created).toBe(true)
  })

  it('ignores every kind that belongs to another log', () => {
    const foreign: Entry[] = [
      { ...stamp(A, 1, 1), op: 'share', pub: 'p', passage: { quote: 'q', prefix: '', suffix: '', chapter: '' } },
      { ...stamp(A, 2, 2), op: 'unshare', pub: 'p' },
      { ...stamp(A, 3, 3), op: 'status', state: 'reading' },
      { ...stamp(A, 4, 4), op: 'rate', stars: 3 },
      { ...stamp(A, 5, 5), op: 'tag', tags: ['sea'] },
      { ...stamp(A, 6, 6), op: 'review', pub: 'r', text: 't' },
      { ...stamp(A, 7, 7), op: 'unreview', pub: 'r' },
      { ...stamp(A, 8, 8), op: 'shelf', pub: 's', work: WORK },
      { ...stamp(A, 9, 9), op: 'unshelf', pub: 's' },
    ]
    expect(foldList(foreign)).toEqual(NO_LIST)
  })
})

describe('the position rule — the falsifier', () => {
  const create: Entry = { ...stamp(A, 1, 1), op: 'create', title: 'L' }

  it('two devices place at position 3: the EARLIER stamp keeps the spot and the later follows it', () => {
    /* A placed "x" at 3 at stamp 5; B placed "y" at 3 at stamp 7. A saw a
       list "y" was not in; B's placement is an insertion after what was
       already there. So: x, then y. And the same whichever page lands first. */
    const fromA = place(A, 2, 5, 'x', 3)
    const fromB = place(B, 1, 7, 'y', 3)
    expect(foldList([create, fromA, fromB]).items.map((one) => one.pub)).toEqual(['x', 'y'])
    expect(foldList([create, fromB, fromA]).items.map((one) => one.pub)).toEqual(['x', 'y'])
    /* Had B been earlier, B's would sit first. The stamp decides, not the device. */
    expect(foldList([create, place(A, 2, 9, 'x', 3), fromB]).items.map((one) => one.pub)).toEqual(['y', 'x'])
  })

  it('breaks a true tie by device id, then by sequence, so every reader agrees', () => {
    const sameStamp = [place(B, 1, 5, 'y', 3), place(A, 2, 5, 'x', 3)]
    expect(foldList([create, ...sameStamp]).items.map((one) => one.pub)).toEqual(['x', 'y'])
    expect(foldList([create, ...sameStamp.reverse()]).items.map((one) => one.pub)).toEqual(['x', 'y'])
    const item = (pub: string, device: string, seq: number, position: number, n: number): ListItem => ({ pub, work: WORK, position, note: '', at: at(n), device, seq })
    expect(compareItems(item('x', A, 1, 3, 5), item('y', A, 2, 3, 5))).toBeLessThan(0)
    expect(compareItems(item('x', A, 2, 3, 5), item('y', A, 1, 3, 5))).toBeGreaterThan(0)
    expect(compareItems(item('x', A, 1, 2, 9), item('y', A, 2, 3, 1))).toBeLessThan(0)
  })

  it('orders by position first, whatever the stamps', () => {
    const items = foldList([create, place(A, 2, 9, 'late-but-first', 1), place(B, 1, 2, 'early-but-second', 2), place(A, 3, 1, 'third', 3, '', OTHER)])
    expect(items.items.map((one) => one.pub)).toEqual(['late-but-first', 'early-but-second', 'third'])
  })

  it('folds to one order from every arrival order — a property', () => {
    /* An honest log: one sequence per (device, seq) — a duplicate key with
       different words is a forgery, and for those the rule is "the first
       seen", which is a rule about delivery, not about the fold. */
    const shape = fc.oneof(
      fc.record({ kind: fc.constant('place' as const), device: fc.constantFrom(A, B), n: fc.integer({ min: 1, max: 6 }), pub: fc.constantFrom('x', 'y', 'z'), position: fc.integer({ min: 1, max: 4 }) }),
      fc.record({ kind: fc.constant('remove' as const), device: fc.constantFrom(A, B), n: fc.integer({ min: 1, max: 6 }), pub: fc.constantFrom('x', 'y', 'z') }),
      fc.record({ kind: fc.constant('retitle' as const), device: fc.constantFrom(A, B), n: fc.integer({ min: 1, max: 6 }), title: fc.constantFrom('p', 'q') }),
    )
    fc.assert(
      fc.property(fc.array(shape, { maxLength: 8 }), fc.array(fc.nat(), { maxLength: 8 }), (shapes, seeds) => {
        const seqs = new Map<string, number>()
        const entries: Entry[] = shapes.map((one) => {
          const seq = (seqs.get(one.device) ?? 1) + 1
          seqs.set(one.device, seq)
          if (one.kind === 'place') return place(one.device, seq, one.n, one.pub, one.position)
          if (one.kind === 'remove') return { ...stamp(one.device, seq, one.n), op: 'remove', pub: one.pub }
          return { ...stamp(one.device, seq, one.n), op: 'retitle', title: one.title }
        })
        const log = [create, ...entries]
        const shuffled = [...log].sort((a, b) => (seeds[log.indexOf(a) % Math.max(seeds.length, 1)] ?? 0) - (seeds[log.indexOf(b) % Math.max(seeds.length, 1)] ?? 0))
        expect(foldList(shuffled)).toEqual(foldList(log))
      }),
    )
  })
})

describe('a list log, compacted', () => {
  const create: Entry = { ...stamp(A, 1, 1), op: 'create', title: 'L' }
  it('serves the winning title, the live placements and nothing retracted, renumbered', () => {
    const log: Entry[] = [
      create,
      { ...stamp(A, 2, 2), op: 'retitle', title: 'Newer' },
      place(A, 3, 3, 'x', 1, 'first'),
      place(A, 4, 4, 'x', 2, 'moved'),
      place(A, 5, 5, 'y', 3),
      { ...stamp(A, 6, 6), op: 'remove', pub: 'y' },
    ]
    const served = compactedList(log, B)
    /* ONE creation, carrying the winning title under the winner's own stamp:
       the losing title is retracted history, and a view holding only the
       retitle would fold to a list never created. */
    expect(served.map((one) => [one.op, one.device, one.seq])).toEqual([
      ['create', B, 1],
      ['place', B, 2],
    ])
    expect(served[0]).toMatchObject({ op: 'create', title: 'Newer', at: at(2) })
    expect(served[1]).toMatchObject({ pub: 'x', position: 2, note: 'moved' })
    expect(foldList(served)).toMatchObject({ created: true, title: 'Newer', items: [{ pub: 'x', position: 2 }] })
    /* And no retracted title anywhere in what is served — the falsifier. */
    expect(JSON.stringify(served)).not.toContain('"L"')
  })

  it('serves the same bytes from every arrival order — sorted before it is renumbered', () => {
    const log: Entry[] = [create, place(B, 1, 5, 'y', 2), place(A, 2, 3, 'x', 1), { ...stamp(A, 3, 4), op: 'retitle', title: 'Newer' }]
    const one = compactedList(log, B)
    const other = compactedList([...log].reverse(), B)
    expect(one).toEqual(other)
    expect(one.map((entry) => entry.seq)).toEqual([1, 2, 3])
    /* Log order: the placement at stamp 3, the retitle-turned-create at 4, the placement at 5. */
    expect(one.map((entry) => [entry.op, entry.at])).toEqual([
      ['place', at(3)],
      ['create', at(4)],
      ['place', at(5)],
    ])
  })

  it('serves the creation alone as the title when nothing retitled it', () => {
    const served = compactedList([create, place(A, 2, 2, 'x', 1)], B)
    expect(served.map((one) => one.op)).toEqual(['create', 'place'])
    expect(foldList(served)).toMatchObject({ created: true, title: 'L' })
  })

  it('serves a deleted list as its deletion alone, and an uncreated one as nothing', () => {
    expect(compactedList([create, place(A, 2, 2, 'x', 1), { ...stamp(A, 3, 3), op: 'delete' }], B).map((one) => one.op)).toEqual(['delete'])
    expect(compactedList([place(A, 2, 2, 'x', 1)], B)).toEqual([])
    expect(compactedList([{ ...stamp(A, 1, 1), op: 'share', pub: 'p', passage: { quote: 'q', prefix: '', suffix: '', chapter: '' } }], B)).toEqual([])
  })
})

describe('one placement delivered twice', () => {
  it('keeps ONE word at one (device, seq, stamp), the same whichever arrived first — a fork, resolved as `fold` resolves one', () => {
    /* An honest device never writes two entries at one sequence, so this is a
       forgery or a corruption; what matters is that two replicas that met
       the two in either order hold the same list, or they diverge for ever.
       The canonical spelling orders them, and the lesser is kept. */
    const create: Entry = { ...stamp(A, 1, 1), op: 'create', title: 'L' }
    const first = place(A, 2, 5, 'x', 3, 'first')
    const again = { ...first, note: 'again', position: 9 }
    const oneWay = foldList([create, first, again]).items
    const otherWay = foldList([create, again, first]).items
    expect(oneWay).toEqual(otherWay)
    expect(oneWay).toHaveLength(1)
    expect(compactedList([create, first, again], B)).toEqual(compactedList([create, again, first], B))
  })
})
