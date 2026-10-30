import { COVER_NAMES, isContentHash, parseCards, validMarks, type Card, type Mark } from '../../../kernel'
import { isHlc, type Hlc } from './clock'
import { fromWire } from './merge'
import type { BookRecord } from '../../../kernel'

/**
 * The star protocol's VOCABULARY — §2.5 of the mobile-sync plan as types
 * and validators. The messages here ride the peer envelope as `sync.*`
 * service calls; `ledger.ts` is the machine that speaks them. Everything
 * that crosses the wire is re-validated on arrival — the wire is a trust
 * boundary exactly as a file is — and everything invalid is answered with a
 * typed refusal before any state is written.
 *
 * One deliberate simplification against the plan's prose, stated: `hello`
 * is a SERVICE CALL (`sync.hello`), not a session-level frame. The plugin's
 * own session hello already carries and validates the ROLE both ways
 * (phase 7); this hello carries the sync-level facts — versions, epoch,
 * hubSeq, clock — and re-checks role as belt and braces, refusing with
 * `err {code: "unsupported"}` before anything is written, as §2.5 demands.
 */

export const SYNC_PROTO = 1
export const SYNC_JOURNAL_FORMAT = 1
/** The service version this build speaks: [min, max]. */
/*
 * BUMPED TO 2 WHEN BOOKMARKS JOINED THE MARKS FILE, and the reason is a silent
 * data loss rather than a new frame shape.
 *
 * A bookmark is a mark record with `kind: 'bookmark'` — no new field, no new
 * service, nothing a v1 parser would reject. That is exactly the problem. A v1
 * peer's `validMarks` drops rows whose kind it does not know, and then ACKS the
 * push; `applyAck` calls `journal.ack(book, 'marks', rev)`, which clears the
 * sender's outbox. The sender therefore records the bookmark as replicated and
 * never sends it again, and the bookmark exists on exactly one device with
 * nothing anywhere saying so.
 *
 * So the vocabulary widening is a version: `versionsOverlap([1,1], [2,2])` is
 * false, and a v1 peer is refused at the hello with a message naming both
 * versions. Refusing to sync is a bad outcome; syncing and quietly losing a
 * record is a worse one, and it is the one the reader cannot detect.
 */
/* [3, 3] since 2026-08-28: a push group now carries `live` (a restore's own
 * presence stamp), and the shelf refuses a stale record for a removed book by
 * INTENT rather than by comparing stamps — a v2 shelf, ignoring the unknown
 * field, would resurrect the book with a fresh clock (WI-20.1). The semantics
 * changed under the same wire shape, so the versions must not interoperate;
 * `versionsOverlap([2, 2], [3, 3])` is false and the hello is refused. */
/* [4, 4] since 2026-08-31 (WI-21.3): a book record now carries `identifier`
 * and `metaSchema`, both in the metadata group. The wire shape is unchanged and
 * a v3 peer would parse the row quite happily — which is exactly the failure
 * this constant exists for, and it is the bookmark case again, field for field.
 *
 * `parseRecord` is built from KNOWN FIELDS, so a v3 peer STRIPS both, ACKs the
 * stripped row, and `applyAck` clears the sender's outbox. The metadata group
 * merges on `parsedAt`, and an ACK carries the sender's own stamp back — so the
 * equal-stamp tie falls to the canonical serialisation and the stripped side
 * can win, ERASING THE SENDER'S OWN IDENTIFIER. The sender then records the
 * book as replicated and never sends it again.
 *
 * `versionsOverlap([3, 3], [4, 4])` is false and the hello is refused with a
 * message naming both versions. Refusing to sync is a bad outcome; syncing and
 * quietly losing a field is a worse one, and it is the one the reader cannot
 * detect. */
/* [5, 5] since 2026-09-03 (WI-23.B3): a book record now carries the reader's
 * own `status`, `rating`/`ratingAt` and `review`. The wire shape is unchanged
 * and a v4 peer parses the row happily — which is the bookmark case and the
 * identifier case again, field for field: `parseRecord` is built from KNOWN
 * FIELDS, so a v4 peer STRIPS all three, ACKs the stripped row, and the
 * equal-stamp ACK can erase the sender's own rating. `versionsOverlap([4, 4],
 * [5, 5])` is false and the hello is refused with a message naming both
 * versions. `merge.test.ts` keeps the erasure reproducible beside the
 * identifier's, as the evidence for why the bump was needed. */
export const SYNC_VERSION: readonly [number, number] = [5, 5]

/** The service names, and the grant each is gated on. */
export const SYNC_SERVICES = {
  hello: { name: 'sync.hello', grant: 'sync:pull' },
  push: { name: 'sync.push', grant: 'sync:push' },
  pull: { name: 'sync.pull', grant: 'sync:pull' },
  marks: { name: 'sync.marks', grant: 'sync:pull' },
  content: { name: 'sync.content', grant: 'sync:pull' },
} as const

export type SyncRole = 'shelf' | 'satchel'

export interface SyncHello {
  readonly proto: number
  readonly journalFormat: number
  readonly services: { readonly sync: readonly [number, number] }
  readonly device: string
  readonly role: SyncRole
  readonly clock: Hlc
}

export interface SyncWelcome {
  readonly clock: Hlc
  readonly epoch: string
  readonly hubSeq: number
  readonly journalFormat: number
  readonly services: { readonly sync: readonly [number, number] }
}

/** The kinds a push group may carry — the row-shaped ones. Content and
 *  cover move as BLOBS, never as push rows; `outboxGroups` filters them. */
export const PUSHABLE = ['record', 'marks', 'removed', 'cards'] as const
export type Pushable = (typeof PUSHABLE)[number]

export interface PushGroup {
  readonly book: string
  /** The outbox revs this group settles — echoed in the ack, CAS-acked. */
  readonly revs: Partial<Readonly<Record<Pushable, number>>>
  readonly record?: BookRecord
  /** Whole rows, tombstones included. */
  readonly marks?: readonly Mark[]
  readonly cards?: readonly Card[]
  readonly removed?: { readonly at: Hlc }
  /** A RESTORE'S presence stamp — the `live` half of the LWW pair, so the
   *  shelf can order the re-add against a removal it made independently. Set
   *  by `buildGroup` when the outbox holds a `removed` rev for a book whose
   *  register now says `live`. */
  readonly live?: { readonly at: Hlc }
  readonly hasContent: boolean
  readonly contentHash?: string
  readonly format?: string
  readonly size?: number
  /** The pusher's cover, so the shelf can blob-fetch it verified. */
  readonly cover?: { readonly name: string; readonly size: number; readonly hash: string }
}

export interface PushAck {
  readonly book: string
  readonly revs: Partial<Readonly<Record<Pushable, number>>>
  /** The MERGED record/marks as the shelf now holds them — applied by the
   *  satchel as a merge, never an assignment. */
  readonly record?: BookRecord
  readonly marks?: readonly Mark[]
}

export interface PullRequest {
  readonly since: number
  readonly until: number
  readonly limit?: number
  /** The satchel's cards digest, so the page carries cards only on change. */
  readonly cardsDigest?: string
}

export interface PullRow {
  readonly book: string
  readonly seq: number
  readonly record: BookRecord
  readonly hasContent: boolean
  readonly contentHash?: string
  readonly format?: string
  readonly size?: number
  readonly marksDigest?: string
  readonly coverAt?: number
}

export interface PullRemoval {
  readonly book: string
  readonly seq: number
  readonly at: Hlc
}

export interface PullPage {
  readonly rows: readonly PullRow[]
  readonly removals: readonly PullRemoval[]
  readonly cards?: readonly Card[]
  /** Persisted by the satchel AFTER the page is durably applied. */
  readonly nextSince: number
  readonly done: boolean
}

/** What `sync.content` answers: where the bytes are and how to verify them.
 *  `contentHash`/`size` may be empty/zero when the serving side cannot hash
 *  (no plugin) — the caller refuses to fetch unverified. The cover triple is
 *  present when a cover exists AND could be hashed. */
export interface ContentAnswer {
  readonly folder: string
  readonly name: string
  readonly size: number
  readonly contentHash: string
  readonly coverName: string | null
  readonly coverSize?: number
  readonly coverHash?: string
}

/* -------------------------------------------------------------- validation */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/* `isSafeInteger`, not `isInteger`: a sequence past 2^53 cannot be ordered or
 * incremented reliably, and a poisoned cursor persists (#WI-audit). */
const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A present-but-malformed optional is a MALFORMED MESSAGE, never "absent".
 *  `typeof x === 'string' ? use : skip` silently reinterpreted junk as a
 *  valid message with less in it — the quiet default this file exists to
 *  refuse. Absent stays allowed; wrong-typed present refuses the whole
 *  message. */
const BAD = Symbol('malformed')
const optString = (value: unknown): string | undefined | typeof BAD =>
  value === undefined ? undefined : typeof value === 'string' ? value : BAD
const optSize = (value: unknown): number | undefined | typeof BAD =>
  value === undefined ? undefined : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : BAD

function readVersions(value: unknown): readonly [number, number] | null {
  if (!isRecord(value)) return null
  const sync = value['sync']
  if (!Array.isArray(sync) || sync.length !== 2) return null
  const [min, max] = sync as [unknown, unknown]
  /* Finite nonnegative integers, or the range is meaningless: an infinite
   * bound overlaps every range and admits a malformed peer. */
  if (!isSeq(min) || !isSeq(max) || min > max) return null
  return [min, max]
}

/** Do two [min, max] ranges share a version? */
export function versionsOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1]
}

export function parseSyncHello(value: unknown): SyncHello | null {
  if (!isRecord(value)) return null
  const services = readVersions(value['services'])
  if (services === null) return null
  if (!Number.isSafeInteger(value['proto']) || (value['proto'] as number) < 0) return null
  if (!Number.isSafeInteger(value['journalFormat']) || (value['journalFormat'] as number) < 0) return null
  if (typeof value['device'] !== 'string' || value['device'] === '') return null
  if (value['role'] !== 'shelf' && value['role'] !== 'satchel') return null
  if (!isHlc(value['clock'])) return null
  return {
    proto: value['proto'] as number,
    journalFormat: value['journalFormat'] as number,
    services: { sync: services },
    device: value['device'],
    role: value['role'],
    clock: value['clock'],
  }
}

export function parseSyncWelcome(value: unknown): SyncWelcome | null {
  if (!isRecord(value)) return null
  const services = readVersions(value['services'])
  if (services === null) return null
  if (!isHlc(value['clock'])) return null
  if (typeof value['epoch'] !== 'string' || value['epoch'] === '') return null
  if (!isSeq(value['hubSeq'])) return null
  /* The same rule the hello applies: a format is a non-negative safe integer,
     and a welcome saying otherwise is a peer this side cannot talk to. */
  if (!isSeq(value['journalFormat'])) return null
  return {
    clock: value['clock'],
    epoch: value['epoch'],
    hubSeq: value['hubSeq'],
    journalFormat: value['journalFormat'],
    services: { sync: services },
  }
}

/** Marks off the wire: STRICT, never thinned. The file parser's rule — drop a
 *  bad row, keep the rest — is for a hand-editable file, where dropping the
 *  lot would let one bad row delete a highlight. On the wire the opposite
 *  holds: an accepted push is ACKED, the ack clears the sender's revision,
 *  and a silently dropped row is never sent again. `fetchMarks` (the pull
 *  side) has refused thinned answers since WI-20.25; this is the same rule
 *  at the push door. */
export function parseWireMarks(value: unknown): readonly Mark[] | null {
  if (!Array.isArray(value)) return null
  const rows = validMarks(value)
  return rows.length === value.length ? rows : null
}

/** Cards off the wire, through the kernel's own parser — STRICT like marks:
 *  a list the parser would thin (a malformed row, a duplicated id) refuses
 *  the message rather than acknowledging rows that were never applied. */
export function parseWireCards(value: unknown): readonly Card[] | null {
  if (!Array.isArray(value)) return null
  const rows = parseCards(JSON.stringify(value))
  return rows.length === value.length ? rows : null
}

/** The `revs` map both push shapes carry — one parser, so a validation
 *  change cannot land on one path and miss the other (#714). */
function parseRevs(value: unknown): Partial<Record<Pushable, number>> | null {
  if (!isRecord(value)) return null
  const revs: Partial<Record<Pushable, number>> = {}
  for (const what of PUSHABLE) {
    const rev = value[what]
    if (rev === undefined) continue
    if (!isSeq(rev) || rev < 1) return null
    revs[what] = rev
  }
  return revs
}

export function parsePushGroup(value: unknown): PushGroup | null {
  if (!isRecord(value)) return null
  // The cards group has no book; it travels as book "".
  if (typeof value['book'] !== 'string') return null
  const revs = parseRevs(value['revs'])
  if (revs === null || Object.keys(revs).length === 0) return null
  /* Required means REQUIRED (#333): a missing or wrong-typed `hasContent`
   * is a malformed message, not `false`. */
  if (typeof value['hasContent'] !== 'boolean') return null
  const out: {
    book: string
    revs: typeof revs
    hasContent: boolean
    record?: BookRecord
    marks?: readonly Mark[]
    cards?: readonly Card[]
    removed?: { at: Hlc }
    contentHash?: string
    format?: string
    size?: number
  } = {
    book: value['book'] as string,
    revs,
    hasContent: value['hasContent'],
  }
  if (value['record'] !== undefined) {
    const record = fromWire(value['record'])
    if (record === null) return null
    out.record = record
  }
  if (value['marks'] !== undefined) {
    const marks = parseWireMarks(value['marks'])
    if (marks === null) return null
    out.marks = marks
  }
  if (value['cards'] !== undefined) {
    const cards = parseWireCards(value['cards'])
    if (cards === null) return null
    out.cards = cards
  }
  if (value['removed'] !== undefined) {
    if (!isRecord(value['removed']) || !isHlc(value['removed']['at'])) return null
    out.removed = { at: value['removed']['at'] }
  }
  if (value['live'] !== undefined) {
    if (!isRecord(value['live']) || !isHlc(value['live']['at'])) return null
    ;(out as { live?: { at: Hlc } }).live = { at: value['live']['at'] }
  }
  const contentHash = optString(value['contentHash'])
  const format = optString(value['format'])
  const size = optSize(value['size'])
  if (contentHash === BAD || format === BAD || size === BAD) return null
  /* A pushed hash is checked before the record it rides on is applied, so a
     record never lands promising bytes the verified fetch will refuse — and a
     record that has no hash yet carries none, not an empty one. */
  if (contentHash !== undefined && !isContentHash(contentHash)) return null
  if (contentHash !== undefined) out.contentHash = contentHash
  if (format !== undefined) out.format = format
  if (size !== undefined) out.size = size
  if (value['cover'] !== undefined) {
    const cover = value['cover']
    if (
      !isRecord(cover) ||
      typeof cover['name'] !== 'string' ||
      /* The kernel's cover names — anything else is skipped on landing, so it is refused here. */
      !(COVER_NAMES as readonly string[]).includes(cover['name']) ||
      optSize(cover['size']) === BAD ||
      cover['size'] === undefined ||
      !isContentHash(cover['hash'])
    ) {
      return null
    }
    ;(out as { cover?: PushGroup['cover'] }).cover = { name: cover['name'], size: cover['size'] as number, hash: cover['hash'] }
  }
  /* REVISIONS CORRELATE WITH PAYLOADS (#59). A revision advertises state; the
   * ack clears it; a revision with nothing behind it is state that never
   * travels and can never be sent again. A record or marks rev may ride a
   * removal or a restore instead of its payload — the removal IS the news for
   * a trashed book — and a payload may travel WITHOUT its rev (a restore
   * re-sends the record under `revs.removed`). Cards live only in the
   * reserved `''` group, and that group carries nothing else. */
  const intent = out.removed !== undefined || (out as { live?: unknown }).live !== undefined
  if (revs.record !== undefined && out.record === undefined && !intent) return null
  if (revs.marks !== undefined && out.marks === undefined && !intent) return null
  if (revs.removed !== undefined && !intent) return null
  if (revs.cards !== undefined && (out.cards === undefined || out.book !== '')) return null
  if (out.cards !== undefined && out.book !== '') return null
  return out
}

export function parsePushAck(value: unknown): PushAck | null {
  if (!isRecord(value)) return null
  if (typeof value['book'] !== 'string') return null
  const revs = parseRevs(value['revs'])
  if (revs === null) return null
  const out: { book: string; revs: typeof revs; record?: BookRecord; marks?: readonly Mark[] } = {
    book: value['book'],
    revs,
  }
  if (value['record'] !== undefined) {
    const record = fromWire(value['record'])
    if (record === null) return null
    out.record = record
  }
  if (value['marks'] !== undefined) {
    const marks = parseWireMarks(value['marks'])
    if (marks === null) return null
    out.marks = marks
  }
  return out
}

export function parsePullRequest(value: unknown): PullRequest | null {
  if (!isRecord(value)) return null
  if (!isSeq(value['since']) || !isSeq(value['until'])) return null
  // An inverted window describes no cursor and would answer a backwards
  // `nextSince`; refused here rather than served nonsense (#716).
  if ((value['since'] as number) > (value['until'] as number)) return null
  const out: { since: number; until: number; limit?: number; cardsDigest?: string } = {
    since: value['since'],
    until: value['until'],
  }
  if (value['limit'] !== undefined) {
    if (!isSeq(value['limit']) || value['limit'] < 1) return null
    out.limit = value['limit']
  }
  const cardsDigest = optString(value['cardsDigest'])
  if (cardsDigest === BAD) return null
  if (cardsDigest !== undefined) out.cardsDigest = cardsDigest
  return out
}

export function parsePullPage(value: unknown): PullPage | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value['rows']) || !Array.isArray(value['removals'])) return null
  if (!isSeq(value['nextSince']) || typeof value['done'] !== 'boolean') return null
  const rows: PullRow[] = []
  for (const raw of value['rows'] as unknown[]) {
    if (!isRecord(raw) || !isSeq(raw['seq'])) return null
    if (typeof raw['book'] !== 'string' || raw['book'] === '') return null
    const record = fromWire(raw['record'])
    if (record === null) return null
    if (typeof raw['hasContent'] !== 'boolean') return null
    const rowHash = optString(raw['contentHash'])
    const rowFormat = optString(raw['format'])
    const rowSize = optSize(raw['size'])
    const rowMarksDigest = optString(raw['marksDigest'])
    const rowCoverAt = optSize(raw['coverAt'])
    if (rowHash === BAD || rowFormat === BAD || rowSize === BAD || rowMarksDigest === BAD || rowCoverAt === BAD) return null
    /* A present hash is a BLAKE3 digest, as a push group's and a content
       answer's must be — a pull row was the one message that took any
       string, and handed the ledger a `PullPage` the other parsers would
       have refused. */
    if (rowHash !== undefined && !isContentHash(rowHash)) return null
    rows.push({
      book: raw['book'],
      seq: raw['seq'],
      record,
      hasContent: raw['hasContent'],
      ...(rowHash !== undefined ? { contentHash: rowHash } : {}),
      ...(rowFormat !== undefined ? { format: rowFormat } : {}),
      ...(rowSize !== undefined ? { size: rowSize } : {}),
      ...(rowMarksDigest !== undefined ? { marksDigest: rowMarksDigest } : {}),
      ...(rowCoverAt !== undefined ? { coverAt: rowCoverAt } : {}),
    })
  }
  const removals: PullRemoval[] = []
  for (const raw of value['removals'] as unknown[]) {
    if (!isRecord(raw) || typeof raw['book'] !== 'string' || raw['book'] === '' || !isSeq(raw['seq']) || !isHlc(raw['at'])) return null
    removals.push({ book: raw['book'], seq: raw['seq'], at: raw['at'] })
  }
  /* ONE JOURNAL POSITION, ONE OPERATION. A row and a removal — or two rows —
     at the same seq would apply contradictory work and then advance the
     cursor past both; a page that says so is refused whole. */
  const seen = new Set<number>()
  for (const { seq } of [...rows, ...removals]) {
    if (seen.has(seq)) return null
    seen.add(seq)
  }
  let cards: readonly Card[] | undefined
  if (value['cards'] !== undefined) {
    const parsed = parseWireCards(value['cards'])
    if (parsed === null) return null
    cards = parsed
  }
  return {
    rows,
    removals,
    ...(cards === undefined ? {} : { cards }),
    nextSince: value['nextSince'],
    done: value['done'],
  }
}

/* The cover names and the digest rule are the KERNEL's — `COVER_NAMES` and
   `isContentHash` — not restated here. This file, `coverCache.ts` and
   `ledger.ts` each carried a copy of the two names, and this one carried its
   own copy of the digest pattern; a name added to the kernel's set, or a
   digest rule tightened there, would have left parsing, caching and landing
   disagreeing with the record they serve. */

export function parseContentAnswer(value: unknown): ContentAnswer | null {
  if (!isRecord(value)) return null
  if (typeof value['folder'] !== 'string' || typeof value['name'] !== 'string') return null
  /* A size is a count of bytes and a hash is a BLAKE3 digest: both feed the
     verified transfer, and a NaN or a string of the wrong length would fail
     there with a worse message, or not at all. */
  if (!Number.isSafeInteger(value['size']) || (value['size'] as number) < 0) return null
  /* EMPTY IS THE DOCUMENTED "COULD NOT HASH" ANSWER — a shelf with no plugin
     and no stored hash still answers, and the caller refuses to fetch bytes
     it cannot verify. Anything else must be a digest. */
  if (typeof value['contentHash'] !== 'string' || (value['contentHash'] !== '' && !isContentHash(value['contentHash']))) return null
  const coverName = value['coverName']
  if (coverName !== null && typeof coverName !== 'string') return null
  /* The cover's facts are one tuple: all three present and well-formed, or
     none. A cover with a name and no readable size is not "a cover with no
     usable facts", it is an answer this build does not accept. */
  const coverSize = value['coverSize']
  const coverHash = value['coverHash']
  const coverFacts = coverSize !== undefined || coverHash !== undefined
  if (coverFacts) {
    if (coverName === null) return null
    if (!Number.isSafeInteger(coverSize) || (coverSize as number) < 0) return null
    if (!isContentHash(coverHash)) return null
  }
  return {
    folder: value['folder'],
    name: value['name'],
    size: value['size'] as number,
    contentHash: value['contentHash'],
    coverName: coverName as string | null,
    ...(coverFacts ? { coverSize: coverSize as number, coverHash: coverHash as string } : {}),
  }
}
