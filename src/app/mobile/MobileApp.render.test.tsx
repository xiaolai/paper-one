// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MobileApp } from './MobileApp'
import { createKernelServices, type Composition } from '../../kernel'
import styles from '../shell/shell.module.css'

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
  standing: [],
  panes: [],
  settings: [],
  bookActions: [],
  bookStatuses: [],
  services: new Map(),
  clients: [],
  [Symbol.dispose]: () => {},
} as unknown as Composition

function mount(initialBooks: readonly { bookId: string; title: string; author: string; addedAt: number }[] = []) {
  /* NO FILESYSTEM AND NO STORAGE. Both are legal — a browser has neither, and
     `createKernelServices` is built to answer for that — so this mounts the
     shell in the state a phone reaches before any book has been carried onto
     it, which is also what the simulator shows.
     `initialBooks` is for the one case that needs a shelf with something on
     it: the tap below. */
  const services = createKernelServices({ fs: null, storage: null, initialBooks: initialBooks as never })
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

const MOBY = { bookId: 'book:m', title: 'Moby-Dick', author: 'Melville', addedAt: 1 }

describe('the phone shell', () => {
  it('opens on the Library', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Library' }).getAttribute('aria-current')).toBe('page')
  })

  it('draws the tabs the design names', () => {
    mount()
    const bar = screen.getByRole('navigation', { name: 'Sections' })
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Library', 'Reading', 'Settings'])
  })

  it.each(['Settings'])('renders the %s screen when its tab is pressed', (tab) => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: tab }))
    /* THE HEADING, not just the absence of a throw — a screen that rendered
       nothing at all would pass a smoke test and show a blank tab. */
    expect(screen.getByRole('heading', { name: tab })).not.toBeNull()
    expect(screen.getByRole('button', { name: tab }).getAttribute('aria-current')).toBe('page')
  })

  /* ONE SCREEN AT A TIME. Each tab's screen is drawn while its tab is current
     and not otherwise — a shelf left under the settings, or the settings drawn
     over the shelf, is two screens fighting for one stage. */
  it('draws the shelf alone on Library, and the settings alone on Settings', () => {
    mount([MOBY])
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
    expect(screen.queryByTitle('Open Moby-Dick')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByTitle('Open Moby-Dick')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Settings' })).not.toBeNull()
  })

  /* THE SETTINGS SCREEN SITS ON THE STAGE AS A SCROLLING SCREEN — `stage` is
     what gives it the space under the safe area and `screen` what lets a long
     settings list scroll, so a bare box would run off the bottom of the phone. */
  it('lays the Settings screen out on the stage, as a screen', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const box = screen.getByRole('heading', { name: 'Settings' }).parentElement
    expect([...(box?.classList ?? [])]).toEqual(expect.arrayContaining([styles.stage, styles.screen]))
  })

  /* NO BOOK ON A PHONE YET, so Reading has nothing to open and must not leave
     the reader on a stage with nothing drawn on it. */
  it('keeps the shelf when Reading is pressed with no book open', () => {
    mount([MOBY])
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))
    expect(screen.getByRole('button', { name: 'Library' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByTitle('Open Moby-Dick')).not.toBeNull()
  })

  /**
   * ⚠️ **TAPPING A BOOK DID NOTHING AT ALL, SILENTLY.** Both `onOpen`s were
   * `() => {}` — the shelf's covers and the Continue strip's — so a reader tapped
   * a book and the screen did not move, which reads as a broken app rather than
   * an unfinished one. `MobileApp` states the rule eight lines from the defect:
   * "the screen draws no control it cannot act on".
   *
   * The covers cannot go, because they ARE the Library screen. So the tap is
   * answered, through the notice `Library` already renders.
   */
  it('answers a tap on a book rather than swallowing it', async () => {
    const moby = { bookId: 'book:m', title: 'Moby-Dick', author: 'Melville', addedAt: 1 }
    mount([moby])
    /* The row the shelf drew for it — the phone's Library is a list. */
    const row = screen.getByTitle('Open Moby-Dick')
    fireEvent.click(row)
    expect(await screen.findByText(/not ready yet/u)).toBeTruthy()
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
