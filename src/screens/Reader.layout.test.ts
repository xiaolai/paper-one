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
