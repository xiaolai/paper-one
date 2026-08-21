// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { cornerPoints, matteFigures, matteFor } from './matteFigures'

/**
 * Which figures get a matte, and — much more importantly — which do not.
 *
 * The decision is made from the image's four corners, and that is not a
 * convenience. There is no attribute, file type, size or name that separates
 * "a diagram exported on white" from "a photograph" from "a transparent PNG",
 * and the consequence of guessing is a slab of invented white around artwork
 * that was correct to begin with. Four corners that agree IS a background; a
 * photograph almost never has four matching corners.
 */

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a]
const four = (c: number[]) => [c, c, c, c]

describe('matteFor', () => {
  it('mattes an image whose four corners are one opaque colour', () => {
    expect(matteFor(four(px(255, 255, 255)))).toEqual({ css: 'rgb(255 255 255)' })
  })

  it('mattes a colour that is not white, because the plate is the image’s own', () => {
    /* The point is not "hide white". It is to extend whatever background the
       image already has, so a cream or grey plate is matted in its own colour. */
    expect(matteFor(four(px(247, 240, 226)))).toEqual({ css: 'rgb(247 240 226)' })
  })

  it('refuses a transparent background, which is already correct anywhere', () => {
    /* THE CASE THAT MATTERS MOST. A transparent PNG sits properly on a dark
       page with no help; matting it invents a slab that was never there. */
    expect(matteFor(four(px(255, 255, 255, 0)))).toBeNull()
    expect(matteFor(four(px(255, 255, 255, 128)))).toBeNull()
  })

  it('refuses anything less than fully opaque', () => {
    /* The first version allowed 250 and justified it as "a JPEG re-encode can
       land at 254". JPEG HAS NO ALPHA CHANNEL and decodes to 255 everywhere, so
       the rationale was simply false — and what the threshold actually did was
       accept a slightly transparent PNG edge and paint a solid colour behind
       it, which is the one case this exists to refuse. */
    expect(matteFor(four(px(255, 255, 255, 254)))).toBeNull()
    expect(matteFor(four(px(255, 255, 255, 255)))).not.toBeNull()
  })

  it('refuses corners that disagree, which is a photograph', () => {
    const corners = [px(20, 30, 40), px(200, 190, 180), px(90, 90, 90), px(10, 10, 10)]
    expect(matteFor(corners)).toBeNull()
  })

  it('forgives compression noise and refuses a gradient', () => {
    expect(matteFor([px(255, 255, 255), px(252, 252, 252), px(253, 253, 253), px(255, 255, 255)]))
      .not.toBeNull()
    expect(matteFor([px(255, 255, 255), px(230, 230, 230), px(255, 255, 255), px(255, 255, 255)]))
      .toBeNull()
  })

  it('measures every corner against the centre, not against the first one', () => {
    /* Compared with corner zero, two corners could sit either side of it and be
       twice the tolerance apart from EACH OTHER and still pass — and corner
       zero, chosen only for being first, then became the matte colour, so one
       compression artefact set the colour of the whole plate. */
    /* 92 and 108 are each exactly 8 from 100, so the old first-corner rule with
       its 8-level slack accepted both — while they are SIXTEEN apart from one
       another, which is a gradient, not noise. Against the mean of 100 with 6
       levels, the outliers fail. Written first as `262 - 12`, which is 250 and
       therefore identical to its neighbours: arithmetic that tested nothing. */
    const spread = [px(100, 100, 100), px(92, 100, 100), px(108, 100, 100), px(100, 100, 100)]
    expect(matteFor(spread)).toBeNull()
  })

  it('draws the mean, so no single corner decides the colour', () => {
    const noisy = [px(200, 200, 200), px(204, 204, 204), px(202, 202, 202), px(202, 202, 202)]
    expect(matteFor(noisy)).toEqual({ css: 'rgb(202 202 202)' })
  })

  it('refuses a reading it did not get four corners for', () => {
    expect(matteFor([])).toBeNull()
    expect(matteFor([px(255, 255, 255)])).toBeNull()
    expect(matteFor([[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]])).toBeNull()
  })
})

describe('cornerPoints', () => {
  it('reads just inside the edge, not on it', () => {
    /* The outermost row of a JPEG carries the worst of its ringing. */
    const pts = cornerPoints(1000, 500)
    expect(pts).toEqual([[10, 10], [989, 10], [10, 489], [989, 489]])
  })

  it('still reads four distinct points on a tiny image', () => {
    const pts = cornerPoints(4, 4)
    expect(pts).toHaveLength(4)
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(4)
      expect(y).toBeLessThan(4)
    }
  })

  it('does not run off a one-pixel image', () => {
    for (const [x, y] of cornerPoints(1, 1)) {
      expect(x).toBe(0)
      expect(y).toBe(0)
    }
  })
})

describe('matteFigures', () => {
  const withFigure = (complete: boolean) => {
    const d = new DOMParser().parseFromString(
      '<body><p><img id="f" data-paper-figure src="a.png"/></p><p><img id="g" src="b.png"/></p></body>',
      'text/html',
    )
    const img = d.getElementById('f') as HTMLImageElement
    Object.defineProperty(img, 'complete', { value: complete })
    return { d, img }
  }

  it('sets the colour as a property, leaving the stylesheet to decide the rest', () => {
    /* This records a FACT about the image. Padding, radius and which themes
       matte at all are the sheet's business. */
    const { d, img } = withFigure(true)
    matteFigures(d, () => four(px(255, 255, 255)))
    expect(img.style.getPropertyValue('--paper-matte')).toBe('rgb(255 255 255)')
    expect(img.hasAttribute('data-paper-matte')).toBe(true)
  })

  it('only looks at images markFigures marked', () => {
    const { d } = withFigure(true)
    matteFigures(d, () => four(px(255, 255, 255)))
    expect(d.getElementById('g')?.hasAttribute('data-paper-matte')).toBe(false)
  })

  it('marks nothing when the image does not want a matte', () => {
    const { d, img } = withFigure(true)
    matteFigures(d, () => four(px(255, 255, 255, 0)))
    expect(img.hasAttribute('data-paper-matte')).toBe(false)
    expect(img.style.getPropertyValue('--paper-matte')).toBe('')
  })

  it('waits for an image that has not decoded, rather than reading a blank canvas', () => {
    /* THE SCHEDULING IS THE WHOLE OF IT. Asked for its pixels before
       `complete`, an image hands back four transparent corners — which reads
       exactly like "no matte wanted" and would never be revisited. */
    const { d, img } = withFigure(false)
    const sample = vi.fn(() => four(px(255, 255, 255)))
    matteFigures(d, sample)
    expect(sample).not.toHaveBeenCalled()
    img.dispatchEvent(new Event('load'))
    expect(sample).toHaveBeenCalledTimes(1)
    expect(img.hasAttribute('data-paper-matte')).toBe(true)
  })

  it('treats a sampler that cannot read as no matte, not as an error', () => {
    /* A tainted canvas, a failed decode. The figure keeps the treatment it
       would have had without any of this. */
    const { d, img } = withFigure(true)
    expect(() => matteFigures(d, () => null)).not.toThrow()
    expect(img.hasAttribute('data-paper-matte')).toBe(false)
  })
})
