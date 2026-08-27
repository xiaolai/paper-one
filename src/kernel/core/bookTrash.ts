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
import { folderOf, parseRecord, readMarks, trashOf, writeMarks } from './bookFolder'
import type { BookRecord } from './bookFolder'


/**
 * How long a removed book is recoverable.
 *
 * Long enough to cover "I did not mean that" and the day after, short enough
 * that a library is not quietly storing twice what the reader thinks. Calibre
 * holds deletions for the same reason and roughly as long.
 */
export const TRASH_DAYS = 14
/**
 * The retention window as UI copy, derived from the number the sweep actually
 * enforces. "Two weeks" was written out twice in the remove confirm,
 * independently of `TRASH_DAYS` — so shortening the sweep would have left the
 * interface promising recovery the trash no longer offered.
 */
export const TRASH_KEPT_FOR = TRASH_DAYS === 14 ? 'two weeks' : `${TRASH_DAYS} days`
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a trashed book has left, as the words a reader sees.
 *
 * Beside `TRASH_KEPT_FOR` and for its stated reason: the retention window and
 * the copy describing it drift the moment they live apart, and this is the
 * second sentence derived from `TRASH_DAYS`.
 *
 * "AT NEXT LAUNCH", NOT "TODAY", for an entry already past its window. The
 * sweep is `emptyExpired`, run once at startup and never on a timer — so a
 * book whose fortnight ended while the app was open is still there, still
 * restorable, and saying "today" would promise a deletion that will not
 * happen until the app is next started.
 *
 * A null `expiresAt` is an entry whose removal time could not be read. The
 * sweep LEAVES those rather than guessing, so the honest word is that it
 * stays.
 */
export function timeLeft(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return 'Kept'
  const left = expiresAt - now
  if (left <= 0) return 'Goes at next launch'
  const days = Math.ceil(left / DAY_MS)
  return days === 1 ? '1 day left' : `${days} days left`
}

export interface TrashFs extends VaultFs {
  readDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  /** Remove a directory and everything in it. */
  removeDir: (path: string) => Promise<void>
}

/**
 * Move a book's folder into the trash.
 *
 * FALSE MEANS THE REMOVAL DID NOT HAPPEN — which covers two different things
 * and deliberately does not distinguish them: there was no folder to move, or
 * a move failed and the rollback put everything back. The contract used to
 * say only the first, and a reader of it would conclude that a `false` is
 * always benign.
 *
 * The distinction is the CALLER'S to draw, because only the caller can ask
 * the cheap question that settles it — `libraryStore.remove` does exactly
 * that: on false it checks whether the folder is still there and throws if it
 * is, which is how an optimistically removed row gets put back. Answering it
 * here would mean a second stat on the happy path for a case the one caller
 * already handles.
 */
export async function trashBook(fs: TrashFs, bookId: string): Promise<boolean> {
  try {
    /* CHECKED FIRST. Without this, removing a book that is not there renamed
     * nothing and then wrote the stamp anyway — producing `trash/<id>/.removed`
     * with no book beside it, which `emptyExpired` would then dutifully carry
     * around for a fortnight. */
    if (!(await fs.exists(folderOf(bookId)))) return false
    await fs.mkdir('trash')
    /* FILE BY FILE WHEN THERE IS ALREADY SOMETHING THERE, for the same reason
     * `restoreBook` moves that way: a restore deliberately leaves behind
     * anything it could not bring back, so a trash entry can still exist for a
     * book that is live again. Renaming a directory ONTO a non-empty one fails,
     * and this reported that failure as `false` — which the caller ignored, so
     * the row vanished optimistically, the index was written without it, and the
     * book came back on the next launch. Remove appearing not to work is worse
     * than almost anything else the shelf can do.
     *
     * The LIVE copy wins on a collision here, which is the mirror of restore:
     * it is the one the reader has been using. */
    if (await fs.exists(trashOf(bookId))) {
      /* AND IT UNDOES ITSELF IF IT CANNOT FINISH. Renaming one entry at a time
       * is not one operation, so a failure part way through — a locked file, a
       * permission — left `book.json` in the trash and the content live, or the
       * other way round. A book split across two directories is worse than a
       * removal that did not happen, and only one of those is recoverable by
       * pressing the button again. */
      /* Anything a previous, interrupted removal held aside. It is superseded by
       * whatever this one is about to move, and leaving it would collide with
       * the name this run wants to use. */
      for (const entry of await fs.readDir(trashOf(bookId))) {
        if (entry.name.endsWith('.displaced')) {
          await fs.remove(`${trashOf(bookId)}/${entry.name}`).catch(() => {})
        }
      }
      const moved: { from: string; to: string }[] = []
      /* The trashed copies displaced by a collision, held aside rather than
       * deleted. Deleting them first made the rollback a half-measure: it could
       * put the live entries back and had nothing left to restore on the other
       * side. `content.*` is the one that matters — identity above 64MB is
       * sampled, which this file already says elsewhere, so a collided copy is
       * not provably the same book. */
      const displaced: { held: string; original: string }[] = []
      try {
        for (const entry of await fs.readDir(folderOf(bookId))) {
          const from = `${folderOf(bookId)}/${entry.name}`
          const to = `${trashOf(bookId)}/${entry.name}`
          if (await fs.exists(to)) {
            const held = `${to}.displaced`
            await fs.rename(to, held)
            displaced.push({ held, original: to })
          }
          await fs.rename(from, to)
          moved.push({ from, to })
        }
      } catch (cause) {
        // Back where they came from, in reverse, best effort — the live entries
        // first, then the trashed copies they displaced.
        for (const one of moved.reverse()) {
          await fs.rename(one.to, one.from).catch(() => {})
        }
        for (const one of displaced.reverse()) {
          await fs.rename(one.held, one.original).catch(() => {})
        }
        throw cause
      }
      // Only now, with everything moved, is the displaced copy redundant.
      for (const one of displaced) await fs.remove(one.held).catch(() => {})
      await fs.removeDir(folderOf(bookId)).catch(() => {})
    } else {
      await fs.rename(folderOf(bookId), trashOf(bookId))
    }
    /* A stamp beside the folder rather than a modified time on it, because a
     * rename does not reliably change mtime on every filesystem — and reading
     * one back through the plugin would need a stat permission this app does not
     * ask for. A file with a number in it needs neither. */
    /* THE STAMP IS BEST-EFFORT, AND ITS FAILURE IS NOT THE REMOVAL'S.
       By this line the folder is already under `trash/` — the move happened,
       the shelf is right to have dropped the row, and there is nothing to
       roll back. Letting a failed stamp fall into the catch below returned
       `false`, which says "the removal did not happen"; the caller then finds
       the live folder gone, concludes all is well, and the two disagree about
       an event that DID occur. `readStamp` already treats an absent stamp as
       "leave this alone", so the cost of losing it is a trash entry that
       never ages out — visible, recoverable, and much the smaller wrong. */
    try {
      await fs.writeFile(`${trashOf(bookId)}/.removed`, new TextEncoder().encode(String(Date.now())))
    } catch {
      /* Kept for ever rather than reported as un-removed. */
    }
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
/**
 * How a restore went.
 *
 * THREE ANSWERS, NOT TWO, and a failure is a FOURTH thing — it is thrown.
 *
 * This returned a boolean and wrapped everything in `catch { return false }`,
 * so three unrelated situations arrived at the caller identically: there was
 * nothing in the trash, the disk could not be read, and the trash entry was
 * found but half of it could not be moved. The first is an ordinary answer,
 * the second is a fault the caller must not paper over, and the third is a
 * partial restore that used to be reported as a complete one — the reader is
 * told their book is back while its `book.json` is still in the trash, ageing
 * towards the sweep that deletes it.
 */
export type RestoreOutcome =
  /** Everything the trash held for this book is back in its folder. */
  | { readonly state: 'restored' }
  /** The entry was there; these names could not be moved and REMAIN in the
   *  trash, re-stamped for a fresh fortnight. */
  | { readonly state: 'partial'; readonly held: readonly string[] }
  /** There is no trash entry for this book. Nothing to do, and not a fault. */
  | { readonly state: 'absent' }

export async function restoreBook(fs: TrashFs, bookId: string): Promise<RestoreOutcome> {
  if (!(await fs.exists(trashOf(bookId)))) return { state: 'absent' }
  const entries = await fs.readDir(trashOf(bookId))
  await fs.mkdir(folderOf(bookId))
  const held: string[] = []
  for (const entry of entries) {
    // The stamp belongs to the trash and is not part of the book.
    if (entry.name === '.removed') continue
    /* Nor is a copy held aside mid-removal. A crash between displacing one and
     * finishing the move leaves it behind, and restoring it would put
     * `content.epub.displaced` into the live folder — a file the shelf cannot
     * read and the sweep does not recognise. It stays in the trash and ages
     * out with everything else there. */
    if (entry.name.endsWith('.displaced')) continue
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
      held.push(entry.name)
      continue
    }
    try {
      await fs.rename(`${trashOf(bookId)}/${entry.name}`, to)
    } catch {
      /* SWALLOWED AND REMEMBERED, not swallowed and forgotten. Catching the
       * failure and then emptying the trash anyway deleted the entry that had
       * just failed to move — a restore that loses the thing it was restoring,
       * which is worse than not restoring at all. The name goes into the
       * outcome, so the caller can say WHICH part of the book stayed behind
       * rather than reporting a clean success over half a book. */
      held.push(entry.name)
    }
  }
  /* The trash entry goes LAST, and ONLY when it is empty of the book. Anything
   * still in there keeps its stamp and therefore its age, so `emptyExpired`
   * clears it on the ordinary schedule rather than never — removing the stamp
   * early is what would strand it, because that sweep keeps whatever it cannot
   * age. */
  if (held.length === 0) {
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
  return held.length === 0 ? { state: 'restored' } : { state: 'partial', held }
}


/**
 * What is in the trash, and when each entry ages out.
 *
 * The folder name is `safeId(bookId)` and is NOT reversible, so the id and
 * the title come from the record that travelled with the folder — a book is
 * self-contained, which is exactly what makes a trash entry describable at
 * all. An entry whose record will not read still appears, named by its
 * folder: it is a directory holding a reader's work, and a listing that
 * silently omitted it would make it unrecoverable through any surface.
 *
 * `removedAt` is null for an entry with no readable stamp, and `expiresAt` is
 * null with it — the sweep LEAVES such an entry rather than deleting it, so
 * saying it expires would be a lie.
 */
export interface TrashedBook {
  /** The directory under `trash/`. */
  readonly folder: string
  /** The id from the record, or the folder name when there is no record. */
  readonly bookId: string
  readonly title: string
  readonly author: string
  readonly removedAt: number | null
  readonly expiresAt: number | null
}

/**
 * The removal stamp, or null when there is not a usable one.
 *
 * `Number('')` IS ZERO, and `Number.isFinite(0)` is true — so an empty or
 * half-written `.removed` read as "removed at the epoch", which is older than
 * any retention window, and `emptyExpired` DELETED THE BOOK. That is the one
 * outcome this file's contract forbids: "a folder that will not read, or
 * whose stamp is missing, is LEFT rather than deleted". Whitespace does the
 * same thing, and a crash between `mkdir` and the stamp write is exactly how
 * an empty one occurs.
 *
 * ONE PARSER FOR BOTH READERS. `listTrash` had the same coercion, where it
 * showed as a row removed in 1970 with its fortnight long gone; two copies of
 * this rule is how the surface that REPORTS the deadline and the sweep that
 * ENFORCES it come to disagree about which books are past it.
 *
 * A stamp must be a positive integer of milliseconds. Zero and negatives are
 * refused rather than clamped: no removal happened at or before the epoch, so
 * such a value is corruption, and corruption must not be able to delete.
 */
export function readStamp(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const stamp = Number(text)
  if (!Number.isInteger(stamp) || stamp <= 0) return null
  return stamp
}

export async function listTrash(fs: TrashFs, signal?: AbortSignal): Promise<TrashedBook[]> {
  /* ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER — the rule this file's own
   * `readMarks` neighbour records, and the one a bare `catch` here broke. No
   * trash directory is an empty trash: it is made on the first removal, and a
   * library that has never removed a book has none. A directory that EXISTS
   * and will not read is a failure, and reporting it as "empty" would let
   * `trash.empty --count 0` succeed over a trash full of the reader's work. */
  if (!(await fs.exists('trash'))) return []
  const entries = await fs.readDir('trash')
  const rows: TrashedBook[] = []
  for (const entry of entries) {
    /* THE CALLER'S CANCELLATION REACHES THE SCAN. This read two files per
     * entry and nothing stopped it: a timeout, a cancel frame or a closed
     * session left the whole trash being read for an answer nobody was
     * waiting for. Checked per entry, so the work stops within one folder
     * rather than at the end. */
    if (signal?.aborted === true) break
    if (!entry.isDirectory) continue
    const at = `trash/${entry.name}`
    let record: BookRecord | null = null
    try {
      record = parseRecord(new TextDecoder().decode(await fs.readFile(`${at}/book.json`)))
    } catch {
      record = null
    }
    let removedAt: number | null = null
    try {
      removedAt = readStamp(new TextDecoder().decode(await fs.readFile(`${at}/.removed`)))
    } catch {
      removedAt = null
    }
    rows.push({
      folder: entry.name,
      bookId: record?.bookId ?? entry.name,
      title: record?.title ?? '',
      author: record?.author ?? '',
      removedAt,
      expiresAt: removedAt === null ? null : removedAt + TRASH_DAYS * DAY_MS,
    })
  }
  return rows
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
  const gone: string[] = []
  for (const name of await expiredTrash(fs, now)) {
    try {
      await fs.removeDir(`trash/${name}`)
      gone.push(name)
    } catch {
      // A delete that failed. Left alone on purpose.
      continue
    }
  }
  return gone
}

/** The trash's whole stay, in milliseconds — `TRASH_DAYS`, spent. */
export const TRASH_WINDOW_MS = TRASH_DAYS * DAY_MS

/**
 * The trashed folders whose stay is over at `now`, by folder name — the
 * LISTING half of the sweep, with the sweep's rules: a folder whose stamp is
 * missing, unreadable or not a positive integer is left, and so is one that
 * cannot be listed. Reads and decides; deletes nothing.
 *
 * SPLIT OUT so the app's sweep can delete on each book's LANE instead
 * (`Library.emptyExpiredTrash`). `emptyExpired` above listed and deleted in
 * one pass, off every queue — so a restore that landed between its stamp
 * read and its `removeDir` lost the files the restore had deliberately kept
 * back, and the fresh stamp with them. The decision is made here once and
 * re-made inside the lane by the purge, against the stamp as it is then.
 */
export async function expiredTrash(fs: TrashFs, now = Date.now()): Promise<string[]> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await fs.readDir('trash')
  } catch {
    return []
  }
  const expired: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    try {
      const stamp = readStamp(new TextDecoder().decode(await fs.readFile(`trash/${entry.name}/.removed`)))
      if (stamp === null) continue
      if (now - stamp < TRASH_WINDOW_MS) continue
      expired.push(entry.name)
    } catch {
      // Unreadable stamp. Left alone on purpose.
      continue
    }
  }
  return expired
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
