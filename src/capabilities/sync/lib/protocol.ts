import { parseCards, validMarks, type Card, type Mark } from '../../../kernel'
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
export const SYNC_VERSION: readonly [number, number] = [3, 3]

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

export interface MarksAnswer {
  readonly book: string
  readonly marks: readonly Mark[]
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

const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

function readVersions(value: unknown): readonly [number, number] | null {
  if (!isRecord(value)) return null
  const sync = value['sync']
  if (!Array.isArray(sync) || sync.length !== 2) return null
  const [min, max] = sync as [unknown, unknown]
  if (typeof min !== 'number' || typeof max !== 'number' || min > max) return null
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
  if (typeof value['proto'] !== 'number' || typeof value['journalFormat'] !== 'number') return null
  if (typeof value['device'] !== 'string' || value['device'] === '') return null
  if (value['role'] !== 'shelf' && value['role'] !== 'satchel') return null
  if (!isHlc(value['clock'])) return null
  return {
    proto: value['proto'],
    journalFormat: value['journalFormat'],
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
  if (typeof value['journalFormat'] !== 'number') return null
  return {
    clock: value['clock'],
    epoch: value['epoch'],
    hubSeq: value['hubSeq'],
    journalFormat: value['journalFormat'],
    services: { sync: services },
  }
}

/** Marks off the wire: whole rows, stamps kept, everything else refused row
 *  by row through the same validation a file gets. */
export function parseWireMarks(value: unknown): readonly Mark[] | null {
  if (!Array.isArray(value)) return null
  return validMarks(value)
}

/** Cards off the wire, through the kernel's own parser. */
export function parseWireCards(value: unknown): readonly Card[] | null {
  if (!Array.isArray(value)) return null
  return parseCards(JSON.stringify(value))
}

export function parsePushGroup(value: unknown): PushGroup | null {
  if (!isRecord(value)) return null
  // The cards group has no book; it travels as book "".
  if (typeof value['book'] !== 'string') return null
  if (!isRecord(value['revs'])) return null
  const revs: Partial<Record<Pushable, number>> = {}
  for (const what of PUSHABLE) {
    const rev = (value['revs'] as Record<string, unknown>)[what]
    if (rev === undefined) continue
    if (!isSeq(rev) || rev < 1) return null
    revs[what] = rev
  }
  if (Object.keys(revs).length === 0) return null
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
    hasContent: value['hasContent'] === true,
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
  if (typeof value['contentHash'] === 'string') out.contentHash = value['contentHash']
  if (typeof value['format'] === 'string') out.format = value['format']
  if (typeof value['size'] === 'number') out.size = value['size']
  if (value['cover'] !== undefined) {
    const cover = value['cover']
    if (
      !isRecord(cover) ||
      typeof cover['name'] !== 'string' ||
      typeof cover['size'] !== 'number' ||
      typeof cover['hash'] !== 'string'
    ) {
      return null
    }
    ;(out as { cover?: PushGroup['cover'] }).cover = { name: cover['name'], size: cover['size'], hash: cover['hash'] }
  }
  return out
}

export function parsePushAck(value: unknown): PushAck | null {
  if (!isRecord(value)) return null
  if (typeof value['book'] !== 'string') return null
  if (!isRecord(value['revs'])) return null
  const revs: Partial<Record<Pushable, number>> = {}
  for (const what of PUSHABLE) {
    const rev = (value['revs'] as Record<string, unknown>)[what]
    if (rev === undefined) continue
    if (!isSeq(rev) || rev < 1) return null
    revs[what] = rev
  }
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
  const out: { since: number; until: number; limit?: number; cardsDigest?: string } = {
    since: value['since'],
    until: value['until'],
  }
  if (value['limit'] !== undefined) {
    if (!isSeq(value['limit']) || value['limit'] < 1) return null
    out.limit = value['limit']
  }
  if (typeof value['cardsDigest'] === 'string') out.cardsDigest = value['cardsDigest']
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
    rows.push({
      book: raw['book'],
      seq: raw['seq'],
      record,
      hasContent: raw['hasContent'] === true,
      ...(typeof raw['contentHash'] === 'string' ? { contentHash: raw['contentHash'] } : {}),
      ...(typeof raw['format'] === 'string' ? { format: raw['format'] } : {}),
      ...(typeof raw['size'] === 'number' ? { size: raw['size'] } : {}),
      ...(typeof raw['marksDigest'] === 'string' ? { marksDigest: raw['marksDigest'] } : {}),
      ...(typeof raw['coverAt'] === 'number' ? { coverAt: raw['coverAt'] } : {}),
    })
  }
  const removals: PullRemoval[] = []
  for (const raw of value['removals'] as unknown[]) {
    if (!isRecord(raw) || typeof raw['book'] !== 'string' || !isSeq(raw['seq']) || !isHlc(raw['at'])) return null
    removals.push({ book: raw['book'], seq: raw['seq'], at: raw['at'] })
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

export function parseMarksAnswer(value: unknown): MarksAnswer | null {
  if (!isRecord(value) || typeof value['book'] !== 'string') return null
  const marks = parseWireMarks(value['marks'])
  if (marks === null) return null
  return { book: value['book'], marks }
}

export function parseContentAnswer(value: unknown): ContentAnswer | null {
  if (!isRecord(value)) return null
  if (typeof value['folder'] !== 'string' || typeof value['name'] !== 'string') return null
  if (typeof value['size'] !== 'number' || typeof value['contentHash'] !== 'string') return null
  const coverName = value['coverName']
  if (coverName !== null && typeof coverName !== 'string') return null
  return {
    folder: value['folder'],
    name: value['name'],
    size: value['size'],
    contentHash: value['contentHash'],
    coverName: coverName as string | null,
    ...(typeof value['coverSize'] === 'number' ? { coverSize: value['coverSize'] } : {}),
    ...(typeof value['coverHash'] === 'string' ? { coverHash: value['coverHash'] } : {}),
  }
}
