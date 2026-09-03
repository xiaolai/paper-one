import {
  atomicWrite,
  canonicalJson,
  compareEntries,
  paginate,
  sharedPathIn,
  signedBytes,
  type Entry,
  type Hlc,
  type Page,
  type Passage,
  type VaultFs,
  type WorkClaim,
  type WriteQueue,
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
}

/** This reader's publications for one book, and the pages already served. */
export interface SharedFile {
  readonly publications: readonly Publication[]
  /** In emission order, per device. See [`SealedPage`]. */
  readonly sealed: readonly SealedPage[]
}

/** Nothing published from this book, which is true of almost every book. */
export const NOTHING_PUBLISHED: SharedFile = { publications: [], sealed: [] }

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
  return { publications: rows, sealed }
}

function isSealed(value: unknown): value is SealedPage {
  /* Stryker disable next-line ConditionalExpression: as `isPublication` — a
     non-object has no `device` member, so the check below refuses it anyway. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row['device'] === 'string' &&
    Number.isSafeInteger(row['from']) &&
    Number.isSafeInteger(row['to'])
  )
}

function isPublication(value: unknown): value is Publication {
  /* Stryker disable next-line ConditionalExpression: unobservable for anything
     `JSON.parse` produces. A string, number or boolean has no `pub` member, so
     the check below reads `undefined` and refuses the row anyway; this refuses
     it a line earlier and says why. */
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (typeof row['pub'] !== 'string' || row['pub'] === '') return false
  if (typeof row['markId'] !== 'string' || typeof row['device'] !== 'string') return false
  if (typeof row['at'] !== 'string') return false
  if (!Number.isSafeInteger(row['seq'])) return false
  const passage = row['passage']
  if (typeof passage !== 'object' || passage === null) return false
  const parts = passage as Record<string, unknown>
  return ['quote', 'prefix', 'suffix', 'chapter'].every((key) => typeof parts[key] === 'string')
}

/** Replace this reader's publications for one book, on the book's own lane. */
export async function writeShared(
  fs: VaultFs,
  queue: WriteQueue,
  lane: LaneFor,
  bookId: string,
  held: SharedFile,
): Promise<void> {
  await queue.append(lane(bookId), async () => {
    await atomicWrite(fs, sharedPathIn(bookId), new TextEncoder().encode(JSON.stringify(held)))
  })
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

/** The page version this build publishes. */
export const PUBLISH_VERSION = 1

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
): Promise<{
  readonly pages: readonly string[]
  readonly more: boolean
  /** The store to write back: the boundaries this call sealed. */
  readonly held: SharedFile
}> {
  const mine = logOf(held)
    .filter((entry) => entry.device === publisher.device)
    .sort((a, b) => a.seq - b.seq)
  const bySeq = new Map(mine.map((entry) => [entry.seq, entry]))

  /* Every page this device has already served, in the order it served them. */
  const boundaries = held.sealed.filter((one) => one.device === publisher.device)
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
  // Stryker disable OptionalChaining
  const sealedNow: SealedPage[] = paginate(fresh, bounds.budget).map((group) => ({
    device: publisher.device,
    from: group[0]?.seq ?? 0,
    to: group.at(-1)?.seq ?? 0,
  }))
  // Stryker restore OptionalChaining

  const wanted = since[publisher.device] ?? 0
  const pages: string[] = []
  let prevPageHash = ''
  let more = false

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
      v: PUBLISH_VERSION,
      person: publisher.person,
      work: publisher.work,
      device: publisher.device,
      from: boundary.from,
      to: boundary.to,
      prevPageHash,
      entries: group,
      roster: [...publisher.roster],
      revocations: publisher.revocations,
      delegation: publisher.delegation,
    }
    /* `body` has no `sig` and `signedBytes` drops one anyway — a placeholder
       here was a value with no meaning, which reads as though it had one. */
    const sig = await publisher.sign(signedBytes('page', PUBLISH_VERSION, body))
    /* ⚠️ **`canonicalJson`, NOT `signedBytes`, FOR THE BYTES THAT TRAVEL.**
     * `signedBytes` DROPS `sig` — that is what a signature covers — so building
     * the wire bytes from it emits a page with no signature at all, and every
     * recipient answers `not-canonical` because what arrived is not the
     * canonical form of what parsed. Two different strings on purpose, and
     * using one for the other has no symptom on this side. */
    const raw = canonicalJson({ ...body, sig })
    prevPageHash = hash(raw)
    if (boundary.to <= wanted) continue
    if (pages.length >= bounds.maxPages) {
      more = true
      break
    }
    pages.push(raw)
  }

  return {
    pages,
    more,
    held: { ...held, sealed: [...held.sealed, ...sealedNow] },
  }
}
