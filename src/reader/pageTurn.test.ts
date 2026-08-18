import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Renderer } from 'foliate-js/view.js'
import { applyLayout } from './FoliateView'

/**
 * The page turn slides, and there is no setting for it.
 *
 * Worth a test of its own because the whole behaviour rests on ONE attribute
 * whose absence is silent: foliate checks `hasAttribute('animated')` and jumps
 * when it is missing, which is exactly what Paper did for months without anyone
 * noticing a feature was switched off rather than absent.
 */

/** Records what was set on it — the only part of a `Renderer` this touches. */
function fakeRenderer() {
  const attributes = new Map<string, string>()
  const renderer = {
    attributes,
    /** Every write, in order — a guard is about writes, not final values. */
    writes: [] as string[],
    setAttribute(this: { writes: string[] }, name: string, value: string) {
      this.writes.push(name)
      attributes.set(name, value)
    },
    /* Reads back, because `applyLayout` now WRITES `zoom` only when it changes:
     * `attributeChangedCallback` fires on every `setAttribute`, so rewriting it
     * needlessly re-ran the fixed-layout renderer and repainted every PDF page.
     * A fake that forgot its own attributes could not tell the two apart. */
    getAttribute: (name: string) => attributes.get(name) ?? null,
    toggleAttribute: (name: string, force: boolean) => {
      if (force) attributes.set(name, '')
      else attributes.delete(name)
      return force
    },
  }
  return renderer as unknown as Renderer & { attributes: Map<string, string>; writes: string[] }
}

const settings = (animated: boolean) => ({
  stepIdx: 2,
  /* The measure the GRID settled on, which the renderer is told rather than
   * deriving. It is deliberately NOT `measureForStep(2)` here: the two differ
   * exactly when the stage is too narrow, which is the case that used to draw
   * the text over its own gutter. */
  measure: 624,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  spacing: { letter: 1, word: 0, line: 1, paragraph: 2 },
  animated,
  paginated: true,
})

/* The renderer is what draws the text, so it is what has to be told how wide
 * the text may be. It used to work that out for itself from the reading step,
 * which is right only while the stage can afford that width — `proseGrid`
 * shrinks the measure when it cannot, and nothing passed that on. The grid
 * then reserved a gutter the renderer knew nothing about and drew straight
 * over it: measured at a 760px window, a 688px renderer asking for 700 and
 * zero space either side of the words. */
describe('the measure the renderer is given', () => {
  it('is the grid’s, not the reading step’s', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, { ...settings(true), stepIdx: 2, measure: 624 })
    // 660 is `measureForStep(2)` — the width the step asks for, which is the
    // number this must NOT reach for.
    expect(renderer.attributes.get('max-inline-size')).toBe('624px')
  })

  it('follows the grid down as the stage narrows, at a fixed reading step', () => {
    const widths = [660, 624, 540, 480].map((measure) => {
      const renderer = fakeRenderer()
      applyLayout(renderer, { ...settings(true), stepIdx: 2, measure })
      return renderer.attributes.get('max-inline-size')
    })
    expect(widths).toEqual(['660px', '624px', '540px', '480px'])
  })

  /* Foliate builds its grid with `calc()`, which drops the whole declaration
   * if a value arrives without a unit — the tracks then size to content and
   * every attribute still looks correct. A fractional measure must not reach
   * it either. */
  it('carries a unit and a whole number — floored, never rounded up', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, { ...settings(true), measure: 623.6 })
    // Floor: 624 would ask for more width than the grid allocated.
    expect(renderer.attributes.get('max-inline-size')).toBe('623px')
  })
})

describe('the page turn', () => {
  it('slides', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(true))
    expect(renderer.attributes.has('animated')).toBe(true)
  })

  /* The single exception, and not a preference: a reader whose system asks for
   * less movement has already said so once, and Paper offers no way to say it
   * again — or to switch it back on. */
  it('does not slide when the system asks for less movement', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(false))
    expect(renderer.attributes.has('animated')).toBe(false)
  })

  /* `toggleAttribute`, not `setAttribute`. foliate tests for PRESENCE, so
   * `animated="false"` would animate — the failure that looks like a fix. */
  it('removes the attribute rather than setting it false', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(true))
    applyLayout(renderer, settings(false))
    expect(renderer.attributes.get('animated')).toBeUndefined()
  })

  it('leaves the other settings alone either way', () => {
    const on = fakeRenderer()
    const off = fakeRenderer()
    applyLayout(on, settings(true))
    applyLayout(off, settings(false))
    for (const key of ['flow', 'max-inline-size', 'margin', 'gap', 'max-column-count']) {
      expect(off.attributes.get(key), key).toBe(on.attributes.get(key))
    }
  })
})

describe('no control exposes this', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

  /* The decision was one behaviour rather than a menu. A settings row or a
   * palette command would be someone re-adding the choice later without the
   * argument for it, so both are asserted absent rather than left to habit. */
  it('has no Settings row and no palette command', () => {
    expect(read('../pane/Settings.tsx')).not.toContain('animat')
    expect(read('../lib/commands.ts')).not.toContain('animat')
  })

  it('has no state field, so there is nothing to expose', () => {
    const state = read('../lib/state.ts')
    expect(state).not.toContain('animated')
    expect(state).not.toContain('pageTurn')
  })
})

/**
 * One Flow setting has to reach BOTH renderers.
 *
 * A PDF is drawn by `foliate-fxl`, which has never read `flow` — so for as long
 * as `zoom` went unset, every PDF sat on that renderer's implicit fit-page
 * default and the Flow control was a switch wired to nothing. These assert the
 * pairing rather than either attribute alone, because the bug was never a wrong
 * value: it was a missing one, and each attribute on its own looked right.
 */
describe('flow reaches the fixed-layout renderer too', () => {
  const layout = (paginated: boolean) => {
    const renderer = fakeRenderer()
    applyLayout(renderer, { ...settings(true), paginated })
    return renderer.attributes
  }

  it('pages both renderers together', () => {
    const attrs = layout(true)
    expect(attrs.get('flow')).toBe('paginated')
    expect(attrs.get('zoom')).toBe('fit-page')
  })

  /* `fit-width` is not a zoom control. It scales a page to the viewport's
   * width, so a portrait page overflows the renderer — which carries
   * `:host { overflow: auto }` — and scrolls. That is a PDF's scroll mode, and
   * it needed no fork and no change to how the book is built. */
  it('scrolls both renderers together', () => {
    const attrs = layout(false)
    expect(attrs.get('flow')).toBe('scrolled')
    expect(attrs.get('zoom')).toBe('fit-width')
  })

  /* The failure that started this: making the PDF `reflowable` to move it onto
   * the paginator. The paginator columnises the loaded document by the reading
   * measure, so a rigid page canvas drew at half the window — and it sizes its
   * scrollport by measuring a document that a PDF paints into asynchronously,
   * so there was nothing to scroll either. Both modes came out broken. */
  it('does not reach for a reflowable layout to get a PDF scrolling', () => {
    const makePdf = readFileSync(fileURLToPath(new URL('./makePdf.ts', import.meta.url)), 'utf8')
    expect(makePdf).toContain("layout: 'pre-paginated'")
  })
})

/**
 * Writing an attribute is not free, and `zoom` is the expensive one.
 *
 * `attributeChangedCallback` fires on EVERY `setAttribute`, not only on ones
 * that change the value — so rewriting `zoom` on each settings pass re-ran the
 * fixed-layout renderer, which calls back into `makePdf` and repaints the page
 * and its text layer. Changing the theme threw away a PDF render and redid it.
 */
describe('a settings pass that changes nothing', () => {
  it('does not rewrite zoom', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(true))
    const first = renderer.writes.filter((n) => n === 'zoom').length
    applyLayout(renderer, settings(true))
    expect(first).toBe(1)
    expect(renderer.writes.filter((n) => n === 'zoom')).toHaveLength(1)
  })

  it('still writes zoom when the mode actually changes', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(true))
    applyLayout(renderer, { ...settings(true), paginated: false })
    expect(renderer.writes.filter((n) => n === 'zoom')).toHaveLength(2)
    expect(renderer.attributes.get('zoom')).toBe('fit-width')
  })

  /* `flow` is deliberately NOT guarded: writing it is what makes the paginator
   * re-render, and the sizing attributes are read during that render rather
   * than observed on their own. Guarded, a type-size change would set
   * `max-inline-size` with nothing to act on it. */
  it('keeps rewriting flow, which is what triggers a reflow', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings(true))
    applyLayout(renderer, settings(true))
    expect(renderer.writes.filter((n) => n === 'flow')).toHaveLength(2)
  })
})
