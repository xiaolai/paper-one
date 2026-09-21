// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAudiobook, type AudiobookControl, type AudiobookDeps } from './useAudiobook'
import { NO_GOOD_VOICE } from '../reader/voiceChoice'
import type { VoiceFacts } from '../reader/voiceChoice'

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
