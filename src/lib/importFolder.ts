/**
 * Add a folder of books, rather than one book at a time.
 *
 * The first thing a reader with a real collection needs, and deliberately the
 * last thing built: it needs identity, ownership, covers and reporting to exist
 * first, or it produces a mess that removing books one at a time cannot clean up.
 *
 * ON THE MAIN THREAD, AND THAT IS NOT THE OVERSIGHT IT LOOKS LIKE. The plan said
 * to hash off the main thread, on the reasoning that 300 books hashed inline
 * freezes the window. Half of that is already true for free: `crypto.subtle.digest`
 * is a native async API and does its work off-thread, so the hash of a 40MB book
 * never blocks a frame. What WOULD block is the loop around it — reading every
 * file back to back with no gap for React to paint. So the loop yields between
 * books instead, which buys the same responsiveness without a Worker, without a
 * second copy of the identity code, and without moving `File` objects across a
 * thread boundary that cannot carry them cheaply.
 *
 * A Worker becomes the right answer if the hash ever stops being native — or if
 * a book arrives that is large enough for the READ to be the cost rather than
 * the digest. Neither is true today, and building for it now would be building
 * on a guess.
 */

import type { VaultFs } from './bookVault'
import { atomicWrite, contentPathIn } from './bookFolder'
import { bookIdFor } from './marks'

/** Extensions worth reading. The same closed list the vault stores under. */
const IMPORTABLE = /\.(epub|pdf|mobi|azw3|cbz|fb2|fbz)$/i

/**
 * How deep to walk.
 *
 * A bound rather than a preference: a symlinked folder can point at its own
 * parent, and a recursive read with no depth limit walks that forever. Tauri's
 * `readDir` does not resolve links for us, so this is the only thing standing
 * between "import my books folder" and a hang with no error.
 */
const MAX_DEPTH = 8

/** A ceiling on one import, so a mis-picked home directory does not run for an hour. */
const MAX_FILES = 5000

export interface DirFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  /** Reads a book from ANYWHERE — the reader's own filesystem, not the vault. */
  readOutside: (path: string) => Promise<Uint8Array>
}

/** One book's fate. Named individually, because a count is not a report. */
export interface ImportOutcome {
  readonly path: string
  readonly status: 'added' | 'duplicate' | 'failed'
  /** Why it failed, in the reader's terms. Absent unless it did. */
  readonly reason?: string
  readonly bookId?: string
  readonly name?: string
}

export interface ImportProgress {
  readonly done: number
  readonly total: number
  readonly current: string
}

/**
 * Every importable file under a folder, depth-first.
 *
 * Failures to read a subdirectory are SKIPPED rather than fatal. A permission
 * error three levels down should cost that branch, not the whole import — and a
 * reader who pointed at a folder containing one unreadable subfolder would
 * otherwise get nothing with no explanation.
 */
export async function collectBooks(
  fs: DirFs,
  root: string,
  depth = 0,
  found: string[] = [],
): Promise<string[]> {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return found
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await fs.readDir(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (found.length >= MAX_FILES) break
    const path = `${root}/${entry.name}`
    if (entry.isDirectory) {
      // Dot-directories are skipped: `.git`, `.Trash` and their like contain
      // nothing a reader means by "my books" and can be enormous.
      if (entry.name.startsWith('.')) continue
      await collectBooks(fs, path, depth + 1, found)
    } else if (IMPORTABLE.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

/** Hand the main thread back, so React can paint between books. */
const yieldToPaint = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * Copy every book under a folder into the vault.
 *
 * Duplicate refusal is not implemented here and does not need to be: `ownBook`
 * derives its destination from the content hash, so a book already held has
 * nowhere else to go. This only has to NOTICE, so it can say so.
 */
export async function importFolder(
  fs: DirFs,
  root: string,
  {
    onProgress,
    signal,
  }: { onProgress?: (progress: ImportProgress) => void; signal?: AbortSignal } = {},
): Promise<ImportOutcome[]> {
  // The walk itself can be long on a deep tree, and was uncancellable.
  if (signal?.aborted) return []
  const paths = await collectBooks(fs, root)
  if (signal?.aborted) return []
  const outcomes: ImportOutcome[] = []

  for (const [index, path] of paths.entries()) {
    if (signal?.aborted) break
    const name = path.slice(path.lastIndexOf('/') + 1)
    onProgress?.({ done: index, total: paths.length, current: name })
    try {
      const bytes = await fs.readOutside(path)
      /* Checked AGAIN after the read, which is the long part of one book — a
       * 40MB file off a network volume takes long enough that stopping only
       * between books means "stop" waits for it. Anything after this point is
       * hashing and a rename, which are fast and better finished than half-done. */
      if (signal?.aborted) break
      const file = new File([bytes as BlobPart], name)
      const bookId = await bookIdFor(file)
      // And again between the hash and the write. What remains after this point
      // is one file, which is better finished than half-done.
      if (signal?.aborted) break

      /* INTO THE BOOK'S OWN FOLDER, which is where every other part of a book
       * lives. This wrote `books/<id>.<ext>` at the top level until phase 4, and
       * a folder import was the last thing still producing the flat layout. */
      const at = contentPathIn(bookId, name)
      const held = await fs.exists(at)
      // Renamed into place by `atomicWrite`, so an interrupted import cannot
      // leave a truncated file that `exists` will later call a book.
      if (!held) await atomicWrite(fs, at, bytes)
      outcomes.push({
        path,
        /* Whether the file was ALREADY there, checked before writing. An
         * earlier version probed a path without the extension — one that never
         * exists — so every book reported as added; and it could not fall back
         * to a byte count, which is the input's length either way. */
        status: held ? 'duplicate' : 'added',
        bookId,
        name,
      })
    } catch (cause) {
      /* Named individually rather than counted. "4 of 300 failed" tells a reader
       * nothing they can act on; the path and the reason tell them which book to
       * look at and usually why. */
      outcomes.push({
        path,
        status: 'failed',
        reason: cause instanceof Error ? cause.message : 'could not be read',
      })
    }
    // Between books, not inside one: this is the whole of what keeps a
    // three-hundred-book import from freezing the window.
    await yieldToPaint()
  }

  onProgress?.({ done: paths.length, total: paths.length, current: '' })
  return outcomes
}

/** A one-line summary, for a reader who does not want the whole list. */
export function summarise(outcomes: readonly ImportOutcome[]): string {
  const added = outcomes.filter((one) => one.status === 'added').length
  const duplicate = outcomes.filter((one) => one.status === 'duplicate').length
  const failed = outcomes.filter((one) => one.status === 'failed').length
  if (outcomes.length === 0) return 'No books found in that folder.'
  const parts = [`${added} added`]
  if (duplicate) parts.push(`${duplicate} already here`)
  if (failed) parts.push(`${failed} could not be read`)
  return parts.join(', ')
}

/**
 * Keep Paper's own copy of one book the reader chose, and say what happened.
 *
 * The per-book half of `importFolder`, for a caller that already HAS the bytes:
 * the native picker hands back a `File` and a path together, so there is nothing
 * to read off the disk again.
 *
 * It exists because picking five books used to add one. Opening a book replaces
 * the open one, so a loop that opened each in turn left React with a single
 * source and shelved a single book — the rest were selected and silently
 * discarded. This is what the other four go through instead.
 */
export async function keepOwnCopy(
  fs: VaultFs,
  file: File,
  path: string | null,
): Promise<ImportOutcome> {
  const bookId = await bookIdFor(file)
  const at = contentPathIn(bookId, file.name)
  const held = await fs.exists(at)
  if (!held) await atomicWrite(fs, at, new Uint8Array(await file.arrayBuffer()))
  return {
    path: path ?? file.name,
    status: held ? 'duplicate' : 'added',
    bookId,
    name: file.name,
  }
}
