import { describe, expect, it } from 'vitest'
import type { Mark } from './marks'
import { cacheKey, forgetGeneration, keyFor, lookUp, remember, type CacheEntry } from './reanchorCache'
import { resolvedCfiForTesting } from './resolvedCfi.testkit'

/**
 * The re-anchoring cache key (WI-21.8).
 *
 * The plan proposed `(foreign mark id, local bookId)` and the audit found it had
 * NEITHER half — archives omit mark ids, and `bookId` is sampled so it cannot
 * satisfy *"different bytes invalidate"*. These are the assertions that the two
 * halves now exist and that the second one actually bites.
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const unplacedMark = (over: Partial<Mark> = {}): Mark =>
  ({
    id: 'm1',
    bookId: 'book:here',
    cfi: resolvedCfiForTesting(''),
    sectionIndex: 0,
    text: 'Call me Ishmael',
    prefix: '',
    suffix: '',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: 'Loomings',
    createdAt: 1000,
    unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
    ...over,
  }) as Mark

describe('the key', () => {
  it('is the stored mark id and the book’s full digest', () => {
    expect(keyFor(unplacedMark(), { contentHash: HASH_A })).toEqual({ markId: 'm1', generation: HASH_A })
  })

  it('refuses to key a book with no full digest, rather than keying on nothing', () => {
    /* ⚠️ **NO GENERATION MEANS NO CACHE, NEVER AN UNVERSIONED ONE.**
       `contentHash` comes from sync's backfill, so a build without `sync` has
       none. A cache keyed on nothing would answer for a file it has never
       seen: the cost of missing is a 3.46 ms re-walk, and the cost of a stale
       hit is a mark drawn on the wrong words. */
    expect(keyFor(unplacedMark(), {})).toBeNull()
    expect(keyFor(unplacedMark(), { contentHash: '' })).toBeNull()
  })

  it('refuses a mark the store has not named yet', () => {
    /* The first draft keyed at the wrong MOMENT — before `addMany` had minted
       an id. WI-21.7 is what supplies one: a name-matched mark is stored now
       rather than refused, so it has a durable id that survives a relaunch. */
    expect(keyFor(unplacedMark({ id: '' }), { contentHash: HASH_A })).toBeNull()
  })

  it('refuses a mark that is already placed — there is nothing to resolve', () => {
    const { unplaced: _dropped, ...placed } = unplacedMark({ cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'), sectionIndex: 1 })
    expect(keyFor(placed as Mark, { contentHash: HASH_A })).toBeNull()
  })
})

describe('what it remembers', () => {
  const key = { markId: 'm1', generation: HASH_A }

  it('tells "never tried" apart from "tried, and not there"', () => {
    /* ⚠️ THE WHOLE CACHE IS THIS DISTINCTION. A passage genuinely absent from
       this build costs the SAME full walk to discover as one that is present.
       Remembering only the successes re-walks every unresolvable mark on every
       open, for ever — the shape that makes a working feature feel broken. */
    const empty = new Map<string, CacheEntry>()
    expect(lookUp(empty, key), 'nothing has been tried').toBeUndefined()

    const missed = remember(empty, key, null)
    expect(lookUp(missed, key), 'tried, and the passage is not in these bytes').toBeNull()

    const found = remember(empty, key, { cfi: resolvedCfiForTesting('epubcfi(/6/6!/4/8)'), sectionIndex: 2 })
    expect(lookUp(found, key)).toEqual({ cfi: resolvedCfiForTesting('epubcfi(/6/6!/4/8)'), sectionIndex: 2 })
  })

  it('does not answer for a different generation of the same mark', () => {
    /* THE INVALIDATION THE FIRST DRAFT COULD NOT EXPRESS. A reader who replaces
       a book with a better scan has the same marks and different bytes; an
       answer computed against the old file is now a guess. */
    const held = remember(new Map(), key, { cfi: resolvedCfiForTesting('epubcfi(/6/6!/4/8)'), sectionIndex: 2 })
    expect(lookUp(held, { markId: 'm1', generation: HASH_B })).toBeUndefined()
  })

  it('re-checks the generation it was handed, not only the key it built', () => {
    /* The key is a string this module builds; the map is the CALLER's, and may
       have been read off disk or merged. A cache that trusts its own key format
       is one rename away from serving an answer computed against other bytes. */
    const forged = new Map<string, CacheEntry>([
      [cacheKey(key), { generation: HASH_B, resolution: { cfi: resolvedCfiForTesting('epubcfi(/6/2)'), sectionIndex: 0 } }],
    ])
    expect(lookUp(forged, key)).toBeUndefined()
  })

  it('never mutates the map it was given', () => {
    const held = new Map<string, CacheEntry>()
    const next = remember(held, key, null)
    expect(held.size).toBe(0)
    expect(next.size).toBe(1)
  })
})

describe('forgetting a generation', () => {
  it('drops every answer computed against the bytes that changed', () => {
    const held = remember(
      remember(new Map(), { markId: 'm1', generation: HASH_A }, null),
      { markId: 'm2', generation: HASH_A },
      { cfi: resolvedCfiForTesting('epubcfi(/6/4)'), sectionIndex: 1 },
    )
    expect(forgetGeneration(held, HASH_A).size).toBe(0)
  })

  it('leaves other books alone', () => {
    /* Entries carry their own generations, and a change to one book's bytes
       says nothing about another's. */
    const held = remember(
      remember(new Map(), { markId: 'm1', generation: HASH_A }, null),
      { markId: 'm2', generation: HASH_B },
      null,
    )
    const kept = forgetGeneration(held, HASH_A)
    expect(kept.size).toBe(1)
    expect(lookUp(kept, { markId: 'm2', generation: HASH_B })).toBeNull()
  })

  it('hands the map back by identity when nothing matched', () => {
    /* The no-write convention the stores rely on: a caller holding this in
       state must not re-render because a generation nobody had was forgotten. */
    const held = remember(new Map(), { markId: 'm1', generation: HASH_A }, null)
    expect(forgetGeneration(held, HASH_B)).toBe(held)
  })
})
