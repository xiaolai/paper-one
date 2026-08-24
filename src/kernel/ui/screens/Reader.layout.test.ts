import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A guard on the one CSS property that carries `proseBleed`.
 *
 * The arithmetic in `proseBleed` was correct and unit-tested for weeks while
 * the CSS applying it did nothing: the book is a `position: absolute; inset: 0`
 * child of `.text`, and an absolutely positioned box resolves its insets
 * against the containing block's PADDING box. So `padding-inline-end` left the
 * book at the full width of the grid, foliate centred the measure inside that,
 * and the moment a mark widened the margin column the text sat 72px off its own
 * track and ran under the notes.
 *
 * Nothing could catch that from the arithmetic — both sides agreed. This is the
 * cheapest durable check on the property itself, and it fails with the reason
 * attached rather than leaving the next person to rediscover it in the browser.
 */
const css = readFileSync(
  fileURLToPath(new URL('./Reader.module.css', import.meta.url)),
  'utf8',
)

/**
 * One rule's body, comments removed.
 *
 * Scoped rather than scanning the whole file, and stripped rather than taken
 * raw. The previous version searched the entire stylesheet: the passage above
 * NAMES `padding-inline-end` in prose, so a check for "no padding declaration"
 * could be satisfied or broken by an edit to a comment, and a bleed applied to
 * some unrelated selector would have counted as this rule being correct.
 */
function ruleBody(selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  // Loud: a renamed class must fail as a missing rule, not pass as an empty one.
  if (!match) throw new Error(`Reader.module.css has no rule for ${selector}`)
  return match[1] ?? ''
}

/**
 * Bleed declarations in the book's own rule, as `property → variable`.
 *
 * Both halves, because the property alone cannot tell the two edges apart:
 * `margin-inline-start` written twice passed a test that only counted two
 * allowed declarations, and the end of the measure would have run under the
 * margin notes with every assertion green.
 */
function bleedDeclarations(): string[] {
  return [
    ...ruleBody('.text').matchAll(/([a-z-]+)\s*:\s*var\(--text-bleed-([a-z]+)/g),
  ].map((match) => `${match[1] ?? ''} -> ${match[2] ?? ''}`)
}

describe('the prose bleed', () => {
  it('is applied to both edges, each from its own variable', () => {
    expect(bleedDeclarations().sort()).toEqual([
      'margin-inline-end -> end',
      'margin-inline-start -> start',
    ])
  })

  it('uses margin, which an absolutely positioned book actually follows', () => {
    // Stated separately from the pairing above so a regression to padding
    // fails with the reason attached rather than as a mismatched list.
    for (const declaration of bleedDeclarations()) {
      expect(declaration).toMatch(/^margin-inline-(start|end) -> /)
    }
  })

  it('never uses padding, which the book would silently ignore', () => {
    expect(ruleBody('.text')).not.toMatch(/padding-inline-[a-z]+\s*:\s*var\(--text-bleed/)
  })
})

const glossCss = readFileSync(
  fileURLToPath(new URL('../reader/GlossStrip.module.css', import.meta.url)),
  'utf8',
)

/** The same scoping as `ruleBody`, over the strip's own stylesheet. */
function glossRule(selector: string): string {
  const source = glossCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(source)
  if (!match) throw new Error(`GlossStrip.module.css has no rule for ${selector}`)
  return match[1] ?? ''
}

/**
 * WI-16.3's CSS half, and ONLY that half.
 *
 * The behaviour — which element each state renders into, whether the failure is
 * visible, whether it says "couldn't" — is asserted by RENDERING, in
 * `reader/GlossStrip.test.tsx`. It used to be asserted here by scanning
 * `Reader.tsx`'s source, and an audit named what that misses: adding `hidden`
 * to the failed element leaves every source assertion green while the failure
 * disappears from the screen.
 *
 * What stays here is the one question a rendering test cannot answer. CSS
 * Modules give jsdom a hashed class name and no stylesheet, so "is it amber" is
 * legible only from the stylesheet — and amber is the whole point:
 * `core/gloss.ts` says an apology must never be resolved as a definition
 * "because an apology rendered in amber reads as a definition".
 */
describe('the gloss that did not arrive', () => {
  it('is not amber, while the definition still is', () => {
    // Non-vacuity first: amber is the point of the definition box, and a test
    // that only asserted the absence would pass if both lost their colour.
    expect(glossRule('.gloss')).toMatch(/var\(--amber/)
    expect(glossRule('.glossTerm')).toMatch(/var\(--amber/)
    expect(glossRule('.glossFailed')).not.toMatch(/var\(--amber/)
    expect(glossRule('.glossFailedReason')).not.toMatch(/var\(--amber/)
  })

  /*
   * THE OTHER HALF OF "drawn apart": it has to be drawn.
   *
   * `GlossStrip.test.tsx` catches a `hidden` attribute, and cannot catch this —
   * CSS Modules give jsdom a hashed class name and no stylesheet, so a rule
   * that hid the element would leave every mounted case green while the reader
   * saw nothing. A verification pass named exactly that mutation. This is the
   * only place it is visible.
   */
  it('is drawn at all — not hidden by its own rule', () => {
    for (const rule of ['.glossFailed', '.glossFailedSaid', '.glossFailedReason']) {
      expect(glossRule(rule)).not.toMatch(/display\s*:\s*none/)
      expect(glossRule(rule)).not.toMatch(/visibility\s*:\s*(hidden|collapse)/)
      expect(glossRule(rule)).not.toMatch(/content-visibility\s*:\s*hidden/)
      /* Opacity is READ rather than pattern-matched, because the pattern that
       * looks right is wrong: `/opacity:\s*0(\D|$)/` matches `opacity: 0.75`,
       * since `.` is a non-digit. The question is numeric, so ask it that way. */
      for (const [, value] of glossRule(rule).matchAll(/opacity\s*:\s*([\d.]+)/g)) {
        expect(Number(value)).toBeGreaterThan(0)
      }
    }
    /* Non-vacuity: the reason IS de-emphasised, so a loop over no declarations
     * at all would pass. There is one to find. */
    expect([...glossRule('.glossFailedReason').matchAll(/opacity\s*:\s*([\d.]+)/g)]).toHaveLength(1)
  })

  /* A phrase lookup can be 120 characters (`isLookUpTerm`), and at
   * `flex: 0 0 auto` a failed one pushed the dismiss control off the line. */
  it('lets a long term shrink rather than pushing the control off the line', () => {
    expect(glossRule('.glossFailedSaid')).toMatch(/flex:\s*0\s+1\s+auto/)
    expect(glossRule('.glossFailedSaid')).toMatch(/min-width:\s*0/)
  })
})
