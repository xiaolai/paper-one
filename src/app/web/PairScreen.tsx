import { useCallback, useState } from 'react'
import styles from './PairScreen.module.css'
import { normalizeCode, submitCode, type SubmitOutcome } from './session'

/**
 * The first thing a browser sees: six digits, typed.
 *
 * There is no QR here and no camera permission, which was the point of the
 * whole auth decision. The shelf shows six digits; a human types them.
 *
 * ## What each refusal says, and why they are not one message
 *
 * The shelf answers `401` for both a wrong code and a stale one so a guess
 * cannot learn which it was — but it separates the cases whose FIX differs, and
 * this is where that pays off. "No code is showing" and "that was not the code"
 * send a person to two different places; collapsing them into "could not sign
 * in" would have someone hunting for a typo while the shelf sits with nothing
 * on screen.
 *
 * ## Why the field is one input rather than six boxes
 *
 * Six boxes look like the design of a code entry and are worse to use: they
 * fight paste, they fight the software keyboard's delete, and they need focus
 * management that screen readers then have to be told about. One input with
 * `inputMode="numeric"` and `autocomplete="one-time-code"` gets the numeric
 * keypad, accepts a pasted code with spaces or dashes in it, and needs no
 * focus choreography at all.
 */

/** The exact words for each refusal. Kept together so their voice matches. */
function say(outcome: Exclude<SubmitOutcome, { kind: 'connected' }>): string {
  switch (outcome.kind) {
    case 'wrong':
      return 'That was not the code. Check the digits on your computer and try again.'
    case 'no-code-showing':
      return 'No code is showing. On your computer, open Paper → Settings → Devices, and choose “Show code”.'
    case 'expired':
      return 'That code has expired. Ask your computer for a new one.'
    case 'no-attempts-left':
      return 'Too many tries for that code. Ask your computer for a new one.'
    case 'unreachable':
      return 'Your library is not answering. It may be asleep, or off the network.'
  }
}

export interface PairScreenProps {
  readonly onConnected: () => void
  /** Injected so a test can drive the screen without a server. */
  readonly submit?: typeof submitCode
}

export function PairScreen({ onConnected, submit = submitCode }: PairScreenProps) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (code.length !== 6 || busy) return
      setBusy(true)
      /* The previous problem is cleared BEFORE the request, not after it. Left
       * up, it reads as the verdict on the attempt now in flight. */
      setProblem(null)
      const outcome = await submit(code)
      setBusy(false)
      if (outcome.kind === 'connected') {
        onConnected()
        return
      }
      setProblem(say(outcome))
      /* The field is cleared on a refusal so the next attempt starts clean —
       * six digits is little enough to retype, and editing a wrong one in
       * place is how a second wrong attempt gets spent. */
      setCode('')
    },
    [busy, code, onConnected, submit],
  )

  return (
    <form className={styles.screen} onSubmit={onSubmit}>
      <h1 className={styles.title}>Connect to your library</h1>
      <p className="paper-cap-hint">
        On the computer holding your books, open Paper → Settings → Devices, and choose “Show code”.
      </p>

      {/* NO PLACEHOLDER, and its absence is deliberate. `000000` in a code
          field reads as a typed value rather than a hint — six zeros ARE a
          possible code — and it left a centred hint beside a caret WebKit
          parks at the field's left edge, which is what the empty state looked
          wrong for. An empty field that looks empty says more. */}

      <input
        className={`paper-cap-field ${styles.code}`}
        value={code}
        onChange={(event) => setCode(normalizeCode(event.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        /* `aria-label` rather than a visible label: the heading and the
         * paragraph above already say what this is, and a third statement of
         * it would be read out as repetition. */
        aria-label="The six-digit code shown on your computer"
        aria-invalid={problem !== null}
        aria-describedby={problem === null ? undefined : 'pair-problem'}
        autoFocus
        disabled={busy}
        data-disabled={busy ? 'true' : undefined}
      />

      <button className={`paper-cap-button paper-cap-button-primary ${styles.submit}`} type="submit" disabled={code.length !== 6 || busy}
        data-disabled={code.length !== 6 || busy ? 'true' : undefined}
      >
        {busy ? 'Connecting…' : 'Connect'}
      </button>

      {problem !== null && (
        /* `role="alert"` so it is announced when it appears. The reader may be
         * looking at the keyboard rather than the screen. */
        <p className={styles.problem} id="pair-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}
