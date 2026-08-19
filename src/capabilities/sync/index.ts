import { createElement } from 'react'
import {
  defineSetting,
  type Capability,
  type CapabilityContext,
  type Disposable,
  type KernelApi,
  type ServiceContext,
  type ServiceContribution,
  type ServiceHandler,
  type Setting,
} from '../../kernel'
import { peerPort, registerSyncNow, type PeerPort } from '../peer'
import { createClock, ensureDeviceId, isHlc, type Hlc } from './lib/clock'
import { createBackfill } from './lib/backfill'
import { createCoverCache, type CoverCache } from './lib/coverCache'
import { createJournal, type Journal } from './lib/journal'
import { createLedger, type Ledger, type SyncChannel } from './lib/ledger'
import { SYNC_SERVICES, parseContentAnswer, type SyncRole } from './lib/protocol'
import { bindRole, bindScheduler, currentRole, syncNow, syncStatus, unbindRole, unbindScheduler } from './lib/runtime'
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

async function downloadAction(bookId: string): Promise<void> {
  const held = running
  if (!held) return
  await withShelf(async (channel) => {
    const { size } = await held.ledger.download(channel, bookId)
    const fs = held.fs
    if (fs) await recordDownloadSize(fs, bookId, size).catch(() => {})
    /* The jacket, best-effort — a cover that will not come costs nothing. */
    await held.coverCache?.ensure(bookId).catch(() => {})
  })
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

/* -------------------------------------------------------------- capability */

export const sync: Capability = {
  id: 'sync',
  requires: ['peer'],

  settings: [
    {
      id: 'sync:storage',
      title: 'Storage',
      render: () => (storageModel ? createElement(StoragePane, { model: storageModel }) : null),
    },
  ],

  bookActions: [
    {
      id: 'sync:download',
      label: 'Download',
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
      id: 'sync:remove-download',
      label: 'Remove download',
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
    let closeJournal: (() => void) | null = null
    let unserve: (() => void) | null = null
    let scheduler: SyncScheduler | null = null
    let unregisterSyncNow: (() => void) | null = null
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
      const fetchVerifiedBlob = (peerId: string, folder: string, blob: { name: string; size: number; hash: string }) =>
        port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash })
      const ledger = createLedger({
        services,
        journal: openJournal,
        clock,
        device,
        role,
        fetchBlob: fetchVerifiedBlob,
        hashFile: (folder, name) => port.hashFile(folder, name),
      })
      myHandlers = new Map(ledger.services().map((service) => [service.name, service.handler]))
      handlers = myHandlers
      const shelfPeer = async (): Promise<string | null> =>
        (await port.listPeers()).find((peer) => peer.role === 'shelf')?.id ?? null

      const coverCache = createCoverCache({
        fs,
        settings,
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

      if (role === 'shelf') {
        /* The composed services are served centrally by the peer host once
         * every capability has started (`services.serveServices`), so a
         * declared service is reachable whichever capability owns it — sync no
         * longer serves its own subset. The shelf here only tracks "last sync"
         * from an incoming session. The status is RESET first: it is a
         * module-global store, and a previous lifetime's `degraded` must not
         * survive into this one looking current. */
        syncStatus.set({ state: 'idle', detail: null })
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
        unregisterSyncNow = registerSyncNow(syncNow)
        scheduler.start()
      }

      /* The contentHash backfill, queued lazily: a small batch, then again
       * while there is work, riding idle seconds rather than launch. */
      const backfill = createBackfill({ services, hashFile: (folder, name) => port.hashFile(folder, name) })
      const backfillTick = async (): Promise<void> => {
        if (stopped) return
        const stamped = await backfill.runOnce().catch(() => 0)
        /* Do not re-arm after teardown: an await that resolved past `stop`
         * would otherwise schedule a timer nobody clears. */
        if (!stopped && stamped > 0) backfillTimer = setTimeout(() => void backfillTick(), 3_000)
      }
      backfillTimer = setTimeout(() => void backfillTick(), 3_000)
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
