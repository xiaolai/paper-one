import type { PublicPassage } from './envelope'

/**
 * Publishing to the circle and publishing to strangers are two acts — WI-26.4.
 *
 * ⚠️ **NEVER A MIRROR, AND NEVER A SWITCH THAT FORWARDS CIRCLE ACTIVITY.** The
 * same passage sent to both audiences carries identical quote, prefix and
 * suffix — that is what a passage IS — so anybody who is in the reader's circle
 * AND reading the public annotations can match the two and learn which
 * pseudonym is which person. A "share to both" control makes that the default
 * rather than a choice.
 *
 * ⚠️ **AND "NO CODE PATH CAUSES IT" IS NOT THE PROPERTY.** WI-26.4's acceptance
 * says so outright: disabling public publishing entirely would pass that test.
 * What has to hold is that each audience is reached by its own explicit act,
 * that an act changes ONE audience, and that the disclosure was shown before
 * the public one.
 *
 * ⚠️ **THAT SENTENCE USED TO END "which is what `publicAct` makes checkable",
 * AND THERE IS NO `publicAct` ANYWHERE.** The boundary that actually enforces
 * it is `publishPort.publish`, which asks {@link mayPublish} before it mints
 * and refuses without an acknowledgement — and `PublishControl`, which cannot
 * publish before the reader has answered the disclosure step. Naming a symbol
 * that does not exist sends a reader looking for the enforcement in a file
 * that is not there. Found by audit.
 *
 * PURE. No storage, no transport, no clock.
 */

/** Who a passage is being published to. */
export type Audience = 'circle' | 'public'

/**
 * What a reader is told before their first public publication of a passage.
 *
 * ⚠️ **IT NAMES THE CONSEQUENCE, NOT THE MECHANISM.** "Signed under a separate
 * key" is true and useless; what a reader needs to know is that this goes to
 * people they have not chosen, that it cannot be recalled from anyone who has
 * already read it, and — when the passage is also in their circle — that the
 * two can be matched.
 */
export const PUBLIC_DISCLOSURE =
  'This goes to anyone, not to your circle. You can take it back from this device, but not from anyone who has already read it.'

/**
 * The extra sentence when this passage is ALSO in the reader's circle.
 *
 * ⚠️ **THE LINKAGE IS THE PASSAGE, NOT THE KEY.** A separate signing key hides
 * nothing here: quote, prefix and suffix are identical by construction, so a
 * reader in both audiences matches them without doing any work at all. Saying
 * so is the only honest thing available, because there is no version of this
 * that publishes the same words twice and stays unlinkable.
 */
export const PUBLIC_LINKS_DISCLOSURE =
  'You have already shared these exact words with your circle. Anyone in both places can tell that the same person wrote both.'

/**
 * One publication a reader is about to make.
 *
 * ⚠️ **NO `passage`, AND IT USED TO BE REQUIRED AND NEVER READ.** `mayPublish`
 * asks two questions — which audience, and did the reader answer the
 * disclosure — and neither depends on the words. A required field nothing
 * consults implies a per-passage check that does not happen, and made every
 * caller carry a passage to a function with no use for one. What IS
 * passage-specific is `linksVoiceToPerson`, which takes the passage directly.
 * Found by audit.
 */
export interface PublishRequest {
  readonly audience: Audience
  /**
   * Whether the reader saw and accepted the disclosure for THIS act.
   *
   * ⚠️ **PER ACT, NOT PER SESSION AND NOT PER READER.** A flag that survives
   * the first publication is a flag that makes every later one silent, which
   * is the *"switch that forwards circle activity"* by another route.
   */
  readonly acknowledged: boolean
}

/** Why a publication may not proceed. `null` when it may. */
export type PublishRefusal =
  /** The reader has not seen the disclosure for this act. */
  | 'needs-disclosure'

/**
 * Whether this act may go ahead.
 *
 * The circle is unconditional: a reader sharing with people they chose has
 * already made that decision, and a second confirmation on every passage is
 * the kind of prompt readers learn to dismiss without reading.
 */
export function mayPublish(request: PublishRequest): PublishRefusal | null {
  if (request.audience === 'circle') return null
  return request.acknowledged ? null : 'needs-disclosure'
}

/* ⚠️ **`Published`, `afterPublishing` AND `afterWithdrawing` STOOD HERE AND
   NOTHING CALLED THEM.** They modelled "which audiences is this passage in"
   as a pure transition — `afterPublishing(held, audience)` setting exactly one
   field — and the comment claimed *"this is where that is true or not"*. It
   was not: no surface and no port ever held a `Published` value, so the mirror
   WI-26.4 forbids could have been written in `publishPort` without these ever
   being consulted. A one-line transition function is not where an invariant
   lives; the invariant lives at the two ports that each reach ONE audience,
   and `publishPort.test.ts` asserts that each act changes its own and not the
   other. The name `Published` now belongs to `publishPort`'s receipt, which is
   a thing callers do hold. Found by audit. */

/**
 * The disclosure to show before a public act, given what the circle already
 * holds. `null` for a circle act, which needs none.
 */
export function disclosureFor(audience: Audience, alreadyInCircle: boolean): string | null {
  if (audience === 'circle') return null
  return alreadyInCircle ? `${PUBLIC_DISCLOSURE} ${PUBLIC_LINKS_DISCLOSURE}` : PUBLIC_DISCLOSURE
}

/**
 * Whether publishing this passage publicly would link the reader's voice to
 * their person for anybody in both audiences.
 *
 * The comparison is over the three fields that travel, and nothing else: a
 * chapter label differs between builds and a note may have been withheld from
 * one audience, but quote, prefix and suffix are what `markContext` captured
 * and are identical wherever they are sent.
 */
export function linksVoiceToPerson(passage: PublicPassage, sharedWithCircle: readonly PublicPassage[]): boolean {
  return sharedWithCircle.some(
    (one) => one.quote === passage.quote && one.prefix === passage.prefix && one.suffix === passage.suffix,
  )
}
