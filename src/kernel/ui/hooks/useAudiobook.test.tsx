// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  audiobookSourceOf,
  useAudiobook,
  type AudiobookControl,
  type AudiobookDeps,
  type AudiobookSource,
} from './useAudiobook'
import { NO_GOOD_VOICE } from '../reader/voiceChoice'
import type { VoiceFacts } from '../reader/voiceChoice'
import type { AudiobookPlatform } from '../reader/audiobook'
import type { VoicePack } from '../../core/ports'

/* THE PLATFORM HALF IS THE ONLY THING REPLACED. `audiobookTauri` is the save
   dialog and the engine, neither of which exists in a test; `exportAudiobook`
   — the ordering, the cancellation, the tidy-up count — is the real one, so
   what the reader is told is what the real export would make them hear. */
const tauri = vi.hoisted(() => ({
  path: null as string | null,
  platform: null as AudiobookPlatform | null,
  asked: [] as string[],
  opened: 0,
  /** The packs `tauriAudiobook` was given, so routing can be asserted. */
  packs: [] as readonly unknown[],
}))
vi.mock('../reader/audiobookTauri', () => ({
  chooseAudiobookPath: async (title: string) => {
    tauri.asked.push(title)
    return tauri.path
  },
  tauriAudiobook: async (packs: readonly unknown[] = []) => {
    tauri.opened += 1
    tauri.packs = packs
    if (!tauri.platform) throw new Error('the test named no platform')
    return tauri.platform
  },
}))

beforeEach(() => {
  tauri.path = null
  tauri.platform = null
  tauri.asked = []
  tauri.opened = 0
  tauri.packs = []
})

/**
 * The hook had NO test, which is why a stale closure in its consumer was
 * invisible: `App`'s `commands` memo read `audiobook` and did not declare it,
 * because a fresh object per render would have rebuilt every command on every
 * render — and a position update is a render.
 *
 * What is pinned here is the property that makes the dependency declarable: the
 * control keeps its identity while nothing about it has changed, and takes a new
 * one the moment `running` does.
 */

afterEach(cleanup)

/* ABOVE THE FLOOR — see `voiceChoice.ts`. A compact voice, which is all a Mac's
   WebView offers, is refused, and so is the export. */
const VOICE: VoiceFacts = {
  name: 'Zoe',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.enhanced.en-US.Zoe',
  localService: true,
}

function mount(over: Partial<AudiobookDeps> = {}) {
  const seen: (AudiobookControl | null)[] = []
  const say = vi.fn()
  const deps: AudiobookDeps = {
    available: true,
    /* No pack, so every existing case still measures the platform voice and
     * the floor exactly as it did. The pack cases below supply their own. */
    packs: [],
    source: {
      title: 'A Measured Book',
      author: 'Paper',
      lang: 'en-US',
      toc: [],
      fixedLayout: false,
      skip: { notes: false },
      sectionTexts: vi.fn(async () => ({ sections: [], complete: true })),
    },
    voices: [VOICE],
    chosen: {},
    rate: 1,
    say,
    ...over,
  }
  function Probe() {
    seen.push(useAudiobook(deps))
    return null
  }
  const view = render(<Probe />)
  return {
    seen,
    say,
    rerender: () => view.rerender(<Probe />),
    /* CHANGES THE DEPS THE NEXT RENDER SEES. `deps` is the object the probe
       closes over, so mutating it is how a test says "the reader closed the
       book" — the same thing a new prop would do to the real component. */
    change: (next: Partial<AudiobookDeps>) => {
      Object.assign(deps, next)
      view.rerender(<Probe />)
    },
  }
}

describe('the control a consumer may depend on', () => {
  it('keeps its identity across a render that changed nothing', () => {
    /* ⚠️ **THIS IS THE PROPERTY THE OMITTED DEPENDENCY WAS AVOIDING.** Without
       it, declaring `audiobook` in `App`'s commands memo rebuilds every command
       on every render; with it, the declaration is free and honest. */
    const { seen, rerender } = mount()
    act(() => rerender())
    act(() => rerender())
    expect(seen.length).toBeGreaterThan(2)
    expect(seen[seen.length - 1]).toBe(seen[0])
  })

  it('is absent where the engine is not', () => {
    /* The transport and the palette both read absence, not a disabled flag. */
    expect(mount({ available: false }).seen[0]).toBeNull()
  })

  it('is absent with no book open', () => {
    expect(mount({ source: null }).seen[0]).toBeNull()
  })

  it('reports not running before anything starts', () => {
    expect(mount().seen[0]?.running).toBe(false)
  })
})

describe('a book laid out in fixed pages', () => {
  /**
   * ⚠️ **NOT EXPORTED AT ALL — the owner's decision, 2026-09-21.** A chapter is
   * a spine section and a PDF's sections are its pages, so the export wrote one
   * chapter per page and numbered the unnamed ones: "Chapter 7" for page seven,
   * which is the false claim `planChapters` says numbering must never make.
   */
  it('is refused, with the reason said, before anything is read', async () => {
    const read = vi.fn(async () => ({ sections: [], complete: true }))
    const { seen, say } = mount({
      source: {
        title: 'A Scanned Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: true,
        skip: { notes: false },
        sectionTexts: read,
      },
    })
    seen.at(-1)?.run()
    await act(async () => {})
    expect(say).toHaveBeenCalledWith(
      'A book of fixed pages cannot be exported as an audiobook — its pages are not chapters.',
    )
    expect(read, 'the book was read before the refusal').not.toHaveBeenCalled()
    expect(seen.at(-1)?.running, 'the refusal left an export running').toBe(false)
  })

  it('is still offered, so the reader can be told why', () => {
    /* An absent row for the book in front of them is a question with no
       answer — the control exists and refuses. */
    const { seen } = mount({
      source: {
        title: 'A Scanned Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: true,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => ({ sections: [], complete: true })),
      },
    })
    expect(seen.at(-1)).not.toBeNull()
  })
})

describe('a book with no voice this app would choose', () => {
  it('refuses a book whose only voices are below the floor — the Mac, as measured', async () => {
    const compact = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }
    const { seen, say } = mount({ voices: [compact] })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(NO_GOOD_VOICE)
  })

  it('refuses a remote voice, which is the privacy half of the same rule', async () => {
    const { seen, say } = mount({ voices: [{ ...VOICE, localService: false }] })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(NO_GOOD_VOICE)
  })

  it('says the voices have not arrived, rather than sending the reader to Settings', async () => {
    /* An engine that has listed nothing yet: a render needs a voice named, and
       there is nothing in Settings to name. */
    const { seen, say } = mount({ voices: [] })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith('No voices are available yet — try again in a moment.')
  })

  it('asks for a voice to be named for a book that declares no language', async () => {
    const { seen, say } = mount({
      source: {
        title: 'An Unlabelled Book',
        author: 'Paper',
        lang: null,
        toc: [],
        fixedLayout: false,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => ({ sections: [], complete: true })),
      },
    })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(
      'This book does not say what language it is in — choose a voice for it in Settings first.',
    )
  })
})

describe('two calls before React has committed anything', () => {
  /**
   * ⚠️ **`running` IS A RENDER SNAPSHOT AND WAS USED AS A LOCK.** Two calls before
   * `setRunning(true)` commits both read `false` and both start an export, sharing
   * one `stop` flag so either cancels the other — and until each got its own
   * scratch directory, deleting each other's chapters. A palette row and an
   * accelerator firing together is enough to do it.
   */
  it('starts one export, not two', async () => {
    const reads: number[] = []
    let calls = 0
    const { seen, say } = mount({
      source: {
        title: 'A Measured Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: false,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => {
          calls += 1
          reads.push(calls)
          return { sections: [], complete: true }
        }),
      },
    })
    /* BOTH inside one act, so no render commits between them — which is exactly
       the window a state flag cannot close. */
    await act(async () => {
      seen[0]?.run()
      seen[0]?.run()
    })
    expect(calls).toBe(1)
    /* The second call is a STOP, because the first is in flight. */
    expect(say).toHaveBeenCalledWith(expect.stringContaining('Stopping the export'))
  })
})

describe('a walk that did not finish', () => {
  /**
   * ⚠️ **A PARTIAL WALK USED TO BE EXPORTED AS A FINISHED BOOK.**
   * `ReaderSession.sectionTexts` stops when the book closes or is replaced, and
   * returned a bare array either way — so a book closed part way through was
   * written out complete-looking, missing everything after the section it reached.
   * A short file is indistinguishable from a short book, which is exactly the trap
   * `narrate` records for an empty buffer arriving mid-stream.
   */
  it('refuses rather than exporting what it managed to read', async () => {
    const { seen, say } = mount({
      source: {
        title: 'A Measured Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: false,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => ({
          sections: [{ index: 0, title: 'One', text: 'Some real text.' }],
          complete: false,
        })),
      },
    })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(expect.stringContaining('stopped being readable'))
    /* And it must not have gone on to ask for a destination. */
    expect(say).not.toHaveBeenCalledWith(expect.stringContaining('Exported'))
  })

  it('exports when the walk did finish', async () => {
    /* So the refusal cannot pass by refusing everything. */
    const { seen, say } = mount({
      source: {
        title: 'A Measured Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: false,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => ({
          sections: [{ index: 0, title: 'One', text: 'Some real text.' }],
          complete: true,
        })),
      },
    })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).not.toHaveBeenCalledWith(expect.stringContaining('stopped being readable'))
    /* And it went on to ask where the book should go — the step a refusal
       would never reach. */
    expect(tauri.asked).toEqual(['A Measured Book'])
  })
})

describe('a book with nothing to read', () => {
  it('says so instead of writing an empty file', async () => {
    const { seen, say } = mount()
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(expect.stringContaining('no text to read aloud'))
  })
})

describe('the control while an export is under way', () => {
  /**
   * ⚠️ **CLOSING THE BOOK TOOK THE ONLY STOP AWAY AND LEFT THE EXPORT RUNNING.**
   * The hook ended `if (!available || !source) return null`, so a book closed
   * mid-export removed the palette row that stops it while the operation carried
   * on — reading, rendering and writing a file the reader could no longer reach
   * — and with `source` gone they could not start another to get the row back.
   *
   * The export captures everything it needs when it begins and never reads
   * `source` again, which is exactly why it survives the book closing, and
   * exactly why its control has to.
   */
  it('keeps the stop control when the book closes part way through', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const harness = mount({
      source: {
        title: 'A Measured Book',
        author: 'Paper',
        lang: 'en-US',
        toc: [],
        fixedLayout: false,
        skip: { notes: false },
        sectionTexts: vi.fn(async () => {
          await held
          return { sections: [], complete: true }
        }),
      },
    })

    const latest = () => harness.seen[harness.seen.length - 1]
    await act(async () => {
      latest()?.run()
    })
    expect(latest()?.running, 'the export is under way').toBe(true)

    await act(async () => {
      harness.change({ source: null })
    })
    expect(latest(), 'and the control is still there to stop it').not.toBeNull()

    await act(async () => {
      release()
      await held
    })
  })

  it('is absent once it has finished and the book is gone', () => {
    /* The survival above is for a RUNNING export and nothing wider: with nothing
       under way there is no operation to stop, so absence is right again. */
    const harness = mount()
    act(() => harness.change({ source: null }))
    expect(harness.seen[harness.seen.length - 1]).toBeNull()
  })
})

/* TWO CHAPTERS, the second at spine index 2 — so a scratch path built from the
   position in the list rather than the section's own index would show. */
const SECTIONS = [
  { index: 0, title: 'One', text: 'The first chapter.' },
  { index: 2, title: 'Two', text: 'The second chapter.' },
]
const WHERE = '/books/A Measured Book.m4b'

function book(over: Partial<AudiobookSource> = {}): AudiobookSource {
  return {
    title: 'A Measured Book',
    author: 'A. Writer',
    lang: 'en-US',
    toc: [],
    fixedLayout: false,
    skip: { notes: false },
    sectionTexts: vi.fn(async () => ({ sections: SECTIONS, complete: true })),
    ...over,
  }
}

/**
 * An engine that does what it is told and writes down what it was told.
 * `hold` makes a chapter's render wait for the test, which is how a test stands
 * between two chapters — the only place a stop can land.
 */
function engine(over: Partial<AudiobookPlatform> = {}) {
  const rendered: Parameters<AudiobookPlatform['render']>[0][] = []
  const packaged: Parameters<AudiobookPlatform['package']>[0][] = []
  const discarded: string[] = []
  const platform: AudiobookPlatform = {
    render: async (job) => {
      rendered.push(job)
    },
    package: async (job) => {
      packaged.push(job)
      return { durationMs: 180_000, chapters: job.chapters.length }
    },
    scratchFor: (index) => `/scratch/chapter-${index}.wav`,
    discard: async (path) => {
      discarded.push(path)
    },
    discardScratch: async () => {},
    ...over,
  }
  tauri.platform = platform
  tauri.path = WHERE
  return { rendered, packaged, discarded }
}

/** A promise the test resolves, and the function that resolves it. */
function gate() {
  let open = () => {}
  const shut = new Promise<void>((resolve) => {
    open = resolve
  })
  return { shut, open }
}

describe('an export that runs to the end', () => {
  it('tells the reader each step, and names the file it wrote', async () => {
    engine()
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    /* EXACTLY these, in this order: the progress line counts from one and
       reports the chapter it is ABOUT to read, and the last step is named for
       what it does rather than as a third chapter of two. */
    expect(say.mock.calls.map(([line]) => line)).toEqual([
      'Reading the book…',
      'Reading One — 1 of 2…',
      'Reading Two — 2 of 2…',
      'Joining the chapters…',
      'Exported 2 chapters, 3 minutes, to A Measured Book.m4b.',
    ])
  })

  it('renders in the voice the reading would use, at the reader’s rate, into the book’s own name', async () => {
    const { rendered, packaged } = engine()
    const { seen } = mount({ source: book(), rate: 1.25 })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(rendered).toEqual([
      { text: 'The first chapter.', voice: VOICE.voiceURI, rate: 1.25, path: '/scratch/chapter-0.wav' },
      { text: 'The second chapter.', voice: VOICE.voiceURI, rate: 1.25, path: '/scratch/chapter-2.wav' },
    ])
    expect(packaged).toEqual([
      {
        chapters: [
          { title: 'One', path: '/scratch/chapter-0.wav' },
          { title: 'Two', path: '/scratch/chapter-2.wav' },
        ],
        title: 'A Measured Book',
        author: 'A. Writer',
        path: WHERE,
      },
    ])
  })

  it('reads the settings as they are when it starts, not as they were at the first render', async () => {
    /* ⚠️ A callback that captured its first render's deps would render at the
       rate the reader had BEFORE they changed it — and export the book in a
       voice they had since moved away from. */
    const { rendered } = engine()
    const harness = mount({ source: book() })
    act(() => harness.change({ rate: 1.5 }))
    await act(async () => {
      harness.seen.at(-1)?.run()
    })
    expect(rendered.map((job) => job.rate)).toEqual([1.5, 1.5])
  })

  it('is running while it works, and not once it has finished', async () => {
    const held = gate()
    engine({ render: () => held.shut })
    const { seen } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(seen.at(-1)?.running).toBe(true)
    await act(async () => {
      held.open()
    })
    expect(seen.at(-1)?.running).toBe(false)
  })

  it('can be run again once it has finished, and the second run is an export, not a stop', async () => {
    /* ⚠️ THE CLAIM AND THE STOP ARE RELEASED TOGETHER, in one `finally`. Left
       claimed, the second run would be read as "stop the one in flight"; left
       stopped, it would cancel itself at the first chapter. */
    engine()
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(say.mock.calls.filter(([line]) => String(line).startsWith('Exported'))).toHaveLength(2)
    expect(say).not.toHaveBeenCalledWith(expect.stringContaining('Stopping'))
  })
})

describe('scratch the tidy-up could not remove', () => {
  it('says one file, when one would not go', async () => {
    engine({
      discard: async (path) => {
        if (path === '/scratch/chapter-0.wav') throw new Error('in use')
      },
    })
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(say).toHaveBeenLastCalledWith(
      'Exported 2 chapters, 3 minutes, to A Measured Book.m4b. One temporary audio file could not be removed.',
    )
  })

  it('says how many, when more than one would not go', async () => {
    engine({
      discard: async () => {
        throw new Error('in use')
      },
    })
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(say).toHaveBeenLastCalledWith(
      'Exported 2 chapters, 3 minutes, to A Measured Book.m4b. 2 temporary audio files could not be removed.',
    )
  })
})

describe('a stop the reader asks for', () => {
  it('while the book is being read, stops before asking where to save it', async () => {
    const held = gate()
    let shouldStop: (() => boolean) | undefined
    engine()
    const { seen, say } = mount({
      source: book({
        sectionTexts: vi.fn(async (_toc, stopAsked) => {
          shouldStop = stopAsked
          await held.shut
          return { sections: SECTIONS, complete: true }
        }),
      }),
    })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(shouldStop?.(), 'the walk was told to stop before anything asked it to').toBe(false)

    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(say).toHaveBeenLastCalledWith('Stopping the export after this chapter…')
    /* THE STOP REACHES THE WALK, so a long book stops parsing rather than
       reading every remaining section to be thrown away. */
    expect(shouldStop?.(), 'the walk was never told').toBe(true)

    await act(async () => {
      held.open()
    })
    expect(say).toHaveBeenLastCalledWith('The export was stopped. Nothing was left behind.')
    expect(tauri.asked, 'a stopped export still asked for a file name').toEqual([])
    expect(seen.at(-1)?.running).toBe(false)
  })

  it('between chapters, renders no more of them and removes what it wrote', async () => {
    const held = gate()
    const rendered: string[] = []
    const { discarded } = engine({
      render: async (job) => {
        rendered.push(job.path)
        await held.shut
      },
    })
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    await act(async () => {
      seen.at(-1)?.run()
    })
    await act(async () => {
      held.open()
    })
    expect(rendered).toEqual(['/scratch/chapter-0.wav'])
    expect(discarded).toEqual(['/scratch/chapter-0.wav'])
    expect(say).toHaveBeenLastCalledWith('The export was stopped. Nothing was left behind.')
  })

  it('says what it could not remove, rather than claiming nothing was left', async () => {
    const held = gate()
    engine({
      render: () => held.shut,
      discard: async () => {
        throw new Error('in use')
      },
    })
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    await act(async () => {
      seen.at(-1)?.run()
    })
    await act(async () => {
      held.open()
    })
    expect(say).toHaveBeenLastCalledWith(
      'The export was stopped. One temporary audio file could not be removed.',
    )
  })
})

describe('an export the engine refuses', () => {
  it('says the engine’s own sentence, and is no longer running', async () => {
    engine({
      render: async () => {
        throw new Error('the voice stalled on chapter 1')
      },
    })
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(say).toHaveBeenLastCalledWith('The export failed: the voice stalled on chapter 1')
    expect(seen.at(-1)?.running).toBe(false)
  })
})

describe('a reader who closes the save dialog', () => {
  it('starts nothing and says nothing more', async () => {
    engine()
    tauri.path = null
    const { seen, say } = mount({ source: book() })
    await act(async () => {
      seen.at(-1)?.run()
    })
    expect(tauri.asked).toEqual(['A Measured Book'])
    expect(tauri.opened, 'the engine was opened for an export nobody asked for').toBe(0)
    expect(say.mock.calls.map(([line]) => line)).toEqual(['Reading the book…'])
    expect(seen.at(-1)?.running).toBe(false)
  })
})

describe('a control held past the book it was for', () => {
  it('does nothing once its export has ended and the book is gone', async () => {
    /* A consumer that kept the control — the palette's memo is one — holds a
       `run` built while the book was closed and the export still running. Once
       the export ends, that `run` is neither a stop nor a start: there is no book
       to export. */
    const held = gate()
    engine({ render: () => held.shut })
    const harness = mount({ source: book() })
    await act(async () => {
      harness.seen.at(-1)?.run()
    })
    act(() => harness.change({ source: null }))
    const kept = harness.seen.at(-1)
    expect(kept, 'the running export lost its control').not.toBeNull()
    await act(async () => {
      held.open()
    })
    const said = harness.say.mock.calls.length
    expect(() => kept?.run()).not.toThrow()
    expect(harness.say).toHaveBeenCalledTimes(said)
  })
})

/**
 * What the export is handed, from the book on screen.
 *
 * ⚠️ **EVERY FALLBACK HERE IS SOMETHING A READER SEES IN A FILE NAME OR A
 * PLAYER.** A book that declares no title still has to be called something, and
 * a book with no author must say nothing rather than something wrong — both
 * end up in the `.m4b`'s metadata and in Apple Books' library.
 */
describe('the source an export is built from', () => {
  const doc = () => {
    const made = document.implementation.createHTMLDocument('')
    made.documentElement.setAttribute('lang', 'fr')
    return made
  }
  const walk = () => Promise.resolve({ sections: [], complete: true })
  const book = (over: Partial<Parameters<typeof audiobookSourceOf>[0]> = {}) => ({
    bookId: 'book:1',
    doc: doc(),
    meta: { title: 'Le Horla', author: 'Maupassant' } as Parameters<typeof audiobookSourceOf>[0]['meta'],
    toc: [],
    fixedLayout: false,
    sectionTexts: walk,
    ...over,
  })

  it('is nothing until the book has both an identity and a document', () => {
    /* The id resolves from the bytes before the book is parsed, and a walk
       started then has no navigator to ask. */
    expect(audiobookSourceOf(book({ doc: null }), false), 'an id alone').toBeNull()
    expect(audiobookSourceOf(book({ bookId: null }), false), 'a document alone').toBeNull()
    expect(audiobookSourceOf(book(), false), 'both').not.toBeNull()
  })

  it('carries what the book declares, and the language of its document', () => {
    const one = book()
    expect(audiobookSourceOf(one, false)).toEqual({
      title: 'Le Horla',
      author: 'Maupassant',
      lang: 'fr',
      toc: one.toc,
      fixedLayout: false,
      sectionTexts: walk,
      skip: { notes: false },
    })
  })

  it('names a book that declares nothing, and credits nobody rather than somebody wrong', () => {
    expect(audiobookSourceOf(book({ meta: null }), false)).toMatchObject({ title: 'Audiobook', author: '' })
  })

  it('skips the notes the reading skips, and reads the ones it reads', () => {
    expect(audiobookSourceOf(book(), true)?.skip).toEqual({ notes: true })
    expect(audiobookSourceOf(book(), false)?.skip).toEqual({ notes: false })
  })
})

describe('exporting on a downloaded voice', () => {
  const ENGLISH: VoicePack = {
    id: 'english-kokoro',
    name: 'English',
    summary: '',
    family: 'kokoro',
    languages: ['en'],
    bytes: 336_822_660,
    minimumMemoryGb: 4,
    voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
    installed: true,
  }

  it('renders through the pack, naming the voice the way the reading stores it', async () => {
    /* ⚠️ THE STRING IS THE ROUTING. `audiobookTauri` reads its shape and sends
     * an engine-qualified name to the plugin and anything else to
     * `narrate_render`, so one stored choice serves the reading and the
     * export alike. */
    const { rendered } = engine()
    const { seen } = mount({ source: book(), packs: [ENGLISH] })
    await act(async () => {
      await seen[0]?.run()
    })
    expect(rendered.length).toBeGreaterThan(0)
    expect(new Set(rendered.map((job) => job.voice))).toEqual(new Set(['kokoro:af_heart']))
    expect(tauri.packs).toEqual([ENGLISH])
  })

  it('exports a book the platform floor would have refused outright', async () => {
    /* ⚠️ THE CASE THAT MAKES THIS FEATURE EXIST. Before a pack, every voice on
     * a Mac is below the floor and the export is simply off. */
    const compact = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }
    const { rendered } = engine()
    const { seen, say } = mount({ source: book(), voices: [compact], packs: [ENGLISH] })
    await act(async () => {
      await seen[0]?.run()
    })
    expect(say).not.toHaveBeenCalledWith(NO_GOOD_VOICE)
    expect(rendered.length).toBeGreaterThan(0)
  })

  it('still uses the platform voice where no pack reads the language', async () => {
    const { rendered } = engine()
    const { seen } = mount({ source: book(), packs: [{ ...ENGLISH, languages: ['zh'] }] })
    await act(async () => {
      await seen[0]?.run()
    })
    expect(rendered.length).toBeGreaterThan(0)
    expect(new Set(rendered.map((job) => job.voice))).toEqual(new Set([VOICE.voiceURI]))
  })

  it('names the pack that would give a refused book a voice', async () => {
    // Advice a reader can act on, where `NO_GOOD_VOICE` alone is a dead end.
    const compact = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }
    const { seen, say } = mount({ source: book(), voices: [compact], packs: [{ ...ENGLISH, installed: false }] })
    await act(async () => {
      await seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(expect.stringContaining('321 MB'))
  })
})
