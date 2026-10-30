import { describe, expect, it } from 'vitest'
import { balanceRatio, balanceRects, type InkMetrics, type PaintRect } from './markGeometry'

/**
 * Real numbers, measured off the running app with the module's own probe.
 *
 * Note the ascent: 16.42, the ASCENDER. An earlier version probed `Hy` and got
 * 14.72, the cap height, which balanced the band against a line of capitals
 * rather than against prose — visibly low, by 0.85px.
 */
const LITERATA: InkMetrics = {
  fontBoundingBoxAscent: 25,
  fontBoundingBoxDescent: 6,
  actualBoundingBoxAscent: 16.42,
  actualBoundingBoxDescent: 4.83,
}

/** What `Hy` measures in the same face — cap height, not the ascender. */
const LITERATA_CAPS: InkMetrics = { ...LITERATA, actualBoundingBoxAscent: 14.72 }

/** Georgia at the same size: what the canvas measures before the webfont
 *  lands, and the ratio an earlier version cached forever. */
const FALLBACK: InkMetrics = {
  fontBoundingBoxAscent: 19,
  fontBoundingBoxDescent: 5,
  actualBoundingBoxAscent: 15.88,
  actualBoundingBoxDescent: 4.55,
}

const ZERO: InkMetrics = {
  fontBoundingBoxAscent: 0,
  fontBoundingBoxDescent: 0,
  actualBoundingBoxAscent: 0,
  actualBoundingBoxDescent: 0,
}

/** A complete rect. All six edges, because foliate's line painters read the
 *  ones a naive fixture leaves out — see `PaintRect`. */
function rect(left: number, top: number, width: number, height: number): PaintRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

/**
 * A stand-in Document whose canvas answers per probe string.
 *
 * This is what lets the tests exercise the REAL path — `balanceRects` reading a
 * computed font, measuring through a canvas, and choosing a probe. Every test
 * used to pass `null` here, which skipped all of that: the probe could be
 * reverted to `Hy` and the suite stayed green while the band went visibly
 * crooked. `byProbe` keys on the string actually measured, so a change of probe
 * changes the answer.
 */
function fakeDoc(options: {
  byProbe: Record<string, InkMetrics>
  writingMode?: string
  contextAvailable?: boolean
  /** Fonts per element, so a test can tell body apart from the marked run. */
  fontFor?: (target: Element) => string
  /** Metrics per font, so measuring the WRONG element changes the answer. */
  byFont?: Record<string, Record<string, InkMetrics>>
}): Document {
  /* Keyed by font AND probe. Keyed by probe alone, a regression that measured
   * `body` for every mark was undetectable: both elements resolved the same
   * metrics, so the assertion passed either way. */
  const metricsFor = (font: string, text: string) =>
    options.byFont?.[font]?.[text] ?? options.byProbe[text] ?? ZERO
  const doc = {
    body: {} as unknown as HTMLElement,
    createElement: () => ({
      getContext: () =>
        options.contextAvailable === false
          ? null
          : {
              font: '',
              measureText(this: { font: string }, text: string) {
                return metricsFor(this.font, text)
              },
            },
    }),
    defaultView: {
      /* Answers PER TARGET. Ignoring the argument made a real bug invisible:
       * `balanceRects` could have measured `body` for every mark and this
       * suite would not have noticed, which is the whole point of it taking an
       * element at all. */
      getComputedStyle: (target: Element) => ({
        fontStyle: 'normal',
        fontWeight: '400',
        fontSize: '21px',
        fontFamily: options.fontFor?.(target) ?? '"Literata Variable", Georgia, serif',
        writingMode: options.writingMode ?? 'horizontal-tb',
      }),
    },
  }
  ;(doc.body as unknown as { ownerDocument: unknown }).ownerDocument = doc
  return doc as unknown as Document
}

/** The probe the module actually uses, and the one it used to use. */
const ASCENDER_PROBE = 'bdfhklgjpqy'
const CAP_PROBE = 'Hy'

describe('balanceRatio', () => {
  it('equalises the gaps above and below the ink', () => {
    const ratio = balanceRatio(LITERATA)
    const em = LITERATA.fontBoundingBoxAscent + LITERATA.fontBoundingBoxDescent
    const shift = em * ratio
    const above = LITERATA.fontBoundingBoxAscent - LITERATA.actualBoundingBoxAscent - shift
    const below = LITERATA.fontBoundingBoxDescent - LITERATA.actualBoundingBoxDescent + shift
    expect(above).toBeCloseTo(below, 6)
  })

  it('moves Literata down by the measured 3.70px at 21px', () => {
    expect(balanceRatio(LITERATA) * 31).toBeCloseTo(3.704, 2)
  })

  it('leaves a font whose em box is already centred alone', () => {
    expect(balanceRatio({
      fontBoundingBoxAscent: 20,
      fontBoundingBoxDescent: 10,
      actualBoundingBoxAscent: 15,
      actualBoundingBoxDescent: 5,
    })).toBe(0)
  })

  it('is a ratio, so it holds at any size', () => {
    expect(balanceRatio({
      fontBoundingBoxAscent: 50,
      fontBoundingBoxDescent: 12,
      actualBoundingBoxAscent: 32.84,
      actualBoundingBoxDescent: 9.66,
    })).toBeCloseTo(balanceRatio(LITERATA), 6)
  })

  it.each([
    ['all zero', ZERO],
    ['a NaN ascent', { ...LITERATA, actualBoundingBoxAscent: NaN }],
    ['an infinite descent', { ...LITERATA, fontBoundingBoxDescent: Infinity }],
    ['a negative em box', { ...ZERO, fontBoundingBoxAscent: -5 }],
  ])('refuses to derive a ratio from %s', (_label, metrics) => {
    // NaN reaching a rect would poison every coordinate on the page.
    expect(balanceRatio(metrics as InkMetrics)).toBe(0)
  })
})

describe('the probe the band is measured with', () => {
  const line = [rect(100, 133, 220, 31)]

  it('measures the ASCENDER, not the cap height', () => {
    /* The regression that shipped and looked equal against the wrong
     * reference. This goes through `balanceRects`, so the assertion depends on
     * which string the module measures: revert PROBE to `Hy` and the shift
     * becomes the cap-height one and this fails. The previous version called
     * the pure arithmetic directly and stayed green either way. */
    const doc = fakeDoc({
      byProbe: { [ASCENDER_PROBE]: LITERATA, [CAP_PROBE]: LITERATA_CAPS },
    })
    const shift = (balanceRects(line, doc)[0]?.top ?? 0) - 133
    expect(shift).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
    expect(shift).not.toBeCloseTo(31 * balanceRatio(LITERATA_CAPS), 3)
  })

  it('re-measures on every call, so a font that arrives late is picked up', () => {
    /* The cache that made this wrong for a whole session: the first draw
     * measured the fallback, cached its ratio, and every later mark inherited
     * a band balanced for a font nobody was looking at. */
    const metrics: Record<string, InkMetrics> = { [ASCENDER_PROBE]: FALLBACK }
    const doc = fakeDoc({ byProbe: metrics })

    const before = (balanceRects(line, doc)[0]?.top ?? 0) - 133
    expect(before).toBeCloseTo(31 * balanceRatio(FALLBACK), 4)

    metrics[ASCENDER_PROBE] = LITERATA // the webfont lands
    const after = (balanceRects(line, doc)[0]?.top ?? 0) - 133
    expect(after).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
    expect(after).not.toBeCloseTo(before, 3)
  })

  it('leaves the band alone when no canvas is available', () => {
    const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA }, contextAvailable: false })
    expect(balanceRects(line, doc)[0]?.top).toBe(133)
  })

  it.each(['vertical-rl', 'vertical-lr', 'sideways-rl', 'sideways-lr'])(
    'applies no vertical shift in %s writing',
    (writingMode) => {
      /* The correction moves the band DOWN, which is meaningless when the text
       * runs down the page. `sideways-*` does that too and does not start with
       * "vertical", which an exclusion list missed. */
      const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA }, writingMode })
      expect(balanceRects(line, doc)[0]?.top).toBe(133)
    },
  )
})

describe('one band per line', () => {
  /* The rects a real line produces: body text with a superscript and a 1.5em
   * run, plus the duplicates WebKit emits for nested inline elements. */
  const oneLine = [
    rect(100, 133, 220.7, 31),
    rect(321, 129, 110.6, 26),
    rect(321, 129, 110.6, 26),
    rect(432, 133, 104.3, 31),
    rect(537, 121, 180.1, 47),
    rect(537, 121, 180.1, 47),
  ]

  it('collapses a ragged line into one band on the dominant run', () => {
    const bands = balanceRects(oneLine, null)
    expect(bands).toHaveLength(1)
    expect(bands[0]?.height).toBe(31)
    expect(bands[0]?.top).toBe(133)
    expect(bands[0]?.left).toBe(100)
    expect(bands[0]?.right).toBeCloseTo(717.1, 1)
  })

  it('does not mutate the rects it was given', () => {
    /* Asserting against the same array the call received would let in-place
     * mutation rewrite its own oracle and still pass. */
    const input = [rect(100, 133, 200, 31)]
    const snapshot = JSON.parse(JSON.stringify(input))
    balanceRects(input, null)
    expect(input).toEqual(snapshot)
  })

  it('returns rects untouched when there is no document to measure', () => {
    const input = [rect(1, 2, 3, 4)]
    const snapshot = JSON.parse(JSON.stringify(input))
    expect(balanceRects(input, null)).toEqual(snapshot)
  })

  it('keeps separate lines separate', () => {
    expect(balanceRects([rect(100, 133, 200, 31), rect(100, 167, 150, 31)], null))
      .toHaveLength(2)
  })

  it('gives each column its OWN box across a gutter', () => {
    /* Two columns of different heights sharing a vertical range. The dominant
     * rect used to be chosen per LINE, so the narrower column inherited the
     * wider one's top and height and was drawn at the wrong size. Identical
     * geometry on both sides would have hidden that. */
    const columns = [rect(100, 130, 300, 34), rect(900, 133, 120, 28)]
    const bands = balanceRects(columns, null)
    expect(bands).toHaveLength(2)
    const ordered = [...bands].sort((a, b) => a.left - b.left)
    expect(ordered[0]?.height).toBe(34)
    expect(ordered[0]?.top).toBe(130)
    expect(ordered[1]?.height).toBe(28)
    expect(ordered[1]?.top).toBe(133)
  })

  it('still joins fragments separated by an ordinary word space', () => {
    expect(balanceRects([rect(100, 133, 200, 31), rect(306, 133, 100, 31)], null))
      .toHaveLength(1)
  })

  it('groups the same rects whatever order they arrive in', () => {
    /* Membership must be symmetric: a tall inline run used to absorb the line
     * above it depending only on which rect the loop reached first. */
    const scattered = [rect(100, 121, 180, 47), rect(300, 133, 200, 31)]
    expect(balanceRects(scattered, null).length)
      .toBe(balanceRects([...scattered].reverse(), null).length)
  })

  it('emits every edge a line painter reads', () => {
    // `underline` and `strikethrough` destructure right and bottom; a rect
    // missing them yields NaN SVG coordinates.
    const band = balanceRects([rect(10, 20, 30, 40)], null)[0]
    expect(band?.right).toBe(40)
    expect(band?.bottom).toBe(60)
  })
})

describe('scripts whose ink is not Latin', () => {
  const line = [rect(100, 133, 220, 31)]

  /** An element carrying text, so the probe can be chosen from it. */
  const element = (text: string, doc: Document) =>
    ({ textContent: text, ownerDocument: doc }) as unknown as Element

  it('measures an ideograph for CJK, and so barely moves the band', () => {
    /* A CJK glyph fills the em box, so the gaps above and below its ink are
     * near zero and the correction is near zero — which is right, because the
     * text is already centred. Measured with the Latin probe instead, a page
     * of Chinese was pushed down by the ascent gap Latin leaves and CJK does
     * not. */
    const ideographic: InkMetrics = {
      fontBoundingBoxAscent: 25,
      fontBoundingBoxDescent: 6,
      actualBoundingBoxAscent: 24.6,
      actualBoundingBoxDescent: 5.7,
    }
    const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA, '永国': ideographic } })

    const cjkShift = (balanceRects(line, doc, element('第一章 引言', doc))[0]?.top ?? 0) - 133
    const latinShift = (balanceRects(line, doc, element('Chapter one', doc))[0]?.top ?? 0) - 133

    expect(Math.abs(cjkShift)).toBeLessThan(0.5)
    expect(latinShift).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
  })

  it('treats Hangul as ideographic too', () => {
    const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA, '永国': ZERO } })
    // ZERO metrics yield ratio 0, so a Hangul run takes no shift at all.
    expect(balanceRects(line, doc, element('한국어 문장', doc))[0]?.top).toBe(133)
  })

  it('leaves Latin text on the Latin probe', () => {
    const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA, '永国': ZERO } })
    const shift = (balanceRects(line, doc, element('ordinary prose', doc))[0]?.top ?? 0) - 133
    expect(shift).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
  })
})

describe('which element the band is measured against', () => {
  const line = [rect(100, 133, 220, 31)]
  const element = (text: string, doc: Document, tag = 'p') =>
    ({ textContent: text, tagName: tag, ownerDocument: doc }) as unknown as Element

  it('measures the marked element, not the book default', () => {
    /* A mark can sit in a heading or a code span with a family of its own,
     * and measuring `body` regardless would give it the body ratio. The two
     * fonts resolve DIFFERENT metrics here, so the shifts must differ — an
     * implementation that ignored the element produces identical ones. */
    const HEADING_FONT = 'normal 400 21px "Display Face", serif'
    const DISPLAY: InkMetrics = { ...LITERATA, actualBoundingBoxAscent: 21.5 }
    const doc = fakeDoc({
      byProbe: { [ASCENDER_PROBE]: LITERATA },
      byFont: { [HEADING_FONT]: { [ASCENDER_PROBE]: DISPLAY } },
      fontFor: (target) =>
        (target as unknown as { tagName?: string }).tagName === 'H1'
          ? '"Display Face", serif'
          : '"Literata Variable", Georgia, serif',
    })
    const heading = (balanceRects(line, doc, element('A heading', doc, 'H1'))[0]?.top ?? 0) - 133
    const body = (balanceRects(line, doc, element('ordinary prose', doc))[0]?.top ?? 0) - 133
    expect(heading).toBeCloseTo(31 * balanceRatio(DISPLAY), 4)
    expect(body).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
    expect(heading).not.toBeCloseTo(body, 3)
  })

  it('falls back to body for an element from another document', () => {
    // A stale element left over from a torn-down section would otherwise be
    // measured against a layout that no longer exists.
    const doc = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA } })
    const other = fakeDoc({ byProbe: { [ASCENDER_PROBE]: LITERATA } })
    const stale = element('from elsewhere', other)
    const shift = (balanceRects(line, doc, stale)[0]?.top ?? 0) - 133
    expect(shift).toBeCloseTo(31 * balanceRatio(LITERATA), 4)
  })
})

describe('the gutter threshold', () => {
  it('joins fragments a hair closer than one line-height apart', () => {
    const near = [rect(100, 133, 200, 31), rect(330, 133, 100, 31)] // 30px gap
    expect(balanceRects(near, null)).toHaveLength(1)
  })

  it('splits fragments a hair further than one line-height apart', () => {
    const far = [rect(100, 133, 200, 31), rect(332, 133, 100, 31)] // 32px gap
    expect(balanceRects(far, null)).toHaveLength(2)
  })
})
