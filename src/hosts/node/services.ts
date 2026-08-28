import { homedir } from 'node:os'
import { posix as posixPath, win32 as win32Path } from 'node:path'
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
  /* AN EMPTY `HOME` IS NO HOME. `?? homedir()` let `HOME=` through as the
   * empty string, and every path below then resolved against the CURRENT
   * DIRECTORY — a library opened wherever the shell happened to be. Same
   * rule the `APPDATA` and `XDG_DATA_HOME` branches already apply. */
  const home = env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : homedir()
  /* THE SEPARATOR BELONGS TO THE PLATFORM ASKED ABOUT, not to the one running.
   * `platform` is a parameter — the tests name all three, and a harness may —
   * but every branch composed with `node:path`'s `join`, which is the HOST's.
   * Asked for `darwin` from Windows this answered
   * `\Users\x\Library\Application Support\one.paper.reader`: the macOS
   * path, spelled in backslashes, which is not a path on either system. Only
   * a Windows machine could see it, and none had run this. */
  const joinFor = platform === 'win32' ? win32Path.join : posixPath.join
  if (platform === 'darwin') return joinFor(home, 'Library', 'Application Support', APP_IDENTIFIER)
  if (platform === 'win32') {
    const roaming = env['APPDATA']
    return joinFor(roaming !== undefined && roaming !== '' ? roaming : joinFor(home, 'AppData', 'Roaming'), APP_IDENTIFIER)
  }
  const xdg = env['XDG_DATA_HOME']
  return joinFor(xdg !== undefined && xdg !== '' ? xdg : joinFor(home, '.local', 'share'), APP_IDENTIFIER)
}

export interface NodeHostOptions {
  /** The library's data directory. Made if it is not there. */
  readonly dataDir: string
  readonly diagnostics?: Diagnostics
  /**
   * Whether this host may WRITE the shelf cache it loads. Default true.
   *
   * A read-only command holds no lock — reads never do — but `loadShelf`
   * rescans a stale index and, until WI-20.34, wrote the result back through
   * the same `index.json.writing` temp the app uses. So `paper book list`
   * beside a running app was a writer after all, racing the app's own index
   * write for one filename. `false` rescans in memory and writes nothing.
   */
  readonly persist?: boolean
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
export async function openNodeServices({ dataDir, diagnostics, persist = true }: NodeHostOptions): Promise<NodeHost> {
  const root = await makeDataDir(dataDir)
  const fs = nodeIndexFs(root)
  /* No `legacy`: there is no `localStorage` in a Node process to carry
   * across, and passing one would be inventing a migration source. */
  const storage: FileStore = await openFileStore({ fs: nodeTextFs(root), legacy: null })
  const shelf = await loadShelf(fs, { persist })
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
      /* THE STORE IS FLUSHED WHATEVER THE DRAIN DID. `drain()` flushes it
       * itself on the way through, so on the ordinary path this second call
       * is an idempotent repeat — kept deliberately as the belt for a drain
       * that rejected BEFORE reaching it (a stuck index write, a queue that
       * would not go idle), which used to leave the store's writes behind
       * on exit. */
      try {
        await services.drain()
      } finally {
        await storage.flush()
      }
    },
  }
}
