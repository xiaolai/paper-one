import { messageOf } from '../../../kernel'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One asynchronous act at a time, with its own busy flag and its own line of
 * trouble — the state a control needs, and nothing another control shares.
 *
 * ⚠️ **ONE PER CONTROL, NOT ONE PER PANE.** Each pane kept a single `busy`
 * and a single trouble line for everything on it, so a note that would not
 * save disabled the stars, a person who could not be removed was reported
 * beside the offer link, and a slow list write held the shelf switch. An
 * act here blocks and reports only the controls that asked for this one;
 * two controls that SHOULD wait on each other are handed the same one.
 *
 * `run` answers whether the act landed, so a form knows whether to clear.
 * Nothing is set into a component that has gone — an act begun on a row that
 * unmounted, because the book changed or the person was removed, reports
 * nowhere, and its `after` is not run.
 */
export interface Action {
  readonly busy: boolean
  /** What the last act said when it failed, with `said` in front; cleared when the next begins. */
  readonly trouble: string | null
  /** Run `what`; on success run `after` — a refresh, usually — with the act still busy. Answers whether `what` landed. */
  run(what: () => Promise<unknown>, after?: () => Promise<unknown> | void): Promise<boolean>
  /** Whether the component that asked is still mounted — for an act with a second step that must not run for one that has gone. */
  alive(): boolean
}

export function useAction(said: string): Action {
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  /** Cleared on unmount, so nothing sets state into a gone component. */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const run = useCallback(
    async (what: () => Promise<unknown>, after?: () => Promise<unknown> | void): Promise<boolean> => {
      setBusy(true)
      setTrouble(null)
      try {
        await what()
        if (live.current && after) await after()
        return true
      } catch (cause) {
        if (live.current) setTrouble(`${said} ${messageOf(cause)}`)
        return false
      } finally {
        // Stryker disable next-line ConditionalExpression: a component that has gone draws nothing, so a flag set into it is read by nobody.
        if (live.current) setBusy(false)
      }
    },
    [said],
  )
  const alive = useCallback(() => live.current, [])
  return { busy, trouble, run, alive }
}
