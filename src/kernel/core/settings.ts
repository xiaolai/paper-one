import { MARK_TINTS, READER_STYLES, type MarkStorage, type MarkStyle, type MarkTint } from './marks'
import {
  BRIGHTNESS,
  CONTRAST,
  DEFAULT_READING_STYLE,
  DEFAULT_STEP_IDX,
  LEGACY_READING_SIZES,
  FIGURE_HEIGHTS,
  FIGURE_WIDTHS,
  MINIMUM_SIZES,
  READING_STEPS,
  SPACING,
  type SpacingScale,
} from './metrics'
import { defineSetting, type Setting, type SettingsStore } from './ports'
import {
  ALIGNS,
  CODE_FACES,
  CODE_WRAPS,
  FIDELITIES,
  FIGURE_FRAMES,
  FLOURISHES,
  HEADING_SCALES,
  NOTE_SIZES,
  PAGE_LAYOUTS,
  QUOTE_STYLES,
  SEPARATIONS,
  SIDES,
  TABLE_FITS,
  THEME_IDS,
  type Align,
  type PageLayout,
  type ReadingStyle,
  type Side,
  type SpacingIndices,
  type Theme,
  type Typeface,
} from './uiTypes'

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

/**
 * Carry Paper's pre-kernel settings file onto the namespaced keys.
 *
 * That file was a flat map of `AppState` field names — `theme`, `stepIdx`,
 * `spacing` — written under this same storage key before the kernel gave every
 * setting an owner. The names are otherwise identical, so the migration is a
 * prefix: `theme` becomes `kernel.theme`, and a value that is already
 * namespaced (anything with a dot) is passed through untouched, which is what
 * makes this safe to run over an envelope that has already been migrated.
 *
 * VALUES ARE NOT VALIDATED HERE. Each setting's own `parse` runs on `get`, so a
 * field the old file spelled differently, or a step index from a build with a
 * longer ramp, falls back or clamps exactly as it would from a current file —
 * one migration, not a second copy of fifteen validators.
 */
export const carryLegacySettings: SettingsMigration = (found) => {
  const values = found?.values ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key.includes('.') ? key : `kernel.${key}`] = value
  }
  return out
}

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
  const versioned = typeof shape.version === 'number' && Number.isFinite(shape.version)
  const version = versioned ? (shape.version as number) : 0
  const wrapped =
    typeof shape.values === 'object' && shape.values !== null && !Array.isArray(shape.values)
      ? (shape.values as Record<string, unknown>)
      : null
  /* AN ENVELOPE FROM BEFORE THERE WERE ENVELOPES is the object itself.
   * Paper's first settings file was a flat map of `AppState` field names under
   * this same key, with no `version` and no `values` — so reading it as "an
   * envelope carrying nothing" would hand every reader who had ever chosen a
   * theme the defaults back, once, silently. Only when BOTH markers are absent:
   * a versioned envelope with no values really is carrying nothing. */
  const values = wrapped ?? (versioned ? {} : (parsed as Record<string, unknown>))
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
  /* ⚠️ **AN ENVELOPE FROM THE FUTURE IS NOT THIS BUILD'S TO MIGRATE.** The
   * test was `version === SETTINGS_VERSION`, so ANY other number — including a
   * higher one — went through the BACKWARD migration and was then written back
   * as version 1. A reader who ran a newer Paper and then an older one had
   * their settings file rewritten into a shape the newer build no longer
   * understands, silently, on the first preference they changed. Found by
   * audit. */
  const fromTheFuture = found !== null && found.version > SETTINGS_VERSION
  let values: Readonly<Record<string, unknown>> =
    found && found.version === SETTINGS_VERSION
      ? found.values
      : fromTheFuture
        ? /* READ, BUT NOT REWRITTEN. The values are almost certainly a superset
             of this build's — every setting is `<namespace>.<name>` and `get`
             ignores what it was not asked for — so the reader keeps their theme
             and their type size rather than being reset. What must not happen
             is this build claiming the file. */
          (found.values as Readonly<Record<string, unknown>>)
        : migrate(found)
  const listeners = new Set<() => void>()

  /* WHETHER THE NEXT LAUNCH WILL SEE ANY OF THIS. No storage at all is the
   * plain case; a storage that has REFUSED a write is the earned one — and a
   * file written by a NEWER build is the third: refusing to write it is the
   * only way to leave it intact, and "these settings are not being saved" is
   * already the sentence the panel draws for exactly this state. */
  let persistent = storage !== null && !fromTheFuture

  /**
   * Tell every subscriber, and let none of them stop the others.
   *
   * ⚠️ **A THROWING SUBSCRIBER USED TO ESCAPE, AND TAKE THE WRITE WITH IT.**
   * `set` promises in capitals never to throw, and the loop broke that three
   * ways at once: the exception left `set` through a caller with nobody to
   * catch it, every listener after the thrower went untold, and `persist` never
   * ran — so the value was in memory, half the UI knew, and the disk never
   * heard. The same class `controller.ts`'s `set` was fixed for one round
   * earlier.
   *
   * ⚠️ **AND THERE ARE TWO CALLERS, WHICH IS WHY THIS IS A FUNCTION.** The
   * first fix isolated the loop in `set` and left the identical loop in
   * `persist`'s catch — the one that publishes `persistent = false`, which is
   * the single most important thing this store ever tells anybody, and the path
   * where a subscriber is most likely to be doing something unusual. One
   * notifier, two callers, and no third copy to forget. Found by the verify
   * pass on the fix for the first.
   */
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (thrown) {
        console.error('Paper: a settings subscriber threw while being notified', thrown)
      }
    }
  }

  /**
   * Whether a write would change anything, without ever throwing.
   *
   * ⚠️ **`JSON.stringify` IS NOT TOTAL**, and the comparison it replaces was
   * unguarded inside a method that promises never to throw: a cyclic value
   * throws `TypeError`, and so does a `bigint` or a `toJSON` that fails. The
   * settings this app defines are all JSON-safe, so the hole was reachable only
   * through a capability's own setting — which is exactly the caller this store
   * cannot vouch for.
   *
   * A DIFFERENCE IT CANNOT PROVE IS A DIFFERENCE. Falling back to "changed"
   * costs one redundant write and a notification; falling back to "unchanged"
   * would silently drop a real preference, which is the worse of the two by a
   * wide margin.
   */
  const unchanged = (current: unknown, value: unknown): boolean => {
    if (Object.is(current, value)) return true
    try {
      return JSON.stringify(current) === JSON.stringify(value)
    } catch {
      return false
    }
  }

  const persist = () => {
    if (!storage || !persistent) return
    const envelope: SettingsEnvelope = { version: SETTINGS_VERSION, values }
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(envelope))
    } catch (cause) {
      /* ⚠️ **THIS USED TO THROW, AND NOTHING CAUGHT IT.**
       *
       * `MarkStorage.setItem` signals a failed store by throwing, and the note
       * here said the caller would decide what to say about it. No caller
       * decided. `set` is called from `onClick` handlers and from a loop, and
       * every multi-field write in the app is a RUN of `set` calls — choosing a
       * theme writes `theme` then `themeFollowsOs`; `writeKernelPreferences`
       * writes sixteen. A quota error on the first aborted the rest, so what
       * survived a launch was a PREFIX of what the reader had chosen: theme
       * night, "follow the system" still on, and no way to tell.
       *
       * Swallowing it would be the other half of the same defect, so it is not
       * swallowed — it becomes `persistent: false`, published to subscribers,
       * which the settings pane draws as a sentence. A store that cannot write
       * is a SESSION store, which is a state this store already has a name for.
       *
       * And it stops trying. A quota that is full stays full, and re-throwing
       * out of every keystroke costs a serialisation of the whole envelope for
       * an answer that will not have changed. */
      persistent = false
      console.error('Paper: settings will not be saved on this device', cause)
      notify()
    }
  }

  return {
    get: <T,>(setting: Setting<T>): T => {
      if (!(setting.key in values)) return setting.fallback
      /* `get` PROMISES NEVER TO FAIL, and `parse` is arbitrary code supplied
       * by whoever defined the setting — one that threw on a hand-edited or
       * migrated value took down every reader of it, including the boot path
       * that has no handler. A parser that cannot make sense of what is
       * stored is answering the same thing as one that returns `undefined`:
       * "not a value I recognise", which is what the fallback is for. */
      let parsed: T | undefined
      try {
        parsed = setting.parse(values[setting.key])
      } catch {
        return setting.fallback
      }
      return parsed === undefined ? setting.fallback : parsed
    },
    set: (setting, value) => {
      /* BY VALUE, so a re-render that sets what is already set writes nothing:
       * the UI writes on every change of fifteen fields, and most of those
       * changes are one field. Primitives compare directly; anything richer
       * compares serialised, which is what will be stored anyway.
       *
       * AND AGAINST THE FALLBACK WHEN NOTHING IS STORED, because absent MEANS
       * the fallback — `get` returns it — so writing it back changes nothing a
       * reader could observe. Without this every cold start wrote all fifteen
       * defaults to disk: the app reads its preferences before the first
       * render and writes them back in an effect, so a launch that changed
       * nothing still paid a write, on the one path that is already the
       * slowest. */
      const current = setting.key in values ? values[setting.key] : setting.fallback
      if (unchanged(current, value)) return
      values = { ...values, [setting.key]: value }
      // Listeners first: what is held in memory is the truth the UI shows,
      // whether or not the disk then takes it. Then the write, whose failure
      // becomes `persistent` rather than an exception out of an event handler.
      notify()
      persist()
    },
    get persistent() {
      return persistent
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
 * A list of strings, with anything that is not one dropped.
 *
 * NOT rejected wholesale: this stores pane ids a reader ticked, and a single
 * junk entry from a hand-edited file should cost that entry rather than the
 * whole list. A non-array IS rejected, because that is a value of the wrong
 * shape rather than a list with a bad member.
 */
const stringList = (raw: unknown): readonly string[] | undefined =>
  Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : undefined

/**
 * An index into one of §09's scales, CLAMPED to it rather than rejected.
 *
 * These are positions on a ramp, and a file written by a build with a longer
 * ramp is not corrupt — it is describing the end of a scale this build has
 * less of. Falling back to the default there would throw away a reader's
 * deliberate "as large as it goes"; clamping keeps the intent and lands on the
 * nearest thing this build can show. A non-integer IS rejected: it indexes
 * nothing, and `stepAt` on a NaN yields undefined rather than a step.
 */
const index =
  (length: number) =>
  (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isInteger(raw) ? Math.max(0, Math.min(length - 1, raw)) : undefined

/** The four spacing indices, each independently clamped; a broken one costs
 *  itself and not the other three. */
const spacingIndices = (raw: unknown): SpacingIndices | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const at = (key: keyof SpacingIndices) =>
    index(SPACING[key].steps.length)(row[key]) ?? SPACING[key].def
  return { letter: at('letter'), word: at('word'), line: at('line'), paragraph: at('paragraph') }
}

/**
 * WI-14.4's fifteen, validated one key at a time.
 *
 * FIELD BY FIELD, NEVER AS A BLOB. This value is read back off disk and may
 * have been hand-edited, or written by a build whose scales were a different
 * length — so each key is validated against the same list or scale the UI
 * offers, and anything unrecognised falls back to that setting's own default
 * rather than taking the whole object down with it. Exactly what
 * `spacingIndices` does above, for the same reason.
 *
 * A MISSING KEY IS THE ORDINARY CASE, not an error: every settings file written
 * before this landed has none of them, and a reader upgrading must get the
 * defaults rather than an empty panel.
 */
const readingStyle = (raw: unknown): ReadingStyle | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const pick = <T extends string>(key: keyof ReadingStyle, from: readonly T[]): T =>
    (oneOf(from)(row[key]) ?? DEFAULT_READING_STYLE[key]) as T
  const step = (key: keyof ReadingStyle, scale: SpacingScale): number =>
    index(scale.steps.length)(row[key]) ?? (DEFAULT_READING_STYLE[key] as number)
  const flag = (key: keyof ReadingStyle): boolean =>
    boolean(row[key]) ?? (DEFAULT_READING_STYLE[key] as boolean)
  return {
    separation: pick('separation', SEPARATIONS),
    flourish: pick('flourish', FLOURISHES),
    headingScale: pick('headingScale', HEADING_SCALES),
    blockquote: pick('blockquote', QUOTE_STYLES),
    codeFace: pick('codeFace', CODE_FACES),
    codeWrap: pick('codeWrap', CODE_WRAPS),
    figureWidth: step('figureWidth', FIGURE_WIDTHS),
    figureFrame: pick('figureFrame', FIGURE_FRAMES),
    figureScalesWithText: flag('figureScalesWithText'),
    figureHeight: step('figureHeight', FIGURE_HEIGHTS),
    wideTables: pick('wideTables', TABLE_FITS),
    noteSize: pick('noteSize', NOTE_SIZES),
    cjkSpacing: flag('cjkSpacing'),
    minimumSize: step('minimumSize', MINIMUM_SIZES),
    fidelity: pick('fidelity', FIDELITIES),
  }
}

/**
 * The reading preferences that survive a launch. Names match the `AppState`
 * fields they mirror; keys carry the `kernel.` namespace.
 */
export const KERNEL_SETTINGS = {
  /**
   * Developer options, off until somebody asks for them by name.
   *
   * ⌘⌃⌥D is the only way in — there is no control anywhere that turns this on,
   * because a switch a reader can find is a switch a reader will find. What it
   * reveals is the unfinished panels (`UNFINISHED_PANE_IDS`) and the Developer
   * panel itself.
   *
   * PERSISTED, like every other preference. Re-entering a four-key chord on
   * every launch is a thing nobody would do twice, and the state is not a
   * secret — it is a preference about what this reader wants to be shown.
   */
  developer: defineSetting<boolean>('kernel.developer', false, boolean),
  /**
   * Which unfinished panels to keep hidden WHILE developer options are on.
   *
   * Consulted only under `developer`, which is what makes it harmless: a
   * reader who never opens developer options cannot end up with a list that
   * means anything, and turning the master switch off gives the plain app back
   * whatever was ticked while it was on. See `paneOffered`, which is the one
   * function that reads both.
   *
   * Empty by default, so turning developer options on shows everything — the
   * switches are there to take a panel away while you work on another, not to
   * make you go and find each one.
   */
  hiddenPanes: defineSetting<readonly string[]>('kernel.hiddenPanes', [], stringList),
  theme: defineSetting<Theme>('kernel.theme', 'paper', oneOf(THEME_IDS)),
  themeFollowsOs: defineSetting<boolean>('kernel.themeFollowsOs', true, boolean),
  /* A string, validated only as a non-empty one: the registry of faces is the
   * UI's (`typefaces.ts`), and `faceById` maps an id this machine lacks to the
   * default. `literata` is §14's face. */
  typeface: defineSetting<Typeface>('kernel.typeface', 'literata', (raw) =>
    typeof raw === 'string' && raw !== '' ? raw : undefined,
  ),
  /**
   * THE READING SIZE IN PIXELS, NOT AN INDEX INTO THE RAMP.
   *
   * It was `kernel.stepIdx`, an index, and an index means nothing across a
   * change to `READING_STEPS`. When the ramp went from seven steps to fourteen
   * a stored `2` meant 21px on the old scale and 17px on the new one — so every
   * reader would have opened the next launch with smaller type and nothing to
   * say why. Storing what the reader actually chose survives any ramp that
   * still offers it, and `stepIndexForSize` lands them on the nearest step when
   * one does not (30px was offered once and is not now).
   *
   * Validated as a finite positive number rather than against the ramp's own
   * list, for the same reason `index` clamps instead of rejecting: a size this
   * build does not offer is a reader's deliberate choice made on another build,
   * and the nearest step honours it where refusing it would not.
   */
  textSize: defineSetting<number>('kernel.textSize', READING_STEPS[DEFAULT_STEP_IDX]!.size, (raw) =>
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined,
  ),
  pageLayout: defineSetting<PageLayout>('kernel.pageLayout', 'scrolled', oneOf(PAGE_LAYOUTS)),
  side: defineSetting<Side>('kernel.side', 'right', oneOf(SIDES)),
  rulerOn: defineSetting<boolean>('kernel.rulerOn', false, boolean),
  scrollbarOn: defineSetting<boolean>('kernel.scrollbarOn', false, boolean),
  progressLineOn: defineSetting<boolean>('kernel.progressLineOn', false, boolean),
  spacing: defineSetting<SpacingIndices>(
    'kernel.spacing',
    { letter: SPACING.letter.def, word: SPACING.word.def, line: SPACING.line.def, paragraph: SPACING.paragraph.def },
    spacingIndices,
  ),
  align: defineSetting<Align>('kernel.align', 'justified', oneOf(ALIGNS)),
  brightness: defineSetting<number>('kernel.brightness', BRIGHTNESS.def, index(BRIGHTNESS.steps.length)),
  contrast: defineSetting<number>('kernel.contrast', CONTRAST.def, index(CONTRAST.steps.length)),
  markTint: defineSetting<MarkTint>('kernel.markTint', 'yellow', oneOf(MARK_TINTS)),
  /* READER_STYLES, not every style there is. The wave belongs to the
     companion — a settings file naming it, whether hand-edited or written by
     a build that offered it, must not hand the reader a style they cannot
     choose and cannot see the provenance rule behind. */
  markStyle: defineSetting<MarkStyle>('kernel.markStyle', 'fill', oneOf(READER_STYLES)),
  /* WI-14.4's fifteen. They persist for the same reason every other reading
     setting here does — a reader who set them up should not have to do it
     again on the next launch — and their absence was a real defect for exactly
     as long as it took an audit to notice that `theme`, `stepIdx`, `spacing`
     and `align` are all in this list and these fifteen were not. */
  readingStyle: defineSetting<ReadingStyle>('kernel.readingStyle', DEFAULT_READING_STYLE, readingStyle),
} as const satisfies Record<string, Setting<unknown>>

export type KernelSettingName = keyof typeof KERNEL_SETTINGS

/** The kernel's preferences as values — what a launch reads before it renders. */
export type KernelPreferences = {
  readonly [K in KernelSettingName]: (typeof KERNEL_SETTINGS)[K] extends Setting<infer T> ? T : never
}

/**
 * The legacy index, for one migration, or `-1` when there is nothing to read.
 *
 * `store.get` NEVER FAILS — an absent or malformed value comes back as the
 * setting's fallback — so "not stored" and "stored as rubbish" are the same
 * answer, and the only way to ask the question is a fallback no real value can
 * take. `-1` is not a legal index, and `index()` rejects it, so both cases land
 * on it and both mean the same thing here: nothing to migrate.
 */
const LEGACY_STEP_IDX = defineSetting<number>('kernel.stepIdx', -1, index(LEGACY_READING_SIZES.length))

/**
 * The reading size, migrating a stored index from the seven-step ramp once.
 *
 * WITHOUT THIS, EVERY READER'S TYPE CHANGES SIZE ON THE LAUNCH AFTER THE RAMP
 * DID. The default was index 2 of seven and is index 6 of fourteen; a settings
 * file written before the change says `2`, which on this ramp is 17px. The
 * reader chose 21px and would be given 17px, silently.
 *
 * ONE DIRECTION AND ONE TIME. Once `kernel.textSize` exists it wins outright
 * and the legacy key is never consulted again, so this cannot fight a size the
 * reader sets afterwards. The old key is left on disk rather than deleted: it
 * costs one line of JSON, and a reader who moves a library back to an older
 * build gets their size there too.
 */
function readTextSize(store: SettingsStore): number {
  const stored = store.get(KERNEL_SETTINGS.textSize)
  if (stored !== KERNEL_SETTINGS.textSize.fallback) return stored
  const legacy = store.get(LEGACY_STEP_IDX)
  return LEGACY_READING_SIZES[legacy] ?? stored
}

export function readKernelPreferences(store: SettingsStore): KernelPreferences {
  return {
    developer: store.get(KERNEL_SETTINGS.developer),
    hiddenPanes: store.get(KERNEL_SETTINGS.hiddenPanes),
    theme: store.get(KERNEL_SETTINGS.theme),
    themeFollowsOs: store.get(KERNEL_SETTINGS.themeFollowsOs),
    typeface: store.get(KERNEL_SETTINGS.typeface),
    textSize: readTextSize(store),
    pageLayout: store.get(KERNEL_SETTINGS.pageLayout),
    side: store.get(KERNEL_SETTINGS.side),
    rulerOn: store.get(KERNEL_SETTINGS.rulerOn),
    scrollbarOn: store.get(KERNEL_SETTINGS.scrollbarOn),
    progressLineOn: store.get(KERNEL_SETTINGS.progressLineOn),
    spacing: store.get(KERNEL_SETTINGS.spacing),
    align: store.get(KERNEL_SETTINGS.align),
    brightness: store.get(KERNEL_SETTINGS.brightness),
    contrast: store.get(KERNEL_SETTINGS.contrast),
    markTint: store.get(KERNEL_SETTINGS.markTint),
    markStyle: store.get(KERNEL_SETTINGS.markStyle),
    readingStyle: store.get(KERNEL_SETTINGS.readingStyle),
  }
}

/** Write every kernel preference that differs from what is stored. */
export function writeKernelPreferences(store: SettingsStore, prefs: KernelPreferences): void {
  /* EVERY SETTING IN THE TABLE, DERIVED — never a second hand-written list.
   *
   * This was sixteen `store.set` calls mirroring `KERNEL_SETTINGS` by hand, and
   * the asymmetry is the trap: an omitted field in the READER is a type error,
   * because `KernelPreferences` is mapped from the table — an omitted `set`
   * here is nothing at all, and the setting simply never persists. WI-14.4's
   * fifteen were shipped that way for exactly as long as it took an audit to
   * ask why the panel reset on every launch.
   *
   * The cast is the one place the derivation cannot be expressed: `store.set`
   * is generic in the setting's own type, and iterating the table erases the
   * link between key and value that `KernelPreferences` already guarantees.
   */
  for (const name of Object.keys(KERNEL_SETTINGS) as KernelSettingName[]) {
    store.set(KERNEL_SETTINGS[name] as Setting<unknown>, prefs[name])
  }
}
