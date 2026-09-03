import { canonicalJson } from '../canonicalJson'
import type { Entry } from './log'
import type { WorkClaim } from './workClaim'

/**
 * Pages: what one frame carries, and what is signed — WI-22.C1, C4 and the
 * review's signature blocker.
 *
 * ## Every page verifies alone
 *
 * ⚠️ A recipient may receive page 7 before page 3, may keep 7 and lose 3, and
 * must be able to say *"this is Alice's"* about the page in its hand. So each
 * carries its own signature **and** the delegation and revocation version
 * needed to check it. That costs bytes on every page and buys the ability to
 * verify anything at all out of order.
 *
 * ## The version is first, and it is negotiated
 *
 * ⚠️ **`SYNC_VERSION`'s history is the precedent and it is worse here.** An
 * unbumped peer stripped an unknown field, ACKed the stripped row, and the
 * equal-stamp ACK erased the sender's data. On an append-only log the log IS
 * the record, so the same shape is not a lost field but a lost history.
 * Bumping the outer envelope is not negotiation — it refuses before service
 * dispatch — so the version rides on the page and the hello exchanges a range.
 *
 * ## Verification is by re-serialisation, which is the whole trick
 *
 * ⚠️ `JSON.parse` destroys duplicate-member evidence before any parser of ours
 * runs, so this does not try to detect duplicates. It re-serialises what it
 * parsed and requires the bytes to match what arrived. A duplicate `"work"`
 * member, an exponent-form number, a `-0`, a different key order, an encoder
 * emitting `\\u00e9` where ours emits `é` — every one changes the bytes and
 * every one is refused by one comparison. Cross-language golden vectors then
 * test ONE property rather than six.
 *
 * PURE. Signing and hashing are injected: Ed25519 and SHA-256 are platform
 * bindings, and a module that imported one would take this whole subtree out of
 * a browser's reach (`check-browser-safe.mjs`).
 */

/** The only wire version that exists. A second one is a `v2` constant here. */
export const WIRE_VERSION = 1

/** What a peer can speak. Exchanged in the hello, before any page. */
export interface VersionRange {
  readonly min: number
  readonly max: number
}

export const SUPPORTED: VersionRange = { min: WIRE_VERSION, max: WIRE_VERSION }

/**
 * The highest version both peers speak, or null when there is no overlap.
 *
 * Null is refused with a stated reason rather than a parse error — a peer too
 * old to talk to should be told that, not handed bytes it will reject field by
 * field.
 */
export function negotiate(a: VersionRange, b: VersionRange): number | null {
  const top = Math.min(a.max, b.max)
  return top >= Math.max(a.min, b.min) ? top : null
}

/** One page. `v` first, and the signature over everything else. */
export interface Page {
  readonly v: number
  readonly person: string
  readonly work: WorkClaim
  readonly device: string
  readonly from: number
  readonly to: number
  /** SHA-256 of the previous page from THIS device, or `''` for the first. */
  readonly prevPageHash: string
  readonly entries: readonly Entry[]
  /** Device ids only — no address hints, no join times. See `signedBytes`. */
  readonly roster: readonly string[]
  readonly revocations: number
  readonly delegation: string
  readonly sig: string
}

/** The kinds of object that get signed. Domain separation reads this. */
export type SignedKind = 'page' | 'delegation' | 'roster' | 'revocation' | 'succession'

/**
 * The exact bytes a signature covers.
 *
 * ⚠️ **DOMAIN SEPARATION, which nothing had.** Without the type in the preamble
 * a roster signature can be presented as a delegation signature over the same
 * bytes — `review.md`'s *"cross-type signature substitution"* check. The
 * version is in there too, so a v1 signature cannot be replayed as v2 once v2
 * exists.
 */
export function signedBytes(kind: SignedKind, version: number, value: object): string {
  const { sig: _dropped, ...rest } = value as Record<string, unknown>
  return `paper.circle.${version}.${kind}\n${canonicalJson(rest)}`
}

/**
 * Whether the received bytes are the canonical spelling of what they parsed to.
 *
 * ⚠️ **THIS IS WHAT MAKES "INTEGERS ONLY" AND "NO DUPLICATE KEYS" ENFORCEABLE
 * RATHER THAN ASPIRATIONAL.** See the module header: one comparison catches the
 * whole family, including the members `JSON.parse` has already destroyed the
 * evidence of.
 */
export function isCanonical(received: string, parsed: unknown): boolean {
  return canonicalJson(parsed) === received
}

/**
 * Whether every number in a signed object is a safe integer.
 *
 * ⚠️ Floats are refused rather than discouraged: `canonicalJson` goes through
 * `JSON.stringify`, which turns `-0` into `0` and `1e21` into `1e+21`, so a
 * float is a value whose canonical form is not its own. Refusing them makes
 * `isCanonical` total instead of nearly total. Timestamps are integer
 * milliseconds for the same reason.
 */
export function integersOnly(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (Array.isArray(value)) return value.every(integersOnly)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every(integersOnly)
  }
  return true
}

/** What verifying a page needs from the platform. */
export interface PageCrypto {
  /** Ed25519 verify. `key` is 32 raw bytes as lower-case hex. */
  readonly verify: (key: string, message: string, sig: string) => boolean
  /** SHA-256, lower-case hex. Used by `chainHash` to extend the chain. */
  readonly hash: (value: string) => string
}

/**
 * The hash the NEXT page from this device must carry as `prevPageHash`.
 *
 * ⚠️ **THIS WAS MISSING, AND ITS ABSENCE MADE THE CHAIN UNUSABLE.** `checkPage`
 * compared `prevPageHash` against a value the caller supplied, and nothing
 * computed what a caller should supply — so `crypto.hash` was required of every
 * caller and never called. A chain that can be verified and not extended is not
 * a chain; it is a field.
 *
 * Over the RECEIVED bytes, not over a re-serialisation: the chain must commit to
 * exactly what was signed, and `isCanonical` has already established that the
 * two are the same string.
 */
export function chainHash(crypto: PageCrypto, receivedBytes: string): string {
  return crypto.hash(receivedBytes)
}

export type PageRefusal =
  | 'version'
  | 'not-canonical'
  | 'non-integer'
  | 'bad-signature'
  | 'chain'
  | 'too-large'
  /** The signing device may not speak for this person — see `checkPage`. */
  | 'may-not-speak'

/**
 * Check one page, in the order that costs least to refuse.
 *
 * ⚠️ **THE ORDER IS THE POINT, and it is `importLimits.ts`'s rule applied to a
 * single frame.** Version, then shape, then the signature — because a signature
 * check is the expensive step and a peer that can make us do it for free on
 * malformed input has found a cheap way to spend our CPU.
 *
 * `expectedPrev` is the hash of the last page held from this device, or `''`
 * when there is none. A mismatch is a GAP or a substitution — the whole reason
 * `prevPageHash` exists — and is refused rather than merged, because merging it
 * would silently accept a log with a hole in it.
 */
export function checkPage(
  page: Page,
  received: string,
  crypto: PageCrypto,
  key: string,
  expectedPrev: string,
  /**
   * Whether the signing device may speak for this person RIGHT NOW.
   *
   * ⚠️ **THIS PARAMETER WAS NOT HERE, AND WITHOUT IT A REVOKED DEVICE'S PAGE
   * VERIFIED CLEANLY.** The page carries `delegation`, `roster` and
   * `revocations` — `wire.md` says it carries them because they are *"needed to
   * check it"* — and nothing read any of them. The only thing checked was that
   * a key the CALLER chose produced the signature, which says the bytes are
   * intact and says nothing at all about whether their author is still allowed
   * to write them.
   *
   * That is WI-22.B2's acceptance — *"a peer holding version n refuses anything
   * signed by a device revoked at ≤ n"* — and it was the security property of
   * the whole stage, absent. `maySpeak` in `identity.ts` had been written and
   * wired to nothing.
   *
   * Injected rather than called directly so this module keeps no dependency on
   * the identity types, and so a caller cannot forget: it is a required
   * argument, not an optional check.
   */
  maySpeak: (page: Page) => boolean,
  version: number = WIRE_VERSION,
): PageRefusal | null {
  if (page.v !== version) return 'version'
  if (!isCanonical(received, page)) return 'not-canonical'
  if (!integersOnly(page)) return 'non-integer'
  if (page.prevPageHash !== expectedPrev) return 'chain'
  /* BEFORE the signature, because it is the cheaper of the two and a device
     that may not speak is refused whatever it signed. */
  if (!maySpeak(page)) return 'may-not-speak'
  if (!crypto.verify(key, signedBytes('page', page.v, page), page.sig)) return 'bad-signature'
  return null
}

/**
 * Split entries into pages that each fit the frame.
 *
 * ⚠️ **BY ENCODED SIZE, NEVER BY COUNT.** The cap is on bytes, and a count is a
 * proxy that is wrong for exactly the notes that matter — the long ones. A
 * reader who writes a paragraph about a paragraph produces entries an order of
 * magnitude larger than a bare highlight, and a page sized for the second
 * overflows on the first.
 *
 * ⚠️ **AN ENTRY TOO LARGE FOR AN EMPTY PAGE IS ITS OWN PAGE, not an infinite
 * loop.** It will be refused downstream by the frame cap, which is the right
 * place to refuse it — but a pager that never emitted it would hang instead,
 * and a hang is the one failure that looks like nothing at all.
 */
export function paginate(entries: readonly Entry[], budget: number): readonly (readonly Entry[])[] {
  const pages: Entry[][] = []
  let current: Entry[] = []
  let size = 2 /* the `[]` an empty page still costs */
  for (const entry of entries) {
    const cost = canonicalJson(entry).length + 1
    if (current.length > 0 && size + cost > budget) {
      pages.push(current)
      current = []
      size = 2
    }
    current.push(entry)
    size += cost
  }
  if (current.length > 0) pages.push(current)
  return pages
}
