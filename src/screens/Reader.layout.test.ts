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

/** Declarations consuming a bleed variable, as `property: var(--text-bleed-…)`. */
function bleedDeclarations(): string[] {
  return [...css.matchAll(/([a-z-]+)\s*:\s*var\(--text-bleed-[a-z]+/g)].map(
    (match) => match[1] ?? '',
  )
}

describe('the prose bleed', () => {
  it('is applied, and to both edges', () => {
    expect(bleedDeclarations()).toHaveLength(2)
  })

  it('uses margin, which an absolutely positioned book actually follows', () => {
    for (const property of bleedDeclarations()) {
      expect(property).toMatch(/^margin-inline-(start|end)$/)
    }
  })

  it('never uses padding, which the book would silently ignore', () => {
    expect(bleedDeclarations()).not.toContain('padding-inline-start')
    expect(bleedDeclarations()).not.toContain('padding-inline-end')
  })
})
