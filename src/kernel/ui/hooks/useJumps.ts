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
   *
   * ⚠️ **AND AN ACCEPTED JUMP CAN STILL FAIL, SECONDS LATER.** A cross-book
   * jump answers `true` on the assumption that the book it just asked for will
   * open, which is a read off disk — missing content, an origin that has moved.
   * The host already rolls back what it committed on that assumption (see
   * `App`'s `openRollback`); the STACK was committed on the same assumption and
   * was not rolled back with it, so ⌘[ offered a way back from a jump that
   * never happened, and a failed Back consumed its destination without moving
   * (2026-09-13 audit, #94).
   *
   * `revert` is that rollback's other half. Calling it is always safe: it puts
   * the stack back only if it is still the one this navigation left, so a jump
   * made since is never undone by an older one's failure.
   */
  navigate: (target: JumpTarget, revert: () => void) => boolean
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
  jumpTo: (target: JumpTarget) => boolean
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

  /**
   * How many times the stack has been moved — the identity a revert is guarded
   * on.
   *
   * ⚠️ **NOT THE STACK OBJECT, AND THAT WAS THE FIRST SPELLING.** `pushOrigin`
   * returns the SAME stack when the new origin equals the one on top and there
   * is nothing ahead — so two jumps made from one place leave two navigations
   * holding an identical stack, and an object comparison cannot tell them
   * apart. Measured: the older jump's revert then wiped an origin the newer one
   * had also recorded. A count cannot collide.
   *
   * ⚠️ **AND IT COUNTS EVERY MOVE, BECAUSE IT COUNTED ONLY NAVIGATIONS.** The
   * count was advanced by `jumpTo`, `back` and `forward`, and `record` — an
   * in-book link — moved the stack without it. So a cross-book jump still
   * opening kept its claim over a stack a later link had grown, and its failure
   * restored the stack from before the link, erasing that history
   * (2026-09-14, #94 regressed). Advanced HERE, in the one function every move
   * goes through, a path that moves the stack cannot forget it — a revert
   * included, which retires every other outstanding one.
   */
  const moves = useRef(0)
  /* Stryker disable ArrayDeclaration: its empty dependency list is the only
     array in it, and it reads only refs and the state setter, none of which
     changes — a list holding one constant re-creates it no more often. */
  const setStack = useCallback((next: JumpStack) => {
    // Stryker disable next-line AssignmentOperator: the count is only ever compared for equality, with a value it held after a move, and a count stepping down never repeats any more than one stepping up does.
    moves.current += 1
    stackRef.current = next
    setStackState(next)
  }, [])
  // Stryker restore ArrayDeclaration

  /**
   * Record a departure. The BRANCH is unconditional; only the origin is not.
   *
   * A place that cannot be pinned down is not recorded — pushing a half-formed
   * origin would give the reader a ⌘[ that lands somewhere they have never
   * been. But the jump still abandons whatever was ahead, so `forward` is
   * cleared either way. See `branchWithoutOrigin`.
   */
  const branched = useCallback((): JumpStack => {
    const origin = placeHere()
    return origin ? pushOrigin(stackRef.current, origin) : branchWithoutOrigin(stackRef.current)
  }, [placeHere])

  /**
   * The undo a navigation hands to the host — see `JumpsDeps.navigate`.
   *
   * READ LAZILY: `mine` is taken when the stack actually moves, which is after
   * the host has been handed the revert. Before that, and after any later move
   * of the stack — a navigation, a recorded link, another revert — reverting
   * does nothing, so a slow open's failure can only ever undo its own jump.
   *
   * ⚠️ **AND SO IS WHAT IT PUTS BACK, WHICH WAS COPIED BEFORE `navigate`**
   * (2026-09-14, #94, round 4). `navigate` is where the host starts the open,
   * and starting one RETIRES the rollback the last open left — so an older
   * jump still opening has its revert run, and its entry taken off the stack,
   * before `navigate` returns. The copy this took beforehand still held that
   * entry, and this navigation's own failure put it back: ⌘[ offering a way
   * back from a jump whose rollback had already run. The stack is read in
   * `move` now, after `navigate`, as the one this navigation replaces.
   */
  /* Stryker disable ArrayDeclaration: `[setStack]` is the only array in it, and
     `setStack` is memoised over nothing and never changes — listing it
     re-creates nothing, and leaving it out keeps the same one. */
  const undoTo = useCallback(() => {
    let claim: { readonly mine: number; readonly before: JumpStack } | null = null
    return {
      revert: () => {
        if (claim !== null && claim.mine === moves.current) setStack(claim.before)
      },
      /* This navigation's own move, and the claim on it — called once
         `navigate` has accepted, so whatever it retired is already undone. */
      move: (next: JumpStack) => {
        const before = stackRef.current
        setStack(next)
        claim = { mine: moves.current, before }
      },
    }
  }, [setStack])
  // Stryker restore ArrayDeclaration

  const jumpTo = useCallback(
    (target: JumpTarget) => {
      /* NAVIGATE FIRST, then move the stack. The host can refuse, and a stack
         that recorded a departure the reader never made is worse than one that
         missed a jump: ⌘[ would take them somewhere they had not been.
         The boolean is what lets the host show a way back only when there is
         one — a "back to…" line after a refused jump would be a lie. */
      const undo = undoTo()
      if (!navigate(target, undo.revert)) return false
      undo.move(branched())
      return true
    },
    [branched, navigate, undoTo],
  )

  const record = useCallback(() => {
    /* The navigation is foliate's and has already been allowed to proceed —
       see `record`'s doc. There is nothing to accept or refuse. */
    setStack(branched())
  }, [branched, setStack])

  /* A FAILED BACK IS THE WORST OF THE THREE: it CONSUMES the entry it was
     going to, so without the undo the reader loses the way back as well as the
     move. See `JumpsDeps.navigate`.

     `step` IS READ BEFORE `navigate`, and has to be: `to` is what it asks for.
     Only the undo's copy of the stack moved to after it. */
  const back = useCallback(() => {
    const step = goBack(stackRef.current, placeHere())
    if (!step) return
    const undo = undoTo()
    if (!navigate(step.to, undo.revert)) return
    undo.move(step.stack)
  }, [navigate, placeHere, undoTo])

  const forward = useCallback(() => {
    const step = goForward(stackRef.current, placeHere())
    if (!step) return
    const undo = undoTo()
    if (!navigate(step.to, undo.revert)) return
    undo.move(step.stack)
  }, [navigate, placeHere, undoTo])

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
