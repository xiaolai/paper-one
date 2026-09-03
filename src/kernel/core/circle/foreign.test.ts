import { describe, expect, it } from 'vitest'
import { resolvedCfiForTesting } from '../resolvedCfi.testkit'
import {
  FOREIGN_WEIGHTS,
  drawable,
  foreignWeight,
  offersShare,
  offersUnshare,
  overlayKey,
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
    expect(overlayKey({ person: 'alice', pub: 'p1' })).not.toBe(
      overlayKey({ person: 'bob', pub: 'p1' }),
    )
    expect(overlayKey({ person: 'alice', pub: 'p1' })).not.toBe(
      overlayKey({ person: 'alice', pub: 'p2' }),
    )
  })

  it('shows the roster name as a claim, and it is never Paper verdict', () => {
    const [annotation] = drawable([entry()], named, always)
    expect(annotation!.author).toBe('Name of alice')
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
    expect(drawn[0]!.readers).toBe(4)
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
    expect(withSecond[0]!.pub).toBe(first[0]!.pub)
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
    for (const state of ['read-only', 'revoked', 'unreachable'] as const) {
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
    for (const state of ['read-only', 'revoked', 'unreachable'] as const) {
      expect(shareAbsentBecause(state)).toBeTruthy()
    }
    for (const state of ['usable', 'pending'] as const) {
      expect(shareAbsentBecause(state)).toBeNull()
    }
  })

  it('has a reason for every state that hides Share, with none missed', () => {
    /* A `switch` over the union means a sixth state added later fails to
       compile rather than silently returning undefined. */
    const all: Publishability[] = ['usable', 'pending', 'read-only', 'revoked', 'unreachable']
    for (const state of all) {
      expect(offersShare(state) === (shareAbsentBecause(state) === null)).toBe(true)
    }
  })
})
