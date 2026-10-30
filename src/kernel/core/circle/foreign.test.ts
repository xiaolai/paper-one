import { describe, expect, it } from 'vitest'
import { resolvedCfiForTesting } from '../resolvedCfi.testkit'
import {
  FOREIGN_WEIGHTS,
  drawable,
  foreignWeight,
  offersShare,
  offersUnshare,
  overlayKey,
  overlayKeyOf,
  readersAmong,
  shareAbsentBecause,
  type ForeignEntry,
  type Publishability,
} from './foreign'

/** WI-22.D1, D2 and D3 — the overlay seam, the foreign store, publishability. */

const entry = (over: Partial<ForeignEntry> = {}): ForeignEntry => ({
  pub: 'pub1',
  person: 'alice',
  passage: { quote: 'the whale', prefix: 'p', suffix: 's', chapter: 'Ch. 1' },
  epoch: 1,
  receivedAt: 1000,
  resolved: { cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'), sectionIndex: 1 },
  ...over,
})

const always = () => true
const named = (person: string) => `Name of ${person}`

describe('WI-22.D1 — what reaches the painter', () => {
  it('never offers an unresolved passage', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"a capability contributes a passage that did
       not resolve and the painter draws it somewhere."* An entry with no
       `resolved` has no `ResolvedCfi` to give, so it cannot be built into a
       `ForeignAnnotation` at all — by the compiler, not by this filter. */
    /* ⚠️ Built by OMITTING the key, not by setting it undefined —
       `exactOptionalPropertyTypes` is on, and a present-but-undefined key is a
       different value here exactly as it is for `Mark.unplaced`. */
    const { resolved: _none, ...unresolved } = entry()
    expect(drawable([unresolved], named, always)).toEqual([])
  })

  it('carries no tint or style, so it cannot claim the reader vocabulary', () => {
    /* `Mark.tint` carries meaning the reader assigned. The fields are not on
       the wire either, so there is nothing to ignore — which is the point. */
    const [annotation] = drawable([entry()], named, always)
    expect(Object.keys(annotation!)).not.toContain('tint')
    expect(Object.keys(annotation!)).not.toContain('style')
  })

  it('gives each publication its own overlay key, which is the collapse fix', () => {
    /* ⚠️ `review.md`'s overlay blocker 1: `addAnnotation` keys the Overlayer on
       the annotation's VALUE, so several readers at one CFI became one entry
       and the last writer won. `Overlayer.add` already takes a key separate
       from the range; the fork keys on `annotation.key ?? annotation.value`,
       and this is what Paper passes. */
    const keyed = (person: string, pub: string) =>
      overlayKey({ person, opinions: [{ pub, audience: 'circle' as const, author: person }] })
    expect(keyed('alice', 'p1')).not.toBe(keyed('bob', 'p1'))
    expect(keyed('alice', 'p1')).not.toBe(keyed('alice', 'p2'))
    /* The composed spelling and the pre-annotation one are the SAME key —
       the resolver asks with the second and the painter is handed the first,
       so a drift between them silently anchors nothing. */
    expect(keyed('alice', 'p1')).toBe(overlayKeyOf('circle', 'alice', 'p1'))
  })

  it('keys a stranger apart from a friend who shares a publication id', () => {
    /* ⚠️ **A VOICE ID AND A PERSON ID ARE BOTH 64 HEX.** Without the audience
       segment the two layers key onto one another's marks — which is what the
       public capability's own `public:` literal used to prevent, in a second
       definition of this namespace that could have moved without this one. */
    expect(overlayKeyOf('public', 'a'.repeat(64), 'p1')).not.toBe(
      overlayKeyOf('circle', 'a'.repeat(64), 'p1'),
    )
  })

  it('shows the roster name as a claim, and it is never Paper verdict', () => {
    const [annotation] = drawable([entry()], named, always)
    expect(annotation!.opinions[0]!.author).toBe('Name of alice')
  })
})

describe('WI-22.D2 — a friend mark must not look like yours', () => {
  it('counts readers on one passage instead of stacking marks', () => {
    /* ⚠️ **THE FEATURE'S CENTRAL CASE** — *"4 of 11 readers marked this."* Four
       readers on one sentence is ONE underline that is heavier, not four
       stacked: drawing them separately is both illegible and the collapse bug
       wearing a different hat. */
    const four = ['alice', 'bob', 'carol', 'dan'].map((person, i) =>
      entry({ person, pub: `p${i}` }),
    )
    const drawn = drawable(four, named, always)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.people).toEqual(['alice', 'bob', 'carol', 'dan'])
    expect(readersAmong(drawn[0]!.people)).toBe(4)
  })

  it('keeps passages at different anchors separate', () => {
    const two = [
      entry({ pub: 'a', resolved: { cfi: resolvedCfiForTesting('cfiA'), sectionIndex: 1 } }),
      entry({ pub: 'b', resolved: { cfi: resolvedCfiForTesting('cfiB'), sectionIndex: 1 } }),
    ]
    expect(drawable(two, named, always)).toHaveLength(2)
  })

  it('does not move which publication a mark is filed under when a reader joins', () => {
    /* A redraw must not change the overlay key, or foliate sees a different
       annotation and the mark flickers out and back. */
    const first = drawable([entry({ pub: 'first' })], named, always)
    const withSecond = drawable(
      [entry({ pub: 'first' }), entry({ person: 'bob', pub: 'second' })],
      named,
      always,
    )
    expect(withSecond[0]!.opinions[0]!.pub).toBe(first[0]!.opinions[0]!.pub)
  })

  it('ramps weight and then flattens', () => {
    /* The difference between one reader and three is worth showing; between
       eleven and twelve it is not. Weight is the only channel available,
       because colour belongs to the reader. */
    expect(foreignWeight(1)).toBe(FOREIGN_WEIGHTS[0])
    expect(foreignWeight(3)).toBeGreaterThan(foreignWeight(1))
    expect(foreignWeight(50)).toBe(FOREIGN_WEIGHTS[FOREIGN_WEIGHTS.length - 1])
    expect(foreignWeight(0)).toBe(FOREIGN_WEIGHTS[0])
  })
})

describe('WI-22.E3 through the seam — the epoch decides what is drawn', () => {
  it('drops entries from a relationship that ended', () => {
    /* The recipient's epoch, not the publisher's. A reader you blocked and
       later re-admitted does not get their old passages back. */
    const old = entry({ epoch: 1 })
    const now = entry({ person: 'bob', pub: 'p2', epoch: 2 })
    const admitsEpoch2 = (_person: string, epoch: number) => epoch === 2
    const drawn = drawable([old, now], named, admitsEpoch2)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.person).toBe('bob')
  })

  it('draws nothing for a blocked person', () => {
    expect(drawable([entry()], named, () => false)).toEqual([])
  })
})

describe('WI-22.D3 — publishability', () => {
  it('offers Share only when the shelf can take one', () => {
    expect(offersShare('usable')).toBe(true)
    expect(offersShare('pending')).toBe(true)
    for (const state of ['read-only', 'revoked', 'unreachable', 'no-identity'] as const) {
      expect(offersShare(state)).toBe(false)
    }
  })

  it('offers Unshare while PENDING, which is the transition that misled', () => {
    /* ⚠️ **THE ITEM'S FALSIFIER**: *"find a transition that loses a share or
       misleads the reader."* `pending → failed` cannot distinguish "persisted,
       unacknowledged" from "never persisted" — so a pending publication may
       have landed, and a reader must never be unable to withdraw something that
       may be out. Offering it for something never published costs one no-op;
       withholding it costs the reader control of their own words. */
    expect(offersUnshare('pending', false)).toBe(true)
    expect(offersUnshare('usable', true)).toBe(true)
    /* And it stays offered when the shelf has gone away, because the passage
       may still be out there. */
    expect(offersUnshare('unreachable', true)).toBe(true)
  })

  it('gives a reason whenever Share is absent', () => {
    /* ⚠️ **ABSENT, NOT DISABLED, AND ALWAYS WITH A REASON.** A greyed control
       with no explanation is indistinguishable from a broken app — the defect
       `MobileApp.tsx` names about `onAddBooks`. */
    for (const state of ['read-only', 'revoked', 'unreachable', 'no-identity'] as const) {
      expect(shareAbsentBecause(state)).toBeTruthy()
    }
    /* ⚠️ **THE DESKTOP'S REASON NAMES THE DESKTOP'S REMEDY.** The shelf IS
       this machine, so a reason about a shelf that has not answered would
       send the reader looking for a device that is in front of them. */
    expect(shareAbsentBecause('no-identity')).toBe('Start a circle to share a passage.')
    for (const state of ['usable', 'pending'] as const) {
      expect(shareAbsentBecause(state)).toBeNull()
    }
  })

  it('has a reason for every state that hides Share, with none missed', () => {
    /* A `switch` over the union means a sixth state added later fails to
       compile rather than silently returning undefined. */
    const all: Publishability[] = ['usable', 'pending', 'read-only', 'revoked', 'unreachable', 'no-identity']
    for (const state of all) {
      expect(offersShare(state) === (shareAbsentBecause(state) === null)).toBe(true)
    }
  })
})

describe('the last clauses of publishability and the overlay — one row each', () => {
  it('says why Share is absent, for every state', () => {
    expect(shareAbsentBecause('usable')).toBeNull()
    expect(shareAbsentBecause('pending')).toBeNull()
    expect(shareAbsentBecause('read-only')).toBe('This device can read your shelf but not write to it.')
    expect(shareAbsentBecause('revoked')).toBe('Your shelf no longer recognises this device.')
    expect(shareAbsentBecause('unreachable')).toBe('Your shelf has not answered.')
    expect(shareAbsentBecause('no-identity')).toBe('Start a circle to share a passage.')
  })

  it('offers Unshare for what is published or pending, and for nothing else', () => {
    for (const state of ['usable', 'read-only', 'revoked', 'unreachable', 'no-identity'] as const) {
      expect(offersUnshare(state, false)).toBe(false)
      expect(offersUnshare(state, true)).toBe(true)
    }
    expect(offersUnshare('pending', false)).toBe(true)
  })

  it('carries a note only when the passage has one', () => {
    const [bare] = drawable([entry()], named, always)
    expect('note' in bare!.opinions[0]!).toBe(false)
    const [noted] = drawable([entry({ passage: { quote: 'q', prefix: 'p', suffix: 's', chapter: 'c', note: 'mine' } })], named, always)
    expect(noted!.opinions[0]!.note).toBe('mine')
  })

  it('keeps every publication’s words at one anchor, not just the first', () => {
    /* ⚠️ **GROUPING IS FOR THE WEIGHT, NOT FOR THE WORDS.** Two readers who
       marked the same sentence wrote two notes; the mark is one heavier rule
       and the notes are two. This dropped the second silently — it was parsed,
       admitted, anchored, and then discarded by the grouping. */
    const passage = (note: string) => ({ quote: 'q', prefix: 'p', suffix: 's', chapter: 'c', note })
    const [both] = drawable(
      [
        entry({ pub: 'p1', passage: passage('mine') }),
        entry({ pub: 'p2', person: 'bob', passage: passage('and mine') }),
      ],
      named,
      always,
    )
    expect(both!.opinions.map((one) => one.note)).toEqual(['mine', 'and mine'])
    expect(both!.opinions.map((one) => one.author)).toEqual(['Name of alice', 'Name of bob'])
  })

  it('keeps both notes when ONE person marked the same passage twice', () => {
    /* The count says one reader and there are still two notes — the case that
       made the loss invisible, because the row was dropped for the right
       reason (a reader already counted) and took the words with it. */
    const passage = (note: string) => ({ quote: 'q', prefix: 'p', suffix: 's', chapter: 'c', note })
    const [one] = drawable(
      [entry({ pub: 'p1', passage: passage('first') }), entry({ pub: 'p2', passage: passage('second') })],
      named,
      always,
    )
    expect(one!.people).toEqual(['alice'])
    expect(one!.opinions.map((each) => each.note)).toEqual(['first', 'second'])
  })
})

describe('readers are people, not entries', () => {
  it('counts one person once however many passages they placed at the anchor, and two people twice', () => {
    const one = drawable([entry(), entry({ pub: 'pub2' })], named, always)
    expect(one).toHaveLength(1)
    expect(one[0]!.people).toEqual(['alice'])
    const two = drawable([entry(), entry({ pub: 'pub2', person: 'bob' })], named, always)
    expect(two[0]!.people).toEqual(['alice', 'bob'])
  })
})

describe('nobody identifiable is one reader, never none', () => {
  it('floors an empty set at one, because a mark on the page had somebody behind it', () => {
    /* ⚠️ **AND ONE IS ALSO THE CEILING FOR THAT CASE.** An anchor a thousand
       unbound voices marked carries no identities at all — `reconcile` leaves
       every one of them out — so the floor is what draws it and the count
       cannot be inflated by minting keys. */
    expect(readersAmong([])).toBe(1)
    expect(readersAmong(['alice'])).toBe(1)
    expect(readersAmong(['alice', 'bob'])).toBe(2)
  })
})

describe('a weight for a count that is not a number', () => {
  it('is one reader’s worth', () => {
    expect(foreignWeight(Number.NaN)).toBe(foreignWeight(1))
    expect(foreignWeight(Number.POSITIVE_INFINITY)).toBe(foreignWeight(1))
  })
})
