import { describe, expect, it } from 'vitest'
import { adjustPalette, contrastRatio, luminance, mix, type Palette } from './palette'

/* The two polarities, read from `tokens.css` rather than invented. */
const PAPER: Palette = {
  surface: '#FFFFFF', bg: '#FBFBFA', wash: '#F2F3F1',
  ink: '#17191B', ink2: '#3D4348', muted: '#5F666C',
}
const NIGHT: Palette = {
  surface: '#16191C', bg: '#101315', wash: '#1E2226',
  ink: '#E9EAE8', ink2: '#C2C7C9', muted: '#8B9196',
}

describe('the colour arithmetic', () => {
  it('matches the WCAG ratios tokens.css publishes', () => {
    // The file states 6.5 for --danger on Paper's surface; 4.15 on slate's wash.
    expect(contrastRatio('#B3261E', '#FFFFFF')).toBeCloseTo(6.54, 1)
    expect(contrastRatio('#B3261E', '#CBCFCA')).toBeCloseTo(4.15, 1)
  })

  it('is symmetric, and 1 for a colour against itself', () => {
    expect(contrastRatio('#123456', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#123456'), 6)
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 6)
  })

  /* The ends return the caller's own string rather than a re-rendered hex, so
   * an untouched palette compares equal to untouched. */
  it('mixes to the ends and clamps past them', () => {
    expect(mix('#FFFFFF', '#000000', 0)).toBe('#FFFFFF')
    expect(mix('#FFFFFF', '#000000', 1)).toBe('#000000')
    expect(mix('#FFFFFF', '#000000', 5)).toBe('#000000')
    expect(mix('#FFFFFF', '#000000', -5)).toBe('#FFFFFF')
    expect(mix('#FFFFFF', '#000000', 0.5)).toBe('#808080')
  })

  it('reads luminance in the right order', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 3)
    expect(luminance('#000000')).toBeCloseTo(0, 3)
    expect(luminance('#FFFFFF')).toBeGreaterThan(luminance('#16191C'))
  })
})

describe('brightness dims whatever is emitting the light', () => {
  it('leaves a theme untouched at full brightness and neutral contrast', () => {
    expect(adjustPalette(PAPER, 1, 0)).toEqual(PAPER)
    expect(adjustPalette(NIGHT, 1, 0)).toEqual(NIGHT)
  })

  /* On a light theme the page is what the screen is emitting. */
  it('darkens the page on a light theme, and not the text', () => {
    const dim = adjustPalette(PAPER, 0.7, 0)
    expect(luminance(dim.surface)).toBeLessThan(luminance(PAPER.surface))
    expect(luminance(dim.bg)).toBeLessThan(luminance(PAPER.bg))
    // The text is where it was, or darker to hold the floor — never lighter.
    expect(luminance(dim.ink)).toBeLessThanOrEqual(luminance(PAPER.ink) + 1e-9)
  })

  /* On a dark theme the page is already near-black; the text is the emitter. */
  it('dims the text on a dark theme, and leaves the page alone', () => {
    const dim = adjustPalette(NIGHT, 0.7, 0)
    expect(dim.surface).toBe(NIGHT.surface)
    expect(dim.bg).toBe(NIGHT.bg)
    expect(luminance(dim.ink)).toBeLessThan(luminance(NIGHT.ink))
  })

  it('reduces the light on screen in both polarities', () => {
    const brightPaper = luminance(PAPER.surface)
    const dimPaper = luminance(adjustPalette(PAPER, 0.7, 0).surface)
    expect(dimPaper).toBeLessThan(brightPaper)
    const brightNight = luminance(NIGHT.ink)
    const dimNight = luminance(adjustPalette(NIGHT, 0.7, 0).ink)
    expect(dimNight).toBeLessThan(brightNight)
  })
})

describe('contrast moves the text, never the page', () => {
  it('leaves the page where brightness put it', () => {
    for (const c of [-0.3, 0, 0.3]) {
      expect(adjustPalette(PAPER, 0.8, c).surface).toBe(adjustPalette(PAPER, 0.8, 0).surface)
      expect(adjustPalette(NIGHT, 0.8, c).surface).toBe(NIGHT.surface)
    }
  })

  it('separates the text from the page when asked for more', () => {
    const base = adjustPalette(PAPER, 1, 0)
    const more = adjustPalette(PAPER, 1, 0.3)
    expect(contrastRatio(more.ink, more.surface)).toBeGreaterThanOrEqual(
      contrastRatio(base.ink, base.surface),
    )
  })

  it('softens the text when asked for less', () => {
    const base = adjustPalette(PAPER, 1, 0)
    const less = adjustPalette(PAPER, 1, -0.3)
    expect(contrastRatio(less.ink, less.surface)).toBeLessThan(
      contrastRatio(base.ink, base.surface),
    )
  })
})

/* THE FLOOR IS THE WHOLE SAFETY ARGUMENT. Two controls that can each reduce
 * separation can, together, produce a page nobody can read — and a reader who
 * gets there has no way of knowing which control to undo. */
describe('no combination of the two can go under 4.5:1', () => {
  const range = [0, 0.25, 0.5, 0.75, 1]
  const contrasts = [-1, -0.6, -0.3, 0, 0.3, 0.6, 1]

  for (const [name, theme] of [['Paper', PAPER], ['Night', NIGHT]] as const) {
    it(`holds the floor across every setting on ${name}`, () => {
      for (const b of range) {
        for (const c of contrasts) {
          const p = adjustPalette(theme, b, c)
          for (const key of ['ink', 'ink2', 'muted'] as const) {
            const ratio = contrastRatio(p[key], p.surface)
            expect(ratio, `${name} b=${b} c=${c} ${key} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.49)
          }
        }
      }
    })
  }

  it('holds it at the very worst setting — darkest page, softest text', () => {
    const p = adjustPalette(PAPER, 0, -1)
    expect(contrastRatio(p.ink, p.surface)).toBeGreaterThanOrEqual(4.49)
  })
})
