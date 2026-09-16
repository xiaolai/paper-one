/**
 * The golden corpus for sentence extraction: every fixture, as plain data.
 *
 * **A schema of its own, and a driver of its own.** `corpus.ts` is word-snap
 * shaped — `strs`, `start: Edge`, `end: Edge`, `expected: SnappedRange | 'none'`
 * — and `scripts/word-snap-parity.mjs` inlines `classify.ts` and
 * `snapWordRange.ts` and calls `snapWordRange`. A sentence row fits neither, so
 * adding rows there would have meant widening one schema until it described two
 * unrelated questions badly.
 *
 * It exists for the same reason `corpus.ts` does. `Intl.Segmenter` is backed by
 * ICU and **Node and WebKit do not agree**; a macOS upgrade can move WebKit's
 * segmentation without anything in this repository changing, and a Node-only
 * green says nothing about the engine the app ships on.
 *
 * ## `sentence` is what a person would say; `actual` is what we return
 *
 * Two fields, and the pair is the whole design. If a row recorded only what the
 * implementation produced, the corpus would **bless** the shortfalls in ICU's
 * sentence breaking instead of measuring them — a green suite over a set of
 * transcripts, saying nothing about whether any of them is the sentence the
 * reader is looking at.
 *
 * So `sentence` is the full linguistic sentence, written by hand. `actual` is
 * what `sentenceOf` returns today. Where they differ the row is UNCOVERED, and
 * `sentenceCorpus.test.ts` pins how many uncovered rows there are — so coverage
 * can be improved deliberately and cannot silently fall.
 *
 * ## The constraints, and why they are not decoration
 *
 * - **Plain data, no expressions.** Rows are literals. Nothing here is
 *   computed, so what a reader sees is what both engines run.
 * - **No imports at all.** `scripts/sentence-parity.mjs` loads this file with
 *   nothing but Node's own TypeScript stripping — no vite, no bundler — and
 *   Node's ESM resolver does not add extensions. The schema is declared here
 *   rather than imported for exactly that reason.
 * - **`locale` on every row, never the host's.** A row whose answer depends on
 *   the machine running it cannot be compared across two engines, which is the
 *   only thing this file is for.
 * - **The term is located by OFFSET.** `Smith` and `two` occur more than once
 *   in some rows on purpose; a driver reaching for `indexOf` would pick the
 *   wrong one and the row would fail.
 * - **`actual` is a literal object or the literal `'none'`**, never `null` and
 *   never optional — `null` is indistinguishable from "nobody filled this in".
 */

/** What a row is there to cover. The required subset is asserted by
 *  `sentenceCorpus.test.ts`, not listed here: a requirement stored beside the
 *  data can be deleted in the same edit as the last row satisfying it. */
export type SentenceTag =
  | 'abbreviation'
  | 'cap'
  | 'cjk'
  | 'edge'
  | 'empty'
  | 'invisible'
  | 'japanese'
  | 'latin'
  | 'locale'
  | 'numeric'
  | 'quotation'
  | 'span'
  | 'whitespace'

/** What `sentenceOf` returned, or the literal `'none'` for "it declined". */
export type SentenceAnswer = { readonly sentence: string; readonly term: string } | 'none'

export interface SentenceCorpusRow {
  /** Stable and unique. It is what a divergence report names. */
  readonly id: string
  readonly tags: readonly SentenceTag[]
  /** The run as the DOM hands it over — RAW, before any squeeze. Segmenting
   *  this directly is the defect the ordering exists to prevent. */
  readonly raw: string
  readonly termStart: number
  readonly termEnd: number
  /** Always explicit. See the header. */
  readonly locale: string
  readonly maxSentenceChars: number
  /**
   * What lies across the run's start and end edges — `SentenceOptions.before`
   * and `.after` (phase 17, L8). ABSENT is a value here, not an omission: it is
   * "nothing is known across this edge", the budget-cut edge, and the two
   * `run-*-edge` rows are that case. `null` is "nothing lies across it".
   */
  readonly before?: string | null
  readonly after?: string | null
  /**
   * The completeness gate — `SentenceOptions.requireComplete`. ABSENT is the gate
   * ON, which is `sentenceOf`'s default and the walk's, and `false` is the
   * fallback walk, which answers where the gate declines. A row can therefore
   * change its answer with every other input standing still, which is why the
   * parity report carries it (2026-09-13 audit).
   */
  readonly requireComplete?: false
  /** The full linguistic sentence, written by hand — or the literal `'none'`
   *  when the row genuinely has no sentence to name, which an empty term does.
   *  Typed `string` because `string | 'none'` IS `string`: TypeScript absorbs
   *  the literal, so spelling it out read as a distinction nothing checked. */
  readonly sentence: string
  /** What the implementation returns today. Where this differs from
   *  `sentence`, the row is uncovered and says so. */
  readonly actual: SentenceAnswer
  /** Why this row is in the corpus — the thing that breaks if it is deleted. */
  readonly why: string
}

export const SENTENCE_CORPUS: readonly SentenceCorpusRow[] = [
  /* ── Abbreviations: what the segmenter does not do, and what we add ───── */
  {
    id: 'abbreviation-title',
    tags: ['latin', 'abbreviation'],
    raw: 'Alpha one. He met Mr. Smith today. Beta two.',
    termStart: 22,
    termEnd: 27,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'He met Mr. Smith today.',
    actual: { sentence: 'He met Mr. Smith today.', term: 'Smith' },
    why: 'ICU breaks after "Mr." — identical for en, en-US and en-GB. The bounded merge pass is what puts the title back with the name it belongs to',
  },
  {
    id: 'abbreviation-initial-chain',
    tags: ['latin', 'abbreviation'],
    raw: 'Alpha one. He met Mr. J. R. Smith today. Beta two.',
    termStart: 28,
    termEnd: 33,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'He met Mr. J. R. Smith today.',
    actual: { sentence: 'He met Mr. J. R. Smith today.', term: 'Smith' },
    why: 'a run of single capital initials produces a segment each; the merge has to chain rather than join one pair',
  },
  {
    id: 'abbreviation-closing-quote',
    tags: ['latin', 'quotation'],
    raw: 'Alpha one. He said, "Stop!" he said. Beta two.',
    termStart: 31,
    termEnd: 35,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'He said, "Stop!" he said.',
    actual: { sentence: 'He said, "Stop!" he said.', term: 'said' },
    why: 'ICU ends a sentence at the closing quote after "!" — UAX #29 keeps a lowercase continuation with the sentence before it only after a full stop (SB8) — so the attribution came back alone as "he said." The merge pass puts a quotation ending in "!" or "?" back with the lowercase words straight after it. Recorded as a shortfall until an audit showed that much is a bounded rule rather than a quotation model; the Japanese row is what that model would still be for',
  },
  {
    id: 'abbreviation-street-overshoot',
    tags: ['latin', 'abbreviation'],
    raw: 'Alpha one. He lived on Main St. Beta two here. Gamma three.',
    termStart: 32,
    termEnd: 36,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Beta two here.',
    actual: { sentence: 'He lived on Main St. Beta two here.', term: 'Beta' },
    why: 'UNCOVERED, and it is the COST of having "St" on the merge list: a street abbreviation genuinely can end a sentence, and here the merge welds two together. The list is closed and short because every entry buys this risk',
  },
  {
    id: 'decimal-point',
    tags: ['latin', 'numeric'],
    raw: 'Alpha one. It cost 3.14 dollars. Beta two.',
    termStart: 24,
    termEnd: 31,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'It cost 3.14 dollars.',
    actual: { sentence: 'It cost 3.14 dollars.', term: 'dollars' },
    why: 'a decimal point is handled by ICU itself and needs no merge — the row is here so a merge pass that grew greedy would show up as a change to it',
  },
  {
    id: 'abbreviation-eg',
    tags: ['latin', 'abbreviation'],
    raw: 'Alpha one. Use it, e.g. here. Beta two.',
    termStart: 24,
    termEnd: 28,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Use it, e.g. here.',
    actual: { sentence: 'Use it, e.g. here.', term: 'here' },
    why: 'ICU already keeps "e.g." inside its sentence, which is the evidence for NOT shipping a general abbreviation dictionary: most of what one would buy is already there',
  },

  /* ── The scripts the model was chosen for ─────────────────────────────── */
  {
    id: 'cjk-under-a-latin-locale',
    tags: ['cjk', 'locale'],
    raw: '第一句。他说。然后走了。最后一句。',
    termStart: 7,
    termEnd: 9,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: '然后走了。',
    actual: { sentence: '然后走了。', term: '然后' },
    why: 'the regex this replaces does not split Chinese AT ALL — its lookbehind lists the CJK terminators but the pattern still requires \\s+ after them, and Chinese puts no space after 。 The segmenter splits it even under an en locale, where the Latin merge pass is on',
  },
  {
    id: 'japanese-closing-quote',
    tags: ['japanese', 'quotation'],
    raw: '最初の文。彼は「止まれ！」と言った。次です。',
    termStart: 13,
    termEnd: 17,
    locale: 'ja',
    maxSentenceChars: 1000,
    sentence: '彼は「止まれ！」と言った。',
    actual: { sentence: 'と言った。', term: 'と言った' },
    why: 'UNCOVERED, and the same shape as the English closing-quote row in a script where the merge pass deliberately does not run: there is no letter case to tell the attribution "と言った" from a new sentence, so the rule that answers the English row has nothing to read here. Quoted speech loses its attribution',
  },

  /* ── Normalise before segment ─────────────────────────────────────────── */
  {
    id: 'source-line-feed',
    tags: ['latin', 'invisible'],
    raw: 'Alpha one. This is a long\nsentence in source. Beta two.',
    termStart: 26,
    termEnd: 34,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'This is a long sentence in source.',
    actual: { sentence: 'This is a long sentence in source.', term: 'sentence' },
    why: 'THE ORDERING ROW. WebKit renders that LF as a space and ICU reads it as a sentence boundary (UAX #29 SB4). Segmenting the raw run and squeezing the winner afterwards returns "sentence in source." — correctly punctuated, marked complete, and half a sentence',
  },
  {
    id: 'source-indentation',
    tags: ['latin', 'whitespace'],
    raw: '\n    Alpha one. Beta two. Gamma three.\n  ',
    termStart: 21,
    termEnd: 24,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Beta two.',
    actual: { sentence: 'Beta two.', term: 'two' },
    why: 'pretty-printed XHTML wraps a paragraph in indentation. It must not become a leading space that shifts every offset, nor a trailing one that makes the last segment look interior',
  },
  {
    id: 'soft-hyphen',
    tags: ['latin', 'invisible'],
    raw: 'Alpha one. The hy­phen­ation here. Beta two.',
    termStart: 15,
    termEnd: 28,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'The hyphenation here.',
    actual: { sentence: 'The hyphenation here.', term: 'hyphenation' },
    why: 'U+00AD is invisible and UAX #29 ignores it, so a snapped selection legitimately contains it — and it must reach neither the sentence nor the term, where it would be a character nobody can see inside the word being defined',
  },
  {
    id: 'no-break-space',
    tags: ['latin', 'whitespace'],
    raw: 'Alpha one. Beta two here. Gamma three.',
    termStart: 16,
    termEnd: 19,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Beta two here.',
    actual: { sentence: 'Beta two here.', term: 'two' },
    why: 'U+00A0 is whitespace to \\s and to the reader, and typesetting is full of it. Left raw it would reach the model as a character it has to guess about',
  },

  {
    id: 'lowercase-sentence-start',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. iPhone users noticed. Beta two.',
    termStart: 18,
    termEnd: 23,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'iPhone users noticed.',
    actual: 'none',
    why: 'UNCOVERED, and it is ICU\u2019s rule rather than ours: UAX #29 SB8 does not end a sentence after a full stop when the next word is LOWERCASE, so a sentence beginning "iPhone" is swallowed by the one before it. Measured — ICU returns TWO segments, "Alpha one. iPhone users noticed. " and "Beta two.": the first two sentences merged, not the whole run. It matters here because the merged segment then begins at the run\u2019s start, nothing is known across that edge, and the answer is the run-start refusal',
  },

  {
    id: 'sentence-final-initial',
    tags: ['latin', 'abbreviation'],
    raw: 'Alpha one. Choose option A. Then continue. Beta two.',
    termStart: 33,
    termEnd: 41,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Then continue.',
    actual: { sentence: 'Choose option A. Then continue.', term: 'continue' },
    why: 'UNCOVERED, and the second cost of the merge list — a lone capital CAN end a sentence ("Choose option A."), and the rule that puts "J." back with "R. Smith" welds this pair. Found by an audit rather than predicted, which is why it is written down here instead of being argued away',
  },

  /* ── The separators CSS does not collapse ─────────────────────────────── */
  {
    id: 'line-separator',
    tags: ['latin', 'invisible'],
    raw: 'Alpha one. Line one\u2028Line two. Beta two.',
    termStart: 25,
    termEnd: 28,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Line two.',
    actual: { sentence: 'Line two.', term: 'two' },
    why: 'U+2028 is \\s to JavaScript and is NOT in CSS\u2019s white space set, so it renders as a break the reader sees. Squeezing it to a space welded two rendered lines into one sentence; kept, it is UAX #29 Sep and ICU ends the sentence there. The mirror of `source-line-feed`, which must go the other way',
  },

  {
    id: 'paragraph-separator',
    tags: ['latin', 'invisible'],
    raw: 'Alpha one. Para one\u2029Para two. Beta two.',
    termStart: 25,
    termEnd: 28,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Para two.',
    actual: { sentence: 'Para two.', term: 'two' },
    why: 'the other half of the separator class. U+2029 behaves exactly as U+2028 does, which is why the pair is worth two rows rather than one: the guard is a character class, and a class that lost one member would keep passing the other row',
  },

  /* ── Completeness, and what it costs ──────────────────────────────────── */
  {
    id: 'run-start-edge',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 0,
    termEnd: 5,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Alpha one.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN. The sentence begins at the run’s edge and NOTHING IS KNOWN across it — the budget ended the window there — so the edge is no evidence of a sentence starting. `block-edge-start` is the same shape with the paragraph before it known, and answers',
  },
  {
    id: 'run-start-edge-ungated',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 0,
    termEnd: 5,
    locale: 'en',
    maxSentenceChars: 1000,
    requireComplete: false,
    sentence: 'Alpha one.',
    actual: { sentence: 'Alpha one.', term: 'Alpha' },
    why: '`run-start-edge` with the completeness gate off: the fallback walk, which answers where the gated walk declines. Every other input is the same, so this pair is what makes the gate an input the parity report must record; without the field the two rows would be one run with two answers',
  },
  {
    id: 'run-end-edge',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 16,
    termEnd: 19,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Beta two.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN, the other side of the same rule: nothing is known across the end edge. Until phase 17 this was EVERY paragraph’s last sentence, whatever followed it — see `block-edge-end`',
  },

  /* ── What lies across the edge (phase 17, L8) ─────────────────────────── */
  {
    id: 'block-edge-start',
    tags: ['latin', 'edge'],
    raw: 'Beta two. Gamma three.',
    termStart: 0,
    termEnd: 4,
    locale: 'en',
    maxSentenceChars: 1000,
    before: 'Alpha one.',
    sentence: 'Beta two.',
    actual: { sentence: 'Beta two.', term: 'Beta' },
    why: 'a paragraph’s first sentence. The run cannot vouch for its own start, but the paragraph before it is known, and read with it as flowing text the segmenter breaks exactly at the seam. Only the edge is confirmed from across it — nothing of `Alpha one.` is sent',
  },
  {
    id: 'block-edge-end',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 16,
    termEnd: 19,
    locale: 'en',
    maxSentenceChars: 1000,
    after: 'Gamma three.',
    sentence: 'Beta two.',
    actual: { sentence: 'Beta two.', term: 'two' },
    why: 'a paragraph’s last sentence, confirmed by the paragraph after it — the same run as `run-end-edge`, which knows nothing across the edge and declines',
  },
  {
    id: 'document-start',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 0,
    termEnd: 5,
    locale: 'en',
    maxSentenceChars: 1000,
    before: null,
    sentence: 'Alpha one.',
    actual: { sentence: 'Alpha one.', term: 'Alpha' },
    why: 'nothing lies across the edge — a section’s first paragraph, or the first under a heading. The segmenter is still asked, with a sentence that has ended standing in for the far side; `document-start-lowercase` is why it is asked rather than assumed',
  },
  {
    id: 'document-end',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Beta two.',
    termStart: 16,
    termEnd: 19,
    locale: 'en',
    maxSentenceChars: 1000,
    after: null,
    sentence: 'Beta two.',
    actual: { sentence: 'Beta two.', term: 'two' },
    why: 'a section’s last sentence: nothing follows it, and it ends in a full stop the segmenter would break after',
  },
  {
    id: 'block-edge-cjk',
    tags: ['cjk', 'edge'],
    raw: '然后走了。最后一句。',
    termStart: 0,
    termEnd: 2,
    locale: 'zh',
    maxSentenceChars: 1000,
    before: '他说。',
    sentence: '然后走了。',
    actual: { sentence: '然后走了。', term: '然后' },
    why: 'the seam rule in the script where the two engines are likeliest to disagree. The join puts a space after 。 that Chinese never writes, and the break must still fall at the seam rather than after the space',
  },
  {
    id: 'document-start-lowercase',
    tags: ['latin', 'edge'],
    raw: 'and so it ended. Beta two.',
    termStart: 7,
    termEnd: 9,
    locale: 'en',
    maxSentenceChars: 1000,
    before: null,
    sentence: 'none',
    actual: 'none',
    why: 'a section that opens in the middle of a sentence begun in the one before it — which a producer’s split can do. Nothing lies across the edge here either, and the sentence does not start at it: the probe asks, the segmenter does not break before a lowercase word, and there is no sentence in this run to name',
  },
  {
    id: 'document-end-unterminated',
    tags: ['latin', 'edge'],
    raw: 'Alpha one. Apples and pears',
    termStart: 22,
    termEnd: 27,
    locale: 'en',
    maxSentenceChars: 1000,
    after: null,
    sentence: 'none',
    actual: 'none',
    why: 'a list item or a caption at the end of a section: nothing follows, and nothing ends it either. It is a phrase, not a sentence, and the answer is the fallback rather than a fragment presented as whole',
  },
  {
    id: 'block-edge-weld',
    tags: ['latin', 'edge'],
    raw: 'Call me Ishmael. Some years ago.',
    termStart: 8,
    termEnd: 15,
    locale: 'en',
    maxSentenceChars: 1000,
    before: 'Chapter 1. Loomings',
    sentence: 'Call me Ishmael.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN. A heading with no full stop, spelled as a paragraph, runs into the sentence after it as flowing text: the segmenter finds no break at the seam, and a boundary it did not find is not one to vouch for. `sentenceAt` passes `null` for an h1–h6 or role="heading", which is what answers this in a book; `<p class="title">` is this row',
  },
  {
    id: 'block-edge-abbreviation',
    tags: ['latin', 'edge', 'abbreviation'],
    raw: 'Smith today. Beta two.',
    termStart: 0,
    termEnd: 5,
    locale: 'en',
    maxSentenceChars: 1000,
    before: 'He met Mr.',
    sentence: 'He met Mr. Smith today.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN. ICU alone breaks after "Mr." at the seam; the merge pass does not, and the seam is asked through the merge pass like every other boundary. So a title at the end of one block is not taken for the end of a sentence — and nothing from across an edge is ever sent, so the sentence cannot be had either',
  },
  {
    id: 'block-edge-continues',
    tags: ['latin', 'edge'],
    raw: 'store and bought milk. Beta two.',
    termStart: 0,
    termEnd: 5,
    locale: 'en',
    maxSentenceChars: 1000,
    before: 'He went to the',
    sentence: 'He went to the store and bought milk.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN. A sentence running ACROSS a block edge — a verse line, a paragraph a producer split at a page break. The kind of edge was never the question; the text on both sides is, and it does not break at the seam',
  },
  {
    id: 'spans-two-sentences',
    tags: ['latin', 'span'],
    raw: 'One here. Two there. Three everywhere. Four beyond.',
    termStart: 14,
    termEnd: 26,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'Two there. Three everywhere.',
    actual: { sentence: 'Two there. Three everywhere.', term: 'there. Three' },
    why: 'the selection itself contains a terminator, so it belongs to two segments — taking only the first would send half of what the reader chose and define a term the sentence does not hold',
  },
  {
    id: 'longer-than-a-sentence',
    tags: ['latin', 'cap'],
    raw: 'Alpha one. Beta two is a longer middle sentence. Gamma three.',
    termStart: 25,
    termEnd: 31,
    locale: 'en',
    maxSentenceChars: 10,
    sentence: 'Beta two is a longer middle sentence.',
    actual: 'none',
    why: 'UNCOVERED BY DESIGN — the cap, exercised at a length a row can carry. Past it the span is a run with no terminators in it rather than a sentence, and §C3 forbids sending a partial one — so it is a fallback, never a truncation',
  },

  {
    id: 'cap-counts-the-trimmed-sentence',
    tags: ['latin', 'cap'],
    raw: 'Alpha one. Beta two. Gamma three.',
    termStart: 16,
    termEnd: 19,
    locale: 'en',
    maxSentenceChars: 9,
    sentence: 'Beta two.',
    actual: { sentence: 'Beta two.', term: 'two' },
    why: 'the cap measures what is SENT. A segment carries the whitespace separating it from the next one, so `Beta two.` occupies ten characters of the run and nine of the prompt; capping the span refused a sentence for a character the model never sees',
  },

  /* ── The locale gate ──────────────────────────────────────────────────── */
  {
    id: 'latin-abbreviation-in-han-under-en',
    tags: ['locale', 'abbreviation', 'cjk'],
    raw: '第一句。他说 Mr. Smith 来了。最后一句。',
    termStart: 11,
    termEnd: 16,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: '他说 Mr. Smith 来了。',
    actual: { sentence: '他说 Mr. Smith 来了。', term: 'Smith' },
    why: 'the merge pass is gated on the LOCALE’s script, so the same run answers differently under en and zh. This row and the next are a pair; either alone would let the gate be deleted',
  },
  {
    id: 'latin-abbreviation-in-han-under-zh',
    tags: ['locale', 'abbreviation', 'cjk'],
    raw: '第一句。他说 Mr. Smith 来了。最后一句。',
    termStart: 11,
    termEnd: 16,
    locale: 'zh',
    maxSentenceChars: 1000,
    sentence: '他说 Mr. Smith 来了。',
    actual: { sentence: 'Smith 来了。', term: 'Smith' },
    why: 'UNCOVERED. A Latin abbreviation embedded in Han text is exactly what the locale gate cannot see, because the gate asks about the locale and not about the run. Deciding per script RUN is a second feature; this row is the honest record that it is not done',
  },

  {
    id: 'unknown-language',
    tags: ['locale', 'abbreviation'],
    raw: 'Alpha one. He met Mr. Smith today. Beta two.',
    termStart: 22,
    termEnd: 27,
    locale: 'und',
    maxSentenceChars: 1000,
    sentence: 'He met Mr. Smith today.',
    actual: { sentence: 'Smith today.', term: 'Smith' },
    why: 'UNCOVERED BY DESIGN, and the cost of failing closed. `und` MEANS "no language", and `new Intl.Locale(\u2019und\u2019).maximize().script` is `Latn` \u2014 so a book saying it does not know what it is would have got the Latin merge. It is refused instead, and the price is this row',
  },

  /* ── Nothing to answer about ──────────────────────────────────────────── */
  {
    id: 'term-of-whitespace-only',
    tags: ['whitespace', 'empty'],
    raw: 'Alpha one.    Beta two. Gamma three.',
    termStart: 11,
    termEnd: 13,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'none',
    actual: 'none',
    why: 'the term lands inside whitespace that collapses to nothing. Relocating it to the next word would define a word the reader did not select, so it declines',
  },
  {
    id: 'run-of-whitespace-only',
    tags: ['whitespace', 'empty'],
    raw: '   ',
    termStart: 0,
    termEnd: 1,
    locale: 'en',
    maxSentenceChars: 1000,
    sentence: 'none',
    actual: 'none',
    why: 'an empty run must not segment to one empty sentence and be reported as an answer — the same fail-closed reason a zero-row corpus is a failure and not a clean sweep',
  },
]
