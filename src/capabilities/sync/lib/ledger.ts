import {
  BOOKS_DIR,
  CARDS_STORAGE_KEY,
  defineSetting,
  folderOf,
  mergeCards,
  parseCards,
  readBook,
  readMarks,
  readPresence,
  recordPath,
  validMarks,
  type BookRecord,
  type KernelServices,
  type Mark,
  type RemoteRow,
  type ServiceContribution,
  type Setting,
} from '../../../kernel'
import { isHlc, type Clock, type Hlc } from './clock'
import type { Journal, JournalKeyRef } from './journal'
import { canonicalJson, cardsDigest, marksDigest, mergeRecord, toWire } from './merge'
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
  readonly fetchBlob?: (peerId: string, folder: string, blob: BlobFacts) => Promise<void>
  /** Hash a blob in THIS device's data root — the plugin's `peer_hash_file`. */
  readonly hashFile?: (folder: string, name: string) => Promise<{ blake3: string; size: number }>
  readonly pageLimit?: number
}

export interface SyncSummary {
  readonly pushed: number
  readonly pulledRows: number
  readonly pulledRemovals: number
  readonly pulledMarks: number
  readonly pulledCards: boolean
}

export interface Ledger {
  /** The shelf-side handlers, for the peer router. Role-refused at hello. */
  services(): ServiceContribution[]
  /** The satchel side: hello, push everything eligible, pull to the hub's
   *  head, cursor persisted per durable page. */
  runSession(channel: SyncChannel): Promise<SyncSummary>
  /** Download one book's bytes from the shelf — WI-C.3. Resolves with the
   *  verified size, for the Storage section's ledger of downloads. */
  download(channel: SyncChannel, book: string): Promise<{ size: number }>
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

const contentNameOf = (record: BookRecord): string => `content.${record.ext ?? record.format ?? 'bin'}`

export function createLedger({
  services,
  journal,
  clock,
  device,
  role,
  fetchBlob,
  hashFile,
  pageLimit = DEFAULT_PAGE_LIMIT,
}: LedgerOptions): Ledger {
  const { library, marks, cards, settings, fs, storage } = services

  const ownCards = () => parseCards(storage?.getItem(CARDS_STORAGE_KEY) ?? null)
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
      pending.push(apply.run())
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

  const applyIncomingRecord = async (book: string, incoming: BookRecord): Promise<void> => {
    if (rowOf(book)) {
      await library.update(book, foldRecord(incoming))
    } else {
      /* A book this device has never seen: `add` — which also restores a
       * trashed copy rather than writing over it, exactly what a re-add
       * arriving from elsewhere needs. */
      await library.add(book, incoming)
    }
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
    requireReady()
    witnessStamps(group)

    /* The content identity guard (§2.3): both sides hold bytes and the
     * hashes differ ⇒ conflict — never merge, never fetch. Judged BEFORE any
     * state is written. */
    const held = group.book === '' ? null : await ownRecord(group.book)
    const row = group.book === '' ? undefined : rowOf(group.book)
    const ownHasContent = row?.hasContent === true
    if (group.hasContent && ownHasContent && group.contentHash && held?.contentHash && group.contentHash !== held.contentHash) {
      throw refuse('conflict', `content for ${group.book} differs on the two devices`)
    }
    const needsBytes = group.hasContent && !ownHasContent && group.contentHash !== undefined && fetchBlob !== undefined

    const applies: RemoteApply[] = []
    if (group.removed) {
      applies.push({ keys: [{ book: group.book, what: 'removed' }], run: () => library.remove(group.book) })
    }
    if (group.record) {
      const incoming = group.record
      applies.push({ keys: [{ book: group.book, what: 'record' }], run: () => applyIncomingRecord(group.book, incoming) })
    }
    if (group.marks && group.marks.length > 0) {
      const incoming = group.marks
      applies.push({ keys: [{ book: group.book, what: 'marks' }], run: () => marks.mergeRemote(group.book, incoming) })
    }
    if (group.cards) {
      const incoming = group.cards
      applies.push({ keys: [{ book: '', what: 'cards' }], run: () => applyIncomingCards(incoming) })
    }
    await applyRemote(applies)

    if (needsBytes) {
      /* The bytes, then the commit, then — only then — the ack: "import
       * acked only after bytes". The fetch itself journals nothing; the
       * `refreshContent` commit is the remote-origin record of the landing. */
      const folder = blobFolderOf(group.book)
      const name = `content.${group.format ?? 'bin'}`
      await fetchBlob(peer, folder, { name, size: group.size ?? 0, hash: group.contentHash as string })
      if (group.cover) {
        /* A cover that will not land costs the jacket, not the ack. */
        await fetchBlob(peer, folder, group.cover).catch(() => {})
      }
      await applyRemote([{ keys: [{ book: group.book, what: 'content' }], run: () => library.refreshContent(group.book) }])
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
      nextSince: page.length === 0 ? request.until : page[page.length - 1]!.seq,
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
    const content = await facts(contentNameOf(record))
    const cover = (await facts('cover.jpg')) ?? (await facts('cover.webp'))
    return {
      folder,
      name: content?.name ?? contentNameOf(record),
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
      } else if (record && group.record === undefined) {
        // A restore with no record edit: the record IS the news.
        group.record = toWire(record)
      }
    }
    if (hasContent && record) {
      group.format = record.format ?? record.ext ?? 'bin'
      if (record.contentHash) {
        group.contentHash = record.contentHash
      } else if (hashFile) {
        /* No stored hash yet (the lazy backfill has not reached this book):
         * hash the copy now, so the shelf can fetch verified. */
        try {
          const hashed = await hashFile(blobFolderOf(book), contentNameOf(record))
          group.contentHash = hashed.blake3
          group.size = hashed.size
        } catch {
          /* No bytes to hash after all; the shelf will not fetch. */
        }
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

  const pushAll = async (channel: SyncChannel): Promise<number> => {
    let pushed = 0
    for (const [book, revs] of outboxGroups()) {
      const group = await buildGroup(book, revs)
      const answer = await channel.call(SYNC_SERVICES.push.name, group)
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

  const applyPage = async (channel: SyncChannel, page: PullPage): Promise<{ rows: number; removals: number; marksPulled: number; cardsApplied: boolean }> => {
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
      ...page.removals.map(
        (removal): RemoteApply => ({ keys: [{ book: removal.book, what: 'removed' }], run: () => library.remove(removal.book) }),
      ),
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
    /* Marks, for books whose digest differs — each under its own remote
     * bracket. Gated by "Keep notes on this phone": off means only books
     * whose bytes are here. */
    const keepNotes = settings.get(KEEP_NOTES_SETTING)
    for (const row of page.rows) {
      if (row.marksDigest === undefined) continue
      if (!keepNotes && rowOf(row.book)?.hasContent !== true) continue
      const current = await marksDigest(await ownMarks(row.book))
      if (current === row.marksDigest) continue
      const answer = await channel.call(SYNC_SERVICES.marks.name, { book: row.book })
      const parsed = answer && typeof answer === 'object' ? (answer as { book?: unknown; marks?: unknown }) : null
      const rows = Array.isArray(parsed?.marks) ? validMarks(parsed.marks) : null
      if (rows === null) throw new Error('sync.marks answered something that is not a marks list')
      if (rows.length === 0) continue
      witnessStamps(rows)
      await applyRemote([{ keys: [{ book: row.book, what: 'marks' }], run: () => marks.mergeRemote(row.book, rows) }])
      marksPulled += 1
    }
    return { rows: page.rows.length, removals: page.removals.length, marksPulled, cardsApplied }
  }

  const pullAll = async (
    channel: SyncChannel,
    from: number,
    until: number,
    epoch: string,
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
      const applied = await applyPage(channel, page)
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
    if (welcome.journalFormat !== SYNC_JOURNAL_FORMAT) {
      throw new Error(`the shelf journals format ${welcome.journalFormat}; this build speaks ${SYNC_JOURNAL_FORMAT}`)
    }
    if (!versionsOverlap(welcome.services.sync as [number, number], SYNC_VERSION as [number, number])) {
      throw new Error(`the shelf speaks sync [${welcome.services.sync.join(', ')}]; this build [${SYNC_VERSION.join(', ')}]`)
    }
    clock.witness(welcome.clock)

    /* Epoch discipline (§2.4): a shelf whose epoch changed — a rebuilt
     * journal, a restored backup — invalidates every seq this cursor holds;
     * `since` resets to 0 and the catalog re-pulls, merges absorbing it. */
    const cursor = readCursor(channel.peerId)
    const since = cursor !== null && cursor.epoch === welcome.epoch ? cursor.since : 0

    const pushed = await pushAll(channel)
    const pulled = await pullAll(channel, since, welcome.hubSeq, welcome.epoch)
    return {
      pushed,
      pulledRows: pulled.rows,
      pulledRemovals: pulled.removals,
      pulledMarks: pulled.marksPulled,
      pulledCards: pulled.cardsApplied,
    }
  }

  const download: Ledger['download'] = async (channel, book) => {
    if (!fetchBlob) throw new Error('download: no blob transport')
    const answer = parseContentAnswer(await channel.call(SYNC_SERVICES.content.name, { book }))
    if (answer === null) throw new Error('sync.content answered something that is not a content answer')
    if (answer.contentHash === '' || answer.size === 0) throw new Error(`the shelf has no verified bytes for ${book}`)
    await fetchBlob(channel.peerId, answer.folder, { name: answer.name, size: answer.size, hash: answer.contentHash })
    await applyRemote([{ keys: [{ book, what: 'content' }], run: () => library.refreshContent(book) }])
    return { size: answer.size }
  }

  const removeDownload: Ledger['removeDownload'] = async (book) => {
    if (!fs) return
    const record = await ownRecord(book)
    if (record === null) return
    const path = `${folderOf(book)}/${contentNameOf(record)}`
    if (await fs.exists(path)) await fs.remove(path)
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
