import { useCallback, useMemo, useRef, useState } from 'react'
import {
  EMPTY,
  branchWithoutOrigin,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  pushOrigin,
  type JumpStack,
  type Place,
} from '../../core/jumpStack'

/**
 * The jump stack, as UI state.
 *
 * `core/jumpStack` owns what a jump IS; this owns when one happened and where
 * the reader was. It is a hook rather than a store because the stack has the
 * App's lifetime exactly — a jump history that survived a relaunch would offer
 * ⌘[ back into a book the reader closed days ago — and because every push site
 * is a UI event.
 */

/**
 * Somewhere to go.
 *
 * A STRING IS THE OPEN BOOK, a `Place` is any book. The string form is what
 * foliate's `goTo` already takes and what every panel already passes — a CFI
 * from a search hit or a mark, an href from a table-of-contents entry, and the
 * renderer resolves either. The `Place` form is what a cross-book row needs
 * (WI-12.2) and what the stack always stores, because a CFI with no book id
 * names nothing once more than one book is in play.
 */
export type JumpTarget = string | Place

export interface JumpsDeps {
  /**
   * Where the reader is, as a `Place`, or null when that cannot be pinned
   * down. The session's answer, not the host's — see `jumpStack.goBack`.
   */
  placeHere: () => Place | null
  /**
   * Go there, and say whether it was ACCEPTED.
   *
   * The boolean is load-bearing. The host can refuse — a cross-book target
   * whose book left the shelf between the row being drawn and the row being
   * clicked has nowhere to go — and the stack must not move for a navigation
   * that did not happen. It used to be mutated first and unconditionally, so a
   * refused jump still cleared `forward` and recorded an origin the reader
   * never left, and a refused ⌘[ still popped an entry without moving.
   */
  navigate: (target: JumpTarget) => boolean
}

export interface JumpsView {
  readonly canBack: boolean
  readonly canForward: boolean
  /**
   * Navigate somewhere NON-LINEAR, recording the departure.
   *
   * Everything that is not a page turn goes through this, and it is handed to
   * the side pane as one prop so every panel gets the push by construction.
   * Five call sites each remembering to push is five places for the sixth to
   * forget.
   */
  jumpTo: (target: JumpTarget) => void
  /**
   * Record a departure THE CALLER IS NOT PERFORMING.
   *
   * A link inside the book navigates itself: foliate calls `goTo` unless the
   * `link` event is cancelled, so the host records where the reader was and
   * then stays out of the way. Going through `jumpTo` here would navigate a
   * second time to the same place — once by us, once by foliate — which is a
   * page turn the reader did not ask for and a duplicate entry in the stack.
   */
  record: () => void
  back: () => void
  forward: () => void
}

export function useJumps({ placeHere, navigate }: JumpsDeps): JumpsView {
  const [stack, setStackState] = useState<JumpStack>(EMPTY)
  /**
   * The ref is the source of truth; the state is a copy for rendering.
   *
   * Not a functional `setState`: the navigation is a side effect and an updater
   * that performs one runs twice under StrictMode, which would turn every ⌘[
   * into two. `useBook` holds its generation the same way and for a related
   * reason — a value read during render is a value that can be stale by the
   * time an event handler uses it.
   */
  const stackRef = useRef(stack)
  const setStack = useCallback((next: JumpStack) => {
    stackRef.current = next
    setStackState(next)
  }, [])

  /**
   * Record a departure. The BRANCH is unconditional; only the origin is not.
   *
   * A place that cannot be pinned down is not recorded — pushing a half-formed
   * origin would give the reader a ⌘[ that lands somewhere they have never
   * been. But the jump still abandons whatever was ahead, so `forward` is
   * cleared either way. See `branchWithoutOrigin`.
   */
  const branch = useCallback(() => {
    const origin = placeHere()
    setStack(
      origin ? pushOrigin(stackRef.current, origin) : branchWithoutOrigin(stackRef.current),
    )
  }, [placeHere, setStack])

  const jumpTo = useCallback(
    (target: JumpTarget) => {
      /* NAVIGATE FIRST, then move the stack. The host can refuse, and a stack
         that recorded a departure the reader never made is worse than one that
         missed a jump: ⌘[ would take them somewhere they had not been. */
      if (!navigate(target)) return
      branch()
    },
    [branch, navigate],
  )

  const record = useCallback(() => {
    /* The navigation is foliate's and has already been allowed to proceed —
       see `record`'s doc. There is nothing to accept or refuse. */
    branch()
  }, [branch])

  const back = useCallback(() => {
    const step = goBack(stackRef.current, placeHere())
    if (!step) return
    if (!navigate(step.to)) return
    setStack(step.stack)
  }, [navigate, placeHere, setStack])

  const forward = useCallback(() => {
    const step = goForward(stackRef.current, placeHere())
    if (!step) return
    if (!navigate(step.to)) return
    setStack(step.stack)
  }, [navigate, placeHere, setStack])

  return useMemo<JumpsView>(
    () => ({
      canBack: canGoBack(stack),
      canForward: canGoForward(stack),
      jumpTo,
      record,
      back,
      forward,
    }),
    [stack, jumpTo, record, back, forward],
  )
}
