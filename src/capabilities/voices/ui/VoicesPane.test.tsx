// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLL_MS, STOPPED, VoicesPane, arrivedOf, languagesOf, progressLine, sizeOf, usageLine } from './VoicesPane'
import type { ClipUsage, InstallProgress, SpeechEnginePort, SpokenAudio, VoicePack } from '../../../kernel'
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
    render: async (): Promise<SpokenAudio> => ({ pcm: new Uint8Array(0), sampleRate: 24_000, words: [], skipped: [], evicted: { clips: 0, bytes: 0 }, clipPath: '/tmp/audio/clips/x.wav' }),
    findClip: async () => null,
    holdClips: async (stems: readonly string[]) => stems.length,
    clipUsage: async () => ({ bytes: 0, budget: 5 * 1024 * 1024 * 1024, clips: 0 }),
    forgetClips: async () => ({ clips: 0, bytes: 0 }),
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
    /* ⚠️ **TWO TURNS, BECAUSE THERE ARE TWO READS.** The catalogue and the
       rendered reading's usage are started together and are independent promises,
       so one microtask lands the first and leaves the second pending — and a case
       about the usage row would then find no row and read as a missing feature. */
    await Promise.resolve()
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

  it('reads several as a list, in the app’s own language', () => {
    /* The separator is what makes it a list rather than one long word, and the
       locale is the APP's: named `en`, these say "English, Chinese" on a Mac
       set to any language, which is the rest of this pane's language too. */
    expect(languagesOf(pack({ languages: ['en', 'zh'] }))).toBe('English, Chinese')
    expect(languagesOf(pack({ languages: ['en', 'not a tag at all'] }))).toBe('English, not a tag at all')
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
    /* With real timers this could only say that nothing happened in the next
       microtask, which is true of a live pane too. The clock has to move. */
    vi.useFakeTimers()
    try {
      const catalogue = vi.fn(async () => [pack()])
      const view = await show(portOver([], { catalogue }))
      const before = catalogue.mock.calls.length
      view.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS * 3)
      })
      expect(catalogue.mock.calls.length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling while it is open', async () => {
    vi.useFakeTimers()
    try {
      const catalogue = vi.fn(async () => [pack()])
      await show(portOver([], { catalogue }))
      const before = catalogue.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS + 10)
      })
      expect(catalogue.mock.calls.length).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies the NEWEST read, whatever order the answers arrive in', async () => {
    /* ⚠️ The timer polls while `install` and `remove` each ask for a read of
       their own, so two are in flight routinely — and a stale one landing last
       put `installed: false` back on a pack that had just finished
       installing, which redraws Download over a pack that is here. */
    vi.useFakeTimers()
    try {
      const settles: ((rows: readonly VoicePack[]) => void)[] = []
      const catalogue = () =>
        new Promise<readonly VoicePack[]>((resolve) => {
          settles.push(resolve)
        })
      render(<VoicesPane port={portOver([], { catalogue })} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS + 10)
      })
      expect(settles.length, 'two reads are in flight').toBe(2)
      await act(async () => {
        settles[1]?.([pack({ installed: true })])
        await Promise.resolve()
      })
      await act(async () => {
        settles[0]?.([pack({ installed: false })])
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: 'Remove' }), 'the older answer lost').toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says it is looking before the first answer, and does not call that a failure', async () => {
    render(
      <VoicesPane port={portOver([], { catalogue: () => new Promise(() => {}) })} downloads={makeDownloads()} />,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/Looking for voices/)).toBeTruthy()
    expect(screen.queryByText(/could not be listed/)).toBeNull()
  })

  it('says plainly when this device is offered no voice at all', async () => {
    /* Not the same as "the plugin would not answer": the catalogue answered,
       and this machine is on a platform or under a memory floor that no pack
       is offered for. An empty pane would read as a defect. */
    await show(portOver([]))
    expect(screen.getByText(/No voices are offered on this device/)).toBeTruthy()
  })

  it('takes a later answer as having cleared the failure it was showing', async () => {
    let fail = true
    const catalogue = async () => {
      if (fail) throw new Error('the plugin did not answer')
      return [pack()]
    }
    vi.useFakeTimers()
    try {
      await show(portOver([], { catalogue }))
      expect(screen.getByText(/could not be listed/)).toBeTruthy()
      fail = false
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS + 10)
      })
      expect(screen.queryByText(/could not be listed/), 'a read that worked takes it back').toBeNull()
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing about a failure when there was none', async () => {
    const { container } = await show(portOver([pack()]))
    expect(container.textContent).not.toContain('could not be listed')
  })

  it('draws no empty line where a row has nothing to report', async () => {
    /* An `error` of null still rendered its container, so every row carried an
       empty hint the layout had to make room for. */
    await show(portOver([pack()]))
    const row = screen.getByText(/Kokoro 82M/).parentElement
    const hints = [...(row?.children ?? [])].filter((child) => child.className.includes('hint'))
    expect(hints.map((hint) => hint.textContent?.slice(0, 6))).toEqual(['Kokoro', 'Heart'])
  })

  it('names every voice a pack ships, separated so they read as a list', async () => {
    const two = pack({
      voices: [
        { id: 'af_heart', name: 'Heart', language: 'en-US', note: '' },
        { id: 'bf_emma', name: 'Emma', language: 'en-GB', note: '' },
      ],
    })
    await show(portOver([two]))
    expect(screen.getByText('Heart, Emma')).toBeTruthy()
  })

  it('draws Remove as the destructive control and Download as the primary one', async () => {
    /* The two controls differ by nothing but their class, and one of them
       deletes 2.3 GB: a Remove that looks like a Download is a press nobody
       meant to make. */
    await show(portOver([pack({ installed: true })]))
    expect(screen.getByRole('button', { name: 'Remove' }).className).toContain('danger')
    cleanup()
    await show(portOver([pack()]))
    expect(screen.getByRole('button', { name: 'Download' }).className).toContain('primary')
  })

  it('reads the port it has NOW, and watches the registry it has now', async () => {
    /* Both arrive as props. A pane that captured the first of either goes on
       polling a port the composition has replaced, and shows the progress of
       downloads nobody is running. */
    const first = makeDownloads()
    const second = makeDownloads()
    const view = render(<VoicesPane port={portOver([pack()])} downloads={first} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    view.rerender(<VoicesPane port={portOver([pack({ installed: true })])} downloads={second} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Remove' }), 'the new port was read').toBeTruthy()
    await act(async () => {
      void second.begin('english-kokoro', 10, () => new Promise(() => {}))
      await Promise.resolve()
    })
    expect(screen.getByText(/Downloading/), 'the new registry is the one watched').toBeTruthy()
  })

  it('lets an older read’s FAILURE land nowhere either, not only its answer', async () => {
    /* The stale check guards both roads out of a read, and the failing one is
       the road that matters more: a poll that refuses after a newer poll has
       already answered would replace live rows with "the voices could not be
       listed" for something that is no longer being asked. */
    vi.useFakeTimers()
    try {
      const settles: { ok: (rows: readonly VoicePack[]) => void; no: (cause: unknown) => void }[] = []
      const catalogue = () =>
        new Promise<readonly VoicePack[]>((resolve, reject) => {
          settles.push({ ok: resolve, no: reject })
        })
      render(<VoicesPane port={portOver([], { catalogue })} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS + 10)
      })
      expect(settles.length).toBe(2)
      await act(async () => {
        settles[1]?.ok([pack()])
        await Promise.resolve()
      })
      await act(async () => {
        settles[0]?.no(new Error('the plugin did not answer'))
        await Promise.resolve()
      })
      expect(screen.queryByText(/could not be listed/), 'the abandoned read said nothing').toBeNull()
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts one removal for a pack, however fast Remove is pressed twice', async () => {
    /* ⚠️ Both presses before React commits the first read the same `removing`
       map, so a lock kept in state is no lock at all — and the disabled
       attribute cannot help either, because it only appears on the render
       that has not happened yet. */
    const remove = vi.fn(async () => new Promise<void>(() => {}))
    await show(portOver([pack({ installed: true })], { remove }))
    const button = screen.getByRole('button', { name: 'Remove' })
    act(() => {
      button.click()
      button.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('downloads and removes through the port it has NOW', async () => {
    /* Both controls close over the port, and a pane that kept the first goes
       on asking a plugin the composition has replaced — a press that appears
       to do nothing at all. */
    const first = { install: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const second = { install: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
    const view = render(<VoicesPane port={portOver([pack()], first)} downloads={makeDownloads()} />)
    await act(async () => {
      await Promise.resolve()
    })
    view.rerender(<VoicesPane port={portOver([pack()], second)} downloads={makeDownloads()} />)
    await act(async () => {
      await Promise.resolve()
    })
    act(() => screen.getByRole('button', { name: 'Download' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(first.install).not.toHaveBeenCalled()
    expect(second.install).toHaveBeenCalledTimes(1)

    view.rerender(<VoicesPane port={portOver([pack({ installed: true })], second)} downloads={makeDownloads()} />)
    await act(async () => {
      await Promise.resolve()
    })
    act(() => screen.getByRole('button', { name: 'Remove' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(first.remove).not.toHaveBeenCalled()
    expect(second.remove).toHaveBeenCalledTimes(1)
  })

  it('leaves another row’s Remove disabled while its own removal ends', async () => {
    /* One map for every row: replacing it wholesale on the way OUT of one
       removal re-enables a control for a removal that is still running. */
    const held: { done: () => void } = { done: () => {} }
    const remove = vi.fn(async (id: string) => {
      if (id === 'english-kokoro') return new Promise<void>(() => {})
      return new Promise<void>((resolve) => {
        held.done = resolve
      })
    })
    const chinese = pack({ id: 'chinese-qwen', name: 'Chinese', installed: true })
    await show(portOver([pack({ installed: true }), chinese], { remove }))
    const buttons = () => screen.getAllByRole('button', { name: 'Remove' }) as HTMLButtonElement[]
    act(() => buttons()[0]?.click())
    act(() => buttons()[1]?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(buttons().map((button) => button.disabled)).toEqual([true, true])
    await act(async () => {
      held.done()
      await Promise.resolve()
    })
    expect(buttons().map((button) => button.disabled), 'only the one that finished').toEqual([true, false])
  })

  it('marks only the pack being removed, and leaves another row’s sentence alone', async () => {
    const refuse = vi.fn(async (id: string) => {
      if (id === 'chinese-qwen') throw new Error('the files would not go')
    })
    const chinese = pack({ id: 'chinese-qwen', name: 'Chinese', installed: true })
    await show(portOver([pack({ installed: true }), chinese], { remove: refuse }))
    const [english, zh] = screen.getAllByRole('button', { name: 'Remove' })
    act(() => zh?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/would not go/)).toBeTruthy()
    /* Removing the OTHER pack must not take that sentence away: each row's
       state is its own, and a whole-map replacement loses every other row. */
    act(() => english?.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/would not go/), 'the Chinese row still says why').toBeTruthy()
  })

  it('disables Remove while the removal is in flight', async () => {
    const held: { done: () => void } = { done: () => {} }
    const remove = async () =>
      new Promise<void>((resolve) => {
        held.done = resolve
      })
    await show(portOver([pack({ installed: true })], { remove }))
    const button = screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    act(() => button.click())
    await act(async () => {
      await Promise.resolve()
    })
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      held.done()
      await Promise.resolve()
    })
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('forgets a finished download’s sentence when the pack is removed', async () => {
    /* A download the reader stopped leaves its sentence in the registry, which
       outlives the pane. Removing the pack is the reader saying they are done
       with it; the sentence has to go with it, or it reappears under a pack
       that is no longer even here. */
    const downloads = makeDownloads()
    await act(async () => {
      const stopping = downloads.begin('english-kokoro', 1, (_report, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      )
      downloads.stop('english-kokoro')
      /* With a deadline: this only ends because the stop reached the download,
         so a registry that aborted nothing would hold the case here until
         vitest's own 15 s bound — half a minute of saying nothing, which a
         mutation sweep can only read as a timeout. */
      await Promise.race([
        stopping.catch(() => {}),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the download never settled')), 2000)),
      ])
    })
    await show(portOver([pack({ installed: true })]), downloads)
    expect(screen.getByText(STOPPED)).toBeTruthy()
    act(() => screen.getByRole('button', { name: 'Remove' }).click())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText(STOPPED)).toBeNull()
  })
})

describe('the rendered reading, and the disk it holds', () => {
  const usage = (over: Partial<ClipUsage> = {}): ClipUsage => ({
    bytes: 1_500_000_000,
    budget: 5 * 1024 * 1024 * 1024,
    clips: 12,
    ...over,
  })

  it('says how much is held, the budget, and what goes first', async () => {
    /* ⚠️ **WI-34.5's *eviction shown*.** Five gigabytes of audio derived from
       books the reader already has, and the only other sign of it is a chapter
       they heard last week being made again. */
    await show(portOver([pack()], { clipUsage: async () => usage() }))
    expect(screen.getByText(/in 12 chapters/u).textContent).toBe(
      `${sizeOf(1_500_000_000)} in 12 chapters · up to ${sizeOf(5 * 1024 * 1024 * 1024)} is kept · the least recently played goes first`,
    )
  })

  it('asks the line directly, because the DOM flattens its answers', () => {
    /* ⚠️ `packSize` REFUSES ZERO — correctly, for a SIZE — and nought bytes of
       rendered reading is an ordinary amount. The same rule the
       `sizeOf`/`arrivedOf` pair records, one level along. */
    expect(usageLine(usage({ bytes: 0, clips: 0 }))).toBe(
      `nothing yet · up to ${sizeOf(5 * 1024 * 1024 * 1024)} is kept · the least recently played goes first`,
    )
    expect(usageLine(usage({ clips: 1 }))).toContain('in 1 chapter ·')
    expect(usageLine(usage({ clips: 2 }))).toContain('in 2 chapters ·')
  })

  it('offers no Forget where there is nothing to forget', async () => {
    await show(portOver([pack()], { clipUsage: async () => usage({ bytes: 0, clips: 0 }) }))
    expect(screen.getByRole('button', { name: 'Forget them' }).hasAttribute('disabled')).toBe(true)
  })

  it('forgets everything on one press, and reads the usage back', async () => {
    const forgot: (string | undefined)[] = []
    let held = usage()
    const port = portOver([pack()], {
      clipUsage: async () => held,
      forgetClips: async (bookId) => {
        forgot.push(bookId)
        held = usage({ bytes: 0, clips: 0 })
        return { clips: 12, bytes: 1_500_000_000 }
      },
    })
    await show(port)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Forget them' }))
    })
    expect(forgot, 'all of it, not one book').toEqual([undefined])
    expect(screen.getByText(/nothing yet/u)).toBeTruthy()
  })

  it('keeps the newer read where two are in flight, in either order', async () => {
    /* ⚠️ **THE GENERATION TOKEN HAD NO CASE AT ALL — FOUND BY THE MUTATION SWEEP,
       which reported the guard, its negation and the whole `catch` as survivors.**
       The pane polls every four seconds and re-reads after a forget, so two reads
       overlap the moment either is slow — and the older one landing last would
       put stale disk in front of the reader, or `null` over a row that had just
       loaded. Every other case here has one read that resolves at once. */
    const answers: ((value: ClipUsage) => void)[] = []
    const port = portOver([pack()], {
      clipUsage: () => new Promise<ClipUsage>((resolve) => answers.push(resolve)),
    })
    /* ⚠️ **FAKE TIMERS BEFORE THE RENDER, NOT AFTER.** The poll's interval is
       armed in an effect at mount; switching clocks afterwards leaves that
       interval on the real one, so advancing the fake clock fires nothing and the
       case reports one read where it needs two. */
    vi.useFakeTimers()
    let view
    try {
      view = render(<VoicesPane port={port} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
      })
      /* A second read, from the poll, before the first has answered. */
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS)
      })
    } finally {
      vi.useRealTimers()
    }
    expect(answers.length, 'two reads really are in flight').toBeGreaterThanOrEqual(2)

    /* THE OLDER ONE LANDS LAST, which is the case the token exists for. */
    await act(async () => {
      answers.at(-1)?.({ bytes: 2_000_000_000, budget: 5 * 1024 * 1024 * 1024, clips: 9 })
      await Promise.resolve()
    })
    await act(async () => {
      answers[0]?.({ bytes: 1, budget: 5 * 1024 * 1024 * 1024, clips: 1 })
      await Promise.resolve()
    })
    expect(
      screen.getByText(/in 9 chapters/u),
      'the newer answer stands; the stale one was dropped',
    ).toBeTruthy()
    view.unmount()
  })

  it('leaves a loaded row alone when a LATER read fails', async () => {
    /* ⚠️ **THE `catch`'s OWN TOKEN CHECK, which nothing reached.** A poll that
       fails after the row has loaded must not blank it — the disk is still there,
       and a row flickering to nothing every four seconds on a transient failure is
       worse than a row that is briefly stale. And a STALE failure must not blank a
       row a newer read has just filled, which is the same question the other way
       round. */
    let answer: (value: ClipUsage) => void = () => {}
    let refuse: (cause: unknown) => void = () => {}
    let first = true
    const port = portOver([pack()], {
      clipUsage: () =>
        new Promise<ClipUsage>((resolve, reject) => {
          if (first) {
            first = false
            refuse = reject
          } else {
            answer = resolve
          }
        }),
    })
    /* FAKE TIMERS BEFORE THE RENDER — see the case above. */
    vi.useFakeTimers()
    let view
    try {
      view = render(<VoicesPane port={port} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS)
      })
    } finally {
      vi.useRealTimers()
    }
    /* The NEWER read succeeds, then the older one fails. */
    await act(async () => {
      answer({ bytes: 2_000_000_000, budget: 5 * 1024 * 1024 * 1024, clips: 9 })
      await Promise.resolve()
    })
    await act(async () => {
      refuse(new Error('the store went away'))
      await Promise.resolve()
    })
    expect(
      screen.getByText(/in 9 chapters/u),
      'a stale failure does not blank a row a newer read filled',
    ).toBeTruthy()
    view.unmount()
  })

  it('takes the row away when the read that fails is the CURRENT one', async () => {
    /* ⚠️ **AND THIS IS WHY `setUsage(null)` IS THERE AT ALL — the sweep reported
       it as removable, because the only case about a failing read had never loaded
       a row to lose.** The decision is the pane's own: a build without the store
       answers nothing, and a row about disk is not worth a sentence explaining its
       own absence beside a catalogue that loaded. So a current failure blanks it —
       which is a different answer from the stale failure above, and the token is
       what tells them apart. */
    let fails = false
    const port = portOver([pack()], {
      clipUsage: async () => {
        if (fails) throw new Error('the store went away')
        return usage()
      },
    })
    vi.useFakeTimers()
    try {
      const view = render(<VoicesPane port={port} downloads={makeDownloads()} />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByText(/in 12 chapters/u), 'the row loaded first').toBeTruthy()
      fails = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS)
      })
      expect(screen.queryByText(/in 12 chapters/u), 'and the failure took it away').toBeNull()
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the usage from the port it has NOW, not the one it was built with', async () => {
    /* ⚠️ **THE DEPENDENCY LIST, WHICH NOTHING HELD — the sweep emptied it and every
       case passed.** A port arrives asynchronously in the app, so a pane memoised
       against the first one would poll a store that is not the reader's for as
       long as Settings stayed open, and the row would never load at all. */
    const first = vi.fn(async () => usage())
    const second = vi.fn(async () => usage({ clips: 3 }))
    vi.useFakeTimers()
    try {
      const view = render(
        <VoicesPane port={portOver([pack()], { clipUsage: first })} downloads={makeDownloads()} />,
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(first).toHaveBeenCalled()
      view.rerender(
        <VoicesPane port={portOver([pack()], { clipUsage: second })} downloads={makeDownloads()} />,
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(second, 'the new port was asked').toHaveBeenCalled()
      expect(screen.getByText(/in 3 chapters/u)).toBeTruthy()
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('draws no row at all where the store cannot be asked', async () => {
    /* A build without the store answers nothing, and a row about disk is not
       worth a sentence explaining its own absence beside a catalogue that
       loaded. */
    await show(
      portOver([pack()], {
        clipUsage: async () => {
          throw new Error('no store here')
        },
      }),
    )
    expect(screen.queryByRole('button', { name: 'Forget them' })).toBeNull()
  })

  it('does not start a second forget while the first is in flight', async () => {
    /* ⚠️ THE REF AND NOT THE STATE: two presses before React commits the first
       both read the old value — the same defect `remove` records above. */
    let releases = 0
    const port = portOver([pack()], {
      clipUsage: async () => usage(),
      forgetClips: async () => {
        releases += 1
        await Promise.resolve()
        return { clips: 1, bytes: 1 }
      },
    })
    await show(port)
    const button = screen.getByRole('button', { name: 'Forget them' })
    /* ⚠️ **BOTH INSIDE ONE `act`, AND THIS CASE USED TO PRESS THEM APART — FOUND BY
       THE MUTATION SWEEP, which reported the ref lock and both of its assignments
       as survivors over a green test.** `fireEvent` wraps each call in its own
       `act`, so the first press committed `forgetting: true` and DISABLED the
       button: the second never reached the handler at all, and the state was the
       thing that refused it. The ref exists for the window state cannot close, and
       measuring it means closing that window in the test too. */
    await act(async () => {
      button.click()
      button.click()
    })
    expect(releases).toBe(1)
  })

  it('disables Forget while it is running, which is the only sign a reader gets', async () => {
    /* ⚠️ **THE STATE IS NOT THE LOCK — the ref is — SO NOTHING OBSERVED THE STATE
       AT ALL, and the sweep reported `setForgetting(true)` as removable.** It is
       not redundant: a forget of five gigabytes is not instant, and the button
       going flat is the whole of what tells the reader the press landed. The ref
       refuses a second call and the state refuses a second PRESS; they answer
       different halves and only one of them is visible. */
    let release: () => void = () => {}
    const port = portOver([pack()], {
      clipUsage: async () => usage(),
      forgetClips: () =>
        new Promise<{ clips: number; bytes: number }>((resolve) => {
          release = () => resolve({ clips: 1, bytes: 1 })
        }),
    })
    await show(port)
    const button = () => screen.getByRole('button', { name: 'Forget them' })
    expect(button().hasAttribute('disabled'), 'live before the press').toBe(false)

    await act(async () => {
      button().click()
    })
    expect(button().hasAttribute('disabled'), 'flat while it runs').toBe(true)

    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(button().hasAttribute('disabled'), 'live again afterwards').toBe(false)
  })

  it('forgets through the port it has NOW, not the one it was built with', async () => {
    /* ⚠️ **THE DEPENDENCY LIST AGAIN, on the other callback** — a pane memoised
       against the first port would send *forget everything* to a store that is not
       the reader's, and the row would go on showing disk that was never reclaimed. */
    const first = vi.fn(async () => ({ clips: 0, bytes: 0 }))
    const second = vi.fn(async () => ({ clips: 1, bytes: 1 }))
    const view = render(
      <VoicesPane
        port={portOver([pack()], { clipUsage: async () => usage(), forgetClips: first })}
        downloads={makeDownloads()}
      />,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    view.rerender(
      <VoicesPane
        port={portOver([pack()], { clipUsage: async () => usage(), forgetClips: second })}
        downloads={makeDownloads()}
      />,
    )
    await act(async () => {
      screen.getByRole('button', { name: 'Forget them' }).click()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(second, 'the new port was asked').toHaveBeenCalled()
    expect(first, 'and the old one was not').not.toHaveBeenCalled()
    view.unmount()
  })

  it('lets the reader forget again once the first has finished', async () => {
    /* ⚠️ **THE LOCK HAS TO BE GIVEN BACK, AND ONLY A SECOND PRESS AFTER THE FIRST
       SETTLES CAN SEE IT — FOUND BY THE MUTATION SWEEP.** A ref left `true` would
       disable Forget for the life of the pane: the row would keep showing disk the
       reader had asked to reclaim, and the only way back would be closing Settings
       and opening it again. Every other case here presses once, so the release was
       unobservable. */
    let releases = 0
    let held = usage()
    const port = portOver([pack()], {
      clipUsage: async () => held,
      forgetClips: async () => {
        releases += 1
        /* Still something there afterwards, so the button is not disabled for the
           OTHER reason and this case measures the lock rather than the count. */
        held = usage({ bytes: 1, clips: 1 })
        return { clips: 1, bytes: 1 }
      },
    })
    await show(port)
    const press = async () => {
      await act(async () => {
        screen.getByRole('button', { name: 'Forget them' }).click()
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    await press()
    expect(releases).toBe(1)
    await press()
    expect(releases, 'the lock was given back').toBe(2)
  })
})
