import { describe, expect, it } from 'vitest'
import { FOREIGN_WEIGHTS, foreignWeight, overlayKey, overlayKeyOf, readersAmong } from './foreignAnnotation'

describe('WI-22.D1 — what reaches the painter', () => {
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
})

describe('WI-22.D2 — a friend mark must not look like yours', () => {
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
