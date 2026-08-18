/**
 * The two things a book's bytes need, wherever they are kept.
 *
 * This module OWNED the layout once — `books/<bookId>.<ext>` at the top level,
 * with `ownBook` writing there and `vaultPath` naming it. A book is a folder
 * now, so the layout moved to `bookFolder` and what is left here is the part
 * that was never about layout: the filesystem seam, and the closed list of
 * extensions a book may be stored under.
 *
 * The extension list stays HERE rather than moving with the paths, because it
 * is a security property and not a naming convention — see below.
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
/* `BOOKS_DIR` lives in `bookFolder`, which owns the layout. It was declared
 * here too, with no production consumer — two names for one path is one of them
 * waiting to disagree. */

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
  /** Remove a directory and everything in it — for emptying the trash. */
  removeDir: (path: string) => Promise<void>
}

const DIR = { baseDir: BaseDirectory.AppData } as const

export const tauriVaultFs: VaultFs = {
  readFile: (path) => readFile(path, DIR),
  writeFile: (path, bytes) => writeFile(path, bytes, DIR),
  exists: (path) => exists(path, DIR),
  mkdir: (path) => mkdir(path, { ...DIR, recursive: true }),
  remove: (path) => remove(path, DIR),
  rename: (from, to) => rename(from, to, { oldPathBaseDir: DIR.baseDir, newPathBaseDir: DIR.baseDir }),
  removeDir: (path) => remove(path, { ...DIR, recursive: true }),
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
export const KNOWN_EXTENSIONS: readonly string[] = [
  'epub',
  'pdf',
  'mobi',
  'azw3',
  'cbz',
  'fb2',
  'fbz',
]

/**
 * What a stored `content.*` can be called — the known list, plus the fallback.
 *
 * Exported because `bookIndex` has to decide whether a folder HOLDS a book, and
 * it kept its own copy of this list to do it. Adding a format to one and not the
 * other made every book of that format look contentless: the row went disabled,
 * with the bytes sitting right there beside the record.
 */
export const CONTENT_EXTENSIONS: readonly string[] = [...KNOWN_EXTENSIONS, 'bin']

/** The extension to store a book under, from the name it arrived with. */
export function extensionFor(name: string): string {
  const last = name.lastIndexOf('.')
  if (last < 0) return 'bin'
  const ext = name.slice(last + 1).toLowerCase()
  return KNOWN_EXTENSIONS.includes(ext) ? ext : 'bin'
}


/**
 * The filename a stored book must be handed to a parser under.
 *
 * The vault names files by content hash so two copies cannot collide; every
 * parser Paper uses routes on the EXTENSION, and foliate rejects a name with no
 * suffix as an unsupported type. So the name is rebuilt from the record each
 * time a stored book is opened — by the reader, and now by the enrichment pass
 * as well. Two copies of this reconstruction is one of them keeping a different
 * fallback when the rule changes.
 */
export function storedBookName(entry: { title?: string; ext?: string }): string {
  return `${entry.title || 'book'}.${entry.ext || 'epub'}`
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
