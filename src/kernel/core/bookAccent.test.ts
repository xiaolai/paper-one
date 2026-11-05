import { describe, expect, it } from 'vitest'
import { bookAccent, bookHue, coverTintFor, rowHue } from './bookAccent'

/** The two shapes `bookIdFor` actually produces. */
const fileId = (hex: string) => `file:${hex}`
const hexIds = (n: number) =>
  Array.from({ length: n }, (_, i) => fileId(i.toString(16).padStart(32, 'a')))

describe('bookHue', () => {
  it('gives the same book the same hue, every time', () => {
    expect(bookHue('file:abc')).toBe(bookHue('file:abc'))
    expect(bookHue('url:/sample.epub')).toBe(bookHue('url:/sample.epub'))
  })

  it('stays inside a hue', () => {
    for (const id of hexIds(200)) {
      const hue = bookHue(id)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
      expect(Number.isInteger(hue)).toBe(true)
    }
  })

  /* The property a cheaper hash would fail. These ids differ in ONE character
   * out of thirty-seven, which is the realistic case: `bookIdFor` emits `file:`
   * and then a hash, so every id on a shelf is the same length over the same
   * alphabet. Summing char codes would put this whole set within a few degrees
   * of each other and every book would be the same colour. */
  it('separates ids that differ by a single character', () => {
    const hues = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) =>
      bookHue(fileId(`${'a'.repeat(31)}${c}`)),
    )
    expect(new Set(hues).size).toBe(hues.length)
    // And not merely distinct — spread. Adjacent ids must not be adjacent hues.
    const sorted = [...hues].sort((a, b) => a - b)
    const span = (sorted.at(-1) ?? 0) - (sorted[0] ?? 0)
    expect(span).toBeGreaterThan(180)
  })

  it('spreads a shelf across the wheel rather than bunching it', () => {
    // Twelve 30° buckets; 200 books should reach most of them.
    const buckets = new Set(hexIds(200).map((id) => Math.floor(bookHue(id) / 30)))
    expect(buckets.size).toBeGreaterThanOrEqual(10)
  })

  it('does not fold two hashes onto one hue by negating', () => {
    // The `Math.abs` bug this avoids: it maps int32 onto half its range, so
    // collisions double. A large sample should stay close to fully distinct.
    const hues = hexIds(360).map(bookHue)
    expect(new Set(hues).size).toBeGreaterThan(200)
  })
})

describe('bookAccent', () => {
  it('has no colour for no book', () => {
    expect(bookAccent(null, false)).toBeNull()
  })

  it('varies the hue and nothing else', () => {
    const a = bookAccent('file:aaa', false)
    const b = bookAccent('file:bbb', false)
    expect(a).not.toBe(b)
    // Same saturation and lightness — the invariant that stops an arbitrary hue
    // from clashing with §05's themes.
    const tail = (css: string | null) => css?.split(' ').slice(1).join(' ')
    expect(tail(a)).toBe(tail(b))
  })

  it('lifts and mutes for Night, where the light value would glare', () => {
    const day = bookAccent('file:aaa', false)
    const night = bookAccent('file:aaa', true)
    expect(day).toContain('46% 52%')
    expect(night).toContain('42% 62%')
    // Same book, same hue, either way.
    expect(day?.split(' ')[0]).toBe(night?.split(' ')[0])
  })
})

describe('rowHue', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`)

  it('gives a row the same hue every time, inside a hue', () => {
    for (const id of ids) {
      expect(rowHue(id)).toBe(rowHue(id))
      expect(rowHue(id)).toBeGreaterThanOrEqual(0)
      expect(rowHue(id)).toBeLessThan(360)
    }
  })

  it('spreads ids that differ by a character across the wheel', () => {
    expect(new Set(ids.map(rowHue)).size).toBeGreaterThan(100)
  })
})

describe('coverTintFor', () => {
  const TINTS = ['var(--tint-a)', 'var(--tint-b)', 'var(--tint-c)', 'var(--tint-d)', 'var(--tint-e)']

  it('gives a book the same tint every time', () => {
    for (const id of hexIds(50)) expect(coverTintFor(id)).toBe(coverTintFor(id))
  })

  /* All five, and nothing else. A shelf drawn from fewer — a tint dropped from
   * the palette, or every book falling back to the first — would still give each
   * book a stable colour, so stability alone cannot tell. */
  it('reaches every one of the five theme tints and no other value', () => {
    const seen = new Set(hexIds(200).map(coverTintFor))
    expect([...seen].sort()).toEqual(TINTS)
  })
})
