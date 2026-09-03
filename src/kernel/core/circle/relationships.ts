import { laterHlc, type Hlc } from '../hlc'
import { BLOCKED_BUDGET, DEFAULT_BUDGET, type Budget } from './bound'

/**
 * Relationships: exit, blocking, inbound safety, retained data — WI-22.E1, E2,
 * E3.
 *
 * The design is `docs/design/circle/relationships.md`, written for the review's
 * NINTH condition. Its verdict on the other eight was blunt: *"Condition 7
 * admits relationships and defines no block, mute, unpair, purge or
 * re-admission epoch … **No object in the eight conditions passes this.**"*
 *
 * ⚠️ **ADMISSION IS A NEGOTIATION; EXIT IS A DECLARATION.** Admission needs two
 * people, a SAS and a room. A block that needed the blocked person to
 * acknowledge it is not a block — it hands the decision to the one party who
 * must not have it. Everything asymmetric here follows from that.
 *
 * PURE. The record is the caller's to persist and to sync; this decides.
 */

export type RelationshipState = 'admitted' | 'muted' | 'blocked' | 'exited'

/** What happens to what they already sent. */
export type Retain = 'keep' | 'purge'

export interface Relationship {
  /**
   * ⚠️ **THE PERSON, NOT A DEVICE — which is what satisfies "every current and
   * future A leaf".** A device-level block is a list you extend every time the
   * blocked reader buys a phone, and the phone works in the gap. Blocking the
   * person refuses a new leaf presenting a perfectly valid delegation, which is
   * only expressible because `identity.md` now has a person key to name.
   */
  readonly person: string
  readonly state: RelationshipState
  /** Bumped on every re-admission. See `readmit`. */
  readonly epoch: number
  readonly admittedAt: Hlc
  /** LWW register, exactly as `tagClock` is. */
  readonly changedAt: Hlc
  readonly retain: Retain
}

/**
 * Which of two copies of one relationship wins.
 *
 * ⚠️ **LWW ON `changedAt`, so blocking on the phone reaches the sleeping
 * laptop.** `tagClock` in `bookFolder.ts` is the precedent and the reasoning is
 * identical: a clock is what lets two of your own devices disagree and then
 * agree. `review.md` requires the block survive *"restart and device sync"*.
 *
 * A true tie keeps the MORE RESTRICTIVE state rather than the first seen —
 * because the two orderings must converge, and of the two answers only one is
 * safe to be wrong about.
 */
export function mergeRelationship(a: Relationship, b: Relationship): Relationship {
  if (a.changedAt !== b.changedAt) return laterHlc(a.changedAt, b.changedAt) === a.changedAt ? a : b
  return RESTRICTION[a.state] >= RESTRICTION[b.state] ? a : b
}

/** How restrictive each state is, for the tie above. */
const RESTRICTION: Readonly<Record<RelationshipState, number>> = {
  admitted: 0,
  muted: 1,
  exited: 2,
  blocked: 3,
}

/** Whether their leaves may connect at all. */
export function acceptsTransport(state: RelationshipState): boolean {
  return state === 'admitted' || state === 'muted'
}

/** Whether their passages are drawn. */
export function drawsOverlays(state: RelationshipState): boolean {
  return state === 'admitted'
}

/**
 * The budget a person's frames are charged against.
 *
 * ⚠️ **ZERO AND PERSISTED WHEN BLOCKED, which is `review.md`'s *"reconnection
 * not resetting A's quota"*.** Expressing it as a budget rather than as a
 * branch at each call site means every path that charges is covered, including
 * paths written later — a branch has to be remembered, a budget does not.
 */
export function budgetFor(state: RelationshipState): Budget {
  return acceptsTransport(state) ? DEFAULT_BUDGET : BLOCKED_BUDGET
}

/**
 * Whether a foreign entry should be drawn, given the relationship it arrived
 * under.
 *
 * ⚠️ **THE EPOCH IS WHAT STOPS RE-ADMISSION REVIVING OLD CONTENT.**
 * `review.md`: *"re-admission creating a new epoch that cannot revive old
 * grants or hidden content."* A reader you blocked and later re-admitted does
 * not get their old passages back — those belong to a relationship that ended.
 *
 * ⚠️ **NOT the same epoch as `identity.md`'s.** That one is the PUBLISHER's,
 * bumped by a succession, describing which root is current. This is the
 * RECIPIENT's, bumped by re-admission, describing which relationship a piece of
 * data belongs to. Two different subjects; a shared name would be a bug waiting
 * in a merge.
 */
export function drawsEntry(relationship: Relationship, entryEpoch: number): boolean {
  return drawsOverlays(relationship.state) && entryEpoch === relationship.epoch
}

/**
 * Re-admit somebody, in a NEW epoch.
 *
 * ⚠️ **A FULL PAIRING, SAS AND ALL — not a toggle.** Restoring a relationship
 * you ended is a decision with the same weight as making it, and the ceremony
 * is what makes the epoch bump honest rather than incidental. This function
 * exists to make the bump unforgettable, not to make it easy.
 */
export function readmit(previous: Relationship, at: Hlc): Relationship {
  return {
    person: previous.person,
    state: 'admitted',
    epoch: previous.epoch + 1,
    admittedAt: at,
    changedAt: at,
    retain: 'keep',
  }
}

/** The default `retain` for a state — see `relationships.md`. */
export function defaultRetain(state: RelationshipState): Retain {
  /* Purge for blocked and exited, keep for muted: a reader who blocks somebody
     is usually saying they do not want their words on the page, and a reader
     who mutes is saying not right now. */
  return state === 'blocked' || state === 'exited' ? 'purge' : 'keep'
}

export function changeState(
  previous: Relationship,
  state: RelationshipState,
  at: Hlc,
  retain: Retain = defaultRetain(state),
): Relationship {
  return { ...previous, state, changedAt: at, retain }
}

/**
 * What an unknown endpoint is told on the introduction ALPN.
 *
 * ⚠️ **"BLOCKED" AND "NEVER PAIRED" ARE THE SAME ANSWER, and that is a
 * requirement rather than a simplification.** Distinguishing them turns the
 * introduction path into a way to ask whether somebody blocked you.
 */
export type Admission = 'admit' | 'refuse'

export function admits(relationship: Relationship | null): Admission {
  return relationship && acceptsTransport(relationship.state) ? 'admit' : 'refuse'
}
