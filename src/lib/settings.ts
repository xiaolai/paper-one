import { BRIGHTNESS, CONTRAST, READING_STEPS, SPACING } from './metrics'
import { MARK_TINTS, READER_STYLES, type MarkStyle, type MarkTint } from './marks'
import type { AppState, Align, PageLayout, Side, SpacingIndices, Theme, Typeface } from './state'

/**
 * The reader's settings, across launches.
 *
 * Paper persisted none of this. Theme, type size, spacing, brightness, contrast
 * and reading flow were held in a `useReducer` and nowhere else, so every
 * launch handed back the defaults — a reader who had set Night at 19px got
 * Paper at 17px the next morning, every morning, with nothing to say why.
 *
 * WHAT IS PERSISTED IS A DECISION, not everything in `AppState`. The test is
 * whether the value is something the reader CHOSE about how they read, or
 * something about this session. A theme is chosen; an open palette is not. The
 * split is written out in `SETTINGS_KEYS` below, so adding a field to `AppState`
 * does not silently start or stop persisting it.
 *
 * PURE, and that is what makes it testable: `parseSettings` takes a string and
 * returns a state patch, `settingsOf` takes the state and returns what to
 * store. Neither touches storage. The seam to the disk is `useSettings`.
 */

/** The one key. Versioned in the name, like `paper.marks.v1`, so a future
 *  shape can be told apart from this one by a build that predates it. */
export const SETTINGS_STORAGE_KEY = 'paper.settings.v1'

/**
 * Exactly the fields that survive a launch.
 *
 * `screen`, `pane`, `libraryQuery`, the two overlay flags and `chromeOn` are
 * deliberately absent: they describe where the reader was, not how they like to
 * read, and restoring them puts someone back into a search or an open palette
 * they have no memory of leaving. `rulerPinned` is absent for the same reason
 * while `rulerOn` is kept — one is a preference, the other is where the ruler
 * happened to be sitting.
 */
export const SETTINGS_KEYS = [
  'theme',
  'themeFollowsOs',
  'side',
  'rulerOn',
  'stepIdx',
  'spacing',
  'align',
  'brightness',
  'contrast',
  'typeface',
  'scrollbarOn',
  'progressLineOn',
  'pageLayout',
  'markTint',
  'markStyle',
] as const

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/** The persisted slice of the reader's state. */
export type StoredSettings = Pick<AppState, SettingsKey>

const THEMES: readonly Theme[] = ['paper', 'slate', 'sepia', 'sage', 'night']
const SIDES: readonly Side[] = ['left', 'right']
const ALIGNS: readonly Align[] = ['justified', 'ragged']
const LAYOUTS: readonly PageLayout[] = ['scrolled', 'paginated']
const SPACING_KEYS = ['letter', 'word', 'line', 'paragraph'] as const

/**
 * A stored value, or the default.
 *
 * STORAGE IS A TRUST BOUNDARY — the same rule `isMark` and `readBook` follow.
 * What comes back is whatever is in a file a reader can edit, an older build
 * wrote, or a half-finished write left behind. One bad field must cost that
 * field and nothing else: a settings file that threw would leave the app unable
 * to start, which is a far worse failure than a forgotten type size.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * An index into one of §09's scales, clamped to it.
 *
 * CLAMPED RATHER THAN REJECTED. These are positions on a ramp, and a file
 * written by a build with a longer ramp is not corrupt — it is describing the
 * end of a scale this build has less of. Falling back to the default there
 * would throw away a reader's deliberate "as large as it goes"; clamping keeps
 * the intent and lands on the nearest thing this build can show.
 *
 * A non-integer or non-finite value IS rejected: it indexes nothing, and
 * `stepAt` on a NaN yields undefined rather than a step.
 */
function index(value: unknown, length: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.max(0, Math.min(length - 1, value))
}

function spacing(value: unknown, fallback: SpacingIndices): SpacingIndices {
  if (typeof value !== 'object' || value === null) return fallback
  const raw = value as Record<string, unknown>
  const out = { ...fallback }
  for (const key of SPACING_KEYS) {
    out[key] = index(raw[key], SPACING[key].steps.length, fallback[key])
  }
  return out
}

/**
 * A face id, kept as a STRING rather than checked against a list.
 *
 * Which faces exist depends on the machine — see `Typeface`. Validating against
 * this machine's fonts would drop a reader's choice the moment they opened the
 * same library on a laptop that happens to lack it, and `faceById` already
 * resolves an unknown id to the default at the point of use. Bounded, because
 * this is still a file anything could have written.
 */
function face(value: unknown, fallback: Typeface): Typeface {
  return typeof value === 'string' && value !== '' ? value.slice(0, 120) : fallback
}

/**
 * The stored settings as a patch over the defaults.
 *
 * Every field independently defaulted, so a file holding one recognisable value
 * and nine broken ones still restores that one. Returns an empty patch for
 * anything that is not an object — including `null`, which `typeof` calls an
 * object and which is what an empty file parses to.
 */
export function parseSettings(raw: string | null, defaults: StoredSettings): StoredSettings {
  if (!raw) return defaults
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaults
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return defaults
  const r = parsed as Record<string, unknown>
  return {
    theme: oneOf(r['theme'], THEMES, defaults.theme),
    themeFollowsOs: bool(r['themeFollowsOs'], defaults.themeFollowsOs),
    side: oneOf(r['side'], SIDES, defaults.side),
    rulerOn: bool(r['rulerOn'], defaults.rulerOn),
    stepIdx: index(r['stepIdx'], READING_STEPS.length, defaults.stepIdx),
    spacing: spacing(r['spacing'], defaults.spacing),
    align: oneOf(r['align'], ALIGNS, defaults.align),
    brightness: index(r['brightness'], BRIGHTNESS.steps.length, defaults.brightness),
    contrast: index(r['contrast'], CONTRAST.steps.length, defaults.contrast),
    typeface: face(r['typeface'], defaults.typeface),
    scrollbarOn: bool(r['scrollbarOn'], defaults.scrollbarOn),
    progressLineOn: bool(r['progressLineOn'], defaults.progressLineOn),
    pageLayout: oneOf(r['pageLayout'], LAYOUTS, defaults.pageLayout),
    markTint: oneOf(r['markTint'], MARK_TINTS, defaults.markTint) as MarkTint,
    /* READER_STYLES, not every style there is. The wave belongs to the
       companion — a settings file naming it, whether hand-edited or written by
       a build that offered it, must not hand the reader a style they cannot
       choose and cannot see the provenance rule behind. */
    markStyle: oneOf(r['markStyle'], READER_STYLES, defaults.markStyle) as MarkStyle,
  }
}

/**
 * What to store, taken from the live state.
 *
 * Built from `SETTINGS_KEYS` rather than written out a second time: two lists
 * of fields is how a setting comes to be saved and never restored, or restored
 * and never saved, and neither failure announces itself.
 */
export function settingsOf(state: StoredSettings): StoredSettings {
  const out = {} as Record<string, unknown>
  for (const key of SETTINGS_KEYS) out[key] = state[key]
  return out as StoredSettings
}

/**
 * Whether two settings differ, for deciding whether to write at all.
 *
 * A shallow compare with one nested object — `spacing` — spelled out. A deep
 * equality helper would be more general and would also happily compare the
 * whole of `AppState` if someone passed it; this only knows how to compare the
 * thing it is for.
 */
export function sameSettings(a: StoredSettings, b: StoredSettings): boolean {
  for (const key of SETTINGS_KEYS) {
    if (key === 'spacing') continue
    if (a[key] !== b[key]) return false
  }
  return SPACING_KEYS.every((key) => a.spacing[key] === b.spacing[key])
}
