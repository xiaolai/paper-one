import { BaseDirectory, stat, readDir } from '@tauri-apps/plugin-fs'
import { sizePortOver, type SizeOps } from './bookSizes'
import type { SizePort } from './ports'

/**
 * `SizePort`, bound to the Tauri filesystem plugin.
 *
 * ## Why this is its own file
 *
 * `bookSizes.ts` said "SEPARATED FROM THE TAURI BINDING" and the binding was
 * eleven lines further down the same module. That is a separation of
 * FUNCTIONS, and the import graph does not resolve functions — it resolves
 * files. So importing `sizePortOver`, a pure walk over two callbacks, pulled
 * `@tauri-apps/plugin-fs` in behind it.
 *
 * The cost was not hypothetical. `src/kernel/index.ts` re-exported
 * `tauriSizePort`, and **that single export was the only thing making the
 * kernel's public entry Tauri-bound** — the entry every capability imports, and
 * the entry the browser client was forbidden from importing for exactly this
 * reason. One line in one file fenced off 54 modules, and the fence had a
 * bespoke dependency-cruiser rule written to route around it.
 *
 * This is the same split, for the same reason, as `vaultFsTauri.ts` out of
 * `bookVault.ts` — where importing `extensionFor`, a pure function over a
 * filename, took the entire reader subtree down with it. That docstring tells
 * the story; this one is the fourth instance, and `scripts/check-browser-safe.mjs`
 * exists so there is not a fifth.
 *
 * ## `stat`, not a read
 *
 * Measuring a 200 MB scanned PDF by decoding it would make locating a book cost
 * as much as opening it, and on this host the bytes would cross the IPC bridge
 * to be counted and thrown away. `fs:allow-stat` is granted in the app's Tauri
 * ACL, scoped to `$APPDATA/**`: the same files `readFile` already reaches,
 * asked a cheaper question. (The grant identifier is spelled out rather than
 * the file's path, because the kernel's declarations may not name a
 * `capabilities` directory — `check-kernel-declarations` enforces that.)
 */

const DIR = { baseDir: BaseDirectory.AppData } as const

/**
 * `stat` over the plugin.
 *
 * NULL, NEVER ZERO, for a file that is not there. "Nobody can say" and "empty"
 * are different answers, and every caller of this port has to be able to tell
 * them apart before deciding whether a book's bytes are here.
 */
const tauriSizeOps: SizeOps = {
  bytesAt: async (path) => {
    try {
      const info = await stat(path, DIR)
      return info.isFile ? info.size : null
    } catch {
      return null
    }
  },
  /**
   * ⚠️ **THE EMPTY PATH IS THE DATA ROOT, AND THE PLUGIN WILL NOT TAKE IT.**
   *
   * `libraryBytes` walks from `''` — the data directory itself — because the
   * port promises the whole library and `books/` is only part of it. The plugin
   * joins its argument onto the base directory, and an empty segment is not a
   * path it resolves; `'.'` is the same directory spelled in a way it accepts.
   *
   * Written as a mapping here rather than as a special case in the walk,
   * because the walk is shared with the Node host — where `''` is exactly what
   * `path.resolve` wants and `'.'` would be the odd spelling.
   */
  readDir: (path) => readDir(path === '' ? '.' : path, DIR),
}

export const tauriSizePort: SizePort = sizePortOver(tauriSizeOps)
