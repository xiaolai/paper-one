// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useJumps, type JumpTarget, type JumpsView } from './useJumps'
import type { Place } from '../../core/jumpStack'

/**
 * The stack as the app drives it.
 *
 * `core/jumpStack` proves the rules; this proves the three verbs are wired to
 * them — and, in particular, the distinction that is easy to get wrong:
 * `jumpTo` navigates and `record` does not, because a link inside the book
 * navigates itself.
 */

afterEach(cleanup)

const at = (cfi: string, bookId = 'book-1'): Place => ({ bookId, cfi })

/** Mount the hook and expose it, with a controllable `placeHere`. */
function mount(initial: Place | null = at('start')) {
  /** Accepts by default; a test flips `accept` to exercise a refusal. */
  let accept = true
  const navigate = vi.fn<(target: JumpTarget) => boolean>(() => accept)
  let here: Place | null = initial
  const api: { current: JumpsView | null } = { current: null }

  function Probe() {
    api.current = useJumps({ placeHere: () => here, navigate })
    return null
  }
  render(<Probe />)
  return {
    navigate,
    refuseNext: () => {
      accept = false
    },
    acceptAgain: () => {
      accept = true
    },
    jumps: () => api.current!,
    /** Move the reader, as a relocate would. */
    standAt: (place: Place | null) => {
      here = place
    },
  }
}

describe('jumpTo', () => {
  it('records where the reader was, then navigates', () => {
    const { jumps, navigate, standAt } = mount(at('a'))
    act(() => jumps().jumpTo('target-href'))
    expect(navigate).toHaveBeenCalledWith('target-href')
    expect(jumps().canBack).toBe(true)

    standAt(at('b'))
    act(() => jumps().back())
    /* The place recorded was the ORIGIN — where they were when they jumped —
       not the destination they asked for. */
    expect(navigate).toHaveBeenLastCalledWith(at('a'))
  })

  it('navigates without recording when the place cannot be pinned down', () => {
    /* Pushing a half-formed origin would give the reader a ⌘[ that lands
       somewhere they have never been, which is worse than one that is
       unavailable. */
    const { jumps, navigate } = mount(null)
    act(() => jumps().jumpTo('somewhere'))
    expect(navigate).toHaveBeenCalledWith('somewhere')
    expect(jumps().canBack).toBe(false)
  })
})

describe('record', () => {
  it('pushes WITHOUT navigating, which is what an internal link needs', () => {
    /* THE DISTINCTION THIS HOOK EXISTS TO KEEP. foliate navigates a book's own
       link itself unless the `link` event is cancelled — so going through
       `jumpTo` here would move the reader twice and stack the origin twice. */
    const { jumps, navigate } = mount(at('a'))
    act(() => jumps().record())
    expect(navigate).not.toHaveBeenCalled()
    expect(jumps().canBack).toBe(true)
  })
})

describe('back and forward', () => {
  it('walk the stack, and stop rather than throwing at either end', () => {
    const { jumps, navigate, standAt } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))

    act(() => jumps().back())
    expect(navigate).toHaveBeenLastCalledWith(at('a'))
    expect(jumps().canBack).toBe(false)
    expect(jumps().canForward).toBe(true)

    const calls = navigate.mock.calls.length
    act(() => jumps().back())
    // Nothing behind: no navigation, no throw.
    expect(navigate.mock.calls).toHaveLength(calls)

    standAt(at('a'))
    act(() => jumps().forward())
    expect(navigate).toHaveBeenLastCalledWith(at('b'))
    expect(jumps().canForward).toBe(false)
  })

  it('does one thing per press, not two', () => {
    /* The navigation is a side effect, and an updater that performs one runs
       TWICE under StrictMode — which would turn every ⌘[ into two. The hook
       holds the stack in a ref for exactly this reason. */
    const { jumps, navigate, standAt } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    navigate.mockClear()
    act(() => jumps().back())
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})

describe('a navigation the host refuses', () => {
  it('leaves the stack exactly where it was', () => {
    /* The stack used to move first and unconditionally, so a refused jump —
       a cross-book target whose book left the shelf between the row being
       drawn and the row being clicked — still cleared `forward` and recorded
       an origin the reader never left. */
    const { jumps, standAt, refuseNext } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    act(() => jumps().back())
    expect(jumps().canForward).toBe(true)

    refuseNext()
    act(() => jumps().jumpTo('refused'))
    expect(jumps().canForward).toBe(true)
    expect(jumps().canBack).toBe(false)
  })

  it('does not pop a back entry for a move that did not happen', () => {
    const { jumps, standAt, refuseNext } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    refuseNext()
    act(() => jumps().back())
    expect(jumps().canBack).toBe(true)
  })
})

describe('a jump whose origin cannot be pinned down', () => {
  it('still abandons what was ahead', () => {
    /* `pushOrigin` does two things — record, and branch — and skipping the
       call when `placeHere()` is null skipped BOTH. Go back once so `forward`
       holds a place, then jump again while a section is still rendering: the
       stack went untouched and ⌘] walked back into the branch that jump had
       just abandoned. */
    const { jumps, standAt } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    act(() => jumps().back())
    expect(jumps().canForward).toBe(true)

    standAt(null)
    act(() => jumps().jumpTo('somewhere-new'))
    expect(jumps().canForward).toBe(false)
  })
})

describe('what does not go on the stack', () => {
  it('is anything nobody called a verb on — the stack only moves when asked', () => {
    /* A PAGE TURN IS NOT A JUMP, and this is the structural half of that
       claim: nothing in the paging path holds this hook. `next`, `prev`,
       `goLeft`, `goRight`, the wheel and the ruler all go through `useBook`,
       which does not know the stack exists. The hook cannot record what it is
       never told about. */
    const { jumps } = mount(at('a'))
    expect(jumps().canBack).toBe(false)
    expect(jumps().canForward).toBe(false)
  })
})
