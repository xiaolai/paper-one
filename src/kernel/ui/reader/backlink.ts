/**
 * A link OUT of a note, told apart from a link INTO one.
 *
 * The note popover exists for the second kind. Handed the first it produces a
 * box containing the reference marker and nothing else — measured at 22px tall
 * against *What's Our Problem?*, holding a single green asterisk — which is
 * what a reader sees as "an empty popup", and which also takes away the one
 * thing a backlink is for: getting back to where the note was called from.
 *
 * WHY FOLIATE DOES NOT CATCH THIS. `isFootnoteReference` has two branches, and
 * only the weaker one excludes backlinks:
 *
 * ```js
 * yes:   refRoles.some(...) || refTypes.some(...)                  // no test
 * maybe: () => !types.has('backlink') && !roles.has('doc-backlink') // tested
 * ```
 *
 * So a backlink carrying `epub:type="noteref"` goes down the `yes` path
 * unexamined. That is not a rare miscoding — it is what the book above ships,
 * on every footnote it has:
 *
 * ```html
 * <p>…between 200,000 and 300,000 years<a epub:type="noteref"
 *      href="#footnote-ref-1" id="footnote-1"><span class="fn">*</span></a></p>
 * …
 * <aside epub:type="footnote" id="footnote-ref-1">
 *   <p><a epub:type="noteref" href="#footnote-1">*</a> A.D. is over 2,000…</p>
 * </aside>
 * ```
 *
 * Both anchors say `noteref`. Only the first one is one.
 *
 * THREE TESTS, WIDEST LAST. Each catches books the one before it misses, and
 * every one of them is a way of asking the same question — does this link go
 * to the note, or back from it?
 */

/**
 * ⚠️ **BOTH SPELLINGS OF `epub:type`, and this file used to read only one.**
 *
 * `getAttributeNS(OPS, 'type')` is right for a section foliate parsed as XML
 * and returns `null` for the same markup in one it had to reparse as
 * `text/html` — where the attribute keeps its literal name in the null
 * namespace. Invalid XHTML is precisely what sends a book down the HTML path,
 * so the books most likely to need these semantics were the ones where every
 * question here answered "no attribute".
 *
 * **The tests did not catch it and could not**: `backlink.test.ts`'s helper
 * parses as `application/xhtml+xml`, and its own header explains why — an HTML
 * document drops the prefix. So the fixture only ever produced the one shape
 * the reader could see, and the file's first case asserts the fixture's
 * namespace precisely because the whole suite is worthless without it.
 *
 * `epubSemantics.ts` reads both, in one place, so the next caller does not have
 * to remember. Recorded as a finding in `dev-docs/plans/phase-16-the-sentence.md`
 * §B2, where the same trap was met from the other side.
 */
import { ariaRoles, epubTypes } from './epubSemantics'

const typesOf = (el: Element): Set<string> => epubTypes(el)
const rolesOf = (el: Element): Set<string> => ariaRoles(el)

/**
 * Containers whose contents ARE the note.
 *
 * Both vocabularies, because books use either and some use neither
 * consistently: `epub:type` is the EPUB 3 semantic, `role` the ARIA DPUB one.
 * The plurals (`endnotes`, `footnotes`) are the section that holds all of
 * them, which is where an endnote's backlink lives.
 */
const NOTE_TYPES = new Set([
  'footnote',
  'footnotes',
  'endnote',
  'endnotes',
  'rearnote',
  'rearnotes',
  'note',
  'biblioentry',
  'bibliography',
  'glossary',
  'glossdef',
])
const NOTE_ROLES = new Set([
  'doc-footnote',
  'doc-endnote',
  'doc-biblioentry',
  'doc-bibliography',
  'doc-glossary',
  'definition',
  'note',
])

/**
 * Is this anchor inside something the book calls a note?
 *
 * BY WALKING, NOT BY `closest`. A CSS selector cannot match a NAMESPACED
 * attribute without an `@namespace` rule, which `querySelector` has nowhere to
 * take one from — `[epub|type~="footnote"]` throws as an invalid selector
 * there. The walk reads the attribute directly and has no such problem.
 *
 * A note that cites ANOTHER note is caught by this and navigates instead of
 * opening a second popover. That is the right way to be wrong: the reader ends
 * up at the note they asked for, with `⌘[` to come back, rather than at a
 * popover over a popover.
 */
function insideNote(a: Element): boolean {
  for (let el = a.parentElement; el; el = el.parentElement) {
    const types = typesOf(el)
    for (const type of types) if (NOTE_TYPES.has(type)) return true
    const roles = rolesOf(el)
    for (const role of roles) if (NOTE_ROLES.has(role)) return true
  }
  return false
}

/**
 * Does this link point AT A REFERENCE, rather than at a note?
 *
 * The general rule, and the one that needs no cooperation from the book: a
 * forward reference points at the note's CONTENT — an `aside`, an `li`, a
 * `section`, a `p` — while a backlink points at the reference anchor, because
 * that is the element the reference had to put an `id` on to be returnable to.
 * **A link that lands on another link is one half of a pair, and it is the
 * second half.**
 *
 * SAME DOCUMENT ONLY. A cross-document backlink — the usual shape for endnotes
 * gathered in their own file — cannot be resolved from here without loading
 * that file, and the two tests above already cover the labelled ones.
 */
function pointsAtAReference(a: Element): boolean {
  const href = a.getAttribute('href')
  if (!href?.startsWith('#')) return false
  let id: string
  try {
    id = decodeURIComponent(href.slice(1))
  } catch {
    /* A malformed escape is not a backlink; it is a broken href, and the note
       handler will fail to resolve it on its own terms. */
    return false
  }
  if (!id) return false
  const target = a.ownerDocument?.getElementById(id) ?? null
  return target !== null && target !== a && target.matches('a[href]')
}

/**
 * True when this link leads out of a note rather than into one.
 *
 * The caller declines to offer it to the footnote handler, which leaves
 * foliate to navigate exactly as it does for any other link — so the reader
 * arrives at the reference, and the jump stack records where they came from.
 */
export function isBacklink(a: Element): boolean {
  if (typesOf(a).has('backlink')) return true
  if (rolesOf(a).has('doc-backlink')) return true
  if (insideNote(a)) return true
  return pointsAtAReference(a)
}

/**
 * The note as text, for the clipboard.
 *
 * BLOCK BY BLOCK, so a note carrying a quotation or a second paragraph does not
 * paste as one run-on line. Within a block the whitespace is collapsed: the
 * source is indented XHTML and that indentation belongs to the file, not to the
 * author.
 *
 * THE LEADING MARKER IS LEFT IN. A note begins with the mark that ties it to
 * the page — `*`, `†`, a numeral — and it is tempting to strip it as furniture.
 * There is no rule here that would do it honestly: inside the popover the note
 * has been cut away from its reference, so the marker's anchor points at an id
 * that is no longer in this document, and `isBacklink` cannot see what it is.
 * Everything else on offer is a guess about length or position. One asterisk
 * the reader can delete beats a heuristic that some day eats a real word.
 */
export function noteText(body: Element): string {
  const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()
  const blocks = [...body.children].map((child) => collapse(child.textContent ?? ''))
  const lines = blocks.filter((line) => line.length > 0)
  return lines.length > 0 ? lines.join('\n') : collapse(body.textContent ?? '')
}
