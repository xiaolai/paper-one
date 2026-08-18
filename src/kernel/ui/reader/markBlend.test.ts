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

  it('is fully opaque, which multiply makes safe', () => {
    // Under multiply, opacity is the mark's strength and costs the text
    // nothing. Under `normal` it would be the strength of the film.
    expect(declared('--overlayer-highlight-opacity')).toBe('1')
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
