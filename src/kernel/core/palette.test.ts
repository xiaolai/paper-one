import { describe, expect, it } from 'vitest'
import { adjustPalette, contrastRatio, luminance, mix, type Palette } from './palette'

/* The two polarities, read from `tokens.css` rather than invented. */
const PAPER: Palette = {
  surface: '#FFFFFF', bg: '#FBFBFA', wash: '#F2F3F1',
  line: '#EDEEEB', line2: '#E3E4E1', line3: '#D6D8D3',
  ink: '#17191B', ink2: '#3D4348', muted: '#5F666C',
}
const NIGHT: Palette = {
  surface: '#16191C', bg: '#101315', wash: '#1E2226',
  line: '#24282C', line2: '#2F343A', line3: '#3C4248',
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

  /* ONE DIRECTION IN EVERY THEME. A control called Brightness that moved the
   * text on one theme and the background on another would be one a reader
   * cannot predict — which is what the first version did. */
  it('darkens the background on every theme', () => {
    for (const [name, theme] of [['Paper', PAPER], ['Night', NIGHT]] as const) {
      const dim = adjustPalette(theme, 0.75, 0)
      for (const key of ['surface', 'bg', 'wash'] as const) {
        expect(luminance(dim[key]), `${name} ${key}`).toBeLessThan(luminance(theme[key]))
      }
    }
  })

  /* `--line` on Paper is luminance 0.85 and the dimmed surface reaches 0.52, so
   * a rule left alone would be LIGHTER than the page it divides. */
  it('darkens the rules with the background, so no border out-lights its page', () => {
    for (const [name, theme] of [['Paper', PAPER], ['Night', NIGHT]] as const) {
      const dim = adjustPalette(theme, 0.75, 0)
      for (const key of ['line', 'line2', 'line3'] as const) {
        expect(luminance(dim[key]), `${name} ${key}`).toBeLessThan(luminance(theme[key]))
      }
      // On a light theme the rules must stay under the page they sit on.
      if (luminance(theme.surface) > luminance(theme.ink)) {
        expect(luminance(dim.line), `${name} line vs surface`).toBeLessThan(luminance(dim.surface))
      }
    }
  })

  it('does not move the font at all', () => {
    for (const theme of [PAPER, NIGHT]) {
      const dim = adjustPalette(theme, 0.75, 0)
      // Unchanged, unless the floor had to step in — which it must not here.
      expect(dim.ink).toBe(theme.ink)
      expect(dim.ink2).toBe(theme.ink2)
    }
  })
})

describe('contrast moves the font, never the background', () => {
  it('leaves every background colour where brightness put it', () => {
    for (const theme of [PAPER, NIGHT]) {
      const neutral = adjustPalette(theme, 0.8, 0)
      for (const c of [-0.35, 0.35]) {
        const moved = adjustPalette(theme, 0.8, c)
        for (const key of ['surface', 'bg', 'wash', 'line', 'line2', 'line3'] as const) {
          expect(moved[key], key).toBe(neutral[key])
        }
      }
    }
  })

  /* On a dark theme, more contrast means BRIGHTER text — the opposite move
   * from a light theme, and the one place polarity still matters. */
  it('brightens the text on a dark theme when asked for more', () => {
    const more = adjustPalette(NIGHT, 1, 0.35)
    expect(luminance(more.ink)).toBeGreaterThan(luminance(NIGHT.ink))
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
