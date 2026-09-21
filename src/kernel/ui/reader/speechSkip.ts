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
 *
 * ⚠️ **AND THIS IS NOT A PREFERENCE, UNLIKE `NOTE_BODIES` BELOW — THE MARKUP
 * CANNOT SAY WHICH KIND OF RUBY IT IS.** An audit asked for the choice, on the
 * ground that W3C calls ruby TTS strategy context-dependent and that annotation
 * can carry meaning the base text does not: semantic ruby, a gloss, a
 * heteronym's reading. All true, and none of it decidable here. `<rt>` is one
 * element for two unrelated jobs — the pronunciation of the base text (pinyin,
 * furigana), and a separate gloss beside it — and HTML gives no attribute that
 * distinguishes them. There is no `rt` a reading system can look at and say
 * which it is.
 *
 * So the choice a preference would offer is not "phonetic or semantic" but "say
 * every annotated word twice, or once", and reading a pinyin book twice over is
 * not a setting anybody wants. A note body is different in exactly the way that
 * matters: `epub:type="footnote"` SAYS what it is, so the reader's choice can be
 * honoured precisely. Where the markup cannot express the distinction, a switch
 * is a worse answer than the better default.
 *
 * What would change this is markup that carries the distinction — `rt` with a
 * declared role, or Media Overlays marking the annotation — and then it belongs
 * with `NOTE_BODIES` and not here.
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
const NEVER_SPOKEN: readonly { readonly type: string; readonly role: string | null }[] = [
  /* A PRINT page number, injected mid-sentence for citation. The voice says
     "two hundred and forty-seven" between two clauses. */
  { type: 'pagebreak', role: 'doc-pagebreak' },
  /* The marker, not the note: a bare `3` in the middle of a sentence, which
     tells a listener nothing and breaks the sentence in two. */
  { type: 'noteref', role: 'doc-noteref' },
  /* The book's own navigation. A table of contents read aloud is a list of
     every chapter title in the book. */
  { type: 'toc', role: 'doc-toc' },
  { type: 'landmarks', role: null },
  { type: 'page-list', role: 'doc-pagelist' },
]

/**
 * A note's BODY — content, and therefore the reader's call.
 *
 * ⚠️ **THESE SAT IN `NEVER_SPOKEN` AND THEY ARE NOT NEVER-SPEECH.** The header
 * above states the rule this file is built on — only what is never speech in any
 * reading is dropped outright — and then the table broke it for four entries. A
 * footnote body is the author's prose. Dropping it silently is a reading of the
 * book with words missing and nothing to say so, which is the one failure
 * direction `effectiveRole` is explicitly written to avoid.
 *
 * The other five above genuinely are never speech: a print page number, a bare
 * note marker, and the book's own navigation lists have no reading in which they
 * belong. That is the line, and it now runs between two tables rather than
 * inside one.
 *
 * ⚠️ **AND THE DEFAULT IS STILL TO SKIP THEM, WHICH IS A DEVIATION FROM WHAT THE
 * AUDIT ASKED FOR AND IS DELIBERATE.** The audit wanted meaningful content to
 * default to `read`. For a note body that is the worse default: most are already
 * hidden and never reach here, and the ones that do are a print-style block at
 * the foot of a section — so turning them on by default means a run of
 * citations arriving mid-chapter, unannounced, in the middle of the prose. What
 * was wrong was that a listener could not CHOOSE; the choice now exists, and its
 * default is the quieter of the two.
 */
const NOTE_BODIES: readonly { readonly type: string; readonly role: string | null }[] = [
  { type: 'footnote', role: 'doc-footnote' },
  { type: 'endnote', role: 'doc-endnote' },
  { type: 'rearnote', role: null },
  { type: 'note', role: null },
]

/**
 * ⚠️ **ONE TABLE, BECAUSE TWO LISTS HAD ALREADY DRIFTED.** `page-list` was
 * suppressed and its DPUB-ARIA equivalent `doc-pagelist` was not, so two books
 * marking up the same structure the two permitted ways behaved differently — and
 * nothing could notice, because each list looked complete on its own. The sets
 * are derived from the pairs now, so an entry cannot exist in one spelling only.
 *
 * `role: null` is a deliberate value rather than an omission: `rearnote`,
 * `note` and `landmarks` have no DPUB-ARIA role at all, and writing that down is
 * what stops the next reader "fixing" the asymmetry by inventing one.
 */
const typesOf = (table: readonly { readonly type: string }[]): ReadonlySet<string> =>
  new Set(table.map((one) => one.type))
const rolesOf = (table: readonly { readonly role: string | null }[]): ReadonlySet<string> =>
  new Set(table.flatMap((one) => (one.role === null ? [] : [one.role])))

const NEVER_SPOKEN_TYPES = typesOf(NEVER_SPOKEN)
const NEVER_SPOKEN_ROLES = rolesOf(NEVER_SPOKEN)
const NOTE_BODY_TYPES = typesOf(NOTE_BODIES)
const NOTE_BODY_ROLES = rolesOf(NOTE_BODIES)

/**
 * What a listener has chosen to hear, for the parts that are theirs to choose.
 *
 * ONE FIELD, because one entry in the skippability vocabulary is content this
 * app currently suppresses. EPUB Media Overlays names a dozen more — `sidebar`,
 * `marginalia`, `table`, `list` — and none of those is suppressed here at all,
 * so there is nothing for a preference to govern yet. A field per spec entry
 * would be twelve switches over one behaviour.
 */
export interface SpeechSkipPrefs {
  /** Read a footnote or endnote BODY where the book leaves one on the page. */
  readonly notes: boolean
}

/**
 * What a reading does when nobody has said otherwise.
 *
 * Exported so the default is one value rather than a literal repeated at each
 * caller — `collectText` takes it, the export path takes it, and a test that
 * does not care about notes says nothing.
 */
export const DEFAULT_SPEECH_SKIP: SpeechSkipPrefs = { notes: false }

/**
 * The role that actually applies, out of a token list.
 *
 * ⚠️ **ARIA TAKES THE FIRST ROLE, NOT ANY OF THEM**, and this used to test every
 * token — so `role="button doc-noteref"` was suppressed although the element is a
 * BUTTON whose fallback happens to be a note reference. Fallback roles exist so
 * an author can name a specific role and a generic one behind it; reading the
 * list as a set inverts that.
 *
 * The first token is taken as effective. That is an approximation of the spec's
 * "first RECOGNISED non-abstract role" — this module has no list of every ARIA
 * role to recognise against — and it errs toward READING: an unrecognised first
 * token means nothing here matches, so the text is spoken. Failing toward
 * speaking content is the safe direction; failing toward silence loses a book's
 * words with no way for a listener to know.
 */
function effectiveRole(el: Element): string | null {
  for (const role of ariaRoles(el)) return role
  return null
}

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
export function speechSkip(el: Element | null, prefs: SpeechSkipPrefs = DEFAULT_SPEECH_SKIP): SpeechSkip {
  for (let node = el; node; node = node.parentElement) {
    if (RUBY_ANNOTATION.has(node.tagName.toLowerCase())) return 'silent'

    for (const type of epubTypes(node)) {
      if (NEVER_SPOKEN_TYPES.has(type)) return 'gap'
      if (!prefs.notes && NOTE_BODY_TYPES.has(type)) return 'gap'
    }
    const role = effectiveRole(node)
    if (role !== null) {
      if (NEVER_SPOKEN_ROLES.has(role)) return 'gap'
      if (!prefs.notes && NOTE_BODY_ROLES.has(role)) return 'gap'
    }
  }
  return 'read'
}
