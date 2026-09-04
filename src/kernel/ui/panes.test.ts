import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { PaneContribution } from '../core/capability'
import { KERNEL_PANE_IDS } from '../core/uiTypes'
import { PANES, PANE_SHORTCUTS, PANE_TITLES, comboFor, renderContribution, shownPane } from './panes'

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
  const NO_BOOK = { bookId: null }

  it('passes through what React can draw', () => {
    const element = renderContribution('example:pane', contributed[0]!.render, NO_BOOK)
    expect(element).toMatchObject({ type: 'p' })
    expect(renderContribution('x:y', () => null, NO_BOOK)).toBe(null)
    expect(renderContribution('x:y', () => 'text', NO_BOOK)).toBe('text')
    expect(renderContribution('x:y', () => [createElement('i'), 'and text'], NO_BOOK)).toHaveLength(2)
  })

  it('hands the renderer the context it was drawn in — the open book, if any (WI-23.B4)', () => {
    /* A pane about a book has to know which; the kernel's own panes get it as
       a prop, and a contribution gets it here. */
    const seen: (string | null)[] = []
    const render = (context: { bookId: string | null }) => {
      seen.push(context.bookId)
      return null
    }
    renderContribution('x:y', render, { bookId: 'book:moby' })
    renderContribution('x:y', render, NO_BOOK)
    expect(seen).toEqual(['book:moby', null])
  })

  it('refuses, by pane id, what React cannot — before React does, without saying which capability', () => {
    expect(() => renderContribution('sync:status', () => ({ not: 'an element' }), NO_BOOK)).toThrow(/"sync:status" rendered an object of Object/)
    expect(() => renderContribution('sync:status', () => () => null, NO_BOOK)).toThrow(/a function/)
    expect(() => renderContribution('sync:status', () => Symbol('x'), NO_BOOK)).toThrow(/a symbol/)
    expect(() => renderContribution('sync:status', () => [1, { no: 1 }], NO_BOOK)).toThrow(/sync:status/)
  })

  /**
   * ⚠️ **REACT 19 DRAWS MORE THAN ARRAYS AND ELEMENTS**, and the guard accepted
   * only those. A capability returning any other legal `ReactNode` had its pane
   * thrown out by a predicate claiming to recognise what React accepts —
   * refused before React ever saw something React would have drawn perfectly.
   */
  it('passes through the other things React 19 can draw', () => {
    /* An ITERABLE. React renders one; this used to be `Array.isArray` only. */
    function* rows() {
      yield createElement('li', { key: 'a' })
      yield createElement('li', { key: 'b' })
    }
    expect(() => renderContribution('x:y', rows, NO_BOOK)).not.toThrow()

    /* A PROMISE, which `use` unwraps. */
    expect(() => renderContribution('x:y', () => Promise.resolve('later'), NO_BOOK)).not.toThrow()

    /* A PORTAL, recognised by React's own marker rather than by shape. */
    const portal = { $$typeof: Symbol.for('react.portal'), children: null, containerInfo: null }
    expect(() => renderContribution('x:y', () => portal, NO_BOOK)).not.toThrow()
  })

  /* AND AN ITERABLE IS NOT CONSUMED. Walking a generator to check it would
     leave React nothing to render — the guard would eat the pane it approved. */
  it('does not read the iterable it approves', () => {
    let pulled = 0
    function* counted() {
      pulled += 1
      yield createElement('li', { key: 'a' })
    }
    const drawn = renderContribution('x:y', counted, NO_BOOK) as Iterable<unknown>
    expect(pulled, 'the guard consumed the generator').toBe(0)
    expect([...drawn]).toHaveLength(1)
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

/**
 * WHICH KEYBOARD IS IN FRONT OF THE READER, which is not which build this is.
 *
 * ⚠️ `web` took the Ctrl branch, on a note saying "the client draws no shortcut
 * anywhere today". The browser client mounts `Marginalia`, which calls this for
 * its empty state — so every reader on a Mac in a browser was shown `Ctrl+B`
 * for a key their machine does not have.
 *
 * `web` is the only platform where the build and the keyboard can disagree; a
 * native build IS its platform.
 */
describe('comboFor', () => {
  const withPlatform = (named: string, run: () => void) => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'platform')
    Object.defineProperty(navigator, 'platform', { value: named, configurable: true })
    try {
      run()
    } finally {
      if (original) Object.defineProperty(navigator, 'platform', original)
    }
  }

  it('keeps the Command key on a native Mac and replaces it elsewhere', () => {
    expect(comboFor('⌘B', 'macos')).toBe('⌘B')
    expect(comboFor('⌘B', 'windows')).toBe('Ctrl+B')
    expect(comboFor('⌘B', 'linux')).toBe('Ctrl+B')
  })

  it('asks the machine on the web, rather than the build target', () => {
    withPlatform('MacIntel', () => expect(comboFor('⌘B', 'web')).toBe('⌘B'))
    withPlatform('Win32', () => expect(comboFor('⌘B', 'web')).toBe('Ctrl+B'))
    withPlatform('Linux x86_64', () => expect(comboFor('⌘B', 'web')).toBe('Ctrl+B'))
  })
})

describe('what renderContribution lets through as a node', () => {
  it('lets a portal through by React’s own marker, and refuses an object marked with some other symbol', () => {
    const portal = { $$typeof: Symbol.for('react.portal'), key: null, children: null, containerInfo: {} }
    expect(() => renderContribution('cap:one', () => portal as never, { bookId: null })).not.toThrow()
    const stranger = { $$typeof: Symbol('not a portal') }
    expect(() => renderContribution('cap:one', () => stranger as never, { bookId: null })).toThrow(/pane "cap:one" rendered/u)
  })
})
