import { describe, expect, it } from 'vitest'
import { BRIGHTNESS, CONTRAST, READING_STEPS, SPACING } from './metrics'
import { initialState } from './state'
import {
  SETTINGS_KEYS,
  parseSettings,
  sameSettings,
  settingsOf,
  type StoredSettings,
} from './settings'

const DEFAULTS: StoredSettings = settingsOf(initialState)
const parse = (value: unknown): StoredSettings =>
  parseSettings(typeof value === 'string' ? value : JSON.stringify(value), DEFAULTS)

describe('what is persisted', () => {
  it('takes exactly the fields a reader chose, and none of the session', () => {
    /* The split is the whole design. Restoring `screen` or `paletteOpen` would
       put someone back into a search or an open overlay they have no memory of
       leaving; not restoring `theme` is the bug this file exists to fix. */
    expect(SETTINGS_KEYS).toContain('theme')
    expect(SETTINGS_KEYS).toContain('stepIdx')
    expect(SETTINGS_KEYS).toContain('brightness')
    for (const session of ['screen', 'pane', 'paletteOpen', 'switcherOpen', 'libraryQuery', 'chromeOn', 'rulerPinned']) {
      expect(SETTINGS_KEYS, session).not.toContain(session)
    }
  })

  it('round-trips every persisted field', () => {
    /* The failure this catches is a field saved and never restored, or the
       reverse — neither of which announces itself in the app. */
    const changed: StoredSettings = {
      ...DEFAULTS,
      theme: 'night',
      themeFollowsOs: false,
      side: 'left',
      rulerOn: true,
      stepIdx: 1,
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
    expect(parse(settingsOf(changed))).toEqual(changed)
  })
})

describe('reading a file nobody can vouch for', () => {
  it('returns the defaults for an absent, empty or unparseable file', () => {
    for (const bad of [null, '', 'not json', '{oops']) {
      expect(parseSettings(bad, DEFAULTS)).toEqual(DEFAULTS)
    }
  })

  it('returns the defaults for a shape that is not an object', () => {
    // `null` is what an empty file parses to, and `typeof null` is 'object'.
    for (const bad of ['null', '[]', '42', '"night"']) {
      expect(parseSettings(bad, DEFAULTS)).toEqual(DEFAULTS)
    }
  })

  it('keeps the one field it recognises out of a file of rubbish', () => {
    /* One bad field costs that field and nothing else. A settings file that
       threw would leave the app unable to start, which is a far worse failure
       than a forgotten type size. */
    const got = parse({ theme: 'sepia', stepIdx: 'huge', align: 42, spacing: 'no', brightness: null })
    expect(got.theme).toBe('sepia')
    expect(got.stepIdx).toBe(DEFAULTS.stepIdx)
    expect(got.align).toBe(DEFAULTS.align)
    expect(got.spacing).toEqual(DEFAULTS.spacing)
    expect(got.brightness).toBe(DEFAULTS.brightness)
  })

  it('refuses a theme, side, alignment or flow it does not have', () => {
    const got = parse({ theme: 'midnight', side: 'top', align: 'centred', pageLayout: 'columns' })
    expect(got.theme).toBe(DEFAULTS.theme)
    expect(got.side).toBe(DEFAULTS.side)
    expect(got.align).toBe(DEFAULTS.align)
    expect(got.pageLayout).toBe(DEFAULTS.pageLayout)
  })
})

describe('indices into a scale', () => {
  it('clamps a step past the end of this build’s ramp', () => {
    /* NOT rejected. A file written by a build with a longer ramp is describing
       the end of a scale this one has less of, and falling back to the default
       would throw away a deliberate "as large as it goes". */
    expect(parse({ stepIdx: 999 }).stepIdx).toBe(READING_STEPS.length - 1)
    expect(parse({ brightness: 999 }).brightness).toBe(BRIGHTNESS.steps.length - 1)
    expect(parse({ contrast: -5 }).contrast).toBe(0)
    expect(parse({ contrast: 999 }).contrast).toBe(CONTRAST.steps.length - 1)
    expect(parse({ spacing: { line: 999 } }).spacing.line).toBe(SPACING.line.steps.length - 1)
  })

  it('rejects a step that indexes nothing at all', () => {
    // `stepAt` on a NaN yields undefined rather than a step.
    for (const bad of [1.5, Number.NaN, Infinity, '2', null]) {
      expect(parse({ stepIdx: bad }).stepIdx, String(bad)).toBe(DEFAULTS.stepIdx)
    }
  })

  it('fills a partial spacing object from the defaults', () => {
    const got = parse({ spacing: { line: 0 } })
    expect(got.spacing.line).toBe(0)
    expect(got.spacing.word).toBe(DEFAULTS.spacing.word)
  })
})

describe('the typeface', () => {
  it('keeps a face this machine may not have', () => {
    /* Which faces exist depends on the machine. Validating against this one's
       fonts would drop the reader's choice the moment they opened the same
       library on a laptop that lacks it; `faceById` resolves it at use. */
    expect(parse({ typeface: 'some-face-only-on-the-other-mac' }).typeface).toBe(
      'some-face-only-on-the-other-mac',
    )
  })

  it('refuses an empty or non-string face, and bounds a long one', () => {
    expect(parse({ typeface: '' }).typeface).toBe(DEFAULTS.typeface)
    expect(parse({ typeface: 42 }).typeface).toBe(DEFAULTS.typeface)
    expect(parse({ typeface: 'x'.repeat(500) }).typeface).toHaveLength(120)
  })
})

describe('the mark appearance', () => {
  it('restores a tint and a style the reader can choose', () => {
    const got = parse({ markTint: 'green', markStyle: 'underline' })
    expect(got.markTint).toBe('green')
    expect(got.markStyle).toBe('underline')
  })

  it('refuses the companion’s wave, however it got into the file', () => {
    /* The wave is reserved — see `READER_STYLES`. A settings file naming it,
       hand-edited or written by a build that once offered it, must not hand the
       reader a style whose whole job is to mean "a machine wrote this". */
    expect(parse({ markStyle: 'wave' }).markStyle).toBe(DEFAULTS.markStyle)
  })
})

describe('sameSettings', () => {
  it('is true for a copy, including the nested spacing', () => {
    expect(sameSettings(DEFAULTS, { ...DEFAULTS, spacing: { ...DEFAULTS.spacing } })).toBe(true)
  })

  it('notices a change in any persisted field', () => {
    expect(sameSettings(DEFAULTS, { ...DEFAULTS, theme: 'night' })).toBe(false)
    expect(sameSettings(DEFAULTS, { ...DEFAULTS, stepIdx: DEFAULTS.stepIdx + 1 })).toBe(false)
  })

  it('notices a change inside spacing, which a shallow compare would miss', () => {
    const moved = { ...DEFAULTS, spacing: { ...DEFAULTS.spacing, line: DEFAULTS.spacing.line + 1 } }
    expect(sameSettings(DEFAULTS, moved)).toBe(false)
  })
})
