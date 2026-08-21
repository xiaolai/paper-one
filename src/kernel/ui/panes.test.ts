import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { PaneContribution } from '../core/capability'
import { KERNEL_PANE_IDS } from '../core/uiTypes'
import { PANES, PANE_SHORTCUTS, PANE_TITLES, renderContribution, shownPane } from './panes'

/**
 * The pane registry beside a composition — WI-5.6. `shownPane` decides what
 * the side pane draws for what the state asks, against THIS composition;
 * `renderContribution` narrows the opaque handle a capability registered.
 */

const contributed: PaneContribution[] = [
  { id: 'example:pane', label: 'Example', screens: ['library', 'reader'], render: () => createElement('p', null, 'hi') },
]

describe('shownPane', () => {
  it('names a kernel pane by the registry title, a contributed one by its label', () => {
    expect(shownPane('marginalia', contributed, 'companion')).toEqual({ id: 'marginalia', title: 'Marginalia', contribution: null })
    expect(shownPane('example:pane', contributed, 'companion')).toEqual({ id: 'example:pane', title: 'Example', contribution: contributed[0] })
  })

  it('shows the fallback for a contributed id nobody composed — a remembered pane from a capability that is gone', () => {
    expect(shownPane('gone:pane', contributed, 'library')).toEqual({ id: 'library', title: 'Library', contribution: null })
    expect(shownPane('example:pane', [], 'companion').id).toBe('companion')
  })
})

describe('renderContribution', () => {
  it('passes through what React can draw', () => {
    const element = renderContribution('example:pane', contributed[0]!.render)
    expect(element).toMatchObject({ type: 'p' })
    expect(renderContribution('x:y', () => null)).toBe(null)
    expect(renderContribution('x:y', () => 'text')).toBe('text')
    expect(renderContribution('x:y', () => [createElement('i'), 'and text'])).toHaveLength(2)
  })

  it('refuses, by pane id, what React cannot — before React does, without saying which capability', () => {
    expect(() => renderContribution('sync:status', () => ({ not: 'an element' }))).toThrow(/"sync:status" rendered an object of Object/)
    expect(() => renderContribution('sync:status', () => () => null)).toThrow(/a function/)
    expect(() => renderContribution('sync:status', () => Symbol('x'))).toThrow(/a symbol/)
    expect(() => renderContribution('sync:status', () => [1, { no: 1 }])).toThrow(/sync:status/)
  })
})

describe('the kernel registry keeps its shortcuts', () => {
  it('binds ⌘1…5 to kernel panes only', () => {
    expect(PANE_SHORTCUTS.map((s) => s.pane)).toEqual([
      'toc',
      'marginalia',
      'search',
      'cards',
    ])
    /* AGAINST THE ID REGISTRY, not against `PANE_TITLES` — that map is built
       BY `Object.fromEntries(PANES.map(…))`, so asking whether every pane is a
       key of it is asking whether every pane is in a list made of the panes.
       It was true by construction and could not fail; a kernel pane left out
       of `PANES` altogether — the omission worth catching — passed it happily.
       `KERNEL_PANE_IDS` is declared by hand in `uiTypes`, so the two really can
       disagree, and `PANE_TITLES` is typed `Record<KernelPaneId, string>` on
       the promise that they do not. */
    const listed = PANES.map((pane) => pane.id).sort()
    expect(listed).toEqual([...KERNEL_PANE_IDS].sort())
    expect(Object.keys(PANE_TITLES).sort()).toEqual(listed)
  })
})
