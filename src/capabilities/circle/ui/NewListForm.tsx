import { useState } from 'react'
import { CAPABILITY_UI } from '../../../kernel'

/**
 * The one way a list starts — WI-23.E1 — on the book's surface and on the
 * Circle screen alike. A title, trimmed, and nothing until there is one.
 */
export function NewListForm({
  busy,
  placeholder,
  onStart,
}: {
  readonly busy: boolean
  readonly placeholder: string
  /** Called with the trimmed title; resolves once the list exists. Rejects to keep the title for another try. */
  /** Start the list. Resolving `false` means it did not start — the title stays for another try. */
  readonly onStart: (title: string) => Promise<boolean | void>
}) {
  const [title, setTitle] = useState('')
  const trimmed = title.trim()
  return (
    <div className={CAPABILITY_UI.row}>
      <input
        type="text"
        className={CAPABILITY_UI.field}
        aria-label="New list"
        placeholder={placeholder}
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button
        type="button"
        className={CAPABILITY_UI.button}
        disabled={busy || trimmed === ''}
        onClick={() =>
          void onStart(trimmed).then(
            /* Cleared only once the list HAS started: the panes' act helpers
               catch a failure and resolve, so a resolved promise is not yet
               a started list — its answer is. */
            (started) => {
              if (started !== false) setTitle('')
            },
            () => undefined,
          )
        }
      >
        Start list
      </button>
    </div>
  )
}
