// @vitest-environment jsdom
//
// `bookSheets` copies the host's @font-face rules out of `document.styleSheets`,
// so it needs a document even where the assertion is about a declaration.
import { describe, expect, it } from 'vitest'
import {
  CODE_PANEL_PAD,
  CONTENT_AREA,
  FIGURE_HEIGHTS,
  FIGURE_WIDTHS,
  MINIMUM_SIZES,
  PARAGRAPH_INDENT,
  READING_RATIOS,
  stepAt,
} from '../../core/metrics'
import {
  CODE_FACES,
  CODE_WRAPS,
  FIDELITIES,
  FIGURE_FRAMES,
  FLOURISHES,
  HEADING_SCALES,
  NOTE_SIZES,
  QUOTE_STYLES,
  SEPARATIONS,
  TABLE_FITS,
  type ReadingStyle,
} from '../../core/uiTypes'
import { bookSheets, bookVars, noteSheets } from './bookCss'
import { SMALL_ATTR, SMALL_VAR } from './markSmallText'
import { DEFAULT_READING_STYLE } from '../../core/metrics'
import { DEFAULT_STEP_IDX } from '../../core/metrics'

/**
 * WI-14.4's fifteen: each one property and a rule that reads it.
 *
 * THE PROPERTY THAT MATTERS MOST IS THE DULLEST ONE. Every default is what
 * Paper rendered before the setting existed, so a reader who never opens any of
 * them gets the book they had. A settings surface that quietly restyles the
 * whole library on the day it ships is not a feature, and the only way that
 * promise survives contact with a fifteenth setting is a test that states it.
 *
 * THE SECOND IS THAT NONE OF THEM IS INERT. A control that does nothing is
 * worse than no control — this codebase says so in three places already — and
 * a gate whose property name is misspelled matches nothing, silently. So every
 * setting here is asserted to MOVE something: the contract, and the sheet.
 */

const settings = (style: Partial<ReadingStyle> = {}) => ({
  stepIdx: DEFAULT_STEP_IDX,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  align: 'justified' as const,
  spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
  brightness: 1,
  contrast: 0,
  style,
})

const vars = (style: Partial<ReadingStyle> = {}) => bookVars(settings(style))
const sheets = () => [...bookSheets(), ...noteSheets()].join('\n')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every state of every setting, so a loop can walk the whole surface. */
const EVERY_STATE: { [K in keyof ReadingStyle]: readonly ReadingStyle[K][] } = {
  separation: SEPARATIONS,
  flourish: FLOURISHES,
  headingScale: HEADING_SCALES,
  blockquote: QUOTE_STYLES,
  codeFace: CODE_FACES,
  codeWrap: CODE_WRAPS,
  figureWidth: FIGURE_WIDTHS.steps.map((_, i) => i),
  figureFrame: FIGURE_FRAMES,
  figureScalesWithText: [false, true],
  figureHeight: FIGURE_HEIGHTS.steps.map((_, i) => i),
  wideTables: TABLE_FITS,
  noteSize: NOTE_SIZES,
  cjkSpacing: [false, true],
  minimumSize: MINIMUM_SIZES.steps.map((_, i) => i),
  fidelity: FIDELITIES,
}

const KEYS = Object.keys(EVERY_STATE) as (keyof ReadingStyle)[]

describe('the defaults are what Paper rendered before the settings existed', () => {
  it('covers every setting, so this file cannot fall behind the type', () => {
    /* A test that walks a list is only as good as the list. Derived from the
       type's own keys, so a sixteenth setting fails here rather than shipping
       untested. */
    expect(new Set(KEYS)).toEqual(new Set(Object.keys(DEFAULT_READING_STYLE)))
    expect(KEYS).toHaveLength(15)
  })

  it('keeps the paragraph space, and adds no indent', () => {
    expect(DEFAULT_READING_STYLE.separation).toBe('space')
    expect(vars()['--paper-para']).toBe('1')
    /* ABSENT, not zero — the value IS the gate, so no property means no rule.
       Written as `0` the rule would still match and force `text-indent: 0` on
       every prose paragraph, taking a book's own indent away from a reader who
       asked for none. */
    expect(vars()['--paper-indent']).toBeNull()
  })

  it('leaves headings at the publisher’s sizes', () => {
    /* Paper sets a heading's weight, leading and space and has NEVER touched
       its size, so `h1 { font-size: 2.25em }` resolves against the reader's
       base and the author's proportions survive whole. */
    expect(DEFAULT_READING_STYLE.headingScale).toBe('publisher')
    expect(vars()['--paper-heading-scale']).toBeNull()
  })

  it('indents a quotation and italicises it, which is what the sheet always did', () => {
    expect(DEFAULT_READING_STYLE.blockquote).toBe('indent')
    expect(vars()['--paper-quote-rule']).toBeNull()
    expect(vars()['--paper-quote-tint']).toBeNull()
  })

  it('caps a figure where it was already capped', () => {
    /* 95 IS IN THE SCALE BECAUSE IT IS WHERE PAPER ALREADY WAS. The plan named
       70/80/90/100, which has no step at the value the sheet had been shipping
       — adding the control on those four would have moved every figure in the
       library by five points on the day it landed. */
    expect(stepAt(FIGURE_WIDTHS, DEFAULT_READING_STYLE.figureWidth)).toBe(95)
    expect(vars()['--paper-figure-width']).toBe('95%')
    expect(stepAt(FIGURE_HEIGHTS, DEFAULT_READING_STYLE.figureHeight)).toBe(95)
    expect(vars()['--paper-figure-height']).toBe('95vh')
  })

  it('leaves the accessibility floor off', () => {
    /* A floor IS an override of the author's proportions — it flattens a run of
       small caps into the prose around it — so it is offered, not imposed. */
    expect(stepAt(MINIMUM_SIZES, DEFAULT_READING_STYLE.minimumSize)).toBe(0)
    expect(vars()['--paper-min-size']).toBeNull()
  })

  it('leaves every other switch where the sheet already was', () => {
    const v = vars()
    expect(v['--paper-drop-cap']).toBeNull()
    expect(v['--paper-small-caps']).toBeNull()
    expect(v['--paper-code-wrap']).toBeNull()
    expect(v['--paper-figure-hairline']).toBeNull()
    expect(v['--paper-figure-shadow']).toBeNull()
    expect(v['--paper-figure-scale']).toBeNull()
    expect(v['--paper-table-shrink']).toBeNull()
    expect(v['--paper-cjk-space']).toBeNull()
    expect(v['--paper-code-family']).toBe('inherit')
    /* The two that ARE on by default, and both were already the behaviour: the
       house sheet has always sat in the appended slot, and the note popover has
       reset its blocks to the base since the 11.2px regression was fixed. */
    expect(v['--paper-fidelity-paper']).toBe('1')
    expect(v['--paper-note-prose']).toBe('1')
  })

  it('is the seed the app actually starts from', () => {
    /* Imported rather than restated in `initialState`, so the reducer's seed
       and the stylesheet's own idea of "unchanged" cannot drift apart. */
    expect(bookVars(settings(DEFAULT_READING_STYLE))).toEqual(bookVars(settings()))
  })
})

describe('no setting is inert', () => {
  /**
   * EVERY STATE OF EVERY SETTING MOVES THE CONTRACT.
   *
   * A gate whose property name is misspelled matches nothing and the setting
   * does nothing, silently — no error, no warning, a row in the panel that
   * looks exactly like a working one. This is the sweep that catches it, and
   * `bookTiers.test.ts` catches the other half: a gate the contract never
   * writes, and a property the sheets never use.
   */
  it('gives every setting at least two distinct contracts', () => {
    for (const key of KEYS) {
      const seen = new Set(
        (EVERY_STATE[key] as readonly ReadingStyle[typeof key][]).map((value) =>
          JSON.stringify(bookVars(settings({ [key]: value }))),
        ),
      )
      expect(seen.size, `${key} writes the same contract in every state`).toBe(
        EVERY_STATE[key].length,
      )
    }
  })

  it('has a rule in some sheet for every switch it writes', () => {
    /* The other direction of the same question: a property written and never
       used is a control that moves a value nothing reads. */
    const css = sheets()
    for (const [name, value] of Object.entries(vars())) {
      if (value !== null) continue
      expect(css.includes(`[style*="${name}"]`), `${name} is written and gated on nowhere`).toBe(true)
    }
  })
})

describe('paragraph separation', () => {
  it('offers space, indent and both — and never neither', () => {
    /* No space AND no indent runs the prose together with nothing to separate
       it. `SPACING.paragraph` records withdrawing its own zero step for exactly
       that reason; `indent` is what makes taking the space away safe now. */
    expect(SEPARATIONS).toEqual(['space', 'indent', 'both'])
  })

  it('takes the space away for indent, and keeps it for both', () => {
    expect(vars({ separation: 'indent' })['--paper-para']).toBe('0')
    expect(vars({ separation: 'indent' })['--paper-indent']).toBe(`${PARAGRAPH_INDENT}em`)
    expect(vars({ separation: 'both' })['--paper-para']).toBe('1')
    expect(vars({ separation: 'both' })['--paper-indent']).toBe(`${PARAGRAPH_INDENT}em`)
  })

  it('indents only a paragraph that follows another, which is the convention', () => {
    /* The first paragraph after a heading takes no indent, because there is
       nothing above it to be told apart from. An adjacent-sibling selector says
       exactly that — and against the PROSE MARKER on both sides, so a centred
       dedication following a centred epigraph is not indented into prose. */
    const rule = /\[style\*="--paper-indent"\]\)\s*p\[data-paper-prose\] \+ p\[data-paper-prose\]/
    expect(strip(sheets())).toMatch(rule)
  })

  it('marks the indent, because it is the reader’s and not a default', () => {
    const css = strip(sheets())
    const at = css.indexOf('--paper-indent"])')
    expect(css.slice(at, css.indexOf('}', at))).toContain('!important')
  })
})

describe('the tiers WI-14.4 assigns', () => {
  /**
   * WHICH SHEET A SETTING LIVES IN IS THE WHOLE OF WHETHER A BOOK CAN REFUSE
   * IT, and the plan's tier column is a decision rather than a detail. The
   * house settings are defaults and go unmarked in `before`, where a book that
   * states a view wins. The four that are the READER speaking go marked in
   * `after`, where only `!important` can be beaten.
   */
  const inBefore = (needle: string) => strip(bookSheets()[0]).includes(needle)
  const inAfter = (needle: string) => strip(bookSheets()[1]).includes(needle)

  it('puts the house settings in the before tier, so a book still wins', () => {
    for (const gate of [
      '--paper-drop-cap',
      '--paper-small-caps',
      '--paper-heading-scale',
      '--paper-quote-rule',
      '--paper-quote-tint',
      '--paper-code-wrap',
      '--paper-figure-hairline',
      '--paper-figure-shadow',
      '--paper-table-shrink',
      '--paper-cjk-space',
    ]) {
      expect(inBefore(gate), `${gate} is not a house default in the before tier`).toBe(true)
      expect(inAfter(gate), `${gate} is also in the appended tier`).toBe(false)
    }
  })

  it('puts the reader’s own in the appended tier, marked', () => {
    for (const gate of ['--paper-indent', '--paper-min-size', '--paper-figure-scale']) {
      expect(inAfter(gate), `${gate} is not in the appended tier`).toBe(true)
      expect(inBefore(gate), `${gate} is a house default, which it is not`).toBe(false)
    }
    /* The note's own, which lives in the note tier and only there — a page has
       no `body > *` that means what it means in a popover. */
    expect(noteSheets()[1]).toContain('--paper-note-prose')
    expect(inAfter('--paper-note-prose')).toBe(false)
  })

  it('adds nothing marked to the before tier', () => {
    /* Restated here because WI-14.4 is where it would break: ten new rules
       landed in that sheet at once, and one `!important` among them makes the
       tier meaningless without changing anything a reader can see. */
    expect(strip(bookSheets()[0])).not.toContain('!important')
  })
})

/**
 * THE HOUSE RATIOS — 80% for a footnote, 90% for everything that is not running
 * text. Paper set none of these, so a quotation, a table, a list and a code
 * block all inherited 100% and read, next to a paragraph, like more paragraph.
 */
describe('the house font ratios', () => {
  const before = () => strip(bookSheets()[0])

  it('sets a quotation, a table, a list and a code block at 90%', () => {
    const css = before()
    const at = css.indexOf('\nblockquote, table, ul, ol, pre {')
    expect(at, 'the 90% rule is gone').toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain('font-size: 0.9em')
  })

  it('sets inline code at 90% of the line it sits in', () => {
    const css = before()
    const at = css.indexOf('\ncode, kbd, samp {')
    expect(at, 'the inline code rule is gone').toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain(`font-size: ${READING_RATIOS.code}em`)
  })

  /**
   * THE PANEL IS THE CONTEXT'S HEIGHT, AND THE ARITHMETIC IS EASY TO GET
   * BACKWARDS.
   *
   * A background on an inline element paints the CONTENT AREA, which scales
   * with the font size — so code at nine tenths paints a box nine tenths as
   * tall as the text around it. Half the shortfall above and half below puts it
   * back. But inside an element whose `font-size` is `0.9em`, `1em` is 0.9 of
   * the CONTEXT for every other property, so a plain `0.05em` would be 0.045 of
   * the context and the panel would still be short. Every length in that rule
   * is divided by the ratio for exactly this reason.
   */
  it('pads the code panel in the CONTEXT’s em, not the code’s', () => {
    const css = before()
    const at = css.indexOf('padding-block:')
    expect(at, 'the code panel padding is gone').toBeGreaterThan(-1)
    const written = /padding-block:\s*([\d.]+)em/.exec(css.slice(at))?.[1]
    expect(written, 'the padding is not in em').toBeDefined()
    /* What it comes to once the element's own 0.9em is applied. */
    const inContext = Number(written) * READING_RATIOS.code
    expect(inContext).toBeCloseTo(CODE_PANEL_PAD, 4)
    /**
     * AND THE PANEL COMES BACK TO THE CONTEXT'S PAINTED HEIGHT.
     *
     * Not to its font size — half of one tenth is the right answer to the wrong
     * question. What is short is the CONTENT AREA, which is `CONTENT_AREA`
     * times the font size, so the compensation carries the same factor. At a
     * flat 0.05 this asserted parity in font-size terms and the panel still
     * measured 97.1% of the surrounding text in the running app.
     */
    const contextBox = CONTENT_AREA
    const codeBox = READING_RATIOS.code * CONTENT_AREA + inContext * 2
    expect(codeBox / contextBox).toBeCloseTo(1, 4)
  })

  it('derives every ratio from one constant rather than repeating a literal', () => {
    /* `code` needs its ratio TWICE — once to shrink the text and once to divide
       the padding back out — and two literals that must stay reciprocal is a
       drift waiting to happen. */
    const css = before() + strip(bookSheets()[1]) + strip(noteSheets()[1])
    expect(READING_RATIOS.code * CONTENT_AREA + CODE_PANEL_PAD * 2).toBeCloseTo(CONTENT_AREA, 4)
    expect(css).toContain(`font-size: ${READING_RATIOS.block}em`)
    expect(css).toContain(`font-size: ${READING_RATIOS.footnote}em`)
    expect(css).toContain(`font-size: ${READING_RATIOS.footnote}rem`)
  })

  /**
   * THE TRAP, AND IT FAILS SILENTLY. `em` is a share of the PARENT, so every one
   * of these nested inside another compounds: a list inside a list is 81%, and
   * inside a quotation as well it is 73%. Books nest all of them — sub-lists are
   * ordinary and a quotation containing a list is ordinary — so the reset is
   * not a corner case, it is the common case.
   */
  it('takes the ninety per cent ONCE, however deeply these nest', () => {
    const css = before()
    expect(css).toContain(':is(blockquote, table, ul, ol, pre) :is(blockquote, table, ul, ol, pre)')
    const at = css.indexOf(':is(blockquote, table, ul, ol, pre) :is(')
    expect(css.slice(at, css.indexOf('}', at))).toContain('font-size: 1em')
  })

  it('does not shrink code twice inside a pre', () => {
    /* The block rule has already taken the nine tenths; `<pre><code>` is the
       spec's own idiom for a code block, so this is the ordinary shape. */
    const css = before()
    const at = css.indexOf('\npre code, pre kbd, pre samp {')
    expect(at, 'the pre-code reset is gone').toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain('font-size: 1em')
  })

  it('sets a footnote at 80%, marker and note alike', () => {
    const css = before() + strip(bookSheets()[1]) + strip(noteSheets()[1])
    const marker = css.indexOf('a[epub|type~="noteref"]')
    expect(marker, 'the noteref rule is gone').toBeGreaterThan(-1)
    expect(css.slice(marker, css.indexOf('}', marker))).toContain('font-size: 0.8em')
    const note = css.indexOf('--paper-note-prose')
    expect(note, 'the note rule is gone').toBeGreaterThan(-1)
    expect(css.slice(note, css.indexOf('}', note))).toContain('font-size: 0.8rem')
  })
})

/**
 * THE CODE PANEL, AND THE RULE THAT NEARLY DELETED IT.
 *
 * WI-14.6 lost a whole release to this exact interaction: a blanket
 * `background-color: transparent !important` on a dark page beats any unmarked
 * background whatever its specificity, so the matte was inert on precisely the
 * pages it existed for and intact on the ones that never needed it.
 */
describe('the panel behind code', () => {
  it('mixes the panel from the reader’s ink rather than naming a grey', () => {
    /* A literal light grey is right on four themes and a bright slab on the
       fifth, which is the defect WI-14.1 exists to remove. */
    const css = strip(bookSheets()[0])
    const at = css.indexOf('\npre, code, kbd, samp {\n  background:')
    expect(at, 'the code panel is gone').toBeGreaterThan(-1)
    expect(css.slice(at, css.indexOf('}', at))).toContain('var(--paper-ink)')
  })

  it('exempts code from the dark page’s blanket clear', () => {
    /* At (0,0,1) the panel cannot outrank the clear at (0,4,1), so the clear
       has to stop MATCHING rather than be beaten — the same answer the matte
       arrived at, by the same route. */
    const css = strip(bookSheets()[1])
    const at = css.indexOf('background-color: transparent')
    expect(at, 'the blanket clear is gone').toBeGreaterThan(-1)
    const selector = css.slice(css.lastIndexOf('\n', css.lastIndexOf('{', at)), at)
    for (const tag of ['pre', 'code', 'kbd', 'samp']) {
      expect(selector, `${tag} is not exempt from the clear`).toContain(`:not(${tag})`)
    }
  })

  it('repaints the panel on a dark page, marked', () => {
    /* With the clear out of the way the thing left to beat is a publisher
       background, and a light grey `pre` from the book is the slab this
       prevents. */
    const css = strip(bookSheets()[1])
    const at = css.indexOf(':is(pre, code, kbd, samp)')
    expect(at, 'the dark-page panel is gone').toBeGreaterThan(-1)
    const rule = css.slice(at, css.indexOf('}', at))
    expect(rule).toContain('!important')
    expect(css.slice(0, at)).toContain('--paper-dark-page')
  })
})

describe('the settings that need more than a rule', () => {
  it('reads the code face from the registry rather than restating a stack', () => {
    /* A face's stack was written twice once before — for the book and for its
       sample — so a face could be previewed in something other than what the
       reader would get. One registry. */
    expect(vars({ codeFace: 'paper' })['--paper-code-family']).toContain('IBM Plex Mono')
  })

  it('writes the figure cap in em when it follows the type, and per cent otherwise', () => {
    /* A share of the MEASURE and a share of the TYPE are different questions,
       and a reader enlarging the text for their eyes is asking the second. */
    expect(vars({ figureScalesWithText: false, figureWidth: 4 })['--paper-figure-width']).toBe('100%')
    expect(vars({ figureScalesWithText: true, figureWidth: 4 })['--paper-figure-width']).toBe('10em')
  })

  it('uses the prefixed drop cap, which is the one this engine has', () => {
    /* Measured in the running app rather than assumed:
       `CSS.supports('initial-letter', '2')` is false there and the prefixed
       form is true. Both are written, so the unprefixed one starts working the
       day WebKit ships it — and neither is a fallback for the other, since an
       unsupported declaration is dropped and the supported one stands. */
    const css = strip(sheets())
    expect(css).toContain('-webkit-initial-letter')
    expect(css).toContain('\n  initial-letter')
  })

  it('marks the note size, or a book’s own class beats it', () => {
    /* `body > *` is (0,0,1) and a book's `.footnote { font-size: 70% }` is
       (0,1,0) — higher. Unmarked, this rule loses to the very declaration it
       exists to answer and the 11.2px note comes back on any book that names
       its notes by class. WI-14.4 puts Note size in the `after` tier, and
       `after` means marked; it shipped unmarked and an audit caught it. */
    const note = strip(noteSheets()[1])
    const at = note.indexOf('--paper-note-prose')
    expect(at, 'the note rule is gone — this asserts nothing').toBeGreaterThan(-1)
    expect(note.slice(at, note.indexOf('}', at))).toContain('!important')
  })

  it('makes a scrolling table a block, which is what gives it a scroll port', () => {
    /* `overflow-x` is not honoured on a `display: table` box, so the scroll
       branch scrolled nothing at all until an audit read the rule against its
       own comment — which had said `display: block` from the start. */
    const before = strip(bookSheets()[0])
    const at = before.indexOf('\ntable {')
    expect(at, 'the table rule is gone').toBeGreaterThan(-1)
    const rule = before.slice(at, before.indexOf('}', at))
    expect(rule).toContain('display: block')
    expect(rule).toContain('overflow-x: auto')
  })

  it('builds the floor’s selector from the marker’s own constants', () => {
    /* The attribute and the property are ONE contract with `markSmallText`.
       Restated as literals here, a rename there leaves a rule matching nothing
       — silently, which is this area's recurring failure. */
    expect(strip(sheets())).toContain(`[${SMALL_ATTR}]`)
    expect(strip(sheets())).toContain(`var(${SMALL_VAR})`)
  })

  it('spaces CJK with a property, never by inserting a character', () => {
    /* Every mark in this app is CFI-anchored with 32 characters of context
       either side, and inserting so much as a space invalidates them all. This
       is why the setting is `text-autospace` and not pangu.js. */
    expect(strip(sheets())).toContain('text-autospace')
  })
})
