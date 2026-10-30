import type { PaintRect } from 'foliate-js/overlayer.js'

/**
 * Where a highlight's band sits relative to the words it marks.
 *
 * foliate draws marks from `range.getClientRects()`, and those rects are the
 * font's EM BOX — ascent above the baseline plus descent below it — not the
 * ink. The two are not the same shape, and for a text face they are not even
 * close. Measured in the running app, Literata at 21px:
 *
 *     rect            31px tall  (ascent 25 + descent 6)
 *     ink above       14.7px     (cap height)
 *     ink below        4.8px     (descender)
 *     space ABOVE     10.3px
 *     space BELOW      1.2px
 *
 * So the band sat almost ten pixels clear of the capitals and barely one below
 * the descenders — a highlighter held crooked. It is not a rounding error; it
 * is the ascent metric, which a text face makes generous to leave room for
 * diacritics that most lines do not contain.
 *
 * The fix is to move the band down by half the difference, which equalises the
 * two gaps without changing the band's height — the mark keeps the weight it
 * was designed with and gains symmetry. Shrinking it instead would be a second,
 * unasked-for change to how strong a mark looks.
 *
 * Expressed as a FRACTION of each rect's height rather than as a pixel
 * constant, because one page has more than one font size in it: a heading, a
 * block quote and a footnote all draw their own rects, and a constant tuned for
 * body text would sit wrong on every one of them.
 */

/**
 * The string the typeface is measured with.
 *
 * Ascenders and descenders, no capitals — and that is the correction that made
 * this actually look right. The first version probed `Hy`, taking `H` as the
 * top of the text. But `H` is the CAP HEIGHT, and in a serif face the
 * ascenders of `b d f h k l` rise above it: Literata at 21px puts the cap at
 * 14.72 and the ascender at 16.42. Balancing to the cap left the band 0.85px
 * low, which measured as equal against the wrong reference and was plainly
 * lopsided on screen — the top gap visibly tighter than the bottom, because
 * ordinary prose is full of `h`, `l` and `d` poking above where the model said
 * the text stopped.
 *
 * Capitals are deliberately absent: they are shorter than the ascenders, so
 * they cannot widen the box, and including accented ones (Å, Ä) would balance
 * every line against a height almost no line reaches.
 *
 * A FIXED probe rather than the marked words, so the band is the same shape on
 * every line. Measuring the actual text would give a line of "no one" a
 * different band from a line of "highlight", which reads as the mark wobbling
 * as the eye moves down the page.
 */
const PROBE = 'bdfhklgjpqy'

/**
 * The probe for scripts a Latin one says nothing about.
 *
 * A CJK ideograph fills nearly the whole em box, so its ink sits where Latin
 * ink does not: measuring `bdfhklgjpqy` against a page of Chinese reports the
 * generous Latin ascent gap that the ideographs do not leave, and the band
 * gets pushed down about 3.7px at 21px — off a page of text that was already
 * centred. Measuring an ideograph instead reports gaps near zero, so the
 * correction is near zero, which is the right answer: CJK glyphs are centred
 * in the em box and need no help.
 *
 * `永` is the conventional shape for this — the eight strokes cover the full
 * body — and `国` is a dense square that reaches the box on all sides.
 */
const PROBE_IDEOGRAPHIC = '永国'

/**
 * Scripts whose ink does not follow Latin ascender/descender geometry.
 *
 * Deliberately narrow: CJK and Hangul, which fill the em box. Scripts with
 * their own vertical extremes — Arabic, Devanagari, Thai — are NOT here,
 * because their ink genuinely does extend above and below in a way the Latin
 * probe approximates, and a wrong probe would be worse than a rough one.
 */
const IDEOGRAPHIC = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/** Which probe represents the text this element actually holds. */
function probeFor(at: Element | null | undefined): string {
  const sample = (at?.textContent ?? '').slice(0, 200)
  return IDEOGRAPHIC.test(sample) ? PROBE_IDEOGRAPHIC : PROBE
}

/* `PaintRect` is imported rather than restated. It was declared here AND in
 * `vite-env.d.ts`, which is two contracts for one shape and the usual outcome:
 * this copy lacked `right` and `bottom`, which foliate's line painters read. */
export type { PaintRect }

/**
 * One scratch context per document, so measuring costs no allocation.
 *
 * The ratio itself is NOT cached, and that is the whole design. An earlier
 * version cached it per font shorthand and was wrong in a way that took three
 * measurements to see: marks are drawn when a section renders, which is before
 * the book's webfont arrives, so the canvas measured the fallback — Georgia,
 * ascent 19 against Literata's 25 — and cached a ratio for a font the reader
 * would never see.
 *
 * Two guards were tried against that and both failed silently. `fonts.check`
 * handed the whole stack answers true because Georgia is a system font.
 * Handed only the primary family it ALSO answers true, because a family the
 * FontFaceSet has never heard of is assumed to be a system font — so it
 * reported ready while `measureText` was demonstrably resolving to the
 * fallback.
 *
 * Measuring every time removes the question. Whatever is rendering right now is
 * what gets balanced: while the fallback is on screen the band is balanced for
 * the fallback, which is correct, because that is the text the reader is
 * looking at. `session.ts` redraws marks when `fonts.ready` settles, and the
 * band settles with them. A `measureText` is microseconds and a mark is drawn
 * once per section render.
 */
const contexts = new WeakMap<Document, CanvasRenderingContext2D>()

function context(doc: Document): CanvasRenderingContext2D | null {
  const held = contexts.get(doc)
  if (held) return held
  const made = doc.createElement('canvas').getContext('2d')
  if (made) contexts.set(doc, made)
  return made
}

/**
 * How far down a rect must move, as a fraction of its height.
 *
 * Zero when the font cannot be measured, which leaves the band exactly where
 * foliate put it.
 */
function offsetRatio(doc: Document, font: string, probe: string): number {
  const ctx = context(doc)
  if (!ctx) return 0
  ctx.font = font

  return balanceRatio(ctx.measureText(probe))
}

/** The four numbers the ratio is derived from. */
export interface InkMetrics {
  readonly fontBoundingBoxAscent: number
  readonly fontBoundingBoxDescent: number
  readonly actualBoundingBoxAscent: number
  readonly actualBoundingBoxDescent: number
}

/**
 * The arithmetic, separated from the canvas so it can be tested.
 *
 * `above` and `below` are the two gaps between the em box — which is what
 * foliate draws — and the ink. Half their difference is what closes the gap
 * between them, and dividing by the em height makes it a ratio that holds at
 * any font size, so a heading and a footnote both get a band on their own
 * words rather than one tuned for body text.
 */
export function balanceRatio(metrics: InkMetrics): number {
  const above = metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent
  const below = metrics.fontBoundingBoxDescent - metrics.actualBoundingBoxDescent
  const em = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent

  // A font whose metrics are unavailable reports zeroes; dividing by that
  // would poison every rect on the page with NaN.
  if (!(em > 0) || !Number.isFinite(above) || !Number.isFinite(below)) return 0
  return (above - below) / 2 / em
}

/**
 * One band per line, instead of one per inline fragment.
 *
 * `getClientRects()` returns a rect per rendered box, and a line of real prose
 * is many boxes. Measured on a line carrying a superscript and a 1.5em run:
 *
 *     body       top 133  height 31
 *     superscript top 129  height 26
 *     larger run  top 121  height 47
 *
 * Drawn as they come, that is a stepped, ragged stripe rather than a
 * highlighter stroke — which is exactly what maths, footnote markers and
 * italic runs produce, and what the eye reads as broken. Nested inline
 * elements also emit the SAME rect twice, and two identical bands under
 * `multiply` darken where they overlap, so the patch under a marked `<em>`
 * came out deeper than the rest of the mark.
 *
 * So the rects are grouped into lines and each line gets ONE band, taking its
 * vertical box from the WIDEST fragment on that line — the dominant run of
 * prose, not the superscript that happens to sit highest. A tall element may
 * then extend past the band, which is what a real highlighter does too.
 *
 * Runs separated by a wide horizontal gap are NOT merged: in a paginated book
 * two columns share a vertical range, and joining them would paint a band
 * straight across the gutter.
 *
 * TWO LIMITS THIS CANNOT CLOSE, both worth knowing before trusting it:
 *
 *   HIT TESTING DIVERGES. foliate stores `range.getClientRects()` when the
 *   annotation is added and hit-tests against those, while the painter draws
 *   these. So the clickable area is the original fragments and the visible
 *   band is this — offset by the balance shift (3.7px at 21px Literata) and
 *   spanning the gaps between fragments. Roughly 88% of the band is both
 *   visible and clickable; the mismatch is a thin strip at each edge. Closing
 *   it means patching `Overlayer.add` to store what the painter returned,
 *   which is a change to a pinned dependency and a deliberate decision rather
 *   than a tidy-up.
 *
 *   ONE FONT PER MARK. The ratio comes from the element the range STARTS in,
 *   and is applied to every band the mark produces. A mark running from body
 *   text into a heading gets the body ratio throughout. Per-rect provenance is
 *   not available: `getClientRects` returns geometry with no link back to the
 *   node each box came from.
 */
/** Two boxes are on one line when each one's vertical centre is inside the
 *  other. Symmetric by construction, so grouping cannot depend on order. */
function sameLine(a: PaintRect, b: PaintRect): boolean {
  const centreA = a.top + a.height / 2
  const centreB = b.top + b.height / 2
  return (
    centreA > b.top && centreA < b.top + b.height &&
    centreB > a.top && centreB < a.top + a.height
  )
}

/** Drop empty rects and the exact duplicates nested inline elements emit. */
function distinct(rects: readonly PaintRect[]): PaintRect[] {
  const seen = new Set<string>()
  return rects.filter((r) => {
    if (!(r.width > 0 && r.height > 0)) return false
    const key = `${r.left}:${r.top}:${r.width}:${r.height}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Group boxes that share a line, by the symmetric test above.
 *
 * A rect matching SEVERAL groups merges them all. Taking the first match alone
 * left the outcome dependent on arrival order again by a different route: a
 * box overlapping two half-formed groups would join one and leave the other
 * beside it, so one visual line came out as two bands.
 */
function groupIntoLines(rects: readonly PaintRect[]): PaintRect[][] {
  const lines: PaintRect[][] = []
  for (const rect of [...rects].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const matching = lines.filter((group) => group.some((other) => sameLine(rect, other)))
    if (matching.length === 0) {
      lines.push([rect])
      continue
    }
    const [keep, ...absorbed] = matching as [PaintRect[], ...PaintRect[][]]
    keep.push(rect, ...absorbed.flat())
    for (const group of absorbed) lines.splice(lines.indexOf(group), 1)
  }
  return lines
}

/**
 * Split one line into horizontally contiguous runs.
 *
 * A gap wider than the tallest box on the line is a column gutter, not a word
 * space. That threshold is a judgement rather than a measurement: it is far
 * larger than any inter-word gap and far smaller than the gutter of a
 * two-column layout, and the tests pin both ends.
 */
function splitRuns(line: readonly PaintRect[]): PaintRect[][] {
  const gap = Math.max(...line.map((r) => r.height))
  const runs: PaintRect[][] = []
  let end = -Infinity
  for (const rect of [...line].sort((a, b) => a.left - b.left)) {
    const open = runs[runs.length - 1]
    if (open && rect.left - end <= gap) open.push(rect)
    else {
      runs.push([rect])
      end = -Infinity
    }
    end = Math.max(end, rect.left + rect.width)
  }
  return runs
}

/** One band covering a run, taking its box from the run's widest fragment. */
function bandFor(run: readonly PaintRect[]): PaintRect {
  const dominant = run.reduce((a, b) => (b.width > a.width ? b : a))
  const left = Math.min(...run.map((r) => r.left))
  const right = Math.max(...run.map((r) => r.left + r.width))
  return {
    left,
    right,
    width: right - left,
    top: dominant.top,
    bottom: dominant.top + dominant.height,
    height: dominant.height,
  }
}

function mergeByLine(rects: readonly PaintRect[]): PaintRect[] {
  return groupIntoLines(distinct(rects)).flatMap((line) => splitRuns(line).map(bandFor))
}

/**
 * Move each rect so the band is optically centred on the words.
 *
 * `at` is the element the marked text lives in, and measuring THAT rather than
 * body is what makes this hold up. Body's font is the book's default; a mark
 * can sit in a heading, a pull quote or a code span, and an EPUB is free to
 * give any of them a family of its own. Balanced against body, a mark on a
 * display face gets a shift computed for a face it is not drawn in.
 *
 * Falls back to body when the element cannot be reached, which is the previous
 * behaviour and right for the overwhelmingly common case of body text.
 */
export function balanceRects(
  rects: readonly PaintRect[],
  doc: Document | null,
  at?: Element | null,
): PaintRect[] {
  const view = doc?.defaultView
  const body = doc?.body
  if (!view || !body) return mergeByLine(rects)

  /* The element must belong to THIS document. A stale one from a section that
   * has been torn down would measure against a layout that no longer exists. */
  const target = at && at.ownerDocument === doc ? at : body
  const style = view.getComputedStyle(target)

  /* Horizontal text only. The whole correction is "move the band DOWN by half
   * the difference between the gaps above and below the ink", and in vertical
   * writing those gaps are to the left and right — the same shift applied to
   * `top` would slide the band along the line instead of across it. Vertical
   * books are not something Paper claims to support; leaving their bands where
   * foliate put them is the honest behaviour until it does. */
  if (style.writingMode !== 'horizontal-tb') return mergeByLine(rects)
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  const merged = mergeByLine(rects)
  const ratio = offsetRatio(doc, font, probeFor(at))
  if (ratio === 0) return merged

  return merged.map((rect) => {
    const top = rect.top + rect.height * ratio
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      top,
      bottom: top + rect.height,
      height: rect.height,
    }
  })
}
