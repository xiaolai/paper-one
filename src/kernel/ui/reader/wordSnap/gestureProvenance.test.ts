import { describe, expect, it } from 'vitest'
import { buildFixture, elem, txt } from './domFake.testkit'
import { fakeDocument, type FakeDocument } from './documentFake.testkit'
import { emptySelection, selectionOver, type FakeSelection } from './selectionFake.testkit'
import { watchGestureProvenance, type GestureProvenance } from './gestureProvenance'

/**
 * Provenance, asserted through the events a document actually receives.
 *
 * The plan puts these cases on `ReaderSession` so that `#watchSelection`'s real
 * registration path is exercised. Two things move them here instead, and both
 * are facts about the lane rather than preferences:
 *
 * 1. **There is no consequence to assert at the session yet.** WI-7 records
 *    provenance and deliberately does not wire the snap — `applySnap` is
 *    integrated in WI-9 and deferred in WI-8 — so "snaps" / "does not snap" is
 *    not observable anywhere in this work item. The predicate below is this
 *    unit's whole output, not an internal flag reached for in place of a
 *    consequence.
 * 2. **A `keydown` cannot be dispatched through a session in this lane.**
 *    `#watchKeys` forwards it by constructing a `KeyboardEvent` and dispatching
 *    it on `window`; the unit lane is plain node, where neither global exists.
 *    Every keyboard case here would throw before reaching provenance.
 *
 * What the session keeps is what only the session can show: that these
 * listeners are registered on the right target, exactly once per section load,
 * and removed on teardown. That is `session.test.ts`'s listener-table case.
 *
 * **Live-lane partner: none, and there cannot be one.** Every sequence below is
 * a claim about the order WebKit delivers `pointerdown`, `selectionchange`,
 * `pointerup`, `keydown` and `blur` in for a real drag, a real shift+arrow, and
 * a real interrupted gesture. No harness can produce those: the Tauri MCP bridge
 * dispatches `isTrusted: false` events, which produce no native selection and
 * therefore no `selectionchange` at all. The `live` lane exists
 * (`scripts/word-snap-live.mjs`) and does not help here — it calls the adapter,
 * it does not gesture.
 *
 * **This pairing is permanently unmet.** Drags, double-click, long-press,
 * selection handles, touch, pen and force-touch are covered only by
 * The manual selection checklist §1, and this file claims nothing
 * about them.
 */

const WORDS = 'the quick brown fox'

/** A document with a forward selection over `'ick bro'`, and provenance bound
 *  to it. The offsets address the one text node, not flat coordinates. */
function scene(options: { readonly selection?: FakeSelection | null } = {}): {
  doc: FakeDocument
  selection: FakeSelection
  words: Text
  provenance: GestureProvenance
} {
  const fixture = buildFixture(elem('p', { id: 'para' }, [txt(WORDS)]))
  const words = fixture.text(WORDS)
  const selection =
    options.selection === undefined
      ? selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 })
      : (options.selection ?? emptySelection())
  const doc = fakeDocument({ selection })
  return { doc, selection, words, provenance: watchGestureProvenance(doc.asDocument()) }
}

/** The events a completed mouse drag delivers, in the order WebKit sends them. */
function drag(doc: FakeDocument): void {
  doc.dispatch('pointerdown')
  doc.dispatch('selectionchange')
  doc.dispatch('pointerup')
}

describe('gesture provenance', () => {
  it('marks the selection a completed drag produced', () => {
    const { doc, provenance } = scene()
    drag(doc)
    expect(provenance.isPointerProduced()).toBe(true)
  })

  it('does not mark a keyboard selection that a later click merely completed', () => {
    // The plan's headline failure: shift+arrow, then a context-click. The
    // pointer events are real and `pointerup` really fires — what is missing is
    // any `selectionchange` between them, which is what provenance keys on.
    const { doc, provenance } = scene()

    doc.dispatch('keydown')
    doc.dispatch('selectionchange')
    doc.dispatch('keyup')
    doc.dispatch('pointerdown')
    doc.dispatch('pointerup')
    expect(provenance.isPointerProduced()).toBe(false)

    // And the tracker is not simply stuck: a real drag on the same document
    // still marks. Without this half, an implementation that always answers
    // false passes the case above.
    drag(doc)
    expect(provenance.isPointerProduced()).toBe(true)
  })

  it('releases the pointer on pointercancel, and a later pointerup cannot resurrect it', () => {
    const { doc, provenance } = scene()

    doc.dispatch('pointerdown')
    doc.dispatch('selectionchange')
    doc.dispatch('pointercancel')
    expect(provenance.isPointerProduced()).toBe(false)

    /* The second half is what proves the flag was RELEASED rather than merely
     * not acted on. Without it, an implementation that ignores `pointercancel`
     * entirely also passes: nothing has asked it a question yet. */
    doc.dispatch('pointerup')
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('releases the pointer on a WINDOW blur, and not on a document blur', () => {
    const { doc, provenance } = scene()
    const view = doc.defaultView
    if (!view) throw new Error('the fixture document has no window')

    doc.dispatch('pointerdown')
    doc.dispatch('selectionchange')

    /* Keyed on the target, which is the whole point. `blur` does not bubble
     * from a focus change to the window, so a listener on the document never
     * hears it — the mistake `bindSelectionFix` documents at `makePdf.ts:87`.
     * A fake with one shared listener table would let it pass. */
    doc.dispatch('blur')
    expect(provenance.isPointerProduced()).toBe(true)

    view.dispatch('blur')
    expect(provenance.isPointerProduced()).toBe(false)
    doc.dispatch('pointerup')
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('releases the pointer on keydown, so a missed pointerup cannot mark a keyboard selection', () => {
    /* The bounded failure mode, pinned as an asymmetry. A `pointerdown` with no
     * release of any kind is possible — a drag ended by something that delivers
     * neither `pointerup`, `pointercancel` nor `blur` — and the guarantee is
     * that the worst it can produce is "does not snap", never "snaps a keyboard
     * selection". `keydown` is what draws that line, so both sides are run. */
    const released = scene()
    released.doc.dispatch('pointerdown')
    released.doc.dispatch('keydown')
    released.doc.dispatch('selectionchange')
    released.doc.dispatch('keyup')

    const stuck = scene()
    stuck.doc.dispatch('pointerdown')
    stuck.doc.dispatch('selectionchange')
    stuck.doc.dispatch('keyup')

    expect([
      released.provenance.isPointerProduced(),
      stuck.provenance.isPointerProduced(),
    ]).toEqual([false, true])
  })

  it('is per selection, not per gesture: replacing the selection drops it', () => {
    const { doc, words, selection, provenance } = scene()
    drag(doc)
    expect(provenance.isPointerProduced()).toBe(true)

    /* No event at all — the selection is simply somewhere else now. A boolean
     * flag cannot tell "this is still the selection the pointer made" from "a
     * pointer made SOME selection at some point", and this is the case that
     * separates them. WI-8 depends on it: a snap scheduled for one selection
     * must not land on another. */
    selection.setBaseAndExtent(words, 16, words, 19)
    expect(selection.toString()).toBe('fox')
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('keeps provenance through a trailing selectionchange that moved nothing', () => {
    /* WebKit fires `selectionchange` ASYNCHRONOUSLY, so a drag's last one can
     * land after `pointerup`. An implementation that dropped provenance on any
     * post-pointerup `selectionchange` would silently refuse to snap every
     * gesture where it did — and would look identical to a correct one in every
     * other case here. Provenance is dropped by the selection MOVING, which the
     * case below covers, not by an event arriving. */
    const { doc, provenance } = scene()
    drag(doc)

    doc.dispatch('selectionchange')

    expect(provenance.isPointerProduced()).toBe(true)
  })

  it('does not mark a selection made after the pointer went up', () => {
    const { doc, words, selection, provenance } = scene()
    drag(doc)

    selection.setBaseAndExtent(words, 16, words, 19)
    doc.dispatch('selectionchange')
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('marks nothing when the document has no selection to mark', () => {
    const { doc, provenance } = scene({ selection: null })
    drag(doc)
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('answers false for a document detached from its window', () => {
    // No window is no `getSelection`, so there is nothing to take provenance
    // OF. It must not throw on the way to saying so, and it must not register a
    // `blur` listener it has nowhere to put.
    const doc = fakeDocument({ detachedView: true })
    const provenance = watchGestureProvenance(doc.asDocument())

    drag(doc)
    expect(provenance.isPointerProduced()).toBe(false)
    expect(doc.listenerCounts()['blur']).toBeUndefined()
    provenance.unbind()
    expect(doc.listenerCounts()).toEqual({})
  })

  it('removes every listener it added, on the document and on the window', () => {
    const { doc, provenance } = scene()
    const view = doc.defaultView
    if (!view) throw new Error('the fixture document has no window')

    expect(doc.listenerCounts()).toEqual({
      pointerdown: 1,
      pointerup: 1,
      pointercancel: 1,
      keydown: 1,
      selectionchange: 1,
    })
    expect(view.listenerCounts()).toEqual({ blur: 1 })

    provenance.unbind()

    expect(doc.listenerCounts()).toEqual({})
    expect(view.listenerCounts()).toEqual({})
    // And the behaviour follows the table: an unbound tracker hears nothing.
    drag(doc)
    expect(provenance.isPointerProduced()).toBe(false)
  })

  it('gives the same answer whichever pointerup listener runs first', () => {
    /* Two `pointerup` listeners genuinely coexist on a PDF page document:
     * `bindSelectionFix` (`makePdf.ts:82`) and this one. Neither may depend on
     * running first. The stand-in reads the answer AT THE MOMENT IT FIRES, so
     * an implementation whose `pointerup` handler changed the answer would give
     * two different readings depending on the order. */
    const readings: Record<string, boolean> = {}

    for (const order of ['stand-in first', 'stand-in second'] as const) {
      const fixture = buildFixture(elem('p', { id: 'para' }, [txt(WORDS)]))
      const words = fixture.text(WORDS)
      const selection = selectionOver({ node: words, offset: 6 }, { node: words, offset: 13 })
      const doc = fakeDocument({ selection })

      let provenance: GestureProvenance
      const standIn = (): void => {
        readings[order] = provenance.isPointerProduced()
      }
      if (order === 'stand-in first') {
        doc.addEventListener('pointerup', standIn)
        provenance = watchGestureProvenance(doc.asDocument())
      } else {
        provenance = watchGestureProvenance(doc.asDocument())
        doc.addEventListener('pointerup', standIn)
      }
      drag(doc)
    }

    expect(readings).toEqual({ 'stand-in first': true, 'stand-in second': true })
  })
})

/**
 * The fake document's own contract.
 *
 * Every case above runs against it. If it stopped keying dispatch on the event
 * type, or shared one listener table between the document and the window, or
 * removed every listener of a type rather than the one it was given, those
 * cases would stay green while asserting nothing — the failure mode
 * `markGeometry.test.ts:53` documents one layer down. Nothing else in the suite
 * can detect it, because it looks exactly like success everywhere it matters.
 */
describe('the fake document contract', () => {
  it('dispatches only to the listeners of the type given', () => {
    const doc = fakeDocument()
    const heard: string[] = []
    doc.addEventListener('pointerup', () => heard.push('pointerup'))
    doc.addEventListener('pointercancel', () => heard.push('pointercancel'))

    doc.dispatch('pointerup')

    expect(heard).toEqual(['pointerup'])
  })

  it('removes exactly the function it was given, leaving its siblings', () => {
    const doc = fakeDocument()
    const heard: string[] = []
    const first = (): void => void heard.push('first')
    const second = (): void => void heard.push('second')
    doc.addEventListener('pointerup', first)
    doc.addEventListener('pointerup', second)

    doc.removeEventListener('pointerup', first)
    doc.dispatch('pointerup')

    expect(heard).toEqual(['second'])
    expect(doc.listenerCounts()).toEqual({ pointerup: 1 })
  })

  it('keeps the window table apart from the document table', () => {
    const doc = fakeDocument()
    const view = doc.defaultView
    if (!view) throw new Error('the fake document has no window')
    const heard: string[] = []
    doc.addEventListener('blur', () => heard.push('document'))
    view.addEventListener('blur', () => heard.push('window'))

    view.dispatch('blur')

    expect(heard).toEqual(['window'])
    expect(doc.listenerCounts()).toEqual({ blur: 1 })
    expect(view.listenerCounts()).toEqual({ blur: 1 })
  })

  it('fires listeners in registration order, over a copy of the list', () => {
    const doc = fakeDocument()
    const heard: string[] = []
    const second = (): void => void heard.push('second')
    // Unregisters the one behind it mid-dispatch: iterating the live array
    // would skip `second` entirely.
    doc.addEventListener('pointerup', () => {
      heard.push('first')
      doc.removeEventListener('pointerup', second)
    })
    doc.addEventListener('pointerup', second)

    doc.dispatch('pointerup')

    expect(heard).toEqual(['first', 'second'])
    expect(doc.listenerCounts()).toEqual({ pointerup: 1 })
  })

  it('honours { once: true } and leaves no entry behind', () => {
    const doc = fakeDocument()
    let fired = 0
    doc.addEventListener('pagehide', () => void (fired += 1), { once: true })

    doc.dispatch('pagehide')
    doc.dispatch('pagehide')

    expect(fired).toBe(1)
    expect(doc.listenerCounts()).toEqual({})
  })
})
