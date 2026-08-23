import { describe, expect, it } from 'vitest'
import { createKernelServices, scopeSettings } from '../../../kernel'
import type { Controller, InferenceSnapshot, RuntimeState } from '../lib/controller'
import type { InferencePlugin, ModelRow } from '../lib/plugin'
import { KEEP_LOADED_SETTING } from '../lib/settings'
import {
  createModelsModel,
  downloadLine,
  formatBytes,
  lookUpValue,
  modelAction,
  modelValue,
  runtimeValue,
} from './modelsModel'

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

  /* `—`, NEVER `0`. Lemonade is specifically credited for returning null
   * rather than zero for memory it cannot read, and a `0` beside "Memory" is
   * a claim that nothing is resident — a different statement from "unknown". */
  it('says `—` for an unknown figure and never zero', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(null)).not.toBe('0 B')
    /* And a genuine zero is still a zero, which is not the same thing. */
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
   * standing "AI is ready", because readiness is not work. */
  it('is null at rest, in every state that is not a download', () => {
    const atRest: RuntimeState[] = [
      { kind: 'absent', reason: 'x' },
      { kind: 'installed' },
      { kind: 'starting' },
      { kind: 'ready', version: '11.7.0' },
      { kind: 'degraded', detail: 'The runtime stopped' },
    ]
    for (const state of atRest) expect(downloadLine(state, MODELS)).toBeNull()
  })

  it('never says the companion is ready', () => {
    const line = downloadLine({ kind: 'ready', version: '11.7.0' }, MODELS)
    expect(line).toBeNull()
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

describe('lookUpValue', () => {
  it('is null where there is no control to draw', () => {
    expect(lookUpValue('system', false, false)).toBeNull()
  })

  it('names the mode in the reader’s words', () => {
    expect(lookUpValue('system', true, false)).toBe('System dictionary')
    expect(lookUpValue('gloss', false, true)).toBe('Gloss')
    expect(lookUpValue('both', true, true)).toBe('Both')
  })

  it('shows what is actually in use when the stored choice is unavailable', () => {
    expect(lookUpValue('both', true, false)).toBe('System dictionary')
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

  function fakeController(snapshot: Partial<InferenceSnapshot> = {}): {
    controller: Controller
    calls: string[]
    notify: () => void
  } {
    const calls: string[] = []
    const listeners = new Set<() => void>()
    const state: InferenceSnapshot = {
      runtime: { kind: 'ready', version: '1.0', port: 1234 } as RuntimeState,
      models: [],
      installing: null,
      ...snapshot,
    }
    return {
      calls,
      notify: () => {
        for (const l of [...listeners]) l()
      },
      controller: {
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
        refresh: async () => void calls.push('refresh'),
        install: async (id) => void calls.push(`install:${id}`),
        cancelInstall: () => void calls.push('cancel'),
        uninstall: async (id) => void calls.push(`uninstall:${id}`),
        ensureReady: async () => true,
        textModel: () => (state.models.some((m) => m.modality === 'text' && m.installed) ? 'a-model' : null),
        dispose: () => void calls.push('dispose'),
      },
    }
  }

  const fakePlugin = (over: Partial<InferencePlugin> = {}): InferencePlugin =>
    ({
      revealModelsDir: async () => '/models',
      resourceUsage: async () => ({ residentBytes: 42 }),
      ...over,
    }) as InferencePlugin

  /**
   * THE REAL GUARD, and this is the whole reason these tests exist in this
   * shape.
   *
   * `scopeSettings` confines a capability to its own `<id>.` namespace at
   * every door. Handing the store in raw — which is what an earlier version
   * of this suite did — makes every assertion here pass over a pane that
   * throws `namespace` on its first render in the running app, which is
   * exactly what happened: `getSnapshot` read `kernel.lookUp` through this
   * handle and `Settings → Local models` was an uncaught error.
   *
   * `kernel` is the real `KernelServices`, so the look-up accessor under test
   * is the one that ships.
   */
  function wiring() {
    const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
    return { settings: scopeSettings(services.settings, 'inference'), kernel: services }
  }

  it('folds the settings and the plugin readings into the controller snapshot', async () => {
    const { controller } = fakeController({ models: [model({ id: 'a', installed: true })] })
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    await models.refresh()
    const snap = models.getSnapshot()
    expect(snap.models).toHaveLength(1)
    expect(snap.modelsDir).toBe('/models')
    expect(snap.residentBytes).toBe(42)
    expect(snap.voiceTest).toBe('idle')
    models.dispose()
  })

  /* BOTH PLUGIN READINGS ARE BEST-EFFORT. The models folder is a convenience
     and the memory figure is honestly unknown when the daemon is down, so a
     rejection from either must leave the refresh — and the model list —
     standing. */
  it('survives a plugin that refuses both readings', async () => {
    const { controller } = fakeController({ models: [model({ id: 'a' })] })
    const plugin = fakePlugin({
      revealModelsDir: async () => {
        throw new Error('no window server')
      },
      resourceUsage: async () => {
        throw new Error('daemon is down')
      },
    })
    const models = createModelsModel({ controller, plugin, ...wiring() })
    await expect(models.refresh()).resolves.toBeUndefined()
    expect(models.getSnapshot().modelsDir).toBeNull()
    expect(models.getSnapshot().residentBytes).toBeNull()
    expect(models.getSnapshot().models).toHaveLength(1)
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

  it('notifies subscribers, and stops on unsubscribe', async () => {
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

  it('does not notify after dispose', async () => {
    const { controller, notify } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    let seen = 0
    models.subscribe(() => void (seen += 1))
    models.dispose()
    notify()
    expect(seen).toBe(0)
  })

  it('passes install, cancel and uninstall straight through to the controller', async () => {
    const { controller, calls } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    await models.install('a')
    models.cancelInstall()
    await models.uninstall('a')
    expect(calls).toEqual(['install:a', 'cancel', 'uninstall:a'])
    models.dispose()
  })

  it('writes keepLoaded through its OWN namespace, which the guard allows', () => {
    const { settings, kernel } = wiring()
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), settings, kernel })
    models.setKeepLoaded(true)
    expect(settings.get(KEEP_LOADED_SETTING)).toBe(true)
    models.dispose()
  })

  /* THE REGRESSION, NAMED. `getSnapshot` is what `useSyncExternalStore` calls
     on mount, and it reads the look-up mode. Reading it through `settings`
     throws `namespace` — under the real guard, this test is what says so. */
  it('reads the look-up mode without touching the kernel namespace', () => {
    const { settings, kernel } = wiring()
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), settings, kernel })
    expect(() => models.getSnapshot()).not.toThrow()
    expect(models.getSnapshot().lookUp).toBe(kernel.lookUp())
    models.dispose()
  })

  /* The cycle is over what this machine can actually do, so a build with no
     dictionary and no local model cannot be cycled into a mode that would do
     nothing when pressed. */
  it('reveals the models folder through the plugin, not a path it built itself', async () => {
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    await expect(models.reveal()).resolves.toBe('/models')
    models.dispose()
  })

  /* STOPPING WHEN NOTHING IS PLAYING IS A NO-OP, and it has to be: the pane's
     stop control is reachable the moment a test starts, and the audio element
     may not exist yet. Releasing a null element or revoking a null URL would
     throw where the reader pressed Stop. */
  it('stops a voice test that never started, without throwing', () => {
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), ...wiring() })
    expect(() => models.stopVoice()).not.toThrow()
    expect(models.getSnapshot().voiceTest).toBe('idle')
    models.dispose()
  })

  it('cycles Look up only when more than one mode is available', () => {
    const { settings, kernel } = wiring()
    const { controller } = fakeController()
    const models = createModelsModel({ controller, plugin: fakePlugin(), settings, kernel })
    const before = kernel.lookUp()
    /* No dictionary and no model: one mode at most, so pressing does nothing
       rather than cycling into a mode that would fail when used. */
    models.cycleLookUp(false)
    expect(kernel.lookUp()).toBe(before)
    models.dispose()

    const withModel = fakeController({ models: [model({ id: 'a', installed: true })] })
    const second = createModelsModel({ controller: withModel.controller, plugin: fakePlugin(), settings, kernel })
    second.cycleLookUp(true)
    expect(kernel.lookUp()).not.toBe(before)
    second.dispose()
  })
  /**
   * ONE VOICE TEST AT A TIME, AND THE GUARD IS ON THE NEAR SIDE OF THE AWAIT.
   *
   * `testVoice` returned early when `voiceTest === 'speaking'`, but set
   * `speaking` only after `ensureReady()` resolved — so two presses of Play both
   * saw `idle`, both waited for the runtime, and both went on to synthesise. Two
   * requests spent, two `Audio` elements, and the first blob URL overwritten
   * before anything revoked it. A guard on the far side of an await guards
   * nothing.
   */
  it('spends one request, however fast the second press is', async () => {
    const spoken: string[] = []
    let releaseReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => void (releaseReady = resolve))

    const { controller } = fakeController({ models: [model({ id: 'v', modality: 'speech', installed: true })] })
    /* The runtime start is what both presses used to wait behind. */
    const slowController = { ...controller, ensureReady: async () => { await ready; return true } }
    const plugin = fakePlugin({
    speak: (async (id: string) => { spoken.push(id); return [] }) as never,
    cancel: (async () => {}) as never,
  })
      const models = createModelsModel({ controller: slowController, plugin, ...wiring() })

      const first = models.testVoice()
      const second = models.testVoice()
      releaseReady()
      await Promise.all([first, second])

      expect(spoken, 'two presses synthesised twice').toHaveLength(1)
      models.dispose()
    })
})
