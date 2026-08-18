import { createElement } from 'react'
import {
  defineSetting,
  writeQueue,
  type Capability,
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
import { SYNC_SERVICES, type SyncRole } from './lib/protocol'
import { bindRole, bindScheduler, currentRole, syncNow, syncStatus } from './lib/runtime'
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
  if (!running) throw new Error('sync has not started')
  const shelf = await running.shelfPeer()
  if (shelf === null) throw new Error('not paired with a shelf')
  const channel = await running.port.connect(shelf)
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
    const fs = servicesFs
    if (fs) await recordDownloadSize(fs, bookId, size).catch(() => {})
    /* The jacket, best-effort — a cover that will not come costs nothing. */
    await held.coverCache?.ensure(bookId).catch(() => {})
  })
}

async function removeDownloadAction(bookId: string): Promise<void> {
  const held = running
  if (!held) return
  await held.ledger.removeDownload(bookId)
  const fs = servicesFs
  if (fs) await dropDownloadSize(fs, bookId).catch(() => {})
}

let servicesFs: KernelApi['services']['fs'] = null

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
      run: (bookId) => removeDownloadAction(bookId).catch(() => {}),
    },
  ],

  services: [...SERVICE_LIST],

  /** The satchel-side stubs, declared (I.2). */
  clients: Object.values(SYNC_SERVICES).map((service) => ({ name: service.name as `${string}.${string}` })),

  async start(api: KernelApi, signal: AbortSignal): Promise<Disposable> {
    const services = api.services
    const settings = api.settings
    servicesFs = services.fs

    const device = ensureDeviceId(settings)
    const clock = createClock({
      deviceId: device,
      load: () => {
        const raw = settings.get(CLOCK_FLOOR_SETTING)
        return raw !== '' && isHlc(raw) ? (raw as Hlc) : null
      },
      save: (last) => settings.set(CLOCK_FLOOR_SETTING, last),
    })
    services.bindClock(() => clock.now())

    const port = peerPort()
    const fs = services.fs
    let journal: Journal | null = null
    if (fs) {
      journal = createJournal({
        fs,
        queue: writeQueue(),
        clock: () => clock.now(),
        ...(port ? { fsync: (path: string) => port.fsync(path).catch(() => {}) } : {}),
        storage: services.storage,
      })
      await journal.open()
      services.bindRecorder(journal)
    }

    let unserve: (() => void) | null = null
    let scheduler: SyncScheduler | null = null
    let unregisterSyncNow: (() => void) | null = null
    let backfillTimer: ReturnType<typeof setTimeout> | null = null

    if (fs && journal && port) {
      const openJournal = journal
      const role: SyncRole = await port.localRole().catch(() => 'shelf' as SyncRole)
      bindRole(role)
      const ledger = createLedger({
        services,
        journal: openJournal,
        clock,
        device,
        role,
        fetchBlob: (peerId, folder, blob) =>
          port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash }),
        hashFile: (folder, name) => port.hashFile(folder, name),
      })
      handlers = new Map(ledger.services().map((service) => [service.name, service.handler]))
      const shelfPeer = async (): Promise<string | null> =>
        (await port.listPeers()).find((peer) => peer.role === 'shelf')?.id ?? null

      const coverCache = createCoverCache({
        fs,
        settings,
        lookup: async (book) => {
          try {
            return await withShelf(async (channel) => {
              const answer = (await channel.call(SYNC_SERVICES.content.name, { book })) as Record<string, unknown>
              const cover =
                typeof answer['coverName'] === 'string' &&
                typeof answer['coverSize'] === 'number' &&
                typeof answer['coverHash'] === 'string'
                  ? { name: answer['coverName'], size: answer['coverSize'], hash: answer['coverHash'] }
                  : null
              return { peerId: channel.peerId, folder: String(answer['folder'] ?? ''), cover }
            })
          } catch {
            return null
          }
        },
        fetchBlob: (peerId, folder, blob) =>
          port.fetchBlob({ peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash }),
      })
      running = { port, ledger, shelfPeer, coverCache }
      storageModel = createStorageModel({
        services,
        coverCache,
        status: syncStatus,
        removeDownload: (book) => removeDownloadAction(book),
      })

      if (role === 'shelf') {
        unserve = await port.serve(SERVICE_LIST)
        /* The shelf's "last sync" is the last satchel that came calling. */
        const offOpen = port.onSessionOpen(() => syncStatus.set({ state: 'ok', lastSyncAt: Date.now() }))
        const held = unserve
        unserve = () => {
          offOpen()
          held()
        }
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
        const stamped = await backfill.runOnce().catch(() => 0)
        if (stamped > 0) backfillTimer = setTimeout(() => void backfillTick(), 3_000)
      }
      backfillTimer = setTimeout(() => void backfillTick(), 3_000)
    } else {
      /* No filesystem (a browser tab) or no peer plugin: the ledger still
       * journals nothing and the UI says so instead of pretending. */
      storageModel = createStorageModel({ services, coverCache: null, status: syncStatus, removeDownload: null })
      syncStatus.set({ state: 'idle', detail: fs ? 'Peer plugin unavailable' : 'No filesystem in a browser tab' })
    }

    api.diagnostics.info('sync.started', { wired: running !== null })

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      scheduler?.stop()
      bindScheduler(null)
      bindRole(null)
      unregisterSyncNow?.()
      unserve?.()
      if (backfillTimer !== null) clearTimeout(backfillTimer)
      storageModel?.dispose()
      storageModel = null
      handlers = null
      running = null
      servicesFs = null
      /* Best-effort: the dirty flag stays if this write loses the race with
       * the window, and the next open's verify pass squares it — that is
       * what the flag is FOR. */
      void journal?.close().catch(() => {})
      signal.removeEventListener('abort', stop)
    }
    signal.addEventListener('abort', stop, { once: true })
    return { dispose: stop }
  },
}

function runningRole(): SyncRole | null {
  return running === null ? null : currentRole()
}

export { useSync } from './ui/useSync'
export { syncStatus } from './lib/runtime'
export type { SyncStatus } from './lib/status'
