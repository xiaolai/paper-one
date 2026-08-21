// @vitest-environment jsdom
//
// `bookCss` copies the host's @font-face rules out of `document.styleSheets`,
// so it needs a document even where the assertion is about a plain declaration.
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../core/uiTypes'
import { bookCss, isDark } from './bookCss'

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
  stepIdx: 2,
  theme,
  typeface: 'literata' as const,
  align: 'justified' as const,
  spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
  brightness: 1,
  contrast: 0,
})

const sheet = (theme: (typeof THEME_IDS)[number]) =>
  bookCss(settings(theme)).replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * A rule beginning with `:root *`, by index, or null.
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
    at = css.indexOf('\n:root *', at + 1)
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

  it('agrees with every theme the app actually ships', () => {
    /* Exactly one of the five is dark. A second one appearing without this
       file changing is the case the whole derivation exists for. */
    const dark = THEME_IDS.filter((t) => inkRule(sheet(t)) !== null)
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
    expect(rule).toContain(':root *')
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
    expect(sheet('night')).toMatch(/:root svg text \{[^}]*fill: currentColor !important/)
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
    expect(rule.startsWith('\n:root *')).toBe(true)
  })

  it('leaves a light page entirely alone', () => {
    /* A book's dark ink reads perfectly well on a light page, and taking its
       colours over there would flatten composition for no reader benefit. */
    for (const theme of ['paper', 'sepia', 'sage', 'slate'] as const) {
      expect(inkRule(sheet(theme)), theme).toBeNull()
    }
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
