/**
 * Write a snapped selection back to the live one — or leave it exactly alone.
 *
 * This is the only module in the feature that mutates anything, and it is
 * governed by two behaviours of WebKit that were measured in the running app
 * rather than assumed:
 *
 * 1. **`setBaseAndExtent` detaches a previously captured `Range`.**
 *    `captured === getRangeAt(0)` is `true` before the call and `false` after,
 *    and the captured range keeps returning the OLD text while the live one
 *    returns the snapped text. So nothing here may hold a range across the
 *    write: the boundaries are copied out as plain numbers before it, and the
 *    range in the result is read after it. `publish()` (WI-9) has the same
 *    obligation — a stale range there stores an unsnapped CFI and text under a
 *    snapped-looking selection.
 * 2. **A naive `setBaseAndExtent(start, end)` flips a backward drag forward.**
 *    `snapInDom` returns an ordered pair and carries no direction, so the
 *    orientation is read from the live selection BEFORE the write and put back
 *    deliberately. The text is identical either way; only the four
 *    anchor/focus fields show it.
 *
 * Everything else here is refusal. `snapInDom` answering `null` — an unreadable
 * document, an anchor outside the block, a window with no safe edge, no
 * word-like segment — means *leave the reader's selection exactly as they made
 * it*, never collapse it and never clear it: a selection with no popup over it
 * is a worse outcome than a partial word. A result identical to the live
 * selection is not written back either, because every write is a
 * `selectionchange` and foliate's paginator turns pages on that event
 * (`paginator.js:586`), which is the whole reason WI-8 exists.
 *
 * **Live-lane partner: the `live` lane** — `node scripts/word-snap-live.mjs`,
 * `range-detach` and `backward-direction`. Both behaviours above are asserted
 * here against a modelled fake `Selection` (`selectionFake.testkit.ts`) and
 * cannot be proven by one; those two checks call this adapter on a real WebKit
 * `Selection` and read the result back. The lane exists and is manual-only,
 * because it needs the app running — **check whether it has been run before
 * treating this pairing as met.**
 *
 * What it still does not reach: a real backward **drag**. The bridge dispatches
 * `isTrusted: false` events, so no harness produces a native selection.
 * The manual selection checklist row 1.2 is the only cover for that.
 */

import { snapInDom, walkRoot, type DomPosition } from './flatten'
import type { SnapOptions } from './snapWordRange'

/* `Node.TEXT_NODE`, spelled as the number it is: the unit lane has no `Node`
 * global, and naming one would throw on import. */
const TEXT_NODE = 3

export interface SnapApplication {
  /** Whether the live selection was mutated. `publish()` must re-read the
   *  range, the CFI and the text when this is `true`. */
  readonly snapped: boolean
  /** The live range as it stands AFTER the call — never one captured before
   *  it. `null` only when the selection holds no range at all. */
  readonly range: Range | null
}

/** `snapWordRange`'s locale, plus the flattener's two bounds. `anchors` is not
 *  offered: they are the selection's own edges and `snapInDom` sets them. */
export type ApplySnapOptions = SnapOptions & {
  readonly maxChars?: number
  readonly maxNodes?: number
  /**
   * The gesture was a double-click — `PointerEvent.detail >= 2`.
   *
   * Only read to recognise ONE WebKit behaviour, described at
   * `wordAtAnchor`. A double-click is otherwise an ordinary pointer gesture
   * and takes the ordinary path.
   */
  readonly doubleClick?: boolean | undefined
}

export function applySnap(selection: Selection, options: ApplySnapOptions = {}): SnapApplication {
  /* Read outside the `try` on purpose. `getRangeAt(0)` throws when there is no
   * range, and an implementation that reached for it before this check would
   * have that throw quietly swallowed below — a guard that looks present and
   * does nothing. Here it fails loudly instead. */
  if (selection.rangeCount === 0) return { snapped: false, range: null }

  let mutated = false
  try {
    mutated = snap(selection, options)
  } catch (cause) {
    /* Flattening and segmentation read the live DOM, and a document being torn
     * down under the walk throws from inside it. That must not escape: the
     * caller is `publish()`, and an exception there takes the selection popup
     * down with it. A snap nobody can make is a no-op, not an error.
     *
     * **Reported, though — a bare `catch {}` here would be a defect.**
     * `snapWordRange` throws on purpose twice, and both throws arrive here: the
     * caller-bug `RangeError` (`snapWordRange.ts:102`) and the collapse
     * invariant (`snapWordRange.ts:126`), whose entire justification in
     * decisions §4 is that it "fails loudly at the origin instead of silently
     * publishing no selection". Swallowed without a word, it becomes precisely
     * the silent no-op that decision forbade. The behaviour stays a no-op; only
     * the silence goes. Same shape as `invalidate.ts:113`. */
    console.error('Paper: a word snap failed', cause)
  }
  return { snapped: mutated, range: liveRange(selection) }
}

/**
 * The same answer for a selection that must not be snapped: what it is, with
 * nothing written.
 *
 * Here rather than at the caller because the two outcomes have to be one
 * shape. Provenance decides whether a gesture SNAPS; it has no business
 * deciding whether a gesture is reported at all, and a caller that expressed
 * "do not snap" by returning early expressed "do not publish" as well — which
 * cost the reader the selection toolbar for every gesture whose provenance
 * read false. Giving the refusal a value, rather than a `return`, is what keeps
 * the two separable.
 */
export function unsnapped(selection: Selection): SnapApplication {
  return { snapped: false, range: liveRange(selection) }
}

/** The snap itself. Returns whether the live selection was mutated. */
function snap(selection: Selection, options: ApplySnapOptions): boolean {
  if (selection.isCollapsed) return false

  /* The live range is read for four numbers and then dropped. It is dead the
   * moment `setBaseAndExtent` runs, so it must not outlive this block. */
  const live = selection.getRangeAt(0)
  const start = textPosition(live.startContainer, live.startOffset)
  const end = textPosition(live.endContainer, live.endOffset)
  if (!start || !end) return false

  /* Direction, before anything is written. A range is always ordered, so this
   * is the last moment the drag's orientation is knowable. */
  const backward =
    selection.anchorNode !== live.startContainer || selection.anchorOffset !== live.startOffset

  /* ⚠️ **A DOUBLE-CLICK IS NEVER BACKWARD**, and one that is did not expand a
   * word — see `wordAtAnchor`. Handled before the ordinary path, because the
   * ordinary path cannot help: the selection WebKit produced is already
   * word-aligned at both ends, so snapping returns it unchanged and nothing is
   * written. */
  if (options.doubleClick === true && backward) {
    return wordAtAnchor(selection, options)
  }

  /* The walk's outer bound: the top of whatever tree the selection is in. Not
   * the range's common ancestor — a word runs past the edges of the selection,
   * which is the entire point — and not `document`, which is not an element.
   * Cost is bounded by the flattener's own char and node budgets, not by the
   * size of the tree named here. */
  const root = walkRoot(start.node)
  if (!root) return false

  const snapped = snapInDom(root, start, end, options)
  if (!snapped) return false
  /* Compared against the LIVE selection rather than against the previous
   * result, so applying twice mutates once. A boundary on a seam between two
   * text nodes has two spellings and this comparison sees them as different;
   * the cost of that is one extra write, which WI-8's deferral absorbs, and the
   * alternative is comparing in flat coordinates the caller does not have. */
  if (samePlace(snapped.start, start) && samePlace(snapped.end, end)) return false

  /* Immediately before the write, and nowhere earlier: WI-8 defers this whole
   * call by a macrotask and WI-11 repaints PDF pages underneath it, so the
   * document may have been torn down since the gesture that started it. Both
   * ends are checked — writing one live boundary and one dead one is not a
   * half-success, it is a selection nobody can see. */
  if (!snapped.start.node.isConnected || !snapped.end.node.isConnected) return false

  const anchor = backward ? snapped.end : snapped.start
  const focus = backward ? snapped.start : snapped.end
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  return true
}

/**
 * The word the reader actually double-clicked, when WebKit selected a block
 * instead.
 *
 * ⚠️ **MEASURED IN THE RUNNING APP**, on a paginated EPUB, with real
 * (`isTrusted`) events posted through the window server — a synthetic
 * `dblclick` cannot produce a native selection, so nothing about this could
 * have been learned from a harness.
 *
 * Double-clicking the LAST WORD OF A LINE does not expand that word. WebKit
 * puts the anchor where the pointer landed and the focus at offset 0 of the
 * block, selecting everything from the start of the paragraph up to the click,
 * backwards. Two measurements from one paragraph:
 *
 * | click | anchor → focus | selected |
 * |---|---|---|
 * | mid-line | 9 → 10 | one word, forward |
 * | mid-line | 102 → 107 | `their`, forward |
 * | end of line 1 | 60 → **0** | 60 chars, backward |
 * | end of line 2 | 127 → **0** | 127 chars, backward |
 *
 * The click is ON the word in both failing cases — line 1's text ends at
 * x=820 and the click was at x=810 — so this is not a hit-testing miss. It is
 * word expansion abandoned at a column edge.
 *
 * **The anomaly is its own signal.** A double-click that expands a word puts
 * the anchor at the word's start and the focus at its end, which is forward,
 * always. A BACKWARD double-click therefore expanded nothing, and there is no
 * legitimate gesture it could be confused with — a backward *drag* is not a
 * double-click.
 *
 * The anchor is exactly where the pointer landed, so the word the reader meant
 * is the word containing it. A ONE-CHARACTER range there is inside that word,
 * and the ordinary policy expands a range inside a word to the whole of it —
 * so this needs no new rule, only a different question asked of the same one.
 */
function wordAtAnchor(selection: Selection, options: ApplySnapOptions): boolean {
  const { anchorNode } = selection
  if (!anchorNode) return false
  const at = textPosition(anchorNode, selection.anchorOffset)
  if (!at) return false
  const root = walkRoot(at.node)
  if (!root) return false

  /* A one-character probe, forward where there is room and backward at the end
   * of the node. Either lands inside the same word; `snapWordRange` refuses a
   * collapsed range, which is why this cannot simply ask about the caret. */
  const probe =
    at.offset < at.node.data.length
      ? { start: at, end: { node: at.node, offset: at.offset + 1 } }
      : at.offset > 0
        ? { start: { node: at.node, offset: at.offset - 1 }, end: at }
        : null
  if (!probe) return false

  const word = snapInDom(root, probe.start, probe.end, options)
  if (!word) return false
  if (!word.start.node.isConnected || !word.end.node.isConnected) return false

  /* FORWARD, deliberately. The reader double-clicked; the result is a word,
   * and a word selected by a double-click reads left to right. Restoring the
   * backward orientation here would preserve the artifact this exists to
   * remove. */
  selection.setBaseAndExtent(word.start.node, word.start.offset, word.end.node, word.end.offset)
  return true
}

/** A range boundary as a flattener position, or `null` when it is not in text
 *  at all — a selection over whole elements has element containers, and there
 *  is no honest word boundary to give it. */
function textPosition(node: Node, offset: number): DomPosition | null {
  return node.nodeType === TEXT_NODE ? { node: node as Text, offset } : null
}

function samePlace(a: DomPosition, b: DomPosition): boolean {
  return a.node === b.node && a.offset === b.offset
}

/** Read after everything, so the result never carries a range from before the
 *  write. */
function liveRange(selection: Selection): Range | null {
  return selection.rangeCount > 0 ? selection.getRangeAt(0) : null
}
