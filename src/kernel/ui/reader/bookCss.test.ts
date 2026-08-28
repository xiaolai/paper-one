// @vitest-environment jsdom
//
// `bookCss` copies the host's @font-face rules out of `document.styleSheets`
// into the book, so it needs a document to read even when the assertion is about
// a plain declaration. See dev-docs/hook-tests.md for the per-file opt-in.
import { describe, expect, it } from 'vitest'
import { ALIGNS, type Align, type ReadingStyle } from '../../core/uiTypes'
import { bookSheets, bookVars, resolveBookVars, resolvedBookCss } from './bookCss'
import { DEFAULT_STEP_IDX } from '../../core/metrics'
import { faceById } from '../../core/typefaces'

/**
 * Alignment, and the hyphenation that is half of it.
 *
 * Worth its own file because the two are one setting with three states, and
 * every part of that is easy to get wrong quietly. The pairing was a bare
 * conditional for a long time with nothing asserting it either way, and the
 * reasoning printed beside it went unchecked long enough to be half wrong.
 */

const settings = (align: Align) => ({
  stepIdx: DEFAULT_STEP_IDX,
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

/**
 * What a state resolves to, on the marked prose the reader's settings own.
 *
 * FOUND BY THE MARKER, not by an exact selector string — the rule names the
 * four prose elements as well as the attribute, to outweigh a book's own
 * `p.class` rule, and a helper keyed to the literal text would go quietly blank
 * the next time that changes. It THROWS rather than returning null, because a
 * missing rule read as `null` is how `never writes a physical side` passed
 * against nothing at all: `null ?? ''` matches no physical side either.
 */
const resolved = (align: Align) => {
  const css = resolvedBookCss(settings(align)).replace(/\/\*[\s\S]*?\*\//g, '')
  const match = /([^{}]*\[data-paper-prose\][^{}]*)\{([^{}]*)\}/.exec(css)
  if (!match) throw new Error('no rule targets [data-paper-prose] — the marker rule is gone')
  const declarations = match[2] ?? ''
  const value = (property: string) => {
    const found = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'm').exec(declarations)
    if (!found) throw new Error(`the prose rule declares no ${property}`)
    return (found[1] ?? '').trim()
  }
  return { align: value('text-align'), hyphens: value('hyphens') }
}

/** The same rule, with the prefixed spelling WebKit is the one that reads. */
const resolvedWithPrefix = (align: Align) => {
  const css = resolvedBookCss(settings(align)).replace(/\/\*[\s\S]*?\*\//g, '')
  const match = /([^{}]*\[data-paper-prose\][^{}]*)\{([^{}]*)\}/.exec(css)
  if (!match) throw new Error('no rule targets [data-paper-prose] — the marker rule is gone')
  const declarations = match[2] ?? ''
  const read = (property: string) => {
    const found = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'm').exec(declarations)
    if (!found) throw new Error(`the prose rule declares no ${property}`)
    return (found[1] ?? '').trim()
  }
  return { hyphens: read('hyphens'), prefixed: read('-webkit-hyphens') }
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
   * decision made about what it means.
   *
   * AGAINST A DECLARED TABLE, not against a pattern. Matching each value to
   * /justify|start/ accepted ANY pair, so a new state falling through an `else`
   * to justify/manual passed — which is precisely the silence this was written
   * to prevent. The table has to name the state before the test can go green. */
  it('gives every declared state a resolution, and only the declared ones', () => {
    const EXPECTED: Record<Align, { align: string; hyphens: string }> = {
      justified: { align: 'justify !important', hyphens: 'auto !important' },
      'justified-no-hyphens': { align: 'justify !important', hyphens: 'manual !important' },
      ragged: { align: 'start !important', hyphens: 'manual !important' },
    }
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALIGNS].sort())
    for (const align of ALIGNS) expect(resolved(align), align).toEqual(EXPECTED[align])
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
    /* Through `resolved`, which finds the rule by its marker and THROWS when it
       cannot. Read with an exact selector string this compared null to null the
       moment the selector grew its element names — passing while asserting
       nothing, which is the defect this whole round is about. */
    for (const align of ALIGNS) {
      const { hyphens, prefixed } = resolvedWithPrefix(align)
      expect(prefixed, align).toBe(hyphens)
      expect(prefixed, align).toMatch(/^(auto|manual) !important$/)
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
    const css = resolvedBookCss(settings('ragged'))
    /* Against the marker, never against a bare `p`. On the element selector it
       would flatten every centred dedication, epigraph and verse line in nearly
       half the library — 45% of the same 400 books.

       THE RULE IS ASSERTED PRESENT FIRST, and that is not ceremony: this was
       written as `slice(indexOf(sel))`, and `indexOf` returns −1 when the rule
       is gone, so the slice came out empty and `not.toMatch` passed. The test
       could not fail for the reason it exists. */
    const start = css.indexOf('\np, li, blockquote, dd {')
    expect(start, 'the shared prose rule is gone — this test asserts nothing').toBeGreaterThan(-1)
    const declarations = css.slice(start, css.indexOf('\n}', start))
    expect(declarations).not.toMatch(/text-align/)
    expect(declarations).not.toMatch(/hyphens/)
  })

  /* And nowhere else. A bare `p { text-align: … !important }` added later would
   * be invisible to the rule above, which only inspects one known selector. */
  it('marks alignment under no selector but the prose marker', () => {
    const css = resolvedBookCss(settings('ragged')).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/text-align:[^;]*!important|hyphens:[^;]*!important/.test(body ?? '')) continue
      expect(selector ?? '', 'important alignment under an unmarked selector')
        .toMatch(/\[data-paper-prose\]/)
    }
  })

  /* The body declarations stay as the fallback for prose the walk never reached
   * — a book that sets its paragraphs in divs, or a section that failed to
   * parse. They are defaults there, and correctly not important. */
  it('keeps the body declarations as the unmarked fallback, and unforced', () => {
    const css = resolvedBookCss(settings('ragged'))
    expect(ruleValue(css, 'body', 'text-align')).toBe('start')
    expect(ruleValue(css, 'body', 'hyphens')).toBe('manual')
  })

  /* ALL THREE STATES, AND BOTH SPELLINGS. Two of the three were checked, so
   * `justified-no-hyphens` could have hyphenated in the fallback — or the
   * prefixed property, the one WebKit actually reads, could have stopped
   * following the setting — with the suite still green. */
  it('moves the fallback with the setting, in every state and both spellings', () => {
    const EXPECTED: Record<Align, { align: string; hyphens: string }> = {
      justified: { align: 'justify', hyphens: 'auto' },
      'justified-no-hyphens': { align: 'justify', hyphens: 'manual' },
      ragged: { align: 'start', hyphens: 'manual' },
    }
    for (const align of ALIGNS) {
      const css = resolvedBookCss(settings(align))
      expect(
        {
          align: ruleValue(css, 'body', 'text-align'),
          hyphens: ruleValue(css, 'body', 'hyphens'),
        },
        align,
      ).toEqual(EXPECTED[align])
      expect(ruleValue(css, 'body', '-webkit-hyphens'), align).toBe(EXPECTED[align].hyphens)
    }
  })
})

/**
 * THE TYPEFACE IS A CONTROL TOO, and it was the one control left to inherit.
 *
 * Size, line, tracking, alignment and hyphens all reach the prose elements
 * marked; the family was declared once, on `body`, unmarked — so it lost to any
 * rule that matched the element. Calibre writes `p { font-family }` as a matter
 * of course, and on every such book the Typeface setting did nothing at all
 * while its four siblings worked. The ledger's "book `<p>` computes to the
 * chosen face" held only for books that set no family below `body`.
 */
describe('the typeface reaches the prose', () => {
  const family = () => faceById('literata').stack

  it('forces the reader’s face on the prose elements, with the weight the size rule uses', () => {
    const css = resolvedBookCss(settings('justified'))
    const start = css.indexOf('\np, li, blockquote, dd {')
    expect(start, 'the shared prose rule is gone — this test asserts nothing').toBeGreaterThan(-1)
    expect(ruleValue(css, 'p, li, blockquote, dd', 'font-family')).toBe(`${family()} !important`)
  })

  /* The body declaration stays as the fallback for prose the element list does
     not name — a book set in divs — and stays a default there, unforced. */
  it('keeps the body declaration as the unmarked fallback', () => {
    const css = resolvedBookCss(settings('justified'))
    expect(ruleValue(css, 'body', 'font-family')).toBe(family())
  })

  /* Code is set apart by the house-ratio rules and keeps its own face; the
     forced family must not name it, and must not name `pre`, whose contents are
     code by definition. */
  it('names none of code, pre, kbd or samp', () => {
    const css = resolvedBookCss(settings('justified')).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/font-family:[^;]*!important/.test(body ?? '')) continue
      expect(selector ?? '', 'a forced family under a code selector').not.toMatch(/\b(code|pre|kbd|samp)\b/)
    }
  })

  /* WHAT A READER SEES, in a real cascade rather than in the sheet's text. The
     book's rule sits BETWEEN the two tiers, where the app puts it, and carries a
     class so that it outranks the prose rule on specificity — only the marking
     can win, which is the whole claim. jsdom honours `!important` and
     specificity in `getComputedStyle`; measured before this was written.

     In the suite's own document, not a `createHTMLDocument` — a document made
     that way has no window, so `getComputedStyle` has nobody to ask and the
     assertion would compare against nothing. Everything is removed after. */
  const computed = (bookCss: string, style?: Partial<ReadingStyle>) => {
    const [before, after] = bookSheets()
    const vars = bookVars(style ? { ...settings('justified'), style } : settings('justified'))
    const added: Element[] = []
    for (const css of [resolveBookVars(before, vars), bookCss, resolveBookVars(after, vars)]) {
      const element = document.createElement('style')
      element.textContent = css
      document.head.append(element)
      added.push(element)
    }
    const host = document.createElement('div')
    host.innerHTML = '<p class="body">prose <code>code</code></p>'
    document.body.append(host)
    added.push(host)
    /* Quotes normalised: the engine serialises a quoted family name with double
       quotes whatever the sheet wrote, and the spelling is not the claim. */
    const unquoted = (value: string) => value.replace(/["']/g, '')
    try {
      return {
        p: unquoted(window.getComputedStyle(host.querySelector('p') as HTMLElement).fontFamily),
        code: unquoted(window.getComputedStyle(host.querySelector('code') as HTMLElement).fontFamily),
      }
    } finally {
      for (const element of added) element.remove()
    }
  }

  it('computes to the chosen face on a paragraph the book gave its own, and leaves code in the reader’s monospace', () => {
    const seen = computed('p.body { font-family: Georgia; }', { codeFace: 'paper' })
    expect(seen.p).toBe(family().replace(/["']/g, ''))
    expect(seen.code).toBe(faceById('plex').stack.replace(/["']/g, ''))
  })

  /* The other direction of the exclusion: with the code face left to the
     publisher, a code run the book set in its own monospace keeps it — the
     forced family reaches the paragraph around it and stops there. */
  it('leaves a code run the book set in monospace alone, while the paragraph takes the face', () => {
    const seen = computed('p.body { font-family: Georgia; } code { font-family: Menlo, monospace; }')
    expect(seen.p).toBe(family().replace(/["']/g, ''))
    expect(seen.code).toBe('Menlo, monospace')
  })
})
