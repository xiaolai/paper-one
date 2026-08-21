// @vitest-environment jsdom
//
// `bookSheets` copies the host's @font-face rules out of `document.styleSheets`
// into the appended tier, so it needs a document even where the assertion is
// about which tier a rule is in.
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../core/uiTypes'
import { applyBookVars, bookSheets, bookVars, measurementKey, noteSheets, resolveBookVars } from './bookCss'

/**
 * THE VARIABLE CONTRACT (WI-14.3): two static sheets, and the settings as
 * custom properties on each document's root.
 *
 * WHAT IT REPLACED. `bookCss(settings)` rebuilt all 585 lines of the stylesheet
 * as a string on every change to step, theme, typeface, spacing, align,
 * brightness or contrast — re-reading `document.styleSheets` on the way — and
 * re-injected it, forcing a full CSS re-parse in every open document. That is
 * F4. It is also why adding a setting meant editing a template literal, why
 * there was nowhere to put a fidelity dial, and why PDF could share none of it.
 *
 * WHAT THIS FILE HOLDS is the part of the split that is invisible when it
 * breaks. A rule in the wrong tier still parses. A variable the sheet reads and
 * the contract never writes still parses — the declaration is simply invalid at
 * computed-value time and drops, and a book renders unstyled with nothing
 * logged anywhere.
 */

const settings = (over: Partial<Parameters<typeof bookVars>[0]> = {}) => ({
  stepIdx: 2,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  align: 'justified' as const,
  spacing: { letter: 1, word: 1, line: 1, paragraph: 1 },
  brightness: 1,
  contrast: 0,
  ...over,
})

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the two tiers', () => {
  it('gives each sheet its own @namespace prologue', () => {
    /**
     * `@namespace` IS PER STYLESHEET, and this is the trap the split had
     * waiting. The noteref rule is `a[epub|type~="noteref"]`; leave the
     * declaration in the other sheet and the selector does not error, it simply
     * stops matching. Every footnote link loses its superscript and nothing
     * anywhere says why.
     */
    for (const sheet of bookSheets()) {
      expect(sheet).toContain('@namespace epub "http://www.idpf.org/2007/ops";')
    }
    const [, after] = bookSheets()
    expect(after, 'the rule that needs the prefix is in the appended tier').toContain(
      'a[epub|type~="noteref"]',
    )
  })

  it('marks nothing at all in the before tier', () => {
    /* The tier only means anything because a book that states a view wins
       there. A marked rule in `before` beats the book from the wrong end of the
       cascade, which makes the two sheets one again — and would do it
       silently, since the rule goes on applying either way. */
    const [before] = bookSheets()
    expect(strip(before)).not.toContain('!important')
  })

  it('keeps the bundled faces in the appended tier and nowhere else', () => {
    /* The last matching @font-face for a family wins. In `before`, a book that
       declares a face of the same name shadows the bundled one — and the
       Literata the whole reading typography is specified around silently
       becomes somebody else's, with no error of any kind. */
    const [before, after] = bookSheets()
    expect(before).not.toContain('@font-face')
    /* The host has no font CSS under jsdom, so what is asserted is the SLOT:
       the note naming it is in `after`, and `before` carries neither. */
    expect(after).toContain('The bundled faces, carried in from the host')
    expect(before).not.toContain('The bundled faces, carried in from the host')
  })

  it('puts the presentational reset in the before tier, where a book still wins', () => {
    /* 114 books ship 308,899 `<font>` tags and 24 books style the element in
       CSS; zero do both. A presentational hint loses to any author rule, so the
       reset needs no mark — and putting it in `after` would take the element
       from the 24 books that mean it. */
    const [before, after] = bookSheets()
    expect(strip(before)).toMatch(/\nfont \{/)
    expect(strip(after)).not.toMatch(/\nfont \{/)
  })
})

/**
 * THE INVARIANT THAT MAKES THE SPLIT SAFE.
 *
 * Every `var(--paper-*)` in the sheets must be something `bookVars` writes. A
 * variable that is read and never written is not an error and not a warning:
 * the declaration is invalid at computed-value time and drops, so
 * `margin-block: calc(var(--paper-line) * 1.5)` becomes no margin at all, on
 * every heading in the book, and the page just looks wrong.
 *
 * This is the assertion that would have caught a document the wiring missed,
 * which is the failure mode the whole design introduces.
 */
describe('the sheets and the contract agree', () => {
  /* EVERY SHEET THE READER EVER SEES, the note's included. The note tier is
     the page's two with one extra rule appended, and that rule is gated — so a
     scan of the page sheets alone would report its switch as written and never
     used, which is exactly the shape of a real defect this suite hunts. */
  const allSheets = () => [...bookSheets(), ...noteSheets()].join('\n')

  const read = () => {
    const names = new Set<string>()
    for (const m of allSheets().matchAll(/var\((--paper-[\w-]+)\)/g)) {
      names.add(m[1] ?? '')
    }
    return names
  }

  it('reads no variable the contract does not define', () => {
    const defined = new Set(Object.keys(bookVars(settings())))
    /* Set on the ELEMENT, not by the contract on the root, because each is a
       fact about one element rather than about the reader: `--paper-matte` is
       the colour sampled from one image's own corners, and `--paper-em` is how
       small one piece of text already is. See `matteFigures`, `markSmallText`. */
    defined.add('--paper-matte')
    defined.add('--paper-em')
    const missing = [...read()].filter((name) => !defined.has(name))
    expect(missing, `\nread by the sheets, never written by bookVars:\n  ${missing.join('\n  ')}\n`).toEqual([])
  })

  it('finds variables at all, so the scan above can fail', () => {
    expect(read().size).toBeGreaterThan(8)
  })

  /** Every name the sheets use as an attribute-presence gate — see `when`. */
  const gates = () => {
    const names = new Set<string>()
    for (const m of allSheets().matchAll(/\[style\*="(--paper-[\w-]+)"\]/g)) {
      names.add(m[1] ?? '')
    }
    return names
  }

  it('writes nothing the sheets neither read nor switch on', () => {
    /* A variable written and never used is dead weight in every document, and a
       SWITCH that nothing gates on is worse: it reads as a working setting.
       Derived rather than listed, so adding a switch cannot quietly widen the
       exemption — the sheet itself has to name it. */
    const unused = Object.keys(bookVars(settings())).filter(
      (name) => !read().has(name) && !gates().has(name),
    )
    expect(unused, `\nwritten by bookVars, neither read nor gated on:\n  ${unused.join('\n  ')}\n`).toEqual([])
  })

  it('gates on nothing the contract does not write', () => {
    /* The other direction, and the one that fails silently: a gate whose
       property name is misspelled matches nothing, so the setting behind it
       does nothing at all and no test that only reads the sheet can see it. */
    const written = new Set(Object.keys(bookVars(settings())))
    const orphans = [...gates()].filter((name) => !written.has(name))
    expect(orphans, `\ngated on by the sheets, never written by bookVars:\n  ${orphans.join('\n  ')}\n`).toEqual([])
  })

  it('has no gate name that is a prefix of another property', () => {
    /**
     * `[style*="…"]` IS A SUBSTRING MATCH, so a gate named `--paper-indent`
     * would also fire on a `--paper-indent-on` beside it — the rule would be in
     * force in the state that turns it off, and nothing would report it. There
     * is no `--paper-indent-on` for exactly this reason; this is what stops one
     * being added.
     */
    const written = Object.keys(bookVars(settings()))
    const collisions: string[] = []
    for (const gate of gates()) {
      for (const name of written) {
        if (name !== gate && name.startsWith(gate)) collisions.push(`${gate} also matches ${name}`)
      }
    }
    expect(collisions, `\n${collisions.join('\n')}\n`).toEqual([])
  })
})

describe('the contract', () => {
  it('resolves the reader’s size, leading and face', () => {
    const vars = bookVars(settings())
    expect(vars['--paper-size']).toMatch(/^\d+px$/)
    expect(vars['--paper-line']).toBe('34px')
    expect(vars['--paper-line-scale']).toBe('1')
    expect(vars['--paper-family']).toContain('Literata')
  })

  it('moves when a setting moves, which is the whole of a settings change', () => {
    const at = (stepIdx: number) => bookVars(settings({ stepIdx }))['--paper-size']
    expect(at(2)).not.toBe(at(5))
  })

  it('writes the values onto a document’s root, inline', () => {
    /* INLINE, WHICH IS NOT AN IMPLEMENTATION DETAIL. A rule in a stylesheet
       would carry the same values and the two switches would stop working:
       `[style*="--paper-dark-page"]` reads the root's style ATTRIBUTE, and a
       custom property declared in a sheet never appears there. */
    const doc = document.implementation.createHTMLDocument('t')
    applyBookVars(doc, settings({ theme: 'night' }))
    expect(doc.documentElement.style.getPropertyValue('--paper-line')).toBe('34px')
    expect(doc.documentElement.getAttribute('style')).toContain('--paper-dark-page')
  })

  it('REMOVES a switch rather than blanking it', () => {
    /* A property present with an empty value is still present, and
       `[style*=…]` goes on matching. Written that way, every dark rule in the
       sheet stays in force on a white page — which is the exact failure the
       presence mechanism is chosen for. */
    const doc = document.implementation.createHTMLDocument('t')
    applyBookVars(doc, settings({ theme: 'night' }))
    expect(doc.documentElement.getAttribute('style')).toContain('--paper-dark-page')
    applyBookVars(doc, settings({ theme: 'paper' }))
    expect(doc.documentElement.getAttribute('style')).not.toContain('--paper-dark-page')
  })

  it('keys the small-text measurement on everything that can move a font size', () => {
    /**
     * NOT JUST `--paper-size`, which is what this compared first and was not
     * enough. The heading scale gives `h1`-`h6` sizes they did not have and the
     * note size resets a popover's own blocks — so an `h5` measured at the UA's
     * 0.83em is marked as small text, and turning Paper's heading scale on
     * takes it to 1.1em while the mark and its 0.83 ratio stay. The floor rule
     * is `!important`, so it would then SHRINK the heading: the exact damage
     * `markSmallText` exists to avoid, arriving through a stale measurement
     * rather than through a bad selector.
     */
    const doc = document.implementation.createHTMLDocument('t')
    const root = doc.documentElement
    const keyAfter = (over: Parameters<typeof bookVars>[0]) => {
      applyBookVars(doc, over)
      return measurementKey(root)
    }
    const base = keyAfter(settings())
    /* Settings that cannot change a computed font size leave the key alone. */
    for (const same of [settings({ theme: 'night' }), settings({ align: 'ragged' })]) {
      expect(keyAfter(same), 'a setting that changes no size moved the key').toBe(base)
    }
    /* The three that can, each move it on their own. */
    expect(keyAfter(settings({ stepIdx: 5 }))).not.toBe(base)
    expect(keyAfter(settings({ style: { headingScale: 'paper' } }))).not.toBe(base)
    expect(keyAfter(settings({ style: { noteSize: 'publisher' } }))).not.toBe(base)
  })

  it('leaves a book’s own inline style on the root alone', () => {
    const doc = document.implementation.createHTMLDocument('t')
    doc.documentElement.setAttribute('style', 'orphans: 2')
    applyBookVars(doc, settings())
    expect(doc.documentElement.style.getPropertyValue('orphans')).toBe('2')
  })

  it('survives a document with no root rather than throwing into a load handler', () => {
    expect(() => applyBookVars({} as unknown as Document, settings())).not.toThrow()
  })
})

/**
 * THE FIDELITY DIAL — the mechanism WI-14.1 identified as missing from this
 * item, and the answer to three separate objections.
 *
 * A custom property cannot make a stylesheet disappear. An attribute-presence
 * selector on the root can, and that is how one static sheet serves both
 * settings: the house typography sits unmarked in `before`, and `after` carries
 * a copy of it gated on the property. Present, and Paper wins on source order
 * exactly as it did when there was one sheet; absent, and the copy matches
 * nothing, so the book keeps its own.
 */
describe('the fidelity dial', () => {
  const GATE = ':where(:root[style*="--paper-fidelity-paper"])'

  it('defaults to paper, which is the one slot Paper’s sheet has always been in', () => {
    expect(bookVars(settings())['--paper-fidelity-paper']).toBe('1')
  })

  it('takes the switch away for the publisher', () => {
    expect(bookVars(settings({ style: { fidelity: 'publisher' } }))['--paper-fidelity-paper']).toBeNull()
  })

  it('carries the house typography in both tiers, gated only in the appended one', () => {
    const [before, after] = bookSheets()
    for (const selector of ['h1', 'a', 'blockquote']) {
      expect(strip(before), selector).toMatch(new RegExp(`(^|\\n|, )${selector}[ ,]`))
      expect(strip(after), selector).toContain(`${GATE} ${selector}`)
    }
  })

  it('gates exactly the three the corpus measured, and no reader control', () => {
    /* MEASURED, NOT ASSUMED. Links, headings and blockquotes are the contested
       house typography of WI-14.0's table. The other rows are not here and must
       not be: `body { text-align }` and `body { font-family }` are the READER'S
       controls, which no dial may hand to a publisher, and `img { max-width }`
       turned out not to compete at all — 7 books of 1,957. */
    const [, after] = bookSheets()
    const gated = [...strip(after).matchAll(/:where\(:root\[style\*="--paper-fidelity-paper"\]\)\s*([a-z0-9]+)/g)]
      .map((m) => m[1])
    expect(new Set(gated)).toEqual(new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'blockquote']))
    expect(strip(after)).not.toContain(`${GATE} body`)
    expect(strip(after)).not.toContain(`${GATE} img`)
  })

  it('adds no specificity, so it never wins an argument the book used to', () => {
    /* `:where()` contributes zero, so the gated copy is `(0,0,1)` — exactly
       `h1`. Written `:root[style*=…] h1` it would be `(0,2,1)` and would start
       beating `.chapter h1 { font-weight: 300 }`, which today wins. The dial
       exists to hand typography BACK, never to take more of it. */
    const [, after] = bookSheets()
    expect(after).toContain(':where(:root[style*="--paper-fidelity-paper"])')
    expect(strip(after)).not.toMatch(/(^|\n):root\[style\*="--paper-fidelity-paper"\]/)
  })

  it('writes the house declarations identically in both tiers', () => {
    /* One source, because two copies of nine declarations that must agree is a
       drift waiting to happen — and the drift would be invisible, since both
       sheets would still parse and only one configuration would be wrong. */
    const [before, after] = bookSheets()
    const declarations = (css: string, selector: string) =>
      strip(css)
        .slice(strip(css).indexOf(`${selector} {`))
        .slice(0, strip(css).slice(strip(css).indexOf(`${selector} {`)).indexOf('}'))
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .slice(1)
    expect(declarations(after, `${GATE} blockquote`)).toEqual(declarations(before, 'blockquote'))
  })
})

describe('the sheets are stable, which is what stops the re-parse', () => {
  it('hands back the same tuple by identity', () => {
    /* `setStyles` writes textContent on two style elements, and writing the
       same string back still re-parses the sheet in every open document. The
       caller skips the call on identity, so a fresh array every time would
       defeat F4's whole fix — silently, and only in a profiler. */
    expect(bookSheets()).toBe(bookSheets())
  })

  it('does not change when a setting changes', () => {
    const before = bookSheets()
    bookVars(settings({ theme: 'night', stepIdx: 6, align: 'ragged' }))
    expect(bookSheets()).toBe(before)
  })
})

describe('resolveBookVars', () => {
  it('substitutes what the contract defines and leaves the rest alone', () => {
    const vars = bookVars(settings())
    expect(resolveBookVars('a { color: var(--paper-accent) }', vars)).toContain('#1B3A6B')
    expect(resolveBookVars('a { color: var(--paper-nope) }', vars)).toContain('var(--paper-nope)')
  })

  it('leaves a variable the contract removes as it found it', () => {
    /* A `null` in the contract means the property is ABSENT from the root, so
       a `var()` reading it would fall back rather than resolve. Substituting
       "null" into the text would be a test reading a string that no browser
       would ever see. */
    const vars = bookVars(settings({ theme: 'paper' }))
    expect(vars['--paper-dark-page']).toBeNull()
    expect(resolveBookVars('x { y: var(--paper-dark-page) }', vars)).toContain('var(--paper-dark-page)')
  })
})

describe('every theme resolves the whole contract', () => {
  it('leaves no value undefined or NaN in any theme', () => {
    /* `undefined` reaches a stylesheet as the string "undefined" and a NaN as
       "NaNpx"; both parse as an invalid declaration and drop. Across five
       themes and both fidelities, nothing may. */
    for (const theme of THEME_IDS) {
      for (const fidelity of ['paper', 'publisher'] as const) {
        for (const [name, value] of Object.entries(bookVars(settings({ theme, style: { fidelity } })))) {
          if (value === null) continue
          expect(value, `${theme}/${fidelity} ${name}`).not.toContain('undefined')
          expect(value, `${theme}/${fidelity} ${name}`).not.toContain('NaN')
          expect(value.length, `${theme}/${fidelity} ${name}`).toBeGreaterThan(0)
        }
      }
    }
  })
})
