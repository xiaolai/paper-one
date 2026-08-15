/**
 * Classification primitives for word-boundary snapping.
 *
 * Two questions about one `Intl.Segmenter` segment: is it word-like, and is it
 * written in a script where snapping to a word boundary means anything.
 *
 * This module is pure. It touches no `document`, no `window`, no `Selection`,
 * no `Range` and no `Node`; it never calls `getComputedStyle`. Everything it
 * needs is in the string it is handed, which is what lets the whole snapping
 * policy be tested with no DOM anywhere in the lane. `classify.test.ts` reads
 * this file back and scans it, so the constraint is enforced rather than
 * merely stated — the scan strips comments first, which is the only reason
 * this paragraph is allowed to name those identifiers at all.
 */

/**
 * A segment is word-like when it contains a letter or a number.
 *
 * Deliberately NOT `Intl.Segmenter`'s own `isWordLike` flag, and the signature
 * takes a bare string so the flag is not even in reach. The engines disagree:
 * Node's ICU reports `true` for `3.14`, `1,000` and `42`, WebKit reports
 * `false` for all three. `10km` is `true` in both, so a flag-reading
 * implementation looks correct until someone selects a price or a year.
 * Characters are the same in both engines; the flag is not.
 *
 * `\p{N}` rather than `[0-9]`, so Arabic-Indic and other digits count.
 */
const WORD_CHARACTER = /[\p{L}\p{N}]/u

export function isWordLike(segment: string): boolean {
  return WORD_CHARACTER.test(segment)
}

/**
 * Scripts written without visible word boundaries, where segmentation is
 * dictionary-driven guesswork and snapping would move a selection edge to a
 * boundary the reader cannot see.
 *
 * `Script_Extensions`, never `Script`. Two characters make the difference, and
 * both are ordinary in Japanese text:
 *
 * - U+30FC, the long-vowel mark, is `Script=Common`. A `\p{Script=...}` test
 *   calls it neutral and therefore snappable — wrong, and invisible until
 *   someone selects a word containing it.
 * - U+3099, the combining voiced sound mark, is `Script=Inherited`, which
 *   resolves to nothing at all on its own.
 *
 * `Script_Extensions` gives both of them Hiragana and Katakana, which is the
 * answer the reader would give.
 */
const UNSNAPPABLE_SCRIPTS = ['Han', 'Hiragana', 'Katakana', 'Thai', 'Lao', 'Khmer', 'Myanmar']

/* Built from the list above rather than written out, so adding a script is an
 * edit to a readable array instead of to a wall of escapes. A malformed entry
 * throws from `RegExp` the moment this module is imported — at load, not on
 * the first selection. */
const UNSNAPPABLE_SCRIPT = new RegExp(
  '[' + UNSNAPPABLE_SCRIPTS.map((name) => '\\p{Script_Extensions=' + name + '}').join('') + ']',
  'u',
)

/**
 * Whether a selection edge touching this segment may be snapped.
 *
 * The test is per segment, never per document or per surrounding sentence: an
 * English word inside a Chinese paragraph snaps, and the Han around it does
 * not. Callers apply this to each edge independently, so one edge of a
 * selection can move while the other stays.
 *
 * A segment is blocked when ANY of its characters belongs to a blocked script
 * — not the first, not the last, which would let `ab中` and `中ab` through in
 * turn. Everything else is transparent: whitespace and punctuation carry no
 * script and are not blocked here, so a caller trimming an edge inward through
 * them is not stopped by this gate.
 *
 * The `u` flag is load-bearing. It makes the character class match whole code
 * points, so U+20000 is tested as one astral Han character rather than as two
 * unpaired surrogates, each of which is `Script=Unknown` and would sail past.
 */
export function isSnappableScript(segment: string): boolean {
  return !UNSNAPPABLE_SCRIPT.test(segment)
}

/**
 * Whether a locale tag can actually drive a word segmenter.
 *
 * By construction, never by shape. `i-klingon` satisfies any plausible regex
 * for a language tag and still throws a `RangeError` from the constructor, so
 * the only honest test is to build the thing and see. The Segmenter built here
 * is discarded — it is the throw, or the absence of one, that is the answer.
 */
function segments(tag: string): boolean {
  try {
    new Intl.Segmenter(tag, { granularity: 'word' })
    return true
  } catch {
    return false
  }
}

/**
 * A locale tag from the document, turned into something safe to hand to
 * `Intl.Segmenter` — or `undefined`, meaning "use the host's own locale".
 *
 * Total by design. `new Intl.Segmenter('en_US')` throws a `RangeError`, EPUBs
 * carry exactly that spelling in `lang`, and the call site is on the selection
 * path — a throw there loses the user's selection over a metadata typo. Every
 * input therefore leaves here as a tag that has already been proven to
 * construct, or as `undefined`.
 *
 * Two rules, in order:
 *
 * - **A tag that works is returned unchanged.** Not canonicalised: the round
 *   trip is the contract, and `Intl.getCanonicalLocales` rewrites `POSIX` to
 *   `posix` while rejecting outright several tags the Segmenter accepts.
 * - **Underscores become hyphens, and only then.** The one repair worth making,
 *   because it is the one malformation that is unambiguous and common — POSIX
 *   locale names (`en_US`, `zh_Hans_CN`) written where a BCP 47 tag belongs.
 *   The repaired tag is validated the same way as any other; nothing is
 *   returned on the strength of the substitution alone.
 *
 * Everything else — `''`, `'???'`, `'C'`, a 200-character string — resolves to
 * `undefined` rather than to `'en'`. Guessing English would be a silent wrong
 * answer for every reader whose host locale is not English, and `makePdf.ts`
 * already stamps `lang="en"` on generated pages, so a hardcoded fallback here
 * would make that guess unfalsifiable.
 */
export function resolveSegmenterLocale(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (segments(raw)) return raw
  const repaired = raw.replaceAll('_', '-')
  if (repaired !== raw && segments(repaired)) return repaired
  return undefined
}
