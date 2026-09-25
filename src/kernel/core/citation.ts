/**
 * A passage, written out so it can be pasted somewhere that is not Paper.
 *
 * PURE, and that is the point: what a citation should say is a set of small
 * decisions about missing fields — a book with no author, a PDF with no
 * outline, a quote that already has quotation marks around it — and every one
 * of them is a case that can be written down and checked without opening a
 * book. The reader half is `SelectionTools`, which knows only that it has a
 * string to put on the clipboard.
 *
 * §15's lexicon: the marked words are a QUOTE, and what follows them is the
 * ATTRIBUTION. Neither is a "note", which is the written annotation.
 */

/** Where a passage came from, as far as the reader can be told. */
export interface Source {
  /** The book's title. Empty when it declares none. */
  readonly title: string
  /** The author, as the book declares them. Empty when it declares none. */
  readonly author: string
  /** The table-of-contents entry the passage sits under. Empty when there is none. */
  readonly chapter: string
  /**
   * The page the passage is on, for a book that has pages, or 0.
   *
   * A reflowed page is a property of the window it is being shown in, and a
   * number derived from one reader's font size is a citation nobody else can
   * follow. So this is never counted from the layout. A PDF has real pages
   * and `makePdf` builds one section per page, which is where this comes from
   * for that format.
   *
   * ⚠️ **AND THIS COMMENT USED TO END "SO THIS IS 0 FOR AN EPUB", WHICH WAS
   * WRONG.** It argued from the reflowed page to the conclusion that an EPUB
   * has no page at all, and an EPUB may carry the PRINT edition's own
   * pagination — a `page-list` nav, which is exactly the stable, cross-copy
   * locator the argument says cannot exist. See `printPage`, which is where
   * that arrives, and which 10 of 150 books on this shelf have.
   */
  readonly page: number
  /**
   * The PRINT edition's page, as the book spells it, or empty.
   *
   * REQUIRED, with no default, and that is deliberate. An optional field is
   * how a value arrives that nothing ever fills — this repository has now
   * shipped that three times (`paper/share-notes/1` with no client,
   * `books_in_index` with no caller, `PassageHit.offset` with no reader), and
   * the third was found last week. Required means the compiler names every
   * call site.
   *
   * A STRING, because a page is what the publisher printed: `xiv`, `A-3` and
   * `212` are all real, and parsing them to a number would lose two of the
   * three.
   */
  readonly printPage: string
  /**
   * How far through the book, 0…1.
   *
   * The locator of last resort, and it is a poor one — "31%" is a fact about
   * this file rather than about the work. It is here because the alternative
   * for a PDF with no outline and no pages is an attribution that names a book
   * and nothing else, and a reader pasting a quote into their notes has no way
   * back to it at all.
   */
  readonly fraction: number
}

/**
 * The typographic quotation marks the app sets prose in.
 *
 * Curly, matching §14's text, not the typewriter pair — a quote pasted into a
 * document should look like it was typed by someone rather than by a program.
 */
const OPEN = '“'
const CLOSE = '”'

/** Any mark a passage might already open with, straight or curly, double or single. */
const ALREADY_QUOTED = /^["'‘“]/

/**
 * The quote, as one clean run of text.
 *
 * LINE BREAKS ARE COLLAPSED. A selection that crosses a line in the book
 * carries the source's own wrapping, which has nothing to do with the width of
 * wherever it is being pasted. Collapsed, the quote re-wraps to its new home.
 *
 * A PASSAGE THAT IS ALREADY QUOTED IS LEFT ALONE — not stripped and re-wrapped,
 * which is the obvious move and is wrong on the commonest case there is.
 * Selecting a line of dialogue gives `“Call me Ishmael,” he said.`: strip the
 * outer marks and the dialogue loses its opening quote while keeping its
 * closing one, and wrap it without stripping and it comes out `““Call me
 * Ishmael,” he said.”`. Both read as a transcription error. Leaving the book's
 * own punctuation exactly as the book set it is the only reading that is right
 * for a passage that opens with dialogue, for one that IS a whole quotation,
 * and for a book that uses single marks throughout.
 */
function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  return ALREADY_QUOTED.test(clean) ? clean : `${OPEN}${clean}${CLOSE}`
}

/**
 * Where in the book, in the most specific terms the book supports.
 *
 * PRINT PAGE, THEN PAGE, THEN CHAPTER, THEN PROPORTION — most useful first,
 * and each one only when the format actually has it.
 *
 * The print page leads because it is the best locator there is: it names a
 * place in the PAPER edition, so it is exact for a reader holding the
 * hardback, the paperback or this file. A PDF's page is exact for anyone
 * holding the same PDF; a chapter is exact for anyone holding any copy of the
 * work; a percentage is none of those, and is offered only when there is
 * nothing else to say.
 */
function locator(source: Source): string {
  if (source.printPage.trim() !== '') return `p. ${source.printPage.trim()}`
  if (source.page > 0) return `p. ${source.page}`
  if (source.chapter.trim() !== '') return source.chapter.trim()
  const percent = Math.round(clamp(source.fraction) * 100)
  return percent > 0 ? `${percent}%` : ''
}

function clamp(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  return Math.max(0, Math.min(1, fraction))
}

/**
 * The attribution line, or empty when there is nothing to attribute to.
 *
 * EMPTY RATHER THAN A DANGLING DASH. A book with no title, no author, no
 * outline and no position produces no parts at all, and an em dash on its own
 * line under a quote looks like the app lost the source — which is worse than
 * not offering one, because it invites the reader to go looking for it.
 */
function attribution(source: Source): string {
  const parts = [source.author.trim(), source.title.trim(), locator(source)].filter(
    (part) => part !== '',
  )
  return parts.length === 0 ? '' : `— ${parts.join(', ')}`
}

/**
 * A quote with its attribution, ready for the clipboard.
 *
 * Blank line between the two, so it survives being pasted into an editor that
 * treats a single newline as a soft wrap and a blank line as a paragraph
 * break — which is most of them, and all the markdown ones. Without it the
 * attribution joins the end of the quote as if it were part of the sentence.
 */
export function citation(text: string, source: Source): string {
  const body = quote(text)
  const credit = attribution(source)
  if (body === '') return credit
  if (credit === '') return body
  return `${body}\n\n${credit}`
}
