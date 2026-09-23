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

const OTHER: VoicePack = { ...PACK, id: 'chinese-qwen', name: 'Chinese', family: 'qwen', languages: ['zh'] }

/** Mount with the services as a prop, so a case can swap them. */
async function mountSwapping(first: KernelServices) {
  const seen: { current: VoicesState | null } = { current: null }
  function Probe({ services }: { services: KernelServices }) {
    seen.current = useVoicePacks(services)
    return null
  }
  const view = render(<Probe services={first} />)
  await act(async () => {
    await Promise.resolve()
  })
  const swap = async (next: KernelServices) => {
    view.rerender(<Probe services={next} />)
    await act(async () => {
      await Promise.resolve()
    })
  }
  return { seen, view, swap }
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

  it('says nothing about it, however long it polls', async () => {
    /* A build with no voices capability is not a fault and has nothing to
       report. This is what makes the catch in `read` a different road rather
       than a second spelling of this one. */
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount(servicesWith(null))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PACKS_POLL_MS * 3)
    })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
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
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PACKS_POLL_MS + 10)
    })
    expect(seen.current?.packs).toEqual([PACK])
    /* Kept, and SAID: a poll that fails every four seconds is otherwise
       invisible, and this hook is the only place that knows it happened. */
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('catalogue would not read'),
      expect.objectContaining({ message: 'the plugin did not answer' }),
    )
    errors.mockRestore()
  })

  it('answers no packs until the first read lands', () => {
    /* The list starts EMPTY, and that is a decision: "no pack can read this
       book" is the right answer while nothing is known, and it is what the
       Listen control and the export both read. */
    const seen: { current: VoicesState | null } = { current: null }
    const services = servicesWith(portOver({ catalogue: () => new Promise(() => {}) }))
    function Probe() {
      seen.current = useVoicePacks(services)
      return null
    }
    render(<Probe />)
    expect(seen.current?.packs).toEqual([])
  })

  it('follows a port bound later, and lets no abandoned read overwrite it', async () => {
    /* ⚠️ THREE THINGS AT ONCE, and they are one mechanism: the port is read
       through the services it was given, the poll re-runs when that changes,
       and the read it abandoned may not land afterwards. A capability binds
       its port during `start`, which can arrive after this hook's first
       render — so a hook that captured the first answer would poll a port that
       no longer exists, and its late reply would overwrite the real one. */
    const held: { resolve: (rows: VoicePack[]) => void } = { resolve: () => {} }
    const first = portOver({
      catalogue: () =>
        new Promise<readonly VoicePack[]>((resolve) => {
          held.resolve = resolve
        }),
    })
    const { seen, swap } = await mountSwapping(servicesWith(first))
    expect(seen.current?.packs).toEqual([])
    await swap(servicesWith(portOver({ catalogue: async () => [OTHER] })))
    expect(seen.current?.packs, 'the services it has now').toEqual([OTHER])
    await act(async () => {
      held.resolve([PACK])
      await Promise.resolve()
    })
    expect(seen.current?.packs, 'and the abandoned read lands nowhere').toEqual([OTHER])
  })

  it('asks the port it was using for the model back when the services change', async () => {
    // Not only on unmount: a composition swapped under a live hook leaves the
    // old engine holding 2.5 GB that nothing will ever ask for again.
    const release = vi.fn(async () => {})
    const { swap } = await mountSwapping(servicesWith(portOver({ release })))
    await swap(servicesWith(portOver()))
    expect(release).toHaveBeenCalled()
  })

  it('hands the reading the list it has now, and the port’s own render', async () => {
    /* The engine is what `useSpeech` speaks through, and both of its members
       are forwarding: a `packs()` that answers nothing routes every book to
       the platform voice, and a `render` that answers nothing is a reading
       that produces no sound at all. */
    const spoken = { pcm: new Uint8Array([1, 0]), sampleRate: 24_000, words: [], skipped: [] }
    const render_ = vi.fn(async () => spoken)
    const { seen } = await mount(servicesWith(portOver({ render: render_ })))
    expect(seen.current?.engine?.packs()).toEqual([PACK])
    const request = { packId: 'english-kokoro', voiceId: 'af_heart', text: 'Call me Ishmael.' }
    await expect(seen.current?.engine?.render(request)).resolves.toBe(spoken)
    expect(render_).toHaveBeenCalledWith(request)
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

  /** A stub context that records its own lifecycle. */
  function stubAudio() {
    const log = { made: 0, resumes: 0, closes: 0, last: null as { state: string } | null }
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        constructor() {
          log.made += 1
          log.last = this
        }
        async resume() {
          log.resumes += 1
          this.state = 'running'
        }
        async close() {
          log.closes += 1
          this.state = 'closed'
        }
      },
    )
    return log
  }

  it('makes no audio context until something asks to play', async () => {
    // ⚠️ A context takes an output device and counts against a per-page limit
    // in some browsers. A reader who never presses Listen should not have one.
    const log = stubAudio()
    const { seen } = await mount(servicesWith(portOver()))
    expect(log.made).toBe(0)
    act(() => {
      seen.current?.engine?.host()
    })
    expect(log.made).toBe(1)
    // And only one, however many passages are read.
    act(() => {
      seen.current?.engine?.host()
    })
    expect(log.made).toBe(1)
    vi.unstubAllGlobals()
  })

  it('gives the output device back when the app is torn down', async () => {
    /* ⚠️ Only the MODEL was released on unmount. The context stayed, holding an
       output device and counting against the per-page limit, and a hook that
       mounted again handed out the one it had left behind. */
    const log = stubAudio()
    const { seen, view } = await mount(servicesWith(portOver()))
    act(() => {
      seen.current?.engine?.host()
    })
    expect(log.closes).toBe(0)
    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(log.closes).toBe(1)
    vi.unstubAllGlobals()
  })

  it('asks a suspended context to run again, rather than handing back a silent one', async () => {
    /* ⚠️ `host()` is reached from `#play`, AFTER an async render — not from the
       Listen gesture, whatever the comment used to say. So the first `resume`
       can be refused, and a cached context was then handed out suspended for
       ever, playing nothing with nothing saying why. */
    const log = stubAudio()
    const { seen } = await mount(servicesWith(portOver()))
    act(() => {
      seen.current?.engine?.host()
    })
    expect(log.resumes).toBe(1)
    // As though the first resume had been refused.
    act(() => {
      if (log.last) log.last.state = 'suspended'
      seen.current?.engine?.host()
    })
    expect(log.resumes).toBe(2)
    // And a running one is left alone.
    act(() => {
      seen.current?.engine?.host()
    })
    expect(log.resumes).toBe(2)
    vi.unstubAllGlobals()
  })

  it('answers no host where the browser has no audio at all', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const { seen } = await mount(servicesWith(portOver()))
    expect(seen.current?.engine?.host()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('takes the prefixed constructor where that is the only one there is', async () => {
    /* Safari on older macOS ships `webkitAudioContext` and nothing else. The
       unprefixed name has to be the clause that DECIDES here — reaching for it
       regardless leaves `Ctor` undefined and the reader with no sound, on the
       one browser this fallback exists for. */
    const log = { made: 0 }
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal(
      'webkitAudioContext',
      class {
        state = 'suspended'
        constructor() {
          log.made += 1
        }
        async resume() {}
        async close() {}
      },
    )
    const { seen } = await mount(servicesWith(portOver()))
    act(() => {
      expect(seen.current?.engine?.host()).not.toBeNull()
    })
    expect(log.made).toBe(1)
    vi.unstubAllGlobals()
  })
})
