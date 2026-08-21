/**
 * Give a figure the background it already has, so it reads as a plate.
 *
 * THE PROBLEM NOTHING IN CSS CAN SOLVE. A diagram exported with a white
 * background is white pixels. On a dark page it is a bright slab, and
 * `background-color` never touches it — the colour is IN the image. Forcing the
 * reader's ink everywhere, which Paper now does on a dark page, makes this
 * worse by contrast rather than better.
 *
 * WHAT THE ALTERNATIVES COST. Readium darkens (`brightness(80%)`) and inverts;
 * both damage the artwork, and `invert()` on a photograph is grotesque.
 * A bare border does not fix anything either: a white slab with a line round it
 * is still a white slab. What it changes is how it READS — deliberate rather
 * than broken — and that is worth having but it is not the whole of it.
 *
 * SO: EXTEND THE IMAGE'S OWN BACKGROUND OUTWARD. Matted in its own colour, with
 * padding and a radius, the white stops being a defect leaking onto the page and
 * becomes a plate — exactly how a printed book mounts one on coloured stock.
 * Nothing is filtered, no artwork is altered, and the image is what its author
 * made.
 *
 * ONLY WHERE IT APPLIES, which is why the corners are sampled. An image with a
 * transparent background already sits correctly on any page, and matting it
 * would invent a slab that was never there. So the four corners decide, and an
 * image that does not need this is left completely alone.
 */

/** A colour a matte can be drawn in, or null when the image does not want one. */
export interface Matte {
  readonly css: string
}

/** How far in from each corner to read, as a fraction of the shorter side. */
const INSET = 0.02

/**
 * Are these four corners one opaque colour?
 *
 * ALL FOUR, AND CLOSE TOGETHER. One corner is a photograph's sky; four that
 * agree is a background. A photograph almost never has four matching corners,
 * and a diagram almost always does, which is the whole discrimination — no
 * heuristic about file type, size or name gets near it.
 *
 * TRANSPARENCY DISQUALIFIES IMMEDIATELY. A PNG with an alpha background is
 * already correct on any page.
 */
export function matteFor(corners: readonly (readonly number[])[]): Matte | null {
  if (corners.length !== 4) return null
  for (const c of corners) {
    if (c.length < 4) return null
    /* FULLY OPAQUE, and nothing less. The first version allowed 250 and
       justified it as "a JPEG re-encode can land at 254" — which is simply
       untrue: JPEG HAS NO ALPHA CHANNEL and decodes to 255 everywhere. What
       that threshold actually did was accept a slightly transparent PNG edge
       and replace it with a solid colour, which is the one case this is
       supposed to refuse. */
    if (c[3] !== 255) return null
  }
  /* AGAINST THE CENTRE, NOT AGAINST THE FIRST CORNER. Compared with corner
     zero, two corners could sit eight levels either side of it and sixteen
     apart from each other and still pass — and corner zero, chosen only for
     being first, then became the matte colour, so a compression artefact at one
     corner set the colour for the whole plate. The mean is what they are all
     measured against and what gets drawn. */
  const mean = [0, 1, 2].map((i) => Math.round(corners.reduce((n, c) => n + (c[i] ?? 0), 0) / 4))
  for (const c of corners) {
    for (const i of [0, 1, 2]) {
      if (Math.abs((c[i] ?? 0) - (mean[i] ?? 0)) > 6) return null
    }
  }
  return { css: `rgb(${mean[0]} ${mean[1]} ${mean[2]})` }
}

/** Where to read, for an image of this size. */
export function cornerPoints(width: number, height: number): readonly (readonly [number, number])[] {
  /* CLAMPED TO WHAT EXISTS. Two percent of a 1px image is still 1px, and
     reading at [1,1] of a one-pixel image is off the end of it — caught by the
     test, which asked for a point inside the image and got one outside. */
  const shorter = Math.min(width, height)
  const inset = Math.min(Math.max(1, Math.round(shorter * INSET)), Math.floor((shorter - 1) / 2))
  const right = Math.max(0, width - 1 - inset)
  const bottom = Math.max(0, height - 1 - inset)
  return [
    [inset, inset],
    [right, inset],
    [inset, bottom],
    [right, bottom],
  ]
}

/** The bits of a canvas this needs — the seam, so the decision is testable. */
export interface Sampler {
  (img: HTMLImageElement): readonly (readonly number[])[] | null
}

/**
 * Read an image's four corners through a canvas.
 *
 * SAME ORIGIN, so this does not taint. Book resources arrive as `blob:` URLs
 * minted by foliate's `Loader` from the archive, which makes them same-origin
 * with the document — a remote image would taint the canvas and `getImageData`
 * would throw, which is caught and treated as "no matte" rather than as an
 * error, because a figure without a matte is the behaviour without any of this.
 */
export const canvasSampler: Sampler = (img) => {
  const width = img.naturalWidth
  const height = img.naturalHeight
  if (!width || !height) return null
  try {
    /* TWO PIXELS BY TWO, NEVER THE IMAGE'S OWN SIZE. The first version
       allocated a canvas of width x height and drew the whole image in order to
       read four pixels: a 4000x3000 figure is 48MB of RGBA backing, and a
       section with forty of them is over two gigabytes of pixel writes — on the
       main thread, inside the load handler, which foliate calls BEFORE its first
       render. It blocked pagination to answer a question about four bytes.

       The nine-argument drawImage copies a 1x1 source rectangle into a 1x1
       destination, so each corner lands in one pixel of a four-pixel canvas and
       one getImageData reads all of them.

       No `willReadFrequently`: it hints at repeated reads of a canvas drawn
       many times, and can force a software backing. This one is drawn four
       times, read once, and thrown away. */
    const canvas = img.ownerDocument.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const points = cornerPoints(width, height)
    points.forEach(([x, y], i) => {
      ctx.drawImage(img, x, y, 1, 1, i % 2, i < 2 ? 0 : 1, 1, 1)
    })
    const { data } = ctx.getImageData(0, 0, 2, 2)
    /* Back into corner order: the loop above wrote 0,1 across the top row and
       2,3 across the bottom, which is the order `cornerPoints` returns. */
    return [0, 1, 2, 3].map((i) => [...data.slice(i * 4, i * 4 + 4)])
  } catch {
    /* A tainted canvas, a decode that failed, an image the engine will not
       hand back. None of them is worth reporting: the figure keeps the
       treatment it would have had. */
    return null
  }
}

/**
 * Matte every figure in a document that wants one.
 *
 * AFTER THE IMAGE HAS DECODED, and that is the whole of the scheduling. An
 * image asked for its pixels before `complete` returns a blank canvas — four
 * transparent corners, which this correctly reads as "no matte" and would then
 * never revisit. So each one is either read now or waited for once.
 *
 * The colour is written as a custom property rather than as a background, so
 * the stylesheet keeps the padding, the radius and the decision about which
 * themes matte at all. This sets a fact; `bookCss` decides what to do with it.
 */
export function matteFigures(doc: Document, sample: Sampler = canvasSampler): void {
  const body = doc.body as HTMLElement | null
  if (!body) return
  for (const img of body.querySelectorAll<HTMLImageElement>('img[data-paper-figure]')) {
    const apply = () => {
      const matte = matteFor(sample(img) ?? [])
      if (!matte) return
      img.style.setProperty('--paper-matte', matte.css)
      img.setAttribute('data-paper-matte', '')
    }
    if (img.complete) apply()
    else img.addEventListener('load', apply, { once: true })
  }
}
