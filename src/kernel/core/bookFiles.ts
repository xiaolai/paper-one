import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { tauriVaultFs } from './bookVault'
import type { DirFs } from './importFolder'
import { BaseDirectory, readDir, readFile } from '@tauri-apps/plugin-fs'
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
 *
 * ONE FILE READ AT A TIME — the loop below awaits each read before starting
 * the next, and that is load-bearing rather than incidental (phase 6, WI-A.2):
 * a phone picking a stack of 200 MB PDFs must not have N of them in flight at
 * once. The RESULTS still accumulate, because every caller wants the whole
 * pick; handing out lazily-read handles instead is the mobile-import work
 * (WI-D.4), where the caller changes with it.
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
  /**
   * Read a directory INSIDE the app's own data directory.
   *
   * `baseDir` is the whole of it, and leaving it off was a real bug that no test
   * could see: `readDir('books')` with no base resolves against the process's
   * working directory, so the library scan looked somewhere that does not exist,
   * threw, and `scanBooks` — which skips an unreadable directory on purpose —
   * returned an empty shelf. Ten migrated books, an index written with zero in
   * it, and nothing anywhere saying why.
   *
   * The two readDirs in this app are DIFFERENT OPERATIONS that happened to share
   * a name: this one is app-relative, and the import's is absolute, because the
   * dialog grants a path outside the app. Merging them into one object let the
   * wrong one win silently.
   */
  readDir: async (path: string) => {
    const entries = await readDir(path, { baseDir: BaseDirectory.AppData })
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    }))
  },
  /** Read an ABSOLUTE directory — the folder a reader picked. */
  readDirOutside: async (path: string) => {
    const entries = await readDir(path)
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    }))
  },
  /* Reads from the reader's OWN filesystem rather than the app's, which is why
   * it takes an absolute path and passes no base directory. It only works for a
   * path the dialog granted. */
  readOutside: (path: string) => readFile(path),
}




/**
 * The filesystem the LIBRARY reads and writes: Paper's own data directory.
 *
 * Its `readDir` is app-relative, because everything the shelf lists lives under
 * `$APPDATA/books`. That is the whole distinction from `importFs` below, and it
 * used to be invisible: one object carried both kinds of read, so an import had
 * to override `readDir` with the other one and assert the result into the shape
 * it needed. An `as unknown as` around a filesystem is not a cast, it is a
 * promise that the object has a member nobody put there — and it did not.
 */
export const libraryFs = { ...tauriVaultFs, ...tauriDirOps }

/**
 * The filesystem an IMPORT reads: the reader's own disk, and Paper's to write
 * into.
 *
 * `readDir` walks an absolute path here — the folder they picked — while
 * everything written still goes to the app's data directory. Two different
 * roots in one object, which is exactly why they are named apart: the reader's
 * files are read and never written, and Paper's are written and never walked.
 */
export const importFs: DirFs = {
  ...tauriVaultFs,
  readDir: tauriDirOps.readDirOutside,
  readOutside: tauriDirOps.readOutside,
}
