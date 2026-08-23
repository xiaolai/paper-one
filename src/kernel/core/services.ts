import type { IndexFs, IndexedBook } from './bookIndex'
import type { Disposable, ServiceContribution } from './capability'
import { createCards, type CardStorage, type Cards } from './cardStore'
import { hlcOf, type Hlc } from './hlc'
import { createLibrary, type Library } from './libraryStore'
import { createMarkStore, type MarkStore } from './markStore'
import { folderOf } from './bookFolder'
import { NOT_CONFIGURED, type CompanionProvider } from './companion'
import { LOOK_UP_SETTING, NO_GLOSS, availableModes, effectiveMode, type GlossProvider, type LookUpMode } from './gloss'
import { NO_WORK_LINE, NOOP_DIAGNOSTICS, NOOP_RECORDER, REMOVABLE_BLOB_NAMES, recorded, type DevicePort, type Diagnostics, type MutationKind, type MutationRecorder, type MutationToken, type RemovableBlobName, type SettingsStore, type ShelfPort, type SizePort, type WorkLine } from './ports'
import { carryLegacySettings, createSettingsStore, type SettingsMigration } from './settings'
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
   * Whether `initialBooks` is the shelf, or a stand-in for one nobody read.
   *
   * The composition root opens the window on an empty snapshot when the index
   * will not load — not opening at all would be worse — and the kernel had no
   * way to tell that from a library with no books in it. So every consumer
   * that counts the snapshot answered "0 books" for "the shelf could not be
   * read", including `shelf.status`, which is the service a peer uses to
   * decide whether this device is healthy.
   *
   * A function rather than a field for the same reason the ports are: it is
   * the composition root's knowledge, not the store's.
   */
  readonly shelfRead: () => boolean
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
   * the peer plugin's landing (WI-10.2). The folder comes from the book id
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
   * Bind the DEVICE port — the peer capability's view of who is paired
   * (phase 11). Late-bound and once-at-a-time like the recorder, with the
   * same restoring disposer. Until bound, `devices()` is null and `device.*`
   * refuses `unsupported` by name rather than answering an empty list.
   */
  bindDevicePort(port: DevicePort): Disposable
  /** The bound device port, or null. Read at CALL time by every `device.*`
   *  handler, so a port bound during a capability's `start` reaches services
   *  that were built before it. */
  devices(): DevicePort | null
  /**
   * Bind the SHELF port — the role, the endpoint, and the journal's head and
   * epoch (phase 11). Same rules as `bindDevicePort`.
   */
  bindShelfPort(port: ShelfPort): Disposable
  shelf(): ShelfPort | null
  /**
   * Bind the SIZE port — bytes on disk, which only a host can measure
   * (phase 11). Bound by a host rather than by a capability, and otherwise
   * the same slot as the two above.
   */
  bindSizePort(port: SizePort): Disposable
  sizes(): SizePort | null
  /**
   * Bind the COMPANION provider — `companion`, at composition, and only
   * `companion`. Same late-bound, once-at-a-time rule and the same restoring
   * disposer as `bindRecorder`.
   *
   * The kernel holds this from birth so that one bind reaches every holder:
   * `companion.ts` shipped `NOT_CONFIGURED` as a hardcoded const, which is
   * why wiring a provider used to mean editing the kernel. Until bound, the
   * default is `NOT_CONFIGURED` and the panel says what is missing.
   */
  bindCompanion(provider: CompanionProvider): Disposable
  /** The companion provider — `NOT_CONFIGURED` until one is bound. */
  companion(): CompanionProvider
  /**
   * Bind the GLOSS provider — `inference`, at composition, and only
   * `inference`.
   *
   * SEPARATE FROM THE COMPANION ON PURPOSE (F8). The two features fail
   * separately because they are two features: with `companion` absent, failed,
   * or set to an agent, the gloss still works. And because only `inference`
   * binds this, there is no code path from a selection to an agent session —
   * a property of the wiring rather than a rule someone has to remember.
   */
  bindGloss(provider: GlossProvider): Disposable
  /**
   * Bind the WORK LINE — the library status bar's third rung (WI-15.12).
   *
   * Same late-bound, once-at-a-time rule and the same restoring disposer as
   * `bindRecorder`. Until bound the default reports nothing, and the bar is
   * exactly the two-rung ladder it has always been.
   */
  bindWorkLine(work: WorkLine): Disposable
  /** The work line — `NO_WORK_LINE` until one is bound. */
  workLine(): WorkLine
  /** The gloss provider — `NO_GLOSS` until one is bound. */
  gloss(): GlossProvider
  /**
   * The reader's `Look up` preference, and the one way to cycle it.
   *
   * HERE RATHER THAN IN THE SETTINGS STORE, and the reason is an invariant
   * that would otherwise be broken by the only two callers there are.
   * `LOOK_UP_SETTING` is `kernel.lookUp` on purpose — `ui/lookUp.ts` acts on
   * it and that file is the kernel's — but a capability's settings handle is
   * confined to its own `<id>.` namespace by `scopeSettings`, at every door
   * including `services.settings`. So `inference` and `companion`, which both
   * DRAW the row, cannot reach the value through the store at all: the read
   * throws `namespace` the moment their pane mounts.
   *
   * An accessor is the seam that satisfies both: the kernel keeps ownership
   * of the question, and a capability that draws the control asks rather than
   * reaches. It also collapses a duplicated algorithm — the cycle was written
   * out twice, identically, in two capability stores.
   *
   * `hasDictionary` and `hasGloss` are the CALLER's answers, because only the
   * caller knows: the platform's dictionary is `ui/lookUp.ts`'s question and
   * whether a text model is installed is the controller's. A cycle with one
   * or no available mode does nothing, so a control that would be inert is
   * simply not offered.
   */
  lookUp(): LookUpMode
  cycleLookUp(hasDictionary: boolean, hasGloss: boolean): void
  /**
   * Whether this platform has a system dictionary to hand a passage to.
   *
   * ⚠️ **A CAPABILITY CANNOT WORK THIS OUT.** It is
   * `ui/lookUp.ts`'s `hasDictionary(platform)`, and both the platform and that
   * function live behind the kernel's React layer, which `kernel-public-entry-only`
   * puts out of a capability's reach. So `CompanionPane` took it as an
   * optional prop defaulting to `false`, and the production caller passed
   * nothing — which on macOS silently removed the system dictionary from the
   * cycle, so a reader could not select `System dictionary` or `Both` at all.
   * A default that is wrong for the platform the feature exists for is not a
   * default.
   *
   * The composition root answers it once, and every drawer of the control
   * asks. Defaults to `false` only where there is genuinely no platform to
   * ask about — a test, a headless service.
   */
  hasDictionary(): boolean
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
  /**
   * Whether `initialBooks` came from a shelf that was actually read.
   *
   * Defaults to `true`, which is right for every caller that HAS the books —
   * a test, a satchel, a fresh library. The composition root passes `false`
   * when `loadShelf` threw, so nothing downstream reports an unreadable shelf
   * as an empty one.
   */
  readonly shelfRead?: boolean
  /**
   * Whether this platform has a system dictionary — see
   * `KernelServices.hasDictionary`. The composition root passes
   * `hasDictionary(resolvePlatform())`; everything else leaves it false.
   */
  readonly hasDictionary?: boolean
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
/** Which binding issued a token. A symbol, so it cannot collide with a field
 *  a recorder defines and does not survive the JSON a journal writes. */
const BINDING = Symbol('kernel.recorderBinding')

function exclusiveSlot<T>(
  alreadyBound: string,
  fallback: T,
): { get(): T; bind(next: T): Disposable; generation(): number } {
  let target = fallback
  /* Bumped on every bind AND every unbind, so "the binding that issued this"
   * is answerable later without holding a reference to the value itself. Used
   * by the recorder port; harmless for the slots that ignore it. */
  let generation = 0
  /* Ownership is a fresh token per bind, not the bound value's identity:
   * binding the SAME object twice is legal (dispose, then bind again), and
   * an identity guard would let the first binding's stale disposer unbind
   * the second. Null means unbound. */
  let owner: object | null = null
  return {
    get: () => target,
    generation: () => generation,
    bind: (next) => {
      if (owner !== null) throw new Error(alreadyBound)
      const token = {}
      owner = token
      target = next
      generation += 1
      return {
        /* Idempotent: a disposer that no longer owns the binding — re-bound
         * since, or already run — changes nothing. */
        dispose: () => {
          if (owner !== token) return
          target = fallback
          owner = null
          generation += 1
        },
      }
    },
  }
}

export function createKernelServices({
  fs,
  storage,
  initialBooks = [],
  shelfRead = true,
  recorder = NOOP_RECORDER,
  diagnostics = NOOP_DIAGNOSTICS,
  settingsMigration,
  clock,
  hasDictionary = false,
}: KernelServicesOptions): KernelServices {
  /* The delegating ports. The stores capture THESE, so a bind after
   * construction reaches every store without any of them knowing. Each
   * slot's default target is what an unbind RESTORES. */
  const recorderSlot = exclusiveSlot<MutationRecorder>('bindRecorder: the recorder port is already bound', recorder)
  /* A COMMIT GOES TO THE RECORDER THAT ISSUED ITS BEGIN, OR TO THE DEFAULT —
   * never to a DIFFERENT one.
   *
   * The first rule here was "each end resolves the current slot", and its
   * reasoning still holds for the case it was written for: an UNBIND between
   * begin and commit sends the commit to the restored default, leaving a
   * dangling begin, which is exactly the shape the journal's launch recovery
   * exists for — a crash leaves the same. The alternative tried before that,
   * routing a commit back to the recorder that issued it, sent it into a
   * journal that had since CLOSED: a recoverable gap turned into a rejected
   * write whose bytes were already down.
   *
   * Neither rule covered the third case. A REBIND — unbind then bind, which
   * is every capability reload — leaves the slot holding a different, live
   * journal. "Resolve the current slot" then hands that journal a token it
   * never issued, and it rejects it: the file write has already happened, so
   * the mutation is durable and unjournalled, and the rejection surfaces as a
   * write failure for something that did not fail.
   *
   * The generation is what tells the three apart. Same generation: the
   * issuing recorder is still bound, commit to it. Different: fall through to
   * the DEFAULT, which is where an unbind already sent it — a dangling begin
   * in the old journal, nothing bogus in the new one, and recovery handles
   * both because it cannot tell them from a crash. */
  const recorderPort: MutationRecorder = {
    begin: async (book, what) => {
      const at = recorderSlot.generation()
      const token = await recorderSlot.get().begin(book, what)
      return { ...token, [BINDING]: at } as MutationToken
    },
    commit: (token: MutationToken, digest?: string) => {
      const at = (token as unknown as Record<symbol, unknown>)[BINDING]
      const target = at === recorderSlot.generation() ? recorderSlot.get() : recorder
      return target.commit(token, digest)
    },
  }
  const clockSlot = exclusiveSlot<() => Hlc>('bindClock: the clock port is already bound', clock ?? (() => hlcOf(Date.now())))
  const clockPort = () => clockSlot.get()()

  const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }
  const serviceHostSlot = exclusiveSlot<ServiceHost>('bindServiceHost: the service host is already bound', () => NOOP_DISPOSABLE)
  /* Null defaults, and that is the whole default: there is nothing sensible
   * for an unbound device or shelf port to answer, and a stub that returned
   * an empty peer list would be a lie a caller could not detect. */
  const deviceSlot = exclusiveSlot<DevicePort | null>('bindDevicePort: the device port is already bound', null)
  const shelfSlot = exclusiveSlot<ShelfPort | null>('bindShelfPort: the shelf port is already bound', null)
  const sizeSlot = exclusiveSlot<SizePort | null>('bindSizePort: the size port is already bound', null)
  /* The two provider ports (WI-15.4, WI-15.13). Held from birth for the same
   * reason the recorder is: a capability implementing one can only arrive
   * after construction, and the holders must not have to know that. */
  const companionSlot = exclusiveSlot<CompanionProvider>('bindCompanion: the companion port is already bound', NOT_CONFIGURED)
  const glossSlot = exclusiveSlot<GlossProvider>('bindGloss: the gloss port is already bound', NO_GLOSS)
  const workLineSlot = exclusiveSlot<WorkLine>('bindWorkLine: the work line port is already bound', NO_WORK_LINE)

  const writes = writeQueue()
  const library = createLibrary({ fs, queue: writes, initial: initialBooks, recorder: recorderPort, clock: clockPort })
  /* THE LIBRARY'S LANE, so a marks write and the record/move writes for the
   * same book are on ONE lane even after a rekey — `folderOf` alone is folder-
   * correct but does not follow a rename chain. */
  const marks = createMarkStore({ fs, queue: writes, recorder: recorderPort, clock: clockPort, lane: library.lane })
  const cards = createCards({ storage, recorder: recorderPort, clock: clockPort, queue: writes })
  const settings = createSettingsStore(
    /* `carryLegacySettings` by default, not `keepValues`: the app has a
     * settings file older than the namespaced keys, and the kernel is where
     * that history is known. A composition may still supply its own. */
    { storage, migrate: settingsMigration ?? carryLegacySettings },
  )
  return {
    library,
    marks,
    cards,
    settings,
    diagnostics,
    writes,
    shelfRead: () => shelfRead,
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
      /* THE FOLDER'S LANE, not the id's — `library.lane`, the same resolver
       * the record, mark and move writers use.
       *
       * This queued on the raw `bookId` while writing to `folderOf(bookId)`,
       * and `folderOf` is MANY-TO-ONE: `book:a/b` and `book:a_b` are two ids
       * and one directory, so they took two lanes over the same files and a
       * delete could interleave with a landing or a folder move. The comment
       * below already claimed this ran "inside the book's queued task, like
       * every other folder mutation" — it was the one that did not. */
      /* RECORDED, like every other folder mutation.
       *
       * A blob deletion changed the folder and journalled nothing, so a crash
       * between the unlink and whatever the caller did next left the bytes
       * gone with no entry saying so — invisible to the feed and to the
       * unclean-shutdown verify pass. The kind follows the name: a cover is a
       * `cover` mutation, everything else is `content`. */
      const kind: MutationKind = name === 'cover.webp' || name === 'cover.jpg' ? 'cover' : 'content'
      await writes.append(library.lane(bookId), () =>
        recorded(recorderPort, bookId, kind, async () => {
        const path = `${folderOf(bookId)}/${name}`
        /* EXISTS-THEN-REMOVE IS ATOMIC ONLY AGAINST THIS QUEUE, and another
         * PROCESS can still take the file in between — so a remove that races
         * one is an ordinary absence, not a fault. Absence is the documented
         * no-op for this operation either way; raising it would turn two
         * callers both doing the right thing into an error for one of them. */
        if (!(await fs.exists(path))) return
        await fs.remove(path).catch(async (cause: unknown) => {
          if (await fs.exists(path)) throw cause
        })
        }),
      )
    },
    bindRecorder: (next) => recorderSlot.bind(next),
    bindClock: (next) => clockSlot.bind(next),
    bindServiceHost: (next) => serviceHostSlot.bind(next),
    bindDevicePort: (next) => deviceSlot.bind(next),
    devices: () => deviceSlot.get(),
    bindShelfPort: (next) => shelfSlot.bind(next),
    shelf: () => shelfSlot.get(),
    bindSizePort: (next) => sizeSlot.bind(next),
    sizes: () => sizeSlot.get(),
    bindCompanion: (next) => companionSlot.bind(next),
    /* Resolved per call, never captured: a pane that read the provider once
     * at mount would still be showing "no model configured" after the reader
     * installed one. */
    companion: () => companionSlot.get(),
    bindGloss: (next) => glossSlot.bind(next),
    gloss: () => glossSlot.get(),
    lookUp: () => settings.get(LOOK_UP_SETTING),
    cycleLookUp: (hasDictionary, hasGloss) => {
      const modes = availableModes(hasDictionary, hasGloss)
      if (modes.length <= 1) return
      const current = effectiveMode(settings.get(LOOK_UP_SETTING), modes)
      const index = current === null ? -1 : modes.indexOf(current)
      settings.set(LOOK_UP_SETTING, modes[(index + 1) % modes.length] as LookUpMode)
    },
    hasDictionary: () => hasDictionary,
    bindWorkLine: (next) => workLineSlot.bind(next),
    workLine: () => workLineSlot.get(),
    serveServices: async (list) => (await serviceHostSlot.get()(list)) ?? NOOP_DISPOSABLE,
    drain: async () => {
      await writes.idle()
      await storage?.flush?.()
    },
  }
}
