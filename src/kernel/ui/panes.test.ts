import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { PaneContribution } from '../core/capability'
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
    expect(shownPane('notes', contributed, 'companion')).toEqual({ id: 'notes', title: 'Notes', contribution: null })
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
  it('binds ⌘1…6 to kernel panes only', () => {
    expect(PANE_SHORTCUTS.map((s) => s.pane)).toEqual([
      'toc',
      'notes',
      'search',
      'cards',
      'stats',
      'bookmarks',
    ])
    expect(PANES.every((pane) => pane.id in PANE_TITLES)).toBe(true)
  })
})
