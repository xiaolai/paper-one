/**
 * The vault's filesystem, over Tauri.
 *
 * SPLIT OUT OF `bookVault.ts`, and not for tidiness. That module also holds
 * `extensionFor` and `CONTENT_EXTENSIONS` — pure functions over a filename that
 * `bookFolder` imports, which the reader imports in turn. With the binding
 * beside them, every one of those importers dragged `@tauri-apps/plugin-fs` in
 * behind it, so the whole reader subtree reached a plugin no module on that
 * path ever calls. A browser has no fs plugin, and `assert-bundle` refuses a
 * web bundle that carries one.
 *
 * One value import, and it put the reader out of a browser's reach. The seam
 * and its rules stay in `bookVault.ts`; what is here is the part that can only
 * exist inside the app.
 */

import { invoke } from '@tauri-apps/api/core'
import {
  BaseDirectory,
  SeekMode,
  exists,
  mkdir,
  open as openFile,
  readFile,
  remove,
  rename,
  writeFile,
} from '@tauri-apps/plugin-fs'
import type { VaultFs } from './bookVault'

const DIR = { baseDir: BaseDirectory.AppData } as const

export const tauriVaultFs: VaultFs = {
  readFile: (path) => readFile(path, DIR),
  writeFile: (path, bytes) => writeFile(path, bytes, DIR),
  exists: (path) => exists(path, DIR),
  mkdir: (path) => mkdir(path, { ...DIR, recursive: true }),
  remove: (path) => remove(path, DIR),
  rename: (from, to) => rename(from, to, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir }),
  removeDir: (path) => remove(path, { ...DIR, recursive: true }),
  // A real append, so a journal line costs one write and not a rewrite of
  // the whole file. The fs plugin's writeFile carries the flag.
  appendFile: (path, bytes) => writeFile(path, bytes, { ...DIR, append: true }),
  /* THE WHOLE ATOMIC WRITE, SYNCED, IN ONE ROUND TRIP (phase 20, D3). The fs
   * plugin has no fsync, so the temp-and-rename the vault used to do through
   * it survived a crash and not a power cut: an empty `book.json` after the
   * rename is a book `scanFolder` skips. `write_atomic` is the app's own
   * command (`src-tauri/src/atomic.rs`) — temp in the same directory, write,
   * sync at `level`, rename, directory synced — confined by Rust to the
   * same `AppData` root every other call here resolves against.
   *
   * The bytes travel as the request BODY, the way the fs plugin's own
   * `writeFile` sends them: an index is a megabyte, and a JSON array of
   * numbers is four characters per byte. The path rides in a header,
   * percent-encoded because headers carry ASCII and a folder name may not. */
  writeAtomic: (path, bytes, level) =>
    invoke('write_atomic', bytes, { headers: { path: encodeURIComponent(path), level } }),
  /* The sync journal's barrier: its appends are not atomic writes and must
   * not be, so they are synced after the fact. Used to be the peer plugin's
   * `fs_fsync`, reached by the kernel through a capability's port — a kernel
   * that stops flushing when a capability is removed. */
  fsync: (path, level) => invoke('fsync_in_data_dir', { path, level }),
  /* A REAL SEEK, so serving a book to a browser costs one read per slice
   * rather than one read of the whole book per slice. `fs:allow-open`,
   * `fs:allow-seek`, `fs:allow-read` and `fs:allow-close` are granted in
   * `capabilities/default.json`, scoped to `$APPDATA/**` — the same files
   * `readFile` already reaches, reached a different way.
   *
   * The handle is closed in a `finally`: a leaked one holds a descriptor for
   * the life of the process, and a reader browsing a shelf opens many. */
  readRange: async (path, offset, length) => {
    const handle = await openFile(path, { ...DIR, read: true })
    try {
      await handle.seek(offset, SeekMode.Start)
      const buffer = new Uint8Array(length)
      /* ONE `read` IS NOT A GUARANTEE OF `length` BYTES. It answers what it
       * has; a short answer at the end of a file is normal, and looping is
       * what turns "some bytes" into "the slice asked for". */
      let filled = 0
      for (;;) {
        const got = await handle.read(buffer.subarray(filled))
        if (got === null || got === 0) break
        filled += got
        if (filled >= length) break
      }
      return buffer.subarray(0, filled)
    } finally {
      await handle.close()
    }
  },
}
