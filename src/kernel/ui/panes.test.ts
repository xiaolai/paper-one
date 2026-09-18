import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { PaneContribution } from '../core/capability'
import { KERNEL_PANE_IDS } from '../core/uiTypes'
import { PANES, PANE_SHORTCUTS, PANE_TITLES, THEMES, comboFor, panesFor, renderContribution, shownPane } from './panes'

/**
 * The pane registry beside a composition — WI-5.6. `shownPane` decides what
 * the side pane draws for what the state asks, against THIS composition;
 * `renderContribution` narrows the opaque handle a capability registered.
 */

const contributed: PaneContribution[] = [
  { id: 'example:pane', label: 'Example', icon: 'people', screens: ['library', 'reader'], render: () => createElement('p', null, 'hi') },
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

  /* A FALLBACK IS RESOLVED AGAINST THE COMPOSITION TOO. Handed a contributed id
     nobody composed as the fallback, this returned it with `title: undefined`
     under a declared `string` (#151). */
  it('lands on a kernel pane, with its title, when the fallback itself is gone', () => {
    expect(shownPane('gone:pane', [], 'also:gone')).toEqual({ id: 'toc', title: 'Contents', contribution: null })
    expect(shownPane('gone:pane', contributed, 'example:pane')).toEqual({ id: 'example:pane', title: 'Example', contribution: contributed[0] })
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

  /* EVERY PRIMITIVE REACT DRAWS AS TEXT, OR AS NOTHING, passes through as the
     same value. A number, a bigint and a boolean each had a case of their own
     that nothing exercised, so any one of them could have been refused. */
  it('passes through a number, a bigint and a boolean as themselves', () => {
    expect(renderContribution('x:y', () => 42, NO_BOOK)).toBe(42)
    expect(renderContribution('x:y', () => 0, NO_BOOK)).toBe(0)
    expect(renderContribution('x:y', () => 10n, NO_BOOK)).toBe(10n)
    expect(renderContribution('x:y', () => false, NO_BOOK)).toBe(false)
    expect(renderContribution('x:y', () => true, NO_BOOK)).toBe(true)
    expect(renderContribution('x:y', () => undefined, NO_BOOK)).toBeUndefined()
  })

  /* THE WHOLE MESSAGE, in the refusal's own words — and for an object with no
     constructor to name, which is what `Object.create(null)` is. Read without
     the `?.`, its name is a TypeError about `name` instead of the refusal, and
     that names neither the pane nor the shape. */
  it('says which pane sent what, in full, even for an object with no constructor', () => {
    const refusal = (value: unknown): unknown => {
      try {
        renderContribution('sync:status', () => value, NO_BOOK)
      } catch (cause) {
        return cause
      }
      return null
    }
    const bare = refusal(Object.create(null))
    expect(bare).toBeInstanceOf(Error)
    expect((bare as Error).message).toBe('pane "sync:status" rendered an object of unknown, which React cannot show')
    expect((refusal({ not: 'an element' }) as Error).message).toBe(
      'pane "sync:status" rendered an object of Object, which React cannot show',
    )
    expect((refusal(() => null) as Error).message).toBe('pane "sync:status" rendered a function, which React cannot show')
    expect((refusal(Symbol('x')) as Error).message).toBe('pane "sync:status" rendered a symbol, which React cannot show')
    expect((refusal([1, [{ no: 1 }]]) as Error).message).toBe('pane "sync:status" rendered an object of Array, which React cannot show')
  })

  /* AN ARRAY THAT CONTAINS ITSELF is refused the same way, by pane id — the
     walk used to follow it until the stack ran out, which names nothing and
     reads as a fault in Paper rather than in the pane that sent it (#153). */
  it('refuses an array that contains itself instead of walking it forever', () => {
    const hall: unknown[] = ['a mirror']
    hall.push(hall)
    expect(() => renderContribution('sync:status', () => hall, NO_BOOK)).toThrow(/"sync:status" rendered/u)
  })

  /* ⚠️ **AND ONE THAT IS ONLY DEEP, NOT CYCLIC, OVERFLOWED THE SAME WAY**
     (2026-09-14, #153). The cycle check needed a path to compare against, and
     the walk that carried it was still recursive — so a hundred thousand arrays
     one inside the next threw "Maximum call stack size exceeded", naming
     neither the pane nor the shape. */
  it('refuses arrays nested past what React can draw, by pane id, without running out of stack', () => {
    const nest = (depth: number): unknown => {
      let node: unknown = 'leaf'
      for (let level = 0; level < depth; level += 1) node = [node]
      return node
    }
    expect(() => renderContribution('sync:status', () => nest(100_000), NO_BOOK)).toThrow(/"sync:status" rendered/u)
    /* A real nesting still passes, and so does one array reached twice — a
       repeat is not a cycle. */
    expect(() => renderContribution('x:y', () => nest(50), NO_BOOK)).not.toThrow()
    const shared = [createElement('i')]
    expect(() => renderContribution('x:y', () => [shared, [shared]], NO_BOOK)).not.toThrow()
    /* `MAX_NESTING` is 500: the deepest nesting let through, and one past it. */
    expect(() => renderContribution('x:y', () => nest(500), NO_BOOK)).not.toThrow()
    expect(() => renderContribution('x:y', () => nest(501), NO_BOOK)).toThrow(/"x:y" rendered/u)
    /* And an array reached twice is walked once: sixty-four levels of `[n, n]`
       is two to the sixty-fourth leaves to a walk that does not remember. */
    let doubled: unknown = [createElement('i')]
    for (let level = 0; level < 64; level += 1) doubled = [doubled, doubled]
    expect(() => renderContribution('x:y', () => doubled, NO_BOOK)).not.toThrow()
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

  /* EACH DIGIT IS THE LAST CHARACTER OF ITS COMBO, and only a pane with a combo
     has one — the four in publication order, which is not the rail's. */
  it('pairs each combo with its digit and its panel, and gives the rest none', () => {
    expect(PANE_SHORTCUTS).toEqual([
      { combo: '⌘1', digit: '1', pane: 'toc' },
      { combo: '⌘2', digit: '2', pane: 'marginalia' },
      { combo: '⌘3', digit: '3', pane: 'search' },
      { combo: '⌘4', digit: '4', pane: 'cards' },
    ])
  })

  /* WHAT EVERY SURFACE THAT NAMES A PANEL PRINTS — the pane header, the
     palette, the developer rows in Settings. A label left empty is a heading
     with nothing in it. */
  it('titles every kernel pane by the name a reader is shown', () => {
    expect(PANE_TITLES).toEqual({
      toc: 'Contents',
      marginalia: 'Marginalia',
      search: 'Search',
      cards: 'Cards',
      companion: 'Companion',
      library: 'Library',
      settings: 'Settings',
      dev: 'Developer',
    })
  })
})

/**
 * WHICH PANELS A SCREEN OFFERS, in registry order — `state`'s rule applied to
 * the registry. Companion and Cards are unfinished (`UNFINISHED_PANE_IDS`) and
 * Developer is developer-only, so none of the three is offered to a reader who
 * has not pressed the chord.
 */
describe('panesFor', () => {
  const ids = (panes: readonly { id: string }[]) => panes.map((pane) => pane.id)

  it('offers a reader the book panels and Settings, and the shelf its own', () => {
    expect(ids(panesFor('reader'))).toEqual(['toc', 'marginalia', 'search', 'settings'])
    expect(ids(panesFor('library'))).toEqual(['marginalia', 'library', 'settings'])
  })

  it('offers the unfinished panels and Developer under developer options, less any hidden', () => {
    expect(ids(panesFor('reader', { developer: true }))).toEqual([
      'toc',
      'marginalia',
      'search',
      'cards',
      'companion',
      'settings',
      'dev',
    ])
    expect(ids(panesFor('reader', { developer: true, hiddenPanes: ['cards'] }))).toEqual([
      'toc',
      'marginalia',
      'search',
      'companion',
      'settings',
      'dev',
    ])
  })
})

/* THE OTHER REGISTRY, in §05's order, under the names the palette and the
   Settings chips print. */
describe('THEMES', () => {
  it('lists the five themes in order, each with its name', () => {
    expect(THEMES).toEqual([
      { id: 'paper', label: 'Paper' },
      { id: 'slate', label: 'Slate' },
      { id: 'sepia', label: 'Sepia' },
      { id: 'sage', label: 'Sage' },
      { id: 'night', label: 'Night' },
    ])
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

  /* ⌃⌘D — Look up — is Control-and-Command on a Mac, and the accelerator IS
     Control elsewhere, so it prints as what `accel.ts` binds there: Shift.
     "Ctrl+Ctrl+D", or a ⌃ left in front of a Ctrl, would be a combo nobody can
     press. */
  it('prints the Control-and-Command chord as Control-and-Shift off a Mac', () => {
    expect(comboFor('⌃⌘D', 'macos')).toBe('⌃⌘D')
    expect(comboFor('⌃⌘D', 'windows')).toBe('Ctrl+Shift+D')
    expect(comboFor('⌃⌘D', 'linux')).toBe('Ctrl+Shift+D')
    withPlatform('MacIntel', () => expect(comboFor('⌃⌘D', 'web')).toBe('⌃⌘D'))
  })

  /* AN iPHONE OR iPAD IS AN APPLE KEYBOARD, native or not. The web branch already
     read it that way, and the native branch printed Ctrl for the same device
     (#152). */
  it('keeps the Command key on iOS, as it does for an iPad in a browser', () => {
    expect(comboFor('⌘B', 'ios')).toBe('⌘B')
    expect(comboFor('⌃⌘D', 'ios')).toBe('⌃⌘D')
    withPlatform('iPad', () => expect(comboFor('⌘B', 'web')).toBe('⌘B'))
    withPlatform('iPhone', () => expect(comboFor('⌘B', 'web')).toBe('⌘B'))
    withPlatform('iPod touch', () => expect(comboFor('⌘B', 'web')).toBe('⌘B'))
    expect(comboFor('⌘B', 'android')).toBe('Ctrl+B')
  })

  /* A BROWSER'S OWN ANSWER FIRST. `userAgentData.platform` is the one that is
     not deprecated, so where it exists it outranks `navigator.platform`. */
  it('prefers the user-agent data’s platform to the deprecated one', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: 'Win32', userAgent: 'Windows' })
    try {
      expect(comboFor('⌘B', 'web')).toBe('⌘B')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /* NO NAVIGATOR AT ALL, OR ONE THAT NAMES NOTHING, is not a Mac — and asking
     must not throw, which reading a property of a missing navigator would. */
  it('prints Ctrl on the web when nothing says the machine is a Mac', () => {
    try {
      vi.stubGlobal('navigator', undefined)
      expect(comboFor('⌘B', 'web')).toBe('Ctrl+B')
      vi.stubGlobal('navigator', {})
      expect(comboFor('⌘B', 'web')).toBe('Ctrl+B')
      vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
      expect(comboFor('⌘B', 'web'), 'the user agent is the last thing asked, and it is still asked').toBe('⌘B')
    } finally {
      vi.unstubAllGlobals()
    }
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
