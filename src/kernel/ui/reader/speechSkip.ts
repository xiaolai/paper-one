/**
 * What the voice must not say, and whether leaving it out leaves a gap.
 *
 * `collectText` already drops what is not on the page — `hidden`, `aria-hidden`,
 * and the three CSS ways of hiding something. This is the other half: text that
 * IS on the page, that a reader's eye skips without noticing, and that a voice
 * reads out in the middle of a sentence.
 *
 * ## The vocabulary is the format's, not ours
 *
 * EPUB Media Overlays defines SKIPPABILITY for exactly this, and names the
 * structures: `sidebar`, `practice`, `marginalia`, `annotation`, `help`, `note`,
 * `footnote`, `rearnote`, `table`, `table-row`, `table-cell`, `list`,
 * `list-item`, `pagebreak`. It comes from DAISY's talking books, where the
 * problem was met first. Reading those through `epub:type` and the DPUB-ARIA
 * roles beside them is what a reading system is supposed to do, and it is why
 * this file has no tag-name heuristics in it — `sentenceAt.ts` already records
 * that a note reference is `epub:type~="noteref"` or `role="doc-noteref"` and
 * **never `<sup>` by tag**, because `<sup>` is also how a book writes x².
 *
 * ⚠️ **BUT SKIPPABILITY IS A PREFERENCE, AND MOST OF THAT LIST IS NOT OURS TO
 * DECIDE.** The spec's point is that a reading system OFFERS the choice — a
 * listener may want sidebars and not footnotes. Tables and lists are on it
 * because a listener may want to escape a long one, not because reading a list
 * aloud is wrong; skipping them by default would silently drop content the book
 * meant to be read. So this file skips only what is never speech in any
 * reading, and the preference-controlled set waits for the Settings surface
 * that would govern it — which is also this repository's rule about growing a
 * surface in the change that mounts it.
 *
 * ## Two kinds of removal, because one of them fuses words
 *
 * ⚠️ **TAKING A NOTE REFERENCE OUT WITHOUT LEAVING A GAP CLOSES THE SENTENCE UP
 * AGAINST THE NEXT ONE.** `sentenceAt.ts` records the shape:
 * `He left.<a epub:type="noteref"> 1 </a>Then she stayed.` — remove the marker
 * silently and the text reads `He left.Then she stayed.`, which is one token to
 * a segmenter and one word to a voice.
 *
 * ⚠️ **AND LEAVING A GAP WHERE A RUBY ANNOTATION WAS SPLITS A WORD.**
 * `<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>` must come out as `漢字`, not
 * `漢 字` — the annotation sits INSIDE the word it annotates, and a space there
 * is a word boundary that the text does not have.
 *
 * So the answer is three-valued rather than a boolean.
 */

import { ariaRoles, epubTypes } from './epubSemantics'

export type SpeechSkip =
  /** Say it. */
  | 'read'
  /** Leave it out, and leave nothing in its place — it sat inside a word. */
  | 'silent'
  /** Leave it out, and leave a separator — it sat between words. */
  | 'gap'

/**
 * Ruby ANNOTATIONS, which are the pronunciation and not the text.
 *
 * ⚠️ **THIS IS THE ONE THAT MATTERS MOST FOR A CHINESE OR JAPANESE BOOK, AND IT
 * IS IN NO EPUB LIST** — it is an HTML matter, so the format's skippability
 * vocabulary never mentions it. Read as written, `<ruby>漢字<rt>かんじ</rt></ruby>`
 * is spoken `漢字かんじ`: every annotated word said once and then spelled out.
 * A book with pinyin or furigana throughout is unlistenable.
 *
 * `<rp>` is the parenthesis a browser without ruby support shows instead. A
 * browser WITH support hides it, so it is usually caught as hidden already —
 * but that depends on the reader's stylesheet, and this does not.
 */
const RUBY_ANNOTATION = new Set(['rt', 'rp'])

/**
 * Structures that are never part of the reading, by `epub:type`.
 *
 * Each is here because saying it aloud is wrong in EVERY reading, not because a
 * listener might prefer to leave it out:
 *
 * - `pagebreak` — a PRINT page number, injected mid-sentence for citation. The
 *   voice says "two hundred and forty-seven" between two clauses.
 * - `noteref` — the marker, not the note: a bare `3` in the middle of a
 *   sentence, which tells a listener nothing and breaks the sentence in two.
 * - `footnote`, `endnote`, `rearnote`, `note` — the note's BODY. Usually hidden
 *   and already dropped; a print-style note block at the foot of a section is
 *   not, and arrives as a run of citations mid-chapter with nothing to say it
 *   has happened. `collectText`'s own comment describes meeting this.
 * - `toc`, `landmarks`, `page-list` — the book's own navigation. A table of
 *   contents read aloud is a list of every chapter title in the book.
 */
const NEVER_SPOKEN_TYPES = new Set([
  'pagebreak',
  'noteref',
  'footnote',
  'endnote',
  'rearnote',
  'note',
  'toc',
  'landmarks',
  'page-list',
])

/** The DPUB-ARIA roles for the same structures — see `epubSemantics`. */
const NEVER_SPOKEN_ROLES = new Set([
  'doc-pagebreak',
  'doc-noteref',
  'doc-footnote',
  'doc-endnote',
  'doc-toc',
])

/**
 * Whether text inside `el` is spoken, and what it leaves behind if not.
 *
 * Walks ANCESTORS, because the semantics sit on the container — the note is an
 * `<aside epub:type="footnote">` and the text is in a `<p>` inside it — and
 * because the same walk answers for a text node at any depth.
 *
 * ⚠️ **IT DOES NOT CONSULT COMPUTED STYLE, DELIBERATELY, AND THAT IS WHAT MAKES
 * IT WORK FOR THE AUDIOBOOK.** `collectText` skips the style half of its filter
 * when a document has no browsing context, which is exactly the case for the
 * export: `section.createDocument()` gives a document whose `defaultView` is
 * null, so CSS-hidden endnotes are NOT dropped there and go into the file. These
 * rules are attributes and tag names, so they hold in both documents — the
 * export gets the same reading the reader hears.
 */
export function speechSkip(el: Element | null): SpeechSkip {
  for (let node = el; node; node = node.parentElement) {
    if (RUBY_ANNOTATION.has(node.tagName.toLowerCase())) return 'silent'

    for (const type of epubTypes(node)) {
      if (NEVER_SPOKEN_TYPES.has(type)) return 'gap'
    }
    for (const role of ariaRoles(node)) {
      if (NEVER_SPOKEN_ROLES.has(role)) return 'gap'
    }
  }
  return 'read'
}
