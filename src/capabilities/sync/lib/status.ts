import { ENVELOPE_ERRORS, ServiceCallError } from '../../../kernel'

/**
 * The sync STATUS store — one snapshot, `getSnapshot`/`subscribe`, no React
 * (WI-C.4). The scheduler writes it; `useSync` and the Storage section read
 * it. `degraded` is the honest state for "the shelf did not answer": the
 * satchel keeps working from what it has and the UI says why.
 *
 * AND THE WORDS (WI-20.25). Every way a session could fail — the shelf
 * offline, this device revoked, a version skew, a full disk, one book's
 * bytes differing — reached the reader as the same sentence, "Paper on your
 * Mac isn't reachable". Wrong for all but the first, and "Mac" was a guess
 * about hardware: a phone paired to a Linux desktop was told about a Mac it
 * does not own. One sentence per kind now, the shelf's own pairing name in
 * it, and the book's title where the refusal is about a book.
 */

export type SyncState = 'idle' | 'syncing' | 'ok' | 'degraded'

export interface SyncStatus {
  readonly state: SyncState
  /** What to tell the reader — e.g. "Paper on Study iMac isn’t reachable", or
   *  after a session that finished with one book refused, which book and why. */
  readonly detail: string | null
  readonly lastSyncAt: number | null
  /** The last session's movement, for the Storage section's line. */
  readonly lastSummary: { readonly pushed: number; readonly pulledRows: number } | null
}

export interface SyncStatusStore {
  getSnapshot(): SyncStatus
  subscribe(listener: () => void): () => void
  set(next: Partial<SyncStatus>): void
}

export function createSyncStatus(): SyncStatusStore {
  let snapshot: SyncStatus = { state: 'idle', detail: null, lastSyncAt: null, lastSummary: null }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    set: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/* ------------------------------------------------------------ the kinds */

/**
 * Why a session, or one book in it, was refused. Each has exactly one
 * sentence below, and `status.test.ts` holds that no two share one.
 */
/**
 * ONE LIST. The union used to be spelled out beside this tuple, member for
 * member, and the two could drift without a compile error; the type is
 * derived from the tuple now, so adding a kind is one edit with its
 * sentence in `describeRefusal` still required by the exhaustive switch.
 */
export const REFUSAL_KINDS = [
  /** No shelf is paired. */
  'unpaired',
  /** No route to the shelf: offline, a dial that timed out, a session lost mid-way. */
  'unreachable',
  /** The shelf no longer admits this device — revoked, or its grants withdrawn. */
  'revoked',
  /** Both devices hold the same role; neither can sync from the other. */
  'role-mismatch',
  /** A protocol, journal-format or sync-version skew between the two builds. */
  'unsupported',
  /** The shelf's journal is still building its baseline. */
  'not-ready',
  /** A book's bytes differ between the devices. */
  'conflict',
  /** A file that is there and will not read, on either side. */
  'unreadable',
  /** A book's content could not be verified or fetched. */
  'content',
  /** The other side answered something this build cannot understand. */
  'broken-peer',
  /** This device is out of space. */
  'disk-full',
  'unknown',
] as const

export type RefusalKind = (typeof REFUSAL_KINDS)[number]

/** One refusal, as the ledger records it in a session's summary. */
export interface SessionRefusal {
  readonly kind: RefusalKind
  /** The book it was about, when it was about one. The cards group is `''`. */
  readonly book?: string
  /** The raw message, for the diagnostic — never shown as the sentence. */
  readonly message: string
}

/** The pull side's quarantine after a session — see `quarantine.ts`. */
export interface QuarantineReport {
  /** Books whose marks answer would not validate and are held for re-fetch. */
  readonly held: number
  /** Dropped off the old end of the bounded list, ever, for this shelf. */
  readonly dropped: number
  /** Held books whose answer validated this session and were merged. */
  readonly repaired: number
}

/** The names the sentences need: the shelf's pairing name, and a book's title. */
export interface RefusalNames {
  readonly shelf: string | null
  readonly title: (book: string) => string | null
}

/* -------------------------------------------------------- classifying */

/** The envelope's own codes, and the ledger's, by kind. */
const KIND_BY_CODE: Readonly<Record<string, RefusalKind>> = {
  [ENVELOPE_ERRORS.disconnected]: 'unreachable',
  [ENVELOPE_ERRORS.timeout]: 'unreachable',
  [ENVELOPE_ERRORS.overloaded]: 'unreachable',
  [ENVELOPE_ERRORS.cancelled]: 'unreachable',
  [ENVELOPE_ERRORS.forbidden]: 'revoked',
  [ENVELOPE_ERRORS.unsupported]: 'unsupported',
  'not-ready': 'not-ready',
  conflict: 'conflict',
  unreadable: 'unreadable',
  'content-unavailable': 'content',
  unverifiable: 'content',
  [ENVELOPE_ERRORS.malformed]: 'broken-peer',
  [ENVELOPE_ERRORS.protocol]: 'broken-peer',
  [ENVELOPE_ERRORS.internal]: 'broken-peer',
  [ENVELOPE_ERRORS.unknownService]: 'broken-peer',
  [ENVELOPE_ERRORS.duplicateId]: 'broken-peer',
  [ENVELOPE_ERRORS.frameTooLarge]: 'broken-peer',
  'not-found': 'broken-peer',
}

/** The peer plugin's `{kind, message}` errors, by kind; a refused session
 *  names its reason in the message and is read below. */
const KIND_BY_PLUGIN_KIND: Readonly<Record<string, RefusalKind>> = {
  roleMismatch: 'role-mismatch',
  peerUnknown: 'unpaired',
  iroh: 'unreachable',
  connect: 'unreachable',
  connection: 'unreachable',
  timeout: 'unreachable',
  streamClosed: 'unreachable',
  streamRead: 'unreachable',
  streamWrite: 'unreachable',
  noSession: 'unreachable',
  sessionUnknown: 'unreachable',
  tooManySessions: 'unreachable',
  /* A download: the shelf does not grant this device the bytes, or what
   * arrived was not the file the record promised. */
  blobRefused: 'revoked',
  blobHashMismatch: 'content',
  blobMismatch: 'content',
  blobInterrupted: 'content',
  blobTooLarge: 'content',
}

const DISK_FULL = /no space left|enospc|quota(?:\s|_)?exceeded|disk full/i

/**
 * What a thrown value means, in the reader's terms.
 *
 * Four shapes reach here: the envelope's `ServiceCallError` (a refusal that
 * crossed the wire, `error.code` typed); the ledger's own local refusals,
 * plain `{code, retryable, message}` objects; the peer plugin's `{kind,
 * message}` objects, where a refused session carries its reason in the
 * message; and plain `Error`s from the filesystem or the ledger's own checks.
 * Anything else is `unknown`; its message goes to the diagnostic, not the
 * sentence.
 */
export function refusalKind(thrown: unknown): RefusalKind {
  if (thrown instanceof ServiceCallError) return KIND_BY_CODE[thrown.error.code] ?? 'unknown'
  if (typeof thrown === 'object' && thrown !== null) {
    const value = thrown as { code?: unknown; kind?: unknown; message?: unknown; name?: unknown }
    const message = typeof value.message === 'string' ? value.message : ''
    /* A code we KNOW answers at once. One we do not — `ENOSPC` off the
     * filesystem, say — used to answer `unknown` here, before the disk-full
     * tell below ever ran; an unknown code falls through instead. */
    if (typeof value.code === 'string') {
      const known = KIND_BY_CODE[value.code]
      if (known !== undefined) return known
    }
    if (typeof value.kind === 'string') {
      if (value.kind === 'sessionRefused') {
        if (/revoked|unknown-peer/.test(message)) return 'revoked'
        if (/role-mismatch/.test(message)) return 'role-mismatch'
        if (/not-ready/.test(message)) return 'not-ready'
        /* The peer WAS reached — it refused. A reason this build does not
         * know is `unknown`, never "isn't reachable", which is false. */
        return 'unknown'
      }
      return KIND_BY_PLUGIN_KIND[value.kind] ?? 'unknown'
    }
    if (value.name === 'QuotaExceededError' || DISK_FULL.test(message)) return 'disk-full'
    if (thrown instanceof Error) {
      if (message === 'not paired with a shelf') return 'unpaired'
      if (/^sync\.\w+ answered /.test(message)) return 'broken-peer'
    }
  }
  return 'unknown'
}

/* ---------------------------------------------------------- the words */

/** The name-less fallback — what the Storage pane says for `degraded` with
 *  no detail. Every real degradation sets a detail through `describeRefusal`. */
export const DEGRADED_DETAIL = 'Your library isn’t reachable'

const quoted = (book: string, names: RefusalNames): string => `“${names.title(book) ?? book}”`
const shelfOr = (names: RefusalNames, fallback: string): string => names.shelf ?? fallback

/** The sentence for one refusal. */
export function describeRefusal(refusal: SessionRefusal, names: RefusalNames): string {
  const book = refusal.book !== undefined && refusal.book !== '' ? quoted(refusal.book, names) : null
  const shelf = shelfOr(names, 'your library')
  switch (refusal.kind) {
    case 'unpaired':
      return 'This device isn’t paired with a library yet'
    case 'unreachable':
      return names.shelf === null ? DEGRADED_DETAIL : `Paper on ${names.shelf} isn’t reachable`
    case 'revoked':
      return `${capital(shelf)} no longer allows this device — pair it again`
    case 'role-mismatch':
      return 'Both devices are set the same way, so neither can sync from the other'
    case 'unsupported':
      return `${capital(shelf)} runs a different version of Paper — update both`
    case 'not-ready':
      return `${capital(shelf)} is still getting its library ready — try again shortly`
    case 'conflict':
      return book === null ? `A book’s file differs from the one on ${shelf}` : `${book} has a different file on ${shelf}`
    case 'unreadable':
      return book === null ? 'A book’s file couldn’t be read' : `${book} couldn’t be read on one of the devices`
    case 'content':
      return book === null ? 'A book’s file couldn’t be verified' : `${book}’s file couldn’t be verified`
    case 'broken-peer':
      /* Symmetric on purpose: `malformed` means the shelf could not read what
       * THIS device sent, `protocol` and `internal` that one side failed. */
      return `Paper on ${shelf} and this device couldn’t understand each other`
    case 'disk-full':
      return 'This device is out of space, so nothing more could be saved'
    case 'unknown':
      /* The raw message goes to the diagnostic (`sync.session-failed`,
       * `sync.push-refused`), never here — `SessionRefusal.message`'s own
       * contract, which this line used to contradict with a path or a
       * protocol internal in the status bar. */
      return 'Sync failed'
  }
}

const capital = (text: string): string => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1))

/**
 * The status line after a session that FINISHED with something to say — a
 * book refused on push, or marks set aside on pull. Null when there is
 * nothing to complain about, which is what a repaired quarantine is.
 */
export function describeSession(
  outcome: { readonly refused: readonly SessionRefusal[]; readonly quarantine: QuarantineReport },
  names: RefusalNames,
): string | null {
  const parts: string[] = []
  const [first, ...rest] = outcome.refused
  if (first !== undefined) {
    const more = rest.length === 0 ? '' : ` — and ${rest.length} more couldn’t be synced`
    parts.push(describeRefusal(first, names) + more)
  }
  const { held, dropped } = outcome.quarantine
  if (held > 0 || dropped > 0) {
    const books = held === 1 ? '1 book' : `${held} books`
    const overflow = dropped === 0 ? '' : dropped === 1 ? '; 1 more was set aside unread' : `; ${dropped} more were set aside unread`
    parts.push(`Highlights for ${books} couldn’t be read from ${shelfOr(names, 'your library')}${overflow}`)
  }
  return parts.length === 0 ? null : parts.join('. ')
}
