// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STOPPED, VoicesPane, languagesOf, progressLine, sizeOf } from './VoicesPane'
import type { InstallProgress, SpeechEnginePort, SpokenAudio, VoicePack } from '../../../kernel'

afterEach(cleanup)

function pack(over: Partial<VoicePack> = {}): VoicePack {
  return {
    id: 'english-kokoro',
    name: 'English',
    summary: 'Kokoro 82M, read on this device.',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: false,
    ...over,
  }
}

/** A port the case drives. */
function portOver(packs: readonly VoicePack[], over: Partial<SpeechEnginePort> = {}): SpeechEnginePort {
  return {
    catalogue: async () => packs,
    install: async () => {},
    remove: async () => {},
    render: async (): Promise<SpokenAudio> => ({ pcm: new Uint8Array(0), sampleRate: 24_000, words: [], skipped: [] }),
    release: async () => {},
    ...over,
  }
}

/** Mount and let the first catalogue read land. */
async function show(port: SpeechEnginePort) {
  const view = render(<VoicesPane port={port} />)
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

describe('sizes a reader can read', () => {
  it('says megabytes under a gigabyte and gigabytes over', () => {
    expect(sizeOf(336_822_660)).toBe('321 MB')
    expect(sizeOf(2_498_416_818)).toBe('2.3 GB')
  })

  it('refuses to render a size that is not one', () => {
    // A row with no size would otherwise be offered as `NaN MB`.
    expect(sizeOf(0)).toBe('unknown size')
    expect(sizeOf(Number.NaN)).toBe('unknown size')
    expect(sizeOf(-1)).toBe('unknown size')
  })
})

describe('what a download says it is doing', () => {
  it('counts what has arrived against the whole', () => {
    const progress: InstallProgress = { kind: 'downloading', received: 432_013_312, total: 2_498_416_818 }
    expect(progressLine(progress)).toBe('Downloading · 412 MB of 2.3 GB')
  })

  it('names the two other stages', () => {
    expect(progressLine({ kind: 'verifying' })).toBe('Checking every byte')
    expect(progressLine({ kind: 'installed' })).toBe('Installed')
  })

  it('leaves the total out where it is not known yet', () => {
    expect(progressLine({ kind: 'downloading', received: 1_048_576, total: 0 })).toBe('Downloading · 1 MB')
  })
})

describe('the languages a pack reads', () => {
  it('spells the tag for a person', () => {
    expect(languagesOf(pack({ languages: ['en'] }))).toBe('English')
    expect(languagesOf(pack({ languages: ['zh'] }))).toContain('Chinese')
  })

  it('keeps a tag it cannot spell rather than failing', () => {
    // A catalogue is data. One malformed tag must not take the pane down.
    expect(languagesOf(pack({ languages: ['not a tag at all'] }))).toBe('not a tag at all')
  })
})

describe('the pane', () => {
  it('states the size, the languages and the memory before there is anything to press', async () => {
    // ⚠️ A pack is 300 MB to 2.4 GB. That is not a thing to begin on a tap and
    // explain afterwards.
    await show(portOver([pack()]))
    const row = screen.getByText(/Kokoro 82M/)
    expect(row.textContent).toContain('English')
    expect(row.textContent).toContain('321 MB')
    expect(row.textContent).toContain('4 GB of memory')
  })

  it('names whose models these are', async () => {
    await show(portOver([pack()]))
    expect(screen.getByText(/Apache-2.0/).textContent).toContain('CMUdict')
  })

  it('offers Download for a pack that is not here, and Remove for one that is', async () => {
    await show(portOver([pack()]))
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    cleanup()
    await show(portOver([pack({ installed: true })]))
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('reports progress as it arrives', async () => {
    let report: ((progress: InstallProgress) => void) | null = null
    const port = portOver([pack()], {
      install: async (_id, onProgress) => {
        report = onProgress
        await new Promise(() => {})
      },
    })
    await show(port)
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => report?.({ kind: 'downloading', received: 104_857_600, total: 336_822_660 }))
    expect(screen.getByText(/100 MB of 321 MB/)).toBeTruthy()
  })

  it('says why a download failed rather than going quiet', async () => {
    // ⚠️ A refused digest, a full disk and a stopped fetch all end here. A row
    // that simply goes back to Download tells a reader their tap did nothing.
    const port = portOver([pack()], {
      install: async () => {
        throw new Error("the file's digest does not match the catalogue")
      },
    })
    await show(port)
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/digest does not match/)).toBeTruthy()
  })

  it('stops a download through the port’s own signal, and says the reader did it', async () => {
    let seen: AbortSignal | undefined
    const port = portOver([pack()], {
      install: async (_id, _onProgress, signal) => {
        seen = signal
        await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
    })
    await show(port)
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => screen.getByRole('button', { name: 'Stop' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(seen?.aborted).toBe(true)
    // A stop is the reader's own doing, so it does not read as a failure.
    expect(screen.getByText(STOPPED)).toBeTruthy()
  })

  it('says the plugin is not answering rather than showing an empty shelf', async () => {
    // The catalogue is embedded in the binary, so a failure here is the plugin
    // — an empty pane would read as "no voices exist".
    const port = portOver([], { catalogue: async () => { throw new Error('the plugin did not answer') } })
    await show(port)
    expect(screen.getByText(/could not be listed/).textContent).toContain('did not answer')
  })

  it('stops polling once it is closed', async () => {
    const catalogue = vi.fn(async () => [pack()])
    const view = await show(portOver([], { catalogue }))
    const before = catalogue.mock.calls.length
    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(catalogue.mock.calls.length).toBe(before)
  })
})
