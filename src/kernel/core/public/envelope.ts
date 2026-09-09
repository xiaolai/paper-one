import { canonicalJson } from '../canonicalJson'

/**
 * What a stranger's annotation IS on the wire — WI-26.2.
 *
 * ⚠️ **"RETAIN THE SIGNED ENVELOPE" NAMED A THING THAT DOES NOT EXIST.** The
 * circle's `Page` signs a person, a device, a work claim, a roster, a
 * delegation, a sequence range and a previous-page hash, and `checkPage`
 * requires authority to speak for a PERSON before it checks the signature.
 * Extracting one entry from a signed multi-entry page does not carry its
 * signature; keeping the whole page carries the person and device metadata
 * this phase exists to remove. Neither is a public envelope. The signing
 * PRIMITIVE is reusable — `pageCrypto.verify` takes a message and a key — and
 * the envelope is not.
 *
 * ## Public and circle share no wire type
 *
 * ⚠️ **THEY HAVE OPPOSITE DEFAULTS.** The circle denies unless a person is
 * admitted; the public layer allows unless a voice is blocked. A single type
 * serving both is a place where the wrong default is invisible — and finding #1
 * of phase 26's review is what that looks like when it is only NEARLY true: the
 * circle's disk loader was safe solely because the receiver refused strangers
 * upstream.
 *
 * So: a different domain (`paper.public.` and never `paper.circle.`), a
 * different shape, a different verifier. What is shared, deliberately, is the
 * canonical encoding — because two canonicalisers disagreeing about key order
 * is a signature that verifies on one machine and fails on another, and the
 * cheapest way not to have that problem is not to have two.
 *
 * ## Two identifiers had to be stripped, and this shape carries neither
 *
 * | Circle identifier | What it is | Here |
 * |---|---|---|
 * | `page.device` | the endpoint public key — the signing key IS the device id | absent; the signer is a `voice` that opens no connections |
 * | the suffix of every `at` | a separate random 16-hex id from `ensureDeviceId`, bound in as the kernel clock | absent; there is no HLC here at all |
 *
 * ⚠️ **AND THE STAMP COULD NOT SIMPLY BE EMPTIED**, which is why the ordering
 * is this layer's own rather than the kernel's clock with a blank in it. See
 * `order.ts`: `isHlc` rejects a missing suffix, `makeHlc` rejects `"0"`,
 * sixteen zeroes is refused by `createClock` as a clock identity, and a 64-hex
 * key does not fit a 16-hex field. Every route to reusing the stamp fails, and
 * the ones that do not fail carry a private identifier.
 *
 * PURE. Signing and verifying are injected, for `page.ts`'s reason: a module
 * that imported Ed25519 would take this whole subtree out of a browser's reach.
 */

/** The newest public wire version this build publishes. */
export const PUBLIC_VERSION = 1

/** The versions this build will read. */
export const PUBLIC_SUPPORTED: readonly number[] = [1]

/** What a public envelope can say. */
export type PublicOp =
  /** A passage, with the reader's words when they chose to share them. */
  | 'note'
  /** Takes back a `note` by its publication id. Carries no passage — see below. */
  | 'unnote'

export const PUBLIC_OPS: readonly PublicOp[] = ['note', 'unnote']

/**
 * The same two names as a set, for the shape check.
 *
 * ⚠️ **`PUBLIC_OPS` WAS DECLARED, RE-EXPORTED AND READ BY NOTHING**, while
 * `isPublicEnvelopeShape` spelled the two operation names out again — so the
 * list that says what a public operation IS could have gained a third entry
 * without the validator ever hearing about it. Found by audit.
 */
const IS_PUBLIC_OP = new Set<string>(PUBLIC_OPS)

/** What travels: the quote and its neighbours. Never an anchor. */
export interface PublicPassage {
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly chapter: string
  /** The reader's own words, when they chose to publish them. */
  readonly note?: string
}

/**
 * One public statement, signed.
 *
 * ⚠️ **`unnote` CARRIES NO PASSAGE, AND THE TYPE IS WHAT ENFORCES IT.** A
 * tombstone that repeated what it retracts would disclose the withdrawn
 * passage to somebody who never saw the publication — the rule `log.ts` states
 * for `unshare`, and the one a reviewer noticing is not a mechanism for.
 */
export type PublicEnvelope = PublicNote | PublicUnnote

interface PublicCommon {
  readonly v: number
  /** The signing key, full, as 64 lower-case hex. Never an abbreviation. */
  readonly voice: string
  /** The book, by its whole-file BLAKE3 — WI-25.2's network name. */
  readonly book: string
  /** This voice's own sequence. Strictly increasing, durable across restarts. */
  readonly seq: number
  /** When the voice says it published. Display only — see `order.ts`. */
  readonly at: number
  /**
   * When this stops being valid, in epoch milliseconds — WI-26.3.
   *
   * ⚠️ **SIGNED INTO EVERY PUBLICATION, AND THAT IS THE REPLAY HORIZON.** The
   * alternative — remembering every withdrawal for ever — is unbounded by
   * construction, because public keys and publication ids are unlimited. With
   * an expiry in the signed bytes an envelope stops being valid on its own, so
   * suppression only has to outlive the thing it suppresses.
   *
   * The cost, stated rather than hidden: **a public annotation has a lifetime
   * and must be published again to outlive it.** A voice that stops reading
   * stops publishing, and its annotations go — which is the behaviour a
   * bulletin board should have anyway.
   */
  readonly expires: number
  /** The publication this names. Minted by the voice; `unnote` names one. */
  readonly pub: string
  readonly sig: string
}

export interface PublicNote extends PublicCommon {
  readonly op: 'note'
  readonly passage: PublicPassage
}

export interface PublicUnnote extends PublicCommon {
  readonly op: 'unnote'
}

/** 64 lower-case hex — a voice key, or a book's content hash. */
const HEX64 = /^[0-9a-f]{64}$/u
/** 128 lower-case hex — an Ed25519 signature. */
const HEX128 = /^[0-9a-f]{128}$/u

/**
 * The most one envelope may be, in UTF-8 BYTES of canonical JSON.
 *
 * ⚠️ **IT COUNTED UTF-16 CHARACTERS AND RUST COUNTS BYTES, AND THE TWO
 * DISAGREED BY THREE TIMES.** Measured by audit: a valid 10,416-character
 * Chinese envelope occupies 30,416 bytes, passed this check and was refused by
 * `share/notes.rs`'s 16 KiB. A publisher could then write something this build
 * says is fine and no provider will store — with no error anywhere that names
 * the disagreement. Every bound in this design counts bytes now, because
 * that is the unit the wire and the disk both use.
 */
export const MAX_ENVELOPE_BYTES = 16 * 1024

/** UTF-8 bytes of a string — the unit every bound here counts. */
export function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * The most a published quote, its neighbours or the reader's note may be, in
 * UTF-8 BYTES — see {@link MAX_ENVELOPE_BYTES} for why not characters.
 */
export const MAX_QUOTE = 2_000
export const MAX_NOTE = 4_000
export const MAX_CHAPTER = 500
/** The most a publication id may be. */
export const MAX_PUB = 128

/**
 * The longest a publication may claim to live — WI-26.3.
 *
 * ⚠️ **A CAP ON THE PUBLISHER'S OWN CLAIM, NOT A PREFERENCE.** Without one a
 * voice mints an envelope that expires in the year 3000 and the suppression
 * record for it is unbounded again by another road. Four hundred days is a year
 * with room for a reader who publishes annually.
 *
 * ⚠️ **AND IT IS MEASURED AGAINST THE RECIPIENT'S CLOCK, NOT THE PUBLISHER'S
 * `at`.** Measured by audit: an envelope dated in the year 3000 with a
 * one-second lifetime passed this check today, because `expires - at` was one
 * second — and it would still be valid in the year 3000, which is the bounded
 * replay horizon defeated by arithmetic. `at` is a number a stranger chose;
 * the horizon has to be anchored to a number this device chose.
 */
export const MAX_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000

/**
 * How far ahead of this device's clock a publication may claim to be dated.
 *
 * ⚠️ **A SKEW ALLOWANCE, NOT A TRUST.** Two machines disagree about the time by
 * minutes routinely and by hours occasionally; refusing on a one-second
 * difference would drop honest annotations from a laptop whose clock had not
 * synced yet. A day is far past any real skew and far under anything that makes
 * `MAX_LIFETIME_MS` meaningless.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

/** What a build publishes with, unless a caller says otherwise. */
export const DEFAULT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000

/**
 * The exact bytes a public signature covers.
 *
 * ⚠️ **`paper.public.`, NEVER `paper.circle.`** — and the two must never
 * become one function with a parameter. Domain separation is what stops a
 * circle page's signature being replayed as a public annotation and the other
 * way round; a shared builder is one argument away from being called with the
 * wrong domain, and nothing downstream could tell.
 *
 * ⚠️ **AND THE DEVICE-SIGNING COMMAND CANNOT PRODUCE THESE.** `identity::
 * sign_page` in Rust refuses anything whose bytes are not
 * `paper.circle.<version>.page\n…`, so the endpoint key — the one a renderer
 * can reach — cannot sign a public envelope even by mistake. The voice key is
 * a different key with a different command.
 */
export function publicSignedBytes(version: number, value: object): string {
  const { sig: _dropped, ...rest } = value as Record<string, unknown>
  return `paper.public.${version}.envelope\n${canonicalJson(rest)}`
}

/** Whether the received bytes are the canonical spelling of what they parsed to. */
export function isCanonicalEnvelope(received: string, parsed: unknown): boolean {
  return canonicalJson(parsed) === received
}

/** Whether every number in the envelope is a safe integer. */
export function integersOnlyEnvelope(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value === 'object' && value !== null) return Object.values(value).every(integersOnlyEnvelope)
  return true
}

export type PublicRefusal =
  | 'version'
  | 'not-canonical'
  | 'non-integer'
  | 'too-large'
  | 'malformed'
  | 'bad-signature'
  /** `expires` has passed, or is further out than this build will accept. */
  | 'expired'
  /** The reader has blocked this voice. */
  | 'blocked'
  /**
   * This book already holds as many public annotations as it will keep.
   *
   * ⚠️ **THE ONLY REFUSAL THAT IS NOT ABOUT THE ENVELOPE.** The other eight say
   * the envelope is bad; this one says it is fine and arrived at a full book.
   * It exists because a capacity drop had NO reason at all — the loop simply
   * stopped — so the one refusal a reader might actually need explained was the
   * one that produced no diagnostic. A withdrawal is never refused for this:
   * suppression is not subject to capacity.
   */
  | 'full'

/** What verifying an envelope needs from the platform. Ed25519, and nothing else. */
export interface PublicCrypto {
  /** `key` is 32 raw bytes as lower-case hex; answers `false`, never throws. */
  readonly verify: (key: string, message: string, sig: string) => boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key))

const COMMON_FIELDS = ['v', 'voice', 'book', 'seq', 'at', 'expires', 'pub', 'op', 'sig'] as const
const NOTE_FIELDS = new Set<string>([...COMMON_FIELDS, 'passage'])
const UNNOTE_FIELDS = new Set<string>(COMMON_FIELDS)
const PASSAGE_FIELDS = new Set(['quote', 'prefix', 'suffix', 'chapter', 'note'])

/**
 * Whether a parsed value has the shape of a public envelope.
 *
 * ⚠️ **A FIELD THE OP DOES NOT NAME IS REFUSED, NOT IGNORED.** `page.ts` states
 * the rule and what it costs to break: a validator that only looked for the
 * fields it wanted let a page carry the forbidden ones alongside, signed, into
 * every recipient's file. Here the forbidden one is the passage on an `unnote`.
 */
export function isPublicEnvelopeShape(value: unknown): value is PublicEnvelope {
  if (!isObject(value)) return false
  const e = value
  if (typeof e['op'] !== 'string' || !IS_PUBLIC_OP.has(e['op'])) return false
  if (!hasOnly(e, e['op'] === 'note' ? NOTE_FIELDS : UNNOTE_FIELDS)) return false
  if (typeof e['v'] !== 'number') return false
  if (typeof e['voice'] !== 'string' || !HEX64.test(e['voice'])) return false
  if (typeof e['book'] !== 'string' || !HEX64.test(e['book'])) return false
  if (typeof e['sig'] !== 'string' || !HEX128.test(e['sig'])) return false
  /* Numbers, not integers: whether a number is a safe integer is
     `integersOnlyEnvelope`'s question, refused under its own name. */
  if (typeof e['seq'] !== 'number' || typeof e['at'] !== 'number' || typeof e['expires'] !== 'number') return false
  if (typeof e['pub'] !== 'string' || e['pub'] === '' || byteLengthOf(e['pub']) > MAX_PUB) return false
  if (e['op'] === 'unnote') return true
  const passage = e['passage']
  if (!isObject(passage) || !hasOnly(passage, PASSAGE_FIELDS)) return false
  return (
    typeof passage['quote'] === 'string' &&
    byteLengthOf(passage['quote']) <= MAX_QUOTE &&
    typeof passage['prefix'] === 'string' &&
    byteLengthOf(passage['prefix']) <= MAX_QUOTE &&
    typeof passage['suffix'] === 'string' &&
    byteLengthOf(passage['suffix']) <= MAX_QUOTE &&
    typeof passage['chapter'] === 'string' &&
    byteLengthOf(passage['chapter']) <= MAX_CHAPTER &&
    (passage['note'] === undefined || (typeof passage['note'] === 'string' && byteLengthOf(passage['note']) <= MAX_NOTE))
  )
}

/**
 * Check one envelope that has ALREADY passed {@link isPublicEnvelopeShape}, in
 * the order that costs least to refuse.
 *
 * ⚠️ **NOT EXPORTED, AND IT USED TO BE.** It assumes the shape and does not
 * check it, so a caller reaching it directly could hand it a correctly signed
 * `unnote` CARRYING A PASSAGE and be told the envelope is fine —
 * `readPublicEnvelope` refuses exactly that, one line earlier. TypeScript does
 * not close the gap: `PublicEnvelope` is structural, so an object with extra
 * fields satisfies it. A door with a precondition nobody outside can see is a
 * door with no precondition; there is one door now, and it is
 * `readPublicEnvelope`. Found by audit.
 *
 * ⚠️ **THE ORDER IS THE POINT** — `checkPage`'s rule, and the reason is sharper
 * here: this door faces strangers with free keys, so a signature check a
 * stranger can make us do on malformed input is a cheap way to spend our CPU.
 *
 * ⚠️ **NO ROSTER, NO DELEGATION, NO EPOCH.** There is nobody to be admitted by.
 * The only identity question is whether the reader has BLOCKED this voice,
 * which is the public layer's opposite default expressed as its one predicate.
 */
function checkPublicEnvelope(
  envelope: PublicEnvelope,
  received: string,
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
): PublicRefusal | null {
  if (!PUBLIC_SUPPORTED.includes(envelope.v)) return 'version'
  if (byteLengthOf(received) > MAX_ENVELOPE_BYTES) return 'too-large'
  if (!isCanonicalEnvelope(received, envelope)) return 'not-canonical'
  if (!integersOnlyEnvelope(envelope)) return 'non-integer'
  if (envelope.seq < 1 || envelope.at < 0) return 'malformed'
  /* ⚠️ **THE EXPIRY IS CHECKED BEFORE THE SIGNATURE AND AFTER THE SHAPE.** It
     is the replay horizon: an envelope past its own expiry is refused whoever
     signed it, so a replayed old copy costs no verification at all. And a
     lifetime longer than this build accepts is refused as well — otherwise a
     voice mints a century and the suppression record for it is unbounded by
     another road. */
  if (envelope.expires <= envelope.at) return 'malformed'
  /* ⚠️ **AGAINST THIS DEVICE'S CLOCK, NOT THE PUBLISHER'S OWN `at`.** See
     `MAX_LIFETIME_MS`: a year-3000 `at` with a one-second lifetime passed a
     check written the other way, and would go on passing it for a thousand
     years. Both halves are needed — a publication dated absurdly far ahead is
     refused, and so is one whose expiry is further out than this build accepts
     from now. */
  if (envelope.at > now + MAX_CLOCK_SKEW_MS) return 'expired'
  if (envelope.expires > now + MAX_LIFETIME_MS + MAX_CLOCK_SKEW_MS) return 'expired'
  if (envelope.expires - envelope.at > MAX_LIFETIME_MS) return 'expired'
  if (envelope.expires <= now) return 'expired'
  /* Before the signature, because it is cheaper and a blocked voice is refused
     whatever it signed. */
  if (blocked(envelope.voice)) return 'blocked'
  if (!crypto.verify(envelope.voice, publicSignedBytes(envelope.v, envelope), envelope.sig)) return 'bad-signature'
  return null
}

/** What a reader is about to say publicly, before it is signed. */
export interface Minting {
  /** The publishing voice, 64 lower-case hex. */
  readonly voice: string
  /** The book, by its whole-file BLAKE3. */
  readonly book: string
  /** This voice's next sequence — from a DURABLE counter, never a guess. */
  readonly seq: number
  /** Now, in epoch milliseconds. */
  readonly at: number
  /** The publication id. Minted by the voice; see {@link mintPublicationId}. */
  readonly pub: string
  /** How long it lives. Bounded by {@link MAX_LIFETIME_MS}. */
  readonly lifetimeMs?: number
}

/**
 * A `PublicEnvelope` without its signature.
 *
 * ⚠️ **DISTRIBUTIVE, BECAUSE `Omit` OVER A UNION IS NOT.** `PublicEnvelope` is
 * `PublicNote | PublicUnnote`, and a bare `Omit<PublicEnvelope, 'sig'>`
 * collapses to the fields the two SHARE — dropping `passage` entirely, so a
 * note could not be built at all. The conditional distributes over the union
 * and each arm keeps its own fields — and it has to go through a generic
 * helper, because distribution happens over a naked type PARAMETER and not
 * over a concrete alias written in place. Both spellings compile; only one is
 * a union of two shapes.
 */
type WithoutSig<T> = T extends unknown ? Omit<T, 'sig'> : never
export type Unsealed = WithoutSig<PublicEnvelope>

/** An envelope with everything but its signature, and the bytes to sign. */
export interface Unsigned {
  readonly envelope: Unsealed
  /** Exactly what a signer must be handed — see {@link publicSignedBytes}. */
  readonly signedBytes: string
}

/**
 * Build a publication, unsigned.
 *
 * ⚠️ **THE MINT AND THE CHECK ARE ONE MODULE ON PURPOSE.** A builder living
 * beside the verifier is a builder that cannot drift from it: every field the
 * shape requires is set here, and a field the shape forbids has nowhere to
 * come from. The circle learned the opposite lesson the hard way —
 * `signedBytes` is *"the ONE place these bytes are built"* — and this is that
 * rule applied a domain over.
 *
 * ⚠️ **AND IT REFUSES RATHER THAN CLAMPS.** A lifetime past the cap, a
 * sequence below one, a quote over its bound: each is a caller bug, and
 * silently shortening one produces an envelope the reader did not write.
 */
export function mintNote(minting: Minting, passage: PublicPassage): Unsigned {
  return unsigned({
    ...common(minting),
    op: 'note',
    passage,
  })
}

/**
 * Build a withdrawal, unsigned.
 *
 * ⚠️ **`pub` NAMES THE PUBLICATION BEING TAKEN BACK, AND `seq` IS THIS
 * WITHDRAWAL'S OWN.** They come from different places — the first from what is
 * being withdrawn, the second from the voice's counter — and swapping them is
 * a withdrawal that withdraws nothing and an equivocation at once.
 *
 * ⚠️ **AND IT CARRIES NO PASSAGE.** The type is what enforces that; see
 * `PublicEnvelope`.
 */
export function mintUnnote(minting: Minting): Unsigned {
  return unsigned({ ...common(minting), op: 'unnote' })
}

function common(minting: Minting): Omit<PublicUnnote, 'sig' | 'op'> {
  const lifetime = minting.lifetimeMs ?? DEFAULT_LIFETIME_MS
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > MAX_LIFETIME_MS) {
    throw new RangeError(`public: a lifetime is 1..=${MAX_LIFETIME_MS} ms, not ${lifetime}`)
  }
  if (!Number.isSafeInteger(minting.seq) || minting.seq < 1) {
    throw new RangeError(`public: not a sequence: ${minting.seq}`)
  }
  if (!Number.isSafeInteger(minting.at) || minting.at < 0) {
    throw new RangeError(`public: not a time: ${minting.at}`)
  }
  /* ⚠️ **TWO SAFE INTEGERS CAN ADD UP TO ONE THAT IS NOT.** `at` past
     `MAX_SAFE_INTEGER - lifetime` produced an `expires` the READER refuses as
     `non-integer` — a mint that reports success and an envelope nobody will
     take, which is the shape of failure this whole function exists to prevent
     ("it refuses rather than clamps … silently shortening one produces an
     envelope the reader did not write"). Found by audit. */
  const expires = minting.at + lifetime
  if (!Number.isSafeInteger(expires)) {
    throw new RangeError(`public: that lifetime puts the expiry past a safe integer: ${expires}`)
  }
  return {
    v: PUBLIC_VERSION,
    voice: minting.voice,
    book: minting.book,
    seq: minting.seq,
    at: minting.at,
    expires,
    pub: minting.pub,
  }
}

function unsigned(envelope: Unsealed): Unsigned {
  /* ⚠️ **THE CALLER'S PASSAGE IS COPIED BEFORE ANYTHING IS SIGNED OVER IT.**
     `mintNote` took the caller's object by reference and kept it in the
     returned envelope while `signedBytes` was computed from it — and signing
     is asynchronous. A caller that reused or mutated its passage object during
     the signature produced a `sealPublic` line that no longer matched the
     bytes that were signed, which arrives at the recipient as `bad-signature`
     and names the wrong cause entirely. Frozen as well as copied, so the same
     mistake made LATER fails at the mutation rather than at the far end.
     Found by audit. */
  const sealed: Unsealed =
    envelope.op === 'note'
      ? Object.freeze({ ...envelope, passage: Object.freeze({ ...envelope.passage }) })
      : Object.freeze({ ...envelope })
  /* ⚠️ **THE SHAPE IS CHECKED AT THE MINT, NOT ONLY AT THE VERIFIER.** A
     malformed envelope that reaches a signer is a signature over something no
     recipient will accept — and the reader is told it published. The dummy
     signature is only there to satisfy the shape check, which requires the
     field; it is never returned and never signed over. */
  const asSealed = { ...sealed, sig: '0'.repeat(128) }
  if (!isPublicEnvelopeShape(asSealed)) {
    throw new Error('public: that is not a publishable envelope')
  }
  /* ⚠️ **AND THE WHOLE-ENVELOPE BOUND IS CHECKED HERE TOO, WHICH IT WAS NOT.**
     The field bounds above are each satisfiable while the SERIALISED envelope
     is over `MAX_ENVELOPE_BYTES`: a note of four thousand characters that JSON
     escapes to six bytes each is 24 KiB on the wire, minted happily and
     refused by every reader as `too-large`. The signature is the full 128
     hex characters here for the same reason the shape check needs one — the
     real one is exactly that long, so this measures what will be sent. */
  const size = byteLengthOf(canonicalJson(asSealed))
  if (size > MAX_ENVELOPE_BYTES) {
    throw new RangeError(`public: that envelope is ${size} bytes, past the ${MAX_ENVELOPE_BYTES} a reader accepts`)
  }
  return { envelope: sealed, signedBytes: publicSignedBytes(sealed.v, sealed) }
}

/**
 * A publication id — sixteen random bytes as hex.
 *
 * ⚠️ **RANDOM RATHER THAN DERIVED FROM THE PASSAGE.** `mintPub` in the circle
 * carries the reasoning and it holds here: a reader who publishes the same
 * words twice has made two publications, and a withdrawal names exactly one of
 * them. Deriving the id would make them one, and taking one back would take
 * both.
 */
export function mintPublicationId(random: (bytes: Uint8Array) => Uint8Array = fill): string {
  return Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fill(bytes: Uint8Array): Uint8Array {
  return globalThis.crypto.getRandomValues(bytes)
}

/**
 * The line to publish, once a signer has answered.
 *
 * ⚠️ **THE BYTES SIGNED AND THE BYTES STORED ARE DERIVED FROM ONE OBJECT.** A
 * caller that built the line itself could canonicalise differently from the
 * signer's input and produce a publication that fails its own verifier — which
 * is the failure `isCanonical` exists to catch, arriving from the writing side.
 */
export function sealPublic(unsigned: Unsigned, sig: string): string {
  return canonicalJson({ ...unsigned.envelope, sig })
}

/**
 * Parse and check one line of public annotation storage.
 *
 * ⚠️ **THE RECEIVED BYTES ARE WHAT IS KEPT, AND EVERY DERIVED FIELD IS
 * RECOMPUTED FROM THEM.** Phase 26's finding #3 is that a stored PROJECTION of
 * a signed object proves nothing — the circle keeps the passage and the stamps
 * and drops the envelope, so a provider forwarding that projection forwards
 * something unsigned. The fix is not a second signature check somewhere; it is
 * to have no separately mutable projection at all. What is stored, what is
 * relayed and what is rendered are one string.
 */
export function readPublicEnvelope(
  line: string,
  crypto: PublicCrypto,
  now: number,
  blocked: (voice: string) => boolean,
): { readonly envelope: PublicEnvelope; readonly received: string } | PublicRefusal {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return 'malformed'
  }
  if (!isPublicEnvelopeShape(parsed)) return 'malformed'
  const refusal = checkPublicEnvelope(parsed, line, crypto, now, blocked)
  return refusal ?? { envelope: parsed, received: line }
}
