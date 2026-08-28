import type { IndexFs, IndexedBook } from './bookIndex'
import type { Disposable, ServiceContribution } from './capability'
import { createCards, type CardStorage, type Cards } from './cardStore'
import { hlcOf, type Hlc } from './hlc'
import { createLibrary, type Library } from './libraryStore'
import { createMarkStore, type MarkStore } from './markStore'
import { folderOf } from './bookFolder'
import { NOT_CONFIGURED, type CompanionProvider } from './companion'
import { NO_GLOSS, type GlossProvider } from './gloss'
import { NO_WORK_LINE, NOOP_DIAGNOSTICS, NOOP_RECORDER, REMOVABLE_BLOB_KINDS, REMOVABLE_BLOB_NAMES, recorded, type DevicePort, type Diagnostics, type MutationRecorder, type MutationToken, type RemovableBlobName, type SettingsStore, type ShelfPort, type SizePort, type WorkLine } from './ports'
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
  /**
   * The gloss provider — `NO_GLOSS` until one is bound.
   *
   * ⚠️ **THERE ARE NO LOOK-UP ACCESSORS BESIDE THIS ANY MORE.** `lookUp()`,
   * `cycleLookUp()` and `hasDictionary()` were here so that `inference` and
   * `companion` could draw a settings row cycling between the system
   * dictionary, the gloss and both — a value they could not reach through
   * `services.settings`, because `scopeSettings` confines a capability to its
   * own `<id>.` namespace and the setting was `kernel.lookUp`.
   *
   * All three are deleted with the mode they served. What is worth keeping
   * from the episode is why `hasDictionary` was on this interface at all: it
   * was a fact the composition root worked out and passed down, it defaulted
   * to `false` on the way, and the production caller forgot to pass it — so on
   * macOS the system dictionary silently vanished from the cycle. The
   * replacement fact lives on the provider (`GlossProvider.installable`),
   * where the object that knows the answer is the one that states it and no
   * caller can default it wrong.
   */
  gloss(): GlossProvider
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
/**
 * Which binding issued each token, held BESIDE the token rather than on it.
 *
 * ⚠️ **THE TOKEN USED TO BE CLONED.** `{ ...token, [BINDING]: at }` returns a
 * different object from the one the recorder minted, which breaks every
 * recorder whose token is more than a bag of enumerable fields: one that keys
 * a `Map` by identity, one that hands back a class instance with a prototype,
 * one with a non-enumerable id. Each would be handed something it did not
 * issue and would rightly refuse to commit it — after the file write, so the
 * mutation is durable, unjournalled, and reported as a failure.
 *
 * `MutationToken` is an interface, so the kernel does not get to assume the
 * shape behind it. A `WeakMap` records the generation without touching the
 * value, and the token that reaches `commit` is byte-for-byte the one `begin`
 * returned. Weak because the entry should die with the token; a bracket left
 * open by a crash must not pin one forever.
 */
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

/**
 * The recorder every store writes through, routing each commit to whichever
 * binding issued its begin.
 *
 * Its own function because it is a POLICY, not wiring: three cases, each with
 * a different right answer, and the reasoning below is why. Inline among
 * thirty other `const`s it read as setup, and the one time it was changed the
 * change was made without the third case in view.
 */
function routedRecorder(
  slot: { get(): MutationRecorder; generation(): number },
  fallback: MutationRecorder,
): MutationRecorder {
  /* PER RECORDER PORT, not module-wide. Token uniqueness is not something
   * `MutationRecorder` promises, so a recorder that reused one token object
   * across two `KernelServices` instances had each overwriting the other's
   * routing generation in a shared map. Weak, so an entry dies with its
   * token — a bracket left open by a crash must not pin one forever. */
  const issuedAt = new WeakMap<MutationToken, number>()
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
  return {
    begin: async (book, what) => {
      const at = slot.generation()
      const token = await slot.get().begin(book, what)
      /* THE RECORDER'S OWN OBJECT, UNTOUCHED — see `issuedAt`. */
      issuedAt.set(token, at)
      return token
    },
    commit: (token: MutationToken, digest?: string) => {
      /* A token this port never issued has no generation, so it cannot match
         one — and falls through to the default, which is the same answer an
         unbind gets and the one recovery already understands. */
      const at = issuedAt.get(token)
      const target = at === slot.generation() ? slot.get() : fallback
      return target.commit(token, digest)
    },
  }
}

/** What `removeBlob` needs of the services being built around it. */
interface BlobRemoval {
  readonly fs: IndexFs | null
  readonly writes: WriteQueue
  readonly library: Library
  readonly recorder: MutationRecorder
}

/**
 * Delete one blob from a book's folder — the kernel's ONE door into
 * `books/<id>/`.
 *
 * Its own function because it is an OPERATION, not composition: a closed name
 * set, an ownership check against the shelf, a lane, a journal bracket and an
 * idempotent delete, each with a reason that has to be read together. It sat
 * inline among thirty bindings, where it was by some distance the longest
 * thing in `createKernelServices` and the only one that did any work.
 */
async function removeBlob(
  { fs, writes, library, recorder }: BlobRemoval,
  bookId: string,
  name: RemovableBlobName,
): Promise<void> {
    if (!REMOVABLE_BLOB_NAMES.has(name)) {
      throw new Error(`removeBlob: ${JSON.stringify(name)} is not a blob the kernel removes`)
    }
    if (!fs) return
    /* ⚠️ **AN ALIAS MUST NOT REACH ANOTHER BOOK'S FOLDER.** `folderOf`
     * sanitises an id into `books/<safeId>` — a slash, a dot, anything
     * outside [A-Za-z0-9] becomes `_` — which stops traversal and does NOT
     * stop collision: it is many-to-one, so `book:a/b` and `book:a_b` are two
     * ids over one directory. A caller holding the first could delete the
     * second's content or jacket, and every check here passed it.
     *
     * The shelf is the authority on which id owns a folder. An id the shelf
     * does not hold at all is left alone — that is an already-removed book,
     * and absence is this operation's documented no-op — but an id whose
     * folder belongs to a DIFFERENT, live book is refused rather than
     * quietly honoured. */
    const folder = folderOf(bookId)
    /* ANY row on the folder that is not this id refuses — not the FIRST row
     * found. A snapshot holding both the requested id and a colliding alias
     * (a corrupt index, a caller-supplied initial set) let ordering decide
     * whether the shared blob could be deleted. */
    const other = library.getSnapshot().find((one) => folderOf(one.bookId) === folder && one.bookId !== bookId)
    if (other !== undefined) {
      throw new Error(
        `removeBlob: ${JSON.stringify(bookId)} does not own ${folder} — ${JSON.stringify(other.bookId)} does`,
      )
    }
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
    /* THE SURFACE COMES FROM THE ONE MAP — see `REMOVABLE_BLOB_KINDS`. It
     * was spelled out here as a second policy, so a removable cover name
     * added to the closed set would have been journalled as `content` and
     * told every peer the book's bytes had changed. */
    const kind = REMOVABLE_BLOB_KINDS[name]
    await writes.append(library.lane(bookId), async () => {
      const path = `${folder}/${name}`
      /* ⚠️ CHECKED BEFORE THE BRACKET IS OPENED, not inside it. An absent
       * blob is the documented no-op, and opening a bracket around it wrote
       * a committed mutation for a change that did not happen: the journal
       * advanced, the feed carried an entry, and the verify pass had one more
       * surface to digest — all for a file that was already gone. Removing
       * the same blob twice, or evicting a book whose bytes a peer already
       * took, did exactly this.
       *
       * EXISTS-THEN-REMOVE IS ATOMIC ONLY AGAINST THIS QUEUE, and another
       * PROCESS can still take the file in between — so a remove that races
       * one is an ordinary absence, not a fault. Absence is the documented
       * no-op for this operation either way; raising it would turn two
       * callers both doing the right thing into an error for one of them.
       * Both checks are inside the queued task, so the pair is still atomic
       * against everything else touching this folder. */
      if (!(await fs.exists(path))) return
      await recorded(recorder, bookId, kind, async () => {
        await fs.remove(path).catch(async (cause: unknown) => {
          if (await fs.exists(path)) throw cause
        })
      })
    })
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
}: KernelServicesOptions): KernelServices {
  /* The delegating ports. The stores capture THESE, so a bind after
   * construction reaches every store without any of them knowing. Each
   * slot's default target is what an unbind RESTORES. */
  const recorderSlot = exclusiveSlot<MutationRecorder>('bindRecorder: the recorder port is already bound', recorder)
  const recorderPort = routedRecorder(recorderSlot, recorder)
  const clockSlot = exclusiveSlot<() => Hlc>('bindClock: the clock port is already bound', clock ?? (() => hlcOf(Date.now())))
  const clockPort = () => clockSlot.get()()

  const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }
  /* A SET, NOT A SLOT, since phase 18.
   *
   * It was `exclusiveSlot` — "the service host is already bound" — which was
   * right while `peer` was the only transport. It is not a property of the
   * kernel: a service is a service, and the question of how many wires carry it
   * belongs to the wires. The browser client is a second transport serving the
   * SAME contributions, and with a slot it simply could not bind: `peer` held
   * it, and a browser signed in, called `book.list`, and waited for ever.
   *
   * Third time this shape has appeared in this phase — the envelope's home and
   * the test-project globs were the other two. An assumption that is safe with
   * one caller and silent with two. */
  /* ⚠️ **A SET OF BINDINGS, NOT A SET OF FUNCTIONS.** It held the `ServiceHost`
   * itself, so binding the SAME function twice collapsed to one entry and
   * either disposer removed the other's binding — a transport unbound by a
   * teardown that had nothing to do with it. Two transports sharing a
   * module-level host function is not exotic; it is what a shared adapter
   * looks like. Wrapping each binding in its own object makes identity
   * per-BINDING, which is what `bindServiceHost` returns a disposer for.
   * Found by audit. */
  const serviceHosts = new Set<{ readonly host: ServiceHost }>()
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
  /**
   * Dispose every served host, whatever any single one does.
   *
   * ⚠️ **THIS LOOP WAS WRITTEN OUT THREE TIMES AND EVERY COPY CALLED
   * `dispose()` BARE**, so one host throwing took the other two paths with it:
   *
   * - on the REJECTION unwind, the loop aborted, every host after the thrower
   *   stayed registered, and the throw replaced `thrown.reason` — the original
   *   failure, and the only one that says why any of this is unwinding;
   * - on the NO-DISPOSER unwind, the same, masking the error naming the host
   *   that answered wrongly;
   * - in the returned composite disposer, the same leak with nothing left to
   *   report it.
   *
   * A partial serve left running is the exact leak both unwinds exist to
   * prevent, arriving by the one door neither of them watched. Found by audit.
   *
   * Best-effort and total: every host is asked, failures are collected rather
   * than propagated, and the caller decides what outranks what. The original
   * error always does.
   */
  const disposeAll = (all: readonly (Disposable | undefined)[]): unknown[] => {
    const failures: unknown[] = []
    for (const one of all) {
      if (typeof one?.dispose !== 'function') continue
      try {
        one.dispose()
      } catch (cause) {
        failures.push(cause)
      }
    }
    return failures
  }

  const reportDisposeFailures = (where: string, failures: readonly unknown[]): void => {
    for (const cause of failures) {
      /* The diagnostics port is injected, and a throwing one must not abort
       * the remaining reports, make ordinary disposal throw, or REPLACE the
       * host-start failure this is reporting on. Every report on its own. */
      try {
        diagnostics.warn('services.host-dispose-failed', {
          where,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      } catch (reporting) {
        console.error('Paper: the diagnostics port threw while reporting a dispose failure', reporting, cause)
      }
    }
  }

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
    removeBlob: (bookId, name) => removeBlob({ fs, writes, library, recorder: recorderPort }, bookId, name),
    bindRecorder: (next) => recorderSlot.bind(next),
    bindClock: (next) => clockSlot.bind(next),
    bindServiceHost: (next) => {
      /* A fresh object per bind — see the Set's own note. Two binds of one
       * function are two bindings and two disposers, and neither reaches the
       * other. */
      const binding = { host: next }
      serviceHosts.add(binding)
      /* Idempotent, like every other disposer here: a capability whose teardown
       * runs twice must not remove a host a later composition bound. */
      let disposed = false
      return {
        dispose: () => {
          if (disposed) return
          disposed = true
          serviceHosts.delete(binding)
        },
      }
    },
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
    bindWorkLine: (next) => workLineSlot.bind(next),
    workLine: () => workLineSlot.get(),
    serveServices: async (list) => {
      /* NO HOST IS THE OFFLINE CASE, not a failure — see `bindServiceHost`.
       * With none bound there is nothing to serve and nothing to dispose. */
      if (serviceHosts.size === 0) return NOOP_DISPOSABLE

      /* EVERY host gets the same list. They are transports, and a service
       * reachable over one wire and not another would be a difference nothing
       * in this table describes. */
      /* ⚠️ `Promise.all` LOST THE DISPOSERS OF EVERY HOST THAT SUCCEEDED.
       *
       * It rejects on the first rejection and discards the other results, so a
       * second host that had already registered its handlers was left running
       * with nothing holding its disposer — the exact partial-serve leak the
       * check below was written to prevent, arriving by the one door that check
       * could not see. `allSettled` keeps them all, so the unwind can be
       * complete whichever way a host failed. */
      const settled = await Promise.allSettled([...serviceHosts].map(async ({ host }) => await host(list)))
      const served = settled.map((one) => (one.status === 'fulfilled' ? one.value : undefined))
      const thrown = settled.find((one) => one.status === 'rejected')
      if (thrown !== undefined && thrown.status === 'rejected') {
        /* THE ORIGINAL FAILURE WINS. A disposer throwing during the unwind is
         * worth reporting and must not replace the reason we are unwinding. */
        reportDisposeFailures('serve-rejected', disposeAll(served as (Disposable | undefined)[]))
        throw thrown.reason
      }

      /* ⚠️ A BOUND HOST RETURNING NO DISPOSER IS A DEFECT IN THAT HOST, and it
       * has to be told so where it happens rather than at the next restart.
       * This was once `?? NOOP_DISPOSABLE`, indistinguishable from the unbound
       * fallback — so a host that answered wrongly was silently accepted, and
       * if it had registered handlers their disposer went with it: teardown
       * took nothing down and the registrations leaked into the next
       * composition.
       *
       * Checked for EVERY host, and the ones that answered properly are still
       * disposed before throwing — a partial serve left running is the leak
       * this check exists to prevent, arriving by a different door. */
      const bad = served.findIndex((one) => typeof (one as Disposable | undefined)?.dispose !== 'function')
      if (bad !== -1) {
        reportDisposeFailures('serve-no-disposer', disposeAll(served as (Disposable | undefined)[]))
        throw new Error(`serveServices: a bound service host returned no disposer (host ${bad + 1} of ${served.length})`)
      }

      /* ONCE, HOWEVER OFTEN IT IS CALLED. `Disposable` says disposal is
       * idempotent and this ran every child again on a second call — so a
       * caller that disposed defensively (a teardown path and an unmount, say)
       * double-disposed every host beneath it. The children are not required to
       * tolerate that, and the contract does not ask them to. */
      let disposed = false
      return {
        dispose: () => {
          if (disposed) return
          disposed = true
          /* NOT `throw`: `Disposable.dispose()` is called from teardown paths
           * that have nothing to do with the host that failed, and a throw
           * here would abort THEIR cleanup for somebody else's defect. The
           * failure is reported instead, which is the only thing left that can
           * still be done with it. */
          reportDisposeFailures('unserve', disposeAll(served as (Disposable | undefined)[]))
        },
      }
    },
    drain: async () => {
      /* THE INDEX FIRST (phase 20, D4): a page turn writes `book.json` and
       * leaves the index dirty behind a throttle, and a drain is the one
       * moment — quit, window close — that must not wait for the timer. The
       * flush queues the rewrite; the idle below is what waits for it. */
      await library.flushIndex()
      await writes.idle()
      await storage?.flush?.()
    },
  }
}
