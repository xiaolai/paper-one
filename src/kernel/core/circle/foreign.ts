import type { Hlc } from '../hlc'
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
  readonly person: string
  readonly cfi: ResolvedCfi
  readonly sectionIndex: number
  readonly quote: string
  /**
   * Every publication anchored here, in arrival order. NEVER EMPTY, and the
   * first one owns the overlay key and the treatment.
   *
   * ⚠️ **THIS WAS ONE `pub`, ONE `author` AND ONE `note`, AND GROUPING THREW
   * THE REST AWAY.** Marks are grouped by anchor because four readers on one
   * sentence must be one heavier underline rather than four stacked ones —
   * but the grouping kept only the FIRST row's words, so a second reader's
   * note at the same passage was parsed, verified, anchored and then silently
   * dropped. The weight and the words are different questions: group the
   * first, keep all of the second. Found by audit, in both this function and
   * the public overlay that copied its shape.
   */
  readonly opinions: readonly ForeignOpinion[]
  /**
   * The distinct PEOPLE behind those publications, so the weight can be
   * reconciled ACROSS contributions rather than within one.
   *
   * ⚠️ **A COUNT CANNOT BE RECONCILED; A SET CAN.** This used to be
   * `readers: number`, and the overlay host merely flattened every
   * contribution — so one person who marked a passage in the circle AND
   * published a bound voice at it arrived as two annotations claiming one
   * reader each, and was drawn as two people. Identities survive to the host,
   * which unions them and only then takes a count.
   *
   * ⚠️ **EMPTY IS A LEGITIMATE ANSWER AND IS NOT ZERO READERS.** A public
   * annotation from a voice nobody has bound is somebody, and is nobody
   * IDENTIFIABLE: it draws at the floor of one and adds nothing to a count,
   * which is what stops free keys manufacturing readers.
   */
  readonly people: readonly string[]
}

/** Which layer an annotation reached the reader through. */
export type OverlayAudience = 'circle' | 'public'

/**
 * One publication's own words at a passage.
 *
 * ⚠️ **`audience` IS A FIELD BECAUSE IT WAS AN ENCODING.** The public layer
 * used to say "stranger" by prefixing the person id with `public:` — a value
 * no 64-hex person id can collide with, which made the two safe to key apart
 * and told the PAINTER nothing at all: `attachForeign` labelled every one of
 * them with the circle's painter kind, so a stranger's mark was drawn exactly
 * as a friend's. Provenance the reader is meant to see cannot live in a string
 * prefix that only the producer reads. Found by audit.
 */
export interface ForeignOpinion {
  readonly pub: string
  readonly audience: OverlayAudience
  /** The publisher's own claim, from the roster. Never Paper's verdict. */
  readonly author: string
  readonly note?: string
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
export function overlayKey(annotation: Pick<ForeignAnnotation, 'person' | 'opinions'>): string {
  const first = annotation.opinions[0]
  if (first === undefined) throw new Error('circle: an annotation with no publication cannot be keyed')
  return overlayKeyOf(first.audience, annotation.person, first.pub)
}

/**
 * The same key, composed before an annotation exists — the resolver asks for
 * one passage per PUBLICATION, and grouping happens after it answers.
 *
 * ⚠️ **THE AUDIENCE IS THE FIRST SEGMENT, AND IT IS WHAT KEEPS THE TWO LAYERS
 * APART.** This used to be the literal `circle:` here and a second literal
 * `public:` in the public capability's own `publicOverlayKey` — two
 * definitions of one namespace, either of which could have moved without the
 * other. The segment is not decoration: a voice id and a person id are both 64
 * hex, so without it a stranger and a friend sharing a publication id key onto
 * one another's marks. Found by audit.
 */
export function overlayKeyOf(audience: OverlayAudience, person: string, pub: string): string {
  return `${audience}:${person}:${pub}`
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
/**
 * How many readers a set of identities is worth, with the floor that says a
 * mark on the page had somebody behind it.
 *
 * ⚠️ **NOBODY IDENTIFIABLE IS ONE, NEVER ZERO.** A public annotation from an
 * unbound voice names no person, and a zero would ramp the weight below the
 * lightest rule and draw nothing where a stranger had marked something. One is
 * also the CEILING for that case, which is the property `PUBLIC_WEIGHT` is
 * about: a thousand free keys are still one.
 */
export function readersAmong(people: readonly string[]): number {
  return Math.max(1, people.length)
}

export const FOREIGN_WEIGHTS = [1, 1.5, 2, 2.5, 3] as const

export function foreignWeight(readers: number): number {
  /* A count that is not a number is one reader's worth: NaN through the
     clamp below is NaN, and NaN indexes nothing. */
  const counted = Number.isFinite(readers) ? Math.floor(readers) : 1
  const step = Math.min(Math.max(counted, 1), FOREIGN_WEIGHTS.length)
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
