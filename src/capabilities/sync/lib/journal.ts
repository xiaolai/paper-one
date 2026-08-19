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
  MUTATION_KINDS,
  PRESENCE_KEY,
  readPresence,
  PRESENCE_PATH,
  TRASH_DIR,
  atomicWrite,
  hlcOf,
  notePresence,
  parseRecord,
  readBook,
  readMarks,
  recordPath,
  validMarks,
  type Card,
  type Hlc,
  type IndexFs,
  type MutationKind,
  type MutationRecorder,
  type MutationToken,
  type WriteQueue,
} from '../../../kernel'
import { isHlc } from './clock'
import { cardsDigest, marksDigest, recordDigest } from './merge'

/** The directory the journal, its meta, its dirty flag and the presence
 *  register all live in — fsynced whenever an ENTRY in it is created,
 *  renamed or removed, so the directory slot survives power loss too. */
export const SYNC_DIR = 'sync'
export const JOURNAL_PATH = 'sync/journal.jsonl'
export const JOURNAL_META_PATH = 'sync/journal.meta.json'
export const JOURNAL_DIRTY_PATH = 'sync/journal.dirty'
export const JOURNAL_FORMAT = 1
/** The one write-queue key every journal mutation is serialised on. */
export const JOURNAL_KEY = 'sync:journal'

export type JournalOrigin = 'local' | 'remote'
export type JournalState = 'building' | 'ready'

export interface JournalEntry {
  readonly seq: number
  readonly kind: 'begin' | 'commit' | 'acked'
  readonly epoch: string
  readonly book: string
  readonly what: MutationKind
  readonly at: Hlc
  /** On commits and acks. */
  readonly rev?: number
  /**
   * On a runtime commit: the `seq` of the begin this commit settles. A
   * commit must clear ONLY its own bracket — brackets on one key can
   * overlap (cards are not serialised by the book queue), and a commit that
   * swept every dangling begin for the key silently un-announced a write
   * still in flight. Absent on baseline/verify commits, which follow no
   * begin; those clear the key whole, the pre-token behaviour.
   */
  readonly begin?: number
  readonly origin: JournalOrigin
  readonly digest?: string
}

interface JournalMeta {
  readonly epoch: string
  readonly nextSeq: number
  readonly journalFormat: number
  readonly state: JournalState
}

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
   * The canonical card rows, tombstones included, for the cards baseline
   * and the verify pass — `services.cards.stored` at composition (WI-10.4),
   * so the journal holds no raw flat-store handle. Absent: no cards.
   */
  readonly cards?: () => readonly Card[]
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

/* Derived from the kernel's own tuple — a kind added there is valid here
 * the same day, not after someone remembers this copy. */
const KNOWN_KINDS: ReadonlySet<string> = new Set(MUTATION_KINDS)

const keyOf = (book: string, what: MutationKind): string => `${what}\u0000${book}`

/**
 * The book a `(book, what)` is journaled under. Cards are ONE cross-book
 * surface and their canonical book is `''` — the same key the bootstrap
 * baseline uses. The kernel's card writer records under `''` too; this is
 * the belt for any other caller and for lines written before the rule, so
 * one surface can never split into unrelated rev and outbox streams again.
 */
const canonicalBook = (book: string, what: MutationKind): string => (what === 'cards' ? '' : book)

interface KeyState {
  lastCommit?: JournalEntry
  lastLocalCommit?: JournalEntry
  lastRev: number
  lastAckedRev: number
  lastAcked?: JournalEntry
  /** Begins with no commit yet, in seq order. */
  dangling: JournalEntry[]
}

/**
 * Validate one PARSED line into an entry — the schema half only. The JSON
 * half stays with the loader, because the two failures mean different
 * things: bytes that do not parse can be a torn append (tolerable at the
 * tail), while a COMPLETE line that is not an entry is corruption wherever
 * it sits, the tail included.
 */
function entryOf(raw: unknown): JournalEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  if (typeof e['seq'] !== 'number' || !Number.isInteger(e['seq']) || e['seq'] < 1) return null
  if (e['kind'] !== 'begin' && e['kind'] !== 'commit' && e['kind'] !== 'acked') return null
  if (typeof e['epoch'] !== 'string' || e['epoch'] === '') return null
  if (typeof e['book'] !== 'string') return null
  if (typeof e['what'] !== 'string' || !KNOWN_KINDS.has(e['what'])) return null
  if (!isHlc(e['at'])) return null
  if (e['origin'] !== 'local' && e['origin'] !== 'remote') return null
  const needsRev = e['kind'] === 'commit' || e['kind'] === 'acked'
  if (needsRev && (typeof e['rev'] !== 'number' || !Number.isInteger(e['rev']) || e['rev'] < 1)) return null
  /* AN INVALID OPTIONAL FIELD IS CORRUPTION, NOT A FIELD TO DROP. A `rev` on a
   * begin, or a non-string / non-commit `digest`, means the line was written
   * by something that did not understand the schema — silently discarding it
   * (the old behaviour) let a garbled line load as a valid entry with its
   * telltale field quietly gone. */
  if (!needsRev && e['rev'] !== undefined) return null
  if (e['digest'] !== undefined && (typeof e['digest'] !== 'string' || e['kind'] !== 'commit')) return null
  const beginRef = e['begin']
  if (
    beginRef !== undefined &&
    (e['kind'] !== 'commit' || typeof beginRef !== 'number' || !Number.isInteger(beginRef) || beginRef < 1 || beginRef >= (e['seq'] as number))
  ) {
    return null
  }
  return {
    seq: e['seq'],
    kind: e['kind'],
    epoch: e['epoch'],
    book: canonicalBook(e['book'], e['what'] as MutationKind),
    what: e['what'] as MutationKind,
    at: e['at'],
    ...(needsRev ? { rev: e['rev'] as number } : {}),
    ...(beginRef === undefined ? {} : { begin: beginRef as number }),
    origin: e['origin'],
    ...(typeof e['digest'] === 'string' ? { digest: e['digest'] } : {}),
  }
}

/**
 * Whether `s` is a strict prefix of some syntactically valid JSON text — the
 * exact shape a crash mid-append leaves of a serialised entry. Arbitrary
 * corruption sitting where the last line should be is NOT such a prefix, and
 * tolerating it as a torn tail would silently erase a line the disk holds.
 *
 * A compact hand-scanner over the JSON grammar rather than a dependency:
 * running out of input mid-value is a valid prefix; a structurally impossible
 * byte, or a complete value with trailing junk, is not.
 */
export function isValidJsonPrefix(s: string): boolean {
  const n = s.length
  if (n === 0) return false

  const skipWs = (i: number): number => {
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++
    return i
  }
  /* Each scanner returns the index AFTER a complete token, `n` when the input
   * ran out mid-token (a valid prefix), or -1 for a structural violation. */
  const scanString = (i: number): number => {
    i++
    while (i < n) {
      const c = s[i]!
      if (c === '\\') {
        if (i + 1 >= n) return n
        const e = s[i + 1]!
        if ('"\\/bfnrt'.includes(e)) {
          i += 2
          continue
        }
        if (e === 'u') {
          for (let k = 0; k < 4; k++) {
            if (i + 2 + k >= n) return n
            if (!/[0-9a-fA-F]/.test(s[i + 2 + k]!)) return -1
          }
          i += 6
          continue
        }
        return -1
      }
      if (c === '"') return i + 1
      if (c.charCodeAt(0) < 0x20) return -1
      i++
    }
    return n
  }
  const scanLiteral = (i: number, word: string): number => {
    for (let k = 0; k < word.length; k++) {
      if (i + k >= n) return n
      if (s[i + k] !== word[k]) return -1
    }
    return i + word.length
  }
  const scanNumber = (i: number): number => {
    const start = i
    if (s[i] === '-') i++
    while (i < n && s[i]! >= '0' && s[i]! <= '9') i++
    if (i < n && s[i] === '.') {
      i++
      while (i < n && s[i]! >= '0' && s[i]! <= '9') i++
    }
    if (i < n && (s[i] === 'e' || s[i] === 'E')) {
      i++
      if (i < n && (s[i] === '+' || s[i] === '-')) i++
      while (i < n && s[i]! >= '0' && s[i]! <= '9') i++
    }
    return i === start ? -1 : i
  }
  const scanValue = (i0: number): number => {
    const i = skipWs(i0)
    if (i >= n) return n
    const c = s[i]!
    if (c === '"') return scanString(i)
    if (c === '{') return scanObject(i)
    if (c === '[') return scanArray(i)
    if (c === 't') return scanLiteral(i, 'true')
    if (c === 'f') return scanLiteral(i, 'false')
    if (c === 'n') return scanLiteral(i, 'null')
    if (c === '-' || (c >= '0' && c <= '9')) return scanNumber(i)
    return -1
  }
  function scanObject(i0: number): number {
    let i = skipWs(i0 + 1)
    if (i >= n) return n
    if (s[i] === '}') return i + 1
    for (;;) {
      i = skipWs(i)
      if (i >= n) return n
      if (s[i] !== '"') return -1
      const afterKey = scanString(i)
      if (afterKey === -1 || afterKey >= n) return afterKey
      i = skipWs(afterKey)
      if (i >= n) return n
      if (s[i] !== ':') return -1
      const afterVal = scanValue(i + 1)
      if (afterVal === -1 || afterVal >= n) return afterVal
      i = skipWs(afterVal)
      if (i >= n) return n
      if (s[i] === '}') return i + 1
      if (s[i] !== ',') return -1
      i++
    }
  }
  function scanArray(i0: number): number {
    let i = skipWs(i0 + 1)
    if (i >= n) return n
    if (s[i] === ']') return i + 1
    for (;;) {
      const afterVal = scanValue(i)
      if (afterVal === -1 || afterVal >= n) return afterVal
      i = skipWs(afterVal)
      if (i >= n) return n
      if (s[i] === ']') return i + 1
      if (s[i] !== ',') return -1
      i++
    }
  }

  const end = scanValue(0)
  if (end === -1) return false
  return skipWs(end) >= n
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
  cards = () => [],
}: JournalOptions): Journal {
  let meta: JournalMeta | null = null
  let nextSeq = 1
  let all: JournalEntry[] = []
  const byKey = new Map<string, KeyState>()
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

  const keyState = (book: string, what: MutationKind): KeyState => {
    const key = keyOf(book, what)
    let held = byKey.get(key)
    if (!held) {
      held = { lastRev: 0, lastAckedRev: 0, dangling: [] }
      byKey.set(key, held)
    }
    return held
  }

  const absorb = (entry: JournalEntry): void => {
    all.push(entry)
    const state = keyState(entry.book, entry.what)
    if (entry.kind === 'begin') {
      state.dangling.push(entry)
    } else if (entry.kind === 'commit') {
      state.lastCommit = entry
      if (entry.origin === 'local') state.lastLocalCommit = entry
      state.lastRev = Math.max(state.lastRev, entry.rev!)
      /* ONLY ITS OWN BRACKET. Brackets on one key can overlap, and a commit
       * that swept the key's every dangling begin dropped a write still in
       * flight from the crash record. A commit with no begin ref (baseline,
       * verify, a legacy line) still clears whole — those commit the key's
       * observed state, not one bracket. */
      state.dangling =
        entry.begin === undefined ? [] : state.dangling.filter((begin) => begin.seq !== entry.begin)
    } else {
      /* NOT validated against the key's commit revs, deliberately: crash
       * recovery renumbers revisions (a dropped tail, legacy cards lines),
       * so an ack honestly ahead of the surviving commits is a state the
       * crash suite REQUIRES loading — the outbox's CAS is what keeps a
       * live ack honest. */
      if (entry.rev! >= state.lastAckedRev) {
        state.lastAckedRev = entry.rev!
        state.lastAcked = entry
      }
    }
  }

  /* ------------------------------------------------------------ file io */

  /* Fsync the sync DIRECTORY, so a create/rename/remove of an entry in it
   * survives power loss — fsyncing a file's bytes makes the bytes durable,
   * not the directory slot that names them (#8). A no-op in tests and the
   * browser; the peer plugin's `fs_fsync` on the app. */
  const fsyncDir = (): Promise<void> => fsync(SYNC_DIR)

  const encode = (entry: JournalEntry): Uint8Array => new TextEncoder().encode(`${JSON.stringify(entry)}\n`)

  const appendLine = async (entry: JournalEntry, sync: boolean): Promise<void> => {
    const bytes = encode(entry)
    const creating = !journalFileExists
    if (fs.appendFile) {
      await fs.appendFile(JOURNAL_PATH, bytes)
    } else {
      let held: Uint8Array = new Uint8Array(0)
      try {
        held = await fs.readFile(JOURNAL_PATH)
      } catch {
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
    if (typeof m['nextSeq'] !== 'number' || !Number.isInteger(m['nextSeq']) || m['nextSeq'] < 1) return null
    if (m['journalFormat'] !== JOURNAL_FORMAT) {
      throw new Error(`journal: unknown journalFormat ${String(m['journalFormat'])}`)
    }
    if (m['state'] !== 'building' && m['state'] !== 'ready') return null
    return { epoch: m['epoch'], nextSeq: m['nextSeq'], journalFormat: JOURNAL_FORMAT, state: m['state'] }
  }

  /* ------------------------------------------------------------- load */

  const loadLines = async (): Promise<void> => {
    all = []
    byKey.clear()
    let text: string
    try {
      text = new TextDecoder().decode(await fs.readFile(JOURNAL_PATH))
    } catch {
      return
    }
    /* The file was there to read, so its directory slot is already durable —
     * the next append is not a create and owes the directory no fsync. */
    journalFileExists = true
    let torn = false
    let repaired = false
    const lines = text.split('\n')
    /* The load-time invariants (#4): one epoch — the same one `meta` names —
     * strictly-increasing seq, strictly-increasing commit and ack revs per
     * key. A journal violating them is not a crash artefact — a crash leaves
     * a PREFIX, and a prefix of a valid journal holds all three — it is
     * corruption, and deriving `nextSeq` from it would serve a feed that
     * disagrees with itself. */
    let lastSeq = 0
    let epoch: string | null = null
    const commitRev = new Map<string, number>()
    const ackedRev = new Map<string, number>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (line === '') continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        /* INCOMPLETE JSON, LAST LINE ONLY, AND ONLY A REAL PREFIX. A crash
         * mid-append truncates the tail into a strict byte-prefix of a
         * serialised entry; bytes that do not parse with valid lines AFTER
         * them, or bytes that are not even a valid JSON prefix, are
         * corruption — tolerating either would serve a feed with a hole in
         * it, or erase a line the disk actually holds. */
        const isTail = lines.slice(i + 1).every((rest) => rest === '')
        if (!isTail) throw new Error(`journal: malformed line ${i + 1} is not the tail`)
        if (!isValidJsonPrefix(line)) {
          throw new Error(`journal: malformed last line ${i + 1} is not a valid entry prefix`)
        }
        torn = true
        break
      }
      let entry = entryOf(raw)
      if (entry === null) {
        /* COMPLETE JSON that is not an entry. A torn append cannot leave
         * this — a byte prefix of `{...}` either fails to parse or IS the
         * whole line — so it is corruption wherever it sits, tail included. */
        throw new Error(`journal: line ${i + 1} is complete but not a journal entry`)
      }
      if (entry.seq <= lastSeq) {
        throw new Error(`journal: seq ${entry.seq} at line ${i + 1} does not increase past ${lastSeq}`)
      }
      lastSeq = entry.seq
      if (epoch === null) epoch = entry.epoch
      else if (entry.epoch !== epoch) {
        throw new Error(`journal: line ${i + 1} names a second epoch`)
      }
      const key = keyOf(entry.book, entry.what)
      if (entry.kind === 'commit') {
        const prev = commitRev.get(key) ?? 0
        if (entry.rev! <= prev) {
          /* CARDS ARE ONE STREAM MADE OF MANY. A legacy journal recorded
           * cards under the caller's book id; canonicalising them to `''`
           * here collapses those streams onto one, and their once-separate
           * revs now collide. Renumber onto a monotone tail rather than
           * refuse to open, and rewrite so the migration is paid once. Every
           * other key colliding is genuine corruption. */
          if (entry.what !== 'cards') {
            throw new Error(`journal: commit rev ${entry.rev} at line ${i + 1} regresses its key`)
          }
          entry = { ...entry, rev: prev + 1 }
          repaired = true
        }
        commitRev.set(key, entry.rev!)
      } else if (entry.kind === 'acked') {
        const prev = ackedRev.get(key) ?? 0
        if (entry.rev! <= prev) {
          if (entry.what !== 'cards') {
            throw new Error(`journal: ack rev ${entry.rev} at line ${i + 1} regresses its key`)
          }
          entry = { ...entry, rev: prev + 1 }
          repaired = true
        }
        ackedRev.set(key, entry.rev!)
      }
      absorb(entry)
    }
    /* THE JOURNAL AND ITS META MUST NAME ONE EPOCH (#4). The loader proves
     * the lines agree with each other; this proves they agree with the meta
     * file, whose epoch is what `begin`/`commit` stamp and what a peer trusts
     * — a journal of epoch A opened under a meta of epoch B would append B
     * onto A and fail its own second-epoch check on the very next load. */
    if (epoch !== null && meta !== null && meta.epoch !== epoch) {
      throw new Error(`journal: entries name epoch ${JSON.stringify(epoch)} but meta says ${JSON.stringify(meta.epoch)}`)
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
      const clean = all.map((entry) => JSON.stringify(entry)).join('\n')
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
    for (const state of byKey.values()) {
      for (const begin of [...state.dangling]) {
        const entry: JournalEntry = {
          seq: nextSeq++,
          kind: 'commit',
          epoch: begin.epoch,
          book: begin.book,
          what: begin.what,
          at: clock(),
          rev: state.lastRev + 1,
          begin: begin.seq,
          origin: begin.origin,
        }
        await appendLine(entry, true)
        absorb(entry)
      }
    }
  }

  /* `book` here is what the kernel handed `begin` — a book ID, from which
   * `readBook`/`readMarks` derive the folder the same way every kernel writer
   * does. `null` is a genuine ABSENCE — a surface with no digest to compute,
   * or a record that is gone — which the verify pass reads as "cannot
   * compare, do not re-commit". An ERROR (a file present but unreadable, a
   * hash that threw) is NOT an absence and is THROWN (#10): verify must not
   * pass by turning a failed read into a matching-looking null. */
  const digestOf = async (book: string, what: MutationKind): Promise<string | null> => {
    if (what === 'record') {
      const record = await readBook(fs, book)
      if (record !== null) return recordDigest(record)
      /* `readBook` answers null for GONE and for BROKEN alike. Present but
       * unreadable is a torn/half-written folder the verify pass must keep
       * chasing, not a book that is simply not there. */
      if (await fs.exists(recordPath(book))) {
        throw new Error(`journal: book.json for ${book} is present but could not be read`)
      }
      return null
    }
    if (what === 'marks') {
      // `readMarks`: absent is `[]`, unreadable THROWS — which propagates as
      // the error it is rather than reading as "no marks".
      return marksDigest(validMarks(await readMarks(fs, book)))
    }
    if (what === 'cards') {
      return cardsDigest(cards())
    }
    return null
  }

  /* Best-effort digest for a COMMIT (#6): the kernel writers pass none, so
   * one is computed from the just-written folder — that is what lets the
   * verify pass detect a durable commit paired with a lost data write. A
   * read that fails here must NOT fail the write, so it commits without a
   * digest — and a digest-less commit is honestly OUTSIDE the verify pass's
   * reach (it compares stored digests): the cost of one unreadable
   * post-write read is one commit the unclean-shutdown check cannot judge,
   * not a failed write. */
  const digestForCommit = async (book: string, what: MutationKind): Promise<string | undefined> => {
    try {
      return (await digestOf(book, what)) ?? undefined
    } catch {
      return undefined
    }
  }

  const verifyAfterUncleanShutdown = async (): Promise<void> => {
    /* Bounded: one digest per (book, what) whose last commit CARRIES a
     * digest — a commit without one has nothing to be compared against. */
    for (const state of byKey.values()) {
      const last = state.lastCommit
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
          const removed = byKey.get(keyOf(last.book, 'removed'))?.lastCommit
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
        rev: state.lastRev + 1,
        origin: 'local',
        digest: current,
      }
      await appendLine(entry, true)
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
      rev: state.lastRev + 1,
      origin: 'local',
      ...(digest === undefined ? {} : { digest }),
    }
    pending.count += 1
    const sync = pending.count % fsyncEvery === 0
    await appendLine(entry, sync)
    absorb(entry)
  }

  const bootstrap = async (): Promise<void> => {
    /* The epoch: kept from a `building` meta (a resumed build), adopted from
     * existing lines when the meta was lost, minted fresh otherwise. */
    const epoch = meta?.epoch ?? (all.length ? all[all.length - 1]!.epoch : clock())
    if (meta?.state !== 'building') {
      await writeMeta({ epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: 'building' })
    }
    const pending = { count: 0 }

    /* Live folders: one record commit each, marks where a file exists. */
    let folders: { name: string; isDirectory: boolean }[] = []
    try {
      folders = await fs.readDir(BOOKS_DIR)
    } catch {
      folders = []
    }
    for (const folder of folders) {
      if (!folder.isDirectory) continue
      let record = null
      try {
        record = parseRecord(new TextDecoder().decode(await fs.readFile(`${BOOKS_DIR}/${folder.name}/book.json`)))
      } catch {
        continue
      }
      if (!record) continue
      const book = record.bookId ?? folder.name
      const at = hlcOf(record.addedAt)
      await emitBaseline(epoch, book, 'record', at, await recordDigest(record), pending)
      try {
        const marks = validMarks(await readMarks(fs, book))
        if (marks.length) {
          const newest = marks.reduce((held, mark) => Math.max(held, mark.createdAt), 0)
          await emitBaseline(epoch, book, 'marks', hlcOf(newest), await marksDigest(marks), pending)
        }
      } catch {
        /* Marks that will not read are that book's problem, not the build's. */
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
      await loadLines()
      nextSeq = Math.max(meta?.nextSeq ?? 1, all.length === 0 ? 1 : all[all.length - 1]!.seq + 1)
      const wasDirty = await fs.exists(JOURNAL_DIRTY_PATH)
      if (meta === null || meta.state === 'building') {
        await bootstrap()
      }
      await recoverDangling()
      if (wasDirty) {
        await verifyAfterUncleanShutdown()
      }
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
      const dangling = [...byKey.values()].some((state) => state.dangling.length > 0)
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
        await appendLine(entry, true)
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
        rev: state.lastRev + 1,
        begin: mine.seq,
        origin: mine.origin,
        ...(measured === undefined ? {} : { digest: measured }),
      }
      await appendLine(entry, true)
      absorb(entry)
      if (entry.origin === 'local') notifyLocalCommit()
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
    const armed = keys.map(({ book, what }) => ({ book, what, ticket: null as number | null }))
    const fences = armed.map((slot) =>
      queue.append(slot.book, async () => {
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
    const last = new Map<string, JournalEntry>()
    for (const entry of all) {
      if (entry.kind !== 'commit') continue
      if (entry.seq <= since || entry.seq > until) continue
      last.set(keyOf(entry.book, entry.what), entry)
    }
    return [...last.values()].sort((a, b) => a.seq - b.seq)
  }

  const outbox: Journal['outbox'] = () => {
    const out: OutboxEntry[] = []
    for (const state of byKey.values()) {
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
        await appendLine(entry, true)
        absorb(entry)
        done = true
      })
      .then(() => done)
  }

  const compact: Journal['compact'] = () =>
    queue.append(JOURNAL_KEY, async () => {
      if (!opened) throw new Error('journal: compact before open')
      const keep: JournalEntry[] = []
      for (const state of byKey.values()) {
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
      all = []
      byKey.clear()
      for (const entry of keep) absorb(entry)
      await writeMeta({ epoch: meta!.epoch, nextSeq, journalFormat: JOURNAL_FORMAT, state: meta!.state })
    })

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
    head: () => (all.length === 0 ? 0 : all[all.length - 1]!.seq),
    entries: () => [...all],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
