import type { MarkStorage } from './marks'
import { DEFAULT_STEP_IDX, READING_STEPS } from './metrics'
import { defineSetting, type Setting, type SettingsStore } from './ports'
import { PAGE_LAYOUTS, SIDES, THEME_IDS, type PageLayout, type Side, type Theme, type Typeface } from './uiTypes'

/**
 * `SettingsStore`, the working one — see the port in `ports.ts`.
 *
 * Persisted through the flat store the reader already has (`fileStore` on
 * disk, `localStorage` in a browser tab), under ONE key holding a versioned
 * envelope. One key rather than one per setting because the flat store is a
 * `getItem`/`setItem` face over a single JSON file: nine keys would be nine
 * strings in that file for one object's worth of values, and a version has to
 * be attached to the whole, not to each.
 *
 * WHY THIS EXISTS AT ALL. Every preference used to be a field of `AppState`,
 * which is a `useReducer` — so a reader who chose Night and Crimson Pro chose
 * them again on every launch, and a mobile build would have forgotten its
 * theme every time the OS unloaded it. `AppState` keeps the transient half
 * (query, layers, selection); the durable half is read from here before the
 * first render and written back as it changes.
 */

export const SETTINGS_STORAGE_KEY = 'paper.settings.v1'
export const SETTINGS_VERSION = 1

/** What is on disk: the version, then the values by key. */
export interface SettingsEnvelope {
  readonly version: number
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * How an envelope from another version becomes this version's values.
 *
 * Called with what was found — `null` when nothing was — whenever the stored
 * version is not `SETTINGS_VERSION`. Returns the values to start from. The
 * default keeps whatever `values` a lower-versioned envelope carried, because
 * a key that has not changed meaning should not be forgotten by a bump; a
 * migration that renames or drops one supplies its own.
 */
export type SettingsMigration = (found: SettingsEnvelope | null) => Readonly<Record<string, unknown>>

export const keepValues: SettingsMigration = (found) => found?.values ?? {}

export interface SettingsStoreOptions {
  /** The flat store. `null` — no storage at all — makes a store that lives for the session. */
  readonly storage: MarkStorage | null
  readonly migrate?: SettingsMigration
}

/**
 * Read one envelope back, or `null` for anything that is not one.
 *
 * `version` may be missing or a non-number: that is an OLDER envelope for the
 * migration hook to see, reported with `version: 0`. `values` that are not an
 * object are no values.
 */
function parseEnvelope(raw: string | null): SettingsEnvelope | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const shape = parsed as { version?: unknown; values?: unknown }
  const version = typeof shape.version === 'number' && Number.isFinite(shape.version) ? shape.version : 0
  const values =
    typeof shape.values === 'object' && shape.values !== null && !Array.isArray(shape.values)
      ? (shape.values as Record<string, unknown>)
      : {}
  return { version, values }
}

export function createSettingsStore({ storage, migrate = keepValues }: SettingsStoreOptions): SettingsStore {
  let read: string | null = null
  try {
    read = storage?.getItem(SETTINGS_STORAGE_KEY) ?? null
  } catch {
    // A storage that throws on read — disabled, or a hostile stub — is a store
    // with nothing in it. The reader gets defaults, and the app still opens.
    read = null
  }
  const found = parseEnvelope(read)
  /* Unknown keys are KEPT, not dropped: a value under `sync.interval` in a
   * build without the sync capability composed belongs to a capability that
   * may be composed again, and forgetting it here would make removing and
   * re-adding a capability a reset of its preferences. `get` ignores what it
   * is not asked for, which is the only sense in which they are ignored. */
  let values: Readonly<Record<string, unknown>> =
    found && found.version === SETTINGS_VERSION ? found.values : migrate(found)
  const listeners = new Set<() => void>()

  const persist = () => {
    if (!storage) return
    const envelope: SettingsEnvelope = { version: SETTINGS_VERSION, values }
    /* THROWS PAST HERE. `MarkStorage.setItem` signals a failed store by
     * throwing, and swallowing that would make a settings pane that stops
     * saving indistinguishable from one that works. The caller — a `set` from
     * the UI — decides what to say about it. */
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(envelope))
  }

  return {
    get: (setting) => {
      if (!(setting.key in values)) return setting.fallback
      const parsed = setting.parse(values[setting.key])
      return parsed === undefined ? setting.fallback : parsed
    },
    set: (setting, value) => {
      /* BY VALUE, so a re-render that sets what is already set writes nothing:
       * the UI writes on every change of nine fields, and most of those
       * changes are one field. Primitives compare directly; anything richer
       * compares serialised, which is what will be stored anyway. */
      const current = values[setting.key]
      const same =
        setting.key in values &&
        (Object.is(current, value) || JSON.stringify(current) === JSON.stringify(value))
      if (same) return
      values = { ...values, [setting.key]: value }
      // Listeners first: what is held in memory is the truth the UI shows,
      // whether or not the disk then takes it. Then the write, whose failure
      // is the caller's to hear about.
      for (const listener of [...listeners]) listener()
      persist()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => values,
  }
}

/* ------------------------------------------------------------------------ */
/* The kernel's own settings                                                 */
/* ------------------------------------------------------------------------ */

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (raw: unknown): T | undefined =>
    typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined

const boolean = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined)

/**
 * The reading preferences that survive a launch. Names match the `AppState`
 * fields they mirror; keys carry the `kernel.` namespace.
 */
export const KERNEL_SETTINGS = {
  theme: defineSetting<Theme>('kernel.theme', 'paper', oneOf(THEME_IDS)),
  themeFollowsOs: defineSetting<boolean>('kernel.themeFollowsOs', true, boolean),
  /* A string, validated only as a non-empty one: the registry of faces is the
   * UI's (`typefaces.ts`), and `faceById` maps an id this machine lacks to the
   * default. `literata` is §14's face. */
  typeface: defineSetting<Typeface>('kernel.typeface', 'literata', (raw) =>
    typeof raw === 'string' && raw !== '' ? raw : undefined,
  ),
  /* An INDEX into `READING_STEPS`, so it is checked against that list's length
   * — a file from a build with more steps must not index past the end. */
  stepIdx: defineSetting<number>('kernel.stepIdx', DEFAULT_STEP_IDX, (raw) =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < READING_STEPS.length
      ? raw
      : undefined,
  ),
  pageLayout: defineSetting<PageLayout>('kernel.pageLayout', 'scrolled', oneOf(PAGE_LAYOUTS)),
  side: defineSetting<Side>('kernel.side', 'right', oneOf(SIDES)),
  rulerOn: defineSetting<boolean>('kernel.rulerOn', false, boolean),
  scrollbarOn: defineSetting<boolean>('kernel.scrollbarOn', false, boolean),
  progressLineOn: defineSetting<boolean>('kernel.progressLineOn', false, boolean),
} as const satisfies Record<string, Setting<unknown>>

export type KernelSettingName = keyof typeof KERNEL_SETTINGS

/** The kernel's preferences as values — what a launch reads before it renders. */
export type KernelPreferences = {
  readonly [K in KernelSettingName]: (typeof KERNEL_SETTINGS)[K] extends Setting<infer T> ? T : never
}

export function readKernelPreferences(store: SettingsStore): KernelPreferences {
  return {
    theme: store.get(KERNEL_SETTINGS.theme),
    themeFollowsOs: store.get(KERNEL_SETTINGS.themeFollowsOs),
    typeface: store.get(KERNEL_SETTINGS.typeface),
    stepIdx: store.get(KERNEL_SETTINGS.stepIdx),
    pageLayout: store.get(KERNEL_SETTINGS.pageLayout),
    side: store.get(KERNEL_SETTINGS.side),
    rulerOn: store.get(KERNEL_SETTINGS.rulerOn),
    scrollbarOn: store.get(KERNEL_SETTINGS.scrollbarOn),
    progressLineOn: store.get(KERNEL_SETTINGS.progressLineOn),
  }
}

/** Write every kernel preference that differs from what is stored. */
export function writeKernelPreferences(store: SettingsStore, prefs: KernelPreferences): void {
  store.set(KERNEL_SETTINGS.theme, prefs.theme)
  store.set(KERNEL_SETTINGS.themeFollowsOs, prefs.themeFollowsOs)
  store.set(KERNEL_SETTINGS.typeface, prefs.typeface)
  store.set(KERNEL_SETTINGS.stepIdx, prefs.stepIdx)
  store.set(KERNEL_SETTINGS.pageLayout, prefs.pageLayout)
  store.set(KERNEL_SETTINGS.side, prefs.side)
  store.set(KERNEL_SETTINGS.rulerOn, prefs.rulerOn)
  store.set(KERNEL_SETTINGS.scrollbarOn, prefs.scrollbarOn)
  store.set(KERNEL_SETTINGS.progressLineOn, prefs.progressLineOn)
}
