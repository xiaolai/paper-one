import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guard on the two custom properties that decide whether a highlight
 * obscures the words it marks.
 *
 * Why they exist, which painter reads them, and why the SVG is not where it
 * appears to be: `Overlayer` in `src/vite-env.d.ts`. Not repeated here.
 *
 * What this file is for is narrower, and is the reason it is a test rather
 * than a comment: the tempting wrong fix is to reach for the opacity, because
 * the symptom is "the mark looks too heavy". A test that merely checked some
 * opacity was set would wave that straight through, so this asserts the blend
 * mode BY NAME. Measured on the running app before the fix: marked text came
 * out 37% lighter than the same text unmarked.
 */
const css = readFileSync(
  fileURLToPath(new URL('../styles/global.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/** The reader's own sheet, where the book element's blend group is declared. */
const readerCss = readFileSync(
  fileURLToPath(new URL('../screens/Reader.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The FIRST declaration of a custom property in the stylesheet.
 *
 * A text scan, not a cascade. It does not know about selector scope,
 * specificity, or a later rule overriding an earlier one — so it can be
 * satisfied by a declaration that never applies, and defeated by one that
 * does. That is a real limit and it is accepted deliberately: the property
 * lives in a single `:root` block, and the alternative — mounting an overlay
 * and reading computed values — needs a DOM this suite does not have and would
 * test WebKit rather than this decision. Its job is to stop someone reaching
 * for the opacity dial again, and for that a text check is enough.
 */
function declared(property: string): string | null {
  const match = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(css)
  return match?.[1]?.trim() ?? null
}

describe('the highlight overlay', () => {
  it('multiplies rather than painting a film over the glyphs', () => {
    // `normal` is foliate's default, so declaring nothing fails this too.
    expect(declared('--overlayer-highlight-blend-mode')).toBe('multiply')
  })

  it('screens on the dark theme, because multiply can only darken', () => {
    /* THE SAME DEFECT FROM THE OTHER SIDE. Multiply keeps the glyphs legible on
       paper by only ever darkening — and on a near-black page that makes the
       band darker than the page it is marking. Measured on the running app: a
       #5D4D15 band over Night's #17191C page rendered as #060603, a black smear
       that swallowed the words. Screen is multiply's dual and keeps the glyphs
       for the same reason on a dark ground.
       Asserted BY NAME, like the mode above and for the same reason: the
       tempting wrong fix for "Night's marks look bad" is to reach for the
       colours, and the colours were never the problem. */
    const night = /\[data-theme='night'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(night).toContain('--overlayer-highlight-blend-mode')
    expect(/--overlayer-highlight-blend-mode\s*:\s*screen\s*;/.test(night)).toBe(true)
  })

  it('is fully opaque, which multiply makes safe', () => {
    // Under multiply, opacity is the mark's strength and costs the text
    // nothing. Under `normal` it would be the strength of the film.
    expect(declared('--overlayer-highlight-opacity')).toBe('1')
  })

  it('gives the book element a blend group, or the mode above does nothing', () => {
    /* THE MODE IS NOT ENOUGH ON ITS OWN, which is the whole reason this
       assertion sits beside the three above rather than somewhere in the
       layout tests. A band multiplies with its BACKDROP, and the words it
       marks are on the far side of an iframe boundary — the Overlayer's SVG is
       the iframe's sibling inside the paginator's shadow tree. With no
       isolation declared the group resolves at whatever ancestor happens to
       establish a stacking context, WebKit composites the book's iframe onto a
       layer of its own, and the band finds nothing beneath it to darken: it
       composites as `normal` and paints an opaque slab over the marked words.

       IT LOOKED FINE FROM EVERY SCREENSHOT AN AGENT TAKES FIRST. The webview's
       own capture re-renders off the compositor and applies the blend, so the
       picture was right while the screen was wrong; only a window-server
       capture (`scripts/shot-window.sh`) or a reader's eyes showed it.
       Measured on the running app, Sage, amber tint: #FAE3B5 on screen — the
       raw fill, words gone — against #DBCC94 from the webview at the same
       instant.

       A text scan, with the same limit as `declared` above and accepted for
       the same reason: what this can catch is the declaration being deleted as
       dead CSS, which is exactly how it would go. */
    expect(/foliate-view\s*\{[^}]*isolation\s*:\s*isolate\s*;/.test(readerCss)).toBe(true)
  })

  it('declares them on :root, where the shadow tree can inherit them', () => {
    /* The placement is the point, not the presence: the Overlayer's SVG is in
     * the view's shadow tree, so a declaration anywhere else resolves to
     * nothing and silently falls back to foliate's defaults. The two exact
     * assertions above already cover presence. */
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(root).toContain('--overlayer-highlight-blend-mode')
    expect(root).toContain('--overlayer-highlight-opacity')
  })
})
