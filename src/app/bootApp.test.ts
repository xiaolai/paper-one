import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FLUSH_MS,
  DIAGNOSTICS_FILE,
  DIAGNOSTICS_SWITCH,
  hlcOf,
  onBeforeClose,
  onBeforeDrain,
  type Capability,
  type Diagnostics,
  type ServiceContext,
} from '../kernel'
import { fakeTrashFs } from '../kernel/testkit'
import { CARRY_REFUSED_NOTICE } from './boot'
import { bootApp, shelfAtLaunch, shutdownDepsOf, type BootedApp } from './bootApp'
import { SHUTDOWN_DONE_EVENT, SHUTDOWN_EVENT, armShutdown } from './shutdown'

/**
 * THE LAUNCH SEQUENCE'S WIRING — the two connections nothing but the type
 * check held, and since 2026-09-14 the sequence itself.
 *
 * `boot.test.ts` holds the shelf's order and `shutdown.test.ts` the teardown's,
 * each over arguments the test hands in. What neither can see is whether
 * `bootApp.ts` hands them the RIGHT arguments: that ⌘Q's teardown is given
 * `settleBeforeDrain` as `settle`, so a quit waits for an import still copying,
 * and that the notice a launch leaves carries a library that would not carry
 * across. Either could be disconnected — `settle: async () => {}`, or
 * `bootNotice: storeNotice` — and every other suite would stay green.
 *
 * ⚠️ **AND THE MUTATION GATE COULD NOT SEE IT EITHER** (2026-09-14): no test
 * imported this file, so a sweep skipped it and exited 0. The two compositions
 * are exported for this suite, which runs them over the kernel's real
 * registries and a real in-memory library.
 *
 * ⚠️ **THEN THE SWEEP COULD SEE IT, AND `bootApp()` WAS 72 MUTANTS NO TEST
 * REACHED** — the diagnostics switch, the recorder, the spool, the size port,
 * the trash sweep's report, `pagehide`, the opened-files bridge. It runs here
 * now, whole. What is stood in for is the native side and nothing else: the
 * shell's event module, the fs plugin and `invoke` (over an in-memory library),
 * and the build's composition list, which is the one input a launch does not
 * build itself.
 */

type Disk = ReturnType<typeof fakeTrashFs>

const shell = vi.hoisted(() => ({
  heard: new Map<string, (event?: { readonly payload: unknown }) => void>(),
  /** Every registration, live or let go — two subscriptions to one event are two, where `heard` keeps the last. */
  registered: [] as { readonly event: string; live: boolean }[],
  emitted: [] as string[],
  /** What was being listened for at each emit, in step with `emitted`. */
  listeningAtEmit: [] as string[][],
  /** Events whose `listen` the shell refuses. */
  refused: new Set<string>(),
}))

const native = vi.hoisted(() => ({
  disk: null as Disk | null,
  /** Paths the fs plugin refuses, whatever is asked of them. */
  refused: new Set<string>(),
  /** The build's composition — read by `bootApp.ts` at module load, so filled in place. */
  capabilities: [] as Capability[],
}))

/* ⚠️ **A LAZY IMPORT OF THIS MOCK THAT OVERLAPS ANOTHER STILL IN FLIGHT GETS THE
   REAL MODULE** — measured under Vitest 4.1.11, with this factory and with a
   synchronous one, and not cured by importing the module first. The launch
   imports it lazily, and `bootApp()` returns before its own arming's import has
   landed: a subscription or a quit issued straight after it reached the real
   `listen` (`transformCallback is not a function`), and a case expecting the
   shell's refusal passed on that error instead. So a case waits for the
   arming's listener — `armed()` — before it starts another import. The app is
   unaffected: there is one module there, and nothing to overlap with. */
vi.mock('@tauri-apps/api/event', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/event')>()),
  listen: async (event: string, handler: (event?: { readonly payload: unknown }) => void) => {
    if (shell.refused.has(event)) throw new Error(`the shell has no ${event} to listen for`)
    const registration = { event, live: true }
    shell.registered.push(registration)
    shell.heard.set(event, handler)
    return () => {
      registration.live = false
      if (shell.heard.get(event) === handler) shell.heard.delete(event)
    }
  },
  emit: async (event: string) => {
    shell.emitted.push(event)
    shell.listeningAtEmit.push(shell.registered.filter((one) => one.live).map((one) => one.event))
  },
}))

/* The library's atomic write is a command, not a plugin call. */
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: async (command: string, body: unknown, options?: { readonly headers?: Record<string, string> }) => {
    if (native.disk === null) throw new Error('no library in this test')
    if (command === 'write_atomic') return native.disk.writeFile(decodeURIComponent(options?.headers?.path ?? ''), body as Uint8Array)
    if (command === 'fsync_in_data_dir') return null
    throw new Error(`no ${command} in this test`)
  },
}))

/* THE FS PLUGIN, OVER THE KERNEL'S OWN IN-MEMORY LIBRARY. What the fake lacks
   is the data root — the size port walks it as `.` — and `stat`. */
vi.mock('@tauri-apps/plugin-fs', () => {
  const disk = (path: string): Disk => {
    if (native.disk === null) throw new Error('no library in this test')
    if (native.refused.has(path)) throw new Error(`the disk refused ${path}`)
    return native.disk
  }
  return {
    BaseDirectory: { AppData: 'AppData' },
    SeekMode: { Start: 0 },
    exists: async (path: string) => disk(path).exists(path),
    mkdir: async (path: string) => disk(path).mkdir(path),
    readFile: async (path: string) => disk(path).readFile(path),
    readTextFile: async (path: string) => new TextDecoder().decode(await disk(path).readFile(path)),
    writeFile: async (path: string, bytes: Uint8Array, options?: { readonly append?: boolean }) => {
      const before = options?.append ? disk(path).store.get(path) : undefined
      return disk(path).writeFile(path, before ? new Uint8Array([...before, ...bytes]) : bytes)
    },
    remove: async (path: string, options?: { readonly recursive?: boolean }) =>
      options?.recursive ? disk(path).removeDir(path) : disk(path).remove(path),
    rename: async (from: string, to: string) => disk(from).rename(from, to),
    readDir: async (path: string) => {
      if (path !== '.') return disk(path).readDir(path)
      const heads = new Map<string, boolean>()
      for (const key of disk(path).store.keys()) {
        const [head = '', ...rest] = key.split('/')
        heads.set(head, (heads.get(head) ?? false) || rest.length > 0)
      }
      return [...heads].map(([name, isDirectory]) => ({ name, isDirectory }))
    },
    stat: async (path: string) => {
      const bytes = disk(path).store.get(path)
      if (bytes) return { isFile: true, size: bytes.byteLength }
      if (await disk(path).exists(path)) return { isFile: false, size: 0 }
      throw new Error(`no such file: ${path}`)
    },
  }
})

vi.mock('virtual:paper-composition', () => ({ capabilities: native.capabilities }))

/** What the launch has built by the time it arms the handshake, each part recording into `order`. */
function launched(order: string[]) {
  const lifetime = new AbortController()
  lifetime.signal.addEventListener('abort', () => order.push('abort'))
  return {
    services: {
      drain: async () => void order.push('drain'),
      diagnostics: { warn: (event: string) => void order.push(`warn:${event}`) } as unknown as Diagnostics,
    },
    lifetime,
    diagnosticSpool: { flush: async () => void order.push('spool') },
    capabilities: [{ quiesce: async () => void order.push('quiesce:a') }, {}, { quiesce: async () => void order.push('quiesce:b') }],
  }
}

describe('the quit handshake a launch arms', () => {
  /* ⚠️ **⌘Q'S TEARDOWN WAITS FOR AN IMPORT STILL COPYING ONLY BECAUSE IT IS
     HANDED `settleBeforeDrain`** (2026-09-13 audit, #96). `App` registers its
     import's stop with `onBeforeDrain`; this registers the same way and holds
     the stop open, and the teardown the shell's ask runs must not drain until
     it lets go. */
  it('waits for what is registered with onBeforeDrain before it drains, on the teardown the shell’s ask runs', async () => {
    const order: string[] = []
    let letGo: () => void = () => {}
    const copying = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const offClose = onBeforeClose(() => void order.push('held'))
    const offDrain = onBeforeDrain(async () => {
      order.push('stop')
      await copying
      order.push('let go')
    })
    try {
      const parts = launched(order)
      shell.emitted.length = 0
      await armShutdown(shutdownDepsOf(parts))

      shell.heard.get(SHUTDOWN_EVENT)?.()
      await vi.waitFor(() => expect(order).toContain('stop'))
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
      expect(order, 'the quit drained under an import still copying').toEqual(['held', 'spool', 'stop'])

      letGo()
      await vi.waitFor(() => expect(shell.emitted).toEqual([SHUTDOWN_DONE_EVENT]))
      expect(order).toEqual(['held', 'spool', 'stop', 'let go', 'drain', 'abort', 'quiesce:a', 'quiesce:b'])
      expect(parts.lifetime.signal.aborted).toBe(true)
    } finally {
      offClose()
      offDrain()
    }
  })

  it('hands the handshake the lifetime’s signal and the services’ diagnostics, and lets the listener go with the lifetime', async () => {
    const parts = launched([])
    const deps = shutdownDepsOf(parts)

    expect(deps.signal).toBe(parts.lifetime.signal)
    expect(deps.diagnostics).toBe(parts.services.diagnostics)
    await armShutdown(deps)
    expect(shell.heard.has(SHUTDOWN_EVENT)).toBe(true)
    parts.lifetime.abort()
    expect(shell.heard.has(SHUTDOWN_EVENT)).toBe(false)
  })

  /* No spool is a build recording nothing, which is every release without the
     switch — the flush must still run the handover and not trip on the gap. */
  it('flushes the handover when this run writes no diagnostics file', async () => {
    const order: string[] = []
    const off = onBeforeClose(() => void order.push('held'))
    try {
      await shutdownDepsOf({ ...launched(order), diagnosticSpool: null }).flush()
      expect(order).toEqual(['held'])
    } finally {
      off()
    }
  })
})

describe('the shelf a launch reads, and the notice it leaves', () => {
  const storeOf = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null })
  const KEPT = { 'books/book_b/book.json': JSON.stringify({ bookId: 'book_b', title: 'Kept', author: '', addedAt: 50 }), 'books/book_b/content.epub': 'bytes' }

  /* ⚠️ **A LIBRARY THAT WOULD NOT CARRY ACROSS WAS SAID ONLY TO THE CONSOLE**
     (decided 2026-09-14), and `bootNoticeOf` is what says it to the reader — but
     only if the launch passes it the shelf's own `carryRefused`. A marks value
     that will not read is refused by the real `legacySources`, through the real
     order, over a real in-memory library. */
  it('carries a previous library that would not carry across into the notice the app draws, beside what the store said', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const unreadable = storeOf({ 'paper.library.v1': JSON.stringify([{ bookId: 'url_x', title: 'Walden' }]), 'paper.marks.v1': '{}' })

      const said = await shelfAtLaunch({ fs: fakeTrashFs(KEPT), storage: unreadable, storeNotice: 'The store said this.' })
      const alone = await shelfAtLaunch({ fs: fakeTrashFs(KEPT), storage: unreadable, storeNotice: null })

      expect(said.bootNotice, 'the refused carry was dropped from the notice').toBe(`The store said this. ${CARRY_REFUSED_NOTICE}`)
      expect(alone.bootNotice).toBe(CARRY_REFUSED_NOTICE)
      expect(said.initialBooks.map((one) => one.bookId)).toEqual(['book_b'])
      expect(said.shelfUnread).toBe(false)
      expect(errors).toHaveBeenCalledWith('Paper: could not carry the previous library across', expect.any(Error))
    } finally {
      errors.mockRestore()
    }
  })

  it('leaves only what the store said when nothing was refused — nothing stored, no store, or no filesystem — and says what recovery did', async () => {
    const infos = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const crashed = fakeTrashFs({ ...KEPT, 'sync/removed.json': JSON.stringify({ book_b: { state: 'removed', at: hlcOf(100) } }) })

      const nothingStored = await shelfAtLaunch({ fs: crashed, storage: storeOf({}), storeNotice: null })
      const noStore = await shelfAtLaunch({ fs: fakeTrashFs(KEPT), storage: null, storeNotice: 'The store said this.' })
      const noFilesystem = await shelfAtLaunch({ fs: null, storage: storeOf({ 'paper.marks.v1': '{}' }), storeNotice: null })

      expect(nothingStored).toEqual({ initialBooks: [], shelfUnread: false, bootNotice: null })
      expect(infos).toHaveBeenCalledWith('Paper: finished 1 removal a crash had left half done')
      expect(noStore.bootNotice).toBe('The store said this.')
      expect(noStore.initialBooks.map((one) => one.bookId)).toEqual(['book_b'])
      expect(noFilesystem).toEqual({ initialBooks: [], shelfUnread: false, bootNotice: null })
    } finally {
      infos.mockRestore()
    }
  })

  it('reports a shelf that will not load as unread, not as empty', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fs = fakeTrashFs(KEPT)
      const broken = { ...fs, readDir: async () => Promise.reject(new Error('disk')), readFile: async () => Promise.reject(new Error('disk')) }

      const booted = await shelfAtLaunch({ fs: broken, storage: null, storeNotice: null })

      expect(booted).toEqual({ initialBooks: [], shelfUnread: true, bootNotice: null })
      expect(errors).toHaveBeenCalledWith('Paper: could not read the library', expect.any(Error))
    } finally {
      errors.mockRestore()
    }
  })
})

/* ---- the sequence itself ---- */

/** The shell's own spellings — `src-tauri/src/opened.rs`, `OPEN` and `READY`. */
const OPEN_FILES = 'paper://open-files'
const OPEN_FILES_READY = 'paper://open-files-ready'

const LIBRARY = { 'books/book_b/book.json': JSON.stringify({ bookId: 'book_b', title: 'Kept', author: '', addedAt: 50 }), 'books/book_b/content.epub': 'bytes' }

const ASKED = { peer: 'this device', signal: new AbortController().signal, input: (async function* () {})() } as unknown as ServiceContext

const booted: BootedApp[] = []

/** A window: a Tauri webview's when `tauri`, a browser tab's otherwise. */
function page(tauri: boolean): EventTarget {
  const kept = new Map<string, string>()
  const window = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) },
    ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
  })
  vi.stubGlobal('window', window)
  return window
}

/** Launch over `files`, as a Tauri webview unless `tauri` is false, with `capabilities` composed. */
async function launch({
  tauri = true,
  files = LIBRARY,
  capabilities = [],
  boot = bootApp,
}: { tauri?: boolean; files?: Record<string, string>; capabilities?: Capability[]; boot?: () => Promise<BootedApp> } = {}): Promise<BootedApp> {
  native.disk = tauri ? fakeTrashFs(files) : null
  native.capabilities.splice(0, native.capabilities.length, ...capabilities)
  page(tauri)
  const one = await boot()
  booted.push(one)
  return one
}

const textAt = (path: string): string | null => {
  const bytes = native.disk?.store.get(path)
  return bytes ? new TextDecoder().decode(bytes) : null
}

const live = (event: string): number => shell.registered.filter((one) => one.event === event && one.live).length

/**
 * Let every pending import, listen and emit land — the wait a case takes
 * before saying something did NOT happen. Macrotasks, not microtask turns: a
 * lazy import resolves through the runner. Measured, once `armed()` has
 * returned, at ONE turn; the launch's own first one took eight to fifteen. Ten
 * is the margin.
 */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** The launch's own lazy import has landed — see the event mock for why a case waits for it. */
const armed = (): Promise<void> => vi.waitFor(() => expect(shell.heard.has(SHUTDOWN_EVENT)).toBe(true))

beforeEach(() => {
  shell.heard.clear()
  shell.registered.length = 0
  shell.emitted.length = 0
  shell.listeningAtEmit.length = 0
  shell.refused.clear()
  native.refused.clear()
})

afterEach(() => {
  for (const one of booted.splice(0)) one.composition.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the launch sequence, run', () => {
  /* FAKE TIMERS FOR EVERY LAUNCH. The spool debounces on a timer and the
     teardown bounds itself with one, and a real one left over from a launch
     writes into whichever library the next test hands the fs plugin. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  /* THE SERVICES ARE BUILT OVER WHAT THE SHELF FOUND, AND SERVED. `shelf.status`
     is the one answer that reads all four halves at once: the kernel's table
     composed, the handlers over the real services, `shelfRead` from the shelf,
     and the size port this host binds. */
  it('reads the library it finds, and serves the kernel’s table over it with this host’s sizes', async () => {
    const app = await launch()

    expect(app).toMatchObject({ shelfUnread: false, bootNotice: null, bookCount: 1 })
    expect(app.fs).not.toBeNull()
    expect(await app.composition.services.get('shelf.status')?.handler({}, ASKED)).toMatchObject({ books: 1, bytes: expect.any(Number) })
    expect(await app.services.sizes()?.contentBytes('book_b')).toBe('bytes'.length)
  })

  it('has no filesystem and no file outside Tauri, and still records what it is told', async () => {
    const app = await launch({ tauri: false })

    expect(app).toMatchObject({ fs: null, shelfUnread: false, bootNotice: null, bookCount: 0, onDiagnosticsCleared: null })
    app.services.diagnostics.warn('launch.probe', { at: 'outside' })
    expect(app.diagnosticLog?.entries().map((one) => one.event)).toContain('launch.probe')
  })

  /* ⚠️ **THE FILE IS A PROJECTION OF THE WINDOW** — see `diagnosticsLog.ts` —
     written on the spool's debounce, and rewritten when the Developer panel
     clears the window, or a harness reading it over ssh reads entries the app
     has thrown away. */
  it('writes what it records beside the library, and rewrites the file when the window is cleared', async () => {
    const app = await launch()

    app.services.diagnostics.warn('launch.probe', { at: 'inside' })
    expect(app.diagnosticLog?.entries().map((one) => one.event)).toContain('launch.probe')
    await vi.advanceTimersByTimeAsync(DEFAULT_FLUSH_MS)
    await vi.waitFor(() => expect(textAt(DIAGNOSTICS_FILE)).toContain('"event":"launch.probe"'))

    app.diagnosticLog?.clear()
    app.onDiagnosticsCleared?.()
    await vi.advanceTimersByTimeAsync(DEFAULT_FLUSH_MS)
    await vi.waitFor(() => expect(textAt(DIAGNOSTICS_FILE), 'the file kept what the window threw away').toBe(''))
  })

  /* ON IN DEV, AND IN A RELEASE ONLY IF THE SWITCH FILE ASKS — and a switch that
     cannot be read is off, and SAID, because a reader who made the file and got
     nothing otherwise has nothing to go on. */
  it('records nothing in a release build unless the switch file asks, and says why when it cannot look', async () => {
    vi.stubEnv('DEV', false)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await launch({ tauri: false })).diagnosticLog, 'a browser tab recorded with nothing asking').toBeNull()
    expect(await launch()).toMatchObject({ diagnosticLog: null, onDiagnosticsCleared: null })

    const asked = await launch({ files: { ...LIBRARY, [DIAGNOSTICS_SWITCH]: '' } })
    expect(asked.diagnosticLog, 'the switch file was there and nothing recorded').not.toBeNull()
    expect(asked.onDiagnosticsCleared).not.toBeNull()
    expect(errors).not.toHaveBeenCalled()

    native.refused.add(DIAGNOSTICS_SWITCH)
    const unreadable = await launch({ files: { ...LIBRARY, [DIAGNOSTICS_SWITCH]: '' } })
    expect(unreadable.diagnosticLog, 'a switch that could not be read turned diagnostics on').toBeNull()
    expect(errors).toHaveBeenCalledWith(`Paper: could not read ${DIAGNOSTICS_SWITCH}; diagnostics stay off`, expect.any(Error))
  })

  /* THE SWEEP IS NOT AWAITED, SO ITS REJECTION IS CAUGHT AND SAID. The library
     names each purge that fails and carries on, so the sweep rejects only when
     that report itself throws — which is the case this reaches. */
  it('reports a trash sweep that rejects, rather than leaving the rejection unhandled', async () => {
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      if (String(line).startsWith('Paper: could not purge')) throw new Error('the console has gone')
    })
    native.refused.add('trash/book_x')

    const app = await launch({ files: { ...LIBRARY, 'trash/book_x/book.json': '{}', 'trash/book_x/.removed': '1' } })

    await vi.waitFor(() =>
      expect(app.diagnosticLog?.entries().filter((one) => one.event === 'trash.sweep-failed').map((one) => one.fields)).toEqual([
        { message: 'the console has gone' },
      ]),
    )
  })

  /* ⚠️ **ARMED BEFORE COMPOSITION**, because composition is where sync opens the
     journal: the handshake used to be armed below it, and a quit arriving
     during composition reached no handler and left the journal dirty. */
  it('is listening for the shell’s quit while the capabilities are still starting', async () => {
    const listening: boolean[] = []
    const probe: Capability = {
      id: 'probe',
      start: async () => {
        await vi.waitFor(() => expect(shell.heard.has(SHUTDOWN_EVENT)).toBe(true))
        listening.push(true)
        return { dispose: () => {} }
      },
    }

    const app = await launch({ capabilities: [probe] })

    expect(app.composition.failures).toEqual([])
    expect(listening).toEqual([true])
  })

  /* ⚠️ **`pagehide` IS REGISTERED BEFORE COMPOSITION IS AWAITED.** Below the
     await, a reload landing mid-composition found no listener, the half-started
     capabilities were never aborted, and two sets ran over one journal until its
     sequence ran backwards. */
  it('ends the capabilities’ lifetime with the page, even when the page goes while they are starting', async () => {
    const aborted: boolean[] = []
    const probe: Capability = {
      id: 'probe',
      start: (_ctx, signal) => {
        window.dispatchEvent(new Event('pagehide'))
        aborted.push(signal.aborted)
        return { dispose: () => {} }
      },
    }

    await launch({ capabilities: [probe] }).catch(() => null)

    expect(aborted, 'a page that went mid-composition left its capabilities running').toEqual([true])
  })

  /* THE SAME TEARDOWN, REACHED THE WAY ⌘Q REACHES IT — through the launch, not
     through `shutdownDepsOf` alone: the quit is not answered while an import is
     still copying, and every listed capability's tail is waited for. */
  it('answers the shell’s quit only once an import has let go, and after every listed capability’s tail', async () => {
    const order: string[] = []
    let letGo: () => void = () => {}
    const copying = new Promise<void>((resolve) => {
      letGo = resolve
    })
    const offDrain = onBeforeDrain(async () => {
      order.push('stop')
      await copying
      order.push('let go')
    })
    try {
      await launch({ capabilities: [{ id: 'probe', quiesce: async () => void order.push('quiesce') }] })
      await armed()

      shell.heard.get(SHUTDOWN_EVENT)?.()
      await vi.waitFor(() => expect(order).toContain('stop'))
      await settled()
      expect(shell.emitted, 'the quit was answered under an import still copying').toEqual([])

      letGo()
      await vi.waitFor(() => expect(shell.emitted).toEqual([SHUTDOWN_DONE_EVENT]))
      expect(order).toEqual(['stop', 'let go', 'quiesce'])
    } finally {
      offDrain()
    }
  })
})

describe('the books a launch carried', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  /* READY IS SENT ONLY ONCE THE LISTENER IS THERE. The shell holds what the
     Finder handed it until then, and an event emitted before anything listens
     is emitted into nothing. */
  it('tells the shell it is listening only once it is, hands on what arrives, and lets go with the subscription', async () => {
    const app = await launch()
    const carried: (readonly string[])[] = []
    await armed()

    const unsubscribe = app.openRequests.subscribe((paths) => void carried.push(paths))
    await vi.waitFor(() => expect(shell.emitted).toContain(OPEN_FILES_READY))
    expect(shell.listeningAtEmit[shell.emitted.indexOf(OPEN_FILES_READY)]).toContain(OPEN_FILES)

    shell.heard.get(OPEN_FILES)?.({ payload: ['/Books/Walden.epub'] })
    expect(carried).toEqual([['/Books/Walden.epub']])

    unsubscribe()
    expect(live(OPEN_FILES), 'the listener outlived its subscription').toBe(0)
  })

  /* ⚠️ **STRICTMODE MOUNTS, UNMOUNTS AND MOUNTS AGAIN**, and the unmount lands
     before the first `listen` has. That subscription must let its listener go
     when it arrives and send nothing — or the shell hears READY twice and the
     window holds two listeners for one event. The second mount waits for the
     first listener only because overlapping imports defeat the mock (see it);
     what is held is the first subscription's answer to an unmount it could not
     have seen coming. */
  it('sends one READY, and holds one listener, across a mount, an unmount and a mount', async () => {
    const app = await launch()
    const carried: (readonly string[])[] = []
    await armed()

    const first = app.openRequests.subscribe((paths) => void carried.push(paths))
    expect(() => first()).not.toThrow()
    await vi.waitFor(() => expect(shell.registered.map((one) => one.event)).toContain(OPEN_FILES))
    await settled()
    expect(live(OPEN_FILES), 'a subscription let go before its listener landed kept the listener').toBe(0)
    expect(shell.emitted, 'a subscription let go before its listener landed still said it was listening').toEqual([])

    app.openRequests.subscribe((paths) => void carried.push(paths))
    await vi.waitFor(() => expect(shell.emitted).toContain(OPEN_FILES_READY))
    await settled()

    expect(shell.emitted.filter((one) => one === OPEN_FILES_READY)).toHaveLength(1)
    expect(live(OPEN_FILES)).toBe(1)
    shell.heard.get(OPEN_FILES)?.({ payload: ['/Books/Walden.epub'] })
    expect(carried).toEqual([['/Books/Walden.epub']])
  })

  it('says so when it cannot listen, and tells the shell nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    shell.refused.add(OPEN_FILES)
    const app = await launch()
    await armed()

    app.openRequests.subscribe(() => {})

    /* THE SHELL'S REFUSAL, BY ITS OWN WORDS. The real module fails here too,
       differently, and a bare `expect.any(Error)` once passed on that. */
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(
        'Paper: could not listen for the files the launch carried',
        expect.objectContaining({ message: `the shell has no ${OPEN_FILES} to listen for` }),
      ),
    )
    expect(shell.emitted).not.toContain(OPEN_FILES_READY)
  })

  it('has no shell to listen to outside Tauri', async () => {
    const app = await launch({ tauri: false })
    /* The handshake reaches the same module, so a subscription that did import
       it would reach the mock rather than overlap the arming's import. */
    await armed()

    const unsubscribe = app.openRequests.subscribe(() => {})
    await settled()

    expect(shell.registered.map((one) => one.event)).not.toContain(OPEN_FILES)
    expect(shell.emitted).toEqual([])
    expect(() => unsubscribe()).not.toThrow()
  })
})

/**
 * THE LAUNCH'S OWN MEASUREMENTS, WHICH ARE THE ONLY ACCOUNT OF A BLANK WINDOW.
 *
 * `devTiming` is off under Vitest — `MODE` is `test` — so every label and
 * detail below was invisible to every other case here. A label that went empty
 * leaves the terminal saying `took=0ms` about nothing. `MODE` is stubbed and the
 * sequence imported afresh, because the switch is read once, when the module
 * loads. LAST in the file, since it replaces the module registry.
 */
describe('the launch’s own measurements, in a dev build', () => {
  it('names each phase it measures, and what the first frame and the filesystem did after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.stubEnv('MODE', 'development')
    vi.resetModules()
    const fresh = await import('./bootApp')
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
      if (String(line).startsWith('Paper timing: ')) lines.push(String(line))
    })
    /* A clock that does not move, so every duration reads 0 and every instant 5. */
    vi.spyOn(performance, 'now').mockReturnValue(5)
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ responseEnd: 3 }] as unknown as PerformanceEntryList)

    const app = await launch({ boot: fresh.bootApp })

    expect(lines).toEqual(
      expect.arrayContaining([
        'Paper timing: the document at=5ms arrived=3ms modules=2ms',
        'Paper timing: open the store took=0ms at=5ms',
        'Paper timing: carry a legacy library across took=0ms at=5ms',
        'Paper timing: finish pending removals took=0ms at=5ms finished=0',
        'Paper timing: load the shelf took=0ms at=5ms books=1 rescanned=true why=no cache',
        'Paper timing: the store and the shelf at=5ms ms=0',
      ]),
    )
    expect(lines.filter((line) => line.startsWith('Paper timing: filesystem, up to the shelf at=5ms total='))).toHaveLength(1)

    vi.stubGlobal('document', { visibilityState: 'visible' })
    vi.stubGlobal('requestAnimationFrame', (frame: () => void) => {
      frame()
      return 0
    })
    fresh.reportFirstFrame(app)
    expect(lines).toContain('Paper timing: the window drew its first frame at=5ms ms=0 books=1')

    await app.fs?.exists('books')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lines.filter((line) => line.startsWith('Paper timing: since the last line at=5ms added='))).not.toEqual([])
  })
})
