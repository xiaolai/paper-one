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
 * bounded merge pass for titles and single capital initials, gated to
 * Latin-script locales. No general abbreviation dictionary — that is unbounded,
 * locale-specific, and a second feature. `sentenceCorpus.ts` records which
 * cases stay uncovered rather than implying none do.
 *
 * ## Completeness is the gate, not a diagnostic
 *
 * > A side of the sentence is complete **iff the segmenter found that boundary
 * > strictly inside the run**. A boundary that coincides with the run's edge —
 * > whatever that edge is — is not evidence of a sentence ending.
 *
 * Uniform and fail-closed, and it subsumes three cases at once: a
 * budget-truncated window, a selection spanning blocks, and `<br>` mid-sentence
 * (`He said,<br>and left.` yields a sentinel `Flattened` cannot tell from
 * `</p>`, so the run ends at `He said,` and the caller must fall back).
 *
 * It costs the first and last sentence of every block, which is deliberate:
 * nothing in the run can distinguish `</p>` from `<br>` from a budget cut, and
 * a wrong sentence handed to a model reads exactly like a right one. The
 * caller's fallback is what shipped before this existed, so declining is never
 * a regression — see `SentenceGap`, which is counted rather than shown.
 *
 * ⚠️ **AND THE FALLBACK NOW COMES THROUGH HERE TOO**, with the gate off. It has
 * nowhere to decline TO, so the rule above is not available to it; what it
 * needs from this module is the SEGMENTATION, which is the half it used to
 * carry a second, worse copy of. See `SentenceOptions.requireComplete` for the
 * two defects that copy was measured to have.
 */

/** SOFT HYPHEN. Invisible, inside words, and not the model's to read either —
 *  the same character `rangeText` strips out of stored text. */
const SOFT_HYPHEN = '­'

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

/** Why no sentence could be vouched for. Counted through `Diagnostics`; a
 *  closed set of enum words, never book text. */
export type SentenceGap =
  /** A range boundary that is not a text node. */
  | 'not-text'
  /** The range has left the document since the selection was made. */
  | 'detached'
  /** The start boundary is in no tree. */
  | 'no-tree'
  /** The walk reached neither the start boundary nor any text. */
  | 'no-window'
  /** The end boundary is outside the start boundary's run (§A3). */
  | 'span-blocks'
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
  /** The walk threw. Never reaches the reader — see §E6. */
  | 'threw'
  /**
   * THE CALLER'S OWN, and the one member neither this module nor `sentenceAt`
   * can produce: a fixed-layout book, where the sentence path is not attempted
   * at all pending a measurement (WI-16.5). It lives in this union because the
   * vocabulary is "why the lookup has no sentence", and a second enum for the
   * one reason the caller knows would mean two lists to read a count out of.
   */
  | 'fixed-layout'

export type SentenceResult =
  | { readonly ok: true; readonly sentence: string; readonly term: string }
  | { readonly ok: false; readonly gap: SentenceGap }

export interface SentenceOptions {
  /** A tag already proven to construct a `Segmenter` — see
   *  `resolveSegmenterLocale`. `undefined` means the host's own locale, and it
   *  is spelled out because that is a value a caller passes rather than a key
   *  it omits — `exactOptionalPropertyTypes` tells the two apart. */
  readonly locale?: string | undefined
  readonly maxSentenceChars?: number | undefined
  /**
   * Whether a boundary at the run's edge disqualifies the sentence (§C1).
   *
   * TRUE by default, which is the walk's rule and the one this module was
   * written around: nothing in a run can tell `</p>` from `<br>` from a budget
   * cut, a wrong sentence handed to a model reads exactly like a right one, and
   * `sentenceAt` has somewhere to fall back to.
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
interface Span {
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
): SentenceResult {
  /* Before any work, not after it — see `MAX_RUN_CHARS`. */
  if (raw.length > MAX_RUN_CHARS) return { ok: false, gap: 'too-long' }

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
  if (!first || !last) return { ok: false, gap: 'empty' }

  const span: Span = { start: first.start, end: last.end }

  /* §C1, and it depends on no `flatten` flag at all. A boundary at the run's
   * edge is the run ending, which is not the same fact as a sentence ending.
   * Skipped only for the caller with nothing behind it — see
   * `requireComplete`, which is the whole argument. */
  if (options.requireComplete ?? true) {
    if (span.start <= 0) return { ok: false, gap: 'run-start' }
    if (span.end >= text.length) return { ok: false, gap: 'run-end' }
  }

  const sentence = text.slice(span.start, span.end).trim()
  if (sentence === '') return { ok: false, gap: 'empty' }
  /* Measured on what would actually be SENT, after the trim. A segment carries
   * the whitespace that separates it from the next one, so capping the raw span
   * refused a sentence for characters the model never sees. */
  if (sentence.length > (options.maxSentenceChars ?? MAX_SENTENCE_CHARS)) {
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
 */
function squeeze(raw: string, termStart: number, termEnd: number): Squeezed {
  let text = ''
  let owedSpace = false
  let pendingStart = false
  let start: number | null = null
  let end: number | null = null

  for (let at = 0; at <= raw.length; at += 1) {
    if (at === termStart) pendingStart = true
    if (at === termEnd && end === null) end = text.length
    if (at === raw.length) break

    const character = raw[at] ?? ''
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
    if (SEPARATOR.test(character)) owedSpace = false
    if (owedSpace) {
      text += ' '
      owedSpace = false
    }
    if (pendingStart) {
      start = text.length
      pendingStart = false
    }
    text += character
  }

  return {
    text,
    /* Still pending means the term began in whitespace that never emitted, so
     * it starts where the text ran out — which makes it empty, which is the
     * `no-term` answer rather than a silently relocated term. */
    termStart: start ?? text.length,
    termEnd: end ?? text.length,
  }
}

/** The segments, with abbreviation runs merged. */
function merged(text: string, locale: string | undefined): readonly Span[] {
  const spans = segmentsOf(text, locale)
  if (!isLatinLocale(locale)) return spans

  const out: Span[] = []
  for (const span of spans) {
    const previous = out[out.length - 1]
    if (previous && endsInAbbreviation(text.slice(previous.start, previous.end))) {
      out[out.length - 1] = { start: previous.start, end: span.end }
      continue
    }
    out.push(span)
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
const TITLE = /(?:^|[\s("'‘“])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr)\.\s*$/
/** `J.` in `Mr. J. R. Smith` — one capital and a stop, never a whole word. */
const INITIAL = /(?:^|[\s("'‘“])\p{Lu}\.\s*$/u

function endsInAbbreviation(segment: string): boolean {
  return TITLE.test(segment) || INITIAL.test(segment)
}

/**
 * Whether the merge pass applies at all.
 *
 * Gated by SCRIPT rather than by language, because the list above is Latin
 * orthography and nothing else: `。` needs no merge and `Dr.` does not occur.
 * Unknown resolves to false — not merging is exactly what the regex this
 * replaces did, so failing closed here cannot regress anything.
 */
function isLatinLocale(locale: string | undefined): boolean {
  try {
    const tag =
      locale ?? new Intl.Segmenter(undefined, { granularity: 'sentence' }).resolvedOptions().locale
    const parsed = new Intl.Locale(tag)
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
    return false
  }
}

/** The span holding `offset`, or the last one when the offset is the end. */
function spanAt(spans: readonly Span[], offset: number): Span | null {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return span
  }
  return spans[spans.length - 1] ?? null
}
