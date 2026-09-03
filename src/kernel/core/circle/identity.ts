import { type Hlc } from '../hlc'

/**
 * Person identity: roles, versions, delegation, revocation — WI-22.B1, B2, B3.
 *
 * The design is `docs/design/circle/identity.md`, after the review fold-in. Two
 * sentences from it govern everything here:
 *
 * > ⚠️ **A revoked device does not hold the root key** — which was FALSE as
 * > originally written, because skip-by-default put the root on the device.
 *
 * > **Exactly one device holds the root key. It is the `home` device, and the
 * > role is explicit rather than emergent.**
 *
 * So revocation is a LEAF operation, and losing the home device is a
 * **succession** rather than a revocation. That is what makes WI-22.B1's
 * falsifier — *"a device that holds no root key can mint itself a fresh
 * delegation"* — a statement about leaves, true by construction rather than by
 * custody hygiene.
 *
 * PURE. Signature checking is injected; Ed25519 is a platform binding.
 */

/** Which device this is. Only `home` holds the root. */
export type DeviceRole = 'home' | 'leaf'

/**
 * Every signed object's version.
 *
 * ⚠️ **`(epoch, hlc)`, NEVER A COUNTER — and the counter was two blockers.**
 *
 *  - A restored identity cannot resume a counter it does not know
 *    (`review.md` I-4: *"Bob caches Alice at version 42 … A restarted counter
 *    is refused as backwards"*). It opens a NEW EPOCH instead, which dominates
 *    everything signed before it.
 *  - Two root copies could each mint "version 8" (I-5). An HLC is monotonic per
 *    node and tie-broken by node id, so two objects signed by two devices can
 *    never compare equal.
 *
 * `Hlc` is `core/hlc.ts` — already in this tree, already what marks are ordered
 * by. Reusing it costs nothing and brings a total order with it.
 */
export interface Version {
  readonly epoch: number
  readonly at: Hlc
}

/** Lexicographic on `(epoch, hlc)`. Total, except for the tie below. */
export function compareVersions(a: Version, b: Version): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  if (a.at === b.at) return 0
  return a.at < b.at ? -1 : 1
}

/**
 * Which of two signed objects to keep, or null when they cannot be told apart.
 *
 * ⚠️ **A TIE REFUSES BOTH RATHER THAN PREFERRING ONE.** Equal `(epoch, hlc)`
 * with different content means the HLC did not advance — a clock bug, or a
 * restored process — and it is not resolvable by preference. `identity.md`:
 * *"Silently picking one is how a roster the reader never authorised becomes
 * the roster."* The caller keeps what it had and surfaces the conflict.
 */
export function preferVersion<T extends { readonly version: Version }>(
  held: T | null,
  incoming: T,
  same: (a: T, b: T) => boolean,
): T | null {
  if (!held) return incoming
  const order = compareVersions(incoming.version, held.version)
  if (order > 0) return incoming
  if (order < 0) return held
  return same(held, incoming) ? held : null
}

/* ------------------------------------------------------------ time semantics */

/**
 * How much clock skew a `notBefore` is forgiven — five minutes.
 *
 * ⚠️ **ASYMMETRIC, AND DELIBERATELY.** A device whose clock is slightly fast
 * should not have its first hour refused. `notAfter` gets NO tolerance, because
 * it is the backstop the whole revocation design leans on and a tolerance there
 * is an extension granted to exactly the device you are trying to stop.
 */
export const SKEW_MS = 5 * 60 * 1000

/** 90 days, in the units the design now states: integer milliseconds, UTC. */
export const DELEGATION_MS = 90 * 24 * 60 * 60 * 1000

/**
 * When a delegation should be renewed — two thirds of its life.
 *
 * ⚠️ **THIS IS WHAT MAKES FAILING CLOSED AFFORDABLE.** `identity.md` declares
 * that a page signed just before expiry and delivered just after is refused,
 * because it cannot be told from one backdated after expiry. Renewing at ⅔
 * means the window in which a live publisher's pages are near expiry is the
 * failing case rather than the normal one — and the log is append-only and
 * re-fetchable, so a refused page is fetched again after renewal rather than
 * lost.
 */
export const RENEW_AT = 2 / 3

/** Signed by the root. The device holds only this and its own key. */
export interface Delegation {
  readonly v: number
  readonly person: string
  readonly device: string
  readonly role: DeviceRole
  /** Integer milliseconds since the Unix epoch, UTC. */
  readonly notBefore: number
  readonly notAfter: number
  readonly epoch: number
  readonly sig: string
}

export type DelegationRefusal = 'not-yet' | 'expired' | 'wrong-person' | 'wrong-device' | 'stale-epoch'

/**
 * Whether a delegation is live for this device, at this moment, in this epoch.
 *
 * ⚠️ **THE RECEIVER'S CLOCK, at receipt.** There is no trusted time source in
 * this system and none is invented. A page's own `at` is descriptive and never
 * load-bearing for validity — which is exactly what makes a backdated `at`
 * useless to an attacker, and it is why `review.md`'s P (signed at T89,
 * delivered after T90) is refused along with Q (signed after T90 claiming
 * T89). The two are indistinguishable without a trusted clock, and any design
 * that accepts P accepts Q.
 */
export function checkDelegation(
  delegation: Delegation,
  person: string,
  device: string,
  epoch: number,
  now: number,
): DelegationRefusal | null {
  if (delegation.person !== person) return 'wrong-person'
  if (delegation.device !== device) return 'wrong-device'
  if (delegation.epoch < epoch) return 'stale-epoch'
  if (now + SKEW_MS < delegation.notBefore) return 'not-yet'
  /* NO TOLERANCE HERE. See `SKEW_MS`. */
  if (now >= delegation.notAfter) return 'expired'
  return null
}

/** Whether a delegation is far enough through its life to renew. */
export function shouldRenew(delegation: Delegation, now: number): boolean {
  const life = delegation.notAfter - delegation.notBefore
  return life > 0 && now - delegation.notBefore >= life * RENEW_AT
}

/* ------------------------------------------------------------- revocation */

/** One revoked device, and whether its history goes with it. */
export interface Revoked {
  readonly device: string
  /**
   * Ask recipients to drop this device's entries.
   *
   * ⚠️ **A REQUEST, NOT A GUARANTEE, and the copy must say so.** `review.md`
   * puts forced deletion from a hostile peer out of scope; the same honesty the
   * design already applies to `unshare` applies here.
   */
  readonly purge: boolean
}

export interface RevocationList {
  readonly v: number
  readonly person: string
  readonly version: Version
  readonly revoked: readonly Revoked[]
  readonly sig: string
}

/**
 * The roster — a person's live devices, and the name they claim.
 *
 * ⚠️ **DEVICE IDS ONLY WHEN IT TRAVELS ON A PAGE.** `review.md`: the roster
 * *"carries every device's address hints and join time"*. Hints are how your
 * own devices find each other and have no business in a friend's copy; join
 * times are a timeline of your hardware purchases. `hints` is therefore
 * optional and stripped by `strippedRoster` before a page carries it.
 *
 * ⚠️ **`displayName` IS SIGNED, which it was not.** *"`ForeignAnnotation`
 * requires an author name and no signed page, roster or delegation contains
 * one. Check: change the displayed name without changing any signature — all
 * defined verification still passes."* Now it is the person's own signed claim.
 * A signed name is still not a VERIFIED name — the SAS is what binds a key to a
 * human — so the UI shows it, permits a recipient-local alias, and never
 * presents either as an identity Paper has checked.
 */
export interface Roster {
  readonly v: number
  readonly person: string
  readonly version: Version
  readonly displayName: string
  readonly home: string
  readonly devices: readonly { readonly device: string; readonly hints?: readonly string[] }[]
  readonly sig: string
}

/** The roster as a page may carry it — no hints, no join times. */
export function strippedRoster(roster: Roster): Roster {
  return { ...roster, devices: roster.devices.map(({ device }) => ({ device })) }
}

/**
 * Whether a device may speak for a person right now.
 *
 * The whole of WI-22.B1 and B2 in one function: the delegation must be live and
 * for this device, the device must be on the roster, and it must not be
 * revoked.
 *
 * ⚠️ **EXPIRY IS CHECKED EVEN WHEN NO REVOCATION LIST IS HELD.** *"Expiry is
 * the real revocation, and push is the optimisation. You cannot push a
 * revocation to a peer who never connects again."* A peer that has never heard
 * of a revocation still stops accepting the device within 90 days, and that is
 * the guarantee — push only shrinks the window.
 */
export function maySpeak(
  delegation: Delegation,
  roster: Roster,
  revocations: RevocationList | null,
  now: number,
): DelegationRefusal | 'revoked' | 'not-on-roster' | null {
  const refusal = checkDelegation(delegation, roster.person, delegation.device, roster.version.epoch, now)
  if (refusal) return refusal
  if (!roster.devices.some((one) => one.device === delegation.device)) return 'not-on-roster'
  if (revocations?.revoked.some((one) => one.device === delegation.device)) return 'revoked'
  return null
}

/**
 * Whether this device could mint a delegation — the falsifier for WI-22.B1.
 *
 * ⚠️ **A LEAF CANNOT, AND THAT IS THE WHOLE DESIGN.** The item's falsifier is
 * *"a device that holds no root key can mint itself a fresh delegation. If it
 * can, the root/leaf split has moved the problem rather than solved it."*
 *
 * Expressed as a function so it is testable rather than architectural: minting
 * requires the root, the root is on `home` alone, and `home` is not revocable.
 * The UI must not offer "revoke" for a home device — `revocableRoles` is what
 * says so in one place.
 */
export function canMintDelegation(role: DeviceRole, holdsRoot: boolean): boolean {
  return role === 'home' && holdsRoot
}

/** Which roles a reader may revoke. Home is succeeded, never revoked. */
export const REVOCABLE_ROLES: readonly DeviceRole[] = ['leaf']

export function isRevocable(role: DeviceRole): boolean {
  return REVOCABLE_ROLES.includes(role)
}

/**
 * A succession: the root naming a new home device, in a new epoch.
 *
 * ⚠️ **THIS IS WHAT "LOSING THE HOME DEVICE" IS, and it is not a revocation.**
 * It requires the recovery phrase, which is the one ceremony the phrase exists
 * for. The epoch bump is what makes a restored identity dominate without
 * knowing the old counter (`review.md` I-4).
 *
 * ⚠️ It settles ORDERLY REPLACEMENT and not contested control. Two holders of
 * one root can each bump the epoch and peers converge on whichever chain they
 * see — a fork, not a recovery. `identity.md` declares root compromise
 * unrecoverable and prices the remedy at a new identity and an afternoon of
 * re-pairing; social recovery is explicitly rejected.
 */
export interface Succession {
  readonly v: number
  readonly person: string
  readonly epoch: number
  readonly home: string
  readonly at: number
  readonly sig: string
}

/** Whether a succession supersedes what is held. Strictly forward. */
export function supersedes(succession: Succession, heldEpoch: number): boolean {
  return succession.epoch > heldEpoch
}
