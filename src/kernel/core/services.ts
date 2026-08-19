import type { IndexFs, IndexedBook } from './bookIndex'
import type { Disposable, ServiceContribution } from './capability'
import { createCards, type CardStorage, type Cards } from './cardStore'
import { hlcOf, type Hlc } from './hlc'
import { createLibrary, type Library } from './libraryStore'
import { createMarkStore, type MarkStore } from './markStore'
import { folderOf } from './bookFolder'
import { NOOP_DIAGNOSTICS, NOOP_RECORDER, REMOVABLE_BLOB_NAMES, type Diagnostics, type MutationRecorder, type MutationToken, type RemovableBlobName, type SettingsStore } from './ports'
import { createSettingsStore, type SettingsMigration } from './settings'
import { writeQueue, type WriteQueue } from './writeQueue'

/**
 * The kernel's services, built together — because they share things that
 * must be ONE.
 *
 * The write queue above all: a book's record and its marks are two files in
 * one folder, and two queues meant a write to one could not see a write to
 * the other, which is how a mark landed in a folder a removal had just moved.
 * One queue keyed by book makes every write touching a book serial, and gives
 * the window something to wait for when it closes (`drain`).
 *
 * This is what a composition root builds once and hands to the UI — and, in
 * time, to every capability's `start`. The hooks in `ui/hooks` are adapters
 * over these instances; nothing else holds the shelf, the marks or the cards.
 */
export interface KernelServices {
  readonly library: Library
  readonly marks: MarkStore
  readonly cards: Cards
  readonly settings: SettingsStore
  readonly diagnostics: Diagnostics
  /** The one queue every folder write goes through. */
  readonly writes: WriteQueue
  /**
   * The library's filesystem, or null outside Tauri — exposed for a
   * capability that READS the folders the kernel writes (the sync journal
   * digests a book's current state; `readBook`/`readMarks` take an fs).
   * The write paths stay behind the stores.
   */
  readonly fs: IndexFs | null
  /** The flat store, or null. Same audience and same caveat as `fs`. */
  readonly storage: CardStorage | null
  /**
   * Delete ONE closed-name blob from a book's folder — the delete twin of
   * `ContentBlobPort`'s landing (WI-10.2). The folder comes from the book id
   * (`folderOf`, so a hostile id cannot name a path), the name must sit in
   * the closed set (`content.<ext>` | `cover.jpg` | the legacy, evict-only
   * `cover.webp`), and anything else — `book.json`, a `../` escape — throws.
   * This is the ONLY way anything outside the kernel deletes inside
   * `books/<id>/`: a capability's own fs handle is namespace-confined
   * (WI-10.3) and cannot reach there at all. A no-op without a filesystem,
   * and for a blob that is not there — removing what is absent is done.
   */
  removeBlob(bookId: string, name: RemovableBlobName): Promise<void>
  /**
   * Bind the mutation-recorder port — the sync journal, at composition.
   *
   * LATE-BOUND, and that is the point: the services must exist before any
   * capability starts (a `start` receives them), so a port implemented BY a
   * capability can only arrive after construction. The stores hold a
   * delegating recorder from birth; this swaps its target. Binding while
   * already bound throws — two journals bracketing one write queue would be
   * two truths — and everything recorded before the bind went to the previous
   * target (the no-op default), which is exactly the pre-journal state the
   * journal's own bootstrap and verify pass exist to square.
   *
   * Returns an idempotent disposer that RESTORES the previous target and
   * frees the slot to be bound again. The sync capability disposes it before
   * it closes the journal, so a torn-down sync never leaves the stores
   * writing into a closed journal, and the same services can be re-composed.
   */
  bindRecorder(recorder: MutationRecorder): Disposable
  /**
   * Bind the stamp clock — the sync capability's HLC, at composition. Same
   * shape, same once-at-a-time rule, and the same restoring disposer as
   * `bindRecorder`. Until bound, stamps are the legacy wall clock under the
   * zero device (`hlcOf`), which is enough with no sync composed.
   */
  bindClock(clock: () => Hlc): Disposable
  /**
   * Bind the SERVICE HOST — the peer transport, at composition. A shelf serves
   * the capabilities' contributed `services` over the peer router; the host is
   * what turns a `ServiceContribution` set into served, grant-gated handlers.
   * Late-bound and once-at-a-time like the recorder, with the same restoring
   * disposer. Until bound (a browser tab, a satchel with no peer plugin, every
   * test that composes without `peer`) the default hosts NOTHING — replication
   * is the spine and services are enhancement, so an unbound host is not an
   * error, it is the offline case.
   */
  bindServiceHost(host: ServiceHost): Disposable
  /**
   * Serve a composed set of services through the bound host, once every
   * capability has started (so a delegating handler's target is ready). The
   * registry calls this with `Composition.services`; the returned `Disposable`
   * unserves them and rides the composition's teardown. With no host bound it
   * resolves to a no-op — nothing is served, nothing throws.
   */
  serveServices(services: readonly ServiceContribution[]): Promise<Disposable>
  /**
   * Resolves when nothing is in flight — the queue idle AND the flat store
   * flushed. For the one moment that cannot be deferred: the window closing.
   */
  drain(): Promise<void>
}

/**
 * What the peer capability binds to turn contributed services into served
 * handlers: given the composed set, decide by role (a satchel serves nothing)
 * and hand back a `Disposable` that unserves. Async because the role and the
 * transport are.
 */
export type ServiceHost = (services: readonly ServiceContribution[]) => Disposable | Promise<Disposable>

export interface KernelServicesOptions {
  /** The library's filesystem, or null outside Tauri. */
  readonly fs: IndexFs | null
  /** The flat store — cards and settings. Null outside any storage at all. */
  readonly storage: CardStorage | null
  /** The shelf as read at boot, so no frame renders an empty library. */
  readonly initialBooks?: readonly IndexedBook[]
  readonly recorder?: MutationRecorder
  readonly diagnostics?: Diagnostics
  readonly settingsMigration?: SettingsMigration
  /**
   * ONE clock for every store's stamps (`updatedAt`, `deletedAt`, presence)
   * — one, because two clocks on one device could order one edit before the
   * removal that preceded it. Absent, each store uses the legacy wall clock
   * until `bindClock` supplies the sync capability's HLC.
   */
  readonly clock?: () => Hlc
}

/**
 * ONE exclusive-binding slot — the bind-once rule, the identity-guarded
 * restore, and the bound flag, stated once. It lived as three hand-rolled
 * copies (recorder, clock, service host), and the same defect had been
 * pasted into each: a STALE disposer cleared the bound flag it no longer
 * owned, so firing it after a re-bind let a second simultaneous binding in.
 * Here the flag and the target move together, only under the disposer that
 * still owns the active binding.
 */
function exclusiveSlot<T>(alreadyBound: string, fallback: T): { get(): T; bind(next: T): Disposable } {
  let target = fallback
  /* Ownership is a fresh token per bind, not the bound value's identity:
   * binding the SAME object twice is legal (dispose, then bind again), and
   * an identity guard would let the first binding's stale disposer unbind
   * the second. Null means unbound. */
  let owner: object | null = null
  return {
    get: () => target,
    bind: (next) => {
      if (owner !== null) throw new Error(alreadyBound)
      const token = {}
      owner = token
      target = next
      return {
        /* Idempotent: a disposer that no longer owns the binding — re-bound
         * since, or already run — changes nothing. */
        dispose: () => {
          if (owner !== token) return
          target = fallback
          owner = null
        },
      }
    },
  }
}

export function createKernelServices({
  fs,
  storage,
  initialBooks = [],
  recorder = NOOP_RECORDER,
  diagnostics = NOOP_DIAGNOSTICS,
  settingsMigration,
  clock,
}: KernelServicesOptions): KernelServices {
  /* The delegating ports. The stores capture THESE, so a bind after
   * construction reaches every store without any of them knowing. Each
   * slot's default target is what an unbind RESTORES. */
  const recorderSlot = exclusiveSlot<MutationRecorder>('bindRecorder: the recorder port is already bound', recorder)
  /* Each end of the bracket resolves the CURRENT slot, deliberately: an
   * unbind landing between a begin and its commit sends the commit to the
   * restored default, leaving a dangling begin — which is EXACTLY the shape
   * the journal's launch recovery exists for (a crash leaves the same). The
   * once-tried alternative — routing the commit to the recorder that issued
   * the token — sent it into a journal that had since CLOSED, turning a
   * recoverable gap into a rejected write whose bytes were already down. */
  const recorderPort: MutationRecorder = {
    begin: (book, what) => recorderSlot.get().begin(book, what),
    commit: (token: MutationToken, digest?: string) => recorderSlot.get().commit(token, digest),
  }
  const clockSlot = exclusiveSlot<() => Hlc>('bindClock: the clock port is already bound', clock ?? (() => hlcOf(Date.now())))
  const clockPort = () => clockSlot.get()()

  const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }
  const serviceHostSlot = exclusiveSlot<ServiceHost>('bindServiceHost: the service host is already bound', () => NOOP_DISPOSABLE)

  const writes = writeQueue()
  const library = createLibrary({ fs, queue: writes, initial: initialBooks, recorder: recorderPort, clock: clockPort })
  const marks = createMarkStore({ fs, queue: writes, recorder: recorderPort, clock: clockPort })
  const cards = createCards({ storage, recorder: recorderPort, clock: clockPort, queue: writes })
  const settings = createSettingsStore(
    settingsMigration ? { storage, migrate: settingsMigration } : { storage },
  )
  return {
    library,
    marks,
    cards,
    settings,
    diagnostics,
    writes,
    fs,
    storage,
    removeBlob: async (bookId: string, name: RemovableBlobName): Promise<void> => {
      if (!REMOVABLE_BLOB_NAMES.has(name)) {
        throw new Error(`removeBlob: ${JSON.stringify(name)} is not a blob the kernel removes`)
      }
      if (!fs) return
      /* `folderOf` sanitises the id into `books/<safeId>` — a slash, a dot,
       * anything outside [A-Za-z0-9] becomes `_` — so the joined path cannot
       * leave the book's folder whatever the id says. And the delete runs
       * INSIDE the book's queued task, like every other folder mutation: a
       * remove racing a landing or a folder move is the exact interleaving
       * the one-queue rule exists to prevent, and within the task the
       * exists/remove pair is atomic, so two concurrent removes both resolve
       * as the documented absent-blob no-op. */
      await writes.append(bookId, async () => {
        const path = `${folderOf(bookId)}/${name}`
        if (await fs.exists(path)) await fs.remove(path)
      })
    },
    bindRecorder: (next) => recorderSlot.bind(next),
    bindClock: (next) => clockSlot.bind(next),
    bindServiceHost: (next) => serviceHostSlot.bind(next),
    serveServices: async (list) => (await serviceHostSlot.get()(list)) ?? NOOP_DISPOSABLE,
    drain: async () => {
      await writes.idle()
      await storage?.flush?.()
    },
  }
}
