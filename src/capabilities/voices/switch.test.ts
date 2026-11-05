import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeCapabilities, createKernelServices, kernelApi, type Capability, type IndexFs } from '../../kernel'
import { fakeFs } from '../../kernel/testkit'
import { voices } from './index'
import type { VoicesWire } from './lib/wire'

/**
 * Switched off, at the capability's own door: the engine is absent and nothing went
 * wrong. What the reading does with an empty slot is `kernel/ui/reader/voicesOff.test.ts`.
 */

/**
 * The plugin, as far as this file needs one: every command is heard, and `wire`
 * answers it where a test has given one. A real plugin's only way to the packs and
 * clips is a command, because its `setup` resolves a path and touches nothing
 * (`tauri-plugin-voices/src/plugin.rs`), so what crosses this wire is everything
 * that could delete them.
 */
const plugin = vi.hoisted(() => ({
  heard: [] as string[],
  wire: null as VoicesWire | null,
}))

vi.mock('./lib/wire', async (original) => ({
  ...(await original<typeof import('./lib/wire')>()),
  voicesWire: () =>
    new Proxy({} as VoicesWire, {
      get: (_, command: keyof VoicesWire) => (...args: never[]) => {
        plugin.heard.push(command)
        const answer = plugin.wire?.[command] as ((...given: never[]) => unknown) | undefined
        return answer === undefined ? Promise.resolve(undefined) : answer(...args)
      },
    }),
}))

async function launch(caps: readonly Capability[], switchedOff: ReadonlySet<string>, fs: IndexFs | null = null) {
  const services = createKernelServices({ fs, storage: null })
  const composition = await composeCapabilities(caps, kernelApi(services), new AbortController().signal, { switchedOff })
  return { services, composition }
}

describe('the downloadable voices, switched off', () => {
  it('offers a switch in words a reader knows', () => {
    expect(voices.toggle?.title).toBe('Downloadable voices')
    expect(`${voices.toggle?.title} ${voices.toggle?.summary}`).not.toMatch(/plugin|capability/i)
  })

  it('leaves the engine absent and its settings undrawn, and is not a failure', async () => {
    const { services, composition } = await launch([voices], new Set(['voices']))
    expect(services.speechEngines()).toBeNull()
    expect(composition.settings).toEqual([])
    expect(composition.failures).toEqual([])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'voices', state: 'off' })])
    composition.dispose()
  })

  it('comes back whole when it is turned on again', async () => {
    const { services, composition } = await launch([voices], new Set())
    expect(services.speechEngines()).not.toBeNull()
    expect(composition.settings.map((one) => one.id)).toEqual(['voices:voices'])
    expect(composition.standing).toEqual([expect.objectContaining({ id: 'voices', state: 'on' })])
    composition.dispose()
  })
})

describe('what a reader downloaded and rendered, once the voices are off', () => {
  /* The layout is the plugin's own: `paths.rs` for the packs, `clips.rs` for the clips. */
  const PACK_DIR = 'voices/packs/english-kokoro'
  const CLIP_DIR = 'audio/clips'
  const SEED = {
    [`${PACK_DIR}/model.onnx`]: 'the weights',
    [`${PACK_DIR}/voices.bin`]: 'the voices',
    [`${CLIP_DIR}/moby-3.wav`]: 'a section, spoken',
    [`${CLIP_DIR}/moby-3.json`]: '{"book":"moby"}',
    [`${CLIP_DIR}/moby-4.wav`]: 'the next section, spoken',
    [`${CLIP_DIR}/moby-4.json`]: '{"book":"moby"}',
    'audio/state.json': '{"held":["moby-3","moby-4"]}',
  }

  /** The plugin's answers, over `disk`. Absent commands answer nothing, and are still heard. */
  function pluginOver(disk: ReturnType<typeof fakeFs>): Partial<VoicesWire> {
    const under = (dir: string) => [...disk.store.keys()].filter((path) => path.startsWith(`${dir}/`))
    return {
      catalogue: async () => [
        {
          id: 'english-kokoro',
          name: 'English',
          summary: 'Kokoro 82M, read on this device.',
          family: 'kokoro',
          languages: ['en'],
          bytes: 336_822_660,
          minimumMemoryGb: 4,
          voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
          installed: under(PACK_DIR).length > 0,
        },
      ],
      clipUsage: async () => ({
        bytes: under(CLIP_DIR).length,
        budget: 20_000_000_000,
        clips: under(CLIP_DIR).filter((path) => path.endsWith('.wav')).length,
      }),
      remove: async () => {
        for (const path of under(PACK_DIR)) disk.store.delete(path)
      },
      clipForget: async () => {
        for (const path of under(CLIP_DIR)) disk.store.delete(path)
        return { clips: 0, bytes: 0 }
      },
    }
  }

  const text = (disk: ReturnType<typeof fakeFs>) =>
    Object.fromEntries([...disk.store].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]))

  beforeEach(() => {
    vi.useFakeTimers()
    plugin.heard.length = 0
    plugin.wire = null
  })

  afterEach(() => {
    vi.useRealTimers()
    plugin.wire = null
  })

  /* D5: "their data stays", and the toggle's own summary promises it to the reader. */
  it('leaves every pack and clip byte for byte, sends the plugin nothing, and finds them all on return', async () => {
    const disk = fakeFs(SEED)
    plugin.wire = pluginOver(disk) as VoicesWire
    const fs = disk as unknown as IndexFs

    /* What the seed is worth: a running engine reads these files, so a test that
       could not see them could not see them go. */
    const on = await launch([voices], new Set(), fs)
    const engine = on.services.speechEngines()
    expect((await engine?.catalogue())?.map((pack) => pack.installed)).toEqual([true])
    expect((await engine?.clipUsage())?.clips).toBe(2)
    on.composition.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(plugin.heard, 'quitting with the voices on sent more than the release of the model').toEqual([
      'catalogue',
      'clipUsage',
      'release',
    ])
    expect(text(disk)).toEqual(SEED)

    plugin.heard.length = 0
    const off = await launch([voices], new Set(['voices']), fs)
    await vi.advanceTimersByTimeAsync(60_000)
    off.composition.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(plugin.heard, 'a switched-off capability reached the plugin, the only way to these files').toEqual([])
    expect(text(disk), 'a pack or a clip was deleted or rewritten').toEqual(SEED)
    for (const path of Object.keys(SEED)) expect(disk.writes(path), `${path} was written`).toBe(0)

    const back = await launch([voices], new Set(), fs)
    const again = back.services.speechEngines()
    expect((await again?.catalogue())?.map((pack) => pack.installed)).toEqual([true])
    expect((await again?.clipUsage())?.clips).toBe(2)
    back.composition.dispose()
  })
})
