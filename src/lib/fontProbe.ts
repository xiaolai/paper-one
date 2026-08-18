import { useEffect, useState } from 'react'
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

/**
 * A canvas, for FINDING fonts only — never for measuring one.
 *
 * Width comparison is what detection needs and a canvas is the cheapest way to
 * get it. Measuring a face's proportions is a different question and this is
 * the wrong instrument for it: see `xHeightOf`.
 */
function context(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (typeof document.createElement !== 'function') return null
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
 * A face's x-height as a fraction of its em.
 *
 * `1ex` IS the x-height — that is the definition of the unit — so an element
 * one ex tall, in the face, measured, is the answer with no glyph rasterising
 * and no metrics table.
 *
 * NOT A CANVAS, which is where this started and where it was wrong. A canvas
 * resolves `ctx.font` against the fonts the CANVAS knows, and a webfont the
 * page has loaded is not among them until it is explicitly loaded again — so
 * measuring Literata returned Georgia's x-height, the next family in its
 * stack. The scale was then computed for the wrong face: Literata is the
 * REFERENCE and must come out at exactly 1, and it was coming out at 1.06.
 * Every bundled face was being corrected by a number measured off a fallback.
 *
 * An element resolves the stack the same way the text it describes will, which
 * is the only property that makes the measurement mean anything.
 *
 * Zero when there is no document, which `scaleFor` reads as "do not correct".
 */
export function xHeightOf(stack: string): number {
  /* Capability, not existence. A `document` can be present and not be a
     document — a test stub, a non-browser host — and `scaleFor` reads 0 as "do
     not correct", which is the right answer in every one of those cases. This
     builds a stylesheet; it must not be the thing that throws. */
  if (typeof document === 'undefined') return 0
  if (typeof document.createElement !== 'function' || !document.body) return 0
  const probe = document.createElement('span')
  probe.style.cssText =
    `position:absolute;visibility:hidden;pointer-events:none;` +
    `font-family:${stack};font-size:1000px;width:1ex;height:1ex;padding:0;border:0`
  document.body.appendChild(probe)
  const ex = probe.getBoundingClientRect().height
  probe.remove()
  return ex / 1000
}

/* Measured once per stack, but ONLY ONCE THE FONTS ARE THERE. A face is the
 * shape it is and cannot change while the app runs — but until its webfont has
 * loaded, the stack resolves to the next family down and the shape being
 * measured is somebody else's. */
const scales = new Map<string, number>()

/** Whether webfonts have finished loading, so a measurement is of the real face. */
function fontsSettled(): boolean {
  return typeof document === 'undefined' || document.fonts === undefined
    ? true
    : document.fonts.status === 'loaded'
}

/**
 * The correction to apply to a reading size in this face, so the size a reader
 * chose means the same thing in all of them — see `typefaces.ts`.
 *
 * MEASURED EARLY IS MEASURED WRONG, and cached early is wrong for the rest of
 * the session. `'Literata Variable'` before its webfont arrives resolves to
 * Georgia, the next family in its own stack — so the reference face, which must
 * come out at exactly 1, was being corrected by 6% against a measurement of a
 * different typeface. It was right in a console a second later, which is what
 * made it look like it worked.
 *
 * So nothing is remembered until `document.fonts` says it has finished. Before
 * that the answer is still returned — an early paint is better slightly wrong
 * than blank — it is simply not kept, and the next call after loading measures
 * the real face and keeps that.
 */
export function opticalScale(face: Face): number {
  const cached = scales.get(face.stack)
  if (cached !== undefined) return cached
  const scale = scaleFor(xHeightOf(face.stack))
  if (fontsSettled()) scales.set(face.stack, scale)
  return scale
}

/**
 * True once webfonts have loaded, so a caller can measure again.
 *
 * Not a convenience: without it the correction is only picked up by whatever
 * happens to re-render after loading. A book opened during startup would keep
 * the size it was given from a measurement of Georgia until the reader changed
 * some other setting.
 */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(fontsSettled())
  useEffect(() => {
    if (ready || typeof document === 'undefined' || !document.fonts) return
    let live = true
    void document.fonts.ready.then(() => {
      if (live) setReady(true)
    })
    return () => {
      live = false
    }
  }, [ready])
  return ready
}
