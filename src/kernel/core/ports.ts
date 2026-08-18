import { CONTENT_EXTENSIONS } from './bookVault'
import { BOOKS_DIR } from './bookFolder'

/**
 * The kernel's PORTS — the four places it calls OUT, each owned here and each
 * with a default that stands in for nobody.
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
export type MutationKind = 'record' | 'marks' | 'cover' | 'content' | 'removed' | 'cards'

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
/* ContentBlobPort                                                           */
/* ------------------------------------------------------------------------ */

/**
 * The names a blob may land under. CLOSED: a book's bytes, under one of the
 * extensions the vault stores (`CONTENT_EXTENSIONS`, checked at the call), or
 * its jacket. Nothing else in a book's folder is a blob anybody outside the
 * kernel writes.
 */
export type ContentBlobName = `content.${string}` | 'cover.jpg'

/**
 * Where a blob that arrives from OUTSIDE the kernel — a peer plugin landing a
 * book's bytes — may be written. Absolute paths, because the writer is not
 * this webview and has no `BaseDirectory` to be relative to.
 *
 * Narrow on purpose: a folder name and a name from a closed set, validated,
 * joined under the root. It cannot be handed a path.
 */
export interface ContentBlobPort {
  /** The data root every target sits under. Absolute. */
  root(): string
  /**
   * The absolute path for `name` in the folder named `folder`.
   *
   * `folder` is a book's folder name — `safeId(bookId)`, so `[A-Za-z0-9_]` —
   * not a book id and not a path. Throws on anything else, and on a name
   * outside the closed set.
   */
  target(folder: string, name: ContentBlobName): string
}

/** What a book's folder is called: `safeId` output, bounded. */
export const BLOB_FOLDER = /^[A-Za-z0-9_]{1,80}$/

const BLOB_NAMES: ReadonlySet<string> = new Set([
  'cover.jpg',
  ...CONTENT_EXTENSIONS.map((ext) => `content.${ext}`),
])

/**
 * The default port, over the app's data root.
 *
 * `root` is a string rather than resolved here because the kernel cannot
 * resolve it synchronously and must not resolve it wrongly: in a debug build
 * the Rust side may be pointed at `PAPER_TEST_DATA_DIR`, and TypeScript
 * asking `appDataDir()` on its own would disagree with it. The composition
 * root asks Rust (`paper_data_root`) once and hands the answer here.
 */
export function contentBlobPort(root: string): ContentBlobPort {
  if (typeof root !== 'string' || root === '') throw new Error('ContentBlobPort: root must be a path')
  const base = root.replace(/[\\/]+$/, '')
  return {
    root: () => base,
    target: (folder, name) => {
      if (!BLOB_FOLDER.test(folder)) {
        throw new Error(`ContentBlobPort: ${JSON.stringify(folder)} is not a book folder name`)
      }
      if (!BLOB_NAMES.has(name)) {
        throw new Error(`ContentBlobPort: ${JSON.stringify(name)} is not a blob the kernel accepts`)
      }
      return `${base}/${BOOKS_DIR}/${folder}/${name}`
    },
  }
}

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
