import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { coverTintFor } from '../../core/bookAccent'
import { TRASH_KEPT_FOR, timeLeft, type TrashedBook } from '../../core/bookTrash'
import { ICON } from '../../core/metrics'
import { relativeTime } from '../../core/relativeTime'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * The books this device has removed, and the way to take one back.
 *
 * WHY IT EXISTS. Removing a book showed a sheet promising the removal was
 * "recoverable for two weeks", and it was — through `paper book restore`, in
 * a terminal. `trash.list` and `book.restore` had been services since phase
 * 11 and no surface in the app reached either, so the promise on screen could
 * only be kept by a reader who knew the CLI existed. A guarantee the product
 * states and cannot perform is worse than no guarantee, because it is acted
 * on.
 *
 * IT MATTERS MORE ON A SECOND DEVICE. A removal replicates — the presence
 * register in `sync/removed.json` is an LWW fact, not a local act — so a book
 * deleted on a laptop leaves the desktop too, silently, with the reader who
 * did not delete it having no way to ask what happened or undo it. This is
 * that way.
 *
 * PER DEVICE, deliberately. Each device trashes its own copy and sweeps it on
 * its own launch, so this lists what THIS device holds. Restoring writes
 * `live` with a fresh stamp, which wins the register — so a restore here
 * brings the book back everywhere, which is the behaviour a reader expects
 * from an undo and the reason the button does not need to ask which device it
 * means.
 */

export interface TrashSheetProps {
  /** What `listTrash` found, newest first — the caller reads the disk. */
  readonly rows: readonly TrashedBook[]
  /** True while the first read is in flight. */
  readonly loading: boolean
  /**
   * Why the read failed, or null.
   *
   * A THIRD STATE, because two could not tell the truth. `listTrash` throws
   * when the trash directory exists and will not read — deliberately, so that
   * "unreadable" is never reported as "empty" — and the caller was turning
   * that into an empty array. The reader was then told "Nothing removed" on
   * the one surface that exists to get their book back, which is the exact
   * lie the core function refuses to tell.
   */
  readonly error: string | null
  /**
   * Put this book back. May return a promise; while it is pending the row's
   * own button is disabled.
   *
   * A RESTORE IS SLOW AND FALLIBLE — it moves a folder file by file — and the
   * button used to be fire-and-forget, so a reader with a large book pressed
   * a control that looked untouched and pressed it again.
   */
  readonly onRestore: (bookId: string) => void | Promise<void>
  readonly onDismiss: () => void
  /** Read once by the caller, so every row measures against one now. */
  readonly now: number
}

/**
 * What to call a row.
 *
 * `listTrash` returns an EMPTY title when the folder's `book.json` cannot be
 * read — which is one of the reasons a book ends up needing rescuing — and an
 * empty string rendered a blank row above a button reading "Put  back in the
 * library". The folder is the name the reader can still act on.
 */
const named = (row: TrashedBook): string => row.title.trim() || row.folder

export function TrashSheet({ rows, loading, error, onRestore, onDismiss, now }: TrashSheetProps) {
  /* WHICH BOOKS ARE BEING RESTORED — a set, not a single id. A single id
     disabled EVERY row while any one was running, so restoring a large book
     froze the whole recovery surface; the restores are independent and the
     rows should be too. */
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(() => new Set())
  const startRestoring = (bookId: string) =>
    setRestoring((held) => new Set(held).add(bookId))
  const doneRestoring = (bookId: string) =>
    setRestoring((held) => {
      const next = new Set(held)
      next.delete(bookId)
      return next
    })
  return (
    <OverlaySheet label="Removed books" onDismiss={onDismiss}>
      <div className={styles.list}>
        {loading ? (
          <div className={styles.empty}>Reading the trash…</div>
        ) : error !== null ? (
          <div className={styles.empty}>
            The trash could not be read.
            <br />
            {error}
          </div>
        ) : rows.length === 0 ? (
          /* THE EMPTY STATE SAYS WHAT THE PLACE IS FOR, not just that it is
             empty: a reader who opened this looking for a book that vanished
             needs to know they are in the right room and it is not here. */
          <div className={styles.empty}>
            Nothing removed.
            <br />
            Books you remove wait here for {TRASH_KEPT_FOR}.
          </div>
        ) : (
          rows.map((row) => (
            <div key={row.bookId} className={styles.row} data-static="true">
              <span
                className={styles.cover}
                style={{ background: coverTintFor(row.bookId) }}
                aria-hidden
              />
              <span className={styles.rowLabel}>
                {named(row)}
                <span className={styles.rowSub}>
                  {row.author}
                  {/* WHEN, AND HOW LONG IS LEFT. The second is the one that
                      decides whether to act now, so it is the one that gets
                      the emphasis; `timeLeft` derives it from the same
                      `TRASH_DAYS` the sweep uses. */}
                  {' · '}
                  {relativeTime(row.removedAt, now) ?? 'Removed'}
                  {' · '}
                  <span className={styles.rowNote}>{timeLeft(row.expiresAt, now)}</span>
                </span>
              </span>
              <button
                type="button"
                className={styles.rowAction}
                aria-label={`Restore ${named(row)}`}
                title={`Put ${named(row)} back in the library`}
                disabled={restoring.has(row.bookId)}
                aria-busy={restoring.has(row.bookId)}
                onClick={() => {
                  startRestoring(row.bookId)
                  /* Both failure shapes release the row — a throw before the
                     promise exists never reaches `.finally`, and the reader
                     would be left with a dead button on the surface that
                     exists to undo a deletion. Reporting is the caller's;
                     `App` puts the message above the list. */
                  try {
                    void Promise.resolve(onRestore(row.bookId))
                      .catch(() => {})
                      .finally(() => doneRestoring(row.bookId))
                  } catch {
                    doneRestoring(row.bookId)
                  }
                }}
              >
                <RotateCcw size={ICON.control} strokeWidth={ICON.stroke} aria-hidden />
                {restoring.has(row.bookId) ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          ))
        )}
      </div>
    </OverlaySheet>
  )
}
