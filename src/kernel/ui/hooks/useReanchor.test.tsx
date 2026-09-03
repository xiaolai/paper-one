// @vitest-environment jsdom
import { StrictMode } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useReanchor, type ReanchorDeps, type WalkResult } from './useReanchor'
import type { Annotation } from '../../core/marks'
import { resolvedCfiForTesting } from '../../core/resolvedCfi.testkit'

/**
 * WI-22.A2's host half, and where **WI-22.A3** is actually decided.
 *
 * `reanchorPass.test.ts` proves the walk finds the words. This proves the three
 * things around it that the plan states as constraints and that no walk can
 * enforce for itself:
 *
 *  - a hit becomes a STORE WRITE, not a render-time decoration;
 *  - a book is walked ONCE per open, not per render or per page turn;
 *  - the cache is keyed by something that changes when the book does, so
 *    replacing a book's bytes invalidates every answer about it — and does not
 *    touch any other book's.
 */

afterEach(cleanup)

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const unplaced = (id: string, text: string, bookId = 'book:one'): Annotation =>
  ({
    id,
    bookId,
    cfi: '',
    sectionIndex: 0,
    text,
    prefix: 'before ',
    suffix: ' after',
    note: '',
    kind: 'highlight',
    tint: 'yellow',
    style: 'fill',
    chapter: '',
    createdAt: 1,
    unplaced: { reason: 'foreign-build', fromBook: 'book:elsewhere' },
  }) as Annotation

/** A walk that finds the named ids and misses the rest. */
const finding =
  (...hits: readonly string[]) =>
  (pending: readonly { readonly id: string }[]): Promise<WalkResult> =>
    Promise.resolve({
      found: pending
        .filter((one) => hits.includes(one.id))
        .map((one, i) => ({
          id: one.id,
          cfi: resolvedCfiForTesting(`epubcfi(/6/${2 * (i + 2)}!/4/2)`),
          sectionIndex: i + 1,
        })),
      missed: pending.filter((one) => !hits.includes(one.id)).map((one) => one.id),
      complete: true,
      walked: 3,
    })

const deps = (over: Partial<ReanchorDeps> = {}): ReanchorDeps => ({
  reanchor: finding(),
  parsed: true,
  bookId: 'book:one',
  openGeneration: 1,
  contentHash: HASH_A,
  unplaced: [],
  ready: true,
  place: vi.fn(),
  ...over,
})

describe('useReanchor', () => {
  it('writes every hit to the store, naming the book it walked', async () => {
    /* ⚠️ **THE ITEM'S FIRST CONSTRAINT.** *"A HIT MUST BE A STORE WRITE, NOT A
       RENDER-TIME DECORATION."* A mark resolved only in memory is resolved
       again on every open and is invisible to export, to sync and to the
       browser client. */
    const place = vi.fn()
    const one = unplaced('m1', 'driving off the spleen')
    renderHook(() =>
      useReanchor(deps({ unplaced: [one], reanchor: finding('m1'), place })),
    )

    await waitFor(() => expect(place).toHaveBeenCalledTimes(1))
    expect(place).toHaveBeenCalledWith('m1', 'epubcfi(/6/4!/4/2)', 1, 'book:one')
  })

  it('walks a book ONCE, however many times the hook re-runs', async () => {
    /* ⚠️ **THE READING-PATH CONSTRAINT.** Forty cold sections is ~139 ms —
       *"fine as a one-off after open and not fine per page turn"*. A render is
       the cheapest thing that happens while reading, so this is the property
       that keeps the pass off that path at all. */
    const reanchor = vi.fn(finding())
    const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })

    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
    for (let i = 0; i < 5; i += 1) rerender({ ...base })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
  })

  it('does not re-walk for a mark it has already missed', async () => {
    /* The acceptance's second half: *"one whose passage does not exist stays
       unplaced and is not re-walked on the next open (the cache remembers the
       miss)"*. `reanchorCache` stores a miss deliberately — answering `null`
       costs the same full walk as answering with a range, so remembering only
       the successes re-walks every unresolvable mark for ever. */
    const reanchor = vi.fn(finding())
    const one = unplaced('m1', 'absent')
    const base = deps({ unplaced: [one], reanchor })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

    /* Away and back — a second OPEN of the same book, not a re-render.
       `openGeneration` is what makes it a second open: `useBook.open()` bumps
       it, and without it the hook cannot tell a reopen from a re-render. */
    rerender({ ...base, bookId: 'book:two', contentHash: HASH_B, unplaced: [], openGeneration: 2 })
    rerender({ ...base, openGeneration: 3 })

    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
  })

  it('does NOT remember a miss the walk did not establish', async () => {
    /* ⚠️ **THE ONE THAT WOULD BE SILENT.** A pass cut short by the reader
       closing the book has established nothing about the marks it did not
       reach. `reanchorPass` answers `missed: []` with `complete: false`, and
       this must not invent one — otherwise the mark is never looked for again
       in this session, and it is there.

       The second open therefore has to walk again. */
    const cutShort = vi.fn(
      (): Promise<WalkResult> =>
        Promise.resolve({ found: [], missed: [], complete: false, walked: 1 }),
    )
    const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor: cutShort })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(cutShort).toHaveBeenCalledTimes(1))

    rerender({ ...base, bookId: 'book:two', contentHash: HASH_B, unplaced: [], openGeneration: 2 })
    rerender({ ...base, openGeneration: 3 })

    await waitFor(() => expect(cutShort).toHaveBeenCalledTimes(2))
  })

  it('waits for the marks to be read before walking', async () => {
    /* `ready` is false until this book's marks file has been read. Walking
       before it has walks for an empty list and marks the book done — the
       reader's imported marks then stay unplaced with nothing having failed. */
    const reanchor = vi.fn(finding())
    const base = deps({ ready: false, unplaced: [], reanchor })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    expect(reanchor).not.toHaveBeenCalled()

    rerender({ ...base, ready: true, unplaced: [unplaced('m1', 'absent')] })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
  })

  it('does not walk before the book is parsed', async () => {
    /* `meta !== null` is the signal, not `doc !== null` — the walk uses
       `createDocument()` and needs no rendered section, so keying on a rendered
       one would silently never walk a backend that publishes no document. */
    const reanchor = vi.fn(finding())
    renderHook(() => useReanchor(deps({ parsed: false, unplaced: [unplaced('m1', 'x')], reanchor })))
    await Promise.resolve()
    expect(reanchor).not.toHaveBeenCalled()
  })

  it('does not walk when nothing is waiting', async () => {
    const reanchor = vi.fn(finding())
    renderHook(() => useReanchor(deps({ unplaced: [], reanchor })))
    await Promise.resolve()
    expect(reanchor).not.toHaveBeenCalled()
  })

  describe('WI-22.A3 — the cache is keyed by something that changes with the book', () => {
    it("re-walks a book whose bytes were replaced, and does not trust the old answer", async () => {
      /* ⚠️ **THE ITEM'S FALSIFIER, RUN.** *"A mark that resolved against build
         A is still reported resolved after the folder's content is swapped for
         build B. That is a mark drawn on the wrong words, which is phase 21's
         original defect arriving through the cache."*

         Same `bookId`, new `contentHash`. Everything remembered about build A
         is a guess about build B, so the walk must happen again — **on the next
         OPEN**, which is the part this test used to get wrong.

         ⚠️ It asserted a re-walk the instant the hash changed, and that is a
         stale parse. The reader is still looking at build A; only the file on
         disk became build B. Walking the loaded book and filing its answers
         under B's hash produces cache entries derived from bytes the key does
         not name — the very thing `contentHash` was chosen as the generation to
         prevent. Invalidate immediately, walk when the book is reopened.

         ⚠️ **WHAT MAKES THIS PASS IS THE KEY, NOT `forgetGeneration`** — worth
         saying, because the obvious reading is the other way round. The
         generation is IN the cache key (`<markId>@<generation>`) and `lookUp`
         re-checks it against the entry as well, so an answer computed against
         build A is unreachable under build B whether or not it was dropped.
         `forgetGeneration` is memory hygiene: without it the map keeps every
         superseded build's answers for the life of the session. Its own
         behaviour is tested directly in `reanchorCache.test.ts` — *"drops every
         answer computed against the bytes that changed"* and *"leaves other
         books alone"*; what this file adds is that the hook passes it the right
         generation, which the next test is about. */
      const reanchor = vi.fn(finding())
      const one = unplaced('m1', 'absent')
      const base = deps({ unplaced: [one], reanchor })
      const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
        initialProps: base,
      })
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

      /* The bytes change under the open book. Nothing is re-walked yet. */
      rerender({ ...base, contentHash: HASH_B })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reanchor).toHaveBeenCalledTimes(1)

      /* The reader reopens it. Build A's remembered miss must not answer for
         build B, so the walk happens again. */
      rerender({ ...base, contentHash: HASH_B, openGeneration: 2 })
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(2))
    })

    it('does not walk a stale parse when the bytes change under an open book', async () => {
      /* The other half, stated as its own case because it is the one that
         silently corrupts the cache rather than merely missing work: a walk
         started on build A's loaded document, finishing after the hash moved to
         B, must not file its answers under B. `stillHere` refuses it. */
      let release: null | ((r: WalkResult) => void) = null
      const reanchor = vi.fn(
        (): Promise<WalkResult> =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      const place = vi.fn()
      const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor, place })
      const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
        initialProps: base,
      })
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

      /* The library re-hashes the file while the walk is in flight. */
      rerender({ ...base, contentHash: HASH_B })
      const found = {
        found: [
          { id: 'm1', cfi: resolvedCfiForTesting('epubcfi(/6/4!/4/2)'), sectionIndex: 1 },
        ],
        missed: [],
        complete: true,
        walked: 3,
      }
      ;(release as unknown as (r: WalkResult) => void)(found)
      await new Promise((resolve) => setTimeout(resolve, 10))

      /* The answer describes build A and is dropped rather than written. */
      expect(place).not.toHaveBeenCalled()
    })

    it('leaves every OTHER book\'s answers alone when one book changes', async () => {
      /* ⚠️ **THE HALF THE FIRST IMPLEMENTATION GOT WRONG.** The cache map is
         keyed `<markId>@<generation>` and carries no book, so "forget every
         generation that is not the current one" — which is what the first
         version computed — is also every OTHER book's current generation, and
         emptied the cache for the whole library on each open.
         `forgetGeneration`'s own header requires the opposite.

         Book two is walked, book one's bytes are then replaced, and book two
         must still be remembered. */
      const reanchor = vi.fn(finding())
      const first = deps({ unplaced: [unplaced('m1', 'absent')], reanchor })
      const second: ReanchorDeps = {
        ...first,
        bookId: 'book:two',
        contentHash: HASH_B,
        unplaced: [unplaced('m2', 'absent too', 'book:two')],
      }
      const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
        initialProps: first,
      })
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
      rerender(second)
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(2))

      /* Book one comes back with DIFFERENT bytes — its own answers are dropped
         and it is walked again (call 3). */
      const replaced: ReanchorDeps = { ...first, contentHash: 'c'.repeat(64) }
      rerender(replaced)
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(3))

      /* Book two, unchanged, must still be remembered — no fourth call. */
      rerender(second)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reanchor).toHaveBeenCalledTimes(3)
    })

    it('walks every time when the book carries no generation at all', async () => {
      /* ⚠️ **NO GENERATION MEANS NO CACHE, NEVER AN UNVERSIONED ONE.**
         `contentHash` is stamped by sync's backfill, so a build composed
         without `sync` has none — and a cache keyed on nothing would answer for
         a file it has never seen. The cost of missing is a 3.46 ms re-walk; the
         cost of a stale hit is a mark drawn on the wrong words. The trade is
         not close, and `keyFor` answers null. */
      const reanchor = vi.fn(finding())
      const base = deps({ contentHash: undefined, unplaced: [unplaced('m1', 'absent')], reanchor })
      const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
        initialProps: base,
      })
      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

      rerender({ ...base, bookId: 'book:two', unplaced: [], openGeneration: 2 })
      rerender({ ...base, openGeneration: 3 })

      await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(2))
    })
  })
})

describe('the walk lifecycle — what may be recorded as done', () => {
  it('retries on the next OPEN after a walk that was cut short', async () => {
    /* ⚠️ **THE DEFECT THE AUDIT FOUND, AND ITS TWIN THAT THE FIX INTRODUCED.**
       The stamp used to key on the book's BYTES, so closing a book and
       reopening it produced the same stamp and the second open refused to walk
       — and because an interrupted pass deliberately places and caches nothing,
       those marks were never looked for again for the life of the session.

       Fixing that surfaced the twin one level down: `settled` was written for
       ANY walk that returned, complete or not. An incomplete outcome is the
       pass saying it established nothing, so recording the open as done retires
       the question on an answer nobody gave. */
    const cutShort = vi.fn(
      (): Promise<WalkResult> =>
        Promise.resolve({ found: [], missed: [], complete: false, walked: 2 }),
    )
    const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor: cutShort })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(cutShort).toHaveBeenCalledTimes(1))

    /* The reader closes the book and opens it again — same bytes, new open. */
    rerender({ ...base, openGeneration: 2 })
    await waitFor(() => expect(cutShort).toHaveBeenCalledTimes(2))
  })

  it('does not re-walk a COMPLETE book on a later open', async () => {
    /* The other side of the same rule. A complete walk is an answer, and the
       cache carries it — reopening must not pay for the book again. */
    const reanchor = vi.fn(finding())
    const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

    rerender({ ...base, openGeneration: 2 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reanchor).toHaveBeenCalledTimes(1)
  })

  it('starts only one walk while one is already in flight', async () => {
    /* `settled` is written when a walk finishes, so between starting and
       finishing there is nothing to stop a re-render starting a second. On a
       book of forty cold sections that is the ~139 ms budget paid twice, on the
       open it was meant to be paid once. */
    let release: null | (() => void) = null
    const reanchor = vi.fn(
      (): Promise<WalkResult> =>
        new Promise((resolve) => {
          release = () => resolve({ found: [], missed: ['m1'], complete: true, walked: 3 })
        }),
    )
    const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))

    for (let i = 0; i < 4; i += 1) rerender({ ...base })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(reanchor).toHaveBeenCalledTimes(1)

    if (release) (release as () => void)()
  })

  it('reports a walk that threw and lets a later open try again', async () => {
    /* The promise is detached, so without a handler a throw inside the walk —
       a renderer torn down mid-parse — was an unhandled rejection at the window
       AND left the book in flight for ever. */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const throwing = vi.fn((): Promise<WalkResult> => Promise.reject(new Error('renderer went away')))
      const base = deps({ unplaced: [unplaced('m1', 'absent')], reanchor: throwing })
      const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
        initialProps: base,
      })
      await waitFor(() => expect(error).toHaveBeenCalled())

      rerender({ ...base, openGeneration: 2 })
      await waitFor(() => expect(throwing).toHaveBeenCalledTimes(2))
    } finally {
      error.mockRestore()
    }
  })

  it('re-places from a cached placement rather than skipping it', async () => {
    /* ⚠️ A cached answer used to be skipped whatever it said. That is right for
       a remembered MISS and wrong for a remembered PLACEMENT: the mark is in
       `unplaced` despite the cached hit, which means the write that should have
       moved it did not land. The answer is in hand and costs nothing to reuse. */
    const place = vi.fn()
    const reanchor = vi.fn(finding('m1'))
    const one = unplaced('m1', 'driving off the spleen')
    const base = deps({ unplaced: [one], reanchor, place })
    const { rerender } = renderHook((props: ReanchorDeps) => useReanchor(props), {
      initialProps: base,
    })
    await waitFor(() => expect(place).toHaveBeenCalledTimes(1))

    /* A second open with the mark STILL unplaced — the store write did not
       land. The walk is not repeated; the remembered placement is rewritten. */
    rerender({ ...base, openGeneration: 2 })
    await waitFor(() => expect(place).toHaveBeenCalledTimes(2))
    expect(reanchor).toHaveBeenCalledTimes(1)
    expect(place).toHaveBeenLastCalledWith('m1', 'epubcfi(/6/4!/4/2)', 1, 'book:one')
  })
})

describe('under Strict Mode, where every effect is mounted twice', () => {
  it('still places what the walk found', async () => {
    /* ⚠️ **THE HOLE THE FIRST LIFECYCLE FIX LEFT, and it made the pass never
       complete in the environment every developer runs.**

       React mounts an effect, tears it down, and mounts it again. The walk used
       to be abandoned on a flag set by each effect's cleanup, so: effect 1
       starts the walk and marks it in flight; its cleanup sets the flag; effect
       2 sees the same walk still in flight and stands down; the walk finishes,
       finds its flag false, DISCARDS A CORRECT ANSWER, and clears the in-flight
       marker with nobody left to retry.

       Every other test in this file passed throughout, because none of them
       unmounts an effect mid-walk — a re-render with unchanged deps does not
       re-run one. Strict Mode is what makes the teardown happen. */
    const place = vi.fn()
    const one = unplaced('m1', 'driving off the spleen')
    renderHook(() => useReanchor(deps({ unplaced: [one], reanchor: finding('m1'), place })), {
      wrapper: StrictMode,
    })

    await waitFor(() => expect(place).toHaveBeenCalledTimes(1))
    expect(place).toHaveBeenCalledWith('m1', 'epubcfi(/6/4!/4/2)', 1, 'book:one')
  })

  it('walks the book once, not twice', async () => {
    /* The other half: standing down for a walk already in flight is what keeps
       the doubled mount from paying the ~139 ms budget twice. */
    const reanchor = vi.fn(finding())
    renderHook(() => useReanchor(deps({ unplaced: [unplaced('m1', 'absent')], reanchor })), {
      wrapper: StrictMode,
    })
    await waitFor(() => expect(reanchor).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reanchor).toHaveBeenCalledTimes(1)
  })
})
