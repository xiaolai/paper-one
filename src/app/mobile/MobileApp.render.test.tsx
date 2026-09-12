// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MobileApp } from './MobileApp'
import { createKernelServices, type Composition } from '../../kernel'
import { UNFINISHED_PANE_IDS } from '../../kernel/core/uiTypes'

/**
 * EVERY TAB RENDERS — which is the thing a screenshot of one tab cannot say.
 *
 * The shell came up on the iPhone 17 simulator showing Library, and that
 * proved the entry, the insets and the tab bar. It proved nothing about the
 * other three: a tab whose screen throws looks exactly like a tab nobody has
 * pressed. Tapping them by hand would have needed the Simulator's window
 * geometry, which reports a landscape box for a portrait phone — so this is
 * both the cheaper check and the one that survives.
 *
 * `Reading` is deliberately not here: `TabBar` redirects it to Library while
 * there is no book, and asserting that is `TabBar`'s own job.
 */

const EMPTY_COMPOSITION = {
  order: [],
  failures: [],
  panes: [],
  settings: [],
  bookActions: [],
  bookStatuses: [],
  services: new Map(),
  clients: [],
  [Symbol.dispose]: () => {},
} as unknown as Composition

function mount() {
  /* NO FILESYSTEM AND NO STORAGE. Both are legal — a browser has neither, and
     `createKernelServices` is built to answer for that — so this mounts the
     shell in the state a phone reaches before any book has been carried onto
     it, which is also what the simulator shows. */
  const services = createKernelServices({ fs: null, storage: null, initialBooks: [] })
  return render(<MobileApp services={services} shelfUnread={false} composition={EMPTY_COMPOSITION} />)
}

/* jsdom HAS NO `ResizeObserver`, and the You screen's `Settings` groups measure
   themselves to animate open. A stub that observes nothing is enough — these
   cases are about which screen renders, not about how tall it is. The browser
   client's Reader test stubs it the same way, for the same component. */
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('the phone shell', () => {
  it('opens on the Library', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Library' }).getAttribute('aria-current')).toBe('page')
  })

  /**
   * ⚠️ **THIS ASSERTED `['Library', 'Reading', 'Cards', 'Settings']`**, and
   * `cards` is in `UNFINISHED_PANE_IDS` — the list the desktop's rail, palette
   * and digit accelerators all read to keep that deck away from a reader. The
   * bar is mounted by this shell and by `main.web.tsx`, neither of which names
   * `paneOffered`, so the test was pinning the defect: an unfinished panel as a
   * permanent top-level tab on every phone and in every browser, with no chord
   * anywhere to hide it.
   *
   * Derived from the rule rather than from a new literal, so that removing an
   * id from `UNFINISHED_PANE_IDS` moves this expectation with it — which is
   * what that list promises and, on this shell, did not deliver.
   */
  it('draws the tabs the design names, less any panel that is not finished', () => {
    mount()
    const bar = screen.getByRole('navigation', { name: 'Sections' })
    const labels = [...bar.querySelectorAll('button')].map((b) => b.textContent)
    const designed = ['Library', 'Reading', 'Cards', 'Settings']
    /* `Reading` is this bar's own id and no panel; every other label is a pane
       id spelled with a capital. */
    const offered = designed.filter((one) => !(UNFINISHED_PANE_IDS as readonly string[]).includes(one.toLowerCase()))
    expect(labels).toEqual(offered)
    /* NON-VACUOUS both ways: the filter really removes something here, and
       what is left is not empty. */
    expect(offered.length).toBeLessThan(designed.length)
    expect(labels).toContain('Library')
  })

  it.each(['Settings'])('renders the %s screen when its tab is pressed', (tab) => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: tab }))
    /* THE HEADING, not just the absence of a throw — a screen that rendered
       nothing at all would pass a smoke test and show a blank tab. */
    expect(screen.getByRole('heading', { name: tab })).not.toBeNull()
    expect(screen.getByRole('button', { name: tab }).getAttribute('aria-current')).toBe('page')
  })

  /* NO WINDOW CHROME. The shell drew a 52px overlay titlebar and three traffic
     lights on a phone for as long as `resolvePlatform` answered `macos` there;
     jsdom's user agent is not a phone's, so this asserts the SHELL draws none
     of its own regardless of what the platform resolves to. */
  it('draws no titlebar of its own', () => {
    const { container } = mount()
    expect(container.querySelector('[class*="titlebar" i]')).toBeNull()
    expect(container.querySelector('[class*="trafficLight" i]')).toBeNull()
  })
})
