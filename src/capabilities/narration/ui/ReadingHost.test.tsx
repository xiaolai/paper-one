// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createKernelServices,
  createSettingsStore,
  scopeSettings,
  type KernelServices,
  type SettingsStore,
  type SpeechEnginePort,
} from '../../../kernel'
import { useReadingSurface, type BookFacts, type SurfaceDriver } from '../../../kernel/testkit'
import { RATE_SETTING, VOICE_SETTING, VOLUME_SETTING } from '../lib/settings'
import { FakeSynth, FakeUtterance } from '../lib/speechSynth.testkit'
import { NO_GOOD_VOICE, type VoiceFacts } from '../lib/voiceChoice'
import { ListenControl } from './ListenControl'
import { createReadingStore, type Reading, type ReadingStore } from './reading'
import { ReadingHost } from './ReadingHost'

/**
 * THE HOST, WITH THE LISTEN CONTROL AS ITS CONSUMER, over the reading surface
 * `App` builds.
 *
 * What neither the control's cases nor `useSpeech`'s can see is the wire between
 * them: the host reading the engine's live list through `useVoices` and the
 * catalogue through `useVoicePacks`, asking `voiceFor` about the book on screen,
 * reading the reader's settings, and handing all of it to a control the kernel
 * draws somewhere else. A wire that went nowhere would leave the button enabled
 * over a reading the speaker refuses, or a speed control moving a number nobody
 * hears.
 */

let synth: FakeSynth
const originalUtterance = globalThis.SpeechSynthesisUtterance

beforeEach(() => {
  synth = new FakeSynth()
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true })
  window.SpeechSynthesisUtterance = FakeUtterance as unknown as typeof SpeechSynthesisUtterance
})

afterEach(() => {
  cleanup()
  delete (window as { speechSynthesis?: unknown }).speechSynthesis
  window.SpeechSynthesisUtterance = originalUtterance
})

/** A section of prose, in a document of its own, in a language. */
function page(prose: string, lang = 'en') {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.documentElement.setAttribute('lang', lang)
  doc.body.innerHTML = prose
  return doc
}

const ZOE: VoiceFacts = { name: 'Zoe', lang: 'en-US', voiceURI: 'com.apple.voice.enhanced.en-US.Zoe', localService: true }
const COMPACT: VoiceFacts = { name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }
const SUPER_COMPACT: VoiceFacts = {
  name: 'Samantha',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.super-compact.en-US.Samantha',
}

/** An engine with one English pack, installed or not. */
function englishPack(installed: boolean): SpeechEnginePort {
  return {
    catalogue: async () => [
      {
        id: 'english-kokoro',
        name: 'English',
        summary: '',
        family: 'kokoro',
        languages: ['en'],
        bytes: 336_822_660,
        minimumMemoryGb: 4,
        voices: [{ id: 'af_heart', name: 'Heart', language: 'en-US', note: '' }],
        installed,
      },
    ],
    install: async () => {},
    remove: async () => {},
    render: async () => {
      throw new Error('nothing renders in these cases')
    },
    findClip: async () => null,
    holdClips: async (stems: readonly string[]) => stems.length,
    clipUsage: async () => ({ bytes: 0, budget: 5 * 1024 * 1024 * 1024, clips: 0 }),
    forgetClips: async () => ({ clips: 0, bytes: 0 }),
    release: async () => {},
  }
}

const narrationSettings = (): SettingsStore => scopeSettings(createSettingsStore({ storage: null }), 'narration')

const FACTS: Omit<BookFacts, 'doc' | 'sectionTexts'> = {
  generation: 1,
  bookId: 'book:1',
  meta: { title: 'Le Horla', author: 'Maupassant' },
  toc: [],
  fixedLayout: false,
}

/**
 * What the kernel does with the host: the surface committed by the reader, the
 * host drawn first among the window hosts, and the Listen control drawn after
 * it in the title bar.
 */
function mount(
  first: Document | null,
  over: { services?: KernelServices; settings?: SettingsStore; withControl?: boolean } = {},
) {
  const store = createReadingStore()
  const services = over.services ?? createKernelServices({ fs: null, storage: null })
  const settings = over.settings ?? narrationSettings()
  const api: { driver: SurfaceDriver | null } = { driver: null }
  const set: { doc?: (doc: Document | null) => void; store?: (store: ReadingStore) => void } = {}
  const paging = { next: () => {}, prev: () => {}, nextSection: async () => 'unmoved' as const }
  const walk: BookFacts['sectionTexts'] = async () => ({ sections: [], complete: true })
  function Parent() {
    const [doc, setDoc] = useState(first)
    const [host, setHost] = useState(store)
    set.doc = setDoc
    set.store = setHost
    const book = useMemo(() => ({ ...FACTS, doc, sectionTexts: walk }), [doc])
    const driver = useReadingSurface({ doc, place: { bookId: 'book:1', sectionIndex: 0 }, paging, book })
    api.driver = driver
    return (
      <>
        <ReadingHost context={{ sectionKey: doc, surface: driver.surface }} services={services} settings={settings} store={host} />
        {over.withControl === false ? null : <ListenControl store={store} settings={settings} />}
      </>
    )
  }
  const view = render(<Parent />)
  return {
    store,
    settings,
    api,
    set,
    view,
    reading: (): Reading => store.read()!,
    listen: () => view.container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]'),
  }
}

/** The catalogue is READ, in an effect, so its first answer lands a few turns after the mount. */
const settled = () =>
  act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  })

describe('the host', () => {
  it('has published by the time the first commit is over, and the control is drawn from it', () => {
    synth.voices = [ZOE]
    const { store, listen } = mount(page('<p>Words.</p>'))
    expect(store.read()?.speech.available).toBe(true)
    expect(listen(), 'the Listen control is drawn in the same commit').not.toBeNull()
  })

  it('reaches the control when a reading starts and when it stops', () => {
    synth.voices = [ZOE]
    const { reading, listen, view } = mount(page('<p>Words.</p>'))
    act(() => reading().speech.start())
    expect(listen(), 'the transport replaces it').toBeNull()
    expect(view.container.querySelector('[role="group"][aria-label="Reading aloud"]')).not.toBeNull()
    act(() => reading().speech.stop())
    expect(listen()).not.toBeNull()
  })

  it('reads the document the surface committed, and the next one', () => {
    synth.voices = [ZOE]
    const { reading, set } = mount(page('<p>First section.</p>'))
    act(() => reading().speech.start())
    expect(synth.queued.at(-1)?.text).toContain('First')
    act(() => set.doc?.(page('<p>Second section.</p>')))
    expect(synth.queued.at(-1)?.text, 'a chapter turn is a step in the reading').toContain('Second')
    expect(reading().speech.speaking).toBe(true)
  })

  it('says what book there is, and its language, from the surface', () => {
    const { reading, set } = mount(page('<p>Un texte.</p>', 'fr'))
    expect(reading()).toMatchObject({ hasBook: true, lang: 'fr' })
    act(() => set.doc?.(null))
    expect(reading(), 'with the book closed').toMatchObject({ hasBook: false, lang: null })
  })

  it('withdraws what it said when it goes', () => {
    const { store, view } = mount(page('<p>Words.</p>'), { withControl: false })
    expect(store.read()).not.toBeNull()
    view.unmount()
    expect(store.read()).toBeNull()
  })

  it('withdraws from a store it is no longer given, and publishes to the one it is', () => {
    const { store, set } = mount(page('<p>Words.</p>'), { withControl: false })
    const next = createReadingStore()
    act(() => set.store?.(next))
    expect(store.read(), 'the store it was given before').toBeNull()
    expect(next.read()?.hasBook).toBe(true)
  })

  it('publishes the voices this machine has, as they arrive', () => {
    const { reading } = mount(page('<p>Words.</p>'))
    expect(reading().voices).toEqual([])
    act(() => {
      synth.voices = [ZOE]
      synth.dispatchEvent(new Event('voiceschanged'))
    })
    expect(reading().voices.map((voice) => voice.voiceURI)).toEqual([ZOE.voiceURI])
  })
})

describe('the pace, as the book’s own turning sees it', () => {
  /* The other half — the book's own turning refusing to start under a reading,
     and giving the book up when one starts — is `useAutoAdvance`'s, and its
     cases drive it with the same answer this hands the surface. */
  it('is held when a reading starts', () => {
    synth.voices = [ZOE]
    const { reading, api } = mount(page('<p>Words. More words.</p>'))
    expect(api.driver?.paceHeld()).toBe(false)
    act(() => reading().speech.start())
    expect(api.driver?.paceHeld()).toBe(true)
  })

  it('stays held through a pause, and comes back when the reading ends', () => {
    synth.voices = [ZOE]
    const { reading, api } = mount(page('<p>Words. More words.</p>'))
    act(() => reading().speech.start())
    act(() => reading().speech.pause())
    expect(api.driver?.paceHeld(), 'paused').toBe(true)
    act(() => reading().speech.stop())
    expect(api.driver?.paceHeld()).toBe(false)
  })

  it('is let go when the book closes under a reading', () => {
    synth.voices = [ZOE]
    const { reading, api, set } = mount(page('<p>Words.</p>'))
    act(() => reading().speech.start())
    act(() => set.doc?.(null))
    expect(api.driver?.paceHeld()).toBe(false)
  })

  it('lets go when the host goes', () => {
    synth.voices = [ZOE]
    const { reading, api, view } = mount(page('<p>Words.</p>'))
    act(() => reading().speech.start())
    const driver = api.driver!
    view.unmount()
    expect(driver.paceHeld()).toBe(false)
  })
})

/**
 * NO VOICE RATHER THAN A BAD ONE, FROM THE VOICES TO THE CONTROL.
 *
 * The rule lives in `voiceChoice.ts` and the button in `ListenControl`, and each
 * is tested alone; these hold the host to asking the rule about the book on
 * screen, with the live list and the catalogue, and handing the answer on.
 */
describe('the Listen control and the voices this machine has', () => {
  it('is disabled, and says why, when every voice is below the floor — a Mac', async () => {
    synth.voices = [COMPACT, SUPER_COMPACT]
    const { listen } = mount(page('<p>Call me Ishmael.</p>'))
    await settled()
    expect(listen()).toHaveProperty('disabled', true)
    expect(listen()?.getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })

  it('reads when a voice above the floor is there', async () => {
    synth.voices = [COMPACT, ZOE]
    const { listen } = mount(page('<p>Call me Ishmael.</p>'))
    await settled()
    expect(listen()).toHaveProperty('disabled', false)
    expect(listen()?.getAttribute('title')).toBe('Read this chapter aloud')
  })

  it('asks about the voice the reader chose, not only about the best one', async () => {
    /* A chosen voice that is not here falls back to the automatic pick, and the
       automatic pick still has to clear the floor: the choice cannot be how a
       compact voice gets past it. */
    synth.voices = [COMPACT]
    const settings = narrationSettings()
    settings.set(VOICE_SETTING, { en: COMPACT.voiceURI })
    const { listen } = mount(page('<p>Call me Ishmael.</p>'), { settings })
    await settled()
    expect(listen()?.getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })

  /**
   * ⚠️ **A DOWNLOADED PACK IS ASKED FIRST, AND NOTHING HELD THE HOST TO IT.** The
   * mutation gate found it: `engineVoiceFor(...)` in `listenRefusal` could be
   * replaced with `false` and every test still passed — so a Mac with the
   * English pack installed, where no platform voice clears the floor, would
   * show the control disabled saying no high-quality voice is available while
   * the reading was perfectly able to read the book. That exact sentence over
   * an installed pack is the defect WI-30.11 found in the running app.
   */
  it('reads on a downloaded pack even where every platform voice is below the floor', async () => {
    synth.voices = [COMPACT]
    const services = createKernelServices({ fs: null, storage: null })
    services.bindSpeechEngines(englishPack(true))
    const { listen, reading } = mount(page('<p>Call me Ishmael.</p>'), { services })
    await settled()
    expect(reading().packs.map((pack) => pack.id)).toEqual(['english-kokoro'])
    expect(listen()).toHaveProperty('disabled', false)
    expect(listen()?.getAttribute('title')).toBe('Read this chapter aloud')
  })

  /* And a pack that is OFFERED but not here names itself and its size, which is
     advice a reader can act on where NO_GOOD_VOICE alone is a dead end. */
  it('names the pack that would read it, when the pack is not installed', async () => {
    synth.voices = [COMPACT]
    const services = createKernelServices({ fs: null, storage: null })
    services.bindSpeechEngines(englishPack(false))
    const { listen } = mount(page('<p>Call me Ishmael.</p>'), { services })
    await settled()
    expect(listen()).toHaveProperty('disabled', true)
    expect(listen()?.getAttribute('title')).toMatch(/Download the English voice \(321 MB\)/u)
  })

  it('does not name an English pack over a book in another language', async () => {
    synth.voices = [COMPACT]
    const services = createKernelServices({ fs: null, storage: null })
    services.bindSpeechEngines(englishPack(true))
    const { listen } = mount(page('<p>Un texte.</p>', 'fr'), { services })
    await settled()
    expect(listen()?.getAttribute('title')).toBe(`Listen — ${NO_GOOD_VOICE}`)
  })
})

describe('the reader’s settings, as the voice hears them', () => {
  it('reads at the speed the reader has stored, and at the one they change it to', async () => {
    /* ⚠️ **THE PREFERENCES ARE A MEMO OVER THE SETTINGS**, and the engine reads
       them per utterance: a memo that never recomputed would hold the speed the
       reading started at, so the transport's own speed control would move a
       number nobody hears. */
    synth.voices = [ZOE]
    const settings = narrationSettings()
    settings.set(RATE_SETTING, 1.5)
    const { view } = mount(page('<p>Call me Ishmael. Some years ago.</p><p>It is a way I have.</p>'), { settings })
    await settled()
    act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!.click())
    expect(synth.queued.at(0)?.rate, 'the stored speed did not reach the engine').toBe(1.5)

    act(() => view.container.querySelector<HTMLButtonElement>('button[aria-label^="Reading speed"]')!.click())
    expect(
      view.container.querySelector('button[aria-label^="Reading speed"]')?.getAttribute('aria-label'),
      'the speed control did not move',
    ).toBe('Reading speed 1.75×')

    /* AND THE VOICE HEARS IT at the next sentence. */
    act(() => {
      synth.queued.at(-1)?.dispatchEvent(new Event('end'))
    })
    /* After the sentence gap, which is a real timer here. */
    await waitFor(() => expect(synth.queued).toHaveLength(2))
    expect(synth.queued.at(-1)?.text.trim()).toBe('Some years ago.')
    expect(synth.queued.at(-1)?.rate, 'the next sentence was read at the old speed').toBe(1.75)
  })

  it('reaches the voice as a fraction of what is stored', async () => {
    /* ⚠️ **THE ONE DIVISION.** The setting is in percent and both speakers take 0
       to 1, and 40 handed to `utterance.volume` is a voice at full. */
    synth.voices = [ZOE]
    const settings = narrationSettings()
    settings.set(VOLUME_SETTING, 40)
    const { reading } = mount(page('<p>Call me Ishmael.</p>'), { settings })
    await settled()
    act(() => reading().speech.start())
    expect(synth.queued.at(0)?.volume, 'the stored volume did not reach the engine').toBe(0.4)
  })

  it('takes a voice the reader chooses before the next press', async () => {
    synth.voices = [ZOE, { ...ZOE, name: 'Ava', voiceURI: 'com.apple.voice.premium.en-US.Ava' }]
    const settings = narrationSettings()
    const { reading } = mount(page('<p>Call me Ishmael.</p>'), { settings })
    await settled()
    act(() => settings.set(VOICE_SETTING, { en: 'com.apple.voice.premium.en-US.Ava' }))
    act(() => reading().speech.start())
    expect(synth.queued.at(0)?.voice?.voiceURI).toBe('com.apple.voice.premium.en-US.Ava')
  })
})
