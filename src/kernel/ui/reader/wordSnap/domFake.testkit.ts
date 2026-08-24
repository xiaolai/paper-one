/**
 * A hand-built DOM, keyed so that walking the wrong node changes the answer.
 *
 * The `unit` lane has **no DOM environment and no jsdom, deliberately** — see
 * the lane's own description in `.claude/tdd-guardian/config.json`. So the DOM
 * adapters in this directory are tested against this fake, and the discipline
 * that makes a fake worth anything is set out at `markGeometry.test.ts:53`: an
 * earlier fake there *answered the same for the right and the wrong element*,
 * so a regression that measured `body` for every mark stayed green. A fake
 * that cannot tell a right walk from a wrong one certifies bugs.
 *
 * Concretely, this one:
 *
 * 1. **Refuses duplicate text.** `buildFixture` throws if two text nodes in a
 *    tree hold the same string, so `'x'`/`'x'`/`'x'` fixtures cannot be
 *    written. Walking the wrong node always changes the flat string, and
 *    `fixture.text(data)` can address a node by content precisely because the
 *    content is unique.
 * 2. **Answers `getComputedStyle` per element**, exactly like `markGeometry`'s
 *    `fontFor`. `display` comes from the element's own configuration or a UA
 *    default keyed on its tag; `visibility` inherits, as it does in CSS.
 * 3. **Models blockification.** An out-of-flow element (`position: absolute`
 *    or `fixed`) reports `display: block` however it was declared — CSS
 *    Display 3 §2.7's automatic box type transformation, and the reason
 *    pdf.js's absolutely-positioned text spans are NOT the inline elements
 *    they look like in the markup. A fake that skipped this would turn the
 *    PDF text-layer case into the ordinary inline case without saying so.
 * 4. **Models `isConnected` transitively.** Replacing a container's children
 *    flips it on the former *descendants*, not only on the container, so an
 *    implementation that checks a text node's own `isConnected` cannot pass
 *    vacuously.
 * 5. **Counts node visits.** `fixture.visits` increments on every `nodeType`
 *    read — the one property any walk must read to tell a text node from an
 *    element — which is what the bounded-walk case asserts against. A visit
 *    count is the honest observable there; a wall-clock threshold is flaky and
 *    proves nothing on a loaded machine.
 * 6. **Keeps namespaced attributes apart from literal ones.** `getAttributeNS`
 *    answers only what a fixture declared as namespaced, and `getAttribute`
 *    only what it declared literally. That is the difference between a book
 *    foliate parsed as XHTML and one it had to reparse as `text/html`, and an
 *    implementation reading one spelling is a live defect — see
 *    `ElementOptions.namespaced`.
 *
 * `domFake.test.ts` asserts all six, because a fake that quietly stopped
 * doing any of them would leave every case that depends on it green and
 * vacuous, and nothing else in the suite would notice.
 *
 * Test-only. The `.testkit.ts` suffix is the same convention as
 * `sourceScan.testkit.ts`: vitest collects `*.test.ts`, so this file is
 * imported by tests without being run as one, and nothing under `src/`
 * imports it, so it never reaches a bundle.
 *
 * **Live-lane partner: the `live` lane** — `node scripts/word-snap-live.mjs`.
 * Every fixture below is a claim about what WebKit would report for the same
 * markup. Nothing here can prove that claim — `<br>`, blockification, inherited
 * visibility and computed `display` are WebKit's behaviour, not this file's.
 *
 * The lane covers **part** of that, and the part matters: `block-merge` and
 * `br-merge` flatten a real document with real computed styles, so the two
 * sentinel sources below are measured rather than modelled. It does **not**
 * cover inherited `visibility`, `display: contents`, or any of this on a real
 * EPUB section or PDF text layer — those stay unmet, and the lane is
 * manual-only besides, so **check whether it has been run.**
 */

/** `Node.TEXT_NODE` / `Node.ELEMENT_NODE`, spelled as the numbers they are.
 *  There is no `Node` global in this lane — naming one would throw on import,
 *  which is exactly the kind of DOM dependency the lane exists to keep out. */
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** A tree, before it is built. Plain data, so a fixture reads as markup. */
export type Spec = TextSpec | ElementSpec

interface TextSpec {
  readonly kind: 'text'
  readonly data: string
}

interface ElementSpec {
  readonly kind: 'element'
  readonly tag: string
  readonly options: ElementOptions
  readonly children: readonly Spec[]
}

export interface ElementOptions {
  /** A handle for `fixture.element(id)`, and for `replaceChildren`. */
  readonly id?: string
  /** As DECLARED. What `getComputedStyle` reports may differ — see
   *  blockification above. */
  readonly display?: string
  readonly visibility?: string
  readonly position?: string
  /**
   * Attributes under their LITERAL, qualified names — what `getAttribute`
   * answers, and all an HTML parser leaves behind.
   */
  readonly attributes?: Readonly<Record<string, string>>
  /**
   * Attributes an XML parser put in a namespace, keyed `<namespace>|<local>` —
   * what `getAttributeNS` answers, and NOTHING ELSE answers it.
   *
   * The two are declared separately on purpose, because in this repository
   * they genuinely come apart and an implementation that reads only one of
   * them is a live defect. foliate reparses invalid XHTML as `text/html`, and
   * an HTML parser has no namespaces to put `epub:type` in — measured on the
   * same markup, `getAttributeNS(OPS,'type')` is `null` under `text/html` and
   * `"noteref"` under `application/xhtml+xml`, while `getAttribute('epub:type')`
   * is `"noteref"` under both. A fake that answered `getAttributeNS` out of the
   * literal table would make the HTML case indistinguishable from the XHTML
   * one, and certify exactly the bug it exists to catch. So a fixture states
   * both facts or it states one, and the reader has to cope with what it says.
   */
  readonly namespaced?: Readonly<Record<string, string>>
}

export function txt(data: string): Spec {
  return { kind: 'text', data }
}

export function elem(tag: string, options: ElementOptions = {}, children: readonly Spec[] = []): Spec {
  return { kind: 'element', tag, options, children }
}

/**
 * The UA stylesheet, to the extent these tests depend on it.
 *
 * A tag list here is not the tag list the implementation is forbidden to have.
 * A browser genuinely does start from tags and then lets author CSS override
 * them; that is the whole reason `<span style="display:block">` and
 * `<p style="display:inline">` are the pair that pins the rule. The
 * implementation must read the *result*, which is what `getComputedStyle`
 * returns.
 *
 * The non-`block` block displays are spelled out rather than flattened to
 * `block`, because an implementation comparing `display === 'block'` is a
 * plausible near-miss and `<li>` is where it shows.
 */
const UA_DISPLAY: Readonly<Record<string, string>> = {
  P: 'block',
  DIV: 'block',
  SECTION: 'block',
  ARTICLE: 'block',
  BLOCKQUOTE: 'block',
  FIGURE: 'block',
  PRE: 'block',
  H1: 'block',
  H2: 'block',
  H3: 'block',
  H4: 'block',
  H5: 'block',
  H6: 'block',
  UL: 'block',
  OL: 'block',
  LI: 'list-item',
  TABLE: 'table',
  TR: 'table-row',
  TD: 'table-cell',
  SCRIPT: 'none',
  STYLE: 'none',
  TEMPLATE: 'none',
}

interface Counters {
  visits: number
  styleReads: number
}

class FakeNode {
  parentNode: FakeElement | null = null
  nextSibling: FakeNode | null = null
  previousSibling: FakeNode | null = null

  constructor(
    protected readonly counters: Counters,
    readonly ownerDocument: unknown,
  ) {}

  /** Every walk reads this to tell a text node from an element, which is what
   *  makes it the honest place to count a visit. */
  get nodeType(): number {
    this.counters.visits += 1
    return this.rawNodeType
  }

  protected get rawNodeType(): number {
    throw new Error('FakeNode: abstract')
  }

  /** Transitive by construction: connectivity is a property of the topmost
   *  ancestor, so detaching a container detaches everything beneath it without
   *  anyone having to remember to update a flag. */
  get isConnected(): boolean {
    let top: FakeNode = this
    while (top.parentNode) top = top.parentNode
    return top === (this.ownerDocument as { documentRoot: unknown }).documentRoot
  }
}

class FakeText extends FakeNode {
  constructor(counters: Counters, ownerDocument: unknown, public data: string) {
    super(counters, ownerDocument)
  }

  protected override get rawNodeType(): number {
    return TEXT_NODE
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string
  firstChild: FakeNode | null = null
  lastChild: FakeNode | null = null

  constructor(
    counters: Counters,
    ownerDocument: unknown,
    tag: string,
    readonly options: ElementOptions,
  ) {
    super(counters, ownerDocument)
    this.tagName = tag.toUpperCase()
  }

  protected override get rawNodeType(): number {
    return ELEMENT_NODE
  }

  /** The literal, qualified name — all an HTML parser leaves behind. */
  getAttribute(name: string): string | null {
    return this.options.attributes?.[name] ?? null
  }

  /** The namespaced spelling, and ONLY that — see `ElementOptions.namespaced`
   *  for why this must not fall back to the literal table. */
  getAttributeNS(namespace: string, local: string): string | null {
    return this.options.namespaced?.[`${namespace}|${local}`] ?? null
  }
}

/** The declared display of an element: its own, else its tag's UA value. */
function declaredDisplay(el: FakeElement): string {
  return el.options.display ?? UA_DISPLAY[el.tagName] ?? 'inline'
}

/**
 * CSS Display 3 §2.7: an out-of-flow box is blockified, and
 * `getComputedStyle` reports the transformed value, not the declared one.
 *
 * This is modelled because it is the difference between the PDF text layer
 * case being a real test and being a restatement of the inline case: every
 * span pdf.js emits is `position: absolute`, so every one of them reports
 * `display: block` however the markup reads.
 */
function computedDisplay(el: FakeElement): string {
  const declared = declaredDisplay(el)
  if (declared === 'none') return 'none'
  const position = el.options.position ?? 'static'
  if (position !== 'absolute' && position !== 'fixed') return declared
  return declared.startsWith('inline') || declared === 'contents' ? 'block' : declared
}

/** `visibility` inherits, so an element with none of its own answers with its
 *  nearest configured ancestor's — which is what makes a `visibility: visible`
 *  span inside a hidden one a real question rather than a fixture artefact. */
function computedVisibility(el: FakeElement): string {
  let cur: FakeElement | null = el
  while (cur) {
    if (cur.options.visibility) return cur.options.visibility
    cur = cur.parentNode
  }
  return 'visible'
}

export class Fixture {
  private readonly counters: Counters = { visits: 0, styleReads: 0 }
  private readonly texts = new Map<string, FakeText>()
  private readonly elements = new Map<string, FakeElement>()
  private readonly doc: {
    documentRoot: FakeElement | null
    defaultView: { getComputedStyle: (target: unknown) => unknown } | null
  }
  private readonly rootNode: FakeElement
  private nodes = 0

  constructor(spec: Spec, options: { readonly detachedView?: boolean } = {}) {
    if (spec.kind !== 'element') throw new Error('buildFixture: the root of a fixture must be an element')
    this.doc = {
      documentRoot: null,
      defaultView: options.detachedView
        ? null
        : {
            getComputedStyle: (target: unknown) => {
              this.counters.styleReads += 1
              const el = target as FakeElement
              return {
                display: computedDisplay(el),
                visibility: computedVisibility(el),
                position: el.options.position ?? 'static',
              }
            },
          },
    }
    this.rootNode = this.build(spec) as FakeElement
    this.doc.documentRoot = this.rootNode
  }

  private build(spec: Spec): FakeNode {
    this.nodes += 1
    if (spec.kind === 'text') {
      if (this.texts.has(spec.data)) {
        throw new Error(
          `buildFixture: two text nodes hold ${JSON.stringify(spec.data)}. ` +
            'Every text node in a fixture must be distinct, or walking the wrong one ' +
            'does not change the answer and the case proves nothing.',
        )
      }
      const node = new FakeText(this.counters, this.doc, spec.data)
      this.texts.set(spec.data, node)
      return node
    }
    const el = new FakeElement(this.counters, this.doc, spec.tag, spec.options)
    if (spec.options.id !== undefined) {
      if (this.elements.has(spec.options.id)) {
        throw new Error(`buildFixture: duplicate element id ${JSON.stringify(spec.options.id)}`)
      }
      this.elements.set(spec.options.id, el)
    }
    this.link(el, spec.children.map((child) => this.build(child)))
    return el
  }

  private link(parent: FakeElement, children: readonly FakeNode[]): void {
    parent.firstChild = children[0] ?? null
    parent.lastChild = children[children.length - 1] ?? null
    children.forEach((child, i) => {
      child.parentNode = parent
      child.previousSibling = children[i - 1] ?? null
      child.nextSibling = children[i + 1] ?? null
    })
  }

  /** The element a walk should be given. */
  get root(): Element {
    return this.rootNode as unknown as Element
  }

  /** How many `nodeType` reads the tree has served — the bounded walk's only
   *  honest observable. */
  get visits(): number {
    return this.counters.visits
  }

  /** How many `getComputedStyle` calls the tree has served. */
  get styleReads(): number {
    return this.counters.styleReads
  }

  /** Every node in the tree, elements included. */
  get nodeCount(): number {
    return this.nodes
  }

  resetCounters(): void {
    this.counters.visits = 0
    this.counters.styleReads = 0
  }

  /** A text node, by its content. Unique by construction — see `build`. */
  text(data: string): Text {
    const node = this.texts.get(data)
    if (!node) throw new Error(`Fixture.text: no text node holding ${JSON.stringify(data)}`)
    return node as unknown as Text
  }

  /** An element, by the `id` its spec gave it. */
  element(id: string): Element {
    const el = this.elements.get(id)
    if (!el) throw new Error(`Fixture.element: no element with id ${JSON.stringify(id)}`)
    return el as unknown as Element
  }

  /**
   * Replace a container's children, as a re-render does.
   *
   * The former children keep their own `parentNode` pointers downward, so
   * their descendants stay linked to each other — and every one of them is now
   * disconnected, because connectivity is decided by the topmost ancestor.
   * That is the shape WI-11 has to survive: a text node captured before a PDF
   * page repaints looks perfectly intact from the inside.
   */
  replaceChildren(id: string, children: readonly Spec[]): void {
    const container = this.elements.get(id)
    if (!container) throw new Error(`Fixture.replaceChildren: no element with id ${JSON.stringify(id)}`)
    for (let child = container.firstChild; child; child = child.nextSibling) child.parentNode = null
    this.link(
      container,
      children.map((child) => this.build(child)),
    )
  }
}

export function buildFixture(spec: Spec, options: { readonly detachedView?: boolean } = {}): Fixture {
  return new Fixture(spec, options)
}
