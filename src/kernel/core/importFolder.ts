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

/**
 * Extensions worth reading. The same closed list the vault stores under.
 *
 * EXPORTED, because a drop is the other way a folder of books arrives and it
 * walks a different filesystem to get here — `webkitGetAsEntry` rather than
 * Tauri's `readDir`, since the webview is handed entries and not paths. Two
 * walkers are unavoidable; two ANSWERS about what counts as a book are not, and
 * a drop that accepted a format the picker refused would be a difference
 * nobody chose.
 */
export const IMPORTABLE = /\.(epub|pdf|mobi|azw3|cbz|fb2|fbz)$/i

/**
 * How deep to walk.
 *
 * A bound rather than a preference: a symlinked folder can point at its own
 * parent, and a recursive read with no depth limit walks that forever. Tauri's
 * `readDir` does not resolve links for us, so this is the only thing standing
 * between "import my books folder" and a hang with no error.
 */
export const MAX_DEPTH = 8

/** A ceiling on one import, so a mis-picked home directory does not run for an hour. */
export const MAX_FILES = 5000

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
}

/**
 * How many books are handed to the shelf at a time — see `onCopied`.
 *
 * Small enough that the shelf stops saying "empty" almost at once, large
 * enough that a two-thousand-book import is eighty handovers rather than two
 * thousand. At the rate the copy actually runs — about seventy books a
 * second on the library that set this — a batch is a third of a second.
 */
export const SHELVE_BATCH = 24

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
    onCopied,
    signal,
  }: {
    onProgress?: (progress: ImportProgress) => void
    /**
     * Books copied since the last call, IN BATCHES AND WHILE THE WALK IS
     * STILL RUNNING — see `SHELVE_BATCH`.
     *
     * The reason this exists: every outcome used to be returned at the end
     * and shelved in one go afterwards, so a two-thousand-book import spent
     * its entire copying phase with nothing on the shelf. The reader watched
     * a counter climb past eight hundred underneath the words "Your library
     * is empty", which is the app telling them two contradictory things
     * about the same moment.
     *
     * It also bounds what a crash costs. Shelving at the end means every
     * book copied so far has bytes and no record if the app goes down before
     * the loop finishes; shelving as it goes means at most one batch is in
     * that state.
     *
     * The handler must not be slow — it is called from inside the copy loop.
     * Callers hand the batch to a queue and return.
     */
    onCopied?: (batch: readonly ImportOutcome[]) => void
    signal?: AbortSignal
  } = {},
): Promise<ImportOutcome[]> {
  // The walk itself can be long on a deep tree, and was uncancellable.
  if (signal?.aborted) return []
  const paths = await collectBooks(fs, root)
  if (signal?.aborted) return []
  const outcomes: ImportOutcome[] = []
  /* Copied but not yet handed over. Drained on the way out of the loop too,
   * so a batch that never filled still reaches the shelf. */
  let batch: ImportOutcome[] = []
  const handOver = () => {
    if (batch.length === 0) return
    const ready = batch
    batch = []
    onCopied?.(ready)
  }

  for (const [index, path] of paths.entries()) {
    if (signal?.aborted) break
    const name = path.slice(path.lastIndexOf('/') + 1)
    onProgress?.({ done: index, total: paths.length })
    const outcome = await importOne(fs, path, name, signal)
    // `null` is a stop, not a failure — see `importOne`.
    if (!outcome) break
    outcomes.push(outcome)
    batch.push(outcome)
    if (batch.length >= SHELVE_BATCH) handOver()
    // Between books, not inside one: this is the whole of what keeps a
    // three-hundred-book import from freezing the window.
    await yieldToPaint()
  }

  /* EVEN ON A STOP. The books already copied are on disk either way, and a
   * stopped import that left them recordless would leave exactly the
   * orphaned folders this pipeline has been taught to avoid. */
  handOver()
  onProgress?.({ done: outcomes.length, total: paths.length })
  return outcomes
}

/**
 * A one-line summary, for a reader who does not want the whole list.
 *
 * `unsaved` is books whose BYTES arrived and whose record did not — a
 * different failure from `failed`, which is a file that could not be read at
 * all, and the reason this parameter exists. A record write that fails leaves
 * a copy of the book in the library with nothing on the shelf pointing at it,
 * and until this was said out loud the only trace was a line in a console
 * nobody had open: 82 books of 1,959 went missing that way, and the import
 * reported "1,959 added".
 */
export function summarise(outcomes: readonly ImportOutcome[], unsaved = 0): string {
  const added = outcomes.filter((one) => one.status === 'added').length
  const duplicate = outcomes.filter((one) => one.status === 'duplicate').length
  const failed = outcomes.filter((one) => one.status === 'failed').length
  if (outcomes.length === 0) return 'No books found in that folder.'
  const parts = [`${added} added`]
  if (duplicate) parts.push(`${duplicate} already here`)
  if (failed) parts.push(`${failed} could not be read`)
  if (unsaved) parts.push(`${unsaved} could not be saved`)
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
  signal?: AbortSignal,
): Promise<ImportOutcome | null> {
  const bookId = await bookIdFor(file)
  /* CHECKED BETWEEN THE HASH AND THE WRITE. Hashing is the second long step of
   * one book, and stopping only between books means "stop" waits for it. What
   * remains after this point is one file, which is better finished than
   * half-done — so this is the last place a stop is honoured. */
  if (signal?.aborted) return null

  /* INTO THE BOOK'S OWN FOLDER, which is where every other part of a book
   * lives. A folder import wrote `books/<id>.<ext>` at the top level until
   * phase 4, and was the last thing producing the flat layout. */
  const at = contentPathIn(bookId, file.name)
  const held = await fs.exists(at)
  // Renamed into place by `atomicWrite`, so an interrupted import cannot leave
  // a truncated file that `exists` will later call a book.
  if (!held) await atomicWrite(fs, at, new Uint8Array(await file.arrayBuffer()))
  return {
    path: path ?? file.name,
    /* Whether the file was ALREADY there, checked before writing. An earlier
     * version probed a path without the extension — one that never exists — so
     * every book reported as added; and it could not fall back to a byte count,
     * which is the input's length either way. */
    status: held ? 'duplicate' : 'added',
    bookId,
    name: file.name,
  }
}

/**
 * One book of a folder import: read it, keep a copy, say what happened.
 *
 * `null` means STOPPED, which is not a failure and must not be reported as one.
 * Everything else — including being unable to read the file — is an outcome the
 * reader gets to see, named individually rather than counted: "4 of 300 failed"
 * tells them nothing they can act on, while the path and the reason tell them
 * which book to look at and usually why.
 */
async function importOne(
  fs: DirFs,
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<ImportOutcome | null> {
  try {
    const bytes = await fs.readOutside(path)
    /* Checked AGAIN after the read, which is the long part of one book — a 40MB
     * file off a network volume takes long enough that stopping only between
     * books means "stop" waits for it. */
    if (signal?.aborted) return null
    return await keepOwnCopy(fs, new File([bytes as BlobPart], name), path, signal)
  } catch (cause) {
    return {
      path,
      status: 'failed',
      reason: cause instanceof Error ? cause.message : 'could not be read',
    }
  }
}
