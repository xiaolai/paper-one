// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITY_UI as ui, createSettingsStore, scopeSettings, type SettingsStore } from '../../../kernel'
import { NO_GOOD_VOICE } from '../lib/voiceChoice'
import { RATE_SETTING } from '../lib/settings'
import { ListenControl } from './ListenControl'
import { createReadingStore, type Reading, type ReadingStore } from './reading'
import type { Speech } from './useSpeech'

afterEach(cleanup)

/** A reading that is not happening, spelled out in full — see `ReadingTransport.test`. */
const SILENT: Speech = {
  available: true,
  speaking: false,
  paused: false,
  followsWords: false,
  chapters: { back: false, forward: false },
  at: null,
  preparing: false,
  refusal: null,
  start: () => {},
  stop: () => {},
  pause: () => {},
  resume: () => {},
  seekToFraction: () => false,
  seekToOffset: () => false,
  stepSentence: () => {},
  stepParagraph: () => {},
  stepChapter: () => {},
}

const narrationSettings = (): SettingsStore => scopeSettings(createSettingsStore({ storage: null }), 'narration')

/** The control over a published reading — or none, where `reading` is null. */
function draw(
  over: { speech?: Partial<Speech>; listenRefusal?: string | null; hasBook?: boolean } | null = {},
  settings: SettingsStore = narrationSettings(),
) {
  const store = createReadingStore()
  const started: number[] = []
  if (over !== null) {
    const reading: Reading = {
      speech: { ...SILENT, start: () => started.push(1), ...over.speech },
      listenRefusal: over.listenRefusal ?? null,
      hasBook: over.hasBook ?? true,
      lang: 'en',
      voices: [],
      packs: [],
    }
    store.publish(reading)
  }
  const view = render(<ListenControl store={store} settings={settings} />)
  return { store, settings, started, view, listen: () => screen.getByRole('button', { name: 'Read aloud' }) }
}

describe('before the reading has published', () => {
  it('draws nothing, rather than a control with nothing behind it', () => {
    const { view } = draw(null)
    expect(view.container.innerHTML).toBe('')
  })

  it('draws the control once it has', () => {
    const store: ReadingStore = createReadingStore()
    render(<ListenControl store={store} settings={narrationSettings()} />)
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
    act(() =>
      store.publish({ speech: SILENT, listenRefusal: null, hasBook: true, lang: 'en', voices: [], packs: [] }),
    )
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy()
    act(() => store.withdraw())
    expect(screen.queryByRole('button', { name: 'Read aloud' }), 'and is gone once the host is').toBeNull()
  })
})

describe('the Listen control, in each state it can be in', () => {
  /**
   * ⚠️ **§07 KEEPS THE DISABLED STATE FOR THE CASE THAT REMAINS REAL** — a
   * WebView built without Web Speech — rather than for a feature that is
   * unwritten. So there are three states and each says something different: no
   * engine, no book, and ready.
   */
  it('says the build has no speech engine, and cannot be pressed', () => {
    const { listen, started } = draw({ speech: { available: false }, listenRefusal: NO_GOOD_VOICE })
    expect(listen().getAttribute('title'), 'outranks every other reason').toBe(
      'Listen — this build has no speech engine',
    )
    expect(listen().hasAttribute('disabled')).toBe(true)
    expect(listen().getAttribute('data-disabled')).toBe('true')
    fireEvent.click(listen())
    expect(started, 'a disabled control started a reading').toEqual([])
  })

  it('cannot be pressed with no book open, though the engine is there', () => {
    const { listen } = draw({ hasBook: false })
    expect(listen().hasAttribute('disabled')).toBe(true)
    expect(listen().getAttribute('data-disabled')).toBe('true')
  })

  it('reads the chapter aloud when there is an engine and a book', () => {
    const { listen, started } = draw()
    expect(listen().getAttribute('title')).toBe('Read this chapter aloud')
    expect(listen().hasAttribute('disabled')).toBe(false)
    expect(listen().getAttribute('data-disabled'), 'drawn as pressable too').toBe('false')
    expect(listen().getAttribute('aria-pressed'), 'it is a verb, not a state').toBe('false')
    expect(listen().hasAttribute('data-refused')).toBe(false)
    expect(listen().className).toBe(ui.barButton)
    expect(listen().querySelector('.lucide-audio-lines'), 'its own glyph').toBeTruthy()
    fireEvent.click(listen())
    expect(started).toEqual([1])
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
  it('is disabled and says why', () => {
    const { listen } = draw({ listenRefusal: NO_GOOD_VOICE })
    expect(listen()).toHaveProperty('disabled', true)
    expect(listen().getAttribute('data-disabled')).toBe('true')
    expect(listen().getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })

  it('carries whatever reason it was given, not one of its own', () => {
    /* ⚠️ THE REASON AND THE REFUSAL ARE ONE VALUE, so a control cannot be
       disabled with nothing to say. What would fix it differs — a pack that can
       be downloaded names itself and its size — and this is not where that is
       decided. */
    const { listen } = draw({ listenRefusal: 'Download the English voice (321 MB) in Settings → Voices' })
    expect(listen()).toHaveProperty('disabled', true)
    expect(listen().getAttribute('title')).toContain('321 MB')
  })
})

describe('a reading that stopped on its own', () => {
  const FAILED = 'This chapter could not be made into audio. Trying again may work.'

  it('says why on the Listen control, where it used to say nothing', () => {
    /* ⚠️ **WI-34.5's OTHER SENTENCE.** A chapter that could not be made into
       audio left this control back where it was with nothing said — which is
       exactly what a chapter that had FINISHED looks like. */
    const { listen } = draw({ speech: { refusal: FAILED } })
    expect(listen().getAttribute('title')).toBe(`Listen — ${FAILED}`)
    /* ⚠️ **THE VALUE, NOT JUST THE PRESENCE — FOUND BY THE MUTATION SWEEP.** */
    expect(listen().getAttribute('data-refused')).toBe(FAILED)
    /* STILL OFFERED: a render that failed may succeed, which is what the sentence
       says — so the control must not be disabled by it. */
    expect(listen().hasAttribute('disabled')).toBe(false)
  })

  it('is outranked by a refusal to start at all, which is the more actionable news', () => {
    const { listen } = draw({
      speech: { refusal: 'the last one failed' },
      listenRefusal: 'no voice on this Mac is good enough',
    })
    expect(listen().getAttribute('title')).toBe('Listen — no voice on this Mac is good enough')
    expect(listen().hasAttribute('disabled')).toBe(true)
  })
})

describe('while a reading is under way', () => {
  it('is the transport, in the control’s place', () => {
    draw({ speech: { speaking: true } })
    expect(screen.queryByRole('button', { name: 'Read aloud' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Reading aloud' })).toBeTruthy()
  })

  it('shows the stored speed, and stores the next one when it is tapped', () => {
    const settings = narrationSettings()
    settings.set(RATE_SETTING, 1.5)
    draw({ speech: { speaking: true } }, settings)
    fireEvent.click(screen.getByRole('button', { name: 'Reading speed 1.5×' }))
    expect(settings.get(RATE_SETTING)).toBe(1.75)
    expect(screen.getByRole('button', { name: 'Reading speed 1.75×' }), 'and shows it at once').toBeTruthy()
  })

  it('follows a speed stored elsewhere — Settings, or another window', () => {
    const settings = narrationSettings()
    draw({ speech: { speaking: true } }, settings)
    expect(screen.getByRole('button', { name: 'Reading speed 1×' })).toBeTruthy()
    act(() => settings.set(RATE_SETTING, 2))
    expect(screen.getByRole('button', { name: 'Reading speed 2×' })).toBeTruthy()
  })
})
