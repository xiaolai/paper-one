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
  SeekMode,
  exists,
  mkdir,
  open as openFile,
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
  /**
   * Byte-append — the sync journal's primitive (WI-C). OPTIONAL: a
   * filesystem without it makes the journal fall back to read-then-rewrite,
   * which is correct and O(n) per append, a price only tests should pay.
   */
  appendFile?: (path: string, bytes: Uint8Array) => Promise<void>
  /**
   * A slice of a file, without reading the rest (phase 18).
   *
   * OPTIONAL, on the same terms as `appendFile`: a filesystem without it falls
   * back to `readFile` and a slice, which is correct and **O(n) per slice**.
   * That price is not one only tests should pay here — `content.read` serves a
   * book to a browser a slice at a time, so the fallback is O(n²) over the
   * book, and a 300 MB scanned PDF would be re-read once per megabyte served.
   *
   * So: implement it wherever a book's bytes are actually served. The fallback
   * exists so a fake filesystem in a test need not, and `readRangeOf` below is
   * the one place that decides which is in use.
   *
   * Answers FEWER bytes than asked at the end of the file, and an empty array
   * past it — the same contract a POSIX read has, and the one a caller
   * assembling a stream already has to handle.
   */
  readRange?: (path: string, offset: number, length: number) => Promise<Uint8Array>
}

/**
 * A slice of a file, however this filesystem can manage it.
 *
 * ONE PLACE DECIDES. A caller reaching for `fs.readRange ?? readFile-and-slice`
 * itself is a caller that will get the fallback's bounds subtly wrong — a
 * negative offset, a length past the end — in a way that only shows on the
 * last chunk of a large book.
 */
export async function readRangeOf(
  fs: VaultFs,
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (offset < 0 || length < 0) throw new Error(`readRange: offset and length must not be negative (${offset}, ${length})`)
  if (length === 0) return new Uint8Array(0)
  if (fs.readRange) return await fs.readRange(path, offset, length)
  const whole = await fs.readFile(path)
  /* `subarray` would share the buffer with the whole file, keeping every byte
   * of a 300 MB book alive for as long as the caller holds one chunk. */
  return whole.slice(offset, offset + length)
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
  // A real append, so a journal line costs one write and not a rewrite of
  // the whole file. The fs plugin's writeFile carries the flag.
  appendFile: (path, bytes) => writeFile(path, bytes, { ...DIR, append: true }),
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
export const KNOWN_EXTENSIONS = ['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'fb2', 'fbz'] as const

/** One of the formats above, as a type. */
export type KnownExtension = (typeof KNOWN_EXTENSIONS)[number]

/**
 * What a stored `content.*` can be called — the known list, plus the fallback.
 *
 * Exported because `bookIndex` has to decide whether a folder HOLDS a book, and
 * it kept its own copy of this list to do it. Adding a format to one and not the
 * other made every book of that format look contentless: the row went disabled,
 * with the bytes sitting right there beside the record.
 */
export const CONTENT_EXTENSIONS = [...KNOWN_EXTENSIONS, 'bin'] as const

/**
 * What a stored content file's extension may be, as a TYPE.
 *
 * `readonly string[]` made the list a runtime fact and nothing more, so
 * `ContentBlobName` could only be spelled ``content.${string}`` — a "closed
 * set" that accepts `content.exe`, and `content.../book.json` besides. Derived
 * from the literal tuple, the compiler enforces at the call sites what the
 * runtime check enforces at the boundary, and a format added above becomes
 * legal everywhere at once rather than after somebody remembers each copy.
 */
export type ContentExtension = (typeof CONTENT_EXTENSIONS)[number]

/** Whether `value` is a format the vault stores under its own name. */
export function isKnownExtension(value: string): value is KnownExtension {
  return (KNOWN_EXTENSIONS as readonly string[]).includes(value)
}

/** Whether `value` is a name a stored content file may carry. */
export function isContentExtension(value: string): value is ContentExtension {
  return (CONTENT_EXTENSIONS as readonly string[]).includes(value)
}

/** The extension to store a book under, from the name it arrived with. */
export function extensionFor(name: string): ContentExtension {
  const last = name.lastIndexOf('.')
  if (last < 0) return 'bin'
  const ext = name.slice(last + 1).toLowerCase()
  return isKnownExtension(ext) ? ext : 'bin'
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
