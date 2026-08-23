// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_READING_STYLE, DEFAULT_STEP_IDX } from '../../core/metrics'
import { applySettings } from './FoliateView'
import type { Renderer } from 'foliate-js/view.js'
import type { Theme } from '../state'

/**
 * WHEN THE SHEETS ARE PUSHED AT THE RENDERER, and the two things that must not
 * change that answer.
 *
 * `applySheets` skips `setStyles` when nothing moved, because writing the same
 * string back re-parses the sheet in every open document — F4, and the whole
 * reason the reader's settings travel as custom properties instead.
 *
 * THE THEME BELONGS OUTSIDE THAT KEY, and this suite is here because it was
 * once inside it. foliate refreshes its page-edge background at the end of
 * `setStyles`, so keying on the theme did repaint the strips — and flashed the
 * window on every theme change, because the sheet re-parsed carries the
 * `@font-face` rules `bookCss` copies out of the host and the book re-resolved
 * its faces. The strips are the host's to paint now, in CSS and with no JS at
 * all; see the `::part(filter)` rule in `Reader.module.css`.
 *
 * So the theme case below asserts a SKIP. It reads like a test of nothing and
 * is the opposite: it is the one that went red when the flash was introduced,
 * and the only place that records why the obvious fix is the wrong one.
 */

const SETTINGS = {
  stepIdx: DEFAULT_STEP_IDX,
  pageMargins: 88,
  spacing: { letter: 2, word: 2, line: 2, paragraph: 2 },
  align: 'justified',
  brightness: 2,
  contrast: 2,
  measure: 660,
  typeface: 'literata',
  paginated: true,
  animated: true,
  style: DEFAULT_READING_STYLE,
} as const

function settingsFor(theme: Theme): Parameters<typeof applySettings>[1] {
  return { ...SETTINGS, theme }
}

/** Only the surface `applySettings` touches — attributes, styles, contents. */
function fakeRenderer(): Renderer & { setStyles: ReturnType<typeof vi.fn> } {
  const attrs = new Map<string, string>()
  const renderer = {
    setStyles: vi.fn(),
    getContents: () => [],
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    toggleAttribute: (name: string, on?: boolean) =>
      on ? void attrs.set(name, '') : void attrs.delete(name),
  }
  return renderer as unknown as Renderer & { setStyles: ReturnType<typeof vi.fn> }
}

describe('pushing the book stylesheet', () => {
  it('writes it once, and not again when nothing has moved', () => {
    const renderer = fakeRenderer()
    applySettings(renderer, settingsFor('sage'))
    applySettings(renderer, settingsFor('sage'))
    /* The skip is the feature, not an optimisation — a second identical write
       re-parses the sheet in every open document. */
    expect(renderer.setStyles).toHaveBeenCalledTimes(1)
  })

  it('does NOT rewrite it for a theme, because the reader sees that as a flash', () => {
    /* The sheets do not move for a theme — that is the variable contract. What
       made this tempting was foliate repainting its page edges here as a side
       effect; that is now the host's job, and this stays a skip. */
    const renderer = fakeRenderer()
    applySettings(renderer, settingsFor('sage'))
    applySettings(renderer, settingsFor('night'))
    expect(renderer.setStyles).toHaveBeenCalledTimes(1)
  })

  it('keeps the skip while the measure animates, which is F4 itself', () => {
    /* The pane opening moves the measure across 220ms. That was the traffic
       the skip exists to stop. */
    const renderer = fakeRenderer()
    for (const measure of [660, 640, 628, 620]) {
      applySettings(renderer, { ...settingsFor('sage'), measure })
    }
    expect(renderer.setStyles).toHaveBeenCalledTimes(1)
  })

  it('keys per renderer, because a note view has style elements of its own', () => {
    const page = fakeRenderer()
    const note = fakeRenderer()
    applySettings(page, settingsFor('sage'))
    applySettings(note, settingsFor('sage'))
    expect(page.setStyles).toHaveBeenCalledTimes(1)
    expect(note.setStyles).toHaveBeenCalledTimes(1)
  })
})
