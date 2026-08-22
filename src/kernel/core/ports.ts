import { CONTENT_EXTENSIONS, type ContentExtension } from './bookVault'

/**
 * The kernel's PORTS — the places it calls OUT, each owned here.
 *
 * There were four, all with defaults that stand in for nobody. Phase 11 added
 * three more — `device`, `shelf` and sizes — and those have NULL defaults,
 * which is a different contract and a deliberate one: there is no sensible
 * answer an unbound device or shelf port could give, and a stub returning an
 * empty peer list would be a lie the caller could not detect. A count in this
 * comment would go stale again, so it says what kind of thing they are
 * instead.
 *
 * The kernel imports nothing from a capability (`.dependency-cruiser.cjs`,
 * `no-kernel-to-capabilities`). Where it has to call into one — a sync journal
 * bracketing every folder write, a peer plugin asking where a blob may land, a
 * settings pane, a log — it calls one of these, and the composition root
 * injects the real implementation. With no capability composed, the default
 * runs and the reader is exactly the reader it was: that is what makes
 * "delete the capability" an operation the kernel does not notice.
 *
 * `SettingsStore` and `Diagnostics` have working defaults rather than empty
 * ones, because the kernel itself uses them; their factories live beside this
 * file (`settings.ts`, `diagnostics.ts`) — the port is the interface.
 */

/* ------------------------------------------------------------------------ */
/* MutationRecorder                                                          */
/* ------------------------------------------------------------------------ */

/**
 * What kind of thing a writer is about to change in a book's folder. One
 * entry per file a book owns, plus `removed` for the folder going to the
 * trash (or coming back) and `cards` for the cross-book card list, which is
 * not in any folder.
 */
export const MUTATION_KINDS = ['record', 'marks', 'cover', 'content', 'removed', 'cards'] as const
export type MutationKind = (typeof MUTATION_KINDS)[number]

/**
 * What `begin` hands out and `commit` takes back.
 *
 * The kernel reads nothing off it: it names the write it belongs to so a
 * recorder can match the two ends, and an implementation may return a subtype
 * carrying whatever else it needs — a sequence number, a timestamp.
 */
export interface MutationToken {
  readonly book: string
  readonly what: MutationKind
}

/**
 * The bracket around every public kernel write.
 *
 * `begin` BEFORE the file write, `commit` AFTER it, both awaited inside the
 * book's queued task — so a recorder that journals sees "about to change X",
 * then the change, then "changed X", in that order and with nothing else
 * touching the book in between. A write that throws leaves a `begin` with no
 * `commit`, which is what a crash between the two would leave, and is the
 * case a journal's launch recovery exists for.
 *
 * `digest` is optional and unused by the kernel today; the port carries it so
 * a recorder can be told what was written without re-reading it.
 */
export interface MutationRecorder {
  begin(book: string, what: MutationKind): Promise<MutationToken>
  commit(token: MutationToken, digest?: string): Promise<void>
}

/** The default: hands out a token and forgets it. */
export const NOOP_RECORDER: MutationRecorder = {
  begin: async (book, what) => ({ book, what }),
  commit: async () => {},
}

/**
 * Run one write inside the bracket. The single call every kernel writer makes,
 * so the order — begin, write, commit — is stated once rather than in each of
 * them.
 */
export async function recorded<T>(
  recorder: MutationRecorder,
  book: string,
  what: MutationKind,
  write: () => Promise<T>,
): Promise<T> {
  const token = await recorder.begin(book, what)
  const result = await write()
  await recorder.commit(token)
  return result
}

/* ------------------------------------------------------------------------ */
/* DevicePort · ShelfPort · SizePort — the service table's three outward     */
/* nouns (phase 11)                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Three of the service table's nouns are not the kernel's to answer for, and
 * they arrive the way every other outward call does: as a port with a default
 * that stands in for nobody, bound by whoever can implement it.
 *
 *   `device` — pairing state lives in `peers.rs`; the peer capability binds it
 *   `shelf`  — the ROLE, its endpoint, and the journal's head and epoch; the
 *              sync capability binds it
 *   sizes    — bytes on disk, which no filesystem seam the kernel owns can
 *              measure and no webview can; a HOST binds it
 *
 * UNBOUND IS NOT AN ERROR, it is the offline case, and it is answered rather
 * than guessed: `device.*` and `shelf.sync`/`shelf.verify` refuse
 * `unsupported` by name, and `shelf.status` reports `null` for the fields the
 * port would have filled while still counting the books. "No devices" and
 * "this host cannot see devices" are very different facts, and a CLI that
 * conflated them would report a paired phone as forgotten.
 */

/**
 * What a device IS on this network.
 *
 * The two words the Rust, the TypeScript and the docs already use — and the
 * only two `role.rs` can produce. Typed as `string` here, so a row carrying
 * anything at all type-checked, and a service could answer with a role no
 * consumer has a branch for.
 */
export type DeviceRole = 'shelf' | 'satchel'

/** One paired peer, as `device.list` answers. */
export interface DeviceRow {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly role: DeviceRole
  readonly grants: readonly string[]
  readonly pairedAt: number
  readonly lastSeenAt: number
}

export interface DevicePort {
  list(): Promise<readonly DeviceRow[]>
  /** Replace a peer's grants. Answers with the peer as it now stands. */
  grant(id: string, grants: readonly string[]): Promise<DeviceRow>
  /** Revoke a pairing and close any open session. False when no such peer. */
  forget(id: string): Promise<boolean>
}

/** What this device is, as far as the transport and the ledger can say. */
export interface ShelfFacts {
  /** What this device is, or null with no transport composed. */
  readonly role: DeviceRole | null
  readonly endpointId: string | null
  /** The journal's head — `hubSeq` in a hello. Null with no journal. */
  readonly journalSeq: number | null
  /** Published only when the journal is ready; null while it builds. */
  readonly epoch: string | null
}

export interface ShelfPort {
  facts(): Promise<ShelfFacts>
  /** Ask the scheduler to sync now. */
  sync(): Promise<{ readonly started: boolean; readonly detail: string | null }>
  /**
   * An integrity pass over the index and the journal.
   *
   * `findings` are FAULTS and decide `ok`; `notes` are true facts that are
   * not faults — rows waiting to push, say, which is the ordinary state of a
   * device that has not synced yet. Counting one of those as a fault makes
   * `ok` false for a healthy shelf, which is the fastest way to teach
   * somebody to ignore the answer.
   */
  verify(signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly findings: readonly string[]; readonly notes: readonly string[] }>
}

/**
 * What only the HOST can measure.
 *
 * Neither `IndexFs` nor `VaultFs` has a `stat`, deliberately — the kernel has
 * never needed one, and widening the seam for two fields would change every
 * adapter and every fake in the tree. A host that can measure binds this; one
 * that cannot leaves the fields null, which is the same shape the sync
 * protocol's own content answer already uses for a serving side that cannot
 * hash.
 */
export interface SizePort {
  /** Bytes of a book's stored content file, or null when there is none. */
  contentBytes(bookId: string): Promise<number | null>
  /** Bytes the whole library occupies, or null when nobody can say. */
  libraryBytes(): Promise<number | null>
  /**
   * Bytes at one path inside the data root, or null when it cannot be
   * measured.
   *
   * Published because a caller sometimes has a PATH rather than a book — the
   * cover cache measures `books/<folder>/cover.jpg`, and read the whole file
   * to take its `.length` before this existed. A cover arrives from a peer, so
   * its size is not this device's decision to make in memory.
   */
  bytesAt(path: string): Promise<number | null>
}

/* ------------------------------------------------------------------------ */
/* Blob names and folders                                                    */
/*                                                                           */
/* `ContentBlobPort` and `contentBlobPort` LIVED HERE AND ARE GONE.          */
/*                                                                           */
/* They were a kernel-owned port for resolving where a blob may be written,  */
/* with a default that joined a validated folder and a closed name under an  */
/* absolute root — deferred in phase 5 until a consumer existed, and no      */
/* consumer ever arrived. The transfers that ship resolve their own paths in */
/* Rust (`tauri-plugin-peer`'s `BlobTarget`), with symlink and TOCTOU        */
/* protections this never had, so the TypeScript copy was not a smaller      */
/* version of the shipping rule — it was a different, weaker one, published  */
/* from the kernel's public entry with a test suite that read as coverage of */
/* the real thing.                                                           */
/*                                                                           */
/* What is KEPT is the policy the two sides genuinely share, and which the   */
/* kernel really does enforce: what a folder may be called, and what a blob  */
/* may be named. `book.add` checks the first; `removeBlob` checks the        */
/* second; `check-blob-parity.test.mjs` holds both against the Rust.         */
/* ------------------------------------------------------------------------ */

/**
 * The names a blob may land under. CLOSED: a book's bytes, under one of the
 * extensions the vault stores, or its jacket. Nothing else in a book's folder
 * is a blob anybody outside the kernel writes.
 *
 * CLOSED IN THE TYPE, not only in a comment. This was ``content.${string}``,
 * which is not a closed set at all — it accepts `content.exe`, and
 * `content.../book.json` besides, so every compile-time use of the word
 * "closed" here was decoration and only the runtime check meant anything.
 * `CONTENT_EXTENSIONS` is a literal tuple now, so the compiler enforces the
 * same set at the call sites that `REMOVABLE_BLOB_NAMES` enforces at the
 * boundary, and adding a format makes it legal in both at once.
 */
export type ContentBlobName = `content.${ContentExtension}` | 'cover.jpg'

/** What a book's folder is called: `safeId` output, bounded. */
export const BLOB_FOLDER = /^[A-Za-z0-9_]{1,80}$/

const BLOB_NAMES: ReadonlySet<string> = new Set([
  'cover.jpg',
  ...CONTENT_EXTENSIONS.map((ext) => `content.${ext}`),
])

/**
 * The names the kernel's REMOVE primitive accepts (`KernelServices.removeBlob`
 * — WI-10.2): everything a blob may LAND under, plus the legacy `cover.webp`,
 * which is read-only on the landing side but still has to be evictable — a
 * jacket cached before the honest name existed would otherwise be immortal.
 */
export type RemovableBlobName = ContentBlobName | 'cover.webp'

/** The closed set behind `RemovableBlobName`, for the runtime check. */
export const REMOVABLE_BLOB_NAMES: ReadonlySet<string> = new Set([...BLOB_NAMES, 'cover.webp'])

/**
 * Just the BOOK'S BYTES — every name content may be stored under, and nothing
 * else.
 *
 * `content.evict` offers a whole list of names to delete rather than the ones
 * a listing happened to return, because the listing happens outside the book's
 * write lane and a landing queued behind it would otherwise survive the
 * eviction. It offered `REMOVABLE_BLOB_NAMES`, which also holds `cover.jpg`
 * and the legacy `cover.webp` — so evicting a book's bytes silently destroyed
 * its jacket too, and the satchel had to fetch it again over the wire.
 *
 * The cover has its own eviction: the cover cache's LRU, which is the thing
 * that knows how many jackets this device can afford. This set is what
 * `content.evict` means by "content".
 */
export const CONTENT_BLOB_NAMES: readonly RemovableBlobName[] = CONTENT_EXTENSIONS.map(
  (ext) => `content.${ext}` as RemovableBlobName,
)


/* ------------------------------------------------------------------------ */
/* Diagnostics                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Local-only logging, scoped, with the secrets taken out.
 *
 * `child(scope)` is how a capability gets one under its own name — every
 * line it writes carries `<scope>`, and the kernel's own carry `kernel`. There
 * is no telemetry backend and no egress: a `Diagnostics` writes to a sink the
 * composition root chose, which is the console in a dev build and nothing in
 * a release build unless the root enabled it. `diagnostics.ts` has the
 * factory and the redaction rule.
 */
export interface Diagnostics {
  child(scope: string): Diagnostics
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

/** The default: writes nothing, and every child is itself. */
export const NOOP_DIAGNOSTICS: Diagnostics = {
  child: () => NOOP_DIAGNOSTICS,
  info: () => {},
  warn: () => {},
  error: () => {},
}

/* ------------------------------------------------------------------------ */
/* SettingsStore                                                             */
/* ------------------------------------------------------------------------ */

/**
 * A setting's key: namespaced, always. `kernel.<name>` for the kernel's own,
 * `<capability>.<name>` for a capability's — so two of them cannot collide,
 * and a key says who owns it.
 */
export type SettingKey = `${string}.${string}`

/**
 * One durable preference, DESCRIBED rather than named: its key, the value it
 * has when nothing is stored, and how to read a stored value back. The store
 * is generic over these, which is what lets a capability define its own
 * settings without the kernel's schema having to know them.
 *
 * `parse` is the trust boundary. What is on disk is a file, and a file can
 * hold anything: a theme id from a build that had one more theme, a number
 * where a boolean was expected, a hand edit. It returns `undefined` for a
 * value that is not one of these, and the store answers with `fallback`.
 */
export interface Setting<T> {
  readonly key: SettingKey
  readonly fallback: T
  readonly parse: (raw: unknown) => T | undefined
}

export function defineSetting<T>(
  key: SettingKey,
  fallback: T,
  parse: (raw: unknown) => T | undefined,
): Setting<T> {
  /* The template type accepts `.theme`, `kernel.` and `.` — an empty owner
   * or an empty name — and an unowned key is exactly what the namespace
   * wrappers cannot scope. Refused here, where every setting is minted. */
  const dot = key.indexOf('.')
  if (dot < 1 || dot === key.length - 1) {
    throw new Error(`defineSetting: ${JSON.stringify(key)} must be "<namespace>.<name>", both non-empty`)
  }
  return { key, fallback, parse }
}

/**
 * The typed, versioned preference store.
 *
 * `get` never fails: an absent or malformed value is the setting's fallback.
 * `set` writes through to the store it was opened over. `subscribe` and
 * `getSnapshot` are the `useSyncExternalStore` pair — a settings pane reads
 * through them, and so does anything that wants to notice a capability
 * changing a value. Only DURABLE preferences belong here; a query being
 * typed, an open layer, a selection are `AppState`'s and stay there.
 */
export interface SettingsStore {
  get<T>(setting: Setting<T>): T
  set<T>(setting: Setting<T>, value: T): void
  subscribe(listener: () => void): () => void
  /** Every stored value by key. A new object after each change, else the same one. */
  getSnapshot(): Readonly<Record<string, unknown>>
}
