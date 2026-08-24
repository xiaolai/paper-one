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

/** The reader's own sheet, where the book element's blend group and its
 *  page-edge strip are declared. */
const readerCss = readFileSync(
  fileURLToPath(new URL('../screens/Reader.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * foliate's own modules, read from the pinned fork.
 *
 * A relative path into `node_modules` rather than a resolver, and the crudeness
 * is the point: `readFileSync` THROWS on a path that has moved, so this fails
 * loudly instead of quietly asserting over an empty string. The fork is a git
 * dependency pinned to a SHA — see `dev-docs/foliate-fork.md`.
 */
const FOLIATE = ['paginator.js', 'view.js', 'fixed-layout.js', 'overlayer.js'] as const

function foliateSource(file: string): string {
  const source = readFileSync(
    fileURLToPath(new URL(`../../../../node_modules/foliate-js/${file}`, import.meta.url)),
    'utf8',
  )
  /* A SCAN OVER NOTHING FINDS NOTHING, and would report it as safety. The path
     throwing covers a module that moved; this covers one that is present and
     empty, which is what a half-written install looks like. The smallest of the
     four is `fixed-layout.js` at about 9kB. */
  if (source.length < 2000) throw new Error(`foliate-js/${file} is ${source.length} bytes`)
  return source
}

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

  it('leaves the strip outside the page to the stage, so it cannot go stale', () => {
    /* NOT A BLEND QUESTION, and here anyway, because it is the same element and
       the same trap: foliate copies a colour once and never looks again. The
       strip is the `--page-margin` band the book's iframe does not cover, and
       its inline background is the page as it was when the section LOADED — so
       a theme change left Sepia paper down both sides of a Night page.

       `!important` is load-bearing: foliate's value is inline, and a `::part`
       rule loses to one without it. A rule that dropped it would keep matching
       and stop working, which is why this asserts the whole declaration. */
    expect(
      /foliate-view::part\(filter\)\s*\{[^}]*background\s*:\s*transparent\s*!important\s*;/.test(
        readerCss,
      ),
    ).toBe(true)
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

/**
 * WHAT MAKES THE ISOLATION SAFE, asserted against the pinned fork rather than
 * argued in a comment.
 *
 * `isolation: isolate` on `foliate-view` does exactly two things: it makes the
 * element a stacking context, which CONFINES descendants that carry a
 * `z-index`, and it forms an isolated group, which confines `mix-blend-mode`.
 * Everything Paper stacks — §12's scale in `metrics.ts`, from the gutter at 1
 * to the scrim at 30 — is on a host element OUTSIDE the view, and the view's
 * own `z-index` is still `auto`, so where it paints among its siblings has not
 * moved. Only its descendants are confined, and the claim below is that there
 * are none to confine.
 *
 * THE PROOF EXPIRES ON A REBASE, which is why it is here and not in a comment.
 * The fork is pinned to a SHA, upstream's API is explicitly unstable and has
 * already changed the painter contract under Paper once. The day the paginator
 * grows a `z-index`, that element stops being able to reach the host's layers
 * and nothing else in this repo would say so.
 */
describe('the blend group Paper draws around the book', () => {
  it.each(FOLIATE)('confines no z-index in %s, because there is none', (file) => {
    const found = foliateSource(file)
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      /* BOTH SPELLINGS. foliate is JavaScript, where the style API's name is
         `zIndex` — so a guard matching only the CSS `z-index` had a hole
         exactly where a rebase would put one, and would have passed a
         `element.style.zIndex = '1'` without a word. */
      .filter(([, line]) => /z-?index/i.test(line))
      .map(([n, line]) => `${file}:${n}: ${line.trim()}`)
    /* Reported with the lines rather than as a count: if this ever fires, the
       question is whether that z-index needed to escape the book, and that is
       unanswerable from a number. */
    expect(found).toEqual([])
  })

  it('leaves the only blend inside it the one the isolation exists to serve', () => {
    /* `overlayer.js` sets `mixBlendMode` from `--overlayer-highlight-blend-mode`
       — that IS the mark band, whose backdrop must be the book and therefore
       must be inside the group. Any OTHER blend in foliate would be a second
       one with its own idea of what it is blending against. */
    const offenders = FOLIATE.flatMap((file) =>
      foliateSource(file)
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /mix-?blend-?mode/i.test(line))
        .filter(([, line]) => !/--overlayer-highlight-blend-mode/.test(line))
        .map(([n, line]) => `${file}:${n}: ${line.trim()}`),
    )
    expect(offenders).toEqual([])
  })
})
