import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIGHTNESS, CONTRAST, LEGACY_READING_SIZES, READING_STEPS, SPACING, stepIndexForSize } from './metrics'
import { initialState, preferencesOf } from '../ui/state'
import {
  KERNEL_SETTINGS,
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
  it('returns the defaults for an absent, empty or unparseable file', () => {
    for (const bad of ['', 'not json', '{oops']) {
      expect(readingBack(bad)).toEqual(DEFAULTS)
    }
  })

  it('returns the defaults for a shape that is not an object', () => {
    // `null` is what an empty file parses to, and `typeof null` is 'object'.
    for (const bad of ['null', '[]', '42', '"night"']) {
      expect(readingBack(bad)).toEqual(DEFAULTS)
    }
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
    expect(carryLegacySettings({ version: 0, values: { 'kernel.theme': 'sage', theme: 'night' } })).toEqual({
      'kernel.theme': 'night',
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
