import { MAX_COVER_BYTES, SUPPORTED, negotiate, type VersionRange, type WorkClaim, MAX_PAGE_CHARS as KERNEL_MAX_PAGE_CHARS } from '../../../kernel'

/**
 * The circle's own vocabulary on the wire — WI-22.C1.
 *
 * These ride the peer envelope as `circle.*` service calls, the way `sync.*`
 * does. `serviceTable.ts` says why they are not in the table: *"replication is
 * a different protocol that happens to share the envelope"*, and the same is
 * true here. The table's names are `<noun>.<verb>` and name what is OPERATED
 * ON; these name a protocol.
 *
 * ## A page crosses as a STRING, and that is not an encoding preference
 *
 * ⚠️ **`checkPage` COMPARES THE RECEIVED BYTES AGAINST THEIR CANONICAL FORM,
 * so the bytes have to survive the journey.** A page nested as an OBJECT inside
 * the envelope is parsed and re-encoded by the envelope's own JSON — which is
 * free to order keys differently, spell numbers differently, or escape
 * non-ASCII differently — and the string the recipient reconstructs is then not
 * the string the sender signed. `isCanonical` would refuse every page from a
 * peer whose encoder disagreed with ours in any of those ways, and the failure
 * would look like corruption.
 *
 * So a page travels as one opaque string, exactly as it was signed, and is
 * parsed once by the recipient. That is also what makes `isCanonical`'s trick
 * work at all: *"it re-serialises what it parsed and requires the bytes to
 * match what arrived."* There is nothing to match against if the transport
 * rewrote them.
 *
 * ## Strict parsing, which inverts the rule the rest of this codebase follows
 *
 * ⚠️ Elsewhere a tolerant parser saves a reader's data from one bad row. Here
 * the SIGNATURE covers the bytes, so a field the verifier ignored is a field
 * the signer can use to mean something the verifier never saw. `wire.md` states
 * the inversion and the reason; every parser below refuses an unknown member.
 */

/** The wire this build speaks. Bumped when the MEANING changes, not only the shape. */
export const CIRCLE_PROTO = 1

/**
 * The page versions this build can read: `[min, max]`.
 *
 * ⚠️ **NEGOTIATED, NOT ASSUMED — and `SYNC_VERSION`'s history is why.** An
 * unbumped peer there stripped a field it did not know, ACKed the stripped row,
 * and the ACK erased the sender's data. On an append-only log the log IS the
 * record, so the same shape is not a lost field but a lost history.
 */
export const CIRCLE_VERSION: VersionRange = SUPPORTED

/** The service names, and the grant each is gated on. */
export const CIRCLE_SERVICES = {
  hello: { name: 'circle.hello', grant: 'circle:read' },
  pages: { name: 'circle.pages', grant: 'circle:read' },
  /**
   * The shelf log — WI-23.C1. The same grant as pages: the SWITCH is what
   * decides whether this caller is served anything, per person, and it is
   * checked by the handler against the relationship, not by the envelope
   * against a grant. A grant is per device and a relationship is per person.
   */
  shelf: { name: 'circle.shelf', grant: 'circle:read' },
  /**
   * The list logs — WI-23.E1. Gated exactly as the shelf is, by the same
   * switch: a list is a subset of a shelf and discloses no more.
   */
  lists: { name: 'circle.lists', grant: 'circle:read' },
  /**
   * A jacket's bytes, by the shelf entry that named its digest — WI-23.C5.
   * The same grant and the same switch as the shelf: a person the switch is
   * off for is refused exactly as a pub nobody holds is.
   */
  cover: { name: 'circle.cover', grant: 'circle:read' },
} as const

/** The most lists one request names a cursor for. */
export const MAX_LISTS_PER_REQUEST = 64

/** The most pages one answer carries, whatever was asked for. */
export const MAX_PAGES_PER_ANSWER = 32

/** The most a single page may be, in characters of canonical JSON — the kernel's frame cap, named here for the callers that had it here. */
export const MAX_PAGE_CHARS = KERNEL_MAX_PAGE_CHARS

/** What a caller says when it opens a circle exchange. */
export interface CircleHello {
  readonly proto: number
  /** The page versions the caller can read. */
  readonly pages: VersionRange
  /** Who the caller speaks for — a person id, which is a public key. */
  readonly person: string
}

/** What the answering side says back. */
export interface CircleWelcome {
  readonly proto: number
  readonly pages: VersionRange
  readonly person: string
  /** The page version both sides settled on. */
  readonly agreed: number
}

/** The most devices one person's roster may have, for a bounded cursor. */
export const MAX_CURSOR_DEVICES = 64

/** Ask one person for what they have shared of one work. */
export interface PagesRequest {
  readonly work: WorkClaim
  /**
   * The highest `seq` already held, PER DEVICE. Absent means none.
   *
   * ⚠️ **PER DEVICE, AND A SINGLE NUMBER WAS WRONG.** `mergeLogs` explains why
   * in as many words: the log is keyed by `(device, seq)` because *"two
   * desktops at seq 10, disconnect, publish on both — both mint seq 11"*, and
   * putting the device in the key makes that two streams rather than one
   * collision. A scalar cursor over two streams either re-fetches everything
   * or skips one of them, and skipping is silent.
   *
   * ⚠️ **A CURSOR, NOT A COUNT.** Asking for "the next 20" would skip whatever
   * was published between two calls.
   */
  readonly since: Readonly<Record<string, number>>
  /**
   * The page version the caller reads — the one the hello agreed on.
   *
   * ⚠️ **ON THE REQUEST, SO THE ANSWERER NEEDS NO MEMORY OF THE HELLO.** A
   * v1 caller's request has no `v` at all — it was written before the member
   * existed, and its strict parser would refuse an answer it did not ask for
   * — so absent means 1, and a v2 caller names its version. Serving is
   * stateless either way, which is what lets a page be answered by whichever
   * device of the publisher's took the call.
   */
  readonly v: number
}

/**
 * Ask one person for their shelf — WI-23.C1. No work: the shelf is the one
 * log a recipient can ask for whole, because it is about works the recipient
 * cannot name yet.
 */
export interface ShelfRequest {
  readonly since: Readonly<Record<string, number>>
  /** The chain the caller negotiated — REQUIRED, unlike `PagesRequest.v`: the shelf is a v2 log, so there is no v1 to default to. */
  readonly v: number
}

/** Pages, exactly as they were signed. */
export interface PagesAnswer {
  /** Canonical JSON, one string per page. See the module header. */
  readonly pages: readonly string[]
  /** Whether the answerer has more beyond what it sent. */
  readonly more: boolean
}

/* ────────────────────────────────────────────────────────── strict parsers */

/** A plain object, and not an array or `null`. */
function object(value: unknown): Record<string, unknown> | null {
  /* Stryker disable next-line ConditionalExpression: `typeof null` is
     `'object'`, so without this clause `null` is returned as-is — and every
     caller writes `if (!held)`, which refuses it on the next line. The clause
     is what keeps the RETURN TYPE honest rather than what decides. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Whether `value` has exactly these members and no others.
 *
 * ⚠️ **AN UNKNOWN MEMBER IS A REFUSAL — see the module header.** This is the
 * one place in the codebase where a tolerant parser is the wrong answer, so it
 * is a shared helper rather than a habit each parser has to remember.
 */
function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const seen = Object.keys(value)
  /* Stryker disable next-line MethodExpression: `some` cannot be told from
     `every` by any caller HERE, because every one of them then validates each
     named member separately — a wrongly-named key leaves its member
     `undefined` and that member's own check refuses it. The `every` is what
     makes this helper true to its name for the next caller that does not. */
  return seen.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** A `[min, max]` range with `min <= max`, both non-negative integers. */
function range(value: unknown): VersionRange | null {
  const held = object(value)
  if (!held || !exactly(held, ['min', 'max'])) return null
  const { min, max } = held
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return null
  if ((min as number) < 0 || (max as number) < (min as number)) return null
  return { min: min as number, max: max as number }
}

/** 64 lower-case hex characters — a public key, and never a display name. */
function personId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : null
}

/** A `WorkClaim`, whose fields are digests and one language subtag. */
function workClaim(value: unknown): WorkClaim | null {
  const held = object(value)
  if (!held || !exactly(held, ['ids', 'titles', 'author', 'language'])) return null
  const { ids, titles, author, language } = held
  /* Every field but the language is a digest — `workClaim.ts`: sixty-four
     hex characters — and a claim names a handful of them, not a thousand. */
  const digests = (list: unknown): list is readonly string[] =>
    // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern, so the type check only spells out what the pattern refuses.
    Array.isArray(list) && list.length <= MAX_CLAIM_DIGESTS && list.every((one) => typeof one === 'string' && DIGEST.test(one))
  if (!digests(ids) || !digests(titles)) return null
  // Stryker disable next-line ConditionalExpression: a non-string is neither empty nor a digest, so the pattern refuses it alone.
  if (typeof author !== 'string' || (author !== '' && !DIGEST.test(author))) return null
  // Stryker disable next-line ConditionalExpression: as above, for the language subtag.
  if (typeof language !== 'string' || (language !== '' && !/^[a-z]{2,3}$/u.test(language))) return null
  return { ids, titles, author, language }
}

/** A SHA-256 digest as `pageCrypto.hash` spells it. */
const DIGEST = /^[0-9a-f]{64}$/u

/**
 * The most characters one answer's pages may carry between them — under the
 * transport's own 4 MiB envelope with room for the frame. The per-page cap
 * and the page count each held on their own, and thirty-two pages at the
 * page cap made an answer four times what the envelope carries.
 */
export const MAX_ANSWER_CHARS = 3 * 1024 * 1024

/** A cover travels in chunks of this many bytes — two of them hold the largest jacket the circle serves. */
export const COVER_CHUNK_BYTES = 512 * 1024

/** The most characters one chunk spells in base64. */
const COVER_CHUNK_CHARS = Math.ceil(COVER_CHUNK_BYTES / 3) * 4

export interface CoverRequest {
  /** The shelf entry whose digest the caller holds. */
  readonly pub: string
  /** Where to resume from, in bytes. */
  readonly offset: number
}

export function parseCoverRequest(value: unknown): CoverRequest | null {
  const held = object(value)
  if (!held || !exactly(held, ['pub', 'offset'])) return null
  const { pub, offset } = held
  /* A pub is minted hex, bounded — the rule a list id is held to. */
  if (typeof pub !== 'string' || !/^[0-9a-f]{1,64}$/u.test(pub)) return null
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) >= MAX_COVER_BYTES) return null
  return { pub, offset: offset as number }
}

export interface CoverAnswer {
  readonly offset: number
  /** The whole file's size, so the caller knows what it is collecting before the last chunk. */
  readonly size: number
  /** This chunk, base64. */
  readonly bytes: string
  readonly more: boolean
}

export function parseCoverAnswer(value: unknown): CoverAnswer | null {
  const held = object(value)
  if (!held || !exactly(held, ['offset', 'size', 'bytes', 'more'])) return null
  const { offset, size, bytes, more } = held
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) return null
  // Stryker disable next-line ConditionalExpression,EqualityOperator: a size of zero is refused by the offset check below; this spells it.
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > MAX_COVER_BYTES) return null
  if ((offset as number) >= (size as number)) return null
  if (typeof bytes !== 'string' || bytes === '' || bytes.length > COVER_CHUNK_CHARS) return null
  if (typeof more !== 'boolean') return null
  return { offset: offset as number, size: size as number, bytes, more }
}

/** The most identifiers, or title spellings, one claim may carry. */
export const MAX_CLAIM_DIGESTS = 16

/** `null` for anything this build will not answer. */
export function parseCircleHello(value: unknown): CircleHello | null {
  const held = object(value)
  if (!held || !exactly(held, ['proto', 'pages', 'person'])) return null
  const pages = range(held['pages'])
  const person = personId(held['person'])
  if (held['proto'] !== CIRCLE_PROTO || !pages || !person) return null
  return { proto: CIRCLE_PROTO, pages, person }
}

/** `null` for anything this build will not accept as an answer. */
export function parseCircleWelcome(value: unknown): CircleWelcome | null {
  const held = object(value)
  if (!held || !exactly(held, ['proto', 'pages', 'person', 'agreed'])) return null
  const pages = range(held['pages'])
  const person = personId(held['person'])
  const agreed = held['agreed']
  if (held['proto'] !== CIRCLE_PROTO || !pages || !person) return null
  /* Stryker disable next-line ConditionalExpression: the re-derivation below
     refuses anything that is not the agreed number, integer or not — this says
     so before doing the arithmetic. */
  if (!Number.isSafeInteger(agreed)) return null
  /* ⚠️ **THE AGREED VERSION IS RE-DERIVED, NOT TAKEN ON TRUST.** A peer that
     names a version outside the overlap is asking this side to read pages it
     cannot read — or, worse, to read v1 pages as v2 once v2 exists. */
  if (negotiate(CIRCLE_VERSION, pages) !== agreed) return null
  return { proto: CIRCLE_PROTO, pages, person, agreed: agreed as number }
}

/**
 * A per-device cursor: device id to highest seq held.
 *
 * ⚠️ **BOUNDED, because it arrives from a peer.** An unbounded map is an
 * unbounded allocation on the answering side before anything has been decided.
 */
function cursor(value: unknown): Readonly<Record<string, number>> | null {
  const held = object(value)
  if (!held) return null
  const keys = Object.keys(held)
  if (keys.length > MAX_CURSOR_DEVICES) return null
  for (const key of keys) {
    if (!/^[0-9a-f]{64}$/u.test(key)) return null
    const seq = held[key]
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) return null
  }
  return held as Readonly<Record<string, number>>
}

/** `null` for a request this build will not answer. */
export function parsePagesRequest(value: unknown): PagesRequest | null {
  const held = object(value)
  if (!held) return null
  /* `v` is the one member a request may omit — see `PagesRequest.v`. Present,
     it must name a version this build publishes; a strict parser does not
     guess at what a v3 caller wanted. */
  const versioned = Object.hasOwn(held, 'v')
  if (!exactly(held, versioned ? ['work', 'since', 'v'] : ['work', 'since'])) return null
  const v = versioned ? held['v'] : 1
  if (!Number.isSafeInteger(v) || (v as number) < CIRCLE_VERSION.min || (v as number) > CIRCLE_VERSION.max) return null
  const work = workClaim(held['work'])
  const since = cursor(held['since'])
  if (!work || !since) return null
  return { work, since, v: v as number }
}

/**
 * Ask one person for every list they publish — WI-23.E1. A cursor per list
 * this side already holds, by id; a list not named is asked from its start,
 * which is how a new list is discovered: the answer's pages name it.
 */
export interface ListsRequest {
  readonly since: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** Required, and at least 3: lists are a v3 log. */
  readonly v: number
}

/** `null` for a lists request this build will not answer. */
export function parseListsRequest(value: unknown): ListsRequest | null {
  const held = object(value)
  if (!held) return null
  if (!exactly(held, ['since', 'v'])) return null
  const v = held['v']
  if (!Number.isSafeInteger(v) || (v as number) < 3 || (v as number) > CIRCLE_VERSION.max) return null
  const named = object(held['since'])
  if (!named) return null
  const keys = Object.keys(named)
  if (keys.length > MAX_LISTS_PER_REQUEST) return null
  const since: Record<string, Readonly<Record<string, number>>> = {}
  for (const key of keys) {
    /* A list id is a minted `pub`: hex, and bounded. */
    if (!/^[0-9a-f]{1,64}$/u.test(key)) return null
    const one = cursor(named[key])
    if (!one) return null
    since[key] = one
  }
  return { since, v: v as number }
}

/** `null` for a shelf request this build will not answer. */
export function parseShelfRequest(value: unknown): ShelfRequest | null {
  const held = object(value)
  if (!held) return null
  /* A v1 build has no shelf at all — the log and its service are v2 — so a
     request naming v1, or naming no version, is refused rather than answered
     with a chain that carries no `shelf` entry. The version is required. */
  if (!exactly(held, ['since', 'v'])) return null
  const v = held['v']
  if (!Number.isSafeInteger(v) || (v as number) < 2 || (v as number) > CIRCLE_VERSION.max) return null
  const since = cursor(held['since'])
  if (!since) return null
  return { since, v: v as number }
}

/**
 * `null` for an answer this build will not read.
 *
 * ⚠️ **BOUNDED HERE, BEFORE A SINGLE PAGE IS PARSED.** `importLimits.ts` sets
 * the rule and names the failure: *a bound that runs after the read has not
 * bounded anything*. A peer answering with a hundred thousand pages, or one
 * page of forty megabytes, costs this side one length comparison.
 */
export function parsePagesAnswer(value: unknown): PagesAnswer | null {
  const parsed = pagesAnswer(value)
  /* Nothing in hand and more to come is an answer no fetch can act on: the
     loops stop on an empty page list, so `more` would be a promise nobody
     keeps. Refused as the malformed answer it is. */
  if (parsed !== null && parsed.pages.length === 0 && parsed.more) return null
  return parsed
}

function pagesAnswer(value: unknown): PagesAnswer | null {
  const held = object(value)
  if (!held || !exactly(held, ['pages', 'more'])) return null
  const { pages, more } = held
  if (typeof more !== 'boolean') return null
  if (!Array.isArray(pages) || pages.length > MAX_PAGES_PER_ANSWER) return null
  let chars = 0
  for (const page of pages) {
    if (typeof page !== 'string' || page.length > MAX_PAGE_CHARS) return null
    chars += page.length
    if (chars > MAX_ANSWER_CHARS) return null
  }
  return { pages: pages as readonly string[], more }
}

/**
 * What both sides can read, or `null` when they cannot talk.
 *
 * Separate from the parsers so a caller cannot answer a hello it could not
 * fulfil: the version is settled once, here, and carried in the welcome.
 */
export function agreedVersion(theirs: VersionRange): number | null {
  return negotiate(CIRCLE_VERSION, theirs)
}
