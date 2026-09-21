/**
 * The sentence a term sits in, taken out of the run of text around it.
 *
 * The pure half of §16. It touches no `document`, no `Range` and no `Node`;
 * everything it needs is the run's text and two offsets into it — the same
 * split `snapWordRange` and `flatten` already make, and for the same two
 * reasons: the whole policy is testable in a lane with no DOM, and
 * `scripts/sentence-parity.mjs` can inline this one file to run the corpus
 * inside the webview where the ICU is not Node's.
 *
 * ## Normalise, then segment — and the order is the whole point
 *
 * `flatten` preserves raw DOM text, deliberately (`rangeText.test.ts` pins
 * it), so ordinary pretty-printed XHTML carries a source LF **inside** a
 * paragraph. WebKit renders that LF as a space. **ICU reads it as a sentence
 * boundary** — UAX #29 SB4. Measured on Node 24.18 / ICU 78:
 *
 *     "This is a long\nsentence in source."
 *       → ["This is a long\n", "sentence in source."]
 *
 * Segmenting the raw run and squeezing the winner afterwards therefore hands
 * the model **the source line containing the term, correctly punctuated, and
 * looking complete** — the exact silent wrongness this phase exists to remove,
 * reintroduced by the phase itself. So this squeezes first, carrying the term's
 * offsets through the squeeze, and segments what is left.
 *
 * Nothing maps back to the DOM. Only the sentence's *text* is sent, and the
 * term's position is needed only to choose a segment.
 *
 * ## `Intl.Segmenter` does not solve abbreviations
 *
 * Measured, identical for `en`, `en-US` and `en-GB`:
 *
 *     "Mr. Smith went home. Next."       → ["Mr. ", "Smith went home. ", "Next."]
 *     "He said, \"Stop!\" he said. Next." → ["He said, \"Stop!\" ", "he said. ", "Next."]
 *     "It cost 3.14 dollars. Next."      → ["It cost 3.14 dollars. ", "Next."]     ✓
 *     "Use it, e.g. here. Next."         → ["Use it, e.g. here. ", "Next."]        ✓
 *     "他说。然后走了。"                    → ["他说。", "然后走了。"]                  ✓
 *
 * Decimals and `e.g.` are handled; titles and closing quotes are not. It is
 * still the right tool, and the honest framing is not the flattering one: the
 * regex it replaces splits `Mr. Smith` too, **and** `'He met Mr. '.split(…).pop()`
 * is `''` — the whole prefix lost — **and** it does not split Chinese at all,
 * because its `\s+` never matches after `。`. So: the segmenter, plus one
 * bounded merge pass — for titles, for single capital initials, and for a
 * quotation ending in `!` or `?` that runs straight on in lower case — gated to
 * Latin script: the declared language's, or with none declared the text's own,
 * and never the machine's. No general abbreviation dictionary — that is unbounded,
 * locale-specific, and a second feature. `sentenceCorpus.ts` records which
 * cases stay uncovered rather than implying none do.
 *
 * ## Completeness is the gate, not a diagnostic
 *
 * > A side of the sentence is complete **iff the segmenter found that boundary
 * > strictly inside the run** — or, where the boundary IS the run's edge, iff
 * > the caller knows what lies across that edge and the segmenter, reading the
 * > two as flowing text, breaks exactly at the seam.
 *
 * Uniform and fail-closed. A budget-truncated window has nothing known across
 * its edge, so that edge is still no evidence of anything; `He said,<br>and
 * left.` meets `and left.` across its seam and the segmenter does not break
 * there, so the run's `He said,` is still declined and the caller falls back.
 *
 * ⚠️ **THIS RULE USED TO COST THE FIRST AND LAST SENTENCE OF EVERY BLOCK**, and
 * a dialogue paragraph is one sentence long, so in fiction that was most
 * lookups (phase 17, L8). The argument was that nothing in the run can tell
 * `</p>` from `<br>` from a budget cut. True, and beside the point: the kind of
 * edge was never the question. A verse line ending in a comma is a sentence
 * running ACROSS an edge whichever element made it, and `reefs.` before `</p>`
 * is one ending AT an edge — and what tells them apart is the text on both
 * sides, which is this module's question and not the DOM's. Measured: a
 * paragraph after a paragraph, a closing quote before new dialogue, CJK —
 * break; a verse comma, a lowercase continuation, `Mr.` at the edge, and
 * `Chapter 1. Loomings` run into `Call me Ishmael.` — no break, so no answer.
 *
 * Only the EDGE is confirmed from across it. The sentence returned is still
 * inside the run: nothing from the far side of an edge is ever sent.
 *
 * The caller's fallback is what shipped before this existed, so declining is
 * never a regression — see `SegmentGap`, which is counted rather than shown.
 *
 * ⚠️ **AND THE FALLBACK NOW COMES THROUGH HERE TOO**, with the gate off. It has
 * nowhere to decline TO, so the rule above is not available to it; what it
 * needs from this module is the SEGMENTATION, which is the half it used to
 * carry a second, worse copy of. See `SentenceOptions.requireComplete` for the
 * two defects that copy was measured to have.
 */

/** SOFT HYPHEN. Invisible, inside words, and not the model's to read either —
 *  the same character `rangeText` strips out of stored text. */
/* ⚠️ **SPELLED AS AN ESCAPE, AND IT WAS THE INVISIBLE CHARACTER ITSELF.** A
   soft hyphen renders as nothing, so the literal looked like an empty string in
   review and in every diff, and deleting or replacing it would not have shown.
   Written with a tool this repository has already been bitten by: a backslash-u
   escape typed into an edit can arrive as the raw character (see AGENTS.md), so
   the bytes here were checked with `od` rather than trusted. */
const SOFT_HYPHEN = '\u00ad'

/**
 * What CSS collapses, and therefore what a source LF is.
 *
 * NOT `\s`. The two sets come apart on exactly the characters that matter here:
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are `\s` to JavaScript,
 * are NOT in CSS's white space set, and render as a break the reader can see.
 * Collapsing them to a space would weld two rendered lines into one sentence —
 * the same class of silent wrongness as segmenting a source LF, arriving from
 * the opposite direction.
 *
 * They are also UAX #29 `Sep`, so leaving them in place makes ICU end a
 * sentence there, which is what the reader sees. `trim` takes them off the
 * chosen sentence's edges afterwards.
 */
/**
 * Every soft hyphen, for judging whether a range holds anything to say.
 *
 * `trim()` removes U+2028 and U+2029 — they are `\s` to JavaScript — but a soft
 * hyphen is neither whitespace nor content: invisible, and a range holding only
 * one has nothing for a voice to pronounce.
 */
/* THE SAME CHARACTER, BUILT FROM ONE SOURCE, so the test for one soft hyphen and
   the pattern that strips them all cannot come to name different things. */
const SOFT_HYPHEN_ALL = new RegExp(SOFT_HYPHEN, 'gu')

const COLLAPSIBLE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/

/** U+2028 and U+2029 — see `COLLAPSIBLE`. */
const SEPARATOR = /[\u2028\u2029]/

/**
 * The longest span this will call a sentence.
 *
 * Not a defensive round number. A reader stopped reading to wait for this
 * (§F3), the input to a 4B model is otherwise unbounded, and a "sentence" past
 * this length is a run with no terminators in it — a heading, a verse block, a
 * table cell — rather than a sentence. Declining is a fallback, not a failure.
 */
export const MAX_SENTENCE_CHARS = 1_000

/**
 * The longest run this will look for a sentence IN.
 *
 * The cap above bounds the ANSWER; this bounds the WORK, and they are not the
 * same guard. `flatten` never splits a single text node, so its budget is a
 * budget and not a bound: one pathological node arrives whole, and squeezing
 * and segmenting it happens synchronously **on the selection path** before the
 * answer is rejected for being too long. A reader who dragged across such a
 * node would feel the stall and never learn why.
 *
 * Sixty-four times the sentence cap, so nothing a book can plausibly hold is
 * refused by it: the ordinary run is bounded by `flatten`'s own 4 000-character
 * budget, and only a single 64 kB text node reaches this.
 */
export const MAX_RUN_CHARS = 64_000

/**
 * Why the TEXT held no sentence to vouch for — the reasons segmentation itself
 * can reach. Counted through `Diagnostics`; a closed set of enum words, never
 * book text.
 *
 * ⚠️ **ONLY WHAT THIS MODULE CAN PRODUCE.** This union used to hold the DOM
 * walk's reasons as well — a boundary that is not text, a detached range, a
 * walk that threw — and a caller's own reason for not asking at all, none of
 * which a function over strings can reach. `sentenceAt` owns those now, as
 * `SentenceGap`, and the fixed-layout reason went with the deleted lookup that
 * gave it: a vocabulary that lists reasons nothing can produce is a list a
 * reader of the counts goes looking for and never finds.
 */
export type SegmentGap =
  /** The run held no visible text once filtered and squeezed. */
  | 'empty'
  /** The term held no visible text once filtered and squeezed. */
  | 'no-term'
  /** The sentence's start coincides with the run's edge (§C1). */
  | 'run-start'
  /** The sentence's end coincides with the run's edge (§C1). */
  | 'run-end'
  /** The span the term covers is longer than a sentence. */
  | 'too-long'

export type SegmentResult =
  | { readonly ok: true; readonly sentence: string; readonly term: string }
  | { readonly ok: false; readonly gap: SegmentGap }

export interface SentenceOptions {
  /** A tag already proven to construct a `Segmenter` — see
   *  `resolveSegmenterLocale`. `undefined` means the book declares none: ICU
   *  segments in the host's own locale, and the merge pass reads the text's
   *  script rather than the host's (`isLatinLocale`). It is spelled out because
   *  that is a value a caller passes rather than a key it omits —
   *  `exactOptionalPropertyTypes` tells the two apart. */
  readonly locale?: string | undefined
  readonly maxSentenceChars?: number | undefined
  /**
   * What lies across the run's START edge, where the caller knows (phase 17,
   * L8) — see "Completeness is the gate" above.
   *
   * - `undefined` — nothing is known: the window's own budget ended there. A
   *   sentence starting at the edge is declined, as it always was.
   * - a string — the readable text before the edge: the previous paragraph, or
   *   the line before a `<br>`. The sentence may start at the edge iff the
   *   segmenter breaks exactly where the two meet.
   * - `null` — nothing that could belong to the sentence lies across it: the
   *   document starts there, or a heading ends there. Asked the same question,
   *   with `PROBE` standing in for a sentence that has ended — so a document
   *   opening mid-sentence in lower case is still not taken at its word.
   */
  readonly before?: string | null | undefined
  /** What lies across the run's END edge — `before`, mirrored. */
  readonly after?: string | null | undefined
  /**
   * Whether a boundary at the run's edge disqualifies the sentence (§C1) unless
   * the text across it says otherwise — `before` and `after`.
   *
   * TRUE by default, which is the walk's rule and the one this module was
   * written around: a wrong sentence handed to a model reads exactly like a
   * right one, and `sentenceAt` has somewhere to fall back to.
   *
   * ⚠️ **FALSE IS FOR THE CALLER THAT HAS NOWHERE TO FALL BACK TO**, and there
   * is exactly one: `sentenceAround`, the fallback itself. Its run is
   * `markContext`'s 32 characters a side, which is cut mid-sentence by
   * construction — so §C1 would decline every single time and the caller would
   * have to invent a second segmentation to answer with. That second
   * segmentation is what this option exists to delete: it was a regex,
   * `/(?<=[.!?。！？])\s+/`, and it was measured wrong twice over — a NO-OP on
   * Chinese, which does not write a space after `。`, and it erased the whole
   * prefix at an abbreviation (`'He met Mr. '.split(…).pop()` is `''`).
   *
   * So the gate becomes an option rather than the policy forking. Declining is
   * a real answer for a caller that has one; for a caller that does not, a
   * fragment segmented CORRECTLY is strictly better than the whole window, and
   * the whole window is what it sent before.
   */
  readonly requireComplete?: boolean | undefined
}

/** Half-open, into the normalised text. */
/** A half-open range of character offsets. Exported for `sentenceSpansOf`. */
export interface Span {
  readonly start: number
  readonly end: number
}

interface Squeezed {
  readonly text: string
  /** Where the term starts and ends in `text`. Carried through the squeeze
   *  rather than searched for afterwards: `the` occurs a dozen times in a
   *  paragraph and `indexOf` returns the wrong one for most words (§A2). */
  readonly termStart: number
  readonly termEnd: number
  /**
   * For each character of `text`, the offset in `raw` it was emitted from.
   *
   * ⚠️ **BUILT ALWAYS, NOT BEHIND A FLAG.** Only `sentenceSpansOf` reads it, and
   * a parameter deciding whether to fill it would leave the selection path
   * running code no test of that path exercises. One array of `text.length`
   * numbers next to the string building it accompanies is not a cost worth a
   * branch — this file's own history is full of branches that only one caller
   * reached and that were therefore wrong.
   *
   * An OWED space maps to the offset of the character that forced it out, which
   * is the first kept character after the whitespace run it stands for. That is
   * the useful answer: a span starting at that space starts, in `raw`, at the
   * run rather than inside it.
   */
  readonly map: readonly number[]
}

/**
 * The sentence around `[termStart, termEnd)` in `raw`, or the reason there is
 * none.
 *
 * `raw` is the run as the DOM gave it — un-squeezed, because the squeeze is
 * this function's first step and doing it twice would move the offsets.
 */
export function sentenceOf(
  raw: string,
  termStart: number,
  termEnd: number,
  options: SentenceOptions = {},
): SegmentResult {
  /* Before any work, not after it — see `MAX_RUN_CHARS`. What lies across the
   * edges counts: it is squeezed and segmented too. */
  if (raw.length + (options.before?.length ?? 0) + (options.after?.length ?? 0) > MAX_RUN_CHARS) {
    return { ok: false, gap: 'too-long' }
  }

  /* ⚠️ **THE OFFSETS ARE CHECKED, AND THEY USED TO BE TRUSTED.** `squeeze`
   * clamped whatever it was given — a `termEnd` past the end of `raw` resolved
   * to `text.length` — so an out-of-range pair did not fail, it silently described
   * a DIFFERENT term. Under §C1 that mostly ended as a `run-end` gap and was
   * invisible; with `requireComplete: false` the gate is gone, so the same
   * mistake now returns a confident sentence spanning every segment from the
   * term to the end of the run. A caller that computed its offsets wrongly must
   * be told, not answered. Found by audit. */
  if (
    !Number.isInteger(termStart) ||
    !Number.isInteger(termEnd) ||
    termStart < 0 ||
    termEnd > raw.length ||
    termStart >= termEnd
  ) {
    return { ok: false, gap: 'no-term' }
  }

  /* ⚠️ **A CAP THAT IS NOT A WHOLE NUMBER CAPS NOTHING.** `length > NaN` is
   * false for every length, so `maxSentenceChars: NaN` switched the guard at the
   * end of this function off and a 1 101-character "sentence" went out. The
   * offsets' rule: a caller that computed it wrongly is told, not answered — and
   * told before the work. A negative whole number needs no test of its own:
   * every sentence is longer than it. Found by audit. */
  const cap = options.maxSentenceChars ?? MAX_SENTENCE_CHARS
  if (!Number.isInteger(cap)) return { ok: false, gap: 'too-long' }

  const squeezed = squeeze(raw, termStart, termEnd)
  const { text } = squeezed
  if (text === '') return { ok: false, gap: 'empty' }

  const term = text.slice(squeezed.termStart, squeezed.termEnd)
  if (term === '') return { ok: false, gap: 'no-term' }

  const spans = merged(text, options.locale)
  /* The segment holding the term's start, through the one holding its last
   * character. A selection containing a terminator spans two of them (§A4),
   * and taking only the first would send half of what the reader chose. */
  const first = spanAt(spans, squeezed.termStart)
  const last = spanAt(spans, Math.max(squeezed.termStart, squeezed.termEnd - 1))
  const span: Span = { start: first.start, end: last.end }

  /* §C1. A boundary at the run's edge is the run ending, which is not the same
   * fact as a sentence ending — unless what lies across the edge is known and
   * the segmenter breaks at the seam (`before`, `after`). Skipped only for the
   * caller with nothing behind it — see `requireComplete`, which is the whole
   * argument. */
  if (options.requireComplete ?? true) {
    if (
      span.start <= 0 &&
      (options.before === undefined || !breaksBetween(farSide(options.before), text, options.locale))
    ) {
      return { ok: false, gap: 'run-start' }
    }
    if (
      span.end >= text.length &&
      (options.after === undefined || !breaksBetween(text, farSide(options.after), options.locale))
    ) {
      return { ok: false, gap: 'run-end' }
    }
  }

  /* Never empty, so not asked: the span holds the term, and a term is never
   * empty and never starts or ends on the one thing `trim` removes that the
   * squeeze kept — a separator (see `squeeze`). It carried a `sentence === ''`
   * refusal nothing could reach. Found by mutation testing. */
  const sentence = text.slice(span.start, span.end).trim()
  /* Measured on what would actually be SENT, after the trim. A segment carries
   * the whitespace that separates it from the next one, so capping the raw span
   * refused a sentence for characters the model never sees. */
  if (sentence.length > cap) {
    return { ok: false, gap: 'too-long' }
  }
  return { ok: true, sentence, term }
}

/**
 * Runs of whitespace collapsed to one space, soft hyphens dropped, and the
 * term's two offsets carried across.
 *
 * The leading and trailing whitespace of the run never reaches `text` at all:
 * a space is only ever emitted BEFORE a character that is kept, so the result
 * is trimmed by construction and the completeness test above can compare
 * against `text.length` without a second trim moving it.
 *
 * The two offsets resolve differently on purpose. A start lands on the first
 * character emitted at or after it — so a term beginning against a collapsed
 * space starts at the word, not at the space. An end lands on the output as it
 * stands the moment the offset is reached, BEFORE any owed space is flushed —
 * so a term followed by a space does not swallow it.
 *
 * ⚠️ **AND NEITHER LANDS ON A MANDATORY SEPARATOR AT THE TERM'S EDGE.** U+2028
 * and U+2029 are EMITTED, unlike a space, so they could be the term: selecting
 * the separator alone was answered with the sentence before it, and a term
 * ending on one was sent carrying a character its trimmed sentence does not
 * contain. A start steps over them as it steps over collapsed space, and an end
 * stops before any it has just passed. One INSIDE the term is the reader's, and
 * stays. Found by audit.
 */
function squeeze(raw: string, termStart: number, termEnd: number): Squeezed {
  let text = ''
  const map: number[] = []
  let owedSpace = false
  let pendingStart = false
  let start: number | null = null
  let end = 0
  /* `text.length`, less any separators `text` currently ends with. */
  let contentEnd = 0

  for (let at = 0; at <= raw.length; at += 1) {
    if (at === termStart) pendingStart = true
    /* Written exactly once, so there is nothing to fall back to: every `termEnd`
     * lies in `[0, raw.length]` — `sentenceOf` refuses any other and `farSide`
     * passes zero — and this loop stops at every offset in that range,
     * `raw.length` included. It carried `end === null` and `end ?? text.length`,
     * neither of which anything could reach. Found by audit. */
    if (at === termEnd) end = contentEnd
    if (at === raw.length) break

    const character = raw.charAt(at)
    if (character === SOFT_HYPHEN) continue
    if (COLLAPSIBLE.test(character)) {
      /* Owed, not written: a run of whitespace with nothing after it must
       * leave no trailing space behind. */
      if (text !== '') owedSpace = true
      continue
    }
    /* A mandatory separator is EMITTED, and it cancels an owed space rather
     * than following one: `line one\u2028line two` must not become
     * `line one \u2028line two`, whose extra space would survive into the
     * sentence either side of it. */
    const separator = SEPARATOR.test(character)
    if (separator) owedSpace = false
    if (owedSpace) {
      text += ' '
      map.push(at)
      owedSpace = false
    }
    if (pendingStart && !separator) {
      start = text.length
      pendingStart = false
    }
    text += character
    map.push(at)
    if (!separator) contentEnd = text.length
  }

  return {
    text,
    map,
    /* Still pending means the term began in whitespace or separators with
     * nothing kept after them, so it starts where the text ran out — which
     * makes it empty, which is the `no-term` answer rather than a silently
     * relocated term. */
    termStart: start ?? text.length,
    termEnd: end,
  }
}

/**
 * A sentence that has ended: the far side of an edge nothing lies across (see
 * `SentenceOptions.before`). A whole word and a full stop, and NOT an initial —
 * `INITIAL` would merge `A.` into whatever follows it, and a probe the merge
 * pass swallows confirms nothing, ever.
 */
const PROBE = 'Then.'

/** What lies across an edge, normalised as the run is — `null`, nothing, as `PROBE`. */
function farSide(side: string | null): string {
  return side === null ? PROBE : squeeze(side, 0, 0).text
}

/** A run of them at the start of a string — see `breaksBetween`. */
const LEADING_SEPARATORS = /^[\u2028\u2029]+/

/**
 * Whether a sentence boundary falls exactly where `head` meets `tail`, read as
 * flowing text.
 *
 * Through `merged`, not the raw segments: ICU alone breaks after `Mr.` at the
 * end of one block, and a boundary the merge pass would take back inside a run
 * is not one to vouch for at a run's edge either. One policy, asked in one
 * place. An empty side has no seam inside the joined text, so it answers false
 * without being special-cased.
 *
 * Both sides arrive NORMALISED — the run by `sentenceOf`'s own squeeze, a far
 * side by `farSide`. This used to squeeze both itself, so a run already
 * squeezed once was squeezed again for every edge it asked about. Found by
 * audit.
 */
function breaksBetween(head: string, tail: string, locale: string | undefined): boolean {
  /* ⚠️ **NO SPACE BESIDE A MANDATORY SEPARATOR, AND THERE ALWAYS WAS ONE.** ICU
   * ends a sentence straight AFTER U+2028 or U+2029, so `one.<U+2028>` joined
   * to `Beta` by a space broke one character before the seam, and an edge the
   * reader sees as a line break was declined. The separator takes the space's
   * place — the rule `squeeze` applies inside a run — and a break after the
   * tail's own leading separators is still the seam's, since nothing else lies
   * between. Found by audit.
   *
   * ⚠️ PAST ALL OF THEM, NOT THE FIRST. Node's ICU breaks after every separator
   * (UAX #29 SB4), so there counting one and counting all look the same, and
   * cutting this to the first was proposed on that evidence (2026-09-14). WebKit
   * on macOS runs the system ICU; an engine that keeps a run of separators
   * together breaks only after the last, and `sentenceOf.guards.test.ts` stands
   * one in. */
  const joint = SEPARATOR.test(head.slice(-1)) || SEPARATOR.test(tail.slice(0, 1)) ? '' : ' '
  const seam = head.length + joint.length + (tail.length - tail.replace(LEADING_SEPARATORS, '').length)
  return merged(`${head}${joint}${tail}`, locale).some((span) => span.start === seam)
}

/**
 * Every sentence in `raw`, as contiguous ranges in `raw`'s OWN offsets.
 *
 * This is the reading path's entry — `sentenceOf` answers "which sentence holds
 * this selection", and read-aloud needs "what are all of them, in order" so it
 * can speak one at a time and move by one. Both go through the SAME `squeeze`
 * and the same `merged`, deliberately: two answers to where a sentence ends is
 * the drift this file has already paid for twice, and the corpus holds them
 * together (`sentenceOf.reading.test.ts`).
 *
 * ⚠️ **IT SQUEEZES FOR THE REASON THIS FILE'S HEADER ALREADY GIVES** — "Normalise,
 * then segment — and the order is the whole point" — so the reading inherits that
 * rule rather than meeting it again. `Intl.Segmenter` treats a newline as a
 * paragraph separator (UAX #29 SB4) and an EPUB's source is hard-wrapped, so
 * segmenting `raw` splits mid-clause at every source line break; here that would
 * be a wrong "next sentence" and a wrong highlight on most of a book. The corpus
 * row `sentence-in-source` is the evidence and predates this function.
 *
 * ⚠️ **AND FLATTENING NEWLINES TO SPACES IS NOT A SHORTCUT TO IT**, which was
 * measured rather than assumed: a same-length substitution preserves offsets and
 * still breaks `He met Mr.\n    Smith`, because the merge reads a segment's TAIL
 * and that tail is then five spaces, so `endsInAbbreviation` never fires.
 * Collapsing is what makes the tail `Mr. ` again. Only the full squeeze does
 * both jobs.
 *
 * ⚠️ **THE RANGES ARE CONTIGUOUS AND COVER `raw` WHOLE, WHICH IS THE POINT.**
 * Only the STARTS are mapped back; each range ends where the next begins and the
 * last ends at `raw.length`. So no character of a book can fall between two
 * sentences and go unread — a gap here would be a silently skipped line, which
 * is exactly the failure a reader could never diagnose. `covers` asserts it.
 *
 * An empty or whitespace-only `raw` answers `[]` rather than one empty range:
 * nothing to say is not a sentence, and a caller speaking an empty string gets
 * an utterance that ends immediately and looks like an engine fault.
 */
/* ⚠️ **NO WORK BOUND, UNLIKE `sentenceOf` — MEASURED AND LEFT, NOT OVERLOOKED.**
 * An audit asked for `MAX_RUN_CHARS` here too. Measured on 2026-09-21 (load ~4.7):
 * 100 000 characters in 3.7 ms, 1 000 000 in 34.7 ms, 4 000 000 in 165 ms —
 * linear, and a real chapter is well under the first. The worst case is a whole
 * novel in one spine item, which costs one pause of about a sixth of a second
 * when that section starts reading. A bound would turn that into refusing to read
 * the section at all, which is the worse outcome by a long way; `sentenceOf`'s
 * bound exists because a SELECTION can be arbitrarily large, and this is called
 * once per section, not per gesture. */
export function sentenceSpansOf(raw: string, locale: string | undefined): readonly Span[] {
  const squeezed = squeeze(raw, 0, 0)
  /* `squeeze` collapses every run of whitespace AND drops it at both ends, so
     its text is empty exactly when there is nothing to read. A `.trim()` here
     asked the same question a second time, and no input could tell the two
     answers apart. */
  if (squeezed.text === '') return []

  /* CLAMPED THROUGH THE MAP, never past it: `merged` spans index `text`, so
   * every start but a degenerate one has an entry.
   *
   * AND NO `starts.length === 0` GUARD BELOW, because the check above has
   * already answered it: `merged` yields at least one segment for text that is
   * not empty. Were it ever to yield none, the pin on the first start covers
   * the whole section as one sentence — which reads it — where an empty answer
   * would silently drop a section that has words in it. */
  const starts = merged(squeezed.text, locale).map((span) => squeezed.map[span.start] ?? raw.length)

  /* THE FIRST RANGE STARTS AT ZERO whatever the map says. Leading whitespace is
   * squeezed away, so the first kept character can be some way in — and a first
   * range beginning there would leave the run before it in no sentence at all,
   * which is the coverage hole this function promises not to have. */
  starts[0] = 0

  /**
   * ⚠️ **A RANGE HOLDING ONLY A SEPARATOR WAS A SENTENCE, AND IT IS AN UTTERANCE OF
   * NOTHING.** `end > start` drops only a range of ZERO length, and U+2028 is one
   * character — so `\u2028Hello.` produced a first "sentence" containing just the
   * separator. The reading hands that to the engine, and an utterance that ends
   * immediately reads as a fault rather than a pause; a run of separators produced
   * one each.
   *
   * MERGED INTO A NEIGHBOUR RATHER THAN DROPPED, because dropping opens exactly the
   * coverage hole this function promises not to have. The ranges are defined by
   * their starts alone, so removing a start IS the merge: the range before it
   * extends to where the next one begins.
   */
  const silent = (start: number, end: number) =>
    raw.slice(start, end).replace(SOFT_HYPHEN_ALL, '').trim() === ''

  const kept = starts.filter((start, at) =>
    at === 0 ? true : !silent(start, starts[at + 1] ?? raw.length),
  )

  /* ⚠️ **THE FIRST RANGE CANNOT MERGE BACKWARD, SO IT MERGES FORWARD.** `starts[0]`
     is pinned at 0 to keep the tiling total, so a LEADING separator survived the
     pass above — which is the very case this exists for. Dropping the start after
     it extends range 0 over both; a loop, because a run of them leaves several. */
  /* ONE CONDITION, and the end of the text stands in for the start that is not
     there. A `kept.length > 1` beside this asked what the guard at the top of
     the function has already answered — the whole text is not silent — so with
     one start left the range runs to the end and the loop stops on its own. */
  while (silent(kept[0] as number, kept[1] ?? raw.length)) kept.splice(1, 1)

  const out: Span[] = []
  for (const [at, start] of kept.entries()) {
    const end = kept[at + 1] ?? raw.length
    /* A range of nothing is dropped rather than spoken. Two `merged` spans can
     * map to one raw offset when everything between them was collapsed.
     *
     * ⚠️ **NO INPUT HAS EVER PRODUCED ONE**, which is why this carries a
     * directive rather than a case. Fifteen candidates were tried against the
     * real segmenter — runs of soft hyphens, line and paragraph separators,
     * doubled stops, a lone quote, an ellipsis, a Chinese opening bracket, text
     * ending in a separator — and every one tiled strictly. A start can repeat
     * only through the `raw.length` fallback above, which needs a `merged` span
     * beginning past the end of the squeezed text. Kept because the map is
     * `squeeze`'s and this is the only thing standing between a collapsed run
     * and a sentence with nothing in it. */
    // Stryker disable next-line ConditionalExpression,EqualityOperator: see above — no input produces a range of nothing, so neither answer can be observed.
    if (end > start) out.push({ start, end })
  }
  return out
}

/** The segments, with abbreviation runs — and a quotation's lowercase
 *  attribution — merged. */
function merged(text: string, locale: string | undefined): readonly Span[] {
  const spans = segmentsOf(text, locale)
  /* A declared language answers for every segment alike, so it is asked once.
   * With none declared it is `undefined`, and each segment answers for itself —
   * see `isLatinLocale` for why the machine is never asked instead. */
  const declared = locale === undefined ? undefined : isLatinLocale(locale)

  // Stryker disable next-line ArrayDeclaration: a first entry that is not a span is never merged into (nothing is owed a merge before the first segment), and both readers — `spanAt` and `breaksBetween` — test a field it does not have, so it is skipped.
  const out: Span[] = []
  /* What the span last written ends in, asked of the SEGMENT that ended it.
   *
   * ⚠️ **IT WAS ASKED OF THE WHOLE MERGED SPAN**, which re-read every character
   * merged so far at every step: `J. ` twenty-one thousand times is under
   * `MAX_RUN_CHARS` and took seconds to decline, synchronously, on the selection
   * path. The segment gives the same answer. The patterns read only a span's
   * TAIL, and that tail lies inside its last segment — the character before a
   * title included, because ICU never breaks between `Mr.` or `J.` and a capital
   * straight after it (UAX #29 SB7), so a segment continuing a merge always
   * follows a space. Found by audit. */
  let abbreviated = false
  let quoted = false
  for (const span of spans) {
    const segment = text.slice(span.start, span.end)
    if (abbreviated || (quoted && STARTS_LOWER.test(segment))) {
      out[out.length - 1] = { start: (out[out.length - 1] as Span).start, end: span.end }
    } else {
      out.push(span)
    }
    /* Asked of the segment's TAIL, which is the only part the patterns read.
     *
     * ⚠️ **IT WAS THE WHOLE SEGMENT, AND THAT CUT ORDINARY ENGLISH** (found by
     * review, 2026-09-14): one letter of another script anywhere in the
     * sentence answered "not Latin", so selecting a word in `He discussed α
     * with Dr. Smith at noon.` returned `Smith at noon.` — the very failure the
     * locale fix removed, arriving through a different door. A Greek variable,
     * a Han name or a quoted foreign word is ordinary text in an English
     * sentence; what decides is whether THIS abbreviation is a Latin one. */
    const latin = declared ?? isLatinTail(segment)
    abbreviated = latin && endsInAbbreviation(segment)
    quoted = latin && QUOTATION.test(segment)
  }
  return out
}

function segmentsOf(text: string, locale: string | undefined): Span[] {
  const out: Span[] = []
  for (const part of new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text)) {
    out.push({ start: part.index, end: part.index + part.segment.length })
  }
  return out
}

/**
 * The titles and initials that end a segment without ending a sentence.
 *
 * A CLOSED list, and short. Merging on any word ending in a full stop would
 * weld real sentences together, and a general abbreviation dictionary is
 * unbounded and locale-specific — a second feature, not a tightening of this
 * one. `St.` can genuinely end a sentence ("he lived on Main St."); it is here
 * because a title before a name is much the commoner shape and the cost of the
 * miss is one sentence too long rather than one cut in half.
 */
/* ⚠️ **THE TRAILING CLASS IS SPACES, NOT `\s`, AND IT USED TO BE `\s*`.**
 * After `squeeze` the only whitespace left in the text is a single space —
 * everything collapsible became one — EXCEPT U+2028 and U+2029, which are
 * preserved deliberately because CSS does not collapse them and the reader sees
 * a line break there. `\s` matches those, so `Main St.\u2028Beta two.` — two
 * segments ICU correctly split at the separator — was merged back into one
 * sentence by the abbreviation pass. The normaliser goes to some length to keep
 * that boundary and this threw it away. Found by audit.
 *
 * The LEADING class stays `\s`: a separator before `Mr.` is a word boundary
 * like any other, and matching it there merges nothing. */
/* ⚠️ **THE MILITARY AND CIVIC TITLES WERE MISSING, SO `Capt. Smith` WAS CUT IN
 * TWO.** The list held the forms of address and nothing that precedes a rank or
 * an office, and ICU splits after every one of them. Each added here is a word
 * that in practice never ENDS a sentence — which is the only thing that makes a
 * title safe to merge across — and none is a common word in its own right.
 * `St.` stays for the reason given above; the false merge it causes and the one
 * `INITIAL` causes (`option A. Next came B.`) are genuine ambiguities with no
 * local disambiguator, and are the stated cost of this pass. */
const TITLE = /(?:^|[\s("'‘“])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Capt|Lt|Col|Gen|Sgt|Cmdr|Adm|Rev|Hon|Gov|Sen|Rep|Fr|Mt)\. *$/
/** `J.` in `Mr. J. R. Smith` — one capital and a stop, never a whole word. */
const INITIAL = /(?:^|[\s("'‘“])\p{Lu}\. *$/u

function endsInAbbreviation(segment: string): boolean {
  return TITLE.test(segment) || INITIAL.test(segment)
}

/**
 * A quotation or aside ending in `!` or `?` — `"Stop!"`, `(fast!)` — that the
 * next segment carries on in lower case: `He said, "Stop!" he said.`
 *
 * ICU breaks after `!"` whatever follows: UAX #29 keeps a lowercase continuation
 * with the sentence before it only after a FULL STOP (SB8), so the attribution
 * came back as a sentence of its own — `he said.`, which is half of one. Bounded
 * on purpose: a closing mark is required, so `Stop! he said.` with no quotation
 * stays as ICU split it, and a capital after the quotation is a new sentence as
 * it always was. The cost of a wrong merge is the one `St.` already buys: one
 * sentence too long, never one cut in half. Trailing spaces only, not `\s`, for
 * `TITLE`'s reason. Found by audit.
 */
const QUOTATION = /[!?]["'’”»)\]]+ *$/
const STARTS_LOWER = /^\p{Ll}/u

/**
 * Whether the merge pass applies to a book that DECLARES `locale`.
 *
 * Gated by SCRIPT rather than by language, because the list above is Latin
 * orthography and nothing else: `。` needs no merge and `Dr.` does not occur.
 * Unknown resolves to false — not merging is exactly what the regex this
 * replaces did, so failing closed here cannot regress anything.
 *
 * ⚠️ **IT TOOK `undefined` AND ASKED THE MACHINE.** A book that declares no
 * language got `new Intl.Segmenter(undefined, …).resolvedOptions().locale` —
 * the SYSTEM's locale — so whether `Mr.` ended a sentence depended on the
 * computer the book was read on, not on the book. Measured 2026-09-14 on Windows
 * 11 set to zh-CN, ICU 78.3: `He met Mr. Smith at noon.` came back as
 * `Smith at noon.`, and an edge after `He met Mr.` was vouched for as a sentence
 * boundary; both held on an en-US Mac, and both failed there too under
 * `LC_ALL=zh_CN.UTF-8`. ICU was not the dependence — it splits after `Mr.` the
 * same under `undefined`, `en` and `zh-CN`. The lookup was.
 *
 * So it takes a declared tag only, and the text answers the rest: with no
 * language, `merged` asks the tail each segment ends in (`isLatinTail`). The book's
 * text decides, never the machine.
 */
function isLatinLocale(locale: string): boolean {
  try {
    const parsed = new Intl.Locale(locale)
    /* ⚠️ `und` MAXIMIZES TO `en-Latn-US`. Measured: `new Intl.Locale('und')
     * .maximize().script` is `Latn`, so a book that says "I do not know what
     * language this is" would have had the Latin merge applied to it — the
     * opposite of the fail-closed behaviour this function claims.
     *
     * And the obvious guard is the wrong one: `new Intl.Locale('und').language`
     * is **`undefined`**, not `'und'` — measured, and the first version of this
     * check tested for the string and let `und` straight through. A tag with no
     * language, or one whose language MEANS "not a language", is unknown, and
     * unknown does not get the merge. */
    const language = parsed.language as string | undefined
    if (language === undefined || ['und', 'mul', 'zxx'].includes(language)) return false
    return parsed.maximize().script === 'Latn'
  } catch {
    /* ⚠️ **UNREACHABLE IN V8, AND THAT IS ONE ENGINE.** `merged` segments under
     * this tag before asking, and V8 refuses exactly the same tags in
     * `Intl.Segmenter` and `Intl.Locale` — measured 2026-09-14 over thirty-eight.
     * WebKit on the system ICU and WebView2 are what run this, and a tag their
     * segmenter took and their `Intl.Locale` refused would otherwise throw
     * inside the reader's lookup. It looks dead under Node, and removing it was
     * proposed on that evidence alone (2026-09-14); `sentenceOf.guards.test.ts`
     * reaches it through a stand-in engine instead. */
    return false
  }
}

/** A character of the Latin script: a letter, or one of the Roman numeral
 *  signs, which are Latin too and are the only non-letters in it. */
const LATIN = /\p{Script=Latin}/u
/** A letter of some script other than Latin. `Common` is nobody's script —
 *  `µ` in `5 µm`, `ʼ`, `ℕ` — so it counts against no text. */
const OTHER_SCRIPT_LETTER = /(?![\p{Script=Latin}\p{Script=Common}])\p{L}/u

/** The last run of non-space characters, with any spaces after it: `Mr.` of
 *  `He met Mr.`, `"Stop!"` of `He said, "Stop!"`. `TITLE`, `INITIAL` and
 *  `QUOTATION` all anchor at the end, so this is everything they can match. */
const TAIL = /\S+ *$/u

/**
 * Whether the abbreviation a segment ENDS in is a Latin one — the merge pass's
 * question when the book declares no language to ask it of.
 *
 * Fails closed on both sides, as `isLatinLocale` does: a tail with nothing
 * Latin in it — digits and punctuation, `"42!"` — is unknown and gets no merge,
 * and so does one carrying a letter of another script, which keeps a Cyrillic
 * `А.` or a Greek `Γ.` from being read as a Latin initial even at the end of an
 * English sentence.
 *
 * Asked of the TAIL, never the segment and never the run. Of the segment, one
 * Greek variable or Han name anywhere in a sentence took the merge away from a
 * Latin title at its end; of the run, a paragraph holding one foreign word
 * would lose the merge in every sentence in it.
 */
function isLatinTail(segment: string): boolean {
  /* NO TAIL IS `false`, SAID AS `false`. `TAIL` finds none only when the
   * segment ends in a line separator, which `\S` does not match — and then no
   * pattern can match either, since each needs a non-space character before
   * its trailing spaces. So what this answers there never reaches a merge; it
   * answered through `?? ''`, whose operand no test could tell from any other
   * string (found by the final mutation sweep, 2026-09-15). Refused outright,
   * there is nothing to stand in for. */
  const tail = TAIL.exec(segment)
  return tail !== null && LATIN.test(tail[0]) && !OTHER_SCRIPT_LETTER.test(tail[0])
}

/**
 * The span holding `offset`.
 *
 * Always one: `sentenceOf` asks only about offsets inside a term, a term lies
 * inside the text, and the spans cover the text end to end from zero — so the
 * first span ending after `offset` holds it. This returned the last span for an
 * offset past the end and `null` for no spans, and tested each span's start as
 * well; `sentenceOf` refused a `null` as `empty`. None of the three could
 * happen. Found by mutation testing.
 */
function spanAt(spans: readonly Span[], offset: number): Span {
  return spans.find((span) => offset < span.end) as Span
}
