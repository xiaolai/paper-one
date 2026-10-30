/**
 * A modelled fake `Selection`, over the fake DOM of `domFake.testkit.ts`.
 *
 * The `unit` lane has no DOM environment and no jsdom, deliberately — see the
 * lane's own description in `.claude/tdd-guardian/config.json`. So the one
 * module that writes to a live `Selection` is tested against this.
 *
 * **A recorder would be worthless here.** A fake that merely remembers which
 * arguments `setBaseAndExtent` was called with turns every case in
 * `applySnap.test.ts` into a wiring assertion: they would all stay green with
 * the adapter gutted, because nothing would ever ask what the selection now
 * *is*. So this one models, and the cases assert through the model's resulting
 * text and boundary fields rather than through a call log:
 *
 * 1. **`toString()` is computed by walking the tree** between the two ordered
 *    boundary points, so mutating the selection changes its text. That is what
 *    makes a Level 4 assertion possible at all.
 * 2. **`setBaseAndExtent` really moves the boundaries**, in the order it was
 *    given them, which is what makes the direction of the write observable.
 *    Passing the two edges the wrong way round is visible in `anchorNode` /
 *    `focusOffset`, not merely in a recorded argument list.
 * 3. **A previously issued `Range` is detached by the write.** Measured in
 *    WebKit: `captured === getRangeAt(0)` is `true` before `setBaseAndExtent`
 *    and `false` after, and the captured range keeps returning the OLD text
 *    while the live one returns the new. Both halves are modelled, because the
 *    adapter's whole reason for re-reading rests on them.
 * 4. **The illegal calls throw**, as the real API does: `getRangeAt` with no
 *    range, a non-text boundary node, an offset past the end of its node. An
 *    adapter that wrote flat coordinates back without unmapping them to nodes
 *    fails loudly here instead of quietly storing nonsense.
 *
 * The `the fake Selection contract` block in `applySnap.test.ts` asserts all
 * four, because a fake that quietly stopped doing any of them would leave every
 * case that depends on it green and vacuous, and nothing else in the suite
 * would notice. That is not hypothetical: `markGeometry.test.ts:53` documents
 * exactly that happening one layer down. Measured: replacing `setBaseAndExtent`
 * with a call recorder fails nine cases here, five of them in the adapter.
 *
 * Test-only. The `.testkit.ts` suffix is the same convention as
 * `domFake.testkit.ts`: vitest collects `*.test.ts`, so this file is imported
 * by tests without being run as one, and nothing under `src/` imports it, so it
 * never reaches a bundle.
 *
 * **Live-lane partner: the `live` lane** — `node scripts/word-snap-live.mjs`,
 * check `range-detach`. Everything above is a claim about WebKit that this file
 * cannot prove; it can only be consistent with what was measured there. That
 * check is the one that measures it, and it is the highest-value check in the
 * lane: if the real engine ever disagrees with the detach model below, every
 * Level 4 assertion in `applySnap.test.ts` becomes suspect at once. The lane is
 * manual-only — **check whether it has been run before treating this pairing as
 * met.**
 */

/** `Node.TEXT_NODE`, spelled as the number it is. There is no `Node` global in
 *  this lane — naming one would throw on import. */
const TEXT_NODE = 3

/** One end of a selection: a text node and an offset into it. */
export interface Boundary {
  readonly node: Text
  readonly offset: number
}

/** The topmost ancestor of a node — the tree it currently belongs to. */
function topmost(node: Node): Node {
  let cur: Node = node
  while (cur.parentNode) cur = cur.parentNode
  return cur
}

/** Every text node under `root`, in document order. Reads `nodeType` and
 *  nothing else, so a fixture whose `data` throws can still be ordered. */
function textNodesUnder(root: Node): Text[] {
  const found: Text[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      found.push(node as Text)
      return
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(root)
  return found
}

/**
 * Document order of two boundaries: negative, zero or positive.
 *
 * Throws when the two are no longer in one tree. A real selection cannot span
 * two trees, so this is a broken fixture or a stale pair captured before a
 * re-render — and answering it with a guess would let a test assert an order
 * that no browser would produce.
 */
export function compareBoundaries(a: Boundary, b: Boundary): number {
  if (a.node === b.node) return Math.sign(a.offset - b.offset)
  const order = textNodesUnder(topmost(a.node))
  const first = order.indexOf(a.node)
  const second = order.indexOf(b.node)
  if (first < 0 || second < 0) {
    throw new Error('FakeSelection: the two boundaries are not in one tree')
  }
  return Math.sign(first - second)
}

/**
 * The text between two ordered boundaries, as WebKit's `toString()` gives it.
 *
 * **No separator between nodes, and none at a block boundary.** That is the
 * verified behaviour — `<p>all done</p><p>Start here</p>` really does yield
 * `'all doneStart here'` — and it is a defect WI-9 fixes in the published text.
 * Modelling it faithfully is what keeps WI-6's block case honest: it asserts
 * boundary fields precisely because the text here is the wrong shape.
 */
function textBetween(start: Boundary, end: Boundary): string {
  if (start.node === end.node) return start.node.data.slice(start.offset, end.offset)
  const order = textNodesUnder(topmost(start.node))
  const first = order.indexOf(start.node)
  const last = order.indexOf(end.node)
  if (first < 0 || last < 0 || last < first) {
    throw new Error('FakeSelection: the two boundaries are not in one tree, in order')
  }
  let text = start.node.data.slice(start.offset)
  for (let i = first + 1; i < last; i += 1) text += order[i]?.data ?? ''
  return text + end.node.data.slice(0, end.offset)
}

/**
 * A `Range` the fake issued.
 *
 * It holds its own boundary points, so once the selection has moved on it keeps
 * answering with the text it described when it was issued — which is what a
 * detached WebKit range does, and what makes reusing one a silent wrong answer
 * rather than an error.
 */
export class FakeRange {
  private detached = false

  constructor(
    readonly startContainer: Text,
    readonly startOffset: number,
    readonly endContainer: Text,
    readonly endOffset: number,
  ) {}

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset
  }

  /** Whether `setBaseAndExtent` has run since this range was handed out. */
  get isDetached(): boolean {
    return this.detached
  }

  markDetached(): void {
    this.detached = true
  }

  toString(): string {
    return textBetween(
      { node: this.startContainer, offset: this.startOffset },
      { node: this.endContainer, offset: this.endOffset },
    )
  }

  asRange(): Range {
    return this as unknown as Range
  }
}

export class FakeSelection {
  /** How many times `setBaseAndExtent` has been called. Bumped **first**, so a
   *  call that then throws still counts: an adapter that wrote back rubbish
   *  must not be able to hide the write behind the rejection. */
  mutations = 0

  private anchorPoint: Boundary | null = null
  private focusPoint: Boundary | null = null
  private startPoint: Boundary | null = null
  private endPoint: Boundary | null = null
  /** The range handed out by `getRangeAt`, kept so repeated calls return the
   *  same object — as WebKit's does until the selection moves. */
  private cached: FakeRange | null = null
  private readonly issued: FakeRange[] = []

  constructor(anchor: Boundary | null, focus: Boundary | null) {
    if (anchor && focus) this.assign(anchor, focus)
  }

  get anchorNode(): Text | null {
    return this.anchorPoint?.node ?? null
  }

  get anchorOffset(): number {
    return this.anchorPoint?.offset ?? 0
  }

  get focusNode(): Text | null {
    return this.focusPoint?.node ?? null
  }

  get focusOffset(): number {
    return this.focusPoint?.offset ?? 0
  }

  get rangeCount(): number {
    return this.startPoint ? 1 : 0
  }

  get isCollapsed(): boolean {
    if (!this.startPoint || !this.endPoint) return true
    return (
      this.startPoint.node === this.endPoint.node && this.startPoint.offset === this.endPoint.offset
    )
  }

  getRangeAt(index: number): FakeRange {
    if (index !== 0 || !this.startPoint || !this.endPoint) {
      throw new Error(`FakeSelection.getRangeAt(${index}): there are ${this.rangeCount} ranges`)
    }
    if (!this.cached) {
      this.cached = new FakeRange(
        this.startPoint.node,
        this.startPoint.offset,
        this.endPoint.node,
        this.endPoint.offset,
      )
      this.issued.push(this.cached)
    }
    return this.cached
  }

  setBaseAndExtent(
    anchorNode: Node | null,
    anchorOffset: number,
    focusNode: Node | null,
    focusOffset: number,
  ): void {
    this.mutations += 1
    /* Every range issued before this write is dead from here on, and the next
     * `getRangeAt` must build a new one. Done before the arguments are checked,
     * so a rejected write still invalidates them — the ordering WebKit's own
     * selection has, and the reason `publish()` may not hold a captured range
     * across this call under any circumstances. */
    for (const range of this.issued) range.markDetached()
    this.issued.length = 0
    this.cached = null
    this.assign(point(anchorNode, anchorOffset, 'anchor'), point(focusNode, focusOffset, 'focus'))
  }

  toString(): string {
    if (!this.startPoint || !this.endPoint) return ''
    return textBetween(this.startPoint, this.endPoint)
  }

  /** The fake where a `Selection` is expected. There is no real one in this
   *  lane and no in-process substitute for one. */
  asSelection(): Selection {
    return this as unknown as Selection
  }

  private assign(anchor: Boundary, focus: Boundary): void {
    /* Resolved here rather than on every read, so that a pair captured before a
     * re-render still reports the order it had when the reader made it. */
    const forward = compareBoundaries(anchor, focus) <= 0
    this.anchorPoint = anchor
    this.focusPoint = focus
    this.startPoint = forward ? anchor : focus
    this.endPoint = forward ? focus : anchor
  }
}

/** A boundary from what `setBaseAndExtent` was handed, validated as WebKit
 *  validates it: a text node, and an offset inside it. */
function point(node: Node | null, offset: number, label: string): Boundary {
  if (!node || node.nodeType !== TEXT_NODE) {
    throw new Error(`FakeSelection.setBaseAndExtent: the ${label} is not a text node`)
  }
  const text = node as Text
  if (!Number.isInteger(offset) || offset < 0 || offset > text.data.length) {
    throw new Error(
      `FakeSelection.setBaseAndExtent: ${label} offset ${offset} is outside ` +
        `${JSON.stringify(text.data)} (0..${text.data.length})`,
    )
  }
  return { node: text, offset }
}

/** A selection over two boundaries, anchored at the first. Pass them in the
 *  order the reader dragged them: anchor after focus is a backward drag. */
export function selectionOver(anchor: Boundary, focus: Boundary): FakeSelection {
  return new FakeSelection(anchor, focus)
}

/** A selection with no range at all — what a document nobody has clicked has. */
export function emptySelection(): FakeSelection {
  return new FakeSelection(null, null)
}

/**
 * Whether the selection runs right to left, computed from the tree's own order
 * rather than from anything the fake remembered being told.
 */
export function isBackward(selection: FakeSelection): boolean {
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (!anchor || !focus) return false
  return (
    compareBoundaries(
      { node: anchor, offset: selection.anchorOffset },
      { node: focus, offset: selection.focusOffset },
    ) > 0
  )
}
