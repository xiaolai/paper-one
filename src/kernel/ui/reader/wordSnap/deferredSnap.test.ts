import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapApplication } from './applySnap'
import { deferSnap, type DeferredSnap } from './deferredSnap'
import { buildFixture, elem, txt, type Fixture } from './domFake.testkit'
import { fakeDocument, type FakeDocument, type FakeWindow } from './documentFake.testkit'
import { selectionOver, type FakeSelection } from './selectionFake.testkit'
import { watchGestureProvenance } from './gestureProvenance'

/**
 * The snap, one macrotask after the gesture — and every way it gets cancelled.
 *
 * What this file can prove is **ordering and cancellation**: that the mutation
 * has not happened while the `pointerup` listeners are still running, that it
 * has happened after a zero-length macrotask, and that each thing which can move
 * the ground underneath a pending snap stops it.
 *
 * **What it cannot prove is that no page turns.** That behaviour lives in
 * foliate's `paginator.js:586` debounce interacting with real listener ordering
 * in WebKit, on a paginated EPUB, after a real drag. No lane reaches it at any
 * level of effort — the `live` lane included, since the bridge dispatches
 * `isTrusted: false` events and WebKit builds no native selection from them.
 * No case below claims to: the obligation is **permanently UNMET**, and its
 * only cover is the manual selection checklist §2.
 *
 * Every case runs against the same fakes the rest of this directory uses —
 * `domFake.testkit.ts`, `selectionFake.testkit.ts`, `documentFake.testkit.ts` —
 * plus vitest's fake timers, which are a host-timer stub rather than a stand-in
 * for one of our own modules. The provenance predicate is the **real**
 * `watchGestureProvenance`, driven by real event sequences, so the seam WI-7
 * left unconsumed is closed here against the actual implementation rather than
 * against a boolean somebody typed into a test.
 */

const WORDS = 'the quick brown fox'

interface Scene {
  readonly fixture: Fixture
  readonly doc: FakeDocument
  readonly view: FakeWindow
  readonly words: Text
  readonly selection: FakeSelection
  /** What `onSettled` was handed, in order. Empty means nothing published. */
  readonly settled: SnapApplication[]
  readonly snap: DeferredSnap
  /** The events a completed mouse drag delivers, in WebKit's order. The last
   *  of them is what schedules, exactly as `publish()` will in WI-9. */
  readonly drag: () => void
}

/**
 * A document holding `'the quick brown fox'` with `'ick bro'` selected, a real
 * provenance tracker bound to it, and a deferred snap over both.
 *
 * The text sits two levels down (`div#page > p#para`) on purpose: detaching it
 * has to leave the paragraph and its text linked to each other and disconnected
 * from the document, which is the shape a PDF text-layer rebuild produces and
 * the only shape that reaches `applySnap`'s connectivity guard rather than its
 * "no element above this node" one.
 */
function scene(options: { readonly scheduleFirst?: boolean } = {}): Scene {
  const fixture = buildFixture(
    elem('div', { id: 'page' }, [elem('p', { id: 'para' }, [txt(WORDS)])]),
  )
  const words = fixture.text(WORDS)
  const selection = selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 })
  const doc = fakeDocument({ selection })
  const view = doc.defaultView
  if (!view) throw new Error('scene: the fixture document has no window')

  const settled: SnapApplication[] = []
  let deferred: DeferredSnap | undefined
  /* Indirected so the listener can be registered BEFORE the tracker it will
   * eventually schedule — the ordering case needs both arrangements, and a
   * closure that throws is louder than one that quietly does nothing. */
  const schedule = (): void => {
    if (!deferred) throw new Error('scene: the deferred snap has not been built yet')
    deferred.schedule()
  }

  if (options.scheduleFirst) doc.addEventListener('pointerup', schedule)
  const provenance = watchGestureProvenance(doc.asDocument())
  deferred = deferSnap(doc.asDocument(), {
    isPointerProduced: provenance.isPointerProduced,
    onSettled: (application) => settled.push(application),
  })
  if (!options.scheduleFirst) doc.addEventListener('pointerup', schedule)

  return {
    fixture,
    doc,
    view,
    words,
    selection,
    settled,
    snap: deferred,
    drag: () => {
      doc.dispatch('pointerdown')
      doc.dispatch('selectionchange')
      doc.dispatch('pointerup')
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the fake timers, as an instrument', () => {
  /*
   * The contract every case below rests on, asserted rather than assumed. If
   * `advanceTimersByTime(0)` ran a 1 ms timer too, the "one macrotask, not a
   * delay" case would pass against `setTimeout(fn, 100)` and prove nothing —
   * the same vacuity `markGeometry.test.ts:53` records one layer down.
   */
  it('runs a zero-delay callback on a zero advance, and a delayed one not at all', () => {
    const fired: string[] = []
    setTimeout(() => fired.push('zero'), 0)
    setTimeout(() => fired.push('one'), 1)

    // Nothing is synchronous: scheduling alone runs neither.
    expect(fired).toEqual([])
    expect(vi.getTimerCount()).toBe(2)

    vi.advanceTimersByTime(0)
    expect(fired).toEqual(['zero'])
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1)
    expect(fired).toEqual(['zero', 'one'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('deferSnap — when the snap runs', () => {
  /*
   * The headline. The pair of samples IS the assertion: either half alone is
   * satisfied by a wrong implementation — the first by one that never snaps,
   * the second by one that snaps synchronously.
   *
   * The listener registered after the scheduler stands in for foliate's
   * paginator, which is the party that must not see the write. Its sample is
   * taken from inside the same `pointerup` dispatch, which is the only place
   * the race exists.
   *
   * Live partner: "a drag near a page edge in a paginated EPUB does not turn
   * the page" — the manual selection checklist rows 2.1 and 2.2.
   * **Permanently UNMET by any harness**: it needs a trusted drag.
   */
  it('does not run inside the pointerup handler, and has run one macrotask later', () => {
    const s = scene()
    const duringEvent: { mutations: number; text: string }[] = []
    s.doc.addEventListener('pointerup', () => {
      duringEvent.push({ mutations: s.selection.mutations, text: s.selection.toString() })
    })

    s.drag()

    expect(duringEvent).toEqual([{ mutations: 0, text: 'ick bro' }])
    expect(s.selection.mutations).toBe(0)
    expect(s.selection.toString()).toBe('ick bro')
    expect(s.settled).toEqual([])

    vi.advanceTimersByTime(0)

    expect(s.selection.mutations).toBe(1)
    expect(s.selection.toString()).toBe('quick brown')
    expect(s.settled).toHaveLength(1)
    expect(s.settled[0]?.snapped).toBe(true)
    expect(s.settled[0]?.range?.toString()).toBe('quick brown')
  })

  /*
   * One macrotask, not a timeout with a delay — the acceptance criterion "the
   * popup does not visibly flicker or jump" made checkable. A zero advance is
   * the only thing that separates `setTimeout(fn, 0)` from `setTimeout(fn, 100)`
   * "to be safe", and the timer count afterwards says the queue is empty rather
   * than merely not yet due.
   *
   * That the popup does not visibly move is a human judgement on real hardware:
   * WI-12's manual checklist. **UNMET.**
   */
  it('needs a zero-length advance and nothing more', () => {
    const s = scene()

    s.drag()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(0)
    expect(s.selection.mutations).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  /*
   * The deferral is what removes the ordering dependency, so both arrangements
   * are run. Two `pointerup` listeners already sit on a PDF section document
   * (`makePdf.ts:82` and `#watchSelection`), a third arrives with provenance,
   * and none of them may depend on running first.
   */
  it('does not depend on which pointerup listener was registered first', () => {
    const schedulerFirst = scene({ scheduleFirst: true })
    schedulerFirst.drag()
    vi.runAllTimers()
    expect(schedulerFirst.selection.toString()).toBe('quick brown')
    expect(schedulerFirst.selection.mutations).toBe(1)

    const schedulerLast = scene()
    schedulerLast.drag()
    vi.runAllTimers()
    expect(schedulerLast.selection.toString()).toBe('quick brown')
    expect(schedulerLast.selection.mutations).toBe(1)
  })
})

describe('deferSnap — cancellation', () => {
  /*
   * `cancel()` is the whole cancellation surface, and it is deliberately one
   * function: `ReaderSession#onTeardown` registers it per document and
   * `dispose()` runs every teardown list it holds, so section teardown and
   * session disposal reach the same call. That registration is WI-9's wiring
   * step — WI-8 is the mechanism — so what is asserted here is the mechanism's
   * own guarantee: nothing mutates and nothing settles.
   *
   * Live partners: "close the book mid-gesture", "turn the page mid-gesture" —
   * The manual selection checklist. **Permanently UNMET by any
   * harness**: both need a trusted gesture to interrupt.
   */
  it('mutates nothing and settles nothing when cancelled before the macrotask', () => {
    const s = scene()

    s.drag()
    s.snap.cancel()
    vi.runAllTimers()

    expect(s.selection.mutations).toBe(0)
    expect(s.selection.toString()).toBe('ick bro')
    expect(s.settled).toEqual([])
  })

  /*
   * A guarded-but-live timer is invisible in every other case here and is a
   * real leak across a long reading session — one per gesture, each retaining
   * the section's document. Guarding the callback body instead of clearing the
   * handle is the plausible wrong implementation, and this is what catches it.
   */
  it('leaves no orphan timer behind', () => {
    const s = scene()

    s.drag()
    expect(vi.getTimerCount()).toBe(1)

    s.snap.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })

  /*
   * Idempotent, and not a latch. The second half is what proves `cancel()`
   * cancelled a snap rather than disabled snapping: without it, an
   * implementation that never schedules again also passes.
   */
  it('is idempotent, and does not disable later gestures', () => {
    const s = scene()

    s.snap.cancel()
    s.drag()
    s.snap.cancel()
    s.snap.cancel()
    vi.runAllTimers()
    expect(s.selection.mutations).toBe(0)

    s.drag()
    vi.runAllTimers()
    expect(s.selection.mutations).toBe(1)
    expect(s.selection.toString()).toBe('quick brown')
  })

  /*
   * Only one snap is ever pending. The two gestures target DIFFERENT words on
   * purpose: with both selecting `quick brown` the case would pass whether one
   * snap ran or two, which is the keying failure this suite avoids everywhere.
   * The first gesture's selection object is checked for zero mutations, so a
   * second timer left armed cannot hide.
   *
   * Live partner (WI-12): "two rapid drags" — a real double gesture is not
   * producible through the bridge. **Manual only.**
   */
  it('lets a second gesture replace the first pending snap', () => {
    const s = scene()
    s.drag()

    const inFox = selectionOver({ node: s.words, offset: 17 }, { node: s.words, offset: 18 })
    s.view.setSelection(inFox)
    s.drag()

    expect(vi.getTimerCount()).toBe(1)
    vi.runAllTimers()

    expect(inFox.toString()).toBe('fox')
    expect(inFox.mutations).toBe(1)
    expect(s.selection.toString()).toBe('ick bro')
    expect(s.selection.mutations).toBe(0)
    expect(s.settled).toHaveLength(1)
  })

  /*
   * The reason WI-7 made provenance a token rather than a boolean. No event has
   * to fire for a pending snap to become wrong: the selection it was scheduled
   * for is simply not the live one any more, and only a comparison against the
   * live selection can tell. A boolean would say "a pointer made a selection at
   * some point" and snap the reader's new one to word boundaries.
   *
   * Live partner (WI-12): "replace the selection programmatically between
   * schedule and run" — reachable once the lane exists. **UNMET.**
   */
  it('does not touch a selection that replaced the one the pointer made', () => {
    const s = scene()
    s.drag()

    const elsewhere = selectionOver({ node: s.words, offset: 17 }, { node: s.words, offset: 18 })
    s.view.setSelection(elsewhere)
    vi.runAllTimers()

    expect(elsewhere.mutations).toBe(0)
    expect(elsewhere.toString()).toBe('o')
    expect(s.selection.mutations).toBe(0)
    expect(s.selection.toString()).toBe('ick bro')
    /* **It still settles, and that is the correction**, not an oversight: the
     * gesture happened, so the reader gets a toolbar over whatever is selected
     * now. What provenance refused is the WRITE, which is what
     * `snapped: false` and the untouched `mutations` say. The range is the
     * live, replaced selection — reported, never rewritten. */
    expect(s.settled).toHaveLength(1)
    expect(s.settled[0]?.snapped).toBe(false)
    expect(s.settled[0]?.range?.toString()).toBe('o')
  })

  /*
   * WI-7's guarantee, carried through the deferral — and the first place
   * `isPointerProduced()` is actually consumed. A shift+arrow selection
   * completed by a context-click delivers a perfectly ordinary `pointerup`, so
   * the schedule happens; what must not happen is the SNAP.
   *
   * **The publish must still happen**, and the two halves of this case are why
   * the assertion is `snapped: false` rather than `settled: []`. Refusing to
   * settle would have made the reader's own character-granular selection
   * disappear from the toolbar the moment they right-clicked it — checklist row
   * 1.10 expects it to be there, unsnapped.
   */
  it('does not snap a keyboard selection that a later click merely completed', () => {
    const s = scene()

    s.doc.dispatch('keydown')
    s.doc.dispatch('selectionchange')
    s.doc.dispatch('keyup')
    s.doc.dispatch('pointerdown')
    s.doc.dispatch('pointerup')
    vi.runAllTimers()

    expect(s.selection.mutations).toBe(0)
    expect(s.selection.toString()).toBe('ick bro')
    expect(s.settled).toHaveLength(1)
    expect(s.settled[0]?.snapped).toBe(false)
    expect(s.settled[0]?.range?.toString()).toBe('ick bro')
  })
})

describe('deferSnap — the ground moving under a pending snap', () => {
  /*
   * The check has to happen when the work does. Detaching AFTER the gesture and
   * BEFORE the flush is the only arrangement that tells a run-time check from a
   * schedule-time one — the undetached run in the first describe is the other
   * half of the pair, and without it an implementation that never snaps passes
   * this alone.
   *
   * The connectivity check itself lives in `applySnap`; there is deliberately no
   * second one here to drift out of step with it. What this work item
   * contributes is that the whole call happens inside the macrotask, which is
   * what makes that check a run-time check.
   *
   * Live partner (WI-12): "zoom a PDF mid-gesture". **UNMET.**
   */
  it('aborts when the nodes are detached between scheduling and running', () => {
    const s = scene()
    s.drag()

    // What `makePdf.ts:160` does to a text layer on every zoom or re-render.
    s.fixture.replaceChildren('page', [elem('p', {}, [txt('a fresh page')])])
    vi.runAllTimers()

    expect(s.selection.mutations).toBe(0)
    expect(s.selection.toString()).toBe('ick bro')
    expect(s.settled).toHaveLength(1)
    expect(s.settled[0]?.snapped).toBe(false)
  })

  /*
   * A document detached from its window has no route to a selection at all.
   * The predicate is forced `true` here precisely because the real tracker
   * would answer `false` — which would mask the guard rather than test it — and
   * the point is that the run is quiet, not that it is refused upstream.
   */
  it('settles nothing when there is no window to read a selection from', () => {
    const doc = fakeDocument({ detachedView: true })
    const settled: SnapApplication[] = []
    const snap = deferSnap(doc.asDocument(), {
      isPointerProduced: () => true,
      onSettled: (application) => settled.push(application),
    })

    snap.schedule()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(settled).toEqual([])
  })
})
