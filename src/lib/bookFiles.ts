import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { tauriVaultFs } from './bookVault'
import { readDir, readFile, watch } from '@tauri-apps/plugin-fs'
import { ACCEPT_FORMATS } from './formats'

/**
 * Books as things on disk, rather than as bytes granted for one session.
 *
 * A browser `File` is a handle the page was given when the reader picked it. It
 * cannot be re-derived, so a book opened that way could never be opened again —
 * the shelf filled with rows that said so honestly, and the reading position
 * saved for each of them had nowhere to be spent.
 *
 * A path can be kept. Everything downstream still receives a `File`, because
 * that is what foliate and `bookIdFor` already take and there is no reason for
 * either to learn about the filesystem; the path travels beside the book rather
 * than through it.
 *
 * THE PATH IS DEVICE-LOCAL. It is a fact about this machine, not about the
 * book, and later phases replicate library rows between devices. It must never
 * end up inside anything that syncs.
 */

/** A book picked from disk: the bytes to open, and where they came from. */
export interface PickedBook {
  readonly file: File
  readonly path: string
}

/** The last segment of a path, for a `File` that wants a name. */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** The dialog's filter, derived from the formats the app actually accepts. */
function extensions(): string[] {
  return ACCEPT_FORMATS.split(',')
    .map((entry) => entry.trim().replace(/^\./, ''))
    .filter(Boolean)
}

/**
 * Read a book off disk.
 *
 * Whole-file, as the picker already was: `bookIdFor` hashes the content and
 * foliate parses it, so there is no streaming path to preserve here.
 */
export async function readBookAt(path: string): Promise<File> {
  const bytes = await readFile(path)
  return new File([bytes], basename(path))
}

/**
 * Ask for books, and return what was chosen with the paths kept.
 *
 * Empty when the reader cancelled — which is not an error and must not be
 * reported as one.
 */
export async function pickBooks(): Promise<PickedBook[]> {
  const chosen = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: 'Books', extensions: extensions() }],
  })
  if (!chosen) return []

  const paths = Array.isArray(chosen) ? chosen : [chosen]
  const books: PickedBook[] = []
  for (const path of paths) {
    // One unreadable file does not cost the reader the others they picked.
    try {
      books.push({ file: await readBookAt(path), path })
    } catch (cause) {
      console.error('Paper: could not read', path, cause)
    }
  }
  return books
}


/**
 * Ask for a FOLDER, and the pieces needed to walk it.
 *
 * Returns null when the reader cancelled, which is not an error.
 *
 * The dialog is what grants access to the chosen folder — the app's own
 * capability is scoped to `$APPDATA` and nothing else, so this is the only way a
 * path outside it becomes readable at all. That grant is why the walk and the
 * per-file read both go through the seam this returns rather than importing the
 * plugin wherever they happen to run.
 */
export async function pickFolder(): Promise<string | null> {
  /* `recursive` is what extends the grant to DESCENDANTS. Without it Tauri
   * permits the chosen directory and nothing under it, so `collectBooks` walks
   * into a subfolder, `readDir` is denied, and the error is swallowed by the
   * skip-an-unreadable-branch rule — a folder import silently finding only the
   * books at the top level, with nothing anywhere saying why. */
  const chosen = await openDialog({ directory: true, multiple: false, recursive: true })
  return typeof chosen === 'string' ? chosen : null
}

/** The directory half of a vault filesystem — see `importFolder`. */
export const tauriDirOps = {
  readDir: async (path: string) => {
    const entries = await readDir(path)
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    }))
  },
  /* Reads from the reader's OWN filesystem rather than the vault, which is why
   * it takes an absolute path and passes no base directory. It only works for a
   * path the dialog granted. */
  readOutside: (path: string) => readFile(path),
}


/**
 * Tauri's folder watcher, narrowed to what `watchFolder` needs.
 *
 * `watch` needs the `watch` CARGO FEATURE as well as the `fs:allow-watch`
 * permission. Without the feature the plugin still builds, this import still
 * resolves, and the call fails at runtime — which is the exact failure shape
 * this project keeps meeting, where every check is green and the app is not.
 * Both are set; see `Cargo.toml` and the capability file.
 */
export const tauriWatchOps = {
  watch: async (path: string, onEvent: () => void, options: { recursive: boolean }) => {
    const unwatch = await watch(path, () => onEvent(), {
      recursive: options.recursive,
      /* Tauri debounces too, and this is NOT the settle window — it only stops
       * the bridge relaying every filesystem tick. The window that decides when
       * a copy has finished lives in `watchFolder`, where it can be reasoned
       * about and tested. */
      delayMs: 300,
    })
    return () => void unwatch()
  },
}


/**
 * The filesystem a library needs: bytes, directories, and the reader's own
 * files when a folder has been picked.
 *
 * One object rather than two spread together at each call site, because the
 * pieces are always used together and spreading them was already producing
 * `{ ...tauriVaultFs, ...tauriDirOps }` in three places.
 */
export const libraryFs = { ...tauriVaultFs, ...tauriDirOps }
