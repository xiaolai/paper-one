/**
 * A selection's text as the reader sees it, rather than as `toString()` gives
 * it.
 *
 * Two defects are fixed here, and both were measured in the running app rather
 * than assumed:
 *
 * 1. **`range.toString()` merges across block boundaries.**
 *    `<p>all done</p><p>Start here</p>` yields `'all doneStart here'`, and
 *    `one<br>two` yields `'onetwo'`. That text is what is stored on a mark and
 *    what Copy puts on the clipboard, so a two-paragraph quotation comes back
 *    with its paragraphs welded together at a word that never existed. It is a
 *    **pre-existing** defect, independent of snapping; WI-5's flattener is what
 *    makes it cheap to fix, which is why it is fixed alongside the snap rather
 *    than filed.
 * 2. **A snapped range legitimately contains U+00AD.** The soft hyphen is
 *    invisible, and UAX #29 ignores it (WB4, General_Category `Cf`), so
 *    `hyphen<U+00AD>ation` is one word and snapping to it is correct. It must
 *    not survive into stored text, where it is a character nobody can see that
 *    breaks every later search for the word containing it.
 *
 * **The range itself is never touched.** Stripping U+00AD from it would mean
 * moving the highlight's boundaries, and the separator has no DOM to live in at
 * all. This module answers what the selection SAYS; where it sits is
 * `applySnap`'s business and nothing here may disturb it.
 *
 * ## The separator is `'\n'`
 *
 * The same character `flatten` joins blocks with, for the same reason: a
 * newline preserves the paragraph structure in stored mark text and in Copy,
 * where a space silently destroys it. If a renderer downstream collapses
 * whitespace, that is a second change and not a reason to pick the space here.
 *
 * ## Single-block selections come out byte-identical
 *
 * A window with no block boundary in it has no sentinel, so the join is a plain
 * concatenation of the same node data `toString()` would have read — the
 * pre-existing behaviour, to the byte, which is what makes the no-regression
 * case in `session.test.ts` a real assertion. The whitespace-swallowing below
 * runs only where a sentinel is, and everywhere else the text passes through
 * untouched.
 *
 * ## When it declines
 *
 * A boundary that is not in a text node, a range in no tree, a selection longer
 * than the flattener's window, or a document being torn down under the walk:
 * each returns the plain `toString()` rather than nothing. The block join is an
 * improvement on what shipped, not a precondition for publishing a selection —
 * losing the popup would be a far worse outcome than losing a newline.
 *
 * **Live-lane partner: the `live` lane** — `node scripts/word-snap-live.mjs`,
 * `block-merge` and `br-merge`. Both defects above are WebKit's behaviour, and
 * the fixtures here are claims about it that no in-process lane can check.
 * Those two checks reproduce the merge and the fix in the same live run, so a
 * green result cannot mean the defect was simply never there. The lane is
 * manual-only — **check whether it has been run before treating this pairing as
 * met.**
 */

import {
  flatten,
  SENTINEL,
  walkRoot,
  type DomPosition,
  type Flattened,
  type FlattenOptions,
} from './flatten'

/** `Node.TEXT_NODE`, spelled as the number it is: the unit lane has no `Node`
 *  global, and naming one would throw on import. */
const TEXT_NODE = 3

/** SOFT HYPHEN. Invisible, inside words, and not the reader's to see. */
const SOFT_HYPHEN = /­/g
const LEADING_SPACE = /^\s+/
const TRAILING_SPACE = /\s+$/

/** The flattener's two bounds. `anchors` is not offered: they are the range's
 *  own edges and this module sets them. */
export type RangeTextOptions = Pick<FlattenOptions, 'maxChars' | 'maxNodes'>

/** What a selection says, block boundaries included and invisible characters
 *  left out. Trimmed, as the published text has always been. */
export function rangeText(range: Range, options: RangeTextOptions = {}): string {
  return clean(blockAware(range, options) ?? range.toString())
}

function clean(text: string): string {
  return text.replace(SOFT_HYPHEN, '').trim()
}

/**
 * Whether a range still describes something in the document.
 *
 * BOTH ends, because a range with one live boundary and one dead one is not a
 * half-success — it is a selection nobody can see, and `applySnap` refuses to
 * write one for the same reason. `isConnected` is transitive: a text node whose
 * grandparent was replaced still points at its own parent and is still
 * disconnected, which is exactly the shape `replaceChildren()` leaves behind.
 *
 * HERE rather than in each caller, and it has three: `session.ts` before it
 * publishes a snapshot, and `sentenceAt` before it walks one that may have sat
 * in a snapshot since. Two spellings of one liveness rule is how they come to
 * disagree about what a dead range is — the same argument `walkRoot`'s header
 * makes about the tree.
 */
export function connectedRange(range: Range): boolean {
  return range.startContainer.isConnected && range.endContainer.isConnected
}

/**
 * The range's text over the flattened tree, or `null` to fall back.
 *
 * The tree is chosen exactly as `applySnap` chooses it — `walkRoot` from the
 * start boundary — so the blocks seen here are the blocks the snap was computed
 * over. Anything else could disagree with the selection it is describing.
 */
function blockAware(range: Range, options: RangeTextOptions): string | null {
  const startNode = range.startContainer
  const endNode = range.endContainer
  if (startNode.nodeType !== TEXT_NODE || endNode.nodeType !== TEXT_NODE) return null
  const root = walkRoot(startNode)
  if (!root) return null

  const from: DomPosition = { node: startNode as Text, offset: range.startOffset }
  const to: DomPosition = { node: endNode as Text, offset: range.endOffset }

  let flat: Flattened
  try {
    flat = flatten(root, { ...options, anchors: [from, to] })
  } catch {
    /* The walk reads the live DOM, and a document torn down underneath it
     * throws from inside. The caller is `publish()`, where an exception takes
     * the selection popup down with it. */
    return null
  }

  const first = flat.toFlat(from.node, from.offset)
  const last = flat.toFlat(to.node, to.offset)
  /* A window centred on the start does not always reach the end — a selection
   * longer than the flattener's budget is the ordinary case — and a boundary
   * with no flat coordinate cannot be joined against one that has one. */
  if (!first || !last || first.index > last.index) return null

  return join(flat, first.index, first.offset, last.index, last.offset)
}

/**
 * The entries between the two edges, with each block boundary spelled once.
 *
 * A boundary in the DOM is rarely one thing: `</p>\n  <p>` is a block edge, a
 * whitespace-only text node, and another block edge, and joining those verbatim
 * would put the source's indentation into the reader's clipboard. So whitespace
 * that sits against a break is swallowed and consecutive breaks collapse — the
 * boundary renders as one break, and it reads as one here.
 *
 * A leading break is dropped rather than emitted: a selection that begins at
 * the top of a block has nothing in front of it to be separated from. **No test
 * can currently fail on that guard** — `clean` trims, and a separator at
 * position 0 is whitespace at position 0 — so it is written down here rather
 * than left looking covered. It stays because this function's answer should be
 * right on its own, not right because of what the caller does next; the two
 * rules are independent and only both of them going would show.
 */
function join(
  flat: Flattened,
  firstIndex: number,
  firstOffset: number,
  lastIndex: number,
  lastOffset: number,
): string {
  /* Which entries are real text nodes. A sentinel is an entry with no node row
   * behind it — never the character it holds, because a source newline inside a
   * paragraph is a text node whose data is exactly the sentinel and must be
   * treated as the ordinary text it is. */
  const nodeEntries = new Set(flat.nodes.map((row) => row.index))

  let text = ''
  let pendingBreak = false
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    const entry = flat.strs[i] ?? ''
    if (!nodeEntries.has(i)) {
      pendingBreak = true
      continue
    }
    const piece = entry.slice(
      i === firstIndex ? firstOffset : 0,
      i === lastIndex ? lastOffset : entry.length,
    )
    if (!pendingBreak) {
      text += piece
      continue
    }
    /* Whitespace beside a break renders as part of the break, so it does not
     * survive one: the trailing side is dropped from what has been joined so
     * far and the leading side from the piece arriving. A piece that is nothing
     * BUT whitespace therefore contributes nothing, which is what turns
     * `</p>\n  <p>` — an edge, the source's indentation, another edge — into
     * the single break it renders as. */
    text = text.replace(TRAILING_SPACE, '')
    if (text !== '') text += SENTINEL
    text += piece.replace(LEADING_SPACE, '')
    pendingBreak = false
  }
  return text
}
