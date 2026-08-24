import { describe, expect, it, vi } from 'vitest'
import { applySnap } from './applySnap'
import { buildFixture, elem, txt, type Fixture } from './domFake.testkit'
import {
  emptySelection,
  isBackward,
  selectionOver,
  type Boundary,
  type FakeSelection,
} from './selectionFake.testkit'

/**
 * Writing a snap back to the live selection.
 *
 * Two behaviours of WebKit govern this module, both measured in the running app
 * rather than reasoned about:
 *
 * - **`setBaseAndExtent` detaches a previously captured `Range`.**
 *   `captured === getRangeAt(0)` is `true` before the call and `false` after,
 *   and the captured range keeps returning the OLD text while the live one
 *   returns the snapped text. An adapter that returns the range it captured on
 *   the way in therefore hands `publish()` a stale CFI under a snapped-looking
 *   selection.
 * - **A naive `setBaseAndExtent(start, end)` flips a backward drag forward.**
 *   The snapped result is ordered and carries no direction, so the orientation
 *   has to be read from `anchorNode`/`focusNode` *before* the write and put
 *   back deliberately.
 *
 * Every case here runs against `selectionFake.testkit.ts` and
 * `domFake.testkit.ts`. **There is no in-process alternative**: the `unit` lane
 * has no DOM and no jsdom by design, and a jsdom `Selection` would be a third
 * implementation to trust rather than a check on this one.
 *
 * **The mock pairing is MET for the two behaviours that matter most here, and
 * only there.** The fake asserts them; it cannot prove them, because they are
 * WebKit's and not this file's. The live partner is the `live` lane —
 * `node scripts/word-snap-live.mjs`, checks `range-detach` ("a captured Range
 * is detached by `setBaseAndExtent`") and `backward-direction` ("a
 * programmatically-created backward selection survives snapping"). Both call
 * this adapter on a real WebKit `Selection` and read back
 * `getSelection().toString()`.
 *
 * Two caveats, both load-bearing: the lane is **manual-only**, so a green
 * `pnpm test` is no evidence it has been run; and it reaches no **gesture** —
 * the bridge dispatches `isTrusted: false` events, so a real backward drag,
 * a torn-down section and a caret click stay on
 * The manual selection checklist. Nothing below is an integration
 * test.
 */

/** A boundary, named by the content of its text node — unique by construction,
 *  so a case that walked to the wrong node cannot look right. */
function at(fixture: Fixture, data: string, offset: number): Boundary {
  return { node: fixture.text(data), offset }
}

interface Fields {
  readonly anchorNode: Text | null
  readonly anchorOffset: number
  readonly focusNode: Text | null
  readonly focusOffset: number
}

function fieldsOf(selection: FakeSelection): Fields {
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  }
}

/**
 * The four boundary fields, compared by **identity** for the nodes.
 *
 * Never `toEqual` on a snapshot: a deep compare of two distinct fake nodes with
 * the same shape reports them equal, which is precisely the failure
 * `markGeometry.test.ts:53` records — a fake that answers the same for the
 * right and the wrong node certifies bugs.
 */
function expectFields(selection: FakeSelection, expected: Fields): void {
  expect(selection.anchorNode).toBe(expected.anchorNode)
  expect(selection.anchorOffset).toBe(expected.anchorOffset)
  expect(selection.focusNode).toBe(expected.focusNode)
  expect(selection.focusOffset).toBe(expected.focusOffset)
}

/** `the quick brown fox`, with the flat offsets the cases speak in:
 *  `quick` is 4..9, `brown` is 10..15. */
function sentence(): Fixture {
  return buildFixture(elem('p', {}, [txt('the quick brown fox')]))
}

describe('applySnap — the live selection after the write', () => {
  /*
   * The carrying case. Asserted through the fake's resulting TEXT, so an
   * adapter that called `setBaseAndExtent` with the arguments in the wrong
   * order fails here — which `expect(setBaseAndExtent).toHaveBeenCalledWith(…)`
   * would not.
   *
   * Live partner: the `live` lane's `backward-direction` check calls the
   * adapter on a real WebKit selection and reads back
   * `getSelection().toString()`. MET, for the adapter; the DRAG that produces
   * such a selection is still manual-only.
   */
  it('turns a forward mid-word drag into the whole words', () => {
    const fixture = sentence()
    const selection = selectionOver(at(fixture, 'the quick brown fox', 5), at(fixture, 'the quick brown fox', 12))

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(true)
    expect(selection.toString()).toBe('quick brown')
    expect(selection.mutations).toBe(1)
  })

  /*
   * The case a wiring assertion passes and a state assertion fails. The text is
   * identical in both directions, so it cannot discriminate on its own: the
   * four fields and the direction predicate are what catch the naive
   * `setBaseAndExtent(start, end)`.
   *
   * Live partner: `word-snap-live.mjs`'s `backward-direction` check — a
   * programmatically-created backward selection survives snapping in WebKit,
   * built with `setBaseAndExtent(later…, earlier…)`. **MET, for the adapter.**
   * A backward *drag* is a different claim and stays on the manual checklist
   * (row 1.2), permanently.
   */
  it('keeps a backward drag backward', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 12 }, { node: text, offset: 5 })
    expect(isBackward(selection)).toBe(true)

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(true)
    expect(selection.toString()).toBe('quick brown')
    expectFields(selection, { anchorNode: text, anchorOffset: 15, focusNode: text, focusOffset: 4 })
    expect(isBackward(selection)).toBe(true)
    expect(selection.mutations).toBe(1)
  })

  /*
   * Preserve, never collapse. A punctuation-only selection has no word-like
   * segment to snap to, and the UI must not end up showing a blue selection
   * with no popup over it.
   *
   * Live partner (WI-12): "a punctuation-only selection in WebKit is untouched
   * by the adapter". UNMET.
   */
  it('leaves a selection with nothing to snap to byte-identical', () => {
    const fixture = buildFixture(elem('p', {}, [txt('a + b')]))
    const plus = fixture.text('a + b')
    const selection = selectionOver({ node: plus, offset: 2 }, { node: plus, offset: 3 })
    const before = fieldsOf(selection)

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(false)
    expectFields(selection, before)
    expect(selection.toString()).toBe('+')
    expect(selection.mutations).toBe(0)
  })

  /*
   * Each write is a `selectionchange`, and WI-8 exists because that event has a
   * consumer that turns pages — so "write back unconditionally, it is
   * idempotent anyway" is not free. The mutation count is legitimately the
   * point here; the field and text assertions are what carry the case.
   *
   * Live partner (WI-12): "an aligned selection emits no `selectionchange`",
   * counted in WebKit. UNMET.
   */
  it('does not touch a selection that is already word-aligned', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 4 }, { node: text, offset: 9 })
    const before = fieldsOf(selection)

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(false)
    expectFields(selection, before)
    expect(selection.toString()).toBe('quick')
    expect(selection.mutations).toBe(0)
  })

  /*
   * Applying twice must be a no-op the second time, and "did anything change"
   * has to be decided against the LIVE selection rather than against the pure
   * result — the pure result is the same both times.
   *
   * Live partner: covered by the aligned-selection live case above. UNMET.
   */
  it('mutates once when applied twice', () => {
    const fixture = sentence()
    const selection = selectionOver(at(fixture, 'the quick brown fox', 5), at(fixture, 'the quick brown fox', 12))

    const first = applySnap(selection.asSelection())
    const second = applySnap(selection.asSelection())

    expect(first.snapped).toBe(true)
    expect(second.snapped).toBe(false)
    expect(selection.toString()).toBe('quick brown')
    expect(selection.mutations).toBe(1)
  })

  /*
   * The pairing that matters most in the whole feature. The fake's detach model
   * makes a reused range answer with the PRE-snap text, so this one assertion
   * distinguishes a re-read from a reuse — and holding the range from before
   * the write is the natural way to write this function.
   *
   * Live partner: `word-snap-live.mjs`'s `range-detach` check — the same claim,
   * measured in WebKit. **MET.** This is the behaviour nobody would guess, so
   * the fake was asserting something only that check can confirm; if the two
   * ever disagree, every Level 4 assertion in this file is suspect at once.
   */
  it('returns the range read after the write, never one captured before it', () => {
    const fixture = sentence()
    const selection = selectionOver(at(fixture, 'the quick brown fox', 5), at(fixture, 'the quick brown fox', 12))
    const captured = selection.getRangeAt(0)
    expect(captured.toString()).toBe('uick br')

    const result = applySnap(selection.asSelection())

    expect(result.range?.toString()).toBe('quick brown')
    expect(result.range).not.toBe(captured.asRange())
    expect(captured.toString()).toBe('uick br')
    expect(selection.mutations).toBe(1)
  })

  /*
   * The sentinel doing its job through the whole adapter: neither edge drags a
   * word out of the other block.
   *
   * The boundary FIELDS are the observable, deliberately not `toString()`. The
   * fake models WebKit's verified merge, so the text here is `'doneStart'` —
   * asserting it would be asserting the pre-existing defect, which WI-9 fixes.
   *
   * Live partner: `word-snap-live.mjs`'s `block-merge` check — the merge
   * reproduces in WebKit and `rangeText` suppresses it, asserted in one run.
   * **MET.**
   */
  it('snaps each edge within its own block', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('all done')]), elem('p', {}, [txt('Start here')])]),
    )
    const selection = selectionOver(at(fixture, 'all done', 6), at(fixture, 'Start here', 2))

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(true)
    expectFields(selection, {
      anchorNode: fixture.text('all done'),
      anchorOffset: 4,
      focusNode: fixture.text('Start here'),
      focusOffset: 5,
    })
    expect(selection.mutations).toBe(1)
  })

  /*
   * The WI-11 shape: a selection made before a repaint, applied after it. The
   * old subtree is internally intact — it flattens, it segments, it snaps — and
   * every one of its nodes is out of the document, so the write must not
   * happen. This row is what the `isConnected` check earns its place with;
   * removing that check makes it mutate a tree nobody can see.
   *
   * The two mixed rows are decided one stage earlier, by the mapping: a live
   * anchor and a detached focus are not in one tree, so the walk from either of
   * them never reaches the other and `snapInDom` declines. That is not an
   * accident of the fake — connectivity really is a property of the topmost
   * ancestor, in the DOM as here, so a single-range selection with one end in
   * and one end out cannot be walked in a browser either. **A one-sided
   * `isConnected` check therefore survives this lane**; the pairing is
   * "snapping into a torn-down section aborts", which the `live` lane does not
   * check either — tearing a section down under a pending snap needs a real
   * gesture and a real navigation. **Still UNMET**, and covered only by
   * The manual selection checklist.
   */
  it.each([
    { row: 'both ends inside the replaced subtree', anchor: 'stale', focus: 'stale' },
    { row: 'a detached anchor and a live focus', anchor: 'stale', focus: 'kept' },
    { row: 'a live anchor and a detached focus', anchor: 'kept', focus: 'stale' },
  ] as const)('aborts cleanly when a boundary node is detached — $row', ({ anchor, focus }) => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('div', { id: 'layer' }, [elem('p', {}, [txt('the quick brown fox')])]),
        elem('p', {}, [txt('still on the page')]),
      ]),
    )
    const stale = fixture.text('the quick brown fox')
    const kept = fixture.text('still on the page')
    const end = (which: 'stale' | 'kept', offset: number): Boundary => ({
      node: which === 'stale' ? stale : kept,
      offset,
    })
    const selection = selectionOver(end(anchor, 6), end(focus, 12))
    const before = fieldsOf(selection)

    fixture.replaceChildren('layer', [elem('p', {}, [txt('after the repaint')])])
    expect(stale.isConnected).toBe(false)
    expect(kept.isConnected).toBe(true)

    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(false)
    expectFields(selection, before)
    expect(selection.mutations).toBe(0)
  })

  /*
   * A throw must not escape into `publish()` — it would take the selection
   * popup down with it.
   *
   * The flattener is NOT mocked here. Injecting a throwing `flatten` would be
   * mocking my own module, which `policy-core` rule 4 forbids; a `data`
   * accessor that throws makes the REAL flattener throw, which is both
   * permitted and a better model of what actually goes wrong when the DOM is
   * torn down under a walk.
   *
   * **Swallowed, but not silent.** `snapWordRange` throws deliberately in two
   * places — the caller-bug `RangeError` (`snapWordRange.ts:102`) and the
   * collapse invariant (`snapWordRange.ts:126`) — and the whole justification
   * for making the second one throw (decisions §4) is that it "fails loudly at
   * the origin instead of silently publishing no selection". Both routes pass
   * through the catch below, so a bare `catch {}` turns them back into exactly
   * the silent no-op the decision forbade. The report is what keeps the
   * decision true; `invalidate.ts:113` says it the same way.
   *
   * Live partner (WI-12): "the adapter never lets an exception escape to
   * `publish()`". UNMET.
   */
  it('swallows a throw out of the flattener, reports it, and leaves the selection alone', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = buildFixture(
      elem('p', {}, [txt('alpha beta '), txt('gamma delta '), txt('epsilon zeta')]),
    )
    const selection = selectionOver(at(fixture, 'epsilon zeta', 2), at(fixture, 'epsilon zeta', 5))
    const before = fieldsOf(selection)
    Object.defineProperty(fixture.text('gamma delta '), 'data', {
      configurable: true,
      get(): string {
        throw new DOMException('bad')
      },
    })

    expect(() => applySnap(selection.asSelection())).not.toThrow()
    const result = applySnap(selection.asSelection())

    expect(result.snapped).toBe(false)
    expectFields(selection, before)
    expect(selection.mutations).toBe(0)
    /* Twice, because the call above it is a second run of the same failure —
     * pinned rather than loosened to `toHaveBeenCalled`, so a catch that
     * reported only the first one is a failure here. */
    expect(errors).toHaveBeenCalledTimes(2)
    expect(errors.mock.calls[0]?.[1]).toBeInstanceOf(DOMException)
    errors.mockRestore()
  })

  /*
   * A caret is not a selection to snap. `rangeCount` is read before
   * `getRangeAt(0)`, which throws when there is nothing to get — and the fake
   * throws exactly there, so reversing the two reads fails this case rather
   * than being swallowed by the adapter's own catch.
   *
   * Live partner (WI-12): "a caret click is not snapped". UNMET.
   */
  it('does nothing to a collapsed selection', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const caret = selectionOver({ node: text, offset: 6 }, { node: text, offset: 6 })

    const result = applySnap(caret.asSelection())

    expect(result.snapped).toBe(false)
    expectFields(caret, { anchorNode: text, anchorOffset: 6, focusNode: text, focusOffset: 6 })
    expect(caret.mutations).toBe(0)
  })

  it('does nothing to a selection with no range at all', () => {
    const selection = emptySelection()

    const result = applySnap(selection.asSelection())

    expect(result).toEqual({ snapped: false, range: null })
    expect(selection.mutations).toBe(0)
  })
})

/**
 * The fake's own contract.
 *
 * Every case above rests on this one. Simplify the fake into a recorder — drop
 * the internal range, keep a call log — and all of them keep passing while
 * asserting nothing whatsoever about the adapter. Nothing else in the suite
 * detects that, because a vacuous green looks exactly like a real one.
 *
 * These cases prove the fake behaves as specified. They cannot prove the
 * specification matches WebKit; that is the `live` lane's `range-detach` check,
 * which measures exactly this detach behaviour in the real engine. **Manual-only
 * — a green run here says nothing about whether it has been performed.**
 */
describe('the fake Selection contract', () => {
  it('changes its own text when setBaseAndExtent moves the boundaries', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 5 }, { node: text, offset: 12 })
    expect(selection.toString()).toBe('uick br')

    selection.setBaseAndExtent(text, 4, text, 15)

    expect(selection.toString()).toBe('quick brown')
    expect(selection.mutations).toBe(1)
  })

  it('detaches a captured range, which keeps answering with the old text', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 5 }, { node: text, offset: 12 })

    const captured = selection.getRangeAt(0)
    expect(captured).toBe(selection.getRangeAt(0))
    expect(captured.isDetached).toBe(false)

    selection.setBaseAndExtent(text, 4, text, 15)

    expect(selection.getRangeAt(0)).not.toBe(captured)
    expect(captured.isDetached).toBe(true)
    expect(captured.toString()).toBe('uick br')
    expect(selection.getRangeAt(0).toString()).toBe('quick brown')
  })

  it('records the anchor and focus in the order it was given them', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 4 }, { node: text, offset: 15 })
    expect(isBackward(selection)).toBe(false)

    selection.setBaseAndExtent(text, 15, text, 4)

    expect(selection.anchorOffset).toBe(15)
    expect(selection.focusOffset).toBe(4)
    expect(isBackward(selection)).toBe(true)
    /* The range stays ordered whichever way the selection runs, as a DOM Range
     * does — which is why direction cannot be recovered from it afterwards. */
    expect(selection.getRangeAt(0).startOffset).toBe(4)
    expect(selection.getRangeAt(0).endOffset).toBe(15)
  })

  /* WebKit's verified merge, modelled: no separator anywhere, not even across a
   * block boundary. WI-6's block case asserts fields BECAUSE of this. */
  it('joins text across nodes and blocks with no separator', () => {
    const fixture = buildFixture(
      elem('div', {}, [elem('p', {}, [txt('all done')]), elem('p', {}, [txt('Start here')])]),
    )
    const selection = selectionOver(at(fixture, 'all done', 4), at(fixture, 'Start here', 5))

    expect(selection.toString()).toBe('doneStart')
  })

  it('reports no range, and refuses to hand one out, when there is none', () => {
    const selection = emptySelection()

    expect(selection.rangeCount).toBe(0)
    expect(selection.isCollapsed).toBe(true)
    expect(selection.anchorNode).toBeNull()
    expect(() => selection.getRangeAt(0)).toThrow(/there are 0 ranges/)
  })

  /* Flat coordinates written back without being unmapped to nodes land here.
   * A recorder would accept them silently, and the adapter's bug would surface
   * as a wrong highlight in the app instead of a red test. */
  it('refuses a boundary that is not a text node, or an offset outside one', () => {
    const fixture = sentence()
    const text = fixture.text('the quick brown fox')
    const selection = selectionOver({ node: text, offset: 4 }, { node: text, offset: 9 })

    expect(() => selection.setBaseAndExtent(fixture.root, 0, text, 9)).toThrow(/not a text node/)
    expect(() => selection.setBaseAndExtent(text, 4, text, 99)).toThrow(/outside/)
    /* Counted anyway: a write that was attempted and rejected is still a write
     * the adapter tried to make, and it must not be able to hide behind the
     * rejection. */
    expect(selection.mutations).toBe(2)
  })
})
