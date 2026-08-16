/**
 * A removed book, kept for a while.
 *
 * WHY NOT JUST DELETE IT. Because everything a book owns lives in its folder,
 * so removing it takes the reader's tags, their place in it and their marks with
 * it — and that is not a file the reader owns, it is what they WROTE. A misclick
 * on a shelf should not be able to destroy it.
 *
 * Moving the folder to `trash/<bookId>/` keeps the architecture exactly as
 * strict as deleting would: one self-contained object, no tombstone store, no
 * hidden state — a trash is a visible directory. It costs a rename.
 *
 * RE-ADDING A TRASHED BOOK RESTORES IT, which falls straight out of
 * content-derived identity: the same bytes produce the same id, so they land on
 * the same folder name. A reader who removes a book and adds it again finds
 * their highlights waiting, and nothing had to remember that they might.
 */

import type { VaultFs } from './bookVault'
import { folderOf, trashOf } from './bookFolder'

export { TRASH_DIR } from './bookFolder'

/**
 * How long a removed book is recoverable.
 *
 * Long enough to cover "I did not mean that" and the day after, short enough
 * that a library is not quietly storing twice what the reader thinks. Calibre
 * holds deletions for the same reason and roughly as long.
 */
export const TRASH_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

export interface TrashFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  /** Remove a directory and everything in it. */
  removeDir: (path: string) => Promise<void>
}

/** Move a book's folder into the trash. Returns false when there was none. */
export async function trashBook(fs: TrashFs, bookId: string): Promise<boolean> {
  try {
    /* CHECKED FIRST. Without this, removing a book that is not there renamed
     * nothing and then wrote the stamp anyway — producing `trash/<id>/.removed`
     * with no book beside it, which `emptyExpired` would then dutifully carry
     * around for a fortnight. */
    if (!(await fs.exists(folderOf(bookId)))) return false
    await fs.mkdir('trash')
    await fs.rename(folderOf(bookId), trashOf(bookId))
    /* A stamp beside the folder rather than a modified time on it, because a
     * rename does not reliably change mtime on every filesystem — and reading
     * one back through the plugin would need a stat permission this app does not
     * ask for. A file with a number in it needs neither. */
    await fs.writeFile(`${trashOf(bookId)}/.removed`, new TextEncoder().encode(String(Date.now())))
    return true
  } catch {
    return false
  }
}

/** Put a trashed book back. Returns false when it was not there. */
export async function restoreBook(fs: TrashFs, bookId: string): Promise<boolean> {
  try {
    if (!(await fs.exists(trashOf(bookId)))) return false
    await fs.remove(`${trashOf(bookId)}/.removed`).catch(() => {})
    await fs.rename(trashOf(bookId), folderOf(bookId))
    return true
  } catch {
    return false
  }
}

/** Whether a removed copy of this book is waiting to be restored. */
export async function isTrashed(fs: TrashFs, bookId: string): Promise<boolean> {
  try {
    return await fs.exists(trashOf(bookId))
  } catch {
    return false
  }
}

/**
 * Delete anything that has been in the trash longer than its stay.
 *
 * Best effort throughout: a folder that will not read, or whose stamp is
 * missing, is LEFT rather than deleted. Erring towards keeping is the only
 * direction that cannot lose a reader's work, and the cost of being wrong is
 * disk rather than words.
 */
export async function emptyExpired(fs: TrashFs, now = Date.now()): Promise<string[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await fs.readDir('trash')
  } catch {
    return []
  }
  const gone: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    const at = `trash/${entry.name}`
    try {
      const stamp = Number(new TextDecoder().decode(await fs.readFile(`${at}/.removed`)))
      if (!Number.isFinite(stamp)) continue
      if (now - stamp < TRASH_DAYS * DAY_MS) continue
      await fs.removeDir(at)
      gone.push(entry.name)
    } catch {
      // Unreadable stamp, or a delete that failed. Left alone on purpose.
      continue
    }
  }
  return gone
}
