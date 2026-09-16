// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useJumps, type JumpTarget, type JumpsDeps, type JumpsView } from './useJumps'
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
  const navigate = vi.fn<(target: JumpTarget, revert: () => void) => boolean>(() => accept)
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
    /** The undo handed to the nth navigation — what a host calls when the open
     *  it accepted never lands. */
    revertOf: (nth: number) => navigate.mock.calls[nth]?.[1] as () => void,
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
    expect(navigate).toHaveBeenCalledWith('target-href', expect.any(Function))
    expect(jumps().canBack).toBe(true)

    standAt(at('b'))
    act(() => jumps().back())
    /* The place recorded was the ORIGIN — where they were when they jumped —
       not the destination they asked for. */
    expect(navigate).toHaveBeenLastCalledWith(at('a'), expect.any(Function))
  })

  it('navigates without recording when the place cannot be pinned down', () => {
    /* Pushing a half-formed origin would give the reader a ⌘[ that lands
       somewhere they have never been, which is worse than one that is
       unavailable. */
    const { jumps, navigate } = mount(null)
    act(() => jumps().jumpTo('somewhere'))
    expect(navigate).toHaveBeenCalledWith('somewhere', expect.any(Function))
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
    expect(navigate).toHaveBeenLastCalledWith(at('a'), expect.any(Function))
    expect(jumps().canBack).toBe(false)
    expect(jumps().canForward).toBe(true)

    const calls = navigate.mock.calls.length
    act(() => jumps().back())
    // Nothing behind: no navigation, no throw.
    expect(navigate.mock.calls).toHaveLength(calls)

    standAt(at('a'))
    act(() => jumps().forward())
    expect(navigate).toHaveBeenLastCalledWith(at('b'), expect.any(Function))
    expect(jumps().canForward).toBe(false)

    act(() => jumps().forward())
    // Nothing ahead either: no navigation, no throw.
    expect(navigate).toHaveBeenCalledTimes(3)
    expect(jumps().canBack).toBe(true)
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

  it('reports the refusal, so the host does not offer a way back from a jump that did not happen', () => {
    /* THE RETURN LINE DEPENDS ON THIS. `App` shows "← Back to <chapter>" only
       when `jumpTo` returns true; offering a way back from a jump that never
       occurred is a worse lie than saying nothing at all. */
    const { jumps, refuseNext } = mount(at('a'))
    let accepted: boolean | undefined
    act(() => {
      accepted = jumps().jumpTo('fine')
    })
    expect(accepted).toBe(true)
    refuseNext()
    act(() => {
      accepted = jumps().jumpTo('refused')
    })
    expect(accepted).toBe(false)
  })

  it('does not pop a back entry for a move that did not happen', () => {
    const { jumps, standAt, refuseNext } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    refuseNext()
    act(() => jumps().back())
    expect(jumps().canBack).toBe(true)
  })

  /* `revert` IS ALWAYS SAFE TO CALL — `JumpsDeps.navigate` promises it — and a
     navigation the host refused never moved the stack, so there is nothing of
     its own to put back. A host rolling back every open it began, refused or
     not, must neither throw nor undo the jump before it. */
  it('lets the host revert a navigation it refused, which changes nothing', () => {
    const { jumps, navigate, refuseNext, revertOf } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    refuseNext()
    act(() => jumps().jumpTo('refused'))
    expect(navigate).toHaveBeenCalledTimes(2)

    expect(() => act(() => revertOf(1)())).not.toThrow()
    expect(jumps().canBack, 'a refused jump’s revert undid the accepted jump before it').toBe(true)

    act(() => revertOf(0)())
    expect(jumps().canBack).toBe(false)
  })
})

/**
 * THE HOST'S CALLBACKS ARE NOT STABLE, and the hook must use the ones it was
 * last rendered with. `App` builds `placeHere` over the open book and
 * `goToJump` over the shelf and the screen, so both change identity as the
 * reader moves — a verb memoised over the first render's would record where the
 * reader stood in a book they have since left, and navigate through a host
 * that no longer knows the shelf.
 */
describe('a host that renders new callbacks', () => {
  function mountWith(deps: JumpsDeps) {
    const api: { current: JumpsView | null } = { current: null }
    function Probe(props: JumpsDeps) {
      api.current = useJumps(props)
      return null
    }
    const view = render(<Probe {...deps} />)
    return {
      jumps: () => api.current!,
      rerender: (next: JumpsDeps) => view.rerender(<Probe {...next} />),
    }
  }
  const first = () => ({
    placeHere: () => at('where-the-first-render-stood'),
    navigate: vi.fn<JumpsDeps['navigate']>(() => true),
  })

  it('jumps, goes back and goes forward through the latest ones', () => {
    const stale = first()
    const { jumps, rerender } = mountWith(stale)
    let here: Place | null = at('a')
    const navigate = vi.fn<JumpsDeps['navigate']>(() => true)
    rerender({ placeHere: () => here, navigate })

    act(() => jumps().jumpTo('x'))
    expect(navigate).toHaveBeenLastCalledWith('x', expect.any(Function))

    here = at('b')
    act(() => jumps().back())
    expect(navigate, 'the origin came from the first render’s placeHere').toHaveBeenLastCalledWith(
      at('a'),
      expect.any(Function),
    )

    here = at('a-again')
    act(() => jumps().forward())
    expect(navigate, 'Back recorded where the first render stood').toHaveBeenLastCalledWith(
      at('b'),
      expect.any(Function),
    )
    expect(navigate).toHaveBeenCalledTimes(3)
    expect(stale.navigate, 'a verb navigated through the first render’s host').not.toHaveBeenCalled()
  })

  it('records an in-book link’s departure through the latest placeHere', () => {
    const stale = first()
    const { jumps, rerender } = mountWith(stale)
    rerender({ placeHere: () => at('latest'), navigate: stale.navigate })

    act(() => jumps().record())
    act(() => jumps().back())

    expect(stale.navigate).toHaveBeenCalledTimes(1)
    expect(stale.navigate, 'the link recorded where the first render stood').toHaveBeenLastCalledWith(
      at('latest'),
      expect.any(Function),
    )
  })
})

/**
 * ⚠️ **AN ACCEPTED JUMP CAN STILL FAIL.** A cross-book jump answers `true` on
 * the assumption that the book will open — a read off disk that can fail
 * seconds later — and `App` rolls back the place override and the "← Back to …"
 * line when it does not. The STACK was committed on the same assumption and was
 * not rolled back with it (2026-09-13 audit, #94).
 */
describe('a navigation the host accepted and could not finish', () => {
  it('puts the stack back when the host reverts it', () => {
    const { jumps, revertOf } = mount(at('a'))
    act(() => jumps().jumpTo(at('far', 'book-2')))
    expect(jumps().canBack).toBe(true)

    act(() => revertOf(0)())
    expect(jumps().canBack, 'a way back was offered from a jump that never happened').toBe(false)
  })

  /* AND A FAILED BACK GIVES ITS DESTINATION BACK. Back CONSUMES the entry it
     moves to, so an open that then fails used to cost the reader the way back
     as well as the move — the one press where failing silently takes something. */
  it('gives a failed Back its entry back', () => {
    const { jumps, standAt, revertOf } = mount(at('a'))
    act(() => jumps().jumpTo('x'))
    standAt(at('b'))
    act(() => jumps().back())
    expect(jumps().canBack).toBe(false)

    act(() => revertOf(1)())
    expect(jumps().canBack, 'the destination was consumed by a move that did not happen').toBe(true)
  })

  /* THE GUARD IS THE OTHER HALF. A revert that fired against a stack somebody
     else had moved would undo a jump the reader made while the first was still
     opening — which is exactly when a slow open's failure arrives. */
  it('leaves alone a stack a later jump has moved', () => {
    const { jumps, revertOf } = mount(at('a'))
    act(() => jumps().jumpTo(at('far', 'book-2')))
    act(() => jumps().jumpTo(at('nearer', 'book-3')))

    act(() => revertOf(0)())
    expect(jumps().canBack, 'an older failure undid a jump the reader had since made').toBe(true)
  })

  /* ⚠️ **A LINK INSIDE THE BOOK MOVES THE STACK TOO, AND DID NOT MOVE THE
     GUARD** (2026-09-14, #94 regressed). `record` pushed without advancing the
     count, so the jump still opening kept its claim over a stack a later link
     had grown — and its failure put back the stack from BEFORE the link. */
  it('leaves alone a stack an in-book link has moved since', () => {
    const { jumps, navigate, revertOf, standAt } = mount(at('a'))
    act(() => jumps().jumpTo(at('far', 'book-2')))
    standAt(at('before-the-link'))
    act(() => jumps().record())

    act(() => revertOf(0)())
    expect(jumps().canBack, 'an older jump’s failure erased the history a link made since').toBe(true)
    standAt(at('after-the-link'))
    act(() => jumps().back())
    expect(navigate).toHaveBeenLastCalledWith(at('before-the-link'), expect.any(Function))
  })

  /**
   * ⚠️ **AN OVERLAPPING NAVIGATION RETIRES THE OLDER ONE INSIDE `navigate`**
   * (2026-09-14, #94, round 4). `App` holds one rollback slot, and the open a
   * newer navigation starts RUNS the rollback the older one left — its revert
   * included — before `navigate` returns. The newer navigation's undo had
   * already copied the stack by then, so its own failure put back the older
   * jump's entry: a way back from a jump whose rollback had already run.
   */
  function retiringHost(world: ReturnType<typeof mount>) {
    let armed: (() => void) | null = null
    world.navigate.mockImplementation((_target, revert) => {
      const stale = armed
      armed = revert
      stale?.()
      return true
    })
    return { failNewest: () => armed?.() }
  }

  it('restores the stack a newer jump found once the older one was retired, not the one before it', () => {
    const world = mount(at('a'))
    const host = retiringHost(world)
    act(() => world.jumps().jumpTo(at('far', 'book-2')))
    world.standAt(at('a-moved'))
    act(() => world.jumps().jumpTo(at('nearer', 'book-3')))
    expect(world.jumps().canBack).toBe(true)

    act(() => host.failNewest())
    expect(world.jumps().canBack, 'a failure put back the entry of a jump already retired').toBe(false)
  })

  it('restores the stack a Back found once the jump it overtook was retired', () => {
    const world = mount(at('a'))
    act(() => world.jumps().jumpTo('x'))
    world.standAt(at('b'))
    act(() => world.jumps().record())
    const host = retiringHost(world)
    world.standAt(at('c'))
    act(() => world.jumps().jumpTo(at('far', 'book-2')))
    world.standAt(at('d'))
    act(() => world.jumps().back())

    act(() => host.failNewest())
    expect(world.jumps().canForward).toBe(false)
    world.standAt(at('e'))
    act(() => world.jumps().back())
    expect(
      world.navigate,
      'a failed Back put back the origin of the jump it had retired',
    ).toHaveBeenLastCalledWith(at('b'), expect.any(Function))
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
