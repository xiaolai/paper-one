import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { ICON } from '../../core/metrics'
import { OverlaySheet } from './OverlaySheet'
import styles from './Overlay.module.css'

/**
 * The password a protected PDF asks for.
 *
 * WHY IT EXISTS. pdf.js asks its caller for a password through `onPassword`,
 * and nothing set one — so its own answer to "this needs a password" was to
 * reject with the sentence it keeps for that case, "No password given", which
 * the reader then read as the app's verdict on a file it had never been asked
 * about. This is the asking.
 *
 * TWO STATES, NOT ONE. pdf.js asks again after a wrong password, with a
 * different reason, and a sheet that showed the same words both times would
 * have the reader typing the same wrong password twice before wondering. So
 * the second asking says the first answer was wrong.
 *
 * CANCEL CLOSES THE BOOK, by name. A prompt left unanswered would leave
 * pdf.js's loading task — and the worker it started — waiting for an answer
 * that is never coming; the owner turns a cancel into a refusal the reader can
 * read, and the task is torn down with it.
 */
export interface PasswordSheetProps {
  /** The file, as the reader knows it. */
  readonly name: string
  /** Whether this is the first asking or the one after a wrong answer. */
  readonly reason: 'needed' | 'wrong'
  readonly onSubmit: (password: string) => void
  readonly onCancel: () => void
}

export function PasswordSheet({ name, reason, onSubmit, onCancel }: PasswordSheetProps) {
  const [draft, setDraft] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    /* Nothing to try. pdf.js would only ask again, one round-trip later, with
       the reader none the wiser about what happened. */
    if (draft.length === 0) return
    onSubmit(draft)
  }

  /* Esc is a cancel HERE, and stops here. `OverlaySheet` leaves dismissal to
   * its owner because §11 says Esc takes the topmost layer only — and this
   * sheet is not in the host's overlay stack, so the host's own Escape would
   * otherwise ALSO fire and peel a layer the reader could not see under the
   * scrim. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }

  return (
    <OverlaySheet label="Password for this PDF" onDismiss={onCancel}>
      <form onSubmit={submit} onKeyDown={onKeyDown}>
        <div className={styles.field}>
          <KeyRound size={ICON.control} strokeWidth={ICON.stroke} aria-hidden />
          <input
            className={styles.input}
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className={styles.list}>
          <div className={styles.row} data-static="true">
            <span className={styles.rowLabel}>
              {reason === 'wrong' ? 'That password was wrong.' : `“${name}” is protected by a password.`}
              <span className={styles.rowSub}>
                {reason === 'wrong'
                  ? 'Try again, or cancel to leave the book closed.'
                  : 'Enter it to open the book, or cancel to leave it closed.'}
              </span>
            </span>
            <button type="button" className={styles.rowAction} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={styles.rowAction}>
              Unlock
            </button>
          </div>
        </div>
      </form>
    </OverlaySheet>
  )
}
