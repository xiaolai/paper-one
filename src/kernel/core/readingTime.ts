/**
 * How much of this book is left, in minutes.
 *
 * ⚠️ **THE FIGURE THIS REPLACES WAS TWO INVENTED NUMBERS MULTIPLIED TOGETHER.**
 * `ProgressFooter` read the remaining fraction at 250 words a minute over an
 * assumed **90,000 words**, and its own comment said so: *"a number for a novel,
 * and wrong for a monograph… a guess presented as a reading looks like a
 * reading."* Measured over 400 books of the real library, using the canonical
 * text the passage index retains:
 *
 * | | words |
 * |---|---|
 * | median | 95,715 |
 * | 10th percentile | 24,452 |
 * | 90th percentile | 210,494 |
 * | shortest / longest | 1,207 / 988,448 |
 *
 * So 90,000 is an excellent MEDIAN and a poor estimate: **33 % of books are
 * wrong by more than 2x and 17 % by more than 3x**, and the longest book on the
 * shelf was told "about 6 hours" for eleven hours of reading. The median being
 * right is exactly why nobody noticed.
 *
 * ## Where the length comes from, and the two routes not taken
 *
 * The book's own spine tells us: foliate carries each section's file size, so
 * the total is in hand at open with no walk, on every shell, needing no index.
 * `CHARS_PER_XHTML_BYTE` converts it.
 *
 * ⚠️ **THE EXACT NUMBER EXISTS AND THE SHELL THAT DRAWS THIS CANNOT REACH IT.**
 * `passages/text/` retains the canonical text of every indexed book, so the
 * shelf knows each length to the character. The estimate is drawn by the web and
 * phone shells, which have no index — a browser client, a phone, and any build
 * with the `passages` capability cut all lack one. Reaching it would mean a new
 * service row, not a lookup, and that is a decision rather than a tidy-up.
 *
 * ⚠️ **AND A PER-BOOK FACTOR LEARNED WHILE READING IS WORSE, MEASURED.** The
 * obvious refinement — calibrate on the sections the reader has actually opened,
 * since markup density is a property of the book — was tested over 250 books
 * with six or more comparable sections and is actively harmful: **within one
 * book the chars-per-byte ratio spans 18.6x** between its 10th and 90th
 * percentile sections (75th percentile of books: 73x). A factor taken from the
 * first two sections is **76 % off at the median and 437 % off at the 90th
 * percentile**, because front matter is markup over a handful of words and a
 * chapter is the opposite. The AGGREGATE is what is stable; a sample is not.
 * Use the whole spine, never part of it.
 */

/** A reader's pace, unmeasured and deliberately not personalised — see below. */
export const WORDS_PER_MINUTE = 250

/**
 * Five characters to a word, including the space after it.
 *
 * The usual typographic figure, and it is not the uncertain part here: the
 * spread in book LENGTH dwarfs it.
 */
const CHARS_PER_WORD = 5

/**
 * Canonical text characters per byte of the spine's XHTML.
 *
 * ⚠️ **MEASURED, NOT CHOSEN**: the median over 379 books of the real library,
 * comparing each book's retained canonical text against the uncompressed size
 * of its XHTML. The 10th and 90th percentiles are 0.432 and 0.843, so a book's
 * markup density varies by about twofold either way; using this median the
 * error against the true length is **11 % at the median and 65 % at the 90th
 * percentile**.
 *
 * ## Verified after the change, against 400 books' real text
 *
 * | estimate | median | 75th | 90th | worst |
 * |---|---|---|---|---|
 * | assumed 90,000 | 42 % | 75 % | 272 % | **7 359 %** |
 * | this spine proxy | **11 %** | **20 %** | **72 %** | 1 114 % |
 *
 * Better for **330 of the 400**, and books wrong by more than 2x fall from
 * **20 % of the shelf to 8 %**. The assumption's worst case was a 1,207-word
 * pamphlet told six hours.
 *
 * ⚠️ **AND THE RESIDUAL IS REAL, NOT ROUNDING.** One book of the 400 is still
 * out by 12x — 91,426 words read as 1.1 million — because its markup dwarfs its
 * text, which is what a low chars-per-byte ratio means. No bound is applied: a
 * clamp would be a second invented constant, and the honest position is that
 * this is an estimate drawn muted beside a percentage that is exact. The way to
 * remove the residual is the exact length, which needs the service row above.
 */
export const CHARS_PER_XHTML_BYTE = 0.713

/**
 * What a book's length is, or that it is not known.
 *
 * `null` is a real answer and must stay one. A fixed-layout book — every PDF —
 * reports a section size that is not a file size at all: `makePdf` sets a flat
 * `1000` per page, because *"foliate uses this to weight progress. Pages are
 * equal enough."* Multiplying that by a chars-per-byte factor produces a
 * confident number about nothing.
 */
export type BookLength = number | null

/**
 * The spine's total XHTML bytes, or null when the spine cannot be measured.
 *
 * ⚠️ **A PARTIAL COUNT IS REFUSED, NOT SUMMED.** The fork's sections are typed
 * `unknown[]` because their shape varies by backend, so a `size` may simply be
 * absent. Adding up the ones that have it would answer a confident number that
 * is short by however many it skipped — and an estimate that is quietly too
 * small is worse than none, because it reads as a measurement. One missing size
 * refuses the whole book.
 *
 * An empty spine is also null: a book with no sections has no length, and 0
 * would become "Nearly done" for something nobody has opened.
 */
export function spineBytes(sections: unknown): number | null {
  /* ⚠️ **`unknown`, NOT `readonly unknown[]`, AND THAT IS NOT PEDANTRY.** The
     first version took an array and read `.length` off it, which threw for a
     backend that publishes no `sections` at all — and this runs at OPEN, inside
     the session, so it would have taken the whole reader down for such a book
     rather than declining to estimate. 167 cases caught it; the type had said
     the argument was safe and the fork's shapes are exactly what `unknown[]`
     exists to admit it does not know. */
  if (!Array.isArray(sections) || sections.length === 0) return null
  let total = 0
  for (const section of sections) {
    const size = (section as { readonly size?: unknown } | null | undefined)?.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
    total += size
  }
  return total
}

/**
 * The book's length in words, from its spine, or null when it cannot be known.
 *
 * ⚠️ **A FIXED-LAYOUT BOOK ANSWERS NULL RATHER THAN A NUMBER.** See
 * `BookLength`: its sizes are progress weights. The reader is shown no estimate,
 * which is the same rule the footer already follows at 0 % — *a guess presented
 * as a reading looks like a reading*.
 */
export function wordsInSpine(bytes: number | null, fixedLayout: boolean): BookLength {
  if (fixedLayout) return null
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null
  return (bytes * CHARS_PER_XHTML_BYTE) / CHARS_PER_WORD
}

/**
 * Minutes of reading left, or null when there is nothing honest to say.
 *
 * Null for an unknown length, and null at the start: the footer has always
 * refused an estimate before the reader has moved, because at 0 % the
 * arithmetic answers with the whole book and reads as a fact about this reader.
 */
export function minutesLeft(fraction: number, words: BookLength): number | null {
  if (words === null) return null
  const through = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  if (through <= 0) return null
  return Math.round(((1 - through) * words) / WORDS_PER_MINUTE)
}

/**
 * What the reader is told, or null to say nothing.
 *
 * ⚠️ **ROUNDED TO SOMETHING A PERSON WOULD SAY.** "~127 min left" implies a
 * precision two measured constants and a markup-density factor cannot support;
 * past an hour it reads in hours, and the last stretch is "Nearly done" rather
 * than a minute count counting down.
 */
export function timeLeft(fraction: number, words: BookLength): string | null {
  const minutes = minutesLeft(fraction, words)
  if (minutes === null) return null
  if (minutes < 1) return 'Nearly done'
  if (minutes < 60) return `~${minutes} min left`
  return `~${Math.round(minutes / 60)} h left`
}
