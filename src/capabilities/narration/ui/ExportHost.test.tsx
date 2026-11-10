// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSettingsStore,
  KERNEL_SETTINGS,
  scopeSettings,
  type KernelServices,
  type ReaderContext,
  type ReadingSurface,
  type ReadyBook,
  type SettingsStore,
  type SpeechEnginePort,
  type VoicePack,
} from '../../../kernel'
import type { NarrationEngine } from '../lib/wire'
import { currentControl } from '../lib/running'
import { chooseVoice, NOTES_ALOUD_SETTING, setRate } from '../lib/settings'
import { ExportHost } from './ExportHost'

/* THE SAVE DIALOG IS THE ONLY THING REPLACED, and nothing here gets past it:
   an export that does has passed every refusal this file is about. The walk
   comes before the pick, so every case below reaches its walk. */
const dialog = vi.hoisted(() => ({
  asked: 0,
  /** Whether the reader picks a destination; most cases cancel. */
  picks: false,
  /** The engine the host handed the platform, once a case gets that far. */
  engine: null as unknown,
  /** The platform handed back, for a case that goes past the engine; otherwise the export stops there. */
  platform: null as unknown,
}))
vi.mock('../lib/wire', () => ({
  pickDestination: async () => {
    dialog.asked += 1
    return dialog.picks ? { token: 'destination:1', name: 'Le Horla.m4b' } : null
  },
  releaseDestination: async () => {},
  narrationPlatform: async (_packs: unknown, engine: unknown) => {
    dialog.engine = engine
    if (dialog.platform) return dialog.platform
    throw new Error('the test goes no further than the engine')
  },
}))

/**
 * What this file pins is the HOST: what it reads from the reader and the
 * kernel, and what it publishes for the palette row. The export itself is
 * `useAudiobook.test.tsx`'s subject.
 *
 * ⚠️ **THE SURFACE IS A FAKE**, because a capability reaches the reader only
 * through the kernel's index, which does not export the real one. That the
 * real surface stops a walk when another book opens is pinned where the
 * surface is — `readingSurface.test.tsx`, "a walk of the book".
 */

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

/** The voices' port, as much of it as the host reads. */
function portOf({ renders = true } = {}): SpeechEnginePort {
  return {
    catalogue: async () => [PACK],
    findClip: async () => null,
    holdClips: async (stems: readonly string[]) => stems.length,
    ...(renders ? { renderFile: async () => ({ sampleRate: 24_000, skipped: [] }) } : {}),
  } as unknown as SpeechEnginePort
}

/** A walk the test holds open, which is where a stop can land. */
function heldWalk() {
  let open!: (walk: Awaited<ReturnType<ReadyBook['sectionTexts']>>) => void
  const seen: { stop?: () => boolean; skip?: unknown } = {}
  const walk: ReadyBook['sectionTexts'] = (stop, skip) => {
    seen.stop = stop
    seen.skip = skip
    return new Promise((resolve) => {
      open = resolve
    })
  }
  return { walk, seen, finish: (complete: boolean) => open({ sections: [], complete }) }
}

/** A surface whose book the test sets, telling its listeners as the real one does. */
function surfaceOf(first: ReadyBook | null) {
  let book = first
  const listeners = new Set<() => void>()
  const surface = {
    book: () => book,
    subscribeBook: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as ReadingSurface
  const set = (next: ReadyBook | null) => {
    book = next
    for (const listener of listeners) listener()
  }
  return { surface, set }
}

function bookOf(walk: ReadyBook['sectionTexts'] = async () => ({ sections: [], complete: true }), over: Partial<ReadyBook> = {}): ReadyBook {
  return { bookId: 'book:1', title: 'Le Horla', author: 'Maupassant', lang: 'en', toc: [], fixedLayout: false, live: () => true, sectionTexts: walk, ...over }
}

/** Narration's own settings, as the registry hands them to its `start`. */
function narrationSettings(): SettingsStore {
  return scopeSettings(createSettingsStore({ storage: null }), 'narration')
}

function mount({
  book = bookOf() as ReadyBook | null,
  port = portOf() as SpeechEnginePort | null,
  settings = narrationSettings(),
} = {}) {
  const { surface, set } = surfaceOf(book)
  const notify = vi.fn()
  let bound = port
  const servicesWith = (tell: (text: string) => void) =>
    ({ speechEngines: () => bound, notify: tell }) as unknown as KernelServices
  let services = servicesWith(notify)
  const context: ReaderContext = { sectionKey: null, surface }
  const view = render(<ExportHost context={context} services={services} settings={settings} />)
  return {
    notify,
    set,
    view,
    settings,
    redraw: () => view.rerender(<ExportHost context={context} services={services} settings={settings} />),
    /** A port bound after the host mounted, as the voices' `start` binds one; seen at the next render. */
    bindPort: (next: SpeechEnginePort | null) => {
      bound = next
    },
    /** The kernel's services handed again as a new object, with its own notice line. */
    rehost: (tell: (text: string) => void) => {
      services = servicesWith(tell)
      view.rerender(<ExportHost context={context} services={services} settings={settings} />)
    },
  }
}

beforeEach(() => {
  dialog.asked = 0
  dialog.picks = false
  dialog.engine = null
  dialog.platform = null
})
afterEach(cleanup)

describe('the control it publishes', () => {
  it('draws nothing', () => {
    const { view } = mount()
    expect(view.container.innerHTML).toBe('')
  })

  it('offers no export until the book is ready', () => {
    const { set } = mount({ book: null })
    expect(currentControl()).toBeNull()
    act(() => set(bookOf()))
    expect(currentControl()).not.toBeNull()
  })

  it('offers none without the voices, which are what render a chapter', () => {
    mount({ port: null })
    expect(currentControl()).toBeNull()
  })

  it('offers none with a port that cannot render to a file', () => {
    mount({ port: portOf({ renders: false }) })
    expect(currentControl()).toBeNull()
  })

  it('withdraws its control when it goes', () => {
    const { view } = mount()
    expect(currentControl()).not.toBeNull()
    view.unmount()
    expect(currentControl(), 'no row reads a host that is gone').toBeNull()
  })
})

describe('the engine it hands the export', () => {
  it('is the voices port, every question passed through whole', async () => {
    /* The four members are the only road from the export to the voices' store:
       a `findClip` that answered nothing would render every chapter again, and
       a `holdClips` that held nothing would lose a chapter to eviction. */
    const asked: unknown[] = []
    const port = {
      catalogue: async () => [PACK],
      findClip: async (request: unknown) => {
        asked.push(['findClip', request])
        return null
      },
      holdClips: async (stems: readonly string[], hold: boolean) => {
        asked.push(['holdClips', stems, hold])
        return stems.length
      },
      renderFile(this: unknown, request: unknown) {
        asked.push(['renderFile', request, this === port])
        return Promise.resolve({ sampleRate: 24_000, skipped: [] })
      },
    } as unknown as SpeechEnginePort
    dialog.picks = true
    const sections = [{ index: 0, title: 'One', text: 'Words.', textDigest: 'd' }]
    const { notify } = mount({ port, book: bookOf(async () => ({ sections, complete: true })) })
    await act(async () => currentControl()?.run())
    expect(notify).toHaveBeenLastCalledWith('The export failed: the test goes no further than the engine')

    const engine = dialog.engine as NarrationEngine
    await expect(engine.catalogue()).resolves.toEqual([PACK])
    const request = { packId: 'p', voiceId: 'v', text: 'x', clip: { bookId: 'b', section: 0, textDigest: 'd' } }
    await expect(engine.findClip(request)).resolves.toBeNull()
    await expect(engine.holdClips(['a-0-x'], true)).resolves.toBe(1)
    const render = { packId: 'p', voiceId: 'v', text: 'x', rate: 1, run: 'r', index: 0 }
    await expect(engine.renderFile(render as never)).resolves.toEqual({ sampleRate: 24_000, skipped: [] })
    expect(asked).toEqual([
      ['findClip', request],
      ['holdClips', ['a-0-x'], true],
      ['renderFile', render, true],
    ])
  })
})

describe('an export through the surface', () => {
  it('reads with the skip the reading reads with, as the reader sets it', async () => {
    /* Set AFTER the host mounted, through the store: the export follows the
       settings as they are, not as they were when the window opened. */
    const held = heldWalk()
    const { settings } = mount({ book: bookOf(held.walk) })
    act(() => settings.set(NOTES_ALOUD_SETTING, true))
    await act(async () => currentControl()?.run())
    expect(held.seen.skip).toEqual({ notes: true })
    await act(async () => held.finish(true))
  })

  it('leaves the notes out when the reader has not asked for them', async () => {
    /* The setting's own default: an unset choice reads as no notes. */
    const held = heldWalk()
    mount({ book: bookOf(held.walk) })
    await act(async () => currentControl()?.run())
    expect(held.seen.skip).toEqual({ notes: false })
    await act(async () => held.finish(true))
  })

  it('is stopped by the reader, through the walk, and says so on the notice line', async () => {
    const held = heldWalk()
    const { notify } = mount({ book: bookOf(held.walk) })
    await act(async () => currentControl()?.run())
    expect(held.seen.stop?.()).toBe(false)
    await act(async () => currentControl()?.run())
    expect(held.seen.stop?.(), 'the same command stops it').toBe(true)
    await act(async () => held.finish(false))
    expect(notify).toHaveBeenLastCalledWith('The export was stopped. Nothing was left behind.')
  })

  it('is refused, not written, when the walk comes back incomplete', async () => {
    /* ⚠️ **OR THE NEXT BOOK'S WORDS WOULD BE FILED UNDER THIS ONE'S TITLE.** The
       surface ends the walk incomplete once another book opens. */
    const held = heldWalk()
    const { notify } = mount({ book: bookOf(held.walk) })
    await act(async () => currentControl()?.run())
    await act(async () => held.finish(false))
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('stopped being readable'))
    expect(dialog.asked, 'no destination is asked for').toBe(0)
  })

  it('keeps its control while it runs, across a book change', async () => {
    const held = heldWalk()
    const { set } = mount({ book: bookOf(held.walk) })
    await act(async () => currentControl()?.run())
    act(() => set(bookOf(undefined, { bookId: 'book:2' })))
    expect(currentControl()?.running).toBe(true)
    expect(held.seen.stop?.(), 'the same opening').toBe(false)
    await act(async () => held.finish(true))
  })
})

describe('what it follows after it mounts', () => {
  it('takes up a port bound after it mounted', () => {
    const { bindPort, redraw } = mount({ port: null })
    expect(currentControl()).toBeNull()
    bindPort(portOf())
    redraw()
    expect(currentControl(), 'the voices started after the window did').not.toBeNull()
  })

  it('tells the notice line it holds now, not the one it was first handed', async () => {
    const held = heldWalk()
    const { notify, rehost } = mount({ book: bookOf(held.walk) })
    const later = vi.fn()
    rehost(later)
    await act(async () => currentControl()?.run())
    expect(later).toHaveBeenCalledWith('Reading the book…')
    expect(notify).not.toHaveBeenCalled()
    await act(async () => held.finish(true))
  })
})

/** The pack with a second voice, so a choice is visible: without one the export takes the pack's first voice. */
const TWO_VOICES: VoicePack = {
  ...PACK,
  voices: [...PACK.voices, { id: 'am_adam', name: 'Adam', language: 'en-US', note: '' }],
}

/** A platform that records the first job it is asked to render and goes no further. */
function stopsAtFirstRender(seen: (job: { voice: string; rate: number }) => void) {
  return {
    scratchFor: (index: number) => `scratch-${index}`,
    render: async (job: { voice: string; rate: number }) => {
      seen(job)
      throw new Error('the test goes no further than the first render')
    },
    releaseClips: async () => {},
    package: async () => {
      throw new Error('not reached')
    },
    discard: async () => {},
    discardBook: async () => 'removed' as const,
    discardScratch: async () => {},
    exists: async () => false,
  }
}

describe('the voice and pace it exports in', () => {
  it('is the voice the reader chose for the language, at the pace they read at', async () => {
    const jobs: { voice: string; rate: number }[] = []
    dialog.picks = true
    dialog.platform = stopsAtFirstRender((job) => jobs.push({ voice: job.voice, rate: job.rate }))
    const port = { ...portOf(), catalogue: async () => [TWO_VOICES] } as unknown as SpeechEnginePort
    const sections = [{ index: 0, title: 'One', text: 'Words.', textDigest: 'd' }]
    const settings = narrationSettings()
    chooseVoice(settings, 'en', 'kokoro:am_adam')
    setRate(settings, 1.5)
    mount({ port, settings, book: bookOf(async () => ({ sections, complete: true })) })
    await act(async () => currentControl()?.run())
    expect(jobs).toEqual([{ voice: 'kokoro:am_adam', rate: 1.5 }])
  })

  it('follows a voice chosen after it mounted, and keeps its command through any other setting', async () => {
    /* ⚠️ The voice map is memoised on its own stored value, so it has two ways
       to be wrong: never moving, which exports in a voice the reader has
       left, and moving with every setting, which hands the palette a new
       command whenever the theme changes. Both are asked here. */
    const jobs: string[] = []
    dialog.picks = true
    dialog.platform = stopsAtFirstRender((job) => jobs.push(job.voice))
    const port = { ...portOf(), catalogue: async () => [TWO_VOICES] } as unknown as SpeechEnginePort
    const sections = [{ index: 0, title: 'One', text: 'Words.', textDigest: 'd' }]
    const underneath = createSettingsStore({ storage: null })
    const settings = scopeSettings(underneath, 'narration')
    mount({ port, settings, book: bookOf(async () => ({ sections, complete: true })) })
    const first = currentControl()
    act(() => underneath.set(KERNEL_SETTINGS.theme, 'night'))
    expect(currentControl(), 'a theme change is not a new export').toBe(first)
    act(() => chooseVoice(settings, 'en', 'kokoro:am_adam'))
    expect(currentControl(), 'a new voice is').not.toBe(first)
    await act(async () => currentControl()?.run())
    expect(jobs).toEqual(['kokoro:am_adam'])
  })
})
