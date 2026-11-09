import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  carryLegacySettings,
  createSettingsStore,
  scopeSettings,
  stepAt,
  type SettingsStore,
  type SteppedScale,
} from '../../../kernel'
import {
  NOTES_ALOUD_SETTING,
  PARAGRAPH_GAP,
  PARAGRAPH_GAP_MAX,
  PARAGRAPH_GAP_MIN,
  PARAGRAPH_GAP_SETTING,
  RATE_SETTING,
  READING_RATE,
  READING_RATE_MAX,
  READING_RATE_MIN,
  READING_VOLUME_MAX,
  READING_VOLUME_MIN,
  SENTENCE_GAP,
  SENTENCE_GAP_MAX,
  SENTENCE_GAP_MIN,
  SENTENCE_GAP_SETTING,
  VOICE_SETTING,
  VOLUME_SETTING,
  chooseVoice,
  prefsOf,
  setParagraphGap,
  setRate,
  setSentenceGap,
  setVolume,
  toggleNotesAloud,
} from './settings'

/**
 * Read aloud's settings, as narration declares them.
 *
 * Until step 5.5 these were `KERNEL_SETTINGS.reading*`, and the kernel's
 * `settings.test.ts` held their parsers and their ranges; those cases are here
 * now, asked of the narration settings. The kernel keeps what is still its own:
 * the import that carries `kernel.*` to `narration.*` on load.
 */

/**
 * A store over `values` as they would sit on disk, scoped as the registry
 * scopes narration, and what the disk holds under `key` after it: the value
 * as written, which `get` would read through the setting's parser.
 */
function onDisk(values: Record<string, unknown> | null) {
  const map = new Map<string, string>()
  if (values !== null) map.set(SETTINGS_STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION, values }))
  const settings = scopeSettings(
    createSettingsStore({
      storage: {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
      },
    }),
    'narration',
  )
  const saved = (key: string): unknown =>
    (JSON.parse(map.get(SETTINGS_STORAGE_KEY) ?? '{"values":{}}') as { values: Record<string, unknown> }).values[key]
  return { settings, saved }
}

const storedAs = (values: Record<string, unknown> | null): SettingsStore => onDisk(values).settings

const fresh = (): SettingsStore => storedAs(null)

describe('the keys and the defaults', () => {
  it('stores each setting under the name the kernel import writes', () => {
    /* ⚠️ **THE KEYS ARE THE IMPORT'S.** `carryNarrationSettings` copies
       `kernel.<name>` to `narration.<name>`, so a setting declared under any
       other name is a choice the move silently drops. */
    expect(
      [VOICE_SETTING, RATE_SETTING, VOLUME_SETTING, NOTES_ALOUD_SETTING, SENTENCE_GAP_SETTING, PARAGRAPH_GAP_SETTING].map(
        (setting) => setting.key,
      ),
    ).toEqual([
      'narration.readingVoice',
      'narration.readingRate',
      'narration.readingVolume',
      'narration.readingNotesAloud',
      'narration.sentenceGapMs',
      'narration.paragraphGapMs',
    ])
  })

  it('answers what the kernel answered for a reader who never chose', () => {
    /* The defaults are what make the move inaudible: full volume, the
       engine's own speed, a breath at a sentence and a beat at a paragraph,
       footnotes left out, and no voice chosen for any language. */
    expect(prefsOf(fresh())).toEqual({
      voices: {},
      rate: 1,
      volume: 1,
      sentenceGapMs: 150,
      paragraphGapMs: 600,
      notesAloud: false,
    })
  })

  it('reads a value stored under the new key', () => {
    const settings = storedAs({
      'narration.readingVoice': { en: 'kokoro:af_heart' },
      'narration.readingRate': 1.5,
      'narration.readingVolume': 40,
      'narration.readingNotesAloud': true,
      'narration.sentenceGapMs': 500,
      'narration.paragraphGapMs': 1400,
    })
    expect(prefsOf(settings)).toEqual({
      voices: { en: 'kokoro:af_heart' },
      rate: 1.5,
      volume: 0.4,
      sentenceGapMs: 500,
      paragraphGapMs: 1400,
      notesAloud: true,
    })
  })
})

/**
 * THE SCALES A READER STEPS THROUGH — ordered, in their own unit, and with a
 * default step whose value is what a reader who never opens the pane gets.
 * The kernel's `metrics.test.ts` holds its own scales to this; these three
 * moved out of it with the Voice rows.
 */
describe('the stepped scales', () => {
  it.each([
    ['reading rate', READING_RATE, 'x', 1],
    ['sentence gap', SENTENCE_GAP, 'ms', 150],
    ['paragraph gap', PARAGRAPH_GAP, 'ms', 600],
  ] as ReadonlyArray<readonly [string, SteppedScale, string, number]>)(
    '%s runs in order, in its own unit, and starts where the app has always been',
    (_name, scale, unit, standing) => {
      expect(scale.unit).toBe(unit)
      expect(scale.steps.length).toBeGreaterThan(1)
      expect(scale.steps[scale.def]).toBe(standing)
      expect(stepAt(scale, scale.def)).toBe(standing)
      expect([...scale.steps].sort((a, b) => a - b)).toEqual([...scale.steps])
    },
  )

  it('offers the speeds every audiobook player does', () => {
    expect(READING_RATE.steps).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5])
    expect(SENTENCE_GAP.steps).toEqual([0, 150, 300, 500, 750, 1000])
    expect(PARAGRAPH_GAP.steps).toEqual([0, 300, 600, 900, 1400, 2000])
  })
})

describe('the range read aloud may be stored in', () => {
  /**
   * ⚠️ **THE RANGE A READER CAN STORE AND THE RANGE THE STEPPER OFFERS MUST BE
   * ONE RANGE**, which is why these are derived from the scales rather than
   * written down again. A clamp that disagreed with the stepper would refuse a
   * value the pane had just produced.
   */
  it('is exactly the ends of the scale the pane steps through', () => {
    expect([READING_RATE_MIN, READING_RATE_MAX]).toEqual([READING_RATE.steps.at(0), READING_RATE.steps.at(-1)])
    expect([SENTENCE_GAP_MIN, SENTENCE_GAP_MAX]).toEqual([SENTENCE_GAP.steps.at(0), SENTENCE_GAP.steps.at(-1)])
    expect([PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX]).toEqual([PARAGRAPH_GAP.steps.at(0), PARAGRAPH_GAP.steps.at(-1)])
    expect([READING_VOLUME_MIN, READING_VOLUME_MAX]).toEqual([0, 100])
  })

  it('clamps a stored number to those ends rather than refusing it', () => {
    /* A file written by a build with a wider ramp is not corrupt — it is
       describing a speed this build offers less of. */
    const settings = storedAs({
      'narration.readingRate': 99,
      'narration.readingVolume': 150,
      'narration.sentenceGapMs': 99_999,
      'narration.paragraphGapMs': -20,
    })
    expect(settings.get(RATE_SETTING)).toBe(READING_RATE_MAX)
    expect(settings.get(VOLUME_SETTING)).toBe(READING_VOLUME_MAX)
    expect(settings.get(SENTENCE_GAP_SETTING)).toBe(SENTENCE_GAP_MAX)
    expect(settings.get(PARAGRAPH_GAP_SETTING)).toBe(PARAGRAPH_GAP_MIN)
    const low = storedAs({ 'narration.readingRate': 0.01, 'narration.readingVolume': -5 })
    expect([low.get(RATE_SETTING), low.get(VOLUME_SETTING)]).toEqual([READING_RATE_MIN, READING_VOLUME_MIN])
  })

  it('reads back a volume in range, both ends included', () => {
    /* 0 is the end that matters: a falsy value lost on the way back from disk
       is the reading run playing aloud. */
    for (const stored of [0, 37, 100]) {
      expect(storedAs({ 'narration.readingVolume': stored }).get(VOLUME_SETTING)).toBe(stored)
    }
  })

  it('refuses a number that is not finite, whatever kind of value it is, and the default stands', () => {
    /* `Math.min` over a NaN answers NaN, and a NaN rate makes the engine refuse
       the utterance; an infinite gap is a reading that never continues. */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1.5', null, {}, [], true]) {
      for (const setting of [RATE_SETTING, VOLUME_SETTING, SENTENCE_GAP_SETTING, PARAGRAPH_GAP_SETTING]) {
        expect(setting.parse(bad), `${String(bad)} was taken for ${setting.key}`).toBeUndefined()
      }
    }
    expect(RATE_SETTING.parse(99), 'and a number is clamped, not refused').toBe(READING_RATE_MAX)
    expect(storedAs({ 'narration.readingRate': '1.5' }).get(RATE_SETTING)).toBe(1)
  })

  it('reads an infinite speed in the file as no speed at all', () => {
    /* `JSON.stringify(Infinity)` is `null`, so this can only arrive as source
       text — `1e999` parses to Infinity. It is the one route by which a
       non-finite number reaches the clamp, and the clamp must refuse it:
       `Math.min` over an Infinity answers the bound, which would store a speed
       the reader never chose. */
    const map = new Map<string, string>([
      [SETTINGS_STORAGE_KEY, `{"version":${SETTINGS_VERSION},"values":{"narration.readingRate":1e999}}`],
    ])
    const settings = scopeSettings(
      createSettingsStore({
        storage: { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) },
      }),
      'narration',
    )
    expect(settings.get(RATE_SETTING)).toBe(1)
  })

  it('reads whether footnotes are read only from a true or a false', () => {
    expect(NOTES_ALOUD_SETTING.parse(true)).toBe(true)
    expect(NOTES_ALOUD_SETTING.parse(false)).toBe(false)
    for (const bad of [1, 'true', null, {}]) expect(NOTES_ALOUD_SETTING.parse(bad)).toBeUndefined()
  })
})

describe('the voice a reader chose, per language', () => {
  /**
   * ONE VOICE PER LANGUAGE, and a bad entry costs itself. A junk value for one
   * language must not take the reader's other choices with it; a value of the
   * wrong SHAPE — anything that is not a map — is refused whole, because that
   * is not a map with a bad member.
   */
  it('keeps every language that names a voice', () => {
    const stored = { en: 'com.apple.voice.enhanced.en-US.Zoe', zh: 'com.apple.voice.enhanced.zh-CN.Tingting' }
    expect(storedAs({ 'narration.readingVoice': stored }).get(VOICE_SETTING)).toEqual(stored)
  })

  it('drops the entry that is not a voice, and keeps the rest', () => {
    expect(
      VOICE_SETTING.parse({ en: 'com.apple.voice.enhanced.en-US.Zoe', zh: '', fr: 7, de: null }),
    ).toEqual({ en: 'com.apple.voice.enhanced.en-US.Zoe' })
  })

  it('refuses a value that is not a map of languages at all, rather than throwing on it', () => {
    /* `typeof null` is 'object', so the null check is what stands between
       `Object.entries(null)` and a throw. */
    for (const bad of ['com.apple.voice.enhanced.en-US.Zoe', 7, ['en'], null]) {
      expect(VOICE_SETTING.parse(bad)).toBeUndefined()
      expect(storedAs({ 'narration.readingVoice': bad }).get(VOICE_SETTING)).toEqual({})
    }
  })
})

describe('choosing a voice', () => {
  it('merges one language into the map, leaving the others alone', () => {
    const settings = fresh()
    chooseVoice(settings, 'en', 'voice:en')
    chooseVoice(settings, 'zh', 'voice:zh')
    expect(settings.get(VOICE_SETTING)).toEqual({ en: 'voice:en', zh: 'voice:zh' })
    chooseVoice(settings, 'en', 'voice:en-2')
    expect(settings.get(VOICE_SETTING)).toEqual({ en: 'voice:en-2', zh: 'voice:zh' })
  })

  it('forgets the language on an empty voice, rather than storing an empty string', () => {
    const { settings, saved } = onDisk(null)
    chooseVoice(settings, 'en', 'voice:en')
    chooseVoice(settings, 'zh', 'voice:zh')
    chooseVoice(settings, 'en', '')
    expect(settings.get(VOICE_SETTING)).toEqual({ zh: 'voice:zh' })
    /* Asked of the file too: the parser drops an empty voice on the way out,
       so `get` alone cannot tell a forgotten language from a dead key. */
    expect(saved('narration.readingVoice')).toEqual({ zh: 'voice:zh' })
  })

  it('writes nothing for a choice that changes nothing', () => {
    /* The spread moves the language's key to the end, which serialises
       differently — so an unchanged choice would otherwise be written. */
    const settings = fresh()
    chooseVoice(settings, 'en', 'voice:en')
    chooseVoice(settings, 'zh', 'voice:zh')
    const told = vi.fn()
    settings.subscribe(told)
    chooseVoice(settings, 'en', 'voice:en')
    chooseVoice(settings, 'fr', '')
    expect(told).not.toHaveBeenCalled()
    expect(Object.keys(settings.get(VOICE_SETTING))).toEqual(['en', 'zh'])
  })

  it('writes nothing for Automatic over a language whose stored voice was already unreadable', () => {
    /* The file holds an empty voice for English, which the parser drops, so
       the picker already shows Automatic there: choosing it changes nothing a
       reader can see, and the dead key is not this choice to clean. */
    const { settings, saved } = onDisk({ 'narration.readingVoice': { en: '', zh: 'voice:zh' } })
    const told = vi.fn()
    settings.subscribe(told)
    chooseVoice(settings, 'en', '')
    expect(told).not.toHaveBeenCalled()
    expect(saved('narration.readingVoice')).toEqual({ en: '', zh: 'voice:zh' })
  })
})

describe('a value from a control', () => {
  /* CLAMPED HERE TOO, not only by the parser: the parser guards what arrives
     from disk, and these guard what arrives from a control. */
  it('stores a number in range as it is', () => {
    const settings = fresh()
    setRate(settings, 1.75)
    setVolume(settings, 35)
    setSentenceGap(settings, 300)
    setParagraphGap(settings, 900)
    expect([
      settings.get(RATE_SETTING),
      settings.get(VOLUME_SETTING),
      settings.get(SENTENCE_GAP_SETTING),
      settings.get(PARAGRAPH_GAP_SETTING),
    ]).toEqual([1.75, 35, 300, 900])
  })

  it('stores the nearest end for a number past either one', () => {
    const settings = fresh()
    setRate(settings, 9)
    setVolume(settings, 400)
    setSentenceGap(settings, 99_999)
    setParagraphGap(settings, 99_999)
    expect([
      settings.get(RATE_SETTING),
      settings.get(VOLUME_SETTING),
      settings.get(SENTENCE_GAP_SETTING),
      settings.get(PARAGRAPH_GAP_SETTING),
    ]).toEqual([READING_RATE_MAX, READING_VOLUME_MAX, SENTENCE_GAP_MAX, PARAGRAPH_GAP_MAX])
    setRate(settings, 0)
    setVolume(settings, -1)
    setSentenceGap(settings, -1)
    setParagraphGap(settings, -1)
    expect([
      settings.get(RATE_SETTING),
      settings.get(VOLUME_SETTING),
      settings.get(SENTENCE_GAP_SETTING),
      settings.get(PARAGRAPH_GAP_SETTING),
    ]).toEqual([READING_RATE_MIN, READING_VOLUME_MIN, SENTENCE_GAP_MIN, PARAGRAPH_GAP_MIN])
  })

  it('changes nothing for a control that sends a non-number, and says so', () => {
    /* A NaN is handed on unclamped, and the store refuses a value its own
       parser cannot read back — so a broken control is a line in the log, not
       the minimum stored in its place. */
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const settings = fresh()
      setRate(settings, 1.5)
      setRate(settings, Number.NaN)
      expect(settings.get(RATE_SETTING)).toBe(1.5)
      expect(said).toHaveBeenCalledWith(
        'Paper: the setting narration.readingRate was not changed, because its own parser cannot read that value back',
      )
    } finally {
      said.mockRestore()
    }
  })

  it.each([
    ['reading rate', setRate, RATE_SETTING, 1.5],
    ['reading volume', setVolume, VOLUME_SETTING, 35],
    ['sentence gap', setSentenceGap, SENTENCE_GAP_SETTING, 300],
    ['paragraph gap', setParagraphGap, PARAGRAPH_GAP_SETTING, 900],
  ] as const)('keeps the %s when handed Infinity or -Infinity, and says so', (_, put, setting, start) => {
    /* `Math.min(max, Infinity)` is the maximum, so a clamp alone would store
       an end the reader never chose. 5.4's reducer refused every non-finite
       value; the store's own parser refuses it here, with its line. */
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const settings = fresh()
      put(settings, start)
      put(settings, Number.POSITIVE_INFINITY)
      expect(settings.get(setting)).toBe(start)
      put(settings, Number.NEGATIVE_INFINITY)
      expect(settings.get(setting)).toBe(start)
      expect(said).toHaveBeenCalledTimes(2)
      expect(said).toHaveBeenCalledWith(
        `Paper: the setting ${setting.key} was not changed, because its own parser cannot read that value back`,
      )
    } finally {
      said.mockRestore()
    }
  })

  it('turns reading footnotes on, and off again', () => {
    const settings = fresh()
    toggleNotesAloud(settings)
    expect(settings.get(NOTES_ALOUD_SETTING)).toBe(true)
    toggleNotesAloud(settings)
    expect(settings.get(NOTES_ALOUD_SETTING)).toBe(false)
  })
})

describe('the choices, as the speaker takes them', () => {
  it('hands the volume over as a fraction, the only division between the disk and the speakers', () => {
    const settings = fresh()
    for (const [stored, fraction] of [
      [0, 0],
      [40, 0.4],
      [100, 1],
    ] as const) {
      setVolume(settings, stored)
      expect(prefsOf(settings).volume).toBe(fraction)
    }
  })

  it('follows every setting as it changes', () => {
    const settings = fresh()
    chooseVoice(settings, 'en', 'voice:en')
    setRate(settings, 2)
    setSentenceGap(settings, 0)
    setParagraphGap(settings, 2000)
    toggleNotesAloud(settings)
    expect(prefsOf(settings)).toEqual({
      voices: { en: 'voice:en' },
      rate: 2,
      volume: 1,
      sentenceGapMs: 0,
      paragraphGapMs: 2000,
      notesAloud: true,
    })
  })
})

/**
 * A FILE A 5.4 BUILD SAVED AFTER THIS ONE (plan, D6: "an old build still reads
 * and saves the file").
 *
 * `downgraded-5.4.json` was not written by hand. This build loaded
 * `voice-chosen-5.4.json` and set the speed to 1.5×; the 5.4 code, run on what
 * that saved, read the reader's choices back through its own
 * `readKernelPreferences`, changed the English voice through its own
 * `writeKernelPreferences` and saved. Never regenerate it to make this pass:
 * it is what a reader who went back a version and returned has on disk.
 */
describe('a file a 5.4 build saved after this one', () => {
  const fixture = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/settings/${name}`, import.meta.url)), 'utf8').trim()

  /** A store over storage holding `text`, as the app makes one, with what it saves. */
  const over = (text: string) => {
    const map = new Map([[SETTINGS_STORAGE_KEY, text]])
    const store = createSettingsStore({
      storage: { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) },
      migrate: carryLegacySettings,
    })
    return { settings: scopeSettings(store, 'narration'), saved: () => map.get(SETTINGS_STORAGE_KEY)! }
  }

  const values = (text: string) => (JSON.parse(text) as { values: Record<string, unknown> }).values
  const narrationOf = (record: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('narration.')))

  it('keeps every narration choice this build wrote, through a save by the build that knew none of them', () => {
    const written = over(fixture('voice-chosen-5.4.json'))
    setRate(written.settings, 1.5)
    const ours = narrationOf(values(written.saved()))
    expect(Object.keys(ours)).toHaveLength(6)
    const downgraded = values(fixture('downgraded-5.4.json'))
    expect(narrationOf(downgraded)).toEqual(ours)
    /* And the 5.4 build did save: the voice it changed is on its own key. */
    expect(downgraded['kernel.readingVoice']).toEqual({
      en: 'com.apple.voice.compact.en-US.Samantha',
      zh: 'com.apple.voice.premium.zh-CN.Lilian',
    })
  })

  it('reads the narration keys back over what the 5.4 build changed on the old ones', () => {
    /* ⚠️ THE NEW KEY WINS, as D6 decides: the voice changed on the older build
       stays on `kernel.readingVoice` and is not carried over the newer choice. */
    expect(prefsOf(over(fixture('downgraded-5.4.json')).settings)).toEqual({
      voices: { en: 'kokoro:af_heart', zh: 'com.apple.voice.premium.zh-CN.Lilian' },
      rate: 1.5,
      volume: 0.4,
      sentenceGapMs: 500,
      paragraphGapMs: 1400,
      notesAloud: true,
    })
  })
})
