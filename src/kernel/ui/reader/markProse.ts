/**
 * Which paragraphs the reader's alignment is allowed to reach.
 *
 * Its own module rather than a helper inside the session because the decision
 * it encodes — that centred text is composition and justified text is a default
 * — is the whole of it, and it is the kind of decision that is only safe while
 * something checks it.
 *
 * SPLIT INTO A DECISION, A WALK, AND A READER. `alignsAsProse` is a pure
 * function of two strings and is exhaustively tested. `markProse` is the DOM
 * traversal around it, and it takes the style reader as an argument so that the
 * traversal can be tested too — which elements it marks, and that it reads
 * every one before it writes any.
 *
 * The seam is not a way to test the cascade, and no test should pretend it is.
 * What the walk asks is what the BOOK's own stylesheet computed to, and jsdom
 * does not implement that part: measured, a `.body-text { text-align: justify }`
 * rule leaves `getComputedStyle(p).textAlign` as the empty string there, and
 * only inline styles come back at all. So the cascade is verified in the running
 * app, and the seam covers the part that is ordinary logic — which, before it
 * existed, was covered by nothing: both tests here exercised early returns, and
 * emptying this function left the suite green.
 */

/**
 * Is this element's own alignment an ordinary-prose default, or composition?
 *
 * Three spellings mean "running text": `justify`, `start`, and whichever
 * physical side the reading edge is on. Everything else — centred, or set to
 * the far edge — is something the book did on purpose.
 *
 * WHICH SIDE IS THE READING EDGE IS THE DOCUMENT'S TO SAY. `left` is ordinary
 * prose in English and a deliberate placement in Arabic, and `right` is exactly
 * the other way round. Reading it off the physical side would flatten every
 * placed line in an RTL book while leaving that book's actual prose
 * unreachable — wrong in both directions at once.
 *
 * The empty string counts as prose. An engine that reports nothing has told us
 * the element carries no alignment of its own, which is precisely the case the
 * reader's setting is for.
 */
export function alignsAsProse(align: string, direction: string): boolean {
  const readingEdge = direction === 'rtl' ? 'right' : 'left'
  return align === '' || align === 'justify' || align === 'start' || align === readingEdge
}

/** The elements a reader means by "the text" — running prose, and nothing else. */
const PROSE = 'p, li, blockquote, dd'

/**
 * What a chapter's opening paragraph is NOT inside.
 *
 * `p:first-of-type` cannot say this, which is the whole reason the opening is
 * an attribute: it matches the first paragraph of every blockquote, note,
 * caption and list item in the chapter as readily as the one the chapter opens
 * with, and a drop cap on the first line of a pull quote is a defect nobody
 * asked for.
 *
 * A WHITELIST WOULD BE WRONG HERE. The opening paragraph's ancestors are
 * whatever the converter happened to wrap the chapter in — div, section,
 * article, body itself — and there is no naming them. What CAN be named is the
 * short list of containers that mean "this is an aside, not the running text",
 * so the test is for those and everything else is the flow.
 */
const NOT_THE_FLOW = 'blockquote, aside, figure, figcaption, table, li, dd, dt, nav, header, footer, details'

/**
 * The paragraph a chapter opens with, or null when it has none.
 *
 * FIRST IN DOCUMENT ORDER, and among paragraphs only. A section is one spine
 * item, so its first paragraph in the flow is the one under the chapter's
 * heading — Paper does not need to find the heading to know that, and looking
 * for one would fail on every chapter that opens straight into prose.
 *
 * Empty paragraphs are skipped rather than counted. Converters emit them for
 * spacing constantly, and an initial three lines deep drawn on nothing is the
 * worst outcome this function can produce.
 *
 * NO LENGTH TEST, deliberately, and it is worth saying why rather than leaving
 * it to be discovered. A three-line initial on a two-line paragraph reserves
 * the third line and hangs into it, which is a real typographic wrinkle and one
 * that print has too. Guarding it would mean inventing a threshold in
 * characters, which is a guess at a measure this function cannot see — it runs
 * once at load, before the reader's measure is settled. The wrinkle is visible
 * and self-explanatory; a silently-skipped drop cap is not.
 */
export function openingParagraph(
  body: Element,
  /**
   * An extra test the paragraph must pass, beyond being in the flow and not
   * empty.
   *
   * THE STRUCTURAL ANSWER IS NOT THE TYPOGRAPHIC ONE. Without this, the first
   * `<p>` won outright — so a centred dedication, an epigraph or a chapter
   * number took the drop cap, which is the one place a sunk capital can never
   * belong. The walk passes "did I call this prose", and the search FALLS
   * THROUGH to the paragraph that qualifies rather than giving up on the
   * first that does not.
   */
  accepts: (p: Element) => boolean = () => true,
): Element | null {
  for (const p of body.querySelectorAll('p')) {
    if (p.closest(NOT_THE_FLOW)) continue
    if ((p.textContent ?? '').trim() === '') continue
    if (!accepts(p)) continue
    return p
  }
  return null
}

/**
 * Whether Paper's flourish may be drawn on this paragraph.
 *
 * False when the book already draws its own initial — see `InitialStyle` for
 * why that has to be decided here rather than in the stylesheet.
 *
 * EITHER SIGNAL IS ENOUGH — both are inspected, and one alone answers yes.
 * (This said "BOTH SIGNALS, not either alone", which the examples below and
 * the `||` beneath them both contradict.) A float with no size change is a book raising
 * a normal-size letter out of the flow; a size change with no float is a book
 * setting a raised initial. Each is the book composing its own opening, and
 * Paper's belongs in neither.
 */
export function booksOwnInitial(paragraphFontSize: string, initial: InitialStyle): boolean {
  const sunk = (initial.initialLetter ?? '').trim()
  if (sunk !== '' && sunk !== 'normal') return true
  return initial.float !== 'none' || initial.fontSize !== paragraphFontSize
}

/** What the walk needs to know about one element. */
export interface ProseStyle {
  readonly textAlign: string
  readonly direction: string
}

/**
 * Does the book already draw an initial on this paragraph?
 *
 * WHY THIS IS A QUESTION AND NOT A STYLESHEET RULE. WI-14.4 puts the opening
 * flourish in the tier where a book that states its own view wins, and that
 * cannot be expressed in the cascade, because THE CASCADE RESOLVES PER
 * PROPERTY. A book that already draws a drop cap says font-size, line-height,
 * float and margin; Paper says initial-letter. Neither rule wins — they MERGE,
 * and the reader gets the book's float model wearing Paper's sinkage. Measured
 * on Bad Blood, which ships p.dropcaps3line::first-letter with a 4.5em float:
 * the merged result reserved no space at all and the opening two lines ran
 * straight through the letter.
 *
 * Winning the cascade instead is not open to us, and three guards in this repo
 * say so in three different ways: the flourish must stay in the before tier
 * (`bookSettings`), only seven properties may be marked important (`spacing`),
 * and a font-size may be forced on the base and nowhere else (`bookSize`). All
 * three are right. So the choice is made one level up, where it CAN be made —
 * the paragraph is simply not marked, and a rule that matches nothing cannot
 * merge with anything.
 *
 * THE TEST IS "DOES IT DIFFER FROM THE PARAGRAPH", not "is there a rule". A
 * pseudo-element with no rule of its own computes to the element's own values,
 * so a book that never mentions ::first-letter answers false on both counts
 * without anything having to parse its stylesheet.
 */
export interface InitialStyle {
  /** The pseudo-element's size. Equal to the paragraph's when unstyled. */
  readonly fontSize: string
  /** `none` unless the book floats the letter, which is the drop-cap model. */
  readonly float: string
  /**
   * `initial-letter`, the property that exists for exactly this.
   *
   * THE THIRD SIGNAL, and the one a book written after 2020 is most likely to
   * use: it sinks a capital without floating it or changing `font-size`, so a
   * book composing a perfectly good drop cap read as composing nothing and
   * got Paper's flourish merged on top of its own. WebKit still wants the
   * prefix, which is why both are asked for and either counts.
   *
   * Absent or `normal` means the book is not using it.
   */
  readonly initialLetter?: string
}

/**
 * How the walk decides whether a book composes this opening — the second seam.
 *
 * A predicate rather than a style bag, because only one element is ever asked
 * and the arithmetic behind the answer is `booksOwnInitial`, which is tested on
 * its own. Keeping the seam this small also keeps the jsdom limit honest: the
 * cascade is not something the unit lane can evaluate, and a reader that
 * returned raw values would invite a test that pretended otherwise.
 */
export type InitialReader = (el: Element) => boolean

/** How the walk reads an element's own alignment — the seam. */
export type StyleReader = (el: Element) => ProseStyle

/**
 * Mark the running prose, so the reader's alignment can reach it.
 *
 * A body-level `text-align` loses to any rule that matches the element, and
 * books write those constantly: measured over 400 EPUBs in a real library, 32%
 * set paragraph alignment ONLY from a class, and on every one of them the
 * Alignment control did nothing whatever it was set to. `bookCss` answers that
 * for line-height, tracking and paragraph spacing by declaring them
 * `!important` on the prose elements, and the note there explains why raising
 * the selector instead is an arms race a book always wins.
 *
 * ALIGNMENT CANNOT TAKE THAT ANSWER UNCHANGED, which is the whole reason this
 * exists rather than one more line in that rule. `text-align` is the one of
 * them a book uses to COMPOSE rather than to state a default: 45% of those same
 * 400 centre paragraphs from a class — dedications, epigraphs, verse, chapter
 * numbers, the attribution under a quotation — and a blanket `!important` turns
 * every one of them into running prose. Winning the cascade there is not the
 * reader's setting working, it is the book being damaged.
 *
 * The VALUE is not written here. It stays in the stylesheet against
 * `[data-paper-prose]`, so changing the setting is still one stylesheet swap
 * and these marks never need revisiting — which also means this can run once
 * per document, at load, rather than on every settings pass.
 */
export function markProse(doc: Document, readStyle?: StyleReader, readInitial?: InitialReader): void {
  /* A section that failed to parse hands back a document with neither, and this
     runs on every section that loads — the same case `ensureLang` guards. */
  const win = doc.defaultView
  const body = doc.body as HTMLElement | null
  if (!body || (!win && !readStyle)) return

  const read: StyleReader =
    readStyle ??
    ((el) => {
      const style = win!.getComputedStyle(el)
      return { textAlign: style.textAlign, direction: style.direction }
    })

  /* GUARDED ON THE CAPABILITY, NOT ON THE OBJECT. A document standing in for a
     book in the unit lane has a `defaultView` that is a bare object — truthy,
     and with no `getComputedStyle` on it — so a null check on the window passes
     and the call below still throws. There is no cascade to ask in that lane,
     and the honest answer when none can be asked is that the book composes
     nothing. */
  const composed: InitialReader =
    readInitial ??
    ((el) => {
      if (typeof win?.getComputedStyle !== 'function') return false
      const style = win.getComputedStyle(el, '::first-letter')
      return booksOwnInitial(win.getComputedStyle(el).fontSize, {
        fontSize: style.fontSize,
        float: style.float,
        /* `getPropertyValue` rather than a typed field: `initial-letter` is
           not in every lib.dom, and WebKit answers on the prefix. */
        /* EITHER, AND `normal` IS NOT AN ANSWER. `a || b` let a standard
           value of `normal` — truthy — mask a prefixed value that said the
           book DOES sink its capital, which is the arrangement WebKit
           actually produces. */
        initialLetter:
          [
            style.getPropertyValue('initial-letter'),
            style.getPropertyValue('-webkit-initial-letter'),
          ].find((value) => {
            const said = (value ?? '').trim()
            return said !== '' && said !== 'normal'
          }) ?? '',
      })
    })

  /* READ EVERY ELEMENT BEFORE WRITING ANY. `getComputedStyle` flushes pending
     style and setting an attribute invalidates it again, so interleaving the
     two recomputes the whole document once per paragraph. A chapter of several
     hundred is enough for that to show on a section load. */
  const prose: Element[] = []
  for (const el of body.querySelectorAll(PROSE)) {
    /* DIRECTION PER ELEMENT, from the same read as the alignment. Taken once off
       `body` it was wrong for any subtree that sets its own — a quoted passage
       in Hebrew inside an English chapter, which is the ordinary case in exactly
       the books that have one. Both come from one call, so they cannot describe
       different elements. */
    const { textAlign, direction } = read(el)
    if (alignsAsProse(textAlign, direction)) prose.push(el)
  }
  for (const el of prose) el.setAttribute('data-paper-prose', '')

  /* THE OPENING, LAST, and its one style read is deliberately after every write
   * above rather than folded into the loop: the loop's whole shape is "read all,
   * then write all", and a read placed inside it would recompute the document
   * once per paragraph. One read after the writes costs one recompute, which is
   * the same recompute the next layout would have done anyway.
   *
   * `bookCss` has named this function as the owner of the mark since WI-14.4 and
   * nothing set it, so the drop cap and the small caps were two settings that
   * moved a pip and left the page alone.
   *
   * NOT MARKED WHEN THE BOOK COMPOSES ITS OWN OPENING — see `InitialStyle`.
   * That is WI-14.4's before-tier rule ("a book that states a view goes on
   * winning") enforced at the only place the cascade leaves open. */
  /* AND IT HAS TO BE PROSE. `openingParagraph` answers a STRUCTURAL question —
     the first non-empty `<p>` outside the furniture — which is not the same as
     the typographic one the loop above just settled. A centred dedication, an
     epigraph or a chapter number is rejected as prose and was still the first
     paragraph, so it got Paper's drop cap: a sunk capital on a centred line,
     which is the one place it can never belong. */
  const isProse = new Set(prose)
  const opening = openingParagraph(body, (p) => isProse.has(p))
  if (opening && !composed(opening)) opening.setAttribute('data-paper-opening', '')
}
