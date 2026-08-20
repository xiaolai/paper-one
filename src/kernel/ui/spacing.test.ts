import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BRIGHTNESS, CONTRAST, DEFAULT_STEP_IDX, SPACING, spacingAt, stepAt } from '../core/metrics'
import { bookCss } from './reader/bookCss'
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

  const css = () => bookCss({
    stepIdx: DEFAULT_STEP_IDX,
    theme: 'paper',
    typeface: 'literata',
    align: 'justified',
    spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
    brightness: 1,
    contrast: 0,
  })

  it('marks the paragraph spacing', () => {
    expect(css()).toMatch(/margin:[^;]*--paper-line[^;]*!important/)
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
    const proseRule = css().slice(css().indexOf('\np, li, blockquote, dd {'))
    const declarations = proseRule.slice(0, proseRule.indexOf('\n}'))
    expect(declarations).not.toMatch(/text-align/)
    expect(declarations).not.toMatch(/hyphens/)
  })

  /* And nothing else. The rest of the sheet IS a default — a book that styles
   * its own headings, links or blockquotes must go on winning. */
  it('marks nothing that is not one of the six', () => {
    /* Comments stripped first: this file's prose says "not" and "important" in
       several places, and a regex over the whole sheet reads those as
       declarations. */
    const code = css().replace(/\/\*[\s\S]*?\*\//g, '')
    const marked = [...code.matchAll(/([a-z-]+)\s*:[^;{}]*!important/g)].map((m) => m[1])
    expect(new Set(marked)).toEqual(
      new Set([
        'margin', 'line-height', 'letter-spacing', 'word-spacing',
        'hyphens', '-webkit-hyphens', 'text-align',
      ]),
    )
  })
})
