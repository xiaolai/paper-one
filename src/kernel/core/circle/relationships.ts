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
  /**
   * Whether this person is shown the reader's SHELF — WI-23.C2.
   *
   * ⚠️ **PER PERSON, OFF BY DEFAULT, SEPARATE FROM PASSAGE SHARING.** The
   * three disclosures are nested — a marked sentence, then a book you own,
   * then your library — and a reader who agreed to the first has not agreed
   * to the third. Per person and not per circle, because there is no circle
   * object, only pairings; not per book, because a shelf with holes says
   * which books you are hiding. Converges by `changedAt` with the rest of the
   * record, so turning it on from the phone reaches the laptop.
   */
  readonly shelf: boolean
  /**
   * When the shelf switch was last moved — its OWN register, WI-23.C2.
   *
   * ⚠️ **THE SWITCH MUST NOT CARRY THE STATE WITH IT.** With one stamp for
   * the whole record, a shelf toggle made on a stale admitted copy stamped
   * later than a block made elsewhere would win the merge whole — and
   * re-admit the person along with showing them the shelf. The state and the
   * switch merge apart, each by its own stamp. Absent on a record written
   * before this existed, which reads as `changedAt`.
   */
  readonly shelfAt?: Hlc
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
  /* The STATE half — state, epoch, retain, admittedAt. THE NEWER EPOCH WINS
     OUTRIGHT: an epoch is a re-admission, and a record of an older one is
     stale whatever its stamp says — a replica that never heard of the
     re-admission cannot outvote it by having a clock that runs ahead. Within
     one epoch, by `changedAt`; at a true tie the more restrictive state,
     then purge over keep, then the earlier admission: an order three
     replicas reach whichever two they merge first. */
  // Stryker disable next-line EqualityOperator: reached only when the epochs differ, so `>` and `>=` choose alike.
  const state = a.epoch !== b.epoch ? (a.epoch > b.epoch ? a : b) : a.changedAt !== b.changedAt ? (laterHlc(a.changedAt, b.changedAt) === a.changedAt ? a : b) : restrictiveOf(a, b)
  const shelf = shelfWinner(a, b, state)
  return { ...state, shelf: shelf.shelf, shelfAt: shelfAtOf(shelf) }
}

/** The switch's own stamp — `changedAt` on a record written before it had one. */
const shelfAtOf = (one: Relationship): Hlc => one.shelfAt ?? one.changedAt

/**
 * Which record's SHELF switch stands — the security-sensitive half of the
 * merge, named so each branch can be read on its own.
 *
 * ⚠️ **ONLY WITHIN THE WINNING EPOCH.** A grant belongs to the relationship
 * it was made in: a stale replica that turned the shelf on under epoch 1,
 * stamped after a re-admission it had not yet heard of, must not carry that
 * grant into epoch 2 — `readmit` turned it off for exactly this reason. When
 * the epochs differ, the winning record's own shelf stands, whatever the
 * other's stamp says. Within one epoch the later stamp wins; at a true tie,
 * OFF — the answer that is safe to be wrong about.
 */
function shelfWinner(a: Relationship, b: Relationship, state: Relationship): Relationship {
  if (a.epoch !== b.epoch) return state
  const stampA = shelfAtOf(a)
  const stampB = shelfAtOf(b)
  if (stampA !== stampB) return laterHlc(stampA, stampB) === stampA ? a : b
  // Stryker disable next-line ConditionalExpression: with the switches alike either record answers the same switch and the same stamp.
  if (a.shelf === b.shelf) return a
  return a.shelf ? b : a
}

/** Of two records stamped alike, the one that gives away less. */
function restrictiveOf(a: Relationship, b: Relationship): Relationship {
  // Stryker disable next-line EqualityOperator: reached only when the two differ, so `>` and `>=` choose alike.
  if (RESTRICTION[a.state] !== RESTRICTION[b.state]) return RESTRICTION[a.state] > RESTRICTION[b.state] ? a : b
  if (a.retain !== b.retain) return a.retain === 'purge' ? a : b
  /* Alike in every deciding field: the earlier admission stands, so two
     replicas holding the same two records agree whichever they read first. */
  // Stryker disable next-line ConditionalExpression: with the admissions alike the two records are alike in every deciding field, so either answers the same.
  return laterHlc(a.admittedAt, b.admittedAt) === a.admittedAt && a.admittedAt !== b.admittedAt ? b : a
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
    /* A new epoch cannot revive old grants, and showing a shelf is one. */
    shelf: false,
    shelfAt: at,
  }
}

/** The epoch a relationship starts in — and the one a record kept before epochs were stamped belongs to. */
export const FIRST_EPOCH = 1

/**
 * A relationship as it starts: admitted, first epoch, keeping what arrives,
 * showing NO shelf. The default a person has before the reader decides
 * anything about them — which is also what a record read from nothing is.
 */
export function newRelationship(person: string, at: Hlc): Relationship {
  return { person, state: 'admitted', epoch: FIRST_EPOCH, admittedAt: at, changedAt: at, retain: 'keep', shelf: false, shelfAt: at }
}

/** Turn the shelf on or off for one person, under the switch's own stamp — the state's is left alone. */
export function showShelf(previous: Relationship, shelf: boolean, at: Hlc): Relationship {
  return { ...previous, shelf, shelfAt: at }
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
  /* ⚠️ **AN ENDED RELATIONSHIP DOES NOT COME BACK BY A STATE CHANGE.** Blocked
     or exited to admitted, in the same epoch, would revive every entry the
     old epoch retained — which is exactly what `readmit`'s new epoch exists
     to prevent. Muted to admitted is a state change; the other two are a
     re-admission, and only `readmit` makes one — and so is blocked or
     exited to MUTED, which accepts transport again: the two words that
     let their leaves connect are reached from an ended relationship only
     through the ceremony. */
  if (acceptsTransport(state) && !acceptsTransport(previous.state)) {
    throw new Error(`a ${previous.state} relationship is re-admitted through readmit, not changeState`)
  }
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
