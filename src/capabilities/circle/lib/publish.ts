import { MAX_ANSWER_CHARS } from './protocol'
import {
  READING_STATES,
  STARS,
  WIRE_VERSION,
  atomicWrite,
  canonicalJson,
  carriedBy,
  compareEntries,
  isClaimShape,
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

/**
 * A withdrawal, as a row carries it: its own sequence and stamp, and the
 * device that made it.
 *
 * ⚠️ **THE DEVICE IS THE WITHDRAWING DEVICE, NOT THE ROW'S.** Two of the
 * reader's devices are two streams, and `pagesOver` serves only the stream of
 * the device that took the call — so a tombstone filed under the ORIGINAL
 * publisher's device was one the withdrawing device never served, and its
 * sequence, minted from the withdrawing device's count, could collide with a
 * number the original device minted for itself. Absent on rows written before
 * it was kept, which read as the row's own device: the only device that could
 * have withdrawn then.
 */
export interface Withdrawal {
  readonly seq: number
  readonly at: Hlc
  readonly device?: string
}

/** The device a withdrawal is stamped in — its own, or the row's for one written before that was kept. */
export function withdrawnBy(row: { readonly device: string }, gone: Withdrawal): string {
  return gone.device ?? row.device
}

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
  /** The withdrawal, when there is one — see `Withdrawal`. */
  readonly unshared?: Withdrawal
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
   * that boundary was sealed for. `readShared` reads a boundary without one
   * as v1 — the only chain a build before this field served — and refuses one
   * naming a chain this build does not serve.
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
  /**
   * How many entries this page held when it was sealed.
   *
   * ⚠️ **A RANGE IS NOT A MEMBERSHIP, AND THE RANGE WAS ALL THAT WAS STORED.**
   * A store that loses an entry inside a sealed page — a file edited by hand, a
   * row dropped by a future migration — rebuilds `[1,2,3]` as `[1,3]`, and the
   * result passes `checkPage`, which permits gaps because version filtering
   * makes legitimate ones. So a page ALREADY SENT is silently re-emitted with
   * different contents, a different hash, and a different `prevPageHash` for
   * every page after it: every recipient's chain broken, from a store that
   * looked fine.
   *
   * Absent on a boundary sealed before this was recorded, which cannot be
   * checked and is served as it always was.
   */
  readonly entries?: number
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
  readonly unreviewed?: Withdrawal
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
   * every recipient already holds — and breaks their chains permanently.
   *
   * ⚠️ **AND A BOUNDARY WITH NO CHAIN VERSION IS A v1 BOUNDARY, NOT A REFUSAL.**
   * 0.1.3 sealed `{ device, from, to }` and nothing else, because there was
   * one chain; refusing those made every book with a page served before the
   * upgrade unreadable, for ever, on the first read after it. Read as the
   * chain they were sealed on, and written back with it on the next write. */
  const sealed = held['sealed']
  if (!Array.isArray(sealed)) throw new Error(`shared file for ${bookId} has no page boundaries`)
  const versioned = sealed.map(legacyBoundary)
  if (!versioned.every(isSealed)) throw new Error(`shared file for ${bookId} has no page boundaries`)
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
  const file: SharedFile = { publications: rows, sealed: versioned, opinions, reviews, publishOpinion }
  /* Checked as the LOG it serves: a reused `(device, seq)` would let `bySeq`
     keep one entry and drop the other silently, and boundaries out of chain
     order would rebuild a chain nobody holds. */
  if (reusesSequence(logOf(file))) throw new Error(`shared file for ${bookId} reuses a sequence`)
  if (!boundariesInOrder(versioned)) throw new Error(`shared file for ${bookId} has page boundaries out of order`)
  return file
}

/** The chain the first build sealed on — the only one there was before `SealedPage.v`. */
const FIRST_CHAIN = 1

/**
 * Whether a boundary froze a delegation no verifier can read.
 *
 * ⚠️ **THE `sig` RENAME DOES NOT REACH A SEALED PAGE, AND WITHOUT THIS THE FIX
 * IS HALF A FIX.** `SignedDelegation` serialised its signature as `signature`
 * until 2026-09-07; `receive.ts` demands `sig` and refuses an object missing
 * it, so every page from a Rust-signing device was refused. Renaming the field
 * corrects what is minted TODAY — but a boundary keeps the delegation *as first
 * served*, deliberately, and a page rebuilt from one still carries the dead
 * spelling. A reader who shared before upgrading would keep a publication no
 * friend can ever read, for ever, with nothing anywhere saying why.
 *
 * ⚠️ **AND REBUILDING IS SAFE HERE FOR ONE REASON THAT WILL NOT COME AGAIN.**
 * `SealedPage` exists because a page rebuilt with today's roster is a DIFFERENT
 * page — different bytes, different hash, and every recipient holding the old
 * one refuses the next with `chain`. That cost is real whenever a recipient
 * holds the page. Nobody holds these: a page whose delegation cannot be read is
 * refused as `bad-delegation` before its own signature is checked, so no peer
 * ever accepted one. The set of pages this drops is exactly the set no peer can
 * have. Do NOT generalise this to a boundary anything might have accepted.
 *
 * An unparseable delegation goes the same way, for the same reason — it is
 * equally unreadable, and rebuilding is the only thing that can help it.
 */
function unreadableDelegation(raw: unknown): boolean {
  /* ⚠️ **A NON-STRING IS NOT THIS FUNCTION'S BUSINESS, AND DROPPING IT HID A
     REAL CHECK.** `isSealedPage` refuses a boundary whose `delegation` is not a
     string, and the first version of this migration quietly repaired that into
     a valid row — turning a malformed store, which means something wrote
     garbage, into a silent rebuild. A legacy SPELLING is a migration; a broken
     TYPE is a defect, and the store must still refuse it loudly.
     `publish.test.ts`'s "refuses a delegation that is an object" caught this.
     ⚠️ This also answers for a boundary that never had a delegation at all: an
     `if (raw === undefined) return false` stood above it and could not change
     an answer, because `undefined` is not a string either. */
  if (typeof raw !== 'string') return false
  let held: unknown
  try {
    held = JSON.parse(raw)
  } catch {
    return true
  }
  /* ⚠️ **ONLY `null` NEEDS ITS OWN ANSWER.** This read
     `typeof held !== 'object' || held === null || Array.isArray(held)`, and
     two of those three could not change one: a number, a string and a list all
     reach the member read below, have no `sig`, and are refused there. `null`
     is the one that would THROW on the read instead of answering. Removing the
     other two also makes the `catch` above load-bearing, which it was not:
     emptied, `held` stayed `undefined` and the `typeof` clause caught it. */
  if (held === null) return true
  /* The one member the rename moved. `isDelegation` refuses the object without
     it, which is the whole of the defect this migrates past — the rest of the
     shape is that parser's business and is checked there, on arrival. */
  return typeof (held as Record<string, unknown>)['sig'] !== 'string'
}

/** A boundary as written before `v` existed, read onto the one chain it could be for; anything else, as it is. */
function legacyBoundary(value: unknown): unknown {
  /* Stryker disable next-line ConditionalExpression: a non-object is refused by `isSealedPage` whether or not it is spread here. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const row = value as Record<string, unknown>
  const chained = row['v'] === undefined ? { ...row, v: FIRST_CHAIN } : row
  if (!unreadableDelegation(chained['delegation'])) return chained
  /* Dropped rather than corrected: `pageOver` reads `boundary.delegation ??
     publisher.delegation`, so an absent one rebuilds with what this device
     holds now — the path a boundary sealed before the field existed already
     takes. There is nothing to correct it TO from here; the current delegation
     is the publisher's to supply. */
  const { delegation: _dropped, ...rest } = chained
  return rest
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
  return isWithdrawal(value['unreviewed'], value['seq'] as number, value['device'])
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
  return isWithdrawal(row['unshared'], row['seq'] as number, row['device'] as string)
}

/**
 * A withdrawal mark — absent, or a sequence and a stamp, and the device that
 * made it when it is not the row's own. In the row's own stream the sequence
 * comes AFTER the row it withdraws; in another device's stream it is a
 * position on that log from 1, and the reuse check over the whole log is what
 * holds it apart from the rest. One rule for a passage's tombstone, a
 * review's and a shelf row's, which had drifted apart.
 */
export function isWithdrawal(gone: unknown, parentSeq: number, parentDevice: string): boolean {
  if (gone === undefined) return true
  /* Stryker disable next-line ConditionalExpression: a non-object has no `seq` member, so the check below refuses it anyway. */
  if (typeof gone !== 'object' || gone === null || Array.isArray(gone)) return false
  const mark = gone as Record<string, unknown>
  if (!hasOnly(mark, ['seq', 'at', 'device']) || !Number.isSafeInteger(mark['seq']) || (mark['seq'] as number) < 1 || !isHlc(mark['at'])) return false
  const device = mark['device']
  if (device === undefined) return (mark['seq'] as number) > parentSeq
  if (typeof device !== 'string' || device === '') return false
  return device !== parentDevice || (mark['seq'] as number) > parentSeq
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
  /* A withdrawal is counted in the stream it was STAMPED in — `withdrawnBy` —
     which is not always the row's: the laptop takes back what the phone
     published, in the laptop's own stream. */
  for (const row of held.publications) {
    if (row.device === device) top = Math.max(top, row.seq)
    if (row.unshared !== undefined && withdrawnBy(row, row.unshared) === device) top = Math.max(top, row.unshared.seq)
  }
  /* The book-level rows are entries in the same stream, so their numbers are
     taken too — a `rate` at seq 4 and a `share` minted at seq 4 is the
     collision the per-device key exists to make impossible. */
  for (const row of held.opinions) {
    if (row.device === device) top = Math.max(top, row.seq)
  }
  for (const row of held.reviews) {
    if (row.device === device) top = Math.max(top, row.seq)
    if (row.unreviewed !== undefined && withdrawnBy(row, row.unreviewed) === device) top = Math.max(top, row.unreviewed.seq)
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
  /* ⚠️ **A `pub` IS AN IDENTITY, AND NOTHING WAS ENFORCING IT.** Two rows
     sharing one made `unshare` allocate the same sequence twice and wrote a
     store that fails its own next read — a publication that cannot be
     withdrawn without breaking the file it lives in. Refused where the id
     enters, which is the only place it can still be refused cheaply. */
  if (held.publications.some((row) => row.pub === pub)) {
    throw new Error(`this book already has a publication called ${pub}`)
  }
  const publication: Publication = {
    pub,
    markId: what.markId,
    device: what.device,
    seq: nextSeqFor(held, what.device),
    at,
    /* ⚠️ **COPIED, BECAUSE A SNAPSHOT THAT SHARES A REFERENCE IS NOT ONE.** The
       caller's passage object was stored as-is, so editing the mark afterwards
       edited the PUBLICATION — a signed record of what was shared, changing
       under a reader who had already shared it. `readonly` in TypeScript stops
       a write THROUGH THIS reference and nothing at all through the caller's,
       which still holds the same object. */
    passage: { ...what.passage },
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
 *
 * ⚠️ **STAMPED IN THE WITHDRAWING DEVICE'S STREAM** — `device` is the device
 * taking it back, which need not be the one that published. See `Withdrawal`.
 */
export function unshare(held: SharedFile, pub: string, device: string, at: Hlc): SharedFile {
  /* ⚠️ **EXACTLY ONE ROW, BECAUSE EACH WOULD TAKE THE SAME SEQUENCE.** This
     mapped over EVERY row carrying the id, and each computed `nextSeqFor`
     against the same unchanged store — so two rows sharing a `pub` were
     withdrawn at the same sequence, and the store then failed its own next
     read. `share` refuses a duplicate id now, so this cannot arise from here;
     a store already holding one is repaired by withdrawing one row at a time
     rather than by writing a file nothing can load. */
  let withdrawn = false
  return {
    ...held,
    publications: held.publications.map((row) => {
      if (withdrawn || row.pub !== pub || row.unshared) return row
      withdrawn = true
      return { ...row, unshared: { device, seq: nextSeqFor(held, device), at } }
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
      entries.push({ op: 'unreview', pub: row.pub, device: withdrawnBy(row, row.unreviewed), seq: row.unreviewed.seq, at: row.unreviewed.at })
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
      /* Under the device that withdrew it, which is the stream that serves it. */
      entries.push({
        op: 'unshare',
        pub: row.pub,
        device: withdrawnBy(row, row.unshared),
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
 *
 * ⚠️ **MEASURED WITH THE WIDEST SEQUENCES A PAGE CAN CARRY.** `from` and `to`
 * were measured as one-digit zeroes, and two safe integers are thirty
 * characters more — so a page filled to the budget at a high sequence went
 * out past `MAX_PAGE_CHARS`, and every recipient refused it as too large.
 */
export function envelopeOf(publisher: Publisher, version: number): number {
  const frame: Page = {
    v: version,
    person: publisher.person,
    work: publisher.work,
    device: publisher.device,
    from: Number.MAX_SAFE_INTEGER,
    to: Number.MAX_SAFE_INTEGER,
    prevPageHash: 'f'.repeat(64),
    entries: [],
    roster: [...publisher.roster],
    revocations: publisher.revocations,
    delegation: publisher.delegation,
    sig: 'f'.repeat(128),
  }
  return canonicalJson(frame).length + 16
}

/**
 * What a page costs on the wire — the bytes of its JSON-escaped, UTF-8
 * encoded self inside the envelope's own JSON.
 *
 * ⚠️ **NOT `raw.length`.** That counts UTF-16 units, and the envelope encodes
 * each page as UTF-8 and escapes it again as a JSON string: a page of
 * Chinese prose is three bytes per unit, and one of quotation marks grows by
 * every backslash. An answer held to a character count could be three times
 * the frame the transport carries.
 */
export function wireBytesOf(page: string): number {
  return new TextEncoder().encode(JSON.stringify(page)).length
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
  const { mine, boundaries: asStored } = streamOf(log, sealed, publisher, version)
  /* ⚠️ **A LEGACY BOUNDARY IS PINNED THE FIRST TIME IT IS SERVED, NOT REBUILT
     FROM LIVE STATE EVERY TIME.** A boundary sealed before roster, revocations,
     delegation and claim were recorded falls back to the publisher's CURRENT
     values — so pairing a new device, or revoking one, changed the bytes of
     pages already sent. Every recipient holding the old page then refuses the
     next one with `chain`, for ever, and nothing anywhere says why. The
     fallback is what makes an old store readable at all; what was missing is
     that the values it chose are then written down, so the second serve cannot
     differ from the first. */
  /* ⚠️ **UNCONDITIONALLY, BECAUSE THE GUARD COULD NOT CHANGE AN ANSWER.** It
     read "already has all three? then as it is" and every field below falls
     back with `??`, so the rebuilt row held the same values either way — only
     its identity differed, and `pinnedByRef` keys on the ORIGINAL. A branch
     nothing can tell from its other side is a claim the reader has to check. */
  const pin = (one: SealedPage): Pinned => ({
    ...one,
    roster: one.roster ?? [...publisher.roster],
    revocations: one.revocations ?? publisher.revocations,
    work: one.work ?? { ...publisher.work, ids: [...publisher.work.ids], titles: [...publisher.work.titles] },
  })
  const boundaries = asStored.map(pin)
  /* ⚠️ **THE WHOLE STORED LIST IS CARRIED BACK, NOT ONLY THIS CHAIN'S.**
     `streamOf` selects the boundaries of the version being SERVED, so
     returning those alone silently dropped every boundary belonging to the
     other chain — a v1 store served over v2 would have lost its v1 history on
     the next write. Caught by the two-chain test, which is exactly what it is
     for. */
  const pinnedByRef = new Map(asStored.map((one, i) => [one, boundaries[i]!]))
  const allSealed = sealed.map((one) => pinnedByRef.get(one) ?? one)
  const bySeq = new Map(mine.map((entry) => [entry.seq, entry]))
  const sealedNow = sealFresh(mine, boundaries, publisher, bounds, version)
  const wanted = since[publisher.device] ?? 0
  /* ⚠️ **A CAUGHT-UP REQUEST SIGNED THE WHOLE CHAIN TO ANSWER "NOTHING NEW".**
     The walk below starts at the first page because `prevPageHash` links every
     page this device ever emitted, and a resumed page can only get its
     predecessor's hash by walking from the beginning. That is right when a page
     is going out — and there is no page going out here. A reader polling every
     five minutes re-signed their entire history each time, for an empty answer:
     a key operation per sealed page, per poll, for ever. Nothing beyond the
     cursor means nothing to chain to. */
  const anythingNew = [...boundaries, ...sealedNow].some((one) => one.to > wanted)
  if (!anythingNew) return { pages: [], more: false, sealed: [...allSealed, ...sealedNow] }
  const answer = boundedAnswer(bounds)
  let prevPageHash = ''
  let more = false

  /* ⚠️ **THE CHAIN IS WALKED FROM THE FIRST PAGE EVEN WHEN THE ANSWER STARTS
   * LATER.** `prevPageHash` links every page this device has ever emitted, so
   * the hash a resumed page must carry can only be had by walking from the
   * beginning. Skipping ahead emits a page whose predecessor the recipient
   * holds and whose hash does not match it. */
  for (const boundary of [...boundaries, ...sealedNow]) {
    const served = boundary.to > wanted
    /* THE CAP, BEFORE THE SIGNATURE: a page past it is not sent, so signing
       it is a key operation spent on nothing. Pages at or before the cursor
       are still signed — their hash is the chain the next page carries. */
    // Stryker disable next-line EqualityOperator,ConditionalExpression: boundaries are walked in order, so every one at or before the cursor is passed before a page is served; the guard spells out what the order ensures.
    if (served && answer.full()) {
      more = true
      break
    }
    const page = await renderPage(boundary, bySeq, publisher, version, prevPageHash, hash)
    prevPageHash = page.hash
    if (!served) continue
    if (!answer.add(page.raw)) {
      more = true
      break
    }
  }

  /* ⚠️ **`boundaries`, NOT `sealed` — the PINNED list, not the one that came in.**
     Returning the argument threw away the metadata a legacy boundary was just
     rendered with, so the next serve fell back to live state all over again and
     the pinning never persisted. */
  return { pages: answer.pages, more, sealed: [...allSealed, ...sealedNow] }
}

/**
 * This device's stream on ONE chain: its entries the version carries, in
 * order, and every boundary it has already served on that chain, in the
 * order it served them. Another version's boundaries are another chain's.
 */
function streamOf(log: readonly Entry[], sealed: readonly SealedPage[], publisher: Publisher, version: number): { readonly mine: readonly Entry[]; readonly boundaries: readonly SealedPage[] } {
  const mine = log
    .filter((entry) => entry.device === publisher.device && carriedBy(version, entry))
    .sort((a, b) => a.seq - b.seq)
  const boundaries = sealed.filter((one) => one.device === publisher.device && one.v === version)
  return { mine, boundaries }
}

/**
 * One page under its boundary, signed, in the bytes that travel — and the
 * hash the next page on the chain carries.
 *
 * ⚠️ **`canonicalJson`, NOT `signedBytes`, FOR THE BYTES THAT TRAVEL.**
 * `signedBytes` DROPS `sig` — that is what a signature covers — so building
 * the wire bytes from it emits a page with no signature at all, and every
 * recipient answers `not-canonical` because what arrived is not the
 * canonical form of what parsed. Two different strings on purpose, and
 * using one for the other has no symptom on this side.
 *
 * `body` has no `sig` and `signedBytes` drops one anyway — a placeholder
 * was a value with no meaning, which reads as though it had one.
 */
async function renderPage(
  boundary: Pinned,
  bySeq: ReadonlyMap<number, Entry>,
  publisher: Publisher,
  version: number,
  prevPageHash: string,
  hash: (value: string) => string,
): Promise<{ readonly raw: string; readonly hash: string }> {
  const body = rebuilt(boundary, bySeq, publisher, version, prevPageHash)
  const sig = await publisher.sign(signedBytes('page', version, body))
  const raw = canonicalJson({ ...body, sig })
  return { raw, hash: hash(raw) }
}

/**
 * The bounded answer: which served pages go out, and when the rest wait for
 * the next request. PURE — a page count and a byte budget, the bytes as
 * `wireBytesOf` counts them — so the two limits can be read and tested apart
 * from the signing and the chain they used to be interleaved with.
 *
 * THE ANSWER AS A WHOLE fits the envelope: each page fits on its own, and
 * thirty-two of them at the cap did not. The answer's FIRST page is
 * unconditional — a page that fits the frame always goes, or a cursor could
 * never advance past it — and every later one must fit beside the rest.
 */
export function boundedAnswer(bounds: Bounds): { readonly pages: readonly string[]; full(): boolean; add(raw: string): boolean } {
  const pages: string[] = []
  const maxBytes = bounds.maxChars ?? MAX_ANSWER_CHARS
  /* Bytes on the wire, as `wireBytesOf` counts them — the bound is the frame's. */
  let bytes = 0
  return {
    pages,
    full: () => pages.length >= bounds.maxPages,
    add: (raw) => {
      const cost = wireBytesOf(raw)
      if (pages.length > 0 && bytes + cost > maxBytes) return false
      bytes += cost
      pages.push(raw)
      return true
    },
  }
}

/**
 * The boundaries this call seals: whatever is past the last boundary on this
 * chain, cut into pages that each fit the frame, with the publisher's roster,
 * revocations, delegation and claim of THIS moment written beside each.
 *
 * ⚠️ **NO EMPTY GROUP TO FILTER OUT: `paginate` PUSHES ONLY WHEN
 * `current.length > 0`**, so an empty log yields an empty list rather than
 * one empty page. A guard here was dead code that read as caution — and it
 * hid the fact that the `?? 0` below can never be taken either.
 *
 * The `?.`/`?? 0` below are unreachable for the same reason: a group always
 * holds at least one entry. They exist because `noUncheckedIndexedAccess`
 * cannot see `paginate`'s guarantee, and a non-null assertion would be a
 * claim with no check behind it.
 *
 * ⚠️ **THE ENVELOPE IS MEASURED, NOT ASSUMED.** The frame cap is on the whole
 * page, and what surrounds the entries — the roster, the delegation, the
 * claim, the signature — is as long as this publisher makes it. A fixed
 * allowance fitted the roster it was written against and no other.
 */
/**
 * A boundary whose roster, revocations and claim are WRITTEN DOWN.
 *
 * ⚠️ **A TYPE RATHER THAN THREE `??`s AT THE PAGE.** `rebuilt` fell back to the
 * publisher's live values for each of them, which was the whole of the defect
 * `pin` exists to fix — and once `pin` ran over every stored boundary and
 * `sealFresh` set all three on every new one, those fallbacks could not fire.
 * Three dead clauses restating a rule enforced one level up. Said in the type,
 * so a boundary that has not been pinned cannot reach a page.
 */
type Pinned = SealedPage & {
  readonly roster: readonly string[]
  readonly revocations: number
  readonly work: WorkClaim
}

function sealFresh(mine: readonly Entry[], boundaries: readonly SealedPage[], publisher: Publisher, bounds: Bounds, version: number): readonly Pinned[] {
  const lastSealed = boundaries.reduce((top, one) => Math.max(top, one.to), 0)
  const fresh = mine.filter((entry) => entry.seq > lastSealed)
  const wireLimit = MAX_PAGE_CHARS - envelopeOf(publisher, version)
  const budget = Math.min(bounds.budget, wireLimit)
  /* ⚠️ **THE READER ALSO BOUNDS THE SPAN, AND ONLY THE READER DID.**
     `isSealedPage` refuses a boundary whose `to - from` reaches
     `MAX_BOUNDARY_SPAN`, and pagination bounded size and count but never the
     RANGE — which is not the same thing, because a page's entries need not be
     contiguous: filtering out another chain's entries leaves the survivors
     sparse. Two entries a million sequences apart therefore sealed a boundary
     this build's own reader rejects, and the store then fails its next read.
     Cut before the span reaches the limit; the fourth bound of one contract
     the writer was enforcing three of. */
  const withinSpan = (group: readonly Entry[]): readonly (readonly Entry[])[] => {
    const out: Entry[][] = []
    let run: Entry[] = []
    for (const entry of group) {
      if (run.length > 0 && entry.seq - run[0]!.seq >= MAX_BOUNDARY_SPAN) {
        out.push(run)
        run = []
      }
      run.push(entry)
    }
    /* ⚠️ Equivalent by the caller, and kept for the reader: `paginate` never
       yields an empty group — it pushes a run only when it has one — so the
       loop above always pushes at least once and `run` is never empty here.
       Made unconditional, the only input that would tell the difference is one
       that cannot arrive; left as it is, it says what has to be true. */
    // Stryker disable next-line ConditionalExpression,EqualityOperator: unreachable with an empty run — see above.
    if (run.length > 0) out.push(run)
    return out
  }
  return paginate(fresh, budget).flatMap(withinSpan).map((group) => {
    /* ⚠️ **AN ENTRY TOO BIG FOR A PAGE WAS SEALED INTO ONE ANYWAY.**
       `paginate` emits an oversized entry alone rather than dropping it —
       correct, since dropping would lose a publication silently — but nothing
       here checked the result, so the page went out over `MAX_PAGE_CHARS`,
       every recipient refused it, and because pages are a chain EVERY LATER
       PAGE stayed stuck behind it. A quote of 524 289 characters produced a
       525 161-character page against a 524 288 limit, and the reader's whole
       stream stopped there for ever, silently.
       Refused loudly instead. The recovery is in the message, because a person
       reading it is the only one who can take that publication back. */
    /* ⚠️ **AGAINST THE WIRE LIMIT, NOT THE FRAME BUDGET.** `bounds.budget` is
       how much this ANSWER may carry and is legitimately tiny — the tests set
       it to 1 to force one entry per page, and a small budget simply means
       more pages. Only `MAX_PAGE_CHARS` makes a page unsendable, and that is
       the bound a recipient enforces. Checking the wrong one turned a
       deliberate test fixture into an error. */
    /* ⚠️ **CHARACTERS, BECAUSE `wireLimit` IS IN CHARACTERS.** This summed
       `wireBytesOf` — the UTF-8 bytes of the page's JSON-ESCAPED self, which is
       what an ANSWER's frame costs — and compared it against
       `MAX_PAGE_CHARS - envelope`, which `checkPage` measures as
       `received.length`. Two different units, and the byte count runs about
       2.8× the character count for CJK text: MEASURED, 112 characters of
       Chinese weigh 318 bytes. So a 175 000-character Chinese passage — a page
       of 175 000 characters against a limit of 524 288 — was refused as
       unsendable, and the reader was told to withdraw a publication that would
       have gone out perfectly well. The frame budget is a real bound and it is
       enforced elsewhere, on the answer; it is not this one. */
    const size = group.reduce((n, one) => n + canonicalJson(one).length, 0)
    /* ⚠️ A group of more than one cannot be over: `paginate` keeps
       `2 + sum(len) + (n - 1) <= budget` and `budget <= wireLimit`, so this sum
       — which is that one less the brackets and the commas — is strictly under
       it for every `n >= 2`. Stated rather than assumed, because with the byte
       count above it was NOT true and this clause was quietly load-bearing
       against the wrong measure. Kept because it is what makes `group[0]!`
       below honest. */
    // Stryker disable next-line ConditionalExpression: implied by `paginate`'s own bound — see above.
    if (group.length === 1 && size > wireLimit) {
      const only = group[0]!
      throw new Error(
        `one entry (seq ${only.seq}) is ${size} characters and a page holds ${wireLimit} — it cannot be sent, and it blocks every later page. Withdraw that publication.`,
      )
    }
    return {
      device: publisher.device,
      /* ⚠️ **NOT `?? 0` — THAT MANUFACTURED AN INVALID BOUNDARY.** `paginate`
         pushes only non-empty groups and `withinSpan` only non-empty runs, so
         these cannot be undefined; the old fallbacks were unreachable and, if
         that contract ever changed, would have sealed a boundary at sequence 0
         — which `isSealedPage` refuses, making the store unreadable rather than
         reporting the broken assumption. A non-null assertion states the
         guarantee that actually holds. */
      from: group[0]!.seq,
      to: group.at(-1)!.seq,
      v: version,
      roster: [...publisher.roster],
      revocations: publisher.revocations,
      delegation: publisher.delegation,
      /* The claim is sealed INTO the boundary and must not move afterwards:
         its arrays are the publisher's, and the publisher is rebuilt per round
         from live metadata. A boundary whose claim changed would reproduce
         different bytes and break every recipient's chain. */
      work: { ...publisher.work, ids: [...publisher.work.ids], titles: [...publisher.work.titles] },
      /* What this page IS, beside where it sits — see `SealedPage.entries`. */
      entries: group.length,
    }
  })
  // Stryker restore OptionalChaining
}

/**
 * One page, rebuilt under its boundary — the entries the boundary covers, and
 * the metadata it was sealed with.
 *
 * ⚠️ **A STORED BOUNDARY CAN OUTLIVE THE ENTRIES IT COVERS** — a file edited
 * by hand, a row dropped by a future migration. Pushing the `undefined` would
 * put a `null` inside `entries`, and the page then goes out signed, canonical
 * and holding a hole that every recipient refuses without being able to say
 * what is wrong with it. (A page missing an end the boundary names is refused
 * by `checkPage` as malformed, which is the honest outcome for a store whose
 * rows have gone; it is not silently skipped over.)
 */
function rebuilt(boundary: Pinned, bySeq: ReadonlyMap<number, Entry>, publisher: Publisher, version: number, prevPageHash: string): Omit<Page, 'sig'> {
  const group: Entry[] = []
  for (let seq = boundary.from; seq <= boundary.to; seq++) {
    const entry = bySeq.get(seq)
    if (entry) group.push(entry)
  }
  /* ⚠️ **A PAGE THAT LOST AN ENTRY IS NOT THE PAGE THAT WAS SEALED.** Rebuilding
     `[1,2,3]` as `[1,3]` produces a page `checkPage` ACCEPTS — gaps are legal,
     because version filtering makes legitimate ones — so it goes out signed and
     canonical with different contents, a different hash, and a different
     `prevPageHash` for every page after it. Every recipient's chain broken,
     from a store that read cleanly. Refused rather than re-emitted; the count
     is absent on boundaries sealed before it was recorded, and those are served
     as they always were. */
  if (boundary.entries !== undefined && group.length !== boundary.entries) {
    throw new Error(
      `the sealed page ${boundary.from}–${boundary.to} held ${boundary.entries} entries and this store has ${group.length} — refusing to re-send it as a different page`,
    )
  }
  return {
    v: version,
    person: publisher.person,
    work: boundary.work,
    device: publisher.device,
    from: boundary.from,
    to: boundary.to,
    prevPageHash,
    entries: group,
    /* As first served — see `SealedPage` and `Pinned`. A boundary sealed
       before the metadata was kept had it written down by `pin` on the way in,
       so there is nothing to fall back to here. */
    roster: [...boundary.roster],
    revocations: boundary.revocations,
    delegation: boundary.delegation ?? publisher.delegation,
  }
}
