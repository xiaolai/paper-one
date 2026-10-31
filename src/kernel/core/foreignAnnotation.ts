import type { ResolvedCfi } from './resolvedCfi'

/**
 * What the reader's painter is handed for somebody else's annotation: its shape,
 * its overlay key and its weight. The kernel draws these whichever capability
 * supplied them, and `public` and `circle` do not depend on each other, so the
 * vocabulary they share is the kernel's.
 */

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
  /* A count that is not a number is one reader's worth: NaN through the
     clamp below is NaN, and NaN indexes nothing. */
  const counted = Number.isFinite(readers) ? Math.floor(readers) : 1
  const step = Math.min(Math.max(counted, 1), FOREIGN_WEIGHTS.length)
  return FOREIGN_WEIGHTS[step - 1]!
}
