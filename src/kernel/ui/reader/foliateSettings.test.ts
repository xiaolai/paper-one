// @vitest-environment jsdom
//
// `applySettings` reaches `bookSheets()`, which builds style elements — so this
// file needs a document where the layout assertions above it do not.
import { describe, expect, it, vi } from 'vitest'
import type { Renderer } from 'foliate-js/view.js'
import { applyLayout, applySettings, readingVars } from './FoliateView'
import { DEFAULT_READING_STYLE, DEFAULT_SPACING } from '../../core/metrics'

/**
 * What the reader tells the renderer.
 *
 * ## Why this file exists at all
 *
 * `FoliateView.tsx` is 741 lines and **no test had ever imported it**. That was
 * invisible: the v8 coverage provider reports a file nothing loads with a
 * function count taken from a cheap pass, so the module showed as 7 functions
 * when it has 34. The first test to load it — the browser client's reader —
 * did not lower coverage, it revealed it. `vitest.config.ts` records the same
 * thing happening to `Library.tsx`, in the same words, and says what to do
 * about it: put the covered side back.
 *
 * ## What is worth asserting here
 *
 * `applyLayout` is where the reader's numbers become the renderer's attributes,
 * and every rule in it is a defect that already happened once. The comments say
 * so in detail; these are the assertions that keep them true.
 *
 * A fake renderer is enough because that is genuinely the whole interface:
 * `setAttribute`, `getAttribute`, `toggleAttribute`, and the optional
 * `setStyles`/`getContents` foliate's two renderers differ over.
 */

function fakeRenderer(over: Partial<Renderer> = {}) {
  const attributes = new Map<string, string>()
  const order: string[] = []
  const renderer = {
    attributes,
    order,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value)
      order.push(name)
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    toggleAttribute: (name: string, on?: boolean) => {
      if (on) attributes.set(name, '')
      else attributes.delete(name)
      order.push(name)
    },
    getContents: () => [],
    ...over,
  }
  return renderer as unknown as Renderer & { attributes: Map<string, string>; order: string[] }
}

const settings = (over: Record<string, unknown> = {}) => ({
  stepIdx: 6,
  pageMargins: 88,
  spacing: { ...DEFAULT_SPACING },
  align: 'justified' as const,
  brightness: 1,
  contrast: 1,
  measure: 700.7,
  theme: 'paper' as const,
  typeface: 'literata',
  paginated: true,
  animated: true,
  style: DEFAULT_READING_STYLE,
  ...over,
})

describe('applyLayout', () => {
  /**
   * EVERY LENGTH CARRIES A UNIT, and a bare `0` is not a smaller version of
   * `0px`.
   *
   * foliate interpolates each attribute into a CSS custom property and builds
   * `grid-template-columns` with `calc(var(--_max-width) - var(--_gap))`.
   * `calc()` cannot subtract a bare number from a length, so one unitless value
   * invalidates the whole declaration, the tracks fall back to `auto`, and the
   * book sizes to its content instead of to the measure — with every attribute
   * apparently correct and no error anywhere.
   */
  it('writes a unit on every length', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings())
    for (const name of ['margin', 'max-inline-size', 'gap']) {
      expect(renderer.attributes.get(name), `${name} must carry a unit`).toMatch(/^[\d.]+(px|%)$/)
    }
  })

  /* FLOORED, NOT ROUNDED. A rounded-up measure can exceed the fractional width
     the grid allocated, by up to half a pixel — a column break's worth on a
     paginated page. Floor never asks for more than exists. */
  it('floors the measure rather than rounding it', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings({ measure: 700.7, pageMargins: 0 }))
    expect(renderer.attributes.get('max-inline-size')).toBe('700px')
  })

  /**
   * `max-inline-size` IS THE PAGE, not the measure.
   *
   * foliate takes it as the width of its scroll port — the box it clips the
   * book to and scrolls by one width per turn — and derives the column from it
   * by subtracting the gap. While the two coincided, a turn slid text against
   * text with nothing between them.
   */
  it('gives the page the margins on top of the measure, when paginated', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings({ measure: 700, pageMargins: 88 }))
    expect(renderer.attributes.get('max-inline-size')).toBe('788px')
  })

  /* AND NOT IN SCROLLED FLOW, where there is no turn and nothing to separate:
     `scrolled()` sets `body { max-width: columnWidth }`, so a page-width here
     would widen the text past its own measure. */
  it('gives the page exactly the measure when scrolled', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings({ measure: 700, pageMargins: 88, paginated: false }))
    expect(renderer.attributes.get('max-inline-size')).toBe('700px')
  })

  /* THE GAP IS A PERCENTAGE whatever unit is written on it — foliate does
     `parseFloat(gap) / 100` and never looks at the unit. `'88px'` would ask for
     88%, which is a page of margin with a sliver of text down the middle. */
  it('writes the gap as a percentage', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings())
    const gap = renderer.attributes.get('gap') ?? ''
    expect(gap).toMatch(/%$/)
    expect(Number.parseFloat(gap)).toBeGreaterThanOrEqual(0)
    expect(Number.parseFloat(gap)).toBeLessThan(100)
  })

  /**
   * PRESENCE, NOT VALUE. foliate tests `hasAttribute('animated')`, so
   * `animated="false"` would animate — which is why this is `toggleAttribute`.
   */
  it('removes the animated attribute rather than setting it false', () => {
    const on = fakeRenderer()
    applyLayout(on, settings({ animated: true }))
    expect(on.attributes.has('animated')).toBe(true)

    const off = fakeRenderer()
    applyLayout(off, settings({ animated: false }))
    expect(off.attributes.has('animated')).toBe(false)
  })

  /**
   * ORDER MATTERS, and it is the one thing a shape check cannot see.
   *
   * `flow` is what triggers the paginator to re-render, and the sizing
   * attributes are read DURING that render rather than observed independently
   * — so anything set after flow lands too late and is not read until the next
   * one.
   */
  it('sets flow after every attribute the render reads', () => {
    const renderer = fakeRenderer()
    applyLayout(renderer, settings())
    const flow = renderer.order.lastIndexOf('flow')
    expect(flow, 'flow must be set at all').toBeGreaterThanOrEqual(0)
    for (const name of ['margin', 'max-inline-size', 'gap', 'max-column-count']) {
      expect(renderer.order.indexOf(name), `${name} must be set before flow`).toBeLessThan(flow)
    }
  })
})

describe('readingVars', () => {
  it('carries the stylesheet’s fields and the reading style with them', () => {
    const vars = readingVars(settings())
    expect(vars).toMatchObject({ stepIdx: 6, theme: 'paper', typeface: 'literata', align: 'justified' })
    expect(vars.style).toBe(DEFAULT_READING_STYLE)
  })

  /* THE MEASURE IS NOT A STYLESHEET FIELD. `Settings` carries it, the page
     margins, the flow and whether a turn animates; the stylesheet has never
     taken any of them, and passing one would be a variable nothing reads. */
  it('leaves out what the stylesheet does not take', () => {
    const vars = readingVars(settings()) as unknown as Record<string, unknown>
    for (const name of ['measure', 'pageMargins', 'paginated', 'animated']) {
      expect(vars[name], `${name} is not a stylesheet variable`).toBeUndefined()
    }
  })
})

describe('applySettings', () => {
  /**
   * THE SHEETS ARE WRITTEN ONCE PER RENDERER, and skipping the second write is
   * the feature rather than an optimisation.
   *
   * `setStyles` writes `textContent` on two style elements, and writing the
   * same string back still re-parses the sheet in every open document. That
   * re-parse on every settings change is the defect the variable contract
   * exists to remove.
   */
  it('does not rewrite the sheets when nothing about them moved', () => {
    const setStyles = vi.fn()
    const renderer = fakeRenderer({ setStyles } as Partial<Renderer>)
    applySettings(renderer, settings())
    applySettings(renderer, settings({ stepIdx: 9 }))
    expect(setStyles).toHaveBeenCalledOnce()
  })

  /* PER RENDERER, because a note's view is a different renderer with its own
     two style elements. */
  it('writes them again for a different renderer', () => {
    const first = vi.fn()
    const second = vi.fn()
    applySettings(fakeRenderer({ setStyles: first } as Partial<Renderer>), settings())
    applySettings(fakeRenderer({ setStyles: second } as Partial<Renderer>), settings())
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  /* `setStyles` IS OPTIONAL — the fixed-layout renderer does not implement it,
     and a PDF must not crash the settings path. */
  it('survives a renderer that cannot take styles', () => {
    /* `setStyles` ABSENT, not present-and-undefined: the fixed-layout renderer
       simply does not have the method, which is what the optional call in
       `applySheets` is for. */
    const renderer = fakeRenderer()
    delete (renderer as { setStyles?: unknown }).setStyles
    expect(() => applySettings(renderer, settings())).not.toThrow()
    expect(renderer.attributes.get('max-inline-size')).toBeTruthy()
  })
})
