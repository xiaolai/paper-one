import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Renderer } from 'foliate-js/view.js'
import { READING_STEPS, pageMargins, proseBleed, proseGrid } from '../../core/metrics'
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

/** Gutter 56 + gap 32 — `pageMargins` at every width the stage is not starved. */
const MARGINS = 88

const settings = (animated: boolean) => ({
  stepIdx: 2,
  pageMargins: MARGINS,
  /* The measure the GRID settled on, which the renderer is told rather than
   * deriving. It is deliberately NOT `measureForStep(2)` here: the two differ
   * exactly when the stage is too narrow, which is the case that used to draw
   * the text over its own gutter. */
  measure: 624,
  theme: 'paper' as const,
  typeface: 'literata' as const,
  spacing: { letter: 1, word: 0, line: 1, paragraph: 2 },
  /* The theme untouched: this suite is about layout attributes. */
  align: 'justified' as const,
  brightness: 1,
  contrast: 0,
  animated,
  paginated: true,
})

/**
 * FOLIATE'S OWN ARITHMETIC, transcribed from `paginator.js` — `#render`'s
 * conversion and `columnize`'s use of it, at the pinned SHA:
 *
 *   const g = parseFloat(style.getPropertyValue('--_gap')) / 100
 *   const gap = -g / (g - 1) * size
 *   const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
 *   const columnWidth = (size / divisor) - gap
 *   … 'column-width': `${Math.trunc(columnWidth)}px`
 *
 * `size` is `#container`, which the shadow grid sizes to `--_max-width` —
 * `max-inline-size` times the column count, so `max-inline-size` at Paper's
 * fixed count of one.
 *
 * Transcribed rather than imported because there is nothing to import: the
 * value never leaves the closed shadow root, and the ONE number that decides
 * whether the text is the designed measure is computed three layers inside a
 * dependency. A copy here is a copy — `the renderer Paper actually ships`
 * below is what stops it drifting into fiction.
 */
function foliateColumn(attributes: Map<string, string>): number {
  const maxInlineSize = parseFloat(attributes.get('max-inline-size') ?? '')
  const maxColumnCount = parseInt(attributes.get('max-column-count') ?? '', 10)
  // `#container` is sized by the shadow grid to `--_max-width`.
  const size = maxInlineSize * maxColumnCount
  const g = parseFloat(attributes.get('gap') ?? '') / 100
  const gap = (-g / (g - 1)) * size
  const divisor = Math.min(maxColumnCount, Math.ceil(size / maxInlineSize))
  return Math.trunc(size / divisor - gap)
}

/** What `applyLayout` leaves on a renderer, for the settings given. */
function laidOut(overrides: Partial<Parameters<typeof applyLayout>[1]> = {}) {
  const renderer = fakeRenderer()
  applyLayout(renderer, { ...settings(true), ...overrides })
  return renderer.attributes
}

/* The renderer is what draws the text, so it is what has to be told how wide
 * the text may be. It used to work that out for itself from the reading step,
 * which is right only while the stage can afford that width — `proseGrid`
 * shrinks the measure when it cannot, and nothing passed that on. The grid
 * then reserved a gutter the renderer knew nothing about and drew straight
 * over it: measured at a 760px window, a 688px renderer asking for 700 and
 * zero space either side of the words.
 *
 * ASSERTED THROUGH `foliateColumn`, not off the attribute. `max-inline-size` is
 * the PAGE now, and the page is deliberately wider than the measure — so the
 * attribute and the text width are no longer the same number and reading the
 * attribute would assert the wrong one. What has to hold is unchanged: the
 * column foliate lays out is the column the grid reserved. */
describe('the measure the renderer lays out', () => {
  it('is the grid’s, not the reading step’s', () => {
    // 660 is `measureForStep(2)` — the width the step asks for, which is the
    // number this must NOT reach for.
    expect(foliateColumn(laidOut({ stepIdx: 2, measure: 624 }))).toBe(624)
  })

  it('follows the grid down as the stage narrows, at a fixed reading step', () => {
    const widths = [660, 624, 540, 480].map((measure) =>
      foliateColumn(laidOut({ stepIdx: 2, measure })),
    )
    expect(widths).toEqual([660, 624, 540, 480])
  })

  /* Every §09 reading size, because the gap is DERIVED from the measure now and
   * a derivation that happens to land on one number is not a derivation. */
  it('lands on the measure at every reading step, and at every margin', () => {
    for (const [stepIdx, step] of READING_STEPS.entries())
      for (const margins of [0, 24, 56, 88, 176])
        expect(
          foliateColumn(laidOut({ stepIdx, measure: step.measure, pageMargins: margins })),
          `step ${stepIdx} at ${margins}`,
        ).toBe(step.measure)
  })

  /* Foliate builds its grid with `calc()`, which drops the whole declaration
   * if a value arrives without a unit — the tracks then size to content and
   * every attribute still looks correct. A fractional measure must not reach
   * it either. */
  it('carries a unit and a whole number — floored, never rounded up', () => {
    const attributes = laidOut({ measure: 623.6 })
    // Floor: 624 would ask for more width than the grid allocated.
    expect(attributes.get('max-inline-size')).toBe(`${623 + MARGINS}px`)
    expect(foliateColumn(attributes)).toBe(623)
  })
})

/**
 * The page is WIDER than the measure, and that is the whole of the fix.
 *
 * `#container` is foliate's scroll port: it clips the book, and a turn scrolls
 * it by exactly one of its own widths. Sized to the measure — which is what
 * `max-inline-size: measure` and `gap: 0px` did — the port WAS the text, so the
 * outgoing page's last line and the incoming page's first sat flush against
 * each other for the whole 300ms, mid-word, with no seam. Measured in the app
 * at a 1024px window: `#container` 660px wide at x=182, `column-gap: 0px`,
 * 31 columns of 660 back to back.
 */
describe('the page the reader turns', () => {
  it('is the measure plus its own margins', () => {
    expect(laidOut({ measure: 660, pageMargins: 88 }).get('max-inline-size')).toBe('748px')
  })

  /* Half the margins sit either side of the text, so mid-turn — one page
   * leaving, one arriving — the white between the two texts is the whole. */
  it('puts a margin’s worth of white between one page and the next', () => {
    const attributes = laidOut({ measure: 660, pageMargins: 88 })
    expect(parseFloat(attributes.get('max-inline-size') ?? '') - foliateColumn(attributes)).toBe(88)
  })

  /* The bug itself, kept as a case rather than as prose: at zero margins the
   * page and the measure are one number again and the two texts touch. It is
   * also what scrolled flow is deliberately given, below. */
  it('collapses onto the measure when there are no margins, as it used to', () => {
    const attributes = laidOut({ measure: 660, pageMargins: 0 })
    expect(parseFloat(attributes.get('max-inline-size') ?? '') - foliateColumn(attributes)).toBe(0)
  })

  /* THE UNIT IS LOAD-BEARING AND FOLIATE'S JS DOES NOT READ IT. `#render` does
   * `parseFloat(gap) / 100` and never looks at the unit — which is why `'0px'`
   * survived here for years meaning 0%. The SHADOW GRID does read it:
   * `calc(var(--_max-width) - var(--_gap))` needs a percentage to subtract, and
   * a bare number invalidates the declaration, drops the whole
   * `grid-template-columns`, and sizes the tracks to content instead. Every
   * attribute still looks right. */
  it('writes the gap as a percentage, because the shadow grid subtracts it as one', () => {
    expect(laidOut().get('gap')).toMatch(/^[0-9.]+%$/)
  })

  /* Scrolled flow has no turn and nothing to separate, and `scrolled()` sets
   * `body { max-width: columnWidth }` with `columnWidth = maxInlineSize` — so a
   * page width here would not add margins, it would widen the text past its own
   * measure. The same edge-to-edge failure `applyLayout` records, from the
   * other side. */
  it('is the measure alone in scrolled flow, where there is no turn', () => {
    const attributes = laidOut({ paginated: false, measure: 660, pageMargins: 88 })
    expect(attributes.get('max-inline-size')).toBe('660px')
    expect(parseFloat(attributes.get('gap') ?? '')).toBe(0)
  })

  /**
   * THE CEILING, derived rather than chosen — and the reason `pageMargins`
   * takes the narrower of the two side lanes.
   *
   * foliate's shadow grid is
   *
   *   minmax(--_half-gap, 1fr) | --_half-gap
   *   | minmax(0, calc(--_max-width - --_gap))
   *   | --_half-gap | minmax(--_half-gap, 1fr)
   *
   * with `#container` spanning tracks 2–4, so the port is `--_max-width` only
   * while tracks 1 and 5 can meet their minimum. `--_half-gap` is a CSS
   * percentage of `#top`, which is the book element Paper sizes. Ask for a page
   * that does not leave room for both and the centre track — `minmax(0, …)` —
   * absorbs the difference instead of overflowing: the column comes out
   * narrower than the grid reserved, silently, at every width. Nothing throws
   * and nothing looks wrong until the text is measured.
   */
  it('never asks for a page the book element cannot hold', () => {
    for (let stage = 320; stage <= 2400; stage += 7) {
      for (const marks of [false, true]) {
        const grid = proseGrid(stage, marks)
        const bleed = proseBleed(grid)
        /* `#top` is `.text`: the prose grid, bled back to symmetry about the
         * measure. Written out track by track rather than as a formula, so it
         * follows `proseGrid` if the tracks are ever reordered. */
        const top =
          grid.gutter + grid.gap + grid.measure + grid.gap + grid.marginCol - bleed.start - bleed.end
        const attributes = laidOut({ measure: grid.measure, pageMargins: pageMargins(grid) })
        const page = parseFloat(attributes.get('max-inline-size') ?? '')
        const halfGap = parseFloat(attributes.get('gap') ?? '') / 100 / 2
        const where = `stage ${stage}, marks ${marks}`
        expect(page + 2 * halfGap * top, where).toBeLessThanOrEqual(top)
        // And the column still lands on the measure the grid reserved.
        expect(foliateColumn(attributes), where).toBe(Math.floor(grid.measure))
      }
    }
  })

  /* The narrow window with marks, named because it is the case the obvious
   * `gutter + gap` gets wrong: `proseGrid` spends the mark lane first and all
   * the way to zero, so the gutter is still 56 while the lane opposite it is
   * gone, and the book element is symmetric about the SMALLER of the two. */
  it('takes the narrower side lane, not the gutter', () => {
    const grid = proseGrid(760, true)
    expect(grid.marginCol).toBeLessThan(grid.gutter)
    expect(pageMargins(grid)).toBe(Math.floor(grid.marginCol + grid.gap))
  })
})

/**
 * The transcription in `foliateColumn` is a COPY, and a copy can drift.
 *
 * Everything above rests on arithmetic that lives three layers inside a closed
 * shadow root, in a dependency whose README says its API is unstable. A rebase
 * can change it and leave every test here green while describing a renderer
 * that no longer exists — which is exactly how the painter contract changed
 * under Paper once already. These read the shipped file.
 */
describe('the renderer Paper actually ships', () => {
  const paginator = readFileSync(
    fileURLToPath(new URL('../../../../node_modules/foliate-js/paginator.js', import.meta.url)),
    'utf8',
  )

  it('still converts the gap the way `pageGap` inverts it', () => {
    expect(paginator).toContain('const gap = -g / (g - 1) * size')
    expect(paginator).toContain("const columnWidth = (size / divisor) - gap")
  })

  it('still truncates the column, so the derivation must leave no remainder', () => {
    expect(paginator).toContain('Math.trunc(columnWidth)')
  })

  it('still sizes the port from the half-gap tracks the ceiling is derived from', () => {
    expect(paginator).toContain('minmax(var(--_half-gap), 1fr)')
    expect(paginator).toContain('grid-column: 2 / 5')
  })

  /* The duration is a literal in the fork, not an attribute — `MOTION.pageTurn`
   * records it rather than setting it, and this is what keeps that record
   * honest. */
  it('still eases the turn over the 300ms the motion table reports', () => {
    expect(paginator).toContain('300, easeOutQuad')
  })
})

/*
 * The blocks below predate this change and are untouched by it, save one line.
 *
 * They are what stops the page turn regressing in the two ways it already has:
 * `animated` is the whole slide, and foliate tests for the attribute's PRESENCE
 * so `animated="false"` would animate; `flow` and `zoom` are one setting
 * reaching two renderers that read different attribute names.
 */
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

  /* `gap` is in this list even though it is DERIVED now: whether the turn eases
   * is not an input to the page's geometry, and the day it becomes one is the
   * day the reduced-motion reader gets a different measure from everyone else. */
  it('leaves the other settings alone either way', () => {
    const on = fakeRenderer()
    const off = fakeRenderer()
    applyLayout(on, settings(true))
    applyLayout(off, settings(false))
    for (const key of ['flow', 'zoom', 'max-inline-size', 'margin', 'gap', 'max-column-count']) {
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
    expect(read('../commands.ts')).not.toContain('animat')
  })

  it('has no state field, so there is nothing to expose', () => {
    const state = read('../state.ts')
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
