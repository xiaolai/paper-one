/**
 * Paper's own copy of a book.
 *
 * A reader picks a file from somewhere on their disk; Paper copies the bytes
 * into `$APPDATA/books/` and opens that copy from then on. The original is never
 * moved, never written to, and never deleted.
 *
 * WHY OWN THEM AT ALL, given the shelf already keeps a path. Because a path is
 * a promise about someone else's filesystem and Paper cannot keep it. The file
 * gets renamed, moved to an external drive, or lives in a folder the app was
 * granted access to once and has to be granted again — and the failure is
 * always the same: a row on the shelf that will not open, with the reading
 * position and the marks still sitting behind it.
 *
 * IT ALSO RETIRES A DEPENDENCY. Reopening after a relaunch used to rest
 * entirely on `tauri-plugin-persisted-scope` restoring the scope the file dialog
 * granted — inherited, never exercised here, and flagged in phase 2 as the one
 * place already wrong once. `$APPDATA` is in scope permanently and by
 * definition, so reopening stops depending on anything being restored.
 *
 * And it is the precondition for everything later: a phone cannot read a Mac
 * path, so sharing a book between devices needs the bytes somewhere the app
 * owns. Deciding it now rather than after import exists is the cheap order.
 *
 * The cost is disk. A library is stored twice, and that was accepted knowingly
 * rather than discovered — `bytesHeld` exists so the app can say how much.
 */

import {
  BaseDirectory,
  exists,
  mkdir,
  readFile,
  remove,
  rename,
  writeFile,
} from '@tauri-apps/plugin-fs'

/** Where copies live, under the app's own data directory. */
export const BOOKS_DIR = 'books'

/**
 * The filesystem operations a vault needs, so tests need no Tauri.
 *
 * Same seam as `fileStore`'s `FileSystem`, and separate from it on purpose:
 * that one moves TEXT — a JSON store read whole and rewritten — and this one
 * moves bytes. Phase 2 shipped a capability granting the binary permissions
 * while the store called the text APIs, and every read and write would have
 * been denied with `cargo check`, `tsc`, the tests and the build all green.
 * Keeping the two seams distinct is what makes the permission each one needs
 * legible.
 */
export interface VaultFs {
  readFile: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string) => Promise<void>
  remove: (path: string) => Promise<void>
  /** The step that makes a write atomic — see `ownBook`. */
  rename: (from: string, to: string) => Promise<void>
}

const DIR = { baseDir: BaseDirectory.AppData } as const

export const tauriVaultFs: VaultFs = {
  readFile: (path) => readFile(path, DIR),
  writeFile: (path, bytes) => writeFile(path, bytes, DIR),
  exists: (path) => exists(path, DIR),
  mkdir: (path) => mkdir(path, { ...DIR, recursive: true }),
  remove: (path) => remove(path, DIR),
  rename: (from, to) => rename(from, to, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir }),
}

/**
 * Extensions a copy may be given.
 *
 * A CLOSED LIST, and that is the point rather than tidiness. The extension is
 * taken from a filename the reader did not write — a book downloaded from
 * anywhere — and it is interpolated into a path. `name.split('.').pop()` on
 * `book.../../../../etc/passwd` yields a segment that walks out of the vault,
 * and `$APPDATA/**` would happily allow the write on the way past.
 *
 * So nothing is sanitised or escaped. An extension is either one of these or
 * the copy is named `.bin`, which is inert and still opens, because foliate and
 * the PDF adapter are handed the original filename separately and route on
 * that.
 */
const KNOWN_EXTENSIONS: readonly string[] = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
  'cbz',
  'fb2',
  'fbz',
]

/** The extension to store a book under, from the name it arrived with. */
export function extensionFor(name: string): string {
  const last = name.lastIndexOf('.')
  if (last < 0) return 'bin'
  const ext = name.slice(last + 1).toLowerCase()
  return KNOWN_EXTENSIONS.includes(ext) ? ext : 'bin'
}

/**
 * Where a book's copy lives, relative to the app data directory.
 *
 * Named by `bookId`, which is a content hash and therefore both safe to
 * interpolate and exactly the right key: the same bytes are the same book, so
 * two routes to one file cannot produce two copies.
 */
export function vaultPath(bookId: string, name: string): string {
  return `${BOOKS_DIR}/${safeId(bookId)}.${extensionFor(name)}`
}

/**
 * A `bookId` reduced to characters that cannot leave the directory.
 *
 * `bookIdFor` produces `book:` followed by hex, so in practice this changes
 * nothing. It is here because "in practice" is not a guarantee: the id also
 * comes back off a stored row that a reader could have edited, and a path
 * segment built from it must not be able to contain a slash or a dot-dot
 * whatever it says.
 */
function safeId(bookId: string): string {
  return bookId.replace(/[^a-zA-Z0-9]/g, '_')
}

export interface VaultEntry {
  /** Path relative to the app data directory — what a library row stores. */
  readonly path: string
  readonly bytes: number
  /** False when the book was ALREADY held, which is how a duplicate is known. */
  readonly created: boolean
}

/**
 * Copy a book in, unless an identical one is already held.
 *
 * Idempotent by construction: the destination is derived from the content hash,
 * so re-adding a book Paper already owns writes nothing and returns the copy
 * that exists. That is where duplicate refusal actually lives — bulk import only
 * surfaces it.
 */
export async function ownBook(
  fs: VaultFs,
  bookId: string,
  name: string,
  bytes: Uint8Array,
): Promise<VaultEntry> {
  const path = vaultPath(bookId, name)
  // `created` distinguishes "we wrote it" from "it was already here", which the
  // caller needs and could not previously get: the byte count is the input's
  // length either way, so a book already held reported as newly added.
  if (await fs.exists(path)) return { path, bytes: bytes.length, created: false }
  await fs.mkdir(BOOKS_DIR)
  /* Written to a temporary neighbour and then moved into place, for the reason
   * `appStorage` does the same with the store: a write interrupted halfway —
   * the disk filling, the app quitting — otherwise leaves a TRUNCATED file at
   * the exact path `exists` is asked about later. That file would then be
   * treated as the book forever, and it would fail to parse with no clue why.
   *
   * The rename is what provides that property, and the first version of this
   * comment claimed it without one. */
  const writing = `${path}.writing`
  try {
    await fs.writeFile(writing, bytes)
    // THE RENAME IS THE WHOLE POINT, and the first version of this did not have
    // one — it wrote the temporary file and then wrote the bytes AGAIN to the
    // real path, which is not atomic in any sense and left exactly the truncated
    // file the temporary was supposed to prevent. It also cost twice the book's
    // free space. A rename within one directory is atomic on every filesystem
    // Paper runs on, so the real path either does not exist or is complete.
    await fs.rename(writing, path)
  } catch (cause) {
    // Best effort: a leftover `.writing` file is waste rather than corruption,
    // and it is never mistaken for the book because nothing looks for that name.
    await fs.remove(writing).catch(() => {})
    throw cause
  }
  return { path, bytes: bytes.length, created: true }
}

/** Read a book Paper owns back as a `File`, ready for the reader. */
export async function readOwnedBook(
  fs: VaultFs,
  path: string,
  name: string,
): Promise<File> {
  const bytes = await fs.readFile(path)
  /* The ORIGINAL name, not the vault's. The vault names files by hash so two
   * copies cannot collide; the reader routes on the filename's extension and
   * shows it when a book declares no title, and neither wants a hash. */
  return new File([bytes as BlobPart], name)
}

/** Whether Paper holds its own copy of this book. */
export function ownsBook(fs: VaultFs, path: string): Promise<boolean> {
  return fs.exists(path)
}

/**
 * Give up Paper's copy. The reader's own file is not touched — see the header.
 *
 * Resolves even when there was nothing to remove: forgetting a book twice, or
 * forgetting one whose copy never landed, is not a failure worth surfacing to
 * someone who asked for it to be gone.
 */
export async function disownBook(fs: VaultFs, path: string): Promise<void> {
  await fs.remove(path).catch(() => {})
}
