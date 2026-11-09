// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPABILITY_UI as ui,
  createSettingsStore,
  scopeSettings,
  type SettingsStore,
  type VoicePack,
} from '../../../kernel'
import {
  NOTES_ALOUD_SETTING,
  PARAGRAPH_GAP_SETTING,
  RATE_SETTING,
  SENTENCE_GAP_SETTING,
  VOICE_SETTING,
  VOLUME_SETTING,
} from '../lib/settings'
import type { VoiceFacts } from '../lib/voiceChoice'
import { createReadingStore, type Reading } from './reading'
import type { Speech } from './useSpeech'
import { VoiceSettings, voicePickerValue, type VoicePicking } from './VoiceSettings'

afterEach(cleanup)

const installed: VoiceFacts = {
  name: 'Zoe',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.enhanced.en-US.Zoe',
  localService: true,
}
/* What a Mac's WebView offers — below the floor, see `voiceChoice.ts`. */
const compact: VoiceFacts = {
  name: 'Samantha',
  lang: 'en-US',
  voiceURI: 'com.apple.voice.compact.en-US.Samantha',
  localService: true,
}
/** The English pack, as the catalogue reports it once it is here. */
const englishPack: VoicePack = {
  id: 'english-kokoro',
  name: 'English',
  summary: 'Kokoro 82M, read on this device.',
  family: 'kokoro',
  languages: ['en'],
  bytes: 336_822_660,
  minimumMemoryGb: 4,
  voices: [
    { id: 'af_heart', name: 'Heart', language: 'en-US', note: '' },
    { id: 'af_bella', name: 'Bella', language: 'en-US', note: '' },
  ],
  installed: true,
}

const narrationSettings = (): SettingsStore => scopeSettings(createSettingsStore({ storage: null }), 'narration')

/** The section over a published reading — or over none, where `reading` is null. */
function section(
  over: {
    voices?: readonly VoiceFacts[]
    packs?: readonly VoicePack[]
    chosen?: Readonly<Record<string, string>>
    hasBook?: boolean
    lang?: string | null
  } | null = {},
  settings: SettingsStore = narrationSettings(),
) {
  const store = createReadingStore()
  if (over !== null) {
    if (over.chosen) settings.set(VOICE_SETTING, over.chosen)
    const reading: Reading = {
      speech: { available: true, speaking: false } as Speech,
      listenRefusal: null,
      hasBook: over.hasBook ?? true,
      lang: over.lang === undefined ? 'en-US' : over.lang,
      voices: over.voices ?? [installed],
      packs: over.packs ?? [],
    }
    store.publish(reading)
  }
  const view = render(<VoiceSettings store={store} settings={settings} />)
  return { store, settings, view }
}

const picker = () => screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement

/** The picker, with a stored choice, the platform's voices and the packs. */
function pickerFor(
  chosen: Readonly<Record<string, string>>,
  voices: readonly VoiceFacts[] = [installed],
  packs: readonly VoicePack[] = [],
): HTMLSelectElement {
  section({ chosen, voices, packs })
  return picker()
}

describe('before the reading has published', () => {
  it('draws nothing', () => {
    const { view } = section(null)
    expect(view.container.innerHTML).toBe('')
  })
})

describe('with no book open', () => {
  /* The voice is chosen per language, and with no book there is no language
     to choose one for: a picker here would store a choice under `''`, which no
     book ever reads. The rest of the section is the reader's whatever is open. */
  it('says the voice is chosen per book, and offers the rest', () => {
    section({ hasBook: false, lang: null })
    expect(screen.queryByRole('combobox')).toBeNull()
    const hint = screen.getByText(/Open a book to choose its voice/u)
    expect(hint.className).toBe(ui.hint)
    expect(hint.textContent).toBe('The voice is chosen for each book’s language. Open a book to choose its voice.')
    expect(screen.getByRole('button', { name: 'More speed' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Reading volume' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Read footnotes' })).toBeTruthy()
  })
})

describe('the voice the picker shows', () => {
  it('writes the voice the reader picked, under the book’s own language', () => {
    /* ⚠️ **PER LANGUAGE, NOT PER APP** — the whole reason the stored choice is a
       map. A handler that dropped the language would put an English voice under
       every book the reader opens. */
    const { settings } = section({ chosen: { zh: 'a Chinese voice' } })
    fireEvent.change(picker(), { target: { value: installed.voiceURI } })
    expect(settings.get(VOICE_SETTING)).toEqual({ zh: 'a Chinese voice', en: installed.voiceURI })
    expect(picker().value, 'and shows it').toBe(installed.voiceURI)
  })

  it('goes back to Automatic by forgetting the choice', () => {
    const { settings } = section({ chosen: { en: installed.voiceURI } })
    fireEvent.change(picker(), { target: { value: '' } })
    expect(settings.get(VOICE_SETTING)).toEqual({})
  })

  it('groups the voices it offers, and says which tier each group is', () => {
    /* The tier is the only thing that separates a voice worth reading a book in
       from one that is not, so the picker says it rather than listing names. */
    section()
    expect([...picker().querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['Enhanced'])
  })

  it('names each tier it groups by, whichever tiers are installed', () => {
    /* Three tiers can be offered and each has its own word: the two Apple names
       a `voiceURI` spells out, and `Other` for a machine whose identifiers say
       nothing about quality — where the floor cannot be applied and every voice
       is offered. */
    const premium = { ...installed, name: 'Ava', voiceURI: 'com.apple.voice.premium.en-US.Ava' }
    const plain = { ...installed, name: 'Microsoft Zira', voiceURI: 'Microsoft Zira - English (United States)' }
    section({ voices: [premium, installed, plain] })
    expect([...picker().querySelectorAll('optgroup')].map((group) => group.label)).toEqual([
      'Premium',
      'Enhanced',
      'Other',
    ])
  })

  it('says the platform will choose when the engine has listed nothing yet', () => {
    /* ⚠️ NOT "None": an engine that has not answered is not an engine with
       nothing good — the reader can do nothing about the first and something
       about the second, so the two must not read alike. */
    section({ voices: [] })
    expect(picker().selectedOptions[0]?.textContent).toBe('Automatic (system default)')
  })

  it('draws the row and the select with the shared classes, so the band lines up', () => {
    section()
    expect(picker().className).toBe(ui.select)
    expect(picker().closest('div')?.className, 'the voice row is not a row').toBe(ui.row)
  })

  it('shows Automatic, naming the voice it means, for a voice the machine no longer has', () => {
    expect(pickerFor({ en: 'com.apple.voice.premium.en-US.Gone' }).selectedOptions[0]?.textContent).toBe(
      'Automatic (Zoe)',
    )
  })

  it('shows the stored voice when it is one the reading will use', () => {
    expect(pickerFor({ en: installed.voiceURI }).value).toBe(installed.voiceURI)
  })

  /**
   * ⚠️ **ON A MAC, NOTHING CLEARS THE FLOOR, AND THE PICKER SAYS SO.** It said
   * "Automatic (system default)" — naming a voice the reading refuses to use.
   * A stored compact choice from before the floor is refused the same way.
   */
  it('says no high-quality voice is available, and offers none below the floor', () => {
    for (const chosen of [{}, { en: compact.voiceURI }]) {
      const select = pickerFor(chosen, [compact])
      expect(select.selectedOptions[0]?.textContent).toBe('None — no high-quality voice is available here')
      expect([...select.options].map((option) => option.value)).toEqual([''])
      cleanup()
    }
  })

  /**
   * ⚠️ **MEASURED IN THE RUNNING APP, 2026-09-23 — THE ROW CONTRADICTED THE
   * READING.** With the English pack installed, `engineVoiceFor` had resolved
   * Heart and the book was being read in it, while this row said *"None — no
   * high-quality voice is available here"*. The picker asked only `voiceFor`,
   * which refuses every voice a Mac's WebView offers. The cases below are the
   * ones the app itself was in.
   */
  it('names the downloaded voice Automatic means, where the platform has none', () => {
    expect(pickerFor({}, [compact], [englishPack]).selectedOptions[0]?.textContent).toBe('Automatic (Heart)')
  })

  it('offers a pack’s voices under the pack’s own name', () => {
    /* The pack is the group heading because it is what a reader is choosing
       between: two packs can ship a voice of one name, and the tier headings
       say nothing about where a downloaded voice came from. */
    const groups = [...pickerFor({}, [compact], [englishPack]).querySelectorAll('optgroup')]
    expect(groups.map((group) => group.label)).toEqual(['English'])
    expect([...groups[0]!.querySelectorAll('option')].map((option) => [option.value, option.textContent])).toEqual([
      ['kokoro:af_heart', 'Heart'],
      ['kokoro:af_bella', 'Bella'],
    ])
  })

  it('offers the packs above the platform’s own voices, the order the reading asks in', () => {
    /* ⚠️ `engineVoiceFor` runs in FRONT of `voiceFor`, so a list that put the
       platform's tiers first would name a second-choice voice in its first row. */
    const select = pickerFor({}, [installed], [englishPack])
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['English', 'Enhanced'])
  })

  it('says what Automatic means, not what the reader already chose', () => {
    /* ⚠️ Selecting the Automatic row stores `''`, so the label has to name what
       the reading would pick with NOTHING stored. Asked with the choice in
       hand, `engineVoiceFor` honours it and the row said "Automatic (Bella)" to
       a reader who had chosen Bella. */
    const select = pickerFor({ en: 'kokoro:af_bella' }, [compact], [englishPack])
    expect(select.options[0]?.textContent).toBe('Automatic (Heart)')
    expect(select.value).toBe('kokoro:af_bella')
  })

  it('draws no heading for a pack with no voices in it', () => {
    /* ⚠️ A heading with nothing under it: `VoicePack.voices` is data from a
       manifest, not something this file constructs. */
    const select = pickerFor({}, [installed], [{ ...englishPack, voices: [] }])
    expect([...select.querySelectorAll('optgroup')].map((group) => group.label)).toEqual(['Enhanced'])
  })

  it('reads a stored choice through the pack its FAMILY names, not the first pack listed', () => {
    /* ⚠️ Two packs can each ship a voice, and the family is what says whose.
       Matching any pack would look the Chinese voice up in the English pack,
       find nothing, and quietly draw the row as Automatic. */
    const chinese: VoicePack = {
      ...englishPack,
      id: 'chinese-qwen',
      name: 'Chinese',
      family: 'qwen',
      voices: [{ id: 'Vivian', name: 'Vivian', language: 'zh-CN', note: '' }],
    }
    expect(pickerFor({ en: 'qwen:Vivian' }, [compact], [englishPack, chinese]).value).toBe('qwen:Vivian')
  })

  it('falls through for a stored voice the pack no longer ships', () => {
    /* A pack re-cut without a voice is the same case as a pack removed: the
       row must show what the reading will actually do. */
    expect(pickerFor({ en: 'kokoro:af_nobody' }, [compact], [englishPack]).selectedOptions[0]?.textContent).toBe(
      'Automatic (Heart)',
    )
    cleanup()
    const other = pickerFor({ en: 'qwen:Vivian' }, [compact], [englishPack])
    expect(other.selectedOptions[0]?.textContent, 'nor a family no pack has').toBe('Automatic (Heart)')
  })

  it('shows a stored pack voice, and falls through to Automatic once the pack has gone', () => {
    /* Same rule as a platform voice that has been uninstalled. */
    expect(pickerFor({ en: 'kokoro:af_bella' }, [compact], [englishPack]).value).toBe('kokoro:af_bella')
    cleanup()
    const gone = pickerFor({ en: 'kokoro:af_bella' }, [compact], [{ ...englishPack, installed: false }])
    expect(gone.selectedOptions[0]?.textContent).toBe('None — no high-quality voice is available here')
  })

  it('follows the reading when the voices arrive', () => {
    const { store } = section({ voices: [] })
    expect(picker().selectedOptions[0]?.textContent).toBe('Automatic (system default)')
    act(() =>
      store.publish({ ...store.read()!, voices: [installed] }),
    )
    expect(picker().selectedOptions[0]?.textContent).toBe('Automatic (Zoe)')
  })

  /**
   * ⚠️ **THE ROW'S VALUE IS ASSERTED DIRECTLY, AND IT HAS TO BE.** A `<select>`
   * given a value no option carries reports `''` and shows its first row, so
   * "fell through to Automatic" and "named an option that is not there" are
   * the same DOM. The function is pure, so it is asked itself.
   */
  describe('the value the row is given', () => {
    const picking = (
      chosen: Readonly<Record<string, string>>,
      voices: readonly VoiceFacts[],
      packs: readonly VoicePack[],
    ): VoicePicking => ({ lang: 'en-US', voices, packs, chosen })

    it('is the reader’s own pack voice, when the pack is here and ships it', () => {
      expect(voicePickerValue(picking({ en: 'kokoro:af_bella' }, [compact], [englishPack]))).toBe('kokoro:af_bella')
    })

    it('is Automatic for a stored voice the pack does not ship, or a family no pack has', () => {
      expect(voicePickerValue(picking({ en: 'kokoro:af_nobody' }, [compact], [englishPack]))).toBe('')
      expect(voicePickerValue(picking({ en: 'qwen:Vivian' }, [compact], [englishPack]))).toBe('')
      expect(voicePickerValue(picking({ en: 'kokoro:af_bella' }, [compact], []))).toBe('')
    })

    it('reads a stored PLATFORM identifier without trying to split it as ours', () => {
      /* ⚠️ A reader who chose a system voice before any of this existed has
         `com.apple.voice.enhanced.en-US.Zoe` stored. Treated as an engine
         choice it is a read of `null.family`, which takes the whole pane down. */
      const stored = picking({ en: installed.voiceURI }, [installed], [englishPack])
      expect(() => voicePickerValue(stored)).not.toThrow()
      expect(voicePickerValue(stored)).toBe(installed.voiceURI)
    })

    it('is the platform’s own answer when nothing is stored at all', () => {
      expect(voicePickerValue(picking({}, [installed], [englishPack]))).toBe('')
    })

    it('takes the pack the FAMILY names, with two installed', () => {
      const chinese: VoicePack = {
        ...englishPack,
        id: 'chinese-qwen',
        family: 'qwen',
        voices: [{ id: 'Vivian', name: 'Vivian', language: 'zh-CN', note: '' }],
      }
      expect(voicePickerValue(picking({ en: 'qwen:Vivian' }, [compact], [englishPack, chinese]))).toBe('qwen:Vivian')
    })
  })
})

describe('the speed and the pauses', () => {
  it('writes a speed, a sentence gap and a paragraph gap from their own steppers', () => {
    /* Three scales, three settings, each wired by hand: a stepper that called
       the wrong setter would set the wrong silence with everything looking
       right. The values are the NEXT STEP of each scale from its default —
       1x, 150ms, 600ms — so 1.25x, 300ms and 900ms. */
    const { settings } = section()
    for (const [control, setting, expected] of [
      ['More speed', RATE_SETTING, 1.25],
      ['More pause between sentences', SENTENCE_GAP_SETTING, 300],
      ['More pause between paragraphs', PARAGRAPH_GAP_SETTING, 900],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: control }))
      expect(settings.get(setting), `${control} stored the wrong thing`).toBe(expected)
    }
  })

  it('steps back down from where the reader stands', () => {
    const settings = narrationSettings()
    settings.set(RATE_SETTING, 2)
    settings.set(SENTENCE_GAP_SETTING, 500)
    settings.set(PARAGRAPH_GAP_SETTING, 2000)
    section({}, settings)
    fireEvent.click(screen.getByRole('button', { name: 'Less speed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Less pause between sentences' }))
    fireEvent.click(screen.getByRole('button', { name: 'Less pause between paragraphs' }))
    expect([
      settings.get(RATE_SETTING),
      settings.get(SENTENCE_GAP_SETTING),
      settings.get(PARAGRAPH_GAP_SETTING),
    ]).toEqual([1.75, 300, 1400])
  })

  it('stands each stepper where the stored value is', () => {
    const settings = narrationSettings()
    settings.set(RATE_SETTING, 1.5)
    section({}, settings)
    expect(screen.getByRole('img', { name: 'Step 5 of 8' })).toBeTruthy()
    expect(screen.getByTitle('Speed: 1.5×')).toBeTruthy()
    expect(screen.getByTitle('Pause between sentences: 150ms')).toBeTruthy()
    expect(screen.getByTitle('Pause between paragraphs: 600ms')).toBeTruthy()
  })
})

describe('the volume', () => {
  it('is a slider with a name, standing where the reader left it', () => {
    const settings = narrationSettings()
    settings.set(VOLUME_SETTING, 40)
    section({}, settings)
    const slider = screen.getByRole('slider', { name: 'Reading volume' }) as HTMLInputElement
    expect(slider.type).toBe('range')
    expect([slider.min, slider.max, slider.step]).toEqual(['0', '100', '5'])
    expect(slider.value).toBe('40')
    expect(slider.className).toBe(ui.volume)
    /* Said in words as well as drawn, for the reader who cannot see the thumb. */
    expect(slider.getAttribute('aria-valuetext')).toBe('40%')
    expect(screen.getByText('40%').className).toBe(ui.value)
  })

  it('stores the volume the slider was moved to, as a number', () => {
    const { settings } = section()
    fireEvent.change(screen.getByRole('slider', { name: 'Reading volume' }), { target: { value: '0' } })
    expect(settings.get(VOLUME_SETTING)).toBe(0)
    expect(screen.getByText('0%'), 'and says so').toBeTruthy()
  })

  it('sits in a row like the steppers around it', () => {
    section()
    expect(screen.getByRole('slider', { name: 'Reading volume' }).parentElement?.className).toBe(ui.row)
  })
})

describe('reading footnotes', () => {
  /* A SWITCH, as the kernel's on-or-off rows are (`ToggleRow` in the kernel's
     Settings): a `<button role="switch">` whose state is `aria-checked` and
     whose name is the label alone, so it does not change under the finger. */
  it('is a switch, off by default, that stores what it is turned to', () => {
    const { settings } = section()
    const toggle = screen.getByRole('switch', { name: 'Read footnotes' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.textContent).toBe('Off')
    fireEvent.click(toggle)
    expect(settings.get(NOTES_ALOUD_SETTING)).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.textContent).toBe('On')
    fireEvent.click(toggle)
    expect(settings.get(NOTES_ALOUD_SETTING)).toBe(false)
  })

  it('is a button, so Enter turns it as well as Space', () => {
    /* A checkbox answers Space alone; a button answers Enter and Space, which
       is what every other switch in Settings answers. jsdom does not run a
       browser's key activation, so the element itself is what is pinned. */
    section()
    const toggle = screen.getByRole('switch', { name: 'Read footnotes' }) as HTMLButtonElement
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.type).toBe('button')
    expect(toggle.className).toBe(ui.button)
    expect(toggle.parentElement?.className, 'in a row like the steppers around it').toBe(ui.row)
  })

  it('stands where the stored value is', () => {
    const settings = narrationSettings()
    settings.set(NOTES_ALOUD_SETTING, true)
    section({}, settings)
    expect(screen.getByRole('switch', { name: 'Read footnotes' }).getAttribute('aria-checked')).toBe('true')
  })
})

describe('the section', () => {
  it('is one section of rows, built from the shared classes', () => {
    const { view } = section()
    const root = view.container.firstElementChild!
    expect(root.className).toBe(ui.section)
    expect([...root.children].map((row) => row.className)).toEqual([ui.row, ui.row, ui.row, ui.row, ui.row, ui.row])
  })

  it('follows a setting changed elsewhere — the transport, or another window', () => {
    const { settings } = section()
    act(() => settings.set(RATE_SETTING, 2))
    expect(screen.getByTitle('Speed: 2×')).toBeTruthy()
  })
})
