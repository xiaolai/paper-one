/**
 * The golden corpus for word-boundary snapping: every fixture, as plain data.
 *
 * This module exists because `Intl.Segmenter` is backed by ICU and **Node and
 * WebKit do not agree**. Measured in this repository: the segment record's
 * `isWordLike` flag is `true` for `3.14`, `1,000` and `42` under Node's ICU and
 * `false` for all three under the WKWebView the app actually ships on. WI-1's
 * `isWordLike` deliberately never reads that flag, so this particular
 * divergence is already neutralised — but it proves the class is real, and a
 * macOS upgrade can shift WebKit's segmentation again without anything in this
 * repository changing. A Node-only green is therefore not evidence about the
 * runtime.
 *
 * So the fixtures live here, in one place, in a form two very different
 * consumers can read:
 *
 * - `corpus.test.ts` drives every row through `snapWordRange` under Node.
 * - `scripts/word-snap-parity.mjs` reads this module at run time and emits a
 *   self-contained snippet that runs the SAME rows inside the live webview
 *   through `webview_execute_js`.
 *
 * The second consumer is why the constraints below are not decoration:
 *
 * - **Plain data, no expressions.** Rows are literals. Nothing here is
 *   computed, so what a reader sees is what both engines run.
 * - **No value imports.** The parity script loads this file with nothing but
 *   Node's own TypeScript stripping — no vite, no bundler, no build step — and
 *   Node's ESM resolver does not add extensions. One `import { … } from
 *   './snapWordRange'` would resolve happily under vitest and fail only when
 *   someone runs the parity script. The type import below is erased before the
 *   resolver ever sees it, so it costs nothing. `corpus.test.ts` enforces this.
 * - **`expected` is the literal `'none'`, never `null` and never optional.**
 *   `null` is indistinguishable from "nobody filled this in", and an optional
 *   field turns an unfinished row into a silently passing one. As written, a
 *   row with no expectation fails to compile AND is caught at run time.
 *
 * Every expectation here is MEASURED, not predicted. Where a row's answer is
 * surprising, `why` says what the surprise is.
 */

import type { Edge, SnappedRange } from './snapWordRange'

/**
 * What a row is there to cover.
 *
 * The required subset is asserted by `corpus.test.ts`, not listed here: a
 * requirement stored beside the data can be deleted in the same edit as the
 * last row that satisfies it.
 */
export type Tag =
  | 'apostrophe'
  | 'astral'
  | 'cjk'
  | 'emoji'
  | 'empty'
  | 'hyphen'
  | 'kana'
  | 'latin'
  | 'mixed'
  | 'numeric'
  | 'punctuation'
  | 'seam'
  | 'sentinel'
  | 'soft-hyphen'
  | 'thai'
  | 'whitespace'

export interface CorpusRow {
  /** Stable and unique. It is what a divergence report names, so renaming one
   *  costs a line in whatever transcript recorded the last run. */
  readonly id: string
  readonly tags: readonly Tag[]
  readonly strs: readonly string[]
  readonly start: Edge
  readonly end: Edge
  /** The snapped range, or the literal `'none'` for "there was no word-like
   *  segment to snap to". Never `null`, never absent. */
  readonly expected: SnappedRange | 'none'
  /** Why this row is in the corpus — the thing that breaks if it is deleted. */
  readonly why: string
}

export const CORPUS: readonly CorpusRow[] = [
  /* ── Latin prose: expansion ───────────────────────────────────────────── */
  {
    id: 'expand-both-edges',
    tags: ['latin'],
    strs: ['the quick brown fox'],
    start: { index: 0, offset: 5 },
    end: { index: 0, offset: 12 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 15 } },
    why: 'the ordinary case: two mid-word edges each expand outward to the word they touch',
  },
  {
    id: 'expand-not-to-the-nearest-boundary',
    tags: ['latin'],
    strs: ['abc'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 3 } },
    why: 'the policy is expand-the-touched-word, not nearest-boundary; 2 is nearer to 3 and the answer is 0',
  },
  {
    id: 'already-aligned-stays-put',
    tags: ['latin'],
    strs: ['the quick brown fox'],
    start: { index: 0, offset: 4 },
    end: { index: 0, offset: 9 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 9 } },
    why: 'an unchanged range means "already aligned, nothing to mutate" — a distinct signal from none',
  },
  {
    id: 'wholly-inside-one-word',
    tags: ['latin'],
    strs: ['internationalization'],
    start: { index: 0, offset: 5 },
    end: { index: 0, offset: 8 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 20 } },
    why: 'a selection entirely within one word returns the whole word',
  },

  /* ── Latin prose: trimming ────────────────────────────────────────────── */
  {
    id: 'trim-start-sitting-at-a-word-end',
    tags: ['latin'],
    strs: ['the quick brown fox'],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 15 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 15 } },
    why: 'a drag beginning at the end of `the` does not want `the`; a symmetric rule hands back `the quick brown`',
  },
  {
    id: 'trim-end-sitting-at-a-word-start',
    tags: ['latin'],
    strs: ['the quick brown fox'],
    start: { index: 0, offset: 4 },
    end: { index: 0, offset: 10 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 9 } },
    why: 'the mirror of the row above; applying the start rule to both edges fails this one',
  },
  {
    id: 'trim-start-inside-a-whitespace-run',
    tags: ['latin', 'whitespace'],
    strs: ['aa  bb'],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 6 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 6 } },
    why: 'two spaces, not one: with a single space, "moved to the next word" and "moved one character" agree',
  },
  {
    id: 'trim-end-inside-a-whitespace-run',
    tags: ['latin', 'whitespace'],
    strs: ['aa  bb'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 2 } },
    why: 'the mirror: an end edge in whitespace trims back rather than swallowing the next word',
  },
  {
    id: 'trim-end-overshooting-by-one-space',
    tags: ['latin', 'whitespace'],
    strs: ['alpha beta gamma'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 11 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 10 } },
    why: 'offset 11 is a genuine tie — one character from either boundary; trimming inward always gives up the overshoot',
  },

  /* ── Numerics: the measured Node/WebKit divergence ────────────────────── */
  {
    id: 'numeric-decimal',
    tags: ['numeric', 'latin'],
    strs: ['pi is 3.14 exactly'],
    start: { index: 0, offset: 7 },
    end: { index: 0, offset: 8 },
    expected: { start: { index: 0, offset: 6 }, end: { index: 0, offset: 10 } },
    why: 'ICU makes `3.14` one segment; its isWordLike flag is true in Node and FALSE in WebKit, so reading the flag would break this row on the shipping runtime only',
  },
  {
    id: 'numeric-grouped-thousands',
    tags: ['numeric', 'latin'],
    strs: ['1,000 apples'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 5 } },
    why: 'the comma is inside the number, not a separator; same flag divergence as `3.14`',
  },
  {
    id: 'numeric-bare-year',
    tags: ['numeric', 'latin'],
    strs: ['in 42 BC'],
    start: { index: 0, offset: 4 },
    end: { index: 0, offset: 5 },
    expected: { start: { index: 0, offset: 3 }, end: { index: 0, offset: 5 } },
    why: 'a bare integer between words — the plainest case the flag gets wrong in WebKit',
  },
  {
    id: 'numeric-with-unit',
    tags: ['numeric', 'latin'],
    strs: ['10km run'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 2 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 4 } },
    why: '`10km` is flagged word-like in BOTH engines, which is what makes a flag-reading implementation look correct until someone selects a price or a year',
  },

  /* ── Hyphens and dashes ───────────────────────────────────────────────── */
  {
    id: 'hyphen-compound',
    tags: ['hyphen', 'latin'],
    strs: ['well-known'],
    start: { index: 0, offset: 6 },
    end: { index: 0, offset: 7 },
    expected: { start: { index: 0, offset: 5 }, end: { index: 0, offset: 10 } },
    why: 'a hyphen separates two words; joining across it to make `well-known` one word breaks the three rows below',
  },
  {
    id: 'hyphen-number-range',
    tags: ['hyphen', 'numeric'],
    strs: ['10-20'],
    start: { index: 0, offset: 4 },
    end: { index: 0, offset: 5 },
    expected: { start: { index: 0, offset: 3 }, end: { index: 0, offset: 5 } },
    why: 'counterweight to `well-known`: a range is two numbers, not one token',
  },
  {
    id: 'hyphen-double-dash-flag',
    tags: ['hyphen', 'punctuation', 'latin'],
    strs: ['--flag'],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 4 },
    expected: { start: { index: 0, offset: 2 }, end: { index: 0, offset: 6 } },
    why: 'leading punctuation is not part of the word; a command-line flag selects as `flag`',
  },
  {
    id: 'hyphen-isbn-three-different-dashes',
    tags: ['hyphen', 'numeric'],
    strs: ['978\u2010306\u20114063\u20139'],
    start: { index: 0, offset: 5 },
    end: { index: 0, offset: 6 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 7 } },
    why: 'U+2010, U+2011 and U+2013 in one string, so a separator list built from ASCII hyphen alone passes every earlier row and fails here',
  },

  /* ── Apostrophes, both spellings ──────────────────────────────────────── */
  {
    id: 'apostrophe-curly-possessive',
    tags: ['apostrophe', 'latin'],
    strs: ['readers’ choice'],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 4 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 7 } },
    why: 'a trailing apostrophe is outside the word; stripping apostrophes to make this work breaks the contraction below',
  },
  {
    id: 'apostrophe-curly-contraction',
    tags: ['apostrophe', 'latin'],
    strs: ['don’t'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 2 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 5 } },
    why: 'an interior apostrophe is inside the word — the counterweight to the possessive above',
  },
  {
    id: 'apostrophe-straight-possessive',
    tags: ['apostrophe', 'latin'],
    strs: ["readers' choice"],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 4 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 7 } },
    why: 'U+0027 rather than U+2019: books carry both, and a rule keyed to one of them silently mishandles the other',
  },
  {
    id: 'apostrophe-straight-contraction',
    tags: ['apostrophe', 'latin'],
    strs: ["don't"],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 2 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 5 } },
    why: 'the straight-quote mirror of `don’t`, so neither spelling is the one that happens to work',
  },

  /* ── Soft hyphen ──────────────────────────────────────────────────────── */
  {
    id: 'soft-hyphen-inside-a-word',
    tags: ['soft-hyphen', 'latin'],
    strs: ['hyphen\u00ADation'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 12 } },
    why: 'U+00AD is General_Category Cf, UAX #29 WB4 ignores it, and WebKit double-click takes the whole word; adding it to a separator list re-breaks every line-end hyphenation',
  },

  /* ── The block sentinel, and the control that proves it ───────────────── */
  {
    id: 'sentinel-newline-stops-expansion',
    tags: ['sentinel', 'latin'],
    strs: ['all done\nStart here'],
    start: { index: 0, offset: 6 },
    end: { index: 0, offset: 7 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 8 } },
    why: 'UAX #29 makes LF a mandatory break on both sides, so no word-like segment spans one and expansion cannot cross a block',
  },
  {
    id: 'sentinel-absent-merges-two-blocks',
    tags: ['sentinel', 'latin'],
    strs: ['all doneStart here'],
    start: { index: 0, offset: 6 },
    end: { index: 0, offset: 7 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 13 } },
    why: 'the control for the row above: `done` alone is also what a broken expansion returns, so only the pair shows the sentinel is what stopped it',
  },
  {
    id: 'sentinel-newline-lets-trimming-cross',
    tags: ['sentinel', 'latin'],
    strs: ['all done\nStart here'],
    start: { index: 0, offset: 8 },
    end: { index: 0, offset: 12 },
    expected: { start: { index: 0, offset: 9 }, end: { index: 0, offset: 14 } },
    why: 'expansion may never cross a block break, trimming may; a hard barrier for both leaves the edge stranded on the newline',
  },
  {
    id: 'sentinel-word-joiner-does-not-stop-expansion',
    tags: ['sentinel', 'latin'],
    strs: ['all done\u2060Start here'],
    start: { index: 0, offset: 6 },
    end: { index: 0, offset: 7 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 14 } },
    why: 'the REJECTED sentinel, pinned so it cannot be quietly reinstated: U+2060 WORD JOINER is Cf, WB4 ignores it, and done+U+2060+Start is ONE segment',
  },

  /* ── Nothing to snap to ───────────────────────────────────────────────── */
  {
    id: 'none-lone-plus',
    tags: ['punctuation'],
    strs: ['a + b'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 3 },
    expected: 'none',
    why: 'a span holding only punctuation has no word-like segment; the reader keeps exactly what they selected',
  },
  {
    id: 'none-em-dash',
    tags: ['punctuation'],
    strs: ['— dash'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 1 },
    expected: 'none',
    why: 'an em dash beside a word must not drag the word in',
  },
  {
    id: 'none-opening-quote',
    tags: ['punctuation'],
    strs: ['“quoted”'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 1 },
    expected: 'none',
    why: 'a curly quotation mark is punctuation, not part of the word it hugs',
  },
  {
    id: 'none-lone-emoji',
    tags: ['emoji'],
    strs: ['\u{1F600}'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 2 },
    expected: 'none',
    why: 'an emoji is a surrogate pair and carries no letter or number',
  },
  {
    id: 'none-emoji-zwj-sequence',
    tags: ['emoji'],
    strs: ['\u{1F469}\u200D\u{1F680}'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 5 },
    expected: 'none',
    why: 'a zero-width-joiner sequence is five code units and still nothing to snap to',
  },
  {
    id: 'none-single-space',
    tags: ['whitespace'],
    strs: ['aa bb'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 3 },
    expected: 'none',
    why: 'a whitespace-only span touches no word, so there is nothing to expand to',
  },
  {
    id: 'none-whitespace-run',
    tags: ['whitespace'],
    strs: ['aa  bb'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 4 },
    expected: 'none',
    why: 'the two-space version, so the answer cannot come from an off-by-one that happens to land right',
  },
  {
    id: 'none-zero-length-range',
    tags: ['latin'],
    strs: ['the quick brown fox'],
    start: { index: 0, offset: 5 },
    end: { index: 0, offset: 5 },
    expected: 'none',
    why: 'offset 5 is strictly inside `quick`: an implementation that expands before testing for a collapsed range turns a plain click into a word selection',
  },
  {
    id: 'none-no-entries',
    tags: ['empty'],
    strs: [],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 0 },
    expected: 'none',
    why: 'an empty strs is one empty block, not zero blocks, so {0,0} is the single position it contains',
  },
  {
    id: 'none-single-empty-entry',
    tags: ['empty'],
    strs: [''],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 0 },
    expected: 'none',
    why: 'the explicit spelling of the row above; both answer none rather than throwing',
  },

  /* ── Across `strs` entries ────────────────────────────────────────────── */
  {
    id: 'seam-word-split-across-two-entries',
    tags: ['latin', 'seam'],
    strs: ['the qui', 'ck brown fox'],
    start: { index: 0, offset: 5 },
    end: { index: 1, offset: 5 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 1, offset: 8 } },
    why: '`quick` straddles the entry boundary; an implementation that segments each entry alone sees `qui` and `ck`',
  },
  {
    id: 'seam-start-takes-the-later-entry',
    tags: ['latin', 'seam'],
    strs: ['alpha ', 'beta'],
    start: { index: 0, offset: 6 },
    end: { index: 1, offset: 2 },
    expected: { start: { index: 1, offset: 0 }, end: { index: 1, offset: 4 } },
    why: 'a position on a seam has two spellings; a start edge takes the later entry at offset 0, so it names a place inside an entry that exists',
  },
  {
    id: 'seam-end-takes-the-earlier-entry',
    tags: ['latin', 'seam'],
    strs: ['alpha', ' beta'],
    start: { index: 0, offset: 2 },
    end: { index: 1, offset: 0 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 5 } },
    why: 'the mirror: an end edge takes the earlier entry at its length. Each row feeds in the OTHER spelling, so a pass-through implementation fails both',
  },
  {
    id: 'seam-empty-entry-is-transparent',
    tags: ['latin', 'seam', 'empty'],
    strs: ['a', '', 'b'],
    start: { index: 1, offset: 0 },
    end: { index: 2, offset: 1 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 2, offset: 1 } },
    why: 'the empty entry sits between the two halves of `ab`: invisible to the answer, present in the mapping',
  },
  {
    id: 'seam-single-character-entries',
    tags: ['latin', 'seam', 'whitespace'],
    strs: ['a', 'b', 'c', ' ', 'd'],
    start: { index: 1, offset: 0 },
    end: { index: 4, offset: 1 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 4, offset: 1 } },
    why: 'every entry one character, so an off-by-one in the walk cannot hide inside a long entry',
  },

  /* ── The per-edge script gate ─────────────────────────────────────────── */
  {
    id: 'mixed-latin-inside-a-chinese-sentence',
    tags: ['mixed', 'cjk', 'latin'],
    strs: ['读一段 English 文字'],
    start: { index: 0, offset: 6 },
    end: { index: 0, offset: 13 },
    expected: { start: { index: 0, offset: 4 }, end: { index: 0, offset: 13 } },
    why: 'the Latin edge snaps and the Han edge stays; a gate applied per SELECTION rather than per EDGE moves both or neither',
  },
  {
    id: 'mixed-han-start-latin-end',
    tags: ['mixed', 'cjk', 'latin'],
    strs: ['文字 English'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 6 },
    expected: { start: { index: 0, offset: 1 }, end: { index: 0, offset: 10 } },
    why: 'the roles reversed, so neither edge is the one that happens to work',
  },
  {
    id: 'mixed-trim-start-onto-a-blocked-run',
    tags: ['mixed', 'cjk', 'latin', 'whitespace'],
    strs: ['English  文字'],
    start: { index: 0, offset: 8 },
    end: { index: 0, offset: 10 },
    expected: { start: { index: 0, offset: 9 }, end: { index: 0, offset: 10 } },
    why: 'the gate blocks EXPANSION into a blocked script, not TRIMMING onto one: a whitespace-to-text boundary is visible in every script',
  },
  {
    id: 'mixed-trim-end-onto-a-blocked-run',
    tags: ['mixed', 'cjk', 'latin', 'whitespace'],
    strs: ['文字  English'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 1 }, end: { index: 0, offset: 2 } },
    why: 'the mirror of the row above; the gate is consulted in two separate places and one is easy to get wrong',
  },
  {
    id: 'mixed-latin-between-thai',
    tags: ['mixed', 'thai', 'latin'],
    strs: ['สวัสดี English ครับ'],
    start: { index: 0, offset: 8 },
    end: { index: 0, offset: 10 },
    expected: { start: { index: 0, offset: 7 }, end: { index: 0, offset: 14 } },
    why: 'Thai segmentation is dictionary-driven guesswork; an English word inside it still snaps cleanly on both sides',
  },
  {
    id: 'cjk-han-edges-unchanged',
    tags: ['cjk'],
    strs: ['中文测试'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 3 },
    expected: { start: { index: 0, offset: 1 }, end: { index: 0, offset: 3 } },
    why: 'unchanged offsets, NOT none: there was a word, and the answer is that it must not move',
  },
  {
    id: 'thai-edges-unchanged',
    tags: ['thai'],
    strs: ['สวัสดีครับ'],
    start: { index: 0, offset: 3 },
    end: { index: 0, offset: 8 },
    expected: { start: { index: 0, offset: 3 }, end: { index: 0, offset: 8 } },
    why: 'Thai is written without visible word boundaries, so snapping would move the edge somewhere the reader cannot see',
  },
  {
    id: 'kana-long-vowel-mark-unchanged',
    tags: ['kana'],
    strs: ['ここでーす'],
    start: { index: 0, offset: 1 },
    end: { index: 0, offset: 4 },
    expected: { start: { index: 0, offset: 1 }, end: { index: 0, offset: 4 } },
    why: 'U+30FC is Script=Common; only Script_Extensions gives it Hiragana and Katakana, so a \\p{Script=…} gate calls this snappable and is wrong',
  },
  {
    id: 'astral-han-blocks-the-start-edge',
    tags: ['astral', 'cjk', 'mixed', 'latin'],
    strs: ['\u{20000} test'],
    start: { index: 0, offset: 0 },
    end: { index: 0, offset: 5 },
    expected: { start: { index: 0, offset: 0 }, end: { index: 0, offset: 7 } },
    why: 'U+20000 is one astral Han character; read as two lone surrogates it is Script=Unknown and sails past the gate, taking the start edge with it',
  },
  {
    id: 'astral-han-edges-unchanged',
    tags: ['astral', 'cjk'],
    strs: ['\u{20000}\u{20001}'],
    start: { index: 0, offset: 2 },
    end: { index: 0, offset: 4 },
    expected: { start: { index: 0, offset: 2 }, end: { index: 0, offset: 4 } },
    why: 'the pure astral case: offsets are code units, so both edges sit on surrogate-pair boundaries and neither may move',
  },
]
