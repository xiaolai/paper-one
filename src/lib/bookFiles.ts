import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
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
