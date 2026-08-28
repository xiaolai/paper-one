// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Platform } from '../../core/metrics'
import type { Speech } from '../reader/useSpeech'
import { initialState } from '../state'
import { TitleBar } from './TitleBar'

afterEach(cleanup)

const speech: Speech = {
  available: false,
  speaking: false,
  paused: false,
  followsWords: false,
  start: () => {},
  pause: () => {},
  resume: () => {},
  stop: () => {},
}

function bar(platform: Platform) {
  return render(
    <TitleBar
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
