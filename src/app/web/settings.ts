import { KERNEL_SETTINGS, createSettingsStore, type MarkStorage, type SettingsStore } from '../../kernel'

/**
 * The reader's preferences, kept in this browser (phase 19, WI-19.9).
 *
 * ## Why the kernel's own store, and not another one
 *
 * `createSettingsStore` takes a `storage` with `getItem`/`setItem` — which is
 * exactly `localStorage`'s shape — and `core/settings.ts` is browser-safe. So
 * this client gets the real store: the real keys, the real validators, the real
 * migration, and a reader who mistypes nothing because nothing here re-declares
 * what a theme or a typeface may be. A second settings store would have been a
 * second definition of the same fifteen values, and the first divergence would
 * have been silent.
 *
 * ## Why BROWSER-LOCAL and not on the shelf
 *
 * The desktop's settings live inside `appStorage`'s file store with no service
 * in front of them. Sharing them across devices means inventing a `setting.*`
 * wire contract for fifteen UI values plus a rule for what happens when two
 * devices disagree — guessed before anyone has used the feature on two devices.
 *
 * The cost is stated rather than hidden: **set the typeface on your phone and
 * your desktop does not follow.** Reading positions already work this way
 * (`positions.ts`), so the behaviour is at least consistent. If preferences
 * should follow the reader, the answer is a service pair, not a bigger
 * `localStorage`.
 *
 * ## Storage can throw, and that is not exceptional
 *
 * `localStorage` is a GETTER that throws outright in some configurations —
 * private windows, disabled storage, an embedded webview with cookies off. The
 * store already treats a read that throws as an empty store; this treats an
 * absent one the same way, so a reader in a locked-down browser gets defaults
 * and a working app rather than a blank screen.
 */

/** The settings this client actually applies. The rest of `KERNEL_SETTINGS`
 *  governs surfaces a browser does not draw — a ruler, a side pane, a scroll
 *  port it owns — and is left at its defaults rather than offered. */
export const WEB_SETTINGS = {
  theme: KERNEL_SETTINGS.theme,
  themeFollowsOs: KERNEL_SETTINGS.themeFollowsOs,
  typeface: KERNEL_SETTINGS.typeface,
  textSize: KERNEL_SETTINGS.textSize,
  spacing: KERNEL_SETTINGS.spacing,
  align: KERNEL_SETTINGS.align,
  readingStyle: KERNEL_SETTINGS.readingStyle,
} as const

/**
 * `localStorage`, or nothing.
 *
 * Reached through a try, because the PROPERTY ACCESS is what throws — not the
 * call. `typeof localStorage` alone is not enough.
 */
export function browserStorage(): MarkStorage | null {
  try {
    /* `null`, NOT `undefined`: the store reads null as "no storage at all" and
     * gives a session-only store, which is exactly the right answer for a
     * browser that refuses one. */
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * The reader's preferences, over this browser's own storage.
 *
 * ## One store per storage, and there used to be one per screen
 *
 * ⚠️ **`ShelfList` AND `Reader` EACH BUILT THEIR OWN**, and a settings store
 * holds the WHOLE envelope in memory and writes all of it back on every change.
 * So the two diverged the moment either wrote: the reader stays mounted while
 * its tab is hidden, so changing the theme in **You** left the reader's copy
 * holding the values it had read at mount — and the reader's next write, a page
 * turn's worth of nothing or a typeface change, persisted that stale envelope
 * over the new one. A preference changed on one screen was invisible on the
 * other and then quietly undone.
 *
 * There is one browser and one `localStorage`, so there is one store. Memoised
 * on the STORAGE's identity rather than as a bare module singleton, because a
 * test that stubs a fresh `localStorage` is asking about a fresh store — a
 * singleton would hand it the previous test's values, which is the same defect
 * wearing a different hat.
 */
const stores = new WeakMap<MarkStorage, SettingsStore>()
/** The session-only store, for a browser that refuses storage entirely.
 *  `null` has no identity to key a `WeakMap` on, and two of these would
 *  diverge exactly as the two real ones did. */
let sessionOnly: SettingsStore | null = null

export function browserSettings(): SettingsStore {
  const storage = browserStorage()
  if (storage === null) {
    sessionOnly ??= createSettingsStore({ storage: null })
    return sessionOnly
  }
  const held = stores.get(storage)
  if (held) return held
  const made = createSettingsStore({ storage })
  stores.set(storage, made)
  return made
}
