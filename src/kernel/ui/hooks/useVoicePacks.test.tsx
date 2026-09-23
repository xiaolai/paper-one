// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PACKS_POLL_MS, useVoicePacks, type VoicesState } from './useVoicePacks'
import type { KernelServices } from '../../core/services'
import type { SpeechEnginePort, VoicePack } from '../../core/ports'

afterEach(cleanup)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const PACK: VoicePack = {
  id: 'english-kokoro',
  name: 'English',
  summary: '',
  family: 'kokoro',
  languages: ['en'],
  bytes: 1,
  minimumMemoryGb: 4,
  voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
  installed: true,
}

function servicesWith(port: SpeechEnginePort | null): KernelServices {
  return { speechEngines: () => port } as unknown as KernelServices
}

/** Mount the hook and let its first read land. */
async function mount(services: KernelServices) {
  const seen: { current: VoicesState | null } = { current: null }
  function Probe() {
    seen.current = useVoicePacks(services)
    return null
  }
  const view = render(<Probe />)
  await act(async () => {
    await Promise.resolve()
  })
  return { seen, view }
}

describe('without a voices capability', () => {
  it('answers no packs and no engine', async () => {
    const { seen } = await mount(servicesWith(null))
    expect(seen.current?.packs).toEqual([])
    expect(seen.current?.engine).toBeNull()
  })
})

describe('with one', () => {
  function portOver(over: Partial<SpeechEnginePort> = {}): SpeechEnginePort {
    return {
      catalogue: async () => [PACK],
      install: async () => {},
      remove: async () => {},
      render: async () => ({ pcm: new Uint8Array(0), sampleRate: 24_000, words: [], skipped: [] }),
      release: async () => {},
      ...over,
    }
  }

  it('reads the catalogue and offers an engine', async () => {
    const { seen } = await mount(servicesWith(portOver()))
    expect(seen.current?.packs).toEqual([PACK])
    expect(seen.current?.engine).not.toBeNull()
  })

  it('re-reads it, so a pack downloaded in Settings reaches the book', async () => {
    // ⚠️ A list read once at mount leaves the book on screen still refused
    // after the reader has downloaded the very pack that would read it.
    let rows: VoicePack[] = []
    const { seen } = await mount(servicesWith(portOver({ catalogue: async () => rows })))
    expect(seen.current?.packs).toEqual([])
    rows = [PACK]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PACKS_POLL_MS + 10)
    })
    expect(seen.current?.packs).toEqual([PACK])
  })

  it('keeps the list it has when a poll fails', async () => {
    // An empty list means "no pack can read this book", so emptying it on one
    // failed poll takes a working voice away mid-chapter.
    let fail = false
    const { seen } = await mount(
      servicesWith(
        portOver({
          catalogue: async () => {
            if (fail) throw new Error('the plugin did not answer')
            return [PACK]
          },
        }),
      ),
    )
    expect(seen.current?.packs).toEqual([PACK])
    fail = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PACKS_POLL_MS + 10)
    })
    expect(seen.current?.packs).toEqual([PACK])
  })

  it('asks for the model back when the app goes', async () => {
    // 2.5 GB for the Chinese pack, and this is the last moment anything asks.
    const release = vi.fn(async () => {})
    const { view } = await mount(servicesWith(portOver({ release })))
    view.unmount()
    expect(release).toHaveBeenCalled()
  })

  it('stops polling once it is gone', async () => {
    const catalogue = vi.fn(async () => [PACK])
    const { view } = await mount(servicesWith(portOver({ catalogue })))
    const before = catalogue.mock.calls.length
    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PACKS_POLL_MS * 3)
    })
    expect(catalogue.mock.calls.length).toBe(before)
  })

  it('makes no audio context until something asks to play', async () => {
    // ⚠️ A context takes an output device and counts against a per-page limit
    // in some browsers. A reader who never presses Listen should not have one.
    const made = vi.fn()
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          made()
        }
        async resume() {}
      },
    )
    const { seen } = await mount(servicesWith(portOver()))
    expect(made).not.toHaveBeenCalled()
    act(() => {
      seen.current?.engine?.host()
    })
    expect(made).toHaveBeenCalledTimes(1)
    // And only one, however many passages are read.
    act(() => {
      seen.current?.engine?.host()
    })
    expect(made).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('answers no host where the browser has no audio at all', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const { seen } = await mount(servicesWith(portOver()))
    expect(seen.current?.engine?.host()).toBeNull()
    vi.unstubAllGlobals()
  })
})
