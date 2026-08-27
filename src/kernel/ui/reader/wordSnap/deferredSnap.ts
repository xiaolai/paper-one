/**
 * Run the snap one macrotask after the gesture, and abandon it when the ground
 * moves.
 *
 * foliate's paginator listens for `selectionchange` and, while its own
 * `isPointerSelecting` flag is up, runs a 700 ms debounced
 * `checkPointerSelection` that calls `this.next()` once the selection's end
 * passes the last visible range (`paginator.js:586`). Snapping **extends the
 * selection end forward** — precisely that trigger. Whether our write is seen
 * while the flag is still up depends on which `pointerup` listener registered
 * first, which is load-order dependent and therefore non-deterministic: the same
 * drag turns the page on one build and not on the next.
 *
 * A macrotask makes it deterministic. Every `pointerup` listener for one event
 * runs to completion before any macrotask does, so by the time this callback
 * fires the paginator's flag is already down — whatever order the three
 * `pointerup` listeners a section document carries were registered in. It
 * affects paginated EPUB only; the fixed-layout/PDF renderer has no such
 * handler, and the deferral is applied unconditionally rather than branching on
 * the renderer, because a branch at the point of mutation is a second thing to
 * get wrong for no gain — a macrotask is not perceptible.
 *
 * **`setTimeout(fn, 0)`, not `MessageChannel`.** The latter is a marginally
 * earlier macrotask and is not controllable by vitest's fake timers, which would
 * put this file's entire cancellation surface out of reach of the only lane that
 * runs. The slower, testable option is the right trade, and it is written down
 * here rather than rediscovered later.
 *
 * **Deferring means the ground can move.** Between the gesture and the callback
 * the reader can turn the page (the section's document is torn down), close the
 * book (`dispose()`), select something else, or — on a PDF — zoom, which makes
 * `makePdf` call `replaceChildren()` on the text layer and detach every node the
 * selection points at (WI-11). So **nothing is captured at schedule time**: the
 * selection is read when the callback runs, the provenance token is compared
 * when the callback runs, and `applySnap`'s own connectivity check therefore
 * happens when the callback runs too, because the whole call sits inside the
 * macrotask. There is deliberately no second `isConnected` check here to drift
 * out of step with that one.
 *
 * **Cancellation is one function.** `cancel()` covers section teardown and
 * session disposal alike: `ReaderSession#onTeardown` registers it per document,
 * and `dispose()` runs every teardown list the session holds — so one
 * registration reaches both. It clears the handle rather than guarding the
 * callback body, because a guarded-but-live timer leaks one entry per gesture
 * across a long reading session and looks identical from every other angle.
 *
 * **`onSettled` fires exactly when the gesture SETTLED** — whether or not
 * anything was snapped, and whether or not anything was mutated. A cancelled
 * snap does not fire it, because there is no longer a gesture to report; every
 * other path does. That is what lets `publish()` read it as *the selection is
 * final, here is what it now is* rather than as a bare notification.
 *
 * **Provenance gates the snap and nothing else, and the distinction is
 * load-bearing.** The rule is "never snap a keyboard selection", not "never
 * report a selection the keyboard touched" — and a `pointerup` published
 * directly, unconditionally, before this module existed. Reading
 * `isPointerProduced()` as a reason to return early merged the two and cost
 * the reader the toolbar outright: `pointerdown → pointerup →
 * selectionchange` (WebKit fires it asynchronously) and `pointerdown → keydown
 * → selectionchange → pointerup` (any keystroke mid-drag) both answer `false`,
 * and both are ordinary. So a refused snap settles UNSNAPPED — the selection
 * exactly as the reader made it — and only a cancelled one settles nothing.
 *
 * **Wired by WI-9**, in `ReaderSession#watchSelection`: `pointerup` schedules,
 * `onSettled` publishes the snapshot, and `cancel` is registered through
 * `#onTeardown` — which is what makes section teardown and session disposal one
 * path rather than two.
 *
 * **Live-lane partner: none, and there cannot be one.** That no page turns
 * cannot be asserted in process at any level — it lives in foliate's debounce
 * interacting with real listener ordering in WebKit, on a paginated EPUB, after
 * a real drag. The `live` lane exists (`scripts/word-snap-live.mjs`) and does
 * not reach it: the bridge dispatches `isTrusted: false` events, which produce
 * no native selection at all. What the unit lane proves is the ordering (the
 * snap has not run while the `pointerup` listeners are still running) and the
 * cancellation paths.
 *
 * **This pairing is permanently unmet.** the manual selection checklist
 * §2 is the only cover, and if it fails there the fallback is suppressing
 * `checkPointerSelection` around the mutation — which means touching the pinned
 * foliate fork.
 */

import { applySnap, unsnapped, type SnapApplication } from './applySnap'

export interface DeferredSnap {
  /**
   * Arm the snap for the next macrotask. Replaces any snap already pending —
   * a rapid second gesture supersedes the first rather than queueing behind
   * it, so only one is ever outstanding.
   *
   * ⚠️ **THE EVENT IS READ FOR ONE FIELD ONLY: `detail`.** It is the click
   * count, and the only moment it exists is the gesture — by the time the
   * macrotask runs there is no event left to ask. It travels because a
   * double-click at the end of a line needs correcting and nothing observable
   * later can tell one from an ordinary drag; see `applySnap`'s
   * `wordAtAnchor`.
   *
   * Optional, so a caller with no event (a test, a programmatic selection)
   * still schedules an ordinary snap.
   */
  schedule: (event?: { readonly detail?: number } | undefined) => void
  /** Drop a pending snap without running it. Idempotent, safe with nothing
   *  pending, and not a latch: a later gesture schedules again. */
  cancel: () => void
}

export interface DeferredSnapOptions {
  /** Whether the selection live at the moment this is asked is the one a
   *  pointer gesture produced — `GestureProvenance.isPointerProduced`. Asked
   *  when the snap runs, never when it is scheduled: a selection replaced in
   *  between must not be snapped, and no event needs to have fired for that to
   *  be true. `false` means *do not snap it*; it does not mean *do not report
   *  it*. */
  readonly isPointerProduced: () => boolean
  /** Called when the gesture settled, with the selection as it now stands —
   *  snapped when provenance allowed it, untouched when it did not. Not called
   *  for a snap that was cancelled, and not called for a document with no
   *  window left to read a selection from. */
  readonly onSettled: (application: SnapApplication) => void
}

export function deferSnap(doc: Document, options: DeferredSnapOptions): DeferredSnap {
  let handle: ReturnType<typeof setTimeout> | null = null
  /* Captured at SCHEDULE time, unlike everything else here, because it is the
     one fact that stops existing when the gesture does. Reset on cancel so a
     dropped double-click cannot colour the next gesture. */
  let doubleClick = false

  const cancel = (): void => {
    doubleClick = false
    if (handle === null) return
    clearTimeout(handle)
    handle = null
  }

  const run = (): void => {
    /* Cleared first, so `onSettled` may schedule or cancel without fighting a
     * handle that has already fired. */
    handle = null
    const selection = doc.defaultView?.getSelection()
    if (!selection) return
    /* The one branch, and it chooses between two RESULTS rather than between
     * running and returning — see the header. Provenance is asked here, after
     * the selection has been read, because both answers need the selection. */
    const wasDoubleClick = doubleClick
    doubleClick = false
    options.onSettled(
      options.isPointerProduced()
        ? applySnap(selection, { doubleClick: wasDoubleClick })
        : unsnapped(selection),
    )
  }

  return {
    schedule: (event) => {
      cancel()
      doubleClick = (event?.detail ?? 0) >= 2
      handle = setTimeout(run, 0)
    },
    cancel,
  }
}
