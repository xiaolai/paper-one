import type { ForeignAnnotation, ForeignOpinion } from '../../../kernel'
import type { Hlc } from '../../../kernel'
import type { ResolvedCfi } from '../../../kernel'
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
  /** Which relationship epoch this arrived under — see `relationshipState.ts`. */
  readonly epoch: number
  readonly receivedAt: number
  /**
   * The publication's own stamp — `(device, seq, at)` — kept so a duplicate
   * `pub` from another of the person's devices folds by `fold`'s rule (the
   * EARLIER stands) rather than by which page arrived first. Absent on rows
   * written before it was kept; such a row stands against any duplicate.
   */
  readonly at?: Hlc
  readonly device?: string
  readonly seq?: number
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
  const byAnchor = new Map<string, { at: ForeignAnnotation; people: Set<string>; opinions: ForeignOpinion[] }>()
  for (const entry of entries) {
    if (!entry.resolved) continue
    if (!admits(entry.person, entry.epoch)) continue
    const at = `${entry.resolved.sectionIndex}#${entry.resolved.cfi}`
    const opinion: ForeignOpinion = {
      pub: entry.pub,
      audience: 'circle',
      author: authorOf(entry.person),
      ...(entry.passage.note === undefined ? {} : { note: entry.passage.note }),
    }
    const seen = byAnchor.get(at)
    if (seen) {
      /* ⚠️ **THE WORDS ARE KEPT EVEN WHEN THE READER IS NOT NEW.** One person
         who shared the same passage twice is one reader — the weight says how
         many PEOPLE, not how many rows — and they are still two notes. The
         count and the notes were one decision here, and dropping the row
         dropped both. */
      seen.opinions.push(opinion)
      seen.people.add(entry.person)
      continue
    }
    /* The FIRST entry keeps the key, so a redraw does not move which
       publication the mark is filed under. */
    byAnchor.set(at, {
      people: new Set([entry.person]),
      opinions: [opinion],
      at: {
        person: entry.person,
        cfi: entry.resolved.cfi,
        sectionIndex: entry.resolved.sectionIndex,
        quote: entry.passage.quote,
        opinions: [],
        people: [],
      },
    })
  }
  return [...byAnchor.values()].map(({ at, people, opinions }) => ({
    ...at,
    opinions,
    people: [...people],
  }))
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
export type Publishability =
  | 'usable'
  | 'pending'
  | 'read-only'
  | 'revoked'
  | 'unreachable'
  /**
   * This device has no person identity, so there is nobody to publish AS.
   *
   * ⚠️ **THE DESKTOP'S OWN STATE, which the five above cannot name.** They
   * describe a satchel reaching a shelf. On the shelf itself the publication
   * is local — `shared.json` is written here and served from here — so the
   * only thing that can be missing is the identity a page is signed under.
   * A reader who never started a circle is in the ORDINARY state, and the
   * reason Share is absent has to say so rather than blame a shelf that is
   * this very machine.
   */
  | 'no-identity'

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
    case 'no-identity':
      return 'Start a circle to share a passage.'
  }
}
