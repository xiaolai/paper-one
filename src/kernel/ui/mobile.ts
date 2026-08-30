/**
 * The kernel's UI entry FOR A PHONE — the React surfaces the native mobile
 * shell mounts.
 *
 * ## Why a fourth door
 *
 * `src/kernel/index.ts` is React-free, because a capability's declarations
 * compile against it. `src/kernel/ui/index.ts` is the DESKTOP shell's door and
 * names `App`, which brings the pane tree, the titlebar and the palette with
 * it. `src/kernel/ui/browser.ts` is the browser client's, and grows for the
 * browser client's needs. `src/kernel/ui/boot.ts` is the launch surface, with
 * no component in it at all.
 *
 * The mobile shell needs the middle of those: React surfaces and the platform,
 * without the desktop chrome it does not draw. `native-root-not-browser-ui-entry`
 * already refuses it the browser's door, and correctly — that entry lists what
 * a BROWSER mounts, and the two shells do not mount the same set.
 *
 * ## ⚠️ THIS DOOR GROWS ONE EXPORT AT A TIME, WITH ITS WIRING
 *
 * The same rule `browser.ts` states at length, for the same measured reason: a
 * re-export is evaluated when the barrel is, so a surface listed here and
 * mounted nowhere is loaded anyway. Ten of them cost 0.5% of function coverage
 * once and failed `pnpm verify`. **Add an export in the change that mounts it.**
 *
 * ## What is deliberately NOT here
 *
 * No stylesheets. `ui/index.ts` imports the design system as a side effect so a
 * desktop root's reader "arrives dressed"; this entry does not, because
 * `main.mobile.tsx` imports them itself and a side-effect import here would
 * make the order of two stylesheet systems depend on which module was reached
 * first. Same reasoning as `browser.ts`.
 */

/* THE SHELF. The same screen the desktop and the browser client draw — a phone
 * gets the mobile design's Library by giving this one a phone's width, not by
 * a second implementation of a list of books. */
export { Library } from './screens/Library'

/* THE DECK. Its `cards` prop is already narrowed to the three members it
 * reads, so the mobile shell hands it a slice of the same store. */
export { Cards } from './pane/Cards'

/* THE READER'S PREFERENCES, and the two probes it cannot draw without: a pane
 * cannot offer a typeface without knowing which the device actually has. */
export { Settings } from './pane/Settings'
export { offeredFaces } from '../core/typefaces'
export { presentFaces } from './fontProbe'

/* THE STORES BEHIND THEM, as hooks over the services the launch built. */
export { useLibrary } from './hooks/useLibrary'
export { useCards } from './hooks/useCards'

/* THE APP'S OWN COLOURS, and the OS's preference behind them. Without the
 * second, a reader who leaves the theme following the system gets a dark book
 * inside light chrome — the setting half-applied. */
export { useAppPalette } from './hooks/useAppPalette'
export { usePrefersDark } from './platform'

/* WHICH DEVICE THIS IS. `Library` takes a `Platform`, and on a phone the
 * answer decides whether a titlebar band is reserved for a window that does
 * not exist — see `platform.ts`, where reporting an iPhone as macOS drew
 * traffic lights on one. */
export { resolvePlatform } from './platform'

/* A BOOK'S JACKET, out of the vault this device actually has. The browser
 * client fetches covers over its channel; a native shell reads them off disk,
 * which is what `tauriVaultFs` is. */
export { coverIn } from '../core/coverArt'
export { tauriVaultFs } from '../core/vaultFsTauri'
export type { CoverSource } from '../core/coverArt'

