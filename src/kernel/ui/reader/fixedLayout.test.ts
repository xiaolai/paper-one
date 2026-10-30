// NODE, NOT JSDOM, and it matters twice. This suite reads a stylesheet off
// disk — `import.meta.url` is an http URL under jsdom and `readFileSync`
// refuses it — and nothing here needs a DOM: `bookCss` reads
// `document.styleSheets` inside `bookSheets()`, never at import.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BRIGHTNESS, CONTRAST } from '../../core/metrics'
import { THEME_IDS } from '../../core/uiTypes'
import { FIXED_LAYOUT_CONTRACT, REACHES_FIXED_LAYOUT, pageFilter } from './fixedLayout'

/**
 * WI-14.5 — what a fixed-layout book takes from the reader, stated rather than
 * left to be an accident of where each setting happens to be implemented.
 *
 * ROUND 3 REJECTED THE FIRST VERSION OF THIS ITEM and was right to: "theme,
 * brightness, contrast and margins are container properties and apply to the
 * pdf.js page as readily as to an EPUB document" is false as written. The
 * fixed-layout renderer paints to canvas inside a closed shadow root, has no
 * `setStyles`, and observes only `zoom`. What it DOES have is `part="filter"`
 * on its iframe, exported by `view.js` — which is a real mechanism, and the
 * only one.
 */

const filterFor = (theme: (typeof THEME_IDS)[number]) =>
  pageFilter({ theme, brightness: BRIGHTNESS.def, contrast: CONTRAST.def })

describe('the fixed-layout contract', () => {
  it('names every setting as reaching a PDF or not', () => {
    /* A contract with a gap in it is the thing this item exists to replace.
       Each entry says WHY, because "no" without a mechanism is the state the
       item was already in. */
    expect(FIXED_LAYOUT_CONTRACT.length).toBeGreaterThan(8)
    for (const one of FIXED_LAYOUT_CONTRACT) {
      expect(one.setting.length, 'an unnamed setting').toBeGreaterThan(0)
      expect(one.how.length, `${one.setting} says nothing about how`).toBeGreaterThan(12)
    }
  })

  it('refuses every typographic setting, because there is no type', () => {
    /* The words in a PDF are pixels pdf.js painted. Nothing about size, face,
       leading, measure or alignment can reach them, and WI-14.4's fifteen are
       every one typographic. */
    for (const setting of ['stepIdx', 'measure', 'typeface', 'spacing', 'align', 'readingStyle'] as const) {
      expect(REACHES_FIXED_LAYOUT.has(setting), `${setting} claims to reach a PDF`).toBe(false)
    }
  })

  it('accepts the reader’s light, the page and the flow', () => {
    for (const setting of ['brightness', 'contrast', 'theme', 'pageLayout'] as const) {
      expect(REACHES_FIXED_LAYOUT.has(setting), `${setting} does not reach a PDF`).toBe(true)
    }
  })

  it('names the settings as the STATE names them', () => {
    /* The first version said `flow` where the field is `pageLayout`, so
       `has('pageLayout')` was false while the table read as covering it. The
       union is what makes that a compile error; this is what makes it a test
       failure if the union is ever widened back to `string`. */
    expect(REACHES_FIXED_LAYOUT.has('pageLayout')).toBe(true)
  })

  it('refuses the page margins, which fxl does not observe', () => {
    /* `pageMargins` goes to the renderer through `applyLayout` — `margin`,
       `gap`, `max-inline-size` — and `foliate-fxl`'s `observedAttributes` is
       `['zoom']`. The table claimed it as "a container property" and it is not
       applied by the container at all. */
    expect(REACHES_FIXED_LAYOUT.has('pageMargins')).toBe(false)
  })

  it('has no setting listed twice, which would make the set a coin toss', () => {
    const names = FIXED_LAYOUT_CONTRACT.map((one) => one.setting)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('pageFilter', () => {
  it('is none at the defaults, so an untouched reader pays nothing', () => {
    /* A filter of ANY kind promotes the frame to its own compositing layer and
       forces every page turn through it — `brightness(1) contrast(1)` costs
       exactly what a real filter costs and does nothing. */
    expect(filterFor('paper')).toBe('none')
  })

  it('inverts a dark page and nothing else', () => {
    /* Asked of the COLOUR, never of the theme's name, exactly as the sheet's
       own dark rules are — so a second dark theme is covered by construction
       rather than by somebody remembering this file. */
    const inverted = THEME_IDS.filter((t) => filterFor(t).includes('invert'))
    expect(inverted).toEqual(['night'])
  })

  it('rotates the hue back, or every diagram changes colour', () => {
    /* Inversion alone takes a blue diagram to orange. Rotating the hue returns
       it to roughly its own colour against the now-dark page; black text and
       white paper are unaffected either way, being unsaturated. */
    expect(filterFor('night')).toBe('invert(1) hue-rotate(180deg)')
  })

  it('dims with the brightness control', () => {
    const dim = pageFilter({ theme: 'paper', brightness: 0, contrast: CONTRAST.def })
    expect(dim).toMatch(/^brightness\(0?\.\d+\)$/)
  })

  it('softens with the contrast control, and can never harden past the theme', () => {
    /* `CONTRAST` is a REDUCTION — every step is ≤ 0, which `spacing.test.ts`
       asserts — and CSS `contrast()` takes 1 for unchanged. So the mapping is
       `1 + c`, and nothing it produces may exceed 1. */
    for (const [idx] of CONTRAST.steps.entries()) {
      const value = pageFilter({ theme: 'paper', brightness: BRIGHTNESS.def, contrast: idx })
      const match = /contrast\(([\d.]+)\)/.exec(value)
      if (match) expect(Number(match[1]), `step ${idx}`).toBeLessThan(1)
    }
  })

  it('composes the inversion, the light and the hardness in that order', () => {
    /* Filters apply left to right: inverting after dimming dims the paper and
       then flips it, which is not the same picture. */
    const all = pageFilter({ theme: 'night', brightness: 0, contrast: 0 })
    expect(all.indexOf('invert')).toBeLessThan(all.indexOf('brightness'))
    expect(all.indexOf('brightness')).toBeLessThan(all.indexOf('contrast'))
  })
})

describe('the filter reaches the page through the part foliate exports', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const css = readFileSync(join(HERE, '..', 'screens', 'Reader.module.css'), 'utf8')

  it('styles the exported part rather than reaching into the shadow root', () => {
    /* BOTH renderers put `part="filter"` on their iframe and `view.js` sets
       `exportparts="head,foot,filter"`, which is what carries it out through
       two CLOSED shadow roots. There is no other way in: an embedder cannot
       reach the iframe from the DOM side at all. Verified in the running app —
       a rule on `foliate-view::part(filter)` resolves on the live frame. */
    expect(css).toContain('foliate-view::part(filter)')
    expect(css).toContain('filter: var(--paper-page-filter, none)')
  })

  it('falls back to none, so a book that set no property is unfiltered', () => {
    /* The var's fallback is the whole guard: a reflowable book carries the
       theme, the brightness and the contrast in its own injected sheet, and a
       filter here would apply all three a SECOND time. */
    expect(css).toMatch(/--paper-page-filter,\s*none/)
  })
})
