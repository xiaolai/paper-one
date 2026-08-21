import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BRIGHTNESS, CONTRAST, DEFAULT_STEP_IDX, SPACING, spacingAt, stepAt } from '../core/metrics'
import { bookSheets, resolvedBookCss } from './reader/bookCss'
import { initialState, reducer, type SpacingKey } from './state'

const KEYS: readonly SpacingKey[] = ['letter', 'word', 'line', 'paragraph']

describe('the spacing scales', () => {
  it('has a default that is a real step of every scale', () => {
    for (const key of KEYS) {
      const scale = SPACING[key]
      expect(scale.def, key).toBeGreaterThanOrEqual(0)
      expect(scale.def, key).toBeLessThan(scale.steps.length)
    }
  })

  /* A reader who never opens these must get exactly the book they have now:
   * no tracking, no word spacing, the step's own line, one line between
   * paragraphs. The SCALES have been re-based since — every one of them now
   * starts its default at the same position — and this is what says the values
   * did not move when the positions did. */
  it('defaults to the typography that was there before it was adjustable', () => {
    expect(spacingAt('letter', SPACING.letter.def)).toBe(0)
    expect(spacingAt('word', SPACING.word.def)).toBe(0)
    expect(spacingAt('line', SPACING.line.def)).toBe(1)
    expect(spacingAt('paragraph', SPACING.paragraph.def)).toBe(1)
  })

  it('starts every reader on those defaults', () => {
    for (const key of KEYS) expect(initialState.spacing[key], key).toBe(SPACING[key].def)
  })

  /* Every spacing starts at the same position, so the four rows read as one
   * control repeated rather than four that happen to be near each other — and
   * each has a step below its default, so no row's minus is dead before the
   * reader has touched anything. */
  it('starts every spacing at the second step, with room below', () => {
    for (const key of KEYS) {
      expect(SPACING[key].def, key).toBe(1)
      expect(SPACING[key].steps.length, key).toBe(5)
    }
  })

  it('runs each scale in one direction, with no repeated step', () => {
    for (const key of KEYS) {
      const steps = SPACING[key].steps
      expect(new Set(steps).size, key).toBe(steps.length)
      expect([...steps].sort((a, b) => a - b), key).toEqual([...steps])
    }
  })

  /* Line and paragraph are MULTIPLES of the line box, so zero or negative
   * leading is not a thing the scale may contain. */
  it('never offers a multiplier that would collapse the line', () => {
    for (const value of SPACING.line.steps) expect(value).toBeGreaterThan(0)
    for (const value of SPACING.paragraph.steps) expect(value).toBeGreaterThanOrEqual(0)
  })
})

describe('spacingAt', () => {
  it('reads a step', () => {
    expect(spacingAt('line', 0)).toBe(SPACING.line.steps[0])
    expect(spacingAt('line', SPACING.line.steps.length - 1)).toBe(
      SPACING.line.steps[SPACING.line.steps.length - 1],
    )
  })

  /* An index reaches this from state that a newer build may have written, so
   * it is clamped rather than trusted — `undefined` from an array lookup would
   * reach the stylesheet as the string "undefined". */
  it('clamps an index from outside the scale', () => {
    expect(spacingAt('word', -5)).toBe(SPACING.word.steps[0])
    expect(spacingAt('word', 99)).toBe(SPACING.word.steps[SPACING.word.steps.length - 1])
  })

  it('never returns a value that is not a number', () => {
    for (const key of KEYS) {
      for (const idx of [-1, 0, 1.4, 99, NaN]) {
        expect(Number.isFinite(spacingAt(key, idx)), `${key} @ ${idx}`).toBe(true)
      }
    }
  })
})

describe('setSpacing', () => {
  it('moves one spacing and leaves the other three', () => {
    const next = reducer(initialState, { type: 'setSpacing', key: 'word', idx: 2 })
    expect(next.spacing.word).toBe(2)
    expect(next.spacing.letter).toBe(initialState.spacing.letter)
    expect(next.spacing.line).toBe(initialState.spacing.line)
    expect(next.spacing.paragraph).toBe(initialState.spacing.paragraph)
  })

  it('clamps to the ends of the scale', () => {
    expect(reducer(initialState, { type: 'setSpacing', key: 'line', idx: -3 }).spacing.line).toBe(0)
    const top = SPACING.line.steps.length - 1
    expect(reducer(initialState, { type: 'setSpacing', key: 'line', idx: 99 }).spacing.line).toBe(top)
  })

  /* NaN survives `Math.min`/`Math.max` untouched and would reach the array —
   * the same trap `setStepIdx` documents. */
  it('drops a value that is not a number rather than storing it', () => {
    expect(reducer(initialState, { type: 'setSpacing', key: 'letter', idx: NaN })).toBe(initialState)
    expect(reducer(initialState, { type: 'setSpacing', key: 'letter', idx: Infinity })).toBe(
      initialState,
    )
  })

  it('returns the same state when nothing moved, so nothing re-renders', () => {
    const at = initialState.spacing.paragraph
    expect(reducer(initialState, { type: 'setSpacing', key: 'paragraph', idx: at })).toBe(
      initialState,
    )
  })
})

describe('light: the theme is the ceiling', () => {
  /* Both controls start at the theme exactly as designed and only take away.
   * Contrast used to run PAST it, hardening the ink beyond a ratio somebody had
   * already measured — softening is a preference, and overriding a measurement
   * is a second opinion. */
  it('defaults both to the top of their scale', () => {
    expect(BRIGHTNESS.def).toBe(BRIGHTNESS.steps.length - 1)
    expect(CONTRAST.def).toBe(CONTRAST.steps.length - 1)
  })

  it('leaves the theme untouched at those defaults', () => {
    expect(stepAt(BRIGHTNESS, BRIGHTNESS.def)).toBe(1)
    expect(stepAt(CONTRAST, CONTRAST.def)).toBe(0)
  })

  it('offers only reduction — no step brightens or hardens past the theme', () => {
    for (const v of BRIGHTNESS.steps) expect(v).toBeLessThanOrEqual(1)
    for (const v of CONTRAST.steps) expect(v).toBeLessThanOrEqual(0)
  })

  it('gives both five steps', () => {
    expect(BRIGHTNESS.steps.length).toBe(5)
    expect(CONTRAST.steps.length).toBe(5)
  })
})

/* A CONTROL THAT DOES NOTHING IS WORSE THAN NO CONTROL, and on a real book
 * three of these four were one class away from doing nothing: On China ships
 * `p.nonindent { margin-bottom: 0em }`, which beats an element selector and
 * computed paragraph spacing to 0px. The marks are the only mechanism that
 * reliably wins, so this asserts they are still there — a well-meaning cleanup
 * removing them would break the settings on a large share of the library and
 * break nothing that any other test can see.
 *
 * THE FOUR ARE NOW SIX. Alignment and hyphenation were left inheriting from
 * `body` long after the argument above was written, and inheritance loses to
 * any rule that matches the element — so they were the two controls this
 * paragraph describes, still broken. Measured over 400 EPUBs in the library,
 * 32% set paragraph alignment only from a class and reached neither position of
 * the Alignment control.
 *
 * THE SIX ARE NOW SEVEN, and the seventh is different in kind from all of
 * them. The other six are marked ON PROSE, to beat a book's own `p.class`. The
 * base font-size is marked on `html` and `body` — never on an element — and
 * that is what makes it safe: forcing the base leaves `h1 { font-size: 2.25em }`
 * resolving to 2.25 x it, so the author's proportions survive whole, while
 * forcing it on `p` would flatten every heading, note and drop cap in the
 * library into one size. It is on `html` because `rem` resolves against the
 * root: measured over 400 books, 128 of the 372 that ship CSS size text in
 * `rem` and carry 11,584 such declarations between them, and a base declared
 * only on `body` left every one of them pinned to the browser's 16px whatever
 * the reader did with the control. Not one of the 372 sets a font-size on
 * `html`, so nothing is taken from any author. See `bookSize.test.ts`.
 *
 * They are not marked the same way as the other four, and the difference is the
 * point. `text-align` is the one property here a book uses to COMPOSE rather
 * than to state a default — 45% of those same 400 centre paragraphs from a
 * class — so forcing it on `p` would flatten every dedication, epigraph and
 * verse line among them. Both halves are marked against `[data-paper-prose]`
 * instead, which `markProse` puts only on paragraphs the book had not
 * deliberately placed; hyphenation rides with the alignment because it is half
 * of the same setting and has to land on the same elements. */
describe('the reader’s spacings survive a book’s own stylesheet', () => {
  /* `bookCss` copies the host's `@font-face` rules into the book, so it reads
     `document.styleSheets`. There is no document here and none is needed —
     this is about which declarations carry the mark. */
  beforeAll(() => {
    vi.stubGlobal('document', { styleSheets: [] })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  const css = () => resolvedBookCss({
    stepIdx: DEFAULT_STEP_IDX,
    theme: 'paper',
    typeface: 'literata',
    align: 'justified',
    spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
    brightness: 1,
    contrast: 0,
  })

  /* THE UNRESOLVED SHEET, for the questions that are about the sheet.
     `css()` above substitutes the contract in, so `var(--paper-line)` reads as
     `34px` there — right for "what does the reader see", wrong for "is the
     paragraph spacing still a multiple of the line box". */
  const sheetText = () => bookSheets().join('\n')

  it('marks the paragraph spacing, as a multiple of the line box', () => {
    expect(sheetText()).toMatch(/margin:[^;]*--paper-line[^;]*!important/)
    /* And of the reader's paragraph setting, not a length: opening the leading
       has to open the space between paragraphs with it. */
    expect(sheetText()).toMatch(/margin:[^;]*--paper-para[^;]*!important/)
  })

  it('marks the line, letter and word spacing', () => {
    for (const prop of ['line-height', 'letter-spacing', 'word-spacing']) {
      expect(css(), prop).toMatch(new RegExp(`${prop}:[^;]*!important`))
    }
  })

  it('marks the alignment and the hyphenation, only against the prose marker', () => {
    /* Against the attribute, never against `p` — see the head of this block.
       Marked on the element selector they would flatten every centred
       dedication, epigraph and verse line in nearly half the library. */
    for (const prop of ['text-align', 'hyphens', '-webkit-hyphens']) {
      expect(css(), prop).toMatch(
        new RegExp(`\\[data-paper-prose\\]\\s*\\{[^}]*${prop}:[^;]*!important`),
      )
    }
    /* THE RULE IS ASSERTED PRESENT FIRST. Written as `slice(indexOf(sel))` this
       passed when the rule was GONE: indexOf returns −1, the slice comes out
       empty, and `not.toMatch` is satisfied by nothing. */
    const start = css().indexOf('\np, li, blockquote, dd {')
    expect(start, 'the shared prose rule is gone — this test asserts nothing').toBeGreaterThan(-1)
    const declarations = css().slice(start, css().indexOf('\n}', start))
    expect(declarations).not.toMatch(/text-align/)
    expect(declarations).not.toMatch(/hyphens/)
  })

  /* And nothing else. The rest of the sheet IS a default — a book that styles
   * its own headings, links or blockquotes must go on winning. */
  /**
   * And nothing else — EXCEPT WHAT THE THEME FORCES ON A DARK PAGE.
   *
   * The seven are the reader's typographic controls. WI-14.1 added a second
   * marked set, and it is a different kind of thing: `color: inherit`,
   * `background-color: transparent`, `border-color`, `fill`, `stroke` and the
   * matte's `background` take the book's COLOURS over so a reader who picked a
   * dark theme gets one. Every one of them is gated on `--paper-dark-page`, so
   * on a light page nothing in this set applies at all.
   *
   * ASSERTED BY THE GATE, not by adding six names to the list. A list would
   * accept the same six declarations written ungated — which is precisely the
   * failure: `background-color: transparent !important` on every element of
   * every book, on a white page, for ever.
   */
  it('marks nothing that is not one of the seven, unless the dark page forces it', () => {
    /* Comments stripped first: this file's prose says "not" and "important" in
       several places, and a regex over the whole sheet reads those as
       declarations. */
    const code = css().replace(/\/\*[\s\S]*?\*\//g, '')
    /* THE SEVEN ARE TEN, and the three WI-14.4 added are the same kind of
       thing: a control a reader operated, which an inline style would otherwise
       defeat. `text-indent` is half of paragraph separation, `max-width` is the
       figure cap when it is set to follow the type, and `font-size` was already
       here for the base and is now also the accessibility floor. Everything
       WI-14.4 put in the `before` tier is absent from this list because it is
       absent from that sheet's marks — a house default, which a book beats. */
    const READER_CONTROLS = new Set([
      'margin', 'line-height', 'letter-spacing', 'word-spacing',
      'hyphens', '-webkit-hyphens', 'text-align', 'font-size',
      'text-indent', 'max-width',
    ])
    const stray: string[] = []
    for (const [, selector = '', body = ''] of code.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const gated = selector.includes('--paper-dark-page')
      for (const m of body.matchAll(/([a-z-]+)\s*:[^;{}]*!important/g)) {
        const property = m[1] ?? ''
        if (READER_CONTROLS.has(property) || gated) continue
        stray.push(`${selector.trim().split('\n').pop()} { ${property} }`)
      }
    }
    expect(stray, `\nmarked, and neither a reader control nor gated on a dark page:\n  ${stray.join('\n  ')}\n`).toEqual([])
  })

  /* The gate has to be able to fail: an ungated marked declaration outside the
     seven is the thing above is for, and a scan that found none because its
     regex had drifted would look identical. */
  it('would catch a marked declaration that no dark page gates', () => {
    const code = css().replace(/\/\*[\s\S]*?\*\//g, '')
    const gatedRules = [...code.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(
      ([, selector = '', body = '']) =>
        selector.includes('--paper-dark-page') && /!important/.test(body),
    )
    expect(gatedRules.length, 'nothing is gated — the scan above asserts nothing').toBeGreaterThan(0)
  })

  /**
   * A CONTROL THAT STOPS AT PROSE IS THE SAME DEFECT AS F1 (WI-14.0).
   *
   * `line-height` is forced on `p, li, blockquote, dd` from the reader's Line
   * setting — and headings took a flat `1.2`, which is Paper's own declaration
   * blocking the inherited value. So a reader who opened their leading got
   * every paragraph in the book to move and every chapter title to stay exactly
   * where it was. Not a book winning: Paper overruling its own control.
   *
   * The default is unchanged, which is the other half of the assertion — the
   * setting is 1 at rest and 1.2 is what a heading has always had.
   */
  const cssAtLine = (idx: number) => resolvedBookCss({
    stepIdx: DEFAULT_STEP_IDX,
    theme: 'paper',
    typeface: 'literata',
    align: 'justified',
    spacing: { letter: 1, word: 1, line: idx, paragraph: 1 },
    brightness: 1,
    contrast: 0,
  }).replace(/\/\*[\s\S]*?\*\//g, '')

  const headingLine = (idx: number) => {
    const code = cssAtLine(idx)
    const start = code.indexOf('\nh1, h2, h3, h4, h5, h6 {')
    expect(start, 'the heading rule is gone — this test asserts nothing').toBeGreaterThan(-1)
    return /line-height:\s*([^;]+);/.exec(code.slice(start, code.indexOf('\n}', start)))?.[1]?.trim()
  }

  it('lets the line setting reach a heading, not only the prose', () => {
    const at = SPACING.line.steps.map((_, idx) => headingLine(idx))
    /* Every step distinct: a heading that reads the same at every position of
       the control is the control not reaching it, which is what this is for. */
    expect(new Set(at).size, `heading line-heights: ${at.join(', ')}`).toBe(SPACING.line.steps.length)
  })

  it('leaves a heading at 1.2 where the reader has not moved the line', () => {
    expect(spacingAt('line', SPACING.line.def)).toBe(1)
    expect(headingLine(SPACING.line.def)).toBe('calc(1.2 * 1)')
  })

  it('never marks the font-size on prose, only on the base', () => {
    /* THE DISTINCTION THE SEVENTH TURNS ON, and a list of property names cannot
       see it. `font-size: … !important` on `html` is the reader's control
       working; the same declaration on `p` would flatten every enlarged opener,
       every note and every drop cap in the library into one size. Asserted by
       WHERE rather than by WHAT, because only the where is dangerous. */
    const code = css().replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...code.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    const forcing = rules.filter(([, , body]) => /font-size:[^;]*!important/.test(body ?? ''))
    expect(forcing.length, 'no rule forces a font-size — the base is not marked').toBeGreaterThan(0)
    for (const [, selector] of forcing) {
      const last = (selector ?? '').trim().split('\n').pop()?.trim() ?? ''
      /* THE ACCESSIBILITY FLOOR IS THE ONE EXCEPTION, and it is allowed here
         only because it cannot do the damage this test exists to prevent.
         `markSmallText` marks an element ONLY when it is already smaller than
         the base, so `[data-paper-em]` can never match a heading, and the value
         is `max(<the element's own ratio>, floor)` — which keeps the author's
         proportions above the floor exactly. The rule that could not be allowed
         is `* { font-size: max(1em, floor) }`, where `1em` is the PARENT's size
         and every enlarged opener in the library flattens. That rule was
         written first and this test caught it. */
      if (last.endsWith('[data-paper-em]')) {
        expect(last, 'the floor must be gated, or it runs on every book').toContain('--paper-min-size')
        continue
      }
      expect(['html', 'body'], `font-size forced on ${last}`).toContain(last)
    }
  })
})
