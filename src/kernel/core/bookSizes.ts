import { BaseDirectory, stat, readDir } from '@tauri-apps/plugin-fs'
import { BOOKS_DIR, folderOf } from './bookFolder'
import { CONTENT_EXTENSIONS } from './bookVault'
import type { SizePort } from './ports'

/**
 * What the app can measure, over the Tauri filesystem plugin — the kernel's
 * `SizePort` (phase 11), on the desktop side (phase 18).
 *
 * ## Why this did not exist until now
 *
 * `SizePort`'s own header says a host that can measure binds this and one that
 * cannot leaves the fields null. **Only the Node host ever bound one**, so
 * `content.locate` answered `size: null` in the shipping app — always, for
 * every book — while its documentation described the field as a real
 * measurement a caller makes decisions on. A field that is documented and
 * permanently null is worse than an absent one: a caller writes the branch
 * that reads it, and the branch never runs.
 *
 * What made it matter was the browser client. pdf.js's range transport has to
 * be told the file's length BEFORE it asks for a byte of it, and `content.read`
 * cannot supply that — a stream knows where it ends only by reaching the end.
 * So `content.locate.size` is the answer, and it had to become true.
 *
 * ## `stat`, not a read
 *
 * Measuring a 200 MB scanned PDF by decoding it would make locating a book
 * cost as much as opening it — and on this host the bytes would cross the IPC
 * bridge to be counted and thrown away. `fs:allow-stat` is granted in the app's
 * Tauri ACL, scoped to `$APPDATA/**`: the same files `readFile` already
 * reaches, asked a cheaper question. (The grant identifier is spelled out
 * rather than the file's path, because the kernel's declarations may not name
 * a `capabilities` directory — `check-kernel-declarations` enforces that, and
 * it is a path-segment match rather than a judgement about which kind of
 * capability was meant.)
 *
 * ## The cost of `libraryBytes`, stated rather than discovered
 *
 * Every call here is an IPC round trip, which a syscall is not. A whole-library
 * walk over the 1 961-book library WI-8.6 measured is one `readDir` per folder
 * plus one `stat` per file — some thousands of round trips, and seconds rather
 * than milliseconds. That is a price an explicit `shelf.status` may pay; it is
 * why nothing calls it on a render path, and why the answer is not cached here
 * (a cached size is a size that is wrong after the next import).
 *
 * It is implemented rather than left null because null means "nobody here can
 * say", and this host CAN say — just slowly. Answering null to avoid the cost
 * would put a lie in the one field whose whole purpose is to be believed.
 */

/**
 * The two questions a size port asks of a filesystem.
 *
 * SEPARATED FROM THE TAURI BINDING for the same reason `readRangeOf` is
 * separated from `tauriVaultFs`: the walk below has real logic in it — an
 * extension preference order and a partial-answer rule — and none of that is
 * testable through a plugin that only exists inside a webview. The binding is
 * two lines; the logic is the rest of this file and has a test.
 */
export interface SizeOps {
  /** Bytes at one path, or null when it is not a file that could be measured. */
  bytesAt(path: string): Promise<number | null>
  /** One directory's entries. Rejects when the directory will not read. */
  readDir(path: string): Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]>
}

/** A `SizePort` over any filesystem that can answer those two. */
export function sizePortOver(ops: SizeOps): SizePort {
  return {
    bytesAt: ops.bytesAt,

    contentBytes: async (bookId) => {
      const folder = folderOf(bookId)
      /* `CONTENT_EXTENSIONS` ORDER, which is what `content.locate` walks to
       * choose the `ext` it reports and what `content.read` walks to choose
       * the file it streams. A folder is not supposed to hold two content
       * files, but it can — and when two sides picked differently, one answer
       * named `azw3` and carried the epub's byte count. Three places now walk
       * one list. */
      for (const ext of CONTENT_EXTENSIONS) {
        const size = await ops.bytesAt(`${folder}/content.${ext}`)
        if (size !== null) return size
      }
      return null
    },

    libraryBytes: async () => {
      let total = 0
      /* A DIRECTORY THAT WOULD NOT READ makes the TOTAL unknown, not smaller.
       * Skipping it quietly reports a number that is confidently wrong, and a
       * reader deciding whether to evict anything would act on it. Null is the
       * only honest answer to a walk that did not finish. */
      let whole = true
      const walk = async (path: string): Promise<void> => {
        let entries: readonly { readonly name: string; readonly isDirectory: boolean }[]
        try {
          entries = await ops.readDir(path)
        } catch {
          whole = false
          return
        }
        for (const entry of entries) {
          const child = `${path}/${entry.name}`
          if (entry.isDirectory) {
            await walk(child)
            continue
          }
          const size = await ops.bytesAt(child)
          if (size === null) whole = false
          else total += size
        }
      }
      await walk(BOOKS_DIR)
      return whole ? total : null
    },
  }
}

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
  readDir: (path) => readDir(path, DIR),
}

export const tauriSizePort: SizePort = sizePortOver(tauriSizeOps)
