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
import { folderOf, readMarks, trashOf, writeMarks } from './bookFolder'

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

/**
 * Put a trashed book back. Returns false when there was nothing in the trash.
 *
 * FILE BY FILE, NOT FOLDER BY FOLDER, and that is the whole of it. Renaming the
 * folder needs the destination not to exist — but by the time anything asks for
 * a restore, it usually does: an import writes `content.epub` first and puts the
 * book on the shelf second, so the live folder is already there holding the
 * bytes. Refusing at that point was correct about the rename and wrong about the
 * outcome: the reader re-added a book they had removed, and their tags, their
 * place and their marks stayed in the trash where nothing would look again.
 *
 * So each entry moves on its own, and one already live WINS. The bytes just
 * written are the current ones; the record and marks in the trash are the ones
 * with nothing to replace them.
 */
export async function restoreBook(fs: TrashFs, bookId: string): Promise<boolean> {
  try {
    if (!(await fs.exists(trashOf(bookId)))) return false
    const entries = await fs.readDir(trashOf(bookId))
    await fs.mkdir(folderOf(bookId))
    let allMoved = true
    for (const entry of entries) {
      // The stamp belongs to the trash and is not part of the book.
      if (entry.name === '.removed') continue
      const to = `${folderOf(bookId)}/${entry.name}`
      /* A NAME ALREADY LIVE WINS, and the trashed one STAYS WHERE IT IS.
       *
       * An earlier version deleted a collided `content.<ext>` on the reasoning
       * that the folder is named by a hash of those bytes, so the two must be
       * the same book. THAT IS NOT TRUE, and this codebase says so a few files
       * away: above 64MB `bookIdFor` samples rather than hashes whole, and the
       * comment on `INTERIOR_PROBES` states plainly that identity there is
       * approximate. Deleting a file on a premise the code documents as
       * approximate is how a scanned book disappears.
       *
       * So nothing is deleted. What could not move keeps its stamp, ages out on
       * the ordinary fortnight, and can be recovered by hand until it does. The
       * cost is carrying a duplicate copy for that fortnight, which is the right
       * side to be wrong on. */
      if (await fs.exists(to)) {
        allMoved = false
        continue
      }
      try {
        await fs.rename(`${trashOf(bookId)}/${entry.name}`, to)
      } catch {
        /* SWALLOWED AND REMEMBERED, not swallowed and forgotten. Catching the
         * failure and then emptying the trash anyway deleted the entry that had
         * just failed to move — a restore that loses the thing it was restoring,
         * which is worse than not restoring at all. */
        allMoved = false
      }
    }
    /* The trash entry goes LAST, and ONLY when it is empty of the book. Anything
     * still in there keeps its stamp and therefore its age, so `emptyExpired`
     * clears it on the ordinary schedule rather than never — removing the stamp
     * early is what would strand it, because that sweep keeps whatever it cannot
     * age. */
    if (allMoved) {
      await fs.removeDir(trashOf(bookId)).catch(() => {})
    } else {
      /* RE-STAMPED, so what could not move gets a fresh fortnight rather than
       * the remainder of the old one. A restore attempted a day before expiry
       * otherwise reported success and then let the sweep delete the very files
       * it had failed to bring back. */
      await fs
        .writeFile(`${trashOf(bookId)}/.removed`, new TextEncoder().encode(String(Date.now())))
        .catch(() => {})
    }
    return true
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

/**
 * Fold marks a restore had to leave in the trash into the live ones.
 *
 * `restoreBook` moves file by file and a name already live WINS, so a reader who
 * highlights something while a re-added book's bytes are still being written
 * creates a `marks.json` that blocks the complete one from coming back. It then
 * sat in the trash until the sweep deleted it — the one annotation made in that
 * window costing every annotation made before the book was removed.
 *
 * BY ID, and the live copy wins a tie: it is the one the reader has been looking
 * at. Nothing is removed from the trash until the merged list is written.
 */
export async function rescueStrandedMarks(fs: TrashFs, bookId: string): Promise<boolean> {
  const at = `${trashOf(bookId)}/marks.json`
  try {
    if (!(await fs.exists(at))) return false
    const stranded = JSON.parse(new TextDecoder().decode(await fs.readFile(at))) as unknown
    if (!Array.isArray(stranded)) return false
    const live = (await readMarks(fs as never, bookId)) as { id?: unknown }[]
    const held = new Set(live.map((mark) => mark?.id).filter((id) => typeof id === 'string'))
    const fresh = stranded.filter((mark) => {
      const id = (mark as { id?: unknown })?.id
      /* A mark with no usable id CANNOT be deduplicated, so it is carried over
       * rather than dropped: a duplicate is visible and deletable, and this runs
       * once because the trashed file goes immediately after. Losing somebody's
       * note to tidy bookkeeping is the wrong way round. */
      return typeof id !== 'string' || !held.has(id)
    })
    if (fresh.length) await writeMarks(fs as never, bookId, [...live, ...fresh])
    await fs.remove(at).catch(() => {})
    return fresh.length > 0
  } catch (cause) {
    /* LEFT WHERE IT IS. A trashed marks file that will not read is not one to
     * delete on the way past — it keeps its stamp and its fortnight. */
    console.error('Paper: could not recover the removed marks', cause)
    return false
  }
}
