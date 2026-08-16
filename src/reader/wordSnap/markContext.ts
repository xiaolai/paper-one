import { flatten, walkRoot, type DomPosition, type Flattened } from './flatten'

/** `Node.TEXT_NODE`, spelled as its value — this module's tests run with no DOM
 *  global to read it off, the same reason `flatten` spells it out. */
const TEXT_NODE = 3

/**
 * The text immediately before and after a mark.
 *
 * A CFI locates a passage inside ONE package. It is a path through that book's
 * spine and DOM, and in a different build of the same work — an extra wrapper, a
 * split text node, one added paragraph — the same path is still valid and points
 * somewhere else. It does not throw. It highlights the wrong sentence, which is
 * worse than failing.
 *
 * The quote alone cannot replace it. "the whale" occurs hundreds of times in
 * Moby-Dick, so a mark that knows only its own words cannot say which one it is.
 * What makes a quote locatable is the text around it, which is why the W3C Web
 * Annotation model pairs an exact quote with a prefix and a suffix, and why
 * every re-anchoring reader stores all three.
 *
 * NOTHING READS THIS YET. It is captured now because it is the one part of a
 * mark that cannot be recovered later: a stored mark's context can only be
 * recomputed by re-opening the book it came from and resolving its CFI — which
 * is precisely the operation that has stopped working by the time anyone needs
 * the context.
 */

/** Characters kept on each side. Enough to disambiguate, short enough to store. */
export const CONTEXT_CHARS = 32

export interface MarkContext {
  readonly prefix: string
  readonly suffix: string
}

export const NO_CONTEXT: MarkContext = { prefix: '', suffix: '' }

/**
 * The context around a live range, or empty strings when it cannot be read.
 *
 * Empty is a legitimate answer and not a failure: a mark at the very start of a
 * section has no prefix. A caller cannot distinguish that from "the walk did not
 * reach", and deliberately should not — both mean the same thing downstream,
 * which is that there is less to re-anchor with.
 */
export function markContext(range: Range, chars: number = CONTEXT_CHARS): MarkContext {
  const startNode = range.startContainer
  const endNode = range.endContainer
  if (startNode.nodeType !== TEXT_NODE || endNode.nodeType !== TEXT_NODE) return NO_CONTEXT

  const root = walkRoot(startNode)
  if (!root) return NO_CONTEXT

  const from: DomPosition = { node: startNode as Text, offset: range.startOffset }
  const to: DomPosition = { node: endNode as Text, offset: range.endOffset }

  let flat: Flattened
  try {
    /* The same root and the same anchors `rangeText` chooses, so the context
     * and the quote describe the same tree.
     *
     * NOT the same walk, though — the caller runs `rangeText(live)` and then
     * this, which is two. That is a cost, and a risk if the DOM changes between
     * them; sharing one flatten across both is the obvious improvement and is
     * not made here because it changes `rangeText`'s signature. */
    flat = flatten(root, { anchors: [from, to] })
  } catch {
    // The walk reads the live DOM; a document torn down underneath it throws
    // from inside. This runs while a mark is being made, and losing the context
    // is not a reason to lose the mark.
    return NO_CONTEXT
  }

  const first = flat.toFlat(from.node, from.offset)
  const last = flat.toFlat(to.node, to.offset)
  if (!first || !last) return NO_CONTEXT

  const before = textUpTo(flat, first.index, first.offset)
  const after = textFrom(flat, last.index, last.offset)

  /* Normalised BEFORE slicing, and sliced by CODE POINT.
   *
   * Slicing first spends the budget on artefacts: a run of source indentation
   * or soft hyphens is collapsed to nothing afterwards, leaving a context far
   * shorter than asked for — and sometimes empty. Slicing raw UTF-16 can also
   * cut a surrogate pair in half and store half a character, which then matches
   * nothing. `Array.from` iterates code points, so an emoji is one unit. */
  return {
    prefix: lastChars(squeeze(before), chars),
    suffix: firstChars(squeeze(after), chars),
  }
}

/** Everything in the window before an edge. */
function textUpTo(flat: Flattened, index: number, offset: number): string {
  const parts: string[] = []
  for (let i = 0; i < index; i++) parts.push(flat.strs[i] ?? '')
  parts.push((flat.strs[index] ?? '').slice(0, offset))
  return parts.join('')
}

/** Everything in the window after an edge. */
function textFrom(flat: Flattened, index: number, offset: number): string {
  const parts: string[] = [(flat.strs[index] ?? '').slice(offset)]
  for (let i = index + 1; i < flat.strs.length; i++) parts.push(flat.strs[i] ?? '')
  return parts.join('')
}

/**
 * Collapse runs of whitespace, and drop the soft hyphens.
 *
 * Both for the same reason the quote is cleaned: the context has to survive
 * being compared against the SAME passage as another publisher set it, and
 * source indentation, line wrapping and hyphenation points are all artefacts of
 * one build rather than facts about the text. Kept as-is, they would make two
 * copies of one sentence look like two different sentences.
 */
function squeeze(text: string): string {
  return text.replace(/­/g, '').replace(/\s+/g, ' ')
}

/** Whole code points, so a slice cannot leave half a surrogate pair behind. */
function lastChars(text: string, count: number): string {
  const points = Array.from(text)
  return points.slice(Math.max(0, points.length - count)).join('')
}

function firstChars(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('')
}
