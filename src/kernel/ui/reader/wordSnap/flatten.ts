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
  /**
   * The window starts where the root's rendered text starts: the walk behind
   * the anchor ran out of TREE rather than out of budget, so nothing readable
   * lies before it.
   *
   * NOT `!truncatedStart`. That flag is word-safety — a budget cut that lands on
   * a space reports it `false` — and this is the one question it cannot answer:
   * whether anything lies past the window's edge at all. `sentenceAt` needs
   * exactly that to tell the first sentence of a document from the first
   * sentence of a window (phase 17, L8).
   */
  readonly reachedStart: boolean
  /** `reachedStart`, at the other end. */
  readonly reachedEnd: boolean
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
  readonly leading: (text: string) => boolean
  readonly trailing: (text: string) => boolean
}

/**
 * Whitespace no word spans: JavaScript's `\s`, less the two members UAX #29
 * JOINS INTO a word.
 *
 * ⚠️ **IT WAS `\s`, AND TWO OF ITS TWENTY-FIVE ARE NOT BOUNDARIES AT ALL.**
 * U+FEFF is General_Category `Cf`, which WB4 folds into the letter before it —
 * the sentinel's trap above, met from the other side — and U+202F NARROW
 * NO-BREAK SPACE is `ExtendNumLet`, which WB13a/b glue letters across. Measured
 * with `Intl.Segmenter` over every `\s` code point: `abc<U+FEFF>defgh` and
 * `abc<U+202F>defgh` are one word each, and the other twenty-three break on both
 * sides. So a window cut beside either one was called safe, and snapped `abc`
 * where the whole walk selects the word. `flatten.test.ts` asks the segmenter
 * about every member rather than trusting this list. Found by audit.
 */
const BREAKING_SPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u205f\u3000]/

const startsWithBreakingSpace = (text: string): boolean => BREAKING_SPACE.test(text.slice(0, 1))
const endsWithBreakingSpace = (text: string): boolean => BREAKING_SPACE.test(text.slice(-1))

const FORWARD: Direction = {
  first: 'firstChild',
  next: 'nextSibling',
  leading: startsWithBreakingSpace,
  trailing: endsWithBreakingSpace,
}

const BACKWARD: Direction = {
  first: 'lastChild',
  next: 'previousSibling',
  leading: endsWithBreakingSpace,
  trailing: startsWithBreakingSpace,
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
  /** The cut where the walk stopped is safe from its far side: a block
   *  boundary lies in the gap, or the node the budget refused begins with
   *  whitespace. */
  readonly stoppedSafe: boolean
}

/** One side of the window, once `trim` has retreated it to a safe cut. */
interface HalfWindow {
  readonly pieces: Piece[]
  readonly truncated: boolean
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
  /* `none` is not asked: a `display: none` element is SKIPPED before its
   * block-ness can matter — never entered, and never the parent of an entry the
   * walk climbs out of. */
  if (!display || display === 'contents') return false
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
  const visibility = style.visibility
  const facts: ElementFacts = {
    skipped: SKIPPED_TAGS.has(tag) || style.display === 'none',
    visible: visibility !== 'hidden' && visibility !== 'collapse',
    /* Asked of every element and read only where it can matter: a skipped
     * element is never entered nor climbed out of, and `<br>` is handled by
     * name where it is met — a break BETWEEN its siblings rather than a box
     * with edges to cross. */
    block: isBlockLevel(style),
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
 * The first text node of `from`'s subtree, in `dir`'s order.
 *
 * Returns `null` when the subtree holds none — the caller then continues from
 * `from` as if its subtree were finished. Block edges met on the way in set
 * `pendingBreak`; the matching edges on the way out are set by `advance` as it
 * climbs.
 *
 * ⚠️ **A LOOP, AND IT WAS RECURSION — ONE FRAME PER LEVEL OF NESTING.** A tree
 * ten thousand elements deep threw `RangeError: Maximum call stack size
 * exceeded` long before the node budget could refuse it: a throw, where every
 * other pathological tree gets a decline. And the loop over a node's children
 * went on stepping through siblings once the budget was spent — its comment
 * said each call past the budget refused at its first line, "touching nothing",
 * and ten thousand empty siblings were still ten thousand reads. It climbs back
 * by `parentNode` now, as `advance` does, and stops the moment the budget runs
 * out. Both found by audit.
 */
function descend(from: Node, dir: Direction, walk: Walk): Text | null {
  let node: Node = from
  for (;;) {
    if (walk.overflowed || !budgetLeft(walk)) return null
    const type = node.nodeType
    if (type === TEXT_NODE) {
      const parent = node.parentNode
      const parentFacts = parent ? walk.facts.get(parent) : undefined
      if (!parentFacts || parentFacts.visible) return node as Text
    } else if (type === ELEMENT_NODE) {
      const el = node as Element
      const facts = factsOf(el, walk)
      if (!facts.skipped) {
        if (tagOf(el) === 'BR') {
          walk.pendingBreak = true
        } else {
          if (facts.block) walk.pendingBreak = true
          const child = el[dir.first]
          if (child) {
            node = child
            continue
          }
        }
      }
    }
    /* This node's subtree is finished: on to the next sibling, climbing out of
     * every subtree that has none — but never past `from`, whose own siblings
     * are its caller's to walk. Everything stepped through lies strictly inside
     * `from`, so every climb has a parent and meets `from` before it could meet
     * null. */
    for (;;) {
      if (node === from) return null
      const sibling = node[dir.next]
      if (sibling) {
        node = sibling
        break
      }
      node = node.parentNode as Node
    }
  }
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
    /* Every step up from a walked node is an element under the root, whose facts
     * the way down already read — `reachable` refused anything else before the
     * walk began — so the climb meets the root before it could meet null. */
    const parent = cur.parentNode as Element
    /* Leaving a block is a boundary just as entering one is; the flag is a
     * boolean, so a nest of them still yields exactly one sentinel. */
    if (factsOf(parent, walk).block) walk.pendingBreak = true
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
      return { pieces, complete: !walk.overflowed, stoppedSafe: walk.pendingBreak }
    }
    const text = next.data
    if (used + text.length > budget) {
      /* THE NODE REFUSED IS STILL EVIDENCE. It was read, and whitespace at the
       * edge the walk arrived at makes the cut in front of it safe — discarding
       * that declined `['word', ' next sentence']` under a four-character
       * budget, against a cut beside a space. Found by audit. */
      return { pieces, complete: false, stoppedSafe: walk.pendingBreak || dir.leading(text) }
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
 * predicates serve both directions: `dir.trailing` is whitespace at the edge
 * the cut is made on, `dir.leading` whitespace at the edge left behind.
 */
function trim(gathered: Gathered, seedText: string, dir: Direction): HalfWindow {
  if (gathered.complete) return { pieces: gathered.pieces, truncated: false }
  const pieces = [...gathered.pieces]
  /* Dropping every piece leaves the cut at the far edge of the seed, which is
   * always in the window — so the seed's own text is what the last question is
   * asked about. */
  const endsWith = (): string => pieces[pieces.length - 1]?.text ?? seedText
  let safe = gathered.stoppedSafe || dir.trailing(endsWith())
  while (!safe) {
    const dropped = pieces.pop()
    /* Nothing left to drop: the seed's own far edge was the last cut to ask about. */
    if (dropped === undefined) break
    safe = dropped.gapBreak || dir.leading(dropped.text) || dir.trailing(endsWith())
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
 *
 * ⚠️ **AND THE CLIMB IS CHARGED TO THE NODE BUDGET, WHICH IT WAS NOT.** It
 * reads a computed style at every level, and reading those free let a one-node
 * budget read a hundred and one. A climb the budget cannot pay for is a block
 * that could not be read, so it refuses like one. Found by audit.
 */
function reachable(node: Text, walk: Walk): boolean {
  if (node.nodeType !== TEXT_NODE) return false
  let cur: Node = node
  while (cur !== walk.root) {
    const parent: Node | null = cur.parentNode
    if (!parent || parent.nodeType !== ELEMENT_NODE) return false
    if (!budgetLeft(walk)) return false
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
    /* A walk that read nothing vouches for no edge, whatever the reason. */
    reachedStart: false,
    reachedEnd: false,
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
  const view = root.ownerDocument.defaultView
  if (!view) return nothing(true)

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const walk: Walk = {
    root,
    view,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    facts: new Map(),
    visits: 0,
    // Stryker disable next-line BooleanLiteral: every gather resets it before its first read.
    pendingBreak: false,
    overflowed: false,
  }

  const anchor = options.anchors?.[0]
  let backward: HalfWindow = { pieces: [], truncated: false }
  /* With no anchor the seed IS the first text in the tree, so nothing lies
   * before it by construction. */
  let reachedStart = true
  let seed: Text | null
  if (anchor) {
    if (!reachable(anchor.node, walk)) return nothing(true)
    seed = anchor.node
    /* A quarter of the budget behind the anchor: a word extends backward from
     * an edge by a few characters, not by a paragraph, and the remainder is
     * more useful ahead of it where the second edge of a selection lives. */
    const gatheredBehind = gather(seed, BACKWARD, walk, Math.floor(maxChars / 4))
    reachedStart = gatheredBehind.complete
    backward = trim(gatheredBehind, seed.data, BACKWARD)
  } else {
    seed = descend(root, FORWARD, walk)
  }
  if (!seed) return nothing(walk.overflowed)

  const behind = backward.pieces.reduce((total, piece) => total + piece.text.length, 0)
  const ahead = Math.max(0, maxChars - seed.data.length - behind)
  const gatheredAhead = gather(seed, FORWARD, walk, ahead)
  const forward = trim(gatheredAhead, seed.data, FORWARD)

  return assemble(seed, backward, forward, { reachedStart, reachedEnd: gatheredAhead.complete })
}

/** The two half-windows and the seed, in document order, with the sentinels
 *  written in and the lookups built. */
function assemble(
  seed: Text,
  backward: HalfWindow,
  forward: HalfWindow,
  edges: { readonly reachedStart: boolean; readonly reachedEnd: boolean },
): Flattened {
  const behind = backward.pieces
  /* A backward piece's own `gapBreak` describes the gap on its LATER side, so
   * in document order it belongs to the piece in front of it — and the piece
   * farthest back has nothing in front of it at all. */
  const ordered: { node: Text; text: string; breakBefore: boolean }[] = [
    ...behind
      .map((piece, i) => ({ node: piece.node, text: piece.text, breakBefore: behind[i + 1]?.gapBreak ?? false }))
      .reverse(),
    { node: seed, text: seed.data, breakBefore: behind[0]?.gapBreak ?? false },
    ...forward.pieces.map((piece) => ({ node: piece.node, text: piece.text, breakBefore: piece.gapBreak })),
  ]

  const strs: string[] = []
  const nodes: FlatNode[] = []
  const byNode = new Map<Text, FlatNode>()
  const byIndex = new Map<number, FlatNode>()
  let flat = 0
  for (const piece of ordered) {
    /* No leading sentinel: the window's own edge is not a block boundary
     * anyone can act on, and a leading one would shift every offset in the
     * table by one for no gain. Nothing here needs to refuse one — the first
     * entry in document order is given `breakBefore: false` by both `?? false`
     * above. */
    if (piece.breakBefore) {
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

  return {
    strs,
    nodes,
    truncatedStart: backward.truncated,
    truncatedEnd: forward.truncated,
    reachedStart: edges.reachedStart,
    reachedEnd: edges.reachedEnd,

    toFlat(node: Text, offset: number): Edge | null {
      const row = byNode.get(node)
      if (!row) return null
      if (!Number.isInteger(offset) || offset < 0 || offset > row.flatEnd - row.flatStart) return null
      return { index: row.index, offset }
    },

    fromFlat(index: number, offset: number): DomPosition | null {
      if (!Number.isInteger(index) || index < 0 || index >= strs.length) return null
      const row = byIndex.get(index)
      /* A sentinel's entry is as long as the sentinel, and an offset into it is
       * held to that exactly as one into a node is held to the node. ⚠️ It was
       * CLAMPED instead, so `-1`, `0.5`, `NaN` and `99` all came back as live
       * positions. Found by audit. */
      const length = row ? row.flatEnd - row.flatStart : SENTINEL.length
      if (!Number.isInteger(offset) || offset < 0 || offset > length) return null
      if (row) return { node: row.node, offset }
      /* A sentinel occupies no DOM at all, so a position inside one is really
       * the seam beside it: its start is the end of the node before, its end
       * the start of the node after. Both are live positions; neither invents
       * one. And both EXIST: no sentinel is written first or last, and a nest
       * of breaks writes one — so an entry of text stands on either side of
       * every sentinel. */
      const before = byIndex.get(index - 1) as FlatNode
      const after = byIndex.get(index + 1) as FlatNode
      return offset === 0
        ? { node: before.node, offset: before.flatEnd - before.flatStart }
        : { node: after.node, offset: 0 }
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

  /* BOTH MAP, so there is nothing to decline here. `snapWordRange` answers
   * edges inside `strs` — `startEdge` takes the last entry that begins at or
   * before the position and `endEdge` the first that ends at or after it, so
   * each offset lies inside its own entry — and `fromFlat` maps every one of
   * those, a sentinel's index included, which resolves to the seam beside it.
   * The cast is `fromFlat`'s own idiom for a null it has just proved cannot
   * happen.
   *
   * ⚠️ **AND IT WAS A GUARD UNDER A Stryker `disable` DIRECTIVE, WHICH HID A MUTANT EIGHT
   * TESTS KILL.** The directive named `ConditionalExpression`, so it covered the
   * whole condition — including `if (true) return null`, which turns every snap
   * in the app into "leave the selection alone" and was reported as ignored
   * rather than as a survivor. The equivalent half (`false`, and the `&&`) is
   * gone with the branch rather than hidden beside it. Found by mutation
   * testing, 2026-09-14. */
  const snappedStart = flat.fromFlat(snapped.start.index, snapped.start.offset) as DomPosition
  const snappedEnd = flat.fromFlat(snapped.end.index, snapped.end.offset) as DomPosition
  return { start: snappedStart, end: snappedEnd }
}
