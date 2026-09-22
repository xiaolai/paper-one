import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIGHTNESS,
  CONTRAST,
  PARAGRAPH_GAP,
  READING_RATE,
  SENTENCE_GAP,
  DEFAULT_READING_STYLE,
  LEGACY_READING_SIZES,
  MINIMUM_SIZES,
  READING_STEPS,
  SPACING,
  stepIndexForSize,
} from './metrics'
import { initialState, preferencesOf } from '../ui/state'
import { defineSetting } from './ports'
import type { ReadingStyle } from './uiTypes'
import {
  KERNEL_SETTINGS,
  PARAGRAPH_GAP_MAX,
  PARAGRAPH_GAP_MIN,
  READING_RATE_MAX,
  READING_RATE_MIN,
  SENTENCE_GAP_MAX,
  SENTENCE_GAP_MIN,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  carryLegacySettings,
  createSettingsStore,
  readKernelPreferences,
  writeKernelPreferences,
  type KernelPreferences,
} from './settings'

/**
 * The reader's settings, across launches.
 *
 * Paper persisted none of this: theme, type size, spacing, brightness,
 * contrast and reading flow were held in a `useReducer` and nowhere else, so
 * every launch handed back the defaults — a reader who had set Night at 19px
 * got Paper at 17px the next morning, every morning, with nothing to say why.
 *
 * WHAT IS PERSISTED IS A DECISION, not everything in `AppState`. The test is
 * whether the value is something the reader CHOSE about how they read, or
 * something about this session. A theme is chosen; an open palette is not.
 * `KERNEL_SETTINGS` is that split, and `preferencesOf` is its other half —
 * these tests hold the two to each other, because a field saved and never
 * restored (or the reverse) announces itself nowhere in the app.
 */

const DEFAULTS: KernelPreferences = preferencesOf(initialState)

/** A store over a file holding exactly `raw`, read back as preferences. */
const readingBack = (raw: unknown): KernelPreferences => {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, text]])
  return readKernelPreferences(
    createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      },
      migrate: carryLegacySettings,
    }),
  )
}

/** A `MarkStorage` over a Map, for the cases that read it back. */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

/** The envelope a build of this version writes. */
const envelope = (values: Record<string, unknown>) => ({ version: SETTINGS_VERSION, values })

/** The same preferences as an envelope, through the writer that makes one. */
const stored = (prefs: KernelPreferences): Record<string, unknown> => {
  const map = new Map<string, string>()
  const store = createSettingsStore({
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
  })
  writeKernelPreferences(store, prefs)
  return JSON.parse(map.get(SETTINGS_STORAGE_KEY) ?? '{"values":{}}').values as Record<string, unknown>
}

describe('what is persisted', () => {
  it('takes exactly the fields a reader chose, and none of the session', () => {
    /* The split is the whole design. Restoring `screen` or `paletteOpen` would
       put someone back into a search or an open overlay they have no memory of
       leaving; not restoring `theme` is the bug this file exists to fix. */
    const names = Object.keys(KERNEL_SETTINGS)
    expect(names).toContain('theme')
    expect(names).toContain('textSize')
    expect(names).toContain('brightness')
    for (const session of ['screen', 'pane', 'paletteOpen', 'switcherOpen', 'libraryQuery', 'chromeOn', 'rulerPinned', 'tagsOpen']) {
      expect(names, session).not.toContain(session)
    }
  })

  it('namespaces every key it owns, so a capability cannot collide with one', () => {
    for (const setting of Object.values(KERNEL_SETTINGS)) {
      expect(setting.key).toMatch(/^kernel\./)
    }
  })

  it('round-trips every persisted field', () => {
    const changed: KernelPreferences = {
      ...DEFAULTS,
      theme: 'night',
      themeFollowsOs: false,
      side: 'left',
      rulerOn: true,
      textSize: 19,
      spacing: { letter: 2, word: 1, line: 3, paragraph: 0 },
      align: 'ragged',
      brightness: 0,
      contrast: 1,
      typeface: 'literata',
      scrollbarOn: true,
      progressLineOn: true,
      pageLayout: 'paginated',
      markTint: 'purple',
      markStyle: 'underline',
    }
    expect(readingBack(envelope(stored(changed)))).toEqual(changed)
  })
})

describe('reading a file nobody can vouch for', () => {
  it('returns the defaults when there is nothing stored', () => {
    expect(readKernelPreferences(createSettingsStore({ storage: fakeStorage() }))).toEqual(DEFAULTS)
  })

  /* ⚠️ **UNREADABLE IS NOT ABSENT, AND THESE TWO USED TO BE ONE ANSWER.**
     `parseEnvelope` answered `null` for bytes that are not JSON and for a shape
     that is not an envelope, so the store came up carrying no values with
     writes still ON — and the next preference the reader changed replaced the
     file with an envelope holding that one alone. A storage that THREW on the
     read was fixed by an earlier audit; a file that will not READ, which is the
     commoner of the two, took the other path until the 2026-09-13 audit. The
     reader still gets the defaults; what changes is that the file survives.
     `null` is included deliberately — it is what an empty file parses to, and
     `typeof null` is 'object'. */
  it.each([
    ['rubbish', 'not json', 'the stored settings are not JSON'],
    ['truncated', '{oops', 'the stored settings are not JSON'],
    ['an empty string', '', 'the stored settings are not JSON'],
    ['JSON null', 'null', 'the stored settings are not an envelope'],
    ['a list', '[]', 'the stored settings are not an envelope'],
    ['a bare number', '42', 'the stored settings are not an envelope'],
    ['a bare string', '"night"', 'the stored settings are not an envelope'],
  ])('keeps the defaults for a file that is %s, and writes nothing over it', (_name, raw, clause) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, raw]])
      const store = createSettingsStore({
        storage: {
          getItem: (key: string) => map.get(key) ?? null,
          setItem: (key: string, value: string) => void map.set(key, value),
        },
      })

      expect(readKernelPreferences(store)).toEqual(DEFAULTS)
      expect(store.persistent, 'and is told nothing is being saved').toBe(false)
      /* SAID, and for ITS reason: the two refusals share a prefix, so each is
         held to its whole sentence rather than to the words they have in common. */
      expect(error.mock.calls[0]?.[0]).toBe('Paper: settings could not be read, and will not be saved this session')
      const cause: unknown = error.mock.calls[0]?.[1]
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).message).toBe(clause)

      store.set(KERNEL_SETTINGS.side, 'left')
      expect(store.get(KERNEL_SETTINGS.side), 'the session still sees what it chose').toBe('left')
      expect(map.get(SETTINGS_STORAGE_KEY), 'the file it could not read must be intact').toBe(raw)
    } finally {
      error.mockRestore()
    }
  })

  it('keeps what the JSON parser said, as the cause of refusing bytes that are not JSON', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      createSettingsStore({ storage: { getItem: () => '{oops', setItem: () => {} } })
      const cause: unknown = error.mock.calls[0]?.[1]
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).cause).toBeInstanceOf(SyntaxError)
    } finally {
      error.mockRestore()
    }
  })

  /* THE KEY IS THE STORED FORMAT'S NAME. Every other case here reads it through
     the constant, so none of them could notice it change — and a changed key
     is every reader's preferences orphaned, on the first launch of that build. */
  it('reads the file earlier builds wrote, under the name they wrote it', () => {
    const map = new Map<string, string>([['paper.settings.v1', JSON.stringify(envelope({ 'kernel.theme': 'night' }))]])
    const store = createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      },
    })
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('night')
  })

  /* ⚠️ **A COLLECTION THAT IS DAMAGED IS NOT A COLLECTION THAT IS EMPTY, AND
     THE ENVELOPE'S `values` WAS THE ONE LEFT OUT OF THE RULE ABOVE.** Bytes
     that are not an envelope at all were made to throw by the 2026-09-13
     audit; a well-formed envelope whose `values` is a LIST, a string or a
     number went on reading as `{}` with writes still ON — so the first
     preference the reader changed replaced the whole file with an envelope
     holding that one alone. That is the very loss the block above describes,
     one field further in, and the two are spelled apart here because the
     clauses share a prefix. Found by the 2026-09-13 verify.

     A legacy FLAT file has no `values` key at all and is untouched by this —
     see "carrying the pre-kernel settings file across" — and a versioned
     envelope with no `values` really is carrying nothing. */
  it.each([
    ['a list', { version: SETTINGS_VERSION, values: [{ 'kernel.theme': 'night' }] }],
    ['an empty list', { version: SETTINGS_VERSION, values: [] }],
    ['a bare string', { version: SETTINGS_VERSION, values: 'night' }],
    ['a bare number', { version: SETTINGS_VERSION, values: 42 }],
    ['JSON null', { version: SETTINGS_VERSION, values: null }],
    ['a list under no version at all', { values: ['kernel.theme'] }],
  ])('keeps the defaults for an envelope whose values are %s, and writes nothing over it', (_name, doc) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const raw = JSON.stringify(doc)
      const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, raw]])
      const store = createSettingsStore({
        storage: {
          getItem: (key: string) => map.get(key) ?? null,
          setItem: (key: string, value: string) => void map.set(key, value),
        },
      })

      expect(readKernelPreferences(store)).toEqual(DEFAULTS)
      expect(store.persistent, 'and is told nothing is being saved').toBe(false)
      /* Refused for ITS reason, not for the envelope's: the words are this clause's own. */
      const cause: unknown = error.mock.calls[0]?.[1]
      expect(cause).toBeInstanceOf(Error)
      expect((cause as Error).message).toMatch(/have values that are not a collection/u)

      store.set(KERNEL_SETTINGS.side, 'left')
      expect(store.get(KERNEL_SETTINGS.side), 'the session still sees what it chose').toBe('left')
      expect(map.get(SETTINGS_STORAGE_KEY), 'the file it could not read must be intact').toBe(raw)
    } finally {
      error.mockRestore()
    }
  })

  it('still reads a versioned envelope that is carrying no values at all', () => {
    /* THE ONE SHAPE NEXT DOOR THAT IS NOT DAMAGE. `values` absent under a
       version is an envelope this build wrote for a reader who has chosen
       nothing, and refusing it would make a first launch unsaveable. */
    const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION })]])
    const store = createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      },
    })
    expect(readKernelPreferences(store)).toEqual(DEFAULTS)
    expect(store.persistent).toBe(true)
  })

  it('keeps the one field it recognises out of a file of rubbish', () => {
    /* One bad field costs that field and nothing else. A settings file that
       threw would leave the app unable to start, which is a far worse failure
       than a forgotten type size. */
    const got = readingBack(
      envelope({
        'kernel.theme': 'sepia',
        'kernel.textSize': 'huge',
        'kernel.align': 42,
        'kernel.spacing': 'no',
        'kernel.brightness': null,
      }),
    )
    expect(got.theme).toBe('sepia')
    expect(got.textSize).toBe(DEFAULTS.textSize)
    expect(got.align).toBe(DEFAULTS.align)
    expect(got.spacing).toEqual(DEFAULTS.spacing)
    expect(got.brightness).toBe(DEFAULTS.brightness)
  })

  it('refuses a theme, side, alignment or flow it does not have', () => {
    const got = readingBack(
      envelope({
        'kernel.theme': 'aubergine',
        'kernel.side': 'middle',
        'kernel.align': 'centred',
        'kernel.pageLayout': 'scrolly',
      }),
    )
    expect(got.theme).toBe(DEFAULTS.theme)
    expect(got.side).toBe(DEFAULTS.side)
    expect(got.align).toBe(DEFAULTS.align)
    expect(got.pageLayout).toBe(DEFAULTS.pageLayout)
  })

  it('keeps the pane ids in a hidden list, dropping what is not one', () => {
    /* One junk entry costs that entry, not the list — see `stringList`. */
    expect(readingBack(envelope({ 'kernel.hiddenPanes': ['search', 42, null, 'library'] })).hiddenPanes).toEqual([
      'search',
      'library',
    ])
  })

  it('refuses a switch that is not a boolean', () => {
    const got = readingBack(envelope({ 'kernel.rulerOn': 'yes', 'kernel.themeFollowsOs': 0 }))
    expect(got.rulerOn).toBe(DEFAULTS.rulerOn)
    expect(got.themeFollowsOs).toBe(DEFAULTS.themeFollowsOs)
  })
})

describe('indices into a scale', () => {
  it('clamps a step past the end of this build’s ramp', () => {
    /* CLAMPED RATHER THAN REJECTED: a file written by a build with a longer
       ramp is not corrupt, it is describing the end of a scale this build has
       less of. Falling back would throw away a deliberate "as large as it
       goes". */
    const got = readingBack(
      envelope({ 'kernel.stepIdx': 999, 'kernel.brightness': -5, 'kernel.contrast': 999 }),
    )
    /* THE LEGACY INDEX STILL CLAMPS, and 999 still means "as large as it
       goes" — read against the SEVEN-step ramp it was written for, so it lands
       on that ramp's last size rather than on this one's. */
    expect(got.textSize).toBe(LEGACY_READING_SIZES[LEGACY_READING_SIZES.length - 1])
    expect(got.brightness).toBe(0)
    expect(got.contrast).toBe(CONTRAST.steps.length - 1)
  })

  it('rejects a step that indexes nothing at all', () => {
    // A non-integer indexes nothing; `stepAt` on a NaN yields undefined.
    for (const bad of [1.5, Number.NaN, '3', null]) {
      expect(readingBack(envelope({ 'kernel.stepIdx': bad })).textSize).toBe(DEFAULTS.textSize)
    }
  })

  it('fills a partial spacing object from the defaults', () => {
    const got = readingBack(envelope({ 'kernel.spacing': { line: 3, word: 'no' } }))
    expect(got.spacing.line).toBe(3)
    expect(got.spacing.word).toBe(SPACING.word.def)
    expect(got.spacing.letter).toBe(SPACING.letter.def)
    expect(got.spacing.paragraph).toBe(SPACING.paragraph.def)
  })

  it('holds brightness and contrast to their own scales', () => {
    expect(BRIGHTNESS.steps.length).toBeGreaterThan(0)
    const got = readingBack(envelope({ 'kernel.brightness': BRIGHTNESS.steps.length - 1 }))
    expect(got.brightness).toBe(BRIGHTNESS.steps.length - 1)
  })

  it('rejects a fractional brightness or contrast rather than landing between two steps', () => {
    const got = readingBack(envelope({ 'kernel.brightness': 1.5, 'kernel.contrast': 0.5 }))
    expect(got.brightness).toBe(BRIGHTNESS.def)
    expect(got.contrast).toBe(CONTRAST.def)
  })

  /* THE PARSER'S OWN ANSWER, not the store's. `get` forgives a parser that
     throws and falls back on one that answers `undefined`, so through the store
     "not a spacing", "a spacing of defaults" and "a throw" all read alike. The
     port says `T | undefined`: a value of the wrong shape is `undefined`, and
     only asking the parser can hold it to that. */
  it('answers a spacing that is not an object as no spacing at all', () => {
    for (const bad of ['no', 42, null, [], [1, 2, 3, 4]]) {
      expect(KERNEL_SETTINGS.spacing.parse(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('the typeface', () => {
  it('keeps a face this machine may not have', () => {
    /* Which faces exist depends on the machine. Validating against this one's
       fonts would drop a reader's choice the moment they opened the same
       library on a laptop that happens to lack it; `faceById` already resolves
       an unknown id to the default at the point of use. */
    expect(readingBack(envelope({ 'kernel.typeface': 'some-font-only-they-have' })).typeface).toBe(
      'some-font-only-they-have',
    )
  })

  it('refuses an empty or non-string face', () => {
    for (const bad of ['', 42, null, {}]) {
      expect(readingBack(envelope({ 'kernel.typeface': bad })).typeface).toBe(DEFAULTS.typeface)
    }
  })
})

describe('the mark appearance', () => {
  it('restores a tint and a style the reader can choose', () => {
    const got = readingBack(envelope({ 'kernel.markTint': 'purple', 'kernel.markStyle': 'underline' }))
    expect(got.markTint).toBe('purple')
    expect(got.markStyle).toBe('underline')
  })

  it('refuses the companion’s wave, however it got into the file', () => {
    /* READER_STYLES, not every style there is. A settings file naming the
       wave — hand-edited, or written by a build that offered it — must not
       hand the reader a style they cannot choose and cannot see the
       provenance rule behind. */
    expect(readingBack(envelope({ 'kernel.markStyle': 'wave' })).markStyle).toBe(DEFAULTS.markStyle)
  })
})

describe('the reading style', () => {
  /* WI-14.4's fifteen, EVERY ONE MOVED OFF ITS DEFAULT — so a field read from
     the wrong key, or not read at all, comes back as the default and shows. */
  const CHOSEN: ReadingStyle = {
    separation: 'indent',
    flourish: 'drop-cap',
    headingScale: 'paper',
    blockquote: 'rule',
    codeFace: 'paper',
    codeWrap: 'wrap',
    figureWidth: 1,
    figureFrame: 'hairline',
    figureScalesWithText: true,
    figureHeight: 1,
    wideTables: 'shrink',
    noteSize: 'publisher',
    cjkSpacing: true,
    minimumSize: 2,
    fidelity: 'publisher',
  }

  it('reads back every field a reader chose', () => {
    for (const [key, value] of Object.entries(CHOSEN)) {
      expect(value, `${key} must differ from its default, or the case proves nothing`).not.toEqual(
        DEFAULT_READING_STYLE[key as keyof ReadingStyle],
      )
    }
    expect(readingBack(envelope({ 'kernel.readingStyle': CHOSEN })).readingStyle).toEqual(CHOSEN)
  })

  it('keeps each field it recognises and gives each one it does not its own default', () => {
    /* Field by field, never as a blob — and a step past the end of a scale
       clamps, as every other index here does. */
    const got = readingBack(
      envelope({
        'kernel.readingStyle': {
          separation: 'indent',
          flourish: 'sparkles',
          figureWidth: 1.5,
          cjkSpacing: 'yes',
          minimumSize: 99,
        },
      }),
    ).readingStyle
    expect(got).toEqual({
      ...DEFAULT_READING_STYLE,
      separation: 'indent',
      minimumSize: MINIMUM_SIZES.steps.length - 1,
    })
  })

  /* The parser's own answer, for the reason given under "indices into a scale". */
  it('answers a style that is not an object as no style at all', () => {
    for (const bad of ['plain', 42, null, [], ['indent']]) {
      expect(KERNEL_SETTINGS.readingStyle.parse(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('writing only what moved', () => {
  it('writes nothing when nothing the reader chose has changed', () => {
    /* `AppState` changes on every page turn, every chrome fade and every
       keystroke in the search field, and `preferencesOf` builds a fresh object
       each time — so an identity check would write on all of them. The store
       compares BY VALUE, which asks the only question that matters: did
       anything the reader chose actually move? */
    const writes: string[] = []
    const map = new Map<string, string>()
    const store = createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes.push(key)
          map.set(key, value)
        },
      },
    })
    writeKernelPreferences(store, DEFAULTS)
    expect(writes).toHaveLength(0)
    writeKernelPreferences(store, { ...DEFAULTS, theme: 'night' })
    expect(writes).toHaveLength(1)
    writeKernelPreferences(store, { ...DEFAULTS, theme: 'night' })
    expect(writes).toHaveLength(1)
  })

  it('notices a change inside spacing, which an identity compare would miss', () => {
    const writes: string[] = []
    const map = new Map<string, string>()
    const store = createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes.push(key)
          map.set(key, value)
        },
      },
    })
    writeKernelPreferences(store, DEFAULTS)
    // A fresh object holding the same four indices must not count as a change…
    writeKernelPreferences(store, { ...DEFAULTS, spacing: { ...DEFAULTS.spacing } })
    expect(writes).toHaveLength(0)
    // …and one index moving must.
    writeKernelPreferences(store, {
      ...DEFAULTS,
      spacing: { ...DEFAULTS.spacing, line: DEFAULTS.spacing.line + 1 },
    })
    expect(writes).toHaveLength(1)
  })
})

/**
 * The settings file Paper wrote before the kernel existed.
 *
 * A flat map of `AppState` field names under this same key, with no `version`
 * and no `values`. Read as "an envelope carrying nothing" it would hand every
 * reader who had ever chosen a theme the defaults back, once, silently — the
 * exact failure the settings file was added to fix, reintroduced by the file
 * format changing underneath it.
 */
/**
 * THE SIZE IS STORED AS PIXELS, AND ONE MIGRATION READS THE OLD INDEX.
 *
 * `kernel.stepIdx` held an INDEX into `READING_STEPS`, and an index means
 * nothing across a change to that ramp. When it went from seven steps to
 * fourteen, a stored `2` meant 21px on the old scale and 17px on the new one —
 * so every reader would have opened the next launch with smaller type and
 * nothing anywhere to say why. This is what stops that, and what stops it
 * happening again the next time the ramp moves.
 */
describe('the reading size across a change to the ramp', () => {
  it('reads a stored size back as itself', () => {
    expect(readingBack(envelope({ 'kernel.textSize': 24 })).textSize).toBe(24)
  })

  it('migrates the old index through the ramp it was written for', () => {
    /* Index 2 of the seven-step ramp was 21px, and 21px is what the reader
       chose. On this ramp index 2 is 17px, which is what they would have been
       given without this. */
    expect(readingBack(envelope({ 'kernel.stepIdx': 2 })).textSize).toBe(21)
    expect(readingBack(envelope({ 'kernel.stepIdx': 0 })).textSize).toBe(17)
    expect(readingBack(envelope({ 'kernel.stepIdx': 6 })).textSize).toBe(30)
  })

  /**
   * ⚠️ **THE ONE CHOICE NEITHER HALF COULD DETECT.** `readTextSize` read the
   * legacy index whenever the stored size EQUALLED THE FALLBACK, and `set`
   * skips a write whose value equals the current one — which, with nothing
   * stored, IS the fallback. So a reader on a pre-ramp file who chose exactly
   * the default size wrote nothing, the next read inferred "absent" again, and
   * the legacy index won: their choice was undone on every launch, for ever.
   *
   * Both halves were reasonable alone. The fix is that absence is now ASKED
   * (`store.has`) rather than inferred from the value.
   *
   * A migration hook could not have fixed it: `createSettingsStore` runs
   * `migrate` only when the envelope's VERSION differs, and the ramp changed
   * without a version bump — which is why this migration is read-time at all.
   * Established by trying it.
   */
  it('keeps a chosen size that happens to equal the default, over a legacy index', () => {
    const map = new Map<string, string>([
      [SETTINGS_STORAGE_KEY, JSON.stringify(envelope({ 'kernel.stepIdx': 4 }))],
    ])
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    }
    const open = () => createSettingsStore({ storage, migrate: carryLegacySettings })

    const first = open()
    /* What the legacy index means on the ramp it was written for. */
    expect(readKernelPreferences(first).textSize).toBe(LEGACY_READING_SIZES[4])
    /* The reader picks exactly this build's default — a real choice, and the
       only one whose value collides with the fallback. */
    const chosen = KERNEL_SETTINGS.textSize.fallback
    expect(chosen, 'the case only exists because these differ').not.toBe(LEGACY_READING_SIZES[4])
    first.set(KERNEL_SETTINGS.textSize, chosen)

    /* Next launch, from the same storage. */
    expect(readKernelPreferences(open()).textSize).toBe(chosen)
  })

  it('lets a stored size win outright, so the migration cannot fight it', () => {
    /* ONE DIRECTION AND ONE TIME. Once `kernel.textSize` exists the legacy key
       is never consulted again — otherwise a reader who changed their size
       after upgrading would be dragged back to their old one on every launch. */
    const both = envelope({ 'kernel.textSize': 15, 'kernel.stepIdx': 6 })
    expect(readingBack(both).textSize).toBe(15)
  })

  it('keeps a size this ramp does not offer, and lands it on the nearest step', () => {
    /* 30px was the old ramp's largest and is not on this one. The FILE keeps
       what the reader chose; `bootState` is where it becomes an index. */
    const got = readingBack(envelope({ 'kernel.stepIdx': 6 }))
    expect(got.textSize).toBe(30)
    expect(stepIndexForSize(got.textSize)).toBe(READING_STEPS.length - 1)
  })

  it('falls back to the default when there is nothing to migrate', () => {
    expect(readingBack(envelope({})).textSize).toBe(DEFAULTS.textSize)
    expect(readingBack(envelope({ 'kernel.stepIdx': 'two' })).textSize).toBe(DEFAULTS.textSize)
  })

  /* ⚠️ **A NEGATIVE INDEX NAMES NO STEP, AND IT MIGRATED TO THE SMALLEST.** The
     sentinel's note said `index()` rejects `-1`; it clamps it to 0, so a stored
     `-1` came back as 17px. No build ever wrote a negative index — a longer
     ramp is the reason to clamp, and it only ever runs off the top. */
  it('reads a negative legacy index as nothing to migrate, not as the smallest old size', () => {
    expect(readingBack(envelope({ 'kernel.stepIdx': -1 })).textSize).toBe(DEFAULTS.textSize)
    expect(readingBack(envelope({ 'kernel.stepIdx': -4 })).textSize).toBe(DEFAULTS.textSize)
  })
})

describe('carrying the pre-kernel settings file across', () => {
  it('restores a flat file written before the keys were namespaced', () => {
    const got = readingBack({
      theme: 'night',
      stepIdx: 1,
      align: 'ragged',
      markTint: 'purple',
      spacing: { letter: 2, word: 1, line: 3, paragraph: 0 },
    })
    expect(got.theme).toBe('night')
    /* An un-namespaced `stepIdx` is carried to `kernel.stepIdx` and THEN
       migrated to a size — two migrations in sequence, each doing its own job.
       Index 1 of the old seven-step ramp was 19px. */
    expect(got.textSize).toBe(LEGACY_READING_SIZES[1])
    expect(got.align).toBe('ragged')
    expect(got.markTint).toBe('purple')
    expect(got.spacing).toEqual({ letter: 2, word: 1, line: 3, paragraph: 0 })
  })

  it('validates a carried value exactly as a current one', () => {
    // One migration, not a second copy of fifteen validators.
    const got = readingBack({ theme: 'aubergine', stepIdx: 999 })
    expect(got.theme).toBe(DEFAULTS.theme)
    expect(got.textSize).toBe(LEGACY_READING_SIZES[LEGACY_READING_SIZES.length - 1])
  })

  it('leaves an already-namespaced key alone, so it is safe to run twice', () => {
    /* ⚠️ **THIS EXPECTED `night` — THE LEGACY KEY OVERWRITING THE NAMESPACED
       ONE — UNDER A NAME PROMISING THE OPPOSITE.** Which won was decided by
       PROPERTY ORDER: the same two keys written the other way round gave
       `sage`. Both orders are held now, and both keep the namespaced value. */
    expect(carryLegacySettings({ version: 0, values: { 'kernel.theme': 'sage', theme: 'night' } })).toEqual({
      'kernel.theme': 'sage',
    })
    expect(carryLegacySettings({ version: 0, values: { theme: 'night', 'kernel.theme': 'sage' } })).toEqual({
      'kernel.theme': 'sage',
    })
    expect(carryLegacySettings({ version: 0, values: { 'sync.interval': 30 } })).toEqual({ 'sync.interval': 30 })
  })

  it('does not mistake a versioned envelope with no values for a flat file', () => {
    expect(readingBack({ version: SETTINGS_VERSION })).toEqual(DEFAULTS)
  })
})

/* ------------------------------------------------------------------------ */
/* A storage that refuses to write                                           */
/* ------------------------------------------------------------------------ */

/**
 * ⚠️ **A REFUSED WRITE USED TO THROW OUT OF `set`, AND NOTHING CAUGHT IT.**
 *
 * Every multi-field write in this app is a RUN of `set` calls — choosing a
 * theme writes `theme` and then `themeFollowsOs`, and `writeKernelPreferences`
 * writes sixteen in a loop. A quota error on the first aborted the rest, so
 * what survived a launch was a PREFIX of what the reader had chosen. And the
 * only way to find out was the next launch.
 *
 * These are the two halves: the batch must complete, and the failure must
 * become a state the panel can draw.
 */
describe('a storage that will not take a write', () => {
  /* The store reports a refusal to the log as well as to `persistent`. Silenced
     here so a passing run is quiet; the assertions are on `persistent`. */
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => void vi.restoreAllMocks())

  /** Refuses the `refuseAfter`-th write onwards; records what it did take. */
  function refusing(refuseAfter: number) {
    const map = new Map<string, string>()
    let writes = 0
    return {
      map,
      get writes() {
        return writes
      },
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes += 1
          if (writes > refuseAfter) throw new DOMException('quota', 'QuotaExceededError')
          map.set(key, value)
        },
      },
    }
  }

  it('does not throw out of set', () => {
    const disk = refusing(0)
    const store = createSettingsStore({ storage: disk.storage })
    expect(() => store.set(KERNEL_SETTINGS.theme, 'night')).not.toThrow()
  })

  it('keeps the value in memory, so the reader sees what they chose', () => {
    const store = createSettingsStore({ storage: refusing(0).storage })
    store.set(KERNEL_SETTINGS.theme, 'night')
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('night')
  })

  it('reports itself as no longer persistent, and publishes that', () => {
    const store = createSettingsStore({ storage: refusing(0).storage })
    expect(store.persistent, 'a store over a working storage is persistent').toBe(true)
    const heard: boolean[] = []
    store.subscribe(() => heard.push(store.persistent))
    store.set(KERNEL_SETTINGS.theme, 'night')
    expect(store.persistent).toBe(false)
    expect(heard, 'the flip must reach a subscriber, or no panel can draw it').toContain(false)
  })

  it('is not persistent over no storage at all', () => {
    expect(createSettingsStore({ storage: null }).persistent).toBe(false)
  })

  it('opens over no storage at all without reporting a read that failed', () => {
    /* No storage is the plain session store, not a damaged file: nothing was
       read, so nothing failed, and a log line saying otherwise is a false alarm
       on every launch of a build that has none. */
    createSettingsStore({ storage: null })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('says to the log that nothing more will be saved, in its own words', () => {
    createSettingsStore({ storage: refusing(0).storage }).set(KERNEL_SETTINGS.theme, 'night')
    expect(console.error).toHaveBeenCalledWith(
      'Paper: settings will not be saved on this device',
      expect.any(DOMException),
    )
  })

  /**
   * THE BATCH COMPLETES. This is the finding: the loop aborted at the first
   * refusal and the fields after it were never even attempted, so a `setTheme`
   * — which changes two — stored one of them.
   */
  it('attempts every field of a batch rather than stopping at the first refusal', () => {
    /* ONE WRITE TAKEN, THEN REFUSED. `set` skips a field whose value has not
       changed, so this batch is exactly two writes and the second is the one
       that fails — which is the case that used to abandon the rest. */
    const disk = refusing(1)
    const store = createSettingsStore({ storage: disk.storage })
    expect(() => writeKernelPreferences(store, { ...DEFAULTS, theme: 'night', side: 'left' })).not.toThrow()
    /* IN MEMORY, EVERY FIELD. What reached the disk is a prefix by definition —
       the disk stopped taking writes — but nothing was skipped, and the store
       agrees with itself. */
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('night')
    expect(store.get(KERNEL_SETTINGS.side)).toBe('left')
    expect(store.persistent).toBe(false)
  })

  /**
   * AND IT STOPS TRYING. A full quota stays full; re-serialising the whole
   * envelope on every keystroke to be refused again is work with no answer at
   * the end of it.
   */
  it('stops writing once refused, rather than paying for every keystroke', () => {
    const disk = refusing(0)
    const store = createSettingsStore({ storage: disk.storage })
    store.set(KERNEL_SETTINGS.theme, 'night')
    store.set(KERNEL_SETTINGS.side, 'left')
    store.set(KERNEL_SETTINGS.typeface, 'sans')
    expect(disk.writes, 'one attempt, then it knows').toBe(1)
  })
})

/**
 * The three ways `set` and the reader could lose data, all found by one audit.
 */
describe('what the store promises never to do', () => {
  /* ⚠️ **`set` PROMISES NEVER TO THROW**, and a throwing subscriber broke it
     twice over: the exception left `set` through a caller with nobody to catch
     it, later listeners went untold, and the disk write below never ran. The
     same class `controller.ts` was fixed for one round earlier. */
  it('does not let a throwing subscriber escape set, silence its peers, or stop the write', () => {
    const storage = fakeStorage()
    const store = createSettingsStore({ storage })
    let told = 0
    store.subscribe(() => {
      throw new Error('a subscriber that throws')
    })
    store.subscribe(() => {
      told += 1
    })

    expect(() => store.set(KERNEL_SETTINGS.themeFollowsOs, false)).not.toThrow()
    expect(told, 'the subscriber after the thrower').toBe(1)
    expect(store.get(KERNEL_SETTINGS.themeFollowsOs)).toBe(false)
    // And it reached the disk, which the escaping throw used to prevent.
    expect(createSettingsStore({ storage }).get(KERNEL_SETTINGS.themeFollowsOs)).toBe(false)
  })

  /* ⚠️ **AND ON THE REFUSED-WRITE PATH TOO**, which the first fix missed:
     `persist`'s catch publishes `persistent = false` through its OWN loop, and
     that is the single most important thing this store ever tells anybody. A
     throwing subscriber there escaped `set` and stopped the rest of the UI
     learning that nothing is being saved. One notifier, two callers. */
  it('does not let a throwing subscriber escape the refused-write path either', () => {
    const store = createSettingsStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
      },
    })
    let told = 0
    store.subscribe(() => {
      throw new Error('a subscriber that throws')
    })
    store.subscribe(() => {
      told += 1
    })

    expect(() => store.set(KERNEL_SETTINGS.themeFollowsOs, false)).not.toThrow()
    expect(store.persistent, 'the refusal is recorded').toBe(false)
    /* Twice: once for the value, once for `persistent` going false. What
       matters is that the subscriber after the thrower heard both. */
    expect(told).toBe(2)
  })

  /* ⚠️ **`JSON.stringify` IS NOT TOTAL.** The unchanged-check was an unguarded
     call inside the same never-throws method: a cyclic value throws, and so
     does a `bigint`.

     ⚠️ **AND THIS CASE USED TO EXPECT THE VALUE HELD.** Held, it was in the
     envelope, so every later write failed to serialise the whole of it — which
     the write path read as a refused storage and answered with `persistent:
     false` for the rest of the session. One capability's bad value stopped
     every preference saving, and replacing it did not undo that. A value that
     cannot be saved is refused at `set`, said to the log, and never held. */
  it('does not throw comparing a value JSON cannot serialise', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSettingsStore({ storage: fakeStorage() })
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const setting = defineSetting<unknown>('test.cyclic', null, (raw: unknown) => raw)

      expect(() => store.set(setting, cyclic)).not.toThrow()
      expect(store.get(setting)).toBeNull()
      expect(store.has(setting)).toBe(false)
      expect(error, 'a refused value must be said').toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('keeps saving everything else after refusing such a value, and saves its replacement', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const storage = fakeStorage()
      const store = createSettingsStore({ storage })
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const setting = defineSetting<unknown>('test.cyclic', null, (raw: unknown) => raw)

      store.set(setting, cyclic)
      store.set(setting, { plain: true })
      store.set(KERNEL_SETTINGS.theme, 'night')

      expect(store.persistent).toBe(true)
      const reopened = createSettingsStore({ storage })
      expect(reopened.get(KERNEL_SETTINGS.theme)).toBe('night')
      expect(reopened.get(setting)).toEqual({ plain: true })
    } finally {
      error.mockRestore()
    }
  })

  /* ⚠️ **THE STORE HELD THE CALLER'S OWN OBJECT.** Mutated after `set`, the
     value in memory changed with no notification and no write, and setting the
     same object again compared equal to itself — so the disk kept the old
     value while every reader saw the new one. What is held is a copy, taken at
     the boundary, of exactly what would be written. */
  it('holds its own copy, so a caller mutating what it set changes nothing held', () => {
    const storage = fakeStorage()
    const store = createSettingsStore({ storage })
    const chosen = { letter: 0, word: 0, line: 1, paragraph: 0 }
    store.set(KERNEL_SETTINGS.spacing, chosen)
    const before = store.getSnapshot()

    chosen.line = 2
    expect(store.get(KERNEL_SETTINGS.spacing).line).toBe(1)
    expect(store.getSnapshot()).toBe(before)

    /* And the mutated object, set again, IS a change — written and published. */
    store.set(KERNEL_SETTINGS.spacing, chosen)
    expect(store.get(KERNEL_SETTINGS.spacing).line).toBe(2)
    expect(store.getSnapshot()).not.toBe(before)
    expect(createSettingsStore({ storage }).get(KERNEL_SETTINGS.spacing).line).toBe(2)
  })

  /* ⚠️ **AND WHAT `get` HANDS OUT WAS THE STORE'S OWN OBJECT** (2026-09-13
     verify). A reader mutating a fallback — one object shared by every store and
     every reader — or a stored value a parser passed straight through changed
     what every other reader saw, with no notification, no write, and the
     snapshot's identity unchanged. Frozen, the mutation fails at the line that
     makes it. */
  it('hands out values no reader can change under another', () => {
    const store = createSettingsStore({ storage: fakeStorage() })
    const fallback = store.get(KERNEL_SETTINGS.spacing)

    expect(() => {
      ;(fallback as { line: number }).line = 9
    }).toThrow(TypeError)
    expect(store.get(KERNEL_SETTINGS.spacing).line).toBe(SPACING.line.def)

    const passedThrough = defineSetting<{ readonly tags: readonly string[] }>(
      'test.passedThrough',
      { tags: [] },
      (raw) => raw as { tags: string[] },
    )
    store.set(passedThrough, { tags: ['kept'] })
    const held = store.get(passedThrough)

    expect(() => {
      ;(held.tags as string[]).push('slipped in')
    }).toThrow(TypeError)
    expect(store.get(passedThrough).tags).toEqual(['kept'])
  })

  /* AND THROUGH THE SNAPSHOT (2026-09-13 verify, second round). `getSnapshot`
     hands out the held record itself, so freezing only what `get` returns left
     every stored value one cast away from changing in memory while the disk kept
     the old one — a value loaded at launch and a value set since alike. */
  it('hands out a snapshot no reader can change under the store', () => {
    const storage = fakeStorage()
    createSettingsStore({ storage }).set(KERNEL_SETTINGS.spacing, { letter: 0, word: 0, line: 1, paragraph: 0 })
    const loaded = createSettingsStore({ storage })
    const atLaunch = loaded.getSnapshot() as Record<string, { line: number }>

    expect(() => {
      atLaunch['kernel.spacing']!.line = 2
    }).toThrow(TypeError)

    loaded.set(KERNEL_SETTINGS.hiddenPanes, ['search'])
    const sinceSet = loaded.getSnapshot() as Record<string, unknown>

    expect(() => {
      ;(sinceSet['kernel.hiddenPanes'] as string[]).push('library')
    }).toThrow(TypeError)
    expect(() => {
      sinceSet['kernel.theme'] = 'night'
    }).toThrow(TypeError)
    expect(createSettingsStore({ storage }).get(KERNEL_SETTINGS.spacing).line).toBe(1)
  })

  /* The freeze reaches everything a fallback holds: under a parent somebody
     already froze, past a null and a primitive, and round a cycle without
     walking it for ever. */
  it('freezes all of a fallback, whatever its shape', () => {
    const inner = { deep: [1, null, 'x'] }
    const cyclic: Record<string, unknown> = { frozenParent: Object.freeze({ child: inner }) }
    cyclic['self'] = cyclic

    const setting = defineSetting('test.cyclic', cyclic, () => undefined)

    expect(Object.isFrozen(setting.fallback)).toBe(true)
    expect(Object.isFrozen(inner)).toBe(true)
    expect(Object.isFrozen(inner.deep)).toBe(true)
  })

  /* ⚠️ **A READ THAT FAILED WAS TREATED AS AN EMPTY FILE, AND THE NEXT WRITE
     REPLACED THE FILE.** The store started from nothing with writes still on,
     so one preference changed after a transient failure wrote an envelope
     holding only that preference — every other setting, a capability's
     included, gone from disk. Unreadable is not absent: the store keeps the
     session's choices in memory and leaves the file alone. */
  it('writes nothing over a file it could not read', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const written = JSON.stringify(envelope({ 'kernel.theme': 'night', 'sync.keepNotes': false }))
      const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, written]])
      let readable = false
      const storage = {
        getItem: (key: string) => {
          if (!readable) throw new Error('storage is busy')
          return map.get(key) ?? null
        },
        setItem: (key: string, value: string) => void map.set(key, value),
      }
      const store = createSettingsStore({ storage })
      readable = true

      store.set(KERNEL_SETTINGS.side, 'left')
      expect(store.get(KERNEL_SETTINGS.side), 'the session still sees what it chose').toBe('left')
      expect(store.persistent, 'and is told nothing is being saved').toBe(false)
      expect(map.get(SETTINGS_STORAGE_KEY), 'the file it could not read must be intact').toBe(written)
    } finally {
      error.mockRestore()
    }
  })

  /* ⚠️ **AN ENVELOPE FROM THE FUTURE IS NOT THIS BUILD'S TO REWRITE.** Any
     version but this one went through the BACKWARD migration and was written
     back as version 1 — so running a newer Paper and then an older one
     destroyed the newer file on the first preference the reader changed. */
  it('reads a newer envelope without claiming it', () => {
    const storage = fakeStorage()
    const written = JSON.stringify({
      version: SETTINGS_VERSION + 1,
      values: { 'kernel.theme': 'sage', 'kernel.somethingNewer': 42 },
    })
    storage.setItem(SETTINGS_STORAGE_KEY, written)
    const store = createSettingsStore({ storage })

    // The reader keeps what this build understands …
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('sage')
    // … and is told plainly that nothing will be saved.
    expect(store.persistent).toBe(false)

    store.set(KERNEL_SETTINGS.theme, 'night')
    expect(storage.getItem(SETTINGS_STORAGE_KEY), 'the newer file must be intact').toBe(written)
  })

  /* AND A VERSION THAT IS NOT A FINITE NUMBER IS NOT A NEWER BUILD. `1e999` is
     what `JSON.parse` makes Infinity of; counted as a version it outranks every
     version there will ever be, and the file would never be written again. */
  it('reads an envelope whose version is not a finite number as an older one, not a newer one', () => {
    const storage = fakeStorage()
    storage.setItem(SETTINGS_STORAGE_KEY, '{"version":1e999,"values":{"kernel.theme":"sage"}}')
    const store = createSettingsStore({ storage })
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('sage')
    expect(store.persistent).toBe(true)
  })

  it('does not run the migration over an envelope this build wrote', () => {
    const migrate = vi.fn(() => ({}))
    const storage = fakeStorage()
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(envelope({ 'kernel.theme': 'night' })))
    const store = createSettingsStore({ storage, migrate })
    expect(migrate).not.toHaveBeenCalled()
    expect(store.get(KERNEL_SETTINGS.theme)).toBe('night')
  })

  /* ABSENT MEANS THE FALLBACK, WITHOUT ASKING. A parser is written for what is
     STORED, and one that makes something of nothing — `raw === true` reads
     absence as `false` — must not be given the chance. */
  it('reads an absent value as the fallback without asking the parser', () => {
    const onByDefault = defineSetting<boolean>('test.onByDefault', true, (raw: unknown) => raw === true)
    expect(createSettingsStore({ storage: fakeStorage() }).get(onByDefault)).toBe(true)
  })

  /* `get` PROMISES NEVER TO FAIL, and `parse` is whoever defined the setting. */
  it('reads a value its parser throws on as the fallback', () => {
    const storage = fakeStorage()
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(envelope({ 'test.fragile': 'anything' })))
    const fragile = defineSetting<string>('test.fragile', 'fallback', () => {
      throw new Error('a parser that throws')
    })
    expect(createSettingsStore({ storage }).get(fragile)).toBe('fallback')
  })

  it('stops telling a subscriber once it has unsubscribed', () => {
    const store = createSettingsStore({ storage: fakeStorage() })
    let told = 0
    const unsubscribe = store.subscribe(() => {
      told += 1
    })
    store.set(KERNEL_SETTINGS.theme, 'night')
    unsubscribe()
    store.set(KERNEL_SETTINGS.theme, 'sepia')
    expect(told).toBe(1)
  })

  it('names itself in the log when a subscriber throws, so the line is worth reading', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSettingsStore({ storage: fakeStorage() })
      store.subscribe(() => {
        throw new Error('a subscriber that throws')
      })
      store.set(KERNEL_SETTINGS.theme, 'night')
      expect(error).toHaveBeenCalledWith('Paper: a settings subscriber threw while being notified', expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })

  /* `undefined` HAS NO JSON SPELLING, so it could never have reached the disk —
     and it is refused for THAT reason, in those words, rather than for the parse
     failure that would follow if it were let through. */
  it('refuses undefined, and says which setting and why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSettingsStore({ storage: fakeStorage() })
      const setting = defineSetting<unknown>('test.nothing', 'fallback', (raw: unknown) => raw)

      store.set(setting, undefined)

      expect(store.has(setting)).toBe(false)
      expect(error.mock.calls[0]?.[0]).toBe(
        'Paper: the setting test.nothing was not changed, because its value cannot be saved',
      )
      const cause: unknown = error.mock.calls[0]?.[1]
      expect(cause).toBeInstanceOf(TypeError)
      expect((cause as Error).message).toBe('JSON has no spelling for this value')
    } finally {
      error.mockRestore()
    }
  })

  /* A DIFFERENCE IT CANNOT PROVE IS A DIFFERENCE. With nothing stored a value
     is compared against the fallback, and a fallback JSON cannot serialise can
     be proved equal to nothing — so the value is written, not dropped. */
  it('writes a value over a fallback it cannot compare, rather than calling the two the same', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const storage = fakeStorage()
    const setting = defineSetting<unknown>('test.cyclicFallback', cyclic, (raw: unknown) => raw)

    createSettingsStore({ storage }).set(setting, { plain: true })

    expect(createSettingsStore({ storage }).get(setting)).toEqual({ plain: true })
  })

  /* ⚠️ **THIS CASE USED TO ASSERT `persistent` STAYED TRUE, AND THAT WAS THE
     DEFECT RATHER THAN THE CONTRACT.** The reasoning was that serialising is
     not the storage, so a healthy storage should stay marked healthy — true
     about the STORAGE, and `persistent` is not about the storage. Its own
     declaration says what it means: whether the next launch will see any of
     this. With a value in `values` that `JSON.stringify` refuses, the answer is
     no, and it is no for every later write as well, because the offending value
     stays in the record. So the panel drew "your settings are saved" over a
     store that had silently stopped saving at the first preference the reader
     changed — the exact shape of the twelve stores AGENTS.md has a section
     about, one level up: not a blank page written over good data, but a good
     page that is never written at all, reported as written.

     What this gives up is stated rather than hidden: a later `set` that
     replaced the offending key WOULD serialise, and `persistent` does not come
     back, because `persist` returns early once it is false. That is accepted
     because the value cannot arrive from a real file — every value in a parsed
     envelope is serialisable by construction — so it only ever comes from a
     migration hook that invented one, and a hook that does that goes on doing
     it for the session. */
  it('marks itself session-only when it cannot serialise, rather than claiming a save it will never make', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let writes = 0
      const map = new Map<string, string>()
      const storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes += 1
          map.set(key, value)
        },
      }
      const store = createSettingsStore({ storage, migrate: () => ({ 'test.count': BigInt(10) }) })

      store.set(KERNEL_SETTINGS.theme, 'night')

      expect(store.get(KERNEL_SETTINGS.theme), 'the session still sees what it chose').toBe('night')
      expect(writes, 'nothing reached the storage').toBe(0)
      expect(store.persistent, 'and the store says so, instead of reporting a save it did not make').toBe(false)
      expect(error).toHaveBeenCalledWith(
        'Paper: settings could not be serialised, so they will not be saved on this device',
        expect.any(TypeError),
      )
    } finally {
      error.mockRestore()
    }
  })

  /* ⚠️ **A THROWING MIGRATION USED TO TAKE THE LAUNCH WITH IT.** `migrate` is
     the caller's code running on whatever bytes were on disk, and it was the
     one door in this file where damaged settings could be FATAL: every other
     way of meeting them — unreadable bytes, a file from the future — already
     degrades to a session store. A reader with a half-written file could not
     start the app, so could not reach the panel that would have told them why. */
  it('starts from the defaults when the migration throws, instead of failing to start', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      /* AN OLDER ENVELOPE, because a file already AT `SETTINGS_VERSION` is
         taken verbatim and the hook is never called — which is what the first
         version of this case got wrong, and the case caught. */
      const stored = JSON.stringify({ version: 0, values: { 'kernel.theme': 'night' } })
      const map = new Map<string, string>([[SETTINGS_STORAGE_KEY, stored]])
      const storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      }

      const store = createSettingsStore({
        storage,
        migrate: () => {
          throw new Error('this hook is broken')
        },
      })

      expect(store.get(KERNEL_SETTINGS.theme), 'every setting answers its fallback').toBe(
        KERNEL_SETTINGS.theme.fallback,
      )
      expect(store.persistent, 'and it is session-only, so nothing writes over the damaged file').toBe(false)
      expect(map.get(SETTINGS_STORAGE_KEY), 'the bytes are left exactly where they are').toBe(stored)
    } finally {
      error.mockRestore()
    }
  })

  /* The same door, the other half: the hook returns a record rather than
     throwing, and a getter on it throws while the record is being frozen. */
  it('starts from the defaults when the migration returns a record it cannot read', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSettingsStore({
        storage: null,
        migrate: () =>
          Object.defineProperty({}, 'kernel.theme', {
            enumerable: true,
            get: () => {
              throw new Error('hostile getter')
            },
          }) as Readonly<Record<string, unknown>>,
      })

      expect(store.get(KERNEL_SETTINGS.theme)).toBe(KERNEL_SETTINGS.theme.fallback)
      expect(store.persistent).toBe(false)
    } finally {
      error.mockRestore()
    }
  })

  /* ⚠️ **`JSON.stringify(NaN)` IS THE STRING `null`, SO A VALUE COULD BE STORED
     THAT `get` COULD NEVER READ BACK.** `has` answered true for the key, `get`
     ran the setting's parser over `null`, got `undefined`, and returned the
     FALLBACK — so the panel showed one thing and the file held another, for
     every launch after. Surviving `JSON.stringify` is not the same as surviving
     the setting. */
  it('refuses a value the setting’s own parser cannot read back', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const map = new Map<string, string>()
      const storage = {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      }
      const store = createSettingsStore({ storage })

      store.set(KERNEL_SETTINGS.readingRate, Number.NaN)

      expect(store.has(KERNEL_SETTINGS.readingRate), 'nothing was stored under the key').toBe(false)
      expect(store.get(KERNEL_SETTINGS.readingRate)).toBe(KERNEL_SETTINGS.readingRate.fallback)
      expect(map.size, 'and nothing reached the storage').toBe(0)
      expect(error).toHaveBeenCalledWith(
        `Paper: the setting ${KERNEL_SETTINGS.readingRate.key} was not changed, because its own parser cannot read that value back`,
      )
    } finally {
      error.mockRestore()
    }
  })
})

describe('the range read aloud may be stored in', () => {
  /**
   * ⚠️ **THE RANGE A READER CAN STORE AND THE RANGE THE STEPPER OFFERS MUST BE
   * ONE RANGE**, which is why these are derived from §09's scales rather than
   * written down again. A clamp that disagreed with the stepper would refuse a
   * value the pane had just produced.
   */
  it('is exactly the ends of the scale the pane steps through', () => {
    expect([READING_RATE_MIN, READING_RATE_MAX]).toEqual([
      READING_RATE.steps.at(0),
      READING_RATE.steps.at(-1),
    ])
    expect([SENTENCE_GAP_MIN, SENTENCE_GAP_MAX]).toEqual([
      SENTENCE_GAP.steps.at(0),
      SENTENCE_GAP.steps.at(-1),
    ])
    expect([PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX]).toEqual([
      PARAGRAPH_GAP.steps.at(0),
      PARAGRAPH_GAP.steps.at(-1),
    ])
  })

  it('clamps a stored speed to those ends rather than refusing it', () => {
    /* A file written by a build with a wider ramp is not corrupt — it is
       describing a speed this build offers less of. */
    expect(readingBack(envelope({ 'kernel.readingRate': 99 })).readingRate).toBe(READING_RATE_MAX)
    expect(readingBack(envelope({ 'kernel.readingRate': 0.01 })).readingRate).toBe(READING_RATE_MIN)
    expect(readingBack(envelope({ 'kernel.sentenceGapMs': 99_999 })).sentenceGapMs).toBe(SENTENCE_GAP_MAX)
    expect(readingBack(envelope({ 'kernel.paragraphGapMs': -20 })).paragraphGapMs).toBe(PARAGRAPH_GAP_MIN)
  })

  it('refuses a speed that is not a finite number, rather than clamping it', () => {
    /* `Math.min` over a NaN answers NaN, and a NaN rate makes the engine refuse
       the utterance — so this is rejected at the door and the default stands. */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1.5', null, {}]) {
      expect(readingBack(envelope({ 'kernel.readingRate': bad })).readingRate).toBe(DEFAULTS.readingRate)
    }
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
    expect(readingBack(envelope({ 'kernel.readingVoice': stored })).readingVoice).toEqual(stored)
  })

  it('drops the entry that is not a voice, and keeps the rest', () => {
    expect(
      readingBack(
        envelope({ 'kernel.readingVoice': { en: 'com.apple.voice.enhanced.en-US.Zoe', zh: '', fr: 7, de: null } }),
      ).readingVoice,
    ).toEqual({ en: 'com.apple.voice.enhanced.en-US.Zoe' })
  })

  it('refuses a value that is not a map of languages at all', () => {
    for (const bad of ['com.apple.voice.enhanced.en-US.Zoe', 7, ['en'], null]) {
      expect(readingBack(envelope({ 'kernel.readingVoice': bad })).readingVoice).toEqual(DEFAULTS.readingVoice)
    }
  })
})

describe('a migration that cannot finish', () => {
  /**
   * ⚠️ **THE MIGRATION IS THE CALLER'S CODE, AND THE STORE MAY NOT DIE WITH
   * IT.** A hook that throws — or one that hands back a record whose GETTER
   * throws, which runs inside the freeze rather than inside the call — used to
   * abort `createSettingsStore` outright: no settings, and no app. The reader
   * gets the defaults for this session instead, the damaged bytes are left
   * where they are, and each half says which half it was.
   */
  const stored = (values: Record<string, unknown>) => {
    const storage = fakeStorage()
    /* VERSION 0, so the store has something to migrate: the hook runs only for
       an envelope this build did not write. */
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ version: 0, values }))
    return storage
  }

  it('says the migration failed, keeps the defaults, and saves nothing', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cause = new Error('the old file makes no sense')
      const store = createSettingsStore({
        storage: stored({ 'kernel.theme': 'night' }),
        migrate: () => {
          throw cause
        },
      })
      expect(said).toHaveBeenCalledWith(
        'Paper: stored settings could not be migrated, so this session starts from the defaults',
        cause,
      )
      expect(store.get(KERNEL_SETTINGS.theme), 'a migration that failed still set a value').toBe(
        DEFAULTS.theme,
      )
      expect(store.persistent, 'writes were left on over a file nobody could read').toBe(false)
    } finally {
      said.mockRestore()
    }
  })

  it('says the settings could not be READ when the record itself will not be read', () => {
    /* A getter on the migrated record runs while the store FREEZES it, which is
       after the hook returned — so guarding only the call left the second half
       of the same door open. The two sentences are different because the two
       failures are. */
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSettingsStore({
        storage: stored({ 'kernel.theme': 'night' }),
        migrate: () =>
          Object.defineProperty({}, 'kernel.theme', {
            enumerable: true,
            get: () => {
              throw new Error('this record cannot be read')
            },
          }) as Readonly<Record<string, unknown>>,
      })
      expect(said.mock.calls[0]?.[0]).toBe(
        'Paper: stored settings could not be read, so this session starts from the defaults',
      )
      expect(store.get(KERNEL_SETTINGS.theme)).toBe(DEFAULTS.theme)
      expect(store.persistent).toBe(false)
    } finally {
      said.mockRestore()
    }
  })
})

describe('a stored value the parser is handed directly', () => {
  /**
   * ⚠️ **`get` PROMISES NEVER TO FAIL, WHICH HIDES A PARSER THAT WOULD.** The
   * store catches a parser that throws and answers the fallback — the same
   * answer a parser that REFUSES the value gives — so a refusal and a crash
   * are indistinguishable from outside it. These call the parsers themselves,
   * where the difference is visible.
   */
  it('refuses a voice map that is null, rather than throwing on it', () => {
    /* `typeof null` is 'object', so the null check is what stands between
       `Object.entries(null)` and a throw. */
    expect(KERNEL_SETTINGS.readingVoice.parse(null)).toBeUndefined()
    expect(KERNEL_SETTINGS.readingVoice.parse(['en'])).toBeUndefined()
    expect(KERNEL_SETTINGS.readingVoice.parse('a voice')).toBeUndefined()
    expect(KERNEL_SETTINGS.readingVoice.parse({ en: 'voice:en' })).toEqual({ en: 'voice:en' })
  })

  it('refuses a speed that is not a finite number, whatever kind of value it is', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1.5', null, {}, []]) {
      expect(KERNEL_SETTINGS.readingRate.parse(bad), `${String(bad)} was taken as a speed`).toBeUndefined()
    }
    expect(KERNEL_SETTINGS.readingRate.parse(99), 'and a number is clamped, not refused').toBe(
      READING_RATE_MAX,
    )
  })
})

describe('an envelope written with a number JSON cannot hold', () => {
  it('reads an infinite speed as no speed at all', () => {
    /* `JSON.stringify(Infinity)` is `null`, so this can only arrive as source
       text — `1e999` parses to Infinity. It is the one route by which a
       non-finite number reaches the clamp, and the clamp must refuse it:
       `Math.min` over an Infinity answers the bound, which would store a speed
       the reader never chose. */
    const map = new Map<string, string>([
      [SETTINGS_STORAGE_KEY, `{"version":${SETTINGS_VERSION},"values":{"kernel.readingRate":1e999}}`],
    ])
    const store = createSettingsStore({
      storage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
      },
    })
    expect(readKernelPreferences(store).readingRate).toBe(DEFAULTS.readingRate)
  })
})
