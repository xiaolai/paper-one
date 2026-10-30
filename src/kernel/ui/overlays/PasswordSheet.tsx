import { useEffect, useState, type FormEvent } from 'react'
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
   * scrim.
   *
   * A DOCUMENT LISTENER IN THE CAPTURE PHASE, not a handler on the form: the
   * sheet's focus fallback can land focus on the DIALOG itself (jsdom always,
   * a click on the sheet's padding sometimes), and a keydown targeted there
   * never reaches a descendant form's handler — so Escape sailed past the
   * cancel and peeled the host's topmost layer instead, leaving the password
   * request standing over a page that had just changed. While this sheet is
   * mounted it is modal — everything behind it is inert — so every Escape in
   * the document belongs to it. The same scope `OverlaySheet` uses for Tab. */
  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [onCancel])

  return (
    <OverlaySheet label="Password for this PDF" onDismiss={onCancel}>
      <form onSubmit={submit}>
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
