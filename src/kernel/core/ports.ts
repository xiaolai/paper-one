import { CONTENT_EXTENSIONS, type ContentExtension } from './bookVault'

/**
 * The kernel's PORTS — the places it calls OUT, each owned here.
 *
 * NO COUNT IN THIS SENTENCE, deliberately. It said "the four places" over a
 * file that had grown past four, which is the same defect `SidePane`'s header
 * records: three separate comments said "seven" over a rail of eight, and a
 * count in a sentence has no way to notice a port being added. The list below
 * is the list.
 *
 * TWO KINDS OF DEFAULT, and the difference is deliberate. The original ports
 * default to a stub that stands in for nobody. Phase 11's — `device`, `shelf`
 * and sizes — default to NULL, because there is no sensible answer an unbound
 * device or shelf port could give and a stub returning an empty peer list
 * would be a lie the caller could not detect.
 *
 * `CompanionProvider` and `GlossProvider` are ports too and live in their own
 * files (`companion.ts`, `gloss.ts`) — they carry enough of their own
 * reasoning to be worth a file each, and `services.ts` binds them the same way
 * it binds these.
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

/**
 * The HASH port — BLAKE3 of a blob in this device's data root, which only the
 * peer plugin computes (Rust; never in TypeScript). Bound by the peer
 * capability when it starts, on the same late-bound, once-at-a-time slot as
 * the size port; absent on a host with no peer, and every reader of it
 * answers "unmeasured" then rather than failing.
 */
/**
 * A voice pack the catalogue offers, as the interface needs to know it.
 *
 * Every field is what a reader decides with — how big it is, what it can read,
 * what it needs from the machine, and who may license it. The engine's name is
 * here rather than inferred from the id because `readingVoice` is stored
 * engine-qualified (`kokoro:af_heart`) and the interface must be able to build
 * that string without knowing which family a pack belongs to.
 */
export interface VoicePack {
  readonly id: string
  readonly name: string
  readonly summary: string
  /** `kokoro`, `qwen` — which engine reads it. */
  readonly family: string
  /** Primary language subtags this pack can read: `['zh']`. */
  readonly languages: readonly string[]
  /** Every byte of it, so the download can be named before it starts. */
  readonly bytes: number
  /** The memory this Mac must have. A machine under it is not offered the pack. */
  readonly minimumMemoryGb: number
  readonly voices: readonly VoiceChoice[]
  /** Whether every artifact is present and verified on this device. */
  readonly installed: boolean
}

/** One voice inside a pack. */
export interface VoiceChoice {
  readonly id: string
  readonly name: string
  /** A full tag — `zh-CN` — because two voices of one pack can differ by region. */
  readonly language: string
  readonly note: string
}

/** How far a pack's download has got. */
export type InstallProgress =
  | { readonly kind: 'downloading'; readonly received: number; readonly total: number }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'installed' }

/** What to read, in which voice. */
export interface SpeechRequest {
  readonly packId: string
  readonly voiceId: string
  readonly text: string
  /** A multiplier on the engine's own speed; 1 is its default. */
  readonly rate?: number
}

/** A word, and when it is spoken. Absent for an engine that cannot say. */
export interface SpokenWordTiming {
  /** Where the word sits in the requested text, in UTF-16 code units. */
  readonly start: number
  readonly length: number
  readonly startMs: number
  readonly endMs: number
}

/**
 * Audio, and what is known about where the words fall in it.
 *
 * `words` is EMPTY rather than absent for an engine that does not report
 * boundaries, and `sentences` carries what that engine does know. The
 * distinction is what lets the reading fall back to a sentence highlight
 * instead of dropping the follow-along entirely — see `EngineSpeaker`.
 */
export interface SpokenAudio {
  /** 16-bit mono PCM, little-endian, at `sampleRate`. */
  readonly pcm: Uint8Array
  readonly sampleRate: number
  readonly words: readonly SpokenWordTiming[]
  /** Sentences the engine refused, with the reason, so they can be named. */
  readonly skipped: readonly { readonly text: string; readonly why: string }[]
}

/**
 * The downloadable voices: what may be had, getting one, and reading with it.
 *
 * ⚠️ **BOUND BY A CAPABILITY, ABSENT ON A HOST WITHOUT ONE**, like the size and
 * hash ports above — a browser client and a phone have no engine, and every
 * reader of this answers "no voice" then rather than failing. The floor rule
 * from phase 29 is unchanged by its presence: a pack's voices are admitted, and
 * the platform's own are still refused where their tier can be read.
 */
export interface SpeechEnginePort {
  /** What the catalogue offers this device, and what is already here. */
  catalogue(): Promise<readonly VoicePack[]>
  /**
   * Fetch a pack. Resolves when every byte has been checked against the
   * manifest; rejects, having left nothing half-installed, otherwise.
   */
  install(packId: string, onProgress: (progress: InstallProgress) => void, signal?: AbortSignal): Promise<void>
  /** Remove an installed pack and its files. */
  remove(packId: string): Promise<void>
  /** Read some text aloud into samples. */
  render(request: SpeechRequest, signal?: AbortSignal): Promise<SpokenAudio>
  /**
   * Let a loaded model go.
   *
   * Published because it is the reader's memory: Qwen holds about 2.5 GB while
   * it is loaded, and a model that is merely idle is indistinguishable to the
   * machine from one that is reading.
   */
  release(): Promise<void>
}

export interface HashPort {
  /** BLAKE3, hex, and the byte count of `books/<folder>/<name>`; rejects when there is no such file. */
  hashFile(folder: string, name: string): Promise<{ readonly blake3: string; readonly size: number }>
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

/**
 * The names the kernel's REMOVE primitive accepts (`KernelServices.removeBlob`
 * — WI-10.2): everything a blob may LAND under, plus the legacy `cover.webp`,
 * which is read-only on the landing side but still has to be evictable — a
 * jacket cached before the honest name existed would otherwise be immortal.
 */
export type RemovableBlobName = ContentBlobName | 'cover.webp'

/**
 * Every removable blob, and which SURFACE its removal is journalled under.
 *
 * ⚠️ **ONE MAP, BECAUSE THERE WERE TWO POLICIES.** The closed set lived here
 * and the content/cover classification lived in `services.removeBlob` as
 * `name === 'cover.webp' || name === 'cover.jpg' ? 'cover' : 'content'`. So
 * adding a removable cover name — `cover.png`, say — passed validation here
 * and was journalled as `content` there, telling every peer the book's BYTES
 * had changed when its jacket had. The kind decides which key the journal
 * tracks and therefore what a peer is told; a name that is legal in one place
 * and misfiled in the other is a silent replication defect.
 *
 * The set below is derived from this, so a name cannot exist in one and not
 * the other.
 */
export const REMOVABLE_BLOB_KINDS: Readonly<Record<RemovableBlobName, MutationKind>> =
  Object.freeze({
    'cover.jpg': 'cover',
    /* Read-only on the landing side and still evictable — a jacket cached
       before the honest name existed would otherwise be immortal. */
    'cover.webp': 'cover',
    ...Object.fromEntries(CONTENT_EXTENSIONS.map((ext) => [`content.${ext}`, 'content'])),
  } as Record<RemovableBlobName, MutationKind>)

/** The closed set behind `RemovableBlobName`, for the runtime check. */
export const REMOVABLE_BLOB_NAMES: ReadonlySet<string> = new Set(Object.keys(REMOVABLE_BLOB_KINDS))

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
  return { key, fallback: frozen(fallback), parse: (raw) => frozen(parse(raw)) }
}

/**
 * A value and everything reachable through its own properties, frozen in place.
 *
 * ⚠️ **A SETTING'S VALUE WAS SHARED, AND MUTABLE.** A fallback is one object every
 * store and every reader is handed, and a parser may pass a stored value straight
 * through — so a reader who changed what `get` returned changed it for every
 * other reader, with no notification, no write, and the snapshot's identity
 * unchanged (2026-09-13 verify). Frozen where every setting is minted, the
 * mutation fails at the line that makes it, whichever store reads the setting.
 *
 * The walk carries what it has seen, so a cycle ends it, and a parent somebody
 * already froze does not hide a child that was not.
 */
export function frozen<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const child of Object.values(value)) frozen(child, seen)
  return value
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
  /**
   * Write a preference. **NEVER THROWS**, and it used to.
   *
   * A durable store can refuse a write — a full disk, an exhausted quota, a
   * private window with storage switched off — and `set` reported that by
   * throwing. No caller caught it. So a quota error thrown out of an `onClick`
   * aborted the rest of the handler, and every multi-field write in the app is
   * a run of `set` calls: choosing a theme writes `theme` and then
   * `themeFollowsOs`, and `writeKernelPreferences` writes sixteen in a loop. A
   * refusal on the first left the rest UNATTEMPTED, so what was stored was a
   * PREFIX of what the reader had chosen — internally inconsistent, silently.
   *
   * The refusal is not swallowed; it moves to `persistent`, which is a state
   * the pane can draw rather than an exception nobody was catching.
   */
  set<T>(setting: Setting<T>, value: T): void
  /**
   * Whether this setting has a value STORED, as opposed to answering with its
   * fallback.
   *
   * ⚠️ **`get` CANNOT EXPRESS THIS, AND A CALLER INFERRED IT FROM THE VALUE.**
   * `get` never fails: absent, malformed and "stored as exactly the fallback"
   * are one answer by design, which is what makes it safe to call anywhere. A
   * setting whose fallback is not a legal value can use that — `kernel.stepIdx`
   * uses `-1` and says so — but one whose fallback is legal cannot, and
   * `readTextSize` tried: it read the legacy ramp whenever the stored size
   * equalled the default. Combined with `set`, which skips a write whose value
   * equals the current one (the fallback, when nothing is stored), a reader who
   * chose exactly the default size stored nothing and had it overridden by the
   * legacy value on every launch.
   *
   * So the question is asked rather than inferred. `set` already computes it
   * internally; this is the same fact, exposed.
   */
  has<T>(setting: Setting<T>): boolean
  subscribe(listener: () => void): () => void
  /**
   * Whether what is set here will still be here next launch.
   *
   * `false` for a store opened over no storage at all, and for one whose
   * storage has refused a write — the same distinction the marks and cards
   * stores draw, and drawn the same way so a pane can say the same sentence.
   * Changes are published to `subscribe`, so a pane that reads it re-renders
   * when a write first fails.
   */
  readonly persistent: boolean
  /** Every stored value by key. A new object after each change, else the same one. */
  getSnapshot(): Readonly<Record<string, unknown>>
}
