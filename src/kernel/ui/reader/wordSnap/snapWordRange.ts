/**
 * The word-boundary snapping policy, in one pure function.
 *
 * The policy's honest name is **expand the touched word, trim edge
 * separators** — emphatically NOT "move each edge to the nearest boundary".
 * The two agree often enough to be mistaken for each other and disagree where
 * it matters: in `abc`, a start edge at offset 2 is nearer to 3, and the right
 * answer is 0, because the reader is touching `abc` and wants `abc`.
 *
 * - An edge strictly inside a word-like segment moves **outward** to that
 *   segment's own boundary: `start` back to its beginning, `end` forward to
 *   its end.
 * - An edge in whitespace or punctuation moves **inward**: `start` forward to
 *   the next word's beginning, `end` back to the previous word's end. So a
 *   drag that overshoots by a space gives the space up rather than swallowing
 *   the next whole word.
 * - A boundary belongs to the segment the edge is looking into: for `start`
 *   that is the segment to its right, for `end` the segment to its left. The
 *   asymmetry is deliberate — a drag beginning just after `the` does not want
 *   `the` — and it is what makes both rules above the same rule.
 *
 * Each edge is decided on its own, so an English word inside a Chinese
 * sentence snaps while the Han edge beside it stays exactly where the reader
 * put it.
 *
 * Positions are `{ index, offset }` into `strs`, the flattened text of a run
 * of blocks. `\n` inside `strs` is the block sentinel: UAX #29 makes LF a
 * mandatory break on both sides, so no word-like segment ever spans one and
 * expansion cannot cross a block. That guarantee is the entire reason the
 * sentinel is `\n` and not an invisible character — U+2060 WORD JOINER is
 * General_Category `Cf`, WB4 ignores it, and `done<U+2060>Start` is ONE
 * segment. `snapWordRange.test.ts` pins that failure so the choice cannot be
 * quietly reversed.
 *
 * This module is pure. It names no `document`, no `window`, no `Selection`,
 * no `Range` and no `Node`; its test reads this file back and scans it with
 * the comments stripped, which is the only reason this paragraph may name them
 * at all. Nothing here is DOM-shaped, which is what lets the whole policy be
 * tested in a lane with no DOM in it.
 */

import { isSnappableScript, isWordLike, resolveSegmenterLocale } from './classify'

/** A position in `strs`: which entry, and how far into it. */
export interface Edge {
  readonly index: number
  readonly offset: number
}

export interface SnappedRange {
  readonly start: Edge
  readonly end: Edge
}

export interface SnapOptions {
  /** A tag from the book, in whatever shape it arrived; validated by WI-2's
   *  `resolveSegmenterLocale` rather than trusted. */
  readonly locale?: string
}

/** A word-like segment, in flat coordinates over the joined text. */
interface Word {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Snap a selection's two edges to word boundaries, or decline.
 *
 * Three outcomes, three distinct signals, and the difference between them is
 * load-bearing for every caller downstream:
 *
 * - **A range** — use it. It may be equal to the input, which means "already
 *   aligned, nothing to mutate", not "nothing happened".
 * - **`null`** — there was no word-like segment to snap to. Leave the
 *   reader's selection exactly as it is.
 * - **A throw** — the caller passed a position that does not exist, or an end
 *   before its start. That is a bug at the call site, and it fails here, where
 *   it is diagnosable, rather than becoming a quietly wrong selection.
 */
export function snapWordRange(
  strs: readonly string[],
  start: Edge,
  end: Edge,
  opts: SnapOptions,
): SnappedRange | null {
  /* An empty `strs` is one empty block, not zero blocks: `{0,0}` is then the
   * single position it contains, which is what makes an empty book answer
   * `null` while `{0,1}` in it still throws. */
  const blocks: readonly string[] = strs.length === 0 ? [''] : strs

  /* Shape and range first, before the zero-length check, so a caller bug can
   * never be masked by a benign-looking `null`. */
  const flatStart = flatten(blocks, start, 'start')
  const flatEnd = flatten(blocks, end, 'end')

  /* Compared as flat positions, because a seam has two spellings and they
   * denote the same place. Never normalised by swapping: the caller reads
   * selection direction from anchor and focus, and silently reordering the
   * edges here would hide a direction bug there. */
  if (flatStart > flatEnd) {
    throw new RangeError(
      `snapWordRange: start ${describe(start)} is after the end ${describe(end)}`,
    )
  }
  if (flatStart === flatEnd) return null

  /* Checked per call, never at module load: a host without the API must lose
   * the snap, not the module. */
  if (typeof Intl.Segmenter !== 'function') return null

  const words = findWords(blocks.join(''), opts.locale)
  const touched = words.filter((word) => word.start < flatEnd && word.end > flatStart)
  if (touched.length === 0) return null

  const snappedStart = snapStart(words, flatStart)
  const snappedEnd = snapEnd(words, flatEnd)

  /* An invariant, not a guard. Every branch above either keeps an edge where
   * it was or moves it away from the other one, and `touched` is non-empty, so
   * a collapse cannot happen — it is proved, not hoped for. Making it throw
   * keeps `null` meaning one thing only: there was nothing to snap to. If a
   * future policy change makes this reachable, it says so out loud instead of
   * publishing an empty selection. */
  if (snappedStart >= snappedEnd) {
    throw new Error(
      `snapWordRange: snapping collapsed ${flatStart}..${flatEnd} to ` +
        `${snappedStart}..${snappedEnd}; the policy no longer holds its own invariant`,
    )
  }

  return { start: startEdge(blocks, snappedStart), end: endEdge(blocks, snappedEnd) }
}

/** `{index:0, offset:3}`, for an error a reader has to act on. */
function describe(edge: Edge): string {
  return `{index:${edge.index}, offset:${edge.offset}}`
}

/**
 * An edge as a single offset into the joined text, validated on the way.
 *
 * Every rejection is a `RangeError` rather than a clamp. A fractional offset
 * is the one worth spelling out: it comes from arithmetic on a position that
 * went wrong upstream, and `Math.min(offset, length)` would turn that into a
 * selection that is subtly off with nothing anywhere reporting it.
 */
function flatten(blocks: readonly string[], edge: Edge, label: string): number {
  const { index, offset } = edge
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
    throw new RangeError(
      `snapWordRange: ${label} index ${index} is outside strs (0..${blocks.length - 1})`,
    )
  }
  const block = blocks[index] ?? ''
  if (!Number.isInteger(offset) || offset < 0 || offset > block.length) {
    throw new RangeError(
      `snapWordRange: ${label} offset ${offset} is outside entry ${index} (0..${block.length})`,
    )
  }
  let flat = offset
  for (let i = 0; i < index; i += 1) flat += (blocks[i] ?? '').length
  return flat
}

/**
 * The word-like segments of the whole text, in flat coordinates.
 *
 * Word-like by character, through WI-1's `isWordLike`, never through the
 * segment record's own flag — the engines disagree about numbers, and reading
 * the flag would make `42` a word in Node and not in WebKit.
 *
 * Non-word segments are not collected at all: both halves of the policy are
 * expressible over the words alone, so there is no second list to keep in
 * step with this one.
 */
function findWords(text: string, locale: string | undefined): Word[] {
  const segmenter = new Intl.Segmenter(resolveSegmenterLocale(locale), { granularity: 'word' })
  const words: Word[] = []
  for (const part of segmenter.segment(text)) {
    if (!isWordLike(part.segment)) continue
    words.push({ start: part.index, end: part.index + part.segment.length, text: part.segment })
  }
  return words
}

/**
 * Where a start edge belongs.
 *
 * Inside a word — its beginning included, its end excluded, because a start
 * edge looks forward — expand back to that word's beginning. Anywhere else,
 * trim forward to the next word's beginning.
 *
 * The script gate applies to the word actually touched. A word in a script
 * written without visible boundaries keeps the edge exactly where the reader
 * put it; a space or a comma carries no script and does not stop the trim,
 * which is why WI-1's gate blocks scripts and nothing else.
 */
function snapStart(words: readonly Word[], position: number): number {
  const inside = words.find((word) => word.start <= position && position < word.end)
  if (inside) return isSnappableScript(inside.text) ? inside.start : position
  const next = words.find((word) => word.start >= position)
  /* `next` is always found on any reachable path: the caller has already
   * established that some word overlaps the span, and a word overlapping it
   * that does not contain this position must begin after it. The fallback is
   * the conservative answer anyway — leave the edge alone. */
  return next ? next.start : position
}

/** The mirror of `snapStart`: an end edge looks backward, so a word's end is
 *  included and its beginning excluded. */
function snapEnd(words: readonly Word[], position: number): number {
  const inside = words.find((word) => word.start < position && position <= word.end)
  if (inside) return isSnappableScript(inside.text) ? inside.end : position
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]
    if (word && word.end <= position) return word.end
  }
  return position
}

/**
 * A flat position as a start edge: the **latest** spelling.
 *
 * A position on the seam between two entries can be written as the end of the
 * earlier one or the beginning of the later one. A start edge takes the later
 * entry at offset 0, so it names a place inside an entry that exists rather
 * than a phantom past the end of one — which is what the caller mapping this
 * back to a live text run needs.
 */
function startEdge(blocks: readonly string[], position: number): Edge {
  let consumed = 0
  let edge: Edge = { index: 0, offset: 0 }
  for (let i = 0; i < blocks.length; i += 1) {
    if (consumed <= position) edge = { index: i, offset: position - consumed }
    consumed += (blocks[i] ?? '').length
  }
  return edge
}

/** The mirror: an end edge takes the **earliest** spelling, the earlier entry
 *  at its length, for the same reason. */
function endEdge(blocks: readonly string[], position: number): Edge {
  let consumed = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const length = (blocks[i] ?? '').length
    if (consumed + length >= position) return { index: i, offset: position - consumed }
    consumed += length
  }
  const last = blocks.length - 1
  return { index: last, offset: (blocks[last] ?? '').length }
}
