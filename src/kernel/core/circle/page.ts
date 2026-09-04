import { canonicalJson } from '../canonicalJson'
import { isHlc } from '../hlc'
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

/**
 * The newest wire version this build publishes — WI-23.B2.
 *
 * | Version | What a page may carry |
 * |---|---|
 * | 1 | `share`, `unshare` — passages only |
 * | 2 | …and `status`, `rate`, `tag`, `review`, `unreview` — the book |
 *
 * ⚠️ **A v1 PEER IS SERVED v1 PAGES, FILTERED BEFORE PAGINATION, AND THAT IS
 * NOT AN OPTIMISATION.** Page boundaries are sealed when first served and never
 * move (`publish.ts`, `SealedPage`). A page sealed for a v2 peer and later
 * served to a v1 peer with the v2 entries stripped is a DIFFERENT page —
 * different bytes, different hash — under a boundary claiming to be the same
 * one. So the v1 chain and the v2 chain are two chains, sealed separately, and
 * `carriedBy` is the filter each is built through.
 */
export const WIRE_VERSION = 3

/** What a peer can speak. Exchanged in the hello, before any page. */
export interface VersionRange {
  readonly min: number
  readonly max: number
}

/** Both versions are read and published; a v1 peer negotiates 1 and is served it. */
export const SUPPORTED: VersionRange = { min: 1, max: WIRE_VERSION }

/** The ops each version's pages may carry. Every version carries its predecessor's. */
const OPS_BY_VERSION: Readonly<Record<number, ReadonlySet<Entry['op']>>> = {
  1: new Set<Entry['op']>(['share', 'unshare']),
  2: new Set<Entry['op']>(['share', 'unshare', 'status', 'rate', 'tag', 'review', 'unreview', 'shelf', 'unshelf']),
  /* v3 — WI-23.E1: the five list ops, on a list's own log. A v2 peer never
     asks for a list, so nothing is stripped; the version says what a peer
     can PARSE, and a v2 build cannot parse `place`. */
  3: new Set<Entry['op']>([
    'share',
    'unshare',
    'status',
    'rate',
    'tag',
    'review',
    'unreview',
    'shelf',
    'unshelf',
    'create',
    'retitle',
    'place',
    'remove',
    'delete',
  ]),
}

/**
 * Whether a version's page may carry this entry.
 *
 * A version this module does not know carries nothing: a publisher asked for
 * v3 by a build that only knows v2 has no v3 chain to serve, and an empty page
 * is what a chain nobody can build looks like. `negotiate` keeps that from
 * being asked in the first place.
 */
export function carriedBy(version: number, entry: Entry): boolean {
  return OPS_BY_VERSION[version]?.has(entry.op) ?? false
}

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
  /* An array is an object whose values are its elements, so one branch walks
     both — a separate array branch was a second spelling of this one. */
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

/** The most a single page may be, in characters of canonical JSON — the frame's cap. */
export const MAX_PAGE_CHARS = 512 * 1024

/** The most entries one page may carry — a bound on the work a signed page can ask for. */
export const MAX_ENTRIES_PER_PAGE = 4_096

export type PageRefusal =
  | 'version'
  | 'not-canonical'
  | 'non-integer'
  | 'bad-signature'
  | 'chain'
  | 'too-large'
  /** Not the shape of a page, or of an entry — refused before anything is verified. */
  | 'malformed'
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
/** The entry kinds a page may carry — the newest version's set, which holds every older one's. */
const OPS: ReadonlySet<string> = OPS_BY_VERSION[WIRE_VERSION]!

/**
 * The fields each kind carries beyond its stamp — EXACTLY these.
 *
 * ⚠️ **A FIELD THE KIND DOES NOT NAME IS REFUSED, not ignored.** The type
 * says an `unshare` carries no passage and an `unreview` no text — that is
 * the disclosure rule — and a validator that only looked for the fields it
 * wanted let a page carry the forbidden ones alongside, signed, into every
 * recipient's file.
 */
const STAMP = ['op', 'device', 'seq', 'at'] as const
const FIELDS: Readonly<Record<Entry['op'], readonly string[]>> = {
  share: ['pub', 'passage'],
  unshare: ['pub'],
  status: ['state'],
  rate: ['stars'],
  tag: ['tags'],
  review: ['pub', 'text'],
  unreview: ['pub'],
  shelf: ['pub', 'work'],
  unshelf: ['pub'],
  create: ['title'],
  retitle: ['title'],
  place: ['pub', 'work', 'position', 'note'],
  remove: ['pub'],
  // Stryker disable next-line ArrayDeclaration: a field name no delete carries can never be presented, so nothing can tell the difference.
  delete: [],
}
const PASSAGE_FIELDS = new Set(['quote', 'prefix', 'suffix', 'chapter', 'note'])
const WORK_FIELDS = new Set(['title', 'author', 'language', 'identifier', 'cover'])
const CLAIM_FIELDS = new Set(['ids', 'titles', 'author', 'language'])
const PAGE_FIELDS = new Set(['v', 'person', 'work', 'device', 'from', 'to', 'prevPageHash', 'entries', 'roster', 'revocations', 'delegation', 'sig'])

// Stryker disable next-line ConditionalExpression: a non-object that passes this has no keys the field sets allow and no fields of its own, so every check after it refuses it anyway.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => Object.keys(value).every((key) => allowed.has(key))
const isStrings = (value: unknown, most: number): value is readonly string[] =>
  Array.isArray(value) && value.length <= most && value.every((one) => typeof one === 'string')
const isWork = (value: unknown): boolean => {
  if (!isObject(value) || !hasOnly(value, WORK_FIELDS)) return false
  const named = value
  return (
    typeof named['title'] === 'string' &&
    typeof named['author'] === 'string' &&
    typeof named['language'] === 'string' &&
    (named['identifier'] === undefined || typeof named['identifier'] === 'string') &&
    /* A cover is a DIGEST the recipient fetches by (WI-23.C5) — not text, and not a path. */
    // Stryker disable next-line ConditionalExpression: a non-string never matches the digest pattern; the type check spells out what the pattern already refuses.
    (named['cover'] === undefined || (typeof named['cover'] === 'string' && COVER_DIGEST.test(named['cover'])))
  )
}

/** BLAKE3, hex — what a cover on a shelf entry is. */
const COVER_DIGEST = /^[0-9a-f]{64}$/u

/**
 * Whether a value has the shape of an entry — the right fields for its kind,
 * of the right types. Bounds that matter to a recipient are checked here too:
 * a passage is four strings and a note, a tag list is a list of strings.
 */
export function isEntryShape(value: unknown): value is Entry {
  if (!isObject(value)) return false
  const e = value
  /* A stamp is an HLC, spelled as one: a page stamping its entries with anything else folds them somewhere no honest log would. */
  if (typeof e['device'] !== 'string' || typeof e['seq'] !== 'number' || !isHlc(e['at'])) return false
  // Stryker disable next-line ConditionalExpression: an op that is not a string is not in OPS either, so the second clause refuses it alone.
  if (typeof e['op'] !== 'string' || !OPS.has(e['op'])) return false
  if (!hasOnly(e, new Set([...STAMP, ...FIELDS[e['op'] as Entry['op']]]))) return false
  const pub = e['pub']
  switch (e['op']) {
    case 'share': {
      const passage = e['passage']
      if (!isObject(passage) || !hasOnly(passage, PASSAGE_FIELDS)) return false
      return (
        typeof pub === 'string' &&
        pub !== '' &&
        ['quote', 'prefix', 'suffix', 'chapter'].every((key) => typeof passage[key] === 'string') &&
        (passage['note'] === undefined || typeof passage['note'] === 'string')
      )
    }
    case 'unshare':
    case 'unreview':
    case 'unshelf':
    case 'remove':
      return typeof pub === 'string' && pub !== ''
    case 'status':
      return e['state'] === 'want' || e['state'] === 'reading' || e['state'] === 'finished'
    case 'rate':
      return e['stars'] === 1 || e['stars'] === 2 || e['stars'] === 3 || e['stars'] === 4 || e['stars'] === 5
    case 'tag':
      return isStrings(e['tags'], 256)
    case 'review':
      return typeof pub === 'string' && pub !== '' && typeof e['text'] === 'string'
    case 'shelf':
      return typeof pub === 'string' && pub !== '' && isWork(e['work'])
    case 'create':
    case 'retitle':
      return typeof e['title'] === 'string'
    case 'place':
      return typeof pub === 'string' && pub !== '' && isWork(e['work']) && typeof e['position'] === 'number' && typeof e['note'] === 'string'
    case 'delete':
      return true
    // Stryker disable all: an op outside OPS was refused above, so no value reaches this arm; it is the type's exhaustiveness, not a branch.
    default:
      return false
    // Stryker restore all
  }
}

/**
 * Whether a parsed value has the shape of a page: every field present, of its
 * type, with a claim and entries that are what they say. Checked BEFORE the
 * claim is matched or the signature verified, so a hostile page cannot make
 * this side throw inside `matchWork` or fold an entry with the wrong fields.
 */
export function isPageShape(value: unknown): value is Page {
  if (!isObject(value) || !hasOnly(value, PAGE_FIELDS)) return false
  const page = value
  const work = page['work']
  if (!isObject(work) || !hasOnly(work, CLAIM_FIELDS) || !isStrings(work['ids'], 64) || !isStrings(work['titles'], 64)) return false
  if (typeof work['author'] !== 'string' || typeof work['language'] !== 'string') return false
  const entries = page['entries']
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES_PER_PAGE || !entries.every(isEntryShape)) return false
  /* Numbers, not integers: whether a number is a safe integer is
     `integersOnly`'s question, refused under its own name. */
  return (
    typeof page['v'] === 'number' &&
    typeof page['person'] === 'string' &&
    typeof page['device'] === 'string' &&
    typeof page['from'] === 'number' &&
    typeof page['to'] === 'number' &&
    typeof page['prevPageHash'] === 'string' &&
    isStrings(page['roster'], 256) &&
    typeof page['revocations'] === 'number' &&
    typeof page['delegation'] === 'string' &&
    typeof page['sig'] === 'string'
  )
}

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
  if (received.length > MAX_PAGE_CHARS) return 'too-large'
  if (page.prevPageHash !== expectedPrev) return 'chain'
  /* The entries are the page's own: this device's, within the range the page
     names. A signed page that says otherwise lies about what it carries, and
     the cursor it would advance would be wrong. After the chain check, so a
     gap reads as a gap; before the signature, which is the expensive step. */
  if (page.from < 1 || page.to < page.from) return 'malformed'
  if (!page.entries.every((entry) => entry.device === page.device && entry.seq >= page.from && entry.seq <= page.to)) return 'malformed'
  /* And each entry is one the page's OWN version carries: a v1 page holding
     a `status` was checked against the negotiated number and never against
     what the number allows, so a v1 peer could be handed v2 kinds inside a
     page it had agreed to. */
  if (!page.entries.every((entry) => carriedBy(page.v, entry))) return 'malformed'
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
    /* The comma is charged only between entries: a JSON list of n has n − 1. */
    // Stryker disable next-line EqualityOperator: charging the comma on the first entry instead of each one after it moves one character between two entries whose sum is what is measured.
    const cost = canonicalJson(entry).length + (current.length > 0 ? 1 : 0)
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
