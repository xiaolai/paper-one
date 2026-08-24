import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createKernelServices,
  loadShelf,
  openFileStore,
  type Diagnostics,
  type FileStore,
  type IndexFs,
  type IndexedBook,
  type KernelServices,
  type ShelfSource,
} from '../../kernel'
import { makeDataDir, nodeIndexFs, nodeSizePort, nodeTextFs } from './fs'

/**
 * A composition root for a NODE process (phase 11, WI-11.2).
 *
 * `src/main.tsx` is the webview's: it opens the store, carries a legacy
 * library across, loads the shelf and calls `createKernelServices` once. This
 * is the same sequence with the webview's two concerns left out — there is no
 * migration to run in a process that never held a `localStorage`, and no
 * frame to keep from rendering empty — over the two `node:fs` seams.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It composes no capabilities. `peer` and
 * `sync` reach the Tauri plugin through `@tauri-apps/api`, which does not
 * exist in a Node process, and the kernel's ports keep their no-op defaults:
 * nothing journals, nothing replicates, and `bindServiceHost` is unbound so
 * `serveServices` serves nothing. That is the honest state of a CLI running
 * beside the app rather than inside it, and it is why `shelf.status` answers
 * `role: null` here instead of guessing.
 *
 * THE DATA DIRECTORY IS THE APP'S. A CLI that read its own copy would be a
 * second library that agrees with the first only by accident; `paper book
 * list` has to list the books the reader can see. `defaultDataDir()` resolves
 * the same path `BaseDirectory.AppData` does for `one.paper.reader` on each
 * platform, and every caller may name another.
 */

/** The bundle identifier the app ships under — the last segment of the data
 *  directory on all three desktop platforms. Written once, here, because a
 *  second spelling of it is a second library. */
export const APP_IDENTIFIER = 'one.paper.reader'

/** The environment variable that moves the data directory, for a harness
 *  driving two instances (`dev-docs/sync.md`). Read only by this host: the app
 *  honours it in `tauri-plugin-peer` and NOT in the kernel, which is the trap
 *  WI-8.6 recorded — so a Node host that read it silently would be agreeing
 *  with only half of the app. It is here so a test can point at a fixture. */
export const DATA_DIR_ENV = 'PAPER_DATA_DIR'

/**
 * Where the app keeps its data on this platform.
 *
 * Mirrors Tauri's `BaseDirectory.AppData`: `$XDG_DATA_HOME` (or
 * `~/.local/share`) on Linux, `~/Library/Application Support` on macOS,
 * `%APPDATA%` on Windows — each with the bundle identifier under it.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const named = env[DATA_DIR_ENV]
  if (named !== undefined && named !== '') return named
  const home = env['HOME'] ?? homedir()
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_IDENTIFIER)
  if (platform === 'win32') {
    const roaming = env['APPDATA']
    return join(roaming !== undefined && roaming !== '' ? roaming : join(home, 'AppData', 'Roaming'), APP_IDENTIFIER)
  }
  const xdg = env['XDG_DATA_HOME']
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.local', 'share'), APP_IDENTIFIER)
}

export interface NodeHostOptions {
  /** The library's data directory. Made if it is not there. */
  readonly dataDir: string
  readonly diagnostics?: Diagnostics
}

export interface NodeHost {
  /** Absolute, and resolved — the one spelling every message uses. */
  readonly dataDir: string
  readonly services: KernelServices
  readonly fs: IndexFs
  /** What the shelf read cost, so a slow `paper book list` can say why. */
  readonly shelf: {
    readonly books: readonly IndexedBook[]
    readonly rescanned: boolean
    readonly why: ShelfSource
  }
  /** Everything in flight written down. The one moment that cannot be
   *  deferred is the process exiting. */
  close(): Promise<void>
}

/**
 * Build `KernelServices` against a real library directory.
 *
 * The order matters and is the app's: the store is read BEFORE the services
 * are built, because the card and settings stores read their storage once,
 * when they are constructed — a store that arrived later would be a store
 * this process never saw.
 *
 * A shelf that will not load is NOT an empty shelf, and this throws rather
 * than answering with `[]`. The app cannot throw there (a reader would lose
 * the application); a CLI can, and must — `paper book list` printing nothing
 * because a read failed is the single most misleading thing it could do.
 */
export async function openNodeServices({ dataDir, diagnostics }: NodeHostOptions): Promise<NodeHost> {
  const root = await makeDataDir(dataDir)
  const fs = nodeIndexFs(root)
  /* No `legacy`: there is no `localStorage` in a Node process to carry
   * across, and passing one would be inventing a migration source. */
  const storage: FileStore = await openFileStore({ fs: nodeTextFs(root), legacy: null })
  const shelf = await loadShelf(fs)
  const services = createKernelServices({
    fs,
    storage,
    initialBooks: shelf.books,
    ...(diagnostics ? { diagnostics } : {}),
  })
  /* The one port a HOST owns rather than a capability: bytes on disk, which
   * no filesystem seam the kernel defines can measure. Bound here so
   * `content.locate` and `shelf.status` answer with real numbers under the
   * CLI, and with `null` in a webview, which is the honest difference. */
  services.bindSizePort(nodeSizePort(root))
  return {
    dataDir: root,
    services,
    fs,
    shelf,
    close: async () => {
      await services.drain()
      await storage.flush()
    },
  }
}
