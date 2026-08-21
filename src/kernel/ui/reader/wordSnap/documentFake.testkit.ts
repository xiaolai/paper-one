/**
 * A fake `Document` and `Window` that keep listener tables, keyed on both the
 * event type and the target it was registered on.
 *
 * The `unit` lane has **no DOM environment and no jsdom, deliberately** — see
 * the lane's own description in `.claude/tdd-guardian/config.json`. Gesture
 * provenance is nothing but listeners and the order they fire in, so it needs
 * an event target to be testable at all, and this is it.
 *
 * The discipline is `markGeometry.test.ts:53`'s: a fake that answers the same
 * for the right and the wrong call certifies bugs. So this one:
 *
 * 1. **Dispatches by type.** `dispatch('pointerup')` reaches the `pointerup`
 *    listeners and nothing else, so an implementation that released the
 *    pointer flag on the wrong event changes the answer.
 * 2. **Keeps the document's table and the window's apart.** A `blur` listener
 *    registered on the document is NOT reached by a window blur. That is the
 *    whole point of `bindSelectionFix`'s window registration
 *    (`makePdf.ts:87`), and a fake with one shared table would let the mistake
 *    through silently.
 * 3. **Removes exactly the function it was given**, not every listener of that
 *    type — so a teardown that removes the wrong closure leaves a count
 *    behind, which is the leak these tables exist to catch.
 * 4. **Preserves registration order** and dispatches over a COPY of the list,
 *    so a listener that unregisters during a dispatch does not make the next
 *    one be skipped. Order is what the "no ordering dependency with
 *    `bindSelectionFix`" case varies.
 * 5. **Honours `{ once: true }`**, which `#onTeardown`'s `pagehide`
 *    registration depends on.
 *
 * **It does not de-duplicate identical registrations**, where the real DOM
 * does. Every listener in `session.ts` is a closure built fresh on each section
 * load, so de-duplication could not change a count here — and leaving it out
 * makes the table the stricter instrument: a genuine double-registration shows
 * up as a 2 rather than being folded away. The one thing it forbids is code
 * that deliberately re-adds the same function reference, which nothing does.
 *
 * `gestureProvenance.test.ts` asserts all five points above, because a fake
 * that quietly stopped doing any of them would leave every case that depends on
 * it green and vacuous.
 *
 * Test-only. The `.testkit.ts` suffix is the same convention as
 * `domFake.testkit.ts` and `selectionFake.testkit.ts`: vitest collects
 * `*.test.ts`, so this file is imported by tests without being run as one, and
 * nothing under `src/` imports it, so it never reaches a bundle.
 *
 * **Live-lane partner: none, and there cannot be one.** Everything here is a
 * claim about how WebKit delivers events to a book's iframe document, and event
 * DELIVERY is the one thing no harness reaches: the MCP bridge dispatches
 * `isTrusted: false` events, from which WebKit builds no native selection and
 * fires no `selectionchange`. The `live` lane exists
 * (`scripts/word-snap-live.mjs`) and covers the adapter, not the events.
 *
 * **This pairing is permanently unmet.** The only cover is
 * `dev-docs/manual-selection-checklist.md`, run by a person on real hardware.
 */

import type { FakeSelection } from './selectionFake.testkit'

/** How many live listeners each type has. Types with none are absent, so an
 *  emptied table is `{}` and `toEqual({})` means what it says. */
export type ListenerCounts = Record<string, number>

interface Registration {
  readonly fn: (event: unknown) => void
  readonly once: boolean
}

type Listener = (event: unknown) => void

/** Options as `addEventListener` accepts them; only `once` is modelled. */
type AddOptions = boolean | { once?: boolean }

class FakeEventTarget {
  private readonly table = new Map<string, Registration[]>()

  addEventListener(type: string, fn: Listener, options?: AddOptions): void {
    const once = typeof options === 'object' && options !== null ? options.once === true : false
    const list = this.table.get(type)
    if (list) list.push({ fn, once })
    else this.table.set(type, [{ fn, once }])
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.table.get(type)
    if (!list) return
    const at = list.findIndex((registration) => registration.fn === fn)
    if (at < 0) return
    list.splice(at, 1)
    if (list.length === 0) this.table.delete(type)
  }

  /**
   * Deliver one event to the listeners of exactly that type, in the order they
   * were registered.
   *
   * Over a copy, because a listener may add or remove listeners while it runs —
   * `{ once: true }` does exactly that — and iterating the live array would then
   * skip the next one.
   */
  dispatch(type: string, event: unknown = {}): void {
    for (const registration of [...(this.table.get(type) ?? [])]) {
      if (registration.once) this.removeEventListener(type, registration.fn)
      registration.fn(event)
    }
  }

  listenerCounts(): ListenerCounts {
    const counts: ListenerCounts = {}
    for (const [type, list] of this.table) if (list.length > 0) counts[type] = list.length
    return counts
  }
}

export class FakeWindow extends FakeEventTarget {
  constructor(private selection: FakeSelection | null) {
    super()
  }

  getSelection(): Selection | null {
    return this.selection?.asSelection() ?? null
  }

  /** Replace the document's selection, as a click elsewhere in the book would.
   *  `null` is a document with no selection at all. */
  setSelection(selection: FakeSelection | null): void {
    this.selection = selection
  }

  asWindow(): Window {
    return this as unknown as Window
  }
}

/** A `<style>` the app creates and may later find again or take back off. */
export interface FakeStyleElement {
  id: string
  textContent: string
  remove(): void
}

export class FakeDocument extends FakeEventTarget {
  /**
   * The document's stylesheets. EMPTY IS A REAL ANSWER; ABSENT IS NOT.
   *
   * Every `Document` has a `StyleSheetList`, and it is iterable — a book with
   * no CSS has an empty one. Leaving the property off made this fake the only
   * document in existence without it, and when the session began reading the
   * book's own rules (`suppressEmptyGeneratedContent`) that showed up as
   * `doc.styleSheets is not iterable` in seventy-three tests that have nothing
   * to do with stylesheets.
   *
   * Mutable so a test can put rules in it; see `withStyleSheets`.
   */
  styleSheets: { cssRules: unknown[] }[] = []

  /**
   * Just enough `head` to hold a `<style>` the app installs.
   *
   * `suppressEmptyGeneratedContent` appends one and looks it up again by id, so
   * a fake that could be handed a stylesheet but not remember what was done
   * about it would report the first pass and lose the second.
   */
  readonly head = {
    children: [] as FakeStyleElement[],
    appendChild(el: FakeStyleElement) {
      this.children.push(el)
    },
  }

  constructor(readonly defaultView: FakeWindow | null) {
    super()
  }

  createElement(_tag: string): FakeStyleElement {
    const head = this.head
    return {
      id: '',
      textContent: '',
      remove() {
        head.children = head.children.filter((el) => el !== this)
      },
    }
  }

  getElementById(id: string): FakeStyleElement | null {
    return this.head.children.find((el) => el.id === id) ?? null
  }

  /** Nothing in this fake carries attributes, so nothing matches. */
  querySelector(_selectors: string): null {
    return null
  }

  /** Give this document some CSS to be read. Returns itself, for chaining. */
  withStyleSheets(sheets: { cssRules: unknown[] }[]): this {
    this.styleSheets = sheets
    return this
  }

  asDocument(): Document {
    return this as unknown as Document
  }
}

export interface DocumentFakeOptions {
  /** The selection `defaultView.getSelection()` answers with. */
  readonly selection?: FakeSelection | null
  /** A document detached from its window — `defaultView` is `null`, as it is
   *  for a document whose iframe has already been removed. */
  readonly detachedView?: boolean
}

export function fakeDocument(options: DocumentFakeOptions = {}): FakeDocument {
  const view = options.detachedView ? null : new FakeWindow(options.selection ?? null)
  return new FakeDocument(view)
}
