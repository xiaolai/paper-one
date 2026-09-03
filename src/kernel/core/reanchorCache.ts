import type { Mark } from './marks'
import type { ResolvedCfi } from './resolvedCfi'

/**
 * What a re-anchoring attempt already answered, and when that answer expires.
 *
 * ## The key, which the first draft did not have
 *
 * The plan proposed `(foreign mark id, local bookId)` and the audit found it
 * had **neither half**:
 *
 *  - **No mark id.** Archives deliberately omit them (`marksArchive.ts`: *"`id`
 *    is store-assigned"*), `addMany` mints its own and returns `void`, so at
 *    the moment of import there is nothing stable to key on.
 *  - **No usable generation.** `bookId` is SAMPLED above 64 MiB — which is what
 *    `measure-book-identity.mjs` exists to prove — so it cannot satisfy
 *    *"different bytes invalidate"*. Two different files share one.
 *
 * Both halves exist now, and neither was invented for this:
 *
 *  - **The identity is the STORED mark's own id.** WI-21.7 is what supplies it:
 *    a name-matched mark is now stored rather than refused, so it has been
 *    through `addMany` and carries a durable id that survives a relaunch. The
 *    first draft was keying at the wrong moment — before the store had spoken.
 *  - **The generation is `contentHash`**, BLAKE3 of the WHOLE file. It answers
 *    the question `bookId` only appears to: two different files never share one.
 *
 * ## What an absent generation means
 *
 * ⚠️ **NO GENERATION MEANS NO CACHE, NEVER AN UNVERSIONED ONE.** `contentHash`
 * is stamped by sync's backfill, so a build composed without `sync` has none —
 * and a cache keyed on nothing would answer for a file it has never seen. The
 * cost of missing is a re-walk, measured at 3.46 ms for a cold section; the cost
 * of a stale hit is a mark drawn on the wrong words, which is the entire defect
 * this phase exists to remove. The trade is not close.
 *
 * ## Why a miss is stored too
 *
 * A passage that is genuinely not in this build answers `null`, and answering
 * `null` costs the same full walk as answering with a range. Remembering only
 * the successes would re-walk every unresolvable mark on every open, for ever —
 * which is the shape that makes a feature feel broken while working correctly.
 *
 * PURE, and no storage: this decides what may be reused and what must be
 * recomputed. Where the answers live is the caller's, and a caller that keeps
 * them only in memory is still correct — it simply pays more.
 */

/** Where a mark was found — the anchor a resolution produces.
 *
 *  `ResolvedCfi`, because the only thing that fills one in is the resolver
 *  (WI-22.A1). A cache that remembered bare strings would launder them: a
 *  fabricated anchor stored here would come back out branded and go straight
 *  to `marks.place`, which is the one write that installs an anchor. */
export interface Placement {
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
}

/**
 * One remembered answer. `null` is a REMEMBERED FAILURE and not the absence of
 * an entry — see the header: the two cost the same to produce and only one of
 * them is worth paying for twice.
 */
export type Resolution = Placement | null

export interface CacheEntry {
  /** The `contentHash` of the bytes this answer was computed against. */
  readonly generation: string
  readonly resolution: Resolution
}

/** What the cache is keyed by, when it can be keyed at all. */
export interface ResolutionKey {
  readonly markId: string
  readonly generation: string
}

/**
 * The key for re-anchoring this mark against this book, or null when there is
 * no honest one.
 *
 * Null for three reasons, all of which mean "recompute":
 *  - the mark has no stored id yet (it has not been through `addMany`),
 *  - the book carries no `contentHash` (nothing has hashed it),
 *  - the mark is already placed, so there is nothing to resolve.
 */
export function keyFor(mark: Mark, book: { readonly contentHash?: string }): ResolutionKey | null {
  if (mark.unplaced === undefined) return null
  if (mark.id === '') return null
  const generation = book.contentHash
  if (generation === undefined || generation === '') return null
  return { markId: mark.id, generation }
}

/** `<markId>@<generation>` — one string, so a `Map` can hold it. */
export const cacheKey = (key: ResolutionKey): string => `${key.markId}@${key.generation}`

/**
 * The remembered answer for this key, or `undefined` when there is none to
 * reuse.
 *
 * ⚠️ **`undefined` AND `null` ARE DIFFERENT ANSWERS HERE and the difference is
 * the whole cache.** `undefined` is *"nothing has been tried"*; `null` is
 * *"this was tried against these exact bytes and the passage is not in them"*.
 * Collapsing them re-walks every unresolvable mark for ever.
 */
export function lookUp(
  held: ReadonlyMap<string, CacheEntry>,
  key: ResolutionKey,
): Resolution | undefined {
  const entry = held.get(cacheKey(key))
  if (entry === undefined) return undefined
  /* THE GENERATION IS CHECKED AGAIN even though it is in the key. The key is a
   * string built by this module and the map is the caller's — which may have
   * been read off disk, merged, or handed over by another process. A cache that
   * trusts its own key format is one rename away from serving an answer
   * computed against different bytes. */
  return entry.generation === key.generation ? entry.resolution : undefined
}

/** The map with this answer remembered. Fresh, never mutated in place. */
export function remember(
  held: ReadonlyMap<string, CacheEntry>,
  key: ResolutionKey,
  resolution: Resolution,
): ReadonlyMap<string, CacheEntry> {
  const next = new Map(held)
  next.set(cacheKey(key), { generation: key.generation, resolution })
  return next
}

/**
 * Everything still worth keeping when a book's bytes change.
 *
 * ⚠️ **DROPPED BY GENERATION, NOT BY MARK.** A reader who replaces a book with
 * a better scan has the same marks and different bytes, and every answer
 * computed against the old file is now a guess. Keyed per mark, the entries
 * would survive the replacement and place marks by the old document's geometry
 * — silently, which is this phase's whole subject.
 *
 * Entries for OTHER books are untouched: they carry their own generations and a
 * change here says nothing about them.
 */
export function forgetGeneration(
  held: ReadonlyMap<string, CacheEntry>,
  stale: string,
): ReadonlyMap<string, CacheEntry> {
  const next = new Map<string, CacheEntry>()
  for (const [key, entry] of held) if (entry.generation !== stale) next.set(key, entry)
  return next.size === held.size ? held : next
}
