/**
 * The DOM half of word snapping: a block's text as one string, and the way
 * back to the nodes it came from.
 *
 * `snapWordRange` is pure and knows nothing about the DOM. It takes `strs` —
 * the flattened text of a run of blocks — and positions into it. This module
 * produces that array from a live subtree and maps the answer back to
 * `{node, offset}` pairs a `Range` can be built from.
 *
 * ## Why not foliate's `text-walker`
 *
 * It cannot answer this question, and that is not a matter of taste. Read out
 * of the built bundle rather than taken on trust, its filter is:
 *
 *     node => node.nodeType === 1
 *       ? (tag === 'script' || tag === 'style'
 *           ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
 *       : NodeFilter.FILTER_ACCEPT
 *
 * — `FILTER_SKIP` for **every** other element. Its output is then
 * `nodes.map(n => n.nodeValue ?? '')`: a flat list of text with no elements in
 * it at all. Block boundaries and `<br>` are invisible there, hidden subtrees
 * are included, and `<p>all done</p><p>Start here</p>` comes out as
 * `'all doneStart here'` — the same defect WI-9 has to fix in stored mark
 * text.
 *
 * It does take a custom `acceptNode`, and that is not enough either: accepting
 * elements only adds `''` entries where they were, since an element has no
 * `nodeValue`. Turning those into sentinels means deciding block-ness and
 * visibility per element — this module's whole job — and then walking a second
 * time to recover the structure the first walk discarded. So this walks once,
 * and reads what it needs on the way past.
 *
 * ## The sentinel
 *
 * Blocks are joined with `\n`. UAX #29 makes LF a mandatory break on both
 * sides, so no word-like segment ever spans one and expansion cannot cross a
 * block boundary. It has to be a **non-Format** character: U+2060 WORD JOINER
 * is General_Category `Cf`, WB4 ignores it, and `done<U+2060>Start` segments
 * as ONE word — an invisible sentinel that silently does nothing.
 * `flatten.test.ts` pins this by segmenting, not by comparing the character.
 *
 * ## What counts as a block
 *
 * The computed `display`, plus `<br>` by name. Neither rule alone is enough,
 * and the two failures are opposite: a tag list gets
 * `<span style="display:block">` wrong (most EPUBs style their own elements),
 * while `display` alone has nothing to read on a `<br>`, whose display is
 * `inline`. An out-of-flow box (`position: absolute` or `fixed`) is NOT
 * treated as a break, because CSS Display 3 §2.7 blockifies it whatever the
 * markup said — and pdf.js gives every run on a page its own absolutely
 * positioned span. Reading that blockified `block` as a boundary would make
 * every run its own paragraph and stop snapping working on PDFs entirely.
 *
 * ## The bound, and what happens when it is reached
 *
 * A chapter in a single `<div>` is common, so the walk is bounded and centred
 * on the caller's anchors rather than starting from the top of the block.
 *
 * When the bound is reached the walk **retreats to a boundary no word can
 * span** — a space, or a block break — so that the window it returns is
 * equivalent to the whole block as far as segmentation is concerned. If there
 * is no such boundary between the anchor and the bound, the window is reported
 * as truncated and `snapInDom` **declines to snap at all**.
 *
 * That is decisions §2, and the reasoning is worth keeping: a cut mid-word is
 * indistinguishable from a word boundary, so the snap would return a
 * confidently wrong answer with nothing anywhere reporting a problem. A
 * partial word is a visible, self-correcting annoyance; a wrong boundary is
 * not. Fail closed.
 *
 * The bound's VALUE is a guess until it is measured against real books. Its
 * failure mode is bounded by construction: too small means "some selections do
 * not snap", never "some selections snap wrongly".
 */

import { snapWordRange, type Edge, type SnapOptions } from './snapWordRange'

/** The block separator. See the note above: it must not be a Format
 *  character, and it is asserted by segmentation rather than by identity. */
export const SENTINEL = '\n'

/** How much text one snap may look at, and how many nodes it may touch on the
 *  way. Both are guesses pending live measurement; both fail closed. */
export const DEFAULT_MAX_CHARS = 20_000
export const DEFAULT_MAX_NODES = 20_000

/* `Node.TEXT_NODE` and `Node.ELEMENT_NODE`, spelled as the numbers they are.
 * There is no `Node` global in the unit lane — naming one would throw on
 * import, and this module has to be testable in a lane with no DOM in it. */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/* Never rendered, whatever their style says. `script { display: block }` is a
 * real trick for showing source, so this is a tag rule and not a style one —
 * the same call foliate's own walker makes. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE'])

/** A place in the live tree. */
export interface DomPosition {
  readonly node: Text
  readonly offset: number
}

/** One text node's contribution, and where it landed. */
export interface FlatNode {
  readonly node: Text
  /** Which entry of `strs` this node is. Offsets within the node are offsets
   *  within that entry, which is what makes the mapping a lookup rather than
   *  arithmetic. */
  readonly index: number
  /** Position in the joined text, sentinels included — for callers that think
   *  in characters rather than in entries. */
  readonly flatStart: number
  readonly flatEnd: number
}

export interface FlattenOptions {
  /** Characters, not nodes. A single text node is never split, so a window
   *  can exceed this by the length of the anchor's own node. */
  readonly maxChars?: number
  readonly maxNodes?: number
  /**
   * The positions the window must contain. The walk is centred on the first;
   * the rest are covered or they are not, and a position the window does not
   * reach simply has no flat coordinate, so the caller declines.
   *
   * With no anchors the walk starts at the beginning of the block, which is
   * what the small cases want and what a caller with no selection yet gets.
   */
  readonly anchors?: readonly DomPosition[]
}

export interface Flattened {
  /** The flattened text, one entry per text node and one per sentinel. */
  readonly strs: readonly string[]
  readonly nodes: readonly FlatNode[]
  /** The window's edge is not a boundary a word is guaranteed not to span —
   *  so a snap that reaches it would be a guess. */
  readonly truncatedStart: boolean
  readonly truncatedEnd: boolean
  /** A live position as an `Edge` into `strs`, or `null` if this walk never
   *  reached that node. */
  toFlat(node: Text, offset: number): Edge | null
  /** The inverse. Accepts either spelling of a seam, because `snapWordRange`
   *  returns the later one for a start edge and the earlier one for an end. */
  fromFlat(index: number, offset: number): DomPosition | null
}

export interface SnappedDomRange {
  readonly start: DomPosition
  readonly end: DomPosition
}

interface Direction {
  readonly first: 'firstChild' | 'lastChild'
  readonly next: 'nextSibling' | 'previousSibling'
  /** Whitespace at the edge the walk arrives at, and the edge it leaves
   *  behind. A cut beside either one is a cut no word spans. */
  readonly leading: RegExp
  readonly trailing: RegExp
}

const FORWARD: Direction = {
  first: 'firstChild',
  next: 'nextSibling',
  leading: /^\s/,
  trailing: /\s$/,
}

const BACKWARD: Direction = {
  first: 'lastChild',
  next: 'previousSibling',
  leading: /\s$/,
  trailing: /^\s/,
}

/** What the walk needs to know about an element, computed once. */
interface ElementFacts {
  /** Contributes nothing and is not descended into. */
  readonly skipped: boolean
  /** Its own text is rendered. `visibility` inherits, so this is the answer
   *  for the element's own text children and nothing deeper. */
  readonly visible: boolean
  /** Crossing its edge is a block boundary. */
  readonly block: boolean
}

interface Walk {
  readonly root: Node
  readonly view: { getComputedStyle(target: Element): CSSStyleDeclaration }
  readonly maxNodes: number
  /** Facts per element, so climbing out of a block does not re-read a style
   *  the descent already read — and so the node count means what it says. */
  readonly facts: Map<Node, ElementFacts>
  visits: number
  /** A block boundary has been crossed and no text has been emitted since. */
  pendingBreak: boolean
  overflowed: boolean
}

interface Piece {
  readonly node: Text
  readonly text: string
  /** A block boundary lies in the gap crossed to REACH this piece, in
   *  whichever direction the walk was going. */
  readonly gapBreak: boolean
}

interface Gathered {
  readonly pieces: Piece[]
  /** Ran out of tree rather than out of budget. */
  readonly complete: boolean
  /** A block boundary lies in the gap where the walk stopped. */
  readonly stoppedAtBreak: boolean
  readonly used: number
}

function tagOf(el: Element): string {
  return el.tagName.toUpperCase()
}

/**
 * Block-level, for the purpose of separating words.
 *
 * `display` is matched by shape rather than by a list of values: everything
 * that is not inline-level, not `contents`, and not out of flow separates the
 * text around it. `list-item`, `table-cell` and `flow-root` are all block
 * boxes and none of them is the string `block`, which is the near-miss this
 * shape avoids.
 */
function isBlockLevel(style: CSSStyleDeclaration): boolean {
  const display = style.display
  if (!display || display === 'none' || display === 'contents') return false
  if (display.startsWith('inline') || display.startsWith('ruby')) return false
  const position = style.position
  if (position === 'absolute' || position === 'fixed') return false
  return true
}

function factsOf(el: Element, walk: Walk): ElementFacts {
  const cached = walk.facts.get(el)
  if (cached) return cached
  const tag = tagOf(el)
  const style = walk.view.getComputedStyle(el)
  const skipped = SKIPPED_TAGS.has(tag) || style.display === 'none'
  const visibility = style.visibility
  const facts: ElementFacts = {
    skipped,
    visible: visibility !== 'hidden' && visibility !== 'collapse',
    /* `<br>` is handled by name where it is met, not here: it is a break
     * BETWEEN its siblings rather than a box with edges to cross. */
    block: !skipped && tag !== 'BR' && isBlockLevel(style),
  }
  walk.facts.set(el, facts)
  return facts
}

/** Whether the walk may still touch another node. */
function budgetLeft(walk: Walk): boolean {
  walk.visits += 1
  if (walk.visits <= walk.maxNodes) return true
  walk.overflowed = true
  return false
}

/**
 * The first text node of `node`'s subtree, in `dir`'s order.
 *
 * Returns `null` when the subtree holds none — the caller then continues from
 * `node` as if its subtree were finished. Block edges met on the way in set
 * `pendingBreak`; the matching edges on the way out are set by `advance` as it
 * climbs.
 */
function descend(node: Node, dir: Direction, walk: Walk): Text | null {
  if (walk.overflowed || !budgetLeft(walk)) return null
  const type = node.nodeType
  if (type === TEXT_NODE) {
    const text = node as Text
    const parent = text.parentNode
    const parentFacts = parent ? walk.facts.get(parent) : undefined
    if (parentFacts && !parentFacts.visible) return null
    return text
  }
  if (type !== ELEMENT_NODE) return null
  const el = node as Element
  const facts = factsOf(el, walk)
  if (facts.skipped) return null
  if (tagOf(el) === 'BR') {
    walk.pendingBreak = true
    return null
  }
  if (facts.block) walk.pendingBreak = true
  for (let child = el[dir.first]; child; child = child[dir.next]) {
    const leaf = descend(child, dir, walk)
    if (leaf) return leaf
    if (walk.overflowed) return null
  }
  return null
}

/** The next text node after `from` in `dir`'s order, within the walk's root. */
function advance(from: Node, dir: Direction, walk: Walk): Text | null {
  let cur: Node = from
  while (cur !== walk.root) {
    for (let sibling = cur[dir.next]; sibling; sibling = sibling[dir.next]) {
      const leaf = descend(sibling, dir, walk)
      if (leaf) return leaf
      if (walk.overflowed) return null
    }
    const parent: Node | null = cur.parentNode
    if (!parent) return null
    /* Leaving a block is a boundary just as entering one is; the flag is a
     * boolean, so a nest of them still yields exactly one sentinel. */
    if (walk.facts.get(parent)?.block) walk.pendingBreak = true
    cur = parent
  }
  return null
}

/** Walk from `seed` until the tree or the budget runs out, whichever first. */
function gather(seed: Text, dir: Direction, walk: Walk, budget: number): Gathered {
  const pieces: Piece[] = []
  let used = 0
  let cur: Node = seed
  for (;;) {
    walk.pendingBreak = false
    const next = advance(cur, dir, walk)
    if (!next) {
      return { pieces, complete: !walk.overflowed, stoppedAtBreak: walk.pendingBreak, used }
    }
    const text = next.data
    if (used + text.length > budget) {
      return { pieces, complete: false, stoppedAtBreak: walk.pendingBreak, used }
    }
    pieces.push({ node: next, text, gapBreak: walk.pendingBreak })
    used += text.length
    cur = next
  }
}

/**
 * Retreat to a cut no word can span, or report that there is none.
 *
 * A cut is safe when whitespace sits against it or a block boundary falls in
 * it, because UAX #29 breaks a word at both. Dropping pieces to reach one
 * costs nothing — they have already been walked — and it is what keeps the
 * bound from disabling snapping in exactly the long chapters that motivated
 * it. When there is nothing safe to retreat to, the window is truncated and
 * the caller must decline.
 *
 * **Three things make one cut safe, and all three are asked at every cut.** A
 * cut between two pieces has whitespace against it from EITHER side: the piece
 * behind it may end with a space, or the piece in front of it may begin with
 * one — and the gap itself may hold a block break. An earlier version asked
 * only the second and third of those once a piece had been dropped, so a
 * window ending `['Hello ', 'world']` was abandoned entirely although cutting
 * after `'Hello '` was safe. `<p>Hello <em>world</em>…</p>` is the commonest
 * inline shape in an EPUB, so that give-up was not exotic.
 *
 * `text` reads in WALK order, not document order, which is why the same two
 * regexes serve both directions: `dir.trailing` is whitespace at the edge the
 * cut is made on, `dir.leading` whitespace at the edge left behind.
 */
function trim(gathered: Gathered, seedText: string, dir: Direction): { pieces: Piece[]; truncated: boolean } {
  if (gathered.complete) return { pieces: gathered.pieces, truncated: false }
  const pieces = [...gathered.pieces]
  /* Dropping every piece leaves the cut at the far edge of the seed, which is
   * always in the window — so the seed's own text is what the last question is
   * asked about. */
  const endsWith = (): string => pieces[pieces.length - 1]?.text ?? seedText
  let safe = gathered.stoppedAtBreak || dir.trailing.test(endsWith())
  while (!safe && pieces.length > 0) {
    const dropped = pieces.pop()
    if (!dropped) break
    safe = dropped.gapBreak || dir.leading.test(dropped.text) || dir.trailing.test(endsWith())
  }
  return { pieces, truncated: !safe }
}

/**
 * Whether the anchor is a text node this walk would have reached anyway.
 *
 * Climbing to the root costs the tree's depth rather than its size, and it
 * settles three questions at once: that the node is under the root at all,
 * that nothing on the way is skipped, and that its own text is rendered. An
 * anchor inside `display: none` or a `<script>` has no flat position, and
 * inventing one would flatten text the reader cannot see.
 */
function reachable(node: Text, walk: Walk): boolean {
  if (node.nodeType !== TEXT_NODE) return false
  let cur: Node = node
  while (cur !== walk.root) {
    const parent: Node | null = cur.parentNode
    if (!parent || parent.nodeType !== ELEMENT_NODE) return false
    const facts = factsOf(parent as Element, walk)
    if (facts.skipped) return false
    if (cur === node && !facts.visible) return false
    cur = parent
  }
  return true
}

/** A walk that found nothing. `truncated` distinguishes "this block has no
 *  text" from "this block could not be read", which the caller must not
 *  confuse: the first is a fact, the second is a refusal. */
function nothing(truncated: boolean): Flattened {
  return {
    strs: [],
    nodes: [],
    truncatedStart: truncated,
    truncatedEnd: truncated,
    toFlat: () => null,
    fromFlat: () => null,
  }
}

/**
 * The topmost element above `node` — the tree it currently belongs to.
 *
 * `<html>` in a live document, and the root of a detached subtree in one that
 * has been replaced, which is why a caller that then writes to the DOM still
 * has to check connectivity: reaching a root proves the node is in *a* tree,
 * not in *the* tree.
 *
 * Here rather than in each caller because both of them — `applySnap`, to choose
 * the walk's outer bound, and `rangeText`, to flatten the same tree the snap
 * was computed over — must answer this identically. Two copies that drifted
 * would flatten two different trees and disagree about where the blocks are.
 */
export function walkRoot(node: Node): Element | null {
  let cur: Node | null = node
  let top: Element | null = null
  while (cur) {
    if (cur.nodeType === ELEMENT_NODE) top = cur as Element
    cur = cur.parentNode
  }
  return top
}

export function flatten(root: Element, options: FlattenOptions = {}): Flattened {
  /* No view means no computed styles, which is the case for the standalone
   * document `makePdf` builds for search. Guessing at block-ness without them
   * would be a fabrication, so this fails closed rather than falling back to a
   * tag list. */
  const view = root.ownerDocument?.defaultView
  if (!view) return nothing(true)

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const walk: Walk = {
    root,
    view,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    facts: new Map(),
    visits: 0,
    pendingBreak: false,
    overflowed: false,
  }

  const anchor = options.anchors?.[0]
  let backward: { pieces: Piece[]; truncated: boolean } = { pieces: [], truncated: false }
  let seed: Text | null
  if (anchor) {
    if (!reachable(anchor.node, walk)) return nothing(true)
    seed = anchor.node
    /* A quarter of the budget behind the anchor: a word extends backward from
     * an edge by a few characters, not by a paragraph, and the remainder is
     * more useful ahead of it where the second edge of a selection lives. */
    backward = trim(gather(seed, BACKWARD, walk, Math.floor(maxChars / 4)), seed.data, BACKWARD)
  } else {
    seed = descend(root, FORWARD, walk)
  }
  if (!seed) return nothing(walk.overflowed)

  const behind = backward.pieces.reduce((total, piece) => total + piece.text.length, 0)
  const ahead = Math.max(0, maxChars - seed.data.length - behind)
  const forward = trim(gather(seed, FORWARD, walk, ahead), seed.data, FORWARD)

  return assemble(seed, backward, forward)
}

/** The two half-windows and the seed, in document order, with the sentinels
 *  written in and the lookups built. */
function assemble(
  seed: Text,
  backward: { pieces: Piece[]; truncated: boolean },
  forward: { pieces: Piece[]; truncated: boolean },
): Flattened {
  const ordered: { node: Text; text: string; breakBefore: boolean }[] = []
  const behind = backward.pieces
  /* A backward piece's own `gapBreak` describes the gap on its LATER side, so
   * in document order it belongs to the piece in front of it. */
  for (let i = behind.length - 1; i >= 0; i -= 1) {
    const piece = behind[i]
    if (!piece) continue
    ordered.push({
      node: piece.node,
      text: piece.text,
      breakBefore: behind[i + 1]?.gapBreak ?? false,
    })
  }
  ordered.push({ node: seed, text: seed.data, breakBefore: behind[0]?.gapBreak ?? false })
  for (const piece of forward.pieces) {
    ordered.push({ node: piece.node, text: piece.text, breakBefore: piece.gapBreak })
  }

  const strs: string[] = []
  const nodes: FlatNode[] = []
  const byNode = new Map<Text, FlatNode>()
  const byIndex = new Map<number, FlatNode>()
  let flat = 0
  for (const piece of ordered) {
    /* No leading sentinel: the window's own edge is not a block boundary
     * anyone can act on, and a leading one would shift every offset in the
     * table by one for no gain. */
    if (piece.breakBefore && strs.length > 0) {
      strs.push(SENTINEL)
      flat += SENTINEL.length
    }
    const row: FlatNode = {
      node: piece.node,
      index: strs.length,
      flatStart: flat,
      flatEnd: flat + piece.text.length,
    }
    strs.push(piece.text)
    nodes.push(row)
    byNode.set(piece.node, row)
    byIndex.set(row.index, row)
    flat += piece.text.length
  }

  const neighbour = (index: number, step: number): FlatNode | null => {
    for (let i = index + step; i >= 0 && i < strs.length; i += step) {
      const row = byIndex.get(i)
      if (row) return row
    }
    return null
  }

  return {
    strs,
    nodes,
    truncatedStart: backward.truncated,
    truncatedEnd: forward.truncated,

    toFlat(node: Text, offset: number): Edge | null {
      const row = byNode.get(node)
      if (!row) return null
      if (!Number.isInteger(offset) || offset < 0 || offset > row.flatEnd - row.flatStart) return null
      return { index: row.index, offset }
    },

    fromFlat(index: number, offset: number): DomPosition | null {
      if (!Number.isInteger(index) || index < 0 || index >= strs.length) return null
      const row = byIndex.get(index)
      if (row) {
        const length = row.flatEnd - row.flatStart
        if (!Number.isInteger(offset) || offset < 0 || offset > length) return null
        return { node: row.node, offset }
      }
      /* A sentinel occupies no DOM at all, so a position inside one is really
       * the seam beside it: its start is the end of the node before, its end
       * the start of the node after. Both are live positions; neither invents
       * one. */
      const before = neighbour(index, -1)
      const after = neighbour(index, 1)
      if (offset <= 0) {
        if (before) return { node: before.node, offset: before.flatEnd - before.flatStart }
        return after ? { node: after.node, offset: 0 } : null
      }
      if (after) return { node: after.node, offset: 0 }
      return before ? { node: before.node, offset: before.flatEnd - before.flatStart } : null
    },
  }
}

/**
 * Snap a live selection's two edges to word boundaries, or decline.
 *
 * The single place decisions §2 lives: a truncated window is refused outright
 * rather than snapped against. `null` means "leave the reader's selection
 * exactly as they made it", and every reason for it — an unreadable document,
 * an anchor outside the block, a window with no safe edge, no word-like
 * segment to snap to — arrives as that same one answer, because the caller's
 * response to all of them is identical.
 *
 * A caller bug still throws, from `snapWordRange`. That is deliberate: it is
 * diagnosable there and it is not a selection the reader can be shown.
 */
export function snapInDom(
  root: Element,
  start: DomPosition,
  end: DomPosition,
  options: SnapOptions & FlattenOptions = {},
): SnappedDomRange | null {
  const flat = flatten(root, { ...options, anchors: [start, end] })
  if (flat.truncatedStart || flat.truncatedEnd) return null

  const startEdge = flat.toFlat(start.node, start.offset)
  const endEdge = flat.toFlat(end.node, end.offset)
  if (!startEdge || !endEdge) return null

  const snapped = snapWordRange(flat.strs, startEdge, endEdge, options)
  if (!snapped) return null

  const snappedStart = flat.fromFlat(snapped.start.index, snapped.start.offset)
  const snappedEnd = flat.fromFlat(snapped.end.index, snapped.end.offset)
  if (!snappedStart || !snappedEnd) return null
  return { start: snappedStart, end: snappedEnd }
}
