// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STOPPED, VoicesPane, arrivedOf, languagesOf, progressLine, sizeOf } from './VoicesPane'
import type { InstallProgress, SpeechEnginePort, SpokenAudio, VoicePack } from '../../../kernel'
import { StopFailed } from '../lib/port'
import { makeDownloads } from '../lib/downloads'

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

/** Mount and let the first catalogue read land.
 *
 * ⚠️ **ITS OWN REGISTRY, NEVER `theDownloads`.** The downloads deliberately
 * outlive the pane, so the app's one is module-level — which would carry a
 * half-stopped download from one case into the next. `makeDownloads` exists
 * for exactly this. */
async function show(port: SpeechEnginePort, downloads = makeDownloads()) {
  const view = render(<VoicesPane port={port} downloads={downloads} />)
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

  it('counts nothing as nothing, not as an unknown size', () => {
    /* ⚠️ **MEASURED IN THE RUNNING APP, 2026-09-23.** Pressing Download on the
       2.3 GB Chinese pack drew *"Downloading · unknown size of 2.3 GB"* — the
       received count went through `sizeOf`, which refuses zero so a catalogue
       row with no size is never offered as `NaN MB`. A count of bytes received
       starts at zero every time, so it needs the other function. */
    expect(arrivedOf(0)).toBe('0 MB')
    expect(progressLine({ kind: 'downloading', received: 0, total: 2_498_416_818 })).toBe(
      'Downloading · 0 MB of 2.3 GB',
    )
  })

  it('still refuses a received count that is not a count', () => {
    // Negative and non-finite are nonsense on either side of the sentence.
    expect(arrivedOf(-1)).toBe('unknown size')
    expect(arrivedOf(Number.NaN)).toBe('unknown size')
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

  it('keeps the size and the memory out of the truncating container', async () => {
    /* ⚠️ **MEASURED IN THE RUNNING APP, 2026-09-23.** These facts were inside a
     * `paper-cap-grow`, whose own CSS comment says it "takes the slack and
     * truncates": 585 px of text was clipped into 271 px and everything from
     * the size onwards was INVISIBLE — the one thing this pane exists to say
     * before a reader taps Download. Nothing failed; the text was in the DOM.
     * Only looking at it found this, so this case is what stops it returning. */
    await show(portOver([pack()]))
    const facts = screen.getByText(/Kokoro 82M/)
    expect(facts.className).toContain('hint')
    expect(facts.closest('.paper-cap-grow')).toBeNull()
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

  it('says a stop that FAILED, rather than reporting nothing was left behind', async () => {
    /* ⚠️ An aborted signal says the reader ASKED to stop, not that it worked. A
       refused stop leaves the download running to completion, and "Nothing was
       left half-installed" over that is the one sentence in this pane that
       would be false. */
    const port = portOver([pack()], {
      install: async (_id, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new StopFailed('the download could not be stopped: the plugin refused')),
            { once: true },
          )
        }),
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
    expect(screen.queryByText(STOPPED)).toBeNull()
    expect(screen.getByText(/could not be stopped/)).toBeTruthy()
  })

  it('keeps the rows, and the Stop control, when a poll fails mid-download', async () => {
    /* ⚠️ A single failed poll used to replace the whole pane — the rows, the
       progress line and the only control that could stop a 2.3 GB download —
       and put them back a few seconds later.

       ⚠️ **AND THE FIRST VERSION OF THIS CASE NEVER FAILED A POLL.** It left
       the install pending, so the refresh that follows one never ran, and no
       second read happened inside the test at all: it asserted Stop after the
       successful FIRST read and would have passed against the defect. The poll
       is driven here, and the failure is checked to have actually landed. */
    vi.useFakeTimers()
    try {
      let answers = 0
      const port = portOver([pack()], {
        catalogue: async () => {
          answers += 1
          if (answers > 1) throw new Error('the plugin did not answer')
          return [pack()]
        },
        install: async () => new Promise(() => {}),
      })
      const view = render(<VoicesPane port={port} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
      })
      act(() => screen.getByRole('button', { name: 'Download' }).click())
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000)
      })
      expect(answers, 'the poll really did run and really did fail').toBeGreaterThan(1)
      expect(screen.getByText(/could not be listed/), 'and says so').toBeTruthy()
      expect(screen.getByRole('button', { name: 'Stop' }), 'beside the rows, not instead of them').toBeTruthy()
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the plugin is not answering rather than showing an empty shelf', async () => {
    // The catalogue is embedded in the binary, so a failure here is the plugin
    // — an empty pane would read as "no voices exist".
    const port = portOver([], { catalogue: async () => { throw new Error('the plugin did not answer') } })
    await show(port)
    expect(screen.getByText(/could not be listed/).textContent).toContain('did not answer')
  })

  it('keeps a download, its progress and its Stop across a close and reopen', async () => {
    /* ⚠️ **THE DEFECT: THE DOWNLOAD BELONGED TO THE PANEL.** Each lived in a
       ref of `AbortController`s beside React state, so closing Settings — or a
       hot reload, which is how this was first seen on 2026-09-23 — threw away
       the progress and the only control that could stop a 2.3 GB fetch, while
       the plugin went on fetching. Reopening showed Download on a pack that was
       half here. */
    const downloads = makeDownloads()
    let report: ((progress: InstallProgress) => void) | null = null
    const port = portOver([pack()], {
      install: async (_id, onProgress) => {
        report = onProgress
        return new Promise(() => {})
      },
    })
    await show(port, downloads)
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => report?.({ kind: 'downloading', received: 104_857_600, total: 336_822_660 }))
    expect(screen.getByText(/100 MB of 321 MB/)).toBeTruthy()

    cleanup()
    await show(port, downloads)
    expect(screen.getByText(/100 MB of 321 MB/), 'the progress survived the close').toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' }), 'and so did the way to stop it').toBeTruthy()
  })

  it('starts one download for a pack, however many times Download is pressed', async () => {
    const downloads = makeDownloads()
    const install = vi.fn(async () => new Promise<void>(() => {}))
    await show(portOver([pack()], { install }), downloads)
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('removes a pack once however many times Remove is pressed, and clears the last error', async () => {
    /* ⚠️ A second press used to start a second removal, and a retry that worked
       left the previous sentence on the row. */
    let fails = true
    const remove = vi.fn(async () => {
      if (fails) throw new Error('the files would not go')
    })
    await show(portOver([pack({ installed: true })], { remove }))
    act(() => screen.getByRole('button', { name: 'Remove' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/would not go/)).toBeTruthy()
    fails = false
    act(() => screen.getByRole('button', { name: 'Remove' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(/would not go/), 'a retry that worked clears the sentence').toBeNull()
    expect(remove).toHaveBeenCalledTimes(2)
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
