/**
 * THE BOOT SURFACE — the kernel's third UI door, and the only one a shell-less
 * caller may open.
 *
 * `src/app/bootApp.ts` runs the launch sequence for every NATIVE build: open
 * the store, carry a legacy library across, finish interrupted removals, read
 * the shelf, build the services, compose the capabilities, arm the shutdown
 * handshake. None of that is desktop-specific and none of it renders anything
 * — so when the mobile shell arrived, the sequence had to be reachable without
 * also reaching the desktop shell.
 *
 * ⚠️ **THE REASON THIS IS NOT JUST `./index.ts`.** That barrel names `App`,
 * and a barrel retains everything it names: importing it to get `loadShelf`
 * loads the entire desktop pane tree, the titlebar and the palette into a
 * bundle that renders none of them. That is the defect `src/kernel/ui/browser.ts`
 * was created for, written down in AGENTS.md, and measured once at 0.5% of
 * function coverage for ten unused surfaces. Mobile would have repeated it.
 *
 * So the boot exports live HERE and `./index.ts` re-exports them, rather than
 * the reverse. One home, two doors: the desktop root keeps its single import
 * and sees no change, and `bootApp.ts` and the mobile root take this narrower
 * one. `.dependency-cruiser.cjs` (`mobile-root-not-desktop-ui-entry`) refuses
 * the shortcut back.
 *
 * EVERYTHING HERE IS TAURI-BOUND OR DEV-ONLY, and deliberately so — this is a
 * NATIVE boot. It is not browser-safe and must never become the browser
 * client's door; that is `./browser.ts`, and it stays separate.
 */

/* The shell's opened-files contract, for the root that listens for it and
   says when it is listening — see `openedFiles.ts`. */
export { OPEN_FILES_EVENT, OPEN_FILES_READY_EVENT } from './openedFiles'
export type { OpenRequests } from './openedFiles'

/* Boot: the store, the filesystem, the shelf, the migration and the sweep. */
export { openAppStorage } from './appStorage'
export { inTauri } from './inTauri'
export { libraryFs } from '../core/bookFiles'
/* HERE RATHER THAN ON THE PUBLIC ENTRY, which is React-free AND, since
 * WI-19.1, browser-safe. `tauriSizePort` is a platform binding, so exporting it
 * from `src/kernel/index.ts` made all 54 of that barrel's modules unbundlable
 * for a browser — one export, and a bespoke lint rule written to route around
 * it. This entry is already Tauri-bound by design and is the root's second
 * door, which is the same reason `libraryFs` sits on the line above. */
export { tauriSizePort } from '../core/bookSizesTauri'
export { loadShelf } from '../core/bookIndex'
export { migrateToFolders, summariseMigration } from '../core/migrateToFolders'
export { installFatalHandlers } from '../core/reportFatal'
/* ONE DRAIN BOUND for both shutdowns — see `closeWindow.ts`. */
export { CLOSE_DRAIN_MS } from './closeWindow'
/* The launch measurements. Dev-only in effect — `moment` and its neighbours
 * send over the HMR socket, which does not exist in a build — but exported
 * here because `bootApp.ts` is where the launch is, and a composition root may
 * import the kernel only through a declared entry. */
export { countingFs, moment, onFirstPaint, reportFs, reportStartup, timed, watchFs } from './devTiming'
