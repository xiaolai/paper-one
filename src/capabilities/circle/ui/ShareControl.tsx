import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, offersShare, offersUnshare, shareAbsentBecause, type Highlight } from '../../../kernel'
import type { SharePort, ShareState } from '../lib/sharing'

/**
 * The share control, on a mark's own row — WI-23.A1's surface.
 *
 * Drawn by Marginalia under the note of every annotation, through the
 * `markControls` seam. It draws one of three things, and never a disabled
 * button:
 *
 *  - **Share**, and **Share with note** when the mark has one — the note is a
 *    separate choice per share, and the default is without;
 *  - **Withdraw**, when this mark is out;
 *  - the REASON Share is absent, when it is. *"Absent, not disabled, and
 *    always with a reason"* is `surfaces.md`'s rule, and a greyed Share with
 *    no explanation is indistinguishable from a broken app.
 *
 * Nothing at all before the first answer, and nothing on a composition where
 * the circle has not started: a row with no control is the honest rendering
 * of a device that cannot share, and a spinner under every note would be
 * noise on the one panel the reader browses their own writing in.
 */

export interface ShareControlProps {
  readonly mark: Highlight
  /** `null` before the capability has started, which draws nothing. */
  readonly port: SharePort | null
}

export function ShareControl({ mark, port }: ShareControlProps) {
  const [state, setState] = useState<ShareState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  // Stryker disable next-line BooleanLiteral: the mark effect sets it false before anything is drawn, so the start value is never seen.
  const [busy, setBusy] = useState(false)
  /**
   * Which read is newest, so a slow answer cannot overwrite a later one.
   *
   * No unmount guard beside it, deliberately: React 19 drops a state update
   * on an unmounted component silently, so a `live` ref here would be a
   * check nothing can observe — and a check nothing can observe is one a
   * mutation test rightly refuses.
   */
  const read = useRef(0)
  /* Which mark the row is showing NOW, so an act started on one mark cannot
     report on the next: Marginalia reuses the row when the list moves. */
  const shown = useRef(mark.id)
  shown.current = mark.id

  const refresh = useCallback(async () => {
    /* Stryker disable next-line ConditionalExpression: with no port the row
       draws nothing whatever this does — a null port is refused at render —
       so a `port.state` that throws here reaches a failure nobody can see. */
    if (port === null) return
    /* Stryker disable next-line UpdateOperator: `--` mints values that are
       just as distinct per read, and distinct is all the comparison below
       needs. Not an ordering — a NAME for this read. */
    const mine = ++read.current
    try {
      const now = await port.state(mark)
      if (read.current !== mine) return
      setState(now)
      setFailure(null)
    } catch (cause) {
      if (read.current !== mine) return
      /* SHOWN, NOT SWALLOWED. A row that fails to read the store and draws
         "Share" is offering to publish over a file it could not read. */
      setFailure(cause instanceof Error ? cause.message : String(cause))
    }
    /* The mark's IDENTITY, not the object: Marginalia hands a fresh row on
       every store change, and re-reading the file for a note edit would be
       one read per keystroke across every shared mark. */
  }, [port, mark.bookId, mark.id])

  useEffect(() => {
    /* A new mark or port starts from nothing: what the previous one answered
       is not true of this one, and drawing it until the read lands offered
       the wrong buttons for a moment. */
    setState(null)
    // Stryker disable next-line CallExpression: the read that follows clears a failure on success and replaces it on failure; clearing here only spares one frame.
    setFailure(null)
    setTrouble(null)
    setBusy(false)
    void refresh()
    return port?.subscribe(() => void refresh())
  }, [port, refresh])

  /* Stryker disable next-line ConditionalExpression: with no port nothing
     ever sets `state`, so the check two lines down returns for it too. This
     one exists so `port` narrows for the handlers below. */
  if (port === null) return null

  if (failure !== null) {
    return <p className={CAPABILITY_UI.hint}>Paper could not read what you have shared. {failure}</p>
  }
  if (state === null) return null

  /* An act that failed is said beside the buttons, which stay: the reader's
     way to try again is the button they just pressed. A READ that failed is
     the other kind of news, and hides them, because there is nothing true to
     draw them from. */
  const act = async (what: () => Promise<void>) => {
    const marked = mark.id
    setBusy(true)
    setTrouble(null)
    try {
      await what()
    } catch (cause) {
      if (shown.current === marked) setTrouble(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (shown.current === marked) setBusy(false)
    }
  }

  const { publishability, published } = state
  const hasNote = mark.note.trim() !== ''

  return (
    <div className={CAPABILITY_UI.actions}>
      {published ? <span className={CAPABILITY_UI.value}>Shared with your circle</span> : null}
      {!published && offersShare(publishability) ? (
        <>
          <button
            type="button"
            className={CAPABILITY_UI.button}
            disabled={busy}
            onClick={() => void act(() => port.share(mark, false))}
          >
            Share
          </button>
          {/* Offered only when there is a note to share, and never chosen for
              the reader: the passage and what they thought of it are two acts. */}
          {hasNote ? (
            <button
              type="button"
              className={CAPABILITY_UI.button}
              disabled={busy}
              onClick={() => void act(() => port.share(mark, true))}
            >
              Share with note
            </button>
          ) : null}
        </>
      ) : null}
      {offersUnshare(publishability, published) ? (
        <button
          type="button"
          className={CAPABILITY_UI.button}
          disabled={busy}
          onClick={() => void act(() => port.unshare(mark))}
        >
          Withdraw
        </button>
      ) : null}
      {!published && !offersShare(publishability) ? (
        <span className={CAPABILITY_UI.hint}>{shareAbsentBecause(publishability)}</span>
      ) : null}
      {trouble === null ? null : <span className={CAPABILITY_UI.hint}>That did not go through. {trouble}</span>}
    </div>
  )
}
