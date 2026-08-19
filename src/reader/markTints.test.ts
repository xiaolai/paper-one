import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../lib/palette'
import { MARK_TINTS, type MarkTint } from '../lib/marks'
import { BOOK_COLOURS } from './bookCss'
import type { Theme } from '../lib/state'

/**
 * §01's three mark tints, and the model they are derived from.
 *
 * THE VALUES ARE NOT PICKED. `scripts/mark-tints.mjs` generates all thirty from
 * one hue per tint, one chroma per role, and one lightness step from the page
 * per role — with the chroma and the step allowed to differ between light pages
 * and the dark one. This file is what stops the table drifting away from that
 * script: it re-derives each colour's OKLCH coordinates and checks them against
 * the same policy, so a hex edited by hand fails here rather than shipping.
 *
 * Asserted in OKLCH rather than in WCAG contrast, and the difference is not
 * pedantry. The previous version of this file required all three tints to have
 * the SAME contrast ratio against the page, which they no longer do and should
 * not: WCAG luminance weights green at 0.72 and blue at 0.07, so three colours
 * at one apparent lightness come out at three ratios. Equal contrast was an
 * artefact of the old derivation, and holding the new one to it would mean
 * making green darker than the others to satisfy a formula nobody looks at.
 *
 * Contrast still governs the one thing it is good for: the floor for text drawn
 * on a fill.
 */

const THEMES: readonly Theme[] = ['paper', 'slate', 'sepia', 'sage', 'night']

/** The model, mirrored from `scripts/mark-tints.mjs`. */
const HUE: Record<MarkTint, number> = { yellow: 92, green: 145, purple: 310 }
const POLICY = {
  light: { fill: { dL: 0.068, c: 0.075 }, rule: { dL: 0.212, c: 0.118 } },
  night: { fill: { dL: 0.213, c: 0.075 }, rule: { dL: 0.34, c: 0.092 } },
} as const

/** The floor `palette.ts` holds body text to, and marked text is body text. */
const FLOOR = 4.5

/**
 * How far a derived colour may sit from its target.
 *
 * `L` and `C` are quantised through three 8-bit channels on the way to a hex,
 * which moves both by a few thousandths. Hue tolerates more because a small
 * absolute error in a and b is a large angular one when the chroma is low —
 * which a pale fill's is, by design.
 */
const TOL = { dL: 0.01, chroma: 0.008, hue: 2 }

const M1 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
]
const M2 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
]

const channels = (hex: string): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

const toLinear = (v: number): number => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** A colour in OKLCH: perceptual lightness, chroma, and hue in degrees. */
function oklch(hex: string): { L: number; C: number; h: number } {
  const rgb = channels(hex).map(toLinear)
  const lms = M1.map((row) => Math.cbrt(row.reduce((sum, k, i) => sum + k * (rgb[i] ?? 0), 0)))
  const [L, a, b] = M2.map((row) => row.reduce((sum, k, i) => sum + k * (lms[i] ?? 0), 0)) as [
    number,
    number,
    number,
  ]
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

/**
 * The pair each tint is drawn from — a pale band, and the line that names it.
 *
 * `fill` is what the reader SEES, not what `BOOK_COLOURS` holds. The highlight
 * painter blends its rects over the glyphs, so the table's value is a
 * pre-image: multiplied by the page on a light theme, screened on Night. The
 * whole policy below is about the band on screen, so every check has to look at
 * the blended result — checking the pre-image would hold the model to a colour
 * that is never drawn anywhere.
 *
 * The RULES are not blended. `underline` and `squiggly` paint at `normal`;
 * only `highlight` reads `--overlayer-highlight-blend-mode`.
 */
function pair(theme: Theme, tint: MarkTint): { fill: string; rule: string } {
  const c = BOOK_COLOURS[theme]
  const given =
    tint === 'green' ? c.markGreen : tint === 'purple' ? c.markPurple : c.mark
  const rule =
    tint === 'green' ? c.markGreenRule : tint === 'purple' ? c.markPurpleRule : c.markRule
  return { fill: blend(given, c.surface, theme === 'night' ? 'screen' : 'multiply'), rule }
}

/** What the reader sees, given what the painter was handed. Per channel in the
 *  non-linear sRGB the CSS compositing spec blends in. */
function blend(given: string, page: string, mode: 'multiply' | 'screen'): string {
  const g = channels(given).map((v) => v / 255)
  const p = channels(page).map((v) => v / 255)
  const out = g.map((v, i) => {
    const q = p[i] ?? 0
    return mode === 'screen' ? 1 - (1 - v) * (1 - q) : v * q
  })
  return (
    '#' +
    out
      .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  )
}

describe.each(THEMES)('%s', (theme) => {
  const c = BOOK_COLOURS[theme]
  const dark = theme === 'night'
  const policy = dark ? POLICY.night : POLICY.light
  const page = oklch(c.surface).L

  it.each(['fill', 'rule'] as const)('steps every %s at least the policy distance', (role) => {
    /* ONE STEP FOR EVERY TINT AND EVERY THEME OF THIS POLARITY — which is the
       "consistent across the light themes" property, stated as the thing that
       produces it rather than as an observation about the result.
       A MINIMUM, not an exact distance. sRGB cannot hold every hue at every
       lightness, so a hue the gamut will not serve at the policy step keeps
       stepping away from the page until it can — see `stepFor` in the script.
       Never SHALLOWER, though: that direction is a mark quietly fading into its
       page, and there is no gamut reason for it. */
    for (const tint of MARK_TINTS) {
      const got = oklch(pair(theme, tint)[role]).L
      const step = dark ? got - page : page - got
      expect(step, `${theme} ${tint} ${role}`).toBeGreaterThan(policy[role].dL - TOL.dL)
    }
  })

  it.each(['fill', 'rule'] as const)('gives every %s the policy chroma', (role) => {
    /* EXACTLY the target, both ways. More would let one tint out-shout the
       others; less is a colour draining toward grey. There is no gamut
       exception here any more — where sRGB cannot hold the chroma at the policy
       lightness, the generator moves the LIGHTNESS instead and keeps the
       colour, which is what makes this assertion unconditional. */
    for (const tint of MARK_TINTS) {
      const got = oklch(pair(theme, tint)[role]).C
      const target = policy[role].c
      expect(got, `${theme} ${tint} ${role}`).toBeLessThan(target + TOL.chroma)
      expect(got, `${theme} ${tint} ${role}`).toBeGreaterThan(target - TOL.chroma)
    }
  })

  it('keeps every tint on its own hue', () => {
    // A tint is a hue; if this drifts, "green" has stopped meaning green.
    for (const tint of MARK_TINTS) {
      const { fill, rule } = pair(theme, tint)
      for (const [role, hex] of [['fill', fill], ['rule', rule]] as const) {
        /* The signed difference wrapped into (-180, 180], then its size — so
           a hue at 359° and one at 1° are two degrees apart, not 358. */
        const delta = Math.abs(((oklch(hex).h - HUE[tint] + 540) % 360) - 180)
        expect(delta, `${theme} ${tint} ${role}`).toBeLessThan(TOL.hue)
      }
    }
  })

  it('keeps marked text as readable as unmarked text', () => {
    for (const tint of MARK_TINTS) {
      expect(contrastRatio(c.ink, pair(theme, tint).fill), tint).toBeGreaterThanOrEqual(FLOOR)
    }
  })

  it('makes every fill visible against the page at all', () => {
    /* The other side of the policy: a step that had been tuned to nothing would
       satisfy every check above against a page it no longer differs from. */
    for (const tint of MARK_TINTS) {
      expect(contrastRatio(pair(theme, tint).fill, c.surface), tint).toBeGreaterThan(1.15)
    }
  })

  it('gives the three tints three distinguishable rules', () => {
    const rules = MARK_TINTS.map((tint) => pair(theme, tint).rule)
    expect(new Set(rules).size).toBe(MARK_TINTS.length)
  })
})

describe('the dark theme is designed separately, and further from its page', () => {
  it('lifts a fill more than any light theme drops one', () => {
    /* The whole reason Night has its own policy. A band has to climb further
       out of a dark page to register at all — the step that reads as a mark on
       paper is invisible there. Sampled from Kindle's dark mode on 2026-08-19:
       its band sits at OKLCH L 0.425 on a black page, and Night's page is
       L 0.212, so this step puts our band at the same absolute lightness. */
    expect(POLICY.night.fill.dL).toBeGreaterThan(POLICY.light.fill.dL * 2)
    for (const tint of MARK_TINTS) {
      // The BLENDED band, which is the thing Kindle's was measured against.
      const seen = oklch(pair('night', tint).fill).L
      expect(seen, tint).toBeGreaterThan(0.41)
      expect(seen, tint).toBeLessThan(0.46)
    }
  })

  it('asks for less colour in a rule than a light theme does', () => {
    /* A saturated colour on a dark ground reads brighter than the same colour
       on a light one. At the light themes' rule chroma, Night's gold loses its
       blue channel entirely and turns acid. */
    expect(POLICY.night.rule.c).toBeLessThan(POLICY.light.rule.c)
  })
})

describe('a hue the gamut will not serve steps deeper instead of fading', () => {
  it('carries paper’s purple further from the page than its yellow', () => {
    /* Measured: at the light themes' fill lightness of L 0.932, sRGB allows
       yellow chroma 0.094 and green 0.125, but purple only 0.044 — held there,
       purple came out a grey-lilac that did not read as purple. It steps to
       L 0.884 instead, where it can hold the full 0.075. */
    const page = oklch(BOOK_COLOURS.paper.surface).L
    const yellow = page - oklch(BOOK_COLOURS.paper.mark).L
    const purple = page - oklch(BOOK_COLOURS.paper.markPurple).L
    expect(purple).toBeGreaterThan(yellow)
  })

  it('leaves a hue that needs no help exactly where the policy put it', () => {
    /* Yellow and green are available at the fill lightness on every light page
       and reachable through multiply, so neither may drift: the deeper step is
       a remedy, not a licence. */
    for (const theme of ['paper', 'slate', 'sepia', 'sage'] as const) {
      const page = oklch(BOOK_COLOURS[theme].surface).L
      for (const tint of ['yellow', 'green'] as const) {
        const step = page - oklch(pair(theme, tint).fill).L
        expect(Math.abs(step - POLICY.light.fill.dL), `${theme} ${tint}`).toBeLessThan(TOL.dL)
      }
    }
  })

  it('carries purple deeper on every light theme, for two reasons at once', () => {
    /* The gamut is only half of it. Multiply can never make a channel brighter
       than the page's own, so a purple band on a cream page cannot have more
       blue in it than the cream does — which is also what a real highlighter on
       real paper does. Both constraints are answered the same way, and the
       generator searches for the step that satisfies both. */
    for (const theme of ['paper', 'slate', 'sepia', 'sage'] as const) {
      const page = oklch(BOOK_COLOURS[theme].surface).L
      const step = page - oklch(pair(theme, 'purple').fill).L
      expect(step, theme).toBeGreaterThan(POLICY.light.fill.dL * 1.5)
    }
  })
})

describe('the host’s table and the book’s table', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/tokens.css', import.meta.url)), 'utf8')

  /** Every custom property declared in the block for one theme. */
  function block(theme: Theme): Record<string, string> {
    /* `paper` is `:root` as well as `[data-theme='paper']` — see the note at the
       top of tokens.css — and the quoting is not consistent between them, so
       both spellings are accepted rather than the test knowing which is used. */
    const selector = new RegExp(`\\[data-theme=['"]${theme}['"]\\]\\s*\\{`)
    const at = css.search(selector)
    expect(at, `no block for ${theme} in tokens.css`).toBeGreaterThan(-1)
    const body = css.slice(at, css.indexOf('}', at))
    const found: Record<string, string> = {}
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found[name!] = value!.trim().toUpperCase()
    }
    return found
  }

  it.each(THEMES)('agree about every mark tint on %s', (theme) => {
    /* The swatch in the bar is drawn from `tokens.css`; the mark on the page is
       painted from `BOOK_COLOURS`. They are two tables because a book is an
       iframe and custom properties do not cross that boundary — which means
       nothing but this stops them describing different colours, and a swatch
       that offers a colour the book will not draw is worse than no swatch. */
    const declared = block(theme)
    for (const tint of MARK_TINTS) {
      const { fill, rule } = pair(theme, tint)
      /* The token carries the BLENDED value, because a swatch is not painted
         over anything — it has to show the colour the band will end up. On
         Night the two differ by a lot: the painter is handed #533E00 and the
         reader sees #62511C. */
      expect(declared[`--mark-${tint}`], `--mark-${tint} on ${theme}`).toBe(fill.toUpperCase())
      expect(declared[`--mark-${tint}-rule`], `--mark-${tint}-rule on ${theme}`).toBe(
        rule.toUpperCase(),
      )
    }
  })
})
