import { ALL_FACES, scaleFor, type Face } from './typefaces'

/**
 * What this machine actually has, and how big each face reads.
 *
 * Separated from `typefaces.ts` because everything in there is a table and a
 * rule, and everything here needs a canvas. The registry can be tested; this
 * has to be measured on the machine it runs on.
 *
 * HOW A FONT IS FOUND, since there is no API that answers it. Render a string
 * in `"Candidate", <generic>` and again in `<generic>` alone: if the candidate
 * exists the widths differ, and if it does not the request falls through to the
 * generic and they match exactly.
 *
 * Against ALL THREE generics, not one. A face that happens to BE the generic
 * default is invisible to a single comparison — probing "Times New Roman"
 * against `serif` reads as absent on any machine where Times is what `serif`
 * means, which is most of them. Compared against `monospace` as well it is
 * plainly there. One comparison would have quietly dropped a face from the list
 * on exactly the platforms that have it.
 */

const SAMPLE = 'Handgloves 0123 mnop'
const GENERICS = ['serif', 'sans-serif', 'monospace'] as const

/** A canvas measured once — building one per probe is the slow way to do this. */
function context(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  return document.createElement('canvas').getContext('2d')
}

/**
 * The ids of every known face this machine can actually render.
 *
 * Bundled faces are not probed: they ship with the app, and probing them would
 * report them missing for however long the webfont takes to load.
 */
export function presentFaces(): Set<string> {
  const ctx = context()
  const found = new Set<string>()
  if (!ctx) return found
  const base = new Map<string, number>()
  for (const generic of GENERICS) {
    ctx.font = `72px ${generic}`
    base.set(generic, ctx.measureText(SAMPLE).width)
  }
  for (const face of ALL_FACES) {
    if (!face.probe) continue
    const differs = GENERICS.some((generic) => {
      ctx.font = `72px "${face.probe}", ${generic}`
      return Math.abs(ctx.measureText(SAMPLE).width - (base.get(generic) ?? 0)) > 0.5
    })
    if (differs) found.add(face.id)
  }
  return found
}

/**
 * A face's x-height as a fraction of its em, measured.
 *
 * `actualBoundingBoxAscent` of a lowercase `x` is the x-height by definition —
 * no table lookup, no per-face constant to keep up to date, and it works for a
 * face this app has never heard of. Zero when there is no canvas, which
 * `scaleFor` reads as "do not correct".
 */
export function xHeightOf(stack: string): number {
  const ctx = context()
  if (!ctx) return 0
  ctx.font = `100px ${stack}`
  const metrics = ctx.measureText('x')
  return (metrics.actualBoundingBoxAscent ?? 0) / 100
}

/* Measured once per stack. The value cannot change while the app is running —
 * a face is the shape it is — and the reading settings are re-applied on every
 * theme change, page turn and pane animation. */
const scales = new Map<string, number>()

/**
 * The correction to apply to a reading size in this face, so the size a reader
 * chose means the same thing in all of them — see `typefaces.ts`.
 */
export function opticalScale(face: Face): number {
  const cached = scales.get(face.stack)
  if (cached !== undefined) return cached
  const scale = scaleFor(xHeightOf(face.stack))
  scales.set(face.stack, scale)
  return scale
}
