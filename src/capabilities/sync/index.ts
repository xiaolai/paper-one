import { createElement } from 'react'
import {
  INDEX_FILE,
  defineSetting,
  parseIndex,
  restThenBreathe,
  scanBooks,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type IndexedBook,
  type KernelApi,
  type KernelServices,
  type ServiceContext,
  type ServiceContribution,
  type ServiceHandler,
  type Setting,
} from '../../kernel'
import { peerPort, registerSyncNow, type PeerPort } from '../peer'
import { createClock, ensureDeviceId, isHlc, type Hlc } from './lib/clock'
import { createBackfill } from './lib/backfill'
import { createCoverCache, type CoverCache } from './lib/coverCache'
import { JOURNAL_DIRTY_PATH, createJournal, type Journal } from './lib/journal'
import { createLedger, type Ledger, type SyncChannel } from './lib/ledger'
import { SYNC_SERVICES, parseContentAnswer, type SyncRole } from './lib/protocol'
import { bindRole, bindScheduler, currentRole, syncNow, syncStatus, unbindRole, unbindScheduler } from './lib/runtime'
import { createDownloads, describeDownload } from './lib/downloads'
import { describeArrival, dropArrival, readArrivals, recordArrival, type Arrival } from './lib/arrivals'
import { createSyncScheduler, type SyncScheduler } from './lib/scheduler'
import { DEGRADED_DETAIL } from './lib/status'
import { createStorageModel, dropDownloadSize, recordDownloadSize, type StorageModel } from './ui/storageModel'
import { StoragePane } from './ui/StoragePane'

/**
 * The `sync` capability, FILLED (WI-C.4): phase A built the ledger's parts
 * — clock, merge, journal — with no wiring; this is the wiring.
 *
 * `start()` does, in order: mint/load the device id and the persisted clock
 * floor; open the journal over the kernel's own filesystem (bootstrapping a
 * pre-journal shelf); bind the journal into the kernel's recorder port and
 * the clock into its clock port (`bindRecorder`/`bindClock` — the stores
 * held delegating ports from birth, so the bind reaches every store);
 * build the ledger; and then, by role: a SHELF serves the `sync.*` handlers
 * on the peer router and marks itself ready; a SATCHEL starts the
 * scheduler — sync on start, on visibility, five seconds after the last
 * local commit of a burst, and on "Sync now".
 *
 * The Capability's static surfaces delegate into runtime slots
 * (`lib/runtime.ts`): a registry validates the value before anything runs,
 * and the journal exists only after `start()`.
 */

/** The clock floor, persisted before any stamp escapes (`clock.ts`). */
/**
 * An app-relative path, resolved against the data root — the rule behind
 * `absoluteInDataRoot`, kept pure so it can be tested without a peer.
 *
 * Exported for that test and for no other caller: everything inside the
 * capability goes through the memoised wrapper, which is what makes the root
 * one question asked once.
 */
export function absoluteIn(root: string, path: string): string {
  /* The root must already be absolute — it is Rust's answer for the data
   * directory, and a relative or blank one would silently anchor the journal
   * to whatever the working directory happens to be. Same check, and the same
   * reason, as `contentBlobPort`. */
  if (typeof root !== 'string' || (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root))) {
    throw new Error('sync: the data root must be an absolute path')
  }
  const base = root.replace(/[\\/]+$/, '')
  if (base === '') throw new Error('sync: the data root must name a directory, not the filesystem root')
  return `${base}/${path.replace(/^[\\/]+/, '')}`
}

export const CLOCK_FLOOR_SETTING: Setting<string> = defineSetting('sync.clockFloor', '', (raw) =>
  typeof raw === 'string' ? raw : undefined,
)

/* ---------------------------------------------------------- runtime state */

let handlers: ReadonlyMap<string, ServiceHandler> | null = null
let running: {
  readonly port: PeerPort
  readonly ledger: Ledger
  readonly shelfPeer: () => Promise<string | null>
  readonly coverCache: CoverCache | null
  /** The composition's (scoped) filesystem — carried here so an action that
   *  outlives a teardown cannot write through a NEWER runtime's handle. */
  readonly fs: KernelApi['services']['fs']
} | null = null
let storageModel: StorageModel | null = null

const notReady = { code: 'not-ready', retryable: true, message: 'sync has not started' }

/** The static service list: names and grants for the registry, handlers
 *  delegating to the ledger built at start. */
const delegated = (name: string, grant: string): ServiceContribution => ({
  name: name as ServiceContribution['name'],
  grant,
  handler: (req: unknown, ctx: ServiceContext) => {
    const handler = handlers?.get(name)
    if (!handler) throw notReady
    return handler(req, ctx)
  },
})

/* MODULE-LEVEL, like `syncStatus`, because a `Capability` is a VALUE: its
 * `bookStatuses` are read once at composition, before any `start` has run, so
 * the store they read has to exist before the runtime does. */
const downloads = createDownloads()

/* ARRIVALS, mirrored in memory for the shelf row to read synchronously.
 * The file is the record; this is what `of` can answer from without awaiting.
 * Module-level for the reason `downloads` is: `bookStatuses` are read at
 * composition, before any `start` has run. */
const arrivals = new Map<string, Arrival>()
/* WHICH RUNTIME OWNS THE MAP. It is module-level — `bookStatuses` are read at
   composition, before any `start` — so a teardown and a fresh start share it.
   An in-flight `readArrivals` from the old lifetime could otherwise publish
   into the new one, and entries from a shelf run could survive into a satchel
   run that has no business holding them. Every start takes the next number,
   claims the map, and only its own reads may write. */
let arrivalsEpoch = 0
/* The running capability's diagnostics, so the module-level arrival helpers
   can REPORT rather than swallow. `pruneArrivals` runs outside `start`'s
   closure — it is driven by the library subscription — and a `.catch(() => {})`
   there meant a notice the reader had dismissed came back on the next launch
   with nothing anywhere saying why. */
let warn: ((code: string, detail: Record<string, unknown>) => void) | null = null
const arrivalListeners = new Set<() => void>()
const arrivalsChanged = () => {
  for (const listener of [...arrivalListeners]) listener()
}

/**
 * Forget the arrivals whose books the reader has now opened.
 *
 * OFF THE RENDER PATH, and that is the whole point of it existing. The
 * clearing used to happen inside `BookStatus.of`, which the shelf calls while
 * it draws: a render that mutated module state and started a write. This runs
 * from the library's own change subscription instead — the moment `openedAt`
 * moves is exactly a library change, so the notice still goes the instant the
 * book is opened, and nothing about drawing a row can write to disk.
 *
 * The disk write is best-effort and the memory drop is not: a failed write
 * costs a notice that returns once, on the next launch, which is a great deal
 * better than a render that cannot be repeated safely.
 */
function pruneArrivals(books: readonly { bookId: string; openedAt?: number }[]): void {
  if (arrivals.size === 0) return
  let dropped = false
  for (const book of books) {
    const arrival = arrivals.get(book.bookId)
    if (arrival === undefined) continue
    if (describeArrival(arrival, book) !== null) continue
    arrivals.delete(book.bookId)
    dropped = true
    const fs = running?.fs
    if (fs) {
      void dropArrival(fs, book.bookId).catch((thrown: unknown) => {
        warn?.('sync.arrival-drop-failed', {
          book: book.bookId,
          message: thrown instanceof Error ? thrown.message : String(thrown),
        })
      })
    }
  }
  if (dropped) arrivalsChanged()
}

const SERVICE_LIST: readonly ServiceContribution[] = Object.values(SYNC_SERVICES).map((service) =>
  delegated(service.name, service.grant),
)

/** An ephemeral channel to the paired shelf, for one task. */
async function withShelf<T>(task: (channel: SyncChannel) => Promise<T>): Promise<T> {
  /* ONE capture: `running` is a mutable module slot a teardown nulls, and a
   * restart replaces — dereferencing it again after an await could mix two
   * runtimes or read null mid-operation. */
  const held = running
  if (!held) throw new Error('sync has not started')
  const shelf = await held.shelfPeer()
  if (shelf === null) throw new Error('not paired with a shelf')
  const channel = await held.port.connect(shelf)
  try {
    return await task(channel)
  } finally {
    await channel.close().catch(() => {})
  }
}

/* IN FLIGHT, BY BOOK. The corner mark on the card and the Download item in
   the menu both run this, and neither disables itself while it works — so a
   second press started a second fetch for the same blob folder. The plugin
   refuses the duplicate transfer, which surfaced as sync going `degraded`
   over a double-click, and whichever attempt ended first cleared the other's
   progress row. The second caller now joins the first instead. */
const downloading = new Map<string, Promise<void>>()

function downloadAction(bookId: string): Promise<void> {
  const already = downloading.get(bookId)
  if (already !== undefined) return already
  const started = runDownload(bookId).finally(() => {
    downloading.delete(bookId)
  })
  downloading.set(bookId, started)
  return started
}

async function runDownload(bookId: string): Promise<void> {
  const held = running
  if (!held) return
  /* BEFORE the channel opens, not after: the first transfer event can arrive
     while `download` is still awaiting, and an expectation registered later
     would drop it. Registering early also makes the row answer the click at
     once rather than when the first byte lands. */
  downloads.expect(bookId)
  try {
    await withShelf(async (channel) => {
      const { size } = await held.ledger.download(channel, bookId, (received, total) =>
        downloads.progress(bookId, received, total),
      )
      const fs = held.fs
      if (fs) await recordDownloadSize(fs, bookId, size).catch(() => {})
      /* The jacket, best-effort — a cover that will not come costs nothing. */
      await held.coverCache?.ensure(bookId).catch(() => {})
    })
  } finally {
    /* WHATEVER HAPPENED. A terminal transfer event clears this already, but a
       download that fails before any event — no session, a refused grant —
       produces none at all, and a row left saying "Downloading…" forever is
       worse than the failure it is hiding. */
    downloads.forget(bookId)
  }
}

async function removeDownloadAction(bookId: string): Promise<void> {
  const held = running
  if (!held) return
  await held.ledger.removeDownload(bookId)
  const fs = held.fs
  if (fs) await dropDownloadSize(fs, bookId).catch(() => {})
}

let servicesFs: KernelApi['services']['fs'] = null
/* The journal HANDOFF: one journal's close must settle before the next
 * opens, or an overlapping restart's older close could delete the dirty
 * flag out from under the newer, live journal. */
let journalHandoff: Promise<void> = Promise.resolve()

/**
 * The contentHash backfill's rate limit, in milliseconds between batches.
 *
 * Protects the DISK and nothing else — `hashFile` hashes in Rust, so the pass
 * never touches the main thread and needs no protection from it. Staying off
 * the reader's back is `restThenBreathe`'s idle half, above this.
 *
 * It was three seconds, which at four books a batch is twenty-five minutes to
 * cross a two-thousand-book library. Four books per 250ms crosses the same
 * library in about two minutes and reads it at a rate no SSD notices. Tuned,
 * not derived: this is the number to raise if a slower disk ever makes the
 * pass audible.
 */
const BACKFILL_REST_MS = 250

/** The longest the backfill waits for an idle moment before going anyway. */
const BACKFILL_IDLE_CEILING_MS = 3_000

/* -------------------------------------------------------------- capability */

/**
 * `shelf.verify` — one integrity pass over the index and the journal.
 *
 * Three questions, each of which has bitten this project and each of which is
 * silent until somebody asks:
 *
 *   1. DANGLING BEGINS. A `begin` with no `commit` is what a crash between
 *      the two leaves, and what an unbind landing mid-bracket leaves. The
 *      journal's own launch recovery squares them at open; between opens they
 *      accumulate silently, and the count is the only sign.
 *   2. THE INDEX AGAINST THE FOLDERS. `index.json` is a cache and `book.json`
 *      is explicitly allowed to be newer, so a write that failed after the
 *      record landed leaves a cache that AGREES about folders and is wrong
 *      about contents. A count mismatch is the cheap, sound half of that.
 *   3. THE OUTBOX. Rows this device still owes a peer. Not a fault — but a
 *      number that never falls is a sync that is not happening, and nothing
 *      else in the app says so.
 *
 * REPORTS, never repairs. A verify that fixed what it found would make the
 * finding unobservable, and the repairs here are exactly the ones that must
 * be a human's decision.
 */
/**
 * The fields of a shelf row the SHELF reads — what `index.json` being "stale"
 * actually costs a reader: a wrong title on the shelf, a tag that will not
 * filter, a progress bar in the wrong place, a book that says it will open
 * and cannot.
 *
 * A subset rather than the whole row, deliberately. The scan derives some
 * fields afresh every time and the cache carries what it was written with, so
 * comparing everything would report differences that mean nothing and teach a
 * reader to ignore the answer.
 */
function summarise(row: IndexedBook): string {
  return JSON.stringify([
    row.title,
    row.author,
    [...(row.tags ?? [])].sort(),
    row.finished === true,
    row.progress ?? 0,
    row.hasContent === true,
  ])
}

async function integrityPass(
  journal: Journal,
  fs: ReturnType<() => KernelApi['services']['fs']>,
  /* The caller's cancellation, honoured at the two points where this pass
   * becomes expensive: the journal walk and the shelf scan. A verify runs over
   * the whole library, so a caller that timed out, cancelled, disconnected or
   * lost its grant used to leave the work running with nobody waiting. */
  signal?: AbortSignal,
): Promise<{ ok: boolean; findings: readonly string[]; notes: readonly string[] }> {
  const findings: string[] = []
  const notes: string[] = []
  const stop = (): boolean => signal?.aborted === true

  /* BY SEQUENCE, and a commit clears only its OWN begin.
   *
   * Brackets on one key can overlap — cards are not serialised by the book
   * queue — and the journal itself is careful about this: a runtime commit
   * carries the `seq` of the begin it settles, and only a baseline or verify
   * commit (which follows no begin) clears the key whole. Tracking one open
   * begin per key made a commit for the inner bracket hide a genuinely
   * dangling outer one, which is precisely the entry this pass exists to
   * find. */
  const open = new Map<string, Set<number>>()
  for (const entry of journal.entries()) {
    /* Cheap per entry, and a journal can hold tens of thousands. */
    if (stop()) return { ok: false, findings: ['cancelled'], notes }
    const key = `${entry.what}\u0000${entry.book}`
    if (entry.kind === 'begin') {
      const held = open.get(key) ?? new Set<number>()
      held.add(entry.seq)
      open.set(key, held)
      continue
    }
    if (entry.kind !== 'commit') continue
    if (entry.begin === undefined) open.delete(key)
    else open.get(key)?.delete(entry.begin)
  }
  const dangling = [...open.values()].reduce((total, one) => total + one.size, 0)
  if (dangling > 0) {
    findings.push(`${dangling} journal ${dangling === 1 ? 'bracket has' : 'brackets have'} a begin with no commit`)
  }

  /* A NOTE, NOT A FINDING. Rows waiting to push are the ordinary state of a
   * device that has not synced yet; counting them as an integrity fault made
   * `ok` false for a perfectly healthy shelf, which is the fastest way to
   * teach somebody to ignore the answer. */
  const owed = journal.outbox().length
  if (owed > 0) notes.push(`${owed} ${owed === 1 ? 'row is' : 'rows are'} still waiting to push`)

  if (fs) {
    try {
      /* BY CONTENT, not by count and not by id alone.
       *
       * `book.json` is explicitly allowed to be NEWER than `index.json` — the
       * index is a cache — so a write that failed between the two leaves a
       * cache with the right ids and stale fields, and nothing later notices:
       * `loadShelf` trusts a cache whose folder listing still agrees. That is
       * the failure this pass exists for, and a count or an id set cannot see
       * it. Comparing the fields the shelf actually reads can. */
      if (stop()) return { ok: false, findings: ['cancelled'], notes }
      const scanned = await scanBooks(fs)
      const onDisk = new Map(scanned.map((one) => [one.bookId, one] as const))
      const cached = parseIndex(new TextDecoder().decode(await fs.readFile(INDEX_FILE)))
      if (cached === null) findings.push('index.json is missing or will not parse')
      else {
        const indexed = new Map(cached.map((one) => [one.bookId, one] as const))
        /* A DUPLICATE ROW IS A FAULT, and a map alone would hide it: an
         * `index.json` holding one book twice has the right ids and the wrong
         * contents. */
        if (indexed.size !== cached.length) {
          findings.push(`index.json holds ${cached.length - indexed.size} duplicate row(s)`)
        }
        const missing = [...onDisk.keys()].filter((id) => !indexed.has(id))
        const extra = [...indexed.keys()].filter((id) => !onDisk.has(id))
        if (missing.length > 0) findings.push(`index.json is missing ${missing.length} book(s) the folders hold, e.g. ${missing[0]}`)
        if (extra.length > 0) findings.push(`index.json holds ${extra.length} book(s) with no folder, e.g. ${extra[0]}`)
        const stale = [...onDisk.entries()].filter(([id, row]) => {
          const held = indexed.get(id)
          return held !== undefined && summarise(held) !== summarise(row)
        })
        if (stale.length > 0) {
          findings.push(`index.json is behind the record for ${stale.length} book(s), e.g. ${stale[0]?.[0] ?? ''}`)
        }
      }
    } catch (error) {
      findings.push(`the library could not be scanned: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { ok: findings.length === 0, findings, notes }
}

export const sync: Capability = {
  id: 'sync',
  requires: ['peer'],

  settings: [
    {
      id: 'sync:storage',
      title: 'Storage',
      /* NEAR BEFORE FAR. Storage is what this machine is holding — the books
       * whose bytes are here, what the covers cost, how the last sync went.
       * Devices is the machines it talks to. A reader arriving at the bottom
       * of Settings is far more often asking "what is this using?" than
       * "what else is paired?", and the first answer should not be behind
       * the second.
       *
       * DECLARED rather than inherited: unordered, these two fell out of
       * `composeCapabilities`, which is topological by `requires` — so this
       * section sat below Devices purely because sync depends on peer. */
      order: 10,
      render: () => (storageModel ? createElement(StoragePane, { model: storageModel }) : null),
    },
  ],

  /* WHAT IS HAPPENING TO A BOOK, in the order a reader needs to hear it.
   *
   * The kernel takes the FIRST status that answers, so this list is a
   * priority. A download is in flight and finishes in a minute; an arrival
   * note has no deadline and sits there until the book is opened. With the
   * note first, a re-download of a book that had been pushed here would draw
   * its provenance instead of its progress for the whole transfer.
   *
   * Beside the action that starts it, which is the whole point: the reader
   * clicks Download in this menu and the answer appears on the row they
   * clicked, not in a list in Settings.
   */
  bookStatuses: [
    {
      id: 'sync:downloading',
      subscribe: downloads.subscribe,
      of: (book) => {
        const one = downloads.of(book.bookId)
        return one === null ? null : describeDownload(one)
      },
    },
    {
      /* WHERE A BOOK CAME FROM, when it came from somewhere. Announced rather
       * than gated — see `arrivals.ts` on why the shelf must not hold an
       * approval queue. It clears itself once the reader opens the book, so
       * this asks `describeArrival` on every render rather than caching a
       * decision that `openedAt` can invalidate underneath it. */
      id: 'sync:arrived',
      subscribe: (listener) => {
        arrivalListeners.add(listener)
        return () => arrivalListeners.delete(listener)
      },
      /* PURE. This is asked WHILE THE SHELF RENDERS, so it may only read.
         It used to delete the in-memory arrival and start a filesystem write
         from here — a render with side effects, which React is free to run
         twice, and whose swallowed failure meant a notice the reader had
         dismissed came back on the next launch. The forgetting moved to
         `pruneArrivals`, driven by the library's own subscription. */
      of: (book) => {
        const arrival = arrivals.get(book.bookId)
        if (arrival === undefined) return null
        return describeArrival(arrival, book)
      },
    },
  ],

  bookActions: [
    {
      id: 'sync:download',
      label: 'Download',
      icon: 'download',
      /* The fact the kernel needs for the tooltip on a row it cannot open:
         this is the repair, not re-importing the original file. */
      fetchesContent: true,
      /* A satchel's metadata-only row. The kernel's open path still refuses
       * a book with no bytes (`canOpen`); tap-to-open-fetches is C.6 polish
       * — this action is the honest seam today. */
      when: (book) => runningRole() === 'satchel' && book.hasContent !== true,
      run: (bookId) =>
        downloadAction(bookId).catch(() => {
          syncStatus.set({ state: 'degraded', detail: DEGRADED_DETAIL })
        }),
    },
    {
      /* EVICT, not "Remove download" (phase 11).
       *
       * The service table publishes `remove` with a contract — RECOVERABLE,
       * to the trash — and deleting this device's copy of some bytes is not
       * that act: the book stays on the shelf and every other device keeps
       * its copy. Two different verbs wearing one word is how a reader comes
       * to believe a menu item does something it does not.
       *
       * The cover cache already said `evict`, and `content.evict` and
       * `paper content evict` say it now. One concept, one word, in all four
       * places it is written down. */
      id: 'sync:evict',
      label: 'Evict',
      /* DELIBERATELY NOT A BIN. `Trash2` is the shelf's Remove, and the whole
       * reason this verb is called Evict is that the two acts are different:
       * Remove is recoverable and reaches every device, Evict frees this
       * device's bytes and the book stays put. Giving them one icon would
       * undo in artwork exactly what the label was renamed to prevent. */
      icon: 'circle-minus',
      when: (book) => runningRole() === 'satchel' && book.hasContent === true,
      run: (bookId) =>
        removeDownloadAction(bookId).catch(() => {
          /* Content that stayed put must not look removed — same signal as a
           * failed download. */
          syncStatus.set({ state: 'degraded', detail: DEGRADED_DETAIL })
        }),
    },
  ],

  services: [...SERVICE_LIST],

  /** The satchel-side stubs, declared (I.2). */
  clients: Object.values(SYNC_SERVICES).map((service) => ({ name: service.name as `${string}.${string}` })),

  async start(api: CapabilityContext, signal: AbortSignal): Promise<Disposable> {
    const services = api.services
    const settings = api.settings
    servicesFs = services.fs

    /* Every torn-down resource has a slot below; `stop` reads them, so it can
     * run at ANY point — including a `start` that throws half-way — and undo
     * exactly what was acquired so far. It is registered with the kernel's
     * disposer stack (the failure path) AND returned as the Disposable (the
     * normal path); it is idempotent, so the overlap is harmless. */
    /* This invocation's OWN published state, for the ownership checks in
     * `stop` — an overlapping restart's newer values are not this stop's. */
    let myRunning: typeof running = null
    let myHandlers: typeof handlers = null
    let myStorageModel: StorageModel | null = null
    let unbindClock: Disposable | null = null
    let unbindRecorder: Disposable | null = null
    let unbindShelfPort: Disposable | null = null
    let closeJournal: (() => void) | null = null
    let unserve: (() => void) | null = null
    let scheduler: SyncScheduler | null = null
    let unregisterSyncNow: (() => void) | null = null
    let offLibrary: (() => void) | null = null
    /* The epoch this runtime claimed, so its teardown can tell whether the
       map is still its own — see the `arrival-prune` step. */
    let myArrivalsEpoch: number | null = null
    let backfillTimer: ReturnType<typeof setTimeout> | null = null
    let boundRole: object | null = null
    let stopped = false

    const step = (label: string, fn: () => void): void => {
      try {
        fn()
      } catch (error) {
        api.diagnostics.warn('sync.teardown-step-failed', {
          label,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const stop = (): void => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', stop)
      step('scheduler', () => scheduler?.stop())
      step('bindScheduler', () => {
        if (scheduler !== null) unbindScheduler(scheduler)
      })
      step('syncNow', () => unregisterSyncNow?.())
      step('arrival-prune', () => {
        offLibrary?.()
        /* ONLY IF THE MAP IS STILL OURS. A stop that ran unconditionally
           cleared it and bumped the epoch even when a NEWER runtime had
           already claimed both — so a restart wiped the arrivals the new run
           had just loaded, and invalidated its in-flight read as well. A
           late-stopping old runtime now leaves the new one alone. */
        if (myArrivalsEpoch !== null && myArrivalsEpoch === arrivalsEpoch) {
          arrivalsEpoch++
          arrivals.clear()
          arrivalsChanged()
          warn = null
        }
        myArrivalsEpoch = null
      })
      step('shelf-port', () => unbindShelfPort?.dispose())
      step('serve', () => unserve?.())
      step('backfill', () => {
        if (backfillTimer !== null) clearTimeout(backfillTimer)
      })
      step('storageModel', () => {
        if (storageModel === myStorageModel) {
          storageModel?.dispose()
          storageModel = null
        } else {
          myStorageModel?.dispose()
        }
      })
      /* Cleared only under OWNERSHIP: an older, slower stop must not erase
       * a newer start's live runtime — the same rule peer's stop follows. */
      if (handlers === myHandlers) handlers = null
      if (running === myRunning) running = null
      if (servicesFs === services.fs) servicesFs = null
      /* Restore the kernel's recorder and clock BEFORE the journal closes, so
       * no store write is ever delegated into a journal that is shutting down
       * — the whole point of an unbind-able bind. */
      step('unbindRecorder', () => unbindRecorder?.dispose())
      step('unbindClock', () => unbindClock?.dispose())
      step('role', () => {
        if (boundRole !== null) unbindRole(boundRole)
      })
      /* Best-effort: the dirty flag stays if this write loses the race with
       * the window, and the next open's verify pass squares it — that is
       * what the flag is FOR. */
      step('journal', () => closeJournal?.())
    }
    api.onCleanup(stop)
    signal.addEventListener('abort', stop, { once: true })

    const device = ensureDeviceId(settings)
    const clock = createClock({
      deviceId: device,
      load: () => {
        const raw = settings.get(CLOCK_FLOOR_SETTING)
        return raw !== '' && isHlc(raw) ? (raw as Hlc) : null
      },
      save: (last) => settings.set(CLOCK_FLOOR_SETTING, last),
    })
    unbindClock = services.bindClock(() => clock.now())

    const port = peerPort()
    /**
     * The journal's paths, made absolute for the ONE call that is not an fs
     * call.
     *
     * Every path the journal hands its filesystem is app-relative — the
     * kernel's fs resolves them against `BaseDirectory.AppData`, which is what
     * `sync/journal.jsonl` means everywhere else in this file. `fsync` is not
     * an fs-plugin call: it is the peer plugin's own command, it takes a real
     * path, and it refuses one that is not absolute and inside the data root.
     * Handed the relative path it answered `pathNotAbsolute`, `journal.open()`
     * threw, and the composition rolled the whole set back — so a build with
     * `sync` composed showed the fatal screen instead of the library, with the
     * cause two `cause` links down.
     *
     * The root is Rust's answer (`paper_data_root`), asked for ONCE and reused:
     * a debug build may be pointed at `PAPER_TEST_DATA_DIR`, so TypeScript
     * resolving `appDataDir()` on its own would disagree with the process that
     * owns the files — the same reasoning `contentBlobPort` is built on.
     */
    let dataRoot: Promise<string> | null = null
    const absoluteInDataRoot = async (path: string): Promise<string> => {
      dataRoot ??= port!.dataRoot()
      return absoluteIn(await dataRoot, path)
    }
    const fs = services.fs
    let journal: Journal | null = null
    if (fs) {
      /* Wait out the previous lifetime's close (a no-op when none is in
       * flight) so two journals never overlap on the same files. */
      await journalHandoff.catch(() => {})
      journal = createJournal({
        fs,
        /* THE SHELF'S QUEUE — `JournalOptions.queue`'s stated contract: the
         * same queue the stores write on, so `drain()` at window close
         * covers a journal append still in flight. A private queue here
         * silently exempted exactly the writes durability exists for. */
        queue: services.writes,
        /* THE LANE EACH SURFACE ACTUALLY WRITES ON, so `markRemote`'s fence
         * orders against the kernel's own writers. `library.lane` is the
         * folder-and-rekey-aware resolver every record, mark and move write
         * uses; cards are a separate surface on their own key, which is the
         * empty string the card store queues under. */
        lane: (book, what) => (what === 'cards' ? '' : services.library.lane(book)),
        clock: () => clock.now(),
        /* NOT swallowed: the fsync hook is the journal's durability
         * barrier, and a barrier that reports success on failure is no
         * barrier — the append must fail loudly and stay retryable. */
        ...(port ? { fsync: async (path: string) => port.fsync(await absoluteInDataRoot(path)) } : {}),
        /* The canonical rows, tombstones included, off the kernel's card
         * store — sync holds no raw flat-store handle (WI-10.4). */
        cards: () => services.cards.stored(),
        /* A rebuilt journal and a first run look identical from the outside
         * and mean very different things to a peer — so it is said out loud,
         * with where the evidence went. */
        onQuarantine: ({ moved, reason }) => {
          api.diagnostics.error('sync.journal-quarantined', { moved, reason })
        },
      })
      await journal.open()
      const openedJournal = journal
      closeJournal = () => {
        journalHandoff = openedJournal.close().catch((error: unknown) => {
          api.diagnostics.warn('sync.teardown-step-failed', {
            label: 'journal-close',
            message: error instanceof Error ? error.message : String(error),
          })
        })
      }
      unbindRecorder = services.bindRecorder(journal)
    }
    /* An abort during `journal.open()` already ran `stop` — but the slots
     * filled SINCE it ran (the close hook, the recorder bind) were not swept,
     * and carrying on would acquire more. Re-arm, sweep, and fail the start
     * so the registry's rollback sees the truth. */
    const abortedDuringStart = (): boolean => {
      if (!stopped) return false
      stopped = false
      stop()
      return true
    }
    if (abortedDuringStart()) throw new Error('sync: start aborted while the journal was opening')

    if (fs && journal && port) {
      const openJournal = journal
      const role: SyncRole = await port.localRole().catch((error: unknown) => {
        /* The shelf fallback serves nothing extra and schedules nothing —
         * the safe side — but a role that could not be read is a fact the
         * log must carry, not a silent guess. */
        api.diagnostics.warn('sync.role-unknown', { message: error instanceof Error ? error.message : String(error) })
        return 'shelf' as SyncRole
      })
      if (abortedDuringStart()) throw new Error('sync: start aborted while the role was being read')
      boundRole = bindRole(role)
      /* THE ARRIVALS MAP IS CLAIMED HERE, before the role branch, because
         `onArrived` is handed to the ledger either way — a satchel that
         claimed nothing would have had every arrival dropped by the epoch
         check inside it. Hydration from disk is still the shelf's alone. */
      myArrivalsEpoch = ++arrivalsEpoch
      arrivals.clear()
      const fetchVerifiedBlob = (
        peerId: string,
        folder: string,
        blob: { name: string; size: number; hash: string },
        onProgress?: (received: number, total: number) => void,
      ) =>
        port.fetchBlob(
          { peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash },
          onProgress === undefined ? undefined : (event) => onProgress(event.received, event.total),
        )
      const ledger = createLedger({
        services,
        journal: openJournal,
        clock,
        device,
        role,
        fetchBlob: fetchVerifiedBlob,
        hashFile: (folder, name) => port.hashFile(folder, name),
        onArrived: (bookId, peerId) =>
          /* THE NAME, NOT THE ID. "Added from 8e20a13e…" is the same defect
             this pane spent a day being dug out of. Resolved against the peer
             record, and falling back to a plain sentence rather than to the
             id: a book that arrived from a device since revoked still arrived
             from somewhere, and the reader is owed that much. */
          /* RETURNED, not fired and forgotten: the ledger awaits this before
             it acks, so the sender is never told a book landed here while its
             provenance is still unwritten. */
          (async () => {
            const from =
              (await port.listPeers().catch(() => [])).find((one) => one.id === peerId)?.name ??
              'another device'
            /* EPOCH-CHECKED ACROSS THE AWAIT. `listPeers` is IPC, so a
               session that was still acking when the runtime stopped could
               land its arrival in a map the next run owns. */
            if (myArrivalsEpoch === null || myArrivalsEpoch !== arrivalsEpoch) return
            const arrival: Arrival = { from, at: Date.now() }
            arrivals.set(bookId, arrival)
            arrivalsChanged()
            const fs = services.fs
            if (fs) {
              await recordArrival(fs, bookId, arrival).catch((thrown: unknown) => {
                api.diagnostics.warn('sync.arrival-record-failed', {
                  book: bookId,
                  message: thrown instanceof Error ? thrown.message : String(thrown),
                })
              })
            }
          })(),
      })
      myHandlers = new Map(ledger.services().map((service) => [service.name, service.handler]))
      handlers = myHandlers
      const shelfPeer = async (): Promise<string | null> =>
        (await port.listPeers()).find((peer) => peer.role === 'shelf')?.id ?? null

      const coverCache = createCoverCache({
        fs,
        settings,
        /* The host's size port where the host has one — `paper` does, the
         * webview does not. Read at CALL time like the other outward ports,
         * because it is bound after the services are built. */
        bytesAt: async (path) => (await services.sizes()?.bytesAt(path)) ?? null,
        lookup: async (book) => {
          try {
            return await withShelf(async (channel) => {
              /* The one canonical parser — an ad-hoc cast here once accepted
               * shapes the protocol module would refuse. */
              const answer = parseContentAnswer(await channel.call(SYNC_SERVICES.content.name, { book }))
              if (answer === null) return null
              const cover =
                answer.coverName !== null && answer.coverSize !== undefined && answer.coverHash !== undefined
                  ? { name: answer.coverName, size: answer.coverSize, hash: answer.coverHash }
                  : null
              return { peerId: channel.peerId, folder: answer.folder, cover }
            })
          } catch {
            return null
          }
        },
        fetchBlob: fetchVerifiedBlob,
        /* Eviction's only delete — the kernel's closed-name primitive
         * (WI-10.2/10.5); the scoped fs cannot reach a book's folder. */
        removeBlob: (book, name) => services.removeBlob(book, name),
      })
      myRunning = { port, ledger, shelfPeer, coverCache, fs }
      running = myRunning
      myStorageModel = createStorageModel({
        services,
        coverCache,
        status: syncStatus,
        removeDownload: (book) => removeDownloadAction(book),
      })
      storageModel = myStorageModel

      /* THE `shelf` NOUN of the service table (phase 11) — the ROLE, its
       * endpoint, and the journal's head and epoch. Bound here because this
       * is the one place all four are in hand at once, and late-bound
       * because the kernel imports nothing from a capability. Unbound (a
       * browser tab, the CLI beside the app), `shelf.status` still counts
       * the books and says `null` for these; `shelf.sync` and `shelf.verify`
       * refuse `unsupported` by name, because there is nothing partial to
       * give — a sync that did not happen must not answer "started". */
      unbindShelfPort = services.bindShelfPort({
        facts: async () => ({
          role,
          endpointId: await port
            .status()
            .then((one) => one.endpointId)
            .catch(() => null),
          journalSeq: openJournal.head(),
          epoch: openJournal.epoch(),
        }),
        sync: async () => {
          /* A SHELF has no scheduler — it answers satchels, it does not dial
           * them — so "sync now" there is a request with nobody to make it
           * of, and saying so beats returning `started: true` for nothing. */
          if (role !== 'satchel') return { started: false, detail: 'a shelf answers satchels; it does not dial them' }
          syncNow()
          return { started: true, detail: null }
        },
        verify: async (signal) => integrityPass(openJournal, services.fs, signal),
      })

      if (role === 'shelf') {
        /* The composed services are served centrally by the peer host once
         * every capability has started (`services.serveServices`), so a
         * declared service is reachable whichever capability owns it — sync no
         * longer serves its own subset. The shelf here only tracks "last sync"
         * from an incoming session. The status is RESET first: it is a
         * module-global store, and a previous lifetime's `degraded` must not
         * survive into this one looking current. */
        syncStatus.set({ state: 'idle', detail: null })
        /* WHAT ARRIVED WHILE NOBODY WAS LOOKING. The shelf is the unattended
           device, so the notice has to survive a relaunch or it would only
           ever be seen by a reader who happened to be watching. */
        if (services.fs) {
          /* THE SEAM THAT REPLACED A SIDE EFFECT IN RENDER. `openedAt` moving
             IS a library change, so this fires the moment the reader opens an
             arrived book — the same instant the old code cleared it from
             inside `BookStatus.of`, but off the path React may re-run. */
          warn = (code, detail) => api.diagnostics.warn(code, detail)
          offLibrary = services.library.subscribe(() => {
            pruneArrivals(services.library.getSnapshot())
          })
          const epoch = myArrivalsEpoch
          void readArrivals(services.fs)
            .then((held) => {
              if (epoch !== arrivalsEpoch || stopped) return
              for (const [book, arrival] of Object.entries(held)) arrivals.set(book, arrival)
              arrivalsChanged()
            })
            .catch((thrown: unknown) => {
              /* An unreadable index is not an empty one. The notices are lost
                 for this run either way, but a silent loss is how a feature
                 comes to look as though it was never wired. */
              api.diagnostics.warn('sync.arrivals-read-failed', {
                message: thrown instanceof Error ? thrown.message : String(thrown),
              })
            })
        }
        unserve = port.onSessionOpen(() => syncStatus.set({ state: 'ok', lastSyncAt: Date.now() }))
      } else {
        const run = async (): Promise<void> => {
          syncStatus.set({ state: 'syncing', detail: null })
          try {
            const summary = await withShelf((channel) => ledger.runSession(channel))
            syncStatus.set({
              state: 'ok',
              detail: null,
              lastSyncAt: Date.now(),
              lastSummary: { pushed: summary.pushed, pulledRows: summary.pulledRows },
            })
          } catch (thrown) {
            api.diagnostics.warn('sync.session-failed', {
              message: thrown instanceof Error ? thrown.message : String(thrown),
            })
            syncStatus.set({ state: 'degraded', detail: DEGRADED_DETAIL })
          }
        }
        scheduler = createSyncScheduler({
          run,
          onLocalCommit: (listener) => openJournal.subscribe(listener),
          ...(typeof document !== 'undefined'
            ? {
                visibility: {
                  state: () => (document.visibilityState === 'visible' ? ('visible' as const) : ('hidden' as const)),
                  subscribe: (listener: () => void) => {
                    document.addEventListener('visibilitychange', listener)
                    return () => document.removeEventListener('visibilitychange', listener)
                  },
                },
              }
            : {}),
        })
        bindScheduler(scheduler)
        /* THE FEED. A satchel is the side that fetches bytes, so this is the
           side that has progress to report. Registered with the other
           satchel-only bindings so it comes off on the same teardown. */
        unregisterSyncNow = registerSyncNow(syncNow)
        scheduler.start()
      }

      /* The contentHash backfill, queued lazily: a small batch, then again
       * while there is work, riding idle seconds rather than launch.
       *
       * THREE SECONDS BETWEEN BATCHES OF FOUR was the whole rate, and on a
       * two-thousand-book library that is five hundred batches — twenty-five
       * minutes of a progress-less pass running behind a reader who has just
       * imported their shelf and is watching it fill in. The rest was
       * defending against hammering the disk at launch, which is real; it was
       * not defending the main thread, because `hashFile` hashes in Rust.
       *
       * So the two concerns are separated. `BACKFILL_REST_MS` is the rate
       * limit, and it is short because the disk is the only thing it protects.
       * The idle wait on top of it is what keeps the pass off a reader's back,
       * and it is the part that was never expressed: a fixed timer cannot
       * tell a scrolling shelf from an untouched window. See `restThenBreathe`.
       *
       * The floor is TUNED, not derived. Four books per 250ms reads this
       * library's three gigabytes over roughly two minutes, which is a rate
       * no SSD notices; if a slower disk ever makes that visible, this is the
       * number to raise. */
      const backfill = createBackfill({ services, hashFile: (folder, name) => port.hashFile(folder, name) })
      /* Wait, then a batch, then wait again while there is work. `stopped` is
       * checked on the far side of every wait rather than the wait being made
       * cancellable: an idle callback cannot be cancelled, and a tick that
       * wakes after teardown and does nothing is the same outcome. Only the
       * first arm is held on `backfillTimer`, so a capability stopped before
       * the pass ever ran leaves no timer behind. */
      const backfillTick = async (): Promise<void> => {
        await restThenBreathe(BACKFILL_REST_MS, BACKFILL_IDLE_CEILING_MS)
        if (stopped) return
        const stamped = await backfill.runOnce().catch(() => 0)
        if (!stopped && stamped > 0) void backfillTick()
      }
      backfillTimer = setTimeout(() => void backfillTick(), 0)
    } else {
      /* No filesystem (a browser tab) or no peer plugin: the ledger still
       * journals nothing and the UI says so instead of pretending. */
      myStorageModel = createStorageModel({ services, coverCache: null, status: syncStatus, removeDownload: null })
      storageModel = myStorageModel
      syncStatus.set({ state: 'idle', detail: fs ? 'Peer plugin unavailable' : 'No filesystem in a browser tab' })
    }

    api.diagnostics.info('sync.started', { wired: running !== null })

    return { dispose: stop }
  },
}

function runningRole(): SyncRole | null {
  return running === null ? null : currentRole()
}

export { useSync } from './ui/useSync'
export { syncStatus } from './lib/runtime'
export type { SyncStatus } from './lib/status'

/**
 * THE JOURNAL WITHOUT THE TRANSPORT — this capability's second and much
 * smaller composition, for a process that owns the library but has no peer
 * plugin (phase 11, WI-11.7).
 *
 * WHAT IT IS FOR. `paper` writes to the same folders the app does, and until
 * this existed those writes were invisible to sync: the CLI composed the
 * kernel's storage and nothing else, so `bindRecorder` was never called and
 * every mutation went to disk without a journal entry. Replication is a
 * journal feed. A change the journal never saw cannot travel, in either
 * direction, however long anyone waits — measured on two machines, with the
 * book's folder on disk and `grep -c` on `journal.jsonl` answering `0`.
 *
 * So this is the wiring that was missing, and only that wiring: the device id
 * and clock floor the app already persists, the journal over the kernel's own
 * filesystem, and the two binds. NO ledger, NO scheduler, NO role, NO peer —
 * a CLI cannot dial anyone, and pretending otherwise would put a second,
 * transport-less definition of "syncing" into this file. The commit lands in
 * the journal; the outbox is rebuilt from those lines the next time the APP
 * opens it, and the app pushes. That is why this works without a transport,
 * and it is a property of `compact`, which deliberately keeps the last local
 * commit even when a remote one landed after it.
 *
 * WHY THE DIRTY FLAG IS THE GATE, AND WHICH DIRECTION OF IT IS LOAD-BEARING.
 * Two processes appending to one `journal.jsonl` would corrupt it — not
 * merely the bytes, which `O_APPEND` would keep whole, but `nextSeq` and the
 * rev CAS, which each process holds in memory and neither would see the other
 * move. The advisory lock cannot prevent it: the app cannot take that lock (a
 * webview's filesystem has no exclusive create, see `dev-docs/cli.md`).
 *
 * The flag is what can. `open()` writes it before it returns, so a live
 * journal ALWAYS has it up — and the useful direction is the contrapositive:
 * **flag down means no journal opened these files and left them open.** That
 * is the only guarantee needed here, and it holds without asking the
 * operating system what is running.
 *
 * IT IS NOT A LIVENESS SIGNAL, and reading it as one is a mistake this
 * comment exists to stop somebody repeating. Measured on a real library:
 * `close()` did not clear it across an ordinary `quit app "Paper"`, and both
 * machines carried the flag for days with the app shut. A Tauri app quits by
 * tearing down the webview, and an async close that drains a queue and does
 * file I/O is not guaranteed to finish first. So "flag up" means "up for SOME
 * reason" — running, crashed, or simply quit — and the CLI may not conclude
 * from it that anyone is there.
 *
 * Hence the asymmetry: a journal is opened only when the flag is DOWN, which
 * is both safe and, on a library that has ever run the app, uncommon. The
 * caller decides what to do about the refusal; this only refuses.
 *
 * A second reason the same gate is right: a dirty open owes
 * `verifyAfterUncleanShutdown()`, a pass over every book that RAISES REVS.
 * That is the app's job on its own schedule, not something a `paper book add`
 * should do to sixteen gigabytes on its way past.
 *
 * WHAT IS STILL UNCOVERED, and is not pretended away: the app STARTING while
 * a CLI command holds the journal. The flag is checked once, before opening.
 * That window is the same one the CLI has always had against the stores, it
 * is not made wider here, and closing it needs the app to take a real lock —
 * a Rust command with an ACL entry, which is a phase of its own.
 */
export class JournalInUse extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JournalInUse'
  }
}

export interface LocalJournalOptions {
  readonly services: KernelServices
  /** Durability barrier. App-relative paths, as everywhere in this file. */
  readonly fsync?: (path: string) => Promise<void>
  /**
   * Open even when the dirty flag is up, WITHOUT running the recovery pass
   * the flag asks for and without clearing it.
   *
   * The caller states this, because the caller is the only one that can know
   * it: the flag means "not closed cleanly", which in the field is permanent
   * (the app's teardown cannot finish before its process dies), so the real
   * question — is another writer live — is answered by asking the operating
   * system, and a capability has no business doing that.
   */
  readonly allowDirty?: boolean
}

export interface LocalJournal {
  /** Drain, clear the dirty flag, unbind. The clean half of the pair. */
  readonly close: () => Promise<void>
}

export async function openLocalJournal({
  services,
  fsync,
  allowDirty = false,
}: LocalJournalOptions): Promise<LocalJournal> {
  const fs = services.fs
  /* Not a soft no: a caller that asked for a journal and silently got none
   * would write exactly the unreplicated mutations this exists to stop. */
  if (!fs) throw new Error('openLocalJournal: these services have no filesystem')
  const dirty = await fs.exists(JOURNAL_DIRTY_PATH)
  /* THE CALLER'S ANSWER OUTRANKS THE FLAG, IN BOTH DIRECTIONS.
   *
   * `allowDirty` used to be read only when the flag was up, so a caller that
   * KNEW another process held the library was still allowed to open a journal
   * whose flag happened to be down — which is precisely the app-starting
   * window: the app is live, has not yet written the flag, and a CLI opening
   * then makes two writers. The caller is the only side that can see a live
   * process, so its refusal has to bind whatever the flag says. */
  if (!allowDirty) {
    throw new JournalInUse(
      dirty
        ? 'the sync journal is marked dirty — Paper is running on this machine, or last exited without closing it'
        : 'Paper is running on this machine, or its presence could not be determined',
    )
  }

  /* THE SAME DEVICE AND THE SAME FLOOR THE APP USES, read from the settings
   * store they share. A private device id would make this machine's own CLI
   * look like a third device to every peer, and a private floor would let a
   * stamp go backwards across the two processes. */
  const clock = createClock({
    deviceId: ensureDeviceId(services.settings),
    load: () => {
      const raw = services.settings.get(CLOCK_FLOOR_SETTING)
      return raw !== '' && isHlc(raw) ? (raw as Hlc) : null
    },
    save: (last) => services.settings.set(CLOCK_FLOOR_SETTING, last),
  })
  const unbindClock = services.bindClock(() => clock.now())
  const journal = createJournal({
    fs,
    /* The shelf's queue, for `JournalOptions.queue`'s stated reason: the same
     * one the stores write on, so a drain covers a journal append in flight. */
    queue: services.writes,
    /* Same resolver as the app's composition: the fence has to land on the
     * lane the kernel's writers use, and `paper` shares that queue too. */
    lane: (book, what) => (what === 'cards' ? '' : services.library.lane(book)),
    clock: () => clock.now(),
    ...(fsync ? { fsync } : {}),
    /* Appending is ours; RECOVERING IS THE APP'S. Declining the pass keeps
     * the flag up, so the app still owes it and still performs it. */
    ...(dirty ? { recover: false } : {}),
  })
  try {
    await journal.open()
  } catch (error) {
    /* The clock is bound before the open because the journal stamps with it;
     * an open that threw would otherwise leave the port held by a journal
     * that does not exist. */
    unbindClock.dispose()
    throw error
  }
  const unbindRecorder = services.bindRecorder(journal)
  return {
    close: async () => {
      try {
        await journal.close()
      } finally {
        unbindRecorder.dispose()
        unbindClock.dispose()
      }
    },
  }
}

/**
 * Resolves when the journal this capability opened has finished closing.
 *
 * `Composition.dispose()` is synchronous, and the last thing sync's teardown
 * does is asynchronous — drain the queue, write the meta, remove the dirty
 * flag, fsync. `dispose()` therefore RETURNS BEFORE THE JOURNAL IS SHUT, which
 * is invisible on a reload (the next lifetime already waits on this same
 * promise) and fatal on a quit, where the process exits into the gap and the
 * flag is left up forever.
 *
 * The quit handshake in `lib.rs` awaits this before letting the app exit.
 * Resolves immediately when no journal was ever opened, and never rejects —
 * a close that failed is reported through diagnostics, and a shutdown that
 * refused to finish because of it would be a worse bug than the one it
 * reported.
 */
export function journalClosed(): Promise<void> {
  return journalHandoff.catch(() => {})
}
