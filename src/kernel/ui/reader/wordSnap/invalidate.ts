/**
 * Render generations, one per page document — and who wants to know when one
 * starts.
 *
 * **The counter.** Zooming or re-rendering a PDF page starts a fresh paint
 * without stopping the one in flight. Two paints at different scales then race,
 * and the slower one wins whenever it finishes last — leaving a canvas drawn at
 * the previous scale under a text layer positioned for the new one. Each paint
 * takes a generation and abandons itself the moment a newer one starts
 * (`makePdf.ts`, `superseded()`).
 *
 * **The notification, and why the counter moved here.** `paint` finishes by
 * calling `replaceChildren()` on the `.textLayer`, which detaches every node a
 * selection points at. WI-8 defers the word snap by one macrotask, so a repaint
 * landing in that window would have the snap write into nodes that have left
 * the document; and a snapshot already published describes a page that no
 * longer exists. Both need to hear about the repaint, so the counter needed a
 * seam — it was a module-level `WeakMap` behind an unexported function, and
 * **no test could observe a generation bump cancelling a pending snap**. The
 * extraction is WI-11's first task for that reason, recorded in
 * `decisions-design-20260815-100158.md` §5.
 *
 * **The bump is the signal, not the replacement.** `paint` bumps at the top,
 * before an `await` and well before the children are actually replaced, so at
 * bump time the doomed nodes are all still connected. Waiting for the
 * replacement would mean a second call site inside `paint` and a window in
 * which a pending snap is already writing into nodes about to be destroyed.
 * Announcing the *start* of a repaint is both earlier and cheaper, and it is
 * why the listener may not decide anything by asking whether nodes are still
 * attached — at that moment they always are.
 *
 * **A `MutationObserver` was considered and rejected.** It has no in-process
 * substitute in a lane with no DOM, so choosing it would put the whole of this
 * behaviour out of reach of the only lane that runs. The generation already
 * exists, is already correct, and is already the thing `paint` consults.
 *
 * **One counter per document, however many guards ask for it.** `paint` builds
 * a guard for the page it is painting and `#watchSelection` builds one for the
 * same document when the section loads. They must share state or the
 * notification never crosses between them, so the state lives on the document
 * and the guard is only a handle onto it.
 *
 * **Live-lane partner: none, and there cannot be one.** That a real zoom on a
 * real PDF leaves no stale highlight is a claim about pdf.js and WebKit that no
 * in-process lane reaches — and the `live` lane
 * (`scripts/word-snap-live.mjs`) does not reach it either: it needs a selection
 * made by a gesture, and the bridge dispatches `isTrusted: false` events.
 *
 * **This pairing is permanently unmet.** `dev-docs/manual-selection-checklist.md`
 * §2 carries the PDF zoom rows.
 */

interface DocumentState {
  generation: number
  readonly listeners: Set<() => void>
}

/** Keyed on the document, so the entry dies with the page rather than growing
 *  one row per section the reader passes through. */
const states = new WeakMap<Document, DocumentState>()

function stateOf(doc: Document): DocumentState {
  const found = states.get(doc)
  if (found) return found
  const fresh: DocumentState = { generation: 0, listeners: new Set() }
  states.set(doc, fresh)
  return fresh
}

export interface ReflowGuard {
  /** The generation this document is currently painting. `0` before any paint. */
  generation: () => number
  /** Start a new generation, tell everyone watching, and hand back the token
   *  the caller should hold for the rest of its paint. */
  bump: () => number
  /** Whether a token taken earlier is still the current generation. `paint`'s
   *  `superseded()` is this, negated. */
  isValid: (token: number) => boolean
  /** Hear about every repaint of this document. Returns the unsubscribe, which
   *  removes exactly this listener. */
  onReflow: (listener: () => void) => () => void
}

export function createReflowGuard(doc: Document): ReflowGuard {
  const state = stateOf(doc)

  return {
    generation: () => state.generation,
    isValid: (token) => state.generation === token,

    bump: () => {
      state.generation += 1
      const token = state.generation
      /* Over a COPY, so the list is fixed the moment the repaint starts: a
       * listener registered by another listener must not be told about a
       * repaint that began before it existed.
       *
       * Not for the unsubscribing half — a `Set` iterator already handles
       * deletion of the entry it is on, unlike the array `documentFake` keeps
       * its DOM listeners in. Both halves are asserted in `invalidate.test.ts`
       * anyway, so swapping the container for one without that property cannot
       * quietly take the guarantee away. */
      for (const listener of [...state.listeners]) {
        try {
          listener()
        } catch (cause) {
          /* Isolated, because this runs inside `paint`, which is `async` and
           * whose caller does not catch: a throw escaping here would leave the
           * function as a rejected promise nobody handles — the third unhandled
           * rejection in a file that has already fixed two. Reported rather
           * than discarded, so a broken watcher is loud without taking the page
           * down with it. */
          console.error('Paper: a repaint listener failed', cause)
        }
      }
      return token
    },

    onReflow: (listener) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
  }
}
