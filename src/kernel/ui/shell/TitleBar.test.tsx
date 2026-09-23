// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../../core/metrics'
import type { Speech } from '../reader/useSpeech'
import { initialState } from '../state'
import { NO_GOOD_VOICE } from '../reader/voiceChoice'
import { TitleBar } from './TitleBar'

afterEach(cleanup)

/**
 * A reading that is not happening, spelled out in full.
 *
 * ⚠️ **NOT A CAST, AND THAT IS THE POINT.** `as unknown as Speech` would have
 * type-checked while missing every new member, and the transport would then have
 * read `undefined` at runtime — the exact defect the contribution-icon note
 * records, where a double cast hid a required field from `tsc` in two test files
 * and cost eight red suites. Adding a member to `Speech` should break this line.
 */
const speech: Speech = {
  available: false,
  speaking: false,
  paused: false,
  followsWords: false,
  chapters: { back: false, forward: false },
  start: () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  stepSentence: () => {},
  stepParagraph: () => {},
  stepChapter: () => {},
}

function bar(platform: Platform) {
  return render(
    <TitleBar
      screens={[]}
      state={initialState}
      dispatch={vi.fn()}
      platform={platform}
      bookTitle="Paper"
      bookSubtitle=""
      speech={speech}
      listenRefusal={null}
      hasBook={false}
    />,
  )
}

/**
 * ONE TITLEBAR OFF macOS. The shell turns the OS decorations off there
 * (`lib.rs` `setup`), so what this component draws is the window's ONLY
 * chrome: the three controls and the drag region are not a copy of the
 * caption above them any more — there is no caption — and this is what holds
 * them in place.
 */
describe('the titlebar off macOS', () => {
  it.each(['windows', 'linux'] as const)('draws the window controls on %s, because nothing else does', (platform) => {
    bar(platform)
    for (const name of ['Minimise', 'Maximise', 'Close']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })

  it('is a drag region, which is the only way to move a window with no caption', () => {
    const { container } = bar('linux')
    expect(container.firstElementChild?.hasAttribute('data-tauri-drag-region')).toBe(true)
  })

  it('draws no window controls on macOS, where AppKit paints the traffic lights', () => {
    bar('macos')
    for (const name of ['Minimise', 'Maximise', 'Close']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })
})

describe('the controls a contributed screen does not have', () => {
  /* ⚠️ **`WindowShell` AND `SidePane` ALREADY REFUSED TO DRAW A PANE THERE, AND
     THE CONTROLS DID NOT KNOW.** The titlebar kept an active "Close pane"
     button and ⌘\\ kept toggling, so both mutated a state nothing reflected —
     a lit control that does nothing, and a silent change to whether the pane
     came back on the way out. */

  it('draws no pane toggle on a capability’s screen', () => {
    render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, screen: 'circle:circle' }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(screen.queryByRole('button', { name: /pane/iu })).toBeNull()
  })

  it('still draws it on the kernel’s own screens', () => {
    // The refusal must not have taken the ordinary case with it.
    /* `chromeOn` for the reader: §06 fades the whole zone and marks it
       `inert` there until the pointer is near, and an inert subtree is
       invisible to a role query — correctly, since it is invisible to the
       reader too. */
    for (const which of ['library', 'reader'] as const) {
      cleanup()
      render(
        <TitleBar
          screens={[]}
          state={{ ...initialState, screen: which, chromeOn: true }}
          dispatch={vi.fn()}
          platform="macos"
          bookTitle="Paper"
          bookSubtitle=""
          speech={speech}
          listenRefusal={null}
          hasBook={false}
        />,
      )
      expect(screen.getByRole('button', { name: /pane/iu })).toBeTruthy()
    }
  })
})

describe('the reading speed button', () => {
  /**
   * ⚠️ **"FASTER" SKIPPED SPEEDS AND WENT SLOWER.** It advanced one step past the
   * NEAREST step, which is right on the ramp and wrong off it — and off it is the
   * case the nearest-match existed for, a rate stored by a build with another
   * ramp. `1.4` went to `1.75` over `1.5`, and `2.4` wrapped to `0.5` over `2.5`.
   */
  function tap(rate: number): number | undefined {
    const dispatch = vi.fn()
    render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, screen: 'reader', chromeOn: true, readingRate: rate }}
        dispatch={dispatch}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={{ ...speech, available: true, speaking: true }}
        listenRefusal={null}
        hasBook
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Reading speed/u }))
    const action = dispatch.mock.calls.at(-1)?.[0] as { type: string; rate?: number } | undefined
    return action?.type === 'setReadingRate' ? action.rate : undefined
  }

  it.each([
    [1, 1.25, 'on the ramp, the next step'],
    [1.4, 1.5, 'off the ramp, the first faster step — not one past the nearest'],
    [2.4, 2.5, 'near the top, the top — not a wrap to the slowest'],
    [2.5, 0.5, 'at the top, round to the slowest'],
    [9, 0.5, 'above the ramp entirely, round to the slowest'],
  ])('from %s goes to %s: %s', (from, to) => {
    expect(tap(from)).toBe(to)
  })
})

/**
 * NO VOICE RATHER THAN A BAD ONE — the Listen control says so before the press.
 *
 * On a Mac nothing clears the floor (see `voiceChoice.ts`), so the reading would
 * stop at its first sentence. The control is disabled instead, and its title
 * carries the reason, the way it already does for a build with no speech engine.
 */
describe('the Listen control when no voice is good enough', () => {
  function listen(listenRefusal: string | null): HTMLElement {
    render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, screen: 'reader', chromeOn: true }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={{ ...speech, available: true }}
        listenRefusal={listenRefusal}
        hasBook
      />,
    )
    return screen.getByRole('button', { name: 'Read aloud' })
  }

  it('is disabled and says why', () => {
    const button = listen(NO_GOOD_VOICE)
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('data-disabled')).toBe('true')
    expect(button.getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })

  it('carries whatever reason it was given, not one of its own', () => {
    /* ⚠️ THE REASON AND THE REFUSAL ARE ONE VALUE, so a control cannot be
     * disabled with nothing to say. What would fix it differs — a pack that
     * can be downloaded names itself and its size — and this component is not
     * where that is decided. */
    const button = listen('Download the English voice (321 MB) in Settings → Voices')
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toContain('321 MB')
  })

  it('reads the chapter when a voice is good enough', () => {
    const button = listen(null)
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('title')).toBe('Read this chapter aloud')
  })
})

/** The titlebar, with whatever state, speech and screens a case needs. */
function draw(
  over: {
    state?: Partial<typeof initialState>
    speech?: Speech
    screens?: React.ComponentProps<typeof TitleBar>['screens']
    hasBook?: boolean
  } = {},
) {
  const dispatch = vi.fn()
  render(
    <TitleBar
      screens={over.screens ?? []}
      state={{ ...initialState, ...over.state }}
      dispatch={dispatch}
      platform="macos"
      bookTitle="Paper"
      bookSubtitle=""
      speech={over.speech ?? speech}
      listenRefusal={null}
      hasBook={over.hasBook ?? false}
    />,
  )
  return dispatch
}

/** A reading in progress that records what the transport asked it to do. */
function listening(over: Partial<Speech> = {}) {
  const asked: string[] = []
  const reading: Speech = {
    ...speech,
    available: true,
    speaking: true,
    stop: () => asked.push('stop'),
    pause: () => asked.push('pause'),
    resume: () => asked.push('resume'),
    stepSentence: (by) => asked.push(`sentence ${by}`),
    stepParagraph: (by) => asked.push(`paragraph ${by}`),
    stepChapter: (by) => asked.push(`chapter ${by}`),
    ...over,
  }
  draw({ state: { screen: 'reader', chromeOn: true }, speech: reading, hasBook: true })
  return asked
}

/**
 * THE TRANSPORT, which is new on this branch and was drawn by no test.
 *
 * Every control here is a verb the reader presses while a book is being read
 * aloud, and each one is a different verb: a label on the wrong button, or a
 * step of the wrong size, is a control that does something other than what it
 * says.
 */
describe('the reading transport', () => {
  it.each([
    ['Previous sentence', 'sentence -1'],
    ['Next sentence', 'sentence 1'],
    ['Previous paragraph', 'paragraph -1'],
    ['Next paragraph', 'paragraph 1'],
    ['Stop reading aloud', 'stop'],
  ])('%s asks for %s', (name, expected) => {
    const asked = listening()
    fireEvent.click(screen.getByRole('button', { name }))
    expect(asked).toEqual([expected])
  })

  it('offers a chapter step only where there is a chapter to step to', () => {
    /* ⚠️ **ABSENT, NOT DISABLED.** A reader in a book whose contents does not
       name the section they are in has genuinely no next chapter — "not here"
       rather than "not now", which is what an absent control says. */
    listening({ chapters: { back: false, forward: false } })
    expect(screen.queryByRole('button', { name: 'Previous chapter' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next chapter' })).toBeNull()

    cleanup()
    const asked = listening({ chapters: { back: true, forward: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Previous chapter' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }))
    expect(asked).toEqual(['chapter -1', 'chapter 1'])
  })

  it('pauses a reading that is speaking', () => {
    const asked = listening({ paused: false })
    const button = screen.getByRole('button', { name: 'Pause' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(asked).toEqual(['pause'])
  })

  it('goes on with one that is paused, and says so on the same control', () => {
    const asked = listening({ paused: true })
    expect(screen.queryByRole('button', { name: 'Pause' }), 'a paused reading offered Pause').toBeNull()
    const button = screen.getByRole('button', { name: 'Go on reading' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(asked).toEqual(['resume'])
  })

  it.each([
    [1, '1×'],
    [1.25, '1.25×'],
    [1.5, '1.5×'],
    [2, '2×'],
  ])('reads %s back as %s — no trailing zero, which would read as a measurement', (rate, shown) => {
    draw({
      state: { screen: 'reader', chromeOn: true, readingRate: rate },
      speech: { ...speech, available: true, speaking: true },
      hasBook: true,
    })
    const button = screen.getByRole('button', { name: `Reading speed ${shown}` })
    expect(button.textContent).toBe(shown)
    expect(button.getAttribute('title')).toBe(`Reading speed — ${shown}, tap for the next`)
  })

  it('is not drawn at all when nothing is being read', () => {
    draw({ state: { screen: 'reader', chromeOn: true }, speech: { ...speech, available: true }, hasBook: true })
    expect(screen.queryByRole('group', { name: 'Reading aloud' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop reading aloud' })).toBeNull()
  })
})

/**
 * THE SWITCH BETWEEN THE SHELF AND A CAPABILITY'S SCREEN, which belongs where
 * the reader is choosing what to look at — and not in the reader, where the
 * book is the place they are in.
 */
describe('the screens a capability contributed', () => {
  const screens = [{ id: 'circle:circle' as const, label: 'Circle', icon: 'people' as const }]

  it('says which one the reader is on, and takes them to the other', () => {
    const dispatch = draw({ state: { screen: 'library', chromeOn: true }, screens })
    const library = screen.getByRole('button', { name: 'Library' })
    const circle = screen.getByRole('button', { name: 'Circle' })
    expect(library.getAttribute('aria-pressed'), 'the shelf is where the reader is').toBe('true')
    expect(circle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(circle)
    expect(dispatch).toHaveBeenCalledWith({ type: 'goScreen', screen: 'circle:circle' })
  })

  it('says the shelf is not where the reader is, once they are somewhere else', () => {
    const dispatch = draw({ state: { screen: 'circle:circle', chromeOn: true }, screens })
    const library = screen.getByRole('button', { name: 'Library' })
    expect(library.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(library)
    expect(dispatch).toHaveBeenCalledWith({ type: 'goScreen', screen: 'library' })
  })

  it('is absent in the reader, where the book is the place', () => {
    /* A second way out of a book, beside `Open the library` in the reader's own
       chrome, would be two controls for one intent. */
    draw({ state: { screen: 'reader', chromeOn: true }, screens, hasBook: true })
    expect(screen.queryByRole('button', { name: 'Circle' })).toBeNull()
  })

  it('is absent when nothing contributed a screen', () => {
    draw({ state: { screen: 'library', chromeOn: true } })
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull()
  })
})

describe('the pane toggle, and the palette', () => {
  it('says which way it will go, and asks for it', () => {
    /* `initialState` opens on the library WITH its pane, so a closed pane is
       the state a case has to ask for. */
    const closed = draw({ state: { screen: 'library', chromeOn: true, pane: null } })
    const open = screen.getByRole('button', { name: 'Open pane' })
    expect(open.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(open)
    expect(closed).toHaveBeenCalledWith({ type: 'togglePane' })

    cleanup()
    draw({ state: { screen: 'library', chromeOn: true, pane: 'toc' } })
    const close = screen.getByRole('button', { name: 'Close pane' })
    expect(close.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens the palette, and says when it is open', () => {
    const dispatch = draw({ state: { screen: 'library', chromeOn: true } })
    const search = screen.getByRole('button', { name: 'Search or ask' })
    expect(search.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(search)
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleLayer', layer: 'paletteOpen' })

    cleanup()
    draw({ state: { screen: 'library', chromeOn: true, paletteOpen: true } })
    expect(screen.getByRole('button', { name: 'Search or ask' }).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('the traffic lights, in a browser', () => {
  /**
   * Inside Tauri, AppKit paints the real ones over this zone; in a plain
   * browser nothing does, and the design still has to be checkable there. So
   * the lights are drawn for macOS outside Tauri — which is what a test
   * environment is.
   */
  it('draws three of them on macOS, and none elsewhere', () => {
    const { container } = render(
      <TitleBar
        screens={[]}
        state={initialState}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(container.querySelectorAll('span[style*="background"]').length).toBe(3)
    cleanup()

    const other = render(
      <TitleBar
        screens={[]}
        state={initialState}
        dispatch={vi.fn()}
        platform="windows"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(other.container.querySelectorAll('span[style*="background"]').length).toBe(0)
  })
})

describe('the Listen control, in each state it can be in', () => {
  /**
   * ⚠️ **§07 KEEPS THE DISABLED STATE FOR THE CASE THAT REMAINS REAL** — a
   * WebView built without Web Speech — rather than for a feature that is
   * unwritten. So there are three states and each says something different: no
   * engine, no book, and ready. A title that lost its sentence, or a disabled
   * flag that stopped following, is a control a reader presses and learns
   * nothing from.
   */
  const listen = () => screen.getByRole('button', { name: 'Read aloud' })

  it('says the build has no speech engine, and cannot be pressed', () => {
    const started: number[] = []
    draw({
      state: { screen: 'reader', chromeOn: true },
      speech: { ...speech, available: false, start: () => started.push(1) },
      hasBook: true,
    })
    expect(listen().getAttribute('title')).toBe('Listen — this build has no speech engine')
    expect(listen().hasAttribute('disabled')).toBe(true)
    expect(listen().getAttribute('data-disabled')).toBe('true')
    fireEvent.click(listen())
    expect(started, 'a disabled control started a reading').toEqual([])
  })

  it('cannot be pressed with no book open, though the engine is there', () => {
    draw({ state: { screen: 'reader', chromeOn: true }, speech: { ...speech, available: true }, hasBook: false })
    expect(listen().hasAttribute('disabled')).toBe(true)
    expect(listen().getAttribute('data-disabled')).toBe('true')
  })

  it('reads the chapter aloud when there is an engine and a book', () => {
    const started: number[] = []
    draw({
      state: { screen: 'reader', chromeOn: true },
      speech: { ...speech, available: true, start: () => started.push(1) },
      hasBook: true,
    })
    expect(listen().getAttribute('title')).toBe('Read this chapter aloud')
    expect(listen().hasAttribute('disabled')).toBe(false)
    expect(listen().getAttribute('aria-pressed'), 'it is a verb, not a state').toBe('false')
    fireEvent.click(listen())
    expect(started).toEqual([1])
  })
})

describe('what the chrome says without a word', () => {
  it('marks the chip when it is naming the application rather than a book', () => {
    /* ⚠️ NOT THE SWATCH THAT USED TO SIT HERE: that was derived from the open
       book's id, and with no book it hashed the empty string and drew a spine
       for a book that did not exist. The mark belongs to the application. */
    const { container } = render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, chromeOn: true }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(container.querySelectorAll('[class*="chipMark"]').length, 'no mark with no book').toBe(1)
    cleanup()

    const open = render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, chromeOn: true }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Moby-Dick"
        bookSubtitle="Melville"
        speech={speech}
        listenRefusal={null}
        hasBook
      />,
    )
    expect(open.container.querySelectorAll('[class*="chipMark"]').length, 'a mark over a book').toBe(0)
  })

  it('draws the pane control on the side the pane is on', () => {
    /* The glyph is the only thing that says which edge the pane will come from,
       and a reader who moved it to the left would otherwise be told the
       opposite. */
    const { container } = render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, chromeOn: true, side: 'left' }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(container.querySelector('.lucide-panel-left'), 'the left pane’s own glyph').toBeTruthy()
    expect(container.querySelector('.lucide-panel-right')).toBeNull()
  })

  it('says the palette’s own shortcut in its title', () => {
    draw({ state: { screen: 'library', chromeOn: true } })
    expect(screen.getByRole('button', { name: 'Search or ask' }).getAttribute('title')).toBe(
      'Search or ask · ⌘K',
    )
  })

  it('says which way the pane control will go in its title too', () => {
    draw({ state: { screen: 'library', chromeOn: true, pane: null } })
    expect(screen.getByRole('button', { name: 'Open pane' }).getAttribute('title')).toBe('Open pane')
    cleanup()
    draw({ state: { screen: 'library', chromeOn: true, pane: 'toc' } })
    expect(screen.getByRole('button', { name: 'Close pane' }).getAttribute('title')).toBe('Close pane')
  })

  it('offers only the panels this reader is offered', () => {
    /* ⚠️ **THIS WAS THE ONE SURFACE NOT TO ASK `paneFits`**, and it drew the
       deleted companion's button for every reader — a control that named one
       destination and performed another, because `paneFor` redirected the
       click. A panel the reader has HIDDEN is the same question: the rail must
       not offer it. */
    draw({ state: { screen: 'reader', chromeOn: true }, hasBook: true })
    expect(screen.getByRole('button', { name: 'Contents' }), 'the panel a reader is offered').toBeTruthy()
    /* And none of the panels the rail does not carry: the list is one entry, so
       what this holds is that the rail draws THAT one and nothing else. */
    for (const other of ['Marginalia', 'Search', 'Cards', 'Developer']) {
      expect(screen.queryByRole('button', { name: other }), `${other} is not the rail's`).toBeNull()
    }
  })

  /* ⚠️ **THE RAIL'S BUTTON IS A TOGGLE, AND EVERY PART OF THAT WAS UNDRAWN BY ANY
     TEST.** `data-on` fills it and `aria-pressed` says it — §10's rule, since a
     screen reader cannot see a fill — and the press has to CLOSE the panel it is
     announcing as open. A rail that always dispatched `openPane` leaves a reader
     pressing a lit button with nothing happening, and one that always dispatched
     `closePane` never opens anything; both draw identically. */
  it('lights the panel that is open, and closes it when pressed again', () => {
    const onOpen = draw({ state: { screen: 'reader', chromeOn: true, pane: 'toc' }, hasBook: true })
    const lit = screen.getByRole('button', { name: 'Contents' })
    expect(lit.getAttribute('aria-pressed'), 'announced, not only drawn').toBe('true')
    expect(lit.getAttribute('data-on')).toBe('true')
    fireEvent.click(lit)
    expect(onOpen).toHaveBeenCalledWith({ type: 'closePane' })
    cleanup()

    const onShut = draw({ state: { screen: 'reader', chromeOn: true, pane: null }, hasBook: true })
    const dark = screen.getByRole('button', { name: 'Contents' })
    expect(dark.getAttribute('aria-pressed')).toBe('false')
    expect(dark.getAttribute('data-on')).toBe('false')
    fireEvent.click(dark)
    expect(onShut).toHaveBeenCalledWith({ type: 'openPane', pane: 'toc' })
  })

  it('draws the pane control on the right when the pane is on the right', () => {
    /* The other half of the side glyph: with only one side tested, a control
       that always drew the left one would pass. */
    const { container } = render(
      <TitleBar
        screens={[]}
        state={{ ...initialState, chromeOn: true, side: 'right' }}
        dispatch={vi.fn()}
        platform="macos"
        bookTitle="Paper"
        bookSubtitle=""
        speech={speech}
        listenRefusal={null}
        hasBook={false}
      />,
    )
    expect(container.querySelector('.lucide-panel-right')).toBeTruthy()
    expect(container.querySelector('.lucide-panel-left')).toBeNull()
  })

  it('gives every control the shared action class, and the transport its own', () => {
    /* §07's controls are one geometry and one hit area. A control that dropped
       the shared class would sit at a different size from the ones beside it,
       and the transport's own class is what makes its row narrower than the
       chrome's. */
    draw({ state: { screen: 'library', chromeOn: true, pane: null } })
    expect(screen.getByRole('button', { name: 'Open pane' }).className).toMatch(/action/u)
    expect(screen.getByRole('button', { name: 'Open pane' }).className).toMatch(/paneToggle/u)
    cleanup()

    listening()
    for (const name of ['Previous sentence', 'Pause', 'Stop reading aloud']) {
      const button = screen.getByRole('button', { name })
      expect(button.className, `${name} is not an action`).toMatch(/action/u)
      expect(button.className, `${name} is not a transport button`).toMatch(/transportButton/u)
    }
    expect(screen.getByRole('button', { name: /^Reading speed/u }).className).toMatch(/rate/u)
  })

  it('titles each transport step with the step it takes', () => {
    listening()
    for (const name of ['Previous sentence', 'Next sentence', 'Stop reading aloud']) {
      expect(screen.getByRole('button', { name }).getAttribute('title'), name).toBe(name)
    }
  })

  it('titles the pause control with what it will do', () => {
    listening({ paused: false })
    expect(screen.getByRole('button', { name: 'Pause' }).getAttribute('title')).toBe('Pause')
    cleanup()
    listening({ paused: true })
    expect(screen.getByRole('button', { name: 'Go on reading' }).getAttribute('title')).toBe('Go on reading')
  })
})
