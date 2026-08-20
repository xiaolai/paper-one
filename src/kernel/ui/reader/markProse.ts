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

/** What the walk needs to know about one element. */
export interface ProseStyle {
  readonly textAlign: string
  readonly direction: string
}

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
export function markProse(doc: Document, readStyle?: StyleReader): void {
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
}
