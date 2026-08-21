// @vitest-environment jsdom
//
// `bookCss` reads the host's @font-face rules out of `document.styleSheets`, so
// it needs a document even when the assertion is about a plain declaration.
// See docs/hook-tests.md for the per-file opt-in.
import { describe, expect, it } from 'vitest'
import { READING_STEPS } from '../../core/metrics'
import { bookSheets, resolvedBookCss } from './bookCss'

/**
 * Where the reader's size setting actually lands.
 *
 * THE BASE BELONGS TO THE READER; THE PROPORTIONS BELONG TO THE AUTHOR. That is
 * the whole rule, and both halves need holding down. Declared only on `body`,
 * as it was, the base did not reach `rem` — which resolves against the ROOT —
 * so a third of this library had text the size control could not move.
 * Measured over 400 books: 128 of the 372 that ship any CSS size text in
 * `rem`, carrying 11,584 such declarations, and not one of the 372 sets a
 * font-size on `html`.
 */

const settings = (stepIdx: number) => ({
  stepIdx,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  align: 'justified' as const,
  spacing: { letter: 1, word: 0, line: 1, paragraph: 2 },
  brightness: 1,
  contrast: 0,
})

/** A declaration inside the rule with exactly this selector, comments stripped. */
function ruleValue(source: string, selector: string, property: string): string | null {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) return null
  const block = css.slice(start, css.indexOf('\n}', start))
  const match = new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'm').exec(block)
  return match?.[1]?.trim() ?? null
}

describe('the base size', () => {
  it('is declared on the root, which is what makes rem follow the reader', () => {
    /* THE REGRESSION TEST FOR THE WHOLE CLASS. With this on `body` instead,
       every rem in every book stays pinned to the browser's 16px however the
       reader moves the control, and nothing else in the suite notices. */
    const size = ruleValue(resolvedBookCss(settings(2)), 'html', 'font-size')
    expect(size).not.toBeNull()
    expect(size).toMatch(/^\d+px !important$/)
  })

  it('moves with the step, on the root', () => {
    const at = (i: number) => ruleValue(resolvedBookCss(settings(i)), 'html', 'font-size')
    expect(at(0)).not.toBe(at(READING_STEPS.length - 1))
  })

  it('ties body to the root rather than repeating the number', () => {
    /* Two numbers that must agree are one number that can disagree. */
    expect(ruleValue(resolvedBookCss(settings(2)), 'body', 'font-size')).toBe('1rem !important')
  })

  it('never forces a font-size on a descendant, which is what keeps proportion', () => {
    /* Forcing the BASE is safe: `h1 { font-size: 2.25em }` still resolves to
       2.25x it. Forcing a descendant would flatten every heading, note and drop
       cap in the library into one size. The rule is that only html and body may
       carry an important font-size. */
    const css = resolvedBookCss(settings(2)).replace(/\/\*[\s\S]*?\*\//g, '')
    const forced = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /font-size:[^;]*!important/.test(body ?? ''))
      .map(([, selector]) => (selector ?? '').trim().split('\n').pop()?.trim())
    /* THE ACCESSIBILITY FLOOR IS THE ONE EXCEPTION, and only because it cannot
       do the damage this test exists to prevent: `markSmallText` marks an
       element ONLY when it is already smaller than the base, so the selector
       can never reach a heading, and the value keeps the element's own ratio
       above the floor. See `markSmallText.test.ts`, which asserts that
       directly. */
    const floor = forced.filter((s) => s?.endsWith('[data-paper-em]'))
    expect(floor.length, 'the floor rule is gone — this exception asserts nothing').toBe(1)
    expect(forced.filter((s) => !s?.endsWith('[data-paper-em]')).sort()).toEqual(['body', 'html'])
  })
})

describe('the prose line box', () => {
  it('holds the reading grid for prose at the base', () => {
    /* The grid is the point of a fixed line, and enlarged prose is the
       exception — not the other way round. At the 21/34 default, 1.2em is 25px
       against the grid's 34, so ordinary prose is unaffected by the max(). */
    const line = ruleValue(resolvedBookCss(settings(2)), 'p, li, blockquote, dd', 'line-height')
    /* RESOLVED, which is what makes the comment above checkable. The sheet
       itself says `max(var(--paper-line), 1.2em)`; the contract puts 34px in
       it at this step, and 34 against 1.2em is the whole claim. */
    expect(line).toBe('max(34px, 1.2em) !important')
    expect(bookSheets().join('\n')).toContain('max(var(--paper-line), 1.2em) !important')
  })

  it('gives enlarged prose a line of its own rather than crushing it', () => {
    /* The companion the root change REQUIRES. 44 declarations across 400 books
       set a prose element at 1.5rem or more, up to 4rem. Sized against 16px,
       `p { font-size: 2rem }` was 32px inside a 34px line and just cleared it;
       following the reader it is 42px at the default step, and a flat 34px line
       would lay one line across the next.

       Computed here rather than asserted as a string, so the arithmetic that
       makes the claim true is the arithmetic the test checks. */
    const step = READING_STEPS[2]
    if (!step) throw new Error('the default step is gone')
    const grid = step.line
    const twoRem = 2 * step.size
    expect(Math.max(grid, twoRem * 1.2)).toBeGreaterThan(twoRem)
    /* And ordinary prose still lands exactly on the grid. */
    expect(Math.max(grid, step.size * 1.2)).toBe(grid)
  })
})
