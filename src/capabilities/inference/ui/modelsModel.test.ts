import { describe, expect, it, vi } from 'vitest'
import { createKernelServices, scopeSettings } from '../../../kernel'
import type { Controller, InferenceSnapshot, RuntimeState } from '../lib/controller'
import type { ModelRow, ResourceUsage } from '../lib/plugin'
import type { AudioSink } from './voiceTest'
import { KEEP_LOADED_SETTING } from '../lib/settings'
import {
  createModelsModel,
  downloadLine,
  formatBytes,
  isActiveInstall,
  modelAction,
  modelValue,
  runtimeValue,
  type ModelsModelOptions,
} from './modelsModel'

/** A promise the test opens when it wants the operation under test to finish. */
function deferred(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open: () => open() }
}

const MODELS = [
  { id: 'qwen', label: 'Qwen3-4B', bytes: 2_497_281_120, installed: false },
  { id: 'kokoro', label: 'Kokoro', bytes: 353_746_785, installed: false },
]

describe('formatBytes', () => {
  /* Decimal, not binary, and the reason is the reader rather than the
   * arithmetic: this is compared against a download they were quoted in the
   * same units, and 2.5 GB shown as 2.3 GiB reads as a different file. */
  it('reads in the units the reader was quoted', () => {
    expect(formatBytes(2_497_281_120)).toBe('2.5 GB')
    expect(formatBytes(353_746_785)).toBe('354 MB')
    expect(formatBytes(4_096)).toBe('4 KB')
    expect(formatBytes(512)).toBe('512 B')
  })

  /**
   * EVERY THRESHOLD, FROM BOTH SIDES.
   *
   * ⚠️ The three-figure rows are the ones that mattered. The unit used to be
   * chosen from the RAW byte count and the rounding applied afterwards, so
   * anything from 999 500 bytes up printed `1000 KB` — four digits in a unit
   * that only has three — and 999 500 000 printed `1000 MB`. Neither is a
   * number the reader can compare against a download quoted in the next unit
   * up, and no test above this line goes anywhere near either boundary.
   */
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1_000, '1 KB'],
    [1_499, '1 KB'],
    [1_500, '2 KB'],
    [999_499, '999 KB'],
    [999_500, '1 MB'],
    [1_000_000, '1 MB'],
    [999_499_999, '999 MB'],
    [999_500_000, '1.0 GB'],
    [1_000_000_000, '1.0 GB'],
    [1_050_000_000, '1.1 GB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  /* `—`, NEVER `0`. Lemonade is specifically credited for returning null
   * rather than zero for memory it cannot read, and a `0` beside "Memory" is
   * a claim that nothing is resident — a different statement from "unknown". */
  it('says `—` for an unknown figure, which a genuine zero is not', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
  })
})

describe('runtimeValue', () => {
  it('says what each state is, in the reader’s words', () => {
    expect(runtimeValue({ kind: 'absent', reason: 'x' })).toBe('Not installed')
    expect(runtimeValue({ kind: 'installed' })).toBe('Ready to start')
    expect(runtimeValue({ kind: 'starting' })).toBe('Starting…')
    expect(runtimeValue({ kind: 'verifying', model: 'qwen' })).toBe('Verifying…')
    expect(runtimeValue({ kind: 'ready', version: '11.7.0' })).toBe('Running · 11.7.0')
  })

  /* F3: the vocabulary has no progress bar, so a download reports as a fact in
   * the same right-hand `value` slot every other fact goes in. */
  it('reports a download as two counts and no bar', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 412_000_000, total: 2_497_281_120 }
    expect(runtimeValue(state)).toBe('Downloading · 412 MB of 2.5 GB')
  })

  it('does not quote a total it does not have yet', () => {
    expect(runtimeValue({ kind: 'installing', model: 'qwen', received: 0, total: 0 })).toBe('Downloading…')
  })

  /* `degraded` says what went wrong rather than showing a code — and it is
   * NOT `absent`: one means download it, the other means restart it. */
  it('says what went wrong when degraded', () => {
    expect(runtimeValue({ kind: 'degraded', detail: 'The runtime stopped' })).toBe('The runtime stopped')
  })

  it('says `Running` for a daemon that would not name its version', () => {
    expect(runtimeValue({ kind: 'ready', version: '' })).toBe('Running')
  })
})

/* ONE PREDICATE BEHIND BOTH FORMATTERS. It was written out twice, so a row
   could have drifted into showing `Downloading…` beside an `[Install]`. */
describe('isActiveInstall', () => {
  it('is true only for this model’s own download or verification', () => {
    const downloading: RuntimeState = { kind: 'installing', model: 'qwen', received: 0, total: 1 }
    expect(isActiveInstall(downloading, 'qwen')).toBe(true)
    expect(isActiveInstall(downloading, 'kokoro')).toBe(false)
    expect(isActiveInstall({ kind: 'verifying', model: 'qwen' }, 'qwen')).toBe(true)
    expect(isActiveInstall({ kind: 'verifying', model: 'qwen' }, 'kokoro')).toBe(false)
    expect(isActiveInstall({ kind: 'installed' }, 'qwen')).toBe(false)
    expect(isActiveInstall({ kind: 'ready', version: '1' }, 'qwen')).toBe(false)
  })
})

describe('modelValue', () => {
  it('quotes the download cost before the reader commits to it', () => {
    expect(modelValue(MODELS[0]!, { kind: 'installed' })).toBe('2.5 GB')
  })

  it('says installed, with what it cost', () => {
    expect(modelValue({ ...MODELS[0]!, installed: true }, { kind: 'installed' })).toBe('Installed · 2.5 GB')
  })

  /* The progress belongs to the row being downloaded and to no other. */
  it('shows progress on the row that is downloading', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 1_000_000, total: 2_000_000 }
    expect(modelValue(MODELS[0]!, state)).toBe('Downloading · 1 MB of 2 MB')
    expect(modelValue(MODELS[1]!, state)).toBe('354 MB')
  })
})

describe('modelAction', () => {
  /* One button whose label is the action available now, rather than three
   * controls two of which are always disabled. */
  it('offers Install, then Remove, then Cancel', () => {
    expect(modelAction({ id: 'qwen', installed: false }, { kind: 'installed' })).toBe('install')
    expect(modelAction({ id: 'qwen', installed: true }, { kind: 'installed' })).toBe('remove')
    expect(
      modelAction({ id: 'qwen', installed: false }, { kind: 'installing', model: 'qwen', received: 0, total: 1 }),
    ).toBe('cancel')
  })

  it('offers Cancel while verifying, too — it has not finished', () => {
    expect(modelAction({ id: 'qwen', installed: false }, { kind: 'verifying', model: 'qwen' })).toBe('cancel')
  })

  it('does not offer Cancel on a row that is not the one downloading', () => {
    expect(
      modelAction({ id: 'kokoro', installed: false }, { kind: 'installing', model: 'qwen', received: 0, total: 1 }),
    ).toBe('install')
  })
})

describe('downloadLine', () => {
  /* ── WI-15.12's NEGATIVE HALF, WHICH IS THE LOAD-BEARING HALF ─────────
   * "with no download running the status bar is byte-for-byte what it is
   * today". Nothing is added at rest — and in particular there is no
   * standing "AI is ready", because readiness is not work. That claim is
   * exercised by `ready` inside the list below; it does not need a second
   * test of its own restating it. */
  it('is null at rest, in every state that is not a download', () => {
    const atRest: RuntimeState[] = [
      { kind: 'absent', reason: 'x' },
      { kind: 'installed' },
      { kind: 'starting' },
      { kind: 'ready', version: '11.7.0' },
      { kind: 'degraded', detail: 'The runtime stopped' },
    ]
    for (const state of atRest) expect(downloadLine(state, MODELS), state.kind).toBeNull()
  })

  it('names the model and both counts while downloading', () => {
    const state: RuntimeState = { kind: 'installing', model: 'qwen', received: 412_000_000, total: 2_497_281_120 }
    expect(downloadLine(state, MODELS)).toBe('Downloading Qwen3-4B — 412 MB of 2.5 GB')
  })

  it('says it is verifying, so a count that stopped moving does not read as a stall', () => {
    expect(downloadLine({ kind: 'verifying', model: 'kokoro' }, MODELS)).toBe('Verifying Kokoro')
  })

  it('falls back to the id when the catalogue has not loaded yet', () => {
    const state: RuntimeState = { kind: 'installing', model: 'unknown-id', received: 0, total: 0 }
    expect(downloadLine(state, [])).toBe('Downloading unknown-id')
  })
})

/**
 * THE STORE, which is where the pane's every button actually lands.
 *
 * The formatters above are pure and were already covered; none of them can
 * catch the three ways a `useSyncExternalStore` source goes wrong — an
 * unstable snapshot reference, a dead unsubscribe, or a notification after
 * dispose — nor the one behaviour this store adds on top: `refresh` asks the
 * plugin for two things that are allowed to fail, and neither may take the
 * refresh down with it.
 */
describe('the models store', () => {
  const model = (over: Partial<ModelRow> & Pick<ModelRow, 'id'>): ModelRow => ({
    label: over.id,
    modality: 'text',
    license: 'Apache-2.0',
    bytes: 1000,
    installed: false,
    ...over,
  })

  /** A snapshot, built separately from the controller that publishes it. */
  const snapshotOf = (over: Partial<InferenceSnapshot> = {}): InferenceSnapshot => ({
    runtime: { kind: 'ready', version: '1.0' },
    models: [],
    installing: null,
    failure: null,
    ...over,
  })

  /**
   * A typed controller double with explicit spies.
   *
   * SPLIT FROM SNAPSHOT CONSTRUCTION, and no cast anywhere. The single
   * multi-purpose fake this replaces had drifted from the real contract in
   * three separate places at once: it put a `port` field on a `RuntimeState`
   * that has none and hid it behind an `as RuntimeState`, its `textModel`
   * answered `'a-model'` instead of the installed row's id, and its
   * `install`/`uninstall` resolved `undefined` against a `Promise<boolean>`.
   * Every one of those is a contract the store is entitled to rely on.
   */
  function fakeController(snapshot: Partial<InferenceSnapshot> = {}) {
    const listeners = new Set<() => void>()
    let unsubscribes = 0
    const state = snapshotOf(snapshot)
    const spies = {
      refresh: vi.fn(async () => {}),
      install: vi.fn(async (_model: string) => true),
      cancelInstall: vi.fn(() => {}),
      uninstall: vi.fn(async (_model: string) => true),
      ensureReady: vi.fn(async () => true),
      dispose: vi.fn(() => {}),
    }
    const controller: Controller = {
      ...spies,
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          unsubscribes += 1
          listeners.delete(listener)
        }
      },
      /* The documented contract: the installed text row's OWN id. */
      textModel: () => state.models.find((row) => row.modality === 'text' && row.installed)?.id ?? null,
    }
    return {
      controller,
      ...spies,
      notify: () => {
        for (const listener of [...listeners]) listener()
      },
      subscribers: () => listeners.size,
      unsubscribes: () => unsubscribes,
    }
  }

  const USAGE: ResourceUsage = { residentBytes: 42, modelLoaded: 'qwen' }

  /* Playback that goes nowhere. `voiceTest.test.ts` drives the sink itself;
     here it only has to exist, because `Audio` does not on `node`. */
  const silentAudio = (): AudioSink => ({ play: () => ({ stop: () => {} }) })

  /** Only the three commands the store actually calls, each a real spy. */
  function fakePlugin(
    over: Partial<{
      revealModelsDir: () => Promise<string>
      resourceUsage: () => Promise<ResourceUsage>
      speak: (requestId: string, model: string, text: string, voice: string | null) => Promise<number[]>
      cancel: (requestId: string) => Promise<void>
    }> = {},
  ) {
    return {
      revealModelsDir: vi.fn(over.revealModelsDir ?? (async () => '/models')),
      resourceUsage: vi.fn(over.resourceUsage ?? (async (): Promise<ResourceUsage> => USAGE)),
      speak: vi.fn(over.speak ?? (async () => [1])),
      cancel: vi.fn(over.cancel ?? (async () => {})),
    } as unknown as ModelsModelOptions['plugin'] & {
      revealModelsDir: ReturnType<typeof vi.fn>
      resourceUsage: ReturnType<typeof vi.fn>
    }
  }

  /**
   * THE REAL GUARD, and this is the whole reason these tests exist in this
   * shape.
   *
   * `scopeSettings` confines a capability to its own `<id>.` namespace at
   * every door. Handing the store in raw — which is what an earlier version
   * of this suite did — makes every assertion here pass over a pane that
   * throws `namespace` on its first render in the running app, which is
   * exactly what happened once already.
   */
  function wiring() {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    return { settings: scopeSettings(services.settings, 'inference') }
  }

  it('folds the settings and the plugin readings into the controller snapshot', async () => {
    const { controller } = fakeController({ models: [model({ id: 'a', installed: true })] })
    const { settings } = wiring()
    /* SEEDED AWAY FROM THE DEFAULT, so a store that hardcoded the field could
       not pass by coincidence. */
    settings.set(KEEP_LOADED_SETTING, true)

    const models = createModelsModel({ controller, plugin: fakePlugin(), settings })
    await models.refresh()
    const snap = models.getSnapshot()
    expect(snap.models).toHaveLength(1)
    expect(snap.modelsDir).toBe('/models')
    expect(snap.residentBytes).toBe(42)
    expect(snap.keepLoaded).toBe(true)
    expect(snap.voiceTest).toBe('idle')
    models.dispose()
  })

  /* BOTH PLUGIN READINGS ARE BEST-EFFORT. The models folder is a convenience
     and the memory figure is honestly unknown when the daemon is down, so a
     rejection from either must leave the refresh — and the model list —
     standing. */
  it('survives a plugin that refuses both readings, and says so in the log', async () => {
    const events: string[] = []
    const world = fakeController({ models: [model({ id: 'a' })] })
    const plugin = fakePlugin({
      revealModelsDir: async () => {
        throw new Error('no window server')
      },
      resourceUsage: async () => {
        throw new Error('daemon is down')
      },
    })
    const models = createModelsModel({
      controller: world.controller,
      plugin,
      ...wiring(),
      report: (event) => void events.push(event),
    })
    await expect(models.refresh()).resolves.toBeUndefined()

    /* THE CONTROLLER WAS STILL ASKED. Preloading the list and checking only
       that it survived would pass a store that never refreshed at all. */
    expect(world.refresh).toHaveBeenCalledTimes(1)
    expect(models.getSnapshot().modelsDir).toBeNull()
    expect(models.getSnapshot().residentBytes).toBeNull()
    expect(models.getSnapshot().models).toHaveLength(1)
    /* ⚠️ AND NEITHER FAILURE IS SILENT. A bare `.catch(() => null)` made a
       permission problem, a dropped IPC connection and a command that was
       never registered indistinguishable from a daemon that is simply off. */
    expect(events.sort()).toEqual(['inference.models-dir-failed', 'inference.resource-usage-failed'])
    models.dispose()
  })

  /**
   * TWO REFRESHES, NEWEST WINS.
   *
   * Three IPC calls per refresh and the pane calls it on every open, so two
   * can be out at once. Unsequenced, the older one's memory figure lands last
   * — and its FAILED directory read replaces a path the newer one had
   * successfully resolved with `null`.
   */
  it('keeps the newest refresh when an older one resolves after it', async () => {
    const world = fakeController()
    let asked = 0
    const gates = [deferred(), deferred()]
    const plugin = fakePlugin({
      resourceUsage: async () => {
        const mine = asked++
        await gates[mine]!.promise
        return { residentBytes: mine === 0 ? 111 : 222, modelLoaded: null }
      },
    })
    const models = createModelsModel({ controller: world.controller, plugin, ...wiring() })

    const older = models.refresh()
    const newer = models.refresh()
    gates[1]!.open()
    await newer
    expect(models.getSnapshot().residentBytes).toBe(222)

    gates[0]!.open()
    await older
    expect(models.getSnapshot().residentBytes, 'a superseded refresh overwrote the current reading').toBe(222)
    models.dispose()
  })

  it('keeps one snapshot object until something changes', async () => {
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    await models.refresh()
    const before = models.getSnapshot()
    expect(models.getSnapshot()).toBe(before)
    models.setKeepLoaded(true)
    const after = models.getSnapshot()
    expect(after).not.toBe(before)
    expect(models.getSnapshot()).toBe(after)
    models.dispose()
  })

  it('notifies subscribers, and stops on unsubscribe', () => {
    const { controller, notify } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    let seen = 0
    const stop = models.subscribe(() => void (seen += 1))
    notify()
    expect(seen).toBe(1)
    stop()
    notify()
    expect(seen).toBe(1)
    models.dispose()
  })

  /**
   * DISPOSE DETACHES FROM UPSTREAM, NOT JUST FROM ITS OWN LISTENERS.
   *
   * Counting notifications cannot see this: `dispose` clears the model's own
   * listener set, so a controller subscription left attached still fires — it
   * just fires into an empty set, and the count stays at zero either way. The
   * unsubscribe has to be observed at the source.
   */
  it('detaches from the controller and the settings on dispose', () => {
    const world = fakeController()
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    let settingsSubscribers = 0
    const scoped = scopeSettings(services.settings, 'inference')
    const settings = {
      ...scoped,
      subscribe: (listener: () => void) => {
        settingsSubscribers += 1
        const off = scoped.subscribe(listener)
        return () => {
          settingsSubscribers -= 1
          off()
        }
      },
    }
    const models = createModelsModel({ controller: world.controller, plugin: fakePlugin(), settings })
    expect(world.subscribers()).toBe(1)
    expect(settingsSubscribers).toBe(1)

    models.dispose()
    expect(world.unsubscribes(), 'the controller subscription outlived the model').toBe(1)
    expect(world.subscribers()).toBe(0)
    expect(settingsSubscribers, 'the settings subscription outlived the model').toBe(0)
  })

  it('does not notify after dispose', () => {
    const { controller, notify } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    let seen = 0
    models.subscribe(() => void (seen += 1))
    models.dispose()
    notify()
    expect(seen).toBe(0)
  })

  it('passes install, cancel and uninstall straight through to the controller', async () => {
    const world = fakeController()
    const models = createModelsModel({ controller: world.controller, plugin: fakePlugin(), ...wiring() })
    await expect(models.install('a')).resolves.toBe(true)
    models.cancelInstall()
    await expect(models.uninstall('a')).resolves.toBe(true)
    expect(world.install.mock.calls).toEqual([['a']])
    expect(world.cancelInstall).toHaveBeenCalledTimes(1)
    expect(world.uninstall.mock.calls).toEqual([['a']])
    models.dispose()
  })

  /**
   * REMOVING THE VOICE THAT IS SPEAKING STOPS IT FIRST.
   *
   * `Test voice`'s Stop button lives on the voice's own row, so deleting that
   * model takes the only control that could end the utterance off the screen —
   * and the audio played on with the request still open at the daemon.
   */
  it('stops a voice test before removing the model it is playing through', async () => {
    const world = fakeController({ models: [model({ id: 'kokoro', modality: 'speech', installed: true })] })
    const plugin = fakePlugin()
    const models = createModelsModel({ controller: world.controller, plugin, ...wiring(), audio: silentAudio() })
    await models.testVoice()
    expect(models.getSnapshot().voiceTest).toBe('speaking')

    await models.uninstall('kokoro')
    expect(models.getSnapshot().voiceTest, 'the voice kept playing after its model was deleted').toBe('idle')
    expect(plugin.cancel).toHaveBeenCalledTimes(1)
    models.dispose()
  })

  it('leaves a voice test alone when a different model is removed', async () => {
    const world = fakeController({
      models: [model({ id: 'kokoro', modality: 'speech', installed: true }), model({ id: 'qwen', installed: true })],
    })
    const models = createModelsModel({
      controller: world.controller,
      plugin: fakePlugin(),
      ...wiring(),
      audio: silentAudio(),
    })
    await models.testVoice()
    await models.uninstall('qwen')
    expect(models.getSnapshot().voiceTest).toBe('speaking')
    models.dispose()
  })

  it('writes keepLoaded through its OWN namespace, which the guard allows', () => {
    const { settings } = wiring()
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), settings })
    models.setKeepLoaded(true)
    expect(settings.get(KEEP_LOADED_SETTING)).toBe(true)
    models.dispose()
  })

  /* THE REGRESSION, NAMED. `getSnapshot` is what `useSyncExternalStore` calls
     on mount, and it reads settings through the scoped handle. Reading
     anything outside `inference.` there throws `namespace` — under the real
     guard, this is what says so. */
  it('builds a snapshot without touching another capability’s namespace', () => {
    const { settings } = wiring()
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), settings })
    expect(() => models.getSnapshot()).not.toThrow()
    models.dispose()
  })

  /* STOPPING WHEN NOTHING IS PLAYING IS A NO-OP, and it has to be: the pane's
     stop control is reachable the moment a test starts, and the audio element
     may not exist yet. */
  it('stops a voice test that never started, without throwing', () => {
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    expect(() => models.stopVoice()).not.toThrow()
    expect(models.getSnapshot().voiceTest).toBe('idle')
    models.dispose()
  })

  /* NO VOICE, NO REQUEST. `Test voice` is absent from the pane until a speech
     model is installed, but the method is reachable and must not synthesise
     against a model that is not there. */
  it('does nothing when no speech model is installed', async () => {
    const world = fakeController({ models: [model({ id: 'qwen', installed: true })] })
    const plugin = fakePlugin()
    const models = createModelsModel({ controller: world.controller, plugin, ...wiring() })
    await models.testVoice()
    expect(models.getSnapshot().voiceTest).toBe('idle')
    expect(world.ensureReady).not.toHaveBeenCalled()
    models.dispose()
  })
})

/**
 * INSTALL IS OFFERED ONLY WHEN IT CAN RUN — WI-20.21.
 *
 * `modelAction` ignored `runtime.kind`, so with the runtime absent every row
 * offered Install, the download succeeded, 2.5 GB landed, and every lookup
 * after it failed with "The runtime is not installed". A model that cannot
 * run is not something to offer; the row says why instead, which is the
 * routes pane's own rule for a route that cannot answer.
 */
describe('a model without a runtime', () => {
  const absent: RuntimeState = { kind: 'absent', reason: 'the inference runtime is not installed' }

  it('is not offered for install', () => {
    expect(modelAction({ id: 'qwen', installed: false }, absent)).toBe('runtime-missing')
  })

  /* A file that is on disk can still be deleted; only the download is
     pointless. */
  it('can still be removed once it is on disk', () => {
    expect(modelAction({ id: 'qwen', installed: true }, absent)).toBe('remove')
  })

  it('says why in the value slot, rather than quoting a download it will not offer', () => {
    expect(modelValue(MODELS[0]!, absent)).toBe('Runtime not installed')
    expect(modelValue({ ...MODELS[0]!, installed: true }, absent)).toBe('Installed · 2.5 GB')
  })
})
