/**
 * The journal — the replication truth, as the kernel's `MutationRecorder`.
 *
 * `index.json` stays a disposable cache; what replication trusts is this
 * append-only file. The kernel brackets every public folder write with
 * `begin`/`commit`, awaited inside the book's queued task; the composition
 * root (phase C) hands THIS object in as the recorder, and with no sync
 * composed the kernel's no-op default runs instead and nothing here exists.
 *
 * On disk, under the data root:
 *
 *   sync/journal.jsonl        one JSON line per entry, append-only
 *   sync/journal.meta.json    {epoch, nextSeq, journalFormat: 1, state}
 *   sync/journal.dirty        exists while a session is open — see below
 *
 * Entry lines: `{seq, kind: begin|commit|acked, epoch, book, what, at, rev,
 * begin?, origin: local|remote, digest?}` — `rev` and `digest` on commits,
 * `rev` on acks, `begin` (the settled begin's seq) on runtime commits so a
 * commit clears only its OWN bracket. `seq` is one strictly-increasing
 * sequence over every line; `rev` is per-`(book, what)` and monotone,
 * allocated at commit — both VALIDATED at load, with the single epoch: a
 * violation is corruption and throws rather than seeding `nextSeq` from a
 * lie. Cards are one cross-book surface and journal under `book: ''`
 * whatever a caller names. The meta file's `nextSeq` is a FLOOR, not the
 * truth: the truth is the highest seq in the journal, recomputed at load,
 * so the meta file does not need a write per append.
 *
 * DURABILITY. Appends are serialised on one write-queue key (`journal`),
 * appended (never rewritten), and `fsync`ed through the injected hook — the
 * peer plugin's `fs_fsync` in the app, a no-op in tests and the browser. A
 * truncated LAST line is what a crash mid-append leaves and is discarded at
 * load; a malformed line anywhere else is corruption and throws. A `begin`
 * with no later `commit` for its `(book, what)` is what a crash mid-write
 * leaves; load commits it with a fresh seq, and the VERIFY pass squares the
 * claim with the folder: `journal.dirty` is created at open and removed by
 * a drained `close()`, so its presence at open means an unclean shutdown,
 * and each `(book, what)` whose last commit carries a digest is compared
 * against the folder's current digest and re-committed where they differ.
 *
 * PROVENANCE — the echo fix. Every entry carries `origin`. Only `local`
 * commits are push-eligible; applying a pulled row or an ack must journal
 * `remote`. Attribution is by ONE-SHOT EXPECTATION, not by a time window:
 * `markRemote(keys, fn)` registers each named `(book, what)` once, and the
 * NEXT begin for that key is `remote`. The write queue runs one task per
 * book in FIFO order, so the remote apply's begin — enqueued first — is the
 * first to arrive, and a local edit enqueued during the same window keeps
 * its `local`. A time-window flag would have stamped that local edit
 * `remote`, and an edit stamped `remote` is an edit that never pushes.
 *
 * BOOTSTRAP. A shelf that predates the journal has folders and no entries.
 * First open scans `books/star/book.json`, `marks.json`, the cards store
 * and the trash, emits one baseline `local` commit per surface with stamps
 * derived from `hlcOf(addedAt|createdAt)`, migrates trash markers into the
 * presence register, and fsyncs every N records (injectable). The meta file
 * says `building` from the first record and `ready` only at the end — a
 * peer pairing mid-build is told not-ready, and `epoch()` answers null.
 * Killed anywhere, the next open resumes: a `(book, what)` that already has
 * a commit is not re-emitted.
 */

import {
  BOOKS_DIR,
  PRESENCE_KEY,
  PRESENCE_PATH,
  TRASH_DIR,
  atomicWrite,
  hlcOf,
  messageOf,
  notePresence,
  parseRecord,
  readMarks,
  readPresence,
  type Card,
  type Hlc,
  type IndexFs,
  type MutationKind,
  type MutationRecorder,
  type MutationToken,
  type WriteQueue,
  validMarks,
} from '../../../kernel'
import { createDigests } from './journalDigests'
import { scanJournal } from './journalScan'
import { createJournalIndex, nextRev, type KeyState } from './journalIndex'
import { cardsDigest, marksDigest, recordDigest } from './merge'

/** The directory the journal, its meta, its dirty flag and the presence
 *  register all live in — fsynced whenever an ENTRY in it is created,
 *  renamed or removed, so the directory slot survives power loss too. */

/* THE ENTRY, ITS VOCABULARY AND ITS PARSER moved to `journalEntry.ts`.
 *
 * That module is the TRUST BOUNDARY — `journal.jsonl` is a file anything could
 * have written — and it depends on nothing else here, which is what let
 * `journalScan.ts` read it without importing this file and creating a cycle.
 * The gate caught that cycle the first time the scanner was split out, which
 * is exactly what it is for.
 *
 * Re-exported so every existing importer keeps one door. */
export {
  JOURNAL_DIRTY_PATH,
  JOURNAL_FORMAT,
  JOURNAL_KEY,
  JOURNAL_META_PATH,
  JOURNAL_PATH,
  JournalCorruption,
  SYNC_DIR,
  canonicalBook,
  entryOf,
  isValidJsonPrefix,
  keyOf,
} from './journalEntry'
export type { JournalEntry, JournalMeta, JournalOrigin, JournalState } from './journalEntry'

import {
  JOURNAL_DIRTY_PATH,
  JOURNAL_FORMAT,
  JOURNAL_KEY,
  JOURNAL_META_PATH,
  JOURNAL_PATH,
  JournalCorruption,
  SYNC_DIR,
  canonicalBook,
  keyOf,
  type JournalEntry,
  type JournalMeta,
  type JournalOrigin,
  type JournalState,
} from './journalEntry'

/** The filesystem the journal needs: the kernel's, plus a real append when
 *  the platform has one. Without `appendFile` the fallback reads and
 *  rewrites — correct, and O(n) per append, which only tests should pay. */
export interface JournalFs extends IndexFs {
  readonly appendFile?: (path: string, bytes: Uint8Array) => Promise<void>
}

export interface JournalOptions {
  readonly fs: JournalFs
  /** THE SHELF'S QUEUE — the same one the stores write on, so `drain()`
   *  covers the journal too. */
  readonly queue: WriteQueue
  /** The capability's HLC (`createClock`). Stamps every entry. */
  readonly clock: () => Hlc
  /** Durability hook — the plugin's `fs_fsync` in the app. Default no-op. */
  readonly fsync?: (path: string) => Promise<void>
  /** During bootstrap, fsync every N records. Injectable for the kill test. */
  readonly fsyncEvery?: number
  /**
   * How many entries the file may hold before it is compacted in place.
   *
   * `compact()` existed and nothing ever called it, so the journal grew for
   * the life of the library: every open read and split the whole file, every
   * entry stayed in memory, and `feed` rescanned all of it. A shelf edited
   * daily for a year is a file nobody ever asked to keep.
   *
   * The threshold is a FLOOR, not the rule — the rule is below in
   * `overgrown`, which also requires the file to be several times what
   * compaction would leave. A library with more surfaces than this number
   * must not compact on every append to no effect.
   */
  readonly compactEvery?: number
  /**
   * The canonical card rows, tombstones included, for the cards baseline
   * and the verify pass — `services.cards.stored` at composition (WI-10.4),
   * so the journal holds no raw flat-store handle. Absent: no cards.
   */
  readonly cards?: () => readonly Card[]
  /**
   * Told when a corrupt journal was quarantined and rebuilt — see `open`.
   *
   * A hook rather than a `console.error`: the capability holds a scoped
   * `Diagnostics` and this is its news to report. Silence here would make a
   * rebuilt journal indistinguishable from a first run, and the two mean very
   * different things to a peer.
   */
  readonly onQuarantine?: (info: { readonly moved: string; readonly reason: string }) => void
  /**
   * Run the unclean-shutdown verify pass when the dirty flag was up. Default
   * true, which is what the app wants and what recovery means.
   *
   * FALSE IS FOR A PROCESS THAT IS NOT THE LIBRARY'S OWNER — `paper`, which
   * wants to append one commit and leave. That pass walks every book, reads
   * every record and RAISES REVS where it finds a discrepancy; it is the
   * app's job, on the app's schedule, and not something a `paper book add`
   * should do to a sixteen-gigabyte shelf on its way past.
   *
   * Declining it is not the same as declaring the shelf sound, so the dirty
   * flag is RETAINED exactly as it is when the pass runs and cannot finish —
   * the recovery stays owed, and the next app start still performs it.
   */
  readonly recover?: boolean
  /**
   * The queue key a surface's writes actually run on.
   *
   * `markRemote` fences the remote expectation by queueing on this key, so it
   * MUST be the key the kernel's own writers use or the fence orders nothing.
   * It defaulted to the raw book id, and the library's writers queue on
   * `folderOf(bookId)` — `books/<safeId>` — so the two were different keys
   * even with no aliasing in play: the fence ran on an empty lane while a
   * local write sat queued on another, and that local write then consumed the
   * remote expectation and journalled itself `remote`. A local edit marked
   * remote is dropped from the outbox and never pushed.
   *
   * Cards are their own surface with their own key, which is why the kind is
   * passed too. Default keeps the old behaviour for the suites that give the
   * journal a private queue, where ordering against kernel writers is not in
   * question.
   */
  readonly lane?: (book: string, what: MutationKind) => string
}

export interface JournalKeyRef {
  readonly book: string
  readonly what: MutationKind
}

export interface OutboxEntry extends JournalKeyRef {
  readonly rev: number
  readonly seq: number
}

export interface Journal extends MutationRecorder {
  /** Load, recover, bootstrap. Must resolve before anything else is called. */
  open(): Promise<void>
  /** Drain and clear the dirty flag. The clean-shutdown half of the pair. */
  close(): Promise<void>
  /** `building` until the bootstrap finished — then `ready`, forever. */
  state(): JournalState
  /** The epoch — PUBLISHED ONLY WHEN READY; null while building. */
  epoch(): string | null
  /**
   * Run `fn` with each named `(book, what)` expected ONCE as remote: the
   * next begin for that key journals `origin: remote`. See the module note
   * for why this is one-shot per key rather than a time window.
   */
  markRemote<T>(keys: readonly JournalKeyRef[], fn: () => Promise<T>): Promise<T>
  /**
   * The one-shot pair `markRemote` is made of, for a caller that must ARM
   * IN LINE (the ledger): `expectRemote` registers one expectation NOW —
   * synchronous, so it can run inside the surface's own queued task, after
   * every earlier-enqueued local edit has already begun — and returns a
   * TICKET naming exactly that expectation. `clearRemote` takes THAT ticket
   * back when the apply did not consume it (a no-op once it has been):
   * ticket-scoped, because a shared per-key counter let one operation's
   * clear cancel a DIFFERENT operation's still-armed expectation, whose
   * apply then journaled `local` — an echo. An expectation left armed
   * would relabel the NEXT local edit; one cleared by a stranger relabels
   * the remote apply itself.
   */
  expectRemote(book: string, what: MutationKind): number
  clearRemote(book: string, what: MutationKind, ticket: number): void
  /** Commits with `since < seq ≤ until`, coalesced to the last per
   *  `(book, what)`, in seq order — the shelf's change feed. */
  feed(since: number, until: number): readonly JournalEntry[]
  /** What this device still has to push: per `(book, what)`, the latest
   *  LOCAL commit when its rev is newer than the last acked. */
  outbox(): readonly OutboxEntry[]
  /** CAS: acknowledge `(book, what)` at exactly `rev`. False — and nothing
   *  written — when a newer local commit exists; the entry stays pushable. */
  ack(book: string, what: MutationKind, rev: number): Promise<boolean>
  /** Rewrite the file keeping the last commit and ack per key and any
   *  dangling begins. Temp + rename, like every other whole write. */
  compact(): Promise<void>
  /** The highest seq served so far — `hubSeq` in a hello. */
  head(): number
  /** Every entry, for tests and diagnostics. Seq order. */
  entries(): readonly JournalEntry[]
  /**
   * Hear every RUNTIME LOCAL commit — the sync scheduler's debounce input
   * (WI-C.4). Load, recovery and bootstrap do not notify: they describe the
   * past, and a scheduler that synced once per replayed line would sync a
   * thousand times at open. Returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void
}

/** A token the kernel hands back to `commit` — carries the begin's identity. */
interface JournalToken extends MutationToken {
  readonly seq: number
  readonly origin: JournalOrigin
}

export function createJournal({
  fs,
  queue,
  clock,
  fsync = async () => {},
  fsyncEvery = 100,
  compactEvery = 2_000,
  cards = () => [],
  onQuarantine,
  recover = true,
  lane = (book) => book,
}: JournalOptions): Journal {
  let meta: JournalMeta | null = null
  let nextSeq = 1
  const index = createJournalIndex()
  /** Every entry, in seq order — the index's list, read here. */
  const all = (): readonly JournalEntry[] => index.entries()
  /** One-shot remote expectations: key → the armed tickets, oldest first.
   *  A begin consumes the oldest; a clear removes exactly its own. */
  const expectedRemote = new Map<string, number[]>()
  let nextTicket = 1
  let opened = false
  /** True once the journal file exists this session — so the FIRST append,
   *  which creates the file, can fsync the directory that now points at it. */
  let journalFileExists = false
  /** True when an unclean-shutdown verify pass could not complete — a folder
   *  it had to read errored rather than answered. The dirty flag then STAYS
   *  through `close`, so the next open retries instead of passing by omission. */
  let verifyIncomplete = false
  /** Runtime local-commit listeners — see `subscribe`. */
  const listeners = new Set<() => void>()
  const notifyLocalCommit = (): void => {
    for (const listener of [...listeners]) {
      /* Isolated: this runs inside the journal's queued task AFTER the
       * commit line is durable, so a throwing subscriber must neither
       * reject a commit that in fact persisted — inviting a retry of a
       * write that happened — nor rob later listeners of the signal. */
      try {
        listener()
      } catch {
        /* The scheduler's problem, not the journal's. */
      }
    }
  }

  /**
   * The next revision for a key — past the last commit AND past the last ack.
   *
   * `lastRev + 1` alone was wrong wherever an ack sits ahead of the surviving
   * commits, which loading explicitly permits: `compact` keeps the last acked
   * entry, so a journal can carry `lastAckedRev` above any commit still in the
   * file. A new local commit allocated at `lastRev + 1` then landed at or
   * below the ack, and `outbox` skips exactly that (`local.rev <= lastAckedRev`)
   * — so the edit was journalled, looked committed, and was never offered to
   * a peer again. Silent, and permanent for that key.
   */

  /* THE INDEX IS ITS OWN MODULE (`journalIndex.ts`). What it holds and the
   * invariants it keeps are stated there; here it is a collaborator, so this
   * file is about the FILE and the index is about what the file says. */
  const keyState = (book: string, what: MutationKind): KeyState => index.keyState(keyOf(book, what))
  const absorb = (entry: JournalEntry): void => index.absorb(entry, keyOf(entry.book, entry.what))

  /* ------------------------------------------------------------ file io */

  /* Fsync the sync DIRECTORY, so a create/rename/remove of an entry in it
   * survives power loss — fsyncing a file's bytes makes the bytes durable,
   * not the directory slot that names them (#8). A no-op in tests and the
   * browser; the peer plugin's `fs_fsync` on the app. */
  const fsyncDir = (): Promise<void> => fsync(SYNC_DIR)

  const encode = (entry: JournalEntry): Uint8Array => new TextEncoder().encode(`${JSON.stringify(entry)}\n`)

  /**
   * Set when an append failed in a way that leaves the FILE and the in-memory
   * state possibly disagreeing — and cleared only by a fresh `open()`.
   *
   * `appendLine` writes the bytes and then fsyncs. Callers do their `absorb`
   * AFTER it returns, so a throw from either half skips the absorb while the
   * bytes may already be on disk. The in-memory `nextSeq` and per-key revs
   * then describe a journal that is one line shorter than the real one, and
   * the next allocation reuses numbers already written. A retried commit
   * appends a duplicate seq — which the loader treats as corruption, not as a
   * crash artefact, and quarantines the whole journal on the next open.
   *
   * Neither half can be made unambiguous from here: a failed `appendFile` may
   * have written some bytes, and a failed `fsync` follows a write that
   * certainly landed in the page cache. So the honest response is to stop
   * using state that may be wrong. `open()` re-reads the file and re-derives
   * everything, which is the only way back — and it is the same recovery a
   * crash gets.
   */
  let poisoned: Error | null = null

  /**
   * A failure that happened BEFORE any byte was written.
   *
   * Only an append that may have reached disk leaves the file and memory
   * possibly disagreeing. The fallback's read of the existing journal happens
   * first and writes nothing, so failing there is an ordinary error — poisoning
   * on it would close the journal over a transient read with no ambiguity to
   * resolve, which is availability spent for nothing.
   */
  class AppendNotAttempted extends Error {
    constructor(readonly cause: unknown) {
      super(messageOf(cause))
      this.name = 'AppendNotAttempted'
    }
  }

  /** Refuse anything that would read or extend state the file may contradict. */
  const refuseIfPoisoned = (): void => {
    if (poisoned) {
      throw new JournalCorruption(
        `journal: an append failed and the file may disagree with memory, so this journal is closed until it is reopened (${poisoned.message})`,
      )
    }
  }

  const appendLine = async (entry: JournalEntry, sync: boolean): Promise<void> => {
    const bytes = encode(entry)
    const creating = !journalFileExists
    if (fs.appendFile) {
      await fs.appendFile(JOURNAL_PATH, bytes)
    } else {
      let held: Uint8Array = new Uint8Array(0)
      try {
        held = await fs.readFile(JOURNAL_PATH)
      } catch (cause) {
        /* ABSENT IS THE ONLY FORGIVABLE FAILURE HERE, and it used to catch
         * every one of them. This fallback rewrites the file IN PLACE from
         * `held`, so a transient read error — a lock, an EIO, a permission
         * that changed — meant appending one line to an empty buffer and
         * writing that over the whole journal. Every prior entry gone, no
         * error raised, and the next open sees a one-line journal it has no
         * reason to distrust.
         *
         * `exists()` is the portable way to ask: the error SHAPE differs
         * between the Node host and the webview's fs plugin, so matching on
         * `ENOENT` would be right on one and silent on the other. */
        if (await fs.exists(JOURNAL_PATH)) throw new AppendNotAttempted(cause)
        /* first line */
      }
      const joined = new Uint8Array(held.length + bytes.length)
      joined.set(held, 0)
      joined.set(bytes, held.length)
      /* The fallback writes IN PLACE, not via a temp neighbour: an append's
       * crash contract is "old bytes plus a possibly-truncated tail", which
       * is exactly what the loader tolerates — a rename would make the crash
       * window all-or-nothing and hide the truncated-tail path from tests. */
      await fs.writeFile(JOURNAL_PATH, joined)
    }
    journalFileExists = true
    if (sync) await fsync(JOURNAL_PATH)
    /* The append that CREATED the file added a directory entry: fsync the
     * directory so a crash cannot lose the slot even after the bytes fsynced. */
    if (creating) await fsyncDir()
  }

  /**
   * `appendLine`, with the one thing every caller needs: a failure here means
   * the caller's `absorb` will not run, so the journal must stop rather than
   * carry on allocating numbers the file may already hold.
   */
  const appendOrPoison = async (entry: JournalEntry, sync: boolean): Promise<void> => {
    refuseIfPoisoned()
    try {
      await appendLine(entry, sync)
    } catch (cause) {
      /* Nothing was written, so nothing is ambiguous: raise the real cause and
       * leave the journal usable. */
      if (cause instanceof AppendNotAttempted) throw cause.cause
      poisoned = cause instanceof Error ? cause : new Error(messageOf(cause))
      throw cause
    }
  }

  const writeMeta = async (value: JournalMeta): Promise<void> => {
    meta = value
    // Whole, small, and via the kernel's temp-and-rename: a torn meta file
    // would cost the epoch, and the epoch is what a peer trusts. The rename
    // changes a directory entry, so the directory is fsynced too (#8).
    await atomicWrite(fs, JOURNAL_META_PATH, new TextEncoder().encode(JSON.stringify(value, null, 2)))
    await fsync(JOURNAL_META_PATH)
    await fsyncDir()
  }

  const readMeta = async (): Promise<JournalMeta | null> => {
    let raw: string
    try {
      raw = new TextDecoder().decode(await fs.readFile(JOURNAL_META_PATH))
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const m = parsed as Record<string, unknown>
    if (typeof m['epoch'] !== 'string' || m['epoch'] === '') return null
    /* Safe, for the same reason `seq` is: a `nextSeq` at 2^53 stops
     * advancing when incremented and every append repeats it. */
    if (typeof m['nextSeq'] !== 'number' || !Number.isSafeInteger(m['nextSeq']) || m['nextSeq'] < 1) return null
    if (m['journalFormat'] !== JOURNAL_FORMAT) {
      throw new Error(`journal: unknown journalFormat ${String(m['journalFormat'])}`)
    }
    if (m['state'] !== 'building' && m['state'] !== 'ready') return null
    return { epoch: m['epoch'], nextSeq: m['nextSeq'], journalFormat: JOURNAL_FORMAT, state: m['state'] }
  }

  /* ------------------------------------------------------------- load */

  const loadLines = async (): Promise<void> => {
    index.clear()
    let text: string
    try {
      text = new TextDecoder().decode(await fs.readFile(JOURNAL_PATH))
    } catch (cause) {
      /* Only a journal that is NOT THERE loads as empty. Treating every read
       * failure as absence let `open()` succeed on a transient error with an
       * empty journal, an empty outbox and a `nextSeq` derived from meta
       * alone — so unsent local commits silently stopped being offered to
       * peers, and the next append began renumbering over entries still on
       * disk. Failing the open instead leaves the file untouched and lets the
       * next start try again. */
      if (await fs.exists(JOURNAL_PATH)) throw cause
      return
    }
    /* The file was there to read, so its directory slot is already durable —
     * the next append is not a create and owes the directory no fsync. */
    journalFileExists = true
    /* THE WHOLE OF WHAT THE TEXT HAS TO SATISFY lives in `journalScan.ts`,
     * as a pure function of the string: the torn-tail rule, the load-time
     * invariants, the begin/commit pairing, the legacy rev renumbering. It
     * left this closure so that every one of them is reachable from a test
     * that writes a string rather than through a filesystem fake and an open.
     *
     * What stays here is what genuinely needs the journal: absorbing the
     * result into the index, and rewriting the file when the scan repaired
     * something. */
    const scanned = scanJournal(text)
    for (const entry of scanned.entries) absorb(entry)
    const { epoch, torn, repaired } = scanned

    /* THE JOURNAL AND ITS META MUST NAME ONE EPOCH (#4). The loader proves
     * the lines agree with each other; this proves they agree with the meta
     * file, whose epoch is what `begin`/`commit` stamp and what a peer trusts
     * — a journal of epoch A opened under a meta of epoch B would append B
     * onto A and fail its own second-epoch check on the very next load. */
    if (epoch !== null && meta !== null && meta.epoch !== epoch) {
      throw new JournalCorruption(`journal: entries name epoch ${JSON.stringify(epoch)} but meta says ${JSON.stringify(meta.epoch)}`)
    }
    if (torn || repaired) {
      /* THE CLEANED BYTES GO DOWN NOW, not merely into memory — a torn tail
       * dropped, or legacy cards revs renumbered. Recovery is about to APPEND
       * — the dangling-begin commits, the verify pass — and an append after a
       * torn tail welds the fragment onto the next line: one malformed line
       * that is NOT the tail, which the next load correctly refuses as
       * corruption. Renumbered revs must land too, or every future load
       * repeats the collision. Found by the crash-point machine
       * (`syncJournal.crash.test.ts`), which is exactly what it is for.
       * Entries re-serialise byte-identically (one field order, stated at
       * `parseEntry`), so this is the valid prefix, atomically. */
      const clean = all().map((entry) => JSON.stringify(entry)).join('\n')
      await atomicWrite(fs, JOURNAL_PATH, new TextEncoder().encode(clean.length ? `${clean}\n` : ''))
      await fsync(JOURNAL_PATH)
      await fsyncDir()
    }
  }

  const recoverDangling = async (): Promise<void> => {
    /* A begin with no commit is what a crash between the two leaves. It is
     * committed NOW with a fresh seq — the write it announced may or may not
     * have landed, which is exactly what the digest verify pass then squares
     * with the folder. */
    for (const state of index.states()) {
      for (const begin of [...state.dangling]) {
        /* THE FOLDER AS IT ACTUALLY IS, stamped onto the recovery commit.
         *
         * This committed with no digest at all, so the key it recovered was
         * then SKIPPED by the verify pass — and skipped on every later open
         * too, since the digestless head persists. A crash between a write and
         * its commit left exactly one key unverifiable: the one that crashed.
         *
         * A read that fails is not an absence: verification stays incomplete
         * so the dirty flag survives `close` and the next open tries again,
         * rather than a clean close certifying a folder nobody could read. */
        let digest: string | undefined
        try {
          digest = (await digestOf(begin.book, begin.what)) ?? undefined
        } catch {
          verifyIncomplete = true
        }
        const entry: JournalEntry = {
          seq: nextSeq++,
          kind: 'commit',
          epoch: begin.epoch,
          book: begin.book,
          what: begin.what,
          at: clock(),
          rev: nextRev(state),
          begin: begin.seq,
          origin: begin.origin,
          ...(digest === undefined ? {} : { digest }),
        }
        await appendOrPoison(entry, true)
        absorb(entry)
      }
    }
  }

  /* THE DIGESTS ARE THEIR OWN MODULE (`journalDigests.ts`). They depend on
   * the filesystem and the card snapshot and on none of this closure's
   * mutable state, so separating them is what makes their one rule —
   * absence is `null`, a failed read THROWS — reachable from a test. */
  const digests = createDigests({ fs, cards })
  const digestOf = digests.of
  const digestForCommit = digests.forCommit

  const verifyAfterUncleanShutdown = async (): Promise<void> => {
    /* Bounded: one digest per (book, what) whose last commit CARRIES a
     * digest — a commit without one has nothing to be compared against. */
    for (const state of index.states()) {
      /* THE LAST COMMIT THAT CAN BE COMPARED, not merely the last one. A
       * digestless head — a recovery commit whose folder could not be read, a
       * line from before digests existed — used to make the whole key
       * invisible here. The digest below is still the newest STATEMENT about
       * this surface, so comparing the folder against it is the same check,
       * one entry further back. */
      const last = state.lastDigested
      if (!last || last.digest === undefined) continue
      let current: string | null
      try {
        current = await digestOf(last.book, last.what)
      } catch {
        /* NOT an absence, NOT a match — verify could not read the folder, so
         * it cannot certify agreement. The dirty flag is RETAINED (below,
         * through `close`) so the next open retries, instead of a clean close
         * clearing it and the discrepancy going unchecked forever (#10). */
        verifyIncomplete = true
        continue
      }
      if (current === null) {
        if (last.what === 'record') {
          /* A record the journal certifies at a digest, GONE from disk: a
           * lost `book.json` unless a REMOVAL explains it — and the arbiter
           * is the presence register, because a RESTORE journals under the
           * same 'removed' kind, so a newer commit alone cannot say which
           * way the book went. Inventing a removal here would REPLICATE the
           * loss, so verification stays incomplete instead — the dirty flag
           * survives `close` and every later open keeps retrying until the
           * folder is resolved. */
          const removed = keyState(last.book, 'removed').lastCommit
          let explained = false
          if (removed && removed.seq > last.seq) {
            try {
              explained = (await readPresence(fs))[last.book]?.state === 'removed'
            } catch {
              explained = false
            }
          }
          if (!explained) verifyIncomplete = true
        }
        continue
      }
      if (current === last.digest) continue
      const entry: JournalEntry = {
        seq: nextSeq++,
        kind: 'commit',
        epoch: last.epoch,
        book: last.book,
        what: last.what,
        at: clock(),
        rev: nextRev(state),
        origin: 'local',
        digest: current,
      }
      await appendOrPoison(entry, true)
      absorb(entry)
    }
  }

  /* -------------------------------------------------------- bootstrap */

  const emitBaseline = async (
    epoch: string,
    book: string,
    what: MutationKind,
    at: Hlc,
    digest: string | undefined,
    pending: { count: number },
  ): Promise<void> => {
    const state = keyState(book, what)
    if (state.lastCommit) return // resumed: already emitted before the kill
    const entry: JournalEntry = {
      seq: nextSeq++,
      kind: 'commit',
      epoch,
      book,
      what,
      at,
      rev: nextRev(state),
      origin: 'local',
      ...(digest === undefined ? {} : { digest }),
    }
    pending.count += 1
    const sync = pending.count % fsyncEvery === 0
    await appendOrPoison(entry, sync)
    absorb(entry)
  }

  const bootstrap = async (): Promise<void> => {
    /* The epoch: kept from a `building` meta (a resumed build), adopted from
     * existing lines when the meta was lost, minted fresh otherwise. */
    const epoch = meta?.epoch ?? (all().length ? all()[all().length - 1]!.epoch : clock())
    if (meta?.state !== 'building') {
      await writeMeta({ epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: 'building' })
    }
    const pending = { count: 0 }

    /* Live folders: one record commit each, marks where a file exists. */
    /* ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER — the rule `readMarks`
     * states in `bookFolder.ts`, undone here at the call site.
     *
     * Every read below used to collapse into "nothing there", and this pass
     * writes `state: 'ready'` when it finishes. So one transient failure —
     * a directory that would not list, a record that would not read — built a
     * baseline permanently missing those books and then declared it
     * authoritative. Peers pull that baseline. Nothing later notices, because
     * a book absent from the feed is indistinguishable from a book that was
     * never there.
     *
     * Meta is already `building` at this point and only becomes `ready` at the
     * end, so THROWING is the whole recovery: the next open sees `building`
     * and bootstraps again. A library that genuinely has no books directory is
     * still empty, which is the truth rather than a guess. */
    let folders: { name: string; isDirectory: boolean }[] = []
    if (await fs.exists(BOOKS_DIR)) {
      folders = await fs.readDir(BOOKS_DIR)
    }
    for (const folder of folders) {
      if (!folder.isDirectory) continue
      const recordPath = `${BOOKS_DIR}/${folder.name}/book.json`
      /* A folder with no record is not a book to the feed; a record that is
       * THERE and will not read is a failure, and is raised. */
      if (!(await fs.exists(recordPath))) continue
      const record = parseRecord(new TextDecoder().decode(await fs.readFile(recordPath)))
      if (!record) continue
      const book = record.bookId ?? folder.name
      const at = hlcOf(record.addedAt)
      await emitBaseline(epoch, book, 'record', at, await recordDigest(record), pending)
      /* NOT CAUGHT. `readMarks` already answers `[]` for a book with no marks
       * and throws only when a marks file is present and will not read or
       * parse — so catching here converted exactly the failures it was
       * written to surface back into "this book has no marks", and then
       * published that to every peer as the baseline.
       *
       * The cost is that one unreadable marks file keeps the bootstrap
       * incomplete rather than finishing without it. That is the loud
       * failure, and the right one: a baseline that understates a book's
       * marks is a baseline peers will merge. */
      const marks = validMarks(await readMarks(fs, book))
      if (marks.length) {
        const newest = marks.reduce((held, mark) => Math.max(held, mark.createdAt), 0)
        await emitBaseline(epoch, book, 'marks', hlcOf(newest), await marksDigest(marks), pending)
      }
    }

    /* The cards collection, whole, when there is one. */
    const held = cards()
    if (held.length) {
      const newest = held.reduce((most, card) => Math.max(most, card.createdAt), 0)
      await emitBaseline(epoch, '', 'cards', hlcOf(newest), await cardsDigest(held), pending)
    }

    /* Trash markers become presence entries — the register outlives the
     * fortnight, the marker does not — and a removal baseline commit. */
    let trashed: { name: string; isDirectory: boolean }[] = []
    try {
      trashed = await fs.readDir(TRASH_DIR)
    } catch {
      trashed = []
    }
    for (const entry of trashed) {
      if (!entry.isDirectory) continue
      let at = hlcOf(0)
      try {
        const stamp = Number(new TextDecoder().decode(await fs.readFile(`${TRASH_DIR}/${entry.name}/.removed`)))
        if (Number.isFinite(stamp)) at = hlcOf(stamp)
      } catch {
        /* An unstamped trash entry is still a removal; the epoch stamp is
         * the honest floor. */
      }
      let bookId = entry.name
      try {
        const record = parseRecord(new TextDecoder().decode(await fs.readFile(`${TRASH_DIR}/${entry.name}/book.json`)))
        if (record?.bookId) bookId = record.bookId
      } catch {
        /* the folder name stands in */
      }
      await queue.append(PRESENCE_KEY, async () => {
        const wrote = await notePresence(fs, bookId, 'removed', at)
        /* THE PRESENCE REGISTER IS FSYNCED BEFORE READY (#7). A trash marker
         * migrated into the register but left non-durable would, after a
         * crash past `ready`, be a book gone from disk with nothing recording
         * that anyone removed it — a deletion that resurrects. Its directory
         * slot goes down too, for the same reason the journal's does (#8). */
        if (wrote) {
          await fsync(PRESENCE_PATH)
          await fsyncDir()
        }
      })
      await emitBaseline(epoch, bookId, 'removed', at, undefined, pending)
    }

    /* Only when the file exists: an EMPTY shelf's bootstrap appends no
     * baseline at all, so there is no journal file yet — and a real fsync
     * of a path that is not there fails, which (now that fsync failures
     * propagate) would fail the very first open of a fresh install. */
    if (await fs.exists(JOURNAL_PATH)) await fsync(JOURNAL_PATH)
    /* READY, and only now: the epoch a peer may learn is the epoch of a
     * complete baseline. */
    await writeMeta({ epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: 'ready' })
  }

  /* ------------------------------------------------------- public api */

  const open = (): Promise<void> =>
    queue.append(JOURNAL_KEY, async () => {
      verifyIncomplete = false
      meta = await readMeta()
      try {
        await loadLines()
      } catch (cause) {
        /* A JOURNAL THAT CONTRADICTS ITSELF IS REBUILT, not refused.
         *
         * Refusing was right about the file and wrong about the consequence:
         * `open` threw, `sync.start` failed, and before ADR 0001 Decision 9
         * that took the whole app down — a reader lost their library because a
         * replication cache had a sequence gap. Even after Decision 9 it left
         * sync permanently dead until someone deleted a file by hand.
         *
         * Rebuilding is sound because THE JOURNAL IS DERIVED. The books, the
         * marks and the cards are the truth, on disk, in their folders;
         * `bootstrap` walks them and emits a complete baseline. What is
         * genuinely lost is which entries a peer had already acknowledged —
         * so the rebuild mints a NEW EPOCH, which is precisely the signal a
         * peer already understands as "my history restarted, resync from
         * scratch". Nothing is silently reconciled behind its back.
         *
         * The file is MOVED, never deleted: it is evidence about a bug that
         * has happened at least once, and a reader's disk is not the place to
         * destroy evidence. */
        if (!(cause instanceof JournalCorruption)) throw cause
        const moved = `${SYNC_DIR}/journal.corrupt-${clock()}.jsonl`
        await fs.rename(JOURNAL_PATH, moved)
        await fs.remove(JOURNAL_META_PATH).catch(() => {})
        index.clear()
        journalFileExists = false
        meta = null
        onQuarantine?.({ moved, reason: cause.message })
      }
      /* THE WAY BACK from a poisoned journal, and the only one: the file has
       * just been re-read and every counter re-derived from it, so whatever
       * the failed append did or did not write is now accounted for. */
      poisoned = null
      nextSeq = Math.max(meta?.nextSeq ?? 1, all().length === 0 ? 1 : all()[all().length - 1]!.seq + 1)
      const wasDirty = await fs.exists(JOURNAL_DIRTY_PATH)
      if (meta === null || meta.state === 'building') {
        await bootstrap()
      }
      await recoverDangling()
      if (wasDirty) {
        if (recover) {
          await verifyAfterUncleanShutdown()
        } else {
          /* The same state an interrupted pass leaves, and for the same
           * reason: verification has NOT happened, so `close` must not clear
           * the flag and advertise a clean shelf. */
          verifyIncomplete = true
        }
      }
      /* AND THE ACCUMULATED CASE. A journal that grew across sessions before
       * this existed — or across a session that never committed enough in one
       * run to trip the check — is shortened once, here, where the file has
       * just been read and every counter re-derived from it. */
      await compactIfOvergrown()
      /* The flag goes up AFTER recovery, so a crash DURING recovery is
       * simply the next open's unclean shutdown again. Creating it adds a
       * directory entry, so the directory is fsynced too (#8). */
      await fs.mkdir(SYNC_DIR)
      await fs.writeFile(JOURNAL_DIRTY_PATH, new Uint8Array(0))
      await fsync(JOURNAL_DIRTY_PATH)
      await fsyncDir()
      opened = true
    })

  const close = (): Promise<void> =>
    queue.append(JOURNAL_KEY, async () => {
      if (!opened) return
      await writeMeta({ epoch: meta!.epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: meta!.state })
      /* THE DIRTY FLAG STAYS while a bracket still dangles between begin and
       * commit (#5), or an unclean-shutdown verify could not finish (#10).
       * Clearing it would advertise a clean shutdown when a commit for that
       * begin can no longer land, or a folder the verify pass could not read
       * was never squared — so the next open must run recovery again, which
       * only the flag's presence triggers. Removing it changes a directory
       * entry, so the directory is fsynced (#8). */
      const dangling = [...index.states()].some((state) => state.dangling.length > 0)
      if (!dangling && !verifyIncomplete) {
        await fs.remove(JOURNAL_DIRTY_PATH)
        await fsyncDir()
      }
      opened = false
    })

  const begin: MutationRecorder['begin'] = (rawBook, what) => {
    /* Per-call, NOT shared: two books' begins can be in flight at once, and
     * a shared slot would hand one caller the other's token. */
    let token: JournalToken | null = null
    const book = canonicalBook(rawBook, what)
    return queue
      .append(JOURNAL_KEY, async () => {
        if (!opened) throw new Error('journal: begin before open')
        const key = keyOf(book, what)
        const armed = expectedRemote.get(key)
        const origin: JournalOrigin = armed !== undefined && armed.length > 0 ? 'remote' : 'local'
        if (origin === 'remote') {
          armed!.shift()
          if (armed!.length === 0) expectedRemote.delete(key)
        }
        const entry: JournalEntry = {
          seq: nextSeq++,
          kind: 'begin',
          epoch: meta!.epoch,
          book,
          what,
          at: clock(),
          origin,
        }
        await appendOrPoison(entry, true)
        absorb(entry)
        token = { book, what, seq: entry.seq, origin }
      })
      .then(() => token!)
  }

  const commit: MutationRecorder['commit'] = (token, digest) =>
    queue.append(JOURNAL_KEY, async () => {
      if (!opened) throw new Error('journal: commit before open')
      const mine = token as JournalToken
      /* The token must be one THIS journal issued and has not yet settled:
       * a foreign or malformed one (no seq), or one already committed,
       * would append a commit line clearing a bracket it does not own. */
      if (typeof mine.seq !== 'number' || !keyState(canonicalBook(mine.book, mine.what), mine.what).dangling.some((begin) => begin.seq === mine.seq)) {
        throw new Error(`journal: commit for an unknown or already-settled begin (seq ${String(mine.seq)})`)
      }
      /* THE COMMIT CARRIES A DIGEST EVEN WHEN THE CALLER GAVE NONE (#6). The
       * kernel writers pass no digest, so without this every kernel-written
       * key was invisible to the unclean-shutdown verify pass — a durable
       * commit paired with a data write the crash lost could never be
       * detected. Computed from the just-written folder, inside the bracket,
       * AFTER the write landed; a read that fails here yields no digest rather
       * than failing the write (the verify pass is the backstop). */
      const measured = digest ?? (await digestForCommit(mine.book, mine.what))
      const state = keyState(mine.book, mine.what)
      const entry: JournalEntry = {
        seq: nextSeq++,
        kind: 'commit',
        epoch: meta!.epoch,
        book: mine.book,
        what: mine.what,
        at: clock(),
        rev: nextRev(state),
        begin: mine.seq,
        origin: mine.origin,
        ...(measured === undefined ? {} : { digest: measured }),
      }
      await appendOrPoison(entry, true)
      absorb(entry)
      if (entry.origin === 'local') notifyLocalCommit()
      /* THE HOUSEKEEPING, on the lane the write already holds. A commit is
       * the last line of a bracket, so this is the point where the file is
       * consistent and nothing is half-written. */
      await compactIfOvergrown()
    })

  const expectRemote = (rawBook: string, what: MutationKind): number => {
    const key = keyOf(canonicalBook(rawBook, what), what)
    const ticket = nextTicket++
    const armed = expectedRemote.get(key) ?? []
    armed.push(ticket)
    expectedRemote.set(key, armed)
    return ticket
  }

  const clearRemote = (rawBook: string, what: MutationKind, ticket: number): void => {
    /* An expectation the apply did not consume — a row that changed
     * nothing writes nothing — must not lie in wait for the NEXT local
     * edit on that key. Removed BY TICKET: taking back "one" from a shared
     * count could take back a concurrent operation's still-armed one. */
    const key = keyOf(canonicalBook(rawBook, what), what)
    const armed = expectedRemote.get(key)
    if (!armed) return
    const at = armed.indexOf(ticket)
    if (at < 0) return
    armed.splice(at, 1)
    if (armed.length === 0) expectedRemote.delete(key)
  }

  const markRemote = async <T,>(keys: readonly JournalKeyRef[], fn: () => Promise<T>): Promise<T> => {
    /* Armed BY FENCE on each surface's queue key — the ledger's applyRemote
     * pattern: armed inline, a LOCAL write already queued for the key would
     * begin first and consume the expectation, and the remote write itself
     * would then journal `local` — an echo. The fence runs after everything
     * already enqueued, immediately before `fn` enqueues the remote write.
     * (In tests that give the journal a private queue the fence degrades to
     * inline arming — ordering only matters on the SHARED queue the
     * composition wires.) */
    refuseIfPoisoned()
    const armed = keys.map(({ book, what }) => ({ book, what, ticket: null as number | null }))
    const fences = armed.map((slot) =>
      /* ON THE SURFACE'S OWN LANE, not the raw id — see `JournalOptions.lane`.
       * Queueing on the id fenced an empty lane while the writes it was meant
       * to order sat on `books/<safeId>`. */
      queue.append(lane(slot.book, slot.what), async () => {
        slot.ticket = expectRemote(slot.book, slot.what)
      }),
    )
    try {
      return await fn()
    } finally {
      await Promise.allSettled(fences)
      for (const { book, what, ticket } of armed) {
        if (ticket !== null) clearRemote(book, what, ticket)
      }
    }
  }

  const feed: Journal['feed'] = (since, until) => {
    /* A feed built from state the file may contradict UNDER-reports: the peer
     * receives a prefix and believes it has everything, and nothing later
     * disagrees. Refusing is loud, and the scheduler already reports a failed
     * pass as degraded. */
    refuseIfPoisoned()
    const last = new Map<string, JournalEntry>()
    for (const entry of all()) {
      if (entry.kind !== 'commit') continue
      if (entry.seq <= since || entry.seq > until) continue
      last.set(keyOf(entry.book, entry.what), entry)
    }
    return [...last.values()].sort((a, b) => a.seq - b.seq)
  }

  const outbox: Journal['outbox'] = () => {
    /* Same reasoning as `feed`: silently offering less than is on disk is how
     * an edit stops being pushed without anyone learning it stopped. */
    refuseIfPoisoned()
    const out: OutboxEntry[] = []
    for (const state of index.states()) {
      const local = state.lastLocalCommit
      if (!local || local.rev! <= state.lastAckedRev) continue
      out.push({ book: local.book, what: local.what, rev: local.rev!, seq: local.seq })
    }
    return out.sort((a, b) => a.seq - b.seq)
  }

  const ack: Journal['ack'] = (rawBook, what, rev) => {
    let done = false
    const book = canonicalBook(rawBook, what)
    return queue
      .append(JOURNAL_KEY, async () => {
      /* A journal whose file may disagree with memory must not extend it:
       * `ack` allocates from that state too. */
      refuseIfPoisoned()
        if (!opened) throw new Error('journal: ack before open')
        const state = keyState(book, what)
        /* CAS ON THE EXACT REV — the deadlock-and-staleness fix from §2.4.
         * The outbox snapshot was taken earlier and released; if a newer
         * LOCAL commit has landed since, this ack is for a state the peer no
         * longer holds, and writing it would mark the newer edit pushed. */
        const latest = state.lastLocalCommit
        if (!latest || latest.rev !== rev || state.lastAckedRev >= rev) return
        const entry: JournalEntry = {
          seq: nextSeq++,
          kind: 'acked',
          epoch: meta!.epoch,
          book,
          what,
          at: clock(),
          rev,
          origin: 'local',
        }
        await appendOrPoison(entry, true)
        absorb(entry)
        done = true
      })
      .then(() => done)
  }

  /**
   * Whether the file is worth rewriting: past the floor AND several times
   * what compaction would leave.
   *
   * The second half is what makes an automatic trigger safe. A library with
   * more surfaces than the floor would otherwise compact on every append and
   * remove almost nothing — paying a whole-file rewrite per edit to save a
   * line. Requiring a four-to-one reduction means every compaction that runs
   * discards at least three quarters of the file, so the cost is amortised
   * however large the shelf is.
   */
  const overgrown = (): boolean => all().length >= Math.max(compactEvery, index.size() * 4)

  /** Compact, ALREADY ON THE JOURNAL LANE. Never call this off it. */
  const compactInPlace = async (): Promise<void> => {
      /* A journal whose file may disagree with memory must not extend it:
       * `compact` allocates from that state too. */
      refuseIfPoisoned()
      if (!opened) throw new Error('journal: compact before open')
      const keep: JournalEntry[] = []
      for (const state of index.states()) {
        if (state.lastCommit) keep.push(state.lastCommit)
        /* AND the last LOCAL commit when a remote one landed after it: the
         * outbox is rebuilt from these lines on reopen, and keeping only
         * the remote head silently unpushed a local edit the peer had not
         * acknowledged yet. */
        if (state.lastLocalCommit && state.lastLocalCommit !== state.lastCommit) {
          keep.push(state.lastLocalCommit)
        }
        if (state.lastAcked) keep.push(state.lastAcked)
        keep.push(...state.dangling)
      }
      keep.sort((a, b) => a.seq - b.seq)
      const text = keep.map((entry) => JSON.stringify(entry)).join('\n')
      await atomicWrite(fs, JOURNAL_PATH, new TextEncoder().encode(text.length ? `${text}\n` : ''))
      await fsync(JOURNAL_PATH)
      await fsyncDir() // the compaction rename changed a directory entry (#8)
      index.clear()
      for (const entry of keep) absorb(entry)
      await writeMeta({ epoch: meta!.epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: meta!.state })
  }

  /* THE QUEUED CALL. `compactInPlace` runs on the journal lane, so the public
   * entry takes the lane and the automatic trigger — which is always already
   * inside a lane task — calls the body. Queueing from inside a lane task
   * would wait for a task that cannot start until this one returns. */
  const compact: Journal['compact'] = () => queue.append(JOURNAL_KEY, compactInPlace)

  /**
   * Compact if the file has outgrown its keep set. ON THE LANE ONLY.
   *
   * A failure here must not fail the write that triggered it: the entry is
   * already durable, and a journal that refuses an edit because it could not
   * tidy itself has turned housekeeping into data loss. The file simply stays
   * long and the next append tries again.
   */
  const compactIfOvergrown = async (): Promise<void> => {
    if (!overgrown()) return
    try {
      await compactInPlace()
    } catch {
      /* Left long on purpose — see above. */
    }
  }

  return {
    open,
    close,
    state: () => meta?.state ?? 'building',
    epoch: () => (meta?.state === 'ready' ? meta.epoch : null),
    begin,
    commit,
    markRemote,
    expectRemote,
    clearRemote,
    feed,
    outbox,
    ack,
    compact,
    head: () => (all().length === 0 ? 0 : all()[all().length - 1]!.seq),
    entries: () => [...all()],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
