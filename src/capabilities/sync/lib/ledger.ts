import {
  BOOKS_DIR,
  ENVELOPE_ERRORS,
  ServiceCallError,
  defineSetting,
  folderOf,
  mergeCards,
  readBook,
  readMarks,
  readPresence,
  recordPath,
  isContentExtension,
  validMarks,
  type BookRecord,
  type ContentBlobName,
  type KernelServices,
  type Mark,
  type RemoteRow,
  type ServiceContribution,
  type Setting,
} from '../../../kernel'
import { isHlc, type Clock, type Hlc } from './clock'
import type { Journal, JournalKeyRef } from './journal'
import { canonicalJson, cardsDigest, marksDigest, mergeRecord, toWire } from './merge'
import { SYNC_QUARANTINE_SETTING, quarantineFor, release, setAside, type Quarantine } from './quarantine'
import { refusalKind, type QuarantineReport, type SessionRefusal } from './status'
import {
  PUSHABLE,
  SYNC_JOURNAL_FORMAT,
  SYNC_PROTO,
  SYNC_SERVICES,
  SYNC_VERSION,
  parseContentAnswer,
  parsePullRequest,
  parsePushAck,
  parsePushGroup,
  parsePullPage,
  parseSyncHello,
  parseSyncWelcome,
  versionsOverlap,
  type ContentAnswer,
  type PullPage,
  type PullRemoval,
  type PullRow,
  type PushAck,
  type PushGroup,
  type Pushable,
  type SyncRole,
} from './protocol'

/**
 * The LEDGER — the machine that speaks §2.5 over any channel that can
 * `call`. One factory, both roles: `services()` is the shelf side (the
 * handlers registered on the peer router), `runSession(channel)` is the
 * satchel side (hello → push → pull, cursor persisted after each durable
 * page). It holds no transport: blobs and hashes arrive as injected
 * functions, so the whole protocol runs over the fake wire in tests and
 * over iroh in the app without a line of difference.
 *
 * PROVENANCE. Every remote application — a pushed row merged by the shelf,
 * a pulled row applied by the satchel, an ack folded in — runs inside
 * `journal.markRemote(keys, …)`, so the kernel's begin/commit bracket lands
 * `origin: remote` and the echo dies where §2.4 says it must. Push
 * eligibility is the journal's outbox filtered to ROW kinds (`PUSHABLE`):
 * content and cover move as blobs, never as push rows, so a Download —
 * which journals a local `content` commit — pushes nothing.
 *
 * DURABILITY ORDER. The shelf acks only after its own merges have resolved,
 * and every merge awaits its journal commit inside the book's queued task —
 * so an ack the satchel sees implies a durable commit line on the shelf.
 * A pushed book whose bytes the shelf lacks is blob-fetched and
 * `refreshContent`-committed BEFORE the ack (import acked only after
 * bytes). The satchel persists `since` only after `applyPage` resolved,
 * which is after every row's write landed.
 */

export interface SyncChannel {
  readonly peerId: string
  call(service: string, body: unknown): Promise<unknown>
}

export interface BlobFacts {
  readonly name: string
  readonly size: number
  readonly hash: string
}

export interface LedgerOptions {
  readonly services: KernelServices
  readonly journal: Journal
  readonly clock: Clock
  /** This device's id (`sync.deviceId`), for the hello. */
  readonly device: string
  readonly role: SyncRole
  /** Fetch a verified blob FROM a peer into this device's data root. */
  /**
   * Fetch one verified blob. `onProgress` is THIS request's own reporting
   * channel — the plugin has always offered it, and threading it is what let
   * the download surface stop matching a global event stream to a book by
   * folder, which a cover fetched from the same folder silently hijacked.
   */
  readonly fetchBlob?: (
    peerId: string,
    folder: string,
    blob: BlobFacts,
    onProgress?: (received: number, total: number) => void,
  ) => Promise<void>
  /** Hash a blob in THIS device's data root — the plugin's `peer_hash_file`. */
  readonly hashFile?: (folder: string, name: string) => Promise<{ blake3: string; size: number }>
  readonly pageLimit?: number
  /**
   * A book whose CONTENT this device did not have has just landed from a peer.
   *
   * The shelf side only, and only for the fetch-then-commit path: a book the
   * reader already had, pushed again because a mark moved, is not an arrival
   * and must not be announced as one. Called after the bytes are committed and
   * before the ack, so a caller that persists it cannot record an arrival the
   * sender was never told about.
   *
   * Best-effort by contract — see the call site. Provenance is a courtesy to
   * the reader, and a courtesy must never be able to fail a replication.
   *
   * MAY RETURN A PROMISE, AND IT IS AWAITED. The type used to be `void` while
   * the caller started an async task inside it, so "called before the ack"
   * was true of the CALL and not of the work: the ack could go out with the
   * arrival unrecorded, and a crash in that window lost the provenance for a
   * book the sender had been told was safely here. A rejection is still
   * contained — the contract above is unchanged.
   */
  readonly onArrived?: (bookId: string, peerId: string) => void | Promise<void>
}

export interface SyncSummary {
  readonly pushed: number
  readonly pulledRows: number
  readonly pulledRemovals: number
  readonly pulledMarks: number
  readonly pulledCards: boolean
  /**
   * Groups the shelf refused ABOUT THE GROUP — a conflict, a malformed
   * group — and the session went on past (WI-20.25). Their revs stay in the
   * outbox and are offered again next session; the reader is told which
   * book, by the status line. Empty when everything was acked.
   */
  readonly refused: readonly SessionRefusal[]
  /** The pull side's quarantine after this session — see `quarantine.ts`. */
  readonly quarantine: QuarantineReport
}

/**
 * What one session accumulates as it goes: the push side's refusals, and the
 * pull side's quarantine as it stood when the session began, moved by what
 * the session found. One object, threaded through the steps, so a step never
 * has to reach for a module-level slot.
 */
interface SessionOutcome {
  readonly refused: SessionRefusal[]
  quarantine: Quarantine
  repaired: number
}

export interface Ledger {
  /** The shelf-side handlers, for the peer router. Role-refused at hello. */
  services(): ServiceContribution[]
  /** The satchel side: hello, push everything eligible, pull to the hub's
   *  head, cursor persisted per durable page. */
  runSession(channel: SyncChannel): Promise<SyncSummary>
  /** Download one book's bytes from the shelf — WI-C.3. Resolves with the
   *  verified size, for the Storage section's ledger of downloads. */
  /** Fetch a book's bytes. `onProgress` reports THIS download's own frames. */
  download(
    channel: SyncChannel,
    book: string,
    onProgress?: (received: number, total: number) => void,
  ): Promise<{ size: number }>
  /** Drop this device's copy of the bytes. Device-local; journals nothing
   *  push-eligible (`content` commits never push). */
  removeDownload(book: string): Promise<void>
}

/** The satchel's cursor: which shelf, which epoch, how far. Persisted in the
 *  settings store AFTER a page is durably applied (§2.5). */
export interface SyncCursor {
  readonly peerId: string
  readonly epoch: string
  readonly since: number
}

export const SYNC_CURSOR_SETTING: Setting<SyncCursor | null> = defineSetting('sync.cursor', null, (raw) => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value['peerId'] !== 'string' || typeof value['epoch'] !== 'string') return undefined
  if (typeof value['since'] !== 'number' || !Number.isInteger(value['since']) || value['since'] < 0) return undefined
  return { peerId: value['peerId'], epoch: value['epoch'], since: value['since'] }
})

/** Pull marks for every annotated book, or only downloaded ones — §2.5's
 *  "Keep notes on this phone", on by default. */
export const KEEP_NOTES_SETTING: Setting<boolean> = defineSetting('sync.keepNotes', true, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
)

const DEFAULT_PAGE_LIMIT = 200

/**
 * A refusal that is about the SESSION rather than about the group it
 * answered: continuing to the next group would fail the same way and tell
 * the reader nothing new. Everything else the shelf refuses is about the one
 * group — a conflict on this book's bytes, a group it could not parse — and
 * the next book is not implicated, because every rev is CAS-acked on its
 * own (WI-20.25).
 */
const SESSION_LEVEL_CODES: ReadonlySet<string> = new Set([
  ENVELOPE_ERRORS.disconnected,
  ENVELOPE_ERRORS.timeout,
  ENVELOPE_ERRORS.overloaded,
  ENVELOPE_ERRORS.cancelled,
  ENVELOPE_ERRORS.forbidden,
  ENVELOPE_ERRORS.unsupported,
  ENVELOPE_ERRORS.unknownService,
  ENVELOPE_ERRORS.duplicateId,
  ENVELOPE_ERRORS.protocol,
  /* The handler threw something it did not classify — "the service failed"
   * — and whether the fault is this group's or the shelf's is unknown. The
   * session ends, as it always did, and the reader sees a failure. */
  ENVELOPE_ERRORS.internal,
  'not-ready',
])

/** The shelf's answer about THIS group, crossed the wire; null for anything
 *  that ends the session — a transport failure, a session-level refusal, a
 *  local throw. */
const aboutTheGroup = (thrown: unknown): ServiceCallError | null =>
  thrown instanceof ServiceCallError && !SESSION_LEVEL_CODES.has(thrown.error.code) ? thrown : null

/** A refusal of this group that will not change by asking again. A RETRYABLE
 *  one — bytes the shelf cannot verify yet, a file mid-repair — still ends
 *  the session, so the reader sees a failure rather than a finished sync
 *  with a book quietly left behind; `a phone import is acked only after the
 *  bytes land` holds that. */
const groupRefusal = (thrown: unknown): ServiceCallError | null => {
  const refused = aboutTheGroup(thrown)
  return refused !== null && !refused.error.retryable ? refused : null
}

/** A `ServiceError`-shaped refusal — structurally what the envelope router
 *  forwards as a typed `err` frame. */
const refuse = (code: string, message: string, retryable = false): { code: string; retryable: boolean; message: string } => ({
  code,
  retryable,
  message,
})

/** A book's folder name — `folderOf` minus the `books/` prefix; what the
 *  blob layer calls the folder. */
export const blobFolderOf = (bookId: string): string => folderOf(bookId).slice(BOOKS_DIR.length + 1)

/**
 * The ONE rule for a book's content blob file NAME (#17), used by every local
 * call site so the name the source hashes, the name a content answer reports,
 * and the name a download removes can never disagree. `ext` leads because it
 * is what the kernel names the file on disk (`content.<ext>`); a device that
 * only ever RECEIVED the bytes has no `ext` (it is device-local, stripped off
 * the wire) and falls through to `format` — which is what it was fetched
 * under — so the rule matches the disk on both an importer and a receiver.
 * The cross-device FETCH still requests `format` alone, because that is the
 * only content-naming field that travels; on an honest import the two agree.
 */
const contentBlobName = (record: {
  readonly format?: string | undefined
  readonly ext?: string | undefined
}): ContentBlobName => {
  /* VALIDATED, not merely concatenated.
   *
   * Both fields are strings read off a record — which may have been
   * hand-edited, or replicated from a peer — so `content.${record.ext}` could
   * name anything at all. The kernel's remove primitive refused it at runtime,
   * which meant a garbled `ext` turned an ordinary eviction into a thrown
   * error rather than a no-op; and the type said `content.${string}`, so
   * nothing complained at compile time either.
   *
   * `bin` is the fallback because it is what the VAULT would have named the
   * file: `extensionFor` stores anything it does not recognise as
   * `content.bin`, so a record whose `ext` is junk describes a file that is
   * either `content.bin` or is not there — and naming a file that is not there
   * removes nothing, which is the right answer for a record nobody can read. */
  for (const candidate of [record.ext, record.format]) {
    if (candidate !== undefined && isContentExtension(candidate)) return `content.${candidate}`
  }
  return 'content.bin'
}

export function createLedger({
  services,
  journal,
  clock,
  device,
  role,
  fetchBlob,
  hashFile,
  pageLimit = DEFAULT_PAGE_LIMIT,
  onArrived,
}: LedgerOptions): Ledger {
  if (!Number.isInteger(pageLimit) || pageLimit < 1) {
    throw new Error(`createLedger: pageLimit must be a positive integer, not ${JSON.stringify(pageLimit)}`)
  }
  const { library, marks, cards, settings, fs } = services

  /* The canonical rows, tombstones included, off the kernel's card store —
   * the authority between writes, so never staler than the flat store's
   * bytes (WI-10.4: sync holds no raw storage handle at all). */
  const ownCards = () => cards.stored()
  /* ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER — `updateBook`'s rule,
   * held here too. `readMarks` already draws the line (absent is `[]`,
   * unreadable throws); swallowing the throw made a momentary read failure
   * look like "no marks", so a push acked rows it never sent and a pull
   * advanced `since` past rows it never served. The error propagates: the
   * push fails un-acked, the page fails un-advanced, and the next session
   * retries. */
  const ownMarks = async (book: string) => {
    if (!fs) return []
    return validMarks(await readMarks(fs, book))
  }
  const ownRecord = async (book: string): Promise<BookRecord | null> => {
    if (!fs) return null
    const record = await readBook(fs, book)
    if (record !== null) return record
    /* `readBook` answers null for gone AND for broken. Present but
     * unreadable is a row this device CANNOT SERVE — never one it does not
     * have. Retryable: a repaired file resumes exactly where this stopped. */
    if (await fs.exists(recordPath(book))) {
      throw refuse('unreadable', `book.json for ${book} is there but could not be read`, true)
    }
    return null
  }
  const rowOf = (book: string) => library.getSnapshot().find((one) => one.bookId === book)

  /**
   * The ONE reconstruction of a book's content blob facts — name, size, hash
   * (#17). Hashing the file is preferred, because it yields the VERIFIED size
   * and the ACTUAL hash of the bytes; the record's stored `contentHash` (with
   * an honest unknown size of 0) is the fallback when there is no hasher or no
   * file under the canonical name. `null` when there is nothing to offer —
   * which is exactly what makes a `hasContent` claim un-servable, and so
   * un-ackable (#15/#16).
   */
  const contentFacts = async (book: string, record: BookRecord): Promise<BlobFacts | null> => {
    const name = contentBlobName(record)
    if (hashFile) {
      try {
        const hashed = await hashFile(blobFolderOf(book), name)
        return { name, size: hashed.size, hash: hashed.blake3 }
      } catch {
        /* No bytes under that name — fall through to the record's stored hash. */
      }
    }
    if (record.contentHash) return { name, size: 0, hash: record.contentHash }
    return null
  }

  /**
   * Bring a book's cover over when the peer offers one and this device lacks
   * it — INDEPENDENT of whether the content is being fetched (#21). A cover
   * that will not land costs the jacket, not the content ack — and the retry
   * is structural, not tracked: every later push of the book offers the
   * cover again and runs this again. (A `coverRetry` set once claimed to
   * carry the retry; nothing ever read it.)
   *
   * The NAME is checked against the one writable cover name before the
   * fetch: `cover.name` crosses the wire, and a peer that labelled its
   * "cover" `content.epub` would otherwise aim the fetch at the book's
   * bytes. The folder never crosses — it is derived locally from the book.
   */
  const ensureCover = async (peer: string, folder: string, cover: PushGroup['cover']): Promise<void> => {
    if (!cover || !fetchBlob) return
    if (cover.name !== 'cover.jpg' && cover.name !== 'cover.webp') return
    if (hashFile) {
      try {
        const have = await hashFile(folder, cover.name)
        if (have.blake3 === cover.hash) return
      } catch {
        /* Not here yet — fetch it below. */
      }
    }
    try {
      await fetchBlob(peer, folder, cover)
    } catch {
      /* This session loses the jacket, not the content; the next push of
       * the book offers it again. */
    }
  }

  /**
   * Apply a removal that arrived from a peer, carrying the STAMP it happened
   * at (#13). The transmitted `at` — never a fresh mint — drives the presence
   * LWW, so a stale removal LOSES to a newer re-add already in the register
   * instead of a fresh stamp overwriting it, and an absent row still records
   * the removal's time rather than discarding it. Only when the removal WINS
   * the register is the book trashed; `library.remove` mints its own stamp for
   * that write, so `at` is re-asserted afterwards — unless a concurrent re-add
   * has since taken the book live — keeping the register's stored time the
   * REAL removal time for onward propagation.
   *
   * It OWNS its provenance rather than riding `applyRemote`'s fence: the trash
   * bracket is enqueued asynchronously (after the LWW read), so a fence armed
   * up-front could be consumed by an unrelated begin in the gap. `markRemote`
   * arms the expectation and calls `library.remove` synchronously inside it,
   * closing that window — which is why the call sites hand removals HERE
   * rather than into the fenced batch.
   */
  const applyRemoteRemoval = async (book: string, at: Hlc): Promise<void> => {
    if (!fs) return
    /* ON THE BOOK'S LANE, both halves in one task — the register write and
     * the folder move — so a guarded `add` for the same book cannot read
     * `live` between them and materialise the folder beside a `removed`
     * register. This used to write `PRESENCE_KEY` directly and call
     * `library.remove` after, outside every book lane; Codex found the race.
     * `markRemote` still arms the provenance so the resulting `removed`
     * commit journals as remote, not as a local removal echoed back. */
    await journal.markRemote([{ book, what: 'removed' }], () => library.noteRemoteRemoval(book, at))
  }

  /**
   * Witness EVERY stamp a received message carries — records' register
   * stamps, marks' and cards' edit and tombstone stamps, removal times —
   * before it is applied. The hello exchanges the clocks, but the state
   * that follows can carry stamps far past either clock (a peer that
   * itself merged from a skewed device), and a local edit made after
   * applying such state must still beat it: LWW without a witnessed floor
   * silently loses the newer edit. Structural, not schema-bound, so a
   * field added to the protocol cannot quietly ship unwitnessed stamps.
   */
  const witnessStamps = (value: unknown): void => {
    if (typeof value === 'string') {
      if (isHlc(value)) clock.witness(value)
      return
    }
    if (Array.isArray(value)) {
      for (const one of value) witnessStamps(one)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) witnessStamps((value as Record<string, unknown>)[key])
    }
  }

  /**
   * Merge-or-keep, identity-guarded so an echo writes nothing. The incoming
   * `bookId` is DROPPED before the fold: `Library.update` hands the change a
   * record without one (the row carries it separately), so a merge that let
   * the wire's `bookId` in would differ from every held record by exactly
   * that key and re-write — and re-journal — a book that had not changed.
   * On disk the id is `writeBook`'s to stamp, and it already has.
   */
  const foldRecord = (incoming: BookRecord) => {
    const { bookId: _incomingId, ...sansId } = incoming
    return (held: BookRecord): BookRecord => {
      const merged = mergeRecord(held, sansId as BookRecord)
      return canonicalJson(merged) === canonicalJson(held) ? held : merged
    }
  }

  /** One remote application: the journal keys its writes will begin under,
   *  and a `run` that ENQUEUES those writes synchronously when called (every
   *  kernel verb does — it computes, then `queue.append`s before awaiting). */
  interface RemoteApply {
    readonly keys: readonly JournalKeyRef[]
    readonly run: () => Promise<unknown>
  }

  /**
   * Run remote applications with EXACT provenance. For each key, a fence
   * task is enqueued on the surface's own write queue that arms the
   * journal's one-shot remote expectation, and the apply is enqueued in the
   * SAME synchronous block — so nothing can land between fence and apply, a
   * local edit enqueued EARLIER has already begun (and stayed `local`,
   * unarmed), and one enqueued LATER begins after the apply consumed the
   * expectation. This is the lock-scope §2.4 describes, made literal; a
   * plain "register, then await the applies" had a window in which an
   * already-enqueued local edit's begin consumed the expectation and the
   * edit silently never pushed. Cards ride the SAME mechanism: the card
   * store writes on the shared queue under its canonical book `''`, so the
   * fence that used to be impossible for cards — and left a same-tick
   * window a local card edit fell into, journaled `remote`, never pushed —
   * is now the ordinary one. Expectations left unconsumed (an identity
   * merge writes nothing) are taken back at the end, each BY ITS TICKET, so
   * one operation's clear can never cancel a concurrent operation's
   * still-armed expectation.
   */
  const applyRemote = async (applies: readonly RemoteApply[]): Promise<void> => {
    const armed: { book: string; what: JournalKeyRef['what']; ticket: number | null }[] = []
    const fences: Promise<void>[] = []
    const pending: Promise<unknown>[] = []
    for (const apply of applies) {
      for (const key of apply.keys) {
        const slot = { book: key.book, what: key.what, ticket: null as number | null }
        armed.push(slot)
        fences.push(
          services.writes.append(key.book, async () => {
            slot.ticket = journal.expectRemote(key.book, key.what)
          }),
        )
      }
      /* `run` must ENQUEUE synchronously (see the module note) — but a
       * synchronous THROW from it would escape before the try below and
       * leave every armed fence loaded for the next local edit. */
      try {
        pending.push(apply.run())
      } catch (thrown) {
        pending.push(Promise.reject(thrown))
      }
    }
    try {
      const outcomes = await Promise.allSettled(pending)
      const failed = outcomes.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
      if (failed.length === 1) throw failed[0]!.reason
      if (failed.length > 1) throw new AggregateError(failed.map((one) => one.reason), `${failed.length} remote applies failed`)
    } finally {
      /* Every fence has RUN before its expectation is taken back — clearing
       * a not-yet-armed one would leave the later arming loaded for the
       * next local edit, which is the exact defect this helper closes. */
      await Promise.allSettled(fences)
      for (const slot of armed) {
        if (slot.ticket !== null) journal.clearRemote(slot.book, slot.what, slot.ticket)
      }
    }
  }

  const applyIncomingRecord = async (book: string, incoming: BookRecord, restoreAt: Hlc | undefined): Promise<void> => {
    if (rowOf(book)) {
      /* On the shelf: an ordinary edit, merged. */
      await library.update(book, foldRecord(incoming))
      return
    }
    if (restoreAt !== undefined) {
      /* A RESTORE, and it carries its own presence stamp. `add`'s guard wins
       * the re-add only if `restoreAt` is newer than a removal the register
       * holds — so a restore at t2 loses to this shelf's own removal at
       * t3 > t2, and beats a removal at t1 < t2. */
      await library.add(book, incoming, false, { asOf: restoreAt })
      return
    }
    /* NO RESTORE INTENT, and not on the shelf. If the register removed this
     * book, the record is a STALE EDIT — a page turn on a book this device
     * removed after the satchel last heard — and the removal stands whatever
     * the record's own stamp says (a page turn at t3 is newer than a removal
     * at t2 and is still not a re-add). Dropped. Otherwise it is a book this
     * device has genuinely never seen: added. */
    if (fs && (await readPresence(fs))[book]?.state === 'removed') return
    await library.add(book, incoming)
  }

  /**
   * Merge incoming cards, ENQUEUED SYNCHRONOUSLY — the property `applyRemote`
   * fences on. `mergeCards` returns its input by identity when nothing
   * changed and the store writes (and brackets) nothing for an identity, so
   * the digest pre-check this used to await added no protection and broke
   * the synchronous-enqueue contract for the one surface with no book queue.
   * Answers whether anything moved, for the session summary.
   */
  const applyIncomingCards = (incoming: PushGroup['cards']): Promise<boolean> => {
    if (!incoming) return Promise.resolve(false)
    let changed = false
    return cards
      .apply((prev) => {
        const next = mergeCards(prev, incoming)
        changed = next !== prev
        return next
      })
      .then(() => changed)
  }

  /* ------------------------------------------------------------ the shelf */

  const requireReady = (): string => {
    const epoch = journal.epoch()
    if (epoch === null) throw refuse('not-ready', 'the journal is still building its baseline', true)
    return epoch
  }

  const handleHello = async (raw: unknown): Promise<unknown> => {
    const hello = parseSyncHello(raw)
    if (hello === null) throw refuse('malformed', 'not a sync hello')
    if (hello.proto !== SYNC_PROTO) throw refuse('unsupported', `proto ${hello.proto} is not ${SYNC_PROTO}`)
    if (hello.journalFormat !== SYNC_JOURNAL_FORMAT) {
      throw refuse('unsupported', `journalFormat ${hello.journalFormat} is not ${SYNC_JOURNAL_FORMAT}`)
    }
    if (!versionsOverlap(hello.services.sync as [number, number], SYNC_VERSION as [number, number])) {
      throw refuse('unsupported', `sync versions [${hello.services.sync.join(', ')}] do not overlap [${SYNC_VERSION.join(', ')}]`)
    }
    if (hello.role !== 'satchel') throw refuse('unsupported', `a ${role} serves satchels, not another ${hello.role}`)
    const epoch = requireReady()
    clock.witness(hello.clock)
    return {
      clock: clock.now(),
      epoch,
      hubSeq: journal.head(),
      journalFormat: SYNC_JOURNAL_FORMAT,
      services: { sync: SYNC_VERSION },
    }
  }

  const handlePush = async (raw: unknown, peer: string): Promise<PushAck> => {
    const group = parsePushGroup(raw)
    if (group === null) throw refuse('malformed', 'not a push group')
    /* The empty book id is RESERVED for the one cross-book cards surface; a
     * group smuggling a record, marks, a removal or content under it would
     * write state under the id `''`. */
    if (
      group.book === '' &&
      (group.record !== undefined ||
        group.marks !== undefined ||
        group.removed !== undefined ||
        group.hasContent ||
        group.contentHash !== undefined ||
        group.size !== undefined ||
        group.cover !== undefined)
    ) {
      throw refuse('malformed', 'the reserved cards group may carry only cards')
    }
    requireReady()
    witnessStamps(group)

    /* The content identity guard (§2.3): both sides hold bytes and the
     * hashes differ ⇒ conflict — never merge, never fetch. Judged BEFORE any
     * state is written. The held hash is NOT trusted from the record alone
     * (#16): a shelf with bytes but no stored `contentHash` is HASHED now, so
     * a remote hash can never be stamped onto unrelated bytes. If identity
     * cannot be established (no hasher, no bytes under the name), the push is
     * REFUSED retryable rather than merged blind. */
    const held = group.book === '' ? null : await ownRecord(group.book)
    const row = group.book === '' ? undefined : rowOf(group.book)
    const ownHasContent = row?.hasContent === true
    if (group.hasContent && ownHasContent && group.contentHash !== undefined && held !== null) {
      let heldHash = held.contentHash
      if (heldHash === undefined) {
        const facts = await contentFacts(group.book, held)
        if (facts === null) {
          throw refuse('unverifiable', `content for ${group.book} is here but its identity cannot be verified`, true)
        }
        heldHash = facts.hash
      }
      if (heldHash !== group.contentHash) {
        throw refuse('conflict', `content for ${group.book} differs on the two devices`)
      }
    }
    /* A push that CLAIMS content this device lacks must arrive with VERIFIED
     * blob facts and a transport to fetch them (#15) — a hash to verify the
     * bytes against, and a `fetchBlob`. Without either, the bytes can never
     * land, so the push must NOT be acked: it is refused retryable, and the
     * satchel keeps the row pushable for the next session. */
    const wantsBytes = group.hasContent && !ownHasContent
    if (wantsBytes && (group.contentHash === undefined || fetchBlob === undefined)) {
      throw refuse('content-unavailable', `push for ${group.book} claims content but sent no verifiable way to fetch it`, true)
    }
    const needsBytes = wantsBytes

    /* The REMOTE-REMOVAL path (#13) is applied on its own, OUTSIDE the fenced
     * batch: it drives the presence LWW with the transmitted stamp and owns
     * its own provenance (see `applyRemoteRemoval`). */
    if (group.removed) await applyRemoteRemoval(group.book, group.removed.at)

    /* A restore carries `live` (its presence stamp); a stale record does not.
     * Both the record and the marks are judged against it: `marks.mergeRemote`
     * on a book the register removed writes a ghost `marks.json` beside the
     * trash, so it is skipped for a removed book with no restore intent, the
     * same rule the record follows. */
    const restoreAt = group.live?.at
    const removedNow = async (): Promise<boolean> => fs !== null && (await readPresence(fs))[group.book]?.state === 'removed'
    const applies: RemoteApply[] = []
    if (group.record) {
      const incoming = group.record
      applies.push({ keys: [{ book: group.book, what: 'record' }], run: () => applyIncomingRecord(group.book, incoming, restoreAt) })
    }
    if (group.marks && group.marks.length > 0) {
      const incoming = group.marks
      applies.push({
        keys: [{ book: group.book, what: 'marks' }],
        run: async () => {
          if (restoreAt === undefined && rowOf(group.book) === undefined && (await removedNow())) return
          await marks.mergeRemote(group.book, incoming)
        },
      })
    }
    if (group.cards) {
      const incoming = group.cards
      applies.push({ keys: [{ book: '', what: 'cards' }], run: () => applyIncomingCards(incoming) })
    }
    await applyRemote(applies)

    const folder = group.book === '' ? '' : blobFolderOf(group.book)
    if (needsBytes) {
      /* The bytes, then the commit, then — only then — the ack: "import
       * acked only after bytes". The name is the ONE canonical rule (#17), so
       * it matches what the satchel serves. The fetch itself journals nothing;
       * the `refreshContent` commit is the remote-origin record of the
       * landing. */
      const name = contentBlobName({ format: group.format })
      await fetchBlob!(peer, folder, { name, size: group.size ?? 0, hash: group.contentHash as string })
      await applyRemote([{ keys: [{ book: group.book, what: 'content' }], run: () => library.refreshContent(group.book) }])
      /* THE READER IS TOLD WHERE IT CAME FROM, and this is the only moment
       * that knows: the merge above has the book, the session has the peer,
       * and one line later the ack goes out and both are gone. Wrapped,
       * because a note about provenance must not be able to fail an import
       * whose bytes are already committed. */
      try {
        await onArrived?.(group.book, peer)
      } catch {
        /* Told nobody. The book is here, which is the part that mattered. */
      }
    }
    /* The cover moves whenever it is offered and this device lacks it —
     * INDEPENDENT of the content fetch (#21), and tracked for retry rather
     * than dropped on failure. */
    if (group.cover && group.book !== '') {
      await ensureCover(peer, folder, group.cover)
    }

    const ack: {
      book: string
      revs: PushGroup['revs']
      record?: BookRecord
      marks?: readonly Mark[]
    } = { book: group.book, revs: group.revs }
    if (group.record) {
      const current = await ownRecord(group.book)
      if (current) ack.record = toWire(current)
    }
    if (group.marks) ack.marks = await ownMarks(group.book)
    return ack as PushAck
  }

  const handlePull = async (raw: unknown): Promise<PullPage> => {
    const request = parsePullRequest(raw)
    if (request === null) throw refuse('malformed', 'not a pull request')
    requireReady()
    if (!fs) throw refuse('internal', 'no filesystem to serve from')
    const presence = await readPresence(fs)
    const entries = journal.feed(request.since, request.until)
    const limit = Math.min(request.limit ?? pageLimit, pageLimit)
    const page = entries.slice(0, limit)
    const done = entries.length <= limit

    const rows: PullRow[] = []
    const removals: PullRemoval[] = []
    const rowFor = new Set<string>()
    const removalFor = new Set<string>()
    let cardsChanged = false
    for (const entry of page) {
      if (entry.what === 'cards') {
        cardsChanged = true
        continue
      }
      if (entry.what === 'removed') {
        const state = presence[entry.book]
        if (state?.state === 'removed') {
          if (!removalFor.has(entry.book)) {
            removalFor.add(entry.book)
            removals.push({ book: entry.book, seq: entry.seq, at: state.at })
          }
          continue
        }
        /* Re-added since: fall through to a row, the record says it lives. */
      }
      if (rowFor.has(entry.book)) continue
      const record = await ownRecord(entry.book)
      if (record === null) continue // gone since; a later `removed` commit carries the news
      rowFor.add(entry.book)
      const row = rowOf(entry.book)
      const bookMarks = await ownMarks(entry.book)
      rows.push({
        book: entry.book,
        seq: entry.seq,
        record: toWire(record),
        hasContent: row?.hasContent === true,
        ...(record.contentHash ? { contentHash: record.contentHash } : {}),
        ...(record.format ? { format: record.format } : {}),
        marksDigest: await marksDigest(bookMarks),
      })
    }

    let wireCards: PullPage['cards']
    if (cardsChanged) {
      const current = ownCards()
      const digest = await cardsDigest(current)
      if (digest !== request.cardsDigest) wireCards = current
    }
    return {
      rows,
      removals,
      ...(wireCards === undefined ? {} : { cards: wireCards }),
      /* A DONE page advances the cursor to the window's end, not to its
       * last visible entry: `journal.head()` counts begins and acks the
       * coalesced feed never serves, so anchoring on the last entry left
       * the cursor forever short of the advertised head — one spurious
       * catch-up round trip per session. */
      nextSince: done ? request.until : page[page.length - 1]!.seq,
      done,
    }
  }

  const handleMarks = async (raw: unknown): Promise<unknown> => {
    if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>)['book'] !== 'string') {
      throw refuse('malformed', 'not a marks request')
    }
    requireReady()
    const book = (raw as Record<string, unknown>)['book'] as string
    return { book, marks: await ownMarks(book) }
  }

  const handleContent = async (raw: unknown): Promise<ContentAnswer> => {
    if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>)['book'] !== 'string') {
      throw refuse('malformed', 'not a content request')
    }
    requireReady()
    const book = (raw as Record<string, unknown>)['book'] as string
    const record = await ownRecord(book)
    if (record === null) throw refuse('not-found', `no book ${JSON.stringify(book)}`)
    const folder = blobFolderOf(book)
    const facts = async (name: string): Promise<{ name: string; size: number; hash: string } | null> => {
      if (!hashFile) return null
      try {
        const hashed = await hashFile(folder, name)
        return { name, size: hashed.size, hash: hashed.blake3 }
      } catch {
        return null
      }
    }
    const contentName = contentBlobName(record)
    const content = await facts(contentName)
    const cover = (await facts('cover.jpg')) ?? (await facts('cover.webp'))
    return {
      folder,
      name: content?.name ?? contentName,
      size: content?.size ?? 0,
      contentHash: content?.hash ?? record.contentHash ?? '',
      coverName: cover?.name ?? null,
      ...(cover ? { coverSize: cover.size, coverHash: cover.hash } : {}),
    }
  }

  /* ---------------------------------------------------------- the satchel */

  const outboxGroups = (): Map<string, Partial<Record<Pushable, number>>> => {
    const groups = new Map<string, Partial<Record<Pushable, number>>>()
    for (const entry of journal.outbox()) {
      if (!(PUSHABLE as readonly string[]).includes(entry.what)) continue
      const held = groups.get(entry.book) ?? {}
      held[entry.what as Pushable] = entry.rev
      groups.set(entry.book, held)
    }
    return groups
  }

  const buildGroup = async (book: string, revs: Partial<Record<Pushable, number>>): Promise<PushGroup> => {
    if (book === '') {
      return { book, revs, cards: ownCards(), hasContent: false }
    }
    const record = await ownRecord(book)
    const row = rowOf(book)
    const hasContent = row?.hasContent === true
    const group: {
      book: string
      revs: typeof revs
      hasContent: boolean
      record?: BookRecord
      marks?: readonly Mark[]
      removed?: { at: Hlc }
      live?: { at: Hlc }
      contentHash?: string
      format?: string
      size?: number
      cover?: { name: string; size: number; hash: string }
    } = { book, revs, hasContent }
    if (revs.record !== undefined && record) group.record = toWire(record)
    if (revs.marks !== undefined) group.marks = await ownMarks(book)
    if (revs.removed !== undefined && fs) {
      const state = (await readPresence(fs))[book]
      if (state?.state === 'removed') {
        group.removed = { at: state.at }
      } else if (state?.state === 'live') {
        /* A RESTORE: the register flipped back to `live`, so the removed rev
         * in the outbox is a re-add. The record is the news, and `live`
         * carries the flip's stamp so the shelf can order it against a
         * removal of its own — without it the shelf would fall back to the
         * record's stamp, which may predate the removal even for a genuine
         * restore. */
        if (group.record === undefined && record) group.record = toWire(record)
        group.live = { at: state.at }
      }
    }
    if (hasContent && record) {
      group.format = record.format ?? record.ext ?? 'bin'
      /* One canonical builder (#17): it hashes the copy — yielding the
       * VERIFIED size and the ACTUAL hash — and falls back to the record's
       * stored hash only when it cannot. Sending the size lets the shelf's
       * verified-facts gate (#15) accept the fetch. */
      const facts = await contentFacts(book, record)
      if (facts) {
        group.contentHash = facts.hash
        if (facts.size > 0) group.size = facts.size
      }
      if (hashFile) {
        try {
          const cover = await hashFile(blobFolderOf(book), 'cover.jpg')
          group.cover = { name: 'cover.jpg', size: cover.size, hash: cover.blake3 }
        } catch {
          /* No cover; nothing to offer. */
        }
      }
    }
    return group
  }

  const applyAck = async (group: PushGroup, ack: PushAck): Promise<void> => {
    /* THE ACK MUST NAME THE PUSH IT ANSWERS — same book, same revs, exactly.
     * The revs to clear come from the GROUP, so an empty or misdirected ack
     * with a perfectly valid shape would otherwise clear revisions its
     * sender never confirmed — an edit marked pushed that never arrived.
     * Zero trust at the boundary: a mismatch is a broken peer, and the
     * session fails loudly with every rev still pushable. */
    if (ack.book !== group.book || PUSHABLE.some((what) => ack.revs[what] !== group.revs[what])) {
      throw new Error('sync.push answered an ack that does not match the pushed group')
    }
    witnessStamps(ack)
    /* AS A MERGE, NEVER AN ASSIGNMENT (§2.3): a delayed ack meeting a newer
     * local (or pulled) state loses on stamps and changes nothing. */
    const applies: RemoteApply[] = []
    if (ack.record && rowOf(ack.book)) {
      const incoming = ack.record
      applies.push({ keys: [{ book: ack.book, what: 'record' }], run: () => library.update(ack.book, foldRecord(incoming)) })
    }
    if (ack.marks && ack.marks.length > 0) {
      const incoming = ack.marks
      applies.push({ keys: [{ book: ack.book, what: 'marks' }], run: () => marks.mergeRemote(ack.book, incoming) })
    }
    await applyRemote(applies)
    /* CAS, per key: a rev outrun by a newer LOCAL commit refuses, and the
     * entry stays pushable — the local edit survives on the wire too. */
    for (const what of PUSHABLE) {
      const rev = group.revs[what]
      if (rev !== undefined) await journal.ack(group.book, what, rev)
    }
  }

  const pushAll = async (channel: SyncChannel, outcome: SessionOutcome): Promise<number> => {
    let pushed = 0
    for (const [book, revs] of outboxGroups()) {
      const group = await buildGroup(book, revs)
      let answer: unknown
      try {
        answer = await channel.call(SYNC_SERVICES.push.name, group)
      } catch (thrown) {
        /* ONE REFUSED GROUP DOES NOT END THE SESSION (WI-20.25). It used to:
         * a `conflict` on one book was offered first every session, refused
         * every session, and every later push and the whole pull sat behind
         * it. The revs stay in the outbox — nothing was acked — and the
         * next group is offered, because each rev is acked on its own and
         * the shelf's answer about this book says nothing about the next.
         * The refusal is recorded so the reader is told WHICH book. A
         * refusal about the session, or anything that did not come from the
         * shelf's handler, still ends it. */
        const refused = groupRefusal(thrown)
        if (refused === null) throw thrown
        outcome.refused.push({ kind: refusalKind(refused), book, message: refused.error.message })
        continue
      }
      const ack = parsePushAck(answer)
      if (ack === null) throw new Error('sync.push answered something that is not an ack')
      await applyAck(group, ack)
      pushed += 1
    }
    return pushed
  }

  const readCursor = (peerId: string): SyncCursor | null => {
    const held = settings.get(SYNC_CURSOR_SETTING)
    return held && held.peerId === peerId ? held : null
  }

  /**
   * One book's marks off the shelf — CORRELATED, and strictly valid. An
   * answer for a different book, a non-list, or a list validation would thin
   * is `invalid`, never a partial merge: a dropped row would otherwise be
   * skipped forever, because the digest comparison that schedules this fetch
   * never re-fires for an already-advanced page. Invalid answers go to the
   * quarantine (below), which is what re-asks.
   */
  const fetchMarks = async (
    channel: SyncChannel,
    book: string,
  ): Promise<{ readonly rows: readonly Mark[] } | { readonly invalid: string }> => {
    const answer = await channel.call(SYNC_SERVICES.marks.name, { book })
    const parsed = answer && typeof answer === 'object' ? (answer as { book?: unknown; marks?: unknown }) : null
    if (parsed?.book !== book) return { invalid: `sync.marks answered book ${JSON.stringify(parsed?.book)} for ${book}` }
    const answered = parsed.marks
    if (!Array.isArray(answered)) return { invalid: 'sync.marks answered something that is not a marks list' }
    const rows = validMarks(answered)
    if (rows.length !== answered.length) {
      return { invalid: `sync.marks answered ${answered.length} rows of which only ${rows.length} are valid marks` }
    }
    return { rows }
  }

  const mergeFetched = async (book: string, rows: readonly Mark[]): Promise<void> => {
    if (rows.length === 0) return
    witnessStamps(rows)
    await applyRemote([{ keys: [{ book, what: 'marks' }], run: () => marks.mergeRemote(book, rows) }])
  }

  /* The quarantine is PERSISTED as it changes, before the page's cursor
   * moves: a kill between the two re-pulls the page (free, every apply is a
   * merge) rather than leaving a book neither fetched nor held. */
  const hold = (outcome: SessionOutcome, next: Quarantine): void => {
    if (next === outcome.quarantine) return
    outcome.quarantine = next
    settings.set(SYNC_QUARANTINE_SETTING, next)
  }

  const applyPage = async (
    channel: SyncChannel,
    page: PullPage,
    outcome: SessionOutcome,
  ): Promise<{ rows: number; removals: number; marksPulled: number; cardsApplied: boolean }> => {
    witnessStamps(page)
    const known = new Set(library.getSnapshot().map((one) => one.bookId))
    const adds: PullRow[] = []
    const updates: RemoteRow[] = []
    for (const row of page.rows) {
      const incoming: BookRecord = { ...row.record, bookId: row.book }
      if (known.has(row.book)) updates.push({ bookId: row.book, change: foldRecord(incoming) })
      else adds.push({ ...row, record: incoming })
    }
    let marksPulled = 0
    let cardsApplied = false
    const applies: RemoteApply[] = [
      ...adds.map((row): RemoteApply => ({ keys: [{ book: row.book, what: 'record' }], run: () => library.add(row.book, row.record) })),
      ...(updates.length > 0
        ? [
            {
              keys: updates.map((row): JournalKeyRef => ({ book: row.bookId, what: 'record' })),
              run: () => library.applyRemoteRows(updates),
            } satisfies RemoteApply,
          ]
        : []),
      ...(page.cards
        ? [
            {
              keys: [{ book: '', what: 'cards' } as JournalKeyRef],
              /* Enqueued synchronously — see `applyIncomingCards`. */
              run: () =>
                applyIncomingCards(page.cards as NonNullable<PullPage['cards']>).then((changed) => {
                  cardsApplied = cardsApplied || changed
                }),
            } satisfies RemoteApply,
          ]
        : []),
    ]
    await applyRemote(applies)
    /* Removals apply OUTSIDE the fenced batch (#13): the transmitted stamp
     * through the LWW register, each owning its own provenance. */
    for (const removal of page.removals) await applyRemoteRemoval(removal.book, removal.at)
    /* Marks, for books whose digest differs — each under its own remote
     * bracket. Gated by "Keep notes on this phone": off means only books
     * whose bytes are here. */
    const keepNotes = settings.get(KEEP_NOTES_SETTING)
    for (const row of page.rows) {
      if (row.marksDigest === undefined) continue
      if (!keepNotes && rowOf(row.book)?.hasContent !== true) continue
      const current = await marksDigest(await ownMarks(row.book))
      if (current === row.marksDigest) continue
      const fetched = await fetchMarks(channel, row.book)
      if ('invalid' in fetched) {
        /* SET ASIDE, NOT THROWN (WI-20.25). Throwing failed this page every
         * session, forever, for one bad row — and every row behind it. The
         * page advances; the book is held and re-asked every session until
         * it answers validly, which is the only way a repair the shelf makes
         * WITHOUT a new seq can ever be seen. */
        hold(outcome, setAside(outcome.quarantine, row.book))
        continue
      }
      /* A valid answer for a book that was held releases it: the shelf's
       * repair, seen on the digest path first. */
      hold(outcome, release(outcome.quarantine, row.book))
      if (fetched.rows.length === 0) continue
      await mergeFetched(row.book, fetched.rows)
      marksPulled += 1
    }
    return { rows: page.rows.length, removals: page.removals.length, marksPulled, cardsApplied }
  }

  /**
   * Re-ask for every held book, REGARDLESS OF DIGEST — the whole reason the
   * quarantine exists. Bounded by the list's cap, so a shelf that answers
   * badly for ten thousand books costs sixty-four calls a session, not ten
   * thousand. A book the shelf no longer has is released: there is nothing
   * left to repair. A refusal about the session ends it, as anywhere.
   */
  const refetchQuarantine = async (channel: SyncChannel, outcome: SessionOutcome): Promise<number> => {
    let repaired = 0
    for (const book of [...outcome.quarantine.books]) {
      let fetched: Awaited<ReturnType<typeof fetchMarks>>
      try {
        fetched = await fetchMarks(channel, book)
      } catch (thrown) {
        /* Refused about this book — retryable or not, it stays held and is
         * asked again next session; that is what the list is for. */
        const refused = aboutTheGroup(thrown)
        if (refused === null) throw thrown
        if (refused.error.code === 'not-found') hold(outcome, release(outcome.quarantine, book))
        continue
      }
      if ('invalid' in fetched) continue
      await mergeFetched(book, fetched.rows)
      hold(outcome, release(outcome.quarantine, book))
      repaired += 1
    }
    return repaired
  }

  const pullAll = async (
    channel: SyncChannel,
    from: number,
    until: number,
    epoch: string,
    outcome: SessionOutcome,
  ): Promise<{ rows: number; removals: number; marksPulled: number; cardsApplied: boolean }> => {
    let since = from
    const totals = { rows: 0, removals: 0, marksPulled: 0, cardsApplied: false }
    for (;;) {
      const raw = await channel.call(SYNC_SERVICES.pull.name, {
        since,
        until,
        limit: pageLimit,
        cardsDigest: await cardsDigest(ownCards()),
      })
      const page = parsePullPage(raw)
      if (page === null) throw new Error('sync.pull answered something that is not a page')
      /* THE PAGE IS JUDGED AGAINST THE CURSOR before a row of it is
       * applied. Shape-valid is not cursor-valid: a `nextSince` behind
       * `since` would replay or — persisted — skip what sat between; one
       * past `until` claims seqs the hello never promised; a non-advancing
       * page that is not terminal loops this session forever. Sequences
       * must climb inside the window, or the shelf is serving a feed that
       * disagrees with itself. */
      if (page.nextSince < since || page.nextSince > until) {
        throw new Error(`sync.pull answered nextSince ${page.nextSince} outside [${since}, ${until}]`)
      }
      if (!page.done && page.nextSince === since) {
        throw new Error('sync.pull answered a page that does not advance and is not terminal')
      }
      for (const list of [page.rows, page.removals] as const) {
        let prev = since
        for (const one of list) {
          if (one.seq <= prev || one.seq > page.nextSince) {
            throw new Error(`sync.pull answered seq ${one.seq} outside its page window`)
          }
          prev = one.seq
        }
      }
      const applied = await applyPage(channel, page, outcome)
      totals.rows += applied.rows
      totals.removals += applied.removals
      totals.marksPulled += applied.marksPulled
      totals.cardsApplied = totals.cardsApplied || applied.cardsApplied
      /* The cursor moves only now — after the page is durably applied. A
       * kill anywhere above re-pulls this page, and every apply is a merge,
       * so the replay is free. */
      settings.set(SYNC_CURSOR_SETTING, { peerId: channel.peerId, epoch, since: page.nextSince })
      since = page.nextSince
      if (page.done) break
    }
    return totals
  }

  const runSession: Ledger['runSession'] = async (channel) => {
    const welcomeRaw = await channel.call(SYNC_SERVICES.hello.name, {
      proto: SYNC_PROTO,
      journalFormat: SYNC_JOURNAL_FORMAT,
      services: { sync: SYNC_VERSION },
      device,
      role,
      clock: clock.now(),
    })
    const welcome = parseSyncWelcome(welcomeRaw)
    if (welcome === null) throw new Error('sync.hello answered something that is not a welcome')
    /* TYPED, like the shelf's own refusal of a skewed hello — the status
     * line reads the code, and a version skew must not be worded as "not
     * reachable" (WI-20.25). */
    if (welcome.journalFormat !== SYNC_JOURNAL_FORMAT) {
      throw refuse('unsupported', `the shelf journals format ${welcome.journalFormat}; this build speaks ${SYNC_JOURNAL_FORMAT}`)
    }
    if (!versionsOverlap(welcome.services.sync as [number, number], SYNC_VERSION as [number, number])) {
      throw refuse('unsupported', `the shelf speaks sync [${welcome.services.sync.join(', ')}]; this build [${SYNC_VERSION.join(', ')}]`)
    }
    clock.witness(welcome.clock)

    /* Epoch discipline (§2.4): a shelf whose epoch changed — a rebuilt
     * journal, a restored backup — invalidates every seq this cursor holds;
     * `since` resets to 0 and the catalog re-pulls, merges absorbing it. */
    const cursor = readCursor(channel.peerId)
    const since = cursor !== null && cursor.epoch === welcome.epoch ? cursor.since : 0

    const outcome: SessionOutcome = {
      refused: [],
      quarantine: quarantineFor(settings.get(SYNC_QUARANTINE_SETTING), channel.peerId),
      repaired: 0,
    }
    const pushed = await pushAll(channel, outcome)
    /* The held books first, then the pull: what THIS session sets aside is
     * not re-asked in the same breath. */
    outcome.repaired = await refetchQuarantine(channel, outcome)
    const pulled = await pullAll(channel, since, welcome.hubSeq, welcome.epoch, outcome)
    return {
      pushed,
      pulledRows: pulled.rows,
      pulledRemovals: pulled.removals,
      pulledMarks: pulled.marksPulled,
      pulledCards: pulled.cardsApplied,
      refused: outcome.refused,
      quarantine: { held: outcome.quarantine.books.length, dropped: outcome.quarantine.dropped, repaired: outcome.repaired },
    }
  }

  const download: Ledger['download'] = async (channel, book, onProgress) => {
    if (!fetchBlob) throw new Error('download: no blob transport')
    const answer = parseContentAnswer(await channel.call(SYNC_SERVICES.content.name, { book }))
    if (answer === null) throw new Error('sync.content answered something that is not a content answer')
    if (answer.contentHash === '' || answer.size === 0) throw new Error(`the shelf has no verified bytes for ${book}`)
    /* The answer's folder and name cross the wire — CORRELATED to the book
     * this device asked for before any byte lands. Folder names are
     * deterministic (`safeId`), so the shelf's folder for the book IS the
     * local one; an answer naming any other folder, or a non-content name,
     * would aim the landing at somebody else's files. */
    if (answer.folder !== blobFolderOf(book)) {
      throw new Error(`sync.content answered folder ${JSON.stringify(answer.folder)} for ${book}`)
    }
    if (!answer.name.startsWith('content.')) {
      throw new Error(`sync.content answered a non-content name ${JSON.stringify(answer.name)}`)
    }
    await fetchBlob(
      channel.peerId,
      answer.folder,
      { name: answer.name, size: answer.size, hash: answer.contentHash },
      onProgress,
    )
    await applyRemote([{ keys: [{ book, what: 'content' }], run: () => library.refreshContent(book) }])
    return { size: answer.size }
  }

  const removeDownload: Ledger['removeDownload'] = async (book) => {
    if (!fs) return
    const record = await ownRecord(book)
    if (record === null) return
    /* The ONE door into books/<id>/: the kernel's closed-name primitive
     * (WI-10.2/10.5). This ledger's own fs handle is namespace-confined and
     * cannot reach the book's folder at all. */
    await services.removeBlob(book, contentBlobName(record))
    await applyRemote([{ keys: [{ book, what: 'content' }], run: () => library.refreshContent(book) }])
  }

  return {
    services: () => [
      { name: SYNC_SERVICES.hello.name, grant: SYNC_SERVICES.hello.grant, handler: (req) => handleHello(req) },
      { name: SYNC_SERVICES.push.name, grant: SYNC_SERVICES.push.grant, handler: (req, ctx) => handlePush(req, ctx.peer) },
      { name: SYNC_SERVICES.pull.name, grant: SYNC_SERVICES.pull.grant, handler: (req) => handlePull(req) },
      { name: SYNC_SERVICES.marks.name, grant: SYNC_SERVICES.marks.grant, handler: (req) => handleMarks(req) },
      { name: SYNC_SERVICES.content.name, grant: SYNC_SERVICES.content.grant, handler: (req) => handleContent(req) },
    ],
    runSession,
    download,
    removeDownload,
  }
}
