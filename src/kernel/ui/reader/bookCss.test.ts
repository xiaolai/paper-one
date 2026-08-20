// @vitest-environment jsdom
//
// `bookCss` copies the host's @font-face rules out of `document.styleSheets`
// into the book, so it needs a document to read even when the assertion is about
// a plain declaration. See docs/hook-tests.md for the per-file opt-in.
import { describe, expect, it } from 'vitest'
import { ALIGNS, type Align } from '../../core/uiTypes'
import { bookCss } from './bookCss'

/**
 * Alignment, and the hyphenation that is half of it.
 *
 * Worth its own file because the two are one setting with three states, and
 * every part of that is easy to get wrong quietly. The pairing was a bare
 * conditional for a long time with nothing asserting it either way, and the
 * reasoning printed beside it went unchecked long enough to be half wrong.
 */

const settings = (align: Align) => ({
  stepIdx: 2,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  align,
  spacing: { letter: 1, word: 0, line: 1, paragraph: 2 },
  brightness: 1,
  contrast: 0,
})

/**
 * The value of a property inside the rule whose selector line starts with `selector`.
 *
 * COMMENTS STRIPPED FIRST, as `spacing.test.ts` does for the same reason: the
 * stylesheet explains itself in prose, and that prose contains the words it is
 * explaining. A note reading "a dedication that asked for hyphens: manual" is
 * indistinguishable from a declaration to anything scanning for one, and it
 * matches first.
 */
function ruleValue(source: string, selector: string, property: string): string | null {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) return null
  const block = css.slice(start, css.indexOf('\n}', start))
  const match = new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'm').exec(block)
  return match?.[1]?.trim() ?? null
}

/** What a state resolves to, on the marked prose the reader's settings own. */
const resolved = (align: Align) => {
  const css = bookCss(settings(align))
  return {
    align: ruleValue(css, '[data-paper-prose]', 'text-align'),
    hyphens: ruleValue(css, '[data-paper-prose]', 'hyphens'),
  }
}

/**
 * THE WHOLE MATRIX, IN ONE PLACE.
 *
 * Written as a table rather than as three separate assertions because the
 * interesting property is the SHAPE — two alignments and two hyphenations make
 * four combinations and exactly one is deliberately absent. A test per state
 * would assert the three that exist and say nothing about the fourth.
 */
describe('the three states', () => {
  it('resolves each one to its alignment and its hyphenation', () => {
    expect(resolved('justified')).toEqual({
      align: 'justify !important',
      hyphens: 'auto !important',
    })
    expect(resolved('justified-no-hyphens')).toEqual({
      align: 'justify !important',
      hyphens: 'manual !important',
    })
    expect(resolved('ragged')).toEqual({
      align: 'start !important',
      hyphens: 'manual !important',
    })
  })

  /* Exhaustive over `ALIGNS`, so a fourth state cannot land here with no
   * decision made about what it means — it fails rather than inheriting the
   * `else` branch of whatever conditional it fell into. */
  it('gives every declared state a resolution', () => {
    for (const align of ALIGNS) {
      const { align: value, hyphens } = resolved(align)
      expect(value, align).toMatch(/^(justify|start) !important$/)
      expect(hyphens, align).toMatch(/^(auto|manual) !important$/)
    }
  })

  /* The absent fourth. Hyphens do measure shorter in a rag — 15px mean against
   * 29px on a real page at the 660px measure — so leaving it out is a decision
   * and not an oversight, which is exactly why it needs asserting: without
   * this, a later reading of that measurement looks like a bug worth fixing. */
  it('never hyphenates ragged text, which is the combination left out', () => {
    expect(resolved('ragged').hyphens).toBe('manual !important')
  })
})

describe('the alignment the book is set to', () => {
  /* START, NEVER LEFT. The flush edge is on the left in English, the right in
   * Arabic and the top in vertical Japanese — one behaviour, three appearances,
   * and the book's own dir and writing-mode say which. A physical `left` here
   * is not a second option, it is a bug in two writing systems, which is why
   * `ALIGNS` names the far edge rather than the flush one. */
  it('never writes a physical side, in any state', () => {
    for (const align of ALIGNS) {
      const value = resolved(align).align ?? ''
      expect(value, align).not.toMatch(/\bleft\b/)
      expect(value, align).not.toMatch(/\bright\b/)
    }
  })
})

describe('hyphenation', () => {
  /* Both spellings, because WebKit is the engine this ships on and it reads the
   * prefixed one. Writing only the standard property is a change that looks
   * correct, passes review, and silently stops hyphenating the whole app. */
  it('carries the prefixed property WebKit actually reads, in every state', () => {
    for (const align of ALIGNS) {
      const css = bookCss(settings(align))
      expect(ruleValue(css, '[data-paper-prose]', '-webkit-hyphens'), align)
        .toBe(ruleValue(css, '[data-paper-prose]', 'hyphens'))
    }
  })
})

/**
 * A CONTROL THAT SILENTLY DOES NOTHING IS WORSE THAN NO CONTROL — the rule the
 * stylesheet already states for line-height, tracking and paragraph spacing,
 * and which alignment was never given.
 *
 * Left to inherit from `body` it loses to any rule that matches the element,
 * and measured over 400 EPUBs in a real library 32% set paragraph alignment
 * only from a class. On every one of those the setting did nothing in any
 * position. These hold the fix from the stylesheet's side; `markProse.test.ts`
 * holds the half that decides which elements are eligible.
 */
describe('the reader’s settings reach the prose', () => {
  it('applies both halves against the prose marker, not the element', () => {
    const css = bookCss(settings('ragged'))
    /* Against the attribute, never against `p`. Marked on the element selector
       it would flatten every centred dedication, epigraph and verse line in
       nearly half the library — 45% of the same 400 books. */
    const proseRule = css.slice(css.indexOf('\np, li, blockquote, dd {'))
    const declarations = proseRule.slice(0, proseRule.indexOf('\n}'))
    expect(declarations).not.toMatch(/text-align/)
    expect(declarations).not.toMatch(/hyphens/)
  })

  /* The body declarations stay as the fallback for prose the walk never reached
   * — a book that sets its paragraphs in divs, or a section that failed to
   * parse. They are defaults there, and correctly not important. */
  it('keeps the body declarations as the unmarked fallback, and unforced', () => {
    const css = bookCss(settings('ragged'))
    expect(ruleValue(css, 'body', 'text-align')).toBe('start')
    expect(ruleValue(css, 'body', 'hyphens')).toBe('manual')
  })

  it('moves the fallback with the setting, so the two cannot disagree', () => {
    const css = bookCss(settings('justified'))
    expect(ruleValue(css, 'body', 'text-align')).toBe('justify')
    expect(ruleValue(css, 'body', 'hyphens')).toBe('auto')
  })
})
