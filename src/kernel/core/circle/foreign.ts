import type { ResolvedCfi } from '../resolvedCfi'
import type { Passage } from './log'

/**
 * A friend's passage, on this device — WI-22.D1, D2 and D3.
 *
 * ## Why it cannot live in `marks.json`
 *
 * ⚠️ `review.md`: *"`unplaced` is a discriminator on a stored `Mark` and the
 * cache needs a stored mark id — but a foreign passage must never enter
 * `marks.json`, or it republishes as the recipient's own."*
 *
 * The second half is the dangerous one. A foreign passage in `marks.json` is
 * picked up by `exportMarks`, by the sync feed and by every one of your own
 * devices — as **your** annotation. So it lives beside the marks file and never
 * inside it:
 *
 * ```
 * <book folder>/circle/<personId>.json
 * ```
 *
 * Same folder, same write queue, same HLC discipline — so removing a book takes
 * its foreign overlays with it, which is what a reader expects and what nothing
 * else would give.
 *
 * ## `pub` is the stable id the cache needed
 *
 * ⚠️ The objection was that `reanchorCache.keyFor` refuses a mark with no
 * stored id. `pub` is minted by the publisher, travels with the entry and is
 * durable — so the cache generalises to `(pub, contentHash)` with no change to
 * its reasoning, and `reanchorPass` is reused unchanged: it takes
 * `PendingMark { id, quote, prefix, suffix }`, and a foreign entry supplies
 * `pub` as the id and the wire's passage as the rest.
 *
 * **Stage A built the walk this needs without knowing it.**
 */

/** One friend's passage, as this device holds it. */
export interface ForeignEntry {
  readonly pub: string
  readonly person: string
  readonly passage: Passage
  /** Which relationship epoch this arrived under — see `relationships.ts`. */
  readonly epoch: number
  readonly receivedAt: number
  /**
   * Where it landed in THIS build, once a re-anchoring pass placed it.
   *
   * Absent until then, and absent for ever for a passage this build does not
   * contain — which is a legitimate state, not a failure. `ResolvedCfi`,
   * because only the resolver can produce one (WI-22.A1).
   */
  readonly resolved?: { readonly cfi: ResolvedCfi; readonly sectionIndex: number }
}

/**
 * What the painter is handed — already anchored HERE.
 *
 * ⚠️ **`ResolvedCfi`, so an unresolved passage cannot reach the painter — by
 * the compiler, not by a comment.** That is WI-22.D1's acceptance, and it is
 * the reason `surfaces.md` asked for the nominal type in the first place.
 *
 * ⚠️ **NO `tint` AND NO `style`.** A foreign mark is drawn in the recipient's
 * own foreign treatment; `Mark.tint` carries meaning the reader assigned, and a
 * friend's mark must not claim that vocabulary. The fields are not on the wire
 * either (`log.ts`), so there is nothing to ignore — which is the point.
 */
export interface ForeignAnnotation {
  readonly pub: string
  readonly person: string
  /** The person's own signed claim, from the roster. Never Paper's verdict. */
  readonly author: string
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
  readonly quote: string
  readonly note?: string
  /**
   * How many people marked this passage — 1 for one reader.
   *
   * ⚠️ **THE FEATURE'S CENTRAL CASE, and the painter used to collapse it.**
   * *"4 of 11 readers marked this."* `review.md`'s overlay blocker 1:
   * `addAnnotation` keys the Overlayer on the annotation's value, so several
   * readers at one CFI became one entry and the last writer won.
   */
  readonly readers: number
}

/**
 * The overlay key for a foreign annotation.
 *
 * ⚠️ **THIS IS THE FIX FOR THE COLLAPSE, and it needs a one-line fork change to
 * be reachable.** `Overlayer.add(key, range, …)` already takes a key separate
 * from the range; what does not is `view.addAnnotation`, which uses
 * `annotation.value` as both the CFI to resolve and the overlay key. The fork
 * keys on `annotation.key ?? annotation.value`, and this is what Paper passes —
 * so *n* readers at one passage are *n* entries, each independently drawable,
 * hit-testable and erasable.
 *
 * Person AND publication, because one reader may share one passage twice — two
 * publications, and an `unshare` names exactly one of them.
 */
export function overlayKey(annotation: Pick<ForeignAnnotation, 'person' | 'pub'>): string {
  return `circle:${annotation.person}:${annotation.pub}`
}

/**
 * The foreign entries that can be drawn, grouped so multiplicity is one mark.
 *
 * ⚠️ **GROUPED BY ANCHOR, and that is what makes the weight ramp possible.**
 * Four readers on one sentence is ONE underline that is heavier, not four
 * underlines stacked — `surfaces.md` §"What a foreign mark looks like" decides
 * this, and drawing them separately is both illegible and the collapse bug
 * wearing a different hat.
 *
 * `epochOf` decides whether an entry's relationship still admits it, which is
 * how a re-admitted person's old passages stay gone (WI-22.E3).
 */
export function drawable(
  entries: readonly ForeignEntry[],
  authorOf: (person: string) => string,
  admits: (person: string, epoch: number) => boolean,
): readonly ForeignAnnotation[] {
  const byAnchor = new Map<string, ForeignAnnotation>()
  for (const entry of entries) {
    if (!entry.resolved) continue
    if (!admits(entry.person, entry.epoch)) continue
    const at = `${entry.resolved.sectionIndex}#${entry.resolved.cfi}`
    const seen = byAnchor.get(at)
    if (seen) {
      /* One more reader on the same words. The FIRST entry keeps the key, so a
         redraw does not move which publication the mark is filed under. */
      byAnchor.set(at, { ...seen, readers: seen.readers + 1 })
      continue
    }
    byAnchor.set(at, {
      pub: entry.pub,
      person: entry.person,
      author: authorOf(entry.person),
      cfi: entry.resolved.cfi,
      sectionIndex: entry.resolved.sectionIndex,
      quote: entry.passage.quote,
      ...(entry.passage.note === undefined ? {} : { note: entry.passage.note }),
      readers: 1,
    })
  }
  return [...byAnchor.values()]
}

/**
 * How heavily a foreign mark is drawn, from how many readers marked it.
 *
 * ⚠️ **WEIGHT CARRIES MULTIPLICITY BECAUSE COLOUR CANNOT.** `MarkTint` is the
 * reader's own vocabulary and a foreign mark must not claim it, so there is one
 * neutral hue for all of them — which leaves weight as the only channel, and
 * makes *"4 of 11 readers marked this"* legible without a click. WI-22.D2's
 * falsifier is *"screenshot a page with one of your marks and one friend's in
 * the same tint. If you cannot tell them apart without clicking, this is not
 * done"*; the tints cannot be the same, because a foreign mark has none.
 *
 * Ramps and then flattens: the difference between one reader and three is worth
 * showing, and between eleven and twelve is not.
 */
export const FOREIGN_WEIGHTS = [1, 1.5, 2, 2.5, 3] as const

export function foreignWeight(readers: number): number {
  const step = Math.min(Math.max(Math.floor(readers), 1), FOREIGN_WEIGHTS.length)
  return FOREIGN_WEIGHTS[step - 1]!
}

/**
 * Whether a publisher can be published TO — WI-22.D3's state.
 *
 * ⚠️ **A LIVE ANSWER, NEVER A STORED RECORD.** `surfaces.md` names two states a
 * stored pairing gets wrong: a phone the shelf has forgotten still holds its
 * shelf record (`forget_peer` removes on one side only), and a phone demoted to
 * `READ_ONLY_GRANTS` can mark locally and never deliver.
 *
 * ⚠️ **AND THE PROBE IS THE PUBLICATION, NOT THE SOCKET.** `review.md`: *"An
 * older shelf can accept `sync:push` while having no circle store at all."*
 * With a client-minted `pub` the mutation is idempotent, so probing with the
 * real thing is safe — publishing the same `pub` twice is one publication.
 */
export type Publishability = 'usable' | 'pending' | 'read-only' | 'revoked' | 'unreachable'

/** Whether Share is offered. Absent, never disabled — see `surfaces.md`. */
export function offersShare(state: Publishability): boolean {
  return state === 'usable' || state === 'pending'
}

/**
 * Whether Unshare is offered.
 *
 * ⚠️ **OFFERED WHILE PENDING, and that is the fix for a real trap.**
 * `review.md`: *"`pending → failed` cannot distinguish 'persisted,
 * unacknowledged' from 'never persisted'"*. A pending publication may have
 * landed — so a reader must never be unable to withdraw something that may be
 * out. Offering a withdrawal for something that was never published costs one
 * no-op; withholding it costs the reader control of their own words.
 */
export function offersUnshare(state: Publishability, published: boolean): boolean {
  return published || state === 'pending'
}

/** Why Share is absent, for the copy that must accompany its absence. */
export function shareAbsentBecause(state: Publishability): string | null {
  switch (state) {
    case 'usable':
    case 'pending':
      return null
    case 'read-only':
      return 'This device can read your shelf but not write to it.'
    case 'revoked':
      return 'Your shelf no longer recognises this device.'
    case 'unreachable':
      return 'Your shelf has not answered.'
  }
}
