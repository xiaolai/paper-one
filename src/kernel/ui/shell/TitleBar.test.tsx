// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../../core/metrics'
import type { Speech } from '../reader/useSpeech'
import { initialState } from '../state'
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
