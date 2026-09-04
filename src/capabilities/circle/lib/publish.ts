import { MAX_ANSWER_CHARS } from './protocol'
import {
  READING_STATES,
  STARS,
  WIRE_VERSION,
  atomicWrite,
  canonicalJson,
  carriedBy,
  compareEntries,
  paginate,
  sharedPathIn,
  signedBytes,
  type Entry,
  type Hlc,
  type Page,
  type Passage,
  type ReadingState,
  type Stars,
  type VaultFs,
  type WorkClaim,
  type WriteQueue,
  isHlc,
} from '../../../kernel'
import { MAX_PAGES_PER_ANSWER, MAX_PAGE_CHARS } from './protocol'
import type { LaneFor } from './store'

/**
 * What this reader has published, and the pages that serve it — WI-22.C1/C4.
 *
 * ## The store carries a SNAPSHOT, not a pointer
 *
 * ⚠️ **THE ROW WAS `{ markId, sharedAt, withNote }` — A POINTER INTO THE
 * READER'S OWN MARKS — AND `wire.md` REFUSES IT.** Edit the note, delete the
 * mark, restart, and the page that was already served cannot be reproduced: the
 * quote and the note are gone, so the signature on a page a friend still holds
 * can never be checked again.
 *
 * A copy, and the duplication is the point. It is also the correct semantics:
 * you published that text. Editing your note afterwards changes what you think,
 * not what you said — and a signed entry cannot be rewritten in place, so the
 * wire already treats a later edit as a new publication.
 *
 * `markId` stays so the reader's own UI can say *"this mark is shared"*, and
 * nothing on the serving path reads through it.
 *
 * ## `pub` is minted per SHARE, not per mark
 *
 * ⚠️ `share(P), share(P), unshare(P)` has to be three unambiguous entries: two
 * publications and a withdrawal naming exactly one of them. With one id per
 * mark the receiver cannot tell which, because there is nothing to name.
 */

/** One thing this reader published, kept whole. */
export interface Publication {
  /** The publication id — minted per share, never reused. */
  readonly pub: string
  /** The reader's own mark, so their UI can say "shared". Never served. */
  readonly markId: string
  /** The device that published it; the sequence is per device. */
  readonly device: string
  readonly seq: number
  readonly at: Hlc
  /** What was published, copied. See the module header. */
  readonly passage: Passage
  /** The withdrawal, when there is one. Its own sequence and stamp. */
  readonly unshared?: { readonly seq: number; readonly at: Hlc }
}

/**
 * A page this device has already emitted, by the sequence range it covers.
 *
 * ⚠️ **A PAGE IS IMMUTABLE ONCE EMITTED, AND RE-PAGINATING BREAKS EVERY
 * RECIPIENT'S CHAIN.** `paginate` fills greedily from the start of the log, so
 * a log of two entries yields the page `[e1, e2]` and a log of three yields
 * `[e1, e2, e3]` — a DIFFERENT first page, with different bytes and a different
 * hash. Every recipient holding the old one then refuses the next page with
 * `chain`, and the symptom is a friend who stops receiving anything after their
 * third passage, for ever, with nothing anywhere saying why.
 *
 * So the boundary is decided ONCE, when the page is first served, and written
 * down. This is what `wire.md` means by *"an append-only signed log must be
 * able to reproduce its own past pages byte for byte"* — the entries alone are
 * not enough, because the entries do not say where the pages ended.
 */
export interface SealedPage {
  readonly device: string
  readonly from: number
  readonly to: number
  /**
   * Which chain this boundary belongs to — WI-23.B2.
   *
   * ⚠️ **THE v1 CHAIN AND THE v2 CHAIN ARE TWO CHAINS.** A v1 page is the
   * log with the book-level kinds filtered out BEFORE pagination, so its
   * boundaries fall in different places from the v2 chain's and its bytes
   * are different bytes. One list of boundaries with no `v` would hand a v1
   * peer a v2 boundary — and the page served under it would not be the page
   * that boundary was sealed for. `readShared` refuses a boundary without one.
   */
  readonly v: number
  /**
   * What the page was signed WITH when it was first served — the roster, the
   * revocation version and the delegation of that moment.
   *
   * ⚠️ **A SEALED PAGE REBUILT WITH TODAY'S ROSTER IS A DIFFERENT PAGE.** The
   * roster, `revocations` and `delegation` are signed into the page, so a
   * device paired after the page was served changes its bytes, its hash, and
   * with it the `prevPageHash` every later page carries — and every recipient
   * holding the old page refuses the next one with `chain`, for ever. Kept
   * beside the boundary so the page reproduces byte for byte. Absent on a
   * boundary sealed before this was recorded, which rebuilds with the current
   * values as it always did.
   */
  readonly roster?: readonly string[]
  readonly revocations?: number
  readonly delegation?: string
  /** The claim the page was signed under — a book whose metadata changed since would name a different one. */
  readonly work?: WorkClaim
}

/** What every published row carries: which stream, where in it, and when. */
interface PublishedRow {
  readonly device: string
  readonly seq: number
  readonly at: Hlc
}

/**
 * A register the reader published about the BOOK — WI-23.B2's substrate for
 * WI-23.B4. One row per publication of it; the newest stamp is what a
 * recipient folds to, and the older rows stay because the pages that carried
 * them must reproduce.
 */
export type OpinionRow =
  | (PublishedRow & { readonly op: 'status'; readonly state: ReadingState })
  | (PublishedRow & { readonly op: 'rate'; readonly stars: Stars })
  | (PublishedRow & { readonly op: 'tag'; readonly tags: readonly string[] })

/** A review the reader published, kept whole, with its withdrawal if any. */
export interface ReviewRow extends PublishedRow {
  readonly pub: string
  /** What was published, copied — the same snapshot rule as `Publication`. */
  readonly text: string
  readonly unreviewed?: { readonly seq: number; readonly at: Hlc }
}

/** This reader's publications for one book, and the pages already served. */
export interface SharedFile {
  readonly publications: readonly Publication[]
  /** In emission order, per device. See [`SealedPage`]. */
  readonly sealed: readonly SealedPage[]
  /** What the reader published about the book itself — v2 entries. */
  readonly opinions: readonly OpinionRow[]
  readonly reviews: readonly ReviewRow[]
  /**
   * The per-book control — WI-23.B4: *"Share what I think of this book with
   * my circle."* On, the reader's status, rating, review and tags are
   * published as entries and re-published as they change; off, nothing is,
   * and what was already published STAYS published — turning it off is not
   * a withdrawal, because a withdrawal is its own act with its own copy.
   *
   * ⚠️ **HERE, NOT ON THE RECORD.** `wire.md` refuses a `published` flag on a
   * mark because it *"would ride the existing sync for free"* and send a
   * social fact to every one of the reader's own devices whether they take
   * part or not. The same line holds for the switch: it is what this device
   * publishes, and it lives with what this device published.
   */
  readonly publishOpinion: boolean
}

/** Nothing published from this book, which is true of almost every book. */
export const NOTHING_PUBLISHED: SharedFile = {
  publications: [],
  sealed: [],
  opinions: [],
  reviews: [],
  publishOpinion: false,
}

/**
 * What this reader has published of one book.
 *
 * THROWS on a malformed file, for the reason `readForeign` does: reading it as
 * "nothing published" would mint sequence numbers already used, and two
 * different entries at one `(device, seq)` is a log a recipient must refuse
 * for ever.
 */
export async function readShared(fs: VaultFs, bookId: string): Promise<SharedFile> {
  const path = sharedPathIn(bookId)
  if (!(await fs.exists(path))) return NOTHING_PUBLISHED
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await fs.readFile(path)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`shared file for ${bookId} is not a publisher's store`)
  }
  const held = parsed as Record<string, unknown>
  const rows = held['publications']
  if (!Array.isArray(rows) || !rows.every(isPublication)) {
    throw new Error(`shared file for ${bookId} has no publication list`)
  }
  /* ⚠️ **PAGE BOUNDARIES THAT WILL NOT READ THROW TOO.** Reading them as "none
   * sealed yet" re-paginates from the start, which changes the bytes of pages
   * every recipient already holds — and breaks their chains permanently. */
  const sealed = held['sealed']
  if (!Array.isArray(sealed) || !sealed.every(isSealed)) {
    throw new Error(`shared file for ${bookId} has no page boundaries`)
  }
  /* ABSENT IS EMPTY, MALFORMED THROWS. A file written before the book-level
   * rows existed holds none, and reading it as none loses nothing — no
   * sequence number was ever minted for a row that is not there. A list that
   * is present and will not read is the other case: rows with sequences the
   * chain has served, and reading them as none would mint those again. */
  /* `undefined` is absent; `null` is a value, and not a list. */
  const opinions = held['opinions'] === undefined ? [] : held['opinions']
  if (!Array.isArray(opinions) || !opinions.every(isOpinion)) {
    throw new Error(`shared file for ${bookId} has an opinion list that will not read`)
  }
  const reviews = held['reviews'] === undefined ? [] : held['reviews']
  if (!Array.isArray(reviews) || !reviews.every(isReview)) {
    throw new Error(`shared file for ${bookId} has a review list that will not read`)
  }
  /* Absent is OFF — the default the design requires of a disclosure switch.
     Present and not a boolean is a file that will not read. */
  const publishOpinion = held['publishOpinion'] === undefined ? false : held['publishOpinion']
  if (typeof publishOpinion !== 'boolean') {
    throw new Error(`shared file for ${bookId} has a publish switch that will not read`)
  }
  const file: SharedFile = { publications: rows, sealed, opinions, reviews, publishOpinion }
  /* Checked as the LOG it serves: a reused `(device, seq)` would let `bySeq`
     keep one entry and drop the other silently, and boundaries out of chain
     order would rebuild a chain nobody holds. */
  if (reusesSequence(logOf(file))) throw new Error(`shared file for ${bookId} reuses a sequence`)
  if (!boundariesInOrder(sealed)) throw new Error(`shared file for ${bookId} has page boundaries out of order`)
  return file
}

function isPublishedRow(value: unknown): value is PublishedRow & Record<string, unknown> {
  /* Stryker disable next-line ConditionalExpression: as `isPublication` — a
     non-object has no `device` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  /* A stamp is an HLC and a sequence a position on the device's log, from 1:
     a row saying otherwise is signed into a page every recipient refuses. */
  return typeof row['device'] === 'string' && row['device'] !== '' && Number.isSafeInteger(row['seq']) && (row['seq'] as number) >= 1 && isHlc(row['at'])
}

const STAMP_FIELDS = ['op', 'device', 'seq', 'at']
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key))

/** The most tags one register carries — the wire's own bound (`isEntryShape`). */
export const MAX_TAGS = 256

function isOpinion(value: unknown): value is OpinionRow {
  if (!isPublishedRow(value)) return false
  /* Membership in a closed set is the whole check: a state or a star count
     that is not one of the listed values fails it whatever its type. And
     EXACTLY the kind's fields: a row is its entry, so a field the wire does
     not name would ride into a page the wire refuses. */
  if (value['op'] === 'status') return hasOnly(value, [...STAMP_FIELDS, 'state']) && (READING_STATES as readonly unknown[]).includes(value['state'])
  if (value['op'] === 'rate') return hasOnly(value, [...STAMP_FIELDS, 'stars']) && (STARS as readonly unknown[]).includes(value['stars'])
  return (
    value['op'] === 'tag' &&
    hasOnly(value, [...STAMP_FIELDS, 'tags']) &&
    Array.isArray(value['tags']) &&
    value['tags'].length <= MAX_TAGS &&
    value['tags'].every((one) => typeof one === 'string')
  )
}

function isReview(value: unknown): value is ReviewRow {
  if (!isPublishedRow(value)) return false
  if (!hasOnly(value, ['pub', 'text', 'device', 'seq', 'at', 'unreviewed'])) return false
  if (typeof value['pub'] !== 'string' || value['pub'] === '' || typeof value['text'] !== 'string') return false
  return isWithdrawal(value['unreviewed'], value['seq'] as number)
}

/**
 * Whether a file's boundaries are in chain order: per device and version,
 * each boundary starts after the one before it ends. Boundaries are replayed
 * in file order to rebuild the chain, so a reordered or overlapping pair
 * would rebuild a chain no recipient holds.
 */
export function boundariesInOrder(sealed: readonly SealedPage[]): boolean {
  const last = new Map<string, number>()
  for (const one of sealed) {
    const key = `${one.device}:${one.v}`
    if (one.from <= (last.get(key) ?? 0)) return false
    last.set(key, one.to)
  }
  return true
}

/** Every `(device, seq)` a log holds is one position, held once — tombstones included. */
export function reusesSequence(log: readonly Entry[]): boolean {
  const held = new Set<string>()
  for (const entry of log) {
    const key = `${entry.device}:${entry.seq}`
    if (held.has(key)) return true
    held.add(key)
  }
  return false
}

/**
 * A page boundary as every publisher store keeps it — the shelf's and the
 * lists' included, so the three files cannot drift in what they accept.
 *
 * A range runs from a first sequence of at least 1 to a last one no earlier
 * than it, on a chain version of at least 1: a reversed or negative range
 * would rebuild an empty page or loop over sequences no log has.
 */
export function isSealedPage(value: unknown): value is SealedPage {
  /* Stryker disable next-line ConditionalExpression: as `isPublication` — a
     non-object has no `device` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const from = row['from']
  const to = row['to']
  const v = row['v']
  if (typeof row['device'] !== 'string' || row['device'] === '') return false
  if (!Number.isSafeInteger(from) || (from as number) < 1) return false
  if (!Number.isSafeInteger(to) || (to as number) < (from as number)) return false
  /* A boundary with no chain named is a boundary for no chain — reading it
     into either would re-serve a page under the wrong version's hash — and
     one naming a chain this build does not serve was written by a build it
     is not. */
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > WIRE_VERSION) return false
  /* The wire's own bounds: a roster of at most 256 names, as `isPageShape` reads it. */
  if (row['roster'] !== undefined && !(Array.isArray(row['roster']) && row['roster'].length <= 256 && row['roster'].every((one) => typeof one === 'string'))) return false
  if (row['revocations'] !== undefined && !Number.isSafeInteger(row['revocations'])) return false
  if (row['delegation'] !== undefined && typeof row['delegation'] !== 'string') return false
  if (row['work'] !== undefined && !isClaimShape(row['work'])) return false
  /* A range no page was cut over: a page holds at most `MAX_ENTRIES_PER_PAGE`
     entries, but a page cut under an older version skips the newer kinds,
     so its RANGE can be wider than its entry count. The span is bounded all
     the same — rebuilding walks every sequence in it — at a width no honest
     log reaches between two boundaries. */
  if ((to as number) - (from as number) >= MAX_BOUNDARY_SPAN) return false
  return true
}

/** The widest range one boundary may cover — see `isSealedPage`. */
export const MAX_BOUNDARY_SPAN = 1 << 20

/** A claim as the store keeps one — EXACTLY the shape the wire refuses otherwise, within its bounds. */
function isClaimShape(value: unknown): value is WorkClaim {
  // Stryker disable next-line ConditionalExpression: a non-object has no claim member, so the key check below refuses it anyway.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const claim = value as Record<string, unknown>
  if (!hasOnly(claim, ['ids', 'titles', 'author', 'language'])) return false
  const strings = (list: unknown): boolean => Array.isArray(list) && list.length <= 64 && list.every((one) => typeof one === 'string')
  return strings(claim['ids']) && strings(claim['titles']) && typeof claim['author'] === 'string' && typeof claim['language'] === 'string'
}

const isSealed = isSealedPage

function isPublication(value: unknown): value is Publication {
  /* Stryker disable next-line ConditionalExpression: unobservable for anything
     `JSON.parse` produces. A string, number or boolean has no `pub` member, so
     the check below reads `undefined` and refuses the row anyway; this refuses
     it a line earlier and says why. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row['pub'] !== 'string' || row['pub'] === '') return false
  if (typeof row['markId'] !== 'string' || typeof row['device'] !== 'string' || row['device'] === '') return false
  if (!isHlc(row['at'])) return false
  if (!Number.isSafeInteger(row['seq']) || (row['seq'] as number) < 1) return false
  const passage = row['passage']
  if (typeof passage !== 'object' || passage === null) return false
  const parts = passage as Record<string, unknown>
  /* EXACTLY a passage's fields: `logOf` forwards the passage whole, and the wire refuses a field it does not name. */
  if (!hasOnly(parts, ['quote', 'prefix', 'suffix', 'chapter', 'note'])) return false
  if (!['quote', 'prefix', 'suffix', 'chapter'].every((key) => typeof parts[key] === 'string')) return false
  /* A note is optional, and a string when it is there: an object here would
     reach the page as a signed entry nobody can draw. */
  if (parts['note'] !== undefined && typeof parts['note'] !== 'string') return false
  return isWithdrawal(row['unshared'], row['seq'] as number)
}

/**
 * A withdrawal mark — absent, or a sequence and a stamp: the sequence AFTER
 * the row it withdraws, on the same log, and the stamp an HLC. One rule for
 * a passage's tombstone and a review's, which had drifted apart.
 */
function isWithdrawal(gone: unknown, parentSeq: number): boolean {
  if (gone === undefined) return true
  /* Stryker disable next-line ConditionalExpression: a non-object has no `seq` member, so the check below refuses it anyway. */
  if (typeof gone !== 'object' || gone === null || Array.isArray(gone)) return false
  const mark = gone as Record<string, unknown>
  return hasOnly(mark, ['seq', 'at']) && Number.isSafeInteger(mark['seq']) && (mark['seq'] as number) > parentSeq && isHlc(mark['at'])
}


/**
 * Change this reader's publications for one book as ONE step on the book's
 * lane: read, transform, write, with nothing else on the lane between.
 *
 * ⚠️ **A READ FOLLOWED BY A QUEUED WRITE IS NOT A TRANSACTION.** The share
 * control, the opinion driver and the exchange's sealing all change this one
 * file; two of them reading the same store and each writing its own answer
 * lose whichever landed first. The queue serialises the WRITES already — this
 * puts the read inside the same turn, so what is transformed is what is on
 * disk when the write lands. The transform answering the same object writes
 * nothing.
 */
export async function updateShared(
  fs: VaultFs,
  queue: WriteQueue,
  lane: LaneFor,
  bookId: string,
  transform: (held: SharedFile) => SharedFile | Promise<SharedFile>,
): Promise<SharedFile> {
  let next: SharedFile = NOTHING_PUBLISHED
  await queue.append(lane(bookId), async () => {
    const held = await readShared(fs, bookId)
    next = await transform(held)
    if (next !== held) await atomicWrite(fs, sharedPathIn(bookId), new TextEncoder().encode(JSON.stringify(next)))
  })
  return next
}

/**
 * The next sequence for a device — one past the highest it has ever used.
 *
 * ⚠️ **COUNTED OVER SHARES AND WITHDRAWALS ALIKE.** A withdrawal is an entry
 * with its own `seq`; counting only shares reissues a number the withdrawal
 * already holds, and two entries at one `(device, seq)` is exactly the
 * collision `prevPageHash` and the per-device key exist to make impossible.
 */
export function nextSeqFor(held: SharedFile, device: string): number {
  let top = 0
  for (const row of held.publications) {
    if (row.device !== device) continue
    top = Math.max(top, row.seq, row.unshared?.seq ?? 0)
  }
  /* The book-level rows are entries in the same stream, so their numbers are
     taken too — a `rate` at seq 4 and a `share` minted at seq 4 is the
     collision the per-device key exists to make impossible. */
  for (const row of held.opinions) {
    if (row.device === device) top = Math.max(top, row.seq)
  }
  for (const row of held.reviews) {
    if (row.device !== device) continue
    top = Math.max(top, row.seq, row.unreviewed?.seq ?? 0)
  }
  /* And past every sealed boundary, which can outlive the rows it covers —
     a sequence inside one has been served. A sequence past the safe
     integers is not a sequence: said here, not minted as a row that will
     not read back. */
  for (const sealed of held.sealed) {
    if (sealed.device === device) top = Math.max(top, sealed.to)
  }
  if (top >= Number.MAX_SAFE_INTEGER) throw new Error(`the log for ${device} has run out of sequence numbers`)
  return top + 1
}

/** Record a share. Returns the store to write and the publication made. */
export function share(
  held: SharedFile,
  what: { readonly markId: string; readonly passage: Passage; readonly device: string },
  pub: string,
  at: Hlc,
): { readonly held: SharedFile; readonly publication: Publication } {
  const publication: Publication = {
    pub,
    markId: what.markId,
    device: what.device,
    seq: nextSeqFor(held, what.device),
    at,
    passage: what.passage,
  }
  return { held: { ...held, publications: [...held.publications, publication] }, publication }
}

/**
 * Record a withdrawal of one publication.
 *
 * ⚠️ **THE ROW STAYS, AND ONLY GAINS A TOMBSTONE.** Removing it would lose the
 * snapshot the withdrawal's own page still needs, and would let the sequence
 * numbers it used be minted again. `unshare` is a tombstone at every layer of
 * this design, for the same reason `Mark.deletedAt` is one.
 */
export function unshare(held: SharedFile, pub: string, at: Hlc): SharedFile {
  return {
    ...held,
    publications: held.publications.map((row) => {
      if (row.pub !== pub || row.unshared) return row
      return { ...row, unshared: { seq: nextSeqFor(held, row.device), at } }
    }),
  }
}

/**
 * The whole log this reader would serve for one book.
 *
 * ⚠️ **A WITHDRAWAL CARRIES NO PASSAGE, AND THE TYPE IS WHAT ENFORCES IT.**
 * `wire.md`: a tombstone that repeated the quote in order to identify it would
 * disclose the withdrawn passage to a peer who had never seen the share — a
 * retraction that publishes the thing being retracted.
 */
export function logOf(held: SharedFile): readonly Entry[] {
  const entries: Entry[] = []
  for (const row of held.opinions) {
    /* Each row is its entry, rebuilt from its DECLARED fields: a stored row is
       refused with an extra field, but the wire's exact schema is the one
       that must hold, and building the entry is what guarantees it. */
    if (row.op === 'status') entries.push({ op: 'status', state: row.state, device: row.device, seq: row.seq, at: row.at })
    else if (row.op === 'rate') entries.push({ op: 'rate', stars: row.stars, device: row.device, seq: row.seq, at: row.at })
    else entries.push({ op: 'tag', tags: [...row.tags], device: row.device, seq: row.seq, at: row.at })
  }
  for (const row of held.reviews) {
    entries.push({ op: 'review', pub: row.pub, device: row.device, seq: row.seq, at: row.at, text: row.text })
    if (row.unreviewed) {
      entries.push({ op: 'unreview', pub: row.pub, device: row.device, seq: row.unreviewed.seq, at: row.unreviewed.at })
    }
  }
  for (const row of held.publications) {
    entries.push({
      op: 'share',
      pub: row.pub,
      device: row.device,
      seq: row.seq,
      at: row.at,
      passage: row.passage,
    })
    if (row.unshared) {
      entries.push({
        op: 'unshare',
        pub: row.pub,
        device: row.device,
        seq: row.unshared.seq,
        at: row.unshared.at,
      })
    }
  }
  return [...entries].sort(compareEntries)
}

/** What a page needs that the log does not carry. */
export interface Publisher {
  readonly person: string
  readonly device: string
  readonly work: WorkClaim
  /** The devices the person's roster names, ids only. */
  readonly roster: readonly string[]
  /** The revocation list version this device holds. */
  readonly revocations: number
  /** The delegation, canonical JSON, exactly as `person.rs` signed it. */
  readonly delegation: string
  /** Sign the page's bytes with the DEVICE key — `peer_page_sign`. */
  readonly sign: (message: string) => Promise<string>
}

/** The newest page version this build publishes. A v1 peer is served v1. */
export const PUBLISH_VERSION = WIRE_VERSION

/**
 * Build the pages a request asks for, signed, in order.
 *
 * ⚠️ **THE CHAIN IS BUILT HERE OR IT IS NOWHERE.** Each page's `prevPageHash`
 * is the hash of the previous page FROM THIS DEVICE, so pages must be built in
 * sequence order and each must see the one before it. A server that built them
 * independently would emit a chain no recipient can follow — and the symptom is
 * every page after the first refused with `chain`, which reads as corruption.
 *
 * `since` is the recipient's per-device cursor: entries at or below it are
 * already held. Answering from the cursor rather than from the start is what
 * keeps a long log from being re-sent on every round.
 */
/**
 * The two bounds an answer is held to, as parameters.
 *
 * ⚠️ **PARAMETERS SO THEY CAN BE REACHED FROM A TEST, AND THE DEFAULTS ARE THE
 * POLICY.** Proving that `more` is set at the cap otherwise means building
 * thirty-three pages of half a megabyte each — seventeen megabytes of fixture
 * for one boolean — so the bound went untested and the flag could have been
 * inverted or dropped with nothing to say so. A bound nobody can exercise is a
 * bound nobody has checked.
 */
export interface Bounds {
  readonly maxPages: number
  readonly budget: number
  /** The most characters one answer's pages may carry between them — the transport's envelope, less the frame. Defaults to `MAX_ANSWER_CHARS`. */
  readonly maxChars?: number
}

/**
 * ⚠️ **THE BUDGET MUST LEAVE ROOM FOR THE ENVELOPE.** `MAX_PAGE_CHARS` is what
 * the RECIPIENT refuses past, and a page sized to it exactly does not fit
 * inside the frame that carries it — so the publisher would emit pages nobody
 * can accept, and the symptom is a friend receiving everything except the long
 * passages.
 */
export const DEFAULT_BOUNDS: Bounds = {
  maxPages: MAX_PAGES_PER_ANSWER,
  /* Less the envelope's own overhead: the cap is on the FRAME, and a page
     sized to the frame exactly does not fit in one. */
  budget: MAX_PAGE_CHARS - 2_048,
}

export async function pagesFor(
  held: SharedFile,
  publisher: Publisher,
  since: Readonly<Record<string, number>>,
  hash: (value: string) => string,
  bounds: Bounds = DEFAULT_BOUNDS,
  /**
   * Which chain to serve — the version the caller negotiated.
   *
   * ⚠️ **FILTERED HERE, BEFORE PAGINATION.** The entries a version cannot
   * carry are dropped before a single boundary is decided, so a v1 boundary
   * is sealed over the v1 log and reproduces byte for byte however the v2 log
   * grows around it. Filtering after would re-cut every page a v1 peer holds.
   */
  version: number = PUBLISH_VERSION,
): Promise<{
  readonly pages: readonly string[]
  readonly more: boolean
  /** The store to write back: the boundaries this call sealed. */
  readonly held: SharedFile
}> {
  const built = await pagesOver(logOf(held), held.sealed, publisher, since, hash, bounds, version)
  return { pages: built.pages, more: built.more, held: { ...held, sealed: built.sealed } }
}

/**
 * The pages for ANY log this device publishes — the per-book log above, and
 * the shelf log (`shelf.ts`), which is the same chain machinery under
 * `SHELF_WORK`. Takes the log and the boundaries rather than a store, so the
 * two stores share one builder and cannot cut pages two ways.
 */
/**
 * How many characters a page of this publisher costs before its entries: the
 * canonical frame with an empty entry list and a signature of the length an
 * Ed25519 signature has, plus a small margin for the entries' own brackets.
 */
export function envelopeOf(publisher: Publisher, version: number): number {
  const frame: Page = {
    v: version,
    person: publisher.person,
    work: publisher.work,
    device: publisher.device,
    from: 0,
    to: 0,
    prevPageHash: 'f'.repeat(64),
    entries: [],
    roster: [...publisher.roster],
    revocations: publisher.revocations,
    delegation: publisher.delegation,
    sig: 'f'.repeat(128),
  }
  return canonicalJson(frame).length + 16
}

export async function pagesOver(
  log: readonly Entry[],
  sealed: readonly SealedPage[],
  publisher: Publisher,
  since: Readonly<Record<string, number>>,
  hash: (value: string) => string,
  bounds: Bounds = DEFAULT_BOUNDS,
  version: number = PUBLISH_VERSION,
): Promise<{
  readonly pages: readonly string[]
  readonly more: boolean
  /** Every boundary, the ones this call sealed appended. */
  readonly sealed: readonly SealedPage[]
}> {
  const mine = log
    .filter((entry) => entry.device === publisher.device && carriedBy(version, entry))
    .sort((a, b) => a.seq - b.seq)
  const bySeq = new Map(mine.map((entry) => [entry.seq, entry]))

  /* Every page this device has already served ON THIS CHAIN, in the order it
     served them. Another version's boundaries are another chain's. */
  const boundaries = sealed.filter((one) => one.device === publisher.device && one.v === version)
  const lastSealed = boundaries.reduce((top, one) => Math.max(top, one.to), 0)

  /* Whatever is past the last boundary becomes new pages, sealed here. */
  const fresh = mine.filter((entry) => entry.seq > lastSealed)
  /* ⚠️ **NO EMPTY GROUP TO FILTER OUT: `paginate` PUSHES ONLY WHEN
   * `current.length > 0`**, so an empty log yields an empty list rather than
   * one empty page. A guard here was dead code that read as caution — and it
   * hid the fact that the `?? 0` below can never be taken either.
   *
   * The `?.`/`?? 0` below are unreachable for the same reason: a group always
   * holds at least one entry. They exist because `noUncheckedIndexedAccess`
   * cannot see `paginate`'s guarantee, and a non-null assertion would be a
   * claim with no check behind it. */
  /* ⚠️ **THE ENVELOPE IS MEASURED, NOT ASSUMED.** The frame cap is on the
   * whole page, and what surrounds the entries — the roster, the delegation,
   * the claim, the signature — is as long as this publisher makes it. A fixed
   * allowance fitted the roster it was written against and no other. */
  const budget = Math.min(bounds.budget, MAX_PAGE_CHARS - envelopeOf(publisher, version))
  // Stryker disable OptionalChaining
  const sealedNow: SealedPage[] = paginate(fresh, budget).map((group) => ({
    device: publisher.device,
    from: group[0]?.seq ?? 0,
    to: group.at(-1)?.seq ?? 0,
    v: version,
    roster: [...publisher.roster],
    revocations: publisher.revocations,
    delegation: publisher.delegation,
    work: publisher.work,
  }))
  // Stryker restore OptionalChaining

  const wanted = since[publisher.device] ?? 0
  const pages: string[] = []
  let prevPageHash = ''
  let more = false
  let chars = 0
  const maxChars = bounds.maxChars ?? MAX_ANSWER_CHARS

  /* ⚠️ **THE CHAIN IS WALKED FROM THE FIRST PAGE EVEN WHEN THE ANSWER STARTS
   * LATER.** `prevPageHash` links every page this device has ever emitted, so
   * the hash a resumed page must carry can only be had by walking from the
   * beginning. Skipping ahead emits a page whose predecessor the recipient
   * holds and whose hash does not match it. */
  for (const boundary of [...boundaries, ...sealedNow]) {
    const group = []
    for (let seq = boundary.from; seq <= boundary.to; seq++) {
      const entry = bySeq.get(seq)
      /* ⚠️ **A STORED BOUNDARY CAN OUTLIVE THE ENTRIES IT COVERS** — a file
       * edited by hand, a row dropped by a future migration. Pushing the
       * `undefined` would put a `null` inside `entries`, and the page then
       * goes out signed, canonical and holding a hole that every recipient
       * refuses without being able to say what is wrong with it. */
      if (entry) group.push(entry)
    }
    const body: Omit<Page, 'sig'> = {
      v: version,
      person: publisher.person,
      work: boundary.work ?? publisher.work,
      device: publisher.device,
      from: boundary.from,
      to: boundary.to,
      prevPageHash,
      entries: group,
      /* As first served — see `SealedPage`. A boundary sealed before the
         metadata was kept rebuilds with the current values, as it always did. */
      roster: [...(boundary.roster ?? publisher.roster)],
      revocations: boundary.revocations ?? publisher.revocations,
      delegation: boundary.delegation ?? publisher.delegation,
    }
    /* THE CAP, BEFORE THE SIGNATURE: a page past it is not sent, so signing
       it is a key operation spent on nothing. Pages at or before the cursor
       are still signed — their hash is the chain the next page carries. */
    // Stryker disable next-line EqualityOperator,ConditionalExpression: boundaries are walked in order, so every one at or before the cursor is passed before a page is served; the guard spells out what the order ensures.
    if (boundary.to > wanted && pages.length >= bounds.maxPages) {
      more = true
      break
    }
    /* `body` has no `sig` and `signedBytes` drops one anyway — a placeholder
       here was a value with no meaning, which reads as though it had one. */
    const sig = await publisher.sign(signedBytes('page', version, body))
    /* ⚠️ **`canonicalJson`, NOT `signedBytes`, FOR THE BYTES THAT TRAVEL.**
     * `signedBytes` DROPS `sig` — that is what a signature covers — so building
     * the wire bytes from it emits a page with no signature at all, and every
     * recipient answers `not-canonical` because what arrived is not the
     * canonical form of what parsed. Two different strings on purpose, and
     * using one for the other has no symptom on this side. */
    const raw = canonicalJson({ ...body, sig })
    prevPageHash = hash(raw)
    if (boundary.to <= wanted) continue
    /* THE ANSWER AS A WHOLE fits the envelope: each page fits on its own,
       and thirty-two of them at the cap did not. The rest wait for the next
       request, which is what `more` says. */
    if (pages.length > 0 && chars + raw.length > maxChars) {
      more = true
      break
    }
    chars += raw.length
    pages.push(raw)
  }

  return { pages, more, sealed: [...sealed, ...sealedNow] }
}
