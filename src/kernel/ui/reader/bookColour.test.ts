// @vitest-environment jsdom
//
// `bookCss` copies the host's @font-face rules out of `document.styleSheets`,
// so it needs a document even where the assertion is about a plain declaration.
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../core/uiTypes'
import { bookSheets, bookVars, isDark, resolvedBookCss } from './bookCss'
import { DEFAULT_STEP_IDX } from '../../core/metrics'

/**
 * Whose colour wins, and where the book's own furniture stops.
 *
 * THE DEFECT: Paper sets `color` on `html` and reaches everything else by
 * INHERITANCE — and inheritance is consulted only where the cascade produced no
 * value at all. So any colour the book declares anywhere beats it. Measured
 * over 1,957 books: 1,400 (71.5%) declare a text colour somewhere, 860 (43.9%)
 * declare one dark enough to disappear on a night page, 401 (20.5%) do it from
 * an inline style or a `<font color>` where not even the book's own stylesheet
 * is involved. A reader choosing a dark theme and getting black text is a
 * control being overruled, which this sheet refuses everywhere else.
 */

const settings = (theme: (typeof THEME_IDS)[number]) => ({
  stepIdx: DEFAULT_STEP_IDX,
  theme,
  typeface: 'literata' as const,
  align: 'justified' as const,
  spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
  brightness: 1,
  contrast: 0,
})

const sheet = (theme: (typeof THEME_IDS)[number]) =>
  resolvedBookCss(settings(theme)).replace(/\/\*[\s\S]*?\*\//g, '')

/** The contract written onto the document's root — where the switch lives. */
const vars = (theme: (typeof THEME_IDS)[number]) => bookVars(settings(theme))

/**
 * WHAT MOVED, AND WHY THESE TESTS ASK A DIFFERENT QUESTION NOW (WI-14.3).
 *
 * These rules used to be ABSENT from the sheet on a light theme — the whole
 * block was interpolated in only when the page was dark. The sheet is static
 * now, so they are always in it, and whether they APPLY is decided by one
 * property on the root: present, and every rule keyed to its name matches;
 * removed, and none of them do.
 *
 * So "leaves a light page alone" is an assertion about `bookVars`, not about
 * the text of the sheet. Asked of the sheet it would now pass for the wrong
 * reason in one direction and fail for the wrong reason in the other.
 */
const DARK_GATE = ':root:where([style*="--paper-dark-page"])'

/**
 * A rule beginning with the dark gate and `*`, by index, or null.
 *
 * THERE ARE TWO OF THEM AND THAT IS DELIBERATE. The first forces colour and
 * border on every descendant; the second clears backgrounds and carries the
 * exemptions, because an element that keeps its own background — a matted
 * figure, the ruler band — should still take the reader's ink. Folded into one
 * rule, the exemption took `color` away too.
 */
function rootRule(css: string, nth = 0): string | null {
  let at = -1
  for (let i = 0; i <= nth; i += 1) {
    at = css.indexOf(`\n${DARK_GATE} *`, at + 1)
    if (at < 0) return null
  }
  return css.slice(at, css.indexOf('\n}', at))
}

/** The rule that takes the book's ink over. */
const inkRule = (css: string) => rootRule(css, 0)
/** The rule that clears the book's backgrounds, and its exemptions. */
const backgroundRule = (css: string) => rootRule(css, 1)

describe('isDark', () => {
  it('knows the library from its page colour, not from a theme name', () => {
    /* Asked of the colour so that a future dark theme is covered by
       construction. Spelled as `theme === 'night'` it was a fact stored twice,
       and the second copy is the one that would have been forgotten. */
    expect(isDark('#16191C')).toBe(true)
    expect(isDark('#FFFFFF')).toBe(false)
    expect(isDark('#F8F0E1')).toBe(false)
    expect(isDark('#DDE6D8')).toBe(false)
    expect(isDark('#DFE1DE')).toBe(false)
  })

  it('survives a value it cannot read', () => {
    expect(isDark('not a colour')).toBe(false)
  })

  it('reads a three-digit hex as the colour it is', () => {
    /* `parseInt('fff', 16)` is 4095, which as a six-digit colour is
       `rgb(0, 15, 255)` — luma 38, DARK. White reported as dark, and every rule
       gated on a dark page would have come on over it. Paper's own themes are
       all six-digit so nothing shipped wrong, but `isDark` is exported and
       `pageFilter` decides a PDF's inversion with it. */
    expect(isDark('#fff')).toBe(false)
    expect(isDark('#000')).toBe(true)
    expect(isDark('#FFF')).toBe(false)
  })

  it('refuses a string that is not a colour rather than parsing a prefix of it', () => {
    /* `parseInt` stops at the first character it cannot read, so `#ffgarbage`
       came out as `0xff` — a very dark blue — and returned true. */
    expect(isDark('#ffgarbage')).toBe(false)
    expect(isDark('#ff')).toBe(false)
    expect(isDark('')).toBe(false)
  })

  it('agrees with every theme the app actually ships', () => {
    /* Exactly one of the five is dark. A second one appearing without this
       file changing is the case the whole derivation exists for.

       ASKED OF THE SWITCH, not of the sheet — see `DARK_GATE`. The rules are in
       the sheet for every theme now and it is this property that decides. */
    const dark = THEME_IDS.filter((t) => vars(t)['--paper-dark-page'] !== null)
    expect(dark).toEqual(['night'])
  })
})

describe('the theme wins on a dark page', () => {
  it('forces every descendant, not the marked prose containers', () => {
    /* THE MISTAKE THIS REPLACES. The first design targeted
       `[data-paper-prose]`, which `markProse` puts only on p, li, blockquote
       and dd — so `<p data-paper-prose><span style="color:#000">` stayed black,
       because forcing a parent only makes the child INHERIT and the child's own
       declaration beats inheritance. That is the identical cascade rule the
       defect is made of, turned on the fix. `:root *` reaches any depth. */
    const rule = inkRule(sheet('night'))
    expect(rule).not.toBeNull()
    expect(rule).toContain(`${DARK_GATE} *`)
    expect(rule).not.toContain('data-paper-prose')
  })

  it('puts the value on the root and makes everything else inherit it', () => {
    /* `color: inherit`, never `color: <ink>`. One place holds the value and
       every element is forced back onto the chain the book broke; a rule naming
       the ink reaches only the elements it selects. Taken from Readium CSS. */
    expect(inkRule(sheet('night'))).toContain('color: inherit !important')
    expect(sheet('night')).toMatch(/html \{[^}]*color: #E9EAE8/)
  })

  it('spares links, or every one of them dissolves into the text', () => {
    expect(inkRule(sheet('night'))).toContain(':not(a)')
  })

  it('clears the book’s backgrounds, which the defect’s own name omits', () => {
    /* A callout with `background: #fff` is a white slab on a dark page however
       right its text colour is. */
    expect(backgroundRule(sheet('night'))).toContain('background-color: transparent !important')
  })

  it('carries borders to the current colour', () => {
    expect(inkRule(sheet('night'))).toContain('border-color: currentColor !important')
  })

  it('reaches SVG text, which takes fill and not color', () => {
    /* No colour rule however broad touches it — a separate failure mode. */
    expect(sheet('night')).toContain(`${DARK_GATE} svg text {`)
    expect(sheet('night')).toMatch(/svg text \{[^}]*fill: currentColor !important/)
  })

  it('spares a matted figure, or the matte is deleted where it is needed', () => {
    /* THE BUG THIS EXISTS FOR, shipped for exactly one commit. `!important`
       beats non-important whatever the specificity, so
       `background-color: transparent !important` at (0,3,1) defeated
       `img[data-paper-matte]` at (0,1,1) — and it only did so on a DARK page,
       which is the sole place a matte does anything. The feature was inert
       where it mattered and intact where it did not, which is the shape of a
       defect nobody notices for a long time. */
    expect(backgroundRule(sheet('night'))).toContain(':not([data-paper-matte])')
    /* And ONLY from the background rule: a matted figure still takes the
       reader's ink and border, which the first version took away with it. */
    expect(inkRule(sheet('night'))).not.toContain(':not([data-paper-matte])')
  })

  it("spares Paper's own painted elements", () => {
    /* The ruler band and the spoken word ARE backgrounds. Swept up by a blanket
       transparent, the reading ruler stops existing in night mode. */
    const rule = backgroundRule(sheet('night'))
    expect(rule).toContain(':not(.paper-ruler-band)')
    expect(rule).toContain(':not(.paper-spoken-word)')
  })

  it('never selects the root itself, which owns the page colour', () => {
    /* `*` would match `html`, and an important transparent background there
       takes the theme away altogether. */
    const rule = inkRule(sheet('night')) ?? ''
    expect(rule.startsWith(`\n${DARK_GATE} *`)).toBe(true)
  })

  it('leaves a light page entirely alone', () => {
    /* A book's dark ink reads perfectly well on a light page, and taking its
       colours over there would flatten composition for no reader benefit.

       The switch is REMOVED, not set to something falsy. A custom property
       present with an empty value is still present, and `[style*=...]` would go
       on matching — every rule above in force on a white page. */
    for (const theme of ['paper', 'sepia', 'sage', 'slate'] as const) {
      expect(vars(theme)['--paper-dark-page'], theme).toBeNull()
    }
  })

  /**
   * THE GATE COSTS NO SPECIFICITY, which is the whole of why the split could be
   * behaviour-preserving.
   *
   * `:root:where([style*=…])` is `(0,1,0)` — exactly `:root`, because `:where()`
   * contributes nothing. Written `:root[style*=…]` it would be `(0,2,0)`, and
   * these rules would start winning arguments against Paper's OWN important
   * declarations that they used to lose. The matte is the one that already went
   * wrong once that way.
   */
  it('forces the root’s own colour, not only its descendants’', () => {
    /**
     * THE HOLE IN THE MIDDLE OF THIS RULE. Everything below inherits from the
     * root — that is the whole mechanism — so a publisher who wins the root
     * wins the document: `html.chapter { background: #fff; color: #111 }`
     * outranks Paper's bare `html` rule, and every descendant then dutifully
     * inherits the publisher's ink onto a page the reader asked to be dark.
     *
     * Readium marks the root for exactly this reason and WI-14.1 quotes the
     * rule with the mark on it; Paper shipped the descendants marked and the
     * root not.
     */
    const css = sheet('night')
    const at = css.indexOf(`\n${DARK_GATE} {`)
    expect(at, 'there is no rule forcing the root itself').toBeGreaterThan(-1)
    const rule = css.slice(at, css.indexOf('\n}', at))
    expect(rule).toContain('color: #E9EAE8 !important')
    expect(rule).toContain('background: #16191C !important')
    /* And the scheme with them, or form controls and scrollbars keep the
       publisher's light idea of the page. */
    expect(rule).toContain('color-scheme: dark !important')
  })

  it('gates on the property being present, at no cost in specificity', () => {
    const rule = inkRule(sheet('night')) ?? ''
    expect(rule).toContain(':where([style*=')
    expect(rule).not.toContain(':root[style*=')
    /* And the NAME, never the value: how a browser serialises a declaration it
       was handed through `setProperty` is not something to depend on. */
    expect(rule).not.toContain('--paper-dark-page:')
  })
})

describe('a <font> tag does not outrank the reader', () => {
  it('resets the element in every theme', () => {
    /* 114 books, 308,899 tags: size= (205,416), color= (102,602), face=
       (21,085). Each is a presentational hint — a declared value on the
       element — so it beats anything reaching it by inheritance. */
    for (const theme of THEME_IDS) {
      expect(sheet(theme), theme).toMatch(/\nfont \{[^}]*font: inherit/)
      expect(sheet(theme), theme).toMatch(/\nfont \{[^}]*color: inherit/)
    }
  })

  it('sits in the before tier, which is what lets a book win at all', () => {
    /* Unmarked is half of it; the tier is the other half. In the appended
       sheet an unmarked rule still beats the book's equal-specificity
       declaration on source order — see WI-14.0, where that is measured as the
       thing Paper had been doing to 61%% of the library by accident. */
    const [before, after] = bookSheets()
    expect(before.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(/\nfont \{/)
    expect(after.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\nfont \{/)
  })

  it('is unmarked, so a book with real CSS still wins', () => {
    /* A hint loses to any author rule, so no mark is needed to beat it — and
       marking it would take the element from the 24 books that style `font`
       deliberately. Measured: zero books do both. */
    const rule = sheet('night').match(/\nfont \{[^}]*\}/)?.[0] ?? ''
    expect(rule).not.toContain('!important')
  })

  it('leaves <center> alone', () => {
    /* 1,666 books contain one, almost always exactly one — a title page or a
       dedication. That is the book composing, and `markProse` already exists to
       tell composition from a converter's default. */
    expect(sheet('night')).not.toMatch(/\ncenter \{/)
  })
})
