import type { IndexFs, IndexedBook } from './bookIndex'
import { createCards, type CardStorage, type Cards } from './cardStore'
import { hlcOf, type Hlc } from './hlc'
import { createLibrary, type Library } from './libraryStore'
import { createMarkStore, type MarkStore } from './markStore'
import { NOOP_DIAGNOSTICS, NOOP_RECORDER, type Diagnostics, type MutationRecorder, type MutationToken, type SettingsStore } from './ports'
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
   * Bind the mutation-recorder port — the sync journal, at composition.
   *
   * LATE-BOUND, and that is the point: the services must exist before any
   * capability starts (a `start` receives them), so a port implemented BY a
   * capability can only arrive after construction. The stores hold a
   * delegating recorder from birth; this swaps its target ONCE. Binding
   * twice throws — two journals bracketing one write queue would be two
   * truths — and everything recorded before the bind went to the previous
   * target (the no-op default), which is exactly the pre-journal state the
   * journal's own bootstrap and verify pass exist to square.
   */
  bindRecorder(recorder: MutationRecorder): void
  /**
   * Bind the stamp clock — the sync capability's HLC, at composition. Same
   * shape and same once-only rule as `bindRecorder`. Until bound, stamps are
   * the legacy wall clock under the zero device (`hlcOf`), which is enough
   * with no sync composed.
   */
  bindClock(clock: () => Hlc): void
  /**
   * Resolves when nothing is in flight — the queue idle AND the flat store
   * flushed. For the one moment that cannot be deferred: the window closing.
   */
  drain(): Promise<void>
}

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
   * construction reaches every store without any of them knowing. */
  let recorderTarget = recorder
  let recorderBound = false
  const recorderPort: MutationRecorder = {
    begin: (book, what) => recorderTarget.begin(book, what),
    commit: (token: MutationToken, digest?: string) => recorderTarget.commit(token, digest),
  }
  let clockTarget: () => Hlc = clock ?? (() => hlcOf(Date.now()))
  let clockBound = false
  const clockPort = () => clockTarget()

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
    bindRecorder: (next) => {
      if (recorderBound) throw new Error('bindRecorder: the recorder port is already bound')
      recorderBound = true
      recorderTarget = next
    },
    bindClock: (next) => {
      if (clockBound) throw new Error('bindClock: the clock port is already bound')
      clockBound = true
      clockTarget = next
    },
    drain: async () => {
      await writes.idle()
      await storage?.flush?.()
    },
  }
}
