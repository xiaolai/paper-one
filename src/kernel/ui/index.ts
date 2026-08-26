/**
 * The kernel's UI entry — for COMPOSITION ROOTS ONLY.
 *
 * `src/main.tsx` and `src/app/composition.*.ts` are the only modules outside
 * the kernel allowed to import this file (`.dependency-cruiser.cjs`, rule
 * `composition-root-kernel-entries`); a capability may import
 * `src/kernel/index.ts` and nothing else of the kernel. The split exists
 * because that entry must stay React-free — it is what a capability's
 * declarations are compiled against — and a composition root has to render
 * the reader, which is React.
 *
 * What is here is what a root needs to boot and draw the kernel: `App`, the
 * boot-time storage and shelf helpers `main.tsx` calls before the first
 * render, and the stylesheet — imported as a side effect, so the reader
 * arrives dressed. The fonts stay with `main.tsx`; they are packages, not
 * kernel files.
 */

import './styles/tokens.css'
import './styles/global.css'
/* The vocabulary contributed UI draws with — global class names, handed across
 * the boundary as strings by `core/capabilityUi`. */
import './styles/capability.css'

export { App } from './App'
export type { AppProps } from './App'

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
export type { IndexedBook } from '../core/bookIndex'
export { emptyExpired } from '../core/bookTrash'
export { migrateToFolders, summariseMigration } from '../core/migrateToFolders'
export { installFatalHandlers } from '../core/reportFatal'
/* ONE DRAIN BOUND for both shutdowns — see `closeWindow.ts`. */
export { CLOSE_DRAIN_MS } from './closeWindow'
/* WHETHER THIS PLATFORM HAS A DICTIONARY, answered at the composition root
   and handed to `createKernelServices`. Both live behind this entry, which is
   exactly why a capability cannot ask them and had to be told. */
export { hasDictionary } from './lookUp'
export { resolvePlatform } from './platform'
/* The launch measurements. Dev-only in effect — `moment` and its neighbours
 * send over the HMR socket, which does not exist in a build — but exported
 * here because `src/main.tsx` is where the launch is, and a composition root
 * may import the kernel only through this entry. */
export { countingFs, moment, onFirstPaint, reportFs, reportStartup, timed, watchFs } from './devTiming'
