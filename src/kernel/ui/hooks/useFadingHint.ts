import { useEffect, useRef } from 'react'

/**
 * A line that shows for a few seconds and then takes itself away.
 *
 * The reader's "← Back to Loomings" is the one this was written for: a thing
 * that WORKED, offering to be undone, which has no business waiting to be
 * dismissed. It is here rather than inline in the screen because the timing is
 * where all the defects were, and a six-line effect buried in a
 * thousand-line component cannot be tested without mounting the whole reader.
 *
 * TWO WAYS TO GET THIS WRONG, both of which shipped:
 *
 * - **Keyed on the callback.** The host passes an inline `onDone`, which is a
 *   new function every render, and a reader turning pages re-renders
 *   constantly — so the timer restarted on every page turn and the line never
 *   went away. The callback goes through a ref for that reason: it is read
 *   when the timer fires, never depended on.
 * - **Keyed on the message.** The label is a chapter name, so two hints raised
 *   out of the SAME chapter are the same string, React bails out of the
 *   identical `setState`, and the effect never re-runs — the second hint
 *   inherits the first one's deadline and can vanish the instant it appears.
 *   Two footnote links in one chapter is all it takes.
 *
 * Hence the nonce, and hence it is the only thing this keys on. It counts
 * OCCASIONS, not content, which is what the timer is actually about; the text
 * is the caller's to render and none of this hook's business.
 */
export interface FadingHint {
  /**
   * Which showing this is — bumped by the host every time it raises the hint,
   * `null` when none is up.
   *
   * A COUNTER RATHER THAN THE MESSAGE. See above: the message repeats, and a
   * repeat is a new hint with a new deadline.
   */
  readonly nonce: number | null
  /** How long it stays, in milliseconds. */
  readonly after: number
  /** Called when it has had its time. Read at the moment it fires. */
  readonly done: (() => void) | undefined
}

export function useFadingHint({ nonce, after, done }: FadingHint): void {
  /* THROUGH A REF, so the timer is keyed on the OCCASION and not on the
     callback's identity — see the note above. */
  const fade = useRef(done)
  fade.current = done
  useEffect(() => {
    if (nonce === null) return
    const timer = setTimeout(() => fade.current?.(), after)
    /* CLEARED ON THE WAY OUT, which is also what makes a repeat restart rather
       than run two timers: the previous showing's timeout is discarded before
       the next one is set, so the older deadline can never clear the newer
       line. */
    return () => clearTimeout(timer)
  }, [nonce, after])
}
