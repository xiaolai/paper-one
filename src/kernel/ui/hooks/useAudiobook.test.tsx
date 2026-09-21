// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAudiobook, type AudiobookControl, type AudiobookDeps } from './useAudiobook'
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

const VOICE: VoiceFacts = {
  name: 'Samantha',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.compact.en-US.Samantha',
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
  return { seen, say, rerender: () => view.rerender(<Probe />) }
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

describe('a book with no voice this app would choose', () => {
  it('refuses rather than exporting in whatever the platform has', async () => {
    /* Reading aloud may fall through to the platform default — a fair bargain for
       a few paragraphs somebody can stop. A long render in an unexpected voice is
       not the same bargain. */
    const { seen, say } = mount({ voices: [] })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(expect.stringContaining('No installed voice'))
  })

  it('refuses a remote voice, which is the privacy half of the same rule', async () => {
    const { seen, say } = mount({ voices: [{ ...VOICE, localService: false }] })
    await act(async () => {
      seen[0]?.run()
    })
    expect(say).toHaveBeenCalledWith(expect.stringContaining('No installed voice'))
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
