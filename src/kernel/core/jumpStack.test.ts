import { describe, expect, it } from 'vitest'
import {
  EMPTY,
  MAX_DEPTH,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  overrideSpent,
  locationToOpen,
  pushOrigin,
  type JumpStack,
  type Place,
} from './jumpStack'

const at = (cfi: string, bookId = 'book-1'): Place => ({ bookId, cfi })

/** Jump from `origin` and land at `destination`, as the app does it. */
const jump = (stack: JumpStack, origin: Place): JumpStack => pushOrigin(stack, origin)

describe('pushOrigin', () => {
  it('records the place being left, not the place being gone to', () => {
    const stack = pushOrigin(EMPTY, at('/6/4!/2'))
    expect(stack.back).toEqual([at('/6/4!/2')])
    expect(stack.forward).toEqual([])
  })

  it('collapses consecutive identical origins, so one departure costs one press', () => {
    const once = pushOrigin(EMPTY, at('/6/4!/2'))
    const twice = pushOrigin(once, at('/6/4!/2'))
    expect(twice.back).toEqual([at('/6/4!/2')])
  })

  it('does not collapse the same CFI in a different book', () => {
    const stack = pushOrigin(pushOrigin(EMPTY, at('/6/4!/2', 'a')), at('/6/4!/2', 'b'))
    expect(stack.back).toEqual([at('/6/4!/2', 'a'), at('/6/4!/2', 'b')])
  })

  it('clears forward, because a new jump branches away from what was ahead', () => {
    let stack = jump(jump(EMPTY, at('a')), at('b'))
    stack = goBack(stack, at('c'))!.stack
    expect(stack.forward).toEqual([at('c')])
    stack = pushOrigin(stack, at('d'))
    expect(stack.forward).toEqual([])
  })

  it('clears forward even when the origin collapses into the top of back', () => {
    /* The collapse must not become a way to keep a stale forward list: the
       reader still jumped, so what was ahead is still abandoned. */
    let stack = pushOrigin(EMPTY, at('a'))
    stack = goBack(stack, at('b'))!.stack
    stack = pushOrigin(stack, at('b'))
    expect(stack.back).toEqual([at('b')])
    expect(stack.forward).toEqual([])
  })

  it('is the same object when a collapse changes nothing', () => {
    const stack = pushOrigin(EMPTY, at('a'))
    expect(pushOrigin(stack, at('a'))).toBe(stack)
  })
})

describe('walking the stack', () => {
  it('goes back and forward over a sequence of five', () => {
    const places = ['a', 'b', 'c', 'd', 'e'].map((c) => at(c))
    let stack = EMPTY
    for (const place of places) stack = pushOrigin(stack, place)

    // Standing at 'f', having left 'e' last.
    let here = at('f')
    const seen: string[] = []
    for (let i = 0; i < 5; i++) {
      const step = goBack(stack, here)!
      stack = step.stack
      here = step.to
      seen.push(step.to.cfi)
    }
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a'])
    expect(goBack(stack, here)).toBeNull()

    const forward: string[] = []
    for (let i = 0; i < 5; i++) {
      const step = goForward(stack, here)!
      stack = step.stack
      here = step.to
      forward.push(step.to.cfi)
    }
    expect(forward).toEqual(['b', 'c', 'd', 'e', 'f'])
    expect(goForward(stack, here)).toBeNull()
  })

  it('returns null from an empty stack rather than throwing', () => {
    expect(goBack(EMPTY, at('a'))).toBeNull()
    expect(goForward(EMPTY, at('a'))).toBeNull()
  })

  it('still goes back when the current place cannot be pinned down, without inventing a forward', () => {
    /* `placeHere()` is null mid-open and for a section still rendering. The
       press must work — refusing it is a key that fails silently and only
       sometimes — but nothing may be pushed onto forward, because there is no
       place to push. */
    const stack = pushOrigin(pushOrigin(EMPTY, at('a')), at('b'))
    const step = goBack(stack, null)!
    expect(step.to).toEqual(at('b'))
    expect(step.stack.back).toEqual([at('a')])
    expect(step.stack.forward).toEqual([])
  })

  it('still goes forward with no place to record, leaving back alone', () => {
    let stack = pushOrigin(EMPTY, at('a'))
    stack = goBack(stack, at('b'))!.stack
    const step = goForward(stack, null)!
    expect(step.to).toEqual(at('b'))
    expect(step.stack.back).toEqual([])
    expect(step.stack.forward).toEqual([])
  })

  it('returns null going forward when nothing is ahead', () => {
    const stack = pushOrigin(EMPTY, at('a'))
    expect(goForward(stack, at('b'))).toBeNull()
  })

  it('round-trips a cross-book jump, carrying the book id as well as the CFI', () => {
    const stack = pushOrigin(EMPTY, at('/6/4!/2', 'moby'))
    const back = goBack(stack, at('/6/12!/8', 'ulysses'))!
    expect(back.to).toEqual({ bookId: 'moby', cfi: '/6/4!/2' })
    const forward = goForward(back.stack, back.to)!
    expect(forward.to).toEqual({ bookId: 'ulysses', cfi: '/6/12!/8' })
  })
})

describe('the bound', () => {
  it('keeps the newest MAX_DEPTH origins and drops the oldest', () => {
    let stack = EMPTY
    for (let i = 0; i < MAX_DEPTH + 10; i++) stack = pushOrigin(stack, at(`c${i}`))
    expect(stack.back).toHaveLength(MAX_DEPTH)
    /* The NEWEST survive. Dropping from the near end would mean the place the
       reader just left is the one thrown away. */
    expect(stack.back[stack.back.length - 1]).toEqual(at(`c${MAX_DEPTH + 9}`))
    expect(stack.back[0]).toEqual(at('c10'))
  })

  it('bounds forward too, so a long walk back cannot grow without limit', () => {
    let stack: JumpStack = { back: [], forward: [] }
    for (let i = 0; i < MAX_DEPTH + 10; i++) stack = pushOrigin(stack, at(`c${i}`))
    let here = at('here')
    for (let i = 0; i < MAX_DEPTH; i++) {
      const step = goBack(stack, here)!
      stack = step.stack
      here = step.to
    }
    expect(stack.forward.length).toBeLessThanOrEqual(MAX_DEPTH)
  })
})

describe('canGoBack / canGoForward', () => {
  it('are the one rule the key and the palette row both read', () => {
    expect(canGoBack(EMPTY)).toBe(false)
    expect(canGoForward(EMPTY)).toBe(false)
    const stack = pushOrigin(EMPTY, at('a'))
    expect(canGoBack(stack)).toBe(true)
    expect(canGoForward(stack)).toBe(false)
    const back = goBack(stack, at('b'))!
    expect(canGoBack(back.stack)).toBe(false)
    expect(canGoForward(back.stack)).toBe(true)
  })
})

describe('where a book opens', () => {
  const resume = (bookId: string, position: string | null) => ({ bookId, position })

  it('prefers a jump target over the resume and the shelf record', () => {
    expect(locationToOpen('b', at('jumped', 'b'), resume('b', 'resumed'), 'saved')).toBe('jumped')
  })

  it('ignores an override belonging to a different book', () => {
    /* NOT A WEAKER ANSWER — the wrong one. The override is set before the open
       and the id resolves after it, so a stale one from an abandoned open must
       not be applied to whatever the reader opened instead. */
    expect(locationToOpen('b', at('jumped', 'other'), resume('b', 'resumed'), 'saved')).toBe('resumed')
  })

  it('falls through to the resume, then to the shelf record', () => {
    expect(locationToOpen('b', null, resume('b', 'resumed'), 'saved')).toBe('resumed')
    expect(locationToOpen('b', null, resume('other', 'resumed'), 'saved')).toBe('saved')
    expect(locationToOpen('b', null, null, 'saved')).toBe('saved')
  })

  it('is null with no book open', () => {
    expect(locationToOpen(null, at('x', 'b'), resume('b', 'r'), 'saved')).toBeNull()
  })
})

describe('spending the override', () => {
  it('is spent only once a section has rendered, not when the id resolves', () => {
    /* THE WHOLE POINT. `bookId` resolves within milliseconds of the open and
       long before any section renders, so clearing on it would drop the
       override before `locationToOpen` was ever consulted — the jump would
       open the right book at the wrong place. */
    const target = at('deep-in-the-book', 'b')
    expect(overrideSpent('b', target, null)).toBe(false)
    expect(overrideSpent('b', target, 'epubcfi(/6/4!/2)')).toBe(true)
  })

  it('is NOT spent while the SOURCE book is still open — the whole cross-book jump', () => {
    /* THE REGRESSION THIS TEST EXISTS FOR, and it shipped green once.
       A cross-book jump sets the override and then reads the target off disk,
       which takes time. For all of it the source book is still open and still
       publishing its own CFI. A predicate that spent the override whenever "a
       different book is open" therefore fired immediately — before the target
       had loaded, before `locationToOpen` was ever consulted — and every
       cross-book jump quietly landed at the target's saved position instead of
       at the mark. The tests written for that branch asserted the wrong rule,
       so nothing caught it. */
    expect(overrideSpent('source-book', at('x', 'target-book'), 'epubcfi(/6/4!/2)')).toBe(false)
    expect(overrideSpent('source-book', at('x', 'target-book'), null)).toBe(false)
  })

  it('is NOT spent by the gap between books, which every open passes through', () => {
    /* `bookId` is null from `close` until the next content-derived id resolves.
       Spending there would clear the override on the way to the very book it
       was set for. */
    expect(overrideSpent(null, at('x', 'b'), null)).toBe(false)
    expect(overrideSpent(null, at('x', 'b'), 'epubcfi(/6/4!/2)')).toBe(false)
  })

  it('is nothing to spend when no jump is pending', () => {
    expect(overrideSpent('b', null, 'epubcfi(/6/4!/2)')).toBe(false)
  })
})
