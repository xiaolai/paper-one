import { RotateCcw } from 'lucide-react'
import { coverTintFor } from '../../core/bookAccent'
import { timeLeft, type TrashedBook } from '../../core/bookTrash'
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
  /** Null while the first read is in flight; an empty array is an empty trash. */
  readonly loading: boolean
  readonly onRestore: (bookId: string) => void
  readonly onDismiss: () => void
  /** Read once by the caller, so every row measures against one now. */
  readonly now: number
}

export function TrashSheet({ rows, loading, onRestore, onDismiss, now }: TrashSheetProps) {
  return (
    <OverlaySheet label="Removed books" onDismiss={onDismiss}>
      <div className={styles.list}>
        {loading ? (
          <div className={styles.empty}>Reading the trash…</div>
        ) : rows.length === 0 ? (
          /* THE EMPTY STATE SAYS WHAT THE PLACE IS FOR, not just that it is
             empty: a reader who opened this looking for a book that vanished
             needs to know they are in the right room and it is not here. */
          <div className={styles.empty}>
            Nothing removed.
            <br />
            Books you remove wait here for two weeks.
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
                {row.title}
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
                title={`Put ${row.title} back in the library`}
                onClick={() => onRestore(row.bookId)}
              >
                <RotateCcw size={ICON.control} strokeWidth={ICON.stroke} aria-hidden />
                Restore
              </button>
            </div>
          ))
        )}
      </div>
    </OverlaySheet>
  )
}
