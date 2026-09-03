// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolvedCfiForTesting } from '../../core/resolvedCfi.testkit'
import type { ForeignAnnotation } from '../../core/circle/foreign'
import type { OverlayContribution } from '../../core/circle/overlay'
import { useOverlays, type OverlayDeps } from './useOverlays'

/** WI-22.D1's host half — collecting what capabilities contribute. */

afterEach(cleanup)

const annotation = (over: Partial<ForeignAnnotation> = {}): ForeignAnnotation => ({
  pub: 'pub1',
  person: 'alice',
  author: 'alice',
  cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'),
  sectionIndex: 1,
  quote: 'Call me Ishmael',
  readers: 1,
  ...over,
})

const contribution = (
  id: string,
  answer: () => Promise<readonly ForeignAnnotation[]>,
): OverlayContribution & { fire: () => void } => {
  const listeners = new Set<() => void>()
  return {
    id,
    forBook: answer,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    fire: () => {
      for (const one of listeners) one()
    },
  }
}

const deps = (over: Partial<OverlayDeps> = {}): OverlayDeps => ({
  contributions: [],
  bookId: 'book:one',
  openGeneration: 1,
  parsed: true,
  resolve: () => Promise.resolve({ found: [], missed: [], complete: true }),
  ...over,
})

describe('useOverlays', () => {
  it('collects what every contribution answers', async () => {
    const a = contribution('a:x', () => Promise.resolve([annotation({ pub: 'p1' })]))
    const b = contribution('b:x', () => Promise.resolve([annotation({ pub: 'p2', person: 'bob' })]))
    const { result } = renderHook(() => useOverlays(deps({ contributions: [a, b] })))

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current.map((one) => one.key)).toEqual([
      'circle:alice:p1',
      'circle:bob:p2',
    ])
  })

  it('composes the overlay key itself, so one reader cannot collapse another', async () => {
    /* ⚠️ **`review.md`'s overlay blocker 1.** Leaving the key to the
       contributor would make the fix depend on every capability getting it
       right; composing it here makes `n` readers `n` entries by construction. */
    const both = contribution('a:x', () =>
      Promise.resolve([
        annotation({ pub: 'same', person: 'alice' }),
        annotation({ pub: 'same', person: 'bob' }),
      ]),
    )
    const { result } = renderHook(() => useOverlays(deps({ contributions: [both] })))

    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(new Set(result.current.map((one) => one.key)).size).toBe(2)
  })

  it('re-asks when a contribution signals, rather than taking a payload', async () => {
    /* ⚠️ *"a share arriving mid-session can neither appear nor disappear"* is
       the blocker. `subscribe` is a SIGNAL — a payload would give "what should
       be drawn" two sources that can disagree. */
    let answer: readonly ForeignAnnotation[] = []
    const one = contribution('a:x', () => Promise.resolve(answer))
    const { result } = renderHook(() => useOverlays(deps({ contributions: [one] })))
    await waitFor(() => expect(result.current).toEqual([]))

    answer = [annotation()]
    one.fire()
    await waitFor(() => expect(result.current).toHaveLength(1))
  })

  it('unsubscribes when it goes away', async () => {
    const one = contribution('a:x', () => Promise.resolve([]))
    const off = vi.fn()
    const spy: OverlayContribution = { ...one, subscribe: () => off }
    const { unmount } = renderHook(() => useOverlays(deps({ contributions: [spy] })))
    await waitFor(() => expect(off).not.toHaveBeenCalled())
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it("one contribution failing does not cost the reader the others' marks", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bad = contribution('bad:x', () => Promise.reject(new Error('nope')))
      const good = contribution('good:x', () => Promise.resolve([annotation()]))
      const { result } = renderHook(() => useOverlays(deps({ contributions: [bad, good] })))

      await waitFor(() => expect(result.current).toHaveLength(1))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('clears when the book closes, rather than leaving them standing', async () => {
    /* ⚠️ The previous book's anchors drawn over a new book is the defect
       `app/web/Reader.tsx` records for its own marks: *"A STORE THAT WENT AWAY
       TAKES ITS HIGHLIGHTS WITH IT."* */
    const one = contribution('a:x', () => Promise.resolve([annotation()]))
    const base = deps({ contributions: [one] })
    const { result, rerender } = renderHook((props: OverlayDeps) => useOverlays(props), {
      initialProps: base,
    })
    await waitFor(() => expect(result.current).toHaveLength(1))

    rerender({ ...base, bookId: null })
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it('asks nothing before the book is parsed', async () => {
    const forBook = vi.fn(() => Promise.resolve([]))
    const one = { ...contribution('a:x', forBook), forBook }
    renderHook(() => useOverlays(deps({ contributions: [one], parsed: false })))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(forBook).not.toHaveBeenCalled()
  })

  it('costs a composition with no contributions nothing at all', async () => {
    const { result } = renderHook(() => useOverlays(deps({ contributions: [] })))
    expect(result.current).toEqual([])
  })

  it('lets a slower older answer be overtaken, rather than overwriting a newer one', async () => {
    /* ⚠️ Two `ask` calls can be in flight at once — `subscribe` fires while the
       first is still awaiting — and they can settle in either order. An older
       answer landing last would resurrect a withdrawn passage. */
    const settle: ((value: readonly ForeignAnnotation[]) => void)[] = []
    const one = contribution(
      'a:x',
      () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
    )
    const { result } = renderHook(() => useOverlays(deps({ contributions: [one] })))
    await waitFor(() => expect(settle).toHaveLength(1))

    one.fire()
    await waitFor(() => expect(settle).toHaveLength(2))

    /* The NEWER request answers first, then the older one — out of order. */
    await act(async () => {
      settle[1]?.([])
      settle[0]?.([annotation()])
    })

    expect(result.current).toEqual([])
  })

  it('shows nothing for a new book until its own answer lands', async () => {
    /* ⚠️ An effect is asynchronous. Book to book, the previous book's anchors
       would otherwise stay on screen — drawn against a book they have nothing
       to do with. The clear-on-close guard did not cover being REPLACED. */
    const settle: ((value: readonly ForeignAnnotation[]) => void)[] = []
    const one = contribution(
      'a:x',
      () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
    )
    const base = deps({ contributions: [one] })
    const { result, rerender } = renderHook((props: OverlayDeps) => useOverlays(props), {
      initialProps: base,
    })
    await act(async () => settle[0]?.([annotation()]))
    expect(result.current).toHaveLength(1)

    rerender({ ...base, bookId: 'book:two', openGeneration: 2 })
    expect(result.current).toEqual([])
  })

  it('asks every contribution at once, so one slow answer holds up no other', async () => {
    /* A contributor that never settles is exactly as bad as one that throws,
       and only the throwing one was handled. */
    let started = 0
    const slow = contribution('slow:x', () => {
      started += 1
      return new Promise<readonly ForeignAnnotation[]>(() => {})
    })
    const quick = contribution('quick:x', () => {
      started += 1
      return Promise.resolve([annotation()])
    })
    renderHook(() => useOverlays(deps({ contributions: [slow, quick] })))

    await waitFor(() => expect(started).toBe(2))
  })

  it('shows a fast contributor’s marks while a slow one is still thinking', async () => {
    /* ⚠️ Starting them together is only half of it. `Promise.all` published
       nothing until the LAST one settled, so a contributor that never settles
       still cost the reader every other contributor's marks — the same defect
       one step later. A slow answer must delay ITS OWN marks and no one
       else's. */
    const slow = contribution('slow:x', () => new Promise<readonly ForeignAnnotation[]>(() => {}))
    const quick = contribution('quick:x', () => Promise.resolve([annotation()]))
    const { result } = renderHook(() => useOverlays(deps({ contributions: [slow, quick] })))

    await waitFor(() => expect(result.current).toHaveLength(1))
  })

  it('keeps each contributor in its own place, however the answers arrive', async () => {
    /* A slot per contributor, so the order the reader sees is the
       composition's — not the order the network happened to answer in. */
    const settle: ((value: readonly ForeignAnnotation[]) => void)[] = []
    const first = contribution(
      'a:x',
      () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
    )
    const second = contribution(
      'b:x',
      () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
    )
    /* ⚠️ HOISTED WHOLE, so a commit does not hand the effect a new identity
       and restart the very requests this test is timing. `deps()` rebuilds
       both the array AND `resolve`, and either is enough to re-run the effect
       on the first answer. A host that does that resubscribes on every answer
       — `composition.overlays` is frozen once and `book.reanchor` is stable,
       which is why the real one does not. */
    const stable = deps({ contributions: [first, second] })
    const { result } = renderHook(() => useOverlays(stable))
    await waitFor(() => expect(settle).toHaveLength(2))

    /* The SECOND contributor answers first. */
    await act(async () => settle[1]?.([annotation({ pub: 'p2', person: 'bob' })]))
    await act(async () => settle[0]?.([annotation({ pub: 'p1', person: 'alice' })]))

    expect(result.current.map((one) => one.key)).toEqual(['circle:alice:p1', 'circle:bob:p2'])
  })

  it('keeps a slow contributor’s marks up while it answers a re-query', async () => {
    /* ⚠️ **AN EMPTY SLOT IS NOT AN ANSWER.** With the commit happening per
       contributor, starting every slot empty meant one contributor signalling
       erased every slower contributor's marks the moment it answered — and if
       the slow one never settled, its marks never came back. */
    const settle: ((value: readonly ForeignAnnotation[]) => void)[] = []
    const slow = contribution(
      'slow:x',
      () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
    )
    const chatty = contribution('chatty:x', () => Promise.resolve([annotation({ pub: 'quick' })]))
    const stable = deps({ contributions: [slow, chatty] })
    const { result } = renderHook(() => useOverlays(stable))

    await act(async () => settle[0]?.([annotation({ pub: 'slow1', person: 'bob' })]))
    expect(result.current).toHaveLength(2)

    /* The chatty one signals; the slow one is asked again and does not answer. */
    chatty.fire()
    await waitFor(() => expect(settle).toHaveLength(2))
    await act(async () => {})

    expect(result.current.map((one) => one.key)).toContain('circle:bob:slow1')
  })

  it('takes a contributor at its word when it answers nothing, though', async () => {
    /* The other side of it: a successful `[]` IS a withdrawal and must clear
       the marks. Only a REJECTION leaves the previous answer standing, because
       a contributor that failed has said nothing about what it holds. */
    let answer: readonly ForeignAnnotation[] = [annotation()]
    const one = contribution('a:x', () => Promise.resolve(answer))
    const stable = deps({ contributions: [one] })
    const { result } = renderHook(() => useOverlays(stable))
    await waitFor(() => expect(result.current).toHaveLength(1))

    answer = []
    one.fire()

    await waitFor(() => expect(result.current).toEqual([]))
  })

  it('keeps the marks up when a contributor fails a re-query, rather than erasing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let fail = false
      const one = contribution('a:x', () =>
        fail ? Promise.reject(new Error('read failed')) : Promise.resolve([annotation()]),
      )
      const stable = deps({ contributions: [one] })
      const { result } = renderHook(() => useOverlays(stable))
      await waitFor(() => expect(result.current).toHaveLength(1))

      fail = true
      one.fire()
      await waitFor(() => expect(warn).toHaveBeenCalled())

      expect(result.current).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('lets a listener from a book already left cost the new book nothing', async () => {
    /* ⚠️ A contribution can fire a callback it queued before its unsubscribe
       ran. Bumping the shared revision from that dead call made the CURRENT
       book's in-flight answer fail its own check and be discarded — the new
       book then showed nothing until some later signal happened to ask
       again. */
    /* An array, not a `let`: assigning inside the callback leaves TypeScript's
       control flow believing the variable is still `null`, and `stale?.()` then
       narrows to `never`. Pushing sidesteps the narrowing without a cast. */
    const listeners: (() => void)[] = []
    const settle: ((value: readonly ForeignAnnotation[]) => void)[] = []
    const one: OverlayContribution = {
      id: 'a:x',
      forBook: () => new Promise<readonly ForeignAnnotation[]>((resolve) => settle.push(resolve)),
      subscribe: (listener) => {
        /* Kept AFTER the unsubscribe, which is the whole case. */
        listeners.push(listener)
        return () => {}
      },
    }
    const base = deps({ contributions: [one] })
    const { result, rerender } = renderHook((props: OverlayDeps) => useOverlays(props), {
      initialProps: base,
    })
    await waitFor(() => expect(settle).toHaveLength(1))

    /* Book A is left; the effect for B starts its own request. */
    const stale = listeners[0]
    rerender({ ...base, bookId: 'book:two', openGeneration: 2 })
    await waitFor(() => expect(settle).toHaveLength(2))

    /* A's dead listener fires, and must not invalidate B. */
    stale?.()
    await act(async () => settle[1]?.([annotation()]))

    expect(result.current).toHaveLength(1)
  })

  it('does not resubscribe for an answer identical to the one it is showing', async () => {
    /* ⚠️ A host composing its contributions during render hands the effect a
       new identity on every render, so an unconditional commit turns one
       re-ask into a teardown and a fresh subscribe. */
    const subscribed = vi.fn()
    const one = contribution('a:x', () => Promise.resolve([annotation()]))
    const spy: OverlayContribution = {
      ...one,
      subscribe: (listener) => {
        subscribed()
        return one.subscribe(listener)
      },
    }
    const { result, rerender } = renderHook((props: OverlayDeps) => useOverlays(props), {
      initialProps: deps({ contributions: [spy] }),
    })
    await waitFor(() => expect(result.current).toHaveLength(1))
    const before = subscribed.mock.calls.length

    /* A fresh array each time, as a host that composes during render gives. */
    rerender(deps({ contributions: [spy] }))
    await waitFor(() => expect(result.current).toHaveLength(1))
    one.fire()
    await new Promise((resolve) => setTimeout(resolve, 10))

    /* One for the rerender's new identity, and none for the re-ask. */
    expect(subscribed.mock.calls.length).toBe(before + 1)
  })

  it('takes back the listeners it had already installed when one subscribe throws', async () => {
    const off = vi.fn()
    const first: OverlayContribution = {
      ...contribution('a:x', () => Promise.resolve([])),
      subscribe: () => off,
    }
    const second: OverlayContribution = {
      ...contribution('b:x', () => Promise.resolve([])),
      subscribe: () => {
        throw new Error('nope')
      },
    }
    expect(() =>
      renderHook(() => useOverlays(deps({ contributions: [first, second] }))),
    ).toThrow('nope')
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('removes the rest when one unsubscribe throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const off = vi.fn()
      const bad: OverlayContribution = {
        ...contribution('a:x', () => Promise.resolve([])),
        subscribe: () => () => {
          throw new Error('nope')
        },
      }
      const good: OverlayContribution = {
        ...contribution('b:x', () => Promise.resolve([])),
        subscribe: () => off,
      }
      const { unmount } = renderHook(() => useOverlays(deps({ contributions: [bad, good] })))
      unmount()
      expect(off).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('hands the resolver through to the contribution', async () => {
    /* The kernel supplies the port; a capability that found its own would parse
       an unstripped document and produce a path that can disagree by a child
       index. */
    const resolve = vi.fn(() => Promise.resolve({ found: [], missed: [], complete: true }))
    const seen: unknown[] = []
    const one = contribution('a:x', () => Promise.resolve([]))
    const spy: OverlayContribution = {
      ...one,
      forBook: (request) => {
        seen.push(request.resolve)
        return Promise.resolve([])
      },
    }
    renderHook(() => useOverlays(deps({ contributions: [spy], resolve })))
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toBe(resolve)
  })
})
