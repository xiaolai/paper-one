import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INDEX_FILE,
  createKernelServices,
  isHlc,
  makeHlc,
  parseHlc,
  parseRecord,
  scopeSettings,
  type Diagnostics,
  type IndexedBook,
  type KernelServices,
  type ServiceContext,
} from '../../kernel'
import { createPeerPort, fakeBlobHash, fakeWire, linkWires, type FakeWire, type PeerPort } from '../peer'
import { createClock, DEVICE_ID_SETTING } from './lib/clock'
import { COVER_CAP_SETTING } from './lib/coverCache'
import { JOURNAL_DIRTY_PATH, JOURNAL_PATH, createJournal, type Journal } from './lib/journal'
import { crashableFs, memoryStorage, type CrashableFs } from './lib/journalFs.testkit'
import { createLedger, type Ledger } from './lib/ledger'
import { SYNC_SERVICES } from './lib/protocol'
import { SYNC_QUARANTINE_SETTING } from './lib/quarantine'

/**
 * THE COMPOSITION ITSELF — what `start` wires, what it serves, schedules and
 * tears down.
 *
 * ⚠️ **NO TEST RAN IT** until 2026-09-14: `bookStatuses.test.ts` read the
 * static surfaces and `journalFsync.test.ts` read the source, so a mutation
 * sweep found 683 of this file's 735 mutants reached by nothing — every role
 * decision, every teardown step, every sentence the status line is given.
 *
 * It runs here WHOLE, over the kernel's real services and a real in-memory
 * library, with the real journal, ledger, scheduler, cover cache and storage
 * model underneath. What is stood in for is the NATIVE side and nothing else:
 * the peer plugin, as `peer`'s own port over its in-memory wire (`fakeWire`,
 * which `peer` exports for exactly this), and the far device, which is built
 * from the same parts this file composes. `peerPort` is the one seam replaced
 * in `../peer`, because it is the module slot `peer.start` fills from the
 * Tauri plugin; `registerSyncNow` is recorded rather than handed to the
 * Devices pane, which is `peer`'s to draw.
 *
 * FAKE TIMERS FOR EVERY RUN. The backfill waits on a timer, the scheduler's
 * backstop is one, and a real one left over from a run would fire into
 * whichever library the next test composes.
 */

const native = vi.hoisted(() => ({
  /** What `peerPort()` answers — the port `peer.start` would have built over the plugin. */
  port: null as unknown,
  /** The "Sync now" feeds registered with the Devices pane. */
  syncNow: new Set<() => void>(),
  /** Whether taking a feed back throws — the pane failing to let go. */
  refuseUnregister: false,
}))

vi.mock('../peer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../peer')>()),
  peerPort: () => native.port,
  registerSyncNow: (fn: () => void) => {
    native.syncNow.add(fn)
    return () => {
      if (native.refuseUnregister) throw new Error('the Devices pane would not let go')
      native.syncNow.delete(fn)
    }
  },
}))

import { CLOCK_FLOOR_SETTING, journalClosed, openLocalJournal, sync, syncStatus } from './index'

/* ---- the harness ---- */

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

interface Recorded {
  readonly level: 'info' | 'warn' | 'error'
  readonly event: string
  readonly fields: Record<string, unknown>
}

function recorder(): { readonly diagnostics: Diagnostics; readonly events: Recorded[] } {
  const events: Recorded[] = []
  const diagnostics: Diagnostics = {
    child: () => diagnostics,
    info: (event, fields = {}) => void events.push({ level: 'info', event, fields }),
    warn: (event, fields = {}) => void events.push({ level: 'warn', event, fields }),
    error: (event, fields = {}) => void events.push({ level: 'error', event, fields }),
  }
  return { diagnostics, events }
}

const named = (events: readonly Recorded[], event: string): Record<string, unknown>[] =>
  events.filter((one) => one.event === event).map((one) => one.fields)

const text = (bytes: Uint8Array | undefined): string | null => (bytes === undefined ? null : new TextDecoder().decode(bytes))

const record = (bookId: string, title: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ bookId, title, author: 'A. Author', addedAt: 100, format: 'epub', ...extra })

/** A book's folder, record and — when `bytes` is given — its content. */
const book = (bookId: string, title: string, bytes?: string, extra: Record<string, unknown> = {}): Record<string, string> => {
  const folder = `books/${bookId.replace(/[^a-zA-Z0-9]/g, '_')}`
  return {
    [`${folder}/book.json`]: record(bookId, title, extra),
    ...(bytes === undefined ? {} : { [`${folder}/content.epub`]: bytes }),
  }
}

/** The shelf rows a launch would have loaded from these folders. */
const booksOn = (fs: CrashableFs): IndexedBook[] => {
  const rows: IndexedBook[] = []
  for (const [path, bytes] of fs.store) {
    const m = /^books\/([^/]+)\/book\.json$/.exec(path)
    if (!m) continue
    const parsed = parseRecord(text(bytes))
    if (!parsed?.bookId) continue
    const hasContent = [...fs.store.keys()].some((key) => key.startsWith(`books/${m[1]}/content.`))
    rows.push({ ...parsed, bookId: parsed.bookId, hasContent })
  }
  return rows
}

/** Serve and land blobs out of a fake filesystem, as the plugin does out of the data root. */
function blobsOver(wire: FakeWire, fs: CrashableFs): void {
  wire.serveBlob = (folder, name) => fs.store.get(`books/${folder}/${name}`) ?? null
  wire.landBlob = async (folder, name, bytes) => {
    await fs.writeFile(`books/${folder}/${name}`, bytes)
  }
}

/** A wire with some of its commands replaced — the plugin failing, or answering late. */
function overriding(wire: FakeWire, over: Partial<Record<keyof FakeWire, unknown>>): FakeWire {
  return new Proxy(wire, {
    get: (target, key) => {
      if (Object.prototype.hasOwnProperty.call(over, key)) return over[key as keyof FakeWire]
      const value = (target as unknown as Record<PropertyKey, unknown>)[key]
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** Let every queued microtask, fake-wire event and queue step land. */
async function settled(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Retry `check` across event-loop turns — `vi.waitFor` would advance the fake
 * clock under it.
 *
 * ⚠️ **BOUNDED BY REAL TIME, AND IT WAS BOUNDED BY A COUNT OF TURNS.** A turn
 * count is no bound on work that is not on the event loop: this shelf's hashing
 * goes to the thread pool, and on a loaded runner six hundred turns pass in a
 * few milliseconds while a contended digest has not come back — so `until` gave
 * up on work that was merely slow and reported it as work that never happened.
 * That is the shape of the Linux leg's `4 of 5` failure on 2026-09-21, which
 * passed on a re-run and could not be reproduced on either machine here.
 *
 * `performance.now()` rather than `Date.now()`: this file fakes `Date`, so a
 * budget read from it would never advance. The budget is a LIVENESS bound — it
 * says the work arrives at all, not how fast — and a failing `check` now costs
 * it in full, which is a price paid only on a failure.
 */
async function until(check: () => unknown, ms = 10_000): Promise<void> {
  const deadline = performance.now() + ms
  let last: unknown = null
  for (;;) {
    try {
      await check()
      return
    } catch (cause) {
      last = cause
    }
    if (performance.now() >= deadline) break
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw last
}

/** Move the fake clock on in small steps, letting what each step wakes run before the next. */
async function elapse(ms: number, step = 25): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await vi.advanceTimersByTimeAsync(step)
    await settled(3)
  }
}

/**
 * Move the clock on until `check` holds, or give up saying so.
 *
 * For a pass whose next wait is armed only once the batch before it has fully
 * returned: there is no moment at which the clock can be advanced once and be
 * sure of waking the next step, so it is advanced in steps until the effect
 * appears. The bound is generous and is a liveness bound, not a rate claim —
 * what it asserts is that the pass carries on at all.
 */
async function elapseUntil(check: () => boolean, ms = 30_000, step = 250): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    if (check()) return
    await elapse(step, step)
  }
  if (!check()) throw new Error(`nothing happened in ${ms}ms of the fake clock`)
}

/** A promise and the hand that settles it. */
function gate<T = void>(): { readonly promise: Promise<T>; open(value: T): void; fail(cause: unknown): void } {
  let open: (value: T) => void = () => {}
  let fail: (cause: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open, fail }
}

interface Run {
  readonly services: KernelServices
  readonly fs: CrashableFs
  readonly wire: FakeWire
  readonly port: PeerPort | null
  readonly events: Recorded[]
  readonly diagnostics: Diagnostics
  readonly controller: AbortController
  readonly handle: { dispose(): void }
}

const running: Run[] = []

interface StartOptions {
  readonly role?: 'shelf' | 'satchel'
  readonly fs?: CrashableFs | null
  /** A wire already built — paired with a far end, or overriding a command. */
  readonly wire?: FakeWire
  /** No peer plugin at all. */
  readonly noPlugin?: boolean
  readonly services?: KernelServices
  readonly diagnostics?: { readonly diagnostics: Diagnostics; readonly events: Recorded[] }
  readonly controller?: AbortController
  /** Change the services the capability is handed before it starts. */
  readonly around?: (services: KernelServices) => KernelServices
}

/** Compose the capability as `composeCapabilities` would, over a fresh kernel. */
async function start(options: StartOptions = {}): Promise<Run> {
  const role = options.role ?? 'shelf'
  const fs = options.fs === undefined ? crashableFs() : options.fs
  const wire = options.wire ?? fakeWire({ role, endpointId: `${role}-under-test` })
  if (fs !== null) blobsOver(wire, fs)
  const port = options.noPlugin ? null : createPeerPort(wire)
  native.port = port
  const services = options.services ?? createKernelServices({ fs, storage: memoryStorage(), initialBooks: fs === null ? [] : booksOn(fs) })
  const { diagnostics, events } = options.diagnostics ?? recorder()
  const controller = options.controller ?? new AbortController()
  const given = options.around ? options.around(services) : services
  const handle = await sync.start!(
    { services: given, settings: scopeSettings(services.settings, 'sync'), diagnostics, onCleanup: () => {} },
    controller.signal,
  )
  const run: Run = { services, fs: fs as CrashableFs, wire, port, events, diagnostics, controller, handle }
  running.push(run)
  return run
}

interface FarEnd {
  readonly wire: FakeWire
  readonly fs: CrashableFs
  readonly services: KernelServices
  readonly journal: Journal
  readonly port: PeerPort
  readonly ledger: Ledger
}

/** The device at the other end, built from the parts the composition is made of. */
async function farEnd(role: 'shelf' | 'satchel', seed: Record<string, string> = {}): Promise<FarEnd> {
  const fs = crashableFs(seed)
  const wire = fakeWire({ role, endpointId: `${role}-far`, name: role === 'shelf' ? 'Study Mac' : 'Pocket' })
  blobsOver(wire, fs)
  const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: booksOn(fs) })
  const device = role === 'shelf' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb'
  const clock = createClock({ deviceId: device })
  const journal = createJournal({
    fs,
    queue: services.writes,
    lane: (bookId, what) => (what === 'cards' ? '' : services.library.lane(bookId)),
    clock: () => clock.now(),
    cards: () => services.cards.stored(),
  })
  await journal.open()
  services.bindRecorder(journal)
  services.bindClock(() => clock.now())
  const port = createPeerPort(wire)
  const ledger = createLedger({
    services,
    journal,
    clock,
    device,
    role,
    fetchBlob: (peerId, folder, blob, onProgress) =>
      port.fetchBlob(
        { peerId, folder, name: blob.name, expectedSize: blob.size, expectedHash: blob.hash },
        onProgress === undefined ? undefined : (event) => onProgress(event.received, event.total),
      ),
    hashFile: (folder, name) => port.hashFile(folder, name),
  })
  return { wire, fs, services, journal, port, ledger }
}

/** Pair a wire with a far end both ways, with the grants pairing one's own devices writes. */
function pair(near: FakeWire, far: FarEnd, farName = far.wire.id === 'shelf-far' ? 'Study Mac' : 'Pocket'): void {
  linkWires(near, far.wire)
  near.addPeer({ id: far.wire.id, role: far.wire.roleOf, grants: ['sync:*', 'blob:*'], name: farName })
  far.wire.addPeer({ id: near.id, role: near.roleOf, grants: ['sync:*', 'blob:*'], name: 'Under test' })
}

/** A satchel under test, paired with a far shelf that serves `services` (its own ledger's by default). */
async function satchelWith(
  seed: Record<string, string> = {},
  options: {
    readonly serve?: (far: FarEnd) => ReturnType<Ledger['services']>
    readonly near?: Record<string, string>
    /** Another device this satchel knew before it paired with the shelf. */
    readonly knows?: boolean
    readonly wire?: (wire: FakeWire) => FakeWire
    readonly start?: Partial<StartOptions>
  } = {},
): Promise<{ readonly far: FarEnd; readonly run: Run }> {
  const far = await farEnd('shelf', seed)
  await far.port.serve(options.serve ? options.serve(far) : far.ledger.services())
  const base = fakeWire({ role: 'satchel', endpointId: 'satchel-under-test' })
  if (options.knows) base.addPeer({ id: 'another-satchel', role: 'satchel', name: 'Other Phone', grants: ['sync:*'] })
  pair(base, far)
  const run = await start({ role: 'satchel', fs: crashableFs(options.near ?? {}), wire: options.wire ? options.wire(base) : base, ...options.start })
  return { far, run }
}

const ASKED = (peer = 'satchel-far') => ({ peer, signal: new AbortController().signal }) as unknown as ServiceContext

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: NOW })
  native.port = null
  native.syncNow.clear()
  native.refuseUnregister = false
})

afterEach(async () => {
  for (const run of running.splice(0)) run.handle.dispose()
  await journalClosed()
  syncStatus.set({ state: 'idle', detail: null, lastSyncAt: null, lastSummary: null })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/* ---- what the capability declares ---- */

describe('what the capability declares before anything starts', () => {
  it('is `sync`, needs `peer`, and publishes the protocol’s five services with their grants', () => {
    expect(sync.id).toBe('sync')
    expect(sync.requires).toEqual(['peer'])
    const table = Object.values(SYNC_SERVICES).map(({ name, grant }) => [name, grant])
    expect(sync.services?.map(({ name, grant }) => [name, grant])).toEqual(table)
    expect(sync.clients).toEqual(table.map(([name]) => ({ name })))
  })

  it('refuses every service as not ready, retryably, while nothing has started', async () => {
    for (const service of sync.services ?? []) {
      const cause = await Promise.resolve()
        .then(() => service.handler({}, ASKED()))
        .then(() => null, (thrown: unknown) => thrown)
      expect(cause, service.name).toEqual({ code: 'not-ready', retryable: true, message: 'sync has not started' })
    }
  })

  it('persists the clock floor as a string, and nothing else', () => {
    expect(CLOCK_FLOOR_SETTING.key).toBe('sync.clockFloor')
    expect(CLOCK_FLOOR_SETTING.fallback).toBe('')
    expect(CLOCK_FLOOR_SETTING.parse('0001')).toBe('0001')
    expect(CLOCK_FLOOR_SETTING.parse(1)).toBeUndefined()
    expect(CLOCK_FLOOR_SETTING.parse(null)).toBeUndefined()
  })

  it('contributes a Storage section, first, that draws nothing until a runtime holds its model', () => {
    expect(sync.settings?.map(({ id, title, order }) => ({ id, title, order }))).toEqual([{ id: 'sync:storage', title: 'Storage', order: 10 }])
    expect(sync.settings?.[0]?.render({ bookId: null })).toBeNull()
  })

  it('offers Download and Evict on a book, and neither while nothing runs', () => {
    expect(sync.bookActions?.map(({ id, label, icon, fetchesContent }) => ({ id, label, icon, fetchesContent }))).toEqual([
      { id: 'sync:download', label: 'Download', icon: 'download', fetchesContent: true },
      { id: 'sync:evict', label: 'Evict', icon: 'circle-minus', fetchesContent: undefined },
    ])
    for (const action of sync.bookActions ?? []) {
      expect(action.when?.({ bookId: 'b', title: 't', author: '', addedAt: 1, hasContent: false } as IndexedBook), action.id).toBe(false)
      expect(action.when?.({ bookId: 'b', title: 't', author: '', addedAt: 1, hasContent: true } as IndexedBook), action.id).toBe(false)
    }
  })

  it('answers the kernel’s quiesce question with a promise that settles when no journal was ever opened', async () => {
    const asked = sync.quiesce?.()
    expect(asked).toBeInstanceOf(Promise)
    await expect(asked).resolves.toBeUndefined()
  })
})

/* ---- a shelf ---- */

const journalLines = (fs: CrashableFs): Record<string, unknown>[] =>
  (text(fs.store.get(JOURNAL_PATH)) ?? '')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('a shelf', () => {
  /* THE STATUS IS A MODULE SLOT, so a previous lifetime's `degraded` would
     otherwise stand over this one looking current. */
  it('starts wired and idle, with a previous lifetime’s sentence gone', async () => {
    syncStatus.set({ state: 'degraded', detail: 'left over from before' })

    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'idle', detail: null })
    expect(named(shelf.events, 'sync.started')).toEqual([{ wired: true }])
    expect(native.syncNow.size, 'a shelf offered "Sync now" with nothing to dial').toBe(0)
  })

  /* THE `shelf` NOUN — the role, the endpoint, the journal's head and epoch,
     read from the runtime that is up. */
  it('tells the service table its role, endpoint, journal head and epoch, and refuses to sync by name', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const port = shelf.services.shelf()
    const meta = JSON.parse(text(shelf.fs.store.get('sync/journal.meta.json')) ?? '{}') as { epoch?: string }
    const seqs = journalLines(shelf.fs).map((line) => line['seq'] as number)

    expect(await port?.facts()).toEqual({ role: 'shelf', endpointId: 'shelf-under-test', journalSeq: Math.max(...seqs), epoch: meta.epoch })
    expect(seqs.length).toBeGreaterThan(0)
    expect(await port?.sync()).toEqual({ started: false, detail: 'a shelf answers satchels; it does not dial them' })
  })

  it('reports no endpoint rather than failing the facts, when the plugin will not say', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
    const shelf = await start({ wire: overriding(wire, { status: () => Promise.reject(new Error('the plugin is gone')) }) })

    expect(await shelf.services.shelf()?.facts()).toMatchObject({ role: 'shelf', endpointId: null })
  })

  it('draws its Storage section over this runtime’s model, and offers no Download or Evict', async () => {
    const shelf = await start({ fs: crashableFs({ ...book('book:a', 'Alpha', 'bytes'), ...book('book:b', 'Beta') }) })
    const drawn = sync.settings?.[0]?.render({ bookId: null }) as { readonly props: { readonly model: { getSnapshot(): unknown } } } | null

    expect(drawn?.props.model.getSnapshot()).toMatchObject({ status: { state: 'idle' } })
    for (const row of shelf.services.library.getSnapshot()) {
      for (const action of sync.bookActions ?? []) expect(action.when?.(row), `${action.id} on ${row.bookId}`).toBe(false)
    }
  })

  /* ⚠️ **"LAST SYNCED" IS THE HELLO ANSWERED, NOT THE SESSION OPENED.** A
     satchel refused at the hello still opened a session, and stamping the
     time there claimed an exchange that never happened. */
  it('goes green when a satchel connects, and stamps last synced only once its hello is answered', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const far = await farEnd('satchel')
    pair(shelf.wire, far)
    await shelf.port!.serve(sync.services ?? [])
    const channel = await far.port.connect(shelf.wire.id)

    await until(() => expect(syncStatus.getSnapshot()).toMatchObject({ state: 'ok', detail: null }))
    const refused = await channel.call(SYNC_SERVICES.hello.name, { proto: -1 }).then(() => null, (thrown: unknown) => thrown)
    expect((refused as { error?: { code?: string } }).error?.code).toBe('malformed')
    expect(syncStatus.getSnapshot().lastSyncAt, 'a refused hello stamped last synced').toBeNull()

    vi.setSystemTime(NOW + 1_000)
    const summary = await far.ledger.runSession(channel)
    await channel.close()

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'ok', detail: null, lastSyncAt: NOW + 1_000 })
    expect(summary.pulledRows).toBe(1)
    expect(far.services.library.getSnapshot().map((row) => row.title)).toEqual(['Alpha'])
  })

  it('hands each declared service to the running ledger, and refuses again once it stops', async () => {
    const shelf = await start()
    const hello = sync.services?.find((one) => one.name === SYNC_SERVICES.hello.name)
    const asked = () => Promise.resolve().then(() => hello?.handler({ proto: -1 }, ASKED())).then(() => null, (thrown: unknown) => thrown)

    expect(await asked()).toMatchObject({ code: 'malformed', message: 'not a sync hello' })
    shelf.handle.dispose()
    expect(await asked()).toEqual({ code: 'not-ready', retryable: true, message: 'sync has not started' })
  })
})


/* ---- arrivals: what turned up on a shelf by itself ---- */

const arrived = sync.bookStatuses?.find((one) => one.id === 'sync:arrived')
const downloading = sync.bookStatuses?.find((one) => one.id === 'sync:downloading')
/** What the shelf row says about a book, with nothing about the book itself to go on. */
const noticeOf = (bookId: string): unknown => arrived?.of({ bookId, title: '', author: '', addedAt: 0 } as IndexedBook)

/** Count what the shelf is told about arrivals. */
function listening(): { readonly calls: () => number; readonly off: () => void } {
  let calls = 0
  const off = arrived!.subscribe(() => {
    calls += 1
  })
  return { calls: () => calls, off: () => void off() }
}

/** A far satchel holding `seed` pushes it to the shelf under test, once. */
async function pushTo(shelf: Run, seed: Record<string, string>, served: () => void = () => {}): Promise<FarEnd> {
  const far = await farEnd('satchel', seed)
  pair(shelf.wire, far)
  await shelf.port!.serve(sync.services ?? [])
  const channel = await far.port.connect(shelf.wire.id)
  /* Armed once the session is open: the port reads the peers to learn their grants when one opens. */
  await settled()
  served()
  try {
    await far.ledger.runSession(channel)
  } finally {
    await channel.close()
  }
  return far
}

/**
 * A shelf wire whose `listPeers` is taken over once `armed` — the plugin
 * failing, or an arrival parked mid-flight. Not before: `serve` reads the
 * peers too, to learn their grants.
 */
function namesArmed(answer: (wire: FakeWire) => Promise<readonly unknown[]>): { readonly wire: FakeWire; arm(): void } {
  const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
  let armed = false
  return {
    wire: overriding(wire, { listPeers: () => (armed ? answer(wire) : wire.listPeers()) }),
    arm: () => {
      armed = true
    },
  }
}

/** A shelf wire whose `listPeers`, once armed, waits on `hold` first. */
const parkedNames = (hold: Promise<void>): { readonly wire: FakeWire; arm(): void } =>
  namesArmed(async (wire) => {
    await hold
    return wire.listPeers()
  })

const refuseWritesUnder = (fs: CrashableFs, prefix: string, cause = new Error(`the disk refused ${prefix}`)): void => {
  const write = fs.writeFile
  fs.writeFile = async (path, bytes) => {
    if (path.startsWith(prefix)) throw cause
    return write(path, bytes)
  }
}

describe('what a shelf says about a book that arrived by itself', () => {
  afterEach(() => {
    for (const run of running) run.handle.dispose()
  })

  /* THE NAME, NOT THE ID — resolved against the peer that pushed, not the
     first peer on the list. */
  it('names the device that pushed it, in memory and on disk, once the bytes are here', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
    wire.addPeer({ id: 'someone-else', role: 'satchel', name: 'Other Phone' })
    const shelf = await start({ wire, fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    await settled()
    const told = listening()
    try {
      await pushTo(shelf, book('book:new', 'Fresh', 'fresh bytes'))

      expect(text(shelf.fs.store.get('books/book_new/content.epub'))).toBe('fresh bytes')
      expect(noticeOf('book:new')).toEqual({ label: 'Added from Pocket' })
      expect(JSON.parse(text(shelf.fs.store.get('sync/arrivals.json')) ?? 'null')).toEqual({ 'book:new': { from: 'Pocket', at: NOW } })
      expect(told.calls()).toBe(1)
      expect(downloading?.of({ bookId: 'book:new' } as IndexedBook)).toBeNull()
    } finally {
      told.off()
    }
  })

  it('says another device, rather than an id, when the plugin will not name the sender', async () => {
    const names = namesArmed(() => Promise.reject(new Error('the plugin is gone')))
    const shelf = await start({ wire: names.wire })

    await pushTo(shelf, book('book:new', 'Fresh', 'fresh bytes'), names.arm)

    expect(noticeOf('book:new')).toEqual({ label: 'Added from another device' })
  })

  it('still says where the book came from, and why it will not survive a relaunch, when the notice will not save', async () => {
    const fs = crashableFs()
    refuseWritesUnder(fs, 'sync/arrivals')
    const shelf = await start({ fs })

    await pushTo(shelf, book('book:new', 'Fresh', 'fresh bytes'))

    expect(noticeOf('book:new')).toEqual({ label: 'Added from Pocket' })
    expect(named(shelf.events, 'sync.arrival-record-failed')).toEqual([{ book: 'book:new', message: 'the disk refused sync/arrivals' }])
  })

  /* THE SHELF IS THE UNATTENDED DEVICE, so a notice has to survive a relaunch. */
  it('reads back what arrived while nobody was looking, tells the shelf, and stops telling what unsubscribed', async () => {
    const told = listening()
    try {
      const shelf = await start({
        fs: crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) }),
      })

      await until(() => expect(noticeOf('book:a')).toEqual({ label: 'Added from Pocket' }))
      expect(told.calls()).toBeGreaterThan(0)
      const heard = told.calls()
      told.off()

      await shelf.services.library.update('book:a', (held) => ({ ...held, openedAt: NOW }))
      await until(() => expect(noticeOf('book:a')).toBeNull())
      expect(told.calls(), 'a listener that had unsubscribed was still told').toBe(heard)
    } finally {
      told.off()
    }
  })

  it('says so when the notices on disk will not read, rather than showing none', async () => {
    const shelf = await start({ fs: crashableFs({ 'sync/arrivals.json': 'not json' }) })

    await until(() => expect(named(shelf.events, 'sync.arrivals-read-failed')).toEqual([{ message: 'the arrivals index is not JSON' }]))
  })

  /* OFF THE RENDER PATH: the notice goes when the library says the book was
     opened, and a book still unread keeps its own. */
  it('forgets a notice once its book is opened, keeps the unread ones, and says nothing for a change that forgets none', async () => {
    const shelf = await start({
      fs: crashableFs({
        ...book('book:c', 'Gamma', 'bytes'),
        ...book('book:a', 'Alpha', 'bytes'),
        ...book('book:b', 'Beta', 'bytes'),
        'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 }, 'book:b': { from: 'Pocket', at: NOW - 1 } }),
      }),
    })
    await until(() => expect(noticeOf('book:b')).not.toBeNull())
    const told = listening()
    try {
      await shelf.services.library.update('book:a', (held) => ({ ...held, openedAt: NOW }))

      await until(() => expect(noticeOf('book:a')).toBeNull())
      expect(noticeOf('book:b')).toEqual({ label: 'Added from Pocket' })
      await until(() => expect(JSON.parse(text(shelf.fs.store.get('sync/arrivals.json')) ?? 'null')).toEqual({ 'book:b': { from: 'Pocket', at: NOW - 1 } }))
      const afterOpen = told.calls()
      expect(afterOpen).toBe(1)

      await shelf.services.library.tag('book:c', 'Sea')
      await shelf.services.library.update('book:b', (held) => ({ ...held, openedAt: NOW - 2 }))
      await settled()
      expect(told.calls(), 'a change that forgot nothing told the shelf something changed').toBe(afterOpen)
      expect(noticeOf('book:b')).toEqual({ label: 'Added from Pocket' })
    } finally {
      told.off()
    }
  })

  it('forgets the notice for this launch and says why when the file will not let it go', async () => {
    const fs = crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) })
    const shelf = await start({ fs })
    await until(() => expect(noticeOf('book:a')).not.toBeNull())
    refuseWritesUnder(fs, 'sync/arrivals')

    await shelf.services.library.update('book:a', (held) => ({ ...held, openedAt: NOW }))

    await until(() => expect(named(shelf.events, 'sync.arrival-drop-failed')).toEqual([{ book: 'book:a', message: 'the disk refused sync/arrivals' }]))
    expect(noticeOf('book:a')).toBeNull()
  })

  it('reports a drop that fails after the shelf has stopped to nobody, rather than throwing into the void', async () => {
    const fs = crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) })
    const shelf = await start({ fs })
    await until(() => expect(noticeOf('book:a')).not.toBeNull())
    const held = gate()
    const write = fs.writeFile
    fs.writeFile = async (path, bytes) => {
      if (path.startsWith('sync/arrivals')) {
        await held.promise
        throw new Error('the disk refused it late')
      }
      return write(path, bytes)
    }

    await shelf.services.library.update('book:a', (row) => ({ ...row, openedAt: NOW }))
    await until(() => expect(noticeOf('book:a')).toBeNull())
    shelf.handle.dispose()
    held.open()
    await settled()

    expect(named(shelf.events, 'sync.arrival-drop-failed')).toEqual([])
  })

  it('takes its notices down with it, and tells the shelf', async () => {
    const shelf = await start({ fs: crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) }) })
    await until(() => expect(noticeOf('book:a')).not.toBeNull())
    const told = listening()
    try {
      shelf.handle.dispose()

      expect(noticeOf('book:a')).toBeNull()
      expect(told.calls()).toBe(1)
    } finally {
      told.off()
    }
  })

  /* WHO OWNS THE MAP. It is module-level, so a lifetime that has been replaced
     — or stopped — must not publish into it. */
  it('drops an arrival that lands after its shelf stopped', async () => {
    const hold = gate()
    const names = parkedNames(hold.promise)
    const shelf = await start({ wire: names.wire })
    const far = await farEnd('satchel', book('book:new', 'Fresh', 'fresh bytes'))
    pair(shelf.wire, far)
    await shelf.port!.serve(sync.services ?? [])
    const channel = await far.port.connect(shelf.wire.id)
    await settled()
    names.arm()
    const session = far.ledger.runSession(channel)
    await until(() => expect(text(shelf.fs.store.get('books/book_new/content.epub'))).toBe('fresh bytes'))
    await settled()

    shelf.handle.dispose()
    hold.open()
    /* The rest of the session reaches a shelf that has stopped, and is refused. */
    await session.then(() => null, (thrown: unknown) => thrown)
    await settled()

    expect(noticeOf('book:new')).toBeNull()
    expect(shelf.fs.store.has('sync/arrivals.json')).toBe(false)
  })

  it('drops an arrival that lands after a newer shelf claimed the notices — even once that shelf has stopped', async () => {
    const hold = gate()
    const names = parkedNames(hold.promise)
    const older = await start({ wire: names.wire, fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const far = await farEnd('satchel', book('book:new', 'Fresh', 'fresh bytes'))
    pair(older.wire, far)
    await older.port!.serve(sync.services ?? [])
    const channel = await far.port.connect(older.wire.id)
    await settled()
    names.arm()
    const session = far.ledger.runSession(channel)
    await until(() => expect(text(older.fs.store.get('books/book_new/content.epub'))).toBe('fresh bytes'))
    await settled()

    const newer = await start({ fs: crashableFs({ ...book('book:b', 'Beta', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:b': { from: 'Pocket', at: NOW - 1 } }) }) })
    await until(() => expect(noticeOf('book:b')).not.toBeNull())
    newer.handle.dispose()
    expect(noticeOf('book:b')).toBeNull()

    hold.open()
    await session.then(() => null, (thrown: unknown) => thrown)
    await settled()
    expect(noticeOf('book:new'), 'a shelf whose notices were claimed by a newer one published into them').toBeNull()
    expect(older.fs.store.has('sync/arrivals.json')).toBe(false)
  })

  it('drops the notices an older shelf read back, once a newer shelf has claimed them', async () => {
    const fs = crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) })
    const reading = gate()
    const read = fs.readFile
    fs.readFile = async (path) => {
      if (path === 'sync/arrivals.json') await reading.promise
      return read(path)
    }
    await start({ fs })
    await start({ fs: crashableFs(book('book:b', 'Beta', 'bytes')) })

    reading.open()
    await settled()

    expect(noticeOf('book:a')).toBeNull()
  })

  it('drops the notices it read back once it has stopped', async () => {
    const fs = crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) })
    const reading = gate()
    const read = fs.readFile
    fs.readFile = async (path) => {
      if (path === 'sync/arrivals.json') await reading.promise
      return read(path)
    }
    const shelf = await start({ fs })
    shelf.handle.dispose()

    reading.open()
    await settled()

    expect(noticeOf('book:a')).toBeNull()
  })

  it('claims the notices afresh, so an older shelf’s do not show on a newer one — and its stopping takes none of the newer one’s', async () => {
    const older = await start({ fs: crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) }) })
    await until(() => expect(noticeOf('book:a')).not.toBeNull())

    await start({ fs: crashableFs({ ...book('book:b', 'Beta', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:b': { from: 'Pocket', at: NOW - 1 } }) }) })
    expect(noticeOf('book:a')).toBeNull()
    await until(() => expect(noticeOf('book:b')).not.toBeNull())

    const told = listening()
    try {
      older.handle.dispose()
      expect(noticeOf('book:b'), 'an older shelf stopping took the newer one’s notices').toEqual({ label: 'Added from Pocket' })
      expect(told.calls()).toBe(0)
    } finally {
      told.off()
    }
  })
})

/* ---- shelf.verify: the integrity pass ---- */

/** A row as `index.json` holds it — what the scan of `book()`'s folders produces, unless told otherwise. */
const indexRow = (bookId: string, title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  bookId,
  title,
  author: 'A. Author',
  addedAt: 100,
  format: 'epub',
  hasContent: true,
  ...extra,
})

const indexOf = (rows: readonly Record<string, unknown>[]): string => JSON.stringify({ version: 2, books: rows })

/** A signal that reads as aborted from the `n`th time it is asked. */
const abortedFrom = (n: number): AbortSignal => {
  let asked = 0
  return {
    get aborted() {
      asked += 1
      return asked >= n
    },
  } as AbortSignal
}

describe('what shelf.verify finds', () => {
  const verify = (run: Run, signal?: AbortSignal) => run.services.shelf()!.verify(signal)
  const shelfOf = (seed: Record<string, string>, rows: readonly Record<string, unknown>[] | string) =>
    start({ fs: crashableFs({ ...seed, [INDEX_FILE]: typeof rows === 'string' ? rows : indexOf(rows) }) })

  /* A NOTE, NOT A FINDING: rows waiting to push are what a shelf that has not
     synced looks like, and counting them as a fault teaches somebody to ignore
     the answer. */
  it('passes a sound shelf, and notes the rows it still owes — one, or several', async () => {
    const one = await shelfOf(book('book:a', 'Alpha', 'bytes'), [indexRow('book:a', 'Alpha')])
    expect(await verify(one)).toEqual({ ok: true, findings: [], notes: ['1 row is still waiting to push'] })
    one.handle.dispose()

    const two = await shelfOf({ ...book('book:a', 'Alpha', 'bytes'), ...book('book:b', 'Beta', 'bytes') }, [indexRow('book:a', 'Alpha'), indexRow('book:b', 'Beta')])
    expect(await verify(two)).toEqual({ ok: true, findings: [], notes: ['2 rows are still waiting to push'] })
  })

  it('has nothing to note for an empty shelf', async () => {
    expect(await verify(await shelfOf({}, []))).toEqual({ ok: true, findings: [], notes: [] })
  })

  /* A BEGIN WITH NO COMMIT is what a write that failed half-way leaves, and a
     commit clears only its own bracket: a later write to the same book that
     succeeded does not hide the one that did not. */
  it('counts the brackets a failed write left open — one, then two — and a later write to the same book hides neither', async () => {
    const shelf = await shelfOf({ ...book('book:a', 'Alpha', 'bytes'), ...book('book:b', 'Beta', 'bytes') }, [indexRow('book:a', 'Alpha'), indexRow('book:b', 'Beta')])
    const write = shelf.fs.writeFile
    let refusing = true
    shelf.fs.writeFile = async (path, bytes) => {
      if (refusing && path.startsWith('books/')) throw new Error('the disk is full')
      return write(path, bytes)
    }

    await shelf.services.library.tag('book:a', 'Sea').catch(() => null)
    expect((await verify(shelf)).findings).toEqual(['1 journal bracket has a begin with no commit'])

    await shelf.services.library.tag('book:b', 'Sea').catch(() => null)
    refusing = false
    await shelf.services.library.tag('book:a', 'Land')
    await shelf.fs.writeFile(INDEX_FILE, new TextEncoder().encode(indexOf(await scanRows(shelf))))
    const answer = await verify(shelf)
    expect(answer.findings).toEqual(['2 journal brackets have a begin with no commit'])
    expect(answer.ok).toBe(false)
  })

  it('refuses an index that will not parse, and one that holds a book twice', async () => {
    expect((await verify(await shelfOf(book('book:a', 'Alpha', 'bytes'), 'not json'))).findings).toEqual(['index.json is missing or will not parse'])

    const twice = await shelfOf(book('book:a', 'Alpha', 'bytes'), [indexRow('book:a', 'Alpha'), indexRow('book:a', 'Alpha')])
    expect((await verify(twice)).findings).toEqual(['index.json holds 1 duplicate row(s)'])
  })

  it('names a book the folders hold that the index lacks, and one the index holds with no folder', async () => {
    const shelf = await shelfOf({ ...book('book:a', 'Alpha', 'bytes'), ...book('book:b', 'Beta', 'bytes') }, [indexRow('book:a', 'Alpha'), indexRow('book:z', 'Zeta')])

    expect(await verify(shelf)).toMatchObject({
      ok: false,
      findings: ['index.json is missing 1 book(s) the folders hold, e.g. book:b', 'index.json holds 1 book(s) with no folder, e.g. book:z'],
    })
  })

  /* BY CONTENT: the fields a shelf row reads, and only those. */
  it('names a book whose index row is behind its record, for each field the shelf reads', async () => {
    const behind: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['title', {}, { title: 'Old title' }],
      ['author', {}, { author: 'Somebody else' }],
      ['tags', { tags: ['Sea'] }, { tags: ['Land'] }],
      ['finished', { finished: true }, { finished: false }],
      ['progress', { progress: 0.5 }, { progress: 0.7 }],
      ['hasContent', {}, { hasContent: false }],
    ]
    for (const [field, onRecord, inIndex] of behind) {
      const shelf = await shelfOf(book('book:a', 'Alpha', 'bytes', onRecord), [indexRow('book:a', 'Alpha', { ...onRecord, ...inIndex })])
      expect((await verify(shelf)).findings, field).toEqual(['index.json is behind the record for 1 book(s), e.g. book:a'])
      shelf.handle.dispose()
      await journalClosed()
    }
  })

  it('does not call a row behind for differences that mean nothing to the shelf', async () => {
    const same: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['tags in another order', { tags: ['Sea', 'Land'] }, { tags: ['Land', 'Sea'] }],
      ['no tags against none', {}, { tags: [] }],
      ['unfinished against unsaid', {}, { finished: false }],
      ['no progress against none', {}, { progress: 0 }],
      ['no bytes against unsaid', {}, { hasContent: undefined }],
    ]
    for (const [why, onRecord, inIndex] of same) {
      const bytes = why === 'no bytes against unsaid' ? undefined : 'bytes'
      const shelf = await shelfOf(book('book:a', 'Alpha', bytes, onRecord), [indexRow('book:a', 'Alpha', { ...inIndex, ...(bytes === undefined ? { hasContent: undefined } : {}) })])
      expect((await verify(shelf)).findings, why).toEqual([])
      shelf.handle.dispose()
      await journalClosed()
    }
    const noBytes = await shelfOf(book('book:a', 'Alpha'), [indexRow('book:a', 'Alpha', { hasContent: false })])
    expect((await verify(noBytes)).findings, 'no bytes against no bytes').toEqual([])
  })

  it('says the library could not be scanned, and why, rather than passing it', async () => {
    const shelf = await shelfOf(book('book:a', 'Alpha', 'bytes'), [indexRow('book:a', 'Alpha')])
    const read = shelf.fs.readFile
    shelf.fs.readFile = async (path) => {
      if (path === INDEX_FILE) throw new Error('the disk refused index.json')
      return read(path)
    }

    expect(await verify(shelf)).toEqual({ ok: false, findings: ['the library could not be scanned: the disk refused index.json'], notes: ['1 row is still waiting to push'] })
  })

  /* CANCELLED AT THE TWO EXPENSIVE POINTS: the journal walk, and the scan. */
  it('stops when its caller has gone — in the journal walk, or before the scan — and says so', async () => {
    const shelf = await shelfOf({ ...book('book:a', 'Alpha', 'bytes'), ...book('book:b', 'Beta', 'bytes') }, [indexRow('book:a', 'Alpha'), indexRow('book:b', 'Beta')])

    expect(await verify(shelf, abortedFrom(1))).toEqual({ ok: false, findings: ['cancelled'], notes: [] })
    /* Two journal lines are walked; the third question is the one before the scan. */
    expect(await verify(shelf, abortedFrom(3))).toEqual({ ok: false, findings: ['cancelled'], notes: ['2 rows are still waiting to push'] })
    expect(await verify(shelf, abortedFrom(4))).toEqual({ ok: true, findings: [], notes: ['2 rows are still waiting to push'] })
  })
})

/** The rows a scan of this shelf's folders reads, as the index would hold them. */
async function scanRows(run: Run): Promise<Record<string, unknown>[]> {
  const { scanBooks } = await import('../../kernel')
  return (await scanBooks(run.fs)) as unknown as Record<string, unknown>[]
}

/* ---- the contentHash backfill ---- */

describe('the contentHash backfill', () => {
  const hashed = (run: Run, bookId: string): unknown =>
    (JSON.parse(text(run.fs.store.get(`books/${bookId.replace(/[^a-zA-Z0-9]/g, '_')}/book.json`)) ?? '{}') as { contentHash?: unknown }).contentHash

  /** Past the rest and the idle ceiling, once. */
  const breathe = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(3_250)
    await settled()
  }

  /* A FEW AT A TIME, AGAIN WHILE THERE IS WORK — and not once more after. */
  it('hashes every book with bytes and no hash, four at a time, and leaves no timer once none are left', async () => {
    const seed: Record<string, string> = {}
    for (const id of ['a', 'b', 'c', 'd', 'e']) Object.assign(seed, book(`book:${id}`, id.toUpperCase(), `bytes of ${id}`))
    Object.assign(seed, book('book:f', 'No bytes'))
    const shelf = await start({ fs: crashableFs(seed) })
    expect(vi.getTimerCount(), 'the backfill was not queued').toBe(1)

    const done = () => ['a', 'b', 'c', 'd', 'e'].filter((id) => hashed(shelf, `book:${id}`) !== undefined)
    await vi.advanceTimersByTimeAsync(0)
    await breathe()
    /* The batch hashes off the clock; the next one waits on it. */
    await until(() => expect(done()).toHaveLength(4))
    await settled()
    expect(done()).toHaveLength(4)

    /* ⚠️ **THE NEXT BATCH'S WAIT IS ARMED AFTER THIS ONE RETURNS, NOT WHEN ITS
       LAST FILE LANDS — SO THE CLOCK IS MOVED IN STEPS RATHER THAN ONCE.** The
       check above sees a book's own `book.json`; `library.update` resolves later
       still, having written the index and told the journal, and only then does
       the pass arm its next rest. A single `advanceTimersByTimeAsync` after a
       fixed number of turns therefore raced that tail: on a loaded CI runner the
       clock moved past a timer that did not exist yet, nothing woke, and the
       case failed at four of five (Linux leg, 2026-09-21). Stepping cannot race
       it — a wait armed while the clock is moving is reached by a later step —
       and it needs no claim about which of the tail's writes is the slow one. */
    await elapseUntil(() => done().length === 5)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(hashed(shelf, `book:${id}`), id).toBe(await fakeBlobHash(new TextEncoder().encode(`bytes of ${id}`)))
    }
    expect(hashed(shelf, 'book:f')).toBeUndefined()

    /* And then nothing: the last batch stamped something, so it armed one more
       rest, and the clock is moved well past it — in steps, so that rest is
       reached however late it was armed. A pass that kept waking would still
       hold a timer at the end of this, which is what the count says. */
    await elapse(10_000)
    await settled()
    expect(vi.getTimerCount(), 'the backfill kept waking with nothing left to do').toBe(0)
  })

  it('leaves no timer behind when the shelf stops before the pass ever ran', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    shelf.handle.dispose()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing when it wakes after the shelf has stopped', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    await vi.advanceTimersByTimeAsync(1)
    shelf.handle.dispose()

    await breathe()
    await breathe()

    expect(hashed(shelf, 'book:a')).toBeUndefined()
  })

  /* A FAILURE IS NOT "NOTHING LEFT TO STAMP" — ended, but loudly. */
  it('ends on a pass that throws, and says so', async () => {
    let refusing = false
    const shelf = await start({
      fs: crashableFs(book('book:a', 'Alpha', 'bytes')),
      around: (services) => ({
        ...services,
        library: new Proxy(services.library, {
          get: (target, key) =>
            key === 'getSnapshot' && refusing
              ? () => {
                  throw new Error('the shelf will not list')
                }
              : Reflect.get(target, key),
        }),
      }),
    })
    refusing = true

    await vi.advanceTimersByTimeAsync(0)
    await breathe()

    await until(() => expect(named(shelf.events, 'sync.backfill-failed')).toEqual([{ message: 'the shelf will not list' }]))
    await breathe()
    expect(vi.getTimerCount()).toBe(0)
  })
})

/* ---- the clock and the journal this composition wires ---- */

describe('the clock and journal a start wires into the kernel', () => {
  const floorOf = (run: Run): string => run.services.settings.get(CLOCK_FLOOR_SETTING)

  it('stamps the kernel’s writes with this device’s clock, persisting the floor as it goes', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const device = shelf.services.settings.get(DEVICE_ID_SETTING)

    const stamp = shelf.services.clock()

    expect(parseHlc(stamp)).toMatchObject({ ms: NOW, device })
    expect(isHlc(floorOf(shelf))).toBe(true)
    expect(parseHlc(floorOf(shelf))).toMatchObject({ ms: NOW, device })
  })

  it('starts above the floor a previous run persisted, and ignores one that is not a stamp', async () => {
    const device = 'c0ffee00c0ffee00'
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    services.settings.set(DEVICE_ID_SETTING, device)
    services.settings.set(CLOCK_FLOOR_SETTING, makeHlc(NOW + 60_000, 7, device))
    const ahead = await start({ services, fs: services.fs as CrashableFs })
    expect(parseHlc(ahead.services.clock())).toMatchObject({ ms: NOW + 60_000, device })
    ahead.handle.dispose()
    await journalClosed()

    const garbled = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    garbled.settings.set(CLOCK_FLOOR_SETTING, 'not a stamp')
    const run = await start({ services: garbled, fs: garbled.fs as CrashableFs })
    expect(parseHlc(run.services.clock()).ms).toBe(NOW)
  })

  /* The kernel tells a newly bound clock the newest stamp it has handed out,
     and the clock must raise its own floor to it — or the next launch starts
     below a stamp this device already issued. */
  it('raises its persisted floor to a stamp the kernel handed out before it was bound', async () => {
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    vi.setSystemTime(NOW + 10_000)
    services.clock()
    vi.setSystemTime(NOW)
    const run = await start({ services, fs: services.fs as CrashableFs })

    run.services.clock()

    expect(parseHlc(floorOf(run)).ms).toBe(NOW + 10_000)
  })

  it('journals the kernel’s own writes, stamped by this device, flushed at the full barrier', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const flushed: unknown[][] = []
    const flush = fs.fsync
    fs.fsync = async (path: string, ...rest: unknown[]) => {
      flushed.push([path, ...rest])
      return flush(path)
    }
    const shelf = await start({ fs })
    const device = shelf.services.settings.get(DEVICE_ID_SETTING)

    await shelf.services.library.tag('book:a', 'Sea')

    expect(flushed).toContainEqual([JOURNAL_DIRTY_PATH, 'full'])
    const tagged = journalLines(fs).filter((line) => line['book'] === 'book:a' && line['seq'] !== 1)
    expect(tagged.map((line) => line['kind'])).toEqual(['begin', 'commit'])
    for (const line of tagged) expect(parseHlc(line['at'] as string).device).toBe(device)
  })

  it('journals the cards the kernel already holds into the baseline', async () => {
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    await services.cards.add({ id: 'card-1', bookId: 'book:a', kind: 'Excerpt', body: 'a line', answer: '', source: 'One', cfi: null, createdAt: NOW } as never)
    const shelf = await start({ services, fs: services.fs as CrashableFs })

    expect(journalLines(shelf.fs).filter((line) => line['what'] === 'cards').map((line) => line['kind'])).toEqual(['commit'])
  })

  /* A rebuilt journal and a first run look alike from outside, and mean very
     different things to a peer — so it is said, with where the evidence went. */
  it('says so, as an error, when it had to quarantine a journal that contradicted itself', async () => {
    const first = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    first.handle.dispose()
    await journalClosed()
    const lines = journalLines(first.fs)
    const broken = [...lines, { ...lines[0], seq: 1 }].map((line) => JSON.stringify(line)).join('\n') + '\n'
    const fs = crashableFs()
    for (const [path, bytes] of first.fs.store) fs.store.set(path, bytes)
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(broken))

    const shelf = await start({ fs })

    const [reported] = named(shelf.events, 'sync.journal-quarantined')
    expect(reported?.['moved']).toMatch(/^sync\/journal\.corrupt-.+\.jsonl$/u)
    expect(typeof reported?.['reason']).toBe('string')
    expect(fs.store.has(reported?.['moved'] as string)).toBe(true)
    expect(shelf.events.find((one) => one.event === 'sync.journal-quarantined')?.level).toBe('error')
  })

  /* `dispose()` returns before the journal is shut; the quit handshake waits on this. */
  it('settles journalClosed only once the journal it opened has closed', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    expect(shelf.fs.store.has(JOURNAL_DIRTY_PATH)).toBe(true)

    shelf.handle.dispose()
    await journalClosed()

    expect(shelf.fs.store.has(JOURNAL_DIRTY_PATH)).toBe(false)
  })

  it('reports a journal that would not close, and still settles journalClosed', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const remove = shelf.fs.remove
    shelf.fs.remove = async (path) => {
      if (path === JOURNAL_DIRTY_PATH) throw new Error('the flag would not go')
      return remove(path)
    }

    shelf.handle.dispose()
    await journalClosed()

    expect(named(shelf.events, 'sync.teardown-step-failed')).toEqual([{ label: 'journal-close', message: 'the flag would not go' }])
  })
})

/* ---- taking a runtime down, and one that never finished coming up ---- */

const refusing = (message: string) => () => {
  throw new Error(message)
}

describe('taking a runtime down', () => {
  /* EACH STEP ISOLATED: a throwing dispose must not rob the steps after it,
     and must be said by name. */
  it('reports each step that throws by name, still runs the rest, and runs none of it twice', async () => {
    let closing = false
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
    const shelf = await start({
      fs: crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/arrivals.json': JSON.stringify({ 'book:a': { from: 'Pocket', at: NOW - 1 } }) }),
      wire: overriding(wire, {
        onSessionOpen: (fn: Parameters<FakeWire['onSessionOpen']>[0]) => {
          wire.onSessionOpen(fn)
          return refusing('the session feed would not let go')
        },
      }),
      around: (services) => ({
        ...services,
        bindShelfPort: (port) => {
          services.bindShelfPort(port)
          return { dispose: refusing('the shelf port would not let go') }
        },
        bindRecorder: (recorder) => {
          const held = services.bindRecorder(recorder)
          return {
            dispose: () => {
              held.dispose()
              throw new Error('the recorder would not let go')
            },
          }
        },
        bindClock: (now, witness) => {
          const held = services.bindClock(now, witness)
          return {
            dispose: () => {
              held.dispose()
              throw new Error('the clock would not let go')
            },
          }
        },
        library: new Proxy(services.library, {
          get: (target, key) =>
            key === 'subscribe'
              ? (listener: () => void) => {
                  target.subscribe(listener)
                  return refusing('the library would not let go')
                }
              : Reflect.get(target, key),
        }),
        writes: {
          ...services.writes,
          append: (...args: Parameters<KernelServices['writes']['append']>) => {
            if (closing && args[0] === 'sync:journal') throw new Error('the queue has gone')
            return services.writes.append(...args)
          },
        } as KernelServices['writes'],
      }),
    })
    await until(() => expect(noticeOf('book:a')).not.toBeNull())
    const clear = globalThis.clearTimeout
    vi.stubGlobal('clearTimeout', refusing('the timer would not clear'))
    closing = true
    try {
      shelf.handle.dispose()
      shelf.handle.dispose()
    } finally {
      vi.stubGlobal('clearTimeout', clear)
    }

    expect(named(shelf.events, 'sync.teardown-step-failed')).toEqual([
      { label: 'arrival-prune', message: 'the library would not let go' },
      { label: 'shelf-port', message: 'the shelf port would not let go' },
      { label: 'serve', message: 'the session feed would not let go' },
      { label: 'backfill', message: 'the timer would not clear' },
      { label: 'storageModel', message: 'the library would not let go' },
      { label: 'unbindRecorder', message: 'the recorder would not let go' },
      { label: 'unbindClock', message: 'the clock would not let go' },
      { label: 'journal', message: 'the queue has gone' },
    ])
    /* WITHIN a step too: a dispose that throws must not leave the slot it
       empties pointing at what it was disposing. */
    expect(sync.settings?.[0]?.render({ bookId: null }), 'a model that would not dispose was left drawn').toBeNull()
    expect(noticeOf('book:a'), 'a subscription that would not let go left its notices standing').toBeNull()
  })

  it('lets go of every port it bound and every subscription it took, so the next runtime can bind them', async () => {
    const held = new Set<object>()
    const shelf = await start({
      fs: crashableFs(book('book:a', 'Alpha', 'bytes')),
      around: (services) => ({
        ...services,
        library: new Proxy(services.library, {
          get: (target, key) =>
            key === 'subscribe'
              ? (listener: () => void) => {
                  const token = {}
                  held.add(token)
                  const off = target.subscribe(listener)
                  return () => {
                    held.delete(token)
                    off()
                  }
                }
              : Reflect.get(target, key),
        }),
      }),
    })
    const { services } = shelf
    expect(services.shelf()).not.toBeNull()
    expect(held.size).toBeGreaterThan(0)

    shelf.handle.dispose()

    expect(held.size, 'a library subscription outlived the runtime').toBe(0)
    expect(services.shelf()).toBeNull()
    expect(() => services.bindRecorder({ begin: async (bookId, what) => ({ book: bookId, what }), commit: async () => {} }).dispose()).not.toThrow()
    expect(() => services.bindClock(() => makeHlc(NOW, 0, 'c0ffee00c0ffee00')).dispose()).not.toThrow()
    expect(named(shelf.events, 'sync.teardown-step-failed')).toEqual([])
  })

  it('stops answering sessions once it has stopped', async () => {
    const shelf = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const far = await farEnd('satchel')
    pair(shelf.wire, far)
    await shelf.port!.serve(sync.services ?? [])
    shelf.handle.dispose()

    await far.port.connect(shelf.wire.id)
    await settled()

    expect(syncStatus.getSnapshot().state).toBe('idle')
  })

  it('is taken down by the kernel’s cleanup, and by its lifetime ending', async () => {
    const cleanups: (() => void)[] = []
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    native.port = createPeerPort(fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' }))
    const { diagnostics } = recorder()
    const handle = await sync.start!(
      { services, settings: scopeSettings(services.settings, 'sync'), diagnostics, onCleanup: (fn) => void cleanups.push(fn) },
      new AbortController().signal,
    )
    running.push({ handle } as Run)
    expect(services.shelf()).not.toBeNull()
    for (const cleanup of cleanups) cleanup()
    expect(services.shelf(), 'the kernel’s cleanup did not take it down').toBeNull()

    const ended = new AbortController()
    const again = await start({ controller: ended })
    expect(again.services.shelf()).not.toBeNull()
    ended.abort()
    expect(again.services.shelf(), 'the lifetime ending did not take it down').toBeNull()
  })

  /* A start that throws is unwound by the kernel's cleanup — and must undo
     exactly what it acquired, which here is nothing. */
  it('tears down nothing, and reports nothing, for a start that failed before it acquired anything', async () => {
    const cleanups: (() => void)[] = []
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    const { diagnostics, events } = recorder()
    const settings = { ...scopeSettings(services.settings, 'sync'), get: refusing('the settings will not read') }

    const cause = await Promise.resolve(sync.start!({ services, settings, diagnostics, onCleanup: (fn) => void cleanups.push(fn) }, new AbortController().signal)).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    for (const cleanup of cleanups) cleanup()

    expect((cause as Error).message).toBe('the settings will not read')
    expect(cleanups).toHaveLength(1)
    expect(named(events, 'sync.teardown-step-failed')).toEqual([])
  })
})

describe('a start that is aborted part-way', () => {
  it('fails, and undoes what it had, when its lifetime ends while the journal is opening', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const opening = gate()
    const reading = { asked: false }
    const read = fs.readFile
    fs.readFile = async (path) => {
      if (path === 'sync/journal.meta.json') {
        reading.asked = true
        await opening.promise
      }
      return read(path)
    }
    const controller = new AbortController()
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: booksOn(fs) })
    const { diagnostics, events } = recorder()
    const starting = start({ fs, services, controller, diagnostics: { diagnostics, events } }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    await until(() => expect(reading.asked).toBe(true))

    controller.abort()
    opening.open()
    const cause = await starting
    await journalClosed()

    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('sync: start aborted while the journal was opening')
    expect(fs.store.has(JOURNAL_DIRTY_PATH), 'the journal it opened was left open').toBe(false)
    expect(() => services.bindRecorder({ begin: async (bookId, what) => ({ book: bookId, what }), commit: async () => {} }).dispose()).not.toThrow()
    expect(named(events, 'sync.teardown-step-failed')).toEqual([])
    expect(named(events, 'sync.started')).toEqual([])
  })

  it('fails, and undoes what it had, when its lifetime ends while the role is being read', async () => {
    const asking = gate<'shelf'>()
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
    const asked = { yes: false }
    const controller = new AbortController()
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const { diagnostics, events } = recorder()
    const starting = start({
      fs,
      controller,
      diagnostics: { diagnostics, events },
      wire: overriding(wire, {
        localRole: () => {
          asked.yes = true
          return asking.promise
        },
      }),
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    await until(() => expect(asked.yes).toBe(true))

    controller.abort()
    asking.open('shelf')
    const cause = await starting
    await journalClosed()

    expect((cause as Error).message).toBe('sync: start aborted while the role was being read')
    expect(fs.store.has(JOURNAL_DIRTY_PATH)).toBe(false)
    expect(named(events, 'sync.teardown-step-failed')).toEqual([])
  })

  /* A ROLE THAT COULD NOT BE READ serves nothing extra and schedules nothing:
     the safe side of a fact this device could not establish. */
  it('comes up as a shelf when the role cannot be read at all, and says it could not', async () => {
    const wire = fakeWire({ role: 'satchel', endpointId: 'satchel-under-test' })
    const asked = { yes: false }
    const starting = start({
      wire: overriding(wire, {
        localRole: () => {
          asked.yes = true
          return Promise.reject(new Error('the plugin is not ready'))
        },
      }),
    })
    await until(() => expect(asked.yes).toBe(true))
    await elapse(1_000)
    const shelf = await starting

    expect(await shelf.services.shelf()?.facts()).toMatchObject({ role: 'shelf' })
    expect(named(shelf.events, 'peer.role-unknown')).toEqual([{ tries: 3, message: 'the plugin is not ready' }])
    expect(native.syncNow.size).toBe(0)
  })

  it('stops retrying the role as soon as its lifetime ends', async () => {
    const wire = fakeWire({ role: 'shelf', endpointId: 'shelf-under-test' })
    const controller = new AbortController()
    const { diagnostics, events } = recorder()
    const asked = { yes: false }
    const starting = start({
      controller,
      diagnostics: { diagnostics, events },
      wire: overriding(wire, {
        localRole: () => {
          asked.yes = true
          return Promise.reject(new Error('the plugin is not ready'))
        },
      }),
    }).then(
      () => null,
      (thrown: unknown) => thrown,
    )
    await until(() => expect(asked.yes).toBe(true))

    controller.abort()
    await elapse(1_000)

    expect(((await starting) as Error).message).toBe('sync: start aborted while the role was being read')
    expect(named(events, 'peer.role-unknown')).toEqual([])
  })
})

describe('a runtime with no transport', () => {
  it('says there is no filesystem in a browser tab, and still draws its Storage section', async () => {
    const tab = await start({ fs: null })

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'idle', detail: 'No filesystem in a browser tab' })
    expect(named(tab.events, 'sync.started')).toEqual([{ wired: false }])
    expect(sync.settings?.[0]?.render({ bookId: null })).not.toBeNull()
    expect(tab.services.shelf()).toBeNull()

    tab.handle.dispose()
    expect(named(tab.events, 'sync.teardown-step-failed')).toEqual([])
    expect(sync.settings?.[0]?.render({ bookId: null })).toBeNull()
  })

  it('journals the library it has, and says the peer plugin is unavailable', async () => {
    const run = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')), noPlugin: true })

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'idle', detail: 'Peer plugin unavailable' })
    expect(named(run.events, 'sync.started')).toEqual([{ wired: false }])
    await run.services.library.tag('book:a', 'Sea')
    expect(journalLines(run.fs).map((line) => line['kind'])).toEqual(['commit', 'begin', 'commit'])
    expect(run.fs.store.has(JOURNAL_DIRTY_PATH)).toBe(true)

    run.handle.dispose()
    await journalClosed()
    expect(run.fs.store.has(JOURNAL_DIRTY_PATH)).toBe(false)
    expect(named(run.events, 'sync.teardown-step-failed')).toEqual([])
  })
})

describe('two runtimes, one module', () => {
  /* OWNERSHIP: an older, slower stop must not erase a newer start's live
     runtime — its handlers, its model, its notices. */
  it('lets an older runtime stop without taking the newer one’s handlers or Storage model', async () => {
    const older = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const olderModel = (sync.settings?.[0]?.render({ bookId: null }) as { props: { model: { getSnapshot(): { status: { detail: unknown } } } } }).props.model
    const newer = await start({ fs: crashableFs(book('book:b', 'Beta', 'bytes')) })
    const hello = sync.services?.find((one) => one.name === SYNC_SERVICES.hello.name)

    older.handle.dispose()

    const asked = await Promise.resolve().then(() => hello?.handler({ proto: -1 }, ASKED())).then(() => null, (thrown: unknown) => thrown)
    expect(asked, 'an older runtime stopping took the newer one’s handlers').toMatchObject({ code: 'malformed' })
    const newerModel = (sync.settings?.[0]?.render({ bookId: null }) as { props: { model: { getSnapshot(): { status: { detail: unknown } } } } } | null)?.props.model
    expect(newerModel, 'an older runtime stopping took the newer one’s model').toBeDefined()
    syncStatus.set({ detail: 'after the older one stopped' })
    expect(newerModel?.getSnapshot().status.detail).toBe('after the older one stopped')
    expect(olderModel.getSnapshot().status.detail, 'the older model outlived its runtime').not.toBe('after the older one stopped')

    newer.handle.dispose()
    expect(sync.settings?.[0]?.render({ bookId: null })).toBeNull()
  })
})

/* ---- a satchel ---- */

type Served = ReturnType<Ledger['services']>

/** The far shelf's services with some replaced — a refusal, a count, a pause. */
const replacing = (services: Served, over: Record<string, (request: unknown, context: ServiceContext, real: Served[number]['handler']) => unknown>): Served =>
  services.map((one) => (over[one.name] ? { ...one, handler: async (request: unknown, context: ServiceContext) => over[one.name]!(request, context, one.handler) } : one))

/** Count the hellos a far shelf answers. */
function countingHellos(): { readonly count: () => number; readonly serve: (far: FarEnd) => Served } {
  let count = 0
  return {
    count: () => count,
    serve: (far) =>
      replacing(far.ledger.services(), {
        [SYNC_SERVICES.hello.name]: (request, context, real) => {
          count += 1
          return real(request, context)
        },
      }),
  }
}

const row = (run: Run, bookId: string): IndexedBook => run.services.library.getSnapshot().find((one) => one.bookId === bookId)!
const action = (id: string) => sync.bookActions!.find((one) => one.id === id)!

describe('a satchel', () => {
  it('syncs as it starts: syncing, then ok with what moved and when — and offers Download for a book with no bytes', async () => {
    const hello = gate()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.hello.name]: async (request, context, real) => {
            await hello.promise
            return real(request, context)
          },
        }),
    })

    await until(() => expect(syncStatus.getSnapshot()).toMatchObject({ state: 'syncing', detail: null }))
    vi.setSystemTime(NOW + 2_000)
    hello.open()

    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(syncStatus.getSnapshot()).toEqual({ state: 'ok', detail: null, lastSyncAt: NOW + 2_000, lastSummary: { pushed: 0, pulledRows: 1 } })
    expect(named(run.events, 'sync.session-ok')).toEqual([{ pushed: 0, pulledRows: 1, pulledRemovals: 0, pulledMarks: 0, refused: 0 }])
    expect(named(run.events, 'sync.push-refused')).toEqual([])
    expect(named(run.events, 'sync.marks-quarantined')).toEqual([])
    expect(await run.services.shelf()?.facts()).toMatchObject({ role: 'satchel' })
    expect(action('sync:download').when?.(row(run, 'book:a'))).toBe(true)
    expect(action('sync:evict').when?.(row(run, 'book:a'))).toBe(false)
  })

  it('syncs again when asked — through the service table and through the Devices pane', async () => {
    const hellos = countingHellos()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(hellos.count()).toBe(1)

    expect(await run.services.shelf()?.sync()).toEqual({ started: true, detail: null })
    await until(() => expect(hellos.count()).toBe(2))

    expect(native.syncNow.size).toBe(1)
    for (const feed of native.syncNow) feed()
    await until(() => expect(hellos.count()).toBe(3))

    run.handle.dispose()
    expect(native.syncNow.size, 'the Devices pane kept a feed into a stopped runtime').toBe(0)
  })

  /* THE CLOCK UNDER THE EVENTS: a backstop every five minutes after a success,
     and twenty seconds after a failure. */
  it('comes back in five minutes after a success, not sooner, and stops coming back once stopped', async () => {
    const hellos = countingHellos()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await elapse(30_000, 1_000)
    expect(hellos.count(), 'a success was retried as though it had failed').toBe(1)
    await elapse(5 * 60_000, 30_000)
    await until(() => expect(hellos.count()).toBe(2))

    run.handle.dispose()
    await elapse(10 * 60_000, 60_000)
    expect(hellos.count(), 'a stopped satchel kept syncing').toBe(2)
  })

  it('says the shelf is unreachable by its name, and tries again in twenty seconds', async () => {
    const hellos = countingHellos()
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    far.wire.setOnline(false)

    expect(await run.services.shelf()?.sync()).toEqual({ started: true, detail: null })
    await until(() => expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: 'Paper on Study Mac isn’t reachable' }))
    expect(named(run.events, 'sync.session-failed')).toEqual([{ kind: 'unreachable', message: 'peer unreachable' }])

    far.wire.setOnline(true)
    await elapse(20_000, 1_000)
    await until(() => expect(hellos.count()).toBe(2))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
  })

  it('says it is not paired when there is no shelf to dial', async () => {
    const run = await start({ role: 'satchel', wire: fakeWire({ role: 'satchel', endpointId: 'satchel-under-test' }) })

    await until(() => expect(named(run.events, 'sync.session-failed')).toEqual([{ kind: 'unpaired', message: 'not paired with a shelf' }]))
    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: 'This device isn’t paired with a library yet' })
  })

  it('dials the shelf it is paired with, not the first device it knows', async () => {
    await satchelWith(book('book:a', 'Alpha', 'bytes'), { knows: true })

    await until(() => expect(syncStatus.getSnapshot()).toMatchObject({ state: 'ok', detail: null }))
  })

  /* A SESSION THAT FINISHED with a book refused is `ok` — the rest moved —
     with the book named, and the raw refusal in the diagnostics. */
  it('names the book a finished session could not push, by its title and the shelf’s name', async () => {
    const { run } = await satchelWith(
      {},
      {
        knows: true,
        near: { ...book('book:first', 'First', 'first bytes'), ...book('book:mine', 'Mine', 'my bytes') },
        serve: (far) =>
          replacing(far.ledger.services(), {
            [SYNC_SERVICES.push.name]: (request, context, real) => {
              if ((request as { book?: string }).book === 'book:mine') throw { code: 'conflict', retryable: false, message: 'the file differs' }
              return real(request, context)
            },
          }),
      },
    )

    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(syncStatus.getSnapshot().detail).toBe('“Mine” has a different file on Study Mac')
    expect(named(run.events, 'sync.push-refused')).toEqual([{ book: 'book:mine', kind: 'conflict', message: 'the file differs' }])
    expect(named(run.events, 'sync.session-ok')).toEqual([expect.objectContaining({ pushed: 1, refused: 1 })])
  })
})

describe('what a satchel says about a session', () => {
  /** A satchel that held `book:q`'s marks aside from an earlier session with the far shelf. */
  const holding = (): KernelServices => {
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    services.settings.set(SYNC_QUARANTINE_SETTING, { peerId: 'shelf-far', books: ['book:q'], dropped: 0 })
    return services
  }
  const marksAnswer = (answer: unknown) => (far: FarEnd) =>
    replacing(far.ledger.services(), { [SYNC_SERVICES.marks.name]: () => answer })

  it('names the highlights it still could not read, and warns what the quarantine holds', async () => {
    const services = holding()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: marksAnswer({ book: 'book:q', marks: 'not a list' }),
      start: { services, fs: services.fs as CrashableFs },
    })

    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(syncStatus.getSnapshot().detail).toBe('Highlights for 1 book couldn’t be read from Study Mac')
    expect(named(run.events, 'sync.marks-quarantined')).toEqual([{ held: 1, dropped: 0, repaired: 0 }])
  })

  it('warns a repair too, and says nothing is wrong once the held highlights read', async () => {
    const services = holding()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: marksAnswer({ book: 'book:q', marks: [] }),
      start: { services, fs: services.fs as CrashableFs },
    })

    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(syncStatus.getSnapshot().detail).toBeNull()
    expect(named(run.events, 'sync.marks-quarantined')).toEqual([{ held: 0, dropped: 0, repaired: 1 }])
  })

  /* OWNED BY THE RUNTIME THAT STARTED IT: a session still in flight through a
     teardown says what happened to the diagnostics, and nothing to the status
     line of a runtime that is gone. */
  it('records a session that finished after its satchel stopped, and paints nothing over the status', async () => {
    const hello = gate()
    const { run } = await satchelWith(
      {},
      {
        near: book('book:mine', 'Mine', 'my bytes'),
        serve: (far) =>
          replacing(far.ledger.services(), {
            [SYNC_SERVICES.hello.name]: async (request, context, real) => {
              await hello.promise
              return real(request, context)
            },
            [SYNC_SERVICES.push.name]: () => {
              throw { code: 'conflict', retryable: false, message: 'the file differs' }
            },
          }),
      },
    )
    await until(() => expect(syncStatus.getSnapshot().state).toBe('syncing'))

    run.handle.dispose()
    hello.open()

    await until(() => expect(named(run.events, 'sync.session-ok')).toHaveLength(1))
    await settled(100)
    expect(syncStatus.getSnapshot().state).toBe('syncing')
    expect(named(run.events, 'sync.push-refused')).toEqual([])
  })

  it('paints nothing when its satchel stops while the shelf’s name is being asked for', async () => {
    const naming = gate()
    let asked = 0
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      wire: (wire) =>
        overriding(wire, {
          listPeers: async () => {
            asked += 1
            if (asked > 1) await naming.promise
            return wire.listPeers()
          },
        }),
    })
    await until(() => expect(named(run.events, 'sync.session-ok')).toHaveLength(1))
    await settled()

    run.handle.dispose()
    naming.open()
    await settled(100)

    expect(syncStatus.getSnapshot().state).toBe('syncing')
  })

  it('records a session that failed after its satchel stopped, degrades nothing, and asks the plugin nothing', async () => {
    const hello = gate()
    let asked = 0
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      wire: (wire) =>
        overriding(wire, {
          listPeers: () => {
            asked += 1
            return wire.listPeers()
          },
        }),
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.hello.name]: async () => {
            await hello.promise
            throw { code: 'not-ready', retryable: true, message: 'still building' }
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('syncing'))

    run.handle.dispose()
    const before = asked
    hello.open()

    await until(() => expect(named(run.events, 'sync.session-failed')).toEqual([{ kind: 'not-ready', message: 'sync.hello: not-ready: still building' }]))
    await settled(100)
    expect(syncStatus.getSnapshot().state).toBe('syncing')
    expect(asked, 'a session whose runtime is gone asked the plugin for the shelf’s name').toBe(before)
  })

  /* `run` is contracted not to throw; reaching the scheduler's catch is a
     defect in `run`, and it is said rather than retried in silence. */
  it('says so when the session runner itself throws', async () => {
    const { diagnostics, events } = recorder()
    const breaking: Diagnostics = {
      ...diagnostics,
      warn: (event, fields) => {
        diagnostics.warn(event, fields)
        if (event === 'sync.session-failed') throw new Error('the log is full')
      },
    }
    await start({ role: 'satchel', wire: fakeWire({ role: 'satchel', endpointId: 'satchel-under-test' }), diagnostics: { diagnostics: breaking, events } })

    await until(() => expect(named(events, 'sync.run-threw')).toEqual([{ message: 'the log is full' }]))
  })

  it('syncs five seconds after a local edit', async () => {
    const hellos = countingHellos()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await run.services.library.tag('book:a', 'Sea')
    await elapse(4_000, 1_000)
    expect(hellos.count()).toBe(1)
    await elapse(2_000, 500)

    await until(() => expect(hellos.count()).toBe(2))
  })

  it('says so when a channel will not close, and still reports the session', async () => {
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      wire: (wire) => overriding(wire, { close: () => Promise.reject(new Error('the session would not close')) }),
    })

    await until(() => expect(named(run.events, 'sync.channel-close-failed')).toEqual([{ message: 'the session would not close' }]))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
  })
})

/** A page, for the satchel's visibility trigger — only as much of `document` as the scheduler uses. */
function page(state: 'visible' | 'hidden') {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: state,
    refuseRemoval: false,
    listeners,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (doc.refuseRemoval) throw new Error('the page would not let go')
      if (type === 'visibilitychange') listeners.delete(listener)
    },
    show: (next: 'visible' | 'hidden') => {
      doc.visibilityState = next
      for (const listener of [...listeners]) listener()
    },
  }
  vi.stubGlobal('document', doc)
  return doc
}

describe('a satchel in a page', () => {
  it('syncs when the page is shown, not when it is hidden, and stops listening once stopped', async () => {
    const doc = page('visible')
    const hellos = countingHellos()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    expect(doc.listeners.size).toBe(1)

    doc.show('hidden')
    await settled(100)
    expect(hellos.count()).toBe(1)
    doc.show('visible')
    await until(() => expect(hellos.count()).toBe(2))

    run.handle.dispose()
    expect(doc.listeners.size, 'a stopped satchel kept listening to the page').toBe(0)
  })

  it('reports a scheduler that will not stop, by name', async () => {
    const doc = page('visible')
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    doc.refuseRemoval = true

    run.handle.dispose()

    expect(named(run.events, 'sync.teardown-step-failed')).toEqual([{ label: 'scheduler', message: 'the page would not let go' }])
  })
})

/* ---- Download and Evict ---- */

describe('downloading a book to a satchel, and evicting it', () => {
  const downloadingSaid = (): { readonly said: unknown[]; readonly off: () => void } => {
    const said: unknown[] = []
    const off = downloading!.subscribe(() => said.push(downloading!.of({ bookId: 'book:a' } as IndexedBook)))
    return { said, off: () => void off() }
  }
  const JACKET = 'a jacket'

  /** A satchel that has synced the far shelf's `book:a` — its row, not its bytes. */
  async function synced(options: Parameters<typeof satchelWith>[1] = {}, seed: Record<string, string> = {}) {
    const made = await satchelWith({ ...book('book:a', 'Alpha', 'bytes'), 'books/book_a/cover.jpg': JACKET, ...seed }, options)
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    return made
  }

  it('shows the download on the book’s row as it goes, records its size, brings its jacket, and clears the row', async () => {
    const { run } = await synced()
    const told = downloadingSaid()
    try {
      await action('sync:download').run('book:a')

      expect(told.said).toContainEqual({ label: 'Downloading…' })
      expect(told.said).toContainEqual({ label: 'Downloading 0%', fraction: 0 })
      expect(told.said).toContainEqual({ label: 'Downloading 100%', fraction: 1 })
      expect(told.said.at(-1)).toBeNull()
    } finally {
      told.off()
    }
    expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes')
    expect(JSON.parse(text(run.fs.store.get('sync/downloads.json')) ?? 'null')).toEqual({ 'book:a': 5 })
    expect(text(run.fs.store.get('books/book_a/cover.jpg'))).toBe(JACKET)
    expect(JSON.parse(text(run.fs.store.get('sync/covers.json')) ?? 'null')).toMatchObject({ 'book:a': { name: 'cover.jpg', size: JACKET.length } })
    expect(action('sync:download').when?.(row(run, 'book:a'))).toBe(false)
    expect(action('sync:evict').when?.(row(run, 'book:a'))).toBe(true)
    expect(syncStatus.getSnapshot().state).toBe('ok')
  })

  it('evicts this device’s bytes and their size, and offers Download again', async () => {
    const { run } = await synced()
    await action('sync:download').run('book:a')

    await action('sync:evict').run('book:a')

    expect(run.fs.store.has('books/book_a/content.epub')).toBe(false)
    expect(JSON.parse(text(run.fs.store.get('sync/downloads.json')) ?? 'null')).toEqual({})
    expect(action('sync:download').when?.(row(run, 'book:a'))).toBe(true)
  })

  it('evicts from the Storage section too', async () => {
    const { run } = await synced()
    await action('sync:download').run('book:a')
    const model = (sync.settings?.[0]?.render({ bookId: null }) as { props: { model: { removeDownload(book: string): Promise<void> } } }).props.model

    await model.removeDownload('book:a')

    expect(run.fs.store.has('books/book_a/content.epub')).toBe(false)
  })

  /* IN FLIGHT, BY BOOK: a second press joins the first rather than starting a
     duplicate transfer the plugin would refuse. */
  it('joins a second press to the download already running, and starts afresh once it has finished', async () => {
    let fetches = 0
    const { run } = await synced({
      wire: (wire) =>
        overriding(wire, {
          blobFetch: (request: { name: string }) => {
            if (request.name === 'content.epub') fetches += 1
            return wire.blobFetch(request as never)
          },
        }),
    })

    await Promise.all([action('sync:download').run('book:a'), action('sync:download').run('book:a')])
    expect(fetches).toBe(1)

    await action('sync:evict').run('book:a')
    await action('sync:download').run('book:a')
    expect(fetches).toBe(2)
    expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes')
  })

  it('says which book could not be read, by its title, and clears the row', async () => {
    const { run } = await synced(
      {
        serve: (far) =>
          replacing(far.ledger.services(), {
            [SYNC_SERVICES.content.name]: (request, context, real) => {
              if ((request as { book?: string }).book === 'book:a') throw { code: 'unreadable', retryable: true, message: 'the record will not read' }
              return real(request, context)
            },
          }),
      },
      book('book:0', 'Zero', 'zero bytes'),
    )
    expect(run.services.library.getSnapshot()[0]?.bookId, 'the refused book must not be the first row').not.toBe('book:a')

    await action('sync:download').run('book:a')

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: '“Alpha” couldn’t be read on one of the devices' })
    expect(downloading?.of({ bookId: 'book:a' } as IndexedBook)).toBeNull()
  })

  it('says the shelf is unreachable by name — and without one when the name cannot be asked', async () => {
    const { far, run } = await synced()
    far.wire.setOnline(false)

    await action('sync:download').run('book:a')
    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: 'Paper on Study Mac isn’t reachable' })
    run.handle.dispose()
    await journalClosed()

    let asked = 0
    const again = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      wire: (wire) =>
        overriding(wire, {
          listPeers: () => {
            asked += 1
            return asked > 3 ? Promise.reject(new Error('the plugin is gone')) : wire.listPeers()
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    again.far.wire.setOnline(false)
    /* The next ask finds the shelf; the one after, for its name, fails. */
    asked = 2

    await action('sync:download').run('book:a')
    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: 'Your library isn’t reachable' })
  })

  /**
   * ⚠️ **A DOWNLOAD WHOSE TRANSFER FAILED SAID "Sync failed" AND NAMED
   * NOTHING.** The kind was known where `peer/lib/port.ts` rejected the
   * transfer — `blobHashMismatch`, `blobRefused` — and spent on the message,
   * so `refusalKind`, which reads the `kind` FIELD, answered `unknown`. Both
   * sentences below were written for exactly these failures and nothing on
   * any device could reach them. Found by audit, 2026-09-14.
   */
  it('says which book’s file could not be verified, rather than that sync failed', async () => {
    const { run } = await synced({
      serve: (far) =>
        replacing(far.ledger.services(), {
          /* The shelf's answer promises a hash its bytes do not have — a
             record gone stale under the file, which is what a mismatch IS. */
          [SYNC_SERVICES.content.name]: async (request, context, real) => {
            const answer = (await real(request, context)) as Record<string, unknown>
            return { ...answer, contentHash: '0'.repeat(64) }
          },
        }),
    })

    await action('sync:download').run('book:a')

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: '“Alpha”’s file couldn’t be verified' })
    expect(run.fs.store.has('books/book_a/content.epub'), 'bytes that did not verify were kept').toBe(false)
  })

  it('says the library no longer allows this device when its bytes are refused', async () => {
    const { far } = await synced()
    /* The blob grant goes without the session: the shelf's router answers
       `sync.content` from the cache it refreshed when the session opened,
       and the refusal lands on the transfer, where the reader meets it. */
    far.wire.setGrants('satchel-under-test', ['sync:*'])

    await action('sync:download').run('book:a')

    expect(syncStatus.getSnapshot()).toMatchObject({
      state: 'degraded',
      detail: 'Study Mac no longer allows this device — pair it again',
    })
  })

  it('still counts the download done, and says why Storage cannot evict it, when its size will not save', async () => {
    const { run } = await synced()
    refuseWritesUnder(run.fs, 'sync/downloads')

    await action('sync:download').run('book:a')

    expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes')
    expect(named(run.events, 'sync.download-size-unrecorded')).toEqual([{ book: 'book:a', message: 'the disk refused sync/downloads' }])
  })

  it('says evicting failed rather than showing the bytes gone', async () => {
    let refusing = false
    const { run } = await synced({
      start: {
        around: (services) => ({
          ...services,
          removeBlob: (bookId, name) => (refusing ? Promise.reject(new Error('the folder is locked')) : services.removeBlob(bookId, name)),
        }),
      },
    })
    await action('sync:download').run('book:a')
    refusing = true

    await action('sync:evict').run('book:a')

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: 'Sync failed' })
    expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes')
  })

  it('does nothing, and says nothing, for a press that lands after the satchel stopped', async () => {
    const { run } = await synced()
    await action('sync:download').run('book:a')
    run.handle.dispose()
    syncStatus.set({ state: 'idle', detail: null })

    await action('sync:evict').run('book:a')
    await action('sync:download').run('book:b')

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'idle', detail: null })
    expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes')
  })

  it('measures a jacket already here through the host’s size port', async () => {
    const services = createKernelServices({ fs: crashableFs({ 'books/book_a/cover.jpg': JACKET }), storage: memoryStorage(), initialBooks: [] })
    services.bindSizePort({ contentBytes: async () => null, libraryBytes: async () => null, bytesAt: async (path) => (path === 'books/book_a/cover.jpg' ? 777 : null) })
    const { run } = await synced({ start: { services, fs: services.fs as CrashableFs } })

    await action('sync:download').run('book:a')

    expect(JSON.parse(text(run.fs.store.get('sync/covers.json')) ?? 'null')).toMatchObject({ 'book:a': { name: 'cover.jpg', size: 777 } })
  })

  it('evicts the oldest jacket through the kernel once the cache is over its cap', async () => {
    const big = 'j'.repeat(600_000)
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    services.settings.set(COVER_CAP_SETTING, 1)
    const { run } = await synced(
      { start: { services, fs: services.fs as CrashableFs } },
      { 'books/book_a/cover.jpg': big, ...book('book:b', 'Beta', 'beta bytes'), 'books/book_b/cover.jpg': big },
    )

    await action('sync:download').run('book:a')
    expect(run.fs.store.has('books/book_a/cover.jpg')).toBe(true)
    await action('sync:download').run('book:b')

    expect(run.fs.store.has('books/book_b/cover.jpg')).toBe(true)
    expect(run.fs.store.has('books/book_a/cover.jpg'), 'the oldest jacket was not evicted').toBe(false)
  })
})


/* ---- provenance: the lanes the journal fences a remote apply on ---- */

const card = (id: string, createdAt = NOW): Record<string, unknown> => ({ id, bookId: 'book:a', kind: 'Excerpt', body: `body ${id}`, answer: '', source: 'One', cfi: null, createdAt })

describe('the provenance of a write racing a remote apply', () => {
  /** The origins of the last `n` begins journalled for a key. */
  const lastBegins = (run: Run, bookId: string, what: string, n: number): unknown[] =>
    journalLines(run.fs)
      .filter((line) => line['kind'] === 'begin' && line['book'] === bookId && line['what'] === what)
      .slice(-n)
      .map((line) => line['origin'])

  /** Park the lane, queue a local write behind it, pull a remote change for the same key, then let the lane go. */
  async function race(run: Run, far: FarEnd, pulls: () => number, lane: string, local: () => Promise<unknown>, remote: () => Promise<unknown>) {
    const parked = gate()
    void run.services.writes.append(lane, () => parked.promise)
    const mine = local()
    await remote()
    const before = pulls()
    expect(await run.services.shelf()?.sync()).toEqual({ started: true, detail: null })
    await until(() => expect(pulls()).toBeGreaterThan(before))
    await settled(100)
    parked.open()
    await mine
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    void far
  }

  const countingPulls = () => {
    let pulls = 0
    return {
      pulls: () => pulls,
      serve: (far: FarEnd) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.pull.name]: async (request, context, real) => {
            const answer = await real(request, context)
            pulls += 1
            return answer
          },
        }),
    }
  }

  /* THE FENCE ORDERS ONLY ON THE LANE THE KERNEL'S WRITER USES. On any other
     key a local edit already queued begins after the expectation is armed,
     consumes it, and is journalled `remote` — dropped from the outbox, never
     pushed. */
  it('keeps a local edit to a book local when a remote change to it lands behind', async () => {
    const counted = countingPulls()
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: counted.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await race(
      run,
      far,
      counted.pulls,
      run.services.library.lane('book:a'),
      () => run.services.library.tag('book:a', 'Mine'),
      () => far.services.library.setFinished('book:a', true),
    )

    expect(lastBegins(run, 'book:a', 'record', 2)).toEqual(['local', 'remote'])
  })

  it('pulls the shelf’s cards, and keeps a local card edit local when a remote one lands behind', async () => {
    const counted = countingPulls()
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: counted.serve })
    await far.services.cards.add(card('card-far', NOW - 10) as never)
    await run.services.shelf()?.sync()
    await until(() => expect(run.services.cards.stored().map((one) => one.id)).toEqual(['card-far']))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await race(
      run,
      far,
      counted.pulls,
      '',
      () => run.services.cards.add(card('card-near') as never),
      () => far.services.cards.add(card('card-far-2', NOW - 5) as never),
    )

    expect(lastBegins(run, '', 'cards', 2)).toEqual(['local', 'remote'])
  })
})

/* ---- the journal without the transport ---- */

describe('openLocalJournal — the journal a process with no peer plugin opens', () => {
  const DEVICE = 'c0ffee00c0ffee00'
  const servicesOver = (fs: CrashableFs = crashableFs(book('book:a', 'Alpha', 'bytes'))): KernelServices => {
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: booksOn(fs) })
    services.settings.set(DEVICE_ID_SETTING, DEVICE)
    return services
  }
  const recorderFree = (services: KernelServices): boolean => {
    try {
      services.bindRecorder({ begin: async (bookId, what) => ({ book: bookId, what }), commit: async () => {} }).dispose()
      return true
    } catch {
      return false
    }
  }
  const clockFree = (services: KernelServices): boolean => {
    try {
      services.bindClock(() => makeHlc(NOW, 0, DEVICE)).dispose()
      return true
    } catch {
      return false
    }
  }
  const refusalOf = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (thrown: unknown) => thrown)

  it('refuses services with no filesystem, rather than journalling nothing', async () => {
    const cause = await refusalOf(openLocalJournal({ services: createKernelServices({ fs: null, storage: null }) }))

    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe('openLocalJournal: these services have no filesystem')
  })

  /* THE SAME DEVICE AND THE SAME FLOOR THE APP USES. */
  it('journals the kernel’s writes under the app’s device, above its floor, flushed at full — and lets everything go on close', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const flushed: unknown[][] = []
    const flush = fs.fsync
    fs.fsync = async (path: string, ...rest: unknown[]) => {
      flushed.push([path, ...rest])
      return flush(path)
    }
    const services = servicesOver(fs)
    services.settings.set(CLOCK_FLOOR_SETTING, makeHlc(NOW + 60_000, 3, DEVICE))
    const local = await openLocalJournal({ services })
    expect(recorderFree(services)).toBe(false)

    await services.library.tag('book:a', 'Sea')

    const tagged = journalLines(fs).filter((line) => line['seq'] !== 1)
    expect(tagged.map((line) => line['kind'])).toEqual(['begin', 'commit'])
    for (const line of tagged) expect(parseHlc(line['at'] as string)).toMatchObject({ ms: NOW + 60_000, device: DEVICE })
    expect(parseHlc(services.settings.get(CLOCK_FLOOR_SETTING))).toMatchObject({ ms: NOW + 60_000, device: DEVICE })
    expect(flushed).toContainEqual([JOURNAL_DIRTY_PATH, 'full'])

    await local.close()

    expect(fs.store.has(JOURNAL_DIRTY_PATH)).toBe(false)
    expect(recorderFree(services), 'the recorder was left bound').toBe(true)
    expect(clockFree(services), 'the clock was left bound').toBe(true)
  })

  it('starts from a fresh clock when no floor is stored, and ignores one that is not a stamp', async () => {
    const fresh = servicesOver()
    const one = await openLocalJournal({ services: fresh })
    expect(parseHlc(fresh.clock()).ms).toBe(NOW)
    await one.close()

    const garbled = servicesOver()
    garbled.settings.set(CLOCK_FLOOR_SETTING, 'not a stamp')
    const two = await openLocalJournal({ services: garbled })
    expect(parseHlc(garbled.clock()).ms).toBe(NOW)
    await two.close()
  })

  it('raises the floor to a stamp the kernel handed out before the journal opened', async () => {
    const services = servicesOver()
    vi.setSystemTime(NOW + 10_000)
    services.clock()
    vi.setSystemTime(NOW)
    const local = await openLocalJournal({ services })

    services.clock()

    expect(parseHlc(services.settings.get(CLOCK_FLOOR_SETTING)).ms).toBe(NOW + 10_000)
    await local.close()
  })

  /* APPENDING IS OURS; RECOVERING IS THE APP'S. */
  it('leaves the recovery owed to the app when the flag was already up', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const first = await openLocalJournal({ services: servicesOver(fs) })
    void first
    expect(fs.store.has(JOURNAL_DIRTY_PATH)).toBe(true)

    const second = await openLocalJournal({ services: servicesOver(fs) })
    await second.close()

    expect(fs.store.has(JOURNAL_DIRTY_PATH), 'a CLI open cleared a flag whose recovery it never ran').toBe(true)
  })

  it('lets the clock go, and fails, when the journal will not open', async () => {
    const fs = crashableFs({ ...book('book:a', 'Alpha', 'bytes'), 'sync/journal.meta.json': JSON.stringify({ epoch: 'e', nextSeq: 1, journalFormat: 99, state: 'ready' }) })
    const services = servicesOver(fs)

    const cause = await refusalOf(openLocalJournal({ services }))

    expect((cause as Error).message).toBe('journal: unknown journalFormat 99')
    expect(clockFree(services)).toBe(true)
  })

  it('closes the journal, lets the clock go, and fails, when the recorder is already bound', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const services = servicesOver(fs)
    const taken = services.bindRecorder({ begin: async (bookId, what) => ({ book: bookId, what }), commit: async () => {} })

    const cause = await refusalOf(openLocalJournal({ services }))

    expect((cause as Error).message).toBe('bindRecorder: the recorder port is already bound')
    expect(fs.store.has(JOURNAL_DIRTY_PATH), 'the journal it opened was left open').toBe(false)
    expect(clockFree(services)).toBe(true)
    taken.dispose()
  })

  it('lets the clock go even when the journal will not close, and says why', async () => {
    const fs = crashableFs(book('book:a', 'Alpha', 'bytes'))
    const services = servicesOver(fs)
    const local = await openLocalJournal({ services })
    const remove = fs.remove
    fs.remove = async (path) => {
      if (path === JOURNAL_DIRTY_PATH) throw new Error('the flag would not go')
      return remove(path)
    }

    const cause = await refusalOf(local.close())

    expect((cause as Error).message).toBe('the flag would not go')
    expect(clockFree(services)).toBe(true)
    expect(recorderFree(services)).toBe(true)
  })
})

/* ---- the corners: what a journal from elsewhere holds, two satchels at once, the walks nobody sees ---- */

describe('what shelf.verify makes of a journal written by an older build', () => {
  /** A shelf's files after a clean close, with `extra` lines appended to its journal. */
  async function journalWith(extra: (lines: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<CrashableFs> {
    const first = await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    first.handle.dispose()
    await journalClosed()
    const lines = journalLines(first.fs)
    const fs = crashableFs()
    for (const [path, bytes] of first.fs.store) fs.store.set(path, bytes)
    const all = [...lines, ...extra(lines)]
    fs.store.set(JOURNAL_PATH, new TextEncoder().encode(all.map((line) => JSON.stringify(line)).join('\n') + '\n'))
    const meta = JSON.parse(text(fs.store.get('sync/journal.meta.json')) ?? '{}') as Record<string, unknown>
    fs.store.set('sync/journal.meta.json', new TextEncoder().encode(JSON.stringify({ ...meta, nextSeq: all.length + 1 })))
    fs.store.set(INDEX_FILE, new TextEncoder().encode(indexOf([indexRow('book:a', 'Alpha')])))
    return fs
  }

  /* A COMMIT THAT NAMES NO BEGIN — a baseline, a verify, a line from before
     brackets carried their begin — settles the key whole. */
  it('counts a begin settled by a commit that names no begin as settled', async () => {
    const fs = await journalWith((lines) => {
      const { epoch } = lines[0] as { epoch: string }
      const at = makeHlc(NOW, 0, 'c0ffee00c0ffee00')
      return [
        { seq: lines.length + 1, kind: 'begin', epoch, book: 'book:a', what: 'record', at, origin: 'local' },
        { seq: lines.length + 2, kind: 'commit', epoch, book: 'book:a', what: 'record', at, rev: 2, origin: 'local' },
      ]
    })
    const shelf = await start({ fs })

    expect((await shelf.services.shelf()!.verify()).findings).toEqual([])
  })

  /* AND A COMMIT WHOSE BEGIN IS GONE — compaction keeps the last commit of a
     key and drops the begin it settled. */
  it('reads a commit whose begin compaction dropped without failing the pass', async () => {
    const fs = await journalWith((lines) => {
      const { epoch } = lines[0] as { epoch: string }
      return [{ seq: lines.length + 2, kind: 'commit', epoch, book: 'book:a', what: 'record', at: makeHlc(NOW, 0, 'c0ffee00c0ffee00'), rev: 2, begin: lines.length + 1, origin: 'local' }]
    })
    const shelf = await start({ fs })

    expect(await shelf.services.shelf()!.verify()).toMatchObject({ ok: true, findings: [] })
  })
})

describe('the walks a shelf takes on every change', () => {
  /* WHY THE PRUNE LOOKS AT THE MAP FIRST: every library change runs it, and an
     import is thousands of changes. With no notice standing there is nothing
     to walk the shelf for. */
  it('does not walk the shelf on a change while no notice stands, and does while one does', async () => {
    let walks = 0
    let counting = false
    const shelf = await start({
      fs: crashableFs(book('book:a', 'Alpha', 'bytes')),
      around: (services) => ({
        ...services,
        library: new Proxy(services.library, {
          get: (target, key) =>
            key === 'getSnapshot'
              ? () => {
                  const rows = target.getSnapshot()
                  return new Proxy(rows, {
                    get: (held, inner) => {
                      if (inner === Symbol.iterator && counting) walks += 1
                      return Reflect.get(held, inner)
                    },
                  })
                }
              : Reflect.get(target, key),
        }),
      }),
    })
    await settled()

    counting = true
    await shelf.services.library.tag('book:a', 'Sea')
    counting = false
    expect(walks, 'the shelf was walked with no notice to forget').toBe(0)

    await pushTo(shelf, book('book:new', 'Fresh', 'fresh bytes'))
    expect(noticeOf('book:new')).not.toBeNull()
    counting = true
    await shelf.services.library.tag('book:a', 'Land')
    counting = false
    expect(walks).toBeGreaterThan(0)
  })
})

describe('two satchels, one module', () => {
  /** A second satchel, on its own wire, paired with the same far shelf. */
  async function second(far: FarEnd): Promise<Run> {
    const wire = fakeWire({ role: 'satchel', endpointId: 'second-satchel' })
    pair(wire, far)
    return start({ role: 'satchel', wire, fs: crashableFs() })
  }

  /** A far shelf that counts, by device, the hellos it answers — and parks the first one from `parked`. */
  function perDevice(parked: string | null, hold: Promise<void>) {
    const hellos = new Map<string, number>()
    return {
      of: (peer: string) => hellos.get(peer) ?? 0,
      total: () => [...hellos.values()].reduce((sum, one) => sum + one, 0),
      serve: (far: FarEnd) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.hello.name]: async (request, context, real) => {
            const seen = (hellos.get(context.peer) ?? 0) + 1
            hellos.set(context.peer, seen)
            if (context.peer === parked && seen === 1) await hold
            return real(request, context)
          },
        }),
    }
  }

  /* A SESSION WHOSE RUNTIME WAS REPLACED still WORKED, and says so to its own
     scheduler — which then comes back in five minutes, not twenty seconds. */
  it('counts a session that finished after a newer satchel took over as a success, for its own clock', async () => {
    const hold = gate()
    const hellos = perDevice('satchel-under-test', hold.promise)
    const { far } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(hellos.of('satchel-under-test')).toBe(1))
    await second(far)
    await until(() => expect(hellos.of('second-satchel')).toBe(1))

    hold.open()
    await settled(100)
    await elapse(30_000, 1_000)

    expect(hellos.total(), 'a replaced session was retried as though it had failed').toBe(2)
  })

  /* OWNERSHIP AGAIN, one slot along: the runtime a session reaches for is the
     one that is up, and an older satchel stopping must not take it. */
  it('leaves the newer satchel running when an older one stops', async () => {
    const hellos = perDevice(null, Promise.resolve())
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { serve: hellos.serve })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const newer = await second(far)
    await until(() => expect(hellos.of('second-satchel')).toBe(1))

    run.handle.dispose()

    expect(await newer.services.shelf()?.sync()).toEqual({ started: true, detail: null })
    await until(() => expect(hellos.of('second-satchel')).toBe(2))
    expect(named(newer.events, 'sync.session-failed'), 'the newer satchel lost the runtime it was using').toEqual([])
  })

  /* AND IT ASKS THE NEW RUNTIME'S PLUGIN NOTHING. A session that failed for a
     runtime that has been replaced has no sentence to write and no name to
     look up — reaching for one would be IPC on somebody else's transport. */
  it('asks the newer satchel’s plugin nothing when an older one’s session fails', async () => {
    const hello = gate()
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: (shelf) =>
        replacing(shelf.ledger.services(), {
          [SYNC_SERVICES.hello.name]: async (request, context, real) => {
            if (context.peer !== 'satchel-under-test') return real(request, context)
            await hello.promise
            throw { code: 'not-ready', retryable: true, message: 'still building' }
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('syncing'))
    let asked = 0
    const wire = fakeWire({ role: 'satchel', endpointId: 'second-satchel' })
    pair(wire, far)
    await start({
      role: 'satchel',
      fs: crashableFs(),
      wire: overriding(wire, {
        listPeers: () => {
          asked += 1
          return wire.listPeers()
        },
      }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const before = asked

    hello.open()
    await until(() => expect(named(run.events, 'sync.session-failed')).toHaveLength(1))
    await settled(100)

    expect(asked, 'a session whose runtime was replaced asked the newer one’s plugin for a name').toBe(before)
    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'ok', detail: null })
  })

  it('counts it a success too when the newer satchel took over while the shelf’s name was being asked for', async () => {
    const hellos = perDevice(null, Promise.resolve())
    const naming = gate()
    let asked = 0
    const { far, run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: hellos.serve,
      wire: (wire) =>
        overriding(wire, {
          listPeers: async () => {
            asked += 1
            if (asked === 2) await naming.promise
            return wire.listPeers()
          },
        }),
    })
    await until(() => expect(named(run.events, 'sync.session-ok')).toHaveLength(1))
    await second(far)
    await until(() => expect(hellos.of('second-satchel')).toBe(1))

    naming.open()
    await settled(100)
    await elapse(30_000, 1_000)

    expect(hellos.total(), 'a replaced session was retried as though it had failed').toBe(2)
  })
})

describe('the rest of taking a runtime down', () => {
  it('reports a Devices pane that will not let go of its feed, by name', async () => {
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    native.refuseUnregister = true

    run.handle.dispose()

    expect(named(run.events, 'sync.teardown-step-failed')).toEqual([{ label: 'syncNow', message: 'the Devices pane would not let go' }])
  })

  it('offers neither Download nor Evict once the satchel has stopped', async () => {
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const bare = row(run, 'book:a')
    expect(action('sync:download').when?.(bare)).toBe(true)

    run.handle.dispose()

    expect(action('sync:download').when?.(bare)).toBe(false)
    expect(action('sync:evict').when?.({ ...bare, hasContent: true })).toBe(false)
  })

  it('leaves a running shelf’s model alone when a start beside it fails before it acquired anything', async () => {
    await start({ fs: crashableFs(book('book:a', 'Alpha', 'bytes')) })
    const cleanups: (() => void)[] = []
    const services = createKernelServices({ fs: crashableFs(), storage: memoryStorage(), initialBooks: [] })
    const { diagnostics, events } = recorder()
    const settings = { ...scopeSettings(services.settings, 'sync'), get: refusing('the settings will not read') }

    await Promise.resolve(sync.start!({ services, settings, diagnostics, onCleanup: (fn) => void cleanups.push(fn) }, new AbortController().signal)).then(
      () => null,
      () => null,
    )
    for (const cleanup of cleanups) cleanup()

    expect(named(events, 'sync.teardown-step-failed')).toEqual([])
    expect(sync.settings?.[0]?.render({ bookId: null })).not.toBeNull()
  })
})

/* ---- the seams the cover cache is given, and the runtimes a press belongs to ---- */

const captured = vi.hoisted(() => ({ lookup: null as null | ((book: string) => Promise<unknown>) }))
vi.mock('./lib/coverCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/coverCache')>()
  return {
    ...actual,
    createCoverCache: (options: Parameters<typeof actual.createCoverCache>[0]) => {
      captured.lookup = (book: string) => options.lookup(book)
      return actual.createCoverCache(options)
    },
  }
})

describe('what the capability tells the cover cache', () => {
  const JACKET = 'a jacket'
  /** A hash port over a filesystem, as the peer plugin's is over the data root. */
  const hashesOver = (fs: CrashableFs) => ({
    hashFile: async (folder: string, name: string) => {
      const bytes = fs.store.get(`books/${folder}/${name}`)
      if (bytes === undefined) throw new Error(`no ${folder}/${name}`)
      return { blake3: await fakeBlobHash(bytes), size: bytes.byteLength }
    },
  })
  const recordOf = (run: Run, bookId = 'book:a'): Record<string, unknown> =>
    JSON.parse(text(run.fs.store.get(`books/${bookId.replace(/[^a-zA-Z0-9]/g, '_')}/book.json`)) ?? '{}') as Record<string, unknown>

  /* WHAT A LOOKUP ANSWERS is this file's own sentence to the cache: where the
     book is, and the jacket's three facts — or none. */
  it('answers where a book is and what its jacket weighs, nothing for a shelf with no jacket, and nothing at all for an answer that is not one', async () => {
    const { far } = await satchelWith(
      { ...book('book:a', 'Alpha', 'bytes'), 'books/book_a/cover.jpg': JACKET, ...book('book:b', 'Beta', 'beta bytes') },
      {
        serve: (shelf) =>
          replacing(shelf.ledger.services(), {
            [SYNC_SERVICES.content.name]: (request, context, real) =>
              (request as { book?: string }).book === 'book:garbled' ? { folder: 42 } : real(request, context),
          }),
      },
    )
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    expect(await captured.lookup?.('book:a')).toEqual({
      peerId: 'shelf-far',
      folder: 'book_a',
      cover: { name: 'cover.jpg', size: JACKET.length, hash: await fakeBlobHash(new TextEncoder().encode(JACKET)) },
    })
    expect(await captured.lookup?.('book:b')).toEqual({ peerId: 'shelf-far', folder: 'book_b', cover: null })

    /* An answer that is not a content answer is nothing found — said, not thrown. */
    expect(await captured.lookup?.('book:garbled'), 'a shelf that answered nonsense answered something').toBeNull()

    far.wire.serveBlob = () => null
    expect(await captured.lookup?.('book:nowhere'), 'a shelf that has no such book answered something').toBeNull()
  })

  /* A STAMP OWED is paid from a fresh measurement of the file that is there. */
  it('pays a jacket’s stamp onto the record, through the host’s hasher', async () => {
    const fs = crashableFs({
      'books/book_a/cover.jpg': JACKET,
      'sync/covers.json': JSON.stringify({ 'book:a': { name: 'cover.jpg', size: JACKET.length, usedAt: NOW - 1, owed: true } }),
    })
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: [] })
    services.bindHashPort(hashesOver(fs))
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { start: { services, fs } })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await action('sync:download').run('book:a')

    expect(recordOf(run)['coverFacts']).toEqual({ name: 'cover.jpg', size: JACKET.length, hash: await fakeBlobHash(new TextEncoder().encode(JACKET)) })
  })

  /* TWO JACKETS IN ONE FOLDER — the legacy name the cache was tracking and the
     one this build writes — and the new one cannot be measured. The old one's
     facts are still backed by the file that is there, so they stand. */
  it('keeps the facts of the jacket that is here and hashes to them, when the one beside it cannot be measured', async () => {
    const fs = crashableFs({ 'books/book_a/cover.jpg': 'the new one', 'books/book_a/cover.webp': JACKET })
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: [] })
    const hashes = hashesOver(fs)
    services.bindHashPort({
      hashFile: async (folder, name) => {
        if (name === 'cover.jpg') throw new Error('that one will not read')
        return hashes.hashFile(folder, name)
      },
    })
    services.bindSizePort({ contentBytes: async () => null, libraryBytes: async () => null, bytesAt: async (path) => fs.store.get(path)?.byteLength ?? null })
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { start: { services, fs } })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const facts = { name: 'cover.webp' as const, size: JACKET.length, hash: await fakeBlobHash(new TextEncoder().encode(JACKET)) }
    await run.services.library.update('book:a', (held) => ({ ...held, coverFacts: facts }))
    await fs.writeFile('sync/covers.json', new TextEncoder().encode(JSON.stringify({ 'book:a': { name: 'cover.webp', size: JACKET.length, usedAt: NOW - 1 } })))

    await action('sync:download').run('book:a')

    expect(recordOf(run)['coverFacts'], 'facts backed by the file that is here were taken away').toEqual(facts)
  })

  /* AND A JACKET THAT IS NOT THERE takes its facts back off the record. */
  it('takes a jacket’s facts off the record when the file is gone', async () => {
    const fs = crashableFs()
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: [] })
    services.bindHashPort(hashesOver(fs))
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { start: { services, fs } })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    await run.services.library.update('book:a', (held) => ({ ...held, coverFacts: { name: 'cover.jpg' as const, size: 8, hash: 'ab'.repeat(32) } }))
    await fs.writeFile('sync/covers.json', new TextEncoder().encode(JSON.stringify({ 'book:a': { name: 'cover.jpg', size: 8, usedAt: NOW - 1 } })))
    expect(recordOf(run)['coverFacts']).not.toBeUndefined()

    await action('sync:download').run('book:a')

    expect(recordOf(run)['coverFacts'], 'facts for a jacket that is not here stayed on the record').toBeUndefined()
    expect(JSON.parse(text(run.fs.store.get('sync/covers.json')) ?? 'null')).toEqual({})
  })
})

describe('whose sentence a failure is', () => {
  /* THE PRESS OWNS IT. A download that fails after its own runtime has been
     replaced must not paint over the runtime that replaced it. */
  it('paints nothing over a newer satchel when an older one’s download fails', async () => {
    const refuse = gate()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.content.name]: async (request, context, real) => {
            if ((request as { book?: string }).book !== 'book:a') return real(request, context)
            await refuse.promise
            throw { code: 'unreadable', retryable: true, message: 'the record will not read' }
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const pressed = action('sync:download').run('book:a')

    run.handle.dispose()
    await journalClosed()
    const newer = await satchelWith(book('book:b', 'Beta', 'beta bytes'), { wire: (wire) => overriding(wire, {}) })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    refuse.open()
    await pressed
    await settled(100)

    expect(syncStatus.getSnapshot(), 'an older runtime’s download painted over the newer one').toMatchObject({ state: 'ok', detail: null })
    void newer
  })

  it('paints nothing when the satchel stops while the shelf’s name is being asked for a failed download', async () => {
    const naming = gate()
    let asked = 0
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.content.name]: () => {
            throw { code: 'unreadable', retryable: true, message: 'the record will not read' }
          },
        }),
      wire: (wire) =>
        overriding(wire, {
          listPeers: async () => {
            asked += 1
            if (asked > 2) await naming.promise
            return wire.listPeers()
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    syncStatus.set({ state: 'idle', detail: null })

    const pressed = action('sync:download').run('book:a')
    await settled()
    run.handle.dispose()
    naming.open()
    await pressed
    await settled(100)

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'idle', detail: null })
  })

  it('names a book the library no longer holds by its id', async () => {
    await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.content.name]: () => {
            throw { code: 'unreadable', retryable: true, message: 'the record will not read' }
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))

    await action('sync:download').run('book:ghost')

    expect(syncStatus.getSnapshot()).toMatchObject({ state: 'degraded', detail: '“book:ghost” couldn’t be read on one of the devices' })
  })

  it('refuses a session by name when the runtime it belonged to is gone', async () => {
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'))
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const shelf = await start({ fs: crashableFs(book('book:b', 'Beta', 'bytes')) })
    shelf.handle.dispose()

    await run.services.shelf()?.sync()
    await until(() => expect(named(run.events, 'sync.session-failed')).toHaveLength(1))

    expect(named(run.events, 'sync.session-failed')).toEqual([{ kind: 'unknown', message: 'sync has not started' }])
  })

  it('reports a channel that will not close after the satchel stopped to nobody, and still counts the session', async () => {
    const hello = gate()
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), {
      wire: (wire) => overriding(wire, { close: () => Promise.reject(new Error('the session would not close')) }),
      serve: (far) =>
        replacing(far.ledger.services(), {
          [SYNC_SERVICES.hello.name]: async (request, context, real) => {
            await hello.promise
            return real(request, context)
          },
        }),
    })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('syncing'))

    run.handle.dispose()
    hello.open()
    await until(() => expect(named(run.events, 'sync.session-ok')).toHaveLength(1))
    await settled(100)

    expect(named(run.events, 'sync.channel-close-failed')).toEqual([])
    expect(named(run.events, 'sync.session-failed')).toEqual([])
  })

  it('still tracks the jacket already here, and says nothing to nobody, when a download’s size lands after the satchel stopped', async () => {
    const writing = gate()
    const fs = crashableFs({ 'books/book_a/cover.jpg': 'a jacket' })
    const services = createKernelServices({ fs, storage: memoryStorage(), initialBooks: [] })
    services.bindSizePort({ contentBytes: async () => null, libraryBytes: async () => null, bytesAt: async (path) => fs.store.get(path)?.byteLength ?? null })
    const { run } = await satchelWith(book('book:a', 'Alpha', 'bytes'), { start: { services, fs } })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    const write = run.fs.writeFile
    run.fs.writeFile = async (path, bytes) => {
      if (path.startsWith('sync/downloads')) {
        await writing.promise
        throw new Error('the disk refused it late')
      }
      return write(path, bytes)
    }

    const pressed = action('sync:download').run('book:a')
    await until(() => expect(text(run.fs.store.get('books/book_a/content.epub'))).toBe('bytes'))
    run.handle.dispose()
    writing.open()
    await pressed
    await settled(100)

    expect(named(run.events, 'sync.download-size-unrecorded')).toEqual([])
    expect(JSON.parse(text(run.fs.store.get('sync/covers.json')) ?? 'null'), 'the jacket here was not tracked').toMatchObject({ 'book:a': { name: 'cover.jpg', size: 8 } })
  })
})

describe('an ack is not a commit', () => {
  /* A COMMIT CLEARS ITS OWN BRACKET; an acknowledgement clears nothing — it
     says a peer has a revision, not that a write finished. */
  it('leaves a bracket a failed write left open standing after the revision is acked', async () => {
    const { run } = await satchelWith({}, { near: book('book:a', 'Alpha', 'bytes') })
    await until(() => expect(syncStatus.getSnapshot().state).toBe('ok'))
    await run.fs.writeFile(INDEX_FILE, new TextEncoder().encode(indexOf(await scanRows(run))))
    const write = run.fs.writeFile
    let refusing = true
    run.fs.writeFile = async (path, bytes) => {
      if (refusing && path.startsWith('books/book_a/book.json')) throw new Error('the disk is full')
      return write(path, bytes)
    }

    await run.services.library.tag('book:a', 'Sea').catch(() => null)
    refusing = false
    await run.services.library.tag('book:a', 'Land')
    await run.services.shelf()?.sync()
    await until(() => expect(named(run.events, 'sync.session-ok')).toHaveLength(2))
    await run.fs.writeFile(INDEX_FILE, new TextEncoder().encode(indexOf(await scanRows(run))))

    expect(journalLines(run.fs).some((line) => line['kind'] === 'acked')).toBe(true)
    expect((await run.services.shelf()!.verify()).findings).toEqual(['1 journal bracket has a begin with no commit'])
  })
})
