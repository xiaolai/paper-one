import { notifyAll } from './notify'
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
  PARAGRAPH_GAP,
  READING_RATE,
  SENTENCE_GAP,
  READING_STEPS,
  SPACING,
  type SteppedScale,
} from './metrics'
import { defineSetting, frozen, type Setting, type SettingsStore } from './ports'
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
 * ⚠️ **AND THE NAMESPACED VALUE WINS, WHATEVER ORDER THE FILE LISTS THEM IN.**
 * One loop wrote both spellings to the same key as it met them, so
 * `{ "kernel.theme": "sage", "theme": "night" }` came out `night` and the same
 * two keys the other way round came out `sage` — property order deciding a
 * preference. A namespaced key can only have been written by a build that
 * already knew the namespace, so it is the newer of the two; a legacy key is
 * carried only where its destination is still empty. Found by audit.
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
    if (key.includes('.')) out[key] = value
  }
  for (const [key, value] of Object.entries(values)) {
    const carried = `kernel.${key}`
    if (!key.includes('.') && !(carried in out)) out[carried] = value
  }

  return out
}

export interface SettingsStoreOptions {
  /** The flat store. `null` — no storage at all — makes a store that lives for the session. */
  readonly storage: MarkStorage | null
  readonly migrate?: SettingsMigration
}

/**
 * Read one envelope back, or `null` when NOTHING IS STORED.
 *
 * `version` may be missing or a non-number: that is an OLDER envelope for the
 * migration hook to see, reported with `version: 0`. `values` that are absent
 * are no values; `values` that are there and are not an object THROW. (This
 * sentence said they were no values too, which was the defect — see the
 * comment at the check.)
 *
 * ⚠️ **AND BYTES THAT ARE NOT AN ENVELOPE THROW, WHERE THEY USED TO BE `null`
 * TOO.** `null` is what the store reads as "this reader has no settings file",
 * so answering it for a file that would not parse started the store empty with
 * writes ON — and the next preference changed replaced the file with an
 * envelope holding that one alone. That is the very defect the read-THROW path
 * below was fixed for, arriving by the commoner route, and it survived that fix
 * because the two answers were spelled the same (2026-09-13 audit). Only
 * `null` — nothing stored — is nothing stored.
 */
function parseEnvelope(raw: string | null): SettingsEnvelope | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error('the stored settings are not JSON', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the stored settings are not an envelope')
  }
  const shape = parsed as { version?: unknown; values?: unknown }
  /* `Number.isFinite` DOES NOT COERCE, so it answers false for a version that is
     absent, a string, or `1e999` — which is what `JSON.parse` makes Infinity of,
     and which counted as a version would outrank every version there will be. A
     `typeof` test in front of it decided nothing and hid this line's own
     mutants from the gate. */
  const versioned = Number.isFinite(shape.version)
  const version = versioned ? (shape.version as number) : 0
  /* ⚠️ **A `values` THAT IS THERE AND IS NOT A COLLECTION IS DAMAGE, AND IT
   * READ AS NO VALUES.** The throws above were the 2026-09-13 audit's; this
   * line survived them, so `{"version":1,"values":[…]}` still came up as `{}`
   * with writes ON and the first preference changed replaced the file with an
   * envelope holding that one alone — the same loss, one field further in
   * (2026-09-13 verify). ABSENT is still nothing: a legacy flat file has no
   * `values` key, and a versioned envelope without one carries nothing. And
   * one preference that will not read still costs only itself, in its own
   * `parse` on `get`: it is the collection that is refused here, not a row. */
  if (
    shape.values !== undefined &&
    (typeof shape.values !== 'object' || shape.values === null || Array.isArray(shape.values))
  ) {
    throw new Error('the stored settings have values that are not a collection')
  }
  /* Absent stays absent: the `??` below reads `undefined` exactly as it read the
     `null` this used to be turned into, so the turning was a branch that decided
     nothing and hid its own line from the gate. */
  const wrapped = shape.values as Record<string, unknown> | undefined
  /* AN ENVELOPE FROM BEFORE THERE WERE ENVELOPES is the object itself.
   * Paper's first settings file was a flat map of `AppState` field names under
   * this same key, with no `version` and no `values` — so reading it as "an
   * envelope carrying nothing" would hand every reader who had ever chosen a
   * theme the defaults back, once, silently. Only when BOTH markers are absent:
   * a versioned envelope with no values really is carrying nothing. */
  const values = wrapped ?? (versioned ? {} : (parsed as Record<string, unknown>))
  return { version, values }
}

/**
 * What is stored, and whether this launch could read it at all.
 *
 * A storage that throws on read — disabled, busy, or a hostile stub — is a
 * store with nothing in it. The reader gets defaults, and the app still opens.
 *
 * ⚠️ **BUT NOTHING IN IT IS NOT NOTHING ON DISK, AND THE NEXT WRITE USED TO SAY
 * IT WAS.** Writes stayed on, and `persist` writes the whole envelope — so one
 * preference changed after a transient failure replaced the file with an
 * envelope holding only that preference, and every other setting, a
 * capability's included, was gone. Unreadable is not absent: the store keeps
 * this session's choices and leaves the file it could not read alone, which is
 * `persistent: false`. Found by audit.
 *
 * ⚠️ **AND THE COMMONER FAILURE IS THE FILE, NOT THE STORAGE — IT ARRIVED HERE
 * ONLY WITH THE 2026-09-13 AUDIT.** A `getItem` that throws is rare; a file that
 * will not parse is what damage actually looks like, and `parseEnvelope`
 * answered it with the same `null` that means "no settings yet". So everything
 * the paragraph above describes went on happening, past its own fix, to every
 * reader whose file was merely corrupt. The parse throws for those bytes now
 * and both failures land here.
 *
 * A FUNCTION RATHER THAN A `try` IN THE FACTORY, so `found` stays a `const`
 * below: the narrowing that `fromTheFuture` carries is an aliased-condition
 * narrowing, which TypeScript only performs for a constant.
 */
function openStored(storage: MarkStorage | null): {
  readonly found: SettingsEnvelope | null
  readonly unreadable: boolean
} {
  try {
    return { found: parseEnvelope(storage?.getItem(SETTINGS_STORAGE_KEY) ?? null), unreadable: false }
  } catch (cause) {
    console.error('Paper: settings could not be read, and will not be saved this session', cause)
    return { found: null, unreadable: true }
  }
}

/**
 * ⚠️ **THIS STORE ASSUMES IT IS THE ONLY WRITER, AND THAT IS A DECISION.**
 *
 * It reads the envelope once at construction and writes that whole cached
 * record back on every change, so a SECOND store over the same backing
 * storage — two browser tabs of the shelf share one `localStorage` — can
 * overwrite the other's newer values, including keys belonging to capabilities
 * this build does not compose. An audit asked for revisions or a
 * compare-and-set. Three reasons it is written down instead of built:
 *
 * - The fix is not local. `MarkStorage` is `getItem`/`setItem` over one key
 *   and has no compare-and-set, no change notification and no transaction, so
 *   a revision would have to be read-modify-write through the same racing
 *   door it is meant to close. Doing it properly means a new port, and a
 *   format bump on a file every reader already has.
 * - The same absence is why `persistent` can lag a real failure by one write
 *   (`fileStore.ts` reports a refused disk write on the NEXT `setItem`), and
 *   why `writeKernelPreferences` cannot be atomic: N `set` calls are N writes,
 *   and a storage that refuses half way leaves a prefix on disk. That prefix
 *   is REPORTED — it turns the store session-only, which the panel draws — so
 *   the failure is visible even though it is not prevented.
 * - The native app is single-instance (`tauri_plugin_single_instance`), so the
 *   racing pair is two browser tabs, and what is lost there is a preference,
 *   not a book.
 *
 * So: a known limit with a named cost, not an oversight. Anything that gives
 * `MarkStorage` a compare-and-set should close all three at once, and this
 * comment is the list of what to check when it does.
 */
export function createSettingsStore({ storage, migrate = keepValues }: SettingsStoreOptions): SettingsStore {
  const { found, unreadable } = openStored(storage)
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
  /**
   * The migration hook's answer, or none — never a thrown exception.
   *
   * ⚠️ **A THROWING MIGRATION USED TO ABORT THE WHOLE STORE, AND THE STORE IS
   * ON THE BOOT PATH.** `migrate` is supplied by the caller, it runs on
   * whatever bytes were on disk, and it is the one piece of arbitrary code in
   * this function — so a hook that threw on a hand-edited or half-written file
   * took `createSettingsStore` down with it, and with it the launch. Every
   * other way of meeting damaged settings in this file is deliberately
   * nonfatal: unreadable bytes become a session store, a file from the future
   * becomes a session store. This was the one door left where damage could
   * stop the app from starting, which is the worst available answer to it —
   * the reader cannot even reach the panel that would say what is wrong.
   *
   * It degrades the same way as the rest now: no values, session-only, the
   * damaged bytes left exactly where they are so a later build can still read
   * them. `get` answers every setting's fallback, which is what a reader with
   * no settings file already sees.
   */
  let migrationFailed = false
  const migrated = (stored: SettingsEnvelope | null): Readonly<Record<string, unknown>> => {
    try {
      return migrate(stored)
    } catch (cause) {
      migrationFailed = true
      console.error('Paper: stored settings could not be migrated, so this session starts from the defaults', cause)
      return {}
    }
  }
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
        : migrated(found)
  /* FROZEN, like everything `set` holds after it: `getSnapshot` hands this record
     out whole, and a reader who changed a value in it changed memory under the
     disk, with no write and no notification (2026-09-13 verify).

     ⚠️ **AND THE FREEZE IS PART OF THE LOADING PATH, SO IT IS GUARDED TOO.**
     `frozen` walks what the migration returned, and the migration is the
     caller's code — a getter on that record runs HERE, not above, so guarding
     only the `migrate` call left the second half of the same door open. A hook
     that returns a record whose getter throws would abort the store exactly as
     a hook that threw outright did. Same degradation, one reason. */
  try {
    values = frozen(values)
  } catch (cause) {
    migrationFailed = true
    console.error('Paper: stored settings could not be read, so this session starts from the defaults', cause)
    values = frozen({})
  }
  const listeners = new Set<() => void>()

  /* WHETHER THE NEXT LAUNCH WILL SEE ANY OF THIS. No storage at all is the
   * plain case; a storage that has REFUSED a write is the earned one — and a
   * file written by a NEWER build is the third: refusing to write it is the
   * only way to leave it intact, and "these settings are not being saved" is
   * already the sentence the panel draws for exactly this state. A file that
   * would not READ is the fourth, for the same reason as the third. A
   * migration that THREW is the fifth — see `migrated` above. */
  let persistent = storage !== null && !fromTheFuture && !unreadable && !migrationFailed

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
  const notify = (): void => notifyAll(listeners, 'settings')

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
    /* NO `Object.is` SHORTCUT IN FRONT OF THIS. `value` is always a fresh JSON
       copy, so wherever identity held the comparison below held too — a branch
       nothing could observe, which is also a branch nothing could hold. */
    let same = false
    try {
      same = JSON.stringify(current) === JSON.stringify(value)
    } catch {
      /* Left false: a difference it cannot prove is a difference. */
    }
    return same
  }

  const persist = () => {
    if (!storage || !persistent) return
    const envelope: SettingsEnvelope = { version: SETTINGS_VERSION, values }
    /* ⚠️ **SERIALISING IS NOT THE STORAGE, AND ONE CATCH USED TO ANSWER FOR
     * BOTH.** A value `JSON.stringify` refused was read as a refused WRITE and
     * turned persistence off for the session — so one capability's unsaveable
     * value stopped every preference saving, and replacing it did not undo
     * that. `set` now refuses such a value before it is held, so the envelope
     * can only fail here through a migration hook's output. */
    let text: string
    try {
      text = JSON.stringify(envelope)
    } catch (cause) {
      /* ⚠️ **AND THIS USED TO RETURN LEAVING `persistent` TRUE, ON THE GROUND
       * THAT THE STORAGE WAS HEALTHY.** The storage is; the STORE is not, and
       * this flag is the store's. Its own declaration above says what it
       * means — *whether the next launch will see any of this* — and once the
       * envelope holds a value `JSON.stringify` refuses, the answer is no, and
       * stays no for every later write: the offending value sits in `values`
       * and nothing a reader does removes it. So the panel drew "your settings
       * are saved" over a store that had stopped saving at the first
       * preference they changed. A store that cannot write is a SESSION store,
       * exactly as in the storage branch below, and it is published for the
       * same reason. */
      persistent = false
      console.error('Paper: settings could not be serialised, so they will not be saved on this device', cause)
      notify()
      return
    }
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, text)
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
    /* The same test `set` makes below — see the port. */
    has: <T,>(setting: Setting<T>): boolean => setting.key in values,
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
        /* Left unset, which the line below already answers with the fallback:
           a parser that throws is saying what one that returns `undefined` says. */
      }
      return parsed === undefined ? setting.fallback : parsed
    },
    set: (setting, value) => {
      /* BY VALUE, so a re-render that sets what is already set writes nothing:
       * the UI writes on every change of fifteen fields, and most of those
       * changes are one field. Compared serialised, which is what will be
       * stored anyway.
       *
       * AND AGAINST THE FALLBACK WHEN NOTHING IS STORED, because absent MEANS
       * the fallback — `get` returns it — so writing it back changes nothing a
       * reader could observe. Without this every cold start wrote all fifteen
       * defaults to disk: the app reads its preferences before the first
       * render and writes them back in an effect, so a launch that changed
       * nothing still paid a write, on the one path that is already the
       * slowest.
       *
       * ⚠️ **A COPY, TAKEN AT THE BOUNDARY — AND IT USED TO BE THE CALLER'S OWN
       * OBJECT.** Held by reference, a value mutated after `set` changed what
       * every reader saw with no notification and no write, and setting the
       * same object again compared equal to itself and wrote nothing: the disk
       * kept the old value and memory showed the new one. The copy is exactly
       * what would be written, so memory and disk can no longer disagree about
       * a value's shape either.
       *
       * ⚠️ **AND A VALUE THAT WILL NOT SERIALISE IS REFUSED HERE, NOT HELD.**
       * Held, it sat in the envelope and failed every later write, which read as
       * a refused storage and turned persistence off for the session — one bad
       * value from one capability stopped every preference saving. Refused, it
       * costs that one change, said to the log. `undefined` is refused with it:
       * JSON has no spelling for it, so it could never have reached the disk. */
      let held: unknown
      try {
        const text = JSON.stringify(value)
        if (text === undefined) throw new TypeError('JSON has no spelling for this value')
        held = JSON.parse(text)
      } catch (cause) {
        console.error(`Paper: the setting ${setting.key} was not changed, because its value cannot be saved`, cause)
        return
      }
      /* ⚠️ **AND A VALUE THE SETTING'S OWN PARSER CANNOT READ BACK IS REFUSED
       * WITH THEM.** Surviving `JSON.stringify` is not the same as surviving
       * this setting: `JSON.stringify(NaN)` is the string `null`, so
       * `set(readingRate, NaN)` stored a literal `null` under the key. `has`
       * then answered TRUE, `get` ran `parse(null)`, got `undefined` and
       * returned the FALLBACK — a key present on disk and unreadable through
       * the only door that reads it, for every launch after, with the panel
       * showing the fallback and the file disagreeing.
       *
       * Refused on the same ground as the line above: `set` already declines a
       * value the STORAGE cannot hold, and a value the SETTING cannot hold is
       * the same promise broken one level up. The parse is only a
       * READABILITY test — `held` is what gets stored, not `readable` — so a
       * parser that clamps still clamps on the way out and `set` does not
       * quietly rewrite what the caller asked for. A parser that throws says
       * what one returning `undefined` says, exactly as in `get`. */
      let readable: unknown
      try {
        readable = setting.parse(held)
      } catch {
        /* Left undefined, which the refusal below already answers. */
      }
      if (readable === undefined) {
        console.error(
          `Paper: the setting ${setting.key} was not changed, because its own parser cannot read that value back`,
        )
        return
      }
      const current = setting.key in values ? values[setting.key] : setting.fallback
      if (unchanged(current, held)) return
      values = frozen({ ...values, [setting.key]: held })
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
  /* `includes` DOES NOT COERCE and this list holds nothing but strings, so it
     answers false for every value that is not one. A `typeof` test in front of
     it decided nothing and hid this line's own mutants from the gate. */
  (raw: unknown): T | undefined =>
    (allowed as readonly unknown[]).includes(raw) ? (raw as T) : undefined

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
 * The ends of the rate scale, as the stored value's clamp.
 *
 * DERIVED FROM THE SCALE, never typed out again: the range a reader can store
 * and the range the stepper offers are the same range, and two literals is how
 * they stop being. See `READING_RATE` in `metrics.ts` for the steps themselves.
 *
 * CLAMPED, NOT REJECTED, for `textSize`'s reason one step along: a file written
 * by a build offering a wider range is not corrupt, it is a reader who chose
 * "as fast as it goes" on another build, and the nearest speed this build offers
 * honours that where falling back to 1 would throw it away.
 *
 * A MULTIPLIER RATHER THAN AN INDEX, also for `textSize`'s reason: an index
 * means nothing across a change to the ramp the UI offers, and this one is
 * likely to change — 1 is the engine's default for ever, where `steps[4]` is
 * whatever the fifth entry happens to be that month.
 */
export const READING_RATE_MIN = READING_RATE.steps[0] ?? 1
export const READING_RATE_MAX = READING_RATE.steps[READING_RATE.steps.length - 1] ?? 1

/**
 * The ends of a gap scale, as the stored value's clamp — `READING_RATE_MIN`'s
 * reasoning, one scale along, and derived for the same reason: the range a
 * reader can store and the range the stepper offers must be one range.
 */
export const SENTENCE_GAP_MIN = SENTENCE_GAP.steps[0] ?? 0
export const SENTENCE_GAP_MAX = SENTENCE_GAP.steps[SENTENCE_GAP.steps.length - 1] ?? 0
export const PARAGRAPH_GAP_MIN = PARAGRAPH_GAP.steps[0] ?? 0
export const PARAGRAPH_GAP_MAX = PARAGRAPH_GAP.steps[PARAGRAPH_GAP.steps.length - 1] ?? 0

/**
 * A stored number on a continuous range — a gap in milliseconds, a speaking
 * rate — CLAMPED to it rather than rejected.
 *
 * As every other scale here is: a file written by a build offering a longer
 * pause, or a faster voice, is not corrupt. It is a reader who chose "as far as
 * it goes", and the nearest this build offers honours that where falling back
 * to the default would throw it away. Non-finite is refused, because `Infinity`
 * as a timer duration is a reading that never continues, and as a rate it is a
 * voice that never speaks.
 *
 * ⚠️ **THIS WAS TWO FUNCTIONS WITH ONE BODY.** `withinRange(min, max)` and a separate
 * `rate` differed only in where the bounds came from — the second had
 * `READING_RATE_MIN`/`MAX` written into it instead of taking them — so the
 * clamping rule for the reader's speaking rate could be changed without
 * touching the rule for the pauses around it, and neither would look wrong.
 *
 * `index` below is deliberately NOT folded in with them, though it also clamps:
 * its acceptance test is `Number.isInteger`, not `Number.isFinite`, because it
 * addresses a position on a discrete ramp rather than a quantity. Two clamps
 * that accept different things are two rules, and the comment there says why.
 */
const withinRange =
  (min: number, max: number) =>
  (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : undefined

const rate = withinRange(READING_RATE_MIN, READING_RATE_MAX)

/**
 * The voice the reader chose, per primary language subtag — `{ en: '…', zh: '…' }`.
 *
 * ONE VOICE PER LANGUAGE, not one for the app: a single stored voice is the
 * shape where a reader who picks an English voice they like then opens a Chinese
 * book and hears it read in English. `voiceChoice.ts` holds the matching rule
 * and the argument.
 *
 * A BAD ENTRY COSTS ITSELF, exactly as in `stringList`: a junk value for one
 * language must not take the reader's other choices with it. A non-object is
 * rejected, because that is a value of the wrong shape rather than a map with a
 * bad member.
 *
 * ⚠️ **THE KEYS ARE NOT NORMALISED HERE, DELIBERATELY.** Folding `en-US` to `en`
 * would need `primaryOf`, which lives with the reader — and `core` may not
 * import from `ui`. It is not worth moving: the picker only ever writes a
 * primary subtag, and a hand-written `en-US` key simply never matches, which
 * falls through to the automatic pick. A key that does nothing is a safe
 * outcome; a rule spelled out in two modules is not.
 */
const voiceChoices = (raw: unknown): Readonly<Record<string, string>> | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const kept: Record<string, string> = {}
  for (const [lang, voice] of Object.entries(row)) {
    if (typeof voice === 'string' && voice !== '') kept[lang] = voice
  }
  return kept
}

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
  /* `Number.isInteger` DOES NOT COERCE, so it answers false for a string, a
     boolean and `null` as surely as for 1.5 — a `typeof` test in front of it
     decided nothing and hid this line's own mutants from the gate. The cast is
     what that test used to buy: it holds only under the check beside it. */
  (raw: unknown): number | undefined =>
    Number.isInteger(raw) ? Math.max(0, Math.min(length - 1, raw as number)) : undefined

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
/**
 * The fields of `ReadingStyle` whose value is a `V`.
 *
 * ⚠️ **THE HELPERS BELOW TOOK ANY FIELD AND CAST ITS DEFAULT**, so
 * `pick('fidelity', SEPARATIONS)` type-checked and handed a fidelity value back
 * as a separation's fallback. Keyed by value type, a helper can only be given a
 * field its own default fits, and the list a `pick` validates against has to be
 * that field's list — so the casts, and the mistake they hid, are gone.
 */
type StyleField<V> = { [K in keyof ReadingStyle]: ReadingStyle[K] extends V ? K : never }[keyof ReadingStyle]

const readingStyle = (raw: unknown): ReadingStyle | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const pick = <K extends StyleField<string>>(key: K, from: readonly ReadingStyle[K][]): ReadingStyle[K] =>
    oneOf(from)(row[key]) ?? DEFAULT_READING_STYLE[key]
  const step = (key: StyleField<number>, scale: SteppedScale): number =>
    index(scale.steps.length)(row[key]) ?? DEFAULT_READING_STYLE[key]
  const flag = (key: StyleField<boolean>): boolean => boolean(row[key]) ?? DEFAULT_READING_STYLE[key]
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
  /* Read aloud's two, and the reason they are preferences at all: the reading
     used to take whatever voice the platform handed it, which on macOS is the
     most compressed one installed. See `ui/reader/voiceChoice.ts`. */
  readingVoice: defineSetting<Readonly<Record<string, string>>>('kernel.readingVoice', {}, voiceChoices),
  readingRate: defineSetting<number>('kernel.readingRate', 1, rate),
  /* WHETHER A NOTE'S BODY IS READ. Off, which is the quieter of the two: most
     note bodies are hidden and never reach the voice, and the ones that are not
     are a print-style block at the foot of a section — so on by default means a
     run of citations arriving mid-chapter, unannounced. See `NOTE_BODIES` in
     `ui/reader/speechSkip.ts` for why this is the reader's choice at all. */
  readingNotesAloud: defineSetting<boolean>('kernel.readingNotesAloud', false, boolean),
  /* THE SILENCE BETWEEN UNITS OF PROSE — see `SENTENCE_GAP` in `metrics.ts` for
     why this is expressible at all and why it is not scaled by the rate. */
  sentenceGapMs: defineSetting<number>(
    'kernel.sentenceGapMs',
    SENTENCE_GAP.steps[SENTENCE_GAP.def] ?? 0,
    withinRange(SENTENCE_GAP_MIN, SENTENCE_GAP_MAX),
  ),
  paragraphGapMs: defineSetting<number>(
    'kernel.paragraphGapMs',
    PARAGRAPH_GAP.steps[PARAGRAPH_GAP.def] ?? 0,
    withinRange(PARAGRAPH_GAP_MIN, PARAGRAPH_GAP_MAX),
  ),
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
 * take. `-1` is not a legal index, and the parser refuses every negative before
 * `index()` clamps what is left, so absent, rubbish and a stored negative all
 * land on it and all mean the same thing here: nothing to migrate.
 *
 * ⚠️ **THIS SAID `index()` REJECTS `-1`. IT CLAMPS IT, TO 0** — so a stored
 * `-1` read as the old ramp's first step and migrated to 17px. `index()` clamps
 * both ends because a build with a longer ramp can run off the TOP; nothing
 * runs off the bottom, and a negative here names no step at all. Found by
 * audit.
 */
// Stryker disable next-line StringLiteral: `defineSetting` refuses an unnamespaced key, and it is called HERE, at module scope — so the empty-string mutant throws while this module is being imported, every covering suite fails to LOAD, no test fails, and Stryker's vitest runner reports it Survived with nothing able to kill it (measured 2026-09-14)
const LEGACY_STEP_IDX = defineSetting<number>('kernel.stepIdx', -1, (raw) =>
  /* THE SIGN IS READ OFF WHAT WAS STORED, before `index()` can clamp a negative
     up to 0. Only a number can be negative here, and `index()` refuses
     everything else whichever way this comparison goes — so a `typeof` test in
     front of it decided nothing and hid this line from the gate. */
  Number(raw) < 0 ? undefined : index(LEGACY_READING_SIZES.length)(raw),
)

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
 *
 * ⚠️ **"EXISTS" IS `has`, AND IT USED TO BE "DOES NOT EQUAL THE FALLBACK".**
 * That is a sentinel the value can legitimately take, and it met `set`, which
 * skips a write whose value equals the CURRENT one — with nothing stored, the
 * fallback. So a reader on a legacy file who chose exactly the default size
 * wrote nothing, this read inferred "absent" again, and the legacy index won:
 * their choice was undone on every launch, for ever, and it is the one choice
 * neither half could detect. Two reasonable halves, one unreachable state.
 *
 * A migration hook cannot fix it either — `createSettingsStore` runs `migrate`
 * only when the envelope's VERSION differs, and the ramp changed without a
 * version bump, which is why this read-time migration exists at all.
 */
function readTextSize(store: SettingsStore): number {
  if (store.has(KERNEL_SETTINGS.textSize)) return store.get(KERNEL_SETTINGS.textSize)
  const carried = LEGACY_READING_SIZES[store.get(LEGACY_STEP_IDX)]
  if (carried === undefined) return store.get(KERNEL_SETTINGS.textSize)
  /* ⚠️ **RECORDED, SO "ABSENT" STOPS MEANING "THE LEGACY VALUE".** Reading it
   * correctly is not enough on its own: `set` skips a write whose value equals
   * the current one, and with nothing stored the current one is the FALLBACK —
   * so a reader choosing exactly the default size stored nothing, and the next
   * read came back here and answered with the legacy index instead. Writing it
   * once makes every later read and write ordinary.
   *
   * ⚠️ **AND THIS WRITE IS ITSELF SKIPPED WHEN `carried` IS THE FALLBACK,
   * WHICH IS REACHABLE — SO IT DOES NOT "REMOVE THE ORDERING DEPENDENCY
   * ALTOGETHER", AS THIS COMMENT CLAIMED.** `set` declines a value equal to the
   * current one, and with nothing stored the current one IS the fallback, so
   * the very case the paragraph above describes is the case this `set` cannot
   * record. It is not hypothetical: `LEGACY_READING_SIZES[2]` is 21 and
   * `READING_STEPS[DEFAULT_STEP_IDX].size` is 21, so a reader on legacy step 2
   * takes this path on every launch for ever.
   *
   * It is nevertheless HARMLESS, which is why the write is left as it is rather
   * than given a way around the dedup: in the skipped case `carried` and the
   * fallback are the same number, so "absent" and "the legacy value" answer
   * identically and no reader can observe a difference. What it costs is
   * durability, not correctness — `LEGACY_STEP_IDX` can never be retired for
   * those readers, because something still reads it. Said here rather than
   * fixed with a second write path, because one caller is not a reason to give
   * the store an unconditional `set` that every other caller could reach for.
   *
   * Today the app happens not to lose the choice — `useAppState`'s effect
   * writes every preference on mount, which materialises this before anything
   * can be chosen — so this closes a latent hole rather than a reachable one.
   * That is exactly the kind that returns: the effect's dependency list is
   * hand-maintained, and two settings have already been forgotten from it.
   *
   * `set` never throws and reports a refused write through `persistent`, so a
   * read-only store still answers correctly here; it simply carries the value
   * again next launch. */
  store.set(KERNEL_SETTINGS.textSize, carried)
  return carried
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
    readingVoice: store.get(KERNEL_SETTINGS.readingVoice),
    readingRate: store.get(KERNEL_SETTINGS.readingRate),
    readingNotesAloud: store.get(KERNEL_SETTINGS.readingNotesAloud),
    sentenceGapMs: store.get(KERNEL_SETTINGS.sentenceGapMs),
    paragraphGapMs: store.get(KERNEL_SETTINGS.paragraphGapMs),
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
   * ⚠️ **AND THE ASYMMETRY IS THE POINT, NOT A LEFTOVER** — an audit has since
   * read it the other way and asked for the READER to be derived too. It must
   * not be. The two halves fail differently and only one of them fails safely:
   * omitting a field from `readKernelPreferences` is a COMPILE ERROR, measured
   * rather than assumed by deleting `paragraphGapMs` from it and running the
   * gate — `settings.ts(926,3): error TS2741: Property 'paragraphGapMs' is
   * missing in type … but required in type 'KernelPreferences'`. So the reader
   * is already held to the table by the type system, which is a stronger guard
   * than a loop, and it is what lets `textSize` go through `readTextSize`
   * instead of `store.get` without that exception costing the guarantee.
   * Deriving it would buy symmetry and sell the one thing that makes a
   * hand-written list safe.
   *
   * The cast is the one place the derivation cannot be expressed: `store.set`
   * is generic in the setting's own type, and iterating the table erases the
   * link between key and value that `KernelPreferences` already guarantees.
   */
  for (const name of Object.keys(KERNEL_SETTINGS) as KernelSettingName[]) {
    store.set(KERNEL_SETTINGS[name] as Setting<unknown>, prefs[name])
  }
}
