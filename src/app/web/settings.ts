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

/** The reader's preferences, over this browser's own storage. */
export function browserSettings(): SettingsStore {
  return createSettingsStore({ storage: browserStorage() })
}
