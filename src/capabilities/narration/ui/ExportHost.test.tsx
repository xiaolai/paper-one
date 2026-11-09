// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KernelServices,
  ReaderContext,
  ReadingSurface,
  ReadyBook,
  SpeechEnginePort,
  VoicePack,
} from '../../../kernel'
import type { NarrationEngine } from '../lib/wire'
import { currentControl } from '../lib/running'
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
  return { bookId: 'book:1', title: 'Le Horla', author: 'Maupassant', lang: 'en', toc: [], fixedLayout: false, sectionTexts: walk, ...over }
}

function mount({
  book = bookOf() as ReadyBook | null,
  port = portOf() as SpeechEnginePort | null,
  /* Null for "no voice context": an `undefined` argument would take the default. */
  voice = { chosen: {}, rate: 1, notesAloud: false } as NonNullable<ReaderContext['voice']> | null,
} = {}) {
  const { surface, set } = surfaceOf(book)
  const notify = vi.fn()
  let bound = port
  const servicesWith = (tell: (text: string) => void) =>
    ({ speechEngines: () => bound, notify: tell }) as unknown as KernelServices
  let services = servicesWith(notify)
  const context = (over: Partial<ReaderContext> = {}): ReaderContext => ({
    sectionKey: null,
    surface,
    ...(voice ? { voice } : {}),
    ...over,
  })
  const view = render(<ExportHost context={context()} services={services} />)
  return {
    notify,
    set,
    view,
    redraw: (over: Partial<ReaderContext>) => view.rerender(<ExportHost context={context(over)} services={services} />),
    /** A port bound after the host mounted, as the voices' `start` binds one; seen at the next render. */
    bindPort: (next: SpeechEnginePort | null) => {
      bound = next
    },
    /** The kernel's services handed again as a new object, with its own notice line. */
    rehost: (tell: (text: string) => void) => {
      services = servicesWith(tell)
      view.rerender(<ExportHost context={context()} services={services} />)
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
  it('reads with the skip the reading reads with', async () => {
    const held = heldWalk()
    const { redraw } = mount({ book: bookOf(held.walk) })
    redraw({ voice: { chosen: {}, rate: 1, notesAloud: true } })
    await act(async () => currentControl()?.run())
    expect(held.seen.skip).toEqual({ notes: true })
    await act(async () => held.finish(true))
  })

  it('leaves the notes out when there is no voice context', async () => {
    /* The voice's own default: an unset choice reads as no notes. */
    const held = heldWalk()
    mount({ book: bookOf(held.walk), voice: null })
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
    redraw({})
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

describe('the voice and pace it exports in', () => {
  it('is the voice the reader chose for the language, at the pace they read at', async () => {
    /* A second voice, so the choice is visible: without it the export takes the
       pack's first voice. */
    const pack: VoicePack = {
      ...PACK,
      voices: [...PACK.voices, { id: 'am_adam', name: 'Adam', language: 'en-US', note: '' }],
    }
    const jobs: { voice: string; rate: number }[] = []
    dialog.picks = true
    dialog.platform = {
      scratchFor: (index: number) => `scratch-${index}`,
      render: async (job: { voice: string; rate: number }) => {
        jobs.push({ voice: job.voice, rate: job.rate })
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
    const port = { ...portOf(), catalogue: async () => [pack] } as unknown as SpeechEnginePort
    const sections = [{ index: 0, title: 'One', text: 'Words.', textDigest: 'd' }]
    mount({
      port,
      book: bookOf(async () => ({ sections, complete: true })),
      voice: { chosen: { en: 'kokoro:am_adam' }, rate: 1.5, notesAloud: false },
    })
    await act(async () => currentControl()?.run())
    expect(jobs).toEqual([{ voice: 'kokoro:am_adam', rate: 1.5 }])
  })
})
